import { describe, expect, it } from "vitest";
import { generateMonitorScript } from "../monitor/monitor-script.ts";

const BASIC_MONITORS = [{ id: "api", url: "https://api.example.com/healthz" }];

describe("generateMonitorScript", () => {
	it("generates a script with scheduled handler only by default", () => {
		const script = generateMonitorScript(BASIC_MONITORS);
		expect(script).toContain("export default {");
		expect(script).toContain("async scheduled(controller, env, ctx)");
		expect(script).not.toContain("async fetch(request, env)");
		expect(script).not.toContain("handleStats");
	});

	it("adds fetch handler and handleStats when enableReadApi is true", () => {
		const script = generateMonitorScript(BASIC_MONITORS, {
			enableReadApi: true,
			readApiAuth: { type: "service-token" },
		});
		expect(script).toContain("async fetch(request, env)");
		expect(script).toContain('pathname === "/stats"');
		expect(script).toContain("CF-Access-Client-Id");
		expect(script).toContain("handleStats");
	});

	it("produces exactly one export default when read API is enabled", () => {
		const script = generateMonitorScript(BASIC_MONITORS, {
			enableReadApi: true,
		});
		const exportDefaults = script.match(/export default \{/g);
		expect(exportDefaults).toHaveLength(1);
	});

	it("produces exactly one export default when read API is disabled", () => {
		const script = generateMonitorScript(BASIC_MONITORS, {
			enableReadApi: false,
		});
		const exportDefaults = script.match(/export default \{/g);
		expect(exportDefaults).toHaveLength(1);
	});

	it("includes handleStats placeholder response when enabled", () => {
		const script = generateMonitorScript(BASIC_MONITORS, {
			enableReadApi: true,
		});
		expect(script).toContain("Stats endpoint placeholder");
		expect(script).toContain("generated_at");
	});

	it("embeds monitor config as JSON", () => {
		const script = generateMonitorScript([
			{ id: "grafana", url: "https://grafana.example.com/healthz" },
			{
				id: "api",
				url: "https://api.example.com/healthz",
				expectedCodes: [200, 204],
			},
		]);
		expect(script).toContain("grafana");
		expect(script).toContain("https://grafana.example.com/healthz");
		expect(script).toContain("https://api.example.com/healthz");
	});
});
