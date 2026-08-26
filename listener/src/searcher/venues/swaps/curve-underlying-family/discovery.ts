import { ethers } from "ethers";
import type {
  DiscoverySemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import { explicitReverseBindingUnsupported } from
  "../../adapter-family-plugin.js";
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
import { createTxEvidenceNomination } from "../../tx-evidence-nomination.js";
import { reverseBindCurveUnderlying } from "./reverse-binding.js";

export const CURVE_UNDERLYING_I128_LOG_PATTERN_ID =
  "curve-underlying-i128-log";
export const CURVE_UNDERLYING_UINT_LOG_PATTERN_ID =
  "curve-underlying-uint-log";
export const CURVE_UNDERLYING_I128_CALL_PATTERN_ID =
  "curve-underlying-i128-call";
export const CURVE_UNDERLYING_UINT_CALL_PATTERN_ID =
  "curve-underlying-uint-call";
export const CURVE_UNDERLYING_POOL_SURFACE_PATTERN_ID =
  "curve-underlying-pool-surface";

export const curveUnderlyingDiscovery = {
  evidenceChannel: "nominate" as const,
  txSeedNominations: true,
  sources: ["landed-log", "observed-call"],
  canonicalIntakeTargets: [
    "0x99a58482bd75cbab83b27ec03ca68ff489b5788f",
    "0x16c6521dff6bab339122a0fe25a9116693265353",
  ],
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
  addressSurfaces: [Object.freeze({
    id: CURVE_UNDERLYING_POOL_SURFACE_PATTERN_ID,
    kind: "interface" as const,
    fingerprint: "curve-underlying-pool-surface-v1",
  })],
  decodeCandidate({ observation, matchedPatternId }) {
    try {
      return decodeCandidate(observation, matchedPatternId);
    } catch {
      return null;
    }
  },
  candidateKey: (candidate) => lowerAddress(candidate.pool),
  instanceNominationKey: (candidate) => {
    const value = candidate as Readonly<Record<string, unknown>>;
    return lowerAddress(String(value.pool ?? value.address ?? ""));
  },
  nominate: createTxEvidenceNomination({
    opaqueLabels: Object.freeze(["curve-underlying"]),
    logPatterns: Object.freeze([{
      id: "curve-underlying-i128-swap-log",
      topic: CURVE_UNDERLYING_I128_SWAP_TOPIC as `0x${string}`,
      signature: "TokenExchange(address,int128,uint256,int128,uint256)",
    }]),
    callPatterns: Object.freeze([{
      id: "curve-underlying-i128-swap-call",
      selector: CURVE_UNDERLYING_I128_SELECTOR as `0x${string}`,
      signature: "exchange(int128,int128,uint256,uint256)",
      candidateAddress: Object.freeze({ from: "call-target" as const }),
    }]),
  }),
  reverseBinding: Object.freeze({
    kind: "implementation" as const,
    reverseBinding: reverseBindCurveUnderlying,
  }),
} satisfies DiscoverySemantics<CurveUnderlyingCandidate>;

function decodeCandidate(
  observation: UnifiedObservation,
  matchedPatternId: string,
): CurveUnderlyingCandidate | null {
  if (
    observation.kind === "address-surface" &&
    matchedPatternId === CURVE_UNDERLYING_POOL_SURFACE_PATTERN_ID
  ) {
    // Retain-channel address surface: identity still re-verifies the
    // registry membership and underlying coins on chain before admission.
    return Object.freeze({
      candidateKind: "curve-underlying-pool" as const,
      pool: canonicalAddress(observation.address),
      sourceKind: "pool-surface" as const,
      hintedI: null,
      hintedJ: null,
    });
  }
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
