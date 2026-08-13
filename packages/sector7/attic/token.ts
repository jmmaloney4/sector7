// Shared Attic types plus the pure "validity duration" parser used by the
// AtticToken and AtticCache dynamic resources.
//
// JWT minting itself (`mintAtticToken`) moved to provider/attic/token.go when
// AtticCache/AtticToken retyped onto the sector7 plugin (garden ADR 163) —
// see token_test.go for that coverage. The Go implementation hand-encodes the
// same Attic permission-claim wire format this module used to.

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
