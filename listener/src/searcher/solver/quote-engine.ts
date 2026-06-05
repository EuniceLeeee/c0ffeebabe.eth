import type { CandidatePlan } from "../planner/planner.js";

export interface ModeBAmounts {
  flashAmount: bigint;
  debtAmount1: bigint;
  debtAmount2: bigint;
  daiAmount: bigint;
  v4TakeAmount: bigint;
  v3ExactOutput: bigint;
  usdtReceived: bigint;
  susdsOut: bigint;
  dolaAmount: bigint;
  wethOwed: bigint;
  minProfit: bigint;
}

const BASE_FLASH = 3_533_486761808775726594n;
const BASE_DEBT1 = 1_839_929_197n;
const BASE_DEBT2 = 1_839_929_197n;
const BASE_V4_TAKE = 3_679_935_364n;
const BASE_V3_EXACT = 3_513_427_987n;

/**
 * Initial Mode B input model: primary knobs are scaled from a route calibration
 * and then validated/corrected by stateful capture + final BotVM simulation.
 * It deliberately does not read a successful arb trace.
 */
export function deriveAmounts(_plan: CandidatePlan, flashAmount: bigint): ModeBAmounts {
  return {
    flashAmount,
    debtAmount1: BASE_DEBT1 * flashAmount / BASE_FLASH,
    debtAmount2: BASE_DEBT2 * flashAmount / BASE_FLASH,
    daiAmount: 0n,
    v4TakeAmount: BASE_V4_TAKE * flashAmount / BASE_FLASH,
    v3ExactOutput: BASE_V3_EXACT * flashAmount / BASE_FLASH,
    usdtReceived: 0n,
    susdsOut: 0n,
    dolaAmount: 0n,
    wethOwed: 0n,
    minProfit: 1n,
  };
}

export function assertNoUnresolvedAmounts(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoUnresolvedAmounts(item);
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.kind === "string") {
      throw new Error(`unresolved AmountRef remains: ${obj.kind}`);
    }
    for (const item of Object.values(obj)) assertNoUnresolvedAmounts(item);
  }
}
