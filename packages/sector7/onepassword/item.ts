import {
	type CustomResourceOptions,
	dynamic,
	type Input,
	type Output,
} from "@pulumi/pulumi";

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
}

// ---------------------------------------------------------------------------
// Transport: in-process Kubernetes port-forward to the Connect server
//
// Every Node/k8s import is a lazy `await import()` *inside* these functions so
// the provider closure that references them serializes — the same rule
// `r2/r2object.ts` and the litellm admin providers document. The transport and
// REST client are kept in this module (mirroring `litellm/admin.ts`) so the
// serialized closure stays self-contained; factoring the port-forward into a
// shared sector7 util (deduping with `litellm/admin.ts`) is follow-up once both
// land (see ADR 031 / sector7#258).
// ---------------------------------------------------------------------------

interface ConnectTarget {
	kubeconfig?: string;
	namespace: string;
	deploymentName: string;
	port: number;
}

/**
 * Open a short-lived in-process port-forward to a ready Connect pod, invoke
 * `fn` with a `http://127.0.0.1:<port>` base URL, then tear the forward down.
 * Reaches Connect wherever kube credentials work (through the apiserver), so
 * Connect needs no tailnet/public ingress.
 */
async function withConnectBaseUrl<T>(
	target: ConnectTarget,
	fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
	const k8s = await import("@kubernetes/client-node");
	const net = await import("node:net");

	const kc = new k8s.KubeConfig();
	if (target.kubeconfig) {
		kc.loadFromString(target.kubeconfig);
	} else {
		kc.loadFromDefault();
	}

	const apps = kc.makeApiClient(k8s.AppsV1Api);
	const core = kc.makeApiClient(k8s.CoreV1Api);

	// Resolve the deployment's pod selector at runtime (no hardcoded labels),
	// then pick a ready pod.
	const depResp = await apps.readNamespacedDeployment({
		name: target.deploymentName,
		namespace: target.namespace,
	});
	// client-node 1.x returns the body directly; tolerate the 0.x {body} shape.
	// biome-ignore lint/suspicious/noExplicitAny: k8s client response is loosely typed across majors
	const dep: any = (depResp as any)?.body ?? depResp;
	const matchLabels: Record<string, string> =
		dep?.spec?.selector?.matchLabels ?? {};
	const labelSelector = Object.entries(matchLabels)
		.map(([k, v]) => `${k}=${v}`)
		.join(",");
	if (!labelSelector) {
		throw new Error(
			`deployment ${target.namespace}/${target.deploymentName} has no spec.selector.matchLabels`,
		);
	}

	const podResp = await core.listNamespacedPod({
		namespace: target.namespace,
		labelSelector,
	});
	// biome-ignore lint/suspicious/noExplicitAny: k8s client response is loosely typed across majors
	const pods: any[] = ((podResp as any)?.body ?? podResp)?.items ?? [];
	const ready =
		pods.find(
			// biome-ignore lint/suspicious/noExplicitAny: pod object is loosely typed
			(p: any) =>
				p?.status?.phase === "Running" &&
				(p?.status?.conditions ?? []).some(
					// biome-ignore lint/suspicious/noExplicitAny: condition object is loosely typed
					(c: any) => c?.type === "Ready" && c?.status === "True",
				),
		) ?? pods[0];
	const podName: string | undefined = ready?.metadata?.name;
	if (!podName) {
		throw new Error(
			`no running pod found for deployment ${target.namespace}/${target.deploymentName}`,
		);
	}

	const forward = new k8s.PortForward(kc);
	const server = net.createServer((socket) => {
		forward
			.portForward(
				target.namespace,
				podName,
				[target.port],
				socket,
				null,
				socket,
			)
			.catch((err: unknown) =>
				socket.destroy(err instanceof Error ? err : new Error(String(err))),
			);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});

	const address = server.address();
	const localPort =
		address && typeof address === "object" ? address.port : undefined;
	if (!localPort) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error("failed to bind a local port for the Connect port-forward");
	}

	try {
		return await fn(`http://127.0.0.1:${localPort}`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

// ---------------------------------------------------------------------------
// 1Password Connect REST client
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
		throw new Error(
			`1Password Connect ${method} ${path} failed: ${response.status} ${response.statusText}\n${text}`,
		);
	}
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Build the Connect item body for create/update. */
function buildItemBody(
	vault: string,
	title: string,
	category: string,
	fields: ResolvedField[],
	id?: string,
): Record<string, unknown> {
	return {
		...(id ? { id } : {}),
		vault: { id: vault },
		title,
		category,
		fields: fields.map((f) => ({
			label: f.label,
			type: f.type ?? DEFAULT_FIELD_TYPE,
			value: f.value,
			...(f.purpose ? { purpose: f.purpose } : {}),
		})),
	};
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
	// Connect's filter is server-side, but re-check title exactly to avoid
	// adopting a near-match if a backend ever loosens the filter semantics.
	// biome-ignore lint/suspicious/noExplicitAny: item overview is loosely typed
	const match = items.find((it: any) => it?.title === title);
	// biome-ignore lint/suspicious/noExplicitAny: item overview is loosely typed
	return (match as any)?.id;
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
}): ConnectTarget {
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
			news.fields.forEach((f, idx) => {
				if (!f || !f.label)
					failures.push({
						property: `fields[${idx}].label`,
						reason: "field label is required",
					});
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
		// different item, so it forces replacement; everything else is an
		// in-place update. Transport inputs (kubeconfig, token, namespace,
		// deployment, port) never force replacement — they don't change the item.
		const replaces: string[] = [];
		if (olds.vault !== news.vault) replaces.push("vault");
		if (olds.title !== news.title) replaces.push("title");

		const contentHash = await computeContentHash(
			news.category ?? DEFAULT_CATEGORY,
			news.fields,
		);
		const changed = replaces.length > 0 || contentHash !== olds.contentHash;

		// Never delete-before-replace: a value/identity change must not drop the
		// item out from under consumers that reference it by path mid-update.
		return { changes: changed, replaces, deleteBeforeReplace: false };
	},

	async create(
		inputs: OnePasswordItemProviderInputs,
	): Promise<dynamic.CreateResult> {
		const target = resolveTarget(inputs);
		const category = inputs.category ?? DEFAULT_CATEGORY;
		const uuid = await withConnectBaseUrl(target, async (baseUrl) => {
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
				await connectRequest(
					baseUrl,
					inputs.connectToken,
					`/v1/vaults/${inputs.vault}/items/${existing}`,
					"PUT",
					buildItemBody(
						inputs.vault,
						inputs.title,
						category,
						inputs.fields,
						existing,
					),
				);
				return existing;
			}
			const created = await connectRequest(
				baseUrl,
				inputs.connectToken,
				`/v1/vaults/${inputs.vault}/items`,
				"POST",
				buildItemBody(inputs.vault, inputs.title, category, inputs.fields),
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
		_olds: OnePasswordItemState,
		news: OnePasswordItemProviderInputs,
	): Promise<dynamic.UpdateResult> {
		const target = resolveTarget(news);
		const category = news.category ?? DEFAULT_CATEGORY;
		await withConnectBaseUrl(target, async (baseUrl) => {
			await connectRequest(
				baseUrl,
				news.connectToken,
				`/v1/vaults/${news.vault}/items/${id}`,
				"PUT",
				buildItemBody(news.vault, news.title, category, news.fields, id),
			);
		});
		const contentHash = await computeContentHash(category, news.fields);
		return { outs: stateOuts(news, id, contentHash) };
	},

	async delete(id: string, props: OnePasswordItemState): Promise<void> {
		const target = resolveTarget(props);
		await withConnectBaseUrl(target, async (baseUrl) => {
			await connectRequest(
				baseUrl,
				props.connectToken,
				`/v1/vaults/${props.vault}/items/${id}`,
				"DELETE",
			);
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
 * `connectToken` and `kubeconfig` are stored as secret outputs so they are
 * encrypted in Pulumi state. Field values are not echoed into state; drift is
 * tracked via a `contentHash`.
 */
export class OnePasswordItem extends dynamic.Resource {
	/** The created/adopted 1Password item id. */
	public readonly uuid!: Output<string>;
	/** `vaults/<vault>/items/<uuid>` — the form `OnePasswordItem` CRs / `op read` consume. */
	public readonly itemPath!: Output<string>;
	/** Hash of the written content; used to detect drift without storing values. */
	public readonly contentHash!: Output<string>;

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
				...(opts?.additionalSecretOutputs ?? []),
			],
		};
		super(
			onePasswordItemProvider,
			name,
			{ uuid: undefined, itemPath: undefined, contentHash: undefined, ...args },
			mergedOpts,
		);
	}
}
