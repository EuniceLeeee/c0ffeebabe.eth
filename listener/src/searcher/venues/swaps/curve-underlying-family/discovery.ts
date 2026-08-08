import { ethers } from "ethers";
import type {
  DiscoverySemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  CURVE_UNDERLYING_I128_SELECTOR,
  CURVE_UNDERLYING_I128_SWAP_TOPIC,
  CURVE_UNDERLYING_UINT_SELECTOR,
  CURVE_UNDERLYING_UINT_SWAP_TOPIC,
  decodeUnderlyingIndicesFromCall,
  lowerAddress,
} from "./codec.js";
import type { CurveUnderlyingCandidate } from "./types.js";

export const CURVE_UNDERLYING_I128_LOG_PATTERN_ID =
  "curve-underlying-i128-log";
export const CURVE_UNDERLYING_UINT_LOG_PATTERN_ID =
  "curve-underlying-uint-log";
export const CURVE_UNDERLYING_I128_CALL_PATTERN_ID =
  "curve-underlying-i128-call";
export const CURVE_UNDERLYING_UINT_CALL_PATTERN_ID =
  "curve-underlying-uint-call";

export const curveUnderlyingDiscovery = {
  sources: ["landed-log", "observed-call"],
  callPatterns: [{
    id: CURVE_UNDERLYING_I128_CALL_PATTERN_ID,
    selector: CURVE_UNDERLYING_I128_SELECTOR,
    signature: "exchange_underlying(int128,int128,uint256,uint256)",
    candidateAddress: { from: "call-target" },
  }, {
    id: CURVE_UNDERLYING_UINT_CALL_PATTERN_ID,
    selector: CURVE_UNDERLYING_UINT_SELECTOR,
    signature: "exchange_underlying(uint256,uint256,uint256,uint256)",
    candidateAddress: { from: "call-target" },
  }],
  logPatterns: [{
    id: CURVE_UNDERLYING_I128_LOG_PATTERN_ID,
    topic: CURVE_UNDERLYING_I128_SWAP_TOPIC as `0x${string}`,
    signature:
      "TokenExchangeUnderlying(address,int128,uint256,int128,uint256)",
  }, {
    id: CURVE_UNDERLYING_UINT_LOG_PATTERN_ID,
    topic: CURVE_UNDERLYING_UINT_SWAP_TOPIC as `0x${string}`,
    signature:
      "TokenExchangeUnderlying(address,uint256,uint256,uint256,uint256)",
  }],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      return decodeCandidate(observation, matchedPatternId);
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) => lowerAddress(candidate.pool),
} satisfies DiscoverySemantics<CurveUnderlyingCandidate>;

function decodeCandidate(
  observation: UnifiedObservation,
  matchedPatternId: string,
): CurveUnderlyingCandidate | null {
  if (
    observation.kind === "call" &&
    (matchedPatternId === CURVE_UNDERLYING_I128_CALL_PATTERN_ID ||
      matchedPatternId === CURVE_UNDERLYING_UINT_CALL_PATTERN_ID)
  ) {
    const indices = decodeUnderlyingIndicesFromCall(observation.data);
    if (indices === null) return null;
    return Object.freeze({
      candidateKind: "curve-underlying-pool" as const,
      pool: canonicalAddress(observation.target),
      sourceKind: "exchange-underlying-call" as const,
      hintedI: indices.i,
      hintedJ: indices.j,
    });
  }
  if (
    observation.kind !== "log" ||
    (matchedPatternId !== CURVE_UNDERLYING_I128_LOG_PATTERN_ID &&
      matchedPatternId !== CURVE_UNDERLYING_UINT_LOG_PATTERN_ID)
  ) {
    return null;
  }
  const [soldId, , boughtId] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["uint256", "uint256", "uint256", "uint256"],
    observation.data,
  );
  const i = Number(soldId);
  const j = Number(boughtId);
  if (!validIndex(i) || !validIndex(j) || i === j) return null;
  return Object.freeze({
    candidateKind: "curve-underlying-pool" as const,
    pool: canonicalAddress(observation.address),
    sourceKind: "underlying-swap-log" as const,
    hintedI: i,
    hintedJ: j,
  });
}

function validIndex(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < 8;
}
