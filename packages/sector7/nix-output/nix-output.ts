import { execFileSync } from "node:child_process";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { getScriptPath } from "../scripts/index.ts";

export interface NixOutputArgs {
	/** Flake attribute path (e.g. "packages.x86_64-linux.lens-api-image") */
	nixAttr: pulumi.Input<string>;
	/** Absolute path to the repo root containing the flake. */
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
	/** Additional trigger values (added alongside nixAttr). */
	triggers?: pulumi.Input<string>[];
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

		const env: Record<string, pulumi.Input<string>> = {
			...(args.env ?? {}),
			NIX_ATTR: args.nixAttr,
			REPO_ROOT: args.repoRoot,
			SCRIPT_MODE: mode,
			COMMAND_LOG_STEM: commandLogStem,
			...(args.subOutput ? { SUB_OUTPUT: args.subOutput } : {}),
			...(args.subPath ? { SUB_PATH: args.subPath } : {}),
		};

		const cmd = new command.local.Command(
			`${name}-resolve`,
			{
				create: pulumi.interpolate`bash "${scriptPath}"`,
				environment: env,
				triggers: [args.nixAttr, ...(args.triggers ?? [])],
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
