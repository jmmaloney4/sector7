import * as pulumi from "@pulumi/pulumi";
import { type Input, type Output, secret } from "@pulumi/pulumi";
import { PLUGIN_VERSION } from "../version.ts";

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

/**
 * A website URL on the item. 1Password's browser extension matches autofill
 * candidates against these, so a LOGIN item without one never surfaces on the
 * site it belongs to.
 */
export interface OnePasswordItemUrlArgs {
	/**
	 * Full URL including scheme (`https://…`). A bare host is rejected at
	 * check time: it parses, but the extension will not match it, so the item
	 * would silently fail to autofill — the exact failure `urls` exists to
	 * prevent.
	 */
	href: Input<string>;
	/** Display name shown beside the URL (e.g. `tailnet`). */
	label?: Input<string>;
	/** Marks the URL used for "Open and fill". At most one may set it. */
	primary?: Input<boolean>;
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
	/**
	 * Website URLs for the item. Unlike `fields` these are replace-or-preserve
	 * rather than reconciled, and omitted is distinct from empty:
	 *
	 * - omitted — **preserve** whatever urls are on the item.
	 * - `[]` — **clear** the url list.
	 * - `[…]` — **replace** the url list.
	 *
	 * Preserve-on-omit rather than remove-on-omit because there is no
	 * `managedLabels` equivalent for urls to distinguish "I removed the url I
	 * used to manage" from "this resource never managed urls", and silently
	 * dropping a hand-added URL the first time an existing resource applies is
	 * the worse failure. Pass `[]` to explicitly remove them.
	 */
	urls?: OnePasswordItemUrlArgs[];
}

/**
 * A 1Password item, reconciled through a Connect server reached by an
 * in-cluster port-forward.
 *
 * Find-or-create by title: a pre-existing item with the same title in the same
 * vault is adopted rather than duplicated, and only the fields listed here are
 * managed — anything else on the item is left alone.
 *
 * Backed by the `sector7` resource plugin. This was previously a Pulumi
 * *dynamic* provider, which serialised its JavaScript closure into stack state
 * and re-executed that stored copy on refresh and delete (garden ADR 163). The
 * CRUD implementation now lives in `provider/onepassword/item.go` — which is
 * also why `provider`/`providers` are ordinary supported options here rather
 * than something to reject.
 *
 * Field VALUES are never written to state: only the labels this resource
 * manages (`managedLabels`) and a hash of the content (`contentHash`). That is
 * enforced plugin-side by `ItemState`, which deliberately does not carry
 * `fields`.
 */
export class OnePasswordItem extends pulumi.CustomResource {
	/** The created/adopted 1Password item id. */
	public declare readonly uuid: Output<string>;
	/** `vaults/<vault>/items/<uuid>` — the form `OnePasswordItem` CRs / `op read` consume. */
	public declare readonly itemPath: Output<string>;
	/** Hash of the written content; used to detect drift without storing values. */
	public declare readonly contentHash: Output<string>;

	constructor(
		name: string,
		args: OnePasswordItemArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		// Force every sensitive input to a secret so values are encrypted in
		// state even when the caller passes plain strings.
		//
		// Kept even though the plugin schema already marks these secret: this
		// covers the input side at construction, the schema covers the wire and
		// state side, and for a resource whose entire job is handling
		// credentials the redundancy is worth more than the brevity.
		const securedArgs = {
			...args,
			connectToken: secret(args.connectToken),
			...(args.kubeconfig !== undefined
				? { kubeconfig: secret(args.kubeconfig) }
				: {}),
			fields: args.fields.map((f) => ({ ...f, value: secret(f.value) })),
		};

		super(
			"sector7:onepassword:Item",
			name,
			{
				uuid: undefined,
				itemPath: undefined,
				contentHash: undefined,
				...securedArgs,
			},
			pulumi.mergeOptions(opts, {
				version: PLUGIN_VERSION,
				// What makes the move off the dynamic provider a no-op: the
				// engine rewrites the URN in place, so `pulumi preview` is a
				// complete, side-effect-free dry run and no Connect API call is
				// made during the cutover.
				//
				// Keep for at least two releases — it costs nothing and protects
				// any stack not yet through an `up`, plus state restored from a
				// backup taken before the retype.
				aliases: [{ type: "pulumi-nodejs:dynamic:Resource" }],
				additionalSecretOutputs: [
					"connectToken",
					"kubeconfig",
					// contentHash is a sha256 of the secret field values; encrypt
					// it so stack state can't be used as an offline oracle for
					// low-entropy secrets or to detect secret reuse across items.
					"contentHash",
					...(opts?.additionalSecretOutputs ?? []),
				],
			}),
		);
	}
}
