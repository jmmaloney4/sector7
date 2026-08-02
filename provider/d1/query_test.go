package d1

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	pgo "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"
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
