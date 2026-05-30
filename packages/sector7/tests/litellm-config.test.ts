import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { generateLiteLLMConfig } from "../litellm/config.ts";
import { buildLiteLLMTeamScopedModelGroups } from "../litellm/team-plan.ts";

describe("generateLiteLLMConfig", () => {
	it("generates grouped model config with fallbacks and env-based secrets", () => {
		const generated = generateLiteLLMConfig({
			providers: {
				anthropic: { hasApiKey: true, envVar: "ANTHROPIC_API_KEY" },
				openai: {
					hasApiKey: true,
					envVar: "OPENAI_API_KEY",
					apiBase: "https://api.openai.example/v1",
				},
			},
			deployments: [
				{
					id: "anthropic-smart",
					provider: "anthropic",
					providerModel: "anthropic/claude-sonnet-4-20250514",
					mode: "chat",
					accessGroups: ["premium"],
					maxInputTokens: 200000,
				},
				{
					id: "openai-fast",
					provider: "openai",
					providerModel: "openai/gpt-4o-mini",
					mode: "chat",
					rpm: 500,
					tpm: 200000,
				},
			],
			modelGroups: [
				{
					name: "smart",
					deploymentIds: ["anthropic-smart"],
					fallbacks: ["fast"],
					contextWindowFallbacks: ["long-context"],
					accessGroups: ["core"],
				},
				{
					name: "fast",
					deploymentIds: ["openai-fast"],
				},
				{
					name: "long-context",
					deploymentIds: ["anthropic-smart"],
				},
			],
			router: {
				defaultFallbacks: ["smart"],
				retryPolicy: { RateLimitErrorRetries: 3 },
			},
			governance: {
				maxBudget: 500,
				budgetDuration: "30d",
			},
		});

		expect(generated.providerEnvVars).toEqual([
			"ANTHROPIC_API_KEY",
			"OPENAI_API_KEY",
		]);
		expect(generated.configYaml).not.toContain("anthropic-secret");
		expect(generated.configYaml).not.toContain("openai-secret");

		const parsed = parse(generated.configYaml) as Record<string, unknown>;
		const modelList = parsed.model_list as Array<Record<string, unknown>>;
		expect(modelList).toHaveLength(3);
		expect(modelList[0].model_name).toBe("smart");
		expect(
			(modelList[0].litellm_params as Record<string, unknown>).api_key,
		).toBe("os.environ/ANTHROPIC_API_KEY");
		expect(
			(modelList[0].model_info as Record<string, unknown>).access_groups,
		).toEqual(["premium", "core"]);

		const routerSettings = parsed.router_settings as Record<string, unknown>;
		expect(routerSettings.routing_strategy).toBe("cost-based-routing");
		expect(routerSettings.fallbacks).toEqual([{ smart: ["fast"] }]);
		expect(routerSettings.context_window_fallbacks).toEqual([
			{ smart: ["long-context"] },
		]);
		expect(routerSettings.default_fallbacks).toEqual(["smart"]);

		const generalSettings = parsed.general_settings as Record<string, unknown>;
		expect(generalSettings.database_url).toBe("os.environ/DATABASE_URL");
		expect(generalSettings.master_key).toBe("os.environ/LITELLM_MASTER_KEY");
	});

	it("supports secretless internal upstreams, team aliases, and extra settings", () => {
		const modelGroups = buildLiteLLMTeamScopedModelGroups({
			teams: [
				{
					id: "personal",
					alias: "Personal",
					capabilities: [
						{
							name: "coding",
							deploymentIds: ["codex-main"],
							fallbacks: ["cheap"],
							accessGroups: ["core"],
							tags: ["personal"],
						},
						{
							name: "cheap",
							deploymentIds: ["cheap-main"],
						},
					],
				},
			],
		});

		const generated = generateLiteLLMConfig({
			providers: {
				codex: {
					apiBase: "http://codex-proxy.default.svc.cluster.local:9879",
					hasApiKey: true,
				},
				openai: { hasApiKey: true },
			},
			deployments: [
				{
					id: "codex-main",
					provider: "codex",
					providerModel: "openai/gpt-5-codex",
					teamId: "personal",
					teamPublicModelName: "coding",
					tags: ["internal"],
					extraLiteLLMParams: { stream_timeout: 45 },
					extraModelInfo: { owner: "personal-billing" },
				},
				{
					id: "cheap-main",
					provider: "openai",
					providerModel: "openai/gpt-4o-mini",
				},
			],
			modelGroups,
			observability: {
				successCallbacks: ["prometheus"],
			},
			governance: {
				maxBudget: 50,
			},
			extraLiteLLMSettings: {
				json_logs: true,
				max_budget: 999,
			},
			extraGeneralSettings: {
				enforce_user_param: false,
			},
			extraRouterSettings: {
				routing_strategy: "least-busy",
			},
		});

		expect(generated.providerEnvVars).toEqual([
			"CODEX_API_KEY",
			"OPENAI_API_KEY",
		]);

		const parsed = parse(generated.configYaml) as Record<string, unknown>;
		const modelList = parsed.model_list as Array<Record<string, unknown>>;
		const codingEntry = modelList.find(
			(entry) => entry.model_name === "personal::coding",
		);
		const codingParams = codingEntry?.litellm_params as Record<string, unknown>;
		const codingInfo = codingEntry?.model_info as Record<string, unknown>;
		expect(codingParams.api_base).toBe(
			"http://codex-proxy.default.svc.cluster.local:9879",
		);
		expect(codingParams.api_key).toBe("os.environ/CODEX_API_KEY");
		expect(codingParams.stream_timeout).toBe(45);
		expect(codingInfo.team_id).toBe("personal");
		expect(codingInfo.team_public_model_name).toBe("coding");
		expect(codingInfo.team_alias).toBe("Personal");
		expect(codingInfo.tags).toEqual(["internal", "personal"]);
		expect(codingInfo.owner).toBe("personal-billing");

		const routerSettings = parsed.router_settings as Record<string, unknown>;
		expect(routerSettings.routing_strategy).toBe("least-busy");
		expect(routerSettings.fallbacks).toEqual([
			{ "personal::coding": ["personal::cheap"] },
		]);

		const generalSettings = parsed.general_settings as Record<string, unknown>;
		expect(generalSettings.enforce_user_param).toBe(false);

		const litellmSettings = parsed.litellm_settings as Record<string, unknown>;
		expect(litellmSettings.json_logs).toBe(true);
		expect(litellmSettings.max_budget).toBe(999);
		expect(litellmSettings.success_callback).toEqual(["prometheus"]);
	});

	it("rejects missing deployment references and multi-replica without redis", () => {
		expect(() =>
			generateLiteLLMConfig({
				providers: { anthropic: {} },
				deployments: [
					{
						id: "dep-1",
						provider: "anthropic",
						providerModel: "anthropic/claude-sonnet-4-20250514",
					},
				],
				modelGroups: [{ name: "smart", deploymentIds: ["missing-deployment"] }],
			}),
		).toThrow(/missing deployment/i);

		expect(() =>
			generateLiteLLMConfig({
				providers: { anthropic: {} },
				deployments: [
					{
						id: "dep-1",
						provider: "anthropic",
						providerModel: "anthropic/claude-sonnet-4-20250514",
					},
				],
				modelGroups: [{ name: "smart", deploymentIds: ["dep-1"] }],
				replicas: 2,
			}),
		).toThrow(/replicas > 1 require redis/i);
	});
});

describe("buildLiteLLMTeamScopedModelGroups", () => {
	it("fails loudly on duplicate capability names within a team", () => {
		expect(() =>
			buildLiteLLMTeamScopedModelGroups({
				teams: [
					{
						id: "personal",
						capabilities: [
							{ name: "coding", deploymentIds: ["dep-1"] },
							{ name: "coding", deploymentIds: ["dep-2"] },
						],
					},
				],
			}),
		).toThrow(/duplicate capability/i);
	});

	it("throws when a provider has no apiKey and no envVar", () => {
		expect(() =>
			generateLiteLLMConfig({
				providers: {
					codex: {
						apiBase: "http://codex-proxy.default.svc.cluster.local:9879",
					},
				},
				deployments: [
					{
						id: "codex-main",
						provider: "codex",
						providerModel: "openai/gpt-5-codex",
						mode: "chat",
					},
				],
				modelGroups: [
					{
						name: "personal::coding",
						deploymentIds: ["codex-main"],
					},
				],
			}),
		).toThrow(/no apiKey and no envVar/);
	});
});
