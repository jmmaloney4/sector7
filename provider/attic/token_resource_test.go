package attic

import (
	"encoding/base64"
	"testing"

	pgo "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"
)

func baseTokenArgs() TokenArgs {
	return TokenArgs{
		HS256SecretBase64: base64.StdEncoding.EncodeToString([]byte("k")),
		Sub:               "host-bellatrix",
		ValiditySeconds:   31536000,
		Caches:            map[string]CachePermissionFlags{"org-cache": {Pull: true}},
	}
}

// The id must never be the token. Pulumi stores resource ids in PLAINTEXT, so
// using a bearer credential as the id would leak it into state and into every
// `pulumi stack export`.
func TestCreateIdIsOpaqueNeverTheToken(t *testing.T) {
	resp, err := Token{}.Create(t.Context(), infer.CreateRequest[TokenArgs]{Inputs: baseTokenArgs()})
	if err != nil {
		t.Fatal(err)
	}
	if resp.ID == "" {
		t.Fatal("expected an opaque id")
	}
	if resp.ID == resp.Output.Token {
		t.Fatal("the resource id must NEVER be the token — ids are plaintext in state")
	}
	if resp.Output.ExpiresAt-resp.Output.NotBefore != 31536000 {
		t.Fatalf("exp-nbf should equal validitySeconds; got %d", resp.Output.ExpiresAt-resp.Output.NotBefore)
	}
}

// Every claim-affecting change replaces, because a signed JWT is immutable.
// Equally important: nothing else does, or 13 host tokens churn.
func TestTokenDiffReplacesOnClaimInputsOnly(t *testing.T) {
	old := TokenState{TokenArgs: baseTokenArgs(), Token: "t", ExpiresAt: 2, NotBefore: 1}

	for name, mutate := range map[string]func(*TokenArgs){
		"hs256SecretBase64": func(a *TokenArgs) { a.HS256SecretBase64 = base64.StdEncoding.EncodeToString([]byte("other")) },
		"sub":               func(a *TokenArgs) { a.Sub = "other" },
		"validitySeconds":   func(a *TokenArgs) { a.ValiditySeconds = 100 },
		"caches":            func(a *TokenArgs) { a.Caches = map[string]CachePermissionFlags{"org-cache": {Pull: true, Push: true}} },
	} {
		news := baseTokenArgs()
		mutate(&news)
		r, _ := Token{}.Diff(t.Context(), infer.DiffRequest[TokenArgs, TokenState]{State: old, Inputs: news})
		if r.DetailedDiff[name].Kind != pgo.UpdateReplace {
			t.Fatalf("%s must force replacement; got %+v", name, r.DetailedDiff)
		}
	}

	// Identical inputs must be a no-op — the baked token/exp/nbf live in state,
	// so a plain `up` must not re-mint and invalidate every consumer's copy.
	r, _ := Token{}.Diff(t.Context(), infer.DiffRequest[TokenArgs, TokenState]{State: old, Inputs: baseTokenArgs()})
	if r.HasChanges {
		t.Fatalf("an unchanged token must not churn; got %+v", r.DetailedDiff)
	}
}

func TestDeleteIsANoOp(t *testing.T) {
	// A stateless JWT has no server-side record; destroy must not fail trying.
	if _, err := (Token{}).Delete(t.Context(), infer.DeleteRequest[TokenState]{ID: "x"}); err != nil {
		t.Fatal(err)
	}
}
