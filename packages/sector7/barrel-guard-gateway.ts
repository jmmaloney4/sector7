// Gateway helpers live on the ./gateway sub-path, not in the main barrel.
// If someone adds them here, tsc will flag the unused @ts-expect-error.

// @ts-expect-error — gateway exports live on ./gateway sub-path
export type {
	ServiceHttpRouteArgs,
	SharedGatewayReferenceGrantArgs,
	TailnetIngressArgs,
} from "./gateway/index.ts";

// @ts-expect-error — gateway exports live on ./gateway sub-path
export {
	createServiceHttpRoute,
	createSharedGatewayReferenceGrant,
	createTailnetIngress,
} from "./gateway/index.ts";
