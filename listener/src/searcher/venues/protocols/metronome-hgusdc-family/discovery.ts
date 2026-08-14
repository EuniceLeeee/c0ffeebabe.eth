import { METRONOME_HGUSDC_PATH } from "../../../../adapters/metronome-hgusdc.js";
import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { METRONOME_HGUSDC_ROUTER_INTERFACE } from "./shared.js";
import type { MetronomeHgUsdcCandidate } from "./types.js";

const EXECUTE_PATH_PATTERN_ID = "metronome-hgusdc-execute-path";

export const metronomeHgUsdcDiscovery = {
  evidenceChannel: "tx-evidence" as const,
  sources: ["observed-call"],
  callPatterns: [{
    id: EXECUTE_PATH_PATTERN_ID,
    selector: METRONOME_HGUSDC_ROUTER_INTERFACE.getFunction("executePath")!
      .selector as `0x${string}`,
    signature: "executePath(bytes,uint256[],address)",
    candidateAddress: { from: "call-target" },
    argumentProjection: [
      { index: 0, type: "bytes", name: "path" },
      { index: 1, type: "uint256[]", name: "amounts" },
    ],
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    if (
      observation.kind !== "call" ||
      matchedPatternId !== EXECUTE_PATH_PATTERN_ID
    ) return null;
    try {
      const decoded = METRONOME_HGUSDC_ROUTER_INTERFACE.decodeFunctionData(
        "executePath",
        observation.data,
      );
      const path = String(decoded[0]).toLowerCase();
      const amounts = Array.from(decoded[1] as readonly bigint[], BigInt);
      if (
        path !== METRONOME_HGUSDC_PATH.toLowerCase() ||
        amounts.length !== 1 ||
        amounts[0] <= 0n
      ) return null;
      return Object.freeze({
        candidateKind: "metronome-hgusdc-router" as const,
        router: canonicalAddress(observation.target),
        observedAmount: amounts[0],
      });
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) => lowerAddress(candidate.router),
} satisfies DiscoverySemantics<MetronomeHgUsdcCandidate>;
