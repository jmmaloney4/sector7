package attic

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func decodeSegment(t *testing.T, seg string) map[string]any {
	t.Helper()
	raw, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		t.Fatalf("segment is not base64url without padding: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("segment is not JSON: %v", err)
	}
	return out
}

// THE load-bearing property. Attic deserialises each permission value as an
// integer, not a boolean — atticadm emits {"r":1,"cc":1,…}. Emitting `true`
// makes Attic reject the WHOLE token with 401 because the permission claim
// fails to deserialise, silently breaking every minted token.
//
// This is asserted on the raw JSON text, not the decoded value, because
// encoding/json unmarshals both `1` and `true` into distinguishable Go types
// only if you look — the raw form is what Attic actually parses.
func TestPermissionValuesAreIntegersNotBooleans(t *testing.T) {
	tok, err := MintToken(MintArgs{
		SecretBase64: base64.StdEncoding.EncodeToString([]byte("supersecret")),
		Sub:          "ci", IssuedAtSeconds: 1000, ExpiresAtSeconds: 2000,
		Caches: map[string]CachePermissionFlags{
			"cache-a": {Pull: true, Push: true, CreateCache: true},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.Split(tok, ".")[1])
	if err != nil {
		t.Fatal(err)
	}
	payload := string(raw)
	for _, want := range []string{`"r":1`, `"w":1`, `"cc":1`} {
		if !strings.Contains(payload, want) {
			t.Fatalf("expected %s in payload, got %s", want, payload)
		}
	}
	if strings.Contains(payload, "true") || strings.Contains(payload, "false") {
		t.Fatalf("permission values must be integers, never booleans: %s", payload)
	}
	// Ungranted flags must be ABSENT, not 0 — absent means deny.
	for _, absent := range []string{`"d"`, `"cr"`, `"cq"`, `"cd"`} {
		if strings.Contains(payload, absent) {
			t.Fatalf("ungranted flag %s must be absent, got %s", absent, payload)
		}
	}
}

func TestTokenStructureAndSignature(t *testing.T) {
	secret := []byte("hs256-signing-secret")
	tok, err := MintToken(MintArgs{
		SecretBase64: base64.StdEncoding.EncodeToString(secret),
		Sub:          "github-actions-ci", IssuedAtSeconds: 1700000000, ExpiresAtSeconds: 1731536000,
		Caches: map[string]CachePermissionFlags{"org-cache": {Pull: true}},
	})
	if err != nil {
		t.Fatal(err)
	}

	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatalf("expected three JWT segments, got %d", len(parts))
	}
	if strings.ContainsAny(tok, "+/=") {
		t.Fatalf("segments must be base64url without padding: %s", tok)
	}

	header := decodeSegment(t, parts[0])
	if header["alg"] != "HS256" || header["typ"] != "JWT" {
		t.Fatalf("unexpected header: %v", header)
	}

	payload := decodeSegment(t, parts[1])
	if payload["sub"] != "github-actions-ci" {
		t.Fatalf("sub: %v", payload["sub"])
	}
	if payload["nbf"].(float64) != 1700000000 || payload["exp"].(float64) != 1731536000 {
		t.Fatalf("nbf/exp: %v %v", payload["nbf"], payload["exp"])
	}
	// No iss/aud/iat — Attic only enforces issuer/audience when the server is
	// configured with them, and leaves iat unset itself.
	for _, k := range []string{"iss", "aud", "iat"} {
		if _, present := payload[k]; present {
			t.Fatalf("%s must not be emitted", k)
		}
	}
	ns, ok := payload[ClaimNamespace].(map[string]any)
	if !ok {
		t.Fatalf("missing namespace claim %s: %v", ClaimNamespace, payload)
	}
	if _, ok := ns["caches"]; !ok {
		t.Fatalf("namespace claim must carry caches: %v", ns)
	}

	// Verify the signature is HMAC-SHA256 over the signing input using the
	// DECODED secret bytes — not the base64 text.
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if parts[2] != want {
		t.Fatal("signature does not verify against the decoded secret")
	}
}

// Fail closed rather than minting a token signed with a bad key, which would
// look fine and hide that the root credential is invalid.
func TestMintRejectsEmptySecret(t *testing.T) {
	for _, s := range []string{"", "   "} {
		if _, err := MintToken(MintArgs{SecretBase64: s, Sub: "x"}); err == nil {
			t.Fatalf("expected an error for secret %q", s)
		}
	}
}

func TestMintIsDeterministic(t *testing.T) {
	args := MintArgs{
		SecretBase64: base64.StdEncoding.EncodeToString([]byte("k")),
		Sub:          "s", IssuedAtSeconds: 1, ExpiresAtSeconds: 2,
		Caches: map[string]CachePermissionFlags{
			"z": {Pull: true}, "a": {Push: true}, "m": {Delete: true},
		},
	}
	first, err := MintToken(args)
	if err != nil {
		t.Fatal(err)
	}
	// Go map iteration order is randomised per run, so without the explicit
	// sort this would flake — and a non-deterministic token would churn on
	// every apply.
	for range 20 {
		again, err := MintToken(args)
		if err != nil {
			t.Fatal(err)
		}
		if again != first {
			t.Fatal("minting must be deterministic for identical inputs")
		}
	}
}

func TestParseDurationSeconds(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int64
	}{
		{"1y", 31536000}, {"90d", 7776000}, {"12h", 43200},
		{"300s", 300}, {"300", 300}, {" 2w ", 1209600},
	} {
		got, err := ParseDurationSeconds(tc.in)
		if err != nil || got != tc.want {
			t.Fatalf("%q → %d, %v; want %d", tc.in, got, err, tc.want)
		}
	}

	// Zero and negative mint an immediately-dead token; garbage must not parse.
	for _, bad := range []string{"0", "0s", "-1", "", "abc", "1x", "1.5h"} {
		if _, err := ParseDurationSeconds(bad); err == nil {
			t.Fatalf("expected %q to be rejected", bad)
		}
	}
}

// Byte-for-byte parity with the TypeScript implementation, captured by running
// its exact logic under node with the same inputs.
//
// Cross-checking this matters more here than almost anywhere else in the port:
// there are 13 live Attic tokens, and they gate every host's binary-cache auth.
// If a re-mint produced a different credential, every NixOS host would need an
// agenix re-bootstrap.
//
// Single-cache/single-flag inputs are used deliberately: with one entry the
// map-ordering divergence between JS (insertion order) and Go (sorted) cannot
// arise, so this isolates the encoding, claim order, base64url form and HMAC
// exactly. Multi-cache determinism is covered by TestMintIsDeterministic.
func TestMintMatchesTypeScriptByteForByte(t *testing.T) {
	const want = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
		"eyJzdWIiOiJnaXRodWItYWN0aW9ucy1jaSIsIm5iZiI6MTcwMDAwMDAwMCwiZXhwIjoxNzMxNTM2MDAwLCJodHRwczovL2p3dC5hdHRpYy5ycy92MSI6eyJjYWNoZXMiOnsib3JnLWNhY2hlIjp7InIiOjEsInciOjEsImNjIjoxfX19fQ." +
		"y3o9oLiy2W0p3w0vaeB138pQoNIaGoT7pQW_inA7VaE"

	got, err := MintToken(MintArgs{
		SecretBase64:     base64.StdEncoding.EncodeToString([]byte("hs256-signing-secret")),
		Sub:              "github-actions-ci",
		IssuedAtSeconds:  1700000000,
		ExpiresAtSeconds: 1731536000,
		Caches:           map[string]CachePermissionFlags{"org-cache": {Pull: true, Push: true, CreateCache: true}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("token diverged from the TypeScript implementation:\n got  %s\n want %s", got, want)
	}
}
