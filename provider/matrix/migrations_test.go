package matrix

import (
	"context"
	"reflect"
	"testing"

	"github.com/blang/semver"
	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"
	"github.com/pulumi/pulumi-go-provider/integration"
	"github.com/pulumi/pulumi/sdk/v3/go/property"
)

// liveRoomState mirrors what the garden-local dynamic provider
// (deploy/services/matrix/matrix-room.ts) actually wrote: MatrixRoomOutputs
// spread with `roomId`, plus `__provider`, the serialized closure. isDirect is
// deliberately absent — the dynamic provider only wrote it when the input was
// set (`if (isDirect !== undefined) body.is_direct = isDirect`), and RoomArgs
// models that same absence as a nil *bool rather than a zero value. See
// boolPtrEqual in room.go.
func liveRoomState() property.Map {
	return property.NewMap(map[string]property.Value{
		"homeserverUrl":  property.New("https://matrix.example.com"),
		"accessToken":    property.New("syt-bot-token"),
		"name":           property.New("garden-alerts"),
		"topic":          property.New("automated alerts"),
		"preset":         property.New("private_chat"),
		"aliasLocalpart": property.New("garden-alerts"),
		"invite": property.New([]property.Value{
			property.New("@jack:example.com"),
		}),
		"roomId":     property.New("!abc123:example.com"),
		"__provider": property.New("4;/deleted/worktree/node_modules/...;closure"),
	})
}

// newRoomInputs is what the retyped wrapper sends: the same args, minus
// __provider and roomId (both outputs, not inputs).
func newRoomInputs() property.Map {
	return liveRoomState().Delete("__provider", "roomId")
}

// liveBotAccountState mirrors what the garden-local dynamic provider
// (deploy/services/matrix/matrix-bot-account.ts) actually wrote:
// MatrixBotAccountOutputs spread with `userId`/`accessToken`, plus
// `__provider`. password is present — every live call site already passes an
// explicit RandomPassword rather than relying on the dynamic provider's
// random-UUID fallback (see the Password field comment in botaccount.go), so
// legacy state always carries a real value.
func liveBotAccountState() property.Map {
	return property.NewMap(map[string]property.Value{
		"homeserverUrl":     property.New("https://matrix.example.com"),
		"username":          property.New("garden-bot"),
		"displayName":       property.New("Garden Bot"),
		"registrationToken": property.New("reg-token"),
		"password":          property.New("s3cr3t-password"),
		"userId":            property.New("@garden-bot:example.com"),
		"accessToken":       property.New("syt-bot-access-token"),
		"__provider":        property.New("4;/deleted/worktree/node_modules/...;closure"),
	})
}

// newBotAccountInputs is what the retyped wrapper sends: the same args, minus
// __provider, userId and accessToken (all outputs, not inputs).
func newBotAccountInputs() property.Map {
	return liveBotAccountState().Delete("__provider", "userId", "accessToken")
}

func testServer(t *testing.T) integration.Server {
	t.Helper()
	prov, err := infer.NewProviderBuilder().
		WithNamespace("jmmaloney4").
		WithResources(infer.Resource(Room{}), infer.Resource(BotAccount{})).
		Build()
	if err != nil {
		t.Fatal(err)
	}
	srv, err := integration.NewServer(context.Background(), "sector7",
		semver.MustParse("0.21.0"), integration.WithProvider(prov))
	if err != nil {
		t.Fatal(err)
	}
	return srv
}

const roomURN = "urn:pulumi:prod::matrix::sector7:matrix:Room::garden-alerts"

// THE migration gate for Room: the exact call the engine makes during the
// alias retype. Must succeed and report no changes, or the cutover fails at
// preview instead of diffing to nothing.
//
// Without the migration this fails with
// `Unrecognized field '__provider' on 'matrix.RoomState'`.
func TestRoomDiffAcceptsLiveDynamicProviderState(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "!abc123:example.com",
		Urn:    roomURN,
		State:  liveRoomState(),
		Inputs: newRoomInputs(),
	})
	if err != nil {
		t.Fatalf("Diff must accept live dynamic-provider state: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("retype must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// Dropping __provider is the ONLY thing the migration may do. A genuinely
// edited name must still plan an update.
func TestRoomRealFieldChangeSurvivesTheMigration(t *testing.T) {
	srv := testServer(t)

	inputs := newRoomInputs().Set("name", property.New("garden-alerts-renamed"))

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "!abc123:example.com",
		Urn:    roomURN,
		State:  liveRoomState(),
		Inputs: inputs,
	})
	if err != nil {
		t.Fatalf("edited name must decode: %v", err)
	}
	if !resp.HasChanges {
		t.Fatal("a renamed room must plan a change, not be swallowed by the migration")
	}
	if _, ok := resp.DetailedDiff["name"]; !ok {
		t.Fatalf("expected a name diff; got %+v", resp.DetailedDiff)
	}
}

// State that never passed through the dynamic provider has no __provider and
// must decode by the normal path, proving the migration is additive-safe.
func TestRoomPluginNativeStateStillDecodes(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "!abc123:example.com",
		Urn:    roomURN,
		State:  liveRoomState().Delete("__provider"),
		Inputs: newRoomInputs(),
	})
	if err != nil {
		t.Fatalf("plugin-native state must decode without a migration: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("unchanged plugin-native state must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

const botAccountURN = "urn:pulumi:prod::matrix::sector7:matrix:BotAccount::garden-bot"

// THE migration gate for BotAccount: same call shape as Room's, above.
//
// Without the migration this fails with
// `Unrecognized field '__provider' on 'matrix.BotAccountState'`.
func TestBotAccountDiffAcceptsLiveDynamicProviderState(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "@garden-bot:example.com",
		Urn:    botAccountURN,
		State:  liveBotAccountState(),
		Inputs: newBotAccountInputs(),
	})
	if err != nil {
		t.Fatalf("Diff must accept live dynamic-provider state: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("retype must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// Dropping __provider is the ONLY thing the migration may do. A genuinely
// rotated password must still plan an (in-place) update.
func TestBotAccountRealFieldChangeSurvivesTheMigration(t *testing.T) {
	srv := testServer(t)

	inputs := newBotAccountInputs().Set("password", property.New("ROTATED"))

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "@garden-bot:example.com",
		Urn:    botAccountURN,
		State:  liveBotAccountState(),
		Inputs: inputs,
	})
	if err != nil {
		t.Fatalf("edited password must decode: %v", err)
	}
	if !resp.HasChanges {
		t.Fatal("a rotated password must plan a change, not be swallowed by the migration")
	}
	if _, ok := resp.DetailedDiff["password"]; !ok {
		t.Fatalf("expected a password diff; got %+v", resp.DetailedDiff)
	}
}

// State that never passed through the dynamic provider has no __provider and
// must decode by the normal path, proving the migration is additive-safe.
func TestBotAccountPluginNativeStateStillDecodes(t *testing.T) {
	srv := testServer(t)

	resp, err := srv.Diff(p.DiffRequest{
		ID:     "@garden-bot:example.com",
		Urn:    botAccountURN,
		State:  liveBotAccountState().Delete("__provider"),
		Inputs: newBotAccountInputs(),
	})
	if err != nil {
		t.Fatalf("plugin-native state must decode without a migration: %v", err)
	}
	if resp.HasChanges {
		t.Fatalf("unchanged plugin-native state must diff to nothing; got %+v", resp.DetailedDiff)
	}
}

// Same guard as d1's and onepassword's. infer runs migrations BEFORE the
// normal decode and skips a migrator only when decoding into its old shape
// FAILS, so `,optional` here would make roomStateV0/botAccountStateV0 match
// plugin-native state too and route every read through the migration —
// permanently, not just for legacy state.
func TestProviderTagIsRequiredSoTheMigrationOnlyMatchesLegacyState(t *testing.T) {
	t.Run("Room", func(t *testing.T) {
		f, ok := reflect.TypeOf(roomStateV0{}).FieldByName("Provider")
		if !ok {
			t.Fatal("roomStateV0.Provider is gone; if the field was renamed, update this guard rather than deleting it")
		}
		if tag := f.Tag.Get("pulumi"); tag != "__provider" {
			t.Fatalf("roomStateV0.Provider must be tagged exactly `pulumi:\"__provider\"`, got %q.\n"+
				"Adding ,optional makes this shape match plugin-native state as well, so the\n"+
				"migration would run on every state read instead of only on state written by\n"+
				"the dynamic provider.", tag)
		}
	})

	t.Run("BotAccount", func(t *testing.T) {
		f, ok := reflect.TypeOf(botAccountStateV0{}).FieldByName("Provider")
		if !ok {
			t.Fatal("botAccountStateV0.Provider is gone; if the field was renamed, update this guard rather than deleting it")
		}
		if tag := f.Tag.Get("pulumi"); tag != "__provider" {
			t.Fatalf("botAccountStateV0.Provider must be tagged exactly `pulumi:\"__provider\"`, got %q.\n"+
				"Adding ,optional makes this shape match plugin-native state as well, so the\n"+
				"migration would run on every state read instead of only on state written by\n"+
				"the dynamic provider.", tag)
		}
	})
}
