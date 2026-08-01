// Package httpx is the shared JSON client for sector7's provider resources.
//
// It replaces the ad-hoc `fetch` wrappers in the dynamic providers
// (litellm `adminRequest`, attic `ensureOk`, r2, d1) and fixes two problems
// they shared:
//
//  1. Those wrappers spliced the raw response body into the error message.
//     For LiteLLM's /key/* endpoints the body can echo the key. Only the
//     1Password client got this right (packages/sector7/onepassword/item.ts
//     `connectRequest`), and its behaviour is adopted here for everything:
//     errors render method/path/status only, bodies go to debug logging.
//
//  2. They had neither timeouts nor retries, so a hung port-forward hung
//     `pulumi up`.
package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"time"
)

// Error is a non-2xx response. It carries Status so callers can distinguish a
// definitive client-side outcome (a 404/400 meaning "this object is gone")
// from an auth failure or a transient server error. litellm's Read depends on
// exactly that distinction: only a genuine not-found may drop a resource from
// state, or a transient refresh hiccup would trigger a credential-churning
// recreate.
type Error struct {
	Method string
	Path   string
	Status int
	// Body is retained for debug logging only. It is deliberately NOT included
	// in Error(), because response bodies from these APIs can contain secrets.
	Body string
}

func (e *Error) Error() string {
	return fmt.Sprintf("sector7: %s %s failed: %d", e.Method, e.Path, e.Status)
}

// Client issues authenticated JSON requests against a base URL.
type Client struct {
	BaseURL string
	// Bearer is sent as `Authorization: Bearer <Bearer>`.
	Bearer string
	// Host, when non-empty, overrides the Host header. Attic's allowed-hosts
	// check requires the in-cluster Service FQDN even though the connection is
	// to 127.0.0.1 through a port-forward. Node's fetch (undici) treats Host as
	// a forbidden header and silently drops it, which is why the TypeScript
	// implementation had to drop to node:http; Go's net/http honours req.Host,
	// so that whole workaround disappears.
	Host string
	// HTTP is the underlying client. Callers should give each port-forwarded
	// connection its own client with DisableKeepAlives, so a pooled connection
	// cannot outlive the forward.
	HTTP *http.Client
	// MaxRetries bounds retries of *idempotent* requests on 429/5xx.
	MaxRetries int
}

// Do issues a request and decodes the JSON response into out (may be nil).
//
// idempotent gates retries. This is not a style preference: a retried
// POST /key/generate whose first attempt actually succeeded creates a second
// LiteLLM key whose hash Pulumi never records — a live credential nobody can
// find or revoke. Creating calls (/key/generate, /team/new, 1Password item
// POST) must pass false.
func (c *Client) Do(ctx context.Context, method, path string, body any, out any, idempotent bool) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return fmt.Errorf("sector7: encoding %s %s body: %w", method, path, err)
		}
	}

	attempts := 1
	if idempotent && c.MaxRetries > 0 {
		attempts += c.MaxRetries
	}

	var lastErr error
	for attempt := range attempts {
		if attempt > 0 {
			// Exponential backoff with jitter. Bounded by attempts, so the
			// worst case stays well inside Pulumi's own operation deadline.
			delay := time.Duration(1<<uint(attempt-1)) * 200 * time.Millisecond
			delay += time.Duration(rand.Int63n(int64(delay/2 + 1)))
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}

		err := c.once(ctx, method, path, payload, out)
		if err == nil {
			return nil
		}
		lastErr = err

		var httpErr *Error
		if !isRetryable(err, &httpErr) {
			return err
		}
	}
	return lastErr
}

func isRetryable(err error, into **Error) bool {
	e, ok := err.(*Error)
	if !ok {
		// Transport-level failures (dial, TLS, EOF) are retryable; context
		// cancellation is not, and surfaces as ctx.Err() before we get here.
		return true
	}
	*into = e
	return e.Status == http.StatusTooManyRequests || e.Status >= 500
}

func (c *Client) once(ctx context.Context, method, path string, payload []byte, out any) error {
	var rdr io.Reader
	if payload != nil {
		rdr = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rdr)
	if err != nil {
		return fmt.Errorf("sector7: building %s %s: %w", method, path, err)
	}
	if c.Bearer != "" {
		req.Header.Set("Authorization", "Bearer "+c.Bearer)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Host != "" {
		req.Host = c.Host
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("sector7: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("sector7: reading %s %s response: %w", method, path, err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &Error{Method: method, Path: path, Status: resp.StatusCode, Body: string(raw)}
	}
	if len(raw) == 0 || out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		// A 2xx with a non-JSON body is not an error for every endpoint, so
		// only report when the caller actually wanted a decoded value.
		return fmt.Errorf("sector7: decoding %s %s response: %w", method, path, err)
	}
	return nil
}
