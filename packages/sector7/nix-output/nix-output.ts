import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { getScriptPath } from "../scripts/index.ts";
import {
	describeRepoProvenance,
	resolveRepoProvenance,
} from "./repo-provenance.ts";

/**
 * Tracked `COMMAND_LOG_STEM` for the child Command — and the directory the
 * untracked `repo-root` sidecar is written into.
 *
 * This formula is load-bearing for upgrade diffs. It MUST stay
 * `.pulumi/command-logs/${name}`, the same string every existing stack stored
 * before #401. Namespacing by stack or hashing the name would change a
 * tracked `environment` value and force `~environment` + a Command re-run on
 * every NixOutput/NixImage at first `pulumi up` after upgrade. After
 * zeus#3162 that is not "routine churn". Sidecar isolation therefore follows
 * the log directory: two stacks sharing a cwd and a resource name already
 * shared this path.
 */
export function nixOutputCommandLogStem(name: string): string {
	return `.pulumi/command-logs/${name}`;
}

export interface NixOutputArgs {
	/** Flake attribute path (e.g. "packages.x86_64-linux.lens-api-image") */
	nixAttr: pulumi.Input<string>;
	/**
	 * Absolute path to the repo root containing the flake.
	 *
	 * Controls drvPath evaluation, eager preview, provenance outputs, and
	 * (via an untracked sidecar file, not a Pulumi input) the tree
	 * `nix-output-resolve.sh` actually builds. The absolute path is never
	 * placed in the child Command's tracked `environment`, `stdin`, or
	 * `create` inputs: doing so would force a spurious replace whenever the
	 * same stack is applied from a different checkout than whoever last
	 * applied it. Two clean worktrees of the same commit evaluate to the
	 * same drvPath; the path is not a content signal.
	 *
	 * Construction still refuses when this path names a different tree than
	 * the ambient `REPO_ROOT`/`FLAKE_ROOT` (#385). That check is a safety
	 * net for a stale inherited devshell — it is no longer what *selects*
	 * the build tree. Re-enter the nix devshell or reload direnv in the
	 * worktree you mean to deploy from; to pin one-shot:
	 *
	 *     REPO_ROOT=/path/to/checkout pulumi up
	 *
	 * The path must contain a `flake.nix`. A nested Pulumi program directory
	 * (`deploy/services/…`, `process.cwd()` of `pulumi up`) is refused early
	 * instead of failing later as an opaque nix evaluation error.
	 */
	repoRoot: pulumi.Input<string>;
	/**
	 * Select a named output from a multi-output nix derivation.
	 * Nix derivations can produce outputs like `out`, `dev`, `docs`.
	 * Use this to select a specific output: the attribute becomes
	 * `nixAttr^subOutput` (e.g. `packages.x86_64-linux.myapp^docs`).
	 * Only meaningful when the underlying derivation is a multi-output
	 * derivation. Ignored (no-op) for single-output derivations.
	 */
	subOutput?: pulumi.Input<string>;
	/**
	 * Select a sub-path within the resolved store path.
	 * The store path is the root output; this picks a file or directory
	 * inside it. Example: if `storePath` resolves to
	 * `/nix/store/...-myapp-docs/`, then `subPath: "assets/style.css"`
	 * produces `/nix/store/...-myapp-docs/assets/style.css`.
	 * The path must exist within the output derivation.
	 */
	subPath?: pulumi.Input<string>;
	/** Additional trigger values (added alongside the computed triggers). */
	triggers?: pulumi.Input<string>[];
	/**
	 * How the component detects that the nix output changed so the child
	 * command re-runs on `pulumi up`.
	 *
	 * "drv" (default) evaluates the derivation path
	 * (`nix eval --raw <repoRoot>#<nixAttr>.drvPath`) at program time and
	 * includes it in the command's triggers. The drv hash covers every
	 * transitive build input — sources, lockfiles, flake inputs — so the
	 * command re-runs exactly when the build would produce a different
	 * result, and previews stay clean when nothing changed. Costs one
	 * flake evaluation per preview/up.
	 *
	 * "none" restores the legacy behavior: the command re-runs only when
	 * `nixAttr` or a caller-supplied trigger changes. With no custom
	 * triggers this means content changes never re-resolve — the store
	 * path is served from Pulumi state until an input string changes.
	 */
	changeDetection?: "drv" | "none";
	/**
	 * "resolve" = resolve the output path without building (default).
	 * Fast — just evaluates the flake to find the store path.
	 * Fails if the derivation hasn't been built yet and isn't cached
	 * locally.
	 *
	 * "build" = ensure the output exists by building the derivation.
	 * Runs `nix build` before resolving. Expensive but guarantees the
	 * output is in the local store.
	 */
	mode?: "resolve" | "build";
	/**
	 * Preview path resolution strategy.
	 *
	 * "resource" (default) keeps the existing Pulumi resource-backed
	 * behavior, which means `storePath` can be unknown during preview when
	 * the child command needs to rerun.
	 *
	 * "eager" attempts to resolve the store path during preview when all
	 * inputs needed by the script are plain strings. This preserves better
	 * downstream preview fidelity for consumers like local Helm charts.
	 * If any required input is still dynamic, it falls back to
	 * resource-backed behavior.
	 */
	previewStrategy?: "resource" | "eager";
	/** Extra environment variables to pass to the command. */
	env?: Record<string, pulumi.Input<string>>;
}

function parseStorePath(stdout: string, name: string): string {
	const prefix = "STORE_PATH_OUTPUT:";
	const line = stdout
		.trim()
		.split(/\r?\n/)
		.find((entry) => entry.startsWith(prefix));
	if (!line) {
		throw new Error(
			`Could not parse STORE_PATH_OUTPUT from output for ${name}`,
		);
	}
	return line.slice(prefix.length);
}

/**
 * Evaluate the derivation path for a flake attribute. The drv path is
 * nix's own content hash over every transitive build input, which makes
 * it the precise "did anything relevant change?" trigger — Pulumi cannot
 * know which files feed a build, but nix can.
 *
 * Exported for testing.
 */
export function resolveDrvPathTrigger(
	repoRoot: string,
	nixAttr: string,
): string {
	try {
		return execFileSync(
			"nix",
			["eval", "--raw", `${repoRoot}#${nixAttr}.drvPath`],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		).trim();
	} catch (error) {
		const stderr =
			error instanceof Error && "stderr" in error
				? String((error as { stderr?: unknown }).stderr ?? "")
				: "";
		throw new Error(
			`NixOutput: failed to evaluate drvPath for ${repoRoot}#${nixAttr}` +
				` (changeDetection: "drv"): ${stderr || String(error)}`,
		);
	}
}

function repoRootHasFlakeNix(repoRoot: string): boolean {
	try {
		// `statSync` follows a symlink; `isFile()` rejects a directory that
		// happens to be named flake.nix (`existsSync` would accept that).
		return statSync(join(repoRoot, "flake.nix")).isFile();
	} catch {
		return false;
	}
}

/**
 * Resolve a build root to the directory it actually names: symlinks followed,
 * trailing slashes dropped. Falls back to the literal spelling when the path
 * cannot be resolved — a `repoRoot` that does not exist is its own problem,
 * and must not be quietly made equal to anything.
 */
function canonicalBuildRoot(repoRoot: string): string {
	try {
		return realpathSync(repoRoot);
	} catch {
		return repoRoot.replace(/(.)\/+$/, "$1");
	}
}

/**
 * Whether two build roots name the same tree.
 *
 * Compared as trees rather than as strings, because the ambient variable and
 * a caller's `repoRoot` routinely spell one directory two ways: a trailing
 * slash, a symlinked checkout parent, `/tmp` vs `/private/tmp` on macOS. That
 * was harmless while a divergence only warned; now that it refuses, a spelling
 * difference would block a deploy that was never wrong. `realpathSync` is the
 * same resolution nix performs on a bare-path flake ref, so agreeing here
 * means agreeing about the artifact.
 *
 * Exported for testing.
 */
export function sameBuildRoot(a: string, b: string): boolean {
	return a === b || canonicalBuildRoot(a) === canonicalBuildRoot(b);
}

/** Basename of the untracked sidecar NixOutput uses to forward `repoRoot`. */
export const REPO_ROOT_SIDECAR = "repo-root";

/**
 * Write `repoRoot` where `nix-output-resolve.sh` will read it. The file is
 * not a Pulumi input: its contents can differ by machine without showing up
 * in a preview diff. Exported for testing.
 */
export function writeRepoRootSidecar(
	commandLogStem: string,
	repoRoot: string,
): void {
	mkdirSync(commandLogStem, { recursive: true });
	writeFileSync(join(commandLogStem, REPO_ROOT_SIDECAR), `${repoRoot}\n`, {
		encoding: "utf8",
	});
}

function isStringRecord(
	value: Record<string, pulumi.Input<string>>,
): value is Record<string, string> {
	return Object.values(value).every((entry) => typeof entry === "string");
}

export function resolvePreviewStorePath(
	name: string,
	scriptPath: string,
	env: Record<string, pulumi.Input<string>>,
): string | undefined {
	if (!isStringRecord(env)) {
		return undefined;
	}

	try {
		const stdout = execFileSync("bash", [scriptPath], {
			encoding: "utf8",
			env: {
				...process.env,
				...env,
			},
		});
		return parseStorePath(stdout, name);
	} catch {
		return undefined;
	}
}

export class NixOutput extends pulumi.ComponentResource {
	/** The /nix/store/... store path of the resolved output */
	public readonly storePath: pulumi.Output<string>;
	/**
	 * Git HEAD of `repoRoot` at program time, or `"unknown"` when git cannot
	 * be read. Informational only: not a Command input or trigger, so a
	 * checkout/SHA change does not replace the build. Consumers that stamp
	 * this onto a pod annotation will update that downstream resource.
	 */
	public readonly gitSha: pulumi.Output<string>;
	/**
	 * Tracked files differ from HEAD. Untracked files do not count — nix
	 * excludes them from a bare-path flake build. Informational; same
	 * replacement rule as {@link gitSha}.
	 */
	public readonly gitDirty: pulumi.Output<boolean>;
	/**
	 * Current branch, `"(detached)"`, or `"unknown"`. Informational; same
	 * replacement rule as {@link gitSha}.
	 */
	public readonly gitBranch: pulumi.Output<string>;

	constructor(
		name: string,
		args: NixOutputArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		// Build resource aliases: add URN alias when parented so the child
		// resource is adopted correctly under the parent.
		const aliases: pulumi.Alias[] = [];
		if (opts?.parent) {
			aliases.push({ parent: opts.parent });
		}

		// `repoRoot` is deliberately excluded from the registered inputs.
		//
		// It is an absolute, machine- and checkout-specific path, and its VALUE
		// provably does not affect what gets built: two clean worktrees of the
		// same commit, at different paths, evaluate to an identical drvPath. So
		// diffing it churns every NixOutput and NixImage whenever a preview runs
		// from a different checkout than the last deploy — `[diff: ~repoRoot]` on
		// resources whose content is unchanged.
		//
		// The content signal is the drvPath trigger below, which is exactly the
		// right one: the drv hash covers every transitive input. `repoRoot`
		// reaches the script through an untracked sidecar under COMMAND_LOG_STEM
		// so the parameter controls the build without becoming a diffed input.
		// `checkRoot` still refuses an ambient/devshell mismatch as a safety net.
		//
		// Same reasoning as the script-path handling immediately below, and as
		// `pushGroup` in NixImage.
		const { repoRoot: _repoRoot, ...registrableArgs } = args;

		super("sector7:nix:NixOutput", name, registrableArgs, {
			...opts,
			aliases: [...aliases, ...(opts?.aliases ?? [])],
		});

		const scriptPath = getScriptPath("nix-output-resolve.sh");
		// The script's own CONTENT is what should drive the tracked `create`
		// input, not its resolved filesystem path. getScriptPath() returns an
		// absolute path through node_modules, which is both checkout-location-
		// dependent (same bug class as REPO_ROOT above) AND changes on every
		// single sector7 version bump — pnpm encodes the resolved package
		// version into the .pnpm store directory name. Baking that path into
		// `create` forced a replace of this Command on every version bump
		// regardless of whether the script itself changed. Piping the content
		// via `stdin` with a fixed `create` command makes the tracked input
		// depend only on what the script actually does.
		const scriptContent = readFileSync(scriptPath, "utf8");
		const commandLogStem = nixOutputCommandLogStem(name);
		const mode = args.mode ?? "resolve";
		const previewStrategy = args.previewStrategy ?? "resource";

		// REPO_ROOT is deliberately NOT included here. It would be a diffed
		// input on the spawned command. The script reads args.repoRoot from
		// ${COMMAND_LOG_STEM}/repo-root (written below), then falls back to
		// ambient REPO_ROOT/FLAKE_ROOT. See ADR-021.
		const env: Record<string, pulumi.Input<string>> = {
			...(args.env ?? {}),
			NIX_ATTR: args.nixAttr,
			SCRIPT_MODE: mode,
			COMMAND_LOG_STEM: commandLogStem,
			...(args.subOutput ? { SUB_OUTPUT: args.subOutput } : {}),
			...(args.subPath ? { SUB_PATH: args.subPath } : {}),
		};

		// Checked eagerly when `repoRoot` is a plain string, which is every
		// known caller: a throw inside `.apply()` surfaces as a deferred
		// rejection rather than a constructor error, which is both harder to act
		// on and easy to miss. The apply is kept as a backstop for genuinely
		// dynamic inputs, and that apply also writes the sidecar so the Command
		// cannot run before the path is on disk.
		const checkRoot = (repoRoot: string) => {
			if (!repoRootHasFlakeNix(repoRoot)) {
				throw new Error(
					`NixOutput(${name}): repoRoot ("${repoRoot}") does not contain ` +
						"flake.nix. Pass the absolute path to the flake checkout, not " +
						"a nested Pulumi program directory (for example deploy/services/) " +
						"or process.cwd() of `pulumi up`.",
				);
			}

			// Mirror the script's ambient fallback: ${REPO_ROOT:-${FLAKE_ROOT:-}}.
			// `||`, not `??` — shell `:-` falls through on an *empty* string as
			// well as an unset one, so `REPO_ROOT= pulumi up` must still resolve
			// to FLAKE_ROOT here. The sidecar makes repoRoot control the build;
			// this check is the safety net for a Pulumi process whose nix/devshell
			// is rooted in a different tree than the one named.
			const ambient = process.env.REPO_ROOT || process.env.FLAKE_ROOT;
			if (ambient && !sameBuildRoot(repoRoot, ambient)) {
				// This was a warn, on the reasoning that it "should never fire in
				// practice". It fired: cavinsresearch/zeus#3162, where a deploy
				// built an image from a branch nobody named and a prod deploy came
				// one command from doing the same. The assumption holds only while
				// every consumer runs in a devshell rooted at the tree it means,
				// which stops being true the moment anyone uses a git worktree, a
				// second checkout, or a repo shared by concurrent sessions.
				//
				// A warning is the wrong severity for that class of operator error
				// and is easily lost in `pulumi up` output. Refuse instead — in the
				// intended case the two are equal and this costs nothing.
				throw new Error(
					`NixOutput(${name}): repoRoot ("${repoRoot}") does not match the ` +
						`ambient REPO_ROOT/FLAKE_ROOT ("${ambient}"). Re-enter the nix ` +
						"devshell or reload direnv in the worktree you mean to deploy " +
						`from (${repoRoot}), then retry. To pin one-shot:\n  ` +
						`REPO_ROOT=${repoRoot} pulumi up`,
				);
			}

			writeRepoRootSidecar(commandLogStem, repoRoot);

			// Named at program time so a preview says which commit it is about
			// to build. The drvPath trigger below already detects *that* the
			// content changed; this says what tree the change came from, which a
			// store-path hash cannot.
			pulumi.log.info(
				`NixOutput(${name}): building ${describeRepoProvenance(
					resolveRepoProvenance(repoRoot),
				)}`,
				this,
			);
			return repoRoot;
		};

		const repoRootReady: pulumi.Output<string> =
			typeof args.repoRoot === "string"
				? pulumi.output(checkRoot(args.repoRoot))
				: pulumi.output(args.repoRoot).apply(checkRoot);

		const provenance = repoRootReady.apply(resolveRepoProvenance);
		this.gitSha = provenance.apply((p) => p.gitSha);
		this.gitDirty = provenance.apply((p) => p.dirty);
		this.gitBranch = provenance.apply((p) => p.branch);

		const changeDetection = args.changeDetection ?? "drv";
		const drvPathTrigger =
			changeDetection === "drv"
				? pulumi
						.all([repoRootReady, args.nixAttr])
						.apply(([repoRoot, nixAttr]) =>
							resolveDrvPathTrigger(repoRoot, nixAttr),
						)
				: undefined;

		// String repoRoot (every known caller): keep `nixAttr` as the trigger
		// entry, identical to pre-#401. Dynamic repoRoot: wait for the sidecar
		// write without adding a new trigger *value* — the resolved string is
		// still `nixAttr`, so first apply after upgrade does not `~triggers`.
		const nixAttrTrigger =
			typeof args.repoRoot === "string"
				? args.nixAttr
				: pulumi
						.all([args.nixAttr, repoRootReady])
						.apply(([nixAttr]) => nixAttr);

		const cmd = new command.local.Command(
			`${name}-resolve`,
			{
				create: "bash -s",
				stdin: scriptContent,
				environment: env,
				triggers: [
					nixAttrTrigger,
					...(drvPathTrigger !== undefined ? [drvPathTrigger] : []),
					...(args.triggers ?? []),
				],
			},
			{ parent: this },
		);

		const eagerStorePath =
			previewStrategy === "eager" && pulumi.runtime.isDryRun()
				? resolvePreviewStorePath(name, scriptPath, env)
				: undefined;

		this.storePath =
			eagerStorePath !== undefined
				? pulumi.output(eagerStorePath)
				: cmd.stdout.apply((stdout: string) => parseStorePath(stdout, name));

		this.registerOutputs({
			storePath: this.storePath,
			gitSha: this.gitSha,
			gitDirty: this.gitDirty,
			gitBranch: this.gitBranch,
		});
	}
}
