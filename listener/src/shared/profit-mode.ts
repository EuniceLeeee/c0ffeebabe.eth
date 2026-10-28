/** Positive EV is the default; positive gross profit is a bounded-live experiment. */
export type ProfitMode = "positive-ev" | "positive-gross-profit";

export const POSITIVE_GROSS_PROFIT_BRIBE_BPS = 9_900;

export function positiveGrossProfitBid(profitEth: bigint): bigint {
  return profitEth > 0n ? profitEth * BigInt(POSITIVE_GROSS_PROFIT_BRIBE_BPS) / 10_000n : 0n;
}

export function resolveProfitMode(value: string | undefined): ProfitMode {
  if (value === undefined || value === "positive-ev") return "positive-ev";
  if (value === "positive-gross-profit") return value;
  throw new Error("profit mode must be positive-ev or positive-gross-profit");
}

export function validatePositiveGrossProfitMode(input: {
  profitMode?: ProfitMode;
  evGate: boolean;
  bribeBps: number;
  bribeAllAboveGas: boolean;
  profitHaircutBps: number;
}): void {
  if (resolveProfitMode(input.profitMode) !== "positive-gross-profit") return;
  if (!input.evGate || input.bribeBps !== POSITIVE_GROSS_PROFIT_BRIBE_BPS || input.bribeAllAboveGas || input.profitHaircutBps !== 0) {
    throw new Error("positive-gross-profit requires EV checks, 9900 bribe bps, no above-gas bid and no profit haircut");
  }
}
