// Pure Attic token (JWT) minting, shared by the AtticToken and AtticCache
// dynamic resources.
//
// Attic auth is a self-contained HS256 JWT signed with the server's shared
// secret (`ATTIC_SERVER_TOKEN_HS256_SECRET_BASE64`). `atticadm make-token` mints
// these offline from that secret; the server only verifies the signature. So a
// token can be produced entirely in-process — no server, no port-forward.
//
// SERIALIZATION CONTRACT — do not break:
// This module MUST have no top-level *runtime* `import` statements. `mintAtticToken`
// is referenced from the dynamic-resource provider callbacks in `admin.ts`; Pulumi
// serializes those closures, capturing this function and its module scope. A
// top-level `import * as crypto from "node:crypto"` would be pulled into every such
// closure and break serialization. The only Node import is a lazy `await import()`
// *inside* `mintAtticToken`. `import type` is fine — it is erased at compile time.
// https://www.pulumi.com/docs/concepts/resources/dynamic-providers/#how-dynamic-providers-are-serialized

/** Custom JWT claim namespace Attic reads authorization from (`token/src/lib.rs`). */
export const ATTIC_CLAIM_NAMESPACE = "https://jwt.attic.rs/v1";

/**
 * Per-cache permission flags. Mirrors Attic's `CachePermission`
 * (`token/src/lib.rs`); each maps to a short serde key in the JWT:
 *   pull → r, push → w, delete → d, createCache → cc, configureCache → cr,
 *   configureCacheRetention → cq, destroyCache → cd.
 * Absent/false flags deny (Attic's lookup is default-deny).
 */
export interface AtticCachePermissionFlags {
	pull?: boolean;
	push?: boolean;
	delete?: boolean;
	createCache?: boolean;
	configureCache?: boolean;
	configureCacheRetention?: boolean;
	destroyCache?: boolean;
}

/** Map of cache-name pattern (`*` wildcards allowed) → permission flags. */
export type AtticCacheGrants = Record<string, AtticCachePermissionFlags>;

export interface MintAtticTokenArgs {
	/** The server's HS256 secret, base64-encoded (decoded to the HMAC key bytes). */
	secretBase64: string;
	/** JWT `sub` — a human-meaningful token subject (e.g. "github-actions-ci"). */
	sub: string;
	/** JWT `nbf` / not-before, unix seconds. */
	issuedAtSeconds: number;
	/** JWT `exp` / expiry, unix seconds. */
	expiresAtSeconds: number;
	/** Per-cache grants rendered into the `caches` map of the namespace claim. */
	caches: AtticCacheGrants;
}

/** base64url (no padding) of a Buffer — the JWT segment encoding. */
function base64url(buf: Buffer): string {
	return buf
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * Render permission flags into Attic's short-key form, emitting only the granted
 * flags (absent = deny) with the integer value `1`.
 *
 * Attic deserializes each permission value as an integer, NOT a JSON boolean —
 * `atticadm make-token --dump-claims` emits `{"r":1,"cc":1,...}`. Emitting `true`
 * instead makes Attic reject the whole token with 401 (the permission claim fails
 * to deserialize), which silently breaks every minted token. Match `atticadm`'s
 * `1`/absent encoding exactly.
 */
function permissionClaim(
	flags: AtticCachePermissionFlags,
): Record<string, number> {
	const out: Record<string, number> = {};
	if (flags.pull) out.r = 1;
	if (flags.push) out.w = 1;
	if (flags.delete) out.d = 1;
	if (flags.createCache) out.cc = 1;
	if (flags.configureCache) out.cr = 1;
	if (flags.configureCacheRetention) out.cq = 1;
	if (flags.destroyCache) out.cd = 1;
	return out;
}

/**
 * Mint a signed Attic-compatible HS256 JWT entirely in-process.
 *
 * Emits the minimal claim set `atticadm` produces — `sub`, `nbf`, `exp`, and the
 * `https://jwt.attic.rs/v1` namespace claim with a `caches` map — and signs it
 * with HMAC-SHA256 over the **base64-decoded** secret bytes. No `iss`/`aud`/`iat`:
 * Attic only enforces issuer/audience when the server is configured with a bound
 * issuer/audience (garden's is not), and leaves `iat` unset itself.
 */
export async function mintAtticToken(
	args: MintAtticTokenArgs,
): Promise<string> {
	const crypto = await import("node:crypto");

	const header = { alg: "HS256", typ: "JWT" };
	const caches: Record<string, Record<string, number>> = {};
	for (const [pattern, flags] of Object.entries(args.caches)) {
		caches[pattern] = permissionClaim(flags);
	}
	const payload = {
		sub: args.sub,
		nbf: args.issuedAtSeconds,
		exp: args.expiresAtSeconds,
		[ATTIC_CLAIM_NAMESPACE]: { caches },
	};

	const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(
		Buffer.from(JSON.stringify(payload)),
	)}`;
	const key = Buffer.from(args.secretBase64, "base64");
	// Fail closed on an empty/undecodable secret: Buffer.from(_, "base64") is
	// permissive (garbage → empty/short buffer), which would otherwise mint a
	// token signed with a bad key and hide that the root credential is invalid.
	if (key.length === 0) {
		throw new Error(
			"invalid hs256 secret: decoded to empty bytes (expected a base64-encoded signing secret)",
		);
	}
	const signature = crypto
		.createHmac("sha256", key)
		.update(signingInput)
		.digest();
	return `${signingInput}.${base64url(signature)}`;
}

const UNIT_SECONDS: Record<string, number> = {
	s: 1,
	m: 60,
	h: 3600,
	d: 86400,
	w: 604800,
	y: 31536000,
};

/**
 * Parse a token validity into seconds. Accepts a bare number (already seconds)
 * or a `<n><unit>` duration with unit `s`/`m`/`h`/`d`/`w`/`y` (e.g. `1y`, `90d`,
 * `12h`, `300s`). A bare numeric string is treated as seconds.
 */
export function parseDurationSeconds(input: string | number): number {
	if (typeof input === "number") {
		if (!Number.isFinite(input) || input <= 0) {
			throw new Error(`invalid validity: ${input}`);
		}
		return Math.floor(input);
	}
	const match = /^(\d+)\s*(s|m|h|d|w|y)?$/.exec(input.trim());
	if (!match) {
		throw new Error(
			`invalid validity duration: "${input}" (expected e.g. "1y", "90d", "12h", or seconds)`,
		);
	}
	const n = Number.parseInt(match[1], 10);
	// Reject non-positive / non-finite string durations ("0", "0s", or a digit
	// string so long it overflows to Infinity) — the numeric branch already does.
	// A zero/expired or non-finite validity mints an immediately-dead or invalid
	// (exp → null) token anywhere this helper is used outside the provider check().
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`invalid validity duration: "${input}" (must be positive)`);
	}
	const unit = match[2] ?? "s";
	const seconds = n * UNIT_SECONDS[unit];
	if (!Number.isFinite(seconds)) {
		throw new Error(`validity duration too large: "${input}"`);
	}
	return seconds;
}
