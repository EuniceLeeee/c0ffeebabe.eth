import { ethers } from "ethers";
import type {
  SwapDomainSemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  CURVE_UNDERLYING_I128_SWAP_TOPIC,
  CURVE_UNDERLYING_UINT_SWAP_TOPIC,
} from "./codec.js";
import {
  CURVE_UNDERLYING_I128_LOG_PATTERN_ID,
  CURVE_UNDERLYING_UINT_LOG_PATTERN_ID,
} from "./discovery.js";
import type {
  CurveUnderlyingDescriptor,
  CurveUnderlyingRoute,
} from "./types.js";
import { createCurveSwapObservation } from "../../swap-observation.js";

const LOG_PATTERN_IDS = Object.freeze([
  CURVE_UNDERLYING_I128_LOG_PATTERN_ID,
  CURVE_UNDERLYING_UINT_LOG_PATTERN_ID,
]);

export const curveUnderlyingSwap = {
  landedEvents: {
    patternIds: LOG_PATTERN_IDS,
    classify({ observation }) {
      return isUnderlyingSwapLog(observation) ? "swap" : null;
    },
  },
  observation: {
    patternIds: LOG_PATTERN_IDS,
    decode: ({ observation }) => decodeSwapEffects(observation),
  },
  receiptObservation: createCurveSwapObservation({
    adapterIds: ["curve-exchange-underlying"],
    canonicalIntakeTargets: [
      "0x99a58482bd75cbab83b27ec03ca68ff489b5788f",
      "0x16c6521dff6bab339122a0fe25a9116693265353",
    ],
    topics: [
      CURVE_UNDERLYING_I128_SWAP_TOPIC,
      CURVE_UNDERLYING_UINT_SWAP_TOPIC,
    ],
  }),
  victimSupport: "detect-only",
  poolMaterialization: {
    patternIds: LOG_PATTERN_IDS,
    candidateBinding({ observation }) {
      const decoded = decodeUnderlyingSwap(observation);
      if (decoded === null || observation.kind !== "log") return null;
      return {
        pool: canonicalAddress(observation.address),
        i: decoded.i,
        j: decoded.j,
        amountIn: decoded.amountIn,
        amountOut: decoded.amountOut,
        semantics: "underlying",
      };
    },
  },
} satisfies SwapDomainSemantics<
  CurveUnderlyingDescriptor,
  CurveUnderlyingRoute
>;

function decodeSwapEffects(
  observation: UnifiedObservation,
): ReturnType<SwapDomainSemantics["observation"]["decode"]> {
  const decoded = decodeUnderlyingSwap(observation);
  if (decoded === null || observation.kind !== "log") return [];
  return [Object.freeze({
    kind: "swap" as const,
    canonicalPayload: {
      pool: canonicalAddress(observation.address),
      i: decoded.i,
      j: decoded.j,
      amountIn: decoded.amountIn,
      amountOut: decoded.amountOut,
      semantics: "underlying",
    },
  })];
}

function decodeUnderlyingSwap(observation: UnifiedObservation): {
  readonly i: number;
  readonly j: number;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
} | null {
  if (!isUnderlyingSwapLog(observation) || observation.kind !== "log") {
    return null;
  }
  try {
    const [soldId, tokensSold, boughtId, tokensBought] =
      ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint256", "uint256", "uint256", "uint256"],
        observation.data,
      );
    const i = Number(soldId);
    const j = Number(boughtId);
    if (
      !Number.isSafeInteger(i) ||
      !Number.isSafeInteger(j) ||
      i < 0 ||
      j < 0 ||
      i >= 8 ||
      j >= 8 ||
      i === j
    ) {
      return null;
    }
    return Object.freeze({
      i,
      j,
      amountIn: BigInt(tokensSold),
      amountOut: BigInt(tokensBought),
    });
  } catch {
    return null;
  }
}

function isUnderlyingSwapLog(observation: UnifiedObservation): boolean {
  if (observation.kind !== "log") return false;
  const topic = observation.topics[0]?.toLowerCase();
  return topic === CURVE_UNDERLYING_I128_SWAP_TOPIC ||
    topic === CURVE_UNDERLYING_UINT_SWAP_TOPIC;
}
