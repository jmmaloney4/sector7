// Shared in-process Kubernetes port-forward transport for sector7 dynamic
// resources that must reach a `ClusterIP`-only service from an out-of-cluster
// `pulumi up` — the connection rides the kube-apiserver the deployer already
// authenticates to, so the target needs no tailnet/public ingress.
//
// SERIALIZATION CONTRACT — do not break:
// This module MUST have no top-level runtime `import` statements. Every Node/k8s
// import is a lazy `await import()` *inside* `withPortForward`. Dynamic resource
// providers (e.g. `onepassword/item.ts`, and `litellm/admin.ts` once it adopts
// this) reference `withPortForward` from their provider callbacks; Pulumi
// serializes that closure, capturing this function and its (import-free) module
// scope. A top-level `import * as k8s from "@kubernetes/client-node"` here would
// be pulled into every such closure and break serialization. Keep it lazy.
// `import type` is fine (erased at compile time).

/** Where to open an in-process port-forward. */
export interface PortForwardTarget {
	/** Kubeconfig (YAML). Falls back to the ambient default config when omitted. */
	kubeconfig?: string;
	/** Namespace the target Deployment runs in. */
	namespace: string;
	/** Deployment whose ready pod is forwarded to (selector resolved at runtime). */
	deploymentName: string;
	/** Container port to forward to. */
	port: number;
}

/**
 * Open a short-lived in-process port-forward to a ready pod of `target`'s
 * Deployment, invoke `fn` with a `http://127.0.0.1:<port>` base URL, then tear
 * the forward down. Works wherever kube credentials work (through the
 * apiserver), so the target needs no tailnet/public ingress.
 *
 * The Deployment's pod selector is resolved at runtime (no hardcoded labels),
 * and only a genuinely `Ready` pod is used — never an arbitrary fallback — so a
 * rollout/crashloop surfaces as a clear readiness error rather than opaque
 * connection failures.
 */
export async function withPortForward<T>(
	target: PortForwardTarget,
	fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
	const k8s = await import("@kubernetes/client-node");
	const net = await import("node:net");

	const kc = new k8s.KubeConfig();
	if (target.kubeconfig) {
		kc.loadFromString(target.kubeconfig);
	} else {
		kc.loadFromDefault();
	}

	const apps = kc.makeApiClient(k8s.AppsV1Api);
	const core = kc.makeApiClient(k8s.CoreV1Api);

	const depResp = await apps.readNamespacedDeployment({
		name: target.deploymentName,
		namespace: target.namespace,
	});
	// client-node 1.x returns the body directly; tolerate the 0.x {body} shape.
	// biome-ignore lint/suspicious/noExplicitAny: k8s client response is loosely typed across majors
	const dep: any = (depResp as any)?.body ?? depResp;
	const matchLabels: Record<string, string> =
		dep?.spec?.selector?.matchLabels ?? {};
	const labelSelector = Object.entries(matchLabels)
		.map(([k, v]) => `${k}=${v}`)
		.join(",");
	if (!labelSelector) {
		throw new Error(
			`deployment ${target.namespace}/${target.deploymentName} has no spec.selector.matchLabels`,
		);
	}

	const podResp = await core.listNamespacedPod({
		namespace: target.namespace,
		labelSelector,
	});
	// biome-ignore lint/suspicious/noExplicitAny: k8s client response is loosely typed across majors
	const pods: any[] = ((podResp as any)?.body ?? podResp)?.items ?? [];
	const ready = pods.find(
		// biome-ignore lint/suspicious/noExplicitAny: pod object is loosely typed
		(p: any) =>
			p?.status?.phase === "Running" &&
			(p?.status?.conditions ?? []).some(
				// biome-ignore lint/suspicious/noExplicitAny: condition object is loosely typed
				(c: any) => c?.type === "Ready" && c?.status === "True",
			),
	);
	const podName: string | undefined = ready?.metadata?.name;
	if (!podName) {
		throw new Error(
			`no ready pod found for deployment ${target.namespace}/${target.deploymentName}`,
		);
	}

	const forward = new k8s.PortForward(kc);
	const server = net.createServer((socket) => {
		forward
			.portForward(
				target.namespace,
				podName,
				[target.port],
				socket,
				null,
				socket,
			)
			.catch((err: unknown) =>
				socket.destroy(err instanceof Error ? err : new Error(String(err))),
			);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});

	const address = server.address();
	const localPort =
		address && typeof address === "object" ? address.port : undefined;
	if (!localPort) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error("failed to bind a local port for the port-forward");
	}

	try {
		return await fn(`http://127.0.0.1:${localPort}`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
