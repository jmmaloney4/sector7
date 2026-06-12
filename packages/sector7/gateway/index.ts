import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// ---------------------------------------------------------------------------
// HTTPRoute — Gateway API route for a service (ADR 040, updated by ADR 075)
// ---------------------------------------------------------------------------

/**
 * Gateway API HTTPRoute rule timeouts (GEP-1742).
 *
 * Values are Gateway API Duration strings (GEP-2257), e.g. "600s", "30m",
 * "1h". "0s" disables the timeout entirely.
 */
export interface HttpRouteTimeouts {
	/**
	 * Maximum time for the gateway to complete the entire request/response
	 * exchange, including streaming the full response body. Envoy's built-in
	 * default is 15s, which silently kills long-running requests (e.g. LLM
	 * completions and SSE streams) — set this explicitly for slow backends.
	 */
	request?: string;
	/**
	 * Timeout for a single gateway-to-backend attempt. Must be <= request.
	 */
	backendRequest?: string;
}

// Gateway API Duration format (GEP-2257): 1-4 groups of <up to 5 digits> +
// unit (h, m, s, ms), e.g. "600s", "1h30m", "0s".
const GATEWAY_API_DURATION = /^([0-9]{1,5}(h|m|s|ms)){1,4}$/;

const DURATION_UNIT_MS: Record<string, number> = {
	h: 3_600_000,
	m: 60_000,
	s: 1_000,
	ms: 1,
};

function gatewayApiDurationToMs(duration: string): number {
	let total = 0;
	for (const match of duration.matchAll(/([0-9]{1,5})(ms|h|m|s)/g)) {
		total += Number(match[1]) * (DURATION_UNIT_MS[match[2] ?? ""] ?? 0);
	}
	return total;
}

export interface ServiceHttpRouteArgs {
	/**
	 * Logical/resource name for the HTTPRoute (e.g. "periscope").
	 * Used as both the Pulumi child name and the Kubernetes resource name.
	 */
	name: string;
	/** Namespace the HTTPRoute lives in (e.g. "cavins-dev"). */
	namespace: pulumi.Input<string>;
	/** Hostnames to match (e.g. ["periscope-dev.mellori-delta.ts.net"]). */
	hostnames: pulumi.Input<pulumi.Input<string>[]>;
	/** Backend Service name to route to. */
	serviceName: pulumi.Input<string>;
	/** Backend Service port. */
	port: number;
	/**
	 * Target Gateway name. Defaults to "public-gateway".
	 *
	 * Per ADR 075 the single shared-gateway was split into separate public and
	 * private gateways.  Omit for the public gateway or set to
	 * "private-gateway" for the private gateway.
	 */
	gatewayName?: string;
	/**
	 * Optional path-prefix match. When set, the route only forwards requests
	 * whose path starts with this prefix (Gateway API `PathPrefix`), instead of
	 * the whole host. Use this to expose a single endpoint publicly (e.g.
	 * "/webhook") rather than every route the backend serves. Omit to match all
	 * paths for the hostname (the default).
	 */
	pathPrefix?: string;
	/**
	 * Optional rule timeouts (GEP-1742). Without this, Envoy applies its
	 * built-in 15s route timeout — any request slower than that is killed with
	 * a 504 ("upstream request timeout") even while actively streaming. Set
	 * `request` generously (e.g. "600s") for LLM/streaming backends.
	 */
	timeouts?: HttpRouteTimeouts;
	/** Kubernetes provider. */
	provider: k8s.Provider;
	/** Resources this HTTPRoute depends on. */
	dependsOn?: pulumi.Input<pulumi.Input<pulumi.Resource>[]>;
}

/**
 * Create a Gateway API HTTPRoute that routes traffic for the given hostnames
 * to a backend Service through the specified gateway.
 *
 * The HTTPRoute is created in the service's namespace and references a Gateway
 * in the "networking" namespace. A corresponding ReferenceGrant must exist —
 * see `createSharedGatewayReferenceGrant()`.
 */
export function createServiceHttpRoute(
	args: ServiceHttpRouteArgs,
): k8s.apiextensions.CustomResource {
	const gatewayName = args.gatewayName ?? "public-gateway";
	// Validate the prefix up front so misconfiguration fails fast (at preview)
	// with a clear message rather than producing an invalid manifest at apply.
	// Note: check `!== undefined`, NOT truthiness — an empty string is invalid,
	// not "match everything" (which would silently expose the whole service).
	if (args.pathPrefix !== undefined && !args.pathPrefix.startsWith("/")) {
		throw new Error(
			`createServiceHttpRoute: pathPrefix must be an absolute path starting with "/" (got ${JSON.stringify(args.pathPrefix)})`,
		);
	}
	// Only emit timeout fields that are actually set — an empty `timeouts: {}`
	// is rejected by the Gateway API CRD at apply time.
	const timeouts = Object.fromEntries(
		Object.entries(args.timeouts ?? {}).filter(([, v]) => v !== undefined),
	) as HttpRouteTimeouts;
	for (const [field, value] of Object.entries(timeouts)) {
		if (!GATEWAY_API_DURATION.test(value)) {
			throw new Error(
				`createServiceHttpRoute: timeouts.${field} must be a Gateway API duration like "600s", "30m", or "0s" (got ${JSON.stringify(value)})`,
			);
		}
	}
	// Gateway API requires backendRequest <= request, except request "0s"
	// (disabled) which lifts the bound. Enforce at preview, not apply.
	if (timeouts.request !== undefined && timeouts.backendRequest !== undefined) {
		const requestMs = gatewayApiDurationToMs(timeouts.request);
		if (
			requestMs > 0 &&
			gatewayApiDurationToMs(timeouts.backendRequest) > requestMs
		) {
			throw new Error(
				`createServiceHttpRoute: timeouts.backendRequest (${timeouts.backendRequest}) must not exceed timeouts.request (${timeouts.request})`,
			);
		}
	}
	return new k8s.apiextensions.CustomResource(
		`${args.name}-route`,
		{
			apiVersion: "gateway.networking.k8s.io/v1",
			kind: "HTTPRoute",
			metadata: {
				name: args.name,
				namespace: args.namespace,
			},
			spec: {
				parentRefs: [
					{
						name: gatewayName,
						namespace: "networking",
					},
				],
				hostnames: args.hostnames,
				rules: [
					{
						...(args.pathPrefix !== undefined
							? {
									matches: [
										{ path: { type: "PathPrefix", value: args.pathPrefix } },
									],
								}
							: {}),
						...(Object.keys(timeouts).length > 0 ? { timeouts } : {}),
						backendRefs: [
							{
								name: args.serviceName,
								port: args.port,
							},
						],
					},
				],
			},
		},
		{
			provider: args.provider,
			dependsOn: args.dependsOn,
		},
	);
}

// ---------------------------------------------------------------------------
// ReferenceGrant — cross-namespace gateway routing permission
// ---------------------------------------------------------------------------

export interface SharedGatewayReferenceGrantArgs {
	/**
	 * Logical/resource name for the ReferenceGrant (e.g. "allow-cavins-dev").
	 * Must be a plain string because the helper derives the Pulumi child name
	 * from it; passing an Output<T> triggers Pulumi's forbidden Output.toString().
	 */
	name: string;
	/** Namespace that the HTTPRoute lives in (e.g. "cavins-dev"). */
	fromNamespace: pulumi.Input<string>;
	/** Kubernetes provider. */
	provider: k8s.Provider;
	/** Resources this ReferenceGrant depends on. */
	dependsOn?: pulumi.Input<pulumi.Input<pulumi.Resource>[]>;
	/**
	 * Target Gateway name. Defaults to "public-gateway".
	 *
	 * Per ADR 075 the single shared-gateway was split into separate public and
	 * private gateways.  Omit for the public gateway or set to
	 * "private-gateway" for the private gateway.
	 */
	gatewayName?: string;
}

/**
 * Create a ReferenceGrant in the "networking" namespace that allows
 * HTTPRoutes in a service namespace to reference a Gateway.
 *
 * Hardcoded conventions:
 *   - Grant is created in the `networking` namespace
 *   - Allows HTTPRoutes from exactly one namespace
 */
export function createSharedGatewayReferenceGrant(
	args: SharedGatewayReferenceGrantArgs,
): k8s.apiextensions.CustomResource {
	const gatewayName = args.gatewayName ?? "public-gateway";
	return new k8s.apiextensions.CustomResource(
		`${args.name}-refgrant`,
		{
			apiVersion: "gateway.networking.k8s.io/v1beta1",
			kind: "ReferenceGrant",
			metadata: {
				name: args.name,
				namespace: "networking",
			},
			spec: {
				from: [
					{
						group: "gateway.networking.k8s.io",
						kind: "HTTPRoute",
						namespace: args.fromNamespace,
					},
				],
				to: [
					{
						group: "gateway.networking.k8s.io",
						kind: "Gateway",
						name: gatewayName,
					},
				],
			},
		},
		{
			provider: args.provider,
			dependsOn: args.dependsOn,
		},
	);
}

// ---------------------------------------------------------------------------
// Tailnet Ingress — per-service Tailscale Ingress via private gateway
// ---------------------------------------------------------------------------

export interface TailnetIngressArgs {
	/** Route name (e.g. "periscope-dev"). */
	name: string;
	/** Namespace for the Ingress. Must be "networking" (where the gateway lives). */
	namespace: pulumi.Input<string>;
	/**
	 * Tailnet hostname prefix (e.g. "periscope-dev").
	 * The Tailscale operator appends the tailnet domain automatically,
	 * producing e.g. "periscope-dev.mellori-delta.ts.net".
	 *
	 * Important: Tailscale Ingress only uses the first DNS label here.
	 * Use a single-label name like "periscope-dev", not a dotted name like
	 * "periscope.dev" (which would be truncated back to "periscope").
	 */
	tailnetHostname: string;
	/**
	 * Private gateway proxy Service URL (e.g.
	 * "http://private-gateway-proxy.networking.svc.cluster.local:80").
	 *
	 * Garden resolves this via StackReference. Other consumers can use
	 * pulumi config or hardcode the stable cluster-internal URL.
	 */
	privateGatewayServiceUrl: string | pulumi.Output<string>;
	/** Kubernetes provider. */
	provider: k8s.Provider;
	/** Resources this Ingress depends on. */
	dependsOn?: pulumi.Input<pulumi.Input<pulumi.Resource>[]>;
}

/**
 * Create a per-service Tailscale Ingress that routes through the private
 * Gateway. The Ingress gets its own MagicDNS name (e.g.
 * `periscope-dev.mellori-delta.ts.net`) but the backend points at the private
 * gateway proxy Service, not the application Service. HTTPRoute hostname
 * matching on the gateway routes traffic to the correct backend.
 *
 * Per ADR 075 Tailnet Ingress always uses the private gateway — there is
 * no `gatewayName` parameter on this function.
 */
export function createTailnetIngress(
	args: TailnetIngressArgs,
): k8s.networking.v1.Ingress {
	const gatewayBackend = pulumi
		.output(args.privateGatewayServiceUrl)
		.apply((urlText) => {
			const url = new URL(urlText);
			const [serviceName] = url.hostname.split(".");
			return {
				name: serviceName,
				port: Number(url.port || "80"),
			};
		});

	return new k8s.networking.v1.Ingress(
		`${args.name}-tailnet`,
		{
			metadata: {
				name: `${args.name}-tailnet`,
				namespace: args.namespace,
				annotations: {
					"tailscale.com/proxy-group": "ingress-proxies",
					"tailscale.com/proxy-group-namespace": "tailscale",
					"tailscale.com/http-redirect": "true",
				},
			},
			spec: {
				ingressClassName: "tailscale",
				tls: [
					{
						hosts: [args.tailnetHostname],
					},
				],
				rules: [
					{
						http: {
							paths: [
								{
									path: "/",
									pathType: "Prefix",
									backend: {
										service: {
											name: gatewayBackend.apply((backend) => backend.name),
											port: {
												number: gatewayBackend.apply((backend) => backend.port),
											},
										},
									},
								},
							],
						},
					},
				],
			},
		},
		{
			provider: args.provider,
			dependsOn: args.dependsOn,
		},
	);
}
