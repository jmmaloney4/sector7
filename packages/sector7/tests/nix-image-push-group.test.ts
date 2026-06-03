import type * as pulumi from "@pulumi/pulumi";
import { describe, expect, it } from "vitest";
import { NixImagePushGroup } from "../nix-image/push-group";

/**
 * The group only stores and returns resource references, so plain sentinels
 * standing in for `pulumi.Resource` are sufficient to exercise its logic.
 */
function fakeResource(label: string): pulumi.Resource {
	return { __label: label } as unknown as pulumi.Resource;
}

describe("NixImagePushGroup", () => {
	it("has no dependencies before anything is registered", () => {
		const group = new NixImagePushGroup();
		expect(group.dependencies()).toEqual([]);
	});

	it("serial strategy chains each push onto the previous one", () => {
		const group = new NixImagePushGroup({ strategy: "serial" });
		const a = fakeResource("a");
		const b = fakeResource("b");
		const c = fakeResource("c");

		// First push waits for nothing, then becomes the dependency.
		expect(group.dependencies()).toEqual([]);
		group.register(a);
		expect(group.dependencies()).toEqual([a]);

		// Second waits for the first, then supersedes it.
		group.register(b);
		expect(group.dependencies()).toEqual([b]);

		// Third waits for the second.
		group.register(c);
		expect(group.dependencies()).toEqual([c]);
	});

	it("defaults to the serial strategy", () => {
		const group = new NixImagePushGroup();
		const a = fakeResource("a");
		const b = fakeResource("b");
		group.register(a);
		group.register(b);
		// Serial: latest registered push is the next dependency.
		expect(group.dependencies()).toEqual([b]);
	});

	it("primer strategy makes every later push depend on the first", () => {
		const group = new NixImagePushGroup({ strategy: "primer" });
		const primer = fakeResource("primer");
		const second = fakeResource("second");
		const third = fakeResource("third");

		expect(group.dependencies()).toEqual([]);
		group.register(primer);
		expect(group.dependencies()).toEqual([primer]);

		// Later registrations do not move the dependency off the primer, so the
		// second and third pushes both wait only for the primer and thus run
		// concurrently with each other.
		group.register(second);
		expect(group.dependencies()).toEqual([primer]);
		group.register(third);
		expect(group.dependencies()).toEqual([primer]);
	});
});
