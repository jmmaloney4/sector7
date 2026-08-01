package r2

import (
	"testing"
	"time"
)

// Golden vector captured from the TypeScript signedFetch by running its exact
// logic under node with a fixed date, credentials and body:
//
//	PUT https://acct.r2.cloudflarestorage.com/my-bucket/dir/file%20name%21.txt
//	body "hello world", content-type text/plain, 20260801T120000Z
//
// SigV4 is unforgiving — a single byte off in the canonical request, the header
// ordering, the path encoding or the key-derivation chain yields a signature
// that R2 rejects with an opaque 403. Pinning the exact Authorization header is
// the only way to be confident the reimplementation is correct without a live
// bucket.
//
// The key is deliberately chosen to exercise path encoding: the object key
// contains both a space and a `!`, which percent-encode differently across
// implementations. The canonical request must use the ALREADY-ENCODED path
// (JS `URL.pathname`, Go `URL.EscapedPath()`), not a re-encoded one.
const goldenAuth = "AWS4-HMAC-SHA256 Credential=AKID/20260801/auto/s3/aws4_request, " +
	"SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, " +
	"Signature=7385d623ba654440f12b53ab14e2bb9b16d6d935c4d3bb076d962fb4f4426f87"

func TestSigV4MatchesTypeScript(t *testing.T) {
	got, err := signedHeaders(
		"PUT",
		"https://acct.r2.cloudflarestorage.com/my-bucket/dir/file%20name%21.txt",
		SigV4Credentials{AccessKeyID: "AKID", SecretAccessKey: "SECRETKEY"},
		[]byte("hello world"),
		"text/plain",
		time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}
	if got["Authorization"] != goldenAuth {
		t.Fatalf("signature diverged from the TypeScript implementation:\n got  %s\n want %s",
			got["Authorization"], goldenAuth)
	}
	if got["X-Amz-Date"] != "20260801T120000Z" {
		t.Fatalf("X-Amz-Date: %q", got["X-Amz-Date"])
	}
}

// content-type is signed only when present, so the signed headers match the
// sent headers exactly. A DELETE has no body and no content type.
func TestSigV4OmitsContentTypeWhenAbsent(t *testing.T) {
	got, err := signedHeaders(
		"DELETE",
		"https://acct.r2.cloudflarestorage.com/b/k",
		SigV4Credentials{AccessKeyID: "AKID", SecretAccessKey: "S"},
		nil, "",
		time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, present := got["Content-Type"]; present {
		t.Fatal("Content-Type must not be sent when unset")
	}
	if want := "SignedHeaders=host;x-amz-content-sha256;x-amz-date"; !contains(got["Authorization"], want) {
		t.Fatalf("signed headers must exclude content-type; got %s", got["Authorization"])
	}
	// The empty-payload hash is the sha256 of the empty string, not of "null".
	const emptySHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if got["X-Amz-Content-Sha256"] != emptySHA {
		t.Fatalf("empty payload hash: %s", got["X-Amz-Content-Sha256"])
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (len(sub) == 0 || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
