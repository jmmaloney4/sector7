package onepassword

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

// liveItemState mirrors gateway/prod's `mcp-consumer-tokens` exactly, read off
// the stack rather than imagined:
//
//	pulumi stack export -C deploy/platform/gateway -s prod
//	  outputs: __provider, category, connectPort, connectToken, contentHash,
//	           deploymentName, itemPath, kubeconfig, managedLabels, namespace,
//	           title, uuid, vault
//
// Two things are load-bearing about this shape. `__provider` is present, and
// `fields` is ABSENT — the dynamic provider deliberately never persisted field
// values, keeping only labels and a content hash. ItemState matches that; see
// the comment there.
// managedFields is the single source of truth for the fixture's fields: the
// inputs carry them, and the stored contentHash is derived from them, so the
// fixture cannot drift into a state where the hash disagrees with the values.
func managedFields() []Field {
	return []Field{
		{Label: "claude-code", Value: "tok-1"},
		{Label: "goose", Value: "tok-2"},
		{Label: "hermes", Value: "tok-3"},
	}
}

func fieldsProperty(fs []Field) property.Value {
	out := make([]property.Value, 0, len(fs))
	for _, f := range fs {
		out = append(out, property.New(property.NewMap(map[string]property.Value{
			"label": property.New(f.Label),
			"value": property.New(f.Value),
		})))
	}
	return property.New(out)
}

func mustContentHash(t *testing.T, category string, fs []Field) string {
	t.Helper()
	h, err := ContentHash(category, fs, nil)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func liveItemState(t *testing.T) property.Map {
	t.Helper()
	return property.NewMap(map[string]property.Value{
		"kubeconfig":     property.New("apiVersion: v1\nkind: Config\n"),
		"connectToken":   property.New("op-token"),
		"namespace":      property.New("1password"),
		"deploymentName": property.New("onepassword-connect"),
		"connectPort":    property.New(8080.0),
		"vault":          property.New("hs2ojq6awbjnsmvx5qwwekcvvq"),
		"title":          property.New("mcp-gateway-consumer-tokens"),
		"category":       property.New("API_CREDENTIAL"),
		"uuid":           property.New("x5yluqpkzwhby3326f2embsh64"),
		"itemPath":       property.New("vaults/hs2ojq6awbjnsmvx5qwwekcvvq/items/x5yluqpkzwhby3326f2embsh64"),
		"contentHash":    property.New(mustContentHash(t, "API_CREDENTIAL", managedFields())),
		"managedLabels": property.New([]property.Value{
			property.New("claude-code"), property.New("goose"), property.New("hermes"),
		}),
		"__provider": property.New("4;/deleted/worktree/node_modules/...;closure"),
	})
}

// newInputs is what the retyped wrapper sends: the connection and identity
// inputs plus `fields`, and none of the outputs.
func newInputs(t *testing.T) property.Map {
	t.Helper()
	return liveItemState(t).
		Delete("__provider", "uuid", "itemPath", "contentHash", "managedLabels").
		Set("fields", fieldsProperty(managedFields()))
}

func testServer(t *testing.T) integration.Server {
	t.Helper()
	prov, err := infer.NewProviderBuilder().
		WithNamespace("jmmaloney4").
		WithResources(infer.Resource(Item{})).
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

const itemURN = "urn:pulumi:prod::gateway::sector7:onepassword:Item::mcp-consumer-tokens"

// THE migration gate: the exact call the engine makes during the alias retype.
// Must succeed and report no changes, or the cutover fails at preview instead
// of diffing to nothing.
//
// Without the migration this fails with
// `Unrecognized field '__provider' on 'onepassword.ItemState'`.
func TestDiffAcceptsLiveDynamicProviderState(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "x5yluqpkzwhby3326f2embsh64",
		Urn:    itemURN,
		State:  liveItemState(t),
		Inputs: newInputs(t),
	})
	if err != nil {
		t.Fatalf("Diff must accept live dynamic-provider state: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("retype must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// Dropping __provider is the ONLY thing the migration may do. A genuinely
// edited field value must still plan an update — for this resource that means
// rewriting a live secret, so being swallowed and being spurious are both bad.
func TestRealFieldChangeSurvivesTheMigration(t *testing.T) {
	srv := testServer(t)

	inputs := newInputs(t).Set("fields", fieldsProperty([]Field{
		{Label: "claude-code", Value: "ROTATED"},
	}))

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "x5yluqpkzwhby3326f2embsh64",
		Urn:    itemURN,
		State:  liveItemState(t),
		Inputs: inputs,
	})
	if err != nil {
		t.Fatalf("edited fields must decode: %v", err)
	}
	if !resp.HasChanges {
		t.Fatal("a rotated secret must plan a change, not be swallowed by the migration")
	}
}

// State that never passed through the dynamic provider has no __provider and
// must decode by the normal path, proving the migration is additive-safe.
func TestPluginNativeStateStillDecodes(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "x5yluqpkzwhby3326f2embsh64",
		Urn:    itemURN,
		State:  liveItemState(t).Delete("__provider"),
		Inputs: newInputs(t),
	})
	if err != nil {
		t.Fatalf("plugin-native state must decode without a migration: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("unchanged plugin-native state must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// Same guard as d1's. infer runs migrations BEFORE the normal decode and skips
// a migrator only when decoding into its old shape FAILS, so `,optional` here
// would make itemStateV0 match plugin-native state too and route every read
// through the migration — permanently, not just for legacy state.
//
// Structural rather than behavioural on purpose: the migration is an identity
// copy of the embedded ItemState, so the two tags are largely indistinguishable
// from outside, and any signal that does exist would be an accident of the
// current field set rather than designed behaviour.
func TestProviderTagIsRequiredSoTheMigrationOnlyMatchesLegacyState(t *testing.T) {
	f, ok := reflect.TypeOf(itemStateV0{}).FieldByName("Provider")
	if !ok {
		t.Fatal("itemStateV0.Provider is gone; if the field was renamed, update this guard rather than deleting it")
	}
	if tag := f.Tag.Get("pulumi"); tag != "__provider" {
		t.Fatalf("itemStateV0.Provider must be tagged exactly `pulumi:\"__provider\"`, got %q.\n"+
			"Adding ,optional makes this shape match plugin-native state as well, so the\n"+
			"migration would run on every state read instead of only on state written by\n"+
			"the dynamic provider.", tag)
	}
}

// The security property this resource is built around: field VALUES must never
// be persisted. The dynamic provider's stateOuts omitted them deliberately,
// keeping only labels and a hash; embedding ItemArgs in ItemState silently
// reversed that and would have written every managed secret into state.
//
// Asserted against the reflected shape rather than a Diff, because the failure
// is "a property exists at all", not "a property has the wrong value".
//
// Verified against both ways this can regress, and they fail differently:
//
//   - adding an explicit `Fields` field — caught here, with the message below.
//   - re-embedding ItemArgs — caught EARLIER and less legibly, by infer
//     panicking with "could not annotate field: could not find field" as it
//     walks Annotate over a struct whose promoted fields are shadowed by the
//     explicit ones. That aborts the test binary before this assertion runs.
//
// So the property is protected either way, but only the first case produces a
// message that explains itself. The embed check below is kept regardless: it
// costs nothing and would become the primary signal if the shadowing that
// currently triggers the panic ever stopped applying.
func TestItemStateNeverCarriesFieldValues(t *testing.T) {
	tp := reflect.TypeOf(ItemState{})
	for i := range tp.NumField() {
		f := tp.Field(i)
		if f.Name == "Fields" || f.Tag.Get("pulumi") == "fields" {
			t.Fatalf("ItemState must not carry field values: found %s `%s`.\n"+
				"Create and Update write ItemState wholesale, so any Fields here is "+
				"persisted into state for every managed secret.", f.Name, f.Tag)
		}
		// Embedding ItemArgs would reintroduce Fields transitively, which is
		// exactly how this regressed the first time.
		if f.Anonymous && f.Type == reflect.TypeOf(ItemArgs{}) {
			t.Fatal("ItemState must not embed ItemArgs — it carries Fields transitively")
		}
	}
}
