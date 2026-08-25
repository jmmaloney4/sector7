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
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/internal/checkutil"
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
	checkutil.RequireNonEmpty(&failures, req.NewInputs,
		checkutil.NamedField{Name: "homeserverUrl", Value: args.HomeserverURL},
		checkutil.NamedField{Name: "username", Value: args.Username},
		checkutil.NamedField{Name: "registrationToken", Value: args.RegistrationToken},
		checkutil.NamedField{Name: "password", Value: args.Password},
	)
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
	// A rotated password is applied IN PLACE via Matrix's change-password API,
	// not by replacement. Replacement is not an option here: see the
	// DeleteBeforeReplace comment below — there is no ordering of destroy and
	// create that can replace a Matrix account under the same username.
	if olds.Password != news.Password {
		diffs["password"] = p.PropertyDiff{Kind: p.Update}
	}
	// The display name is mutable in place.
	if olds.DisplayName != news.DisplayName {
		diffs["displayName"] = p.PropertyDiff{Kind: p.Update}
	}

	// DeleteBeforeReplace is ALWAYS false, and this is a safety property rather
	// than a preference.
	//
	// Delete deactivates the account, and Matrix deactivation is irreversible:
	// the user id is permanently retired and cannot be re-registered. So
	// destroying first would burn the username, the follow-up /register would
	// fail, and the recovery login would fail too because the account is
	// deactivated — stranding both the resource and the name, with no way back.
	//
	// Creating first is not a working replacement either when the username and
	// homeserver are unchanged: /register answers M_USER_IN_USE and recovery
	// tries the new credential against an account that still has the old one.
	// But it fails SAFELY — the apply errors and the live account is untouched.
	//
	// Between a loud failure and an irreversible one, take the loud failure.
	// This is why `password` is an in-place update above rather than a
	// replacement: it removes the only routine trigger for this situation.
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

	// A 2xx carrying no user_id or access_token must fail loudly. Assigning an
	// empty resource id would leave Pulumi tracking an account it cannot
	// address, while the registered Matrix user stays live on the homeserver —
	// the same reason Room.Create rejects an empty room_id.
	if res.UserID == "" || res.AccessToken == "" {
		return out, fmt.Errorf(
			"sector7: Matrix registration for %s returned no user_id or access_token; "+
				"the account may exist on the homeserver and must be reconciled manually", a.Username)
	}

	if a.DisplayName != "" {
		b.setDisplayName(ctx, c, res.UserID, res.AccessToken, a.DisplayName)
	}

	out.ID = res.UserID
	out.Output = BotAccountState{BotAccountArgs: a, UserID: res.UserID, AccessToken: res.AccessToken}
	return out, nil
}

func isUserInUse(err error) bool {
	var e *httpx.Error
	return errors.As(err, &e) && strings.Contains(e.Body, "M_USER_IN_USE")
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
		var e *httpx.Error
		if errors.As(err, &e) &&
			(e.Status == http.StatusUnauthorized || e.Status == http.StatusNotFound) {
			return infer.ReadResponse[BotAccountArgs, BotAccountState]{}, nil
		}
		// Any other error keeps state rather than recreating — but is reported,
		// so an account that cannot be verified does not masquerade as healthy.
		p.GetLogger(ctx).Warningf(
			"could not verify Matrix account %s; keeping existing state: %v", req.ID, err)
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
	// Sent whenever it CHANGED, including a change to empty. The dynamic
	// provider guarded on `news.displayName &&`, which made clearing a display
	// name a silent no-op: Diff reported an update, Update skipped the call,
	// and state then claimed an empty name the homeserver never received.
	if req.Inputs.DisplayName != req.State.DisplayName {
		c := client(req.State.HomeserverURL)
		c.Bearer = req.State.AccessToken
		if err := c.Do(ctx, "PUT",
			"/_matrix/client/v3/profile/"+url.PathEscape(req.State.UserID)+"/displayname",
			map[string]any{"displayname": req.Inputs.DisplayName}, nil, true); err != nil {
			return out, fmt.Errorf("sector7: failed to update display name for %s: %w", req.State.Username, err)
		}
	}

	// The password change goes LAST, and the ordering is load-bearing.
	//
	// A failed Update leaves Pulumi holding the OLD state, so the next apply
	// recomputes the same diff and retries. That retry authenticates the UIA
	// stage with req.State.Password — the old password. If the password had
	// already been changed on the homeserver by an earlier attempt, every
	// retry now authenticates with a password the account no longer has, and
	// the account is unrecoverable without server-side intervention: the
	// access token stays valid (logout_devices is false) but cannot satisfy an
	// m.login.password UIA stage.
	//
	// Putting every other step first means anything that fails before this
	// point leaves the credentials untouched and the whole Update cleanly
	// retryable. Only a lost response from the call below can still strand the
	// account, which is a far narrower window than "any later step failed".
	//
	// logout_devices MUST be false: the default is true, which would invalidate
	// the access token this resource stores and every consumer's session.
	if req.Inputs.Password != req.State.Password {
		c := client(req.State.HomeserverURL)
		c.Bearer = req.State.AccessToken
		if err := c.Do(ctx, "POST", "/_matrix/client/v3/account/password", map[string]any{
			"new_password":   req.Inputs.Password,
			"logout_devices": false,
			"auth": map[string]any{
				"type":       "m.login.password",
				"identifier": map[string]any{"type": "m.id.user", "user": req.State.UserID},
				"password":   req.State.Password,
			},
		}, nil, true); err != nil {
			return out, fmt.Errorf(
				"sector7: failed to change the password for %s: %w — if this call reached the "+
					"homeserver, Pulumi state still holds the previous password and the account "+
					"must be reconciled server-side", req.State.Username, err)
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
