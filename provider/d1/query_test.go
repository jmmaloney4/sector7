package d1

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	pgo "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"
	"github.com/pulumi/pulumi/sdk/v3/go/property"
)

func args() QueryArgs {
	return QueryArgs{AccountID: "acct", DatabaseID: "db", SQL: "CREATE TABLE IF NOT EXISTS t (id INT)", APIToken: "tok"}
}

// Cloudflare answers HTTP 200 with success:false for query-level failures, so a
// 2xx is not sufficient — this is the easiest thing to get wrong in the port,
// and getting it wrong means silently recording a schema migration that never
// ran.
func TestQueryLevelFailureIsAnErrorDespiteHTTP200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": false,
			"errors":  []any{map[string]any{"message": "no such table"}, map[string]any{"message": "near \"FROM\""}},
		})
	}))
	defer srv.Close()

	_, err := Query{BaseURL: srv.URL}.Create(t.Context(), infer.CreateRequest[QueryArgs]{Inputs: args()})
	if err == nil {
		t.Fatal("success:false must be an error even with HTTP 200")
	}
	// All error messages are joined, not just the first.
	if !strings.Contains(err.Error(), "no such table") || !strings.Contains(err.Error(), "near") {
		t.Fatalf("every error message must surface; got %v", err)
	}
}

func TestCreateExecutesAndDerivesID(t *testing.T) {
	var gotSQL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotSQL, _ = body["sql"].(string)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))
	defer srv.Close()

	resp, err := Query{BaseURL: srv.URL}.Create(t.Context(), infer.CreateRequest[QueryArgs]{Inputs: args()})
	if err != nil {
		t.Fatal(err)
	}
	if gotSQL != args().SQL {
		t.Fatalf("SQL not sent: %q", gotSQL)
	}
	if !strings.HasPrefix(resp.ID, "d1query:db:") {
		t.Fatalf("id: %q", resp.ID)
	}
	if len(resp.Output.SQLHash) != 64 {
		t.Fatalf("sqlHash should be a full sha256 hex digest; got %d chars", len(resp.Output.SQLHash))
	}
}

func TestDiffReplacesOnStatementIdentityButNotOnToken(t *testing.T) {
	old := QueryState{QueryArgs: args(), SQLHash: "h"}

	changed := args()
	changed.SQL = "SELECT 1"
	r, _ := Query{}.Diff(t.Context(), infer.DiffRequest[QueryArgs, QueryState]{State: old, Inputs: changed})
	if r.DetailedDiff["sql"].Kind != pgo.UpdateReplace || !r.DeleteBeforeReplace {
		t.Fatalf("a SQL change must replace, deleting first; got %+v", r)
	}

	// A token rotation only changes the credential, so it re-executes in place.
	rotated := args()
	rotated.APIToken = "new"
	r, _ = Query{}.Diff(t.Context(), infer.DiffRequest[QueryArgs, QueryState]{State: old, Inputs: rotated})
	if !r.HasChanges || r.DetailedDiff["apiToken"].Kind == pgo.UpdateReplace {
		t.Fatalf("a token rotation must be in-place; got %+v", r.DetailedDiff)
	}
}

// Schema data outlives the resource; destroy must not try to undo it.
func TestDeleteIsANoOp(t *testing.T) {
	if _, err := (Query{}).Delete(t.Context(), infer.DeleteRequest[QueryState]{ID: "x"}); err != nil {
		t.Fatal(err)
	}
}

// Check coverage inherited from the TypeScript dynamic provider. Subtest names
// carry the exact `it(...)` strings from tests/d1-query.test.ts, which the
// plugin retype deletes, so the two lists can be diffed mechanically during
// review and nothing is silently dropped.
func TestCheck(t *testing.T) {
	inputs := func(m map[string]string) property.Map {
		vals := map[string]property.Value{}
		for k, v := range m {
			vals[k] = property.New(v)
		}
		return property.NewMap(vals)
	}
	failedProps := func(fs []pgo.CheckFailure) map[string]bool {
		out := map[string]bool{}
		for _, f := range fs {
			out[string(f.Property)] = true
		}
		return out
	}

	t.Run("reports no check failures for valid inputs", func(t *testing.T) {
		resp, err := Query{}.Check(t.Context(), infer.CheckRequest{
			NewInputs: inputs(map[string]string{
				"accountId":  "acct",
				"databaseId": "db",
				"sql":        "CREATE TABLE IF NOT EXISTS t (id INT)",
				"apiToken":   "tok",
			}),
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(resp.Failures) != 0 {
			t.Fatalf("valid inputs must pass check; got %+v", resp.Failures)
		}
	})

	t.Run("reports check failures when required fields are missing", func(t *testing.T) {
		resp, err := Query{}.Check(t.Context(), infer.CheckRequest{NewInputs: property.NewMap(nil)})
		if err != nil {
			t.Fatal(err)
		}
		got := failedProps(resp.Failures)
		for _, want := range []string{"accountId", "databaseId", "sql", "apiToken"} {
			if !got[want] {
				t.Fatalf("expected a failure for %q; got %+v", want, resp.Failures)
			}
		}
	})

	// Whitespace-only SQL is rejected too. Executing it would be a no-op that
	// still records a sqlHash, so the resource would claim a schema had been
	// applied when nothing ran.
	t.Run("rejects whitespace-only SQL", func(t *testing.T) {
		resp, err := Query{}.Check(t.Context(), infer.CheckRequest{
			NewInputs: inputs(map[string]string{
				"accountId":  "acct",
				"databaseId": "db",
				"sql":        "   \n\t ",
				"apiToken":   "tok",
			}),
		})
		if err != nil {
			t.Fatal(err)
		}
		if !failedProps(resp.Failures)["sql"] {
			t.Fatalf("whitespace-only SQL must fail check; got %+v", resp.Failures)
		}
	})
}

// "detects no changes when SQL is unchanged" — the case that matters most on
// every routine `up`: an untouched schema resource must not re-run its DDL.
func TestDiffIsANoOpWhenNothingChanged(t *testing.T) {
	old := QueryState{QueryArgs: args(), SQLHash: "h"}
	r, err := Query{}.Diff(t.Context(), infer.DiffRequest[QueryArgs, QueryState]{State: old, Inputs: args()})
	if err != nil {
		t.Fatal(err)
	}
	if r.HasChanges {
		t.Fatalf("unchanged inputs must not diff; got %+v", r.DetailedDiff)
	}
}
