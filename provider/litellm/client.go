// Package litellm implements the sector7 provider's LiteLLM admin resources.
//
// Ported from packages/sector7/litellm/admin.ts. The behavioural contract is
// the TypeScript test suite (packages/sector7/tests/litellm-admin.test.ts);
// every case there has a counterpart here carrying the same subtest name, so
// the two lists can be diffed mechanically during review.
package litellm

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/jmmaloney4/sector7/provider/internal/httpx"
	"github.com/jmmaloney4/sector7/provider/internal/kube"
)

// AdminTarget is the connection half of every LiteLLM resource's inputs.
//
// Property names and defaults are byte-compatible with the dynamic provider's
// serialised state, so retyping a live resource via
// `aliases: [{ type: "pulumi-nodejs:dynamic:Resource" }]` diffs to nothing.
// Do not "improve" these names in the retype release.
type AdminTarget struct {
	ProxyNamespace string `pulumi:"proxyNamespace"`
	// MasterKey is secret here even though the dynamic provider did NOT mark it
	// so — it currently sits in plaintext in litellm/prod state on eight
	// resources. Marking it fixes new writes only; the key itself still needs
	// rotating, tracked separately.
	MasterKey           string `pulumi:"masterKey" provider:"secret"`
	ProxyDeploymentName string `pulumi:"proxyDeploymentName,optional"`
	ProxyPort           int    `pulumi:"proxyPort,optional"`
}

// connect opens a port-forward and returns a client bound to it, plus the
// teardown. Every CRUD method opens its own forward rather than sharing one:
// keys `dependsOn` the proxy, so a rollout immediately precedes these calls and
// a cached forward to a now-Terminating pod is exactly the case the pod-ready
// check exists to avoid.
func connect(ctx context.Context, tr kube.Transport, t AdminTarget) (*httpx.Client, func(), error) {
	conn, err := tr.Connect(ctx, kube.Target{
		Namespace:  t.ProxyNamespace,
		Deployment: t.ProxyDeploymentName,
		Port:       t.ProxyPort,
	})
	if err != nil {
		return nil, nil, err
	}
	return &httpx.Client{
		BaseURL: conn.BaseURL,
		Bearer:  t.MasterKey,
		// Each forward gets its own client with keep-alives disabled, so a
		// pooled connection can never outlive the forward. The TypeScript
		// version had to explicitly destroy sockets because undici pools behind
		// a global fetch; owning the client removes the hazard class instead.
		HTTP:       &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 30 * time.Second},
		MaxRetries: 3,
	}, conn.Close, nil
}

// call issues an admin request, reproducing adminRequest's one non-obvious
// behaviour: LiteLLM sometimes answers 200 with an `{"error": …}` body, which
// must be surfaced as a failure. Note it is deliberately NOT an httpx.Error —
// it carries no status, so Read's isMissingKey check will not treat it as
// "gone". That asymmetry is intentional and load-bearing; see readKey.
func call(ctx context.Context, c *httpx.Client, method, path string, body any, out any, idempotent bool) error {
	var raw json.RawMessage
	if err := c.Do(ctx, method, path, body, &raw, idempotent); err != nil {
		return err
	}
	if len(raw) == 0 {
		return nil
	}
	var probe struct {
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(raw, &probe); err == nil && len(probe.Error) > 0 && string(probe.Error) != "null" {
		return fmt.Errorf("sector7: LiteLLM %s %s returned an error payload", method, path)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// isMissingObject reports whether an error means the queried object is gone.
//
// 404 and 400 both count: several LiteLLM versions report a missing or invalid
// token as a bad request. Auth failures (401/403 — a wrong master key, which
// would fail *every* resource at once) and 5xx/network errors deliberately do
// NOT, so a transient refresh hiccup can never trigger a credential-churning
// recreate.
func isMissingObject(err error) bool {
	e, ok := err.(*httpx.Error)
	return ok && (e.Status == http.StatusNotFound || e.Status == http.StatusBadRequest)
}

// applyClearedFields adds explicit resets for fields that were set and are now
// empty.
//
// LiteLLM's /team/update and /key/update treat an *omitted* field as "leave
// unchanged", so the create-shaped body — which simply skips empty optionals —
// cannot clear a previously-set value. Without this, Pulumi would record the
// cleared state while the remote object silently kept the old value.
func applyClearedFields(body map[string]any, oldMaxBudget, newMaxBudget *float64, oldDur, newDur string, oldTags, newTags []string) {
	if oldMaxBudget != nil && newMaxBudget == nil {
		body["max_budget"] = nil
	}
	if oldDur != "" && newDur == "" {
		body["budget_duration"] = nil
	}
	if len(oldTags) > 0 && len(newTags) == 0 {
		body["tags"] = []string{}
	}
}
