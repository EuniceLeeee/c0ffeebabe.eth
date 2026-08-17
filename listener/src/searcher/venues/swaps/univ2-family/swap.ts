import type {
  SwapDomainSemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import {
  canonicalAddress,
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_CREATED_PATTERN_ID,
  UNIV2_PAIR_INTERFACE,
  UNIV2_SWAP_CALL_PATTERN_ID,
  UNIV2_SWAP_LOG_PATTERN_ID,
  UNIV2_SWAP_TOPIC,
  UNIV2_SYNC_LOG_PATTERN_ID,
  UNIV2_SYNC_TOPIC,
} from "./codec.js";
import type { UniV2Descriptor, UniV2Route } from "./types.js";
import { univ2VictimReplay } from "./victim.js";
import { UNIV2_ROUTER } from "./victim.js";
import { createUniV2SwapObservation } from "../../swap-observation.js";

export const univ2Swap = {
  landedEvents: {
    patternIds: [UNIV2_SWAP_LOG_PATTERN_ID, UNIV2_SYNC_LOG_PATTERN_ID],
    classify({ observation }) {
      if (observation.kind !== "log") return null;
      const topic = observation.topics[0]?.toLowerCase();
      if (topic === UNIV2_SWAP_TOPIC.toLowerCase()) return "swap";
      if (topic === UNIV2_SYNC_TOPIC.toLowerCase()) return "mutation";
      return null;
    },
  },
  observation: {
    patternIds: [
      UNIV2_SWAP_CALL_PATTERN_ID,
      UNIV2_SWAP_LOG_PATTERN_ID,
      UNIV2_SYNC_LOG_PATTERN_ID,
    ],
    decode: ({ observation }) => decodeEffects(observation),
  },
  receiptObservation: createUniV2SwapObservation({
    adapterIds: ["univ2-swap"],
    canonicalIntakeTargets: [UNIV2_ROUTER],
    topics: [UNIV2_SWAP_TOPIC],
  }),
  victimSupport: "replay",
  replay: univ2VictimReplay,
  poolMaterialization: {
    patternIds: [UNIV2_PAIR_CREATED_PATTERN_ID],
    candidateBinding({ observation }) {
      if (observation.kind !== "log") return null;
      try {
        const decoded = UNIV2_FACTORY_INTERFACE.decodeEventLog(
          "PairCreated",
          observation.data,
          observation.topics,
        );
        return {
          pool: canonicalAddress(String(decoded.pair)),
          factory: canonicalAddress(observation.address),
          token0: canonicalAddress(String(decoded.token0)),
          token1: canonicalAddress(String(decoded.token1)),
        };
      } catch {
        return null;
      }
    },
  },
} satisfies SwapDomainSemantics<UniV2Descriptor, UniV2Route>;

function decodeEffects(
  observation: UnifiedObservation,
): ReturnType<SwapDomainSemantics["observation"]["decode"]> {
  try {
    if (observation.kind === "call") {
      const decoded = UNIV2_PAIR_INTERFACE.decodeFunctionData(
        "swap",
        observation.data,
      );
      return [Object.freeze({
        kind: "swap" as const,
        canonicalPayload: {
          pool: canonicalAddress(observation.target),
          amount0Out: BigInt(decoded.amount0Out),
          amount1Out: BigInt(decoded.amount1Out),
          recipient: canonicalAddress(String(decoded.to)),
          callbackData: String(decoded.data),
        },
      })];
    }
    if (observation.kind !== "log") return [];
    const topic = observation.topics[0]?.toLowerCase();
    if (topic === UNIV2_SWAP_TOPIC.toLowerCase()) {
      const decoded = UNIV2_PAIR_INTERFACE.decodeEventLog(
        "Swap",
        observation.data,
        observation.topics,
      );
      return [Object.freeze({
        kind: "swap" as const,
        canonicalPayload: {
          pool: canonicalAddress(observation.address),
          sender: canonicalAddress(String(decoded.sender)),
          recipient: canonicalAddress(String(decoded.to)),
          amount0In: BigInt(decoded.amount0In),
          amount1In: BigInt(decoded.amount1In),
          amount0Out: BigInt(decoded.amount0Out),
          amount1Out: BigInt(decoded.amount1Out),
        },
      })];
    }
    if (topic === UNIV2_SYNC_TOPIC.toLowerCase()) {
      const decoded = UNIV2_PAIR_INTERFACE.decodeEventLog(
        "Sync",
        observation.data,
        observation.topics,
      );
      return [Object.freeze({
        kind: "mutation" as const,
        canonicalPayload: {
          pool: canonicalAddress(observation.address),
          reserve0: BigInt(decoded.reserve0),
          reserve1: BigInt(decoded.reserve1),
        },
      })];
    }
    return [];
  } catch {
    return [];
  }
}
