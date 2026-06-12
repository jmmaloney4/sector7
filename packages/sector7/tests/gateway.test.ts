import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";

// We can't run Pulumi inline in unit tests, but we can verify the module
// surface and types are exported correctly without import errors.
import {
	createServiceHttpRoute,
	createSharedGatewayReferenceGrant,
	createTailnetIngress,
	type ServiceHttpRouteArgs,
	type SharedGatewayReferenceGrantArgs,
	type TailnetIngressArgs,
} from "../gateway/index.ts";

describe("gateway module surface", () => {
	it("exports createServiceHttpRoute", () => {
		expect(createServiceHttpRoute).toBeTypeOf("function");
	});

	it("exports createSharedGatewayReferenceGrant", () => {
		expect(createSharedGatewayReferenceGrant).toBeTypeOf("function");
	});

	it("exports createTailnetIngress", () => {
		expect(createTailnetIngress).toBeTypeOf("function");
	});

	it("has correct defaults in ServiceHttpRouteArgs type", () => {
		// Verify the type accepts gatewayName as optional.
		// This is a compile-time check — if it compiles, the interface is correct.
		const args: ServiceHttpRouteArgs = {
			name: "test",
			namespace: "test-ns",
			hostnames: ["test.example.com"],
			serviceName: "test-svc",
			port: 80,
			provider: {} as any,
		};
		expect(args.gatewayName).toBeUndefined();
	});

	it("ServiceHttpRouteArgs accepts an optional pathPrefix", () => {
		const args: ServiceHttpRouteArgs = {
			name: "test",
			namespace: "test-ns",
			hostnames: ["test.example.com"],
			serviceName: "test-svc",
			port: 80,
			pathPrefix: "/webhook",
			provider: {} as any,
		};
		expect(args.pathPrefix).toBe("/webhook");
	});

	it("rejects a pathPrefix without a leading slash", () => {
		expect(() =>
			createServiceHttpRoute({
				name: "t",
				namespace: "ns",
				hostnames: ["h.example.com"],
				serviceName: "svc",
				port: 80,
				pathPrefix: "webhook",
				provider: {} as any,
			}),
		).toThrow(/absolute path/);
	});

	it("rejects an empty pathPrefix (would otherwise match all paths)", () => {
		expect(() =>
			createServiceHttpRoute({
				name: "t",
				namespace: "ns",
				hostnames: ["h.example.com"],
				serviceName: "svc",
				port: 80,
				pathPrefix: "",
				provider: {} as any,
			}),
		).toThrow();
	});

	it("ServiceHttpRouteArgs accepts optional timeouts", () => {
		const args: ServiceHttpRouteArgs = {
			name: "test",
			namespace: "test-ns",
			hostnames: ["test.example.com"],
			serviceName: "test-svc",
			port: 80,
			timeouts: { request: "600s", backendRequest: "600s" },
			provider: {} as any,
		};
		expect(args.timeouts?.request).toBe("600s");
	});

	it("accepts '0s' to disable a timeout", () => {
		const args: ServiceHttpRouteArgs = {
			name: "test",
			namespace: "test-ns",
			hostnames: ["test.example.com"],
			serviceName: "test-svc",
			port: 80,
			timeouts: { request: "0s" },
			provider: {} as any,
		};
		expect(args.timeouts?.request).toBe("0s");
	});

	it("rejects a timeouts.request that is not a Gateway API duration", () => {
		expect(() =>
			createServiceHttpRoute({
				name: "t",
				namespace: "ns",
				hostnames: ["h.example.com"],
				serviceName: "svc",
				port: 80,
				timeouts: { request: "600" },
				provider: {} as any,
			}),
		).toThrow(/Gateway API duration/);
	});

	it("rejects a timeouts.backendRequest that is not a Gateway API duration", () => {
		expect(() =>
			createServiceHttpRoute({
				name: "t",
				namespace: "ns",
				hostnames: ["h.example.com"],
				serviceName: "svc",
				port: 80,
				timeouts: { backendRequest: "ten seconds" },
				provider: {} as any,
			}),
		).toThrow(/Gateway API duration/);
	});

	it("has correct defaults in SharedGatewayReferenceGrantArgs type", () => {
		const args: SharedGatewayReferenceGrantArgs = {
			name: "allow-test",
			fromNamespace: "test-ns",
			provider: {} as any,
		};
		expect(args.gatewayName).toBeUndefined();
	});

	it("TailnetIngressArgs accepts string for privateGatewayServiceUrl", () => {
		const args: TailnetIngressArgs = {
			name: "test",
			namespace: "networking",
			tailnetHostname: "test",
			privateGatewayServiceUrl:
				"http://private-gateway-proxy.networking.svc.cluster.local:80",
			provider: {} as any,
		};
		expect(args.privateGatewayServiceUrl).toBeTypeOf("string");
	});

	it("TailnetIngressArgs accepts Output<string> for privateGatewayServiceUrl", () => {
		const args: TailnetIngressArgs = {
			name: "test",
			namespace: "networking",
			tailnetHostname: "test",
			privateGatewayServiceUrl: pulumi.output("http://example.com:80"),
			provider: {} as any,
		};
		expect(args.privateGatewayServiceUrl).toBeDefined();
	});
});
