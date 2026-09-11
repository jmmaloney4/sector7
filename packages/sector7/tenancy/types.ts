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

/**
 * Aggregate resource ceiling for a tenant, applied per namespace.
 *
 * Deliberately a small, opinionated subset: the goal is a ceiling that stops a
 * runaway workload from starving the cluster, not a chargeback model.
 */
export interface QuotaSpec {
	cpu?: pulumi.Input<string>;
	memory?: pulumi.Input<string>;
	pods?: pulumi.Input<number>;
	persistentVolumeClaims?: pulumi.Input<number>;
	/** Escape hatch for anything the fields above do not cover. */
	extra?: Record<string, pulumi.Input<string>>;
}

/**
 * Default and maximum container resources applied to a tenant's namespaces via
 * `LimitRange`. Without this, a quota is enforceable only against pods that
 * already declare requests.
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

	quota?: QuotaSpec;
	limits?: LimitsSpec;
	podSecurity?: PodSecuritySpec;

	/** NetworkPolicy ratchet. Defaults to `"off"`. */
	networkPolicy?: EnforcementLevel;
}
