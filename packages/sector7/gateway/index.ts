import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// ---------------------------------------------------------------------------
// HTTPRoute — Gateway API route for a service (ADR 040, updated by ADR 075)
// ---------------------------------------------------------------------------

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
						...(args.pathPrefix
							? {
									matches: [
										{ path: { type: "PathPrefix", value: args.pathPrefix } },
									],
								}
							: {}),
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
