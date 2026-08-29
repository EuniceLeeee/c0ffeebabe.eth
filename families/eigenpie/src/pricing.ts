export type EigenpieCoarseOutcomeV1 = { readonly status: "unavailable"; readonly reasonCode: "not-in-release" };
export function coarseEigenpie(): EigenpieCoarseOutcomeV1 { return Object.freeze({ status: "unavailable", reasonCode: "not-in-release" }); }
