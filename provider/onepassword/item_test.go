package onepassword

import (
	"errors"
	"fmt"
	"net/http"
	"testing"

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
	got, err := ContentHash("API_CREDENTIAL", fields)
	if err != nil {
		t.Fatal(err)
	}
	if got != goldenHash {
		t.Fatalf("content hash diverged from the TypeScript implementation:\n got  %s\n want %s", got, goldenHash)
	}
}

func TestContentHashIsOrderInsensitive(t *testing.T) {
	a, err := ContentHash("PASSWORD", []Field{{Label: "x", Value: "1"}, {Label: "y", Value: "2"}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := ContentHash("PASSWORD", []Field{{Label: "y", Value: "2"}, {Label: "x", Value: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatal("reordering fields must not change the content hash")
	}
}

func TestContentHashDefaultsCategory(t *testing.T) {
	withDefault, err := ContentHash("", []Field{{Label: "x", Value: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	explicit, err := ContentHash("PASSWORD", []Field{{Label: "x", Value: "1"}})
	if err != nil {
		t.Fatal(err)
	}
	if withDefault != explicit {
		t.Fatal("an empty category must hash as the PASSWORD default")
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
