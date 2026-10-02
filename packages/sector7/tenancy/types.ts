import type * as pulumi from "@pulumi/pulumi";

/**
 * Enforcement level for a generated policy layer.
 *
 * Rolling default-deny onto a cluster that has never had a NetworkPolicy is the
 * single most likely way to cause an outage, because nothing records which
 * flows actually exist. The level is therefore a per-tenant ratchet rather than
 * a boolean:
 *
 * - `"off"`     — nothing is emitted.
 * - `"observe"` — policies are emitted but inert (Cilium `enableDefaultDeny:
 *                 false`), so the intended allow-list is reviewable against real
 *                 Hubble flow data before anything can be dropped.
 * - `"enforce"` — default-deny plus the allow-list.
 *
 * Move a tenant `off` → `observe` → `enforce`. Move the platform tenant last:
 * it owns the namespaces every other tenant depends on.
 */
export type EnforcementLevel = "off" | "observe" | "enforce";

/**
 * Pod Security Admission levels, using PSA's own vocabulary.
 *
 * `audit` and `warn` can run far ahead of `enforce`, which is the whole point —
 * raise `audit` to `restricted` and read the audit log for a few weeks before
 * moving `enforce` past `baseline`.
 */
export interface PodSecuritySpec {
	enforce?: "privileged" | "baseline" | "restricted";
	audit?: "privileged" | "baseline" | "restricted";
	warn?: "privileged" | "baseline" | "restricted";
}

/** A CPU and/or memory amount, in Kubernetes quantity syntax (`"4"`, `"16Gi"`). */
export interface ComputeQuantities {
	cpu?: pulumi.Input<string>;
	memory?: pulumi.Input<string>;
}

/**
 * Aggregate resource ceiling for a tenant, applied per namespace.
 *
 * Deliberately a small, opinionated subset: the goal is a ceiling that stops a
 * runaway workload from starving the cluster, not a chargeback model.
 *
 * CPU and memory have two distinct ceilings, and which one a quota means is
 * spelled at the call site rather than implied:
 *
 * - `requests` → `requests.cpu` / `requests.memory`: the sum of what the
 *   tenant's pods *reserve*. This is the fair-share ceiling — requests are
 *   what the scheduler packs against, so they decide how much shared capacity
 *   a tenant can actually claim. Note it binds on the numbers pods declare, so
 *   it is only as honest as those requests are (CPU rightsizing first).
 * - `limits` → `limits.cpu` / `limits.memory`: the sum of what the tenant's
 *   pods may *burst* to. A separate control with a separate purpose.
 *
 * Either, both, or neither may be set.
 *
 * **A CPU/memory quota requires a {@link LimitsSpec} that defaults it.**
 * Kubernetes rejects every pod that does not declare a resource the namespace
 * quota constrains, so a quota with no `LimitRange` supplying defaults stops
 * new pods from being admitted at all. `Tenant` refuses such a declaration at
 * construction — see {@link resourceEnvelope}.
 */
export interface QuotaSpec {
	/** Ceiling on summed container *requests* — the fair-share form. */
	requests?: ComputeQuantities;
	/** Ceiling on summed container *limits* — the burst form. */
	limits?: ComputeQuantities;
	pods?: pulumi.Input<number>;
	persistentVolumeClaims?: pulumi.Input<number>;
	/**
	 * Escape hatch for anything the fields above do not cover, as raw
	 * `ResourceQuota.spec.hard` keys. A key here that the fields above also
	 * produce is rejected rather than silently overridden, and a CPU/memory key
	 * here (`cpu`, `requests.memory`, …) is held to the same `LimitRange`
	 * requirement as the typed fields.
	 */
	extra?: Record<string, pulumi.Input<string>>;
}

/**
 * Default and maximum container resources applied to a tenant's namespaces via
 * `LimitRange`.
 *
 * Required whenever the effective {@link QuotaSpec} of any owned namespace
 * constrains CPU or memory, and it must default *each* constrained dimension:
 *
 * - a `requests.*` ceiling needs a default request — `defaultRequest`, or
 *   `default` / `max`, which the apiserver copies down into it;
 * - a `limits.*` ceiling needs a default limit — `default`, or `max`.
 *
 * Without that default, every pod that does not declare the resource is
 * rejected outright rather than merely uncounted.
 */
export interface LimitsSpec {
	defaultRequest?: { cpu?: string; memory?: string };
	default?: { cpu?: string; memory?: string };
	max?: { cpu?: string; memory?: string };
}

/**
 * A Role held by a tenant's deployer **inside a namespace the tenant does not
 * own** — how a tenant reaches a shared platform service.
 *
 * This is a first-class field rather than an escape hatch because it is the
 * property that decides the mechanism (ADR 174). Production has three of these
 * today: `pulumi-zeus` holds `cavins-onepassword-portforward` and
 * `cavins-onepassword-token-reader` in `1password`, and `cavins-tailnet-ingress`
 * in `networking`. Neither Capsule's `additionalRoleBindings` nor Rancher
 * Projects can express them — both model a tenant as a set of namespaces it
 * owns.
 */
export interface PlatformGrant {
	/**
	 * Namespace the Role lives in. Owned by the platform, not by the tenant.
	 *
	 * A plain `string` rather than an `Input`, because `(namespace, role)` is the
	 * grant's stable identity and names the generated `RoleBinding` resource.
	 * Naming it from the array position instead would make reordering
	 * `platformGrants` delete and recreate live bindings; naming it from an
	 * `Output` is not possible at all, since Pulumi resource names must be known
	 * before the graph is built.
	 */
	namespace: string;
	/** Name of an existing `Role` in that namespace. */
	role: string;
	/** Why this grant exists. Required — an unexplained grant cannot be audited. */
	reason: string;
}

/**
 * A platform service a tenant may declare in {@link TenantArgs.consumes}.
 *
 * The catalog is supplied by the platform repo rather than hard-coded here:
 * sector7 owns the mechanism, the platform owns the facts about its own
 * services.
 */
export interface PlatformService {
	/** Key used in `Tenant.consumes`. Conventionally the platform stack name. */
	name: string;
	/** Namespace the service runs in. */
	namespace: string;
	/** Pod selector for the egress allow rule. */
	selector: Record<string, string>;
	/** Ports the service is reached on. */
	ports: Array<{ port: number; protocol?: "TCP" | "UDP" }>;
	/**
	 * Contract item keys published to consuming tenants (ADR 173).
	 *
	 * Listed here so that one `consumes` entry drives both the 1Password
	 * contract and the egress allow-list. Maintained separately they drift, and
	 * the drift is silent in the worst direction: the tenant gets the
	 * credentials and not the route, so it fails at runtime looking like a
	 * network fault.
	 */
	contractItems: string[];
}

/**
 * A namespace owned by a tenant. A bare string uses the tenant's defaults.
 */
export type TenantNamespace =
	| string
	| {
			name: string;
			/** Overrides the tenant-level PSA spec for this namespace only. */
			podSecurity?: PodSecuritySpec;
			/** Overrides the tenant-level quota for this namespace only. */
			quota?: QuotaSpec;
	  };

export interface TenantArgs {
	/**
	 * Tenant identifier — the exact GitHub org/user login.
	 *
	 * The same string is the namespace label value, ADR 171's `X-Scope-OrgID`,
	 * and the subject of ADR 170's WIF `assertion.repository` mapping. One
	 * identity vocabulary across every layer, with no translation table.
	 *
	 * Note the hyphen in `room-of-requirement`: the unhyphenated form is the
	 * domain, not the login.
	 */
	id: string;

	/**
	 * Subject bound to this tenant's deployer ClusterRole.
	 *
	 * Today this is a `User` naming an mTLS certificate CN (`pulumi-zeus`), which
	 * authenticates to the apiserver directly. That path survives every add-on
	 * being down, and keeping it is a deliberate rejection of routing tenant
	 * authorization through Rancher (ADR 174, alternative 2).
	 */
	deployer: {
		kind: "User" | "Group" | "ServiceAccount";
		name: pulumi.Input<string>;
		namespace?: pulumi.Input<string>;
	};

	/** ClusterRole granted in every owned namespace. Defaults to `${id}-deployer`. */
	deployerRole?: pulumi.Input<string>;

	/** Namespaces this tenant owns. The platform creates them; tenants do not. */
	namespaces: TenantNamespace[];

	/**
	 * Platform services this tenant depends on, by catalog key.
	 *
	 * Drives the NetworkPolicy egress allow-list and the set of contract items
	 * published to this tenant. See {@link PlatformService.contractItems}.
	 */
	consumes?: string[];

	/** Roles in namespaces this tenant does not own. See {@link PlatformGrant}. */
	platformGrants?: PlatformGrant[];

	/**
	 * Default quota for every owned namespace; a namespace entry may override
	 * it. A CPU/memory ceiling here (or in any override) requires
	 * {@link TenantArgs.limits}.
	 */
	quota?: QuotaSpec;
	/**
	 * Container defaults (`LimitRange`) for every owned namespace. Not to be
	 * confused with {@link QuotaSpec.limits}, the namespace-wide burst ceiling:
	 * this is what makes such a ceiling — or a `requests` one — admissible.
	 */
	limits?: LimitsSpec;
	podSecurity?: PodSecuritySpec;

	/** NetworkPolicy ratchet. Defaults to `"off"`. */
	networkPolicy?: EnforcementLevel;
}
