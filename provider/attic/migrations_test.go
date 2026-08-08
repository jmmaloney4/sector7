package attic

import (
	"context"
	"reflect"
	"testing"

	"github.com/blang/semver"
	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"
	"github.com/pulumi/pulumi-go-provider/integration"
	"github.com/pulumi/pulumi/sdk/v3/go/property"
)

// liveCacheState mirrors attic/prod's `attic-cache-jmmaloney4-cache` (the
// dynamic.Resource child of the AtticCache ComponentResource) exactly, read
// off the stack rather than imagined:
//
//	pulumi stack export -C deploy/services/attic -s prod
//	  outputs: __provider, cacheName, deploymentName, hs256SecretBase64,
//	           isPublic, namespace, port, priority, publicKey,
//	           retentionPeriodSeconds, storeDir, upstreamCacheKeyNames
//
// kubeconfig is absent — it did not exist on the dynamic provider (added in
// sector7#359, after every live cache was already created), and it is
// `,optional` on CacheArgs, so its absence here is not an obstacle. hs256
// secret and publicKey values are placeholders; only the SHAPE matters for
// this test, and the real values are encrypted ciphertext in the export
// anyway.
//
// The URN this test uses for Diff calls is the NEW flat resource's own URN
// (no `$pulumi-nodejs:dynamic:Resource` nesting) — the engine resolves which
// prior state entry to diff against via the TypeScript-side alias BEFORE
// calling Diff, so by the time the provider sees the request it is always
// diffing against the plugin's own (unnested) URN, regardless of how deeply
// nested the state it matched against used to be. That nesting is a
// TypeScript alias concern (packages/sector7/attic/admin.ts), not something
// this migration or its tests need to encode.
func liveCacheState() property.Map {
	return property.NewMap(map[string]property.Value{
		"namespace":              property.New("attic-prod"),
		"hs256SecretBase64":      property.New("c2VjcmV0LWJhc2U2NA=="),
		"deploymentName":         property.New("attic"),
		"port":                   property.New(8080.0),
		"cacheName":              property.New("jmmaloney4"),
		"isPublic":               property.New(true),
		"priority":               property.New(0.0),
		"storeDir":               property.New("/nix/store"),
		"upstreamCacheKeyNames":  property.New([]property.Value{}),
		"retentionPeriodSeconds": property.New(7776000.0),
		"publicKey":              property.New("jmmaloney4:URPxyEP2mpmt258ZARk35bnkJtt7efjgv62LAP9Y3bA="),
		"__provider":             property.New("exports.handler = __f0; ... closure"),
	})
}

func newCacheInputs() property.Map {
	return liveCacheState().Delete("__provider", "publicKey")
}

// liveTokenState mirrors attic/prod's `attic-host-token-itachi-token`
// exactly, read off the stack the same way as liveCacheState above.
func liveTokenState() property.Map {
	return property.NewMap(map[string]property.Value{
		"hs256SecretBase64": property.New("c2VjcmV0LWJhc2U2NA=="),
		"sub":               property.New("host-itachi-jmmaloney4"),
		"validitySeconds":   property.New(31536000.0),
		"caches": property.New(property.NewMap(map[string]property.Value{
			"jmmaloney4": property.New(property.NewMap(map[string]property.Value{
				"pull": property.New(true),
				"push": property.New(true),
			})),
		})),
		"token":      property.New("eyJhbGciOiJIUzI1NiJ9.fake.signature"),
		"expiresAt":  property.New(1813159693.0),
		"notBefore":  property.New(1781623693.0),
		"__provider": property.New("exports.handler = __f0; var __provider = {check: __f1, ...}; ... closure"),
	})
}

func newTokenInputs() property.Map {
	return liveTokenState().Delete("__provider", "token", "expiresAt", "notBefore")
}

func testServer(t *testing.T) integration.Server {
	t.Helper()
	prov, err := infer.NewProviderBuilder().
		WithNamespace("jmmaloney4").
		WithResources(infer.Resource(Cache{}), infer.Resource(Token{})).
		Build()
	if err != nil {
		t.Fatal(err)
	}
	srv, err := integration.NewServer(context.Background(), "sector7",
		semver.MustParse("0.21.0"), integration.WithProvider(prov))
	if err != nil {
		t.Fatal(err)
	}
	return srv
}

// Cache/Token.Annotate (cache.go, token_resource.go) override the
// package-derived token to "sector7:atticprovider:{Cache,Token}", precisely
// to avoid colliding with the OLD ComponentResource's own
// "sector7:attic:{Cache,Token}" token — see those methods for why. These
// URNs use the overridden token accordingly.
const (
	cacheURN = "urn:pulumi:prod::attic::sector7:atticprovider:Cache::attic-cache-jmmaloney4"
	tokenURN = "urn:pulumi:prod::attic::sector7:atticprovider:Token::attic-host-token-itachi"
)

// THE migration gate for Cache: the exact call the engine makes during the
// alias retype. Must succeed and report no changes, or the cutover fails at
// preview instead of diffing to nothing.
//
// Without the migration this fails with
// `Unrecognized field '__provider' on 'attic.CacheState'`.
func TestCacheDiffAcceptsLiveDynamicProviderState(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "jmmaloney4",
		Urn:    cacheURN,
		State:  liveCacheState(),
		Inputs: newCacheInputs(),
	})
	if err != nil {
		t.Fatalf("Diff must accept live dynamic-provider state: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("retype must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// Dropping __provider is the ONLY thing the migration may do. A genuine
// config change must still plan a change.
func TestCacheRealChangeSurvivesTheMigration(t *testing.T) {
	srv := testServer(t)

	inputs := newCacheInputs().Set("isPublic", property.New(false))

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "jmmaloney4",
		Urn:    cacheURN,
		State:  liveCacheState(),
		Inputs: inputs,
	})
	if err != nil {
		t.Fatalf("edited inputs must decode: %v", err)
	}
	if !resp.HasChanges {
		t.Fatal("a real config change must plan a change, not be swallowed by the migration")
	}
}

// State that never passed through the dynamic provider has no __provider and
// must decode by the normal path, proving the migration is additive-safe.
func TestCachePluginNativeStateStillDecodes(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "jmmaloney4",
		Urn:    cacheURN,
		State:  liveCacheState().Delete("__provider"),
		Inputs: newCacheInputs(),
	})
	if err != nil {
		t.Fatalf("plugin-native state must decode without a migration: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("unchanged plugin-native state must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// THE migration gate for Token: the exact call the engine makes during the
// alias retype. Must succeed and report no changes, or the cutover fails at
// preview instead of diffing to nothing.
//
// Without the migration this fails with
// `Unrecognized field '__provider' on 'attic.TokenState'`.
func TestTokenDiffAcceptsLiveDynamicProviderState(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "host-itachi-jmmaloney4",
		Urn:    tokenURN,
		State:  liveTokenState(),
		Inputs: newTokenInputs(),
	})
	if err != nil {
		t.Fatalf("Diff must accept live dynamic-provider state: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("retype must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// Dropping __provider is the ONLY thing the migration may do. A genuine
// change (here: caches grant) must still plan a change — this token is a
// stateless JWT, so a real change means minting a new one (a replacement),
// and it must not be swallowed by the migration.
func TestTokenRealChangeSurvivesTheMigration(t *testing.T) {
	srv := testServer(t)

	inputs := newTokenInputs().Set("validitySeconds", property.New(86400.0))

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "host-itachi-jmmaloney4",
		Urn:    tokenURN,
		State:  liveTokenState(),
		Inputs: inputs,
	})
	if err != nil {
		t.Fatalf("edited inputs must decode: %v", err)
	}
	if !resp.HasChanges {
		t.Fatal("a real validity change must plan a change, not be swallowed by the migration")
	}
}

// State that never passed through the dynamic provider has no __provider and
// must decode by the normal path, proving the migration is additive-safe.
func TestTokenPluginNativeStateStillDecodes(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "host-itachi-jmmaloney4",
		Urn:    tokenURN,
		State:  liveTokenState().Delete("__provider"),
		Inputs: newTokenInputs(),
	})
	if err != nil {
		t.Fatalf("plugin-native state must decode without a migration: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("unchanged plugin-native state must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// Same guard as d1/onepassword/matrix/r2's. infer runs migrations BEFORE the
// normal decode and skips a migrator only when decoding into its old shape
// FAILS, so `,optional` here would make {cache,token}StateV0 match
// plugin-native state too and route every read through the migration —
// permanently, not just for legacy state.
func TestProviderTagIsRequiredSoTheMigrationOnlyMatchesLegacyState(t *testing.T) {
	t.Run("Cache", func(t *testing.T) {
		f, ok := reflect.TypeOf(cacheStateV0{}).FieldByName("Provider")
		if !ok {
			t.Fatal("cacheStateV0.Provider is gone; if the field was renamed, update this guard rather than deleting it")
		}
		if tag := f.Tag.Get("pulumi"); tag != "__provider" {
			t.Fatalf("cacheStateV0.Provider must be tagged exactly `pulumi:\"__provider\"`, got %q.", tag)
		}
	})
	t.Run("Token", func(t *testing.T) {
		f, ok := reflect.TypeOf(tokenStateV0{}).FieldByName("Provider")
		if !ok {
			t.Fatal("tokenStateV0.Provider is gone; if the field was renamed, update this guard rather than deleting it")
		}
		if tag := f.Tag.Get("pulumi"); tag != "__provider" {
			t.Fatalf("tokenStateV0.Provider must be tagged exactly `pulumi:\"__provider\"`, got %q.", tag)
		}
	})
}
