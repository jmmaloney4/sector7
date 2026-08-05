package matrix

import (
	"context"

	"github.com/pulumi/pulumi-go-provider/infer"
)

// State migrations off the dynamic provider.
//
// Room and BotAccount replace garden-local TypeScript dynamic providers
// (deploy/services/matrix/matrix-room.ts, matrix-bot-account.ts — see the
// package doc comment on botaccount.go). Live state written by either one
// carries `__provider`, the serialized JavaScript closure this plugin exists
// to stop storing. infer treats an unrecognized property as a decode FAILURE
// rather than something quietly ignored:
//
//	Unrecognized field '__provider' on 'matrix.RoomState'
//	Unrecognized field '__provider' on 'matrix.BotAccountState'
//
// so without a migration the alias retype does not diff to nothing; it fails
// outright at the first preview. Same shape and same mechanism as d1 and
// onepassword; see provider/d1/migrations.go for the most heavily-commented
// version of this pattern.
//
// One shape suffices for each resource. Neither RoomState nor BotAccountState
// has a sentinel-encoded optional the way litellm's maxBudget did — every
// property is a plain string, []string or *bool, so an empty/nil value is a
// valid value of its own type and decodes fine whichever path it takes.
// __provider is the only obstacle. (RoomArgs.IsDirect is a *bool rather than
// bool specifically so a room with no isDirect in its inputs decodes as nil
// instead of a false that Diff would then treat as a real value — see
// boolPtrEqual in room.go — but that is a property of RoomState itself, not
// something this migration needs to work around.)
//
// Both migrations are additive-safe: state that never passed through a
// dynamic provider has no __provider, fails the migrator's decode ("doesn't
// fit into the migrator", per infer's own docs), and falls through to the
// normal path unchanged. Verified against the real gRPC path in
// migrations_test.go using shapes modeled on the TypeScript outputs.

type roomStateV0 struct {
	RoomState
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

// StateMigrations satisfies infer.CustomStateMigrations[RoomState].
func (Room) StateMigrations(context.Context) []infer.StateMigrationFunc[RoomState] {
	return []infer.StateMigrationFunc[RoomState]{
		infer.StateMigration(func(_ context.Context, old roomStateV0) (infer.MigrationResult[RoomState], error) {
			migrated := old.RoomState
			return infer.MigrationResult[RoomState]{Result: &migrated}, nil
		}),
	}
}

type botAccountStateV0 struct {
	BotAccountState
	// Provider is the serialized dynamic-provider closure. Declared only so it
	// can be dropped — nothing reads it.
	//
	// Deliberately NOT optional, for the same reason as roomStateV0.Provider
	// above: infer tries this migrator before the normal decode, and `optional`
	// would make the shape match plugin-native state too, routing every future
	// read through the migration instead of only legacy state. Guarded by
	// TestProviderTagIsRequiredSoTheMigrationOnlyMatchesLegacyState.
	Provider string `pulumi:"__provider"`
}

// StateMigrations satisfies infer.CustomStateMigrations[BotAccountState].
func (BotAccount) StateMigrations(context.Context) []infer.StateMigrationFunc[BotAccountState] {
	return []infer.StateMigrationFunc[BotAccountState]{
		infer.StateMigration(func(_ context.Context, old botAccountStateV0) (infer.MigrationResult[BotAccountState], error) {
			migrated := old.BotAccountState
			return infer.MigrationResult[BotAccountState]{Result: &migrated}, nil
		}),
	}
}
