package litellm

import (
	"context"
	"fmt"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/internal/diffutil"
	"github.com/jmmaloney4/sector7/provider/internal/kube"
)

// TeamRecord is the LiteLLM team registration. It replaces the inner dynamic
// child of sector7's LiteLLMTeam ComponentResource; the component itself is
// unchanged and keeps its URN.
type TeamRecord struct {
	// Transport is injected. Production wires kube.SPDYTransport; tests wire
	// kube.Fake against an httptest.Server.
	Transport kube.Transport
}

// TeamArgs mirrors TeamProviderInputs (admin.ts:41-52) exactly.
//
// Note DesiredTeamID's wire name is `desiredTeamId`, not `teamId`. The TS
// wrapper `teamProviderInputs` already performs that rename from the public
// LiteLLMTeamArgs.teamId, so this both matches the serialised state and avoids
// colliding with the `teamId` *output* below.
type TeamArgs struct {
	AdminTarget
	TeamAlias      string            `pulumi:"teamAlias"`
	DesiredTeamID  string            `pulumi:"desiredTeamId,optional"`
	Models         []string          `pulumi:"models,optional"`
	MaxBudget      *float64          `pulumi:"maxBudget,optional"`
	BudgetDuration string            `pulumi:"budgetDuration,optional"`
	Tags           []string          `pulumi:"tags,optional"`
	Metadata       map[string]string `pulumi:"metadata,optional"`
}

// TeamState embeds the inputs, mirroring `TeamProviderState extends
// TeamProviderInputs`, so stored state carries every input and Update/Delete
// see the same shape they always have.
type TeamState struct {
	TeamArgs
	// TeamID is the team_id actually in LiteLLM, resolved on create or adopt.
	TeamID string `pulumi:"teamId"`
}

// Annotate carries the schema defaults. It must be on the args type with a
// pointer receiver so SetDefault can take addresses of real fields; these are
// the same defaults teamProviderInputs applied in TypeScript, moved into the
// schema so both sides of a Diff see populated values.
func (a *TeamArgs) Annotate(ann infer.Annotator) {
	ann.SetDefault(&a.ProxyDeploymentName, "litellm")
	ann.SetDefault(&a.ProxyPort, 4000)
	ann.Describe(&a.DesiredTeamID, "Caller-requested team_id; empty lets LiteLLM assign one.")
}

// Check validates inputs.
//
// DefaultCheck must be called explicitly: implementing CustomCheck *replaces*
// infer's default, which is what decodes the inputs and applies every
// SetDefault above. Omitting it silently drops both.
func (TeamRecord) Check(ctx context.Context, req infer.CheckRequest) (infer.CheckResponse[TeamArgs], error) {
	args, failures, err := infer.DefaultCheck[TeamArgs](ctx, req.NewInputs)
	if err != nil {
		return infer.CheckResponse[TeamArgs]{Inputs: args, Failures: failures}, err
	}
	for _, f := range []struct {
		name, val string
	}{
		{"proxyNamespace", args.ProxyNamespace},
		{"masterKey", args.MasterKey},
		{"proxyDeploymentName", args.ProxyDeploymentName},
		{"teamAlias", args.TeamAlias},
	} {
		if f.val == "" {
			failures = append(failures, p.CheckFailure{Property: f.name, Reason: f.name + " is required"})
		}
	}
	return infer.CheckResponse[TeamArgs]{Inputs: args, Failures: failures}, nil
}

// Diff reproduces admin.ts:380-404.
//
// Only desiredTeamId forces replacement, and only when it is non-empty AND
// differs from the team we actually manage. Promoting an auto-assigned team to
// an explicit id that already equals the managed team is the same object, not a
// new one; an empty desired id means "keep the assigned one".
func (TeamRecord) Diff(_ context.Context, req infer.DiffRequest[TeamArgs, TeamState]) (p.DiffResponse, error) {
	olds, news := req.State, req.Inputs
	diffs := map[string]p.PropertyDiff{}

	managed := olds.TeamID
	if managed == "" {
		managed = olds.DesiredTeamID
	}
	if news.DesiredTeamID != "" && news.DesiredTeamID != managed {
		diffs["desiredTeamId"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}

	// An admin-target change does not alter the remote team, but it must still
	// flow into stored state so a later update/delete targets the new
	// deployment and uses the new master key rather than the stale ones.
	if olds.ProxyNamespace != news.ProxyNamespace ||
		olds.ProxyDeploymentName != news.ProxyDeploymentName ||
		olds.ProxyPort != news.ProxyPort ||
		olds.MasterKey != news.MasterKey {
		diffs["adminTarget"] = p.PropertyDiff{Kind: p.Update}
	}
	if olds.TeamAlias != news.TeamAlias {
		diffs["teamAlias"] = p.PropertyDiff{Kind: p.Update}
	}
	if !diffutil.StringsEqual(olds.Models, news.Models) {
		diffs["models"] = p.PropertyDiff{Kind: p.Update}
	}
	if !diffutil.Float64PtrEqual(olds.MaxBudget, news.MaxBudget) {
		diffs["maxBudget"] = p.PropertyDiff{Kind: p.Update}
	}
	if olds.BudgetDuration != news.BudgetDuration {
		diffs["budgetDuration"] = p.PropertyDiff{Kind: p.Update}
	}
	if !diffutil.StringsEqual(olds.Tags, news.Tags) {
		diffs["tags"] = p.PropertyDiff{Kind: p.Update}
	}
	if !diffutil.StringMapEqual(olds.Metadata, news.Metadata) {
		diffs["metadata"] = p.PropertyDiff{Kind: p.Update}
	}

	return p.DiffResponse{
		HasChanges:   len(diffs) > 0,
		DetailedDiff: diffs,
		// Create-before-delete, matching the dynamic provider. Contrast
		// litellm:Key, which must delete first because a key alias cannot be
		// duplicated.
		DeleteBeforeReplace: false,
	}, nil
}

func buildTeamBody(a TeamArgs, teamIDOverride string) map[string]any {
	body := map[string]any{
		"team_alias": a.TeamAlias,
		"models":     orEmptySlice(a.Models),
		"metadata":   orEmptyMap(a.Metadata),
	}
	// tags is a LiteLLM Enterprise feature — only send it when non-empty.
	if len(a.Tags) > 0 {
		body["tags"] = a.Tags
	}
	teamID := teamIDOverride
	if teamID == "" {
		teamID = a.DesiredTeamID
	}
	if teamID != "" {
		body["team_id"] = teamID
	}
	if a.MaxBudget != nil {
		body["max_budget"] = *a.MaxBudget
	}
	if a.BudgetDuration != "" {
		body["budget_duration"] = a.BudgetDuration
	}
	return body
}

// findTeamID looks for an existing team to adopt, matched by explicit team_id
// ONLY.
//
// Adoption is deliberately not done by team_alias: aliases are not unique on a
// LiteLLM admin plane, so matching one would let a new resource adopt and
// overwrite an unrelated team's models/budgets/metadata — an authorization
// boundary problem on a shared control plane.
func findTeamID(ctx context.Context, c *httpxClient, desired string) (string, error) {
	if desired == "" {
		return "", nil
	}
	var raw any
	if err := call(ctx, c, "GET", "/team/list", nil, &raw, true); err != nil {
		return "", err
	}
	for _, t := range teamsFrom(raw) {
		if id, ok := t["team_id"].(string); ok && id == desired {
			return id, nil
		}
	}
	return "", nil
}

func (r TeamRecord) Create(ctx context.Context, req infer.CreateRequest[TeamArgs]) (infer.CreateResponse[TeamState], error) {
	out := infer.CreateResponse[TeamState]{Output: TeamState{TeamArgs: req.Inputs}}
	if req.DryRun {
		return out, nil
	}

	c, done, err := connect(ctx, r.Transport, req.Inputs.AdminTarget)
	if err != nil {
		return out, err
	}
	defer done()

	existing, err := findTeamID(ctx, c, req.Inputs.DesiredTeamID)
	if err != nil {
		return out, err
	}

	teamID := existing
	if existing != "" {
		// Adopt and reconcile in one step.
		if err := call(ctx, c, "POST", "/team/update", buildTeamBody(req.Inputs, existing), nil, true); err != nil {
			return out, err
		}
	} else {
		var resp struct {
			TeamID string `json:"team_id"`
		}
		// Never retried: a retried /team/new after a timeout that actually
		// succeeded would create a duplicate team.
		if err := call(ctx, c, "POST", "/team/new", buildTeamBody(req.Inputs, ""), &resp, false); err != nil {
			return out, err
		}
		teamID = resp.TeamID
		if teamID == "" {
			teamID = req.Inputs.DesiredTeamID
		}
	}
	if teamID == "" {
		return out, fmt.Errorf("sector7: LiteLLM /team/new returned no team_id")
	}

	out.ID = teamID
	out.Output.TeamID = teamID
	return out, nil
}

func (r TeamRecord) Update(ctx context.Context, req infer.UpdateRequest[TeamArgs, TeamState]) (infer.UpdateResponse[TeamState], error) {
	out := infer.UpdateResponse[TeamState]{Output: TeamState{TeamArgs: req.Inputs, TeamID: req.ID}}
	if req.DryRun {
		return out, nil
	}

	c, done, err := connect(ctx, r.Transport, req.Inputs.AdminTarget)
	if err != nil {
		return out, err
	}
	defer done()

	// Keyed on the Pulumi resource id, which is the LiteLLM team_id — not on
	// news.DesiredTeamID, which may be empty for an auto-assigned team.
	body := buildTeamBody(req.Inputs, req.ID)
	applyClearedFields(body,
		req.State.MaxBudget, req.Inputs.MaxBudget,
		req.State.BudgetDuration, req.Inputs.BudgetDuration,
		req.State.Tags, req.Inputs.Tags)

	if err := call(ctx, c, "POST", "/team/update", body, nil, true); err != nil {
		return out, err
	}
	return out, nil
}

func (r TeamRecord) Delete(ctx context.Context, req infer.DeleteRequest[TeamState]) (infer.DeleteResponse, error) {
	if req.ID == "" {
		return infer.DeleteResponse{}, nil
	}
	c, done, err := connect(ctx, r.Transport, req.State.AdminTarget)
	if err != nil {
		return infer.DeleteResponse{}, err
	}
	defer done()

	err = call(ctx, c, "POST", "/team/delete", map[string]any{"team_ids": []string{req.ID}}, nil, true)
	return infer.DeleteResponse{}, err
}

// Deliberately NO Read: the dynamic teamProvider had none, and adding refresh
// semantics to a resource that has never had them is a separate,
// independently-reviewable change. The whole point of this migration is that a
// bad refresh must not be able to touch live resources.
