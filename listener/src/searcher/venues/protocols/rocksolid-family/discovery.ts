import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { ROCKSOLID_INTERFACE } from "./codec.js";
import type { RocksolidCandidate } from "./types.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";

export const rocksolidDiscovery = {
  evidenceChannel: "nominate" as const,
  sources: ["observed-call", "address-surface"],
  callPatterns: [{
    id: "rocksolid-sync-deposit-call",
    selector: ROCKSOLID_INTERFACE.getFunction(
      "syncDeposit",
    )!.selector as `0x${string}`,
    signature: "syncDeposit(uint256,address,address)",
    candidateAddress: { from: "call-target" as const },
  }],
  addressSurfaces: [{
    id: "rocksolid-sync-deposit-surface",
    kind: "interface",
    fingerprint: "rocksolid-sync-deposit-v1",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    if (
      observation.kind === "call" &&
      matchedPatternId === "rocksolid-sync-deposit-call"
    ) {
      return Object.freeze({
        candidateKind: "rocksolid-receipt" as const,
        target: canonicalAddress(observation.target),
      });
    }
    if (
      observation.kind === "address-surface" &&
      matchedPatternId === "rocksolid-sync-deposit-surface"
    ) {
      return Object.freeze({
        candidateKind: "rocksolid-receipt" as const,
        target: canonicalAddress(observation.address),
      });
    }
    return null;
  },
  candidateKey: (candidate) => lowerAddress(candidate.target),
  nominate: createAddressSurfaceNomination({
    opaqueLabels: Object.freeze(["rocksolid", "protocol:rocksolid"]),
    interfaceFingerprints: Object.freeze(["rocksolid-sync-deposit-v1"]),
  }),
} satisfies DiscoverySemantics<RocksolidCandidate>;
