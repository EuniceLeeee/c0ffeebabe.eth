export type Erc4626SiloRedeemCoarseOutcomeV1 = { readonly status: "unavailable"; readonly reasonCode: "not-in-release" };
export function coarseErc4626SiloRedeem(): Erc4626SiloRedeemCoarseOutcomeV1 { return Object.freeze({ status: "unavailable", reasonCode: "not-in-release" }); }
