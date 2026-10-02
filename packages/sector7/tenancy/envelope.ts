import * as pulumi from "@pulumi/pulumi";
import type { ComputeQuantities, LimitsSpec, QuotaSpec } from "./types.js";

/** `LimitRange.spec` as the tenancy component emits it. */
export interface TenantLimitRangeSpec {
	limits: Array<{
		type: "Container";
		defaultRequest?: { cpu?: string; memory?: string };
		default?: { cpu?: string; memory?: string };
		max?: { cpu?: string; memory?: string };
	}>;
}

/**
 * The resource envelope of one tenant namespace: the `ResourceQuota` and
 * `LimitRange` it gets, produced together so that neither can be emitted in a
 * shape the other does not admit.
 */
export interface ResourceEnvelope {
	/** `ResourceQuota.spec.hard`; absent when the namespace has no quota. */
	quotaHard?: Record<string, pulumi.Input<string>>;
	/** `LimitRange.spec`; absent when the tenant declares no {@link LimitsSpec}. */
	limitRange?: TenantLimitRangeSpec;
}

export interface ResourceEnvelopeArgs {
	tenantId: string;
	namespace: string;
	/** The namespace's effective quota (its override, else the tenant's). */
	quota?: QuotaSpec;
	limits?: LimitsSpec;
}

type ComputeResource = keyof ComputeQuantities;
type ContainerField = "request" | "limit";

/**
 * Quota keys that force every container to declare a resource, and which
 * declaration each one forces.
 *
 * This is the apiserver's quota pod evaluator's own list, not a judgement:
 * only `cpu`/`memory` in their bare, `requests.` and `limits.` forms carry the
 * declare-or-be-rejected rule (bare `cpu` is an alias for `requests.cpu`).
 * Other compute resources, `ephemeral-storage` included, are counted without
 * being made mandatory.
 */
const DECLARATION_FORCING_KEY = /^(?:(requests|limits)\.)?(cpu|memory)$/;

function forcedDeclaration(
	key: string,
): { field: ContainerField; resource: ComputeResource } | undefined {
	const m = DECLARATION_FORCING_KEY.exec(key);
	if (!m) return undefined;
	return {
		field: m[1] === "limits" ? "limit" : "request",
		resource: m[2] as ComputeResource,
	};
}

/**
 * Whether `limits` makes the LimitRanger admission plugin fill in `field` for
 * `resource` on a container that omits it.
 *
 * Follows the apiserver's `LimitRangeItem` defaulting rather than the literal
 * fields: an unset `default` is filled from `max`, and an unset
 * `defaultRequest` from `default`. So `max` alone defaults both, and `default`
 * alone defaults the request as well as the limit.
 */
function limitRangeDefaults(
	limits: LimitsSpec | undefined,
	field: ContainerField,
	resource: ComputeResource,
): boolean {
	if (!limits) return false;
	const limit =
		limits.default?.[resource] !== undefined ||
		limits.max?.[resource] !== undefined;
	if (field === "limit") return limit;
	return limit || limits.defaultRequest?.[resource] !== undefined;
}

function remedyFor(field: ContainerField, resource: ComputeResource): string {
	return field === "limit"
		? `limits.default.${resource} or limits.max.${resource}`
		: `limits.defaultRequest.${resource}, limits.default.${resource} or limits.max.${resource}`;
}

/**
 * Generate one tenant namespace's `ResourceQuota` and `LimitRange` from the
 * tenant declaration, or throw if the pair would stop pods being admitted.
 *
 * This is the only place either object's spec is produced. A quota that
 * constrains CPU or memory is refused unless the `LimitRange` defaults every
 * constrained dimension, because Kubernetes rejects every pod that omits a
 * resource the namespace quota constrains — the failure would otherwise
 * surface as the first pod that fails to schedule, in some other stack, long
 * after this declaration was applied.
 *
 * Also refused, because each would silently produce a different quota than the
 * one written: a `QuotaSpec` carrying the removed top-level `cpu`/`memory`
 * fields (they used to mean `limits.*`; a config-loaded object would drop
 * them without a type error), and an `extra` key that a typed field also sets.
 *
 * Why a construction-time check rather than a type: per-dimension coverage
 * (a `requests.memory` ceiling with only CPU defaults) and keys arriving
 * through `extra` cannot be expressed in the type, and a coarse type-level
 * rule alongside this one would be two mechanisms for a single invariant.
 */
export function resourceEnvelope(args: ResourceEnvelopeArgs): ResourceEnvelope {
	const { tenantId, namespace, quota, limits } = args;
	const where = `tenant "${tenantId}", namespace "${namespace}"`;
	const limitRange: TenantLimitRangeSpec | undefined = limits
		? {
				limits: [
					{
						type: "Container",
						defaultRequest: limits.defaultRequest,
						default: limits.default,
						max: limits.max,
					},
				],
			}
		: undefined;
	if (!quota) return { limitRange };

	for (const removed of ["cpu", "memory"] as const) {
		if ((quota as Record<string, unknown>)[removed] !== undefined) {
			throw new Error(
				`${where}: QuotaSpec.${removed} no longer exists — it used to mean ` +
					`limits.${removed}. Say which ceiling you mean: ` +
					`quota.requests.${removed} (fair-share, what pods reserve) or ` +
					`quota.limits.${removed} (burst, what pods may use).`,
			);
		}
	}

	const typed: Record<string, pulumi.Input<string>> = {};
	for (const resource of ["cpu", "memory"] as const) {
		const req = quota.requests?.[resource];
		if (req !== undefined) typed[`requests.${resource}`] = req;
		const lim = quota.limits?.[resource];
		if (lim !== undefined) typed[`limits.${resource}`] = lim;
	}
	if (quota.pods !== undefined) {
		typed.pods = pulumi.output(quota.pods).apply(String);
	}
	if (quota.persistentVolumeClaims !== undefined) {
		typed.persistentvolumeclaims = pulumi
			.output(quota.persistentVolumeClaims)
			.apply(String);
	}

	const extra = quota.extra ?? {};
	const clashes = Object.keys(extra).filter((k) => Object.hasOwn(typed, k));
	if (clashes.length > 0) {
		throw new Error(
			`${where}: quota.extra sets ${clashes.join(", ")}, which the typed ` +
				`QuotaSpec fields also set. Declare each quota key once.`,
		);
	}
	const hard = { ...extra, ...typed };

	const uncovered = Object.keys(hard)
		.sort()
		.flatMap((key) => {
			const forced = forcedDeclaration(key);
			if (!forced || limitRangeDefaults(limits, forced.field, forced.resource))
				return [];
			return [
				`${key} (needs a default container ${forced.resource} ${forced.field}: ` +
					`set ${remedyFor(forced.field, forced.resource)})`,
			];
		});
	if (uncovered.length > 0) {
		throw new Error(
			`${where}: the quota constrains ${uncovered.join("; ")}, but the ` +
				`tenant's LimitRange (TenantArgs.limits) does not default it. ` +
				`Kubernetes rejects every pod that does not declare a resource its ` +
				`namespace quota constrains, so this quota would stop such pods from ` +
				`being admitted at all.`,
		);
	}

	return { quotaHard: hard, limitRange };
}
