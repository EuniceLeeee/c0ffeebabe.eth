import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  FLUID_VAULT_OPERATE_SELECTOR,
  lowerAddress,
} from "./codec.js";
import type { FluidCreditCandidate } from "./types.js";

export const FLUID_CREDIT_OPERATE_CALL_PATTERN_ID =
  "fluid-credit-operate-call";
export const FLUID_CREDIT_ADDRESS_SURFACE_PATTERN_ID =
  "fluid-credit-vault-surface";

export const fluidCreditDiscovery = {
  sources: ["observed-call", "address-surface"],
  callPatterns: [{
    id: FLUID_CREDIT_OPERATE_CALL_PATTERN_ID,
    selector: FLUID_VAULT_OPERATE_SELECTOR,
    signature: "operate(uint256,int256,int256,address)",
    candidateAddress: { from: "call-target" },
  }],
  addressSurfaces: [{
    id: FLUID_CREDIT_ADDRESS_SURFACE_PATTERN_ID,
    kind: "interface" as const,
    fingerprint: "fluid-credit:constantsView+operate",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    if (
      observation.kind === "call" &&
      matchedPatternId === FLUID_CREDIT_OPERATE_CALL_PATTERN_ID &&
      observation.data.slice(0, 10).toLowerCase() === FLUID_VAULT_OPERATE_SELECTOR
    ) {
      return Object.freeze({
        candidateKind: "fluid-credit-vault" as const,
        vault: canonicalAddress(observation.target),
        sourceKind: "operate-call" as const,
      });
    }
    if (
      observation.kind === "address-surface" &&
      matchedPatternId === FLUID_CREDIT_ADDRESS_SURFACE_PATTERN_ID
    ) {
      return Object.freeze({
        candidateKind: "fluid-credit-vault" as const,
        vault: canonicalAddress(observation.address),
        sourceKind: "address-surface" as const,
      });
    }
    return null;
  },
  candidateKey: (candidate) => lowerAddress(candidate.vault),
} satisfies DiscoverySemantics<FluidCreditCandidate>;
