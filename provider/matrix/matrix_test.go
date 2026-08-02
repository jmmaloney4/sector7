package matrix

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	pgo "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"
	"github.com/pulumi/pulumi/sdk/v3/go/property"

	"github.com/jmmaloney4/sector7/provider/internal/httpx"
)

type call struct {
	Method string
	Path   string
	Body   map[string]any
}

// harness records every request and replies from a per-path route table.
type harness struct {
	mu     sync.Mutex
	calls  []call
	routes map[string]func(w http.ResponseWriter)
	// fallback answers any path with no explicit route.
	fallback func(w http.ResponseWriter, path string)
}

func newHarness(t *testing.T) (*harness, string) {
	t.Helper()
	h := &harness{routes: map[string]func(http.ResponseWriter){}}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return h, srv.URL
}

func (h *harness) route(path string, fn func(w http.ResponseWriter)) *harness {
	h.routes[path] = fn
	return h
}

func (h *harness) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var body map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &body)
	}
	h.mu.Lock()
	h.calls = append(h.calls, call{Method: r.Method, Path: r.URL.Path, Body: body})
	h.mu.Unlock()

	if fn, ok := h.routes[r.URL.Path]; ok {
		fn(w)
		return
	}
	if h.fallback != nil {
		h.fallback(w, r.URL.Path)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{}`))
}

// seen returns the recorded calls. Copied under the lock: the server goroutine
// appends concurrently, and `go test -race` catches a naked read.
func (h *harness) seen() []call {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]call(nil), h.calls...)
}

func (h *harness) paths() []string {
	var out []string
	for _, c := range h.seen() {
		out = append(out, c.Method+" "+c.Path)
	}
	return out
}

func json200(payload string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(payload))
	}
}

func status(code int, payload string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.WriteHeader(code)
		_, _ = w.Write([]byte(payload))
	}
}

// ---------------------------------------------------------------- BotAccount

// "registers the account and returns the user id and access token"
func TestBotAccountCreateRegisters(t *testing.T) {
	h, url := newHarness(t)
	h.route("/_matrix/client/v3/register",
		json200(`{"user_id":"@bot:example.org","access_token":"tok","device_id":"D"}`))

	resp, err := BotAccount{}.Create(t.Context(), infer.CreateRequest[BotAccountArgs]{
		Inputs: BotAccountArgs{
			HomeserverURL: url, Username: "bot", RegistrationToken: "rt", DisplayName: "Bot", Password: "pw",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.ID != "@bot:example.org" || resp.Output.AccessToken != "tok" {
		t.Fatalf("unexpected output: %+v", resp.Output)
	}
	// The display name is set as a side call, not part of registration.
	if got := h.paths(); len(got) != 2 ||
		!strings.HasPrefix(got[1], "PUT /_matrix/client/v3/profile/") {
		t.Fatalf("expected register then displayname; got %v", got)
	}
}

// "does not register when previewing"
func TestBotAccountCreateDryRunMakesNoCalls(t *testing.T) {
	h, url := newHarness(t)
	_, err := BotAccount{}.Create(t.Context(), infer.CreateRequest[BotAccountArgs]{
		DryRun: true,
		Inputs: BotAccountArgs{HomeserverURL: url, Username: "bot", RegistrationToken: "rt", Password: "pw"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := h.paths(); len(got) != 0 {
		t.Fatalf("preview must not touch the homeserver; got %v", got)
	}
}

// "recovers via password login when the user already exists (M_USER_IN_USE)"
//
// This is the half-completed-run path: registration succeeded on the
// homeserver but Pulumi never persisted state. Failing here would strand the
// account permanently outside Pulumi.
func TestBotAccountCreateRecoversFromUserInUse(t *testing.T) {
	h, url := newHarness(t)
	h.route("/_matrix/client/v3/register",
		status(http.StatusBadRequest, `{"errcode":"M_USER_IN_USE"}`))
	h.route("/_matrix/client/v3/login",
		json200(`{"user_id":"@bot:example.org","access_token":"recovered","device_id":"D"}`))

	resp, err := BotAccount{}.Create(t.Context(), infer.CreateRequest[BotAccountArgs]{
		Inputs: BotAccountArgs{
			HomeserverURL: url, Username: "bot", RegistrationToken: "rt", Password: "pw",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Output.AccessToken != "recovered" {
		t.Fatalf("expected the login token; got %q", resp.Output.AccessToken)
	}
	// The recovery login must reuse the SAME password, or it cannot succeed.
	calls := h.seen()
	if calls[1].Body["password"] != "pw" {
		t.Fatalf("login must reuse the declared password; got %v", calls[1].Body["password"])
	}
}

// "fails when registration fails for any reason other than M_USER_IN_USE"
func TestBotAccountCreateFailsOnOtherErrors(t *testing.T) {
	h, url := newHarness(t)
	h.route("/_matrix/client/v3/register",
		status(http.StatusForbidden, `{"errcode":"M_FORBIDDEN"}`))

	_, err := BotAccount{}.Create(t.Context(), infer.CreateRequest[BotAccountArgs]{
		Inputs: BotAccountArgs{HomeserverURL: url, Username: "bot", RegistrationToken: "rt", Password: "pw"},
	})
	if err == nil {
		t.Fatal("a forbidden registration must fail, not silently attempt login")
	}
	for _, p := range h.paths() {
		if strings.Contains(p, "/login") {
			t.Fatal("must not attempt login for a non-M_USER_IN_USE failure")
		}
	}
}

// The registration POST must never be retried: a retried registration after a
// timeout that actually succeeded would hit M_USER_IN_USE with a password the
// caller may not have declared.
func TestBotAccountCreateDoesNotRetryRegistration(t *testing.T) {
	h, url := newHarness(t)
	h.route("/_matrix/client/v3/register", status(http.StatusInternalServerError, `{}`))

	if _, err := (BotAccount{}).Create(t.Context(), infer.CreateRequest[BotAccountArgs]{
		Inputs: BotAccountArgs{HomeserverURL: url, Username: "bot", RegistrationToken: "rt", Password: "pw"},
	}); err == nil {
		t.Fatal("expected an error")
	}
	if got := len(h.seen()); got != 1 {
		t.Fatalf("register must be attempted exactly once; got %d attempts", got)
	}
}

// "reports the account gone on 401 or 404, and keeps state on anything else"
func TestBotAccountReadStatusMatrix(t *testing.T) {
	for _, tc := range []struct {
		name string
		code int
		gone bool
	}{
		{"200 keeps state", http.StatusOK, false},
		{"401 is gone", http.StatusUnauthorized, true},
		{"404 is gone", http.StatusNotFound, true},
		{"403 keeps state", http.StatusForbidden, false},
		{"500 keeps state", http.StatusInternalServerError, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, url := newHarness(t)
			h.fallback = func(w http.ResponseWriter, _ string) {
				w.WriteHeader(tc.code)
				_, _ = w.Write([]byte(`{}`))
			}
			resp, err := BotAccount{}.Read(t.Context(), infer.ReadRequest[BotAccountArgs, BotAccountState]{
				ID:    "@bot:example.org",
				State: BotAccountState{BotAccountArgs: BotAccountArgs{HomeserverURL: url}, UserID: "@bot:example.org"},
			})
			if err != nil {
				t.Fatal(err)
			}
			if gone := resp.ID == ""; gone != tc.gone {
				t.Fatalf("status %d: gone=%v, want %v", tc.code, gone, tc.gone)
			}
		})
	}
}

// "replaces on username, homeserverUrl or registrationToken; updates displayName"
func TestBotAccountDiff(t *testing.T) {
	base := BotAccountArgs{
		HomeserverURL: "https://hs", Username: "bot", RegistrationToken: "rt", DisplayName: "Bot", Password: "pw",
	}
	old := BotAccountState{BotAccountArgs: base, UserID: "@bot:hs"}

	for prop, mutate := range map[string]func(*BotAccountArgs){
		"username":          func(a *BotAccountArgs) { a.Username = "other" },
		"homeserverUrl":     func(a *BotAccountArgs) { a.HomeserverURL = "https://other" },
		"registrationToken": func(a *BotAccountArgs) { a.RegistrationToken = "other" },
	} {
		news := base
		mutate(&news)
		r, _ := BotAccount{}.Diff(t.Context(), infer.DiffRequest[BotAccountArgs, BotAccountState]{State: old, Inputs: news})
		if r.DetailedDiff[prop].Kind != pgo.UpdateReplace {
			t.Fatalf("%s must force replacement; got %+v", prop, r.DetailedDiff)
		}
	}

	news := base
	news.DisplayName = "Renamed"
	r, _ := BotAccount{}.Diff(t.Context(), infer.DiffRequest[BotAccountArgs, BotAccountState]{State: old, Inputs: news})
	if r.DetailedDiff["displayName"].Kind != pgo.Update {
		t.Fatalf("displayName is mutable in place; got %+v", r.DetailedDiff)
	}

	// An unchanged account must be a no-op, or four live bots churn.
	r, _ = BotAccount{}.Diff(t.Context(), infer.DiffRequest[BotAccountArgs, BotAccountState]{State: old, Inputs: base})
	if r.HasChanges {
		t.Fatalf("unchanged inputs must not diff; got %+v", r.DetailedDiff)
	}
}

// A homeserver that refuses to deactivate must not block `pulumi destroy` on
// the rest of the stack.
func TestBotAccountDeleteSwallowsFailure(t *testing.T) {
	h, url := newHarness(t)
	h.route("/_matrix/client/v3/account/deactivate", status(http.StatusForbidden, `{}`))

	if _, err := (BotAccount{}).Delete(t.Context(), infer.DeleteRequest[BotAccountState]{
		ID:    "@bot:hs",
		State: BotAccountState{BotAccountArgs: BotAccountArgs{HomeserverURL: url}},
	}); err != nil {
		t.Fatalf("delete must not fail the destroy; got %v", err)
	}
}

// ---------------------------------------------------------------------- Room

func roomArgs(url string) RoomArgs {
	return RoomArgs{HomeserverURL: url, AccessToken: "tok", Name: "Ops"}
}

// "creates the room and returns its id, defaulting preset to private_chat"
func TestRoomCreate(t *testing.T) {
	h, url := newHarness(t)
	h.route("/_matrix/client/v3/createRoom", json200(`{"room_id":"!abc:example.org"}`))

	resp, err := Room{}.Create(t.Context(), infer.CreateRequest[RoomArgs]{Inputs: roomArgs(url)})
	if err != nil {
		t.Fatal(err)
	}
	if resp.ID != "!abc:example.org" || resp.Output.RoomID != "!abc:example.org" {
		t.Fatalf("unexpected output: %+v", resp.Output)
	}
	body := h.seen()[0].Body
	if body["preset"] != "private_chat" {
		t.Fatalf("preset must default to private_chat in the request; got %v", body["preset"])
	}
	// Optional fields must be omitted entirely, not sent empty — an empty
	// room_alias_name is rejected by the homeserver.
	for _, k := range []string{"topic", "room_alias_name", "invite", "is_direct"} {
		if _, ok := body[k]; ok {
			t.Fatalf("unset %q must be omitted from the request body", k)
		}
	}
}

// "sends every optional field when set"
func TestRoomCreateSendsOptionalFields(t *testing.T) {
	h, url := newHarness(t)
	h.route("/_matrix/client/v3/createRoom", json200(`{"room_id":"!abc:example.org"}`))

	direct := true
	a := roomArgs(url)
	a.Topic = "topic"
	a.AliasLocalpart = "ops"
	a.Invite = []string{"@a:hs"}
	a.IsDirect = &direct
	a.Preset = "public_chat"

	if _, err := (Room{}).Create(t.Context(), infer.CreateRequest[RoomArgs]{Inputs: a}); err != nil {
		t.Fatal(err)
	}
	body := h.seen()[0].Body
	if body["topic"] != "topic" || body["room_alias_name"] != "ops" ||
		body["is_direct"] != true || body["preset"] != "public_chat" {
		t.Fatalf("optional fields not forwarded: %v", body)
	}
}

// A createRoom that answers 200 with no room_id must fail loudly rather than
// record an empty id, which Pulumi would treat as a resource it cannot address.
func TestRoomCreateRejectsEmptyRoomID(t *testing.T) {
	h, url := newHarness(t)
	h.route("/_matrix/client/v3/createRoom", json200(`{}`))

	if _, err := (Room{}).Create(t.Context(), infer.CreateRequest[RoomArgs]{Inputs: roomArgs(url)}); err == nil {
		t.Fatal("expected an error for a missing room_id")
	}
	_ = h
}

// createRoom must never be retried — a retried create after a timeout that
// actually succeeded leaves an orphaned room Pulumi does not track.
func TestRoomCreateDoesNotRetry(t *testing.T) {
	h, url := newHarness(t)
	h.route("/_matrix/client/v3/createRoom", status(http.StatusInternalServerError, `{}`))

	if _, err := (Room{}).Create(t.Context(), infer.CreateRequest[RoomArgs]{Inputs: roomArgs(url)}); err == nil {
		t.Fatal("expected an error")
	}
	if got := len(h.seen()); got != 1 {
		t.Fatalf("createRoom must be attempted exactly once; got %d", got)
	}
}

// "replaces on preset, aliasLocalpart or homeserverUrl; updates name, topic and invite"
func TestRoomDiff(t *testing.T) {
	base := RoomArgs{HomeserverURL: "https://hs", AccessToken: "tok", Name: "Ops", Preset: "public_chat"}
	old := RoomState{RoomArgs: base, RoomID: "!abc:hs"}

	for prop, mutate := range map[string]func(*RoomArgs){
		"preset":         func(a *RoomArgs) { a.Preset = "private_chat" },
		"aliasLocalpart": func(a *RoomArgs) { a.AliasLocalpart = "ops" },
		"homeserverUrl":  func(a *RoomArgs) { a.HomeserverURL = "https://other" },
	} {
		news := base
		mutate(&news)
		r, _ := Room{}.Diff(t.Context(), infer.DiffRequest[RoomArgs, RoomState]{State: old, Inputs: news})
		if r.DetailedDiff[prop].Kind != pgo.UpdateReplace {
			t.Fatalf("%s is immutable and must replace; got %+v", prop, r.DetailedDiff)
		}
	}

	for prop, mutate := range map[string]func(*RoomArgs){
		"name":   func(a *RoomArgs) { a.Name = "Renamed" },
		"topic":  func(a *RoomArgs) { a.Topic = "new" },
		"invite": func(a *RoomArgs) { a.Invite = []string{"@a:hs"} },
	} {
		news := base
		mutate(&news)
		r, _ := Room{}.Diff(t.Context(), infer.DiffRequest[RoomArgs, RoomState]{State: old, Inputs: news})
		if r.DetailedDiff[prop].Kind != pgo.Update {
			t.Fatalf("%s is reconcilable in place; got %+v", prop, r.DetailedDiff)
		}
	}

	r, _ := Room{}.Diff(t.Context(), infer.DiffRequest[RoomArgs, RoomState]{State: old, Inputs: base})
	if r.HasChanges {
		t.Fatalf("unchanged inputs must not diff; got %+v", r.DetailedDiff)
	}
}

// Regression guard for a trap that would have REPLACED all four live rooms:
// declaring a schema default of "private_chat" for preset would materialise it
// into inputs at Check, while live state — written by the dynamic provider,
// which applied the fallback only when building the request body — has no
// preset at all. Diff would then see a change on an immutable property.
func TestRoomDiffIgnoresAbsentPreset(t *testing.T) {
	base := RoomArgs{HomeserverURL: "https://hs", AccessToken: "tok", Name: "Ops"}
	old := RoomState{RoomArgs: base, RoomID: "!abc:hs"}

	r, _ := Room{}.Diff(t.Context(), infer.DiffRequest[RoomArgs, RoomState]{State: old, Inputs: base})
	if r.HasChanges {
		t.Fatalf("an absent preset on both sides must not diff; got %+v", r.DetailedDiff)
	}

	// And nil vs [] invite must compare equal, matching the `?? []` handling
	// everywhere else in this provider.
	news := base
	news.Invite = []string{}
	r, _ = Room{}.Diff(t.Context(), infer.DiffRequest[RoomArgs, RoomState]{State: old, Inputs: news})
	if r.HasChanges {
		t.Fatalf("nil and [] invite must compare equal; got %+v", r.DetailedDiff)
	}
}

// "rejects an unknown preset and reports missing required fields"
func TestRoomCheck(t *testing.T) {
	inputs := func(m map[string]string) property.Map {
		vals := map[string]property.Value{}
		for k, v := range m {
			vals[k] = property.New(v)
		}
		return property.NewMap(vals)
	}
	props := func(fs []pgo.CheckFailure) map[string]bool {
		out := map[string]bool{}
		for _, f := range fs {
			out[string(f.Property)] = true
		}
		return out
	}

	// A valid room passes cleanly. Note preset is absent — live rooms written
	// by the dynamic provider have no preset, and Check must not reject them.
	resp, err := Room{}.Check(t.Context(), infer.CheckRequest{NewInputs: inputs(map[string]string{
		"homeserverUrl": "https://hs", "accessToken": "tok", "name": "Ops",
	})})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Failures) != 0 {
		t.Fatalf("a valid room must pass check; got %+v", resp.Failures)
	}

	// Missing required fields are each reported by name.
	resp, err = Room{}.Check(t.Context(), infer.CheckRequest{NewInputs: property.NewMap(nil)})
	if err != nil {
		t.Fatal(err)
	}
	got := props(resp.Failures)
	for _, want := range []string{"homeserverUrl", "accessToken", "name"} {
		if !got[want] {
			t.Fatalf("expected a failure for %q; got %+v", want, resp.Failures)
		}
	}

	// An unknown preset is caught here rather than as an opaque homeserver
	// error at create time.
	resp, err = Room{}.Check(t.Context(), infer.CheckRequest{NewInputs: inputs(map[string]string{
		"homeserverUrl": "https://hs", "accessToken": "tok", "name": "Ops", "preset": "secret_chat",
	})})
	if err != nil {
		t.Fatal(err)
	}
	if !props(resp.Failures)["preset"] {
		t.Fatalf("expected a preset failure; got %+v", resp.Failures)
	}
}

// "reports the room gone on 403 or 404, and keeps state on anything else"
//
// 401 deliberately keeps state: it means a bad token, not a missing room, and
// dropping the resource would create a DUPLICATE room rather than recover the
// original.
func TestRoomReadStatusMatrix(t *testing.T) {
	for _, tc := range []struct {
		name string
		code int
		gone bool
	}{
		{"200 keeps state", http.StatusOK, false},
		{"403 is gone (bot kicked)", http.StatusForbidden, true},
		{"404 is gone", http.StatusNotFound, true},
		{"401 keeps state", http.StatusUnauthorized, false},
		{"500 keeps state", http.StatusInternalServerError, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, url := newHarness(t)
			h.fallback = func(w http.ResponseWriter, _ string) {
				w.WriteHeader(tc.code)
				_, _ = w.Write([]byte(`{}`))
			}
			resp, err := Room{}.Read(t.Context(), infer.ReadRequest[RoomArgs, RoomState]{
				ID:    "!abc:hs",
				State: RoomState{RoomArgs: RoomArgs{HomeserverURL: url}, RoomID: "!abc:hs"},
			})
			if err != nil {
				t.Fatal(err)
			}
			if gone := resp.ID == ""; gone != tc.gone {
				t.Fatalf("status %d: gone=%v, want %v", tc.code, gone, tc.gone)
			}
		})
	}
}

// "updates only what changed, and invites only newly added members"
func TestRoomUpdate(t *testing.T) {
	h, url := newHarness(t)

	old := RoomState{
		RoomArgs: RoomArgs{
			HomeserverURL: url, AccessToken: "tok", Name: "Ops", Topic: "old",
			Invite: []string{"@a:hs"},
		},
		RoomID: "!abc:hs",
	}
	news := old.RoomArgs
	news.Name = "Renamed"
	news.Invite = []string{"@a:hs", "@b:hs"}

	if _, err := (Room{}).Update(t.Context(), infer.UpdateRequest[RoomArgs, RoomState]{
		ID: "!abc:hs", State: old, Inputs: news,
	}); err != nil {
		t.Fatal(err)
	}

	calls := h.seen()
	if len(calls) != 2 {
		t.Fatalf("expected exactly a name PUT and one invite; got %v", h.paths())
	}
	if !strings.HasSuffix(calls[0].Path, "/state/m.room.name") {
		t.Fatalf("expected the name state event first; got %v", h.paths())
	}
	// The topic did not change, so it must not be re-sent.
	for _, p := range h.paths() {
		if strings.Contains(p, "m.room.topic") {
			t.Fatal("an unchanged topic must not be written")
		}
	}
	// Only the newly added member is invited — re-inviting an existing member
	// spams every room participant on each `pulumi up`.
	if calls[1].Body["user_id"] != "@b:hs" {
		t.Fatalf("expected only @b:hs to be invited; got %v", calls[1].Body)
	}
}

// Matrix has no "uninvite", so dropping a member from the declared list is a
// deliberate no-op rather than an error.
func TestRoomUpdateRemovingAnInviteIsANoOp(t *testing.T) {
	h, url := newHarness(t)
	old := RoomState{
		RoomArgs: RoomArgs{HomeserverURL: url, AccessToken: "tok", Name: "Ops", Invite: []string{"@a:hs", "@b:hs"}},
		RoomID:   "!abc:hs",
	}
	news := old.RoomArgs
	news.Invite = []string{"@a:hs"}

	if _, err := (Room{}).Update(t.Context(), infer.UpdateRequest[RoomArgs, RoomState]{
		ID: "!abc:hs", State: old, Inputs: news,
	}); err != nil {
		t.Fatal(err)
	}
	if got := h.paths(); len(got) != 0 {
		t.Fatalf("removing an invite must make no calls; got %v", got)
	}
}

// "leaves then forgets the room, and never fails the destroy"
func TestRoomDelete(t *testing.T) {
	h, url := newHarness(t)
	state := RoomState{RoomArgs: RoomArgs{HomeserverURL: url, AccessToken: "tok"}, RoomID: "!abc:hs"}

	if _, err := (Room{}).Delete(t.Context(), infer.DeleteRequest[RoomState]{ID: "!abc:hs", State: state}); err != nil {
		t.Fatal(err)
	}
	got := h.paths()
	if len(got) != 2 || !strings.HasSuffix(got[0], "/leave") || !strings.HasSuffix(got[1], "/forget") {
		t.Fatalf("expected leave then forget; got %v", got)
	}
}

// forget only works after a successful leave, so a failed leave must skip it —
// and neither may fail the destroy.
func TestRoomDeleteSkipsForgetWhenLeaveFails(t *testing.T) {
	h, url := newHarness(t)
	h.fallback = func(w http.ResponseWriter, path string) {
		if strings.HasSuffix(path, "/leave") {
			w.WriteHeader(http.StatusForbidden)
		}
		_, _ = w.Write([]byte(`{}`))
	}
	state := RoomState{RoomArgs: RoomArgs{HomeserverURL: url, AccessToken: "tok"}, RoomID: "!abc:hs"}

	if _, err := (Room{}).Delete(t.Context(), infer.DeleteRequest[RoomState]{ID: "!abc:hs", State: state}); err != nil {
		t.Fatalf("delete must not fail the destroy; got %v", err)
	}
	for _, p := range h.paths() {
		if strings.HasSuffix(p, "/forget") {
			t.Fatal("forget must not be attempted after a failed leave")
		}
	}
}

// password is REQUIRED, unlike the dynamic provider, which generated a random
// one when omitted. That generated value was written nowhere, so the
// M_USER_IN_USE recovery path below would log in with a DIFFERENT random
// password and fail — stranding a live account nobody holds credentials for.
// An up-front Check failure is the correct outcome.
func TestBotAccountCheckRequiresPassword(t *testing.T) {
	resp, err := BotAccount{}.Check(t.Context(), infer.CheckRequest{
		NewInputs: property.NewMap(map[string]property.Value{
			"homeserverUrl":     property.New("https://hs"),
			"username":          property.New("bot"),
			"registrationToken": property.New("rt"),
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	var got bool
	for _, f := range resp.Failures {
		if string(f.Property) == "password" {
			got = true
		}
	}
	if !got {
		t.Fatalf("an omitted password must fail check rather than silently minting an unrecoverable one; got %+v", resp.Failures)
	}
}

// Every input that Create sends but no Update path can change must show up in
// Diff. Otherwise the value lands in Pulumi state while the server keeps the
// old one — the state says one thing, the homeserver another, and nothing ever
// reconciles them.
func TestBotAccountDiffCatchesPasswordDrift(t *testing.T) {
	base := BotAccountArgs{
		HomeserverURL: "https://hs", Username: "bot", RegistrationToken: "rt", Password: "pw",
	}
	old := BotAccountState{BotAccountArgs: base, UserID: "@bot:hs"}

	news := base
	news.Password = "rotated"
	r, _ := BotAccount{}.Diff(t.Context(), infer.DiffRequest[BotAccountArgs, BotAccountState]{State: old, Inputs: news})
	if r.DetailedDiff["password"].Kind != pgo.Update {
		t.Fatalf("a rotated password must be an in-place change, not vanish or replace; got %+v", r.DetailedDiff)
	}

	// DeleteBeforeReplace must be false for EVERY diff. Delete deactivates the
	// account, and Matrix deactivation is irreversible: the user id is retired
	// permanently. Destroying first would burn the username, and neither the
	// follow-up /register nor the recovery login could get it back.
	for name, mutate := range map[string]func(*BotAccountArgs){
		"password":          func(a *BotAccountArgs) { a.Password = "rotated" },
		"registrationToken": func(a *BotAccountArgs) { a.RegistrationToken = "rt2" },
		"username":          func(a *BotAccountArgs) { a.Username = "other" },
		"homeserverUrl":     func(a *BotAccountArgs) { a.HomeserverURL = "https://other" },
	} {
		n := base
		mutate(&n)
		got, _ := BotAccount{}.Diff(t.Context(), infer.DiffRequest[BotAccountArgs, BotAccountState]{State: old, Inputs: n})
		if got.DeleteBeforeReplace {
			t.Fatalf("%s: a Matrix account must NEVER be deactivated before its replacement exists — "+
				"deactivation permanently retires the user id", name)
		}
	}
}

// A rotated password is applied through Matrix's change-password API, in place.
// logout_devices must be false, or the call invalidates the access token this
// resource stores and every consumer's session with it.
func TestBotAccountUpdateChangesPassword(t *testing.T) {
	h, url := newHarness(t)
	old := BotAccountState{
		BotAccountArgs: BotAccountArgs{
			HomeserverURL: url, Username: "bot", RegistrationToken: "rt", Password: "old-pw",
		},
		UserID: "@bot:hs", AccessToken: "tok",
	}
	news := old.BotAccountArgs
	news.Password = "new-pw"

	if _, err := (BotAccount{}).Update(t.Context(), infer.UpdateRequest[BotAccountArgs, BotAccountState]{
		ID: "@bot:hs", State: old, Inputs: news,
	}); err != nil {
		t.Fatal(err)
	}
	calls := h.seen()
	if len(calls) != 1 || calls[0].Path != "/_matrix/client/v3/account/password" {
		t.Fatalf("expected exactly one change-password call; got %v", h.paths())
	}
	if calls[0].Body["new_password"] != "new-pw" {
		t.Fatalf("wrong new_password: %v", calls[0].Body["new_password"])
	}
	if calls[0].Body["logout_devices"] != false {
		t.Fatal("logout_devices must be false — true would invalidate the stored access token")
	}
	auth, _ := calls[0].Body["auth"].(map[string]any)
	if auth["password"] != "old-pw" {
		t.Fatalf("UIA must authenticate with the OLD password; got %v", auth["password"])
	}
}

// Diff reports a cleared display name as an in-place update, so Update has to
// actually send it. The dynamic provider guarded on a non-empty value, which
// made clearing a silent no-op with state claiming a name the homeserver never
// received.
func TestBotAccountUpdateClearsDisplayName(t *testing.T) {
	h, url := newHarness(t)
	old := BotAccountState{
		BotAccountArgs: BotAccountArgs{
			HomeserverURL: url, Username: "bot", RegistrationToken: "rt",
			Password: "pw", DisplayName: "Bot",
		},
		UserID: "@bot:hs", AccessToken: "tok",
	}
	news := old.BotAccountArgs
	news.DisplayName = ""

	if _, err := (BotAccount{}).Update(t.Context(), infer.UpdateRequest[BotAccountArgs, BotAccountState]{
		ID: "@bot:hs", State: old, Inputs: news,
	}); err != nil {
		t.Fatal(err)
	}
	calls := h.seen()
	if len(calls) != 1 || !strings.HasSuffix(calls[0].Path, "/displayname") {
		t.Fatalf("clearing the display name must reach the homeserver; got %v", h.paths())
	}
	if calls[0].Body["displayname"] != "" {
		t.Fatalf("expected an empty displayname; got %v", calls[0].Body["displayname"])
	}

	// An unchanged display name must still make no call.
	h2, url2 := newHarness(t)
	old.HomeserverURL = url2
	if _, err := (BotAccount{}).Update(t.Context(), infer.UpdateRequest[BotAccountArgs, BotAccountState]{
		ID: "@bot:hs", State: old, Inputs: old.BotAccountArgs,
	}); err != nil {
		t.Fatal(err)
	}
	if got := h2.paths(); len(got) != 0 {
		t.Fatalf("an unchanged display name must make no call; got %v", got)
	}
}

// isDirect is sent only in the createRoom body and no state event can change
// it, so it is immutable — and absent must equal absent, or every live room
// (whose state has no isDirect) would be replaced on the first apply.
func TestRoomDiffTreatsIsDirectAsImmutable(t *testing.T) {
	base := RoomArgs{HomeserverURL: "https://hs", AccessToken: "tok", Name: "Ops"}
	old := RoomState{RoomArgs: base, RoomID: "!abc:hs"}

	yes, no := true, false
	news := base
	news.IsDirect = &yes
	r, _ := Room{}.Diff(t.Context(), infer.DiffRequest[RoomArgs, RoomState]{State: old, Inputs: news})
	if r.DetailedDiff["isDirect"].Kind != pgo.UpdateReplace {
		t.Fatalf("setting isDirect must force replacement, not vanish; got %+v", r.DetailedDiff)
	}

	// Absent on both sides — the shape of every live room.
	r, _ = Room{}.Diff(t.Context(), infer.DiffRequest[RoomArgs, RoomState]{State: old, Inputs: base})
	if r.HasChanges {
		t.Fatalf("absent isDirect must equal absent; got %+v", r.DetailedDiff)
	}

	// Same value on both sides is not a change either.
	withYes := base
	withYes.IsDirect = &yes
	oldYes := RoomState{RoomArgs: withYes, RoomID: "!abc:hs"}
	alsoYes := true
	news = base
	news.IsDirect = &alsoYes
	r, _ = Room{}.Diff(t.Context(), infer.DiffRequest[RoomArgs, RoomState]{State: oldYes, Inputs: news})
	if r.HasChanges {
		t.Fatalf("equal isDirect values must not diff; got %+v", r.DetailedDiff)
	}

	// true -> false is a change.
	news = base
	news.IsDirect = &no
	r, _ = Room{}.Diff(t.Context(), infer.DiffRequest[RoomArgs, RoomState]{State: oldYes, Inputs: news})
	if r.DetailedDiff["isDirect"].Kind != pgo.UpdateReplace {
		t.Fatalf("flipping isDirect must force replacement; got %+v", r.DetailedDiff)
	}
}

// The M_USER_IN_USE recovery path is what makes a lost /register response
// self-heal on the NEXT run: registration is never retried in-process (a retry
// would be the thing that creates the duplicate), so a transport error fails
// the apply, and the following apply hits M_USER_IN_USE and logs in instead.
//
// That only works because `password` is a declared, required input and is
// therefore stable across invocations — the property the removed random
// fallback lacked. This test pins the two halves together.
func TestBotAccountRecoveryIsStableAcrossRuns(t *testing.T) {
	args := BotAccountArgs{Username: "bot", RegistrationToken: "rt", Password: "declared-pw"}

	// Run 1: the homeserver accepts the registration but the response is lost.
	h1, url1 := newHarness(t)
	h1.route("/_matrix/client/v3/register", func(w http.ResponseWriter) {
		// A transport-shaped failure: no usable response body.
		w.WriteHeader(http.StatusInternalServerError)
	})
	a1 := args
	a1.HomeserverURL = url1
	if _, err := (BotAccount{}).Create(t.Context(), infer.CreateRequest[BotAccountArgs]{Inputs: a1}); err == nil {
		t.Fatal("a lost registration response must fail the apply, not be retried")
	}
	if got := len(h1.seen()); got != 1 {
		t.Fatalf("register must not be retried in-process; got %d attempts", got)
	}

	// Run 2: the account now exists. Recovery logs in with the SAME declared
	// password and succeeds.
	h2, url2 := newHarness(t)
	h2.route("/_matrix/client/v3/register", status(http.StatusBadRequest, `{"errcode":"M_USER_IN_USE"}`))
	h2.route("/_matrix/client/v3/login",
		json200(`{"user_id":"@bot:example.org","access_token":"recovered","device_id":"D"}`))
	a2 := args
	a2.HomeserverURL = url2
	resp, err := BotAccount{}.Create(t.Context(), infer.CreateRequest[BotAccountArgs]{Inputs: a2})
	if err != nil {
		t.Fatalf("the second run must recover the stranded account: %v", err)
	}
	if resp.Output.AccessToken != "recovered" {
		t.Fatalf("expected the recovered token; got %q", resp.Output.AccessToken)
	}
	if got := h2.seen()[1].Body["password"]; got != "declared-pw" {
		t.Fatalf("recovery must reuse the declared password; got %v", got)
	}
}

// isUserInUse drives that recovery, so it must survive error wrapping for the
// same reason as onepassword's asHTTPError: httpx returns *Error unwrapped
// today, and one added %w would turn recovery into a hard failure on an
// account that already exists.
func TestIsUserInUseSeesThroughWrapping(t *testing.T) {
	base := &httpx.Error{Method: "POST", Path: "/register", Status: 400, Body: `{"errcode":"M_USER_IN_USE"}`}
	for name, err := range map[string]error{
		"unwrapped": base,
		"wrapped":   fmt.Errorf("registering: %w", base),
	} {
		if !isUserInUse(err) {
			t.Fatalf("M_USER_IN_USE must be recognised through %s wrapping", name)
		}
	}
	if isUserInUse(&httpx.Error{Status: 403, Body: `{"errcode":"M_FORBIDDEN"}`}) {
		t.Fatal("a different errcode must not trigger recovery")
	}
}

// A rotated bot token must reach state, or every later Read, Update and Delete
// keeps authenticating with a credential that no longer works — and supplying a
// fresh token cannot recover it, because Diff reports no change to apply.
func TestRoomDiffCatchesTokenRotation(t *testing.T) {
	base := RoomArgs{HomeserverURL: "https://hs", AccessToken: "tok", Name: "Ops"}
	old := RoomState{RoomArgs: base, RoomID: "!abc:hs"}

	news := base
	news.AccessToken = "rotated"
	r, _ := Room{}.Diff(t.Context(), infer.DiffRequest[RoomArgs, RoomState]{State: old, Inputs: news})
	if r.DetailedDiff["accessToken"].Kind != pgo.Update {
		t.Fatalf("a rotated token must produce an in-place update; got %+v", r.DetailedDiff)
	}
	// It must NOT force replacement: the token says nothing about the room, and
	// recreating one would abandon the live room and its history.
	for _, d := range r.DetailedDiff {
		if d.Kind == pgo.UpdateReplace {
			t.Fatalf("a token rotation must never replace the room; got %+v", r.DetailedDiff)
		}
	}

	// Update must carry the new token into the returned state.
	h, url := newHarness(t)
	old.HomeserverURL, news.HomeserverURL = url, url
	resp, err := Room{}.Update(t.Context(), infer.UpdateRequest[RoomArgs, RoomState]{
		ID: "!abc:hs", State: old, Inputs: news,
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Output.AccessToken != "rotated" {
		t.Fatalf("the new token must land in state; got %q", resp.Output.AccessToken)
	}
	if got := h.paths(); len(got) != 0 {
		t.Fatalf("rotating a token changes nothing on the homeserver; got %v", got)
	}
}

// A 2xx carrying no user_id or access_token must fail loudly. Recording an
// empty resource id would leave Pulumi tracking an account it cannot address
// while the registered user stays live on the homeserver.
func TestBotAccountCreateRejectsIncompleteResponse(t *testing.T) {
	for name, payload := range map[string]string{
		"no user_id":      `{"access_token":"tok"}`,
		"no access_token": `{"user_id":"@bot:example.org"}`,
		"empty object":    `{}`,
	} {
		t.Run(name, func(t *testing.T) {
			h, url := newHarness(t)
			h.route("/_matrix/client/v3/register", json200(payload))
			_, err := BotAccount{}.Create(t.Context(), infer.CreateRequest[BotAccountArgs]{
				Inputs: BotAccountArgs{
					HomeserverURL: url, Username: "bot", RegistrationToken: "rt",
					Password: "pw", DisplayName: "Bot",
				},
			})
			if err == nil {
				t.Fatal("an incomplete registration response must fail, not record an unusable account")
			}
			// The display-name call must not have fired on a response we are
			// about to reject.
			for _, p := range h.paths() {
				if strings.Contains(p, "displayname") {
					t.Fatal("must not act on an incomplete response")
				}
			}
		})
	}
}
