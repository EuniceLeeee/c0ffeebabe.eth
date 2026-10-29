import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";
import { OLYMPUS_INTERFACE } from "./codec.js";
import type { OlympusCandidate } from "./types.js";

const CALL_ID = "olympus-unstake-call";
const SURFACE_ID = "olympus-staking-surface";
const SURFACE_FINGERPRINT = "olympus-staking-v3-unstake-v1";

/**
 * A real `unstake(address,uint256,bool,bool)` call observes the staking
 * target. The address-surface channel only adds cold nominations; the
 * independent identity lifecycle (pinned runtime code hashes, getters and
 * decimals) decides admission, never this address or a pool allowlist.
 */
export const olympusDiscovery = {
  evidenceChannel: "nominate" as const,
  sources: ["observed-call" as const, "address-surface" as const],
  callPatterns: [{
    id: CALL_ID,
    selector: OLYMPUS_INTERFACE.getFunction("unstake")!.selector as `0x${string}`,
    signature: "unstake(address,uint256,bool,bool)",
    candidateAddress: { from: "call-target" as const },
  }],
  addressSurfaces: [{
    id: SURFACE_ID,
    kind: "interface",
    fingerprint: SURFACE_FINGERPRINT,
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    if (observation.kind === "call" && matchedPatternId === CALL_ID) {
      return Object.freeze({
        candidateKind: "olympus-staking" as const,
        target: canonicalAddress(observation.target),
      });
    }
    if (
      observation.kind === "address-surface" &&
      matchedPatternId === SURFACE_ID
    ) {
      return Object.freeze({
        candidateKind: "olympus-staking" as const,
        target: canonicalAddress(observation.address),
      });
    }
    return null;
  },
  candidateKey: (candidate: OlympusCandidate) => lowerAddress(candidate.target),
  nominate: createAddressSurfaceNomination({
    opaqueLabels: Object.freeze(["olympus", "protocol:olympus"]),
    interfaceFingerprints: Object.freeze([SURFACE_FINGERPRINT]),
  }),
  reverseBinding: explicitReverseBindingUnsupported(
    "Olympus V3 staking is a standalone deployment with no factory or registry creation claim",
  ),
} satisfies DiscoverySemantics<OlympusCandidate>;
