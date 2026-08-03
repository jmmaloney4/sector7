package d1

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

// liveQueryState mirrors what uptime/prod actually holds today, read off the
// stack rather than imagined:
//
//	pulumi stack export -C deploy/services/uptime -s prod
//	  urn: …:UptimeMonitor$pulumi-nodejs:dynamic:Resource::uptime-prod-schema
//	  outputs: __provider, accountId, apiToken, databaseId, sql, sqlHash
//
// Every property maps onto QueryArgs/QueryState except __provider — the
// serialized dynamic-provider closure. Unlike litellm there is no sentinel
// hazard here: all four inputs are strings, so an empty value is a valid value
// of its own type and decodes fine. __provider is the only obstacle.
func liveQueryState() property.Map {
	return property.NewMap(map[string]property.Value{
		"accountId":  property.New("acct-123"),
		"databaseId": property.New("db-456"),
		"sql":        property.New("CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY);"),
		"apiToken":   property.New("cf-token"),
		"sqlHash":    property.New("abc123"),
		"__provider": property.New("4;/deleted/worktree/node_modules/...;closure"),
	})
}

// newInputs is what the retyped TypeScript wrapper sends: the same values,
// minus __provider (which belonged to the dynamic provider) and minus sqlHash
// (an output, not an input).
func newInputs() property.Map {
	return liveQueryState().Delete("__provider", "sqlHash")
}

func testServer(t *testing.T) integration.Server {
	t.Helper()
	prov, err := infer.NewProviderBuilder().
		WithNamespace("jmmaloney4").
		WithResources(infer.Resource(Query{})).
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

// THE migration gate: the exact call the engine makes during the alias retype.
// Old state from the dynamic provider, new inputs from the retyped wrapper. It
// must succeed AND report no changes — anything else means the cutover fails at
// preview rather than diffing to nothing.
//
// Without a state migration this fails outright, because an unrecognized
// property is a decode FAILURE rather than something quietly ignored:
//
//	Unrecognized field '__provider' on 'd1.QueryState'
//
// That is why every dynamic-provider family needs this before it can be
// retyped, not just the ones with awkward sentinel encodings.
func TestDiffAcceptsLiveDynamicProviderState(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "uptime-prod-schema",
		Urn:    "urn:pulumi:prod::uptime::sector7:cloudflare:UptimeMonitor$sector7:d1:Query::uptime-prod-schema",
		State:  liveQueryState(),
		Inputs: newInputs(),
	})
	if err != nil {
		t.Fatalf("Diff must accept live dynamic-provider state: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("retype must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// The migration must not swallow a real change. Dropping __provider is the only
// thing it is allowed to do — a genuinely edited schema still has to plan an
// update, or a schema change would silently never be applied.
func TestRealSqlChangeSurvivesTheMigration(t *testing.T) {
	srv := testServer(t)

	inputs := newInputs().Set("sql",
		property.New("CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY, added_at INTEGER);"))

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "uptime-prod-schema",
		Urn:    "urn:pulumi:prod::uptime::sector7:cloudflare:UptimeMonitor$sector7:d1:Query::uptime-prod-schema",
		State:  liveQueryState(),
		Inputs: inputs,
	})
	if err != nil {
		t.Fatalf("edited SQL must decode: %v", err)
	}
	if !resp.HasChanges {
		t.Fatal("an edited schema must plan a change, not be swallowed by the migration")
	}
	if _, ok := resp.DetailedDiff["sql"]; !ok {
		t.Fatalf("expected a sql diff; got %+v", resp.DetailedDiff)
	}
}

// State that never passed through the dynamic provider — anything created by
// the plugin itself — has no __provider and must decode by the normal path.
func TestPluginNativeStateStillDecodes(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "uptime-prod-schema",
		Urn:    "urn:pulumi:prod::uptime::sector7:cloudflare:UptimeMonitor$sector7:d1:Query::uptime-prod-schema",
		State:  liveQueryState().Delete("__provider"),
		Inputs: newInputs(),
	})
	if err != nil {
		t.Fatalf("plugin-native state must decode without a migration: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("unchanged plugin-native state must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// The `__provider` tag must stay REQUIRED, and this is a structural assertion
// rather than a behavioural one for a specific reason.
//
// infer runs migrations BEFORE the normal decode, and skips a migrator only
// when decoding into its old shape FAILS. Tagging `__provider` as `optional`
// therefore makes queryStateV0 match plugin-native state too — state that
// never carried the property at all — so the migration fires on EVERY read,
// permanently, instead of only on legacy state. That is the opposite of what
// the migration's own comment promises.
//
// The original version of this file shipped with `,optional` and was corrected
// in 98643cf. On the states exercised above the outcome was benign, because
// there the migration is an identity copy; but the documented mechanism was
// wrong and the scope was permanent rather than legacy-only.
//
// All three tests above pass under BOTH tags — verified by reintroducing
// `,optional` and re-running them — because an identity copy is invisible from
// outside. That is NOT the same as the two tags being indistinguishable, and
// the difference is worth recording rather than asserting.
//
// `sqlHash` is optional on this shape but REQUIRED on QueryState, so
// queryStateV0 is strictly more permissive than the type it migrates to.
// Plugin-native state missing `sqlHash` therefore diverges: with `__provider`
// required it fails this migrator's decode AND the normal decode, so Diff
// errors; with `,optional` it matches this shape, migrates, and silently
// succeeds with SQLHash "". So `,optional` did not merely mis-scope the
// migration — it also turned a decode error into a silent empty hash.
//
// That divergence is still a poor thing to pin a test to. It is an accident of
// the current field set rather than designed behaviour: it discriminates only
// while some field is optional here and required on QueryState, it stops
// discriminating the moment that ceases to hold, and asserting "Diff must error
// on state with no sqlHash" enshrines an error path nobody chose as if it were
// the point. A failure reading `expected an error, got nil` would also tell the
// next reader nothing about `__provider`.
//
// So this asserts the invariant directly instead: the tag is load-bearing, and
// a future "cleanup" that adds `,optional` for consistency with the other
// optional fields silently changes when the migration runs.
func TestProviderTagIsRequiredSoTheMigrationOnlyMatchesLegacyState(t *testing.T) {
	f, ok := reflect.TypeOf(queryStateV0{}).FieldByName("Provider")
	if !ok {
		t.Fatal("queryStateV0.Provider is gone; if the field was renamed, update this guard rather than deleting it")
	}

	tag := f.Tag.Get("pulumi")
	if tag != "__provider" {
		t.Fatalf("queryStateV0.Provider must be tagged exactly `pulumi:\"__provider\"`, got %q.\n"+
			"Adding ,optional makes this shape match plugin-native state as well, so the\n"+
			"migration would run on every state read instead of only on state written by\n"+
			"the dynamic provider.", tag)
	}
}
