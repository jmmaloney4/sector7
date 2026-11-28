package providercfg

import (
	"context"
	"testing"

	"github.com/jmmaloney4/sector7/provider/internal/kube"
)

func TestResolveDeleteCredentialsPrecedence(t *testing.T) {
	const (
		stateKube = "state"
		oldKube   = "old-inputs"
		envKube   = "env-443"
	)
	ctx := context.Background()

	t.Run("state alone", func(t *testing.T) {
		k, _ := ResolveDeleteCredentials(ctx, stateKube, "tok-state", "", "")
		if k != stateKube {
			t.Fatalf("got %q", k)
		}
	})

	t.Run("stale OldInputs over state", func(t *testing.T) {
		k, _ := ResolveDeleteCredentials(ctx, stateKube, "", oldKube, "")
		if k != oldKube {
			t.Fatalf("got %q want %q", k, oldKube)
		}
	})

	t.Run("env over stale OldInputs", func(t *testing.T) {
		defer SetenvKubeconfig(t, envKube)()
		k, _ := ResolveDeleteCredentials(ctx, stateKube, "", oldKube, "")
		if k != envKube {
			t.Fatalf("got %q want %q", k, envKube)
		}
	})

}

func TestEnvConstantMatchesKube(t *testing.T) {
	if kube.CurrentKubeconfigEnv != "SECTOR7_KUBECONFIG" {
		t.Fatalf("env constant mismatch: %q", kube.CurrentKubeconfigEnv)
	}
}
