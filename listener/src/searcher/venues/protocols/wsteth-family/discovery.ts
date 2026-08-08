import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { WSTETH_INTERFACE } from "./codec.js";
import type { WstethCandidate } from "./types.js";

export const wstethDiscovery = {
  sources: ["observed-call", "address-surface"],
  callPatterns: [
    {
      id: "wsteth-wrap-call",
      selector: WSTETH_INTERFACE.getFunction("wrap")!.selector as `0x${string}`,
      signature: "wrap(uint256)",
      candidateAddress: { from: "call-target" as const },
    },
    {
      id: "wsteth-unwrap-call",
      selector: WSTETH_INTERFACE.getFunction("unwrap")!.selector as `0x${string}`,
      signature: "unwrap(uint256)",
      candidateAddress: { from: "call-target" as const },
    },
  ],
  addressSurfaces: [{
    id: "wsteth-conversion-surface",
    kind: "interface",
    fingerprint: "wsteth-conversion-surface-v1",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    if (
      observation.kind === "call" &&
      (matchedPatternId === "wsteth-wrap-call" ||
        matchedPatternId === "wsteth-unwrap-call")
    ) {
      return Object.freeze({
        candidateKind: "wsteth-converter" as const,
        target: canonicalAddress(observation.target),
        sourceKind: "observed-call" as const,
      });
    }
    if (
      observation.kind === "address-surface" &&
      matchedPatternId === "wsteth-conversion-surface"
    ) {
      return Object.freeze({
        candidateKind: "wsteth-converter" as const,
        target: canonicalAddress(observation.address),
        sourceKind: "address-surface" as const,
      });
    }
    return null;
  },
  candidateKey: (candidate) => lowerAddress(candidate.target),
} satisfies DiscoverySemantics<WstethCandidate>;
