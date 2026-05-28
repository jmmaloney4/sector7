import type * as pulumi from "@pulumi/pulumi";

export type SecretFieldsOf<
	T extends Record<string, unknown>,
	S extends readonly (keyof T)[],
> = Omit<T, S[number]> & {
	[K in S[number]]: pulumi.Output<NonNullable<T[K]>>;
};

export interface ArrayConfigOptions<
	T extends Record<string, unknown>,
	S extends readonly (keyof T)[],
> {
	shape?: "array";
	secretFields: S;
}

export interface RecordConfigOptions<
	T extends Record<string, unknown>,
	K extends Extract<keyof T, string>,
	S extends readonly (keyof T)[],
> {
	shape: "record";
	keyField: K;
	secretFields: S;
}

export interface MapConfigOptions<
	T extends Record<string, unknown>,
	S extends readonly (keyof T)[],
> {
	shape: "map";
	secretFields: S;
}

export interface FlatSecretsOptions {
	shape: "flatSecrets";
}

export function requireMixedConfig<
	T extends Record<string, unknown>,
	S extends readonly (keyof T)[],
>(
	config: pulumi.Config,
	key: string,
	options: ArrayConfigOptions<T, S>,
): SecretFieldsOf<T, S>[];

export function requireMixedConfig<
	T extends Record<string, unknown>,
	K extends Extract<keyof T, string>,
	S extends readonly (keyof T)[],
>(
	config: pulumi.Config,
	key: string,
	options: RecordConfigOptions<T, K, S>,
): Record<string & {}, SecretFieldsOf<T, S>>;

export function requireMixedConfig<
	T extends Record<string, unknown>,
	S extends readonly (keyof T)[],
>(
	config: pulumi.Config,
	key: string,
	options: MapConfigOptions<T, S>,
): Record<string, SecretFieldsOf<T, S>>;

export function requireMixedConfig(
	config: pulumi.Config,
	key: string,
	options: FlatSecretsOptions,
): Record<string, pulumi.Output<string>>;

export function requireMixedConfig(
	config: pulumi.Config,
	key: string,
	options:
		| ArrayConfigOptions<
				Record<string, unknown>,
				readonly (keyof Record<string, unknown>)[]
		  >
		| RecordConfigOptions<
				Record<string, unknown>,
				Extract<keyof Record<string, unknown>, string>,
				readonly (keyof Record<string, unknown>)[]
		  >
		| MapConfigOptions<
				Record<string, unknown>,
				readonly (keyof Record<string, unknown>)[]
		  >
		| FlatSecretsOptions,
):
	| Array<Record<string, unknown>>
	| Record<string, Record<string, unknown>>
	| Record<string, pulumi.Output<string>> {
	const shape = options.shape ?? "array";
	const secretFields = "secretFields" in options ? options.secretFields : [];

	switch (shape) {
		case "array": {
			const items = config.requireObject<Record<string, unknown>[]>(key);
			return items.map((item, i) => {
				const result: Record<string, unknown> = { ...item };
				for (const field of secretFields) {
					result[field] = config.requireSecret(`${key}[${i}].${field}`);
				}
				return result;
			});
		}

		case "record": {
			const keyField = (options as { keyField: string }).keyField;
			const items = config.requireObject<Record<string, unknown>[]>(key);
			const map: Record<string, Record<string, unknown>> = {};
			items.forEach((item, i) => {
				const keyValue = String(item[keyField]);
				const result: Record<string, unknown> = { ...item };
				for (const field of secretFields) {
					result[field] = config.requireSecret(`${key}[${i}].${field}`);
				}
				map[keyValue] = result;
			});
			return map;
		}

		case "map": {
			const items =
				config.requireObject<Record<string, Record<string, unknown>>>(key);
			const map: Record<string, Record<string, unknown>> = {};
			for (const [mapKey, item] of Object.entries(items)) {
				const result: Record<string, unknown> = { ...item };
				for (const field of secretFields) {
					result[field] = config.requireSecret(`${key}.${mapKey}.${field}`);
				}
				map[mapKey] = result;
			}
			return map;
		}

		case "flatSecrets": {
			const keys = config.requireObject<Record<string, string>>(key);
			const result: Record<string, pulumi.Output<string>> = {};
			for (const k of Object.keys(keys)) {
				result[k] = config.requireSecret(`${key}.${k}`);
			}
			return result;
		}

		default:
			throw new Error(`requireMixedConfig: unknown shape "${shape}"`);
	}
}
