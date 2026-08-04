import { execFileSync } from "node:child_process";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { getScriptPath } from "../scripts/index.ts";

export interface NixOutputArgs {
	/** Flake attribute path (e.g. "packages.x86_64-linux.lens-api-image") */
	nixAttr: pulumi.Input<string>;
	/**
	 * Absolute path to the repo root containing the flake.
	 *
	 * Used locally (drvPath trigger resolution, eager preview resolution) —
	 * never forwarded into the spawned command's tracked `environment` input.
	 * That command instead reads REPO_ROOT from its own ambient environment
	 * at execution time, falling back to FLAKE_ROOT (see
	 * nix-output-resolve.sh). Forwarding this value would bake an absolute,
	 * machine-specific filesystem path into a diffed Pulumi input, forcing a
	 * spurious replace whenever the same stack is applied from a different
	 * checkout path than whoever last applied it. In every known caller this
	 * value is already identical to the ambient FLAKE_ROOT at runtime, so the
	 * command sees the same path either way — it just isn't tracked.
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

		super("sector7:nix:NixOutput", name, args, {
			...opts,
			aliases: [...aliases, ...(opts?.aliases ?? [])],
		});

		const scriptPath = getScriptPath("nix-output-resolve.sh");
		const commandLogStem = `.pulumi/command-logs/${name}`;
		const mode = args.mode ?? "resolve";
		const previewStrategy = args.previewStrategy ?? "resource";

		// REPO_ROOT is deliberately NOT included here. It would be a diffed
		// input on the spawned command (directly, or via resolvePreviewStorePath
		// below, which merges this map over the ambient process.env). The
		// script reads it from the ambient environment at execution time
		// instead, falling back to FLAKE_ROOT — see the doc comment on
		// NixOutputArgs.repoRoot and nix-output-resolve.sh.
		const env: Record<string, pulumi.Input<string>> = {
			...(args.env ?? {}),
			NIX_ATTR: args.nixAttr,
			SCRIPT_MODE: mode,
			COMMAND_LOG_STEM: commandLogStem,
			...(args.subOutput ? { SUB_OUTPUT: args.subOutput } : {}),
			...(args.subPath ? { SUB_PATH: args.subPath } : {}),
		};

		// The spawned command always resolves REPO_ROOT from the ambient
		// FLAKE_ROOT (see the comment on `env` above), never from
		// `args.repoRoot` directly. If a caller's resolved repoRoot ever
		// diverges from the ambient FLAKE_ROOT, the drvPath trigger / eager
		// preview computations below (which DO use args.repoRoot) and the
		// actual spawned build (which uses $FLAKE_ROOT) would silently
		// resolve different flake refs — the exact silent-divergence risk
		// this fix trades the machine-path diffing bug for. Warn loudly if
		// that ever happens; every known caller's repoRoot is already
		// identical to FLAKE_ROOT, so this should never fire in practice.
		pulumi.output(args.repoRoot).apply((repoRoot) => {
			const ambientFlakeRoot = process.env.FLAKE_ROOT;
			if (ambientFlakeRoot && repoRoot !== ambientFlakeRoot) {
				pulumi.log.warn(
					`NixOutput(${name}): repoRoot ("${repoRoot}") does not match the ` +
						`ambient FLAKE_ROOT ("${ambientFlakeRoot}"). The spawned command ` +
						"always builds/resolves against FLAKE_ROOT, not repoRoot, so " +
						"this resource will silently use a different flake than the " +
						"drvPath trigger and eager preview were computed against.",
				);
			}
		});

		const changeDetection = args.changeDetection ?? "drv";
		const drvPathTrigger =
			changeDetection === "drv"
				? pulumi
						.all([args.repoRoot, args.nixAttr])
						.apply(([repoRoot, nixAttr]) =>
							resolveDrvPathTrigger(repoRoot, nixAttr),
						)
				: undefined;

		const cmd = new command.local.Command(
			`${name}-resolve`,
			{
				create: pulumi.interpolate`bash "${scriptPath}"`,
				environment: env,
				triggers: [
					args.nixAttr,
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
		});
	}
}
