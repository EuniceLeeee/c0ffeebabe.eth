import type {
  SwapDomainSemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  DODO_V2_EVENT_INTERFACE,
  DODO_V2_SWAP_TOPIC,
} from "./codec.js";
import { DODO_V2_SWAP_LOG_PATTERN_ID } from "./discovery.js";
import type { DodoV2Descriptor, DodoV2Route } from "./types.js";

export const dodoV2Swap = {
  landedEvents: {
    patternIds: [DODO_V2_SWAP_LOG_PATTERN_ID],
    classify({ observation }) {
      return observation.kind === "log" &&
          observation.topics[0]?.toLowerCase() === DODO_V2_SWAP_TOPIC
        ? "swap"
        : null;
    },
  },
  observation: {
    patternIds: [DODO_V2_SWAP_LOG_PATTERN_ID],
    decode: ({ observation }) => decodeSwapEffects(observation),
  },
  victimSupport: "detect-only",
  poolMaterialization: {
    patternIds: [DODO_V2_SWAP_LOG_PATTERN_ID],
    candidateBinding({ observation }) {
      const decoded = decodeDodoSwap(observation);
      if (decoded === null || observation.kind !== "log") return null;
      return {
        pool: canonicalAddress(observation.address),
        observedTokenIn: decoded.fromToken,
        observedTokenOut: decoded.toToken,
      };
    },
  },
} satisfies SwapDomainSemantics<DodoV2Descriptor, DodoV2Route>;

function decodeSwapEffects(
  observation: UnifiedObservation,
): ReturnType<SwapDomainSemantics["observation"]["decode"]> {
  const decoded = decodeDodoSwap(observation);
  if (decoded === null || observation.kind !== "log") return [];
  return [Object.freeze({
    kind: "swap" as const,
    canonicalPayload: {
      pool: canonicalAddress(observation.address),
      tokenIn: decoded.fromToken,
      tokenOut: decoded.toToken,
      amountIn: decoded.fromAmount,
      amountOut: decoded.toAmount,
      trader: decoded.trader,
      receiver: decoded.receiver,
    },
  })];
}

function decodeDodoSwap(observation: UnifiedObservation): {
  readonly fromToken: string;
  readonly toToken: string;
  readonly fromAmount: bigint;
  readonly toAmount: bigint;
  readonly trader: string;
  readonly receiver: string;
} | null {
  if (
    observation.kind !== "log" ||
    observation.topics[0]?.toLowerCase() !== DODO_V2_SWAP_TOPIC
  ) {
    return null;
  }
  try {
    const decoded = DODO_V2_EVENT_INTERFACE.decodeEventLog(
      "DODOSwap",
      observation.data,
      observation.topics,
    );
    return Object.freeze({
      fromToken: canonicalAddress(String(decoded.fromToken)),
      toToken: canonicalAddress(String(decoded.toToken)),
      fromAmount: BigInt(decoded.fromAmount),
      toAmount: BigInt(decoded.toAmount),
      trader: canonicalAddress(String(decoded.trader)),
      receiver: canonicalAddress(String(decoded.receiver)),
    });
  } catch {
    return null;
  }
}
