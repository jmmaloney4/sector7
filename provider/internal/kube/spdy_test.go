package kube

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func pod(name string, phase corev1.PodPhase, ready bool, terminating bool) corev1.Pod {
	p := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Status:     corev1.PodStatus{Phase: phase},
	}
	if terminating {
		now := metav1.Now()
		p.DeletionTimestamp = &now
	}
	status := corev1.ConditionFalse
	if ready {
		status = corev1.ConditionTrue
	}
	p.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: status}}
	return p
}

// Mirrors the pod-selection predicate in packages/sector7/k8s/port-forward.ts
// (the `pods.find(...)` at the heart of withPortForward).
func TestSelectReadyPod(t *testing.T) {
	for _, tc := range []struct {
		name string
		pods []corev1.Pod
		want string
	}{
		{
			// The subtle one. A terminating pod keeps reporting Ready while it
			// drains, so a naive Running+Ready check forwards to a connection
			// that is about to die.
			name: "skips a terminating pod even though it is Running and Ready",
			pods: []corev1.Pod{
				pod("dying", corev1.PodRunning, true, true),
				pod("live", corev1.PodRunning, true, false),
			},
			want: "live",
		},
		{
			name: "skips a Running pod whose Ready condition is False",
			pods: []corev1.Pod{
				pod("starting", corev1.PodRunning, false, false),
				pod("live", corev1.PodRunning, true, false),
			},
			want: "live",
		},
		{
			name: "skips pods that are not Running",
			pods: []corev1.Pod{
				pod("pending", corev1.PodPending, true, false),
				pod("succeeded", corev1.PodSucceeded, true, false),
				pod("live", corev1.PodRunning, true, false),
			},
			want: "live",
		},
		{
			name: "returns the first match, not an arbitrary one",
			pods: []corev1.Pod{
				pod("first", corev1.PodRunning, true, false),
				pod("second", corev1.PodRunning, true, false),
			},
			want: "first",
		},
		{
			// Never fall back to an arbitrary pod: the caller turns "" into a
			// clear readiness error, so a rollout or crashloop is diagnosable
			// instead of surfacing as a connection reset.
			name: "returns empty when nothing is ready",
			pods: []corev1.Pod{
				pod("dying", corev1.PodRunning, true, true),
				pod("starting", corev1.PodRunning, false, false),
			},
			want: "",
		},
		{
			name: "returns empty for no pods at all",
			pods: nil,
			want: "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := selectReadyPod(tc.pods); got != tc.want {
				t.Fatalf("selectReadyPod = %q, want %q", got, tc.want)
			}
		})
	}
}
