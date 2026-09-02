import { execFileSync } from "node:child_process";

/**
 * Which tree a nix build actually compiled.
 *
 * `changeDetection: "drv"` already gives a precise *content* signal — the drv
 * hash covers every transitive input, so the command re-runs exactly when the
 * build would differ. What it cannot give is a *legible* one. When the tree
 * underneath moves, a consumer sees `[diff: ~create,environment,triggers]`,
 * which reads identically whether you committed a line or are building a
 * colleague's branch. This turns that into words, at program time, before
 * anything is applied.
 *
 * See jmmaloney4/sector7#384 and cavinsresearch/zeus#3162, where a deploy
 * shipped an image built from a branch nobody named and the drvPath trigger
 * dutifully reported the change as routine churn.
 */
export interface RepoProvenance {
	/** The tree that was inspected. */
	repoRoot: string;
	/** `HEAD`, or `"unknown"` when git could not be read. */
	gitSha: string;
	/** Branch name, `"(detached)"`, or `"unknown"`. */
	branch: string;
	/** Tracked files differ from `HEAD`, so the build will not match `gitSha`. */
	dirty: boolean;
}

function git(repoRoot: string, args: string[]): string {
	return execFileSync("git", ["-C", repoRoot, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

/**
 * Read the git identity of a build root. Never throws: a build root that is
 * not a git repository is unusual but legal, and is reported as `"unknown"`
 * rather than failing a deploy that would otherwise have worked.
 */
export function resolveRepoProvenance(repoRoot: string): RepoProvenance {
	let gitSha: string;
	try {
		gitSha = git(repoRoot, ["rev-parse", "HEAD"]);
	} catch {
		return { repoRoot, gitSha: "unknown", branch: "unknown", dirty: false };
	}

	let branch = "(detached)";
	try {
		branch = git(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
	} catch {
		// A detached HEAD is the normal shape of a pinned build checkout.
	}

	// Untracked files are deliberately not consulted: nix excludes them from a
	// bare-path flake build, so they cannot affect the artifact.
	let dirty: boolean;
	try {
		git(repoRoot, ["diff", "--quiet", "HEAD"]);
		dirty = false;
	} catch {
		dirty = true;
	}

	return { repoRoot, gitSha, branch, dirty };
}

/** One line naming the tree a build came from. */
export function describeRepoProvenance(p: RepoProvenance): string {
	const sha = p.gitSha === "unknown" ? "unknown" : p.gitSha.slice(0, 9);
	return `${sha} (${p.branch})${p.dirty ? " dirty" : ""} at ${p.repoRoot}`;
}
