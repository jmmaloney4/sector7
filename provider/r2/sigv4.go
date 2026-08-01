package r2

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Minimal AWS SigV4 for R2, scoped to exactly the two operations needed: PUT
// (upload an object body) and DELETE. No query strings, no multipart, no
// chunked encoding.
//
// Hand-rolled rather than pulled from aws-sdk-go-v2: the surface is ~60 lines,
// the region and service are fixed, and the signer is the only thing that would
// justify a very large dependency. A golden vector pins it against the
// TypeScript implementation.

const (
	sigRegion  = "auto"
	sigService = "s3"
	sigAlgo    = "AWS4-HMAC-SHA256"
)

// SigV4Credentials are the R2 access keys.
type SigV4Credentials struct {
	AccessKeyID     string
	SecretAccessKey string
}

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// deriveSigningKey is the standard SigV4 key derivation chain.
func deriveSigningKey(secret, dateStamp, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), dateStamp)
	kRegion := hmacSHA256(kDate, region)
	kService := hmacSHA256(kRegion, service)
	return hmacSHA256(kService, "aws4_request")
}

// signedHeaders builds the SigV4 Authorization header plus the request headers
// that must accompany it.
//
// `now` is a parameter rather than time.Now() so the signature is testable
// against a fixed vector.
func signedHeaders(
	method, rawURL string,
	creds SigV4Credentials,
	body []byte,
	contentType string,
	now time.Time,
) (map[string]string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("sector7: parsing R2 URL: %w", err)
	}

	amzDate := now.UTC().Format("20060102T150405Z")
	dateStamp := amzDate[:8]
	payloadHash := sha256Hex(body) // sha256 of empty is correct for a nil body

	// Canonical headers must be sorted by lowercase name, and content-type is
	// included only when set so the signed headers match the sent headers
	// exactly.
	headers := map[string]string{
		"host":                 parsed.Host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date":           amzDate,
	}
	if contentType != "" {
		headers["content-type"] = contentType
	}

	names := make([]string, 0, len(headers))
	for k := range headers {
		names = append(names, k)
	}
	sort.Strings(names)

	var canonicalHeaders strings.Builder
	for _, k := range names {
		canonicalHeaders.WriteString(k)
		canonicalHeaders.WriteString(":")
		canonicalHeaders.WriteString(strings.TrimSpace(headers[k]))
		canonicalHeaders.WriteString("\n")
	}
	signedHeaderNames := strings.Join(names, ";")

	canonicalRequest := strings.Join([]string{
		method,
		parsed.EscapedPath(),
		"", // no query string
		canonicalHeaders.String(),
		signedHeaderNames,
		payloadHash,
	}, "\n")

	credentialScope := fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, sigRegion, sigService)
	stringToSign := strings.Join([]string{
		sigAlgo,
		amzDate,
		credentialScope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")

	signature := hex.EncodeToString(hmacSHA256(
		deriveSigningKey(creds.SecretAccessKey, dateStamp, sigRegion, sigService),
		stringToSign,
	))

	out := map[string]string{
		"Authorization": fmt.Sprintf("%s Credential=%s/%s, SignedHeaders=%s, Signature=%s",
			sigAlgo, creds.AccessKeyID, credentialScope, signedHeaderNames, signature),
		"X-Amz-Content-Sha256": payloadHash,
		"X-Amz-Date":           amzDate,
	}
	if contentType != "" {
		out["Content-Type"] = contentType
	}
	return out, nil
}
