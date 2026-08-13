// Package r2 implements the sector7 provider's Cloudflare R2 and zone-cache
// resources. Ported from packages/sector7/r2/r2object.ts.
package r2

import (
	"context"
	"fmt"
	"net/http"
	"time"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/internal/checkutil"
	"github.com/jmmaloney4/sector7/provider/internal/diffutil"
	"github.com/jmmaloney4/sector7/provider/internal/httpx"
)

const apiBase = "https://api.cloudflare.com/client/v4"

// cloudflarePurgeLimit is the API's cap on files/hosts per purge request.
const cloudflarePurgeLimit = 30

// ZoneCachePurge purges a Cloudflare zone cache when its trigger changes.
type ZoneCachePurge struct {
	// BaseURL overrides the Cloudflare API endpoint. Tests only.
	BaseURL string
}

type ZoneCachePurgeArgs struct {
	ZoneID   string `pulumi:"zoneId"`
	APIToken string `pulumi:"apiToken" provider:"secret"`
	// Trigger is an opaque value — typically a content hash. Changing it
	// re-runs the purge.
	Trigger string   `pulumi:"trigger"`
	Files   []string `pulumi:"files,optional"`
	Hosts   []string `pulumi:"hosts,optional"`
}

type ZoneCachePurgeState struct {
	ZoneCachePurgeArgs
}

func (ZoneCachePurge) Check(ctx context.Context, req infer.CheckRequest) (infer.CheckResponse[ZoneCachePurgeArgs], error) {
	args, failures, err := infer.DefaultCheck[ZoneCachePurgeArgs](ctx, req.NewInputs)
	if err != nil {
		return infer.CheckResponse[ZoneCachePurgeArgs]{Inputs: args, Failures: failures}, err
	}
	fail := func(prop, reason string) {
		failures = append(failures, p.CheckFailure{Property: prop, Reason: reason})
	}

	checkutil.RequireNonEmpty(&failures,
		checkutil.NamedField{Name: "zoneId", Value: args.ZoneID},
		checkutil.NamedField{Name: "apiToken", Value: args.APIToken},
		checkutil.NamedField{Name: "trigger", Value: args.Trigger},
	)

	// An explicitly empty list is rejected rather than silently treated as
	// "purge everything" — that would be a destructive surprise. Omit the
	// property to purge the whole zone.
	check := func(name string, vals []string, kind string) {
		if vals == nil {
			return
		}
		if len(vals) == 0 {
			fail(name, name+" must not be empty — omit the property to purge the entire zone")
			return
		}
		if len(vals) > cloudflarePurgeLimit {
			fail(name, fmt.Sprintf("%s must not exceed %d items (Cloudflare API limit)", name, cloudflarePurgeLimit))
		}
		for _, v := range vals {
			if v == "" {
				fail(name, fmt.Sprintf("%s must be an array of non-empty %s strings", name, kind))
				return
			}
		}
	}
	check("files", args.Files, "URL")
	check("hosts", args.Hosts, "hostname")

	if len(args.Files) > 0 && len(args.Hosts) > 0 {
		fail("files", "files and hosts are mutually exclusive — specify at most one")
	}

	return infer.CheckResponse[ZoneCachePurgeArgs]{Inputs: args, Failures: failures}, nil
}

func (ZoneCachePurge) Diff(_ context.Context, req infer.DiffRequest[ZoneCachePurgeArgs, ZoneCachePurgeState]) (p.DiffResponse, error) {
	olds, news := req.State, req.Inputs
	diffs := map[string]p.PropertyDiff{}

	if olds.ZoneID != news.ZoneID {
		diffs["zoneId"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	if olds.Trigger != news.Trigger {
		diffs["trigger"] = p.PropertyDiff{Kind: p.Update}
	}
	if olds.APIToken != news.APIToken {
		diffs["apiToken"] = p.PropertyDiff{Kind: p.Update}
	}
	// nil and [] compare equal, matching the `?? []` normalisation.
	if !diffutil.StringsEqual(olds.Files, news.Files) {
		diffs["files"] = p.PropertyDiff{Kind: p.Update}
	}
	if !diffutil.StringsEqual(olds.Hosts, news.Hosts) {
		diffs["hosts"] = p.PropertyDiff{Kind: p.Update}
	}

	return p.DiffResponse{HasChanges: len(diffs) > 0, DetailedDiff: diffs}, nil
}

// PurgeBody selects the purge scope. hosts wins over files, and an absence of
// both purges the entire zone.
func PurgeBody(files, hosts []string) map[string]any {
	switch {
	case len(hosts) > 0:
		return map[string]any{"hosts": hosts}
	case len(files) > 0:
		return map[string]any{"files": files}
	default:
		return map[string]any{"purge_everything": true}
	}
}

func (z ZoneCachePurge) purge(ctx context.Context, a ZoneCachePurgeArgs) error {
	base := z.BaseURL
	if base == "" {
		base = apiBase
	}
	c := &httpx.Client{
		BaseURL:    base,
		Bearer:     a.APIToken,
		HTTP:       &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 60 * time.Second},
		MaxRetries: 3,
	}
	// Purging is idempotent, so retrying a lost response is safe.
	return c.Do(ctx, "POST", "/zones/"+a.ZoneID+"/purge_cache", PurgeBody(a.Files, a.Hosts), nil, true)
}

// PurgeID builds the resource id. The trigger is truncated for readability.
//
// Truncation is by RUNE, not byte: JS slice(0,12) counts UTF-16 code units, and
// naive Go byte slicing would split a multibyte character and produce invalid
// UTF-8 in a resource id. Triggers are content hashes in practice, but the id
// must not be corruptible by an unusual one.
func PurgeID(zoneID, trigger string) string {
	r := []rune(trigger)
	if len(r) > 12 {
		r = r[:12]
	}
	return fmt.Sprintf("purge-%s-%s", zoneID, string(r))
}

func (z ZoneCachePurge) Create(ctx context.Context, req infer.CreateRequest[ZoneCachePurgeArgs]) (infer.CreateResponse[ZoneCachePurgeState], error) {
	out := infer.CreateResponse[ZoneCachePurgeState]{Output: ZoneCachePurgeState{ZoneCachePurgeArgs: req.Inputs}}
	if req.DryRun {
		return out, nil
	}
	if err := z.purge(ctx, req.Inputs); err != nil {
		return out, err
	}
	out.ID = PurgeID(req.Inputs.ZoneID, req.Inputs.Trigger)
	return out, nil
}

func (z ZoneCachePurge) Update(ctx context.Context, req infer.UpdateRequest[ZoneCachePurgeArgs, ZoneCachePurgeState]) (infer.UpdateResponse[ZoneCachePurgeState], error) {
	out := infer.UpdateResponse[ZoneCachePurgeState]{Output: ZoneCachePurgeState{ZoneCachePurgeArgs: req.Inputs}}
	if req.DryRun {
		return out, nil
	}
	if err := z.purge(ctx, req.Inputs); err != nil {
		return out, err
	}
	return out, nil
}

// Delete is a no-op: purging a cache because a resource was removed serves no
// purpose.
func (ZoneCachePurge) Delete(context.Context, infer.DeleteRequest[ZoneCachePurgeState]) (infer.DeleteResponse, error) {
	return infer.DeleteResponse{}, nil
}
