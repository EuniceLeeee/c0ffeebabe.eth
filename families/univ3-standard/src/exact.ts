import { type UniV3IdentityV1, type UniV3MaterializedStateV1, type UniV3QuoteV1, type UniV3RouteV1 } from "./types.ts";
import { coarseUniV3 } from "./pricing.ts";

export type UniV3ExactOutcomeV1 =
  | { readonly status: "verified"; readonly quote: UniV3QuoteV1 }
  | { readonly status: "chain-proven-rejected"; readonly reasonCode: "zero-output" }
  | { readonly status: "unavailable"; readonly reasonCode: "quote-error" | "missing-state-fact" };

export function exactUniV3(input: { readonly identity: UniV3IdentityV1; readonly state: UniV3MaterializedStateV1; readonly route: UniV3RouteV1; readonly amountIn: string }): UniV3ExactOutcomeV1 {
  const result = coarseUniV3(input);
  if (result.status === "unavailable") return Object.freeze({ status: "unavailable", reasonCode: result.reasonCode === "non-positive-amount" ? "quote-error" : result.reasonCode });
  if (result.quote.amountOut === "0") return Object.freeze({ status: "chain-proven-rejected", reasonCode: "zero-output" });
  return Object.freeze({ status: "verified", quote: result.quote });
}
