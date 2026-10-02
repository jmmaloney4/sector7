import * as pulumi from "@pulumi/pulumi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	contractItemsFor,
	findUnclaimedNamespaces,
	namespacePolicy,
	observabilityIngressPolicy,
	type PlatformService,
	resolveConsumes,
	resourceEnvelope,
	TENANT_LABEL,
	TenancyRegistry,
	Tenant,
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

	it("catches a namespace claimed by two tenants", () => {
		// ownerOf answers with the first match, so a double claim is invisible
		// to it and to the unclaimed check — but in the cluster it means two
		// deployer RoleBindings and two tenant labels racing on apply order.
		const clash = new TenancyRegistry([
			{ id: "jmmaloney4", namespaces: ["matrix", "shared"], contractItems: [] },
			{ id: "cavinsresearch", namespaces: ["shared"], contractItems: [] },
		]);
		expect(clash.conflictingClaims).toEqual([
			{ namespace: "shared", tenants: ["jmmaloney4", "cavinsresearch"] },
		]);
		expect(registry.conflictingClaims).toEqual([]);
	});

	it("reports an owner for a claimed namespace", () => {
		expect(registry.ownerOf("cavins-prod")).toBe("cavinsresearch");
		expect(registry.ownerOf("codex-proxy")).toBeUndefined();
	});
});

describe("observabilityIngressPolicy", () => {
	const policy = observabilityIngressPolicy({
		namespace: "observability",
		alloyServiceAccounts: [
			{ namespace: "observability", name: "alloy-logs" },
			{ namespace: "kube-system", name: "alloy-metrics" },
		],
		writePorts: [{ port: 3100 }],
	});

	it("names each Alloy ServiceAccount's namespace", () => {
		// A fromEndpoints selector that mentions no namespace gets the policy's
		// own namespace ANDed in, so a bare ServiceAccount name would silently
		// drop telemetry from Alloy running anywhere else.
		const rules = (
			policy as {
				ingress: Array<{ fromEndpoints: Array<Record<string, unknown>> }>;
			}
		).ingress;
		// Searched rather than indexed: the rule's position is not part of the
		// contract, and hard-coding it made this test fail for the wrong reason
		// when the blanket in-namespace rule was removed.
		const attested = rules.flatMap((r) => r.fromEndpoints ?? []);
		expect(attested).toContainEqual({
			matchLabels: {
				"k8s:io.kubernetes.pod.namespace": "kube-system",
				"k8s:io.cilium.k8s.policy.serviceaccount": "alloy-metrics",
			},
		});
	});

	it("is default-deny on ingress only", () => {
		expect(policy.enableDefaultDeny).toEqual({ ingress: true, egress: false });
	});
});

describe("observabilityIngressPolicy", () => {
	const alloy = [{ namespace: "observability", name: "alloy-platform" }];

	it("does not blanket-allow the namespace — that would subsume the Alloy rule", () => {
		// Cilium ORs ingress rules, so a namespace-wide allow does not sit
		// alongside the ServiceAccount restriction, it replaces it.
		const p = observabilityIngressPolicy({
			namespace: "observability",
			alloyServiceAccounts: alloy,
			writePorts: [{ port: 3100 }],
		}) as { ingress: Array<Record<string, unknown>> };
		expect(p.ingress).toHaveLength(1);
		expect(JSON.stringify(p.ingress)).toContain("alloy-platform");
	});

	it("admits in-namespace components only when they are named", () => {
		const p = observabilityIngressPolicy({
			namespace: "observability",
			alloyServiceAccounts: alloy,
			writePorts: [{ port: 3100 }],
			componentServiceAccounts: [{ namespace: "observability", name: "loki" }],
		}) as { ingress: Array<Record<string, unknown>> };
		expect(p.ingress).toHaveLength(2);
		expect(JSON.stringify(p.ingress)).toContain("loki");
	});

	it("restricts the Alloy rule to the write ports", () => {
		const p = observabilityIngressPolicy({
			namespace: "observability",
			alloyServiceAccounts: alloy,
			writePorts: [{ port: 3100 }],
		}) as { ingress: Array<Record<string, unknown>> };
		expect(JSON.stringify(p.ingress[0])).toContain("3100");
		expect(p.ingress[0].toPorts).toBeDefined();
	});
});

describe("input validation", () => {
	it("rejects duplicate tenant ids in the registry", () => {
		expect(
			() =>
				new TenancyRegistry([
					{ id: "jmmaloney4", namespaces: ["matrix"], contractItems: [] },
					{
						id: "cavinsresearch",
						namespaces: ["cavins-prod"],
						contractItems: [],
					},
					{ id: "jmmaloney4", namespaces: ["media"], contractItems: [] },
				]),
		).toThrow(/duplicate tenant id\(s\) in registry: jmmaloney4/);
	});

	it("accepts a registry with unique ids", () => {
		expect(
			() =>
				new TenancyRegistry([
					{ id: "jmmaloney4", namespaces: ["matrix"], contractItems: [] },
					{
						id: "cavinsresearch",
						namespaces: ["cavins-prod"],
						contractItems: [],
					},
				]),
		).not.toThrow();
	});
});

describe("Tenant deployer validation", () => {
	beforeAll(() => {
		pulumi.runtime.setMocks({
			newResource: (args) => ({ id: `${args.name}-id`, state: args.inputs }),
			call: (args) => args.inputs,
		});
	});

	const base = { id: "t", namespaces: ["x"] };

	it("rejects a ServiceAccount deployer with no namespace", () => {
		// Kubernetes requires a namespace on a ServiceAccount subject. Without the
		// guard the RoleBinding is generated with `namespace: undefined` and the
		// apiserver rejects it at deploy time rather than here.
		expect(
			() =>
				new Tenant("t", {
					...base,
					deployer: { kind: "ServiceAccount", name: "sa" },
				}),
		).toThrow(/deployer\.namespace is required/);
	});

	it("accepts a ServiceAccount deployer that names its namespace", () => {
		expect(
			() =>
				new Tenant("t2", {
					...base,
					deployer: {
						kind: "ServiceAccount",
						name: "sa",
						namespace: "kube-system",
					},
				}),
		).not.toThrow();
	});

	it("accepts a User deployer, which is not namespaced", () => {
		expect(
			() =>
				new Tenant("t3", {
					...base,
					deployer: { kind: "User", name: "pulumi-jmm" },
				}),
		).not.toThrow();
	});
});

describe("resourceEnvelope", () => {
	const at = { tenantId: "t", namespace: "x" };
	const hardKeys = (e: ReturnType<typeof resourceEnvelope>) =>
		Object.keys(e.quotaHard ?? {}).sort();

	it("targets requests.* for a requests ceiling — the fair-share form", () => {
		const e = resourceEnvelope({
			...at,
			quota: { requests: { cpu: "40", memory: "96Gi" } },
			limits: { defaultRequest: { cpu: "100m", memory: "128Mi" } },
		});
		expect(e.quotaHard).toEqual({
			"requests.cpu": "40",
			"requests.memory": "96Gi",
		});
	});

	it("targets limits.* only when the burst ceiling is asked for", () => {
		const e = resourceEnvelope({
			...at,
			quota: { limits: { cpu: "80" } },
			limits: { default: { cpu: "500m" } },
		});
		expect(e.quotaHard).toEqual({ "limits.cpu": "80" });
	});

	it("expresses both ceilings side by side", () => {
		const e = resourceEnvelope({
			...at,
			quota: { requests: { cpu: "40" }, limits: { cpu: "80" } },
			limits: { default: { cpu: "500m" } },
		});
		expect(hardKeys(e)).toEqual(["limits.cpu", "requests.cpu"]);
	});

	it("emits the LimitRange from the same declaration", () => {
		const e = resourceEnvelope({
			...at,
			quota: { requests: { cpu: "40" } },
			limits: { defaultRequest: { cpu: "100m" }, max: { cpu: "4" } },
		});
		expect(e.limitRange).toEqual({
			limits: [
				{
					type: "Container",
					defaultRequest: { cpu: "100m" },
					default: undefined,
					max: { cpu: "4" },
				},
			],
		});
	});

	it("rejects a CPU/memory quota with no LimitRange, naming the failure", () => {
		expect(() =>
			resourceEnvelope({
				...at,
				quota: { requests: { cpu: "40", memory: "96Gi" }, pods: 200 },
			}),
		).toThrow(
			/tenant "t", namespace "x": the quota constrains requests\.cpu .*requests\.memory .*rejects every pod that does not declare/,
		);
	});

	it("rejects a LimitRange that defaults a different dimension", () => {
		// A memory ceiling is not admissible on the strength of CPU defaults.
		expect(() =>
			resourceEnvelope({
				...at,
				quota: { requests: { memory: "96Gi" } },
				limits: { defaultRequest: { cpu: "100m" } },
			}),
		).toThrow(/requests\.memory \(needs a default container memory request/);
	});

	it("rejects a limits ceiling when only a default request is supplied", () => {
		// defaultRequest is never copied up into a default limit, so pods that
		// omit a cpu limit would still be refused.
		expect(() =>
			resourceEnvelope({
				...at,
				quota: { limits: { cpu: "80" } },
				limits: { defaultRequest: { cpu: "100m" } },
			}),
		).toThrow(/limits\.cpu \(needs a default container cpu limit/);
	});

	it("follows apiserver defaulting: max implies default implies defaultRequest", () => {
		expect(() =>
			resourceEnvelope({
				...at,
				quota: { requests: { cpu: "40" }, limits: { cpu: "80" } },
				limits: { max: { cpu: "4" } },
			}),
		).not.toThrow();
		expect(() =>
			resourceEnvelope({
				...at,
				quota: { requests: { memory: "1Gi" } },
				limits: { default: { memory: "256Mi" } },
			}),
		).not.toThrow();
	});

	it("holds CPU/memory keys arriving through extra to the same rule", () => {
		for (const key of ["cpu", "requests.memory", "limits.cpu"]) {
			expect(() =>
				resourceEnvelope({ ...at, quota: { extra: { [key]: "1" } } }),
			).toThrow(/rejects every pod/);
		}
	});

	it("does not require a LimitRange for quotas that force no declaration", () => {
		const e = resourceEnvelope({
			...at,
			quota: {
				persistentVolumeClaims: 10,
				extra: { "requests.ephemeral-storage": "50Gi" },
			},
		});
		expect(hardKeys(e)).toEqual([
			"persistentvolumeclaims",
			"requests.ephemeral-storage",
		]);
		expect(e.limitRange).toBeUndefined();
	});

	it("rejects the removed top-level cpu/memory rather than dropping them", () => {
		// A config-loaded QuotaSpec escapes the type check; silently ignoring the
		// old field would delete a quota on upgrade.
		expect(() =>
			resourceEnvelope({
				...at,
				quota: { cpu: "40" } as never,
				limits: { default: { cpu: "1" } },
			}),
		).toThrow(/QuotaSpec\.cpu no longer exists — it used to mean limits\.cpu/);
	});

	it("rejects an extra key that a typed field also sets", () => {
		expect(() =>
			resourceEnvelope({
				...at,
				quota: { requests: { cpu: "40" }, extra: { "requests.cpu": "50" } },
				limits: { defaultRequest: { cpu: "100m" } },
			}),
		).toThrow(/quota\.extra sets requests\.cpu/);
	});

	it("emits a LimitRange with no quota", () => {
		const e = resourceEnvelope({
			...at,
			limits: { defaultRequest: { cpu: "100m" } },
		});
		expect(e.quotaHard).toBeUndefined();
		expect(e.limitRange).toBeDefined();
	});
});

describe("Tenant resource envelope", () => {
	const created: Array<{ type: string; inputs: Record<string, unknown> }> = [];
	beforeAll(() => {
		pulumi.runtime.setMocks({
			newResource: (args) => {
				created.push({ type: args.type, inputs: args.inputs });
				return { id: `${args.name}-id`, state: args.inputs };
			},
			call: (args) => args.inputs,
		});
	});

	const deployer = { kind: "User" as const, name: "pulumi-t" };

	it("rejects a CPU/memory quota with no limits — ADR 174 §1's old example", () => {
		expect(
			() =>
				new Tenant("env-bad", {
					id: "bad",
					deployer,
					namespaces: ["matrix"],
					quota: { requests: { cpu: "40", memory: "96Gi" }, pods: 200 },
				}),
		).toThrow(/tenant "bad", namespace "matrix".*rejects every pod/);
	});

	it("checks a per-namespace quota override against the tenant LimitRange", () => {
		expect(
			() =>
				new Tenant("env-override", {
					id: "override",
					deployer,
					namespaces: [
						"ok",
						{ name: "hot", quota: { limits: { memory: "64Gi" } } },
					],
					quota: { pods: 50 },
					limits: { defaultRequest: { memory: "128Mi" } },
				}),
		).toThrow(/namespace "hot".*limits\.memory/);
	});

	it("emits a requests.* ResourceQuota together with its LimitRange", async () => {
		new Tenant("env-good", {
			id: "good",
			deployer,
			namespaces: ["matrix"],
			quota: { requests: { cpu: "40", memory: "96Gi" }, pods: 200 },
			limits: { defaultRequest: { cpu: "100m", memory: "128Mi" } },
		});
		const named = (type: string) =>
			created.find(
				(r) =>
					r.type === type &&
					(r.inputs.metadata as { namespace?: string }).namespace ===
						"matrix" &&
					(r.inputs.metadata as { name?: string }).name?.startsWith("good-"),
			);
		await vi.waitFor(() => {
			expect(named("kubernetes:core/v1:ResourceQuota")).toBeDefined();
			expect(named("kubernetes:core/v1:LimitRange")).toBeDefined();
		});
		const spec = named("kubernetes:core/v1:ResourceQuota")?.inputs.spec as
			| { hard: Record<string, string> }
			| undefined;
		expect(spec?.hard).toEqual({
			"requests.cpu": "40",
			"requests.memory": "96Gi",
			pods: "200",
		});
	});
});
