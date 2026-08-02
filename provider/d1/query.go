// Package d1 implements the sector7 provider's Cloudflare D1 resources.
// Ported from packages/sector7/d1/d1-query.ts.
package d1

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/internal/httpx"
)

const apiBase = "https://api.cloudflare.com/client/v4"

// Query executes SQL against a Cloudflare D1 database.
//
// Unlike the other sector7 resources this talks to a public API, so it needs no
// port-forward transport.
type Query struct {
	// BaseURL overrides the Cloudflare API endpoint. Tests only.
	BaseURL string
}

type QueryArgs struct {
	AccountID  string `pulumi:"accountId"`
	DatabaseID string `pulumi:"databaseId"`
	SQL        string `pulumi:"sql"`
	APIToken   string `pulumi:"apiToken" provider:"secret"`
}

type QueryState struct {
	QueryArgs
	// SQLHash is the SHA-256 of the SQL last executed, used to detect changes
	// between runs.
	SQLHash string `pulumi:"sqlHash"`
}

func (Query) Check(ctx context.Context, req infer.CheckRequest) (infer.CheckResponse[QueryArgs], error) {
	args, failures, err := infer.DefaultCheck[QueryArgs](ctx, req.NewInputs)
	if err != nil {
		return infer.CheckResponse[QueryArgs]{Inputs: args, Failures: failures}, err
	}
	if strings.TrimSpace(args.SQL) == "" {
		failures = append(failures, p.CheckFailure{Property: "sql", Reason: "SQL must be a non-empty string"})
	}
	for _, f := range []struct{ name, val string }{
		{"accountId", args.AccountID},
		{"databaseId", args.DatabaseID},
		{"apiToken", args.APIToken},
	} {
		if f.val == "" {
			failures = append(failures, p.CheckFailure{Property: f.name, Reason: f.name + " is required"})
		}
	}
	return infer.CheckResponse[QueryArgs]{Inputs: args, Failures: failures}, nil
}

func (Query) Diff(_ context.Context, req infer.DiffRequest[QueryArgs, QueryState]) (p.DiffResponse, error) {
	olds, news := req.State, req.Inputs
	diffs := map[string]p.PropertyDiff{}

	// Changing the target database, or the SQL itself, means a different
	// statement to run — replacement re-executes it.
	if olds.AccountID != news.AccountID {
		diffs["accountId"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	if olds.DatabaseID != news.DatabaseID {
		diffs["databaseId"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	if olds.SQL != news.SQL {
		diffs["sql"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	// A token rotation only changes the credential used, so it re-executes
	// in place rather than replacing.
	if olds.APIToken != news.APIToken {
		diffs["apiToken"] = p.PropertyDiff{Kind: p.Update}
	}

	replaces := 0
	for _, d := range diffs {
		if d.Kind == p.UpdateReplace {
			replaces++
		}
	}
	return p.DiffResponse{
		HasChanges:          len(diffs) > 0,
		DetailedDiff:        diffs,
		DeleteBeforeReplace: replaces > 0,
	}, nil
}

func (q Query) execute(ctx context.Context, a QueryArgs) error {
	base := q.BaseURL
	if base == "" {
		base = apiBase
	}
	c := &httpx.Client{
		BaseURL:    base,
		Bearer:     a.APIToken,
		HTTP:       &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 60 * time.Second},
		MaxRetries: 3,
	}

	var resp struct {
		Success bool `json:"success"`
		Errors  []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	path := fmt.Sprintf("/accounts/%s/d1/database/%s/query", a.AccountID, a.DatabaseID)
	// Not retried: the statement may not be idempotent. Callers use
	// CREATE TABLE IF NOT EXISTS style DDL, but that is a convention, not a
	// guarantee the provider can rely on.
	if err := c.Do(ctx, "POST", path, map[string]any{"sql": a.SQL}, &resp, false); err != nil {
		return err
	}
	// Cloudflare answers 200 with success:false for query-level failures, so a
	// 2xx is not sufficient.
	if !resp.Success {
		msgs := make([]string, 0, len(resp.Errors))
		for _, e := range resp.Errors {
			msgs = append(msgs, e.Message)
		}
		if len(msgs) == 0 {
			msgs = append(msgs, "unknown error")
		}
		return fmt.Errorf("sector7: D1 query failed: %s", strings.Join(msgs, "; "))
	}
	return nil
}

func sqlHash(sql string) string {
	sum := sha256.Sum256([]byte(sql))
	return hex.EncodeToString(sum[:])
}

func (q Query) Create(ctx context.Context, req infer.CreateRequest[QueryArgs]) (infer.CreateResponse[QueryState], error) {
	out := infer.CreateResponse[QueryState]{Output: QueryState{QueryArgs: req.Inputs}}
	if req.DryRun {
		return out, nil
	}
	if err := q.execute(ctx, req.Inputs); err != nil {
		return out, err
	}
	h := sqlHash(req.Inputs.SQL)
	out.ID = fmt.Sprintf("d1query:%s:%s", req.Inputs.DatabaseID, h[:12])
	out.Output = QueryState{QueryArgs: req.Inputs, SQLHash: h}
	return out, nil
}

func (q Query) Update(ctx context.Context, req infer.UpdateRequest[QueryArgs, QueryState]) (infer.UpdateResponse[QueryState], error) {
	out := infer.UpdateResponse[QueryState]{Output: QueryState{QueryArgs: req.Inputs, SQLHash: sqlHash(req.Inputs.SQL)}}
	if req.DryRun {
		return out, nil
	}
	if err := q.execute(ctx, req.Inputs); err != nil {
		return out, err
	}
	return out, nil
}

// Delete is a no-op: schema data persists after the resource is removed, and D1
// databases outlive individual Pulumi stacks. Dropping the resource stops
// Pulumi re-running the statement; it does not undo it.
func (Query) Delete(context.Context, infer.DeleteRequest[QueryState]) (infer.DeleteResponse, error) {
	return infer.DeleteResponse{}, nil
}
