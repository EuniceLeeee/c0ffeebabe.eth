import type {
  DiscoverySemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import { nominateUniv3 } from "./nomination.js";
import {
  PANCAKE_V3_SWAP_TOPIC,
  UNIV3_BURN_TOPIC,
  UNIV3_FACTORY_INTERFACE,
  UNIV3_INITIALIZE_TOPIC,
  UNIV3_MINT_TOPIC,
  UNIV3_POOL_CREATED_TOPIC,
  UNIV3_SWAP_SELECTOR,
  UNIV3_SWAP_TOPIC,
} from "../univ3-abi.js";
import {
  canonicalAddress,
  lowerAddress,
  PANCAKE_V3_SWAP_LOG_PATTERN_ID,
  UNIV3_BURN_LOG_PATTERN_ID,
  UNIV3_INITIALIZE_LOG_PATTERN_ID,
  UNIV3_MINT_LOG_PATTERN_ID,
  UNIV3_POOL_CREATED_PATTERN_ID,
  UNIV3_SWAP_CALL_PATTERN_ID,
  UNIV3_SWAP_LOG_PATTERN_ID,
} from "./codec.js";
import type { UniV3Candidate } from "./types.js";

export const UNIV3_POOL_SURFACE_PATTERN_ID = "univ3-pool-surface";

export const univ3Discovery = {
  evidenceChannel: "nominate" as const,
  sources: ["factory-log", "landed-log", "observed-call"],
  callPatterns: [{
    id: UNIV3_SWAP_CALL_PATTERN_ID,
    selector: UNIV3_SWAP_SELECTOR,
    signature: "swap(address,bool,int256,uint160,bytes)",
    candidateAddress: { from: "call-target" },
  }],
  logPatterns: [{
    id: UNIV3_POOL_CREATED_PATTERN_ID,
    topic: UNIV3_POOL_CREATED_TOPIC as `0x${string}`,
    signature: "PoolCreated(address,address,uint24,int24,address)",
  }, {
    id: UNIV3_SWAP_LOG_PATTERN_ID,
    topic: UNIV3_SWAP_TOPIC as `0x${string}`,
    signature: "Swap(address,address,int256,int256,uint160,uint128,int24)",
  }, {
    id: PANCAKE_V3_SWAP_LOG_PATTERN_ID,
    topic: PANCAKE_V3_SWAP_TOPIC as `0x${string}`,
    signature:
      "Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)",
  }, {
    id: UNIV3_INITIALIZE_LOG_PATTERN_ID,
    topic: UNIV3_INITIALIZE_TOPIC as `0x${string}`,
    signature: "Initialize(uint160,int24)",
  }, {
    id: UNIV3_MINT_LOG_PATTERN_ID,
    topic: UNIV3_MINT_TOPIC as `0x${string}`,
    signature: "Mint(address,address,int24,int24,uint128,uint256,uint256)",
  }, {
    id: UNIV3_BURN_LOG_PATTERN_ID,
    topic: UNIV3_BURN_TOPIC as `0x${string}`,
    signature: "Burn(address,int24,int24,uint128,uint256,uint256)",
  }],
  addressSurfaces: [Object.freeze({
    id: UNIV3_POOL_SURFACE_PATTERN_ID,
    kind: "interface" as const,
    fingerprint: "univ3-pool-surface-v1",
  })],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      return decodeCandidate(observation, matchedPatternId);
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) => lowerAddress(candidate.pool),
  nominate: { nominate: nominateUniv3 },
} satisfies DiscoverySemantics<UniV3Candidate>;

function decodeCandidate(
  observation: UnifiedObservation,
  matchedPatternId: string,
): UniV3Candidate | null {
  if (
    matchedPatternId === UNIV3_POOL_SURFACE_PATTERN_ID &&
    observation.kind === "address-surface"
  ) {
    return addressCandidate("pool-surface", observation.address);
  }
  if (
    matchedPatternId === UNIV3_SWAP_CALL_PATTERN_ID &&
    observation.kind === "call"
  ) {
    return addressCandidate("pool-call", observation.target);
  }
  if (
    observation.kind === "log" &&
    matchedPatternId !== UNIV3_POOL_CREATED_PATTERN_ID &&
    new Set([
      UNIV3_SWAP_LOG_PATTERN_ID,
      PANCAKE_V3_SWAP_LOG_PATTERN_ID,
      UNIV3_INITIALIZE_LOG_PATTERN_ID,
      UNIV3_MINT_LOG_PATTERN_ID,
      UNIV3_BURN_LOG_PATTERN_ID,
    ]).has(matchedPatternId)
  ) {
    return addressCandidate("pool-swap-log", observation.address);
  }
  if (
    matchedPatternId !== UNIV3_POOL_CREATED_PATTERN_ID ||
    observation.kind !== "log"
  ) {
    return null;
  }
  const decoded = UNIV3_FACTORY_INTERFACE.decodeEventLog(
    "PoolCreated",
    observation.data,
    observation.topics,
  );
  const tickSpacing = Number(decoded.tickSpacing);
  if (!Number.isSafeInteger(tickSpacing) || tickSpacing <= 0) return null;
  return Object.freeze({
    candidateKind: "univ3-pool" as const,
    sourceKind: "pool-created" as const,
    pool: canonicalAddress(String(decoded.pool)),
    hintedFactory: canonicalAddress(observation.address),
    hintedToken0: canonicalAddress(String(decoded.token0)),
    hintedToken1: canonicalAddress(String(decoded.token1)),
    hintedFee: BigInt(decoded.fee),
    hintedTickSpacing: tickSpacing,
  });
}

function addressCandidate(
  sourceKind: Exclude<UniV3Candidate["sourceKind"], "pool-created">,
  pool: string,
): UniV3Candidate {
  return Object.freeze({
    candidateKind: "univ3-pool" as const,
    sourceKind,
    pool: canonicalAddress(pool),
    hintedFactory: null,
    hintedToken0: null,
    hintedToken1: null,
    hintedFee: null,
    hintedTickSpacing: null,
  });
}
