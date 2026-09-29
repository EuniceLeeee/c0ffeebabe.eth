import { ADDR } from "../shared/constants/addresses.js";
import type { RawTokenRate } from "./blockscan-amount-reference.js";

/** Absolute quote gross profit in WETH wei, for queue priority only. Reuses
 * published effective WETH marks, not a new oracle or trusted final-EV value.
 * Amounts and marks are raw-unit based; never apply token decimals twice. */
export function blockScanGrossProfitWeth(
  profitToken: string,
  quoteProfit: bigint,
  referenceEthPerRaw: ReadonlyMap<string, RawTokenRate>,
): bigint | null {
  if (profitToken.toLowerCase() === ADDR.WETH.toLowerCase()) return quoteProfit;
  const token = referenceEthPerRaw.get(profitToken.toLowerCase());
  if (!token || token.num <= 0n || token.den <= 0n) return null;
  return quoteProfit * token.num / token.den;
}
