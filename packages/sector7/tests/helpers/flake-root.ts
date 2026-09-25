import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

/**
 * A throwaway directory containing `flake.nix`.
 *
 * `NixOutput` refuses a `repoRoot` that is not a flake checkout. Tests used
 * to pass synthetic paths like `/home/user/my-repo`; those now fail the
 * check, so each case that constructs a `NixOutput` needs a real directory
 * with a flake file. The contents are a stub — nothing evaluates it.
 */
export function makeFlakeRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "sector7-flake-root-"));
	writeFileSync(join(dir, "flake.nix"), "{ outputs = _: { }; }\n");
	created.push(dir);
	return dir;
}

/** Throwaway directory with no `flake.nix`, for the missing-flake case. */
export function makeEmptyRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "sector7-empty-root-"));
	created.push(dir);
	return dir;
}

/** Directory whose `flake.nix` is itself a directory, not a file. */
export function makeDirectoryNamedFlakeNix(): string {
	const dir = makeEmptyRoot();
	mkdirSync(join(dir, "flake.nix"));
	return dir;
}

export function cleanupFlakeRoots(): void {
	while (created.length > 0) {
		const dir = created.pop();
		if (dir === undefined) {
			continue;
		}
		rmSync(dir, { recursive: true, force: true });
	}
}
