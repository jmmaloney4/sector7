package litellm

import (
	"context"
	"testing"

	"github.com/blang/semver"
	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"
	"github.com/pulumi/pulumi-go-provider/integration"
	"github.com/pulumi/pulumi/sdk/v3/go/property"
)

// liveKeyState mirrors what litellm/prod actually holds for a key today:
// sentinel-encoded optionals, plus the serialized __provider closure whose
// baked-in worktree path made refresh fail in the first place.
//
// Both are migration hazards, and neither is hypothetical — this is the shape
// the alias retype will hand the Go provider on the very first preview.
func liveKeyState() property.Map {
	return property.NewMap(map[string]property.Value{
		"proxyNamespace":      property.New("litellm"),
		"masterKey":           property.New("sk-master"),
		"proxyDeploymentName": property.New("litellm"),
		"proxyPort":           property.New(4000.0),
		"keyAlias":            property.New("prod-personal-hermes-agent"),
		"keyValue":            property.New("sk-abc"),
		"models":              property.New([]property.Value{property.New("coding")}),
		"teamId":              property.New("personal"),
		"userId":              property.New(""),
		"budgetId":            property.New(""),
		"maxBudget":           property.New(""), // sentinel: unset
		"budgetDuration":      property.New(""),
		"duration":            property.New(""),
		"aliases":             property.New(property.NewMap(map[string]property.Value{})),
		"tags":                property.New([]property.Value{}),
		"metadata":            property.New(property.NewMap(map[string]property.Value{})),
		"tokenId":             property.New("hash-1"),
		"__provider":          property.New("4;/deleted/worktree/node_modules/...;closure"),
	})
}

// newInputs is what the retyped TypeScript wrapper sends: same values, no
// sentinel for maxBudget, and no __provider (that property belonged to the
// dynamic provider).
func newInputs() property.Map {
	m := liveKeyState().Delete("__provider", "maxBudget", "tokenId")
	return m
}

func testServer(t *testing.T) integration.Server {
	t.Helper()
	prov, err := infer.NewProviderBuilder().
		WithNamespace("jmmaloney4").
		WithResources(infer.Resource(KeyRecord{})).
		Build()
	if err != nil {
		t.Fatal(err)
	}
	srv, err := integration.NewServer(context.Background(), "sector7",
		semver.MustParse("0.21.0"), integration.WithProvider(prov))
	if err != nil {
		t.Fatal(err)
	}
	return srv
}

// THE migration gate. This is the exact call the engine makes during the alias
// retype: old state from the dynamic provider, new inputs from the retyped
// wrapper. It must succeed and report no changes — anything else means the
// cutover fails at preview instead of diffing to nothing.
func TestDiffAcceptsLiveDynamicProviderState(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "hash-1",
		Urn:    "urn:pulumi:prod::litellm::sector7:litellm:ApiKey$sector7:litellm:KeyRecord::personal-dev-key-key",
		State:  liveKeyState(),
		Inputs: newInputs(),
	})
	if err != nil {
		t.Fatalf("Diff must accept live dynamic-provider state: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("retype must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// The migration must not swallow a real budget. State carrying a numeric
// maxBudget fails the v0 decode ("doesn't fit into the migrator"), falls
// through to the normal decode, and keeps its value — so declaring a budget
// still diffs against a program that no longer sets one.
func TestNumericBudgetFallsThroughTheMigration(t *testing.T) {
	srv := testServer(t)

	state := liveKeyState().Set("maxBudget", property.New(250.0))
	resp, err := srv.Diff(p.DiffRequest{
		ID:     "hash-1",
		Urn:    "urn:pulumi:prod::litellm::sector7:litellm:ApiKey$sector7:litellm:KeyRecord::personal-dev-key-key",
		State:  state,
		Inputs: newInputs(), // no maxBudget: the budget is being cleared
	})
	if err != nil {
		t.Fatalf("numeric budget must decode: %v", err)
	}
	if !resp.HasChanges {
		t.Fatal("clearing a real budget must be a change, not swallowed by the migration")
	}
	if _, ok := resp.DetailedDiff["maxBudget"]; !ok {
		t.Fatalf("expected a maxBudget diff; got %+v", resp.DetailedDiff)
	}
}
