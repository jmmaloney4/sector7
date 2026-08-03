package litellm

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/internal/kube"
)

// recorded is one captured admin request.
type recorded struct {
	Method string
	Path   string
	Body   map[string]any
}

// harness stands in for the vi.mock() stack in
// packages/sector7/tests/litellm-admin.test.ts: a fake port-forward transport
// pointed at an httptest server, so tests exercise the real CRUD paths without
// touching Kubernetes.
type harness struct {
	t   *testing.T
	srv *httptest.Server
	tr  *kube.Fake
	// mu guards Requests. findKeyHashesByAlias fans /key/info out across
	// goroutines by design, so the httptest handler is genuinely concurrent —
	// `go test -race` catches an unguarded append here.
	mu       sync.Mutex
	Requests []recorded
}

func newHarness(t *testing.T, respond func(r recorded) (int, any)) *harness {
	t.Helper()
	h := &harness{t: t}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := recorded{Method: r.Method, Path: r.URL.Path}
		if r.URL.RawQuery != "" {
			rec.Path += "?" + r.URL.RawQuery
		}
		if r.Body != nil {
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			rec.Body = b
		}
		h.mu.Lock()
		h.Requests = append(h.Requests, rec)
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

func (h *harness) paths() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.Requests))
	for _, r := range h.Requests {
		out = append(out, r.Method+" "+r.Path)
	}
	return out
}

func (h *harness) find(prefix string) *recorded {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i := range h.Requests {
		if strings.HasPrefix(h.Requests[i].Method+" "+h.Requests[i].Path, prefix) {
			return &h.Requests[i]
		}
	}
	return nil
}

func baseKeyArgs() KeyArgs {
	return KeyArgs{
		AdminTarget: AdminTarget{
			ProxyNamespace: "litellm", MasterKey: "sk-master",
			ProxyDeploymentName: "litellm", ProxyPort: 4000,
		},
		KeyAlias: "prod-personal", KeyValue: "sk-abc",
		Models: []string{"coding", "cheap"}, TeamID: "personal",
	}
}

// ---------------------------------------------------------------------------
// Diff — subtest names mirror the `it(...)` strings they replace.
// ---------------------------------------------------------------------------

func TestKeyDiff(t *testing.T) {
	base := baseKeyArgs()
	state := KeyState{KeyArgs: base, TokenID: "hash-1"}

	t.Run("treats a models change as an in-place update", func(t *testing.T) {
		news := base
		news.Models = []string{"coding", "cheap", "lite"}
		resp, _ := KeyRecord{}.Diff(t.Context(), infer.DiffRequest[KeyArgs, KeyState]{State: state, Inputs: news})
		if !resp.HasChanges {
			t.Fatal("expected changes")
		}
		if _, ok := resp.DetailedDiff["keyValue"]; ok {
			t.Fatal("models change must not replace")
		}
	})

	t.Run("ignores model ordering", func(t *testing.T) {
		news := base
		news.Models = []string{"cheap", "coding"}
		resp, _ := KeyRecord{}.Diff(t.Context(), infer.DiffRequest[KeyArgs, KeyState]{State: state, Inputs: news})
		if resp.HasChanges {
			t.Fatalf("reordering models must not be a change; got %+v", resp.DetailedDiff)
		}
	})

	t.Run("replaces when the key value rotates", func(t *testing.T) {
		news := base
		news.KeyValue = "sk-rotated"
		resp, _ := KeyRecord{}.Diff(t.Context(), infer.DiffRequest[KeyArgs, KeyState]{State: state, Inputs: news})
		if resp.DetailedDiff["keyValue"].Kind != p.UpdateReplace {
			t.Fatalf("keyValue must force replacement; got %+v", resp.DetailedDiff)
		}
		if !resp.DeleteBeforeReplace {
			t.Fatal("key replacement must delete before create — the alias cannot be duplicated")
		}
	})

	t.Run("replaces when the team changes", func(t *testing.T) {
		news := base
		news.TeamID = "research"
		resp, _ := KeyRecord{}.Diff(t.Context(), infer.DiffRequest[KeyArgs, KeyState]{State: state, Inputs: news})
		if resp.DetailedDiff["teamId"].Kind != p.UpdateReplace {
			t.Fatalf("teamId must force replacement; got %+v", resp.DetailedDiff)
		}
	})

	t.Run("treats an admin-target change as in-place", func(t *testing.T) {
		news := base
		news.MasterKey = "sk-rotated-master"
		news.ProxyNamespace = "litellm-2"
		resp, _ := KeyRecord{}.Diff(t.Context(), infer.DiffRequest[KeyArgs, KeyState]{State: state, Inputs: news})
		if !resp.HasChanges {
			t.Fatal("admin-target change must flow into state")
		}
		for k, v := range resp.DetailedDiff {
			if v.Kind == p.UpdateReplace {
				t.Fatalf("admin-target change must not replace; %s did", k)
			}
		}
	})
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

func TestKeyCreate(t *testing.T) {
	t.Run("generates a key when none exists", func(t *testing.T) {
		h := newHarness(t, func(r recorded) (int, any) {
			switch {
			case strings.HasPrefix(r.Path, "/key/list"):
				return 200, map[string]any{"keys": []any{}}
			case r.Path == "/key/generate":
				return 200, map[string]any{"token": "hash-new"}
			}
			return 200, map[string]any{}
		})
		resp, err := KeyRecord{Transport: h.tr}.Create(t.Context(),
			infer.CreateRequest[KeyArgs]{Inputs: baseKeyArgs()})
		if err != nil {
			t.Fatal(err)
		}
		if resp.ID != "hash-new" || resp.Output.TokenID != "hash-new" {
			t.Fatalf("id/tokenId should be the LiteLLM hash; got %q / %q", resp.ID, resp.Output.TokenID)
		}
		gen := h.find("POST /key/generate")
		if gen.Body["key"] != "sk-abc" {
			t.Fatalf("generate must carry the supplied sk- value; got %v", gen.Body["key"])
		}
		if h.find("POST /key/delete") != nil {
			t.Fatal("must not delete when no key matched")
		}
	})

	t.Run("deletes a pre-existing key with the same alias and team", func(t *testing.T) {
		h := newHarness(t, func(r recorded) (int, any) {
			switch {
			case strings.HasPrefix(r.Path, "/key/list"):
				return 200, map[string]any{"keys": []any{"hash-old"}}
			case strings.HasPrefix(r.Path, "/key/info"):
				return 200, map[string]any{"info": map[string]any{"key_alias": "prod-personal", "team_id": "personal"}}
			case r.Path == "/key/generate":
				return 200, map[string]any{"token": "hash-new"}
			}
			return 200, map[string]any{}
		})
		if _, err := (KeyRecord{Transport: h.tr}).Create(t.Context(),
			infer.CreateRequest[KeyArgs]{Inputs: baseKeyArgs()}); err != nil {
			t.Fatal(err)
		}
		del := h.find("POST /key/delete")
		if del == nil {
			t.Fatalf("expected a delete; saw %v", h.paths())
		}
		keys, _ := del.Body["keys"].([]any)
		if len(keys) != 1 || keys[0] != "hash-old" {
			t.Fatalf("expected [hash-old]; got %v", del.Body["keys"])
		}
	})

	// The authorization-boundary case: deleting on alias alone would destroy
	// another team's credential on a shared admin plane.
	t.Run("does NOT delete a same-alias key owned by a different team", func(t *testing.T) {
		h := newHarness(t, func(r recorded) (int, any) {
			switch {
			case strings.HasPrefix(r.Path, "/key/list"):
				return 200, map[string]any{"keys": []any{"hash-other-team"}}
			case strings.HasPrefix(r.Path, "/key/info"):
				return 200, map[string]any{"info": map[string]any{"key_alias": "prod-personal", "team_id": "research"}}
			case r.Path == "/key/generate":
				return 200, map[string]any{"token": "hash-new"}
			}
			return 200, map[string]any{}
		})
		if _, err := (KeyRecord{Transport: h.tr}).Create(t.Context(),
			infer.CreateRequest[KeyArgs]{Inputs: baseKeyArgs()}); err != nil {
			t.Fatal(err)
		}
		if h.find("POST /key/delete") != nil {
			t.Fatalf("must not touch another team's key; saw %v", h.paths())
		}
	})

	t.Run("deletes ALL duplicates, not just the first", func(t *testing.T) {
		h := newHarness(t, func(r recorded) (int, any) {
			switch {
			case strings.HasPrefix(r.Path, "/key/list"):
				return 200, map[string]any{"keys": []any{"hash-a", "hash-b"}}
			case strings.HasPrefix(r.Path, "/key/info"):
				return 200, map[string]any{"info": map[string]any{"key_alias": "prod-personal", "team_id": "personal"}}
			case r.Path == "/key/generate":
				return 200, map[string]any{"token": "hash-new"}
			}
			return 200, map[string]any{}
		})
		if _, err := (KeyRecord{Transport: h.tr}).Create(t.Context(),
			infer.CreateRequest[KeyArgs]{Inputs: baseKeyArgs()}); err != nil {
			t.Fatal(err)
		}
		keys, _ := h.find("POST /key/delete").Body["keys"].([]any)
		if len(keys) != 2 {
			t.Fatalf("expected both duplicates cleared; got %v", keys)
		}
	})

	// Guards the credential from becoming the resource id, which Pulumi stores
	// in plaintext.
	t.Run("rejects a generate response with no token id", func(t *testing.T) {
		h := newHarness(t, func(r recorded) (int, any) {
			if strings.HasPrefix(r.Path, "/key/list") {
				return 200, map[string]any{"keys": []any{}}
			}
			return 200, map[string]any{}
		})
		_, err := KeyRecord{Transport: h.tr}.Create(t.Context(),
			infer.CreateRequest[KeyArgs]{Inputs: baseKeyArgs()})
		if err == nil || !strings.Contains(err.Error(), "no token id") {
			t.Fatalf("expected a no-token-id error; got %v", err)
		}
	})
}

// ---------------------------------------------------------------------------
// Read — the status matrix. Getting this wrong either hides a vanished key or
// churns a live credential on a transient blip.
// ---------------------------------------------------------------------------

func TestKeyRead(t *testing.T) {
	state := KeyState{KeyArgs: baseKeyArgs(), TokenID: "hash-1"}

	for _, tc := range []struct {
		name    string
		status  int
		wantID  string
		wantErr bool
	}{
		{"keeps state when the key still exists (200)", 200, "hash-1", false},
		{"reports gone on 404", 404, "", false},
		{"reports gone on 400 (LiteLLM's missing-token shape)", 400, "", false},
		{"preserves state on 401 rather than recreating", 401, "", true},
		{"preserves state on 500 rather than recreating", 500, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, func(recorded) (int, any) { return tc.status, map[string]any{"info": map[string]any{}} })
			resp, err := KeyRecord{Transport: h.tr}.Read(t.Context(),
				infer.ReadRequest[KeyArgs, KeyState]{ID: "hash-1", Inputs: state.KeyArgs, State: state})
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected the error to propagate so state is preserved")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if resp.ID != tc.wantID {
				t.Fatalf("ID = %q, want %q", resp.ID, tc.wantID)
			}
		})
	}

	t.Run("reports gone without probing when no token is persisted", func(t *testing.T) {
		h := newHarness(t, nil)
		empty := KeyState{KeyArgs: baseKeyArgs()}
		resp, err := KeyRecord{Transport: h.tr}.Read(t.Context(),
			infer.ReadRequest[KeyArgs, KeyState]{ID: "", Inputs: empty.KeyArgs, State: empty})
		if err != nil || resp.ID != "" {
			t.Fatalf("want gone, got id=%q err=%v", resp.ID, err)
		}
		if len(h.Requests) != 0 {
			t.Fatalf("must not call the API at all; saw %v", h.paths())
		}
	})
}

// ---------------------------------------------------------------------------
// Update / Delete
// ---------------------------------------------------------------------------

func TestKeyUpdate(t *testing.T) {
	t.Run("keys /key/update on the plaintext sk- value", func(t *testing.T) {
		h := newHarness(t, nil)
		news := baseKeyArgs()
		news.Models = []string{"coding"}
		state := KeyState{KeyArgs: baseKeyArgs(), TokenID: "hash-1"}
		if _, err := (KeyRecord{Transport: h.tr}).Update(t.Context(),
			infer.UpdateRequest[KeyArgs, KeyState]{ID: "hash-1", State: state, Inputs: news}); err != nil {
			t.Fatal(err)
		}
		upd := h.find("POST /key/update")
		if upd.Body["key"] != "sk-abc" {
			t.Fatalf("update must be keyed on the sk- value, not the hash; got %v", upd.Body["key"])
		}
	})

	t.Run("clears fields removed since the last apply", func(t *testing.T) {
		h := newHarness(t, nil)
		budget := 250.0
		old := baseKeyArgs()
		old.MaxBudget, old.BudgetDuration, old.Duration, old.Tags = &budget, "30d", "7d", []string{"a"}
		state := KeyState{KeyArgs: old, TokenID: "hash-1"}

		if _, err := (KeyRecord{Transport: h.tr}).Update(t.Context(),
			infer.UpdateRequest[KeyArgs, KeyState]{ID: "hash-1", State: state, Inputs: baseKeyArgs()}); err != nil {
			t.Fatal(err)
		}
		b := h.find("POST /key/update").Body
		for _, f := range []string{"max_budget", "budget_duration", "duration"} {
			v, present := b[f]
			if !present || v != nil {
				t.Fatalf("%s must be explicitly null (omission means 'leave unchanged'); got %v present=%v", f, v, present)
			}
		}
		tags, _ := b["tags"].([]any)
		if tags == nil || len(tags) != 0 {
			t.Fatalf("tags must be an explicit empty array; got %v", b["tags"])
		}
	})
}

func TestKeyDelete(t *testing.T) {
	t.Run("deletes by token hash", func(t *testing.T) {
		h := newHarness(t, nil)
		state := KeyState{KeyArgs: baseKeyArgs(), TokenID: "hash-1"}
		if _, err := (KeyRecord{Transport: h.tr}).Delete(t.Context(),
			infer.DeleteRequest[KeyState]{ID: "hash-1", State: state}); err != nil {
			t.Fatal(err)
		}
		keys, _ := h.find("POST /key/delete").Body["keys"].([]any)
		if len(keys) != 1 || keys[0] != "hash-1" {
			t.Fatalf("expected [hash-1]; got %v", keys)
		}
	})
}

// Delete is marked idempotent so httpx retries it on transport errors. That
// makes "already gone" reachable: if the first attempt succeeds but its
// response is lost, the retry sees a 404/400 for a token that no longer exists.
// Returning that error would fail the operation — and Pulumi keeps a resource in
// state when Delete fails, so every subsequent `up` would fail on the same 404.
func TestKeyDeleteToleratesAlreadyGone(t *testing.T) {
	for _, status := range []int{404, 400} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			h := newHarness(t, func(recorded) (int, any) {
				return status, map[string]any{"detail": "not found"}
			})
			state := KeyState{KeyArgs: baseKeyArgs(), TokenID: "hash-1"}
			if _, err := (KeyRecord{Transport: h.tr}).Delete(t.Context(),
				infer.DeleteRequest[KeyState]{ID: "hash-1", State: state}); err != nil {
				t.Fatalf("a delete of an already-absent key must succeed; got %v", err)
			}
		})
	}

	t.Run("but a real failure still propagates", func(t *testing.T) {
		h := newHarness(t, func(recorded) (int, any) { return 401, map[string]any{} })
		state := KeyState{KeyArgs: baseKeyArgs(), TokenID: "hash-1"}
		if _, err := (KeyRecord{Transport: h.tr}).Delete(t.Context(),
			infer.DeleteRequest[KeyState]{ID: "hash-1", State: state}); err == nil {
			t.Fatal("401 must not be swallowed as 'already gone'")
		}
	})
}

// The kubeconfig must actually reach the transport.
//
// The ambient default config is whatever kubectl happens to point at, which is
// usually NOT the identity the rest of the stack deploys with. Dropping this
// input anywhere between the resource and kube.Target is invisible to every
// other test — the Fake ignores the Target and returns the same BaseURL — and
// shows up only in production, as a port-forward refused for the wrong user:
//
//	deployments.apps "litellm" is forbidden: User "pulumi-zeus" cannot get
//	resource "deployments" in API group "apps" in the namespace "litellm"
func TestAdminTargetKubeconfigReachesTheTransport(t *testing.T) {
	const kubeconfig = "apiVersion: v1\nkind: Config\n# platform identity\n"

	t.Run("forwarded when set", func(t *testing.T) {
		h := newHarness(t, nil)
		args := baseKeyArgs()
		args.Kubeconfig = kubeconfig

		if _, _, err := connect(t.Context(), h.tr, args.AdminTarget); err != nil {
			t.Fatal(err)
		}
		if got := h.tr.LastTarget.Kubeconfig; got != kubeconfig {
			t.Fatalf("kubeconfig did not reach kube.Target: got %q", got)
		}
		// The rest of the target must still be carried, or a correct
		// kubeconfig would just point at the wrong deployment.
		if h.tr.LastTarget.Namespace != "litellm" ||
			h.tr.LastTarget.Deployment != "litellm" ||
			h.tr.LastTarget.Port != 4000 {
			t.Fatalf("rest of the target was dropped: %+v", h.tr.LastTarget)
		}
	})

	t.Run("empty when unset, meaning ambient", func(t *testing.T) {
		h := newHarness(t, nil)
		if _, _, err := connect(t.Context(), h.tr, baseKeyArgs().AdminTarget); err != nil {
			t.Fatal(err)
		}
		if got := h.tr.LastTarget.Kubeconfig; got != "" {
			t.Fatalf("unset kubeconfig must stay empty (ambient), got %q", got)
		}
	})
}

// A rotated kubeconfig has to land in state, or every later operation keeps
// using the stale one. Both resources share AdminTarget.Changed so they cannot
// disagree about what counts as an admin-target change.
func TestKubeconfigChangeIsAnAdminTargetDiff(t *testing.T) {
	old := KeyState{KeyArgs: baseKeyArgs()}
	news := baseKeyArgs()
	news.Kubeconfig = "apiVersion: v1\nkind: Config\n# rotated\n"

	r, err := KeyRecord{}.Diff(t.Context(), infer.DiffRequest[KeyArgs, KeyState]{State: old, Inputs: news})
	if err != nil {
		t.Fatal(err)
	}
	if r.DetailedDiff["adminTarget"].Kind != p.Update {
		t.Fatalf("a rotated kubeconfig must be an in-place adminTarget update; got %+v", r.DetailedDiff)
	}
	for name, d := range r.DetailedDiff {
		if d.Kind == p.UpdateReplace {
			t.Fatalf("a kubeconfig change must never replace a live key (%s did)", name)
		}
	}

	// Unchanged inputs must stay a no-op — this is what keeps the six live
	// credentials from churning on every apply.
	r, _ = KeyRecord{}.Diff(t.Context(), infer.DiffRequest[KeyArgs, KeyState]{State: old, Inputs: baseKeyArgs()})
	if r.HasChanges {
		t.Fatalf("unchanged inputs must not diff; got %+v", r.DetailedDiff)
	}
}
