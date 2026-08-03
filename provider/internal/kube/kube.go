// Package kube provides the in-cluster port-forward transport that lets
// out-of-cluster provider operations reach a ClusterIP-only Service. The
// connection rides the kube-apiserver the deployer already authenticates to,
// so the target needs no tailnet or public ingress.
//
// This replaces packages/sector7/k8s/port-forward.ts. That module carried a
// long "SERIALIZATION CONTRACT" comment forbidding top-level imports of heavy
// third-party packages, because Pulumi serialised the enclosing provider
// closure into stack state and re-evaluated it from the *consumer's* working
// directory. None of that applies to a plugin: this binary has its own process
// and its own dependency closure, so the contract — and the absolute-path
// pre-resolution that froze a git worktree path into state — is deleted
// outright. That failure is the reason this provider exists.
package kube

import "context"

// Target identifies a Deployment to forward to.
type Target struct {
	// Kubeconfig is YAML. Empty means the ambient default config, which is
	// what every current sector7 call site relies on (litellm and attic never
	// pass one; only OnePasswordItem may).
	Kubeconfig string
	Namespace  string
	Deployment string
	Port       int
}

// Conn is an open forward. Close must be called exactly once.
type Conn struct {
	// BaseURL is http://127.0.0.1:<ephemeral>.
	BaseURL string
	// Host is <deployment>.<namespace>.svc.cluster.local, for callers whose
	// upstream validates the Host header (Attic's allowed-hosts check).
	Host string
	// Close tears down the forward and any sockets opened over it.
	Close func()
}

// Transport opens port-forwards.
//
// This is an interface rather than a concrete type for one reason: it is the
// testability seam. The TypeScript tests faked the transport by mocking
// @kubernetes/client-node and node:net wholesale
// (packages/sector7/tests/litellm-admin.test.ts). Here, resource tests inject a
// Fake pointing at an httptest.Server and never touch Kubernetes at all, while
// production wires SPDYTransport.
type Transport interface {
	Connect(ctx context.Context, t Target) (*Conn, error)
}

// Fake is a Transport that returns a fixed base URL. For tests.
type Fake struct {
	BaseURL string
	HostVal string
	// Connects counts calls, so tests can assert the per-operation forward
	// behaviour (each CRUD method opens its own).
	Connects int
	// LastTarget is the most recent Target received.
	//
	// Without it a resource can silently drop part of its connection inputs —
	// Kubeconfig especially — and every test still passes, because the Fake
	// ignores the Target and hands back the same BaseURL regardless. The only
	// visible symptom is in production, as a port-forward opened against the
	// wrong cluster identity.
	LastTarget Target
}

func (f *Fake) Connect(_ context.Context, t Target) (*Conn, error) {
	f.Connects++
	f.LastTarget = t
	host := f.HostVal
	if host == "" {
		host = t.Deployment + "." + t.Namespace + ".svc.cluster.local"
	}
	return &Conn{BaseURL: f.BaseURL, Host: host, Close: func() {}}, nil
}
