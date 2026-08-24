import { ADDR } from "../../../../shared/constants/addresses.js";
import { createUniV4SwapObservation } from "../../swap-observation.js";
import { UNIV4_SWAP_TOPIC } from "../univ4-abi.js";
import { createUniv4Swap } from "../univ4-family/swap.js";
import { UNIV4_FEE_HOOK_PATTERN_IDS } from "./manifest.js";
import { univ4FeeHookVictimReplay } from "./victim.js";

/**
 * Same swap semantics as the standard univ4 Family; the receipt observation
 * binds the fee-hook owned unlock adapter id and the replay binds the
 * fee-hook victim spec. The remaining fields are a deep copy of the shared
 * implementation (landed events, observation decode, pool materialization),
 * instantiated with this Family's own pattern ids.
 */
export const univ4FeeHookSwap = {
  ...createUniv4Swap(UNIV4_FEE_HOOK_PATTERN_IDS),
  victimSupport: "replay" as const,
  replay: univ4FeeHookVictimReplay,
  receiptObservation: createUniV4SwapObservation({
    adapterIds: ["univ4-fee-hook-unlock"],
    canonicalIntakeTargets: [
      ADDR.UNISWAP_V4_POOL_MANAGER,
      "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad",
      "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
    ],
    topics: [UNIV4_SWAP_TOPIC],
  }),
};
