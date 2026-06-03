import type * as pulumi from "@pulumi/pulumi";

/**
 * Strategy controlling how a {@link NixImagePushGroup} orders the pushes of the
 * images that belong to it.
 *
 * - `"serial"` (default): every push waits for the previously registered push
 *   in the group, so at most one push runs at a time. Correct regardless of
 *   which layers the images actually share — the shared base blob is uploaded
 *   by whichever push runs first, and every later push finds it already present
 *   in the registry and skips re-uploading it.
 * - `"primer"`: only the *first* push in the group runs alone; every later push
 *   waits for that first ("primer") push and then runs concurrently with its
 *   peers. Optimal when every image sits on the same base layer: the primer
 *   uploads the shared base once, and the rest skip it and upload only their
 *   unique top layers in parallel. Assumes the first image carries the shared
 *   base; if it does not, the remaining pushes can still race on a base the
 *   primer never uploaded, so prefer `"serial"` for heterogeneous groups.
 */
export type NixImagePushStrategy = "serial" | "primer";

export interface NixImagePushGroupArgs {
	/** Ordering strategy for the group. Defaults to `"serial"`. */
	strategy?: NixImagePushStrategy;
}

/**
 * Coordinates the push phase of multiple {@link NixImage} builds so they do not
 * upload a shared layer concurrently.
 *
 * Images built from the same repository routinely share a large base layer
 * (e.g. the nix runtime closure) but differ only in a small top layer. When
 * Pulumi pushes those images concurrently, each push races to upload the same
 * base blob: the registry's per-blob existence check (`HEAD .../blobs/<digest>`)
 * returns 404 for all of them before any has finished, so the identical base is
 * uploaded several times over. Serializing — or priming — the pushes lets the
 * first upload populate the blob so the rest skip it.
 *
 * A group is a plain in-memory coordinator: it records the push commands as
 * they are constructed and hands each new push the resources it should depend
 * on. It carries no Pulumi state of its own and never affects correctness —
 * push order is irrelevant to the result, so the worst case of mis-grouping is
 * extra (or insufficient) serialization, never a broken deployment.
 *
 * Consumers rarely construct this directly: a {@link NixImage} with no explicit
 * `pushGroup` joins an internal default group keyed on its `artifactRegistryUrl`
 * (see {@link NixImage}). Construct one explicitly to widen, narrow, or
 * re-strategize that coordination — for example to opt into `"primer"` for a
 * set of images known to share a base:
 *
 * ```ts
 * const group = new NixImagePushGroup({ strategy: "primer" });
 * new NixImage("api", { ...args, pushGroup: group });
 * new NixImage("worker", { ...args, pushGroup: group });
 * ```
 */
export class NixImagePushGroup {
	private readonly strategy: NixImagePushStrategy;
	private primer: pulumi.Resource | undefined;
	private previous: pulumi.Resource | undefined;

	constructor(args: NixImagePushGroupArgs = {}) {
		this.strategy = args.strategy ?? "serial";
	}

	/**
	 * Resources the next push should depend on. Call this *before* constructing
	 * the push command and pass the result into the command's `dependsOn`.
	 *
	 * Returns an empty array for the first push in the group (it has nothing to
	 * wait for). For `"serial"` it returns the most recently registered push;
	 * for `"primer"` it returns the first push registered in the group.
	 */
	dependencies(): pulumi.Resource[] {
		if (this.strategy === "primer") {
			return this.primer ? [this.primer] : [];
		}
		return this.previous ? [this.previous] : [];
	}

	/**
	 * Record a freshly-constructed push command as the most recent member of
	 * the group (and as the primer if it is the first). Call this *after*
	 * constructing the push command.
	 */
	register(push: pulumi.Resource): void {
		if (this.primer === undefined) {
			this.primer = push;
		}
		this.previous = push;
	}
}
