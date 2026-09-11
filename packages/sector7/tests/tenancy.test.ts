import { describe, expect, it } from "vitest";
import {
	contractItemsFor,
	findUnclaimedNamespaces,
	namespacePolicy,
	type PlatformService,
	resolveConsumes,
	TENANT_LABEL,
	TenancyRegistry,
} from "../tenancy/index.js";

const CATALOG: PlatformService[] = [
	{
		name: "gateway",
		namespace: "networking",
		selector: { "app.kubernetes.io/name": "envoy" },
		ports: [{ port: 443 }],
		contractItems: ["gateway/className", "gateway/sharedGatewayName"],
	},
	{
		name: "postgres",
		namespace: "cnpg",
		selector: { "cnpg.io/cluster": "shared" },
		ports: [{ port: 5432 }],
		contractItems: ["postgres/host", "postgres/port"],
	},
];

describe("resolveConsumes", () => {
	it("resolves declared services", () => {
		expect(resolveConsumes(["gateway"], CATALOG).map((s) => s.name)).toEqual([
			"gateway",
		]);
	});

	it("collapses a repeated key so it cannot double an egress rule", () => {
		expect(
			resolveConsumes(["gateway", "gateway"], CATALOG).map((s) => s.name),
		).toEqual(["gateway"]);
	});

	it("throws on an unknown service rather than dropping it", () => {
		// A silently-dropped dependency yields a tenant with credentials but no
		// route — a runtime failure that reads as a network fault.
		expect(() => resolveConsumes(["nope"], CATALOG)).toThrow(
			/unknown platform service "nope"/,
		);
	});
});

describe("contractItemsFor", () => {
	it("derives the contract from the same list that drives egress", () => {
		expect(
			contractItemsFor(resolveConsumes(["gateway", "postgres"], CATALOG)),
		).toEqual([
			"gateway/className",
			"gateway/sharedGatewayName",
			"postgres/host",
			"postgres/port",
		]);
	});
});

describe("namespacePolicy", () => {
	const base = {
		namespace: "matrix",
		tenantId: "jmmaloney4",
		tenantNamespaces: ["matrix", "media"],
		consumes: CATALOG,
	};

	it("emits nothing when off", () => {
		expect(namespacePolicy({ ...base, level: "off" })).toBeUndefined();
	});

	it("observe mode disables default deny so nothing is dropped", () => {
		const p = namespacePolicy({ ...base, level: "observe" });
		expect(p?.enableDefaultDeny).toEqual({ ingress: false, egress: false });
	});

	it("enforce mode turns default deny on", () => {
		const p = namespacePolicy({ ...base, level: "enforce" });
		expect(p?.enableDefaultDeny).toEqual({ ingress: true, egress: true });
	});

	it("always allows DNS — its absence is the least obvious outage", () => {
		for (const level of ["observe", "enforce"] as const) {
			const p = namespacePolicy({ ...base, level }) as {
				egress: Array<Record<string, unknown>>;
			};
			const dns = p.egress.some((r) => JSON.stringify(r).includes("kube-dns"));
			expect(dns).toBe(true);
		}
	});

	it("observe adds no L7 DNS rule, so it changes nothing in the dataplane", () => {
		// An L7 rule routes DNS through cilium-agent's proxy, which "observe"
		// exists specifically to avoid. It also interacts badly with
		// enableDefaultDeny:false (cilium/cilium#38676).
		const observe = namespacePolicy({ ...base, level: "observe" });
		expect(JSON.stringify(observe)).not.toContain("matchPattern");

		// At enforce the redirect is accepted, and the allow-all pattern is the
		// documented workaround for that same interaction.
		const enforce = namespacePolicy({ ...base, level: "enforce" });
		expect(JSON.stringify(enforce)).toContain('"matchPattern":"*"');
	});

	it("isolates tenants by the namespace label, not by name prefix", () => {
		const p = namespacePolicy({ ...base, level: "enforce" });
		expect(JSON.stringify(p)).toContain(TENANT_LABEL);
		expect(JSON.stringify(p)).toContain("jmmaloney4");
	});

	it("names sibling namespaces explicitly as well as by tenant label", () => {
		// The namespace-label selector alone is not trustworthy: Cilium 1.19's
		// docs say io.cilium.k8s.namespace.labels is ignored in a namespaced
		// CiliumNetworkPolicy while its source suggests otherwise. A peer
		// selector that matches nothing is invisible at "observe", because
		// nothing is dropped there either — so the by-name rule carries it.
		const p = namespacePolicy({ ...base, level: "enforce" }) as {
			ingress: Array<{ fromEndpoints: Array<Record<string, unknown>> }>;
			egress: Array<Record<string, unknown>>;
		};
		const peers = p.ingress[0]?.fromEndpoints ?? [];
		expect(peers).toContainEqual({
			matchLabels: { "k8s:io.kubernetes.pod.namespace": "matrix" },
		});
		expect(peers).toContainEqual({
			matchLabels: { "k8s:io.kubernetes.pod.namespace": "media" },
		});
		expect(JSON.stringify(peers)).toContain(
			`k8s:io.cilium.k8s.namespace.labels.${TENANT_LABEL}`,
		);
		// Same peer set governs egress.
		expect(p.egress[0]).toEqual({ toEndpoints: peers });
	});

	it("does not name another tenant's namespace as a peer", () => {
		const p = namespacePolicy({ ...base, level: "enforce" });
		expect(JSON.stringify(p)).not.toContain("cavins-prod");
	});

	it("opens egress to every consumed service and nothing else", () => {
		const p = namespacePolicy({ ...base, level: "enforce" }) as {
			egress: Array<Record<string, unknown>>;
		};
		const json = JSON.stringify(p.egress);
		expect(json).toContain("cnpg");
		expect(json).toContain("networking");
		expect(json).not.toContain("litellm");
	});
});

describe("findUnclaimedNamespaces", () => {
	const registry = new TenancyRegistry([
		{ id: "jmmaloney4", namespaces: ["matrix", "media"], contractItems: [] },
		{ id: "cavinsresearch", namespaces: ["cavins-prod"], contractItems: [] },
	]);

	it("finds namespaces belonging to no tenant", () => {
		const live = [
			"matrix",
			"media",
			"cavins-prod",
			"codex-proxy",
			"temp-access",
		];
		expect(findUnclaimedNamespaces(live, registry)).toEqual([
			"codex-proxy",
			"temp-access",
		]);
	});

	it("ignores system namespaces by default", () => {
		const live = [
			"matrix",
			"kube-system",
			"cattle-system",
			"fleet-local",
			"p-27r5h",
		];
		expect(findUnclaimedNamespaces(live, registry)).toEqual([]);
	});

	it("reports an owner for a claimed namespace", () => {
		expect(registry.ownerOf("cavins-prod")).toBe("cavinsresearch");
		expect(registry.ownerOf("codex-proxy")).toBeUndefined();
	});
});
