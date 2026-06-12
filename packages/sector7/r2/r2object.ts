import * as crypto from "node:crypto";
import * as path from "node:path";
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import {
	type ComponentResourceOptions,
	type CustomResourceOptions,
	dynamic,
	type Input,
	type Output,
	type Resource,
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

// ---------------------------------------------------------------------------
// AWS Signature Version 4 — minimal implementation for S3 PUT/DELETE only.
// Uses node:crypto (dynamically imported) and global fetch(). No external deps.
// See: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html
// ---------------------------------------------------------------------------

interface SigV4Credentials {
	accessKeyId: string;
	secretAccessKey: string;
}

/**
 * Derive the signing key for a given date/region/service.
 * HMAC chain: (secret) → dateKey → regionKey → serviceKey → signingKey
 */
const deriveSigningKey = async (
	nodeCrypto: typeof import("node:crypto"),
	secretAccessKey: string,
	dateStamp: string,
	region: string,
	service: string,
): Promise<Buffer> => {
	const hmac = (key: Buffer | string, data: string) =>
		nodeCrypto.createHmac("sha256", key).update(data).digest();
	const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
	const regionKey = hmac(dateKey, region);
	const serviceKey = hmac(regionKey, service);
	return hmac(serviceKey, "aws4_request");
};

/**
 * Build an AWS Sig V4 signed request and execute it via fetch().
 *
 * This is deliberately scoped to the two operations we need:
 *   - PUT    (upload object body)
 *   - DELETE (remove object)
 *
 * No query strings, no multipart, no chunked encoding.
 */
const signedFetch = async (
	method: "PUT" | "DELETE",
	url: string,
	creds: SigV4Credentials,
	body?: Buffer,
	contentType?: string,
): Promise<Response> => {
	const nodeCrypto = (await import(
		"node:crypto"
	)) as typeof import("node:crypto");

	const parsed = new URL(url);
	const host = parsed.host;
	const now = new Date();
	const amzDate = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
	const dateStamp = amzDate.slice(0, 8);
	const region = "auto";
	const service = "s3";

	// Payload hash
	const payloadHash = body
		? nodeCrypto.createHash("sha256").update(body).digest("hex")
		: nodeCrypto.createHash("sha256").update("").digest("hex");

	// Canonical headers — must be sorted by lowercase name.
	// Only include content-type when it has a value so the signed
	// headers match the actual fetch headers exactly.
	const headers: Record<string, string> = {
		host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
	};
	if (contentType) {
		headers["content-type"] = contentType;
	}

	const signedHeaderNames = Object.keys(headers).sort().join(";");
	const canonicalHeaders =
		Object.keys(headers)
			.sort()
			.map((k) => `${k}:${headers[k].trim()}`)
			.join("\n") + "\n";

	// Canonical request
	const canonicalQueryString = "";
	const canonicalRequest = [
		method,
		parsed.pathname,
		canonicalQueryString,
		canonicalHeaders,
		signedHeaderNames,
		payloadHash,
	].join("\n");

	// String to sign
	const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		nodeCrypto.createHash("sha256").update(canonicalRequest).digest("hex"),
	].join("\n");

	// Sign
	const signingKey = await deriveSigningKey(
		nodeCrypto,
		creds.secretAccessKey,
		dateStamp,
		region,
		service,
	);
	const signature = nodeCrypto
		.createHmac("sha256", signingKey)
		.update(stringToSign)
		.digest("hex");

	const authorization =
		`AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
		`SignedHeaders=${signedHeaderNames}, Signature=${signature}`;

	// Build fetch headers (must match canonical exactly)
	const fetchHeaders: Record<string, string> = {
		Authorization: authorization,
		Host: host,
		"X-Amz-Content-Sha256": payloadHash,
		"X-Amz-Date": amzDate,
	};
	if (contentType) {
		fetchHeaders["Content-Type"] = contentType;
	}

	return fetch(parsed.href, {
		method,
		headers: fetchHeaders,
		body: body ? new Uint8Array(body) : undefined,
	});
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single static file to upload to R2 as a Pulumi-managed resource.
 */
export interface AssetFile {
	/**
	 * Absolute path to the local file on disk.
	 */
	filePath: Input<string>;

	/**
	 * R2 object key (e.g., "index.html", "styles/main.css").
	 * Must be a static string known at construction time — Pulumi resource
	 * names cannot incorporate Output values.
	 */
	key: string;

	/**
	 * MIME content type (e.g., "text/html; charset=utf-8").
	 */
	contentType: Input<string>;
}

/**
 * Static-site file descriptor for `uploadStaticAssets`.
 */
export type StaticAssetFile =
	| {
			/** R2 object key and, by default, the path below `basePath`. */
			key: string;
			/** Optional path below `basePath` when it differs from `key`. */
			fileName?: string;
			/** MIME content type (e.g. "text/html; charset=utf-8"). */
			contentType: Input<string>;
	  }
	| {
			/**
			 * Existing static-site file name. Used as the R2 object key and, by
			 * default, the path below `basePath`.
			 */
			name: string;
			/** Optional path below `basePath` when it differs from `name`. */
			fileName?: string;
			/** MIME content type (e.g. "text/html; charset=utf-8"). */
			contentType: Input<string>;
	  };

/**
 * Configuration for declarative R2 asset uploads.
 *
 * When provided, `uploadAssets` creates a scoped R2 API token and uploads each
 * listed file as a separate Pulumi dynamic resource.  Content changes are
 * detected via MD5 comparison against the stored ETag — no external binary
 * required.
 *
 * Notes
 * -----
 * The generated AccountToken is scoped to R2_BUCKET_ITEM_WRITE on the specific
 * bucket only.  Credentials are derived per Cloudflare's spec:
 *   accessKeyId     = token.id
 *   secretAccessKey = SHA-256(token.value)
 */
export interface AssetConfig {
	/**
	 * Files to upload.  Each file becomes a separate Pulumi R2Object resource.
	 */
	files: AssetFile[];
}

/**
 * Inputs accepted at the call site.  Pulumi resolves all `Input<T>` values
 * before passing them to the dynamic provider, so secrets (which are
 * `Output<string>`) are valid here.
 *
 * Authentication uses an R2-specific API token pair derived from a
 * Cloudflare AccountToken: accessKeyId = token.id, secretAccessKey =
 * SHA-256(token.value).
 */
export interface R2ObjectInputs {
	/** Cloudflare account ID that owns the R2 bucket. */
	accountId: Input<string>;
	/** Name of the R2 bucket. */
	bucketName: Input<string>;
	/** Object key within the bucket (e.g. "index.html"). */
	key: Input<string>;
	/** Absolute path to the local file to upload. */
	filePath: Input<string>;
	/** MIME type for the Content-Type header (e.g. "text/html; charset=utf-8"). */
	contentType: Input<string>;
	/** R2 API token access key ID (= AccountToken.id). Store as a Pulumi secret. */
	accessKeyId: Input<string>;
	/** R2 API token secret access key (= SHA-256 of AccountToken.value). Store as a Pulumi secret. */
	secretAccessKey: Input<string>;
}

/**
 * Arguments for `uploadAssets`.
 */
export interface UploadAssetsArgs {
	/** Cloudflare account ID. */
	accountId: Input<string>;
	/** Name of the R2 bucket to upload to. */
	bucketName: Input<string>;
	/** Files to upload. */
	files: AssetFile[];
	/** Resource dependencies (e.g. the Worker and bucket). */
	dependsOn?: Input<Input<Resource>[]>;
}

/**
 * Arguments for `uploadStaticAssets`.
 */
export interface UploadStaticAssetsArgs {
	/** Cloudflare account ID. */
	accountId: Input<string>;
	/** Name of the R2 bucket to upload to. */
	bucketName: Input<string>;
	/** Directory containing the static-site files. */
	basePath: string;
	/** Files to upload from `basePath`. */
	files: StaticAssetFile[];
	/** Resource dependencies (e.g. the Worker and bucket). */
	dependsOn?: Input<Input<Resource>[]>;
}

/**
 * Resolved inputs as seen inside the dynamic provider callbacks.
 * All values are plain strings — Pulumi resolves Input<T> before invoking the provider.
 */
interface R2ObjectArgs {
	accountId: string;
	bucketName: string;
	key: string;
	filePath: string;
	contentType: string;
	accessKeyId: string;
	secretAccessKey: string;
}

/** State persisted in Pulumi for each R2Object resource. */
interface R2ObjectState extends R2ObjectArgs {
	/**
	 * MD5 hex digest of the uploaded file content (matches the S3/R2 ETag format).
	 * Stored in state and compared on the next `diff` call to detect content changes.
	 */
	etag: string;
}

const rejectCloudProviderOptions = (
	resourceName: string,
	opts?: CustomResourceOptions,
): void => {
	if (!opts) return;

	const hasProvider =
		Object.hasOwn(opts, "provider") && opts.provider !== undefined;
	// `providers` is not on CustomResourceOptions but may be present at runtime
	// if a ComponentResourceOptions was passed (JS doesn't enforce nominal types).
	const hasProviders =
		Object.hasOwn(opts, "providers") &&
		(opts as Record<string, unknown>).providers !== undefined;
	if (!hasProvider && !hasProviders) return;

	throw new Error(
		`${resourceName} is a Pulumi dynamic resource; do not pass provider/providers. ` +
			"Pass provider options only to cloud provider resources, and use parent/dependsOn for dynamic resource ordering.",
	);
};

const omitCloudProviderOptions = (
	opts?: CustomResourceOptions,
): DynamicResourceOptions | undefined => {
	if (!opts) return undefined;
	// Cast to pick both `provider` (on CustomResourceOptions) and `providers`
	// (may be present at runtime from ComponentResourceOptions).
	const {
		provider: _provider,
		providers: _providers,
		...dynamicOpts
	} = opts as CustomResourceOptions & {
		providers?: unknown;
	};
	return dynamicOpts;
};

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

const tryStatFileSync = (
	fs: typeof import("node:fs"),
	filePath: string,
): boolean => {
	try {
		return fs.statSync(filePath).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
};

const tryReadFileSync = (
	fs: typeof import("node:fs"),
	filePath: string,
): Buffer | undefined => {
	try {
		return fs.readFileSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
};

// ---------------------------------------------------------------------------
// R2 operations via native S3 signing (no AWS SDK)
// ---------------------------------------------------------------------------

// RFC 3986 strict encoding: encodeURIComponent plus the characters
// AWS Sig V4 requires for path segments but encodeURIComponent skips.
// These characters are: ! ' ( ) *
const rfc3986Encode = (s: string): string =>
	encodeURIComponent(s).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);

/** Upload a file to R2 and return the normalized ETag. */
const uploadObjectToR2 = async (args: R2ObjectArgs): Promise<string> => {
	const fs = (await import("node:fs")) as typeof import("node:fs");
	const nodeCrypto = (await import(
		"node:crypto"
	)) as typeof import("node:crypto");

	const {
		accountId,
		bucketName,
		key,
		filePath,
		contentType,
		accessKeyId,
		secretAccessKey,
	} = args;
	const body = fs.readFileSync(filePath);
	const url = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${key.split("/").map(rfc3986Encode).join("/")}`;

	const response = await signedFetch(
		"PUT",
		url,
		{ accessKeyId, secretAccessKey },
		body,
		contentType,
	);

	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`R2 PUT ${key} failed: ${response.status} ${response.statusText}\n${text}`,
		);
	}

	const etag = response.headers.get("ETag");
	return (
		etag ?? nodeCrypto.createHash("md5").update(body).digest("hex")
	).replace(/"/g, "");
};

/** Delete an object from R2. */
const deleteObjectFromR2 = async (args: {
	accountId: string;
	bucketName: string;
	key: string;
	accessKeyId: string;
	secretAccessKey: string;
}): Promise<void> => {
	const url = `https://${args.accountId}.r2.cloudflarestorage.com/${args.bucketName}/${args.key.split("/").map(rfc3986Encode).join("/")}`;
	const response = await signedFetch("DELETE", url, {
		accessKeyId: args.accessKeyId,
		secretAccessKey: args.secretAccessKey,
	});

	// R2 returns 204 on successful delete; tolerate 404 (already gone)
	if (response.status !== 204 && response.status !== 404) {
		const text = await response.text();
		throw new Error(
			`R2 DELETE ${args.key} failed: ${response.status} ${response.statusText}\n${text}`,
		);
	}
};

// ---------------------------------------------------------------------------
// Pulumi dynamic provider
// ---------------------------------------------------------------------------

/**
 * Pulumi dynamic resource provider that manages a single object in a
 * Cloudflare R2 bucket via the S3-compatible API.
 *
 * Notes
 * -----
 * Node built-in imports (fs, crypto) are inlined as dynamic import() calls
 * inside provider callbacks rather than imported at module top level.  Pulumi
 * serializes the provider object via V8 source capture; top-level ES module
 * imports of Node built-ins capture native-code functions that cannot be
 * serialized, causing a "Function code: function () { [native code] }" error.
 * Dynamic import() calls are emitted verbatim and evaluated at runtime after
 * deserialization.  See the Pulumi dynamic provider serialization docs:
 * https://www.pulumi.com/docs/concepts/resources/dynamic-providers/#how-dynamic-providers-are-serialized
 *
 * S3 requests are signed natively using AWS Signature Version 4 (node:crypto +
 * fetch) — no @aws-sdk/client-s3 dependency required (ADR-015).
 *
 * Lifecycle
 * ---------
 * - check  : verify the local file exists
 * - diff   : compare MD5(file) to stored etag; replace on key/bucket/account change
 * - create : PUT with body + content-type; store etag
 * - update : re-upload via PUT; store new etag
 * - delete : DELETE
 */
const r2ObjectProvider: dynamic.ResourceProvider = {
	async check(
		_olds: R2ObjectState,
		news: R2ObjectArgs,
	): Promise<dynamic.CheckResult> {
		const fs = (await import("node:fs")) as typeof import("node:fs");
		const failures: dynamic.CheckFailure[] = [];
		try {
			if (!tryStatFileSync(fs, news.filePath)) {
				failures.push({
					property: "filePath",
					reason: `file not found: ${news.filePath}`,
				});
			}
		} catch (error) {
			failures.push({
				property: "filePath",
				reason: `failed to stat file: ${news.filePath}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			});
		}
		return { inputs: news, failures };
	},

	async diff(
		_id: string,
		olds: R2ObjectState,
		news: R2ObjectArgs,
	): Promise<dynamic.DiffResult> {
		const fs = (await import("node:fs")) as typeof import("node:fs");
		const nodeCrypto = (await import(
			"node:crypto"
		)) as typeof import("node:crypto");

		const replaces: string[] = [];
		if (olds.key !== news.key) replaces.push("key");
		if (olds.bucketName !== news.bucketName) replaces.push("bucketName");
		if (olds.accountId !== news.accountId) replaces.push("accountId");
		if (olds.accessKeyId !== news.accessKeyId) replaces.push("accessKeyId");
		if (olds.secretAccessKey !== news.secretAccessKey)
			replaces.push("secretAccessKey");

		const currentFile = tryReadFileSync(fs, news.filePath);
		const currentEtag = currentFile
			? nodeCrypto.createHash("md5").update(currentFile).digest("hex")
			: // Missing files should force a change without crashing refresh/diff.
				"";
		const changed =
			replaces.length > 0 ||
			currentEtag !== olds.etag ||
			news.contentType !== olds.contentType;

		return { changes: changed, replaces, deleteBeforeReplace: true };
	},

	async create(inputs: R2ObjectArgs): Promise<dynamic.CreateResult> {
		const etag = await uploadObjectToR2(inputs);
		const { bucketName, key } = inputs;
		return { id: `${bucketName}/${key}`, outs: { ...inputs, etag } };
	},

	async update(
		_id: string,
		_olds: R2ObjectState,
		news: R2ObjectArgs,
	): Promise<dynamic.UpdateResult> {
		const etag = await uploadObjectToR2(news);
		return { outs: { ...news, etag } };
	},

	async delete(_id: string, props: R2ObjectState): Promise<void> {
		await deleteObjectFromR2(props);
	},
};

/**
 * A single object stored in a Cloudflare R2 bucket.
 *
 * Uses the S3-compatible API for all CRUD operations via native AWS Sig V4
 * signing (node:crypto + fetch).  Content changes are detected via MD5
 * comparison against the stored ETag — no external binary required.
 *
 * Parameters
 * ----------
 * name : str
 *     Pulumi resource name.
 * args : R2ObjectInputs
 *     Bucket coordinates, local file path, content-type, and R2 API credentials.
 * opts : pulumi.CustomResourceOptions, optional
 *     Standard Pulumi resource options.
 */
export class R2Object extends dynamic.Resource {
	/** ETag of the uploaded object as returned by R2 (MD5 hex, no quotes). */
	public declare readonly etag: Output<string>;

	constructor(
		name: string,
		args: R2ObjectInputs,
		opts?: DynamicResourceOptions,
	) {
		rejectCloudProviderOptions("R2Object", opts);
		super(r2ObjectProvider, name, { etag: undefined, ...args }, opts);
	}
}

// Cloudflare permission group ID for R2 bucket item write access.
// Used to scope the API token created for asset uploads.
const R2_BUCKET_ITEM_WRITE_PERMISSION_GROUP_ID =
	"2efd5506f9c8494dacb1fa10a3e7d5b6";

/**
 * Upload static assets to R2 as Pulumi-managed resources.
 *
 * Creates a scoped R2 API token and uploads each file as a separate
 * `R2Object` dynamic resource with MD5-based change detection.
 * Returns the created `R2Object` instances.
 *
 * This function lives on the `./r2` sub-path to isolate the R2 upload concern
 * from consumers that only need `WorkerSite` infrastructure (ADR-014).  No
 * external dependencies are required — S3 signing is implemented natively via
 * node:crypto + fetch (ADR-015).
 *
 * @param name - Pulumi resource name prefix.
 * @param args - Upload configuration (account, bucket, files).
 * @param opts - Pulumi component resource options (set `parent` to the WorkerSite).
 * @returns Array of created R2Object resources.
 */
export function uploadAssets(
	name: string,
	args: UploadAssetsArgs,
	opts?: ComponentResourceOptions,
): R2Object[] {
	// Use caller-provided opts as the base for Cloudflare resources, but do not
	// forward cloud-provider options into Pulumi dynamic resources.
	const tokenOpts = { ...opts };
	const dynamicOpts = omitCloudProviderOptions(opts);
	const r2ObjectOpts = {
		...dynamicOpts,
		dependsOn: pulumi
			.all([opts?.dependsOn ?? [], args.dependsOn ?? []])
			.apply(([optDep, argDep]) => {
				const optArr = Array.isArray(optDep) ? optDep : optDep ? [optDep] : [];
				const argArr = Array.isArray(argDep) ? argDep : argDep ? [argDep] : [];
				return [...optArr, ...argArr];
			}),
	};

	// Create a scoped R2 API token for uploads.
	const r2Token = new cloudflare.AccountToken(
		`${name}-r2-token`,
		{
			accountId: args.accountId,
			name: `${name}-r2-upload`,
			policies: [
				{
					effect: "allow",
					permissionGroups: [
						{
							id: R2_BUCKET_ITEM_WRITE_PERMISSION_GROUP_ID,
						},
					],
					resources: pulumi
						.output({
							accountId: args.accountId,
							bucketName: args.bucketName,
						})
						.apply(
							({
								accountId,
								bucketName,
							}: {
								accountId: string;
								bucketName: string;
							}) => {
								const key = `com.cloudflare.edge.r2.bucket.${accountId}_default_${bucketName}`;
								return JSON.stringify({ [key]: "*" });
							},
						),
				},
			],
		},
		tokenOpts,
	);

	const accessKeyId = r2Token.id;
	const secretAccessKey = r2Token.value.apply(async (v: string) => {
		// crypto is safe here — this runs in the Pulumi host process
		// (not inside a serialized dynamic provider closure).
		const nodeCrypto = (await import(
			"node:crypto"
		)) as typeof import("node:crypto");
		return nodeCrypto.createHash("sha256").update(v).digest("hex");
	});

	const assets: R2Object[] = [];
	for (let index = 0; index < args.files.length; index++) {
		const file = args.files[index];
		// Use a short SHA-256 hash of the key as the resource identifier.
		// This is stable across reorders (unlike array index) and unique
		// in practice for any realistic number of assets.
		const keyHash = crypto
			.createHash("sha256")
			.update(file.key)
			.digest("hex")
			.slice(0, 12);
		const safeKey = file.key.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 64);
		const r2obj = new R2Object(
			`${name}-asset-${keyHash}-${safeKey}`,
			{
				accountId: args.accountId,
				bucketName: args.bucketName,
				key: file.key,
				filePath: file.filePath,
				contentType: file.contentType,
				accessKeyId,
				secretAccessKey,
			},
			{
				...r2ObjectOpts,
			},
		);
		assets.push(r2obj);
	}

	return assets;
}

const joinStaticAssetPath = (basePath: string, fileName: string): string => {
	if (!basePath || basePath === "/") return fileName.replace(/^[\\/]+/, "");
	return path.join(basePath, fileName);
};

/**
 * Upload static-site assets from a common base directory.
 *
 * This is a convenience wrapper around `uploadAssets` for the common case where
 * R2 object keys map directly to files below a site output directory.
 */
export function uploadStaticAssets(
	name: string,
	args: UploadStaticAssetsArgs,
	opts?: ComponentResourceOptions,
): R2Object[] {
	return uploadAssets(
		name,
		{
			accountId: args.accountId,
			bucketName: args.bucketName,
			files: args.files.map((file) => {
				const key = "key" in file ? file.key : file.name;
				return {
					key,
					filePath: joinStaticAssetPath(args.basePath, file.fileName ?? key),
					contentType: file.contentType,
				};
			}),
			dependsOn: args.dependsOn,
		},
		opts,
	);
}

// ---------------------------------------------------------------------------
// Cloudflare zone cache purge
// ---------------------------------------------------------------------------

/**
 * Arguments for `purgeZoneCache`.
 */
export interface PurgeZoneCacheArgs {
	/** Cloudflare zone ID to purge. */
	zoneId: Input<string>;
	/**
	 * Cloudflare API token with Zone Cache Purge permission.
	 * Use the same token that manages the WorkerSite resources.
	 */
	apiToken: Input<string>;
	/**
	 * A value that changes on every deployment (e.g. asset hash, timestamp).
	 * Forces Pulumi to call `update` (and thus re-purge) even when zoneId
	 * and apiToken stay the same across deploys.
	 */
	trigger: Input<string>;
	/**
	 * Specific URLs to purge instead of purging the entire zone.
	 * Each entry must be a full URL (e.g. `https://dev.example.com/index.html`).
	 * When provided, sends `{"files": [...]}` to the Cloudflare API.
	 * Mutually exclusive with `hosts`.
	 */
	files?: Input<Input<string>[]>;
	/**
	 * Hostnames to purge instead of purging the entire zone.
	 * Each entry is a bare hostname (e.g. `"dev.example.com"`).
	 * When provided, sends `{"hosts": [...]}` to the Cloudflare API.
	 * This purges all cached resources for that hostname — ideal when
	 * multiple stacks share a single Cloudflare zone.
	 * Mutually exclusive with `files`.
	 */
	hosts?: Input<Input<string>[]>;
	/** Resource dependencies — purge runs after these complete. */
	dependsOn?: Input<Input<Resource>[]>;
}

/**
 * Normalized inputs stored in Pulumi state for ZoneCachePurge.
 */
interface ZoneCachePurgeInputs {
	zoneId: string;
	apiToken: string;
	trigger: string;
	files?: string[];
	hosts?: string[];
}

/**
 * Purge the Cloudflare edge cache for an entire zone (or specific URLs) after a deploy.
 *
 * Uses a Pulumi dynamic resource to call the Cloudflare Purge Cache API.
 * The `trigger` input changes on every deployment (e.g. a hash of uploaded
 * assets), so Pulumi detects a diff and calls `update` each time, ensuring
 * the cache is purged after every asset upload.
 *
 * The dynamic provider uses native `fetch()` — no external HTTP client
 * dependency required.
 */
const zoneCachePurgeProvider: dynamic.ResourceProvider = {
	async check(
		_olds: Record<string, unknown>,
		news: Record<string, unknown>,
	): Promise<dynamic.CheckResult> {
		const failures: dynamic.CheckFailure[] = [];
		for (const p of ["zoneId", "apiToken", "trigger"]) {
			if (typeof news[p] !== "string" || !news[p]) {
				failures.push({
					property: p,
					reason: p + " is required and must be a non-empty string",
				});
			}
		}
		// Validate files: accept non-empty string[] or undefined; reject non-array, non-string elements, or empty.
		// Cloudflare limits purge requests to 30 URLs.
		if (news.files !== undefined) {
			if (
				!Array.isArray(news.files) ||
				news.files.some((f: unknown) => typeof f !== "string" || !f)
			) {
				failures.push({
					property: "files",
					reason: "files must be an array of non-empty URL strings",
				});
			} else if (news.files.length === 0) {
				failures.push({
					property: "files",
					reason:
						"files must not be empty — omit the property to purge the entire zone",
				});
			} else if (news.files.length > 30) {
				failures.push({
					property: "files",
					reason: "files must not exceed 30 items (Cloudflare API limit)",
				});
			}
		}
		// Validate hosts: accept non-empty string[] or undefined; reject non-array, non-string elements, or empty.
		// Cloudflare limits purge requests to 30 hostnames.
		if (news.hosts !== undefined) {
			if (
				!Array.isArray(news.hosts) ||
				news.hosts.some((h: unknown) => typeof h !== "string" || !h)
			) {
				failures.push({
					property: "hosts",
					reason: "hosts must be an array of non-empty hostname strings",
				});
			} else if (news.hosts.length === 0) {
				failures.push({
					property: "hosts",
					reason:
						"hosts must not be empty — omit the property to purge the entire zone",
				});
			} else if (news.hosts.length > 30) {
				failures.push({
					property: "hosts",
					reason: "hosts must not exceed 30 items (Cloudflare API limit)",
				});
			}
		}
		// files and hosts are mutually exclusive.
		if (
			Array.isArray(news.files) &&
			news.files.length > 0 &&
			Array.isArray(news.hosts) &&
			news.hosts.length > 0
		) {
			failures.push({
				property: "files",
				reason: "files and hosts are mutually exclusive",
			});
		}
		return { inputs: news, failures };
	},

	async diff(
		_id: string,
		olds: Record<string, unknown>,
		news: Record<string, unknown>,
	): Promise<dynamic.DiffResult> {
		const replaces: string[] = [];
		if (olds.zoneId !== news.zoneId) replaces.push("zoneId");
		const filesChanged =
			JSON.stringify(
				[...((olds.files as string[] | undefined) ?? [])].sort(),
			) !==
			JSON.stringify([...((news.files as string[] | undefined) ?? [])].sort());
		const hostsChanged =
			JSON.stringify(
				[...((olds.hosts as string[] | undefined) ?? [])].sort(),
			) !==
			JSON.stringify([...((news.hosts as string[] | undefined) ?? [])].sort());
		return {
			replaces,
			changes:
				replaces.length > 0 ||
				olds.trigger !== news.trigger ||
				olds.apiToken !== news.apiToken ||
				filesChanged ||
				hostsChanged,
		};
	},

	async create(inputs: ZoneCachePurgeInputs): Promise<dynamic.CreateResult> {
		await purgeZoneCacheApi(
			inputs.zoneId,
			inputs.apiToken,
			inputs.files,
			inputs.hosts,
		);
		return {
			id: `purge-${inputs.zoneId}-${inputs.trigger.slice(0, 12)}`,
			outs: { ...inputs },
		};
	},

	async update(
		_id: string,
		_olds: Record<string, unknown>,
		news: ZoneCachePurgeInputs,
	): Promise<dynamic.UpdateResult> {
		await purgeZoneCacheApi(news.zoneId, news.apiToken, news.files, news.hosts);
		return { outs: { ...news } };
	},

	async delete(_id: string, _props: Record<string, unknown>): Promise<void> {
		// No-op: purging cache on resource deletion is unnecessary.
	},
};

async function purgeZoneCacheApi(
	zoneId: string,
	apiToken: string,
	files?: string[],
	hosts?: string[],
): Promise<void> {
	let body: Record<string, unknown>;
	if (hosts && hosts.length > 0) {
		body = { hosts };
	} else if (files && files.length > 0) {
		body = { files };
	} else {
		body = { purge_everything: true };
	}
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);

	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`Cloudflare cache purge failed for zone ${zoneId}: ${response.status} ${response.statusText}\n${text}`,
		);
	}
}

/**
 * A Pulumi dynamic resource that purges the Cloudflare zone cache.
 *
 * When `files` or `hosts` are provided, only the specified URLs or hostnames
 * are purged. Otherwise the entire zone cache is purged.
 * Triggers on create and update (whenever inputs change). Delete is a no-op
 * since there's nothing to undo — the cache will naturally repopulate.
 */
class ZoneCachePurge extends dynamic.Resource {
	constructor(
		name: string,
		args: PurgeZoneCacheArgs,
		opts?: DynamicResourceOptions,
	) {
		rejectCloudProviderOptions("purgeZoneCache", opts);
		// Merge dependsOn from both args and opts so caller-provided
		// dependencies aren't silently dropped.
		const mergedOpts = pulumi.mergeOptions(opts ?? {}, {
			dependsOn: args.dependsOn,
		});

		super(
			zoneCachePurgeProvider,
			name,
			{
				zoneId: args.zoneId,
				apiToken: args.apiToken,
				trigger: args.trigger,
				files: args.files,
				hosts: args.hosts,
			},
			mergedOpts,
		);
	}
}

/**
 * Purge the Cloudflare zone cache as a Pulumi-managed resource.
 *
 * Place this after `uploadAssets` (or any R2 asset upload) to
 * ensure newly deployed content is immediately visible at the edge.
 * The purge runs as a dynamic resource, so it executes during
 * `pulumi up` and is tracked in state.
 *
 * @param name - Pulumi resource name.
 * @param args - Zone cache purge configuration.
 * @param opts - Pulumi custom resource options. Do not pass provider/providers;
 *   this is a Node.js dynamic resource, not a Cloudflare provider resource.
 */
export function purgeZoneCache(
	name: string,
	args: PurgeZoneCacheArgs,
	opts?: DynamicResourceOptions,
): ZoneCachePurge {
	return new ZoneCachePurge(name, args, opts);
}
