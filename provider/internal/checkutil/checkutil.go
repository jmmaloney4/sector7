// Package checkutil provides the shared "required non-empty string" Check
// idiom used across sector7's Pulumi resources.
//
// Every resource's infer.CustomCheck implementation needs to reject missing
// required string inputs as a p.CheckFailure per field, so `pulumi preview`
// surfaces every missing field at once instead of one at a time across
// repeated runs. Before this package existed, at least seven resources
// (r2.Object, r2.ZoneCachePurge, attic.Cache, onepassword.Item,
// litellm.KeyRecord, matrix.Room, matrix.BotAccount) hand-rolled the same
// loop-or-fail-closure with slightly drifting wording. RequireNonEmpty is the
// single implementation they now all share.
package checkutil

import (
	p "github.com/pulumi/pulumi-go-provider"
)

// NamedField pairs a Pulumi input property name with its string value for a
// RequireNonEmpty check.
type NamedField struct {
	Name  string
	Value string
}

// RequireNonEmpty appends a p.CheckFailure to *failures for every field whose
// Value is the empty string, in the order given. The message is always
// "<name> is required", the wording sector7's Check implementations had
// already converged on independently before this package existed.
//
// failures must be non-nil; callers already hold the slice returned by
// infer.DefaultCheck and pass its address so this can append in place.
func RequireNonEmpty(failures *[]p.CheckFailure, fields ...NamedField) {
	for _, f := range fields {
		if f.Value == "" {
			*failures = append(*failures, p.CheckFailure{Property: f.Name, Reason: f.Name + " is required"})
		}
	}
}
