// Package providercfg holds the sector7 provider's optional configuration and
// helpers for resolving runtime cluster identity on operations that lack current
// resource inputs (notably Delete).
package providercfg

import (
	"context"
	"os"
	"strings"

	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/internal/kube"
)

// Config is optional provider configuration. Every field is optional so
// existing default-provider stacks need not set anything new.
type Config struct {
	// Kubeconfig is YAML used to open port-forwards when a resource's checkpoint
	// still carries a stale cluster identity (see onepassword.Item Delete).
	Kubeconfig string `pulumi:"kubeconfig,optional" provider:"secret"`
	// ConnectToken overrides the checkpointed Connect token on Delete when the
	// vault token was rotated and the Item was never updated.
	ConnectToken string `pulumi:"connectToken,optional" provider:"secret"`
}

func (c *Config) Annotate(a infer.Annotator) {
	a.Describe(&c.Kubeconfig, "Kubeconfig (YAML) for port-forwards when destroying "+
		"resources whose state still references a retired API endpoint.")
	a.Describe(&c.ConnectToken, "Optional 1Password Connect token override for "+
		"destroy when state holds a rotated token.")
}

// ResolveDeleteCredentials picks kubeconfig and connectToken for Delete.
//
// Precedence (highest last): state checkpoint < Delete OldInputs < SECTOR7_KUBECONFIG
// env < provider config. Only kubeconfig and connectToken participate; identity
// fields (vault, title, uuid) always come from state.
func ResolveDeleteCredentials(
	ctx context.Context,
	stateKube, stateToken, oldKube, oldToken string,
) (kubeconfig, connectToken string) {
	kubeconfig, connectToken = stateKube, stateToken
	if oldKube != "" {
		kubeconfig = oldKube
	}
	if oldToken != "" {
		connectToken = oldToken
	}
	if env := kube.CurrentKubeconfigFromEnv(); env != "" {
		kubeconfig = env
	}
	if cfg, ok := configFromContext(ctx); ok {
		if cfg.Kubeconfig != "" {
			kubeconfig = cfg.Kubeconfig
		}
		if cfg.ConnectToken != "" {
			connectToken = cfg.ConnectToken
		}
	}
	return kubeconfig, connectToken
}

// configFromContext reads provider config when Configure has run; otherwise ok is false.
func configFromContext(ctx context.Context) (Config, bool) {
	defer func() {
		recover()
	}()
	return infer.GetConfig[Config](ctx), true
}

// SetenvKubeconfig sets SECTOR7_KUBECONFIG for a test. Returns a restore func.
func SetenvKubeconfig(t testingTB, value string) func() {
	t.Helper()
	prev, had := os.LookupEnv(kube.CurrentKubeconfigEnv)
	if err := os.Setenv(kube.CurrentKubeconfigEnv, value); err != nil {
		t.Fatal(err)
	}
	return func() {
		if had {
			_ = os.Setenv(kube.CurrentKubeconfigEnv, prev)
		} else {
			_ = os.Unsetenv(kube.CurrentKubeconfigEnv)
		}
	}
}

// testingTB is the minimal testing.T interface for SetenvKubeconfig.
type testingTB interface {
	Helper()
	Fatal(...any)
}

// Trim is used by tests comparing kubeconfig strings.
func Trim(s string) string { return strings.TrimSpace(s) }
