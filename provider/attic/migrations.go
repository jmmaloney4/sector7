package attic

import (
	"context"

	"github.com/pulumi/pulumi-go-provider/infer"
)

// State migrations off the dynamic provider.
//
// Cache and Token replace garden-local TypeScript dynamic providers
// (packages/sector7/attic/admin.ts's AtticCacheRecord/AtticTokenRecord,
// wrapped by the AtticCache/AtticToken ComponentResources). Live state
// written by either one carries `__provider`, the serialized JavaScript
// closure this plugin exists to stop storing. infer treats an unrecognized
// property as a decode FAILURE rather than something quietly ignored:
//
//	Unrecognized field '__provider' on 'attic.CacheState'
//	Unrecognized field '__provider' on 'attic.TokenState'
//
// so without a migration the alias retype does not diff to nothing; it fails
// outright at the first preview. Same shape and same mechanism as d1,
// onepassword and matrix; see provider/d1/migrations.go for the most
// heavily-commented version of this pattern.
//
// This file only handles the STATE SHAPE (dropping __provider from the
// decoded properties). It says nothing about the split
// ComponentResource/dynamic.Resource URN structure the old TypeScript used —
// that is a TypeScript-side alias concern (packages/sector7/attic/admin.ts),
// entirely orthogonal to what gets migrated here.
//
// One shape suffices for each resource. Neither CacheArgs nor TokenArgs has a
// sentinel-encoded optional the way litellm's maxBudget did — every property
// is a plain string, bool, int, []string or map, so an empty/nil value is a
// valid value of its own type and decodes fine whichever path it takes.
// __provider is the only obstacle. Kubeconfig (added to CacheArgs in
// sector7#359, after the dynamic provider existed) is `,optional`, so its
// absence in legacy state is not an obstacle either.
//
// Both migrations are additive-safe: state that never passed through a
// dynamic provider has no __provider, fails the migrator's decode ("doesn't
// fit into the migrator", per infer's own docs), and falls through to the
// normal path unchanged. Verified against the real gRPC path in
// migrations_test.go using shapes modeled on the TypeScript outputs.

type cacheStateV0 struct {
	CacheState
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

// StateMigrations satisfies infer.CustomStateMigrations[CacheState].
func (Cache) StateMigrations(context.Context) []infer.StateMigrationFunc[CacheState] {
	return []infer.StateMigrationFunc[CacheState]{
		infer.StateMigration(func(_ context.Context, old cacheStateV0) (infer.MigrationResult[CacheState], error) {
			migrated := old.CacheState
			return infer.MigrationResult[CacheState]{Result: &migrated}, nil
		}),
	}
}

type tokenStateV0 struct {
	TokenState
	// Provider is the serialized dynamic-provider closure. Declared only so it
	// can be dropped — nothing reads it.
	//
	// Deliberately NOT optional, for the same reason as cacheStateV0.Provider
	// above. Guarded by
	// TestProviderTagIsRequiredSoTheMigrationOnlyMatchesLegacyState.
	Provider string `pulumi:"__provider"`
}

// StateMigrations satisfies infer.CustomStateMigrations[TokenState].
func (Token) StateMigrations(context.Context) []infer.StateMigrationFunc[TokenState] {
	return []infer.StateMigrationFunc[TokenState]{
		infer.StateMigration(func(_ context.Context, old tokenStateV0) (infer.MigrationResult[TokenState], error) {
			migrated := old.TokenState
			return infer.MigrationResult[TokenState]{Result: &migrated}, nil
		}),
	}
}
