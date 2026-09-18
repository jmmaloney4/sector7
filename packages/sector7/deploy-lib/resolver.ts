/**
 * Dual-mode cluster credential + shared-config resolvers (ADR 035).
 *
 * Contract-first: when the stack carries `contract:vault` config, every
 * function here resolves from the tenant's 1Password contract items.
 * Otherwise it resolves from the legacy shared-backend StackReferences
 * (`organization/k8s/<env>`, `organization/config/<env>`) — the path garden
 * ADR 173 schedules for deletion once no stack uses it (wave 5).
 *
 * Call sites are mode-blind by design: consumers migrate stack-by-stack by
 * setting config, with zero code changes.
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as yaml from "yaml";
import {
	type ContractChannel,
	getContractChannel,
	readContract,
	readContractField,
	requireContractField,
	requireJsonContractField,
} from "./contract.ts";

/**
 * Default organization for Pulumi stack references with a self-managed
 * backend (GCS, S3, local). These backends always use the literal string
 * "organization" as the org component, unlike Pulumi Cloud (SaaS) which
 * uses the account/user name.
 */
const DEFAULT_ORG = "organization";

/**
 * Default platform stack name for the Kubernetes provider abstraction.
 * Matches the Pulumi project name of the platform's `k8s` stack.
 */
const DEFAULT_K8S_STACK_NAME = "k8s";

/** Contract item titles pinned by ADR 035 (the publisher must match). */
const KUBECONFIG_ITEM = "kubeconfig";
const CONFIG_ITEM = "config";

const stackRefCache = new Map<string, pulumi.StackReference>();
const configStackRefCache = new Map<string, pulumi.StackReference>();

/** Test hook: drop cached StackReferences. Not part of the public surface. */
export function clearStackRefCachesForTesting(): void {
	stackRefCache.clear();
	configStackRefCache.clear();
}

export interface PlatformStackOpts {
	/** Pulumi stack name for the k8s platform stack (defaults to "k8s"). */
	stackName?: string;
	/** Pulumi environment/stack (defaults to "prod"). */
	environment?: string;
}

function getPlatformStackRef(opts?: PlatformStackOpts): pulumi.StackReference {
	const stackName = opts?.stackName ?? DEFAULT_K8S_STACK_NAME;
	const environment = opts?.environment ?? "prod";
	const key = `${DEFAULT_ORG}/${stackName}/${environment}`;
	let ref = stackRefCache.get(key);
	if (!ref) {
		ref = new pulumi.StackReference(key);
		stackRefCache.set(key, ref);
	}
	return ref;
}

/**
 * Read the platform cluster's kubeconfig as a string Output.
 *
 * Contract mode reads the `kubeconfig` field of the `kubeconfig` contract
 * item; stackref mode reads the platform stack's `kubeconfig` output.
 *
 * Exposed for dynamic resources (e.g. sector7's `OnePasswordItem`) that open
 * their own in-process Kubernetes port-forward and therefore need the raw
 * kubeconfig rather than a bound `k8s.Provider`.
 */
export function getPlatformKubeconfig(
	opts?: PlatformStackOpts,
): pulumi.Output<string> {
	const channel = getContractChannel();
	if (channel) {
		return readContractField(channel, KUBECONFIG_ITEM, "kubeconfig");
	}
	return getPlatformStackRef(opts)
		.requireOutput("kubeconfig")
		.apply((v) => (typeof v === "string" ? v : JSON.stringify(v)));
}

/**
 * Construct a Kubernetes provider for the platform cluster.
 *
 * The provider's logical name is fixed at `"k8s-platform"` — downstream
 * repos pin exactly one such provider per stack, and renaming it would
 * replace every resource it manages.
 *
 * @param opts.stackName - platform stack name (stackref mode only).
 * @param opts.environment - Pulumi environment/stack (stackref mode only;
 *                           defaults to "prod").
 * @param opts.enablePatchForce - force SSA patch apply even when other field
 *        managers own the same fields (e.g. the Rook operator). Harmless for
 *        non-conflicting resources.
 */
export function getK8sProvider(
	opts?: PlatformStackOpts & { enablePatchForce?: boolean },
): k8s.Provider {
	return new k8s.Provider("k8s-platform", {
		kubeconfig: getPlatformKubeconfig(opts),
		enablePatchForce: opts?.enablePatchForce,
	});
}

/**
 * Derive the API server host from the kubeconfig contract item's fields
 * (`clusters[0].cluster.server`). Pure — exposed as the projection
 * {@link getApiServerHost} applies in contract mode.
 */
export function apiServerHostFromContractFields(
	channel: ContractChannel,
	fields: Record<string, string>,
): string {
	const kubeconfig = requireContractField(
		channel,
		KUBECONFIG_ITEM,
		"kubeconfig",
		fields,
	);
	let server: unknown;
	try {
		// Kubeconfigs are conventionally YAML; JSON is a subset of YAML, so
		// this accepts both without caring which the publisher wrote.
		const parsed = yaml.parse(kubeconfig) as {
			clusters?: { cluster?: { server?: unknown } }[];
		} | null;
		server = parsed?.clusters?.[0]?.cluster?.server;
	} catch {
		throw new Error(
			`contract item "op://${channel.vault}/${KUBECONFIG_ITEM}/kubeconfig" ` +
				"is not parseable YAML/JSON, so the API server host cannot be derived",
		);
	}
	if (typeof server !== "string" || server.length === 0) {
		throw new Error(
			`contract item "op://${channel.vault}/${KUBECONFIG_ITEM}/kubeconfig" ` +
				"has no clusters[0].cluster.server to derive the API server host from",
		);
	}
	return server;
}

/**
 * Read the platform cluster's API server host.
 *
 * Contract mode derives it from the kubeconfig contract item
 * (`clusters[0].cluster.server`) rather than requiring a second item that
 * could drift from it; stackref mode reads the platform stack's `apiHost`
 * output.
 */
export function getApiServerHost(
	opts?: PlatformStackOpts,
): pulumi.Output<string> {
	const channel = getContractChannel();
	if (channel) {
		return readContract(channel, KUBECONFIG_ITEM, (fields) =>
			apiServerHostFromContractFields(channel, fields),
		);
	}
	return getPlatformStackRef(opts).requireOutput(
		"apiHost",
	) as pulumi.Output<string>;
}

/**
 * Typed contract for the shared config surface (garden ADR 038 / ADR 173).
 *
 * The single source of truth for cross-stack Cloudflare secrets and GHCR
 * credentials, however the stack resolves them.
 */
export interface ConfigStackOutputs {
	/** Cloudflare API tokens keyed by account ID. */
	cloudflareApiTokens: pulumi.Output<Record<string, string>>;
	/** GHCR username for image authentication. */
	ghcrUsername: pulumi.Output<string>;
	/** GHCR personal access token (secret). */
	ghcrToken: pulumi.Output<string>;
}

/**
 * Resolve the shared config surface.
 *
 * Contract mode reads the `config` contract item: `cloudflareApiTokens` is a
 * JSON-encoded `Record<accountId, token>` and `ghcr` a JSON-encoded
 * `{"username": ..., "token": ...}` (field shapes pinned by ADR 035).
 *
 * Stackref mode reads the `organization/config/<env>` stack, defaulting to
 * `prod` — dev/stage config stacks inherit prod's secrets via StackReference,
 * so consumers get the same values regardless of deploy environment. Only
 * override `environment` if the target stack has its own secrets.
 */
export function getConfigStack(environment?: string): ConfigStackOutputs {
	const channel = getContractChannel();
	if (channel) {
		type Ghcr = { username: string; token: string };
		// One single-layer Output per surface field: the underlying HTTP read is
		// cached per item, and per-field projections keep every Output directly
		// awaited by its consumer (an intermediate shared Output would turn a
		// contract failure into unhandled rejections next to the real error).
		return {
			cloudflareApiTokens: readContract(channel, CONFIG_ITEM, (fields) =>
				requireJsonContractField<Record<string, string>>(
					channel,
					CONFIG_ITEM,
					"cloudflareApiTokens",
					fields,
				),
			),
			ghcrUsername: readContract(
				channel,
				CONFIG_ITEM,
				(fields) =>
					requireJsonContractField<Ghcr>(channel, CONFIG_ITEM, "ghcr", fields)
						.username,
			),
			ghcrToken: readContract(
				channel,
				CONFIG_ITEM,
				(fields) =>
					requireJsonContractField<Ghcr>(channel, CONFIG_ITEM, "ghcr", fields)
						.token,
			),
		};
	}

	const env = environment ?? "prod";
	const key = `${DEFAULT_ORG}/config/${env}`;
	let ref = configStackRefCache.get(key);
	if (!ref) {
		ref = new pulumi.StackReference(key);
		configStackRefCache.set(key, ref);
	}
	return {
		cloudflareApiTokens: ref.requireOutput(
			"cloudflareApiTokens",
		) as pulumi.Output<Record<string, string>>,
		ghcrUsername: ref.requireOutput("ghcrUsername") as pulumi.Output<string>,
		ghcrToken: ref.requireOutput("ghcrToken") as pulumi.Output<string>,
	};
}
