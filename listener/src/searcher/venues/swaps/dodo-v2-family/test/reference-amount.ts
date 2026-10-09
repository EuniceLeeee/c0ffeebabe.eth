import assert from "node:assert/strict";
import { ethers } from "ethers";

/** Observation-only bridge: borrow a recorded input, never a quote, edge or
 * admission. The operator explicitly selects one source row per input token.
 * Its quote source may be older than the published table (cascade is off).
 * Keep the full donor row in the report; the target is quoted/executed anew. */
export function referenceAmount(prices: any, edgeKeys: readonly string[], tokenIn: string) {
  assert(Array.isArray(edgeKeys) && edgeKeys.length > 0 && new Set(edgeKeys).size === edgeKeys.length);
  const rows = prices.runtime.pricing.effectiveMids.rows;
  assert(rows instanceof Map);
  const selected = edgeKeys.map(key => {
    assert(typeof key === "string");
    const row = rows.get(key);
    assert(row && row.edgeId === key && row.status === "quoted", "donor must be an actual quoted row");
    assert(ethers.isAddress(row.tokenIn) && ethers.isAddress(row.tokenOut));
    assert(typeof row.amountIn === "bigint" && row.amountIn > 0n && row.amountIn <= ethers.MaxUint256);
    assert(typeof row.amountOut === "bigint" && row.amountOut > 0n);
    assert(Number.isSafeInteger(row.quotedAt?.number) && row.quotedAt.number >= 0 && ethers.isHexString(row.quotedAt.hash, 32));
    return row;
  });
  const matches = selected.filter(row => row.tokenIn.toLowerCase() === tokenIn.toLowerCase());
  assert.equal(matches.length, 1, "select exactly one donor row for this input token");
  return { amountIn: matches[0].amountIn as bigint, donorRow: matches[0], kind: "spliced-recorded-input" as const };
}
