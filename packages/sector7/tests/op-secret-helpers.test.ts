import { describe, expect, it } from "vitest";
import {
	mergeSecretRefEnvs,
	parseOnePasswordItemReference,
} from "../pulumi-config/op-secret-helpers.js";

describe("parseOnePasswordItemReference", () => {
	it("parses a standard 3-segment op:// reference", () => {
		const result = parseOnePasswordItemReference(
			"op://v1/i2/f3",
			"test-account",
		);
		expect(result).toEqual({
			itemPath: "vaults/v1/items/i2",
			fieldName: "f3",
		});
	});

	it("rejects section-qualified op:// references", () => {
		expect(() =>
			parseOnePasswordItemReference("op://v1/i2/section/f4", "test-account"),
		).toThrow("Section-qualified references are not supported");
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

	it("throws for too many segments (> 4)", () => {
		expect(() =>
			parseOnePasswordItemReference("op://v1/i2/a/b/c", "test-account"),
		).toThrow("Invalid 1Password reference");
	});

	it("rejects empty path segments caused by consecutive slashes", () => {
		expect(() =>
			parseOnePasswordItemReference("op://v1//f3", "test-account"),
		).toThrow("empty path segment");
		expect(() =>
			parseOnePasswordItemReference("op://v1/i2//f3", "test-account"),
		).toThrow("empty path segment");
	});

	it("strips query parameters from the field name", () => {
		const result = parseOnePasswordItemReference(
			"op://v1/i2/f3?attribute=otp",
			"test-account",
		);
		expect(result).toEqual({
			itemPath: "vaults/v1/items/i2",
			fieldName: "f3",
		});
	});

	it("strips ssh-format query parameters", () => {
		const result = parseOnePasswordItemReference(
			"op://Private/ssh-key/private-key?ssh-format=openssh",
			"test-account",
		);
		expect(result).toEqual({
			itemPath: "vaults/Private/items/ssh-key",
			fieldName: "private-key",
		});
	});

	it("normalizes whitespace in field name to match operator behavior", () => {
		// The 1Password operator replaces spaces in field labels with hyphens
		// when creating K8s Secret keys. Our parser must match.
		const result = parseOnePasswordItemReference(
			"op://Private/ssh-keys/private key",
			"test-account",
		);
		expect(result).toEqual({
			itemPath: "vaults/Private/items/ssh-keys",
			fieldName: "private-key",
		});
	});

	it("rejects non-op:// prefix", () => {
		expect(() =>
			parseOnePasswordItemReference("https://vault/item/field", "test-account"),
		).toThrow('Expected value to start with "op://"');
	});

	it("rejects field names that normalize to an empty secret key", () => {
		expect(() =>
			parseOnePasswordItemReference("op://vault/item/!!!", "test-account"),
		).toThrow("Field name normalizes to an empty Kubernetes Secret key");
	});

	it("handles UUID-style IDs correctly", () => {
		const result = parseOnePasswordItemReference(
			"op://550e8400-e29b-41d4-a716-446655440000/550e8400-e29b-41d4-a716-446655440001/credential",
			"test-account",
		);
		expect(result).toEqual({
			itemPath:
				"vaults/550e8400-e29b-41d4-a716-446655440000/items/550e8400-e29b-41d4-a716-446655440001",
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

	it("throws on duplicate env var names across maps", () => {
		expect(() =>
			mergeSecretRefEnvs(
				{ DUP_KEY: { secretName: "s1", key: "k1" } },
				{ DUP_KEY: { secretName: "s2", key: "k2" } },
			),
		).toThrow("Duplicate secret-ref env var");
	});
});
