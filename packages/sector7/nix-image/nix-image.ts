import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { NixOutput } from "../nix-output/nix-output.ts";
import { getScriptPath } from "../scripts/index.ts";
import { NixImagePushGroup } from "./push-group.ts";

/**
 * Internal default push groups, one per distinct `artifactRegistryUrl`.
 *
 * Layer-blob deduplication happens within a single registry (for GCP Artifact
 * Registry, within one repository resource), so images pushed to the same
 * registry are the ones that benefit from coordinated pushes. Keying on the
 * `artifactRegistryUrl` Input means images sharing a registry are serialized by
 * default, while images pushed to *different* registries stay fully parallel.
 *
 * The map is keyed on the Input itself: plain-string registries collapse by
 * value, and Output registries collapse by reference (the common case where one
 * `artifactRegistryUrl` Output is reused across several `NixImage`s). If a
 * consumer passes a freshly-derived Output per image the keys differ and the
 * default degrades to the previous fully-parallel behavior — never worse than
 * before, since push order never affects correctness.
 */
const defaultPushGroups = new Map<pulumi.Input<string>, NixImagePushGroup>();

function defaultPushGroupFor(
	artifactRegistryUrl: pulumi.Input<string>,
): NixImagePushGroup {
	const existing = defaultPushGroups.get(artifactRegistryUrl);
	if (existing) {
		return existing;
	}
	const group = new NixImagePushGroup();
	defaultPushGroups.set(artifactRegistryUrl, group);
	return group;
}

export interface NixImageArgs {
	/** Flake attribute path (e.g. "packages.x86_64-linux.lens-api-image") */
	nixAttr: pulumi.Input<string>;
	/** Image name in the registry (e.g. "lens-api") */
	imageName: pulumi.Input<string>;
	/** Tag to push (e.g. "dev", "v1.2.3") */
	imageTag: pulumi.Input<string>;
	/** Registry URL (e.g. "us-east1-docker.pkg.dev/addenda-dev/addenda") */
	artifactRegistryUrl: pulumi.Input<string>;
	/** Absolute path to the repo root containing the flake */
	repoRoot: pulumi.Input<string>;
	/** Additional trigger values (added alongside imageTag) */
	triggers?: pulumi.Input<string>[];
	/**
	 * "build" = build+push the image (default)
	 * "resolve" = skip build, just resolve the digest of the already-pushed tag
	 */
	mode?: "build" | "resolve";
	/**
	 * Authentication mode for pushing images.
	 * - "gcloud" (default): uses `gcloud auth print-access-token` for GCP Artifact Registry
	 * - "ghcr": uses GITHUB_USER + GITHUB_TOKEN env vars for GitHub Container Registry
	 */
	authMode?: "gcloud" | "ghcr";
	/** Extra environment variables to pass to the build-push command. */
	env?: Record<string, pulumi.Input<string>>;
	/**
	 * Coordinates the push phase with other images to avoid concurrently
	 * uploading a shared base layer (see {@link NixImagePushGroup}). Only
	 * affects `"build"` mode — `"resolve"` mode performs no upload.
	 *
	 * - omitted (default): the image joins an internal group shared by every
	 *   `NixImage` pushing to the same `artifactRegistryUrl`, serializing their
	 *   pushes so the shared layer is uploaded once. Images on different
	 *   registries remain parallel. This is the zero-config "just works" path.
	 * - a {@link NixImagePushGroup}: the image joins that explicit group
	 *   instead, letting you widen, narrow, or re-strategize the coordination
	 *   (e.g. opt into the `"primer"` strategy).
	 * - `false`: the image opts out of coordination entirely and its push runs
	 *   unordered (the pre-coordination behavior).
	 */
	pushGroup?: NixImagePushGroup | false;
}

export class NixImage extends pulumi.ComponentResource {
	/** Full image reference with digest (e.g. "registry/image@sha256:...") */
	public readonly imageRef: pulumi.Output<string>;
	/** The digest (e.g. "sha256:...") */
	public readonly digest: pulumi.Output<string>;

	constructor(
		name: string,
		args: NixImageArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		// Build resource aliases: add URN alias when parented so the child
		// resource is adopted correctly under the parent.
		const aliases: pulumi.Alias[] = [];
		if (opts?.parent) {
			aliases.push({ parent: opts.parent });
		}

		// Keep the push coordinator out of the component's registered inputs.
		// It is scheduling-only state (and once populated holds references to
		// this component's own child push commands); leaking it into the input
		// bag would create a registration cycle.
		const { pushGroup: _pushGroup, ...registrableArgs } = args;

		super("sector7:nix:NixImage", name, registrableArgs, {
			...opts,
			aliases: [...aliases, ...(opts?.aliases ?? [])],
		});

		const pushScriptPath = getScriptPath("nix-image-push.sh");
		const commandLogStem = `.pulumi/command-logs/${name}`;

		const mode = args.mode ?? "build";
		const authMode = args.authMode ?? "gcloud";

		const baseEnv: Record<string, pulumi.Input<string>> = {
			...(args.env ?? {}),
			IMAGE_NAME: args.imageName,
			IMAGE_TAG: args.imageTag,
			ARTIFACT_REGISTRY_URL: args.artifactRegistryUrl,
			AUTH_MODE: authMode,
			COMMAND_LOG_STEM: commandLogStem,
		};

		if (mode === "resolve") {
			// Resolve-only: authenticate and inspect the already-pushed image
			const resolveCmd = new command.local.Command(
				`${name}-resolve`,
				{
					create: pulumi.interpolate`bash "${pushScriptPath}"`,
					environment: {
						...baseEnv,
						SCRIPT_MODE: "resolve",
					},
					triggers: [args.imageTag, ...(args.triggers ?? [])],
				},
				{ parent: this },
			);

			this.digest = resolveCmd.stdout.apply((stdout: string) => {
				const match = stdout.trim().match(/DIGEST_OUTPUT:(sha256:[a-f0-9]+)/);
				if (!match) {
					throw new Error(
						`Could not parse DIGEST_OUTPUT from resolve output for ${name}`,
					);
				}
				return match[1];
			});
			this.imageRef = pulumi.interpolate`${args.artifactRegistryUrl}/${args.imageName}@${this.digest}`;
		} else {
			// Build + push: compose NixOutput for the build step, then push
			const nixOutput = new NixOutput(
				`${name}-build`,
				{
					nixAttr: args.nixAttr,
					repoRoot: args.repoRoot,
					mode: "build",
					triggers: [args.imageTag, ...(args.triggers ?? [])],
					env: args.env,
				},
				{ parent: this },
			);

			// Coordinate the push with sibling images so a shared base layer
			// is not uploaded concurrently. An explicit `pushGroup` wins; `false`
			// opts out; otherwise join the default group for this registry.
			const pushGroup =
				args.pushGroup === false
					? undefined
					: (args.pushGroup ?? defaultPushGroupFor(args.artifactRegistryUrl));
			const pushDependsOn = pushGroup?.dependencies() ?? [];

			// Push the built image from the store path
			const pushCmd = new command.local.Command(
				`${name}-push`,
				{
					create: pulumi.interpolate`bash "${pushScriptPath}"`,
					environment: {
						...baseEnv,
						SCRIPT_MODE: "push",
						STORE_PATH: nixOutput.storePath,
					},
					triggers: pulumi.all([
						args.imageTag,
						nixOutput.storePath,
						...(args.triggers ?? []),
					]),
				},
				{ parent: this, dependsOn: pushDependsOn },
			);
			pushGroup?.register(pushCmd);

			this.digest = pushCmd.stdout.apply((stdout: string) => {
				const match = stdout.trim().match(/DIGEST_OUTPUT:(sha256:[a-f0-9]+)/);
				if (!match) {
					throw new Error(
						`Could not parse DIGEST_OUTPUT from push output for ${name}`,
					);
				}
				return match[1];
			});
			this.imageRef = pulumi.interpolate`${args.artifactRegistryUrl}/${args.imageName}@${this.digest}`;
		}

		this.registerOutputs({
			imageRef: this.imageRef,
			digest: this.digest,
		});
	}
}
