package onepassword

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"
	"github.com/pulumi/pulumi/sdk/v3/go/property"

	"github.com/jmmaloney4/sector7/provider/internal/kube"
)

// CRUD and Diff coverage inherited from the TypeScript dynamic provider.
//
// Subtest names carry the exact `it(...)` strings from
// tests/onepassword-item.test.ts, which the plugin retype deletes, so the two
// lists can be diffed mechanically during review. That file was the ONLY place
// these behaviours were exercised: the pre-existing Go tests cover pure
// functions (ContentHash, mergedBody, the collation guard) and never invoke
// Create, Update, Delete or Diff.
//
// This matters more here than for most resources. OnePasswordItem adopts by
// title in a SHARED vault, so a wrong adoption overwrites — or later deletes —
// somebody's unrelated hand-created secret.

type recorded struct {
	Method string
	Path   string
	Body   map[string]any
}

type harness struct {
	t   *testing.T
	srv *httptest.Server
	tr  *kube.Fake

	mu       sync.Mutex
	requests []recorded
}

// newHarness serves the Connect REST API from an httptest server and points a
// kube.Fake at it, so no Kubernetes and no real Connect server are involved.
//
// respond returns (status, payload) per request; nil means 200 {}.
func newHarness(t *testing.T, respond func(r recorded) (int, any)) *harness {
	t.Helper()
	h := &harness{t: t}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		rec := recorded{Method: r.Method, Path: r.URL.Path}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &rec.Body)
		}
		h.mu.Lock()
		h.requests = append(h.requests, rec)
		h.mu.Unlock()

		status, payload := 200, any(map[string]any{})
		if respond != nil {
			status, payload = respond(rec)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(payload)
	}))
	t.Cleanup(h.srv.Close)
	h.tr = &kube.Fake{BaseURL: h.srv.URL}
	return h
}

// seen copies under the lock: the server goroutine appends concurrently and
// `go test -race` catches a naked read.
func (h *harness) seen() []recorded {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]recorded(nil), h.requests...)
}

func (h *harness) calls() []string {
	var out []string
	for _, r := range h.seen() {
		out = append(out, r.Method+" "+r.Path)
	}
	return out
}

func (h *harness) item() Item { return Item{Transport: h.tr} }

func baseArgs() ItemArgs {
	return ItemArgs{
		ConnectToken:   "op-token",
		Namespace:      "1password",
		DeploymentName: "onepassword-connect",
		ConnectPort:    8080,
		Vault:          "vault-1",
		Title:          "my-item",
		Category:       "API_CREDENTIAL",
		Fields:         []Field{{Label: "password", Value: "s3cret"}},
	}
}

func baseState(t *testing.T) ItemState {
	t.Helper()
	a := baseArgs()
	return stateOuts(a, "uuid-1", mustContentHash(t, a.Category, a.Fields))
}

// listResponse is the /v1/vaults/<v>/items?filter=title eq "..." shape.
func listResponse(ids ...string) []any {
	out := make([]any, 0, len(ids))
	for _, id := range ids {
		out = append(out, map[string]any{"id": id, "title": "my-item"})
	}
	return out
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

func TestCheckCRUD(t *testing.T) {
	props := func(fs []p.CheckFailure) map[string]bool {
		out := map[string]bool{}
		for _, f := range fs {
			out[string(f.Property)] = true
		}
		return out
	}
	inputs := func(m map[string]property.Value) property.Map { return property.NewMap(m) }

	t.Run("check passes for valid inputs", func(t *testing.T) {
		resp, err := Item{}.Check(t.Context(), infer.CheckRequest{NewInputs: inputs(map[string]property.Value{
			"connectToken": property.New("op-token"),
			"namespace":    property.New("1password"),
			"vault":        property.New("vault-1"),
			"title":        property.New("my-item"),
			"fields": property.New([]property.Value{property.New(property.NewMap(map[string]property.Value{
				"label": property.New("password"), "value": property.New("s3cret"),
			}))}),
		})})
		if err != nil {
			t.Fatal(err)
		}
		if len(resp.Failures) != 0 {
			t.Fatalf("valid inputs must pass; got %+v", resp.Failures)
		}
	})

	t.Run("check flags missing required fields", func(t *testing.T) {
		resp, err := Item{}.Check(t.Context(), infer.CheckRequest{NewInputs: property.NewMap(nil)})
		if err != nil {
			t.Fatal(err)
		}
		got := props(resp.Failures)
		for _, want := range []string{"connectToken", "namespace", "vault", "title", "fields"} {
			if !got[want] {
				t.Fatalf("expected a failure for %q; got %+v", want, resp.Failures)
			}
		}
	})

	// Fields are keyed by label when merged into the item, so duplicates would
	// silently collapse (last write wins) and corrupt drift detection.
	t.Run("check rejects duplicate field labels", func(t *testing.T) {
		dup := property.New([]property.Value{
			property.New(property.NewMap(map[string]property.Value{
				"label": property.New("password"), "value": property.New("a"),
			})),
			property.New(property.NewMap(map[string]property.Value{
				"label": property.New("password"), "value": property.New("b"),
			})),
		})
		resp, err := Item{}.Check(t.Context(), infer.CheckRequest{NewInputs: inputs(map[string]property.Value{
			"connectToken": property.New("op-token"),
			"namespace":    property.New("1password"),
			"vault":        property.New("vault-1"),
			"title":        property.New("my-item"),
			"fields":       dup,
		})})
		if err != nil {
			t.Fatal(err)
		}
		if !props(resp.Failures)["fields[1].label"] {
			t.Fatalf("duplicate labels must fail check; got %+v", resp.Failures)
		}
	})
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

func TestDiffCRUD(t *testing.T) {
	t.Run("diff reports no change when content is identical", func(t *testing.T) {
		r, err := Item{}.Diff(t.Context(), infer.DiffRequest[ItemArgs, ItemState]{
			State: baseState(t), Inputs: baseArgs(),
		})
		if err != nil {
			t.Fatal(err)
		}
		if r.HasChanges {
			t.Fatalf("identical content must not diff; got %+v", r.DetailedDiff)
		}
	})

	t.Run("diff reports an in-place change when a field value changes", func(t *testing.T) {
		news := baseArgs()
		news.Fields = []Field{{Label: "password", Value: "rotated"}}
		r, _ := Item{}.Diff(t.Context(), infer.DiffRequest[ItemArgs, ItemState]{State: baseState(t), Inputs: news})
		if r.DetailedDiff["fields"].Kind != p.Update {
			t.Fatalf("a rotated value must be an in-place update; got %+v", r.DetailedDiff)
		}
		for name, d := range r.DetailedDiff {
			if d.Kind == p.UpdateReplace {
				t.Fatalf("a value change must never replace the item (%s did)", name)
			}
		}
	})

	// A rotated Connect token or a cluster move must reach state, or every later
	// update and delete authenticates with the stale one.
	t.Run("diff reports an in-place change when a transport input changes", func(t *testing.T) {
		for name, mutate := range map[string]func(*ItemArgs){
			"connectToken":   func(a *ItemArgs) { a.ConnectToken = "rotated" },
			"kubeconfig":     func(a *ItemArgs) { a.Kubeconfig = "apiVersion: v1" },
			"namespace":      func(a *ItemArgs) { a.Namespace = "other" },
			"deploymentName": func(a *ItemArgs) { a.DeploymentName = "other" },
			"connectPort":    func(a *ItemArgs) { a.ConnectPort = 9090 },
		} {
			news := baseArgs()
			mutate(&news)
			r, _ := Item{}.Diff(t.Context(), infer.DiffRequest[ItemArgs, ItemState]{State: baseState(t), Inputs: news})
			if !r.HasChanges {
				t.Fatalf("%s change must diff", name)
			}
			for dn, d := range r.DetailedDiff {
				if d.Kind == p.UpdateReplace {
					t.Fatalf("%s must not force replacement (%s did)", name, dn)
				}
			}
		}
	})

	// vault+title is the adoption key: a change there addresses a different
	// item entirely.
	t.Run("diff forces replacement when the vault changes", func(t *testing.T) {
		news := baseArgs()
		news.Vault = "vault-2"
		r, _ := Item{}.Diff(t.Context(), infer.DiffRequest[ItemArgs, ItemState]{State: baseState(t), Inputs: news})
		if r.DetailedDiff["vault"].Kind != p.UpdateReplace {
			t.Fatalf("vault change must replace; got %+v", r.DetailedDiff)
		}
	})

	t.Run("diff forces replacement when the title changes", func(t *testing.T) {
		news := baseArgs()
		news.Title = "renamed"
		r, _ := Item{}.Diff(t.Context(), infer.DiffRequest[ItemArgs, ItemState]{State: baseState(t), Inputs: news})
		if r.DetailedDiff["title"].Kind != p.UpdateReplace {
			t.Fatalf("title change must replace; got %+v", r.DetailedDiff)
		}
		// Never delete-before-replace: consumers reference the item by path and
		// must not see it vanish mid-update.
		if r.DeleteBeforeReplace {
			t.Fatal("must not delete before replacing — consumers read the item by path")
		}
	})
}

// ---------------------------------------------------------------------------
// Create / Update / Delete
// ---------------------------------------------------------------------------

func TestCreateCRUD(t *testing.T) {
	t.Run("create POSTs a new item when none exists", func(t *testing.T) {
		h := newHarness(t, func(r recorded) (int, any) {
			if r.Method == "GET" {
				return 200, []any{} // no match
			}
			return 200, map[string]any{"id": "new-uuid"}
		})
		resp, err := h.item().Create(t.Context(), infer.CreateRequest[ItemArgs]{Inputs: baseArgs()})
		if err != nil {
			t.Fatal(err)
		}
		if resp.ID != "new-uuid" {
			t.Fatalf("expected the created id; got %q", resp.ID)
		}
		var posted bool
		for _, c := range h.calls() {
			if strings.HasPrefix(c, "POST ") {
				posted = true
			}
			if strings.HasPrefix(c, "PUT ") {
				t.Fatalf("must not PUT when no item exists; calls=%v", h.calls())
			}
		}
		if !posted {
			t.Fatalf("expected a POST; calls=%v", h.calls())
		}
	})

	t.Run("create adopts an existing item by title (PUT, no POST)", func(t *testing.T) {
		h := newHarness(t, func(r recorded) (int, any) {
			switch {
			case r.Method == "GET" && strings.Contains(r.Path, "/items") && !strings.Contains(r.Path, "existing-uuid"):
				return 200, listResponse("existing-uuid")
			case r.Method == "GET":
				return 200, map[string]any{"id": "existing-uuid", "title": "my-item", "fields": []any{}}
			default:
				return 200, map[string]any{"id": "existing-uuid"}
			}
		})
		resp, err := h.item().Create(t.Context(), infer.CreateRequest[ItemArgs]{Inputs: baseArgs()})
		if err != nil {
			t.Fatal(err)
		}
		if resp.ID != "existing-uuid" {
			t.Fatalf("must adopt the existing item; got %q", resp.ID)
		}
		for _, c := range h.calls() {
			if strings.HasPrefix(c, "POST ") {
				t.Fatalf("adoption must not create a duplicate; calls=%v", h.calls())
			}
		}
	})

	// Titles are NOT unique in a vault. Adopting an arbitrary match could
	// overwrite — or later DELETE — an unrelated hand-created secret in a
	// shared vault, so ambiguity is a hard error rather than a guess.
	t.Run("create refuses to adopt when multiple items share the title", func(t *testing.T) {
		// The per-item GET is answered properly so that disabling the guard
		// produces a real adoption (and a PUT) rather than a decode error —
		// otherwise the negative control proves nothing.
		h := newHarness(t, func(r recorded) (int, any) {
			switch {
			case r.Method == "GET" && strings.HasSuffix(r.Path, "/items"):
				return 200, listResponse("uuid-a", "uuid-b")
			case r.Method == "GET":
				return 200, map[string]any{"id": "uuid-a", "title": "my-item", "fields": []any{}}
			default:
				return 200, map[string]any{"id": "uuid-a"}
			}
		})
		_, err := h.item().Create(t.Context(), infer.CreateRequest[ItemArgs]{Inputs: baseArgs()})
		if err == nil {
			t.Fatal("ambiguous title must be a hard error, never an arbitrary adoption")
		}
		// Pin the ambiguity path specifically: any error would satisfy a bare
		// nil-check, including an unrelated transport failure.
		if !strings.Contains(err.Error(), "unique title") {
			t.Fatalf("expected the ambiguity error, got: %v", err)
		}
		for _, c := range h.calls() {
			if strings.HasPrefix(c, "PUT ") || strings.HasPrefix(c, "POST ") {
				t.Fatalf("must not write anything when the title is ambiguous; calls=%v", h.calls())
			}
		}
	})

	// Adoption merges into somebody else's item: fields and sections this
	// resource does not declare must survive untouched, while a declared label
	// that already exists is overwritten with the managed value.
	t.Run("preserves unmanaged fields/sections when adopting an item", func(t *testing.T) {
		var putBody map[string]any
		h := newHarness(t, func(r recorded) (int, any) {
			switch {
			case r.Method == "GET" && strings.HasSuffix(r.Path, "/items"):
				return 200, listResponse("existing-uuid")
			case r.Method == "GET":
				return 200, map[string]any{
					"id": "existing-uuid", "title": "my-item", "category": "PASSWORD",
					"fields": []any{
						map[string]any{"label": "notes", "type": "STRING", "value": "keep me"},
						map[string]any{"label": "password", "type": "CONCEALED", "value": "old-value"},
					},
					"sections": []any{map[string]any{"id": "s1", "label": "extra"}},
				}
			default:
				if r.Method == "PUT" {
					putBody = r.Body
				}
				return 200, map[string]any{"id": "existing-uuid"}
			}
		})

		if _, err := h.item().Create(t.Context(), infer.CreateRequest[ItemArgs]{Inputs: baseArgs()}); err != nil {
			t.Fatal(err)
		}

		byLabel := map[string]map[string]any{}
		fs, _ := putBody["fields"].([]any)
		for _, f := range fs {
			if m, ok := f.(map[string]any); ok {
				byLabel[m["label"].(string)] = m
			}
		}
		if _, ok := byLabel["notes"]; !ok {
			t.Fatalf("an unmanaged field must be preserved on adoption; body=%v", putBody)
		}
		if got := byLabel["password"]["value"]; got != "s3cret" {
			t.Fatalf("the managed value must win over the pre-existing one; got %v", got)
		}
		want := []any{map[string]any{"id": "s1", "label": "extra"}}
		if !reflect.DeepEqual(putBody["sections"], want) {
			t.Fatalf("unmanaged sections must be preserved verbatim; got %v", putBody["sections"])
		}
	})

	t.Run("create throws a clear error when no Connect pod is ready", func(t *testing.T) {
		it := Item{Transport: &failingTransport{}}
		_, err := it.Create(t.Context(), infer.CreateRequest[ItemArgs]{Inputs: baseArgs()})
		if err == nil || !strings.Contains(err.Error(), "no ready pod") {
			t.Fatalf("expected the transport error to surface; got %v", err)
		}
	})
}

func TestUpdateCRUD(t *testing.T) {
	t.Run("update PUTs the existing item id in place", func(t *testing.T) {
		h := newHarness(t, func(r recorded) (int, any) {
			if r.Method == "GET" {
				return 200, map[string]any{"id": "uuid-1", "title": "my-item", "fields": []any{}}
			}
			return 200, map[string]any{"id": "uuid-1"}
		})
		news := baseArgs()
		news.Fields = []Field{{Label: "password", Value: "rotated"}}
		_, err := h.item().Update(t.Context(), infer.UpdateRequest[ItemArgs, ItemState]{
			ID: "uuid-1", State: baseState(t), Inputs: news,
		})
		if err != nil {
			t.Fatal(err)
		}
		var put bool
		for _, c := range h.calls() {
			if strings.HasPrefix(c, "PUT ") && strings.Contains(c, "uuid-1") {
				put = true
			}
			if strings.HasPrefix(c, "POST ") {
				t.Fatalf("update must not create; calls=%v", h.calls())
			}
		}
		if !put {
			t.Fatalf("expected a PUT against uuid-1; calls=%v", h.calls())
		}
	})

	// Dropping a field from inputs must remove it from the item — but only if
	// this resource put it there. managedLabels is what distinguishes ours from
	// somebody else's.
	t.Run("update removes a previously-managed field dropped from input", func(t *testing.T) {
		var putBody map[string]any
		h := newHarness(t, func(r recorded) (int, any) {
			if r.Method == "GET" {
				return 200, map[string]any{
					"id": "uuid-1", "title": "my-item",
					"fields": []any{
						map[string]any{"label": "password", "value": "s3cret"},
						map[string]any{"label": "stale", "value": "old"},
						map[string]any{"label": "unmanaged", "value": "keep"},
					},
				}
			}
			if r.Method == "PUT" {
				putBody = r.Body
			}
			return 200, map[string]any{"id": "uuid-1"}
		})

		old := baseState(t)
		old.ManagedLabels = []string{"password", "stale"}
		news := baseArgs() // only `password` remains

		if _, err := h.item().Update(t.Context(), infer.UpdateRequest[ItemArgs, ItemState]{
			ID: "uuid-1", State: old, Inputs: news,
		}); err != nil {
			t.Fatal(err)
		}

		labels := map[string]bool{}
		if fs, ok := putBody["fields"].([]any); ok {
			for _, f := range fs {
				if m, ok := f.(map[string]any); ok {
					labels[m["label"].(string)] = true
				}
			}
		}
		if labels["stale"] {
			t.Fatalf("a dropped managed field must be removed; body=%v", putBody)
		}
		if !labels["unmanaged"] {
			t.Fatalf("an unmanaged field must be preserved; body=%v", putBody)
		}
		if !labels["password"] {
			t.Fatalf("the still-declared field must survive; body=%v", putBody)
		}
	})
}

func TestDeleteCRUD(t *testing.T) {
	t.Run("delete DELETEs the item", func(t *testing.T) {
		h := newHarness(t, nil)
		if _, err := h.item().Delete(t.Context(), infer.DeleteRequest[ItemState]{
			ID: "uuid-1", State: baseState(t),
		}); err != nil {
			t.Fatal(err)
		}
		var deleted bool
		for _, c := range h.calls() {
			if strings.HasPrefix(c, "DELETE ") && strings.Contains(c, "uuid-1") {
				deleted = true
			}
		}
		if !deleted {
			t.Fatalf("expected a DELETE against uuid-1; calls=%v", h.calls())
		}
	})

	// An item already removed out of band means the desired end state is
	// reached. Failing here strands the resource in state and reds every
	// subsequent up.
	t.Run("delete treats a 404 as success (idempotent destroy)", func(t *testing.T) {
		h := newHarness(t, func(recorded) (int, any) {
			return 404, map[string]any{"message": "not found"}
		})
		if _, err := h.item().Delete(t.Context(), infer.DeleteRequest[ItemState]{
			ID: "uuid-1", State: baseState(t),
		}); err != nil {
			t.Fatalf("a 404 on delete must succeed; got %v", err)
		}
	})

	t.Run("delete rethrows non-404 errors", func(t *testing.T) {
		h := newHarness(t, func(recorded) (int, any) {
			return 403, map[string]any{"message": "forbidden"}
		})
		if _, err := h.item().Delete(t.Context(), infer.DeleteRequest[ItemState]{
			ID: "uuid-1", State: baseState(t),
		}); err == nil {
			t.Fatal("a 403 must not be swallowed — the item still exists")
		}
	})
}

// Connect response bodies can echo secret values, so they must never reach an
// error string. httpx renders method/path/status only.
func TestDoesNotLeakConnectResponseBodyIntoErrors(t *testing.T) {
	const leak = "SUPER-SECRET-VALUE"
	h := newHarness(t, func(recorded) (int, any) {
		return 500, map[string]any{"message": leak, "field": leak}
	})
	_, err := h.item().Delete(t.Context(), infer.DeleteRequest[ItemState]{
		ID: "uuid-1", State: baseState(t),
	})
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), leak) {
		t.Fatalf("the Connect response body must not reach the error string: %q", err.Error())
	}
}

// failingTransport stands in for a cluster with no ready Connect pod.
type failingTransport struct{}

func (*failingTransport) Connect(_ context.Context, _ kube.Target) (*kube.Conn, error) {
	return nil, errors.New("sector7: no ready pod for deployment 1password/onepassword-connect")
}
