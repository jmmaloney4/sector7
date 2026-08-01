package kube

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"
)

// SPDYTransport opens port-forwards through the kube-apiserver.
//
// "SPDY" is not an acronym — it is a contraction of "speedy", Google's
// pre-HTTP/2 protocol. Kubernetes still speaks SPDY/3.1 for exec/attach/
// port-forward because those need bidirectional multiplexed streams over an
// HTTP upgrade. client-go's portforward package handles the framing; we supply
// the dialer.
type SPDYTransport struct {
	// configs caches *rest.Config per kubeconfig payload. client-go caches
	// transports globally, so this only avoids re-parsing; it deliberately does
	// NOT cache forwards. See Connect.
	//
	// Guarded by mu: Pulumi serves gRPC requests concurrently, so two resources
	// without a dependency between them reach restConfig at the same time on a
	// shared SPDYTransport. An unsynchronised map would make Go's runtime abort
	// the whole provider process with "concurrent map read and map write".
	mu      sync.Mutex
	configs map[string]*rest.Config
}

// Connect resolves a ready pod behind the Deployment and forwards a local
// ephemeral port to it.
//
// A fresh forward is opened per call rather than pooled. That is deliberate:
// every LiteLLM key `dependsOn` the proxy, so a proxy rollout immediately
// precedes these operations, and a cached forward to a now-Terminating pod is
// exactly the case the readiness check below exists to prevent. The cost is one
// GET + one LIST + one upgrade against calls that dominate it.
func (s *SPDYTransport) Connect(ctx context.Context, t Target) (*Conn, error) {
	cfg, err := s.restConfig(t.Kubeconfig)
	if err != nil {
		return nil, err
	}
	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("sector7: building kubernetes client: %w", err)
	}

	dep, err := clientset.AppsV1().Deployments(t.Namespace).Get(ctx, t.Deployment, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("sector7: reading deployment %s/%s: %w", t.Namespace, t.Deployment, err)
	}

	// LabelSelectorAsSelector handles matchLabels AND matchExpressions
	// (In/NotIn/Exists/DoesNotExist), replacing the hand-rolled renderer in
	// port-forward.ts. But it returns labels.Everything() for a nil/empty
	// selector, which would list every pod in the namespace and forward to an
	// arbitrary one — so the emptiness guard from the TypeScript version must
	// be kept explicitly.
	if dep.Spec.Selector == nil ||
		(len(dep.Spec.Selector.MatchLabels) == 0 && len(dep.Spec.Selector.MatchExpressions) == 0) {
		return nil, fmt.Errorf(
			"sector7: deployment %s/%s has no usable spec.selector (matchLabels/matchExpressions)",
			t.Namespace, t.Deployment)
	}
	selector, err := metav1.LabelSelectorAsSelector(dep.Spec.Selector)
	if err != nil {
		return nil, fmt.Errorf("sector7: rendering selector for %s/%s: %w", t.Namespace, t.Deployment, err)
	}

	pods, err := clientset.CoreV1().Pods(t.Namespace).List(ctx, metav1.ListOptions{LabelSelector: selector.String()})
	if err != nil {
		return nil, fmt.Errorf("sector7: listing pods for %s/%s: %w", t.Namespace, t.Deployment, err)
	}

	podName := selectReadyPod(pods.Items)
	if podName == "" {
		return nil, fmt.Errorf("sector7: no ready pod found for deployment %s/%s", t.Namespace, t.Deployment)
	}

	roundTripper, upgrader, err := spdy.RoundTripperFor(cfg)
	if err != nil {
		return nil, fmt.Errorf("sector7: building SPDY round tripper: %w", err)
	}
	reqURL := &url.URL{
		Scheme: "https",
		Host:   hostFromConfig(cfg),
		Path: fmt.Sprintf("/api/v1/namespaces/%s/pods/%s/portforward",
			t.Namespace, podName),
	}
	dialer := spdy.NewDialer(upgrader, &http.Client{Transport: roundTripper}, http.MethodPost, reqURL)

	stopCh := make(chan struct{}, 1)
	readyCh := make(chan struct{})
	errCh := make(chan error, 1)

	// "0:<port>" asks for an ephemeral local port, matching the TS
	// server.listen(0, "127.0.0.1"). Binding explicitly to 127.0.0.1 keeps the
	// forward off any other interface.
	fw, err := portforward.NewOnAddresses(dialer,
		[]string{"127.0.0.1"},
		[]string{fmt.Sprintf("0:%d", t.Port)},
		stopCh, readyCh, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("sector7: creating port-forward to %s/%s: %w", t.Namespace, podName, err)
	}

	go func() {
		if err := fw.ForwardPorts(); err != nil {
			errCh <- err
		}
	}()

	select {
	case <-readyCh:
	case err := <-errCh:
		close(stopCh)
		return nil, fmt.Errorf("sector7: port-forward to %s/%s failed: %w", t.Namespace, podName, err)
	case <-ctx.Done():
		close(stopCh)
		return nil, ctx.Err()
	case <-time.After(30 * time.Second):
		close(stopCh)
		return nil, fmt.Errorf("sector7: timed out establishing port-forward to %s/%s", t.Namespace, podName)
	}

	ports, err := fw.GetPorts()
	if err != nil || len(ports) == 0 {
		close(stopCh)
		return nil, fmt.Errorf("sector7: failed to bind a local port for the port-forward")
	}

	var closed bool
	return &Conn{
		BaseURL: fmt.Sprintf("http://127.0.0.1:%d", ports[0].Local),
		Host:    fmt.Sprintf("%s.%s.svc.cluster.local", t.Deployment, t.Namespace),
		Close: func() {
			if closed {
				return
			}
			closed = true
			close(stopCh)
		},
	}, nil
}

// selectReadyPod returns the first pod that is genuinely serving traffic.
//
// The DeletionTimestamp check is load-bearing and easy to drop: a terminating
// pod can still report Ready while shutting down, and forwarding to it produces
// a connection that dies mid-request. Requiring a real Ready condition — rather
// than falling back to any pod — means a rollout or crashloop surfaces as a
// clear readiness error instead of an opaque connection reset.
func selectReadyPod(pods []corev1.Pod) string {
	for i := range pods {
		p := &pods[i]
		if p.DeletionTimestamp != nil || p.Status.Phase != corev1.PodRunning {
			continue
		}
		for _, c := range p.Status.Conditions {
			if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
				return p.Name
			}
		}
	}
	return ""
}

func (s *SPDYTransport) restConfig(kubeconfig string) (*rest.Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.configs == nil {
		s.configs = map[string]*rest.Config{}
	}
	if cfg, ok := s.configs[kubeconfig]; ok {
		return cfg, nil
	}

	var (
		cfg *rest.Config
		err error
	)
	if kubeconfig == "" {
		// Ambient default config — the same semantics as the TypeScript
		// kc.loadFromDefault(), including KUBECONFIG, ~/.kube/config, and
		// exec-credential plugins. CI runners rely on this.
		cfg, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
			clientcmd.NewDefaultClientConfigLoadingRules(),
			&clientcmd.ConfigOverrides{},
		).ClientConfig()
	} else {
		cfg, err = clientcmd.RESTConfigFromKubeConfig([]byte(kubeconfig))
	}
	if err != nil {
		return nil, fmt.Errorf("sector7: loading kubeconfig: %w", err)
	}
	s.configs[kubeconfig] = cfg
	return cfg, nil
}

func hostFromConfig(cfg *rest.Config) string {
	u, err := url.Parse(cfg.Host)
	if err != nil || u.Host == "" {
		return cfg.Host
	}
	return u.Host
}
