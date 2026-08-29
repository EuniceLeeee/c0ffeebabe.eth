import { coarseGoldx, type GoldxCoarseOutcomeV1 } from "./pricing.ts";
export type GoldxExactOutcomeV1 = GoldxCoarseOutcomeV1;
export function exactGoldx(input: Parameters<typeof coarseGoldx>[0]): GoldxExactOutcomeV1 { return coarseGoldx(input); }
