// Package diffutil provides order-insensitive comparison helpers for provider
// Diff implementations.
//
// Why this exists: infer's reflective diff compares slices with DeepEqual and
// is therefore order-*sensitive*. The dynamic providers this package replaces
// compared `models`, `tags` and friends through `stableJson`, which sorts, so a
// pure reordering of `models` was NOT a change. Preserving that is not
// cosmetic — `proxy-plan.ts` rebuilds those arrays on every run, and a
// spurious diff on `personal::coding` would replace live LiteLLM keys.
//
// Consequently every sector7 resource implements infer.CustomDiff rather than
// relying on the reflective default. That is also the only way to set
// DeleteBeforeReplace, which litellm:Key requires.
package diffutil

import (
	"encoding/json"
	"sort"
)

// StableJSON renders v as JSON with a canonical ordering, so two values that
// differ only in ordering compare equal.
//
// It reproduces sector7's `stableJson` (packages/sector7/litellm/admin.ts)
// exactly, including its one asymmetry: **top-level slices are sorted, nested
// ones are not**. Go's encoding/json already sorts map keys, so the recursive
// key-sorting half of `stableValue` comes for free.
//
// Matching the old behaviour precisely matters more than being "more correct"
// here: any comparison that is stricter than the TypeScript version turns a
// no-op into a diff during the alias migration, and any that is looser hides a
// real change.
func StableJSON(v any) string {
	if s, ok := v.([]string); ok {
		c := append([]string(nil), s...)
		sort.Strings(c)
		b, err := json.Marshal(c)
		if err != nil {
			return ""
		}
		return string(b)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

// StringsEqual reports whether two string slices are equal ignoring order.
// nil and empty are equivalent, matching the TS `?? []` normalisation.
func StringsEqual(a, b []string) bool { return StableJSON(a) == StableJSON(b) }

// StringMapEqual reports whether two string maps are equal. nil and empty are
// equivalent, matching the TS `?? {}` normalisation.
func StringMapEqual(a, b map[string]string) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	return StableJSON(a) == StableJSON(b)
}

// Float64PtrEqual compares optional numbers, treating nil as "unset".
//
// This replaces the `number | ""` sentinel union the dynamic providers used.
// A Pulumi schema cannot express that union, so unset becomes a nil pointer —
// but the distinction the sentinel carried (set-then-cleared, which must send
// an explicit null on update) is an olds-vs-news question, and infer's
// UpdateRequest carries both. See litellm.applyClearedFields.
func Float64PtrEqual(a, b *float64) bool {
	switch {
	case a == nil && b == nil:
		return true
	case a == nil || b == nil:
		return false
	default:
		return *a == *b
	}
}
