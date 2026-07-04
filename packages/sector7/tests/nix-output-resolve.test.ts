import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Integration test for scripts/nix-output-resolve.sh. It runs the real script
// with a stubbed `nix` on PATH that emits invalid-UTF-8 bytes on its build log
// (stderr), reproducing sector7#318: a `nix build -L` fixup phase leaking a raw
// gzip stream. The regression the script guards against is those bytes reaching
// the stdout/stderr that Pulumi captures as Command resource properties, where
// they crash marshaling ("string field contains invalid UTF-8").

const SCRIPT_PATH = fileURLToPath(
	new URL("../scripts/nix-output-resolve.sh", import.meta.url),
);
const STORE_PATH = "/nix/store/abc123-myapp-1.0.0";
// 0x8b is an invalid UTF-8 start byte; 0xff/0xfe never appear in valid UTF-8.
const INVALID_UTF8 = Buffer.from([0x1f, 0x8b, 0xff, 0xfe]);

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Write an executable `nix` stub into a fresh dir and return that dir. */
function stubNix(body: string): string {
	const binDir = makeTempDir("nix-stub-");
	const nixPath = join(binDir, "nix");
	writeFileSync(nixPath, `#!/usr/bin/env bash\n${body}\n`);
	chmodSync(nixPath, 0o755);
	return binDir;
}

function runScript(binDir: string, logDir: string) {
	return spawnSync("bash", [SCRIPT_PATH], {
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			NIX_ATTR: "packages.x86_64-linux.myapp",
			REPO_ROOT: "/home/user/my-repo",
			SCRIPT_MODE: "build",
			COMMAND_LOG_STEM: logDir,
		},
		// Buffer encoding so we can inspect raw bytes, not a lossy decode.
		encoding: "buffer",
	});
}

function isValidUtf8(buf: Buffer): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(buf);
		return true;
	} catch {
		return false;
	}
}

function readOnlyLog(logDir: string): Buffer {
	const entries = readdirSync(logDir).filter((n) => n.endsWith(".log"));
	expect(entries).toHaveLength(1);
	return readFileSync(join(logDir, entries[0]));
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		// best-effort cleanup; leaked temp dirs are harmless
		try {
			spawnSync("rm", ["-rf", dir]);
		} catch {
			/* ignore */
		}
	}
});

describe("nix-output-resolve.sh UTF-8 safety", () => {
	it("keeps invalid build-log bytes out of stdout/stderr on success", () => {
		const binDir = stubNix(
			[
				// stdout: the store path (what --print-out-paths emits)
				`printf '%s\\n' '${STORE_PATH}'`,
				// stderr: the -L build log, with invalid UTF-8 bytes
				"printf 'python-garden-dev> gzipping man pages\\n' >&2",
				"printf 'python-garden-dev> \\037\\213\\377\\376 raw gzip leak\\n' >&2",
			].join("\n"),
		);
		const logDir = makeTempDir("nix-logs-");

		const result = runScript(binDir, logDir);
		const stdout = result.stdout as Buffer;
		const stderr = result.stderr as Buffer;

		expect(result.status).toBe(0);

		// stdout carries only the ASCII protocol line — valid UTF-8, no raw bytes.
		expect(isValidUtf8(stdout)).toBe(true);
		expect(stdout.toString("utf8")).toContain(
			`STORE_PATH_OUTPUT:${STORE_PATH}`,
		);
		expect(stdout.includes(0x8b)).toBe(false);
		expect(stdout.includes(0xff)).toBe(false);

		// stderr must also be marshal-safe (it is a captured resource property too).
		expect(isValidUtf8(stderr)).toBe(true);
		expect(stderr.includes(0x8b)).toBe(false);

		// The raw bytes are preserved in the log file, not discarded.
		const log = readOnlyLog(logDir);
		expect(log.includes(INVALID_UTF8[1])).toBe(true); // 0x8b survives in the log
	});

	it("keeps the failure diagnostic ASCII-only when the build log has invalid bytes", () => {
		const binDir = stubNix(
			[
				"printf 'python-garden-dev> \\037\\213\\377\\376 raw gzip leak\\n' >&2",
				"exit 1",
			].join("\n"),
		);
		const logDir = makeTempDir("nix-logs-");

		const result = runScript(binDir, logDir);
		const stdout = result.stdout as Buffer;
		const stderr = result.stderr as Buffer;

		expect(result.status).not.toBe(0);

		// No store path was resolved.
		expect(stdout.toString("utf8")).not.toContain("STORE_PATH_OUTPUT:");

		// The error surfaced on stderr is a plain ASCII pointer to the log,
		// never the raw build-log bytes.
		expect(isValidUtf8(stderr)).toBe(true);
		expect(stderr.includes(0x8b)).toBe(false);
		expect(stderr.includes(0xff)).toBe(false);
		expect(stderr.toString("utf8")).toContain("see");
	});
});
