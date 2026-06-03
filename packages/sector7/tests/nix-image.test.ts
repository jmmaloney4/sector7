import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NixImage } from "../nix-image/nix-image";
import { NixImagePushGroup } from "../nix-image/push-group";

type MockResource = {
	type: string;
	name: string;
	inputs: Record<string, unknown>;
};

const resources: MockResource[] = [];

beforeAll(() => {
	pulumi.runtime.setMocks({
		newResource: (args) => {
			const state = args.inputs;

			// For command.local.Command, simulate stdout with appropriate markers
			if (args.type === "command:local:Command") {
				const create = state.create as string | undefined;

				if (create?.includes("nix-output-resolve.sh")) {
					// NixOutput: simulate store path output
					const storePath = "/nix/store/abc123-my-image";
					(state as Record<string, unknown>).stdout =
						`=== Resolved: ${storePath} ===\nSTORE_PATH_OUTPUT:${storePath}\n`;
				} else if (create?.includes("nix-image-push.sh")) {
					// Push or resolve: simulate digest output
					(state as Record<string, unknown>).stdout =
						"=== Pushed registry/example:dev ===\n=== Digest: sha256:abc123def456 ===\nDIGEST_OUTPUT:sha256:abc123def456\n";
				}
			}

			resources.push({
				type: args.type,
				name: args.name,
				inputs: state as Record<string, unknown>,
			});

			return {
				id: `${args.name}-id`,
				state,
			};
		},
		call: (args) => args.inputs,
	});
});

beforeEach(() => {
	resources.length = 0;
});

function resolveOutput<T>(value: pulumi.Input<T>): Promise<T> {
	return new Promise((resolve) => {
		pulumi.output(value).apply((resolved) => {
			resolve(resolved as T);
			return resolved;
		});
	});
}

function byName(fragment: string): MockResource[] {
	return resources.filter((resource) => resource.name.includes(fragment));
}

describe("NixImage", () => {
	it("creates NixOutput child + push command in build mode", async () => {
		const img = new NixImage("test-build", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "my-image",
			imageTag: "dev",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
		});

		await resolveOutput(img.digest);

		// Should create a NixOutput child
		const nixOutputs = resources.filter(
			(r) =>
				r.type === "sector7:nix:NixOutput" && r.name === "test-build-build",
		);
		expect(nixOutputs).toHaveLength(1);

		// Should create a NixOutput command (build-resolve) and a push command (push)
		const buildCmds = byName("test-build-build-resolve");
		const pushCmds = byName("test-build-push");
		expect(buildCmds).toHaveLength(1);
		expect(pushCmds).toHaveLength(1);

		const pushCmd = pushCmds[0];
		expect(pushCmd.type).toBe("command:local:Command");
		expect(pushCmd.inputs.environment).toMatchObject({
			IMAGE_NAME: "my-image",
			IMAGE_TAG: "dev",
			ARTIFACT_REGISTRY_URL: "us-east1-docker.pkg.dev/my-project/my-repo",
			AUTH_MODE: "gcloud",
			SCRIPT_MODE: "push",
		});
	});

	it("creates a resolve command in resolve mode", async () => {
		const img = new NixImage("test-resolve", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "my-image",
			imageTag: "v1.0.0",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
			mode: "resolve",
		});

		await resolveOutput(img.digest);

		// Resolve mode should NOT create a NixOutput child
		const nixOutputs = resources.filter(
			(r) =>
				r.type === "sector7:nix:NixOutput" && r.name.includes("test-resolve"),
		);
		expect(nixOutputs).toHaveLength(0);

		// Should create a single resolve command
		const cmds = byName("test-resolve-resolve");
		expect(cmds).toHaveLength(1);

		const cmd = cmds[0];
		expect(cmd.type).toBe("command:local:Command");

		const createCmd = cmd.inputs.create as string;
		expect(createCmd).toContain("nix-image-push.sh");
		expect(cmd.inputs.environment).toMatchObject({
			IMAGE_NAME: "my-image",
			IMAGE_TAG: "v1.0.0",
			ARTIFACT_REGISTRY_URL: "us-east1-docker.pkg.dev/my-project/my-repo",
			AUTH_MODE: "gcloud",
			SCRIPT_MODE: "resolve",
			COMMAND_LOG_STEM: ".pulumi/command-logs/test-resolve",
		});
	});

	it("parses DIGEST_OUTPUT marker from stdout correctly", async () => {
		const img = new NixImage("test-digest", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "my-image",
			imageTag: "dev",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
		});

		const digest = await resolveOutput(img.digest);
		expect(digest).toBe("sha256:abc123def456");
	});

	it("produces correct imageRef with digest", async () => {
		const img = new NixImage("test-ref", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "my-image",
			imageTag: "dev",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
		});

		const imageRef = await resolveOutput(img.imageRef);
		expect(imageRef).toBe(
			"us-east1-docker.pkg.dev/my-project/my-repo/my-image@sha256:abc123def456",
		);
	});

	it("uses additive triggers with imageTag first when no triggers specified", async () => {
		const img = new NixImage("test-triggers-default", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "my-image",
			imageTag: "dev",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
		});

		await resolveOutput(img.digest);

		// NixOutput child triggers: [nixAttr, imageTag]
		const buildCmds = byName("test-triggers-default-build-resolve");
		expect(buildCmds).toHaveLength(1);
		const buildTriggers = buildCmds[0].inputs.triggers as string[];
		expect(buildTriggers).toEqual(["packages.x86_64-linux.my-image", "dev"]);

		// Push command should also have imageTag as trigger
		const pushCmds = byName("test-triggers-default-push");
		expect(pushCmds).toHaveLength(1);
		const pushTriggers = pushCmds[0].inputs.triggers as string[];
		expect(pushTriggers).toEqual(["dev", "/nix/store/abc123-my-image"]);
	});

	it("uses additive triggers: imageTag plus custom triggers", async () => {
		const img = new NixImage("test-triggers-custom", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "my-image",
			imageTag: "dev",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
			triggers: ["custom-trigger-1", "custom-trigger-2"],
		});

		await resolveOutput(img.digest);

		const pushCmds = byName("test-triggers-custom-push");
		expect(pushCmds).toHaveLength(1);
		const triggers = pushCmds[0].inputs.triggers as string[];
		expect(triggers).toEqual([
			"dev",
			"/nix/store/abc123-my-image",
			"custom-trigger-1",
			"custom-trigger-2",
		]);
	});

	it("uses resolve mode additive triggers with imageTag first", async () => {
		const img = new NixImage("test-resolve-triggers", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "my-image",
			imageTag: "v2.0.0",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
			mode: "resolve",
		});

		await resolveOutput(img.digest);

		const cmds = byName("test-resolve-triggers-resolve");
		expect(cmds).toHaveLength(1);

		const triggers = cmds[0].inputs.triggers as string[];
		expect(triggers).toEqual(["v2.0.0"]);
	});

	it("produces correct imageRef in resolve mode", async () => {
		const img = new NixImage("test-resolve-ref", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "my-image",
			imageTag: "v1.0.0",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
			mode: "resolve",
		});

		const imageRef = await resolveOutput(img.imageRef);
		expect(imageRef).toBe(
			"us-east1-docker.pkg.dev/my-project/my-repo/my-image@sha256:abc123def456",
		);
	});

	it("registers outputs imageRef and digest", async () => {
		const img = new NixImage("test-outputs", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "my-image",
			imageTag: "dev",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
		});

		const digest = await resolveOutput(img.digest);
		const imageRef = await resolveOutput(img.imageRef);

		expect(digest).toBeTruthy();
		expect(imageRef).toBeTruthy();
		expect(imageRef).toContain(digest);
	});

	it("uses the sector7:nix:NixImage type token", async () => {
		const img = new NixImage("test-type-token", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "my-image",
			imageTag: "dev",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
		});

		await resolveOutput(img.digest);

		const component = resources.find(
			(r) => r.type === "sector7:nix:NixImage" && r.name === "test-type-token",
		);
		expect(component).toBeDefined();
	});

	it("passes STORE_PATH from NixOutput to push command in build mode", async () => {
		const img = new NixImage("test-store-path", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "my-image",
			imageTag: "dev",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
		});

		await resolveOutput(img.digest);

		const pushCmds = byName("test-store-path-push");
		expect(pushCmds).toHaveLength(1);
		const env = pushCmds[0].inputs.environment as Record<string, unknown>;
		expect(env.STORE_PATH).toBe("/nix/store/abc123-my-image");
	});

	it("registers its push into an explicit push group (build mode)", async () => {
		const group = new NixImagePushGroup();
		expect(group.dependencies()).toHaveLength(0);

		const img = new NixImage("group-build", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "build-img",
			imageTag: "dev",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
			pushGroup: group,
		});
		await resolveOutput(img.digest);

		// The push command was registered, so the group now hands the next push
		// a dependency. (Serial/primer chaining across multiple pushes is
		// covered by the unit tests in nix-image-push-group.test.ts.)
		expect(group.dependencies()).toHaveLength(1);
	});

	it("does not register resolve-mode images into a push group", async () => {
		const group = new NixImagePushGroup();

		const img = new NixImage("group-resolve", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "resolve-only",
			imageTag: "v1.0.0",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
			mode: "resolve",
			pushGroup: group,
		});
		await resolveOutput(img.digest);

		// Resolve mode performs no upload, so it never joins the group.
		expect(group.dependencies()).toHaveLength(0);
	});

	it("still produces a working push when coordination is opted out (pushGroup: false)", async () => {
		const img = new NixImage("group-optout", {
			nixAttr: "packages.x86_64-linux.my-image",
			imageName: "optout",
			imageTag: "dev",
			artifactRegistryUrl: "us-east1-docker.pkg.dev/my-project/my-repo",
			repoRoot: "/home/user/my-repo",
			pushGroup: false,
		});

		const digest = await resolveOutput(img.digest);
		expect(digest).toBe("sha256:abc123def456");

		const pushCmds = byName("group-optout-push");
		expect(pushCmds).toHaveLength(1);
	});
});
