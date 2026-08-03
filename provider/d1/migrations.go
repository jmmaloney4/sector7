package d1

import (
	"context"

	"github.com/pulumi/pulumi-go-provider/infer"
)

// State migration off the dynamic provider.
//
// Live state written by the dynamic provider carries `__provider`, the
// serialized JavaScript closure — the very thing this plugin exists to stop
// storing. No struct here declares it, and infer treats an unrecognized
// property as a decode FAILURE rather than something quietly ignored:
//
//	Unrecognized field '__provider' on 'd1.QueryState'
//
// So without this migration the alias retype does not diff to nothing; it
// fails outright at the first preview. Verified against the real gRPC path in
// migrations_test.go using the shape read off uptime/prod.
//
// This is simpler than the litellm equivalent, and deliberately so. litellm
// needed two shapes per resource to discriminate a sentinel-encoded optional
// (`maxBudget: number | ""`), because a single shape would have made state
// carrying a real budget fail both the migrator and the normal decode. d1 has
// no such hazard: accountId, databaseId, sql and apiToken are all strings, so
// an empty value is a valid value of its own type and decodes fine either way.
// __provider is the only obstacle, so one shape suffices.
//
// The migration is additive-safe: state that never passed through the dynamic
// provider has no __provider, fails this migrator's decode ("doesn't fit into
// the migrator", per infer's own docs), and falls through to the normal path
// unchanged.
type queryStateV0 struct {
	QueryArgs
	SQLHash string `pulumi:"sqlHash,optional"`
	// Provider is the serialized dynamic-provider closure. Declared only so it
	// can be dropped — nothing reads it, and this is how __provider finally
	// leaves state.
	//
	// Deliberately NOT optional, and that tag is load-bearing. infer tries this
	// migrator before the normal decode, so `optional` would make the shape
	// match plugin-native state too and route every future read through the
	// migration — the opposite of the additive-safety described above. Required
	// is what makes native state miss this shape and fall through.
	Provider string `pulumi:"__provider"`
}

// StateMigrations satisfies infer.CustomStateMigrations[QueryState].
func (Query) StateMigrations(context.Context) []infer.StateMigrationFunc[QueryState] {
	return []infer.StateMigrationFunc[QueryState]{
		infer.StateMigration(func(_ context.Context, old queryStateV0) (infer.MigrationResult[QueryState], error) {
			return infer.MigrationResult[QueryState]{
				Result: &QueryState{
					QueryArgs: old.QueryArgs,
					SQLHash:   old.SQLHash,
				},
			}, nil
		}),
	}
}
