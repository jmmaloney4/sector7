export {
	allowDns,
	allowPlatformService,
	contractItemsFor,
	type NamespacePolicyArgs,
	namespaceEndpoints,
	namespacePolicy,
	observabilityIngressPolicy,
	resolveConsumes,
	sameTenantEndpoints,
	TENANT_LABEL,
	tenantPeerEndpoints,
} from "./policies.js";
export {
	findUnclaimedNamespaces,
	TenancyRegistry,
	type TenancyRegistryEntry,
} from "./tenancy.js";
export { Tenant, type TenantComponentArgs } from "./tenant.js";
export type {
	EnforcementLevel,
	LimitsSpec,
	PlatformGrant,
	PlatformService,
	PodSecuritySpec,
	QuotaSpec,
	TenantArgs,
	TenantNamespace,
} from "./types.js";
