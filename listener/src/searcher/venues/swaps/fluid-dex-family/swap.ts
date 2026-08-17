import type {
  SwapDomainSemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  FLUID_DEX_SWAP_TOPIC,
} from "./codec.js";
import { FLUID_DEX_SWAP_LOG_PATTERN_ID } from "./discovery.js";
import type { FluidDexDescriptor, FluidDexRoute } from "./types.js";
import {
  createStrictSwapObservation,
  type SwapEventLog,
} from "../../swap-observation.js";

export const fluidDexSwap = {
  landedEvents: {
    patternIds: [FLUID_DEX_SWAP_LOG_PATTERN_ID],
    classify: ({ observation }) => isSwapLog(observation) ? "swap" : null,
  },
  observation: {
    patternIds: [FLUID_DEX_SWAP_LOG_PATTERN_ID],
    // The receipt-verified topic has no public stable event ABI. Preserve the
    // owned trigger without inventing token/amount fields. The receipt boundary
    // therefore remains unresolved until this Family supplies a verified ABI.
    decode: () => [],
  },
  receiptObservation: createStrictSwapObservation({
    topics: [FLUID_DEX_SWAP_TOPIC],
    canonicalIntakeTargets: [],
    observedPoolIdentity(log: SwapEventLog) {
      return log.address.toLowerCase();
    },
    async decodeSwapImpacts() {
      return [];
    },
  }),
  victimSupport: "detect-only",
  poolMaterialization: {
    patternIds: [FLUID_DEX_SWAP_LOG_PATTERN_ID],
    candidateBinding({ observation }) {
      return isSwapLog(observation) && observation.kind === "log"
        ? {
            pool: canonicalAddress(observation.address),
            observedTopic: FLUID_DEX_SWAP_TOPIC,
          }
        : null;
    },
  },
} satisfies SwapDomainSemantics<FluidDexDescriptor, FluidDexRoute>;

function isSwapLog(observation: UnifiedObservation): boolean {
  return observation.kind === "log" &&
    observation.topics[0]?.toLowerCase() === FLUID_DEX_SWAP_TOPIC;
}
