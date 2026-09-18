/**
 * Contract channel reader (ADR 035; garden ADR 173).
 *
 * A tenant's cluster coordinates and shared secrets are published as items in
 * a per-tenant 1Password vault — the "contract" — addressed as
 * `op://<vault>/<title>/<label>`. This module is the read side: a minimal
 * 1Password Connect REST client plus the single chokepoint that decides
 * whether a stack is in contract mode at all.
 *
 * Bootstrap is deliberately out-of-band (garden ADR 173): the Connect
 * coordinates come from stack config or environment variables, never from a
 * contract item (circular) and never through a kubeconfig-authenticated
 * port-forward (the kubeconfig is the thing being fetched).
 */

import * as pulumi from "@pulumi/pulumi";

/**
 * Resolved contract-channel coordinates for the current stack.
 *
 * Existence of this object *is* the mode: a stack with a channel resolves
 * every deploy-lib read from the contract, and a read failure is a hard
 * error — never a silent fall back to the StackReference path.
 */
export interface ContractChannel {
	/** 1Password vault holding this tenant's contract (UUID or exact name). */
	vault: string;
	/** 1Password Connect base URL, e.g. `https://op-connect.example.com`. */
	connectHost: string;
	/** Connect bearer token. */
	connectToken: pulumi.Input<string>;
	/**
	 * Reject contract items whose `producedAt` field is older than this.
	 * Unset disables the freshness check.
	 */
	maxAgeHours?: number;
}

/**
 * Read the contract-channel configuration for the current stack, or
 * `undefined` when the stack is not in contract mode.
 *
 * Mode selection is exactly "is `contract:vault` set": once it is, missing
 * Connect coordinates are a configuration error and throw immediately,
 * because interpreting them as "not migrated yet" would silently re-create
 * the cross-boundary StackReference the contract exists to remove.
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
	if (!connectHost) {
		throw new Error(
			"contract:vault is set but no 1Password Connect host is configured. " +
				"Set contract:connectHost or the OP_CONNECT_HOST environment variable.",
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
	const connectToken: pulumi.Input<string> | undefined =
		cfg.getSecret("connectToken")?.apply((t) => t.trim()) ??
		process.env.OP_CONNECT_TOKEN?.trim();
	if (!connectToken) {
		throw new Error(
			"contract:vault is set but no 1Password Connect token is configured. " +
				"Set contract:connectToken (secret) or the OP_CONNECT_TOKEN " +
				"environment variable.",
		);
	}
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
	return {
		vault,
		connectHost,
		connectToken,
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

async function fetchItemFields(
	host: string,
	token: string,
	vault: string,
	title: string,
): Promise<Record<string, string>> {
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
	const item = (await connectGet(
		host,
		token,
		`/v1/vaults/${vaultId}/items/${items[0]!.id}`,
	)) as { fields?: { label?: string; value?: string }[] };
	const fields: Record<string, string> = {};
	for (const f of item.fields ?? []) {
		if (f.label && f.value !== undefined) {
			fields[f.label] = f.value;
		}
	}
	return fields;
}

/**
 * Per-process cache of contract item reads, keyed by host|vault|title.
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
	channel: ContractChannel,
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
 * Promise-level contract item read: cached HTTP fetch plus the freshness
 * assertion. This is where every contract failure mode throws, so it is the
 * function to test failure paths against — a rejecting Pulumi Output cannot
 * be awaited in tests without its internal isKnown/isSecret promise chains
 * surfacing as unhandled rejections.
 */
export async function readContractItemAsync(
	channel: ContractChannel,
	token: string,
	title: string,
): Promise<Record<string, string>> {
	const key = `${channel.connectHost}|${channel.vault}|${title}`;
	let cached = itemCache.get(key);
	if (!cached) {
		cached = fetchItemFields(channel.connectHost, token, channel.vault, title);
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
 * The token resolution, HTTP reads, freshness check, and projection all
 * happen inside ONE `apply`, deliberately: every intermediate Output layer
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
	const result = pulumi
		.output(pulumi.secret(channel.connectToken))
		.apply(async (token) =>
			project(await readContractItemAsync(channel, token, title)),
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
