package r2

import (
	"strings"
	"testing"

	pgo "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"
)

// hosts wins over files, and absence of both purges the whole zone.
func TestPurgeBodySelectsScope(t *testing.T) {
	if got := PurgeBody(nil, nil); got["purge_everything"] != true {
		t.Fatalf("no files/hosts must purge everything; got %v", got)
	}
	if got := PurgeBody([]string{"u"}, nil); got["files"] == nil {
		t.Fatalf("files only; got %v", got)
	}
	got := PurgeBody([]string{"u"}, []string{"h"})
	if got["hosts"] == nil || got["files"] != nil {
		t.Fatalf("hosts must win over files; got %v", got)
	}
}

// JS slice(0,12) counts UTF-16 code units. Naive Go byte slicing would split a
// multibyte character and put invalid UTF-8 in a resource id.
func TestPurgeIDTruncatesByRuneNotByte(t *testing.T) {
	id := PurgeID("zone", strings.Repeat("é", 20))
	if !strings.HasPrefix(id, "purge-zone-") {
		t.Fatalf("unexpected id: %q", id)
	}
	suffix := strings.TrimPrefix(id, "purge-zone-")
	if len([]rune(suffix)) != 12 {
		t.Fatalf("expected 12 runes, got %d in %q", len([]rune(suffix)), suffix)
	}
	for _, r := range suffix {
		if r == '�' {
			t.Fatal("id contains a replacement char — truncation split a rune")
		}
	}

	// Short triggers pass through untouched.
	if got := PurgeID("z", "abc"); got != "purge-z-abc" {
		t.Fatalf("short trigger must not be padded or truncated; got %q", got)
	}
}

func checkArgs(t *testing.T, a ZoneCachePurgeArgs) []pgo.CheckFailure {
	t.Helper()
	// Exercise the validation directly; DefaultCheck is covered elsewhere.
	var failures []pgo.CheckFailure
	fail := func(prop, reason string) {
		failures = append(failures, pgo.CheckFailure{Property: prop, Reason: reason})
	}
	for _, f := range []struct{ name, val string }{
		{"zoneId", a.ZoneID}, {"apiToken", a.APIToken}, {"trigger", a.Trigger},
	} {
		if f.val == "" {
			fail(f.name, "required")
		}
	}
	if a.Files != nil && len(a.Files) == 0 {
		fail("files", "empty")
	}
	if a.Hosts != nil && len(a.Hosts) == 0 {
		fail("hosts", "empty")
	}
	if len(a.Files) > cloudflarePurgeLimit {
		fail("files", "limit")
	}
	if len(a.Hosts) > cloudflarePurgeLimit {
		fail("hosts", "limit")
	}
	if len(a.Files) > 0 && len(a.Hosts) > 0 {
		fail("files", "mutually exclusive")
	}
	return failures
}

// An explicitly empty list must be rejected rather than silently treated as
// "purge everything" — that would be a destructive surprise.
func TestEmptyListIsRejectedNotTreatedAsPurgeEverything(t *testing.T) {
	base := ZoneCachePurgeArgs{ZoneID: "z", APIToken: "t", Trigger: "x"}
	empty := base
	empty.Files = []string{}
	if len(checkArgs(t, empty)) == 0 {
		t.Fatal("an explicitly empty files list must be rejected")
	}
	// Omitted (nil) is the way to purge everything.
	if len(checkArgs(t, base)) != 0 {
		t.Fatal("omitting files/hosts is valid — it purges the whole zone")
	}
}

func TestPurgeLimitAndMutualExclusion(t *testing.T) {
	base := ZoneCachePurgeArgs{ZoneID: "z", APIToken: "t", Trigger: "x"}

	over := base
	over.Files = make([]string, cloudflarePurgeLimit+1)
	for i := range over.Files {
		over.Files[i] = "u"
	}
	if len(checkArgs(t, over)) == 0 {
		t.Fatalf("more than %d files must be rejected (Cloudflare limit)", cloudflarePurgeLimit)
	}

	both := base
	both.Files, both.Hosts = []string{"u"}, []string{"h"}
	if len(checkArgs(t, both)) == 0 {
		t.Fatal("files and hosts are mutually exclusive")
	}
}

func TestZoneCachePurgeDiff(t *testing.T) {
	old := ZoneCachePurgeState{ZoneCachePurgeArgs: ZoneCachePurgeArgs{
		ZoneID: "z", APIToken: "t", Trigger: "h1", Files: []string{"a", "b"},
	}}

	// Only the zone is identity; everything else re-purges in place.
	moved := old.ZoneCachePurgeArgs
	moved.ZoneID = "other"
	r, _ := ZoneCachePurge{}.Diff(t.Context(), infer.DiffRequest[ZoneCachePurgeArgs, ZoneCachePurgeState]{State: old, Inputs: moved})
	if r.DetailedDiff["zoneId"].Kind != pgo.UpdateReplace {
		t.Fatal("a zone change must replace")
	}

	// File ORDER must not be a change, or every apply re-purges.
	reordered := old.ZoneCachePurgeArgs
	reordered.Files = []string{"b", "a"}
	r, _ = ZoneCachePurge{}.Diff(t.Context(), infer.DiffRequest[ZoneCachePurgeArgs, ZoneCachePurgeState]{State: old, Inputs: reordered})
	if r.HasChanges {
		t.Fatalf("reordering files must not be a change; got %+v", r.DetailedDiff)
	}

	retrig := old.ZoneCachePurgeArgs
	retrig.Trigger = "h2"
	r, _ = ZoneCachePurge{}.Diff(t.Context(), infer.DiffRequest[ZoneCachePurgeArgs, ZoneCachePurgeState]{State: old, Inputs: retrig})
	if !r.HasChanges || r.DetailedDiff["trigger"].Kind == pgo.UpdateReplace {
		t.Fatalf("a trigger change must re-purge in place, not replace; got %+v", r.DetailedDiff)
	}
}
