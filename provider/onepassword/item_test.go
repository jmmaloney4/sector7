package onepassword

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/pulumi/pulumi-go-provider/infer"
	"github.com/pulumi/pulumi/sdk/v3/go/property"

	"github.com/jmmaloney4/sector7/provider/internal/httpx"
)

// Golden vector captured from the TypeScript implementation
// (packages/sector7/onepassword/item.ts, computeContentHash) by running its
// exact logic under node:
//
//	canonical: {"category":"API_CREDENTIAL","fields":[{"label":"alpha","value":"p1","type":"STRING","purpose":"USERNAME"},{"label":"mid","value":"\"quoted\"","type":"CONCEALED","purpose":null},{"label":"zebra","value":"a&b<c>d","type":"CONCEALED","purpose":null}]}
//	sha256:    59a504868fc682a67d70d9ae2371754aa16eb78bd98b99aa09a9c4e6b10cf538
//
// contentHash drives Diff, so a single byte of divergence makes every existing
// item show a spurious change on the first apply after migration — and for
// OnePasswordItem that means rewriting live secrets. The fixture is chosen to
// catch the two ways Go and JS actually differ:
//
//   - `a&b<c>d` — Go's encoding/json escapes &, < and > by default; JS does
//     not. Caught only if SetEscapeHTML(false) is set.
//   - out-of-order labels with a mix of defaulted and explicit type/purpose —
//     catches both the sort and the `?? null` / `?? "CONCEALED"` defaulting.
//
// Field ORDER inside each object matters too: Go sorts map keys alphabetically
// (category, fields / label, purpose, type, value) while JS preserves insertion
// order, so the canonical form must be built from structs, not maps.
const goldenHash = "59a504868fc682a67d70d9ae2371754aa16eb78bd98b99aa09a9c4e6b10cf538"

func TestContentHashMatchesTypeScript(t *testing.T) {
	fields := []Field{
		{Label: "zebra", Value: "a&b<c>d"},
		{Label: "alpha", Value: "p1", Type: "STRING", Purpose: "USERNAME"},
		{Label: "mid", Value: `"quoted"`},
	}
	got, err := ContentHash("API_CREDENTIAL", fields, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got != goldenHash {
		t.Fatalf("content hash diverged from the TypeScript implementation:\n got  %s\n want %s", got, goldenHash)
	}
}

func TestContentHashIsOrderInsensitive(t *testing.T) {
	a, err := ContentHash("PASSWORD", []Field{{Label: "x", Value: "1"}, {Label: "y", Value: "2"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := ContentHash("PASSWORD", []Field{{Label: "y", Value: "2"}, {Label: "x", Value: "1"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatal("reordering fields must not change the content hash")
	}
}

func TestContentHashDefaultsCategory(t *testing.T) {
	withDefault, err := ContentHash("", []Field{{Label: "x", Value: "1"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	explicit, err := ContentHash("PASSWORD", []Field{{Label: "x", Value: "1"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if withDefault != explicit {
		t.Fatal("an empty category must hash as the PASSWORD default")
	}
}

// Backward compatibility: an item that declares NO urls (nil) must keep
// hashing to exactly what it hashed before urls existed, or the first apply
// after this release rewrites every live secret.
func TestContentHashOmitsNilURLs(t *testing.T) {
	golden, err := ContentHash("API_CREDENTIAL", []Field{
		{Label: "zebra", Value: "a&b<c>d"},
		{Label: "alpha", Value: "p1", Type: "STRING", Purpose: "USERNAME"},
		{Label: "mid", Value: `"quoted"`},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if golden != goldenHash {
		t.Fatalf("nil urls changed the pre-urls golden hash:\n got  %s\n want %s", golden, goldenHash)
	}
}

// nil (preserve) and []  (clear) are DIFFERENT declarations, so they must be
// different digests — otherwise "remove every url from this item" is
// indistinguishable from "don't manage urls" and Diff never fires.
func TestContentHashDistinguishesNilFromEmptyURLs(t *testing.T) {
	fields := []Field{{Label: "x", Value: "1"}}
	omitted, err := ContentHash("PASSWORD", fields, nil)
	if err != nil {
		t.Fatal(err)
	}
	cleared, err := ContentHash("PASSWORD", fields, []URL{})
	if err != nil {
		t.Fatal(err)
	}
	if omitted == cleared {
		t.Fatal("an explicitly empty urls list must hash differently from an omitted one")
	}
}

func TestContentHashDetectsURLChanges(t *testing.T) {
	fields := []Field{{Label: "x", Value: "1"}}
	none, err := ContentHash("LOGIN", fields, nil)
	if err != nil {
		t.Fatal(err)
	}
	one, err := ContentHash("LOGIN", fields, []URL{{Href: "https://a.example.com"}})
	if err != nil {
		t.Fatal(err)
	}
	if none == one {
		t.Fatal("adding a url must change the content hash, or Diff never triggers an update")
	}

	relabeled, err := ContentHash("LOGIN", fields, []URL{{Href: "https://a.example.com", Label: "tailnet"}})
	if err != nil {
		t.Fatal(err)
	}
	if one == relabeled {
		t.Fatal("changing a url label must change the content hash")
	}

	primary, err := ContentHash("LOGIN", fields, []URL{{Href: "https://a.example.com", Primary: true}})
	if err != nil {
		t.Fatal(err)
	}
	if one == primary {
		t.Fatal("flipping primary must change the content hash")
	}
}

// URLs are an ordered list on the item, unlike fields (label-keyed), so
// reordering is a real change rather than a no-op.
func TestContentHashIsURLOrderSensitive(t *testing.T) {
	fields := []Field{{Label: "x", Value: "1"}}
	a, err := ContentHash("LOGIN", fields, []URL{
		{Href: "https://a.example.com"}, {Href: "https://b.example.com"},
	})
	if err != nil {
		t.Fatal(err)
	}
	b, err := ContentHash("LOGIN", fields, []URL{
		{Href: "https://b.example.com"}, {Href: "https://a.example.com"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("reordering urls must change the content hash")
	}
}

// Declared urls replace the item's list; omitted urls leave it alone. The
// second half is what protects a hand-added URL on an item whose managing
// resource never declared any.
func TestMergedBodyURLSemantics(t *testing.T) {
	existing := map[string]any{
		"id":   "abc",
		"urls": []any{map[string]any{"href": "https://hand-added.example.com"}},
		"fields": []any{
			map[string]any{"label": "managed", "value": "old", "type": "CONCEALED"},
		},
	}
	base := ItemArgs{Vault: "v1", Title: "t", Category: "LOGIN",
		Fields: []Field{{Label: "managed", Value: "new"}}}

	preserved := buildMergedItemBody(existing, base, "abc", []string{"managed"})
	urls, _ := preserved["urls"].([]any)
	if len(urls) != 1 {
		t.Fatalf("undeclared urls must be preserved, got %v", preserved["urls"])
	}
	if got := urls[0].(map[string]any)["href"]; got != "https://hand-added.example.com" {
		t.Fatalf("preserved the wrong url: %v", got)
	}

	withURLs := base
	withURLs.URLs = []URL{{Href: "https://declared.example.com", Label: "tailnet", Primary: true}}
	replaced := buildMergedItemBody(existing, withURLs, "abc", []string{"managed"})
	got, _ := replaced["urls"].([]any)
	if len(got) != 1 {
		t.Fatalf("declared urls must replace the list, got %v", replaced["urls"])
	}
	u := got[0].(map[string]any)
	if u["href"] != "https://declared.example.com" || u["label"] != "tailnet" || u["primary"] != true {
		t.Fatalf("declared url not written through: %v", u)
	}

	// The third state: an explicitly empty list clears the item's urls. A
	// `len() > 0` guard would swallow this and preserve them instead.
	cleared := base
	cleared.URLs = []URL{}
	body := buildMergedItemBody(existing, cleared, "abc", []string{"managed"})
	urlsOut, present := body["urls"].([]any)
	if !present {
		t.Fatalf("an explicitly empty urls list must write an empty array, got %v", body["urls"])
	}
	if len(urlsOut) != 0 {
		t.Fatalf("an explicitly empty urls list must clear the list, got %v", urlsOut)
	}
}

// The url guard exists so an item that cannot autofill fails at plan time
// rather than silently. A scheme that is merely PRESENT is not enough:
// 1Password's extension matches web origins, so ftp/mailto fail exactly like a
// bare host, and javascript: has no business in a URL field.
func TestCheckRejectsNonWebURLSchemes(t *testing.T) {
	urlFailures := func(href string) []string {
		resp, err := Item{}.Check(t.Context(), infer.CheckRequest{
			NewInputs: property.NewMap(map[string]property.Value{
				"connectToken": property.New("t"),
				"namespace":    property.New("1password"),
				"vault":        property.New("v"),
				"title":        property.New("item"),
				"fields": property.New([]property.Value{
					property.New(map[string]property.Value{
						"label": property.New("password"), "value": property.New("p"),
					}),
				}),
				"urls": property.New([]property.Value{
					property.New(map[string]property.Value{"href": property.New(href)}),
				}),
			}),
		})
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, f := range resp.Failures {
			if strings.Contains(string(f.Property), "urls[") {
				out = append(out, string(f.Reason))
			}
		}
		return out
	}

	for _, ok := range []string{"https://a.example.com", "http://a.example.com:8080/path"} {
		if got := urlFailures(ok); len(got) != 0 {
			t.Fatalf("%q must be accepted; got %v", ok, got)
		}
	}
	for _, bad := range []string{
		"ftp://a.example.com",
		"mailto:someone@example.com",
		"javascript:alert(1)",
		"a.example.com",
		"https://",
		// Host is ":8080" (non-empty) but Hostname() is "" — a port with no
		// host. `parsed.Host == ""` misses it.
		"https://:8080",
	} {
		if got := urlFailures(bad); len(got) == 0 {
			t.Fatalf("%q must be rejected at check time", bad)
		}
	}
}

// Check validates the trimmed href, so it must also normalize it — otherwise a
// href with stray whitespace passes validation and is written through
// untrimmed, and feeds contentHash as a different value.
//
// Drives Check rather than normalizeURLs directly: the helper being correct in
// isolation says nothing about it being WIRED IN, and deleting the
// `args.URLs = normalizeURLs(args.URLs)` line is exactly the regression this
// guards against.
func TestCheckTrimsURLHref(t *testing.T) {
	resp, err := Item{}.Check(t.Context(), infer.CheckRequest{
		NewInputs: property.NewMap(map[string]property.Value{
			"connectToken": property.New("t"),
			"namespace":    property.New("ns"),
			"vault":        property.New("v"),
			"title":        property.New("title"),
			"fields": property.New([]property.Value{
				property.New(map[string]property.Value{
					"label": property.New("password"), "value": property.New("p"),
				}),
			}),
			"urls": property.New([]property.Value{
				property.New(map[string]property.Value{
					"href": property.New("  https://spaced.example.com  "),
				}),
			}),
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Failures) > 0 {
		t.Fatalf("a well-formed href with surrounding whitespace must pass check, got %v", resp.Failures)
	}
	if len(resp.Inputs.URLs) != 1 {
		t.Fatalf("expected one url back from check, got %d", len(resp.Inputs.URLs))
	}
	if got := resp.Inputs.URLs[0].Href; got != "https://spaced.example.com" {
		t.Fatalf("Check must return the trimmed href, got %q", got)
	}
}

// primary is omitted rather than written false, so a non-primary entry cannot
// clear a primary flag the operator set elsewhere on the item.
func TestManagedURLOmitsFalsePrimary(t *testing.T) {
	m := managedURL(URL{Href: "https://a.example.com"})
	if _, present := m["primary"]; present {
		t.Fatalf("primary must be omitted when false, got %v", m)
	}
	if _, present := m["label"]; present {
		t.Fatalf("label must be omitted when empty, got %v", m)
	}
}

// buildMergedItemBody must preserve everything it does not manage. A blind
// rebuild would silently drop unmanaged fields, sections, urls and tags — worst
// when adopting a hand-created item.
func TestMergedBodyPreservesUnmanagedContent(t *testing.T) {
	existing := map[string]any{
		"id":       "abc",
		"sections": []any{map[string]any{"id": "s1", "label": "Extra"}},
		"tags":     []any{"manual"},
		"urls":     []any{map[string]any{"href": "https://example.com"}},
		"fields": []any{
			map[string]any{"label": "unmanaged", "value": "keep-me", "type": "STRING"},
			map[string]any{"label": "managed", "value": "old", "type": "CONCEALED"},
			map[string]any{"label": "dropped", "value": "gone", "type": "CONCEALED"},
		},
	}
	args := ItemArgs{
		Vault: "v1", Title: "t", Category: "PASSWORD",
		Fields: []Field{{Label: "managed", Value: "new"}},
	}

	body := buildMergedItemBody(existing, args, "abc", []string{"managed", "dropped"})

	for _, k := range []string{"sections", "tags", "urls"} {
		if _, ok := body[k]; !ok {
			t.Fatalf("%s must be preserved on the merged body", k)
		}
	}

	fields, _ := body["fields"].([]any)
	got := map[string]string{}
	for _, f := range fields {
		m := f.(map[string]any)
		got[m["label"].(string)] = m["value"].(string)
	}
	if got["unmanaged"] != "keep-me" {
		t.Fatalf("a field this resource never managed must survive; got %v", got)
	}
	if got["managed"] != "new" {
		t.Fatalf("a declared field must be upserted; got %v", got)
	}
	if _, present := got["dropped"]; present {
		t.Fatalf("a previously-managed field dropped from input must be removed; got %v", got)
	}
}

// On first adoption there is no record of prior management, so nothing may be
// removed — only upserted.
func TestAdoptionRemovesNothing(t *testing.T) {
	existing := map[string]any{
		"fields": []any{
			map[string]any{"label": "preexisting", "value": "keep", "type": "STRING"},
		},
	}
	args := ItemArgs{Vault: "v1", Title: "t", Category: "PASSWORD",
		Fields: []Field{{Label: "new", Value: "v"}}}

	body := buildMergedItemBody(existing, args, "abc", nil)
	fields, _ := body["fields"].([]any)
	if len(fields) != 2 {
		t.Fatalf("adoption must upsert without removing; got %d fields", len(fields))
	}
}

// Delete's 404 tolerance is what makes `pulumi destroy` idempotent for an item
// that was already removed out of band. It hinges on recognising the error, so
// pin that a WRAPPED *httpx.Error still matches: httpx returns its errors
// unwrapped today, and a bare type assertion would keep passing until someone
// adds a single `fmt.Errorf("…: %w")` to that client — at which point destroy
// starts failing and leaves the resource in state.
func TestAsHTTPErrorSeesThroughWrapping(t *testing.T) {
	base := &httpx.Error{Method: "DELETE", Path: "/v1/vaults/v/items/i", Status: http.StatusNotFound}

	for name, err := range map[string]error{
		"unwrapped": base,
		"wrapped":   fmt.Errorf("deleting item: %w", base),
		"twice":     fmt.Errorf("outer: %w", fmt.Errorf("inner: %w", base)),
	} {
		t.Run(name, func(t *testing.T) {
			var he *httpx.Error
			if !asHTTPError(err, &he) || he.Status != http.StatusNotFound {
				t.Fatalf("a 404 must be recognised through %s wrapping; got %v", name, he)
			}
		})
	}

	// A non-HTTP error must not be mistaken for one.
	var he *httpx.Error
	if asHTTPError(errors.New("dial tcp: connection refused"), &he) {
		t.Fatal("a transport error must not be treated as an HTTP status")
	}
}

// ContentHash sorts fields by label, and the TypeScript it must match sorted
// with localeCompare (item.ts:293) — ICU collation, not byte order. They
// disagree on mixed case, and a disagreement changes the hash, which surfaces
// as a spurious diff that REWRITES A LIVE SECRET.
//
// Rather than reimplement ICU collation, Check restricts multi-field items to
// the domain where the two orders are provably identical. These cases pin that
// boundary; the JS side of each was confirmed under node.
func TestCheckGuardsCollationUnsafeLabels(t *testing.T) {
	labelFailures := func(fields ...string) []string {
		vals := []property.Value{}
		for _, l := range fields {
			vals = append(vals, property.New(map[string]property.Value{
				"label": property.New(l), "value": property.New("v"),
			}))
		}
		resp, err := Item{}.Check(t.Context(), infer.CheckRequest{
			NewInputs: property.NewMap(map[string]property.Value{
				"connectToken": property.New("t"),
				"namespace":    property.New("1password"),
				"vault":        property.New("v"),
				"title":        property.New("item"),
				"fields":       property.New(vals),
			}),
		})
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, f := range resp.Failures {
			if strings.Contains(string(f.Property), ".label") {
				out = append(out, string(f.Property))
			}
		}
		return out
	}

	// A single field has nothing to sort, so its hash cannot depend on
	// collation. This is why the live `LiteLLM-Key` item is unaffected — the
	// guard must NOT fire here.
	if got := labelFailures("LiteLLM-Key"); len(got) != 0 {
		t.Fatalf("a single-field item has no sort and must not be constrained; got %v", got)
	}

	// The live multi-field item (gateway's mcp-consumer-tokens). Both orders
	// agree, so it must keep passing.
	if got := labelFailures("goose", "hermes", "claude-code"); len(got) != 0 {
		t.Fatalf("lowercase-kebab labels are collation-safe; got %v", got)
	}

	// node: ["LiteLLM-Key","api-token"].sort(localeCompare) => ["api-token","LiteLLM-Key"]
	//       byte order                                      => ["LiteLLM-Key","api-token"]
	// Mixed case is the real trigger — not non-ASCII, which is what makes this
	// easy to miss.
	if got := labelFailures("LiteLLM-Key", "api-token"); len(got) != 1 {
		t.Fatalf("mixed-case labels in a multi-field item must fail check; got %v", got)
	}
	if got := labelFailures("Alpha", "beta"); len(got) != 1 {
		t.Fatalf("a capitalised label must fail check; got %v", got)
	}
	// Underscores and dots are where a case-folding approximation of
	// localeCompare diverges, so they are outside the safe domain too.
	if got := labelFailures("a_b", "ab"); len(got) != 1 {
		t.Fatalf("underscored labels must fail check; got %v", got)
	}
}
