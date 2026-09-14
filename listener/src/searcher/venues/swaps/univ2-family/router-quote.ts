import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult } from "../../adapter-request-program.js";
import { decodeAddressResult, requireSuccessfulResult, sameAddress, UNIV2_FACTORY_INTERFACE } from "./codec.js";
import type { UniV2Descriptor, UniV2Route } from "./types.js";

export const UNIV2_QUOTE_ROUTER_INTERFACE = new ethers.Interface([
  "function factory() view returns (address)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
]);

// Quote infrastructure nominations, NOT instance admission. Every use verifies
// router.factory(), factory.getPair() and the quoted curve/fee at the same source.
// Other reverse-verified factories retain their existing Family quote path.
const ROUTER_CANDIDATES = new Map<string, string>([
  ["0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f", "0x7a250d5630b4cf539739df2c5dacb4c659f2488d"],
  ["0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac", "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f"],
  ["0x1097053fd2ea711dad45caccc45eff7548fcb362", "0xeff92a263d31888d860bd50809a8d171709b7b1c"],
]);

export const ROUTER_QUOTE_REQUEST_IDS = Object.freeze([
  "exact-router-factory", "exact-router-pair", "exact-router-amounts",
]);

export function uniV2QuoteRouter(descriptor: UniV2Descriptor): string | null {
  return descriptor.quoteModel.kind === "constant-product"
    ? ROUTER_CANDIDATES.get(descriptor.factoryBinding.factory.toLowerCase()) ?? null
    : null;
}

export function routerQuoteRequests(
  descriptor: UniV2Descriptor, route: UniV2Route, amountIn: bigint,
): readonly AdapterRequest[] {
  const router = uniV2QuoteRouter(descriptor);
  if (router === null) return [];
  return [
    { id: ROUTER_QUOTE_REQUEST_IDS[0], to: router,
      data: UNIV2_QUOTE_ROUTER_INTERFACE.encodeFunctionData("factory") },
    { id: ROUTER_QUOTE_REQUEST_IDS[1], to: descriptor.factoryBinding.factory,
      data: UNIV2_FACTORY_INTERFACE.encodeFunctionData("getPair", [route.tokenIn, route.tokenOut]) },
    { id: ROUTER_QUOTE_REQUEST_IDS[2], to: router,
      data: UNIV2_QUOTE_ROUTER_INTERFACE.encodeFunctionData("getAmountsOut", [amountIn, [route.tokenIn, route.tokenOut]]) },
  ].map(request => Object.freeze({ ...request, kind: "eth-call" as const, completion: "return-data" as const }));
}

export function decodeRouterQuote(
  descriptor: UniV2Descriptor, amountIn: bigint, expectedAmountOut: bigint,
  results: readonly AdapterRequestResult[],
): { readonly router: string; readonly amountOut: bigint } {
  const router = uniV2QuoteRouter(descriptor);
  if (router === null) throw new Error("univ2 missing nominated quote router");
  const factory = decodeAddressResult(results, ROUTER_QUOTE_REQUEST_IDS[0], UNIV2_QUOTE_ROUTER_INTERFACE, "factory");
  const pool = decodeAddressResult(results, ROUTER_QUOTE_REQUEST_IDS[1], UNIV2_FACTORY_INTERFACE, "getPair");
  if (!sameAddress(factory, descriptor.factoryBinding.factory) ||
      !sameAddress(pool, descriptor.pool) || !sameAddress(pool, descriptor.factoryBinding.reversePool)) {
    throw new Error("univ2 quote router factory/pair mismatch");
  }
  const result = requireSuccessfulResult(results, ROUTER_QUOTE_REQUEST_IDS[2]);
  const amounts = UNIV2_QUOTE_ROUTER_INTERFACE.decodeFunctionResult("getAmountsOut", result.data)[0];
  if (amounts.length !== 2 || amounts[0] !== amountIn ||
      UNIV2_QUOTE_ROUTER_INTERFACE.encodeFunctionResult("getAmountsOut", [amounts]).toLowerCase() !== result.data.toLowerCase()) {
    throw new Error("univ2 quote router returned incompatible amounts");
  }
  // Compare, never replace the chain return with local math. A Router whose
  // formula/fee differs from the admitted model must not silently quote it.
  if (amounts[1] !== expectedAmountOut) throw new Error("univ2 quote router curve/fee mismatch");
  return Object.freeze({ router, amountOut: BigInt(amounts[1]) });
}
