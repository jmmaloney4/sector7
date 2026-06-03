// Gateway helpers live on the ./gateway sub-path, not in the main barrel, so
// their @pulumi/kubernetes type closure stays out of the root barrel for
// consumers that do not need it. This guard asserts that exclusion: the main
// barrel (./index.ts) must not surface a `gateway` namespace.
//
// Referencing the (absent) `gateway` member of the barrel is expected to error,
// which the @ts-expect-error below suppresses. If someone adds
// `export * as gateway from "./gateway/index.ts"` to index.ts, the reference
// type-checks, the directive becomes unused, and tsc fails — flagging the
// boundary violation. (This file is excluded from the build via
// tsconfig.build.json and only type-checked by the default tsconfig, so the
// import is never emitted.)
import * as barrel from "./index.ts";

// @ts-expect-error — gateway must stay on the ./gateway sub-path, not the main barrel
export const _gatewayNotInBarrel = barrel.gateway;
