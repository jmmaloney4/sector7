package matrix

import (
	"context"
	"fmt"
	"net/http"
	"net/url"

	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/internal/diffutil"
	"github.com/jmmaloney4/sector7/provider/internal/httpx"
)

// Room is a Matrix room created and maintained by a bot account.
type Room struct{}

type RoomArgs struct {
	HomeserverURL string `pulumi:"homeserverUrl"`
	AccessToken   string `pulumi:"accessToken" provider:"secret"`
	Name          string `pulumi:"name"`
	Topic         string `pulumi:"topic,optional"`
	// Preset is private_chat, trusted_private_chat or public_chat. Immutable
	// after creation.
	Preset string `pulumi:"preset,optional"`
	// AliasLocalpart is immutable after creation.
	AliasLocalpart string   `pulumi:"aliasLocalpart,optional"`
	Invite         []string `pulumi:"invite,optional"`
	IsDirect       *bool    `pulumi:"isDirect,optional"`
}

type RoomState struct {
	RoomArgs
	RoomID string `pulumi:"roomId"`
}

// NOTE: preset deliberately has NO schema default, even though createRoom
// falls back to private_chat. The dynamic provider applied that fallback only
// when building the request body — it never wrote it into inputs. Declaring
// SetDefault here would materialise `preset: "private_chat"` at Check on live
// rooms whose state has no preset at all, and Diff would then see a change on
// an immutable property and REPLACE four live rooms. The fallback stays in
// Create, where it was.
func (Room) Check(ctx context.Context, req infer.CheckRequest) (infer.CheckResponse[RoomArgs], error) {
	args, failures, err := infer.DefaultCheck[RoomArgs](ctx, req.NewInputs)
	if err != nil {
		return infer.CheckResponse[RoomArgs]{Inputs: args, Failures: failures}, err
	}
	for _, f := range []struct{ name, val string }{
		{"homeserverUrl", args.HomeserverURL},
		{"accessToken", args.AccessToken},
		{"name", args.Name},
	} {
		if f.val == "" {
			failures = append(failures, p.CheckFailure{Property: f.name, Reason: f.name + " is required"})
		}
	}
	switch args.Preset {
	case "", "private_chat", "trusted_private_chat", "public_chat":
	default:
		failures = append(failures, p.CheckFailure{
			Property: "preset",
			Reason:   "preset must be private_chat, trusted_private_chat or public_chat",
		})
	}
	return infer.CheckResponse[RoomArgs]{Inputs: args, Failures: failures}, nil
}

func (Room) Diff(_ context.Context, req infer.DiffRequest[RoomArgs, RoomState]) (p.DiffResponse, error) {
	olds, news := req.State, req.Inputs
	diffs := map[string]p.PropertyDiff{}

	// Preset and alias are immutable after creation; a different homeserver is
	// a different server entirely.
	if olds.Preset != news.Preset {
		diffs["preset"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	if olds.AliasLocalpart != news.AliasLocalpart {
		diffs["aliasLocalpart"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}
	if olds.HomeserverURL != news.HomeserverURL {
		diffs["homeserverUrl"] = p.PropertyDiff{Kind: p.UpdateReplace}
	}

	// Name, topic and invites are all reconcilable in place.
	if olds.Name != news.Name {
		diffs["name"] = p.PropertyDiff{Kind: p.Update}
	}
	if olds.Topic != news.Topic {
		diffs["topic"] = p.PropertyDiff{Kind: p.Update}
	}
	if !diffutil.StringsEqual(olds.Invite, news.Invite) {
		diffs["invite"] = p.PropertyDiff{Kind: p.Update}
	}

	return p.DiffResponse{
		HasChanges:          len(diffs) > 0,
		DetailedDiff:        diffs,
		DeleteBeforeReplace: false,
	}, nil
}

func (Room) Create(ctx context.Context, req infer.CreateRequest[RoomArgs]) (infer.CreateResponse[RoomState], error) {
	out := infer.CreateResponse[RoomState]{Output: RoomState{RoomArgs: req.Inputs}}
	if req.DryRun {
		return out, nil
	}
	a := req.Inputs
	c := client(a.HomeserverURL)
	c.Bearer = a.AccessToken

	preset := a.Preset
	if preset == "" {
		preset = "private_chat"
	}
	body := map[string]any{"name": a.Name, "preset": preset}
	if a.Topic != "" {
		body["topic"] = a.Topic
	}
	if a.AliasLocalpart != "" {
		body["room_alias_name"] = a.AliasLocalpart
	}
	if len(a.Invite) > 0 {
		body["invite"] = a.Invite
	}
	if a.IsDirect != nil {
		body["is_direct"] = *a.IsDirect
	}

	var res struct {
		RoomID string `json:"room_id"`
	}
	// Never retried: a retried createRoom after a timeout that actually
	// succeeded would leave an orphaned room Pulumi does not track.
	if err := c.Do(ctx, "POST", "/_matrix/client/v3/createRoom", body, &res, false); err != nil {
		return out, fmt.Errorf("sector7: Matrix createRoom failed for %q: %w", a.Name, err)
	}
	if res.RoomID == "" {
		return out, fmt.Errorf("sector7: Matrix createRoom returned no room_id for %q", a.Name)
	}

	out.ID = res.RoomID
	out.Output = RoomState{RoomArgs: a, RoomID: res.RoomID}
	return out, nil
}

// Read verifies the room still exists and the bot is still joined, by fetching
// the m.room.create state event.
//
// 404 (room gone) and 403 (bot kicked) drop the resource; everything else —
// including 401, which means a bad token rather than a missing room — keeps
// state, because dropping it would recreate a *duplicate* room rather than
// recover the original. This is the same status set the dynamic provider used.
func (Room) Read(ctx context.Context, req infer.ReadRequest[RoomArgs, RoomState]) (infer.ReadResponse[RoomArgs, RoomState], error) {
	if req.ID == "" {
		return infer.ReadResponse[RoomArgs, RoomState]{}, nil
	}
	c := client(req.State.HomeserverURL)
	c.Bearer = req.State.AccessToken

	err := c.Do(ctx, "GET",
		"/_matrix/client/v3/rooms/"+url.PathEscape(req.ID)+"/state/m.room.create", nil, nil, true)
	if err != nil {
		if e, ok := err.(*httpx.Error); ok &&
			(e.Status == http.StatusForbidden || e.Status == http.StatusNotFound) {
			return infer.ReadResponse[RoomArgs, RoomState]{}, nil
		}
	}
	return infer.ReadResponse[RoomArgs, RoomState]{ID: req.ID, Inputs: req.Inputs, State: req.State}, nil
}

func (Room) Update(ctx context.Context, req infer.UpdateRequest[RoomArgs, RoomState]) (infer.UpdateResponse[RoomState], error) {
	roomID := req.State.RoomID
	if roomID == "" {
		roomID = req.ID
	}
	out := infer.UpdateResponse[RoomState]{Output: RoomState{RoomArgs: req.Inputs, RoomID: roomID}}
	if req.DryRun {
		return out, nil
	}
	olds, news := req.State, req.Inputs
	c := client(news.HomeserverURL)
	c.Bearer = news.AccessToken
	esc := url.PathEscape(roomID)

	if news.Name != olds.Name {
		if err := c.Do(ctx, "PUT", "/_matrix/client/v3/rooms/"+esc+"/state/m.room.name",
			map[string]any{"name": news.Name}, nil, true); err != nil {
			return out, fmt.Errorf("sector7: failed to update room name for %s: %w", roomID, err)
		}
	}
	if news.Topic != olds.Topic {
		if err := c.Do(ctx, "PUT", "/_matrix/client/v3/rooms/"+esc+"/state/m.room.topic",
			map[string]any{"topic": news.Topic}, nil, true); err != nil {
			return out, fmt.Errorf("sector7: failed to update room topic for %s: %w", roomID, err)
		}
	}

	// Invite only members not already invited. Matrix has no "uninvite", so
	// removing someone from the list is deliberately a no-op rather than an
	// error — the declared list is additive.
	existing := map[string]bool{}
	for _, u := range olds.Invite {
		existing[u] = true
	}
	for _, u := range news.Invite {
		if existing[u] {
			continue
		}
		if err := c.Do(ctx, "POST", "/_matrix/client/v3/rooms/"+esc+"/invite",
			map[string]any{"user_id": u}, nil, true); err != nil {
			return out, fmt.Errorf("sector7: failed to invite %s to room %s: %w", u, roomID, err)
		}
	}
	return out, nil
}

// Delete leaves and then forgets the room, best-effort.
//
// Forgetting only works after leaving, and neither failure should block
// `pulumi destroy` — a room the bot cannot leave is not a reason to strand the
// rest of the stack.
func (Room) Delete(ctx context.Context, req infer.DeleteRequest[RoomState]) (infer.DeleteResponse, error) {
	roomID := req.ID
	if roomID == "" {
		roomID = req.State.RoomID
	}
	if roomID == "" {
		return infer.DeleteResponse{}, nil
	}
	c := client(req.State.HomeserverURL)
	c.Bearer = req.State.AccessToken
	esc := url.PathEscape(roomID)

	if err := c.Do(ctx, "POST", "/_matrix/client/v3/rooms/"+esc+"/leave", map[string]any{}, nil, true); err != nil {
		return infer.DeleteResponse{}, nil
	}
	_ = c.Do(ctx, "POST", "/_matrix/client/v3/rooms/"+esc+"/forget", map[string]any{}, nil, true)
	return infer.DeleteResponse{}, nil
}
