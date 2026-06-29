import type { TokenDelta } from "../types.js";
import { tokenMeta } from "../registry/protocols.js";

export function roughValueUsd(deltas: TokenDelta[], ethUsd = 0): number | null {
  let total = 0;
  let hasPriced = false;
  for (const d of deltas) {
    const meta = tokenMeta(d.token);
    const amount = Number(d.raw) / 10 ** d.decimals;
    if (meta.roughUsd !== undefined) {
      total += amount * meta.roughUsd;
      hasPriced = true;
    } else if (meta.symbol === "WETH" && ethUsd > 0) {
      total += amount * ethUsd;
      hasPriced = true;
    }
  }
  return hasPriced ? total : null;
}

export function gasPaidEth(gasUsed: bigint, effectiveGasPrice: bigint): number {
  return Number(gasUsed * effectiveGasPrice) / 1e18;
}
