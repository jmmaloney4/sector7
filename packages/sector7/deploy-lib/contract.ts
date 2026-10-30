/**
 * Contract channel reader (ADR 035; garden ADR 173).
 *
 * A tenant's cluster coordinates and shared secrets are published as items in
 * a per-tenant 1Password vault — the "contract" — addressed as
 * `op://<vault>/<title>/<label>`. This module is the read side and the single
 * chokepoint that decides whether a stack is in contract mode at all, and
 * which of two transports carries the reads.
 *
 * ONE reader, ONE item parser, TWO transports. The transport is a closed
 * union chosen exactly once, in {@link getContractChannel}, from
 * configuration — never per call and never by "try one, fall back to the
 * other":
 *
 * - `connect` — a minimal 1Password Connect REST client. Selected when a
 *   Connect host AND token are configured (`contract:connectHost` /
 *   `OP_CONNECT_HOST`, `contract:connectToken` / `OP_CONNECT_TOKEN`). For CI
 *   and any environment that has Connect coordinates.
 * - `op` — the 1Password CLI, run as `op item get <title> --vault <vault>
 *   --format json` under the *operator's own session* (desktop-app
 *   integration, `op signin`, or a service-account token in the
 *   environment). Selected when `contract:vault` is set and NO Connect
 *   coordinates are configured at all. For operator workstations, where
 *   in-cluster Connect is unreachable by design.
 *
 * A *partial* Connect configuration (host without token, or token without
 * host) is a configuration error and throws; it is never read as "use op".
 *
 * Both transports yield a raw item JSON document that the one shared parser
 * ({@link parseContractItem}) normalizes into a `label -> value` map, so
 * everything above the transport (freshness, caching, field accessors,
 * secrecy) is identical. Every failure is loud and names vault/item/label,
 * never a value.
 *
 * Bootstrap is deliberately out-of-band (garden ADR 173): the Connect
 * coordinates come from stack config or environment variables, never from a
 * contract item (circular) and never through a kubeconfig-authenticated
 * port-forward (the kubeconfig is the thing being fetched).
 */

import { execFile } from "node:child_process";
import * as pulumi from "@pulumi/pulumi";

/**
 * Result of one `op` invocation, as a closed union. The default
 * implementation maps Node's `execFile` failure shapes onto it, so nothing
 * above this boundary pattern-matches on `errno` strings or signals, and a
 * test double only has to produce one of four values.
 */
export type OpExecResult =
	| { kind: "ok"; stdout: string }
	/** The `op` binary is not on PATH (or not executable). */
	| { kind: "not-found" }
	/** `op` did not finish within the timeout and was killed. */
	| { kind: "timeout" }
	/** `op` ran and exited non-zero (or its output exceeded the buffer). */
	| { kind: "exit"; code: number | null; stderr: string };

/**
 * Run the 1Password CLI with the given argv (no shell, ever) and return how
 * it ended. The executable is always `op`; only its arguments vary.
 */
export type OpExec = (
	args: readonly string[],
	opts: { timeoutMs: number },
) => Promise<OpExecResult>;

/** Connect transport: REST against a 1Password Connect server over https. */
export interface ConnectTransport<Token = pulumi.Input<string>> {
	kind: "connect";
	/** 1Password Connect base URL, e.g. `https://op-connect.example.com`. */
	host: string;
	/** Connect bearer token. */
	token: Token;
}

/** op transport: the 1Password CLI under the operator's own session. */
export interface OpTransport {
	kind: "op";
	/** How `op` is run. Defaults to a real `execFile`; tests inject a double. */
	exec: OpExec;
}

/** The two ways a contract item can be fetched; chosen once per channel. */
export type ContractTransport<Token = pulumi.Input<string>> =
	| ConnectTransport<Token>
	| OpTransport;

/**
 * Resolved contract-channel coordinates for the current stack.
 *
 * Existence of this object *is* the mode: a stack with a channel resolves
 * every deploy-lib read from the contract, and a read failure is a hard
 * error — never a silent fall back to the StackReference path.
 *
 * `Token` is the Connect token's type: a Pulumi `Input` on the channel
 * {@link getContractChannel} returns, a plain `string` once
 * {@link readContract} has resolved it (see {@link ResolvedContractChannel}).
 */
export interface ContractChannel<Token = pulumi.Input<string>> {
	/** 1Password vault holding this tenant's contract (UUID or exact name). */
	vault: string;
	/** How items are fetched. */
	transport: ContractTransport<Token>;
	/**
	 * Reject contract items whose `producedAt` field is older than this.
	 * Unset disables the freshness check.
	 */
	maxAgeHours?: number;
}

/**
 * A channel whose Connect token (if any) is a plain string, ready for
 * {@link readContractItemAsync}. Unrepresentable on the type level: an op
 * channel has no token to resolve and a Connect channel cannot reach the
 * reader without one.
 */
export type ResolvedContractChannel = ContractChannel<string>;

/**
 * Per-invocation `op` timeout. Generous because the desktop-app integration
 * may be waiting on a biometric unlock; without any bound, a stuck `op` would
 * hang the whole preview/update instead of failing it loudly.
 */
const OP_TIMEOUT_MS = 60_000;

/** Upper bound on `op item get` output; a contract item is a few KB. */
const OP_MAX_BUFFER = 16 * 1024 * 1024;

const defaultOpExec: OpExec = (args, { timeoutMs }) =>
	new Promise((resolve) => {
		const startedAt = Date.now();
		const child = execFile(
			"op",
			[...args],
			{
				timeout: timeoutMs,
				maxBuffer: OP_MAX_BUFFER,
				encoding: "utf8",
				windowsHide: true,
			},
			(err, stdout, stderr) => {
				if (!err) {
					resolve({ kind: "ok", stdout });
					return;
				}
				const e = err as NodeJS.ErrnoException & { killed?: boolean };
				if (e.code === "ENOENT" || e.code === "EACCES") {
					resolve({ kind: "not-found" });
				} else if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
					resolve({ kind: "exit", code: null, stderr: "" });
				} else if (e.killed && Date.now() - startedAt >= timeoutMs) {
					// Only our own timeout kill counts as a timeout. Node sets
					// `killed` for any signal, so a crash or an external kill
					// must not be reported as "waiting on an unlock prompt".
					resolve({ kind: "timeout" });
				} else {
					resolve({
						kind: "exit",
						code: typeof e.code === "number" ? e.code : null,
						stderr,
					});
				}
			},
		);
		// `op` never needs stdin here; close it so it cannot wait on a pipe.
		child.stdin?.end();
	});

let opExecOverride: OpExec | undefined;

/**
 * Test hook: replace how `op` is run for channels subsequently built by
 * {@link getContractChannel}; `undefined` restores the real implementation.
 * Not part of the public surface.
 */
export function setOpExecForTesting(exec: OpExec | undefined): void {
	opExecOverride = exec;
}

/**
 * Read the contract-channel configuration for the current stack, or
 * `undefined` when the stack is not in contract mode.
 *
 * Mode selection is exactly "is `contract:vault` set". Transport selection
 * then looks only at whether Connect coordinates are configured:
 *
 * | Connect host | Connect token | Result                                   |
 * | ------------ | ------------- | ---------------------------------------- |
 * | set          | set           | `connect` transport                      |
 * | unset        | unset         | `op` transport (operator's `op` session) |
 * | set          | unset         | throws — partial Connect config          |
 * | unset        | set           | throws — partial Connect config          |
 *
 * A partial Connect configuration is never interpreted as "use op" (or as
 * "not migrated yet"): that would silently turn a typo into a different
 * credential path, or re-create the cross-boundary StackReference the
 * contract exists to remove.
 */
export function getContractChannel(): ContractChannel | undefined {
	const cfg = new pulumi.Config("contract");
	const vault = cfg.get("vault");
	if (!vault) {
		return undefined;
	}
	// Trimmed: a trailing newline in an env var or pasted config value would
	// otherwise surface as a baffling "Invalid URL" or 401 far from the cause.
	let connectHost = (
		cfg.get("connectHost") ?? process.env.OP_CONNECT_HOST
	)?.trim();
	const connectToken: pulumi.Input<string> | undefined =
		cfg.getSecret("connectToken")?.apply((t) => t.trim()) ??
		process.env.OP_CONNECT_TOKEN?.trim();

	const maxAgeHours = cfg.getNumber("maxAgeHours");
	if (
		maxAgeHours !== undefined &&
		(!Number.isFinite(maxAgeHours) || maxAgeHours <= 0)
	) {
		throw new Error(
			`contract:maxAgeHours must be a positive number of hours, got ` +
				`${maxAgeHours}; a value that cannot bound freshness would silently ` +
				`disable the configured freshness guarantee.`,
		);
	}

	if (!connectHost && !connectToken) {
		// `op` takes the vault as a bare argv element; a leading dash would be
		// parsed as a flag. Refused here, once, rather than at every call.
		if (vault.startsWith("-")) {
			throw new Error(
				`contract:vault must not start with "-" (it is passed to the op CLI ` +
					`as an argument).`,
			);
		}
		return {
			vault,
			transport: { kind: "op", exec: opExecOverride ?? defaultOpExec },
			maxAgeHours,
		};
	}
	if (!connectHost) {
		throw new Error(
			"A 1Password Connect token is configured but no Connect host is. " +
				"Set contract:connectHost or the OP_CONNECT_HOST environment variable, " +
				"or remove the token to read the contract through the op CLI.",
		);
	}
	// A bare hostname would surface as a cryptic "Invalid URL" from fetch;
	// normalize to https. An explicit http:// is refused rather than honored:
	// this channel carries the Connect bearer token and every contract secret,
	// and a cleartext hop is not a configuration this module supports.
	if (/^http:\/\//i.test(connectHost)) {
		throw new Error(
			"contract:connectHost must be https; refusing to send the Connect " +
				"bearer token and contract secrets over cleartext http.",
		);
	}
	if (!/^https:\/\//i.test(connectHost)) {
		connectHost = `https://${connectHost}`;
	}
	if (!connectToken) {
		throw new Error(
			"A 1Password Connect host is configured but no Connect token is. " +
				"Set contract:connectToken (secret) or the OP_CONNECT_TOKEN " +
				"environment variable, or remove the host to read the contract " +
				"through the op CLI.",
		);
	}
	return {
		vault,
		transport: { kind: "connect", host: connectHost, token: connectToken },
		maxAgeHours,
	};
}

/** 1Password vault/item UUIDs are 26 lowercase base32 characters. */
const OP_ID = /^[a-z0-9]{26}$/;

/**
 * Per-request Connect timeout. Without it, an unresponsive Connect server
 * hangs the whole preview/update instead of failing it loudly.
 */
const CONNECT_TIMEOUT_MS = 15_000;

async function connectGet(
	host: string,
	token: string,
	path: string,
): Promise<unknown> {
	const url = `${host.replace(/\/+$/, "")}${path}`;
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
		});
	} catch (e) {
		// Node's fetch wraps network errors in a generic "fetch failed" whose
		// cause carries the useful part (ECONNREFUSED, ENOTFOUND, ...).
		const cause =
			e instanceof Error && e.cause instanceof Error
				? ` — ${e.cause.message}`
				: "";
		const message =
			e instanceof Error &&
			(e.name === "TimeoutError" || e.name === "AbortError")
				? `request timed out after ${CONNECT_TIMEOUT_MS / 1000}s`
				: e instanceof Error
					? `${e.message}${cause}`
					: String(e);
		throw new Error(
			`contract read failed: 1Password Connect at ${host} is unreachable ` +
				`(${message})`,
		);
	}
	if (!res.ok) {
		// Status and path only — an error body from Connect or an intermediate
		// proxy could echo request or item material, and this module guarantees
		// its errors carry names, never values.
		throw new Error(`contract read failed: GET ${path} returned ${res.status}`);
	}
	try {
		return await res.json();
	} catch {
		throw new Error(
			`contract read failed: GET ${path} returned ${res.status} with an ` +
				"invalid JSON body (is something other than 1Password Connect " +
				"answering at this host?)",
		);
	}
}

async function resolveVaultId(
	host: string,
	token: string,
	vault: string,
): Promise<string> {
	if (OP_ID.test(vault)) {
		return vault;
	}
	const filter = new URLSearchParams({ filter: `name eq "${vault}"` });
	const vaults = (await connectGet(host, token, `/v1/vaults?${filter}`)) as {
		id: string;
		name: string;
	}[];
	if (vaults.length !== 1) {
		throw new Error(
			`contract read failed: expected exactly one 1Password vault named ` +
				`"${vault}", found ${vaults.length}`,
		);
	}
	return vaults[0]!.id;
}

/** Fetch the raw Connect item document for `title` in `vault`. */
async function connectFetchItem(
	transport: ConnectTransport<string>,
	vault: string,
	title: string,
): Promise<unknown> {
	const { host, token } = transport;
	const vaultId = await resolveVaultId(host, token, vault);
	const filter = new URLSearchParams({ filter: `title eq "${title}"` });
	const items = (await connectGet(
		host,
		token,
		`/v1/vaults/${vaultId}/items?${filter}`,
	)) as { id: string; title: string }[];
	if (items.length !== 1) {
		throw new Error(
			`contract read failed: expected exactly one item titled "${title}" ` +
				`in vault "${vault}", found ${items.length}. The publisher for this ` +
				`contract item may not have run yet (garden#2075 wave 2).`,
		);
	}
	return connectGet(host, token, `/v1/vaults/${vaultId}/items/${items[0]!.id}`);
}

/**
 * Fetch the raw `op item get` document for `title` in `vault`.
 *
 * `op` resolves the vault by name or UUID and the item by exact title or
 * UUID, and refuses an ambiguous title itself, so no separate lookup step is
 * needed. Failures are classified from stderr into fixed messages; stderr is
 * never echoed (this module's errors carry names, never values).
 */
async function opFetchItem(
	transport: OpTransport,
	vault: string,
	title: string,
): Promise<unknown> {
	// Item title is a bare argv element; a leading dash would become a flag.
	if (title.startsWith("-")) {
		throw new Error(
			`contract read failed: item title "${title}" must not start with "-" ` +
				`(it is passed to the op CLI as an argument)`,
		);
	}
	const where = `item "${title}" in vault "${vault}"`;
	const result = await transport.exec(
		["item", "get", title, "--vault", vault, "--format", "json"],
		{ timeoutMs: OP_TIMEOUT_MS },
	);
	switch (result.kind) {
		case "ok":
			break;
		case "not-found":
			throw new Error(
				`contract read failed: the 1Password CLI (op) was not found on PATH ` +
					`(or is not executable), so ${where} cannot be read. Install op, ` +
					`or configure 1Password Connect (contract:connectHost + ` +
					`contract:connectToken).`,
			);
		case "timeout":
			throw new Error(
				`contract read failed: op timed out after ${OP_TIMEOUT_MS / 1000}s ` +
					`reading ${where} (is it waiting on an unlock prompt?)`,
			);
		case "exit": {
			const err = result.stderr;
			if (
				/not (currently )?signed in|no accounts? (configured|found)|op signin|sign in to|authorization (timeout|prompt)|error initializing client|session expired|unauthori[sz]ed/i.test(
					err,
				)
			) {
				throw new Error(
					`contract read failed: op is not signed in, so ${where} cannot be ` +
						`read. Sign in (op signin, or unlock the 1Password desktop app ` +
						`integration), or export OP_SERVICE_ACCOUNT_TOKEN.`,
				);
			}
			if (/isn't a vault|not a vault/i.test(err)) {
				throw new Error(
					`contract read failed: vault "${vault}" was not found by op ` +
						`(or the signed-in account cannot see it)`,
				);
			}
			if (/more than one item/i.test(err)) {
				throw new Error(
					`contract read failed: expected exactly one item titled "${title}" ` +
						`in vault "${vault}", but op reports more than one match`,
				);
			}
			if (/isn't an item|not found|no item/i.test(err)) {
				throw new Error(
					`contract read failed: expected exactly one item titled "${title}" ` +
						`in vault "${vault}", found 0. The publisher for this contract ` +
						`item may not have run yet (garden#2075 wave 2).`,
				);
			}
			throw new Error(
				`contract read failed: op exited ${result.code ?? "abnormally"} ` +
					`reading ${where}. Re-run \`op item get "${title}" --vault ` +
					`"${vault}" --format json\` by hand to see why (its stderr is not ` +
					`reproduced here).`,
			);
		}
	}
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(
			`contract read failed: op returned output for ${where} that is not ` +
				`valid JSON`,
		);
	}
}

/**
 * The one item parser, shared by both transports.
 *
 * Connect's item JSON and `op item get --format json` agree on everything
 * this reader consumes — a `title` and `fields[]` of `{ id, label, value,
 * type, purpose, section }` — and differ only in extras it ignores (op adds
 * `reference`, `section.label`, `vault.name`, timestamps). Concealed
 * (`type: "CONCEALED"`) fields carry their value inline in both, and are
 * treated exactly like any other field: secretness is applied to the whole
 * result downstream, not per field. A field without a `label` is not
 * addressable by `op://vault/title/label` and is skipped; when two fields
 * share a label (e.g. across sections) the later one wins, as the Connect
 * reader always has.
 *
 * Anything that is not shaped like an item throws, naming `origin`, the item
 * title and the offending field label — never a value.
 */
export function parseContractItem(
	raw: unknown,
	title: string,
	origin: "1Password Connect" | "op",
): Record<string, string> {
	const bad = (why: string): never => {
		throw new Error(
			`contract read failed: ${origin} returned JSON for item "${title}" ` +
				`that is not shaped like a 1Password item (${why})`,
		);
	};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return bad("expected a JSON object");
	}
	const item = raw as { title?: unknown; fields?: unknown };
	if (typeof item.title !== "string") {
		return bad("no string `title`");
	}
	if (item.title !== title) {
		return bad(`its title is "${item.title}", not the requested one`);
	}
	if (item.fields !== undefined && !Array.isArray(item.fields)) {
		return bad("`fields` is not an array");
	}
	const fields: Record<string, string> = {};
	for (const f of (item.fields ?? []) as unknown[]) {
		if (typeof f !== "object" || f === null || Array.isArray(f)) {
			return bad("a `fields` entry is not an object");
		}
		const { label, value } = f as { label?: unknown; value?: unknown };
		if (typeof label !== "string" || label === "") {
			continue;
		}
		if (value === undefined || value === null) {
			continue;
		}
		if (typeof value !== "string") {
			return bad(`field "${label}" has a non-string value`);
		}
		fields[label] = value;
	}
	return fields;
}

async function fetchItemFields(
	channel: ResolvedContractChannel,
	title: string,
): Promise<Record<string, string>> {
	const { transport, vault } = channel;
	switch (transport.kind) {
		case "connect":
			return parseContractItem(
				await connectFetchItem(transport, vault, title),
				title,
				"1Password Connect",
			);
		case "op":
			return parseContractItem(
				await opFetchItem(transport, vault, title),
				title,
				"op",
			);
	}
}

/**
 * Per-process cache of contract item reads, keyed by
 * transport|vault|title (the transport part is the Connect host, or `op`).
 *
 * Same posture as the resolver's StackReference cache: one read per item per
 * program execution, shared by every consumer in the stack.
 */
const itemCache = new Map<string, Promise<Record<string, string>>>();

/** Test hook: drop cached contract reads. Not part of the public surface. */
export function clearContractItemCacheForTesting(): void {
	itemCache.clear();
}

function assertFresh(
	channel: ResolvedContractChannel,
	title: string,
	fields: Record<string, string>,
): void {
	if (channel.maxAgeHours === undefined) {
		return;
	}
	const producedAt = fields.producedAt;
	if (!producedAt) {
		throw new Error(
			`contract item "op://${channel.vault}/${title}" has no producedAt ` +
				`field, but contract:maxAgeHours requires a freshness assertion`,
		);
	}
	const parsed = Date.parse(producedAt);
	if (Number.isNaN(parsed)) {
		throw new Error(
			`contract item "op://${channel.vault}/${title}" has an unparseable ` +
				`producedAt ("${producedAt}")`,
		);
	}
	const ageHours = (Date.now() - parsed) / 3_600_000;
	if (ageHours > channel.maxAgeHours) {
		throw new Error(
			`contract item "op://${channel.vault}/${title}" is stale: produced ` +
				`${producedAt} (${ageHours.toFixed(1)}h ago), ` +
				`contract:maxAgeHours is ${channel.maxAgeHours}. Re-run the ` +
				`publishing stack (its identity is in the producedBy field) before ` +
				`consuming this contract.`,
		);
	}
}

/**
 * Promise-level contract item read: cached fetch (over whichever transport
 * the channel carries) plus the freshness assertion. This is where every contract failure mode throws, so it is the
 * function to test failure paths against — a rejecting Pulumi Output cannot
 * be awaited in tests without its internal isKnown/isSecret promise chains
 * surfacing as unhandled rejections.
 */
export async function readContractItemAsync(
	channel: ResolvedContractChannel,
	title: string,
): Promise<Record<string, string>> {
	const via =
		channel.transport.kind === "connect" ? channel.transport.host : "op";
	const key = `${channel.transport.kind}|${via}|${channel.vault}|${title}`;
	let cached = itemCache.get(key);
	if (!cached) {
		cached = fetchItemFields(channel, title);
		itemCache.set(key, cached);
		// Cache successes only: a cached rejection would pin a transient
		// network failure for the rest of the process.
		cached.catch(() => {
			if (itemCache.get(key) === cached) {
				itemCache.delete(key);
			}
		});
	}
	const fields = await cached;
	assertFresh(channel, title, fields);
	return fields;
}

/**
 * Read a contract item and project a value out of its fields, as a single
 * secret Output.
 *
 * The token resolution (Connect only), the fetch, freshness check, and
 * projection all happen inside ONE `apply`, deliberately: every intermediate Output layer
 * is an unawaited promise that turns a loud contract failure into an
 * unhandled rejection alongside the real error. Secretness is applied to the
 * *input* side and inherited by the derived Output — the channel exists to
 * carry credentials, and classifying per-field would put the decision in the
 * one place least able to make it.
 */
export function readContract<T>(
	channel: ContractChannel,
	title: string,
	project: (fields: Record<string, string>) => T,
): pulumi.Output<T> {
	const { transport } = channel;
	// An op channel has no credential to resolve, but still goes through a
	// secret Output so the result is classified identically on both transports.
	const credential = transport.kind === "connect" ? transport.token : "";
	const result = pulumi
		.output(pulumi.secret(credential))
		.apply(async (resolved) =>
			project(
				await readContractItemAsync(
					transport.kind === "connect"
						? { ...channel, transport: { ...transport, token: resolved } }
						: { ...channel, transport },
					title,
				),
			),
		);
	// Unwrap<T> == T for the plain JSON values a contract item carries.
	return result as pulumi.Output<T>;
}

/** Read every field of a contract item as a secret Output. */
export function readContractItem(
	channel: ContractChannel,
	title: string,
): pulumi.Output<Record<string, string>> {
	return readContract(channel, title, (fields) => fields);
}

/**
 * Extract one labeled field from a contract item's fields, failing with the
 * full op:// coordinate when it is absent. Pure — compose it inside a
 * {@link readContract} projection.
 */
export function requireContractField(
	channel: ContractChannel,
	title: string,
	label: string,
	fields: Record<string, string>,
): string {
	const value = fields[label];
	if (value === undefined) {
		throw new Error(
			`contract item field "op://${channel.vault}/${title}/${label}" is ` +
				`missing; the item has fields [${Object.keys(fields)
					.sort()
					.join(", ")}]`,
		);
	}
	return value;
}

/**
 * Extract one labeled field and parse it as JSON, failing with the full
 * op:// coordinate on absence or malformed JSON. Pure — compose it inside a
 * {@link readContract} projection.
 */
export function requireJsonContractField<T>(
	channel: ContractChannel,
	title: string,
	label: string,
	fields: Record<string, string>,
): T {
	const raw = requireContractField(channel, title, label, fields);
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(
			`contract item field "op://${channel.vault}/${title}/${label}" is ` +
				"not parseable JSON",
		);
	}
}

/**
 * Read one field of a contract item, failing with its full op://
 * coordinate when the field is absent.
 */
export function readContractField(
	channel: ContractChannel,
	title: string,
	label: string,
): pulumi.Output<string> {
	return readContract(channel, title, (fields) =>
		requireContractField(channel, title, label, fields),
	);
}
