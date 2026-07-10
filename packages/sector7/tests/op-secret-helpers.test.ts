import { describe, expect, it } from "vitest";
import {
	mergeSecretRefEnvs,
	parseOnePasswordItemReference,
} from "../pulumi-config/op-secret-helpers.js";

describe("parseOnePasswordItemReference", () => {
	it("parses a standard 3-segment op:// reference", () => {
		const result = parseOnePasswordItemReference("op://v1/i2/f3", "test-account");
		expect(result).toEqual({
			itemPath: "vaults/v1/items/i2",
			fieldName: "f3",
		});
	});

	it("parses a 4-segment op:// reference with section", () => {
		const result = parseOnePasswordItemReference(
			"op://v1/i2/section/f4",
			"test-account",
		);
		expect(result).toEqual({
			itemPath: "vaults/v1/items/i2",
			fieldName: "f4",
		});
	});

	it("strips the op:// prefix correctly", () => {
		const result = parseOnePasswordItemReference(
			"op://abc-123/def-456/secret-token",
			"test-account",
		);
		expect(result).toEqual({
			itemPath: "vaults/abc-123/items/def-456",
			fieldName: "secret-token",
		});
	});

	it("throws for too few segments (< 3)", () => {
		expect(() =>
			parseOnePasswordItemReference("op://v1/i2", "test-account"),
		).toThrow("Invalid 1Password reference");
	});

	it("throws for empty op:// reference", () => {
		expect(() =>
			parseOnePasswordItemReference("op://", "test-account"),
		).toThrow("Invalid 1Password reference");
	});

	it("handles UUID-style IDs correctly", () => {
		const result = parseOnePasswordItemReference(
			"op://550e8400-e29b-41d4-a716-446655440000/550e8400-e29b-41d4-a716-446655440001/credential",
			"test-account",
		);
		expect(result).toEqual({
			itemPath: "vaults/550e8400-e29b-41d4-a716-446655440000/items/550e8400-e29b-41d4-a716-446655440001",
			fieldName: "credential",
		});
	});
});

describe("mergeSecretRefEnvs", () => {
	it("merges multiple secret ref maps", () => {
		const map1 = {
			API_KEY_1: { secretName: "secret-1", key: "password" },
		};
		const map2 = {
			API_KEY_2: { secretName: "secret-2", key: "token" },
		};
		const merged = mergeSecretRefEnvs(map1, map2);
		expect(merged).toEqual({
			API_KEY_1: { secretName: "secret-1", key: "password" },
			API_KEY_2: { secretName: "secret-2", key: "token" },
		});
	});

	it("filters out undefined maps", () => {
		const map1 = { KEY_1: { secretName: "s1", key: "k1" } };
		const merged = mergeSecretRefEnvs(map1, undefined, undefined);
		expect(merged).toEqual({ KEY_1: { secretName: "s1", key: "k1" } });
	});

	it("returns undefined when all maps are undefined", () => {
		const result = mergeSecretRefEnvs(undefined, undefined, undefined);
		expect(result).toBeUndefined();
	});

	it("returns undefined when all maps are empty", () => {
		const result = mergeSecretRefEnvs({}, {});
		expect(result).toBeUndefined();
	});

	it("returns undefined when the only map is empty", () => {
		const result = mergeSecretRefEnvs({});
		expect(result).toBeUndefined();
	});

	it("handles varargs (rest parameter)", () => {
		const maps: Array<Record<string, { secretName: string; key: string }>> = [
			{ K1: { secretName: "s1", key: "k1" } },
			{ K2: { secretName: "s2", key: "k2" } },
			{ K3: { secretName: "s3", key: "k3" } },
		];
		const merged = mergeSecretRefEnvs(...maps);
		expect(merged).toEqual({
			K1: { secretName: "s1", key: "k1" },
			K2: { secretName: "s2", key: "k2" },
			K3: { secretName: "s3", key: "k3" },
		});
	});
});