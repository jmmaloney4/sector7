import type { PlatformService } from "./types.js";

/**
 * Registry-level view over the configured tenants.
 *
 * Deliberately *not* a `ComponentResource`: it owns no cluster objects. Each
 * {@link Tenant} owns its own, and this is the data the platform needs *about*
 * them — what to publish into each tenant's 1Password vault, and what the
 * boundary claims to cover so a check can test that claim.
 */
export interface TenancyRegistryEntry {
	id: string;
	namespaces: string[];
	contractItems: string[];
}

export class TenancyRegistry {
	public readonly tenants: TenancyRegistryEntry[];
	public readonly catalog: PlatformService[];

	constructor(
		tenants: TenancyRegistryEntry[],
		catalog: PlatformService[] = [],
	) {
		this.tenants = tenants;
		this.catalog = catalog;
	}

	/** Every namespace claimed by some tenant. */
	get claimedNamespaces(): string[] {
		return this.tenants.flatMap((t) => t.namespaces).sort();
	}

	/** Contract items to publish per tenant vault (ADR 173). */
	get contract(): Record<string, string[]> {
		return Object.fromEntries(this.tenants.map((t) => [t.id, t.contractItems]));
	}

	/** Tenant owning a namespace, or `undefined` if unclaimed. */
	ownerOf(namespace: string): string | undefined {
		return this.tenants.find((t) => t.namespaces.includes(namespace))?.id;
	}
}

/**
 * Namespaces that exist in the cluster but belong to no tenant.
 *
 * ADR 171's default is that an unregistered namespace falls to the platform
 * tenant and is operator-visible only. That is safe but **silent**, and silence
 * is how `codex-proxy`, `temp-access` and `user-4bzmx` came to exist with no
 * Pulumi project behind them.
 *
 * This takes the live namespace list as an argument rather than reading the
 * cluster, because the Pulumi Kubernetes provider has no generic list
 * operation — the caller is a CI check feeding it `kubectl get ns` output, not
 * a stack. Keeping it a pure function is also what makes it testable.
 *
 * @param live - namespace names currently in the cluster
 * @param registry - the configured tenancy
 * @param ignore - namespaces that are legitimately outside tenancy (e.g. `kube-*`)
 */
export function findUnclaimedNamespaces(
	live: string[],
	registry: TenancyRegistry,
	ignore: RegExp[] = [
		/^kube-/,
		/^cattle-/,
		/^fleet-/,
		/^cluster-fleet-/,
		/^p-[a-z0-9]+$/,
	],
): string[] {
	return live
		.filter((ns) => !ignore.some((re) => re.test(ns)))
		.filter((ns) => registry.ownerOf(ns) === undefined)
		.sort();
}
