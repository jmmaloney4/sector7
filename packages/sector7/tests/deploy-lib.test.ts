import * as pulumi from "@pulumi/pulumi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ContractChannel,
	clearContractItemCacheForTesting,
	getContractChannel,
	readContractItemAsync,
	requireContractField,
} from "../deploy-lib/contract.js";
import {
	apiServerHostFromContractFields,
	clearStackRefCachesForTesting,
	getApiServerHost,
	getConfigStack,
	getK8sProvider,
	getPlatformKubeconfig,
} from "../deploy-lib/resolver.js";

type MockResource = {
	type: string;
	name: string;
	inputs: Record<string, unknown>;
};

const resources: MockResource[] = [];

const STACK_KUBECONFIG = JSON.stringify({
	apiVersion: "v1",
	kind: "Config",
	clusters: [
		{ cluster: { server: "https://stackref.example:6443" }, name: "c" },
	],
});

const CONTRACT_KUBECONFIG = JSON.stringify({
	apiVersion: "v1",
	kind: "Config",
	clusters: [
		{ cluster: { server: "https://contract.example:6443" }, name: "c" },
	],
});

pulumi.runtime.setMocks(
	{
		newResource: (args: pulumi.runtime.MockResourceArgs) => {
			const state: Record<string, unknown> = { ...args.inputs };
			if (args.type === "pulumi:pulumi:StackReference") {
				state.outputs = {
					kubeconfig: STACK_KUBECONFIG,
					apiHost: "https://stackref.example:6443",
					cloudflareApiTokens: { acct1: "cf-token-1" },
					ghcrUsername: "stackref-user",
					ghcrToken: "stackref-token",
				};
				state.secretOutputNames = [];
			}
			resources.push({ type: args.type, name: args.name, inputs: args.inputs });
			return { id: `${args.name}-id`, state };
		},
		call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
	},
	"project",
	"stack",
	false,
);

/** Await an Output, propagating rejections (resolveOutput never rejects). */
function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
	return (output as unknown as { promise(): Promise<T> }).promise();
}

/** A 26-char lowercase id, the shape 1Password uses for vault/item UUIDs. */
const VAULT_ID = "abcdefghijklmnopqrstuvwxyz";

interface FakeItem {
	title: string;
	fields: Record<string, string>;
}

/**
 * Install a fetch mock speaking just enough of the 1Password Connect REST
 * API: vault list (filtered by name), item list (filtered by title), item
 * detail. Returns the mock so tests can assert on calls.
 */
function mockConnect(items: FakeItem[], vaultName = "tenant-vault") {
	const fetchMock = vi.fn(async (input: string | URL) => {
		const url = new URL(String(input));
		const ok = (body: unknown) => ({
			ok: true,
			status: 200,
			json: async () => body,
			text: async () => JSON.stringify(body),
		});
		if (url.pathname === "/v1/vaults") {
			const filter = url.searchParams.get("filter") ?? "";
			const match = filter === `name eq "${vaultName}"`;
			return ok(match ? [{ id: VAULT_ID, name: vaultName }] : []);
		}
		if (url.pathname === `/v1/vaults/${VAULT_ID}/items`) {
			const filter = url.searchParams.get("filter") ?? "";
			const found = items
				.map((item, n) => ({ item, n }))
				.filter(({ item }) => filter === `title eq "${item.title}"`);
			return ok(
				found.map(({ item, n }) => ({ id: `item-${n}`, title: item.title })),
			);
		}
		const detail = url.pathname.match(
			new RegExp(`^/v1/vaults/${VAULT_ID}/items/item-(\\d+)$`),
		);
		if (detail) {
			const idx = Number(detail[1]);
			const item = items[idx];
			if (item) {
				return ok({
					id: detail[1],
					title: item.title,
					fields: Object.entries(item.fields).map(([label, value]) => ({
						id: label,
						label,
						value,
					})),
				});
			}
		}
		return {
			ok: false,
			status: 404,
			json: async () => ({}),
			text: async () => "not found",
		};
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function setContractConfig(extra: Record<string, string> = {}): void {
	pulumi.runtime.setAllConfig({
		"contract:vault": VAULT_ID,
		"contract:connectHost": "https://connect.example",
		"contract:connectToken": "test-token",
		...extra,
	});
}

const KUBECONFIG_ITEM: FakeItem = {
	title: "kubeconfig",
	fields: {
		kubeconfig: CONTRACT_KUBECONFIG,
		producedBy: "organization/k8s/prod",
		producedAt: new Date().toISOString(),
	},
};

const CONFIG_ITEM: FakeItem = {
	title: "config",
	fields: {
		cloudflareApiTokens: JSON.stringify({ acct1: "cf-contract-1" }),
		ghcr: JSON.stringify({
			username: "contract-user",
			token: "contract-token",
		}),
		producedBy: "organization/config/prod",
		producedAt: new Date().toISOString(),
	},
};

beforeEach(() => {
	resources.length = 0;
	clearContractItemCacheForTesting();
	clearStackRefCachesForTesting();
	pulumi.runtime.setAllConfig({});
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.OP_CONNECT_HOST;
	delete process.env.OP_CONNECT_TOKEN;
});

describe("mode selection (the chokepoint)", () => {
	it("is in stackref mode when contract:vault is unset", () => {
		expect(getContractChannel()).toBeUndefined();
	});

	it("is in contract mode when contract:vault is set", () => {
		setContractConfig();
		expect(getContractChannel()).toMatchObject({
			vault: VAULT_ID,
			connectHost: "https://connect.example",
		});
	});

	it("throws when contract:vault is set without a Connect host", () => {
		pulumi.runtime.setAllConfig({
			"contract:vault": VAULT_ID,
			"contract:connectToken": "test-token",
		});
		expect(() => getContractChannel()).toThrow(/connectHost|OP_CONNECT_HOST/);
	});

	it("throws when contract:vault is set without a Connect token", () => {
		pulumi.runtime.setAllConfig({
			"contract:vault": VAULT_ID,
			"contract:connectHost": "https://connect.example",
		});
		expect(() => getContractChannel()).toThrow(/connectToken|OP_CONNECT_TOKEN/);
	});

	it("normalizes a protocol-less connectHost to https", () => {
		setContractConfig({ "contract:connectHost": "connect.example" });
		expect(getContractChannel()).toMatchObject({
			connectHost: "https://connect.example",
		});
	});

	it("falls back to OP_CONNECT_HOST / OP_CONNECT_TOKEN env vars", () => {
		pulumi.runtime.setAllConfig({ "contract:vault": VAULT_ID });
		process.env.OP_CONNECT_HOST = "https://env.example";
		process.env.OP_CONNECT_TOKEN = "env-token";
		expect(getContractChannel()).toMatchObject({
			connectHost: "https://env.example",
			connectToken: "env-token",
		});
	});
});

describe("stackref mode", () => {
	it("resolves the kubeconfig from organization/k8s/prod by default", async () => {
		const kubeconfig = await promiseOf(getPlatformKubeconfig());
		expect(kubeconfig).toBe(STACK_KUBECONFIG);
		const ref = resources.find(
			(r) => r.type === "pulumi:pulumi:StackReference",
		);
		expect(ref?.name).toBe("organization/k8s/prod");
	});

	it("honors stackName and environment overrides", async () => {
		await promiseOf(
			getPlatformKubeconfig({ stackName: "cluster", environment: "dev" }),
		);
		const ref = resources.find(
			(r) => r.type === "pulumi:pulumi:StackReference",
		);
		expect(ref?.name).toBe("organization/cluster/dev");
	});

	it("creates the provider under the pinned logical name k8s-platform", async () => {
		const provider = getK8sProvider();
		await promiseOf(provider.urn);
		const prov = resources.find((r) =>
			r.type.startsWith("pulumi:providers:kubernetes"),
		);
		expect(prov?.name).toBe("k8s-platform");
	});

	it("reads apiHost from the platform stack", async () => {
		await expect(promiseOf(getApiServerHost())).resolves.toBe(
			"https://stackref.example:6443",
		);
	});

	it("reads the config surface from organization/config/prod", async () => {
		const cfg = getConfigStack();
		await expect(promiseOf(cfg.ghcrUsername)).resolves.toBe("stackref-user");
		const ref = resources.find(
			(r) => r.type === "pulumi:pulumi:StackReference",
		);
		expect(ref?.name).toBe("organization/config/prod");
	});
});

describe("contract mode", () => {
	it("resolves the kubeconfig from the contract item, not a StackReference", async () => {
		setContractConfig();
		const fetchMock = mockConnect([KUBECONFIG_ITEM]);
		const kubeconfig = await promiseOf(getPlatformKubeconfig());
		expect(kubeconfig).toBe(CONTRACT_KUBECONFIG);
		expect(
			resources.filter((r) => r.type === "pulumi:pulumi:StackReference"),
		).toHaveLength(0);
		const authHeaders = fetchMock.mock.calls.map(
			(c) =>
				(c[1] as { headers: Record<string, string> }).headers.Authorization,
		);
		expect(new Set(authHeaders)).toEqual(new Set(["Bearer test-token"]));
	});

	it("reads each contract item at most once per process", async () => {
		setContractConfig();
		const fetchMock = mockConnect([KUBECONFIG_ITEM]);
		await promiseOf(getPlatformKubeconfig());
		await promiseOf(getApiServerHost());
		const itemListCalls = fetchMock.mock.calls.filter((c) =>
			String(c[0]).includes("/items?"),
		);
		expect(itemListCalls).toHaveLength(1);
	});

	it("resolves a vault given by name via the Connect vault filter", async () => {
		setContractConfig({ "contract:vault": "tenant-vault" });
		const fetchMock = mockConnect([KUBECONFIG_ITEM], "tenant-vault");
		await promiseOf(getPlatformKubeconfig());
		expect(
			fetchMock.mock.calls.some((c) =>
				String(c[0]).includes("/v1/vaults?filter="),
			),
		).toBe(true);
	});

	it("derives the API server host from the kubeconfig item", async () => {
		setContractConfig();
		mockConnect([KUBECONFIG_ITEM]);
		await expect(promiseOf(getApiServerHost())).resolves.toBe(
			"https://contract.example:6443",
		);
	});

	it("maps the config item onto the ConfigStackOutputs shape", async () => {
		setContractConfig();
		mockConnect([CONFIG_ITEM]);
		const cfg = getConfigStack();
		await expect(promiseOf(cfg.cloudflareApiTokens)).resolves.toEqual({
			acct1: "cf-contract-1",
		});
		await expect(promiseOf(cfg.ghcrUsername)).resolves.toBe("contract-user");
		await expect(promiseOf(cfg.ghcrToken)).resolves.toBe("contract-token");
		expect(
			resources.filter((r) => r.type === "pulumi:pulumi:StackReference"),
		).toHaveLength(0);
	});
});

// Failure paths are exercised at the promise level (readContractItemAsync and
// the pure projections) rather than through a rejecting Output: Pulumi's
// `apply` internally forks isKnown/isSecret promise chains that surface as
// unhandled rejections in vitest whenever the value promise rejects, even
// with the value promise itself properly awaited.
describe("contract failure modes (loud, never a silent fallback)", () => {
	const channel: ContractChannel = {
		vault: VAULT_ID,
		connectHost: "https://connect.example",
		connectToken: "test-token",
	};

	it("fails when the item is missing, pointing at the publisher", async () => {
		mockConnect([]);
		await expect(
			readContractItemAsync(channel, "test-token", "kubeconfig"),
		).rejects.toThrow(/exactly one item titled "kubeconfig".*found 0/s);
	});

	it("fails when the field is missing, naming the op:// coordinate", async () => {
		mockConnect([{ title: "kubeconfig", fields: { producedBy: "x" } }]);
		const fields = await readContractItemAsync(
			channel,
			"test-token",
			"kubeconfig",
		);
		expect(() =>
			requireContractField(channel, "kubeconfig", "kubeconfig", fields),
		).toThrow(`op://${VAULT_ID}/kubeconfig/kubeconfig`);
	});

	it("fails when Connect is unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);
		await expect(
			readContractItemAsync(channel, "test-token", "kubeconfig"),
		).rejects.toThrow(/unreachable/);
	});

	it("fails when the vault name matches no vault", async () => {
		mockConnect([KUBECONFIG_ITEM], "other-vault");
		await expect(
			readContractItemAsync(
				{ ...channel, vault: "tenant-vault" },
				"test-token",
				"kubeconfig",
			),
		).rejects.toThrow(/exactly one 1Password vault named "tenant-vault"/);
	});

	it("derives the API server host from a YAML kubeconfig too", () => {
		const yamlKubeconfig = [
			"apiVersion: v1",
			"kind: Config",
			"clusters:",
			"  - name: c",
			"    cluster:",
			"      server: https://yaml.example:6443",
		].join("\n");
		expect(
			apiServerHostFromContractFields(channel, { kubeconfig: yamlKubeconfig }),
		).toBe("https://yaml.example:6443");
	});

	it("rejects an unparseable kubeconfig when deriving the API server host", () => {
		expect(() =>
			apiServerHostFromContractFields(channel, { kubeconfig: "{ invalid" }),
		).toThrow(/not parseable YAML\/JSON/);
	});

	it("rejects a kubeconfig with no server when deriving the API server host", () => {
		for (const kubeconfig of [
			JSON.stringify({ clusters: [] }),
			"null",
			"just-a-scalar",
		]) {
			expect(() =>
				apiServerHostFromContractFields(channel, { kubeconfig }),
			).toThrow(/clusters\[0\]\.cluster\.server/);
		}
	});
});

describe("freshness (contract:maxAgeHours)", () => {
	const fresh = (maxAgeHours: number): ContractChannel => ({
		vault: VAULT_ID,
		connectHost: "https://connect.example",
		connectToken: "test-token",
		maxAgeHours,
	});

	it("accepts an item younger than the limit (through the Output path)", async () => {
		setContractConfig({ "contract:maxAgeHours": "24" });
		mockConnect([KUBECONFIG_ITEM]);
		await expect(promiseOf(getPlatformKubeconfig())).resolves.toBe(
			CONTRACT_KUBECONFIG,
		);
	});

	it("rejects a stale item, naming producedAt and the limit", async () => {
		mockConnect([
			{
				title: "kubeconfig",
				fields: {
					kubeconfig: CONTRACT_KUBECONFIG,
					producedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
				},
			},
		]);
		await expect(
			readContractItemAsync(fresh(1), "test-token", "kubeconfig"),
		).rejects.toThrow(/stale/);
	});

	it("rejects an item with no producedAt when a freshness bound is set", async () => {
		mockConnect([
			{ title: "kubeconfig", fields: { kubeconfig: CONTRACT_KUBECONFIG } },
		]);
		await expect(
			readContractItemAsync(fresh(1), "test-token", "kubeconfig"),
		).rejects.toThrow(/producedAt/);
	});
});
