// Shared in-process Kubernetes port-forward transport for sector7 dynamic
// resources that must reach a `ClusterIP`-only service from an out-of-cluster
// `pulumi up` — the connection rides the kube-apiserver the deployer already
// authenticates to, so the target needs no tailnet/public ingress.
//
// SERIALIZATION CONTRACT — do not break:
// This module MUST have no top-level *runtime* `import` of heavy third-party
// packages. Pulumi serializes the provider callbacks that reference
// `withPortForward` and re-evaluates them from the *consuming* workspace's
// working directory — not from sector7's installed location. Under pnpm strict
// isolation, a lazy `await import("@kubernetes/client-node")` in that context
// resolves against the consumer's `node_modules`, where the package does NOT
// exist, so the import fails (`Cannot find package '@kubernetes/client-node'`).
//
// To stay resolvable in any consumer context we pre-resolve the absolute path
// to the package here, at module load, using a `require` scoped to *this* file
// (sector7's own installed location). The result is a plain string that Pulumi's
// closure serializer captures as a free variable — the same mechanism that
// already carries module-level consts into serialized functions. `import()`
// with an absolute path then loads the package directly, bypassing the
// consumer's module resolution entirely. `node:module` is a Node built-in, so
// importing it at the top level does not violate the "no heavy third-party
// imports" rule.

import { createRequire } from "node:module";
import type { Socket } from "node:net";

// Pre-resolved at module load. The resolved path string is captured by Pulumi's
// closure serializer; see the SERIALIZATION CONTRACT above.
const require_ = createRequire(import.meta.url);
const k8sClientNodePath = require_.resolve("@kubernetes/client-node");

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

/** A Kubernetes label selector (the `spec.selector` of a Deployment). */
export interface LabelSelector {
	matchLabels?: Record<string, string>;
	matchExpressions?: Array<{
		key?: string;
		operator?: string;
		values?: string[];
	}>;
}

/**
 * Render a Deployment `spec.selector` into a Kubernetes label-selector query
 * string, honoring both `matchLabels` and set-based `matchExpressions`
 * (`In`/`NotIn`/`Exists`/`DoesNotExist`). Returns `""` when the selector is
 * empty/unusable.
 */
export function buildLabelSelector(
	selector: LabelSelector | undefined,
): string {
	const labelParts = Object.entries(selector?.matchLabels ?? {}).map(
		([k, v]) => `${k}=${v}`,
	);
	const exprParts = (selector?.matchExpressions ?? []).flatMap((e) => {
		if (!e?.key || !e?.operator) return [];
		switch (e.operator) {
			case "In":
				return [`${e.key} in (${(e.values ?? []).join(",")})`];
			case "NotIn":
				return [`${e.key} notin (${(e.values ?? []).join(",")})`];
			case "Exists":
				return [e.key];
			case "DoesNotExist":
				return [`!${e.key}`];
			default:
				return [];
		}
	});
	return [...labelParts, ...exprParts].join(",");
}

/**
 * Open a short-lived in-process port-forward to a ready pod of `target`'s
 * Deployment, invoke `fn` with a `http://127.0.0.1:<port>` base URL, then tear
 * the forward down. Works wherever kube credentials work (through the
 * apiserver), so the target needs no tailnet/public ingress.
 *
 * The Deployment's pod selector is resolved at runtime (no hardcoded labels),
 * and only a genuinely `Ready`, non-terminating pod is used — never an arbitrary
 * fallback — so a rollout/crashloop surfaces as a clear readiness error rather
 * than opaque connection failures.
 */
export async function withPortForward<T>(
	target: PortForwardTarget,
	fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
	const k8s = await import(k8sClientNodePath);
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
	const labelSelector = buildLabelSelector(dep?.spec?.selector);
	if (!labelSelector) {
		throw new Error(
			`deployment ${target.namespace}/${target.deploymentName} has no usable spec.selector (matchLabels/matchExpressions)`,
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
			// Skip pods already terminating — they can still report Ready while
			// shutting down, which would forward to a doomed connection.
			!p?.metadata?.deletionTimestamp &&
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
	// Track accepted sockets so we can destroy them on cleanup. `server.close()`
	// only stops accepting new connections; it waits for existing ones to end.
	// Node's `fetch` (undici) keeps connections alive in a pool, so without an
	// explicit teardown the forward — and this function — can hang after `fn`.
	const sockets = new Set<Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
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
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
