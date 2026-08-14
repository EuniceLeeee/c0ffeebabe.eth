import type {
  DiscoverySemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import { nominateUniv2 } from "./nomination.js";
import {
  canonicalAddress,
  lowerAddress,
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_CREATED_PATTERN_ID,
  UNIV2_PAIR_CREATED_TOPIC,
  UNIV2_SWAP_CALL_PATTERN_ID,
  UNIV2_SWAP_LOG_PATTERN_ID,
  UNIV2_SWAP_SELECTOR,
  UNIV2_SWAP_TOPIC,
  UNIV2_SYNC_LOG_PATTERN_ID,
  UNIV2_SYNC_TOPIC,
} from "./codec.js";
import type { UniV2Candidate } from "./types.js";

export const univ2Discovery = {
  evidenceChannel: "nominate" as const,
  sources: ["factory-log", "landed-log", "observed-call"],
  callPatterns: [{
    id: UNIV2_SWAP_CALL_PATTERN_ID,
    selector: UNIV2_SWAP_SELECTOR,
    signature: "swap(uint256,uint256,address,bytes)",
    candidateAddress: { from: "call-target" },
  }],
  logPatterns: [{
    id: UNIV2_PAIR_CREATED_PATTERN_ID,
    topic: UNIV2_PAIR_CREATED_TOPIC,
    signature: "PairCreated(address,address,address,uint256)",
  }, {
    id: UNIV2_SWAP_LOG_PATTERN_ID,
    topic: UNIV2_SWAP_TOPIC,
    signature: "Swap(address,uint256,uint256,uint256,uint256,address)",
  }, {
    id: UNIV2_SYNC_LOG_PATTERN_ID,
    topic: UNIV2_SYNC_TOPIC,
    signature: "Sync(uint112,uint112)",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      return decodeCandidate(observation, matchedPatternId);
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) => lowerAddress(candidate.pool),
  nominate: { nominate: nominateUniv2 },
} satisfies DiscoverySemantics<UniV2Candidate>;

function decodeCandidate(
  observation: UnifiedObservation,
  matchedPatternId: string,
): UniV2Candidate | null {
  if (
    matchedPatternId === UNIV2_SWAP_CALL_PATTERN_ID &&
    observation.kind === "call"
  ) {
    return candidate("pair-call", observation.target);
  }
  if (
    matchedPatternId === UNIV2_SWAP_LOG_PATTERN_ID &&
    observation.kind === "log"
  ) {
    return candidate("pair-swap-log", observation.address);
  }
  if (
    matchedPatternId === UNIV2_SYNC_LOG_PATTERN_ID &&
    observation.kind === "log"
  ) {
    return candidate("pair-sync-log", observation.address);
  }
  if (
    matchedPatternId !== UNIV2_PAIR_CREATED_PATTERN_ID ||
    observation.kind !== "log"
  ) {
    return null;
  }
  const decoded = UNIV2_FACTORY_INTERFACE.decodeEventLog(
    "PairCreated",
    observation.data,
    observation.topics,
  );
  return Object.freeze({
    candidateKind: "univ2-pair" as const,
    sourceKind: "pair-created" as const,
    pool: canonicalAddress(String(decoded.pair)),
    hintedFactory: canonicalAddress(observation.address),
    hintedToken0: canonicalAddress(String(decoded.token0)),
    hintedToken1: canonicalAddress(String(decoded.token1)),
  });
}

function candidate(
  sourceKind: Exclude<UniV2Candidate["sourceKind"], "pair-created">,
  pool: string,
): UniV2Candidate {
  return Object.freeze({
    candidateKind: "univ2-pair" as const,
    sourceKind,
    pool: canonicalAddress(pool),
    hintedFactory: null,
    hintedToken0: null,
    hintedToken1: null,
  });
}
