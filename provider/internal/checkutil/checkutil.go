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
// single implementation they now all share — litellm.TeamRecord included, which
// kept its own copy until #378 showed what the divergence costs.
package checkutil

import (
	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi/sdk/v3/go/property"
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
// inputs is the raw req.NewInputs the caller already passed to
// infer.DefaultCheck. It is needed because infer.DefaultCheck decodes an input
// that is UNKNOWN at preview time to the Go zero value, not to an unknown
// sentinel: a required string that is merely not computed yet is
// indistinguishable, after decoding, from one the user never set. Without
// consulting the raw inputs, a resource whose required input comes from a
// sibling created in the same update can never be previewed — it fails Check
// with "<name> is required" for a value that is on its way. litellm.KeyRecord
// hit this on every new key, since the component always sources keyValue from
// a RandomPassword it owns (jmmaloney4/sector7#378). KeyRecord.Diff carries
// the same guard for the same reason.
//
// Nothing is weakened by skipping unknowns: Check runs again during the real
// update with resolved inputs, so a genuinely empty required field is still
// rejected before Create.
//
// failures must be non-nil; callers already hold the slice returned by
// infer.DefaultCheck and pass its address so this can append in place.
func RequireNonEmpty(failures *[]p.CheckFailure, inputs property.Map, fields ...NamedField) {
	for _, f := range fields {
		// HasComputed, not IsComputed: a secret input arrives wrapped, so an
		// unknown secret is secret(computed) and the shallow check misses it.
		// Every field this helper guards is a candidate — keyValue, masterKey
		// and accessToken are all declared `provider:"secret"`.
		if v, ok := inputs.GetOk(f.Name); ok && v.HasComputed() {
			continue
		}
		if f.Value == "" {
			*failures = append(*failures, p.CheckFailure{Property: f.Name, Reason: f.Name + " is required"})
		}
	}
}
