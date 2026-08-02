// Package matrix implements Matrix homeserver resources.
//
// Ported from garden's deploy/services/matrix/{matrix-bot-account,matrix-room}.ts,
// which were garden-LOCAL dynamic providers rather than sector7 ones. They are
// folded into this provider deliberately: they carry exactly the same
// serialised-closure fragility, and a second provider binary would duplicate the
// packaging, discovery and release machinery for two resources.
package matrix

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/internal/httpx"
)

// BotAccount is a Matrix bot user: registered via the registration API, and
// deactivated on destroy.
type BotAccount struct{}

type BotAccountArgs struct {
	HomeserverURL string `pulumi:"homeserverUrl"`
	Username      string `pulumi:"username"`
	DisplayName   string `pulumi:"displayName,optional"`
	// RegistrationToken is consumed only at registration time, which is why a
	// change to it forces replacement rather than an update.
	RegistrationToken string `pulumi:"registrationToken" provider:"secret"`
	// Password is REQUIRED, unlike the dynamic provider this replaces, which
	// generated a random one when it was omitted. That fallback was unsound:
	// the generated value was never written anywhere — not to state, not to the
	// outputs — so it existed only inside one Create call. Any later attempt to
	// recover the account (see the M_USER_IN_USE path in Create) would log in
	// with a DIFFERENT random password and fail, stranding a live account
	// nobody holds the credentials for.
	//
	// Every live call site already passes an explicit RandomPassword, so this
	// costs nothing and turns an unrecoverable credential into an up-front
	// Check failure.
	Password string `pulumi:"password" provider:"secret"`
}

type BotAccountState struct {
	BotAccountArgs
	UserID string `pulumi:"userId"`
	// AccessToken was NOT marked secret by the garden-local dynamic provider,
	// so it sits in plaintext in matrix/prod state today. Marking it fixes new
	// writes; the token itself should be rotated separately.
	AccessToken string `pulumi:"accessToken" provider:"secret"`
}

func client(base string) *httpx.Client {
	return &httpx.Client{
		BaseURL:    strings.TrimRight(base, "/"),
		HTTP:       &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 60 * time.Second},
		MaxRetries: 3,
	}
}

func (BotAccount) Check(ctx context.Context, req infer.CheckRequest) (infer.CheckResponse[BotAccountArgs], error) {
	args, failures, err := infer.DefaultCheck[BotAccountArgs](ctx, req.NewInputs)
	if err != nil {
		return infer.CheckResponse[BotAccountArgs]{Inputs: args, Failures: failures}, err
	}
	// The original provider validated nothing. These are the fields whose
	// absence produces a confusing homeserver error rather than a clear one.
	for _, f := range []struct{ name, val string }{
		{"homeserverUrl", args.HomeserverURL},
		{"username", args.Username},
		{"registrationToken", args.RegistrationToken},
		{"password", args.Password},
	} {
		if f.val == "" {
			failures = append(failures, p.CheckFailure{Property: f.name, Reason: f.name + " is required"})
		}
	}
	return infer.CheckResponse[BotAccountArgs]{Inputs: args, Failures: failures}, nil
}

func (BotAccount) Diff(_ context.Context, req infer.DiffRequest[BotAccountArgs, BotAccountState]) (p.DiffResponse, error) {
	olds, news := req.State, req.Inputs
	diffs := map[string]p.PropertyDiff{}

	// A different username or homeserver is a fundamentally different account.
	// The registration token is consumed at registration, so changing it also
	// requires re-registering.
	if olds.Username != news.Username {
		diffs["username"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	if olds.HomeserverURL != news.HomeserverURL {
		diffs["homeserverUrl"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	if olds.RegistrationToken != news.RegistrationToken {
		diffs["registrationToken"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	// The display name is mutable in place.
	if olds.DisplayName != news.DisplayName {
		diffs["displayName"] = p.PropertyDiff{Kind: p.Update}
	}

	return p.DiffResponse{
		HasChanges:          len(diffs) > 0,
		DetailedDiff:        diffs,
		DeleteBeforeReplace: false,
	}, nil
}

type loginResult struct {
	UserID      string `json:"user_id"`
	AccessToken string `json:"access_token"`
	DeviceID    string `json:"device_id"`
}

func (b BotAccount) Create(ctx context.Context, req infer.CreateRequest[BotAccountArgs]) (infer.CreateResponse[BotAccountState], error) {
	out := infer.CreateResponse[BotAccountState]{Output: BotAccountState{BotAccountArgs: req.Inputs}}
	if req.DryRun {
		return out, nil
	}
	a := req.Inputs
	c := client(a.HomeserverURL)

	var res loginResult
	// Never retried: a retried registration after a timeout that actually
	// succeeded hits M_USER_IN_USE, which the recovery path below handles —
	// but the register call itself is not idempotent.
	err := c.Do(ctx, "POST", "/_matrix/client/v3/register", map[string]any{
		"username": a.Username,
		"auth": map[string]any{
			"type":  "m.login.registration_token",
			"token": a.RegistrationToken,
		},
		"password": a.Password,
	}, &res, false)

	if err != nil {
		// Recover from a half-completed prior run: registration succeeded on
		// the homeserver but Pulumi failed to persist state (transient network
		// error). Log in with the same password to recover the access token
		// rather than failing forever on a user that already exists.
		if !isUserInUse(err) {
			return out, err
		}
		if err := c.Do(ctx, "POST", "/_matrix/client/v3/login", map[string]any{
			"type":       "m.login.password",
			"identifier": map[string]any{"type": "m.id.user", "user": a.Username},
			"password":   a.Password,
		}, &res, false); err != nil {
			return out, fmt.Errorf(
				"sector7: Matrix user %s already exists but password login failed — "+
					"the account exists with a different password and must be recovered manually: %w", a.Username, err)
		}
	}

	if a.DisplayName != "" {
		b.setDisplayName(ctx, c, res.UserID, res.AccessToken, a.DisplayName)
	}

	out.ID = res.UserID
	out.Output = BotAccountState{BotAccountArgs: a, UserID: res.UserID, AccessToken: res.AccessToken}
	return out, nil
}

func isUserInUse(err error) bool {
	e, ok := err.(*httpx.Error)
	return ok && strings.Contains(e.Body, "M_USER_IN_USE")
}

// setDisplayName is best-effort: a bot with the wrong display name is cosmetic,
// and failing the whole create over it would strand a registered account
// outside Pulumi state.
func (BotAccount) setDisplayName(ctx context.Context, c *httpx.Client, userID, token, name string) {
	dn := *c
	dn.Bearer = token
	_ = dn.Do(ctx, "PUT",
		"/_matrix/client/v3/profile/"+url.PathEscape(userID)+"/displayname",
		map[string]any{"displayname": name}, nil, true)
}

// Read verifies the account still exists.
//
// 401 and 404 mean the account is gone or its token is invalid, so the resource
// is reported absent and the next up re-creates it. Any other status leaves
// state intact — the same fail-safe direction as the LiteLLM key probe: a
// transient homeserver error must not churn a live account.
func (BotAccount) Read(ctx context.Context, req infer.ReadRequest[BotAccountArgs, BotAccountState]) (infer.ReadResponse[BotAccountArgs, BotAccountState], error) {
	if req.ID == "" {
		return infer.ReadResponse[BotAccountArgs, BotAccountState]{}, nil
	}
	c := client(req.State.HomeserverURL)
	c.Bearer = req.State.AccessToken

	err := c.Do(ctx, "GET", "/_matrix/client/v3/profile/"+url.PathEscape(req.ID), nil, nil, true)
	if err != nil {
		if e, ok := err.(*httpx.Error); ok &&
			(e.Status == http.StatusUnauthorized || e.Status == http.StatusNotFound) {
			return infer.ReadResponse[BotAccountArgs, BotAccountState]{}, nil
		}
		// Any other error: assume state is still valid rather than recreating.
		return infer.ReadResponse[BotAccountArgs, BotAccountState]{
			ID: req.ID, Inputs: req.Inputs, State: req.State,
		}, nil
	}
	return infer.ReadResponse[BotAccountArgs, BotAccountState]{
		ID: req.ID, Inputs: req.Inputs, State: req.State,
	}, nil
}

func (b BotAccount) Update(ctx context.Context, req infer.UpdateRequest[BotAccountArgs, BotAccountState]) (infer.UpdateResponse[BotAccountState], error) {
	out := infer.UpdateResponse[BotAccountState]{Output: BotAccountState{
		BotAccountArgs: req.Inputs,
		UserID:         req.State.UserID,
		AccessToken:    req.State.AccessToken,
	}}
	if req.DryRun {
		return out, nil
	}
	if req.Inputs.DisplayName != "" && req.Inputs.DisplayName != req.State.DisplayName {
		c := client(req.State.HomeserverURL)
		c.Bearer = req.State.AccessToken
		if err := c.Do(ctx, "PUT",
			"/_matrix/client/v3/profile/"+url.PathEscape(req.State.UserID)+"/displayname",
			map[string]any{"displayname": req.Inputs.DisplayName}, nil, true); err != nil {
			return out, fmt.Errorf("sector7: failed to update display name for %s: %w", req.State.Username, err)
		}
	}
	return out, nil
}

// Delete deactivates the account, best-effort.
//
// tuwunel (Conduit) accepts token-only deactivation via the Authorization
// header. The auth block is omitted entirely — a partial m.login.password block
// without identifier/password makes stricter homeservers reject the request.
//
// Failures are swallowed: a homeserver that will not deactivate must not block
// `pulumi destroy` on the rest of the stack.
func (BotAccount) Delete(ctx context.Context, req infer.DeleteRequest[BotAccountState]) (infer.DeleteResponse, error) {
	c := client(req.State.HomeserverURL)
	c.Bearer = req.State.AccessToken
	_ = c.Do(ctx, "POST", "/_matrix/client/v3/account/deactivate", map[string]any{}, nil, true)
	return infer.DeleteResponse{}, nil
}
