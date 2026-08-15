import { ethers } from "ethers";
import type { DiscoverySemantics } from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { METRONOME_SYNTH_POOL_INTERFACE } from "./shared.js";
import type { MetronomeSynthCandidate } from "./types.js";
import { createAddressSurfaceNomination } from "../../address-surface-nomination.js";

const SWAP_PATTERN_ID = "metronome-synth-swap-call";
const QUOTE_PATTERN_ID = "metronome-synth-quote-call";
const SURFACE_PATTERN_ID = "metronome-synth-pool-surface";

export const metronomeSynthDiscovery = {
  evidenceChannel: "nominate" as const,
  sources: ["observed-call", "address-surface"],
  callPatterns: [
    {
      id: SWAP_PATTERN_ID,
      selector: METRONOME_SYNTH_POOL_INTERFACE.getFunction("swap")!
        .selector as `0x${string}`,
      signature: "swap(address,address,uint256)",
      candidateAddress: { from: "call-target" },
      argumentProjection: [
        { index: 0, type: "address", name: "tokenIn" },
        { index: 1, type: "address", name: "tokenOut" },
      ],
    },
    {
      id: QUOTE_PATTERN_ID,
      selector: METRONOME_SYNTH_POOL_INTERFACE.getFunction("quoteSwapOut")!
        .selector as `0x${string}`,
      signature: "quoteSwapOut(address,address,uint256)",
      candidateAddress: { from: "call-target" },
      argumentProjection: [
        { index: 0, type: "address", name: "tokenIn" },
        { index: 1, type: "address", name: "tokenOut" },
      ],
    },
  ],
  addressSurfaces: [{
    id: SURFACE_PATTERN_ID,
    kind: "interface" as const,
    fingerprint: "metronome-synth-membership-and-quote-v1",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      if (
        observation.kind === "call" &&
        (matchedPatternId === SWAP_PATTERN_ID ||
          matchedPatternId === QUOTE_PATTERN_ID)
      ) {
        const functionName = matchedPatternId === SWAP_PATTERN_ID
          ? "swap"
          : "quoteSwapOut";
        const decoded = METRONOME_SYNTH_POOL_INTERFACE.decodeFunctionData(
          functionName,
          observation.data,
        );
        const tokenIn = canonicalAddress(String(decoded[0]));
        const tokenOut = canonicalAddress(String(decoded[1]));
        const amountIn = BigInt(decoded[2]);
        if (
          amountIn <= 0n ||
          tokenIn === ethers.ZeroAddress ||
          tokenOut === ethers.ZeroAddress ||
          sameAddress(tokenIn, tokenOut)
        ) return null;
        return Object.freeze({
          candidateKind: "metronome-synth-pool" as const,
          pool: canonicalAddress(observation.target),
          hintedTokens: Object.freeze([tokenIn, tokenOut]),
        });
      }
      if (
        observation.kind === "address-surface" &&
        matchedPatternId === SURFACE_PATTERN_ID
      ) {
        return Object.freeze({
          candidateKind: "metronome-synth-pool" as const,
          pool: canonicalAddress(observation.address),
          hintedTokens: Object.freeze([]),
        });
      }
    } catch {
      return null;
    }
    return null;
  },
  candidateKey: (candidate) => lowerAddress(candidate.pool),
  nominate: createAddressSurfaceNomination({
    opaqueLabels: Object.freeze(["metronome-synth", "protocol:metronome-synth"]),
    interfaceFingerprints: Object.freeze(["metronome-synth-membership-and-quote-v1"]),
  }),
  reverseBinding: explicitReverseBindingUnsupported(
    "no reverse-binding registry declared (explicit unsupported)",
  ),
} satisfies DiscoverySemantics<MetronomeSynthCandidate>;