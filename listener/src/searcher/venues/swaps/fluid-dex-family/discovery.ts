import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  FLUID_DEX_SWAP_SELECTOR,
  FLUID_DEX_SWAP_TOPIC,
  lowerAddress,
} from "./codec.js";
import type { FluidDexCandidate } from "./types.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";

export const FLUID_DEX_SWAP_CALL_PATTERN_ID = "fluid-dex-swap-call";
export const FLUID_DEX_SWAP_LOG_PATTERN_ID = "fluid-dex-swap-log";
export const FLUID_DEX_ADDRESS_SURFACE_PATTERN_ID =
  "fluid-dex-constants-surface";

export const fluidDexDiscovery = {
  evidenceChannel: "nominate" as const,
  sources: ["observed-call", "landed-log", "address-surface"],
  candidateSources: ["dex-token-domain"],
  callPatterns: [{
    id: FLUID_DEX_SWAP_CALL_PATTERN_ID,
    selector: FLUID_DEX_SWAP_SELECTOR,
    signature: "swapIn(bool,uint256,uint256,address)",
    candidateAddress: { from: "call-target" },
  }],
  logPatterns: [{
    id: FLUID_DEX_SWAP_LOG_PATTERN_ID,
    topic: FLUID_DEX_SWAP_TOPIC as `0x${string}`,
    signature: "FluidDexSwap(receipt-verified-topic)",
  }],
  addressSurfaces: [{
    id: FLUID_DEX_ADDRESS_SURFACE_PATTERN_ID,
    kind: "interface" as const,
    fingerprint: "fluid-dex:constantsView+swapIn",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    if (
      observation.kind === "call" &&
      matchedPatternId === FLUID_DEX_SWAP_CALL_PATTERN_ID &&
      observation.data.slice(0, 10).toLowerCase() === FLUID_DEX_SWAP_SELECTOR
    ) {
      return Object.freeze({
        candidateKind: "fluid-dex" as const,
        pool: canonicalAddress(observation.target),
        sourceKind: "swap-call" as const,
      });
    }
    if (
      observation.kind === "log" &&
      matchedPatternId === FLUID_DEX_SWAP_LOG_PATTERN_ID &&
      observation.topics[0]?.toLowerCase() === FLUID_DEX_SWAP_TOPIC
    ) {
      return Object.freeze({
        candidateKind: "fluid-dex" as const,
        pool: canonicalAddress(observation.address),
        sourceKind: "swap-log" as const,
      });
    }
    if (
      observation.kind === "address-surface" &&
      matchedPatternId === FLUID_DEX_ADDRESS_SURFACE_PATTERN_ID
    ) {
      return Object.freeze({
        candidateKind: "fluid-dex" as const,
        pool: canonicalAddress(observation.address),
        sourceKind: "address-surface" as const,
      });
    }
    return null;
  },
  candidateKey: (candidate) => lowerAddress(candidate.pool),
  nominate: createAddressSurfaceNomination({
    opaqueLabels: Object.freeze(["fluid-dex", "fluid"]),
    interfaceFingerprints: Object.freeze(["fluid-dex:constantsView+swapIn"]),
  }),
} satisfies DiscoverySemantics<FluidDexCandidate>;
