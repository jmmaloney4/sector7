package r2

import (
	"context"

	"github.com/pulumi/pulumi-go-provider/infer"
)

// State migration off the dynamic provider.
//
// R2Object replaces the garden-local TypeScript dynamic provider
// (packages/sector7/r2/r2object.ts, deployed today via
// deploy/www/theoreticaledge.com's uploadStaticAssets/R2Object pipeline). The
// dynamic provider's create/update handlers wrote state as `{ ...inputs, etag
// }`, and the Pulumi dynamic-resource runtime additionally persists
// `__provider`, the serialized JavaScript closure this plugin exists to stop
// storing. infer treats an unrecognized property as a decode FAILURE rather
// than something quietly ignored:
//
//	Unrecognized field '__provider' on 'r2.ObjectState'
//
// so without this migration the alias retype does not diff to nothing; it
// fails outright at the first preview. Same shape and same mechanism as d1
// and onepassword; see provider/d1/migrations.go for the most
// heavily-commented version of this pattern.
//
// One shape suffices. There is no sentinel-encoded optional the way
// litellm's maxBudget was — every ObjectArgs/ObjectState property is a plain
// string, so an empty value is a valid value of its own type and decodes
// fine whichever path it takes. __provider is the only obstacle.
//
// The migration is additive-safe: state that never passed through the
// dynamic provider has no __provider, fails this migrator's decode ("doesn't
// fit into the migrator", per infer's own docs), and falls through to the
// normal path unchanged. Verified against the real gRPC path in
// migrations_test.go using a shape modeled on r2object.ts's stateOuts.
type objectStateV0 struct {
	ObjectState
	// Provider is the serialized dynamic-provider closure. Declared only so
	// it can be dropped — nothing reads it.
	//
	// Deliberately NOT optional, and that tag is load-bearing. infer tries
	// this migrator before the normal decode, so `optional` would make the
	// shape match plugin-native state too and route every future read
	// through the migration rather than only legacy state. Required is what
	// makes native state miss this shape and fall through. Guarded by
	// TestProviderTagIsRequiredSoTheMigrationOnlyMatchesLegacyState.
	Provider string `pulumi:"__provider"`
}

// StateMigrations satisfies infer.CustomStateMigrations[ObjectState].
func (Object) StateMigrations(context.Context) []infer.StateMigrationFunc[ObjectState] {
	return []infer.StateMigrationFunc[ObjectState]{
		infer.StateMigration(func(_ context.Context, old objectStateV0) (infer.MigrationResult[ObjectState], error) {
			migrated := old.ObjectState
			return infer.MigrationResult[ObjectState]{Result: &migrated}, nil
		}),
	}
}
