import * as pulumi from "@pulumi/pulumi";

export type MockResource = {
	type: string;
	name: string;
	inputs: Record<string, unknown>;
};

export const resources: MockResource[] = [];

let mocksInstalled = false;

function mockServiceAccountEmail(accountId: string): string {
	return `${accountId}@mock-project.iam.gserviceaccount.com`;
}

export function installPulumiMocks(): void {
	if (mocksInstalled) {
		return;
	}

	pulumi.runtime.setMocks({
		newResource: (args) => {
			const state = { ...(args.inputs as Record<string, unknown>) };
			const typeToken = args.type.toLowerCase();

			if (args.type === "random:index/randomPassword:RandomPassword") {
				state.result =
					args.name === "personal-coding-key-secret"
						? "generated-api-key"
						: "generated-master-key";
			}

			if (args.type === "command:local:Command") {
				state.stdout = `${args.name}-stdout`;
			}

			if (typeToken.includes("serviceaccount/account")) {
				const accountId = String(state.accountId ?? args.name);
				const email = mockServiceAccountEmail(accountId);
				state.email = email;
				state.name = `projects/mock-project/serviceAccounts/${email}`;
			}

			if (typeToken.includes("serviceaccount/key")) {
				state.privateKey = Buffer.from(
					JSON.stringify({
						type: "service_account",
						client_email: "managed-proxy@mock-project.iam.gserviceaccount.com",
					}),
				).toString("base64");
			}

			resources.push({
				type: args.type,
				name: args.name,
				inputs: state,
			});
			return {
				id: `${args.name}-id`,
				state,
			};
		},
		call: (args) => args.inputs,
	});

	mocksInstalled = true;
}

export function resetMockResources(): void {
	resources.length = 0;
}

export function findResource(name: string): MockResource | undefined {
	return resources.find((resource) => resource.name === name);
}

export function resolveOutput<T>(value: pulumi.Input<T>): Promise<T> {
	return new Promise((resolve) => {
		pulumi.output(value).apply((resolved) => {
			resolve(resolved as T);
			return resolved;
		});
	});
}

export async function resolveRecord(
	value: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
	const resolved = await resolveOutput(value ?? {});
	if (
		resolved &&
		typeof resolved === "object" &&
		"value" in resolved &&
		typeof resolved.value === "object" &&
		resolved.value !== null
	) {
		return resolved.value as Record<string, unknown>;
	}
	return resolved;
}
