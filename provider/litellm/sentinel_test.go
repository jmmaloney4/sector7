package litellm

import (
	"context"
	"testing"

	"github.com/pulumi/pulumi-go-provider/infer"
	"github.com/pulumi/pulumi/sdk/v3/go/property"
)

// The dynamic provider normalised unset optionals to sentinel empty values —
// `teamProviderInputs` did `maxBudget: args.maxBudget ?? ""`. Live
// litellm/prod state therefore carries `maxBudget: ""` on all eight resources,
// because none of them sets a budget.
//
// A Pulumi schema cannot express `number | ""`, so the Go side models it as
// *float64. This test pins the consequence: the sentinel does NOT decode, and
// it surfaces as a CheckFailure rather than a hard error.
//
// That makes it a migration blocker, not a cosmetic difference. Retyping a live
// resource with `aliases: [{ type: "pulumi-nodejs:dynamic:Resource" }]` would
// fail at Check instead of diffing to nothing. The fix has two halves, and BOTH
// are required:
//
//  1. Inputs — the TS wrapper must stop sending "" and simply omit the field
//     when unset. Inputs come from the program, so no state migration can
//     reach them.
//  2. State — implement infer.CustomStateMigrations[TeamState] with
//     Old = resource.PropertyMap (which the framework documents as "always
//     run") to strip the sentinel from stored state before it is decoded for
//     Diff/Update/Delete.
//
// Replace this test once both halves land with one asserting that
// `maxBudget: ""` in old state decodes to a nil *float64.
func TestSentinelEmptyStringMaxBudgetIsRejected(t *testing.T) {
	in := property.NewMap(map[string]property.Value{
		"proxyNamespace":      property.New("litellm"),
		"masterKey":           property.New("sk-master"),
		"proxyDeploymentName": property.New("litellm"),
		"proxyPort":           property.New(4000.0),
		"teamAlias":           property.New("prod-personal"),
		"desiredTeamId":       property.New("personal"),
		"models":              property.New([]property.Value{property.New("coding")}),
		"maxBudget":           property.New(""), // the sentinel
		"budgetDuration":      property.New(""),
		"tags":                property.New([]property.Value{}),
		"metadata":            property.New(property.NewMap(map[string]property.Value{})),
	})

	_, failures, err := infer.DefaultCheck[TeamArgs](context.Background(), in)
	if err != nil {
		t.Fatalf("unexpected hard error: %v", err)
	}
	if len(failures) != 1 || failures[0].Property != "maxBudget" {
		t.Fatalf("expected exactly one maxBudget failure, got %+v", failures)
	}

	// budgetDuration is a plain string, so its "" sentinel is indistinguishable
	// from a real empty value and decodes fine. Only the typed optionals
	// (maxBudget here, retentionPeriodSeconds in attic) are affected.
	t.Logf("confirmed migration blocker: %s", failures[0].Reason)
}
