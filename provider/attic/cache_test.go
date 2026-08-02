package attic

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	pgo "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/internal/kube"
)

type rec struct {
	Method, Path string
	Body         map[string]any
	Host         string
}

type harness struct {
	srv *httptest.Server
	tr  *kube.Fake
	mu  sync.Mutex
	Req []rec
}

func newHarness(t *testing.T, respond func(rec) (int, any)) *harness {
	t.Helper()
	h := &harness{}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e := rec{Method: r.Method, Path: r.URL.Path, Host: r.Host}
		_ = json.NewDecoder(r.Body).Decode(&e.Body)
		h.mu.Lock()
		h.Req = append(h.Req, e)
		h.mu.Unlock()
		status, payload := 200, any(map[string]any{})
		if respond != nil {
			status, payload = respond(e)
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(payload)
	}))
	t.Cleanup(h.srv.Close)
	h.tr = &kube.Fake{BaseURL: h.srv.URL}
	return h
}

func (h *harness) find(m, p string) *rec {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i := range h.Req {
		if h.Req[i].Method == m && h.Req[i].Path == p {
			return &h.Req[i]
		}
	}
	return nil
}

func baseCacheArgs() CacheArgs {
	return CacheArgs{
		Namespace: "attic", HS256SecretBase64: base64.StdEncoding.EncodeToString([]byte("k")),
		DeploymentName: "attic", Port: 8080,
		CacheName: "org-cache", IsPublic: true, Priority: 40, StoreDir: "/nix/store",
	}
}

// Adoption must go through PATCH, never POST, so the keypair — and therefore
// every client's trusted-public-keys — survives.
func TestCreateAdoptsExistingCacheWithoutRegeneratingTheKeypair(t *testing.T) {
	h := newHarness(t, func(r rec) (int, any) {
		switch r.Method {
		case "POST":
			return 400, map[string]any{"error": "CacheAlreadyExists"}
		case "GET":
			return 200, map[string]any{"store_dir": "/nix/store", "public_key": "org-cache:abc="}
		}
		return 200, map[string]any{}
	})

	resp, err := Cache{Transport: h.tr}.Create(t.Context(),
		infer.CreateRequest[CacheArgs]{Inputs: baseCacheArgs()})
	if err != nil {
		t.Fatal(err)
	}
	patch := h.find("PATCH", "/_api/v1/cache-config/org-cache")
	if patch == nil {
		t.Fatal("adoption must reconcile via PATCH")
	}
	if _, present := patch.Body["keypair"]; present {
		t.Fatal("PATCH must never carry keypair — that would rotate the signing key")
	}
	if _, present := patch.Body["store_dir"]; present {
		t.Fatal("PATCH must never carry store_dir — it is immutable in this model")
	}
	if resp.Output.PublicKey != "org-cache:abc=" {
		t.Fatalf("public key: %q", resp.Output.PublicKey)
	}
}

// Fail CLOSED when the immutable store_dir cannot be confirmed, rather than
// adopting an unverified cache and recording an assumed storeDir in state.
func TestCreateRefusesToAdoptOnStoreDirMismatch(t *testing.T) {
	for _, existing := range []any{
		map[string]any{"store_dir": "/other/store", "public_key": "k"},
		map[string]any{"public_key": "k"}, // absent entirely
	} {
		h := newHarness(t, func(r rec) (int, any) {
			if r.Method == "POST" {
				return 400, map[string]any{"error": "CacheAlreadyExists"}
			}
			return 200, existing
		})
		_, err := Cache{Transport: h.tr}.Create(t.Context(),
			infer.CreateRequest[CacheArgs]{Inputs: baseCacheArgs()})
		if err == nil || !strings.Contains(err.Error(), "store_dir") {
			t.Fatalf("expected a store_dir refusal, got %v", err)
		}
		if h.find("PATCH", "/_api/v1/cache-config/org-cache") != nil {
			t.Fatal("must not PATCH a cache it refused to adopt")
		}
	}
}

// A missing public_key must fail loudly: persisting "" would record an unusable
// signing key and hide a broken Attic API.
func TestCreateFailsWhenPublicKeyIsAbsent(t *testing.T) {
	h := newHarness(t, func(r rec) (int, any) {
		if r.Method == "GET" {
			return 200, map[string]any{"store_dir": "/nix/store"}
		}
		return 200, map[string]any{}
	})
	_, err := Cache{Transport: h.tr}.Create(t.Context(),
		infer.CreateRequest[CacheArgs]{Inputs: baseCacheArgs()})
	if err == nil || !strings.Contains(err.Error(), "public_key") {
		t.Fatalf("expected a public_key error, got %v", err)
	}
}

// Attic validates the Host header against allowed-hosts, so the in-cluster
// Service FQDN must be sent even though the connection is to 127.0.0.1. Node's
// fetch silently drops a Host override; Go's net/http honours req.Host.
func TestSendsTheInClusterServiceFQDNAsHost(t *testing.T) {
	h := newHarness(t, func(r rec) (int, any) {
		if r.Method == "GET" {
			return 200, map[string]any{"store_dir": "/nix/store", "public_key": "k"}
		}
		return 200, map[string]any{}
	})
	if _, err := (Cache{Transport: h.tr}).Create(t.Context(),
		infer.CreateRequest[CacheArgs]{Inputs: baseCacheArgs()}); err != nil {
		t.Fatal(err)
	}
	got := h.Req[0].Host
	if got != "attic.attic.svc.cluster.local" {
		t.Fatalf("Host header = %q, want the in-cluster Service FQDN", got)
	}
}

func TestDeleteToleratesAlreadyGone(t *testing.T) {
	h := newHarness(t, func(rec) (int, any) { return 404, map[string]any{} })
	state := CacheState{CacheArgs: baseCacheArgs(), PublicKey: "k"}
	if _, err := (Cache{Transport: h.tr}).Delete(t.Context(),
		infer.DeleteRequest[CacheState]{ID: "org-cache", State: state}); err != nil {
		t.Fatalf("a cache already removed out of band must not fail destroy; got %v", err)
	}
}

func TestRetentionPeriodWireForm(t *testing.T) {
	if got := RetentionPeriod(nil); got != "Global" {
		t.Fatalf("unset retention must render as Global, got %v", got)
	}
	secs := 86400
	m, ok := RetentionPeriod(&secs).(map[string]any)
	if !ok || m["Period"] != 86400 {
		t.Fatalf("set retention must render as {Period: n}, got %v", RetentionPeriod(&secs))
	}
}

func TestCacheDiffReplacesOnIdentityOnly(t *testing.T) {
	old := CacheState{CacheArgs: baseCacheArgs(), PublicKey: "k"}

	renamed := baseCacheArgs()
	renamed.CacheName = "other"
	r, _ := Cache{}.Diff(t.Context(), infer.DiffRequest[CacheArgs, CacheState]{State: old, Inputs: renamed})
	if r.DetailedDiff["cacheName"].Kind != pgo.UpdateReplace {
		t.Fatal("a rename is a different cache and must replace")
	}

	// Priority is mutable — must NOT replace, or the keypair is regenerated.
	repriced := baseCacheArgs()
	repriced.Priority = 10
	r, _ = Cache{}.Diff(t.Context(), infer.DiffRequest[CacheArgs, CacheState]{State: old, Inputs: repriced})
	if !r.HasChanges {
		t.Fatal("a priority change must be a change")
	}
	for k, v := range r.DetailedDiff {
		if v.Kind == pgo.UpdateReplace {
			t.Fatalf("a priority change must not replace; %s did", k)
		}
	}
}
