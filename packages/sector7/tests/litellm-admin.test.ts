import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
//
// The litellm admin resources are ComponentResources that each construct an
// inner `dynamic.Resource`. We mock @pulumi/pulumi to (a) make the component
// constructors inert and (b) capture the ResourceProvider object passed to
// dynamic.Resource's super() — the same capture pattern as the zone-cache and
// r2 provider tests. The provider is then exercised directly.
//
// withProxyBaseUrl() loads kube credentials and opens a port-forward; we stub
// @kubernetes/client-node and node:net so it yields a local base URL without a
// real cluster, and stub global fetch to capture the admin API calls.
// ---------------------------------------------------------------------------

type Provider = {
	check: (
		olds: Record<string, unknown>,
		news: Record<string, unknown>,
	) => Promise<{
		inputs: Record<string, unknown>;
		failures: Array<{ property: string; reason: string }>;
	}>;
	diff: (
		id: string,
		olds: Record<string, unknown>,
		news: Record<string, unknown>,
	) => Promise<{ changes: boolean; replaces?: string[] }>;
	create: (inputs: Record<string, unknown>) => Promise<{
		id: string;
		outs: Record<string, unknown>;
	}>;
	update: (
		id: string,
		olds: Record<string, unknown>,
		news: Record<string, unknown>,
	) => Promise<{ outs: Record<string, unknown> }>;
	delete: (id: string, props: Record<string, unknown>) => Promise<void>;
};

const capturedProviders: Provider[] = [];

vi.mock("@pulumi/pulumi", () => {
	// biome-ignore lint/suspicious/noExplicitAny: minimal Output stand-in for tests
	const output = (value: any): any => ({
		// biome-ignore lint/suspicious/noExplicitAny: identity apply for tests
		apply: (fn: (v: any) => any) => output(fn(value)),
	});
	return {
		ComponentResource: class {
			registerOutputs() {}
		},
		dynamic: {
			Resource: class {
				constructor(provider: Provider) {
					capturedProviders.push(provider);
				}
			},
		},
		output,
		// biome-ignore lint/suspicious/noExplicitAny: identity for tests
		secret: (v: any) => v,
		interpolate: () => "sk-test-key",
	};
});

vi.mock("@pulumi/random", () => ({
	RandomPassword: class {
		result = "randompasswordvalue";
	},
}));

// Stub the port-forward transport: a single ready pod + a fake net server.
const apiStubs = {
	readNamespacedDeployment: vi.fn().mockResolvedValue({
		spec: { selector: { matchLabels: { app: "litellm" } } },
	}),
	listNamespacedPod: vi.fn().mockResolvedValue({
		items: [
			{
				metadata: { name: "litellm-pod-1" },
				status: {
					phase: "Running",
					conditions: [{ type: "Ready", status: "True" }],
				},
			},
		],
	}),
};

vi.mock("@kubernetes/client-node", () => ({
	KubeConfig: class {
		loadFromDefault() {}
		makeApiClient(_ctor: { name: string }) {
			// Both Apps and Core methods live on one stub; harmless overlap.
			return apiStubs;
		}
	},
	AppsV1Api: class AppsV1Api {},
	CoreV1Api: class CoreV1Api {},
	PortForward: class {
		portForward() {
			return Promise.resolve();
		}
	},
}));

vi.mock("node:net", () => ({
	createServer: () => {
		const server = {
			// biome-ignore lint/suspicious/noExplicitAny: minimal EventEmitter-ish stub
			once: (_event: string, _cb: any) => server,
			listen: (_port: number, _host: string, cb: () => void) => {
				cb();
				return server;
			},
			address: () => ({ port: 41000 }),
			close: (cb?: () => void) => {
				cb?.();
				return server;
			},
		};
		return server;
	},
}));

import { LiteLLMApiKey, LiteLLMTeam } from "../litellm/admin.ts";

const target = {
	proxyNamespace: "litellm",
	masterKey: "sk-master",
	proxyDeploymentName: "litellm",
	proxyPort: 4000,
};

// A mock fetch that records calls and returns canned admin responses by path.
function installFetch(
	responder: (path: string, method: string, body: unknown) => unknown,
) {
	const calls: Array<{ path: string; method: string; body: unknown }> = [];
	const mock = vi.fn(async (url: string, init?: RequestInit) => {
		const path = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "");
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		calls.push({ path, method, body });
		const payload = responder(path, method, body);
		return {
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => JSON.stringify(payload ?? {}),
		} as Response;
	});
	vi.stubGlobal("fetch", mock);
	return calls;
}

let teamProvider: Provider;
let keyProvider: Provider;

beforeEach(() => {
	capturedProviders.length = 0;
	new LiteLLMTeam("t", {
		...target,
		teamAlias: "prod-personal",
		teamId: "personal",
	});
	new LiteLLMApiKey("k", {
		...target,
		keyAlias: "prod-openwebui",
		teamId: "personal",
	});
	[teamProvider, keyProvider] = capturedProviders;
	vi.unstubAllGlobals();
});

describe("LiteLLMTeam provider", () => {
	it("flags a models change as an in-place update (no replacement)", async () => {
		const olds = {
			...target,
			teamAlias: "prod-personal",
			desiredTeamId: "personal",
			models: ["coding", "cheap", "smart"],
			maxBudget: "",
			budgetDuration: "",
			tags: [],
			metadata: {},
			teamId: "personal",
		};
		const news = { ...olds, models: ["coding", "cheap", "local", "smart"] };
		const result = await teamProvider.diff("personal", olds, news);
		expect(result.changes).toBe(true);
		expect(result.replaces ?? []).toEqual([]);
	});

	it("ignores model ordering", async () => {
		const base = {
			...target,
			teamAlias: "prod-personal",
			desiredTeamId: "personal",
			models: ["a", "b", "c"],
			maxBudget: "",
			budgetDuration: "",
			tags: [],
			metadata: {},
			teamId: "personal",
		};
		const result = await teamProvider.diff("personal", base, {
			...base,
			models: ["c", "a", "b"],
		});
		expect(result.changes).toBe(false);
	});

	it("replaces only when the explicit team_id changes", async () => {
		const olds = {
			...target,
			teamAlias: "prod-personal",
			desiredTeamId: "personal",
			models: ["coding"],
			maxBudget: "",
			budgetDuration: "",
			tags: [],
			metadata: {},
			teamId: "personal",
		};
		const result = await teamProvider.diff("personal", olds, {
			...olds,
			desiredTeamId: "personal-v2",
		});
		expect(result.replaces).toEqual(["desiredTeamId"]);
	});

	it("does not replace when an auto-assigned team is pinned to its matching id", async () => {
		// Was created id-less (LiteLLM assigned "auto-xyz"); config now pins that
		// same id explicitly. Same object — must not replace.
		const olds = {
			...target,
			teamAlias: "prod-personal",
			desiredTeamId: "",
			models: ["coding"],
			maxBudget: "",
			budgetDuration: "",
			tags: [],
			metadata: {},
			teamId: "auto-xyz",
		};
		const result = await teamProvider.diff("auto-xyz", olds, {
			...olds,
			desiredTeamId: "auto-xyz",
		});
		expect(result.replaces ?? []).toEqual([]);
	});

	it("treats an admin-target change as an in-place update", async () => {
		const olds = {
			...target,
			teamAlias: "prod-personal",
			desiredTeamId: "personal",
			models: ["coding"],
			maxBudget: "",
			budgetDuration: "",
			tags: [],
			metadata: {},
			teamId: "personal",
		};
		const result = await teamProvider.diff("personal", olds, {
			...olds,
			masterKey: "sk-rotated-master",
			proxyDeploymentName: "litellm-canary",
		});
		expect(result.changes).toBe(true);
		expect(result.replaces ?? []).toEqual([]);
	});

	it("adopts an existing team via /team/update on create", async () => {
		const calls = installFetch((path) => {
			if (path === "/team/list")
				return {
					teams: [{ team_id: "personal", team_alias: "prod-personal" }],
				};
			return {};
		});
		const result = await teamProvider.create({
			...target,
			teamAlias: "prod-personal",
			desiredTeamId: "personal",
			models: ["coding", "local"],
			maxBudget: "",
			budgetDuration: "",
			tags: [],
			metadata: {},
		});
		expect(result.id).toBe("personal");
		const update = calls.find((c) => c.path === "/team/update");
		expect(update).toBeDefined();
		expect((update?.body as { models: string[] }).models).toEqual([
			"coding",
			"local",
		]);
		// Must NOT have created a duplicate team.
		expect(calls.find((c) => c.path === "/team/new")).toBeUndefined();
		vi.unstubAllGlobals();
	});

	it("creates a new team when none exists", async () => {
		const calls = installFetch((path) => {
			if (path === "/team/list") return { teams: [] };
			if (path === "/team/new") return { team_id: "personal" };
			return {};
		});
		const result = await teamProvider.create({
			...target,
			teamAlias: "prod-personal",
			desiredTeamId: "personal",
			models: ["coding"],
			maxBudget: "",
			budgetDuration: "",
			tags: [],
			metadata: {},
		});
		expect(result.id).toBe("personal");
		expect(calls.find((c) => c.path === "/team/new")).toBeDefined();
		vi.unstubAllGlobals();
	});

	it("does not adopt a different team that merely shares the alias", async () => {
		const calls = installFetch((path) => {
			// A different team_id happens to carry the same alias. With an explicit
			// desiredTeamId that doesn't exist yet, we must create — not mutate the
			// unrelated team.
			if (path === "/team/list")
				return {
					teams: [{ team_id: "someone-else", team_alias: "prod-personal" }],
				};
			if (path === "/team/new") return { team_id: "personal" };
			return {};
		});
		const result = await teamProvider.create({
			...target,
			teamAlias: "prod-personal",
			desiredTeamId: "personal",
			models: ["coding"],
			maxBudget: "",
			budgetDuration: "",
			tags: [],
			metadata: {},
		});
		expect(result.id).toBe("personal");
		expect(calls.find((c) => c.path === "/team/new")).toBeDefined();
		// Must not have mutated the unrelated same-alias team.
		expect(calls.find((c) => c.path === "/team/update")).toBeUndefined();
		vi.unstubAllGlobals();
	});

	it("never adopts by alias when no explicit team_id is given", async () => {
		const calls = installFetch((path) => {
			if (path === "/team/list")
				return {
					teams: [{ team_id: "auto-xyz", team_alias: "prod-personal" }],
				};
			if (path === "/team/new") return { team_id: "auto-new" };
			return {};
		});
		const result = await teamProvider.create({
			...target,
			teamAlias: "prod-personal",
			desiredTeamId: "",
			models: ["coding"],
			maxBudget: "",
			budgetDuration: "",
			tags: [],
			metadata: {},
		});
		// No stable id to adopt → create fresh, never touch the same-alias team.
		expect(calls.find((c) => c.path === "/team/new")).toBeDefined();
		expect(calls.find((c) => c.path === "/team/update")).toBeUndefined();
		expect(result.id).toBe("auto-new");
		vi.unstubAllGlobals();
	});

	it("update calls /team/update with the resolved team_id", async () => {
		const calls = installFetch(() => ({}));
		await teamProvider.update(
			"personal",
			{},
			{
				...target,
				teamAlias: "prod-personal",
				desiredTeamId: "personal",
				models: ["coding", "local"],
				maxBudget: "",
				budgetDuration: "",
				tags: [],
				metadata: {},
			},
		);
		const update = calls.find((c) => c.path === "/team/update");
		expect((update?.body as { team_id: string }).team_id).toBe("personal");
		vi.unstubAllGlobals();
	});

	it("clears a previously-set budget on update", async () => {
		const olds = {
			...target,
			teamAlias: "prod-personal",
			desiredTeamId: "personal",
			models: ["coding"],
			maxBudget: 250,
			budgetDuration: "30d",
			tags: [],
			metadata: {},
			teamId: "personal",
		};
		const news = { ...olds, maxBudget: "", budgetDuration: "" };
		const calls = installFetch(() => ({}));
		await teamProvider.update("personal", olds, news);
		const body = calls.find((c) => c.path === "/team/update")?.body as Record<
			string,
			unknown
		>;
		// Omitting these would leave the old values set in LiteLLM — send nulls.
		expect(body.max_budget).toBeNull();
		expect(body.budget_duration).toBeNull();
		vi.unstubAllGlobals();
	});
});

describe("LiteLLMApiKey provider", () => {
	const baseKey = {
		...target,
		keyAlias: "prod-openwebui",
		keyValue: "sk-abc",
		models: ["coding", "cheap"],
		teamId: "personal",
		userId: "",
		budgetId: "",
		maxBudget: "" as const,
		budgetDuration: "",
		duration: "",
		aliases: {},
		tags: [],
		metadata: {},
		tokenId: "hash-1",
	};

	it("updates in place when models change", async () => {
		const result = await keyProvider.diff("hash-1", baseKey, {
			...baseKey,
			models: ["coding", "cheap", "local"],
		});
		expect(result.changes).toBe(true);
		expect(result.replaces ?? []).toEqual([]);
	});

	it("replaces when the key value rotates", async () => {
		const result = await keyProvider.diff("hash-1", baseKey, {
			...baseKey,
			keyValue: "sk-rotated",
		});
		expect(result.replaces).toContain("keyValue");
	});

	it("replaces when the team changes", async () => {
		const result = await keyProvider.diff("hash-1", baseKey, {
			...baseKey,
			teamId: "research",
		});
		expect(result.replaces).toContain("teamId");
	});

	it("create generates the key with the known sk- value", async () => {
		const calls = installFetch((path) => {
			if (path === "/key/list") return { keys: [] };
			if (path === "/key/generate") return { token: "hash-new" };
			return {};
		});
		const result = await keyProvider.create({ ...baseKey, tokenId: undefined });
		expect(result.outs.tokenId).toBe("hash-new");
		const gen = calls.find((c) => c.path === "/key/generate");
		expect((gen?.body as { key: string }).key).toBe("sk-abc");
		vi.unstubAllGlobals();
	});

	it("create deletes a pre-existing same-alias key in the same team before regenerating", async () => {
		const calls = installFetch((path) => {
			if (path === "/key/list") return { keys: ["hash-old"] };
			if (path.startsWith("/key/info"))
				return { info: { key_alias: "prod-openwebui", team_id: "personal" } };
			if (path === "/key/generate") return { token: "hash-new" };
			return {};
		});
		await keyProvider.create({ ...baseKey, tokenId: undefined });
		const del = calls.find((c) => c.path === "/key/delete");
		expect((del?.body as { keys: string[] }).keys).toEqual(["hash-old"]);
		vi.unstubAllGlobals();
	});

	it("create does NOT delete a same-alias key owned by a different team", async () => {
		const calls = installFetch((path) => {
			if (path === "/key/list") return { keys: ["hash-other-team"] };
			if (path.startsWith("/key/info"))
				return { info: { key_alias: "prod-openwebui", team_id: "research" } };
			if (path === "/key/generate") return { token: "hash-new" };
			return {};
		});
		await keyProvider.create({ ...baseKey, tokenId: undefined });
		// The colliding alias belongs to another team — must be left untouched.
		expect(calls.find((c) => c.path === "/key/delete")).toBeUndefined();
		vi.unstubAllGlobals();
	});

	it("create deletes ALL duplicate same-alias keys in the team", async () => {
		const calls = installFetch((path) => {
			if (path === "/key/list") return { keys: ["hash-a", "hash-b"] };
			// Drift left two keys with the same alias in the same team.
			if (path.startsWith("/key/info"))
				return { info: { key_alias: "prod-openwebui", team_id: "personal" } };
			if (path === "/key/generate") return { token: "hash-new" };
			return {};
		});
		await keyProvider.create({ ...baseKey, tokenId: undefined });
		const del = calls.find((c) => c.path === "/key/delete");
		expect((del?.body as { keys: string[] }).keys).toEqual([
			"hash-a",
			"hash-b",
		]);
		vi.unstubAllGlobals();
	});

	it("update calls /key/update keyed on the key value", async () => {
		const calls = installFetch(() => ({}));
		await keyProvider.update("hash-1", baseKey, {
			...baseKey,
			models: ["coding", "cheap", "local"],
		});
		const update = calls.find((c) => c.path === "/key/update");
		expect((update?.body as { key: string }).key).toBe("sk-abc");
		expect((update?.body as { models: string[] }).models).toContain("local");
		vi.unstubAllGlobals();
	});

	it("clears previously-set budget/duration/tags on update", async () => {
		const olds = {
			...baseKey,
			maxBudget: 100,
			budgetDuration: "30d",
			duration: "7d",
			tags: ["legacy"],
		};
		const news = {
			...baseKey,
			maxBudget: "",
			budgetDuration: "",
			duration: "",
			tags: [],
		};
		const calls = installFetch(() => ({}));
		await keyProvider.update("hash-1", olds, news);
		const body = calls.find((c) => c.path === "/key/update")?.body as Record<
			string,
			unknown
		>;
		expect(body.max_budget).toBeNull();
		expect(body.budget_duration).toBeNull();
		expect(body.duration).toBeNull();
		expect(body.tags).toEqual([]);
		vi.unstubAllGlobals();
	});

	it("delete removes the key by token id", async () => {
		const calls = installFetch(() => ({}));
		await keyProvider.delete("hash-1", baseKey);
		const del = calls.find((c) => c.path === "/key/delete");
		expect((del?.body as { keys: string[] }).keys).toEqual(["hash-1"]);
		vi.unstubAllGlobals();
	});

	it("treats an admin-target change as an in-place update", async () => {
		const result = await keyProvider.diff("hash-1", baseKey, {
			...baseKey,
			masterKey: "sk-rotated-master",
			proxyNamespace: "litellm-staging",
		});
		expect(result.changes).toBe(true);
		expect(result.replaces ?? []).toEqual([]);
	});

	it("reconciles a renamed key alias via /key/update", async () => {
		const renamed = { ...baseKey, keyAlias: "prod-openwebui-v2" };
		const diff = await keyProvider.diff("hash-1", baseKey, renamed);
		expect(diff.changes).toBe(true);
		expect(diff.replaces ?? []).toEqual([]);

		const calls = installFetch(() => ({}));
		await keyProvider.update("hash-1", baseKey, renamed);
		const update = calls.find((c) => c.path === "/key/update");
		expect((update?.body as { key_alias: string }).key_alias).toBe(
			"prod-openwebui-v2",
		);
		vi.unstubAllGlobals();
	});

	it("create throws rather than storing the secret as the resource id", async () => {
		installFetch((path) => {
			if (path === "/key/list") return { keys: [] };
			// /key/generate returns no token — must fail, not leak sk- as the id.
			if (path === "/key/generate") return {};
			return {};
		});
		await expect(
			keyProvider.create({ ...baseKey, tokenId: undefined }),
		).rejects.toThrow(/no token id/);
		vi.unstubAllGlobals();
	});
});
