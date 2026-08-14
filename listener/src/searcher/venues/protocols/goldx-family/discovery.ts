import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { GOLDX_INTERFACE } from "./codec.js";
import type { GoldxCandidate } from "./types.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";

export const goldxDiscovery = {
  sources: ["observed-call", "address-surface"],
  callPatterns: [{
    id: "goldx-mint-call",
    selector: GOLDX_INTERFACE.getFunction("mint")!.selector as `0x${string}`,
    signature: "mint(address,uint256)",
    candidateAddress: { from: "call-target" as const },
  }],
  addressSurfaces: [{
    id: "goldx-unit-mint-surface",
    kind: "interface",
    fingerprint: "goldx-unit-mint-v1",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    if (
      observation.kind === "call" &&
      matchedPatternId === "goldx-mint-call"
    ) {
      return Object.freeze({
        candidateKind: "goldx-minter" as const,
        target: canonicalAddress(observation.target),
      });
    }
    if (
      observation.kind === "address-surface" &&
      matchedPatternId === "goldx-unit-mint-surface"
    ) {
      return Object.freeze({
        candidateKind: "goldx-minter" as const,
        target: canonicalAddress(observation.address),
      });
    }
    return null;
  },
  candidateKey: (candidate) => lowerAddress(candidate.target),
  nominate: createAddressSurfaceNomination({
    opaqueLabels: Object.freeze(["goldx", "protocol:goldx"]),
    interfaceFingerprints: Object.freeze(["goldx-unit-mint-v1"]),
  }),
} satisfies DiscoverySemantics<GoldxCandidate>;
