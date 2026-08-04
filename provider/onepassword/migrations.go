package onepassword

import (
	"context"

	"github.com/pulumi/pulumi-go-provider/infer"
)

// State migration off the dynamic provider.
//
// Live state written by the dynamic provider carries `__provider`, the
// serialized JavaScript closure this plugin exists to stop storing. infer
// treats an unrecognized property as a decode FAILURE rather than something
// quietly ignored:
//
//	Unrecognized field '__provider' on 'onepassword.ItemState'
//
// so without this the alias retype fails at the first preview instead of
// diffing to nothing. Same shape as the d1 migration; see that file for the
// mechanism.
//
// One shape suffices. There is no sentinel-encoded optional to discriminate —
// the TypeScript's stateOuts wrote real values for every property it emitted,
// defaulting deploymentName/connectPort/category rather than leaving empty
// markers. The only obstacle is __provider.
//
// The remaining shape difference between old and new state is `fields`, and it
// resolves itself: the dynamic provider never wrote field values into outputs,
// and ItemState no longer expects them. See the comment on ItemState.
type itemStateV0 struct {
	ItemState
	// Provider is the serialized dynamic-provider closure. Declared only so it
	// can be dropped — nothing reads it.
	//
	// Deliberately NOT optional, and that tag is load-bearing. infer tries this
	// migrator before the normal decode, so `optional` would make the shape
	// match plugin-native state too and route every future read through the
	// migration rather than only legacy state. Required is what makes native
	// state miss this shape and fall through. Guarded by
	// TestProviderTagIsRequiredSoTheMigrationOnlyMatchesLegacyState.
	Provider string `pulumi:"__provider"`
}

// StateMigrations satisfies infer.CustomStateMigrations[ItemState].
func (Item) StateMigrations(context.Context) []infer.StateMigrationFunc[ItemState] {
	return []infer.StateMigrationFunc[ItemState]{
		infer.StateMigration(func(_ context.Context, old itemStateV0) (infer.MigrationResult[ItemState], error) {
			migrated := old.ItemState
			return infer.MigrationResult[ItemState]{Result: &migrated}, nil
		}),
	}
}
