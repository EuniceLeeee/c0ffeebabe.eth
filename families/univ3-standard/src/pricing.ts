import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { v3SwapExactInput, type V3PoolState } from "./kernel/math.ts";
import { assertUniV3Route } from "./routes.ts";
import { assertDecimal, type UniV3IdentityV1, type UniV3MaterializedStateV1, type UniV3QuoteV1, type UniV3RouteV1 } from "./types.ts";

export type UniV3CoarseOutcomeV1 =
  | { readonly status: "rankable"; readonly quote: UniV3QuoteV1 }
  | { readonly status: "unavailable"; readonly reasonCode: "non-positive-amount" | "missing-state-fact" | "quote-error" };

function kernelState(state: UniV3MaterializedStateV1): V3PoolState {
  return { sqrtPriceX96: BigInt(state.sqrtPriceX96), tick: state.tick, liquidity: BigInt(state.liquidity), fee: BigInt(state.fee), tickSpacing: state.tickSpacing, tickBitmap: new Map(state.tickBitmap.map(word => [word.word, BigInt(word.bits)])), ticks: new Map(state.ticks.map(tick => [tick.tick, BigInt(tick.liquidityNet)])) };
}

function quote(identity: UniV3IdentityV1, state: UniV3MaterializedStateV1, route: UniV3RouteV1, amountIn: string): UniV3QuoteV1 {
  assertUniV3Route(route, identity);
  const amount = BigInt(assertDecimal(amountIn, "amountIn"));
  if (amount <= 0n) throw new RangeError("non-positive-amount");
  const amountOut = v3SwapExactInput(kernelState(state), route.zeroForOne, amount);
  if (amountOut <= 0n) throw new RangeError("quote-error");
  const payload = { cutoff: state.cutoff, routeBindingHash: route.routeBindingHash, amountIn: amount.toString(10), amountOut: amountOut.toString(10), stateHash: state.stateHash };
  return Object.freeze({ ...payload, quoteHash: hashDomain("aloha/univ3-standard/quote/v1", payload) });
}

export function coarseUniV3(input: { readonly identity: UniV3IdentityV1; readonly state: UniV3MaterializedStateV1; readonly route: UniV3RouteV1; readonly amountIn: string }): UniV3CoarseOutcomeV1 {
  try { return Object.freeze({ status: "rankable", quote: quote(input.identity, input.state, input.route, input.amountIn) }); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reasonCode = message === "non-positive-amount" ? "non-positive-amount" : message.includes("not available") ? "missing-state-fact" : "quote-error";
    return Object.freeze({ status: "unavailable", reasonCode });
  }
}

export function coarseUpperBound(quoteValue: UniV3QuoteV1): { readonly amountOut: string; readonly proofHash: Hash } {
  return Object.freeze({ amountOut: quoteValue.amountOut, proofHash: hashDomain("aloha/univ3-standard/coarse-upper-bound/v1", quoteValue) });
}
