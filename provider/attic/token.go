// Package attic implements the sector7 provider's Attic binary-cache
// resources. Ported from packages/sector7/attic/{admin,token}.ts.
package attic

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ClaimNamespace is the namespace claim Attic reads its grants from.
const ClaimNamespace = "https://jwt.attic.rs/v1"

// CachePermissionFlags are the per-cache grants.
type CachePermissionFlags struct {
	Pull                    bool `pulumi:"pull,optional"`
	Push                    bool `pulumi:"push,optional"`
	Delete                  bool `pulumi:"delete,optional"`
	CreateCache             bool `pulumi:"createCache,optional"`
	ConfigureCache          bool `pulumi:"configureCache,optional"`
	ConfigureCacheRetention bool `pulumi:"configureCacheRetention,optional"`
	DestroyCache            bool `pulumi:"destroyCache,optional"`
}

// permissionClaim renders flags into Attic's short-key form, emitting only the
// granted flags (absent means deny) with the INTEGER value 1.
//
// Attic deserialises each permission value as an integer, not a JSON boolean —
// `atticadm make-token --dump-claims` emits {"r":1,"cc":1,…}. Emitting `true`
// instead makes Attic reject the whole token with 401, because the permission
// claim fails to deserialise, which silently breaks every minted token. The
// key order below matches atticadm's.
func (f CachePermissionFlags) permissionClaim() []kv {
	var out []kv
	add := func(k string, on bool) {
		if on {
			out = append(out, kv{k, 1})
		}
	}
	add("r", f.Pull)
	add("w", f.Push)
	add("d", f.Delete)
	add("cc", f.CreateCache)
	add("cr", f.ConfigureCache)
	add("cq", f.ConfigureCacheRetention)
	add("cd", f.DestroyCache)
	return out
}

type kv struct {
	Key string
	Val int
}

// MintArgs are the inputs to MintToken.
type MintArgs struct {
	// SecretBase64 is the server's HS256 secret, base64-encoded. It is decoded
	// to the raw HMAC key bytes.
	SecretBase64     string
	Sub              string
	IssuedAtSeconds  int64
	ExpiresAtSeconds int64
	Caches           map[string]CachePermissionFlags
}

// MintToken signs an Attic-compatible HS256 JWT entirely in-process.
//
// It emits the minimal claim set atticadm produces — sub, nbf, exp, and the
// namespace claim with a caches map — and signs with HMAC-SHA256 over the
// base64-DECODED secret bytes. No iss/aud/iat: Attic only enforces
// issuer/audience when the server is configured with a bound issuer/audience
// (garden's is not), and leaves iat unset itself.
//
// On byte-identity with the TypeScript implementation: it is deliberately not
// attempted, because it is not achievable and not required. JS preserves object
// insertion order while Go sorts map keys, so a multi-cache token would serialise
// differently — but a JWT only has to *verify*, and we sign whatever bytes we
// emit. This implementation emits deterministically (caches sorted by pattern,
// permission flags in atticadm's order), which is strictly better than the
// input-order dependence of the original. Tests therefore decode and verify
// rather than string-comparing.
func MintToken(a MintArgs) (string, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(a.SecretBase64))
	if err != nil {
		// Unlike Buffer.from(_, "base64"), Go reports malformed input rather
		// than silently truncating — same fail-closed intent, earlier.
		return "", fmt.Errorf("sector7: invalid hs256 secret: %w", err)
	}
	// Fail closed on an empty secret: minting with a bad key would produce a
	// token that looks fine and hides that the root credential is invalid.
	if len(key) == 0 {
		return "", fmt.Errorf(
			"sector7: invalid hs256 secret: decoded to empty bytes (expected a base64-encoded signing secret)")
	}

	header := []byte(`{"alg":"HS256","typ":"JWT"}`)

	// Built by hand rather than via a map so the claim order is fixed and the
	// permission values stay integers.
	var payload bytes.Buffer
	payload.WriteString(`{"sub":`)
	writeJSONString(&payload, a.Sub)
	payload.WriteString(`,"nbf":`)
	payload.WriteString(strconv.FormatInt(a.IssuedAtSeconds, 10))
	payload.WriteString(`,"exp":`)
	payload.WriteString(strconv.FormatInt(a.ExpiresAtSeconds, 10))
	payload.WriteString(`,`)
	writeJSONString(&payload, ClaimNamespace)
	payload.WriteString(`:{"caches":{`)

	patterns := make([]string, 0, len(a.Caches))
	for k := range a.Caches {
		patterns = append(patterns, k)
	}
	sort.Strings(patterns)
	for i, pattern := range patterns {
		if i > 0 {
			payload.WriteString(",")
		}
		writeJSONString(&payload, pattern)
		payload.WriteString(":{")
		for j, e := range a.Caches[pattern].permissionClaim() {
			if j > 0 {
				payload.WriteString(",")
			}
			writeJSONString(&payload, e.Key)
			payload.WriteString(":")
			payload.WriteString(strconv.Itoa(e.Val))
		}
		payload.WriteString("}")
	}
	payload.WriteString(`}}}`)

	enc := base64.RawURLEncoding
	signingInput := enc.EncodeToString(header) + "." + enc.EncodeToString(payload.Bytes())

	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signingInput))
	return signingInput + "." + enc.EncodeToString(mac.Sum(nil)), nil
}

func writeJSONString(buf *bytes.Buffer, s string) {
	b, _ := json.Marshal(s)
	buf.Write(b)
}

var durationRe = regexp.MustCompile(`^(\d+)\s*(s|m|h|d|w|y)?$`)

var unitSeconds = map[string]int64{
	"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800, "y": 31536000,
}

// ParseDurationSeconds accepts a bare number of seconds or a <n><unit> duration
// with unit s/m/h/d/w/y (e.g. "1y", "90d", "12h", "300s").
//
// Non-positive values are rejected: a zero or expired validity mints an
// immediately-dead token.
func ParseDurationSeconds(input string) (int64, error) {
	m := durationRe.FindStringSubmatch(strings.TrimSpace(input))
	if m == nil {
		return 0, fmt.Errorf(
			"sector7: invalid validity duration: %q (expected e.g. \"1y\", \"90d\", \"12h\", or seconds)", input)
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("sector7: invalid validity duration: %q (must be positive)", input)
	}
	unit := m[2]
	if unit == "" {
		unit = "s"
	}
	secs := n * unitSeconds[unit]
	if secs/unitSeconds[unit] != n { // overflow guard
		return 0, fmt.Errorf("sector7: validity duration too large: %q", input)
	}
	return secs, nil
}
