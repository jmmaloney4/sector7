import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
	contractItemsFor,
	namespacePolicy,
	resolveConsumes,
	TENANT_LABEL,
} from "./policies.js";
import type {
	PlatformService,
	PodSecuritySpec,
	QuotaSpec,
	TenantArgs,
} from "./types.js";

const CILIUM_API = "cilium.io/v2";

function psaLabels(spec: PodSecuritySpec | undefined): Record<string, string> {
	if (!spec) return {};
	const out: Record<string, string> = {};
	if (spec.enforce) out["pod-security.kubernetes.io/enforce"] = spec.enforce;
	if (spec.audit) out["pod-security.kubernetes.io/audit"] = spec.audit;
	if (spec.warn) out["pod-security.kubernetes.io/warn"] = spec.warn;
	return out;
}

function quotaHard(spec: QuotaSpec): Record<string, pulumi.Input<string>> {
	const hard: Record<string, pulumi.Input<string>> = { ...(spec.extra ?? {}) };
	if (spec.cpu !== undefined) hard["limits.cpu"] = spec.cpu;
	if (spec.memory !== undefined) hard["limits.memory"] = spec.memory;
	if (spec.pods !== undefined)
		hard.pods = pulumi.output(spec.pods).apply(String);
	if (spec.persistentVolumeClaims !== undefined) {
		hard.persistentvolumeclaims = pulumi
			.output(spec.persistentVolumeClaims)
			.apply(String);
	}
	return hard;
}

export interface TenantComponentArgs extends TenantArgs {
	/**
	 * Platform service catalog used to resolve {@link TenantArgs.consumes}.
	 *
	 * Supplied by the platform repo. sector7 owns the mechanism; the platform
	 * owns the facts about its own services.
	 */
	catalog?: PlatformService[];
}

/**
 * One tenant's entire in-cluster footprint, generated from a single declaration.
 *
 * Per owned namespace: the `Namespace` with its tenant and PSA labels, a
 * `RoleBinding` to the tenant's deployer ClusterRole, a `ResourceQuota`, a
 * `LimitRange`, and the CiliumNetworkPolicy for the current enforcement level.
 * Per tenant: one `RoleBinding` for each {@link TenantArgs.platformGrants} entry,
 * in a namespace the tenant does not own.
 *
 * Namespaces are created here, by the platform — never by the tenant. That is
 * what makes the tenant label unforgeable without an admission webhook.
 *
 * @example
 * ```ts
 * const jmm = new Tenant("jmmaloney4", {
 *   id: "jmmaloney4",
 *   deployer: { kind: "User", name: "pulumi-jmm" },
 *   namespaces: ["matrix", "media", "ergon-prod"],
 *   consumes: ["gateway", "postgres", "litellm"],
 *   platformGrants: [
 *     { namespace: "1password", role: "onepassword-token-reader",
 *       reason: "reads its own Connect token" },
 *   ],
 *   quota: { cpu: "40", memory: "96Gi", pods: 200 },
 *   podSecurity: { enforce: "baseline", audit: "restricted" },
 *   networkPolicy: "observe",
 *   catalog: PLATFORM_SERVICES,
 * }, { provider });
 * ```
 */
export class Tenant extends pulumi.ComponentResource {
	/** Names of the namespaces this tenant owns. */
	public readonly namespaceNames: string[];
	/** Contract item keys the platform must publish to this tenant (ADR 173). */
	public readonly contractItems: string[];
	/** The tenant id, echoed for consumers that hold only the component. */
	public readonly id: string;

	constructor(
		name: string,
		args: TenantComponentArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("sector7:kubernetes:Tenant", name, {}, opts);

		const level = args.networkPolicy ?? "off";
		const deployerRole = args.deployerRole ?? `${args.id}-deployer`;
		const services = resolveConsumes(args.consumes, args.catalog ?? []);

		this.id = args.id;
		this.contractItems = contractItemsFor(services);
		this.namespaceNames = args.namespaces.map((n) =>
			typeof n === "string" ? n : n.name,
		);
		// A repeated namespace would otherwise collide on the generated Pulumi
		// resource names and fail deep inside the engine with a URN error that
		// names neither the tenant nor the namespace.
		const duplicate = this.namespaceNames.find(
			(ns, i) => this.namespaceNames.indexOf(ns) !== i,
		);
		if (duplicate !== undefined) {
			throw new Error(
				`tenant "${args.id}" lists namespace "${duplicate}" more than once`,
			);
		}

		// Kubernetes requires a namespace on a ServiceAccount RBAC subject. Without
		// this guard the binding is generated with `namespace: undefined`, which the
		// apiserver rejects — so a valid-looking tenant declaration fails at deploy
		// time with an RBAC error rather than here, at the point of the mistake.
		if (
			args.deployer.kind === "ServiceAccount" &&
			args.deployer.namespace === undefined
		) {
			throw new Error(
				`tenant "${args.id}": deployer.namespace is required when deployer.kind ` +
					`is "ServiceAccount" — a ServiceAccount subject is namespaced.`,
			);
		}

		const subject = {
			kind: args.deployer.kind,
			name: args.deployer.name,
			...(args.deployer.kind === "ServiceAccount"
				? { namespace: args.deployer.namespace }
				: { apiGroup: "rbac.authorization.k8s.io" }),
		};

		for (const entry of args.namespaces) {
			const nsName = typeof entry === "string" ? entry : entry.name;
			const podSecurity =
				typeof entry === "string"
					? args.podSecurity
					: (entry.podSecurity ?? args.podSecurity);
			const quota =
				typeof entry === "string" ? args.quota : (entry.quota ?? args.quota);

			const ns = new k8s.core.v1.Namespace(
				`${name}-ns-${nsName}`,
				{
					metadata: {
						name: nsName,
						labels: { [TENANT_LABEL]: args.id, ...psaLabels(podSecurity) },
					},
				},
				{ parent: this },
			);
			const inNamespace = { parent: ns, dependsOn: [ns] };

			new k8s.rbac.v1.RoleBinding(
				`${name}-deployer-${nsName}`,
				{
					metadata: { name: `${args.id}-deployer`, namespace: nsName },
					roleRef: {
						apiGroup: "rbac.authorization.k8s.io",
						kind: "ClusterRole",
						name: deployerRole,
					},
					subjects: [subject],
				},
				inNamespace,
			);

			if (quota) {
				new k8s.core.v1.ResourceQuota(
					`${name}-quota-${nsName}`,
					{
						metadata: { name: `${args.id}-quota`, namespace: nsName },
						spec: { hard: quotaHard(quota) },
					},
					inNamespace,
				);
			}

			if (args.limits) {
				new k8s.core.v1.LimitRange(
					`${name}-limits-${nsName}`,
					{
						metadata: { name: `${args.id}-limits`, namespace: nsName },
						spec: {
							limits: [
								{
									type: "Container",
									defaultRequest: args.limits.defaultRequest,
									default: args.limits.default,
									max: args.limits.max,
								},
							],
						},
					},
					inNamespace,
				);
			}

			const policy = namespacePolicy({
				namespace: nsName,
				tenantId: args.id,
				tenantNamespaces: this.namespaceNames,
				consumes: services,
				level,
			});
			if (policy) {
				new k8s.apiextensions.CustomResource(
					`${name}-netpol-${nsName}`,
					{
						apiVersion: CILIUM_API,
						kind: "CiliumNetworkPolicy",
						metadata: { name: `${args.id}-tenancy`, namespace: nsName },
						spec: policy,
					},
					inNamespace,
				);
			}
		}

		// Platform grants: Roles inside namespaces this tenant does NOT own. The
		// Role itself is owned by the platform stack that owns that namespace —
		// this only binds the tenant to it, so a missing Role is a loud failure
		// rather than a silent over-grant.
		const seenGrants = new Set<string>();
		const owned = new Set(this.namespaceNames);
		for (const grant of args.platformGrants ?? []) {
			// A grant into a namespace the tenant already owns is a contradiction,
			// not a shortcut: the deployer ClusterRole already covers that
			// namespace, so the only thing an extra binding can do is widen access
			// to some other Role — quietly, and outside the deployer role that the
			// rest of the model reasons about. Reject it rather than materialise it.
			if (owned.has(grant.namespace)) {
				throw new Error(
					`platformGrant targets "${grant.namespace}", which tenant "${args.id}" ` +
						`already owns. Platform grants are for namespaces the tenant does NOT ` +
						`own; widen the deployer ClusterRole instead.`,
				);
			}
			// Keyed by what the grant *is* — never by where it sits in the array.
			// An index-derived resource name turns a reorder of `platformGrants`
			// into a delete-and-recreate of live RoleBindings.
			const slug = `${grant.namespace}-${grant.role}`;
			if (seenGrants.has(slug)) {
				throw new Error(
					`tenant "${args.id}" declares the platform grant ` +
						`${grant.role} in ${grant.namespace} more than once`,
				);
			}
			seenGrants.add(slug);

			new k8s.rbac.v1.RoleBinding(
				`${name}-grant-${slug}`,
				{
					metadata: {
						name: `${args.id}-${grant.role}`,
						namespace: grant.namespace,
						annotations: {
							"tenancy.roomofrequirement.xyz/reason": grant.reason,
							"tenancy.roomofrequirement.xyz/grant": slug,
						},
					},
					roleRef: {
						apiGroup: "rbac.authorization.k8s.io",
						kind: "Role",
						name: grant.role,
					},
					subjects: [subject],
				},
				{ parent: this },
			);
		}

		this.registerOutputs({
			id: this.id,
			namespaceNames: this.namespaceNames,
			contractItems: this.contractItems,
		});
	}
}
