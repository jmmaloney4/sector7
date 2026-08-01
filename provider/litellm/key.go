package litellm

import (
	"context"
	"fmt"
	"net/url"
	"sync"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/internal/diffutil"
	"github.com/jmmaloney4/sector7/provider/internal/kube"
)

// KeyRecord is the LiteLLM API-key registration. It replaces the inner dynamic
// child of sector7's LiteLLMApiKey ComponentResource.
//
// The component itself is UNCHANGED, and that is load-bearing: it owns a
// random.RandomPassword child named `<name>-secret` from which the `sk-…` value
// is derived and *pushed* here as KeyValue. LiteLLM never returns a key's
// value (only its hash), so a provider that minted keys itself could not learn
// existing ones and every live credential would rotate on migration. Generation
// stays in TypeScript deliberately.
type KeyRecord struct {
	Transport kube.Transport
}

// KeyArgs mirrors KeyProviderInputs (admin.ts:58-74) exactly.
type KeyArgs struct {
	AdminTarget
	KeyAlias string `pulumi:"keyAlias"`
	// KeyValue is the `sk-…` secret, generated outside this provider by a
	// RandomPassword and supplied as an input. Changing it forces replacement.
	KeyValue       string            `pulumi:"keyValue" provider:"secret"`
	Models         []string          `pulumi:"models,optional"`
	TeamID         string            `pulumi:"teamId,optional"`
	UserID         string            `pulumi:"userId,optional"`
	BudgetID       string            `pulumi:"budgetId,optional"`
	MaxBudget      *float64          `pulumi:"maxBudget,optional"`
	BudgetDuration string            `pulumi:"budgetDuration,optional"`
	Duration       string            `pulumi:"duration,optional"`
	Aliases        map[string]string `pulumi:"aliases,optional"`
	Tags           []string          `pulumi:"tags,optional"`
	Metadata       map[string]string `pulumi:"metadata,optional"`
}

// KeyState embeds the inputs, mirroring `KeyProviderState extends
// KeyProviderInputs`.
type KeyState struct {
	KeyArgs
	// TokenID is the LiteLLM token hash returned by /key/generate. Secret even
	// though it is only a hash, matching the dynamic provider's
	// additionalSecretOutputs.
	TokenID string `pulumi:"tokenId" provider:"secret"`
}

func (a *KeyArgs) Annotate(ann infer.Annotator) {
	ann.SetDefault(&a.ProxyDeploymentName, "litellm")
	ann.SetDefault(&a.ProxyPort, 4000)
	ann.Describe(&a.KeyValue, "The sk-... value. Generated outside the provider so existing keys keep their value.")
}

func (KeyRecord) Check(ctx context.Context, req infer.CheckRequest) (infer.CheckResponse[KeyArgs], error) {
	args, failures, err := infer.DefaultCheck[KeyArgs](ctx, req.NewInputs)
	if err != nil {
		return infer.CheckResponse[KeyArgs]{Inputs: args, Failures: failures}, err
	}
	for _, f := range []struct{ name, val string }{
		{"proxyNamespace", args.ProxyNamespace},
		{"masterKey", args.MasterKey},
		{"proxyDeploymentName", args.ProxyDeploymentName},
		{"keyAlias", args.KeyAlias},
		{"keyValue", args.KeyValue},
	} {
		if f.val == "" {
			failures = append(failures, p.CheckFailure{Property: f.name, Reason: f.name + " is required"})
		}
	}
	return infer.CheckResponse[KeyArgs]{Inputs: args, Failures: failures}, nil
}

// Diff reproduces admin.ts:554-577.
//
// Rotating the secret or moving teams means a new key in LiteLLM, so both force
// replacement. Note DeleteBeforeReplace is TRUE here, the opposite of Team: the
// same alias and key value cannot coexist on the proxy, so the old registration
// must be gone before the new one is created.
func (KeyRecord) Diff(_ context.Context, req infer.DiffRequest[KeyArgs, KeyState]) (p.DiffResponse, error) {
	olds, news := req.State, req.Inputs
	diffs := map[string]p.PropertyDiff{}

	if olds.KeyValue != news.KeyValue {
		diffs["keyValue"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	if olds.TeamID != news.TeamID {
		diffs["teamId"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}

	if olds.ProxyNamespace != news.ProxyNamespace ||
		olds.ProxyDeploymentName != news.ProxyDeploymentName ||
		olds.ProxyPort != news.ProxyPort ||
		olds.MasterKey != news.MasterKey {
		diffs["adminTarget"] = p.PropertyDiff{Kind: p.Update}
	}
	if olds.KeyAlias != news.KeyAlias {
		diffs["keyAlias"] = p.PropertyDiff{Kind: p.Update}
	}
	if !diffutil.StringsEqual(olds.Models, news.Models) {
		diffs["models"] = p.PropertyDiff{Kind: p.Update}
	}
	if !diffutil.StringMapEqual(olds.Aliases, news.Aliases) {
		diffs["aliases"] = p.PropertyDiff{Kind: p.Update}
	}
	if !diffutil.StringMapEqual(olds.Metadata, news.Metadata) {
		diffs["metadata"] = p.PropertyDiff{Kind: p.Update}
	}
	if !diffutil.StringsEqual(olds.Tags, news.Tags) {
		diffs["tags"] = p.PropertyDiff{Kind: p.Update}
	}
	if olds.UserID != news.UserID {
		diffs["userId"] = p.PropertyDiff{Kind: p.Update}
	}
	if olds.BudgetID != news.BudgetID {
		diffs["budgetId"] = p.PropertyDiff{Kind: p.Update}
	}
	if !diffutil.Float64PtrEqual(olds.MaxBudget, news.MaxBudget) {
		diffs["maxBudget"] = p.PropertyDiff{Kind: p.Update}
	}
	if olds.BudgetDuration != news.BudgetDuration {
		diffs["budgetDuration"] = p.PropertyDiff{Kind: p.Update}
	}
	if olds.Duration != news.Duration {
		diffs["duration"] = p.PropertyDiff{Kind: p.Update}
	}

	return p.DiffResponse{
		HasChanges:          len(diffs) > 0,
		DetailedDiff:        diffs,
		DeleteBeforeReplace: true,
	}, nil
}

func buildKeyGenerateBody(a KeyArgs) map[string]any {
	body := map[string]any{
		"key_alias": a.KeyAlias,
		"key":       a.KeyValue,
		"models":    orEmptySlice(a.Models),
		"aliases":   orEmptyMap(a.Aliases),
		"metadata":  orEmptyMap(a.Metadata),
	}
	if len(a.Tags) > 0 {
		body["tags"] = a.Tags
	}
	if a.TeamID != "" {
		body["team_id"] = a.TeamID
	}
	if a.UserID != "" {
		body["user_id"] = a.UserID
	}
	if a.BudgetID != "" {
		body["budget_id"] = a.BudgetID
	}
	if a.MaxBudget != nil {
		body["max_budget"] = *a.MaxBudget
	}
	if a.BudgetDuration != "" {
		body["budget_duration"] = a.BudgetDuration
	}
	if a.Duration != "" {
		body["duration"] = a.Duration
	}
	return body
}

// findKeyHashesByAlias returns ALL token hashes matching both alias and team.
//
// Two properties matter and are easy to get wrong:
//
//   - The match is scoped to BOTH key_alias AND team_id. Aliases are not
//     globally unique in LiteLLM, so matching on alias alone would let Create
//     delete a same-named key belonging to another team, or a manually-managed
//     one, on a shared admin plane.
//   - It returns every match rather than the first. If drift left duplicates in
//     the team, Create must clear all of them so adoption is idempotent and no
//     stale credential survives.
//
// Per-hash /key/info failures are swallowed deliberately: a key we cannot
// inspect is treated as "not a match" rather than aborting the whole create.
func findKeyHashesByAlias(ctx context.Context, c *httpxClient, alias, teamID string) ([]string, error) {
	var raw any
	if err := call(ctx, c, "GET", "/key/list", nil, &raw, true); err != nil {
		return nil, err
	}

	hashes := keyHashesFrom(raw)
	if len(hashes) == 0 {
		return nil, nil
	}

	type result struct {
		hash  string
		match bool
	}
	results := make([]result, len(hashes))
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup

	for i, hash := range hashes {
		wg.Add(1)
		go func(i int, hash string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			var info map[string]any
			if err := call(ctx, c, "GET", "/key/info?key="+url.QueryEscape(hash), nil, &info, true); err != nil {
				return // swallowed; see doc comment
			}
			// LiteLLM wraps the payload as {info: {...}} in some versions.
			if inner, ok := info["info"].(map[string]any); ok {
				info = inner
			}
			gotAlias, _ := info["key_alias"].(string)
			gotTeam, _ := info["team_id"].(string)
			results[i] = result{hash: hash, match: gotAlias == alias && gotTeam == teamID}
		}(i, hash)
	}
	wg.Wait()

	var matches []string
	for _, r := range results {
		if r.match {
			matches = append(matches, r.hash)
		}
	}
	return matches, nil
}

func (r KeyRecord) Create(ctx context.Context, req infer.CreateRequest[KeyArgs]) (infer.CreateResponse[KeyState], error) {
	out := infer.CreateResponse[KeyState]{Output: KeyState{KeyArgs: req.Inputs}}
	if req.DryRun {
		return out, nil
	}

	c, done, err := connect(ctx, r.Transport, req.Inputs.AdminTarget)
	if err != nil {
		return out, err
	}
	defer done()

	// A pre-existing key cannot be adopted in place: /key/info never returns
	// the sk- value, so there is no way to confirm the remote key carries the
	// value we hold. Delete and re-register with the known value instead —
	// which is why this is idempotent and non-rotating.
	existing, err := findKeyHashesByAlias(ctx, c, req.Inputs.KeyAlias, req.Inputs.TeamID)
	if err != nil {
		return out, err
	}
	if len(existing) > 0 {
		if err := call(ctx, c, "POST", "/key/delete", map[string]any{"keys": existing}, nil, true); err != nil {
			return out, err
		}
	}

	var resp struct {
		Token   string `json:"token"`
		TokenID string `json:"token_id"`
	}
	// NEVER retried: a retried /key/generate whose first attempt actually
	// succeeded would leave a second live key whose hash Pulumi never records —
	// a credential nobody can find or revoke.
	if err := call(ctx, c, "POST", "/key/generate", buildKeyGenerateBody(req.Inputs), &resp, false); err != nil {
		return out, err
	}

	tokenID := resp.Token
	if tokenID == "" {
		tokenID = resp.TokenID
	}
	// Never fall back to the sk- value: Pulumi resource ids are stored in
	// plaintext in state, so using the secret as the id would leak the
	// credential — and /key/delete expects a token hash, not the secret.
	if tokenID == "" {
		return out, fmt.Errorf("sector7: LiteLLM /key/generate returned no token id")
	}

	out.ID = tokenID
	out.Output.TokenID = tokenID
	return out, nil
}

// Read reconciles stored state against the live admin plane on refresh.
//
// Without it a key that vanished server-side — a Cloud SQL restore, a redeploy
// onto a fresh DB, a manual /key/delete — stays invisible: Diff only compares
// declared inputs, so a plain `up` reports no changes while every consumer 401s
// on a token the proxy no longer knows. Reporting the resource as gone lets the
// next `up` re-run Create, which re-registers the SAME RandomPassword-derived
// value: self-healing, and non-rotating.
//
// This is a liveness probe, not a real read — props are echoed back unchanged,
// because nothing about the key is recoverable from the API.
func (r KeyRecord) Read(ctx context.Context, req infer.ReadRequest[KeyArgs, KeyState]) (infer.ReadResponse[KeyArgs, KeyState], error) {
	token := req.ID
	if token == "" {
		token = req.State.TokenID
	}
	// No persisted token hash to probe (e.g. a half-created resource): treat as
	// absent so the next up creates it. Never invent existence.
	if token == "" {
		return infer.ReadResponse[KeyArgs, KeyState]{}, nil
	}

	c, done, err := connect(ctx, r.Transport, req.State.AdminTarget)
	if err != nil {
		return infer.ReadResponse[KeyArgs, KeyState]{}, err
	}
	defer done()

	if err := call(ctx, c, "GET", "/key/info?key="+url.QueryEscape(token), nil, nil, true); err != nil {
		// Only a definitive not-found drops the resource. Auth failures
		// (401/403 — a wrong master key, which would fail EVERY key at once)
		// and 5xx/network errors are re-thrown so a transient refresh hiccup
		// can never trigger a credential-churning recreate.
		//
		// Note one LiteLLM variant answers 200 with an {error} body for a
		// missing key; `call` surfaces that as a plain error carrying no
		// status, so isMissingObject does not match and the resource is
		// preserved. That is the safe direction.
		if isMissingObject(err) {
			return infer.ReadResponse[KeyArgs, KeyState]{}, nil
		}
		return infer.ReadResponse[KeyArgs, KeyState]{}, err
	}

	return infer.ReadResponse[KeyArgs, KeyState]{
		ID:     token,
		Inputs: req.Inputs,
		State:  req.State,
	}, nil
}

func (r KeyRecord) Update(ctx context.Context, req infer.UpdateRequest[KeyArgs, KeyState]) (infer.UpdateResponse[KeyState], error) {
	tokenID := req.State.TokenID
	if tokenID == "" {
		tokenID = req.ID
	}
	out := infer.UpdateResponse[KeyState]{Output: KeyState{KeyArgs: req.Inputs, TokenID: tokenID}}
	if req.DryRun {
		return out, nil
	}

	c, done, err := connect(ctx, r.Transport, req.Inputs.AdminTarget)
	if err != nil {
		return out, err
	}
	defer done()

	news := req.Inputs
	// /key/update is keyed on the plaintext sk- value (LiteLLM hashes it
	// server-side) — unlike /key/delete and /key/info, which take the hash.
	// team_id and the key value are handled by replacement, not update.
	body := map[string]any{
		"key":       news.KeyValue,
		"key_alias": news.KeyAlias,
		"models":    orEmptySlice(news.Models),
		"aliases":   orEmptyMap(news.Aliases),
		"metadata":  orEmptyMap(news.Metadata),
	}
	if len(news.Tags) > 0 {
		body["tags"] = news.Tags
	}
	if news.UserID != "" {
		body["user_id"] = news.UserID
	}
	if news.BudgetID != "" {
		body["budget_id"] = news.BudgetID
	}
	if news.MaxBudget != nil {
		body["max_budget"] = *news.MaxBudget
	}
	if news.BudgetDuration != "" {
		body["budget_duration"] = news.BudgetDuration
	}
	if news.Duration != "" {
		body["duration"] = news.Duration
	}
	applyClearedFields(body,
		req.State.MaxBudget, news.MaxBudget,
		req.State.BudgetDuration, news.BudgetDuration,
		req.State.Tags, news.Tags)
	if req.State.Duration != "" && news.Duration == "" {
		body["duration"] = nil
	}

	if err := call(ctx, c, "POST", "/key/update", body, nil, true); err != nil {
		return out, err
	}
	return out, nil
}

func (r KeyRecord) Delete(ctx context.Context, req infer.DeleteRequest[KeyState]) (infer.DeleteResponse, error) {
	token := req.ID
	if token == "" {
		token = req.State.TokenID
	}
	if token == "" {
		return infer.DeleteResponse{}, nil
	}

	c, done, err := connect(ctx, r.Transport, req.State.AdminTarget)
	if err != nil {
		return infer.DeleteResponse{}, err
	}
	defer done()

	err = call(ctx, c, "POST", "/key/delete", map[string]any{"keys": []string{token}}, nil, true)
	return infer.DeleteResponse{}, err
}
