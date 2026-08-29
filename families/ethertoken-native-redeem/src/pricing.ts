export type EtherTokenNativeRedeemCoarseOutcomeV1 = { readonly status: "unavailable"; readonly reasonCode: "not-in-release" };
export function coarseEtherTokenNativeRedeem(): EtherTokenNativeRedeemCoarseOutcomeV1 { return Object.freeze({ status: "unavailable", reasonCode: "not-in-release" }); }
