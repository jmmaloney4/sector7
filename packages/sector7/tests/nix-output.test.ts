import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	NixOutput,
	nixOutputCommandLogStem,
	REPO_ROOT_SIDECAR,
	resolveDrvPathTrigger,
	resolvePreviewStorePath,
	sameBuildRoot,
} from "../nix-output/nix-output";
import {
	cleanupFlakeRoots,
	makeDirectoryNamedFlakeNix,
	makeEmptyRoot,
	makeFlakeRoot,
} from "./helpers/flake-root";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

type MockResource = {
	type: string;
	name: string;
	inputs: Record<string, unknown>;
	parent?: string;
};

const resources: MockResource[] = [];

function installMocks(preview = false): void {
	pulumi.runtime.setMocks(
		{
			newResource: (args: pulumi.runtime.MockResourceArgs) => {
				const state = args.inputs;

				// For command.local.Command, simulate stdout with STORE_PATH_OUTPUT
				// marker. Every command:local:Command in this file's tests is the
				// nix-output-resolve.sh one — `create` is now a fixed "bash -s"
				// with the script piped via `stdin` (see the fix in nix-output.ts),
				// so there's nothing script-specific left to gate on here.
				if (args.type === "command:local:Command") {
					const env = state.environment as Record<string, string> | undefined;
					const subPath = env?.SUB_PATH;
					const baseStorePath = "/nix/store/abc123-myapp-1.0.0";
					const storePath = subPath
						? `${baseStorePath}/${subPath}`
						: baseStorePath;

					(state as Record<string, unknown>).stdout =
						`=== Resolved: ${storePath} ===\nSTORE_PATH_OUTPUT:${storePath}\n`;
				}

				resources.push({
					type: args.type,
					name: args.name,
					inputs: state as Record<string, unknown>,
					parent: args.parent?.urn ?? undefined,
				});

				return {
					id: `${args.name}-id`,
					state,
				};
			},
			call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
		},
		undefined,
		undefined,
		preview,
	);
}

const MOCK_DRV_PATH = "/nix/store/drvhash123-myapp-1.0.0.drv";

// NixOutput refuses when `repoRoot` disagrees with the ambient
// REPO_ROOT/FLAKE_ROOT, and when `repoRoot` has no flake.nix (#384).
// Tests must use a real flake directory (not `/home/user/my-repo`) and
// declare a matching ambient root rather than inheriting the developer's
// real devshell.
let TEST_REPO_ROOT = "";
let savedRepoRoot: string | undefined;
let savedFlakeRoot: string | undefined;

afterEach(async () => {
	// `beforeEach` installs a FRESH mock monitor for every test. A resource
	// registration still in flight when that happens lands on a monitor that
	// has never heard of its URN, and Pulumi surfaces that as an unhandled
	// rejection — which vitest reports as an error and exits non-zero even
	// though every assertion passed. Tests that construct a NixOutput and then
	// await one of its outputs drain themselves; the ones that assert
	// synchronously (a constructor that throws has no output to await) do not.
	// Drain here rather than in each test, so the invariant is "no test leaks
	// registrations into the next one" instead of a rule to remember.
	await new Promise((resolve) => setTimeout(resolve, 0));

	if (savedRepoRoot === undefined) delete process.env.REPO_ROOT;
	else process.env.REPO_ROOT = savedRepoRoot;
	if (savedFlakeRoot === undefined) delete process.env.FLAKE_ROOT;
	else process.env.FLAKE_ROOT = savedFlakeRoot;
	cleanupFlakeRoots();
});

beforeEach(() => {
	savedRepoRoot = process.env.REPO_ROOT;
	savedFlakeRoot = process.env.FLAKE_ROOT;
	TEST_REPO_ROOT = makeFlakeRoot();
	process.env.REPO_ROOT = TEST_REPO_ROOT;
	delete process.env.FLAKE_ROOT;
	resources.length = 0;
	vi.clearAllMocks();
	vi.restoreAllMocks();
	// Default changeDetection ("drv") evaluates the drvPath via execFileSync
	// during resource construction, so give it a stable answer.
	vi.mocked(execFileSync).mockReturnValue(`${MOCK_DRV_PATH}\n`);
	installMocks(false);
});

afterAll(() => {
	rmSync(".pulumi/command-logs", { recursive: true, force: true });
});

function resolveOutput<T>(value: pulumi.Input<T>): Promise<T> {
	return new Promise((resolve) => {
		pulumi.output(value).apply((resolved: T) => {
			resolve(resolved as T);
			return resolved;
		});
	});
}

function byName(fragment: string): MockResource[] {
	return resources.filter((resource) => resource.name.includes(fragment));
}

describe("NixOutput", () => {
	it("creates a Command resource in resolve mode by default", async () => {
		const output = new NixOutput("test-default", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
		});

		await resolveOutput(output.storePath);

		const cmds = byName("test-default-resolve");
		expect(cmds).toHaveLength(1);

		const cmd = cmds[0];
		expect(cmd.type).toBe("command:local:Command");
		// REPO_ROOT is deliberately absent: it would be an absolute,
		// machine-specific path baked into a diffed input, forcing a spurious
		// replace whenever the same stack is applied from a different
		// checkout. The spawned command reads it from its own ambient
		// environment instead — see nix-output-resolve.sh.
		expect(cmd.inputs.environment).toEqual({
			NIX_ATTR: "packages.x86_64-linux.myapp",
			SCRIPT_MODE: "resolve",
			COMMAND_LOG_STEM: ".pulumi/command-logs/test-default",
		});
		// `create` must be a FIXED string — not a resolved filesystem path
		// through node_modules, which would change on every checkout AND on
		// every sector7 version bump. The script content is piped via `stdin`
		// instead, so what's tracked is what the script does, not where it
		// happens to live on disk.
		expect(cmd.inputs.create).toBe("bash -s");
		expect(cmd.inputs.stdin).toContain(
			"Resolve or build a nix flake attribute",
		);

		const sidecar = readFileSync(
			join(nixOutputCommandLogStem("test-default"), REPO_ROOT_SIDECAR),
			"utf8",
		).trim();
		expect(sidecar).toBe(TEST_REPO_ROOT);
	});

	// The spawned command reads args.repoRoot from an untracked sidecar, not
	// from a diffed environment input. A stale ambient root is still refused
	// so a Pulumi process whose nix/devshell is in another tree cannot quietly
	// proceed (#384 / #385).
	it("refuses when repoRoot diverges from the ambient build root", () => {
		const repoRoot = makeFlakeRoot();
		process.env.FLAKE_ROOT = "/home/user/actual-repo";
		delete process.env.REPO_ROOT;

		expect(
			() =>
				new NixOutput("test-divergent-root", {
					nixAttr: "packages.x86_64-linux.myapp",
					repoRoot,
				}),
		).toThrow(
			/does not match the ambient REPO_ROOT\/FLAKE_ROOT[\s\S]*re-enter the nix devshell or reload direnv/i,
		);
	});

	// Shell `:-` falls through on an EMPTY string too, not just an unset one.
	// `??` would not, so `REPO_ROOT= pulumi up` would have us checking against
	// nothing while the script built FLAKE_ROOT's tree.
	it("treats an empty ambient REPO_ROOT as unset, like the shell does", () => {
		const repoRoot = makeFlakeRoot();
		process.env.REPO_ROOT = "";
		process.env.FLAKE_ROOT = "/home/user/flake-root-repo";

		expect(
			() =>
				new NixOutput("test-empty-repo-root", {
					nixAttr: "packages.x86_64-linux.myapp",
					repoRoot,
				}),
		).toThrow(/\/home\/user\/flake-root-repo/);
	});

	// The script's own precedence is ${REPO_ROOT:-${FLAKE_ROOT:-}}, so an
	// explicit REPO_ROOT must win over FLAKE_ROOT here too — otherwise pinning
	// the build with REPO_ROOT would be rejected by a stale FLAKE_ROOT.
	it("prefers ambient REPO_ROOT over FLAKE_ROOT when both are set", () => {
		process.env.FLAKE_ROOT = "/home/user/stale-devshell-root";
		process.env.REPO_ROOT = TEST_REPO_ROOT;

		expect(
			() =>
				new NixOutput("test-repo-root-wins", {
					nixAttr: "packages.x86_64-linux.myapp",
					repoRoot: TEST_REPO_ROOT,
				}),
		).not.toThrow(); // REPO_ROOT won; no divergence against FLAKE_ROOT
	});

	// FLAKE_ROOT alone is still a valid way to declare the build root — the
	// script falls back to it when REPO_ROOT is unset, so this must not refuse.
	it("accepts a repoRoot matching the ambient FLAKE_ROOT", async () => {
		delete process.env.REPO_ROOT;
		process.env.FLAKE_ROOT = TEST_REPO_ROOT;

		const output = new NixOutput("test-matching-root", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
		});
		await expect(resolveOutput(output.storePath)).resolves.toBeDefined();
	});

	it("forwards repoRoot via sidecar when ambient REPO_ROOT/FLAKE_ROOT are unset", async () => {
		delete process.env.REPO_ROOT;
		delete process.env.FLAKE_ROOT;

		const output = new NixOutput("test-sidecar-no-ambient", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
		});
		await resolveOutput(output.storePath);

		const cmds = byName("test-sidecar-no-ambient-resolve");
		expect(cmds[0].inputs.environment).not.toHaveProperty("REPO_ROOT");
		expect(
			readFileSync(
				join(
					nixOutputCommandLogStem("test-sidecar-no-ambient"),
					REPO_ROOT_SIDECAR,
				),
				"utf8",
			).trim(),
		).toBe(TEST_REPO_ROOT);
	});

	it("keeps COMMAND_LOG_STEM on the pre-upgrade formula so upgrades do not ~environment", async () => {
		const output = new NixOutput("test-upgrade-log-stem", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
		});
		const storePath = await resolveOutput(output.storePath);

		const cmds = byName("test-upgrade-log-stem-resolve");
		const env = cmds[0].inputs.environment as Record<string, string>;
		// Pre-#401 / origin/main formula. A stack- or hash-prefixed stem
		// would show `~environment` on every existing NixOutput at first up.
		expect(env.COMMAND_LOG_STEM).toBe(
			".pulumi/command-logs/test-upgrade-log-stem",
		);
		expect(env.COMMAND_LOG_STEM).toBe(
			nixOutputCommandLogStem("test-upgrade-log-stem"),
		);
		expect(storePath).toBe("/nix/store/abc123-myapp-1.0.0");
	});

	it("does not add a sidecar trigger when repoRoot is a dynamic Output", async () => {
		const output = new NixOutput("test-upgrade-dynamic-root", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: pulumi.output(TEST_REPO_ROOT),
		});
		const storePath = await resolveOutput(output.storePath);

		const cmds = byName("test-upgrade-dynamic-root-resolve");
		const triggers = cmds[0].inputs.triggers as string[];
		expect(triggers).toEqual(["packages.x86_64-linux.myapp", MOCK_DRV_PATH]);
		expect(triggers).not.toContain("repo-root-sidecar");
		expect(storePath).toBe("/nix/store/abc123-myapp-1.0.0");
	});

	it("exposes git provenance as outputs without putting them on the Command", async () => {
		const output = new NixOutput("test-provenance-outputs", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
		});

		await expect(resolveOutput(output.gitSha)).resolves.toEqual(
			expect.any(String),
		);
		await expect(resolveOutput(output.gitDirty)).resolves.toEqual(
			expect.any(Boolean),
		);
		await expect(resolveOutput(output.gitBranch)).resolves.toEqual(
			expect.any(String),
		);

		const cmds = byName("test-provenance-outputs-resolve");
		const env = cmds[0].inputs.environment as Record<string, unknown>;
		expect(env).not.toHaveProperty("GIT_SHA");
		expect(env).not.toHaveProperty("gitSha");
	});

	// A refusal has to be about the tree, not about how it was spelled. A
	// devshell that exports a trailing slash names the same directory, and
	// blocking a deploy over that would be a false refusal.
	it("accepts a repoRoot that differs from the ambient root only in spelling", async () => {
		process.env.REPO_ROOT = `${TEST_REPO_ROOT}/`;

		const output = new NixOutput("test-trailing-slash-root", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
		});
		await expect(resolveOutput(output.storePath)).resolves.toBeDefined();
	});

	it("refuses when repoRoot does not contain flake.nix", () => {
		const repoRoot = makeEmptyRoot();
		process.env.REPO_ROOT = repoRoot;

		expect(
			() =>
				new NixOutput("test-missing-flake", {
					nixAttr: "packages.x86_64-linux.myapp",
					repoRoot,
				}),
		).toThrow(/does not contain flake\.nix/);
	});

	it("refuses when flake.nix is a directory rather than a file", () => {
		const repoRoot = makeDirectoryNamedFlakeNix();
		process.env.REPO_ROOT = repoRoot;

		expect(
			() =>
				new NixOutput("test-flake-nix-is-dir", {
					nixAttr: "packages.x86_64-linux.myapp",
					repoRoot,
				}),
		).toThrow(/does not contain flake\.nix/);
	});

	it("creates a Command resource in build mode when specified", async () => {
		const output = new NixOutput("test-build", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
			mode: "build",
		});

		await resolveOutput(output.storePath);

		const cmds = byName("test-build-resolve");
		expect(cmds).toHaveLength(1);

		const cmd = cmds[0];
		expect(cmd.inputs.environment).toMatchObject({
			SCRIPT_MODE: "build",
			NIX_ATTR: "packages.x86_64-linux.myapp",
		});
		expect(cmd.inputs.environment).not.toHaveProperty("REPO_ROOT");
	});

	it("parses STORE_PATH_OUTPUT marker from stdout", async () => {
		const output = new NixOutput("test-storepath", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
		});

		const storePath = await resolveOutput(output.storePath);
		expect(storePath).toBe("/nix/store/abc123-myapp-1.0.0");
	});

	it("passes subOutput as SUB_OUTPUT env var", async () => {
		const output = new NixOutput("test-suboutput", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
			subOutput: "docs",
		});

		await resolveOutput(output.storePath);

		const cmds = byName("test-suboutput-resolve");
		expect(cmds).toHaveLength(1);
		expect(cmds[0].inputs.environment).toMatchObject({
			SUB_OUTPUT: "docs",
		});
	});

	it("passes subPath as SUB_PATH env var and resolves full path", async () => {
		const output = new NixOutput("test-subpath", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
			subPath: "assets/style.css",
		});

		const storePath = await resolveOutput(output.storePath);
		expect(storePath).toBe("/nix/store/abc123-myapp-1.0.0/assets/style.css");
	});

	it("combines subOutput and subPath", async () => {
		const output = new NixOutput("test-combined", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
			subOutput: "docs",
			subPath: "api/index.html",
		});

		const storePath = await resolveOutput(output.storePath);
		expect(storePath).toBe("/nix/store/abc123-myapp-1.0.0/api/index.html");

		const cmds = byName("test-combined-resolve");
		expect(cmds[0].inputs.environment).toMatchObject({
			SUB_OUTPUT: "docs",
			SUB_PATH: "api/index.html",
		});
	});

	it("includes the drvPath trigger by default", async () => {
		const output = new NixOutput("test-trigger-default", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
		});

		await resolveOutput(output.storePath);

		const cmds = byName("test-trigger-default-resolve");
		expect(cmds).toHaveLength(1);

		const triggers = cmds[0].inputs.triggers as string[];
		expect(triggers).toEqual(["packages.x86_64-linux.myapp", MOCK_DRV_PATH]);
		expect(execFileSync).toHaveBeenCalledWith(
			"nix",
			[
				"eval",
				"--raw",
				`${TEST_REPO_ROOT}#packages.x86_64-linux.myapp.drvPath`,
			],
			expect.objectContaining({ encoding: "utf8" }),
		);
	});

	it("omits the drvPath trigger with changeDetection none", async () => {
		const output = new NixOutput("test-trigger-none", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
			changeDetection: "none",
		});

		await resolveOutput(output.storePath);

		const cmds = byName("test-trigger-none-resolve");
		expect(cmds).toHaveLength(1);

		const triggers = cmds[0].inputs.triggers as string[];
		expect(triggers).toEqual(["packages.x86_64-linux.myapp"]);

		// The point of `changeDetection: "none"` is to skip the flake
		// evaluation, so assert on that specifically rather than on
		// execFileSync being untouched at all. Provenance (#384) does shell out
		// to `git`, which is cheap — and precisely because "none" leaves no
		// content signal whatsoever, it is the only thing that will say what
		// tree this built from.
		const nixCalls = vi
			.mocked(execFileSync)
			.mock.calls.filter(([bin]) => bin === "nix");
		expect(nixCalls).toHaveLength(0);
	});

	it("appends custom triggers after nixAttr and the drvPath trigger", async () => {
		const output = new NixOutput("test-trigger-custom", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
			triggers: ["commit-sha-abc", "v2.0.0"],
		});

		await resolveOutput(output.storePath);

		const cmds = byName("test-trigger-custom-resolve");
		expect(cmds).toHaveLength(1);

		const triggers = cmds[0].inputs.triggers as string[];
		expect(triggers).toEqual([
			"packages.x86_64-linux.myapp",
			MOCK_DRV_PATH,
			"commit-sha-abc",
			"v2.0.0",
		]);
	});

	it("resolveDrvPathTrigger trims the evaluated drv path", () => {
		vi.mocked(execFileSync).mockReturnValue("/nix/store/deadbeef-site.drv\n");

		const drvPath = resolveDrvPathTrigger("/repo", "site-html");
		expect(drvPath).toBe("/nix/store/deadbeef-site.drv");
		expect(execFileSync).toHaveBeenCalledWith(
			"nix",
			["eval", "--raw", "/repo#site-html.drvPath"],
			expect.objectContaining({ encoding: "utf8" }),
		);
	});

	it("resolveDrvPathTrigger surfaces stderr on eval failure", () => {
		vi.mocked(execFileSync).mockImplementation(() => {
			const error = new Error("Command failed") as Error & {
				stderr: string;
			};
			error.stderr = "error: attribute 'missing' not found";
			throw error;
		});

		expect(() => resolveDrvPathTrigger("/repo", "missing")).toThrow(
			/failed to evaluate drvPath for \/repo#missing.*attribute 'missing' not found/s,
		);
	});

	it("passes extra env vars to the command", async () => {
		const output = new NixOutput("test-env", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
			env: { MY_VAR: "my-value" },
		});

		await resolveOutput(output.storePath);

		const cmds = byName("test-env-resolve");
		expect(cmds[0].inputs.environment).toMatchObject({
			MY_VAR: "my-value",
		});
	});

	it("registers storePath as output", async () => {
		const output = new NixOutput("test-outputs", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
		});

		const storePath = await resolveOutput(output.storePath);
		expect(storePath).toBeTruthy();
		expect(storePath).toMatch(/^\/nix\/store\//);
	});

	it("uses the sector7:nix:NixOutput type token", async () => {
		const output = new NixOutput("test-type-token", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
		});

		await resolveOutput(output.storePath);

		const component = resources.find(
			(r) => r.type === "sector7:nix:NixOutput" && r.name === "test-type-token",
		);
		expect(component).toBeDefined();
	});

	it("does not include SUB_OUTPUT or SUB_PATH when not specified", async () => {
		const output = new NixOutput("test-no-sub", {
			nixAttr: "packages.x86_64-linux.myapp",
			repoRoot: TEST_REPO_ROOT,
		});

		await resolveOutput(output.storePath);

		const cmds = byName("test-no-sub-resolve");
		const env = cmds[0].inputs.environment as Record<string, unknown>;
		expect(env).not.toHaveProperty("SUB_OUTPUT");
		expect(env).not.toHaveProperty("SUB_PATH");
	});

	it("eager preview helper resolves a concrete store path when env is static", () => {
		const execSpy = vi
			.mocked(execFileSync)
			.mockReturnValue(
				"=== Resolved: /nix/store/eager123-myapp-1.0.0 ===\nSTORE_PATH_OUTPUT:/nix/store/eager123-myapp-1.0.0\n",
			);

		const storePath = resolvePreviewStorePath(
			"test-preview-eager",
			"/tmp/nix-output-resolve.sh",
			{
				NIX_ATTR: "packages.x86_64-linux.myapp",
				REPO_ROOT: "/home/user/my-repo",
				SCRIPT_MODE: "build",
				COMMAND_LOG_STEM: ".pulumi/command-logs/test-preview-eager",
				EXTRA_FLAG: "enabled",
			},
		);

		expect(storePath).toBe("/nix/store/eager123-myapp-1.0.0");
		expect(execSpy).toHaveBeenCalledOnce();
		expect(execSpy).toHaveBeenCalledWith(
			"bash",
			["/tmp/nix-output-resolve.sh"],
			expect.objectContaining({
				encoding: "utf8",
				env: expect.objectContaining({
					NIX_ATTR: "packages.x86_64-linux.myapp",
					REPO_ROOT: "/home/user/my-repo",
					SCRIPT_MODE: "build",
					COMMAND_LOG_STEM: ".pulumi/command-logs/test-preview-eager",
					EXTRA_FLAG: "enabled",
				}),
			}),
		);
	});

	it("eager preview helper returns undefined when the script fails", () => {
		const execSpy = vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error("nix failed");
		});

		const storePath = resolvePreviewStorePath(
			"test-preview-failure",
			"/tmp/nix-output-resolve.sh",
			{
				NIX_ATTR: "packages.x86_64-linux.myapp",
				REPO_ROOT: "/home/user/my-repo",
				SCRIPT_MODE: "build",
				COMMAND_LOG_STEM: ".pulumi/command-logs/test-preview-failure",
			},
		);

		expect(storePath).toBeUndefined();
		expect(execSpy).toHaveBeenCalledOnce();
	});

	it("eager preview helper preserves spaces in parsed store paths", () => {
		vi.mocked(execFileSync).mockReturnValue(
			"=== Resolved: /nix/store/eager123-my app-1.0.0 ===\nSTORE_PATH_OUTPUT:/nix/store/eager123-my app-1.0.0\n",
		);

		const storePath = resolvePreviewStorePath(
			"test-preview-spaces",
			"/tmp/nix-output-resolve.sh",
			{
				NIX_ATTR: "packages.x86_64-linux.myapp",
				REPO_ROOT: "/home/user/my-repo",
				SCRIPT_MODE: "build",
				COMMAND_LOG_STEM: ".pulumi/command-logs/test-preview-spaces",
			},
		);

		expect(storePath).toBe("/nix/store/eager123-my app-1.0.0");
	});

	it("eager preview helper returns undefined when any env input is dynamic", () => {
		const execSpy = vi.mocked(execFileSync);

		const storePath = resolvePreviewStorePath(
			"test-preview-fallback",
			"/tmp/nix-output-resolve.sh",
			{
				NIX_ATTR: "packages.x86_64-linux.myapp",
				REPO_ROOT: pulumi.output("/home/user/my-repo"),
				SCRIPT_MODE: "build",
				COMMAND_LOG_STEM: ".pulumi/command-logs/test-preview-fallback",
			},
		);

		expect(storePath).toBeUndefined();
		expect(execSpy).not.toHaveBeenCalled();
	});
});

// Real directories and a real symlink rather than a mocked `realpathSync`:
// the unit under test IS the path resolution, so mocking it would assert our
// idea of how symlinks resolve instead of the filesystem's.
describe("sameBuildRoot", () => {
	const roots: string[] = [];

	afterAll(() => {
		for (const r of roots) rmSync(r, { recursive: true, force: true });
	});

	function tempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		roots.push(dir);
		return dir;
	}

	it("accepts a trailing slash on either side", () => {
		const root = tempDir("s7-root-");
		expect(sameBuildRoot(root, `${root}/`)).toBe(true);
		expect(sameBuildRoot(`${root}/`, root)).toBe(true);
	});

	it("resolves a symlinked build root to the tree it points at", () => {
		// The shape that bites in practice: a devshell exports the real path
		// while the caller passes the symlink it stood in (or the reverse).
		const real = tempDir("s7-real-");
		const parent = tempDir("s7-link-");
		const link = join(parent, "checkout");
		symlinkSync(real, link, "dir");

		expect(sameBuildRoot(link, real)).toBe(true);
	});

	it("still refuses two genuinely different trees", () => {
		expect(sameBuildRoot(tempDir("s7-a-"), tempDir("s7-b-"))).toBe(false);
	});

	it("compares unresolvable roots literally rather than collapsing them", () => {
		// A repoRoot that does not exist is its own problem; it must not be
		// silently equal to some other nonexistent path.
		expect(sameBuildRoot("/nope/one", "/nope/two")).toBe(false);
		expect(sameBuildRoot("/nope/one", "/nope/one")).toBe(true);
		expect(sameBuildRoot("/nope/one/", "/nope/one")).toBe(true);
	});
});
