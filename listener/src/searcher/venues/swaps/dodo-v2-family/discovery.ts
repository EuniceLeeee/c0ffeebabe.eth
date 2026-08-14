import type {
  DiscoverySemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  lowerAddress,
  DODO_V2_EVENT_INTERFACE,
  DODO_V2_SELL_BASE_SELECTOR,
  DODO_V2_SELL_QUOTE_SELECTOR,
  DODO_V2_SWAP_TOPIC,
} from "./codec.js";
import type { DodoV2Candidate } from "./types.js";
import { nominateDodoV2 } from "./nomination.js";

export const DODO_V2_SELL_BASE_PATTERN_ID = "dodo-v2-sell-base-call";
export const DODO_V2_SELL_QUOTE_PATTERN_ID = "dodo-v2-sell-quote-call";
export const DODO_V2_SWAP_LOG_PATTERN_ID = "dodo-v2-swap-log";

export const dodoV2Discovery = {
  evidenceChannel: "nominate" as const,
  sources: ["landed-log", "observed-call"],
  callPatterns: [{
    id: DODO_V2_SELL_BASE_PATTERN_ID,
    selector: DODO_V2_SELL_BASE_SELECTOR,
    signature: "sellBase(address)",
    candidateAddress: { from: "call-target" },
  }, {
    id: DODO_V2_SELL_QUOTE_PATTERN_ID,
    selector: DODO_V2_SELL_QUOTE_SELECTOR,
    signature: "sellQuote(address)",
    candidateAddress: { from: "call-target" },
  }],
  logPatterns: [{
    id: DODO_V2_SWAP_LOG_PATTERN_ID,
    topic: DODO_V2_SWAP_TOPIC,
    signature:
      "DODOSwap(address,address,uint256,uint256,address,address)",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      return decodeCandidate(observation, matchedPatternId);
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) => lowerAddress(candidate.pool),
  nominate: { nominate: nominateDodoV2 },
} satisfies DiscoverySemantics<DodoV2Candidate>;

function decodeCandidate(
  observation: UnifiedObservation,
  matchedPatternId: string,
): DodoV2Candidate | null {
  if (
    observation.kind === "call" &&
    matchedPatternId === DODO_V2_SELL_BASE_PATTERN_ID
  ) {
    return callCandidate("sell-base-call", observation.target);
  }
  if (
    observation.kind === "call" &&
    matchedPatternId === DODO_V2_SELL_QUOTE_PATTERN_ID
  ) {
    return callCandidate("sell-quote-call", observation.target);
  }
  if (
    observation.kind !== "log" ||
    matchedPatternId !== DODO_V2_SWAP_LOG_PATTERN_ID
  ) {
    return null;
  }
  const decoded = DODO_V2_EVENT_INTERFACE.decodeEventLog(
    "DODOSwap",
    observation.data,
    observation.topics,
  );
  return Object.freeze({
    candidateKind: "dodo-v2-pool" as const,
    sourceKind: "swap-log" as const,
    pool: canonicalAddress(observation.address),
    hintedTokenIn: canonicalAddress(String(decoded.fromToken)),
    hintedTokenOut: canonicalAddress(String(decoded.toToken)),
  });
}

function callCandidate(
  sourceKind: "sell-base-call" | "sell-quote-call",
  pool: string,
): DodoV2Candidate {
  return Object.freeze({
    candidateKind: "dodo-v2-pool" as const,
    sourceKind,
    pool: canonicalAddress(pool),
    hintedTokenIn: null,
    hintedTokenOut: null,
  });
}
