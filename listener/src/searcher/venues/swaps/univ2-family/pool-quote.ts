import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult } from "../../adapter-request-program.js";
import { UNIV2_POOL_QUOTE_INTERFACE } from "./codec.js";

export function poolQuoteRequest(id: string, pool: string, tokenIn: string, amountIn: bigint): AdapterRequest {
  return Object.freeze({
    id, kind: "eth-call", to: pool,
    data: UNIV2_POOL_QUOTE_INTERFACE.encodeFunctionData("getAmountOut", [tokenIn, amountIn]),
    completion: "return-or-revert-data",
  });
}

/** Null is pinned revert/empty, not proof of selector absence or an RPC failure. */
export function decodePoolQuote(results: readonly AdapterRequestResult[], id: string): bigint | null {
  const result = results.find((entry) => entry.id === id);
  if (!result) throw new Error(`univ2 pool quote ${id} missing`);
  if (!result.ok) throw new Error(`univ2 pool quote ${id} unresolved: ${result.failure}`);
  if (result.completion === "reverted-as-declared" || result.data === "0x") return null;
  if (!ethers.isHexString(result.data, 32)) throw new Error(`univ2 pool quote ${id} invalid uint256`);
  return BigInt(result.data);
}
