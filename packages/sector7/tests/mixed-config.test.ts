import * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";
import { requireMixedConfig } from "../pulumi-config/index.js";

type FakeConfig = Pick<pulumi.Config, "requireObject" | "requireSecret">;

type ProviderConfig = {
	provider: string;
	apiKey: string;
};

type TeamConfig = {
	id: string;
	alias: string;
	apiKey: string;
};

type AccountConfig = {
	name: string;
	apiToken: string;
};

function fakeConfig(args: {
	objects: Record<string, unknown>;
	secrets: Record<string, string>;
}) {
	return {
		requireObject: (key: string) => {
			if (!(key in args.objects)) {
				throw new Error(`missing object ${key}`);
			}
			return args.objects[key];
		},
		requireSecret: (key: string) => {
			if (!(key in args.secrets)) {
				throw new Error(`missing secret ${key}`);
			}
			return pulumi.secret(args.secrets[key]);
		},
	} as any;
}

async function resolveOutput<T>(value: pulumi.Input<T>): Promise<T> {
	return new Promise((resolve) => {
		pulumi.output(value).apply((resolved) => {
			resolve(resolved as T);
			return resolved;
		});
	});
}

describe("requireMixedConfig", () => {
	it("reads map-shaped config with plain and secret fields", async () => {
		const config = fakeConfig({
			objects: {
				providers: {
					personal: { provider: "zai" },
					cavinsresearch: { provider: "zai" },
				},
			},
			secrets: {
				"providers.personal.apiKey": "personal-secret",
				"providers.cavinsresearch.apiKey": "research-secret",
			},
		});

		const providers = requireMixedConfig<ProviderConfig, ["apiKey"]>(
			config,
			"providers",
			{ shape: "map", secretFields: ["apiKey"] },
		);

		expect(providers.personal.provider).toBe("zai");
		expect(providers.cavinsresearch.provider).toBe("zai");
		expect(await resolveOutput(providers.personal.apiKey)).toBe(
			"personal-secret",
		);
		expect(await resolveOutput(providers.cavinsresearch.apiKey)).toBe(
			"research-secret",
		);
	});

	it("reads record-shaped config keyed by a string field", async () => {
		const config = fakeConfig({
			objects: {
				teams: [
					{ id: "personal", alias: "coding" },
					{ id: "research", alias: "cheap" },
				],
			},
			secrets: {
				"teams[0].apiKey": "personal-secret",
				"teams[1].apiKey": "research-secret",
			},
		});

		const teams = requireMixedConfig<TeamConfig, "alias", ["apiKey"]>(
			config,
			"teams",
			{ shape: "record", keyField: "alias", secretFields: ["apiKey"] },
		);

		expect(teams.coding.id).toBe("personal");
		expect(teams.cheap.id).toBe("research");
		expect(await resolveOutput(teams.coding.apiKey)).toBe("personal-secret");
		expect(await resolveOutput(teams.cheap.apiKey)).toBe("research-secret");
	});

	it("reads array-shaped config with plain and secret fields", async () => {
		const config = fakeConfig({
			objects: {
				accounts: [{ name: "jmmaloney4" }, { name: "cavinsresearch" }],
			},
			secrets: {
				"accounts[0].apiToken": "jmm-secret",
				"accounts[1].apiToken": "cavins-secret",
			},
		});

		const accounts = requireMixedConfig<AccountConfig, ["apiToken"]>(
			config,
			"accounts",
			{ secretFields: ["apiToken"] },
		);

		expect(accounts[0].name).toBe("jmmaloney4");
		expect(accounts[1].name).toBe("cavinsresearch");
		expect(await resolveOutput(accounts[0].apiToken)).toBe("jmm-secret");
		expect(await resolveOutput(accounts[1].apiToken)).toBe("cavins-secret");
	});

	it("reads flat secret maps", async () => {
		const config = fakeConfig({
			objects: {
				tokens: {
					ghcr: "placeholder",
					langfuse: "placeholder",
				},
			},
			secrets: {
				"tokens.ghcr": "ghcr-secret",
				"tokens.langfuse": "langfuse-secret",
			},
		});

		const tokens = requireMixedConfig(config, "tokens", {
			shape: "flatSecrets",
		});

		expect(await resolveOutput(tokens.ghcr)).toBe("ghcr-secret");
		expect(await resolveOutput(tokens.langfuse)).toBe("langfuse-secret");
	});
});
