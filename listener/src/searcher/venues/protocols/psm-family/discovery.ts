import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { PSM_INTERFACE } from "./codec.js";
import type { PsmCandidate } from "./types.js";

export const psmDiscovery = {
  sources: ["observed-call", "address-surface"],
  callPatterns: ["sellGem", "buyGem"].map((fn) => ({
    id: `psm-${fn.toLowerCase()}-call`,
    selector: PSM_INTERFACE.getFunction(fn)!.selector as `0x${string}`,
    signature: `${fn}(address,uint256)`,
    candidateAddress: { from: "call-target" as const },
  })),
  addressSurfaces: [{
    id: "psm-lite-surface",
    kind: "interface",
    fingerprint: "lite-psm-gem-dai-fees-v1",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    if (
      observation.kind === "call" &&
      (matchedPatternId === "psm-sellgem-call" ||
        matchedPatternId === "psm-buygem-call")
    ) {
      return Object.freeze({
        candidateKind: "lite-psm" as const,
        target: canonicalAddress(observation.target),
      });
    }
    if (
      observation.kind === "address-surface" &&
      matchedPatternId === "psm-lite-surface"
    ) {
      return Object.freeze({
        candidateKind: "lite-psm" as const,
        target: canonicalAddress(observation.address),
      });
    }
    return null;
  },
  candidateKey: (candidate) => lowerAddress(candidate.target),
} satisfies DiscoverySemantics<PsmCandidate>;
