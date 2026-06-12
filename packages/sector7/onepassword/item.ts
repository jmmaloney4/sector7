import {
	type CustomResourceOptions,
	dynamic,
	type Input,
	type Output,
	secret,
} from "@pulumi/pulumi";
import {
	type PortForwardTarget,
	withPortForward,
} from "../k8s/port-forward.ts";

/**
 * Resource options accepted by sector7 dynamic resources.
 *
 * Pulumi dynamic resources are executed by the Node.js dynamic provider runtime,
 * not by a cloud provider plugin. Passing `provider` or `providers` makes Pulumi
 * route the resource through the wrong provider bridge, which fails with a
 * misleading `pulumi-nodejs:dynamic:Resource` unknown-token error.
 */
export type DynamicResourceOptions = Omit<
	CustomResourceOptions,
	"provider" | "providers"
>;

const DEFAULT_DEPLOYMENT = "onepassword-connect";
const DEFAULT_PORT = 8080;
const DEFAULT_CATEGORY = "PASSWORD";
const DEFAULT_FIELD_TYPE = "CONCEALED";

// ---------------------------------------------------------------------------
// Public input types
// ---------------------------------------------------------------------------

/** A field to write into the 1Password item. Values are treated as secrets. */
export interface OnePasswordItemFieldArgs {
	/** Field label (e.g. `password`). Combined with the item title this is how
	 * consumers address the value: `op://<vault>/<title>/<label>`. */
	label: Input<string>;
	/** Field value. Pass a `pulumi.secret(...)` for anything sensitive. */
	value: Input<string>;
	/** Connect field type. Defaults to `CONCEALED`. */
	type?: Input<string>;
	/** Optional field purpose (`PASSWORD` | `USERNAME` | `NOTES`). */
	purpose?: Input<string>;
}

export interface OnePasswordItemArgs {
	/**
	 * Kubeconfig (YAML) used to open the port-forward to Connect. Falls back to
	 * the ambient default config when omitted. Out-of-cluster callers (whose
	 * credentials come from a Pulumi stack output) should pass it explicitly.
	 */
	kubeconfig?: Input<string>;
	/** Connect access token with **write** scope on the target vault. */
	connectToken: Input<string>;
	/** Namespace the Connect server runs in (e.g. `1password`). */
	namespace: Input<string>;
	/** Connect Deployment to port-forward to. Defaults to `onepassword-connect`. */
	deploymentName?: Input<string>;
	/** Connect REST port. Defaults to `8080`. */
	connectPort?: Input<number>;
	/** Target vault id. */
	vault: Input<string>;
	/** Item title; also the stable key used to adopt a pre-existing item. */
	title: Input<string>;
	/** 1Password category. Defaults to `PASSWORD`. */
	category?: Input<string>;
	/** Fields to write. At least one is required. */
	fields: OnePasswordItemFieldArgs[];
}

// ---------------------------------------------------------------------------
// Resolved provider shapes (what the dynamic runtime hands the callbacks)
// ---------------------------------------------------------------------------

interface ResolvedField {
	label: string;
	value: string;
	type?: string;
	purpose?: string;
}

interface OnePasswordItemProviderInputs {
	kubeconfig?: string;
	connectToken: string;
	namespace: string;
	deploymentName?: string;
	connectPort?: number;
	vault: string;
	title: string;
	category?: string;
	fields: ResolvedField[];
}

interface OnePasswordItemState {
	kubeconfig?: string;
	connectToken: string;
	namespace: string;
	deploymentName: string;
	connectPort: number;
	vault: string;
	title: string;
	category: string;
	uuid: string;
	itemPath: string;
	contentHash: string;
	/** Labels this resource manages, so a later update can remove ones that were
	 * dropped from input without touching unmanaged fields. */
	managedLabels: string[];
}

// ---------------------------------------------------------------------------
// 1Password Connect REST client
//
// The in-process port-forward transport lives in the shared `../k8s/port-forward`
// module (`withPortForward`); see its serialization contract. Everything below
// runs inside provider callbacks and uses only the global `fetch` plus lazy
// `await import("node:crypto")`, so the provider closure serializes.
// ---------------------------------------------------------------------------

/** Issue an authenticated request against the Connect REST API. */
async function connectRequest(
	baseUrl: string,
	token: string,
	path: string,
	method: "GET" | "POST" | "PUT" | "DELETE",
	body?: unknown,
	// biome-ignore lint/suspicious/noExplicitAny: Connect responses are dynamic JSON
): Promise<any> {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});

	const text = await response.text();
	if (!response.ok) {
		// Deliberately omit the response body: Connect can echo item content /
		// validation details on failure, which would leak secret field values
		// into Pulumi logs. The status + method + path are enough to diagnose.
		const err = new Error(
			`1Password Connect ${method} ${path} failed: ${response.status} ${response.statusText}`,
		);
		(err as { status?: number }).status = response.status;
		throw err;
	}
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

// biome-ignore lint/suspicious/noExplicitAny: Connect field objects are loosely typed
function managedField(f: ResolvedField): Record<string, any> {
	return {
		label: f.label,
		type: f.type ?? DEFAULT_FIELD_TYPE,
		value: f.value,
		...(f.purpose ? { purpose: f.purpose } : {}),
	};
}

/** Build the Connect item body for a fresh create (no pre-existing item). */
function buildNewItemBody(
	vault: string,
	title: string,
	category: string,
	fields: ResolvedField[],
): Record<string, unknown> {
	return {
		vault: { id: vault },
		title,
		category,
		fields: fields.map(managedField),
	};
}

/**
 * Build the update body for an existing item by merging the managed fields into
 * whatever the item already has. Managed fields are upserted by label; any
 * unmanaged fields, sections, urls, tags, and other metadata on the existing
 * item are preserved (a blind rebuild would silently drop them — important when
 * adopting a pre-existing item).
 */
function buildMergedItemBody(
	// biome-ignore lint/suspicious/noExplicitAny: existing item is loosely typed
	existing: any,
	vault: string,
	title: string,
	category: string,
	fields: ResolvedField[],
	id: string,
	priorManagedLabels: string[],
): Record<string, unknown> {
	// biome-ignore lint/suspicious/noExplicitAny: Connect field objects are loosely typed
	const byLabel = new Map<string, any>();
	for (const f of (existing?.fields ?? []) as Array<{ label?: string }>) {
		if (f?.label) byLabel.set(f.label, f);
	}
	// Remove fields we previously managed but that are no longer declared, so the
	// item reconciles to the declared state. Fields we never managed (and prior
	// managed fields that are still declared) are left untouched here.
	const declared = new Set(fields.map((f) => f.label));
	for (const label of priorManagedLabels) {
		if (!declared.has(label)) byLabel.delete(label);
	}
	// Upsert the declared managed fields.
	for (const f of fields) {
		byLabel.set(f.label, { ...byLabel.get(f.label), ...managedField(f) });
	}
	return {
		...existing,
		id,
		vault: { id: vault },
		title,
		category,
		fields: [...byLabel.values()],
	};
}

/** Fetch a full item (fields + sections + metadata) for a merge-preserving update. */
async function getItem(
	baseUrl: string,
	token: string,
	vault: string,
	id: string,
	// biome-ignore lint/suspicious/noExplicitAny: Connect item is loosely typed
): Promise<any> {
	return connectRequest(
		baseUrl,
		token,
		`/v1/vaults/${vault}/items/${id}`,
		"GET",
	);
}

/** Find an existing item id in a vault by exact title, for idempotent adoption. */
async function findItemIdByTitle(
	baseUrl: string,
	token: string,
	vault: string,
	title: string,
): Promise<string | undefined> {
	const escaped = title.replace(/"/g, '\\"');
	const filter = encodeURIComponent(`title eq "${escaped}"`);
	const items = await connectRequest(
		baseUrl,
		token,
		`/v1/vaults/${vault}/items?filter=${filter}`,
		"GET",
	);
	if (!Array.isArray(items) || items.length === 0) return undefined;
	// Re-check the title exactly (don't trust the server filter to be strict).
	// Titles are NOT unique within a vault, so adopting an arbitrary match could
	// overwrite or later delete an unrelated, manually-created secret in a shared
	// vault. Refuse to adopt ambiguously: exactly one match adopts, zero creates,
	// more than one is a hard error the operator must resolve. (Same authorization
	// reasoning sector7#258 applies to LiteLLM team aliases.)
	// biome-ignore lint/suspicious/noExplicitAny: item overview is loosely typed
	const matches = items.filter((it: any) => it?.title === title);
	if (matches.length > 1) {
		throw new Error(
			`1Password vault ${vault} contains ${matches.length} items titled "${title}"; ` +
				"refusing to adopt ambiguously. Remove the duplicate(s) or give this item a unique title.",
		);
	}
	// biome-ignore lint/suspicious/noExplicitAny: item overview is loosely typed
	return (matches[0] as any)?.id;
}

async function computeContentHash(
	category: string,
	fields: ResolvedField[],
): Promise<string> {
	const nodeCrypto = (await import(
		"node:crypto"
	)) as typeof import("node:crypto");
	const canonical = JSON.stringify({
		category,
		fields: [...fields]
			.map((f) => ({
				label: f.label,
				value: f.value,
				type: f.type ?? DEFAULT_FIELD_TYPE,
				purpose: f.purpose ?? null,
			}))
			.sort((a, b) => a.label.localeCompare(b.label)),
	});
	return nodeCrypto.createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTarget(i: {
	kubeconfig?: string;
	namespace: string;
	deploymentName?: string;
	connectPort?: number;
}): PortForwardTarget {
	return {
		kubeconfig: i.kubeconfig,
		namespace: i.namespace,
		deploymentName: i.deploymentName ?? DEFAULT_DEPLOYMENT,
		port: i.connectPort ?? DEFAULT_PORT,
	};
}

function stateOuts(
	i: OnePasswordItemProviderInputs,
	uuid: string,
	contentHash: string,
): OnePasswordItemState {
	return {
		kubeconfig: i.kubeconfig,
		connectToken: i.connectToken,
		namespace: i.namespace,
		deploymentName: i.deploymentName ?? DEFAULT_DEPLOYMENT,
		connectPort: i.connectPort ?? DEFAULT_PORT,
		vault: i.vault,
		title: i.title,
		category: i.category ?? DEFAULT_CATEGORY,
		uuid,
		itemPath: `vaults/${i.vault}/items/${uuid}`,
		contentHash,
		managedLabels: i.fields.map((f) => f.label),
	};
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const onePasswordItemProvider: dynamic.ResourceProvider = {
	async check(
		_olds: OnePasswordItemState,
		news: OnePasswordItemProviderInputs,
	): Promise<dynamic.CheckResult> {
		const failures: dynamic.CheckFailure[] = [];
		if (!news.connectToken)
			failures.push({
				property: "connectToken",
				reason: "connectToken is required",
			});
		if (!news.namespace)
			failures.push({ property: "namespace", reason: "namespace is required" });
		if (!news.vault)
			failures.push({ property: "vault", reason: "vault is required" });
		if (!news.title || news.title.trim().length === 0)
			failures.push({
				property: "title",
				reason: "title must be a non-empty string",
			});
		if (!Array.isArray(news.fields) || news.fields.length === 0) {
			failures.push({
				property: "fields",
				reason: "at least one field is required",
			});
		} else {
			const seen = new Set<string>();
			news.fields.forEach((f, idx) => {
				if (!f?.label)
					failures.push({
						property: `fields[${idx}].label`,
						reason: "field label is required",
					});
				else if (seen.has(f.label))
					// Fields are keyed by label when written to / merged into the item,
					// so duplicate labels would silently collapse (last write wins) and
					// corrupt drift detection. Reject them up front.
					failures.push({
						property: `fields[${idx}].label`,
						reason: `duplicate field label: ${f.label}`,
					});
				else seen.add(f.label);
			});
		}
		return { inputs: news, failures };
	},

	async diff(
		_id: string,
		olds: OnePasswordItemState,
		news: OnePasswordItemProviderInputs,
	): Promise<dynamic.DiffResult> {
		// Identity = vault + title (the adoption key). A change there is a
		// different item, so it forces replacement.
		const replaces: string[] = [];
		if (olds.vault !== news.vault) replaces.push("vault");
		if (olds.title !== news.title) replaces.push("title");

		const contentHash = await computeContentHash(
			news.category ?? DEFAULT_CATEGORY,
			news.fields,
		);

		// Transport inputs (token, kubeconfig, namespace, deployment, port) don't
		// change the item, so they never force replacement — but they MUST still
		// trigger an in-place update, otherwise a token rotation or cluster move is
		// dropped and the stale value persists in state, breaking a later
		// update()/delete(). Compare against the resolved values stored in state.
		const transportChanged =
			olds.connectToken !== news.connectToken ||
			(olds.kubeconfig ?? undefined) !== (news.kubeconfig ?? undefined) ||
			olds.namespace !== news.namespace ||
			olds.deploymentName !== (news.deploymentName ?? DEFAULT_DEPLOYMENT) ||
			olds.connectPort !== (news.connectPort ?? DEFAULT_PORT);

		const changed =
			replaces.length > 0 ||
			contentHash !== olds.contentHash ||
			transportChanged;

		// Never delete-before-replace: a value/identity change must not drop the
		// item out from under consumers that reference it by path mid-update.
		return { changes: changed, replaces, deleteBeforeReplace: false };
	},

	async create(
		inputs: OnePasswordItemProviderInputs,
	): Promise<dynamic.CreateResult> {
		const target = resolveTarget(inputs);
		const category = inputs.category ?? DEFAULT_CATEGORY;
		const uuid = await withPortForward(target, async (baseUrl) => {
			// Find-or-create: adopt a pre-existing item by title and reconcile its
			// fields in place, else create a fresh one. Adoption is what makes a
			// safe cutover from a hand-created/unmanaged item possible.
			const existing = await findItemIdByTitle(
				baseUrl,
				inputs.connectToken,
				inputs.vault,
				inputs.title,
			);
			if (existing) {
				// Fetch the full item and merge so unmanaged fields/sections survive.
				const current = await getItem(
					baseUrl,
					inputs.connectToken,
					inputs.vault,
					existing,
				);
				await connectRequest(
					baseUrl,
					inputs.connectToken,
					`/v1/vaults/${inputs.vault}/items/${existing}`,
					"PUT",
					buildMergedItemBody(
						current,
						inputs.vault,
						inputs.title,
						category,
						inputs.fields,
						existing,
						// First reconcile of an adopted item: we have no record of what
						// we managed before, so remove nothing — only upsert.
						[],
					),
				);
				return existing;
			}
			const created = await connectRequest(
				baseUrl,
				inputs.connectToken,
				`/v1/vaults/${inputs.vault}/items`,
				"POST",
				buildNewItemBody(inputs.vault, inputs.title, category, inputs.fields),
			);
			const id: string | undefined = created?.id;
			if (!id) throw new Error("1Password Connect create returned no item id");
			return id;
		});
		const contentHash = await computeContentHash(category, inputs.fields);
		return { id: uuid, outs: stateOuts(inputs, uuid, contentHash) };
	},

	async update(
		id: string,
		olds: OnePasswordItemState,
		news: OnePasswordItemProviderInputs,
	): Promise<dynamic.UpdateResult> {
		const target = resolveTarget(news);
		const category = news.category ?? DEFAULT_CATEGORY;
		await withPortForward(target, async (baseUrl) => {
			// Merge into the live item so unmanaged fields/sections are preserved,
			// while removing fields we previously managed but that were dropped.
			const current = await getItem(baseUrl, news.connectToken, news.vault, id);
			await connectRequest(
				baseUrl,
				news.connectToken,
				`/v1/vaults/${news.vault}/items/${id}`,
				"PUT",
				buildMergedItemBody(
					current,
					news.vault,
					news.title,
					category,
					news.fields,
					id,
					olds.managedLabels ?? [],
				),
			);
		});
		const contentHash = await computeContentHash(category, news.fields);
		return { outs: stateOuts(news, id, contentHash) };
	},

	async delete(id: string, props: OnePasswordItemState): Promise<void> {
		const target = resolveTarget(props);
		await withPortForward(target, async (baseUrl) => {
			try {
				await connectRequest(
					baseUrl,
					props.connectToken,
					`/v1/vaults/${props.vault}/items/${id}`,
					"DELETE",
				);
			} catch (error) {
				// A 404 means the item is already gone (manually removed, or an
				// adopted pre-existing item that was deleted externally). Treat that
				// as a successful delete so `pulumi destroy` is idempotent.
				if ((error as { status?: number })?.status !== 404) throw error;
			}
		});
	},
};

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

const rejectCloudProviderOptions = (
	resourceName: string,
	opts?: CustomResourceOptions,
): void => {
	if (!opts) return;

	const hasProvider =
		Object.hasOwn(opts, "provider") && opts.provider !== undefined;
	const hasProviders =
		Object.hasOwn(opts, "providers") &&
		(opts as Record<string, unknown>).providers !== undefined;
	if (!hasProvider && !hasProviders) return;

	throw new Error(
		`${resourceName} is a Pulumi dynamic resource; do not pass provider/providers. ` +
			"Pass provider options only to cloud provider resources, and use parent/dependsOn for dynamic resource ordering.",
	);
};

// ---------------------------------------------------------------------------
// Public resource
// ---------------------------------------------------------------------------

/**
 * A 1Password item managed as a first-class Pulumi resource, written through
 * the in-cluster 1Password Connect server over an in-process Kubernetes
 * port-forward (Connect stays `ClusterIP`-only). Create is idempotent
 * (find-or-create by title); a field-value change is an in-place `PUT`; only a
 * vault/title change forces replacement.
 *
 * Sensitive inputs (`connectToken`, `kubeconfig`, and every field `value`) are
 * wrapped in `pulumi.secret()` so they are encrypted in state even if the caller
 * forgets to — and the same names are marked `additionalSecretOutputs`. Field
 * values are never echoed back into the output state; drift is tracked via a
 * `contentHash`.
 */
export class OnePasswordItem extends dynamic.Resource {
	/** The created/adopted 1Password item id. */
	public declare readonly uuid: Output<string>;
	/** `vaults/<vault>/items/<uuid>` — the form `OnePasswordItem` CRs / `op read` consume. */
	public declare readonly itemPath: Output<string>;
	/** Hash of the written content; used to detect drift without storing values. */
	public declare readonly contentHash: Output<string>;

	constructor(
		name: string,
		args: OnePasswordItemArgs,
		opts?: DynamicResourceOptions,
	) {
		rejectCloudProviderOptions("OnePasswordItem", opts);
		const mergedOpts: DynamicResourceOptions = {
			...opts,
			additionalSecretOutputs: [
				"connectToken",
				"kubeconfig",
				// contentHash is a sha256 of the secret field values; encrypt it so
				// stack state can't be used as an offline oracle for low-entropy
				// secrets or to detect secret reuse across items.
				"contentHash",
				...(opts?.additionalSecretOutputs ?? []),
			],
		};
		// Force every sensitive input to a secret so values are encrypted in state
		// even when the caller passes plain strings.
		const securedArgs = {
			...args,
			connectToken: secret(args.connectToken),
			...(args.kubeconfig !== undefined
				? { kubeconfig: secret(args.kubeconfig) }
				: {}),
			fields: args.fields.map((f) => ({ ...f, value: secret(f.value) })),
		};
		super(
			onePasswordItemProvider,
			name,
			{
				uuid: undefined,
				itemPath: undefined,
				contentHash: undefined,
				...securedArgs,
			},
			mergedOpts,
		);
	}
}
