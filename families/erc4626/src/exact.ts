export type Erc4626ExactOutcomeV1 = { readonly status: "unavailable"; readonly reasonCode: "not-in-release" };
export function exactErc4626(): Erc4626ExactOutcomeV1 { return Object.freeze({ status: "unavailable", reasonCode: "not-in-release" }); }
