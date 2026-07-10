/**
 * 1Password CLI-style op:// parser + CRD creation helpers.
 *
 * This module provides utilities for detecting op:// config values,
 * parsing them, and creating 1Password-operator CRDs that sync secrets
 * into Kubernetes Secrets consumable by pods via secretKeyRef.
 */

import type * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

/**
 * Parse a 1Password CLI secret-reference URI (`op://`) into the CRD
 * `itemPath` and field-name components needed to sync a Kubernetes Secret
 * via the 1Password Connect operator.
 *
 * Implements the official `op://` syntax:
 *   op://<vault>/<item>/[section/]<field>
 *
 * Both names and UUIDs are accepted for vault, item, section, and field
 * (the 1Password Connect operator's `itemPath` accepts either form).
 *
 * Query parameters (e.g. `?attribute=otp`, `?ssh-format=openssh`) are
 * supported but do not affect the CRD — the operator syncs the field value
 * as-is, and the field label becomes the K8s Secret key regardless of query
 * params. The query string is stripped before parsing.
 *
 * Supported characters per the 1Password spec: `a-z`, `A-Z`, `0-9`, `-`,
 * `_`, `.`, and whitespace. Names with unsupported characters must use
 * their UUID identifier instead.
 *
 * @throws Error if the reference has fewer than 3 path segments (missing
 *         vault, item, or field) or more than 4 (unexpected nesting).
 * @see https://developer.1password.com/docs/cli/secrets-references
 */
export function parseOnePasswordItemReference(
	opRef: string,
	accountKey: string,
): { itemPath: string; fieldName: string } {
	const pathPart = opRef.slice("op://".length);
	// Strip query parameters (e.g. "?attribute=otp") — they affect how `op read`
	// returns the value but not the CRD sync target.
	const [path] = pathPart.split("?");
	const parts = path.split("/");
	// Reject empty segments (e.g. "op://vault//field") — these indicate a
	// malformed reference that should fail fast rather than be silently
	// reinterpreted as a shorter valid path.
	if (parts.some((p) => !p)) {
		throw new Error(
			`Invalid 1Password reference for backend account '${accountKey}': "${opRef}". ` +
				"Reference contains an empty path segment (consecutive slashes).",
		);
	}
	if (parts.length < 3 || parts.length > 4) {
		throw new Error(
			`Invalid 1Password reference for backend account '${accountKey}': "${opRef}". ` +
				"Expected op://<vault>/<item>/<field> or op://<vault>/<item>/<section>/<field>.",
		);
	}
	const [vaultId, itemId, ...rest] = parts;
	const fieldName = rest[rest.length - 1];
	return {
		itemPath: `vaults/${vaultId}/items/${itemId}`,
		fieldName,
	};
}

/**
 * Merge multiple secret-ref env var maps into a single map.
 * Returns undefined if all inputs are undefined or the merged result is empty.
 */
export function mergeSecretRefEnvs(
	...envMaps: (
		| Record<string, { secretName: pulumi.Input<string>; key: pulumi.Input<string> }>
		| undefined
	)[]
):
	| Record<string, { secretName: pulumi.Input<string>; key: pulumi.Input<string> }>
	| undefined {
	const merged = Object.assign({}, ...envMaps.filter(Boolean));
	return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Options for creating 1Password secret references from config values.
 */
export interface CreateOnePasswordSecretRefsOptions<
	T extends Record<string, unknown>,
> {
	/**
	 * Pulumi config object to read raw values from.
	 */
	config: pulumi.Config;

	/**
	 * Base config key prefix (e.g., "backendAccounts").
	 * Combined with item key to read the specific config value.
	 */
	configKey: string;

	/**
	 * Map of item keys to item configurations.
	 */
	items: Record<string, T>;

	/**
	 * Function to extract the op:// reference field from an item.
	 * Returns undefined if the field doesn't start with "op://".
	 */
	keySelector: (item: T, itemKey: string) => string | undefined;

	/**
	 * Function to convert an item key to an env var name.
	 * Example: "personal-zai" → "PERSONAL_ZAI_API_KEY".
	 */
	envVarNaming: (itemKey: string) => string;

	/**
	 * Kubernetes namespace where CRDs will be created.
	 */
	namespace: pulumi.Input<string>;

	/**
	 * Pulumi provider for Kubernetes resources.
	 */
	provider: pulumi.ProviderResource;

	/**
	 * Optional resources that must exist before the CRDs are created.
	 */
	dependsOn?: pulumi.Input<pulumi.Resource>[];

	/**
	 * Optional guard to block op:// for certain item types.
	 * Throws an error if the guard returns a message.
	 */
	blockRef?: (
		item: T,
		itemKey: string,
		opRef: string,
	) => string | undefined;
}

/**
 * Create OnePasswordItem CRDs for op:// references and return a secret-ref
 * env var map.
 *
 * This function:
 * 1. Iterates through items
 * 2. Checks the selected field for op:// prefix
 * 3. Creates OnePasswordItem CRDs for detected references
 * 4. Returns a map of env var names → secret names/keys
 *
 * Use with `requireMixedConfig`'s secret fields: override the original field
 * values in the items map with `os.environ/${envVarName}` refs.
 *
 * @example
 * ```typescript
 * const providerSecretRefs = createOnePasswordSecretRefs({
 *   config,
 *   configKey: "backendAccounts",
 *   items: directBackendAccounts,
 *   keySelector: (item, key) => {
 *     const rawApiKey = config.get(`backendAccounts.${key}.apiKey`);
 *     return rawApiKey?.startsWith("op://") ? rawApiKey : undefined;
 *   },
 *   envVarNaming: (key) => key.toUpperCase().replace(/-/g, "_").concat("_API_KEY"),
 *   namespace: litellmNamespace.metadata.name,
 *   provider,
 *   blockRef: (item) => item.provider === "zai"
 *     ? `Backend account '${key}' (provider: zai) cannot use op://...`
 *     : undefined,
 * });
 *
 * // Override account API keys
 * for (const [envVarName, { secretName, key }] of Object.entries(providerSecretRefs)) {
 *   const accountKey = envVarName.slice(0, -"_API_KEY".length).toLowerCase().replace(/_/g, "-");
 *   directBackendAccounts[accountKey].apiKey = `os.environ/${envVarName}`;
 * }
 * ```
 */
export function createOnePasswordSecretRefs<T extends Record<string, unknown>>(
	options: CreateOnePasswordSecretRefsOptions<T>,
): Record<string, { secretName: pulumi.Input<string>; key: pulumi.Input<string> }> {
	const {
		config,
		configKey,
		items,
		keySelector,
		envVarNaming,
		namespace,
		provider,
		dependsOn = [],
		blockRef,
	} = options;

	const secretRefs: Record<
		string,
		{ secretName: pulumi.Input<string>; key: pulumi.Input<string> }
	> = {};

	for (const [itemKey, item] of Object.entries(items)) {
		const opRef = keySelector(item, itemKey);
		if (!opRef) continue;

		// Check guard
		const blockMessage = blockRef?.(item, itemKey, opRef);
		if (blockMessage) {
			throw new Error(blockMessage);
		}

		const { itemPath, fieldName } = parseOnePasswordItemReference(
			opRef,
			itemKey,
		);
		// Kubernetes metadata.name must be DNS-1123 compliant: lowercase
		// alphanumeric or hyphens, must start/end with alphanumeric.
		const secretName = toDNS1123Name(`${configKey}-${itemKey}-api-key`);
		const envVarName = envVarNaming(itemKey);

		// Detect env var name collisions — two item keys that produce the same
		// env var name would silently overwrite each other in the output map.
		if (envVarName in secretRefs) {
			throw new Error(
				`Environment variable name collision: two items produced env var '${envVarName}'. ` +
					`Ensure envVarNaming produces unique names for each item key.`,
			);
		}

		// Create the CRD
		new k8s.apiextensions.CustomResource(
			`${configKey}-${itemKey}-onepassword-item`,
			{
				apiVersion: "onepassword.com/v1",
				kind: "OnePasswordItem",
				metadata: {
					name: secretName,
					namespace,
				},
				spec: { itemPath },
			},
			{ provider, dependsOn },
		);

		secretRefs[envVarName] = { secretName, key: fieldName };
	}

	return secretRefs;
}

/**
 * Convert a string to a DNS-1123 compliant name suitable for Kubernetes
 * metadata.name fields. Lowercases, replaces unsupported characters with
 * hyphens, collapses consecutive hyphens, and trims leading/trailing hyphens.
 */
function toDNS1123Name(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}