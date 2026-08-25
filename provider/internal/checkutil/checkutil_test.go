package checkutil

import (
	"testing"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi/sdk/v3/go/property"
)

// known builds the raw-input map for fields that all carry ordinary values, so
// the table below reads as "nothing is unknown here".
func known(names ...string) property.Map {
	m := map[string]property.Value{}
	for _, n := range names {
		m[n] = property.New("whatever")
	}
	return property.NewMap(m)
}

func TestRequireNonEmptyReportsMissingFieldsInOrder(t *testing.T) {
	var failures []p.CheckFailure
	RequireNonEmpty(&failures, known("a", "b", "c"),
		NamedField{Name: "a", Value: ""},
		NamedField{Name: "b", Value: "present"},
		NamedField{Name: "c", Value: ""},
	)
	if len(failures) != 2 {
		t.Fatalf("expected 2 failures, got %d: %+v", len(failures), failures)
	}
	if failures[0].Property != "a" || failures[0].Reason != "a is required" {
		t.Fatalf("unexpected failures[0]: %+v", failures[0])
	}
	if failures[1].Property != "c" || failures[1].Reason != "c is required" {
		t.Fatalf("unexpected failures[1]: %+v", failures[1])
	}
}

func TestRequireNonEmptyAllPresentReportsNothing(t *testing.T) {
	var failures []p.CheckFailure
	RequireNonEmpty(&failures, known("a", "b"),
		NamedField{Name: "a", Value: "x"},
		NamedField{Name: "b", Value: "y"},
	)
	if len(failures) != 0 {
		t.Fatalf("expected no failures, got %+v", failures)
	}
}

func TestRequireNonEmptyNoFieldsIsNoop(t *testing.T) {
	var failures []p.CheckFailure
	RequireNonEmpty(&failures, property.Map{})
	if len(failures) != 0 {
		t.Fatalf("expected no failures, got %+v", failures)
	}
}

// property.Map is a value type, so the zero value is a legal empty map rather
// than something that can be nil — reading it is safe and every field simply
// misses. Pinned as a test because "can this map be nil?" is the obvious
// question to ask of the GetOk guard, and the answer should not have to be
// rediscovered by compiling something.
func TestRequireNonEmptyToleratesAZeroValueInputMap(t *testing.T) {
	var zero property.Map
	var failures []p.CheckFailure
	RequireNonEmpty(&failures, zero,
		NamedField{Name: "a", Value: ""},
		NamedField{Name: "b", Value: "present"},
	)
	if len(failures) != 1 || failures[0].Property != "a" {
		t.Fatalf("expected only the empty field to fail, got %+v", failures)
	}
}

// RequireNonEmpty must append to an already-populated slice (as callers pass
// the failures collected by infer.DefaultCheck), not replace it.
func TestRequireNonEmptyAppendsToExistingFailures(t *testing.T) {
	failures := []p.CheckFailure{{Property: "existing", Reason: "existing is bad"}}
	RequireNonEmpty(&failures, known("a"), NamedField{Name: "a", Value: ""})
	if len(failures) != 2 {
		t.Fatalf("expected append not replace, got %+v", failures)
	}
	if failures[0].Property != "existing" {
		t.Fatalf("expected the existing failure to be preserved first, got %+v", failures)
	}
	if failures[1].Property != "a" || failures[1].Reason != "a is required" {
		t.Fatalf("unexpected appended failure: %+v", failures[1])
	}
}

// The regression this package's guard exists for (#378): an input that is
// unknown at preview decodes to "" like a missing one, and reporting it as
// missing makes the resource unpreviewable. litellm.KeyRecord's keyValue always
// arrives this way on a new key — from a RandomPassword created in the same
// update.
func TestRequireNonEmptyIgnoresUnknownInputs(t *testing.T) {
	var failures []p.CheckFailure
	RequireNonEmpty(&failures, property.NewMap(map[string]property.Value{
		"keyValue": property.New(property.Computed),
	}), NamedField{Name: "keyValue", Value: ""})
	if len(failures) != 0 {
		t.Fatalf("an unknown input is not a missing one, got %+v", failures)
	}
}

// An unknown secret arrives as secret(computed). This is why the guard uses
// HasComputed rather than IsComputed — keyValue, masterKey and accessToken are
// all declared `provider:"secret"`, so the shallow check would miss every one
// of them and leave the bug in place for exactly the fields that hit it.
func TestRequireNonEmptyIgnoresUnknownSecretInputs(t *testing.T) {
	var failures []p.CheckFailure
	RequireNonEmpty(&failures, property.NewMap(map[string]property.Value{
		"masterKey": property.New(property.Computed).WithSecret(true),
	}), NamedField{Name: "masterKey", Value: ""})
	if len(failures) != 0 {
		t.Fatalf("an unknown secret is not a missing one, got %+v", failures)
	}
}

// Skipping unknowns must not become "skip everything". A field that is present
// in the raw inputs and genuinely empty is still a failure, which is what keeps
// the guard honest at up-time when every input is resolved.
func TestRequireNonEmptyStillReportsKnownEmptyInputs(t *testing.T) {
	var failures []p.CheckFailure
	RequireNonEmpty(&failures, property.NewMap(map[string]property.Value{
		"keyAlias": property.New(""),
	}), NamedField{Name: "keyAlias", Value: ""})
	if len(failures) != 1 {
		t.Fatalf("expected 1 failure, got %+v", failures)
	}
	if failures[0].Property != "keyAlias" || failures[0].Reason != "keyAlias is required" {
		t.Fatalf("unexpected failure: %+v", failures[0])
	}
}

// A field absent from the raw inputs entirely is the plain "you did not set
// this" case and must still fail. GetOk's second return is what separates it
// from the unknown case above.
func TestRequireNonEmptyReportsFieldsAbsentFromInputs(t *testing.T) {
	var failures []p.CheckFailure
	RequireNonEmpty(&failures, property.NewMap(map[string]property.Value{
		"somethingElse": property.New("x"),
	}), NamedField{Name: "vault", Value: ""})
	if len(failures) != 1 {
		t.Fatalf("expected 1 failure, got %+v", failures)
	}
	if failures[0].Property != "vault" || failures[0].Reason != "vault is required" {
		t.Fatalf("unexpected failure: %+v", failures[0])
	}
}

// Mixed run: the unknown is skipped while its genuinely-missing neighbour is
// still reported, so a fresh stack surfaces real misconfiguration instead of
// being drowned in false "is required" noise from every not-yet-computed input.
func TestRequireNonEmptyMixesUnknownAndMissing(t *testing.T) {
	var failures []p.CheckFailure
	RequireNonEmpty(&failures, property.NewMap(map[string]property.Value{
		"masterKey":      property.New(property.Computed).WithSecret(true),
		"proxyNamespace": property.New(property.Computed),
		"keyAlias":       property.New(""),
	}),
		NamedField{Name: "masterKey", Value: ""},
		NamedField{Name: "proxyNamespace", Value: ""},
		NamedField{Name: "keyAlias", Value: ""},
	)
	if len(failures) != 1 {
		t.Fatalf("expected only keyAlias to fail, got %+v", failures)
	}
	if failures[0].Property != "keyAlias" {
		t.Fatalf("unexpected failure: %+v", failures[0])
	}
}
