package attic

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/internal/diffutil"
	"github.com/jmmaloney4/sector7/provider/internal/httpx"
	"github.com/jmmaloney4/sector7/provider/internal/kube"
)

const (
	defaultDeployment = "attic"
	defaultPort       = 8080
	defaultStoreDir   = "/nix/store"
)

// Least-privilege admin token scopes, minted per operation. The token is
// self-contained (no server contact) and scoped to the single cache being
// operated on.
var (
	adminCreateFlags = CachePermissionFlags{Pull: true, CreateCache: true, ConfigureCache: true, ConfigureCacheRetention: true}
	adminUpdateFlags = CachePermissionFlags{Pull: true, ConfigureCache: true, ConfigureCacheRetention: true}
	adminDeleteFlags = CachePermissionFlags{Pull: true, DestroyCache: true}
)

// Cache is an Attic binary cache, administered through the cache-config API
// reached by in-cluster port-forward.
type Cache struct {
	Transport kube.Transport
}

type CacheArgs struct {
	Namespace string `pulumi:"namespace"`
	// HS256SecretBase64 is the server's signing secret; admin tokens are minted
	// from it locally.
	HS256SecretBase64     string   `pulumi:"hs256SecretBase64" provider:"secret"`
	DeploymentName        string   `pulumi:"deploymentName,optional"`
	Port                  int      `pulumi:"port,optional"`
	CacheName             string   `pulumi:"cacheName"`
	IsPublic              bool     `pulumi:"isPublic,optional"`
	Priority              int      `pulumi:"priority,optional"`
	StoreDir              string   `pulumi:"storeDir,optional"`
	UpstreamCacheKeyNames []string `pulumi:"upstreamCacheKeyNames,optional"`
	// RetentionPeriodSeconds unset means the server default ("Global").
	RetentionPeriodSeconds *int `pulumi:"retentionPeriodSeconds,optional"`
}

type CacheState struct {
	CacheArgs
	// PublicKey is the NAR-signing key, read back from the cache config. Every
	// client's trusted-public-keys depends on it, which is why adoption must
	// never regenerate the keypair.
	PublicKey string `pulumi:"publicKey"`
}

func (a *CacheArgs) Annotate(ann infer.Annotator) {
	ann.SetDefault(&a.DeploymentName, defaultDeployment)
	ann.SetDefault(&a.Port, defaultPort)
	ann.SetDefault(&a.StoreDir, defaultStoreDir)
	ann.SetDefault(&a.IsPublic, true)
}

func (Cache) Check(ctx context.Context, req infer.CheckRequest) (infer.CheckResponse[CacheArgs], error) {
	args, failures, err := infer.DefaultCheck[CacheArgs](ctx, req.NewInputs)
	if err != nil {
		return infer.CheckResponse[CacheArgs]{Inputs: args, Failures: failures}, err
	}
	fail := func(prop, reason string) {
		failures = append(failures, p.CheckFailure{Property: prop, Reason: reason})
	}
	if args.Namespace == "" {
		fail("namespace", "namespace is required")
	}
	if args.HS256SecretBase64 == "" {
		fail("hs256SecretBase64", "hs256SecretBase64 is required")
	}
	if args.CacheName == "" {
		fail("cacheName", "cacheName is required")
	}
	if args.RetentionPeriodSeconds != nil && *args.RetentionPeriodSeconds <= 0 {
		fail("retentionPeriodSeconds", "retentionPeriodSeconds must be a positive number of seconds")
	}
	return infer.CheckResponse[CacheArgs]{Inputs: args, Failures: failures}, nil
}

func (Cache) Diff(_ context.Context, req infer.DiffRequest[CacheArgs, CacheState]) (p.DiffResponse, error) {
	olds, news := req.State, req.Inputs
	diffs := map[string]p.PropertyDiff{}

	// Renaming a cache or changing its store dir is a different cache.
	if olds.CacheName != news.CacheName {
		diffs["cacheName"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	if olds.StoreDir != news.StoreDir {
		diffs["storeDir"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}

	// An admin-target change does not alter the remote cache, but must flow into
	// state so a later update/delete targets the new deployment and mints under
	// the new secret.
	if olds.Namespace != news.Namespace ||
		olds.DeploymentName != news.DeploymentName ||
		olds.Port != news.Port ||
		olds.HS256SecretBase64 != news.HS256SecretBase64 {
		diffs["adminTarget"] = p.PropertyDiff{Kind: p.Update}
	}
	if olds.IsPublic != news.IsPublic {
		diffs["isPublic"] = p.PropertyDiff{Kind: p.Update}
	}
	if olds.Priority != news.Priority {
		diffs["priority"] = p.PropertyDiff{Kind: p.Update}
	}
	if !diffutil.StringsEqual(olds.UpstreamCacheKeyNames, news.UpstreamCacheKeyNames) {
		diffs["upstreamCacheKeyNames"] = p.PropertyDiff{Kind: p.Update}
	}
	if !intPtrEqual(olds.RetentionPeriodSeconds, news.RetentionPeriodSeconds) {
		diffs["retentionPeriodSeconds"] = p.PropertyDiff{Kind: p.Update}
	}

	return p.DiffResponse{
		HasChanges:          len(diffs) > 0,
		DetailedDiff:        diffs,
		DeleteBeforeReplace: false,
	}, nil
}

func intPtrEqual(a, b *int) bool {
	switch {
	case a == nil && b == nil:
		return true
	case a == nil || b == nil:
		return false
	default:
		return *a == *b
	}
}

// RetentionPeriod renders the optional retention into Attic's
// RetentionPeriodConfig wire form.
func RetentionPeriod(seconds *int) any {
	if seconds == nil {
		return "Global"
	}
	return map[string]any{"Period": *seconds}
}

func buildPatchBody(a CacheArgs) map[string]any {
	// Deliberately omits keypair (never rotate) and store_dir (immutable in this
	// model — a change is a replacement), so adoption preserves the existing
	// signing key and therefore every client's trusted-public-keys.
	return map[string]any{
		"is_public":                a.IsPublic,
		"priority":                 a.Priority,
		"upstream_cache_key_names": orEmpty(a.UpstreamCacheKeyNames),
		"retention_period":         RetentionPeriod(a.RetentionPeriodSeconds),
	}
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func (c Cache) connect(ctx context.Context, a CacheArgs, flags CachePermissionFlags) (*httpx.Client, func(), error) {
	now := time.Now().Unix()
	token, err := MintToken(MintArgs{
		SecretBase64:     a.HS256SecretBase64,
		Sub:              "sector7-provider",
		IssuedAtSeconds:  now,
		ExpiresAtSeconds: now + 300, // short-lived; this is an admin credential
		Caches:           map[string]CachePermissionFlags{a.CacheName: flags},
	})
	if err != nil {
		return nil, nil, err
	}

	conn, err := c.Transport.Connect(ctx, kube.Target{
		Namespace:  a.Namespace,
		Deployment: a.DeploymentName,
		Port:       a.Port,
	})
	if err != nil {
		return nil, nil, err
	}
	return &httpx.Client{
		BaseURL: conn.BaseURL,
		Bearer:  token,
		// Attic validates the Host header against its allowed-hosts config, so
		// the in-cluster Service FQDN must be sent even though the connection is
		// to 127.0.0.1. Node's fetch treats Host as forbidden and silently drops
		// it, which is why the TypeScript had to drop to node:http; Go's
		// net/http honours req.Host, so that workaround disappears.
		Host:       conn.Host,
		HTTP:       &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 30 * time.Second},
		MaxRetries: 3,
	}, conn.Close, nil
}

func (c Cache) readPublicKey(ctx context.Context, cl *httpx.Client, cacheName string) (string, error) {
	var config map[string]any
	path := "/_api/v1/cache-config/" + cacheName
	if err := cl.Do(ctx, "GET", path, nil, &config, true); err != nil {
		return "", err
	}
	// Fail fast on a missing key: silently returning "" would persist an
	// unusable signing key in state and hide a broken or incompatible Attic API.
	key, _ := config["public_key"].(string)
	if key == "" {
		return "", fmt.Errorf("sector7: Attic GET %s returned no public_key — cannot resolve the cache signing key", path)
	}
	return key, nil
}

func (c Cache) Create(ctx context.Context, req infer.CreateRequest[CacheArgs]) (infer.CreateResponse[CacheState], error) {
	out := infer.CreateResponse[CacheState]{Output: CacheState{CacheArgs: req.Inputs}}
	if req.DryRun {
		return out, nil
	}
	a := req.Inputs

	cl, done, err := c.connect(ctx, a, adminCreateFlags)
	if err != nil {
		return out, err
	}
	defer done()

	path := "/_api/v1/cache-config/" + a.CacheName
	createBody := map[string]any{
		"keypair":                  "Generate",
		"is_public":                a.IsPublic,
		"store_dir":                a.StoreDir,
		"priority":                 a.Priority,
		"upstream_cache_key_names": orEmpty(a.UpstreamCacheKeyNames),
	}

	// Never retried: a retried create after a timeout that actually succeeded
	// would hit the CacheAlreadyExists path and adopt a cache we just made,
	// which is harmless — but the create itself is not idempotent server-side.
	err = cl.Do(ctx, "POST", path, createBody, nil, false)
	switch {
	case err == nil:
		// Created fresh. CreateCacheRequest has no retention field, so a
		// requested retention needs a follow-up PATCH.
		if a.RetentionPeriodSeconds != nil {
			body := map[string]any{"retention_period": RetentionPeriod(a.RetentionPeriodSeconds)}
			if err := cl.Do(ctx, "PATCH", path, body, nil, true); err != nil {
				return out, err
			}
		}

	case isCacheAlreadyExists(err):
		// Idempotent adoption: reconcile the existing cache's config in place.
		// POST is create-only, so going through PATCH preserves the keypair —
		// and therefore every client's trusted-public-keys.
		//
		// First verify the immutable store_dir matches. buildPatchBody omits
		// store_dir (a change is modelled as a replacement), so adopting a
		// same-named cache pointing at a different store dir would silently
		// record the desired storeDir in state while the remote kept its own.
		//
		// Fail CLOSED: if the GET does not report a string store_dir we cannot
		// confirm the immutable field, so refuse rather than adopt an unverified
		// cache and record an assumed storeDir.
		var existing map[string]any
		if err := cl.Do(ctx, "GET", path, nil, &existing, true); err != nil {
			return out, err
		}
		storeDir, ok := existing["store_dir"].(string)
		if !ok || storeDir != a.StoreDir {
			return out, fmt.Errorf(
				"sector7: Attic cache %q already exists but its store_dir (%v) is absent or differs from the requested %q. "+
					"store_dir is immutable — refusing to adopt; align storeDir or choose a different cacheName",
				a.CacheName, existing["store_dir"], a.StoreDir)
		}
		if err := cl.Do(ctx, "PATCH", path, buildPatchBody(a), nil, true); err != nil {
			return out, err
		}

	default:
		return out, err
	}

	key, err := c.readPublicKey(ctx, cl, a.CacheName)
	if err != nil {
		return out, err
	}
	out.ID = a.CacheName
	out.Output = CacheState{CacheArgs: a, PublicKey: key}
	return out, nil
}

// isCacheAlreadyExists recognises Attic's create-collision response: a 400
// whose body names CacheAlreadyExists.
func isCacheAlreadyExists(err error) bool {
	e, ok := err.(*httpx.Error)
	return ok && e.Status == http.StatusBadRequest && strings.Contains(e.Body, "CacheAlreadyExists")
}

func (c Cache) Update(ctx context.Context, req infer.UpdateRequest[CacheArgs, CacheState]) (infer.UpdateResponse[CacheState], error) {
	out := infer.UpdateResponse[CacheState]{Output: CacheState{CacheArgs: req.Inputs, PublicKey: req.State.PublicKey}}
	if req.DryRun {
		return out, nil
	}
	a := req.Inputs

	cl, done, err := c.connect(ctx, a, adminUpdateFlags)
	if err != nil {
		return out, err
	}
	defer done()

	path := "/_api/v1/cache-config/" + a.CacheName
	if err := cl.Do(ctx, "PATCH", path, buildPatchBody(a), nil, true); err != nil {
		return out, err
	}
	key, err := c.readPublicKey(ctx, cl, a.CacheName)
	if err != nil {
		return out, err
	}
	out.Output.PublicKey = key
	return out, nil
}

func (c Cache) Delete(ctx context.Context, req infer.DeleteRequest[CacheState]) (infer.DeleteResponse, error) {
	name := req.ID
	if name == "" {
		name = req.State.CacheName
	}
	if name == "" {
		return infer.DeleteResponse{}, nil
	}

	cl, done, err := c.connect(ctx, req.State.CacheArgs, adminDeleteFlags)
	if err != nil {
		return infer.DeleteResponse{}, err
	}
	defer done()

	err = cl.Do(ctx, "DELETE", "/_api/v1/cache-config/"+name, nil, nil, true)
	if err != nil {
		// Idempotent delete: a cache already removed out of band means the
		// desired end state is reached, so do not fail destroy or a replacement.
		if e, ok := err.(*httpx.Error); ok && e.Status == http.StatusNotFound {
			return infer.DeleteResponse{}, nil
		}
		return infer.DeleteResponse{}, err
	}
	return infer.DeleteResponse{}, nil
}
