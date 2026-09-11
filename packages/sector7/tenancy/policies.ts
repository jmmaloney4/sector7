import type { EnforcementLevel, PlatformService } from "./types.js";

/**
 * Namespace label carrying the owning tenant.
 *
 * Derived from the tenant registry, never authored by hand. It is unforgeable
 * because tenants cannot create namespaces — so nothing a workload controls can
 * set it.
 *
 * Its load-bearing use is here rather than in RBAC: a NetworkPolicy peer needs a
 * runtime predicate over namespaces, which a build-time registry cannot supply.
 */
export const TENANT_LABEL = "tenancy.roomofrequirement.xyz/tenant";

/** Cilium's well-known label for the namespace a pod lives in. */
const NS_LABEL = "k8s:io.kubernetes.pod.namespace";

/**
 * Policy generation is intentionally a set of pure functions over plain data:
 * no Pulumi resources, no cluster access, no `Output`s. That makes the whole
 * policy surface unit-testable, which is the main thing an operator-based
 * mechanism would have cost us.
 */

/**
 * Egress rule allowing DNS to CoreDNS.
 *
 * Separated out because it is the rule whose absence is least obvious and most
 * destructive: with default-deny on and no DNS rule, every name lookup in the
 * namespace fails and the symptom looks nothing like a network policy problem.
 *
 * `l7Visibility` adds the L7 DNS rule, which routes matched DNS through
 * cilium-agent's DNS proxy and surfaces queries in Hubble. It is **off by
 * default and off at `"observe"`** on purpose: an L7 rule is a dataplane
 * change, and `"observe"` exists precisely to make no dataplane change. Its
 * `matchPattern: "*"` is also load-bearing rather than decorative —
 * `enableDefaultDeny: false` does not extend to layer 7, so an L7 rule without
 * an explicit allow-all drops every unmatched query even in a policy that is
 * supposed to be incapable of dropping anything (cilium/cilium#38676).
 */
export function allowDns(options?: {
	l7Visibility?: boolean;
}): Record<string, unknown> {
	return {
		toEndpoints: [
			{ matchLabels: { [NS_LABEL]: "kube-system", "k8s-app": "kube-dns" } },
		],
		toPorts: [
			{
				ports: [
					{ port: "53", protocol: "UDP" },
					{ port: "53", protocol: "TCP" },
				],
				...(options?.l7Visibility
					? { rules: { dns: [{ matchPattern: "*" }] } }
					: {}),
			},
		],
	};
}

/** Egress rule allowing traffic to one platform service the tenant declared. */
export function allowPlatformService(
	svc: PlatformService,
): Record<string, unknown> {
	return {
		toEndpoints: [
			{ matchLabels: { [NS_LABEL]: svc.namespace, ...svc.selector } },
		],
		toPorts: [
			{
				ports: svc.ports.map((p) => ({
					port: String(p.port),
					protocol: p.protocol ?? "TCP",
				})),
			},
		],
	};
}

/**
 * Selector matching every namespace carrying one tenant's label.
 *
 * **Do not rely on this selector alone.** Cilium's 1.19 documentation states
 * that `io.cilium.k8s.namespace.labels` "will be ignored in CiliumNetworkPolicy
 * resources" and is supported only in a `CiliumClusterwideNetworkPolicy`
 * (`Documentation/security/policy/kubernetes.rst`), while 1.19's own
 * `getEndpointSelector` reads as though it works — it skips the implicit
 * same-namespace match exactly when the selector carries this prefix
 * (`pkg/k8s/apis/cilium.io/utils/utils.go`). Docs and source disagree, and a
 * peer selector that silently matches nothing is invisible at `"observe"`,
 * because nothing is dropped there either way. So {@link namespacePolicy} pairs
 * this with explicit per-namespace selectors, which is the only reason the
 * disagreement is safe to leave unresolved.
 */
export function sameTenantEndpoints(tenantId: string): Record<string, unknown> {
	return {
		matchLabels: {
			[`k8s:io.cilium.k8s.namespace.labels.${TENANT_LABEL}`]: tenantId,
		},
	};
}

/** Selector matching every endpoint in one namespace, by name. */
export function namespaceEndpoints(namespace: string): Record<string, unknown> {
	return { matchLabels: { [NS_LABEL]: namespace } };
}

/**
 * Peers a tenant's namespace may talk to within its own tenant: itself, its
 * siblings by name, and — belt and braces — anything carrying the tenant label.
 *
 * The by-name selectors are what actually carry the rule: they use
 * `io.kubernetes.pod.namespace`, whose behaviour in a namespaced
 * CiliumNetworkPolicy is unambiguous. The label selector is kept because it is
 * the form ADR 174 §NetworkPolicy layer 2 specifies and it keeps working for a
 * namespace the registry has not caught up with; see
 * {@link sameTenantEndpoints} for why it cannot be trusted on its own.
 */
export function tenantPeerEndpoints(args: {
	namespace: string;
	tenantId: string;
	tenantNamespaces: string[];
}): Array<Record<string, unknown>> {
	const byName = [
		args.namespace,
		...args.tenantNamespaces.filter((ns) => ns !== args.namespace),
	];
	return [
		...byName.map(namespaceEndpoints),
		sameTenantEndpoints(args.tenantId),
	];
}

export interface NamespacePolicyArgs {
	namespace: string;
	tenantId: string;
	/**
	 * Every namespace this tenant owns, including {@link namespace}. Used to
	 * emit sibling peers by name rather than relying on the namespace-label
	 * selector alone.
	 */
	tenantNamespaces: string[];
	/** Resolved catalog entries for this tenant's `consumes` list. */
	consumes: PlatformService[];
	level: EnforcementLevel;
}

/**
 * The per-namespace policy: layer 1 (default-deny plus allow-list) and layer 2
 * (cross-tenant isolation) in a single object, because Cilium evaluates them
 * together and splitting them would make the allow-list harder to read.
 *
 * Returns `undefined` at level `"off"`.
 *
 * At `"observe"` the rules are emitted with `enableDefaultDeny` false, so the
 * policy selects the endpoints and is visible in Hubble without dropping
 * anything. That is what lets the allow-list be validated against real traffic
 * before enforcement — on a cluster with zero existing policies, the real flow
 * graph is not written down anywhere.
 */
export function namespacePolicy(
	args: NamespacePolicyArgs,
): Record<string, unknown> | undefined {
	if (args.level === "off") return undefined;
	const enforcing = args.level === "enforce";

	// The tenant's own namespaces — this is the cross-tenant boundary, expressed
	// as "mine" rather than as "deny theirs", because Kubernetes and Cilium both
	// allow-list.
	const peers = tenantPeerEndpoints(args);

	return {
		description:
			`tenant ${args.tenantId} — namespace ${args.namespace} ` +
			`(${enforcing ? "enforcing" : "observe-only, default-deny disabled"})`,
		endpointSelector: {},
		enableDefaultDeny: { ingress: enforcing, egress: enforcing },
		ingress: [{ fromEndpoints: peers }],
		egress: [
			{ toEndpoints: peers },
			allowDns({ l7Visibility: enforcing }),
			...args.consumes.map(allowPlatformService),
		],
	};
}

/**
 * Layer 3, from ADR 171 — platform-side, not per-tenant, and the only policy
 * here that is load-bearing for tenancy rather than for blast radius.
 *
 * Loki and Mimir do not authenticate. `auth_enabled: true` means "require the
 * `X-Scope-OrgID` header", not "verify the sender" — so anything that can reach
 * the write port can claim any tenant. This policy, admitting only the Alloy
 * DaemonSets' ServiceAccounts, is what makes tenant attribution unforgeable.
 *
 * Blocked on garden#1844: the ARC runner diag shipper pushes to Loki from inside
 * runner pods where tenant CI runs arbitrary code, and this policy breaks it —
 * which is the point.
 */
export function observabilityIngressPolicy(args: {
	namespace: string;
	alloyServiceAccounts: string[];
	writePorts: Array<{ port: number; protocol?: "TCP" | "UDP" }>;
}): Record<string, unknown> {
	return {
		description: "ADR 171 — only attested Alloy may write telemetry",
		endpointSelector: {},
		enableDefaultDeny: { ingress: true, egress: false },
		ingress: [
			{ fromEndpoints: [namespaceEndpoints(args.namespace)] },
			{
				fromEndpoints: args.alloyServiceAccounts.map((sa) => ({
					matchLabels: { "k8s:io.cilium.k8s.policy.serviceaccount": sa },
				})),
				toPorts: [
					{
						ports: args.writePorts.map((p) => ({
							port: String(p.port),
							protocol: p.protocol ?? "TCP",
						})),
					},
				],
			},
		],
	};
}

/**
 * Resolve a tenant's `consumes` keys against the platform catalog.
 *
 * Throws on an unknown key rather than skipping it. A silently-dropped
 * dependency produces a tenant that has the credentials for a service but no
 * route to it — a runtime failure that reads as a network fault, which is
 * exactly the drift this coupling exists to prevent.
 */
export function resolveConsumes(
	consumes: string[] | undefined,
	catalog: PlatformService[],
): PlatformService[] {
	if (!consumes?.length) return [];
	const byName = new Map(catalog.map((s) => [s.name, s]));
	// De-duplicated so a repeated key cannot produce a duplicate egress rule.
	return [...new Set(consumes)].map((name) => {
		const svc = byName.get(name);
		if (!svc) {
			throw new Error(
				`unknown platform service "${name}" in consumes; ` +
					`catalog has: ${[...byName.keys()].sort().join(", ")}`,
			);
		}
		return svc;
	});
}

/**
 * Contract item keys a tenant should receive, derived from the same `consumes`
 * list that produced its egress rules (ADR 173's contract table).
 */
export function contractItemsFor(services: PlatformService[]): string[] {
	return [...new Set(services.flatMap((s) => s.contractItems))].sort();
}
