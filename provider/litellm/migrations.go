package litellm

import (
	"context"

	"github.com/pulumi/pulumi-go-provider/infer"
)

// State migrations off the dynamic provider's sentinel encoding.
//
// The dynamic provider normalised unset optionals to empty sentinels so its
// JavaScript callbacks never had to reason about `undefined`:
//
//	maxBudget: pulumi.output(args.maxBudget)
//	  .apply((value) => (value === undefined ? "" : value)),
//
// That gave `maxBudget` the TypeScript type `number | ""`. A Pulumi schema
// cannot express that union, so this provider models it as *float64 — and the
// literal "" sitting in all eight live litellm/prod resources does not decode
// into a number.
//
// Only *typed* optionals are affected. `budgetDuration ?? ""` is a string,
// `models ?? []` an array, `metadata ?? {}` a map — each sentinel is a valid
// value of its own type and decodes fine. Across sector7 the affected fields
// are exactly maxBudget (Team and Key) and attic's retentionPeriodSeconds.
//
// There is a second, independent hazard in the same state: `__provider`, the
// serialized dynamic-provider closure. No current struct declares it, and an
// unrecognized property is a decode failure — not something silently ignored.
// So every old shape below declares it, and the migrations drop it. That is how
// __provider finally leaves state.
//
// How the discrimination works: infer decodes each migrator's Old shape in turn
// and, per its own docs, "if we couldn't encode cleanly, then state doesn't fit
// into the migrator" and moves on. Two shapes are therefore needed per resource,
// differing only in the type of the budget field:
//
//   - ...V0Sentinel — budget as a string, matching state where it is "".
//   - ...V0Numeric  — budget as a number, matching state where one is set.
//
// One shape alone is not enough: with only the sentinel variant, state carrying
// a real budget fails BOTH the migrator (number into string) and the normal
// decode (__provider), which is a hard failure. No live litellm resource sets a
// budget today, but attic's retentionPeriodSeconds is set in places, so the
// numeric path is exercised in practice.
//
// This handles stored state only. The other half of the fix is in the
// TypeScript wrapper, which must omit the property when unset rather than
// emitting "" — inputs come from the running program, so no state migration can
// reach them. Both halves are required.

// teamStateV0Sentinel is TeamState as the dynamic provider serialised it, with
// no budget set (maxBudget == "").
type teamStateV0Sentinel struct {
	AdminTarget
	TeamAlias      string            `pulumi:"teamAlias"`
	DesiredTeamID  string            `pulumi:"desiredTeamId,optional"`
	Models         []string          `pulumi:"models,optional"`
	MaxBudget      string            `pulumi:"maxBudget,optional"`
	BudgetDuration string            `pulumi:"budgetDuration,optional"`
	Tags           []string          `pulumi:"tags,optional"`
	Metadata       map[string]string `pulumi:"metadata,optional"`
	TeamID         string            `pulumi:"teamId"`
	// The serialized dynamic-provider closure. Declared so this shape decodes
	// live state cleanly — without it the migrator is skipped ("state doesn't
	// fit") and the normal decode then fails on the same property. Dropped by
	// the migration below, which is how __provider finally leaves state.
	Provider string `pulumi:"__provider,optional"`
}

func (TeamRecord) StateMigrations(context.Context) []infer.StateMigrationFunc[TeamState] {
	return []infer.StateMigrationFunc[TeamState]{
		infer.StateMigration(func(_ context.Context, old teamStateV0Sentinel) (infer.MigrationResult[TeamState], error) {
			// Reaching here means maxBudget decoded as a string, i.e. it was
			// the "" sentinel: unset. A real budget is a number and would have
			// failed the v0 decode.
			return infer.MigrationResult[TeamState]{Result: &TeamState{
				TeamArgs: TeamArgs{
					AdminTarget:    old.AdminTarget,
					TeamAlias:      old.TeamAlias,
					DesiredTeamID:  old.DesiredTeamID,
					Models:         old.Models,
					MaxBudget:      nil,
					BudgetDuration: old.BudgetDuration,
					Tags:           old.Tags,
					Metadata:       old.Metadata,
				},
				TeamID: old.TeamID,
			}}, nil
		}),
		// Same shape, budget actually set: drop __provider, keep the budget.
		infer.StateMigration(func(_ context.Context, old teamStateV0Numeric) (infer.MigrationResult[TeamState], error) {
			return infer.MigrationResult[TeamState]{Result: &TeamState{
				TeamArgs: TeamArgs{
					AdminTarget:    old.AdminTarget,
					TeamAlias:      old.TeamAlias,
					DesiredTeamID:  old.DesiredTeamID,
					Models:         old.Models,
					MaxBudget:      old.MaxBudget,
					BudgetDuration: old.BudgetDuration,
					Tags:           old.Tags,
					Metadata:       old.Metadata,
				},
				TeamID: old.TeamID,
			}}, nil
		}),
	}
}

// keyStateV0Sentinel is KeyState as the dynamic provider serialised it, with no
// budget set (maxBudget == "").
type keyStateV0Sentinel struct {
	AdminTarget
	KeyAlias       string            `pulumi:"keyAlias"`
	KeyValue       string            `pulumi:"keyValue" provider:"secret"`
	Models         []string          `pulumi:"models,optional"`
	TeamID         string            `pulumi:"teamId,optional"`
	UserID         string            `pulumi:"userId,optional"`
	BudgetID       string            `pulumi:"budgetId,optional"`
	MaxBudget      string            `pulumi:"maxBudget,optional"`
	BudgetDuration string            `pulumi:"budgetDuration,optional"`
	Duration       string            `pulumi:"duration,optional"`
	Aliases        map[string]string `pulumi:"aliases,optional"`
	Tags           []string          `pulumi:"tags,optional"`
	Metadata       map[string]string `pulumi:"metadata,optional"`
	TokenID        string            `pulumi:"tokenId" provider:"secret"`
	// See teamStateV0Sentinel.Provider.
	Provider string `pulumi:"__provider,optional"`
}

func (KeyRecord) StateMigrations(context.Context) []infer.StateMigrationFunc[KeyState] {
	return []infer.StateMigrationFunc[KeyState]{
		infer.StateMigration(func(_ context.Context, old keyStateV0Sentinel) (infer.MigrationResult[KeyState], error) {
			return infer.MigrationResult[KeyState]{Result: &KeyState{
				KeyArgs: KeyArgs{
					AdminTarget:    old.AdminTarget,
					KeyAlias:       old.KeyAlias,
					KeyValue:       old.KeyValue,
					Models:         old.Models,
					TeamID:         old.TeamID,
					UserID:         old.UserID,
					BudgetID:       old.BudgetID,
					MaxBudget:      nil,
					BudgetDuration: old.BudgetDuration,
					Duration:       old.Duration,
					Aliases:        old.Aliases,
					Tags:           old.Tags,
					Metadata:       old.Metadata,
				},
				TokenID: old.TokenID,
			}}, nil
		}),
		// Same shape, budget actually set: drop __provider, keep the budget.
		infer.StateMigration(func(_ context.Context, old keyStateV0Numeric) (infer.MigrationResult[KeyState], error) {
			return infer.MigrationResult[KeyState]{Result: &KeyState{
				KeyArgs: KeyArgs{
					AdminTarget:    old.AdminTarget,
					KeyAlias:       old.KeyAlias,
					KeyValue:       old.KeyValue,
					Models:         old.Models,
					TeamID:         old.TeamID,
					UserID:         old.UserID,
					BudgetID:       old.BudgetID,
					MaxBudget:      old.MaxBudget,
					BudgetDuration: old.BudgetDuration,
					Duration:       old.Duration,
					Aliases:        old.Aliases,
					Tags:           old.Tags,
					Metadata:       old.Metadata,
				},
				TokenID: old.TokenID,
			}}, nil
		}),
	}
}

// teamStateV0Numeric is TeamState as the dynamic provider serialised it, with a
// budget actually set. Identical to the sentinel shape except MaxBudget is a
// number, so exactly one of the two decodes any given old state.
type teamStateV0Numeric struct {
	AdminTarget
	TeamAlias      string            `pulumi:"teamAlias"`
	DesiredTeamID  string            `pulumi:"desiredTeamId,optional"`
	Models         []string          `pulumi:"models,optional"`
	MaxBudget      *float64          `pulumi:"maxBudget,optional"`
	BudgetDuration string            `pulumi:"budgetDuration,optional"`
	Tags           []string          `pulumi:"tags,optional"`
	Metadata       map[string]string `pulumi:"metadata,optional"`
	TeamID         string            `pulumi:"teamId"`
	Provider       string            `pulumi:"__provider,optional"`
}

// keyStateV0Numeric — see teamStateV0Numeric.
type keyStateV0Numeric struct {
	AdminTarget
	KeyAlias       string            `pulumi:"keyAlias"`
	KeyValue       string            `pulumi:"keyValue" provider:"secret"`
	Models         []string          `pulumi:"models,optional"`
	TeamID         string            `pulumi:"teamId,optional"`
	UserID         string            `pulumi:"userId,optional"`
	BudgetID       string            `pulumi:"budgetId,optional"`
	MaxBudget      *float64          `pulumi:"maxBudget,optional"`
	BudgetDuration string            `pulumi:"budgetDuration,optional"`
	Duration       string            `pulumi:"duration,optional"`
	Aliases        map[string]string `pulumi:"aliases,optional"`
	Tags           []string          `pulumi:"tags,optional"`
	Metadata       map[string]string `pulumi:"metadata,optional"`
	TokenID        string            `pulumi:"tokenId" provider:"secret"`
	Provider       string            `pulumi:"__provider,optional"`
}
