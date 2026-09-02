import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
	describeRepoProvenance,
	resolveRepoProvenance,
} from "../nix-output/repo-provenance.ts";

// Real git repositories in a temp dir rather than a mocked `git`: the unit
// under test IS the git reading, so mocking would assert our idea of git's
// exit codes rather than git's.

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

function makeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "s7-prov-"));
	roots.push(root);
	execFileSync("git", ["init", "-q", "-b", "main", root], { stdio: "ignore" });
	git(root, "config", "user.email", "t@example.com");
	git(root, "config", "user.name", "t");
	writeFileSync(join(root, "flake.nix"), "{}\n");
	git(root, "add", "flake.nix");
	git(root, "commit", "-q", "-m", "init");
	return root;
}

afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("resolveRepoProvenance", () => {
	it("reads sha, branch and clean state", () => {
		const p = resolveRepoProvenance(makeRepo());
		expect(p.gitSha).toMatch(/^[0-9a-f]{40}$/);
		expect(p.branch).toBe("main");
		expect(p.dirty).toBe(false);
	});

	it("reports a modified tracked file as dirty", () => {
		const root = makeRepo();
		writeFileSync(join(root, "flake.nix"), "{ changed = true; }\n");
		expect(resolveRepoProvenance(root).dirty).toBe(true);
	});

	it("does not report an untracked file as dirty", () => {
		// nix excludes untracked files from a bare-path flake build, so they
		// cannot affect the artifact.
		const root = makeRepo();
		writeFileSync(join(root, "scratch.txt"), "notes\n");
		expect(resolveRepoProvenance(root).dirty).toBe(false);
	});

	it("names a detached HEAD rather than failing", () => {
		const root = makeRepo();
		git(root, "checkout", "-q", "--detach", "HEAD");
		expect(resolveRepoProvenance(root).branch).toBe("(detached)");
	});

	it("degrades to unknown outside a git repo instead of throwing", () => {
		// A non-git build root is unusual but legal; it must not fail a deploy
		// that would otherwise have worked.
		const root = mkdtempSync(join(tmpdir(), "s7-prov-nogit-"));
		roots.push(root);
		const p = resolveRepoProvenance(root);
		expect(p.gitSha).toBe("unknown");
		expect(p.branch).toBe("unknown");
		expect(p.dirty).toBe(false);
	});
});

describe("describeRepoProvenance", () => {
	it("names the sha, branch and dirtiness in one line", () => {
		const s = describeRepoProvenance({
			repoRoot: "/r",
			gitSha: "79678b6bb912ae0e2bc291cab4d22e71258da91f",
			branch: "feat/x",
			dirty: true,
		});
		expect(s).toContain("79678b6bb");
		expect(s).toContain("feat/x");
		expect(s).toContain("dirty");
		expect(s).toContain("/r");
	});

	it("stays quiet for a clean tree", () => {
		expect(
			describeRepoProvenance({
				repoRoot: "/r",
				gitSha: "b2e24e4bb5badef2882898413fd29498b76d6fb6",
				branch: "(detached)",
				dirty: false,
			}),
		).not.toContain("dirty");
	});
});
