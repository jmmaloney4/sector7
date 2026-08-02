package attic

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/internal/diffutil"
)

// Token is an Attic access token: a signed, stateless HS256 JWT.
//
// It contacts nothing. Minting is entirely local from the server's HS256
// secret, which is also why Delete is a no-op — there is no server-side record
// to remove.
type Token struct{}

type TokenArgs struct {
	HS256SecretBase64 string `pulumi:"hs256SecretBase64" provider:"secret"`
	Sub               string `pulumi:"sub"`
	// ValiditySeconds is stored already parsed, matching the dynamic provider's
	// state. The TypeScript wrapper parses the public `validity` (e.g. "1y")
	// before it reaches here, which is what makes Diff compare parsed seconds
	// rather than raw strings — so "1y" and "365d" are not a spurious replace.
	ValiditySeconds int                             `pulumi:"validitySeconds"`
	Caches          map[string]CachePermissionFlags `pulumi:"caches"`
}

type TokenState struct {
	TokenArgs
	Token     string `pulumi:"token" provider:"secret"`
	ExpiresAt int64  `pulumi:"expiresAt"`
	NotBefore int64  `pulumi:"notBefore"`
}

func (Token) Check(ctx context.Context, req infer.CheckRequest) (infer.CheckResponse[TokenArgs], error) {
	args, failures, err := infer.DefaultCheck[TokenArgs](ctx, req.NewInputs)
	if err != nil {
		return infer.CheckResponse[TokenArgs]{Inputs: args, Failures: failures}, err
	}
	if args.HS256SecretBase64 == "" {
		failures = append(failures, p.CheckFailure{Property: "hs256SecretBase64", Reason: "hs256SecretBase64 is required"})
	}
	if args.Sub == "" {
		failures = append(failures, p.CheckFailure{Property: "sub", Reason: "sub is required"})
	}
	if args.ValiditySeconds <= 0 {
		// A zero or negative validity mints an immediately-dead token.
		failures = append(failures, p.CheckFailure{Property: "validitySeconds", Reason: "validitySeconds must be positive"})
	}
	return infer.CheckResponse[TokenArgs]{Inputs: args, Failures: failures}, nil
}

// Diff: a signed JWT is immutable, so any change to a claim input mints a new
// token and is therefore a replacement.
//
// The baked token/exp/nbf live in state rather than inputs, which is what stops
// a no-op `up` from churning the token — and churning it would invalidate the
// copy every consumer already holds.
func (Token) Diff(_ context.Context, req infer.DiffRequest[TokenArgs, TokenState]) (p.DiffResponse, error) {
	olds, news := req.State, req.Inputs
	diffs := map[string]p.PropertyDiff{}

	if olds.HS256SecretBase64 != news.HS256SecretBase64 {
		diffs["hs256SecretBase64"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	if olds.Sub != news.Sub {
		diffs["sub"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	if olds.ValiditySeconds != news.ValiditySeconds {
		diffs["validitySeconds"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	if !cachesEqual(olds.Caches, news.Caches) {
		diffs["caches"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}

	return p.DiffResponse{
		HasChanges:          len(diffs) > 0,
		DetailedDiff:        diffs,
		DeleteBeforeReplace: false,
	}, nil
}

func cachesEqual(a, b map[string]CachePermissionFlags) bool {
	return diffutil.StableJSON(a) == diffutil.StableJSON(b)
}

func (Token) Create(ctx context.Context, req infer.CreateRequest[TokenArgs]) (infer.CreateResponse[TokenState], error) {
	out := infer.CreateResponse[TokenState]{Output: TokenState{TokenArgs: req.Inputs}}
	if req.DryRun {
		return out, nil
	}

	now := time.Now().Unix()
	expires := now + int64(req.Inputs.ValiditySeconds)
	token, err := MintToken(MintArgs{
		SecretBase64:     req.Inputs.HS256SecretBase64,
		Sub:              req.Inputs.Sub,
		IssuedAtSeconds:  now,
		ExpiresAtSeconds: expires,
		Caches:           req.Inputs.Caches,
	})
	if err != nil {
		return out, err
	}

	id, err := opaqueID()
	if err != nil {
		return out, err
	}
	// The resource id is a random opaque handle — NEVER the token, which is a
	// bearer credential and would otherwise sit in plaintext in Pulumi state.
	out.ID = id
	out.Output = TokenState{TokenArgs: req.Inputs, Token: token, ExpiresAt: expires, NotBefore: now}
	return out, nil
}

// Update is reached only if Diff ever reports a non-replace change, which it
// does not today. Re-mint defensively so outputs stay consistent with inputs.
func (Token) Update(ctx context.Context, req infer.UpdateRequest[TokenArgs, TokenState]) (infer.UpdateResponse[TokenState], error) {
	out := infer.UpdateResponse[TokenState]{Output: TokenState{TokenArgs: req.Inputs}}
	if req.DryRun {
		return out, nil
	}
	now := time.Now().Unix()
	expires := now + int64(req.Inputs.ValiditySeconds)
	token, err := MintToken(MintArgs{
		SecretBase64:     req.Inputs.HS256SecretBase64,
		Sub:              req.Inputs.Sub,
		IssuedAtSeconds:  now,
		ExpiresAtSeconds: expires,
		Caches:           req.Inputs.Caches,
	})
	if err != nil {
		return out, err
	}
	out.Output = TokenState{TokenArgs: req.Inputs, Token: token, ExpiresAt: expires, NotBefore: now}
	return out, nil
}

// Delete is a no-op. Attic tokens are stateless JWTs with no server-side record
// to remove; a token is invalidated only by its exp lapsing or by rotating the
// shared HS256 secret (which invalidates every token). Dropping the resource
// stops Pulumi re-issuing it — it cannot revoke a live token.
func (Token) Delete(context.Context, infer.DeleteRequest[TokenState]) (infer.DeleteResponse, error) {
	return infer.DeleteResponse{}, nil
}

func opaqueID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("sector7: generating token id: %w", err)
	}
	return hex.EncodeToString(b[:]), nil
}
