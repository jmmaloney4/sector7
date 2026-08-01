package litellm

import (
	"testing"

	"github.com/pulumi/pulumi-go-provider/infer"
)

func baseTeamArgs() TeamArgs {
	return TeamArgs{
		AdminTarget: AdminTarget{
			ProxyNamespace: "litellm", MasterKey: "sk-master",
			ProxyDeploymentName: "litellm", ProxyPort: 4000,
		},
		TeamAlias: "prod-personal", DesiredTeamID: "personal",
		Models: []string{"coding"},
	}
}

// See TestKeyDeleteToleratesAlreadyGone — same reasoning, same retry exposure.
func TestTeamDeleteToleratesAlreadyGone(t *testing.T) {
	h := newHarness(t, func(recorded) (int, any) { return 404, map[string]any{} })
	state := TeamState{TeamArgs: baseTeamArgs(), TeamID: "personal"}
	if _, err := (TeamRecord{Transport: h.tr}).Delete(t.Context(),
		infer.DeleteRequest[TeamState]{ID: "personal", State: state}); err != nil {
		t.Fatalf("a delete of an already-absent team must succeed; got %v", err)
	}
}

// Adoption must never match on team_alias: aliases are not unique on a shared
// admin plane, so alias matching would let this resource overwrite an unrelated
// team's models and budgets.
func TestTeamCreateAdoptsByIdNeverAlias(t *testing.T) {
	h := newHarness(t, func(r recorded) (int, any) {
		if r.Path == "/team/list" {
			// Same alias, DIFFERENT id — must not be adopted.
			return 200, map[string]any{"teams": []any{
				map[string]any{"team_id": "someone-else", "team_alias": "prod-personal"},
			}}
		}
		if r.Path == "/team/new" {
			return 200, map[string]any{"team_id": "personal"}
		}
		return 200, map[string]any{}
	})
	resp, err := TeamRecord{Transport: h.tr}.Create(t.Context(),
		infer.CreateRequest[TeamArgs]{Inputs: baseTeamArgs()})
	if err != nil {
		t.Fatal(err)
	}
	if h.find("POST /team/update") != nil {
		t.Fatalf("must not adopt a same-alias team with a different id; saw %v", h.paths())
	}
	if resp.ID != "personal" {
		t.Fatalf("expected a fresh create; got id %q", resp.ID)
	}
}
