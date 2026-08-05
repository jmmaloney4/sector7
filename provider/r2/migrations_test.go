package r2

import (
	"context"
	"reflect"
	"testing"

	"github.com/blang/semver"
	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"
	"github.com/pulumi/pulumi-go-provider/integration"
	"github.com/pulumi/pulumi/sdk/v3/go/property"
)

// liveObjectState mirrors what the TypeScript dynamic provider actually
// wrote: r2object.ts's create/update handlers return `{ ...inputs, etag }`
// (see uploadObjectToR2 and the create/update entries in r2ObjectProvider),
// and the Pulumi dynamic-resource runtime layers `__provider` — the
// serialized closure — on top of every dynamic.Resource's state
// automatically. Every ObjectArgs property is a plain string, so there is no
// sentinel-encoding hazard the way litellm's maxBudget had; __provider is
// the only obstacle to a clean decode.
func liveObjectState() property.Map {
	return property.NewMap(map[string]property.Value{
		"accountId":       property.New("acct-123"),
		"bucketName":      property.New("theoreticaledge-static"),
		"key":             property.New("assets/app.css"),
		"filePath":        property.New("/deleted/worktree/dist/assets/app.css"),
		"contentType":     property.New("text/css"),
		"accessKeyId":     property.New("AKIDEXAMPLE"),
		"secretAccessKey": property.New("secret-key"),
		"etag":            property.New("5d41402abc4b2a76b9719d911017c592"),
		"__provider":      property.New("4;/deleted/worktree/node_modules/...;closure"),
	})
}

// newInputs is what the retyped wrapper sends: the same args, minus
// `__provider` (which belonged to the dynamic provider) and minus `etag` (an
// output, not an input).
func newInputs() property.Map {
	return liveObjectState().Delete("__provider", "etag")
}

func testServer(t *testing.T) integration.Server {
	t.Helper()
	prov, err := infer.NewProviderBuilder().
		WithNamespace("jmmaloney4").
		WithResources(infer.Resource(Object{})).
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

const objectURN = "urn:pulumi:prod::theoreticaledge.com::sector7:r2:Object::theoreticaledge-static-assets/app.css"

// THE migration gate: the exact call the engine makes during the alias
// retype. Must succeed and report no changes, or the cutover fails at
// preview instead of diffing to nothing.
//
// Without the migration this fails with
// `Unrecognized field '__provider' on 'r2.ObjectState'`.
func TestDiffAcceptsLiveDynamicProviderState(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "theoreticaledge-static/assets/app.css",
		Urn:    objectURN,
		State:  liveObjectState(),
		Inputs: newInputs(),
	})
	if err != nil {
		t.Fatalf("Diff must accept live dynamic-provider state: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("retype must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// Dropping __provider is the ONLY thing the migration may do. A genuinely
// changed input must still plan a change — for identity properties that
// means UpdateReplace, per Object.Diff.
func TestRealChangeSurvivesTheMigration(t *testing.T) {
	srv := testServer(t)

	inputs := newInputs().Set("key", property.New("assets/app2.css"))

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "theoreticaledge-static/assets/app.css",
		Urn:    objectURN,
		State:  liveObjectState(),
		Inputs: inputs,
	})
	if err != nil {
		t.Fatalf("edited inputs must decode: %v", err)
	}
	if !resp.HasChanges {
		t.Fatal("a real key change must plan a change, not be swallowed by the migration")
	}
	if d, ok := resp.DetailedDiff["key"]; !ok || d.Kind != p.UpdateReplace {
		t.Fatalf("expected a key replace diff; got %+v", resp.DetailedDiff)
	}
}

// State that never passed through the dynamic provider has no __provider and
// must decode by the normal path, proving the migration is additive-safe.
func TestPluginNativeStateStillDecodes(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "theoreticaledge-static/assets/app.css",
		Urn:    objectURN,
		State:  liveObjectState().Delete("__provider"),
		Inputs: newInputs(),
	})
	if err != nil {
		t.Fatalf("plugin-native state must decode without a migration: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("unchanged plugin-native state must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// Same guard as d1's and onepassword's. infer runs migrations BEFORE the
// normal decode and skips a migrator only when decoding into its old shape
// FAILS, so `,optional` here would make objectStateV0 match plugin-native
// state too and route every read through the migration — permanently, not
// just for legacy state.
//
// Structural rather than behavioural on purpose: the migration is an
// identity copy of the embedded ObjectState, so the two tags are largely
// indistinguishable from outside (verified below by reproducing that: this
// guard is what actually catches the regression, not the Diff tests above).
func TestProviderTagIsRequiredSoTheMigrationOnlyMatchesLegacyState(t *testing.T) {
	f, ok := reflect.TypeOf(objectStateV0{}).FieldByName("Provider")
	if !ok {
		t.Fatal("objectStateV0.Provider is gone; if the field was renamed, update this guard rather than deleting it")
	}
	if tag := f.Tag.Get("pulumi"); tag != "__provider" {
		t.Fatalf("objectStateV0.Provider must be tagged exactly `pulumi:\"__provider\"`, got %q.\n"+
			"Adding ,optional makes this shape match plugin-native state as well, so the\n"+
			"migration would run on every state read instead of only on state written by\n"+
			"the dynamic provider.", tag)
	}
}
