// deploy-lib resolvers live on the ./deploy-lib sub-path, not in the main
// barrel, so their @pulumi/kubernetes type closure stays out of the root
// barrel for consumers that do not need it. This guard asserts that
// exclusion: the main barrel (./index.ts) must not surface a `deployLib`
// namespace or the `getK8sProvider` symbol.
//
// Referencing the (absent) members below is expected to error, which the
// ts-expect-error directives suppress. If someone re-exports them from
// index.ts, the references type-check, the directives become unused, and tsc
// fails — flagging the boundary violation. (This file is excluded from the
// build via tsconfig.build.json and only type-checked by the default
// tsconfig, so the import is never emitted.)
import * as barrel from "./index.ts";

// @ts-expect-error — deploy-lib must stay on the ./deploy-lib sub-path, not the main barrel
export const _deployLibNotInBarrel = barrel.deployLib;

// @ts-expect-error — getK8sProvider must stay on the ./deploy-lib sub-path, not the main barrel
export const _getK8sProviderNotInBarrel = barrel.getK8sProvider;
