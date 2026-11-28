package provider

import (
	"testing"

	"github.com/blang/semver"
	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/integration"
	"github.com/pulumi/pulumi/sdk/v3/go/property"
)

func TestProviderConfigUnsetZeroDiff(t *testing.T) {
	prov, err := New()
	if err != nil {
		t.Fatal(err)
	}
	srv, err := integration.NewServer(t.Context(), Name, semver.MustParse("0.21.0"),
		integration.WithProvider(prov))
	if err != nil {
		t.Fatal(err)
	}
	empty := property.Map{}
	resp, err := srv.DiffConfig(p.DiffRequest{
		Urn:       "urn:pulumi:stack::proj::pulumi:providers:sector7::default",
		ID:        "default",
		OldInputs: empty,
		Inputs:    empty,
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.HasChanges {
		t.Fatalf("adding optional provider config keys must not diff when unset; got %+v", resp.DetailedDiff)
	}
}
