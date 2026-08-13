package checkutil

import (
	"testing"

	p "github.com/pulumi/pulumi-go-provider"
)

func TestRequireNonEmptyReportsMissingFieldsInOrder(t *testing.T) {
	var failures []p.CheckFailure
	RequireNonEmpty(&failures,
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
	RequireNonEmpty(&failures,
		NamedField{Name: "a", Value: "x"},
		NamedField{Name: "b", Value: "y"},
	)
	if len(failures) != 0 {
		t.Fatalf("expected no failures, got %+v", failures)
	}
}

func TestRequireNonEmptyNoFieldsIsNoop(t *testing.T) {
	var failures []p.CheckFailure
	RequireNonEmpty(&failures)
	if len(failures) != 0 {
		t.Fatalf("expected no failures, got %+v", failures)
	}
}

// RequireNonEmpty must append to an already-populated slice (as callers pass
// the failures collected by infer.DefaultCheck), not replace it.
func TestRequireNonEmptyAppendsToExistingFailures(t *testing.T) {
	failures := []p.CheckFailure{{Property: "existing", Reason: "existing is bad"}}
	RequireNonEmpty(&failures, NamedField{Name: "a", Value: ""})
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
