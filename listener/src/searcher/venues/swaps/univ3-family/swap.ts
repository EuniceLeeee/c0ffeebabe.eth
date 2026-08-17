import type {
  SwapDomainSemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import {
  PANCAKE_V3_POOL_INTERFACE,
  PANCAKE_V3_SWAP_TOPIC,
  UNIV3_BURN_TOPIC,
  UNIV3_FACTORY_INTERFACE,
  UNIV3_INITIALIZE_TOPIC,
  UNIV3_MINT_TOPIC,
  UNIV3_POOL_CREATED_TOPIC,
  UNIV3_POOL_INTERFACE,
  UNIV3_SWAP_ROUTER,
  UNIV3_SWAP_TOPIC,
} from "../univ3-abi.js";
import {
  canonicalAddress,
  PANCAKE_V3_SWAP_LOG_PATTERN_ID,
  UNIV3_BURN_LOG_PATTERN_ID,
  UNIV3_INITIALIZE_LOG_PATTERN_ID,
  UNIV3_MINT_LOG_PATTERN_ID,
  UNIV3_POOL_CREATED_PATTERN_ID,
  UNIV3_SWAP_CALL_PATTERN_ID,
  UNIV3_SWAP_LOG_PATTERN_ID,
} from "./codec.js";
import type { UniV3Descriptor, UniV3Route } from "./types.js";
import { univ3VictimReplay } from "./victim.js";
import { createUniV3SwapObservation } from "../../swap-observation.js";

const SWAP_PATTERN_IDS = Object.freeze([
  UNIV3_SWAP_LOG_PATTERN_ID,
  PANCAKE_V3_SWAP_LOG_PATTERN_ID,
]);
const MUTATION_PATTERN_IDS = Object.freeze([
  UNIV3_MINT_LOG_PATTERN_ID,
  UNIV3_BURN_LOG_PATTERN_ID,
]);

export const univ3Swap = {
  landedEvents: {
    patternIds: [...SWAP_PATTERN_IDS, ...MUTATION_PATTERN_IDS],
    classify({ observation }) {
      if (observation.kind !== "log") return null;
      const topic = observation.topics[0]?.toLowerCase();
      if (topic === UNIV3_SWAP_TOPIC || topic === PANCAKE_V3_SWAP_TOPIC) {
        return "swap";
      }
      if (
        topic === UNIV3_INITIALIZE_TOPIC ||
        topic === UNIV3_MINT_TOPIC ||
        topic === UNIV3_BURN_TOPIC
      ) {
        return "mutation";
      }
      return null;
    },
  },
  observation: {
    patternIds: [
      UNIV3_SWAP_CALL_PATTERN_ID,
      ...SWAP_PATTERN_IDS,
    ],
    decode: ({ observation }) => decodeEffects(observation),
  },
  receiptObservation: createUniV3SwapObservation({
    adapterIds: ["univ3-swap"],
    canonicalIntakeTargets: [
      UNIV3_SWAP_ROUTER,
      "0xe592427a0aece92de3edee1f18e0157c05861564",
    ],
    topics: [UNIV3_SWAP_TOPIC, PANCAKE_V3_SWAP_TOPIC],
  }),
  victimSupport: "replay",
  replay: univ3VictimReplay,
  poolMaterialization: {
    patternIds: [UNIV3_POOL_CREATED_PATTERN_ID],
    candidateBinding({ observation }) {
      if (
        observation.kind !== "log" ||
        observation.topics[0]?.toLowerCase() !== UNIV3_POOL_CREATED_TOPIC
      ) {
        return null;
      }
      try {
        const decoded = UNIV3_FACTORY_INTERFACE.decodeEventLog(
          "PoolCreated",
          observation.data,
          observation.topics,
        );
        return {
          pool: canonicalAddress(String(decoded.pool)),
          factory: canonicalAddress(observation.address),
          token0: canonicalAddress(String(decoded.token0)),
          token1: canonicalAddress(String(decoded.token1)),
          fee: BigInt(decoded.fee),
          tickSpacing: Number(decoded.tickSpacing),
        };
      } catch {
        return null;
      }
    },
  },
} satisfies SwapDomainSemantics<UniV3Descriptor, UniV3Route>;

function decodeEffects(
  observation: UnifiedObservation,
): ReturnType<SwapDomainSemantics["observation"]["decode"]> {
  try {
    if (observation.kind === "call") {
      const decoded = UNIV3_POOL_INTERFACE.decodeFunctionData(
        "swap",
        observation.data,
      );
      return [Object.freeze({
        kind: "swap" as const,
        canonicalPayload: {
          pool: canonicalAddress(observation.target),
          recipient: canonicalAddress(String(decoded.recipient)),
          zeroForOne: Boolean(decoded.zeroForOne),
          amountSpecified: BigInt(decoded.amountSpecified),
          sqrtPriceLimitX96: BigInt(decoded.sqrtPriceLimitX96),
          callbackData: String(decoded.data),
        },
      })];
    }
    if (observation.kind !== "log") return [];
    const topic = observation.topics[0]?.toLowerCase();
    if (topic === UNIV3_SWAP_TOPIC || topic === PANCAKE_V3_SWAP_TOPIC) {
      const iface = topic === UNIV3_SWAP_TOPIC
        ? UNIV3_POOL_INTERFACE
        : PANCAKE_V3_POOL_INTERFACE;
      const decoded = iface.decodeEventLog(
        "Swap",
        observation.data,
        observation.topics,
      );
      const amount0 = BigInt(decoded.amount0);
      const amount1 = BigInt(decoded.amount1);
      const zeroForOne = amount0 > 0n && amount1 < 0n;
      const oneForZero = amount1 > 0n && amount0 < 0n;
      if (!zeroForOne && !oneForZero) return [];
      return [Object.freeze({
        kind: "swap" as const,
        canonicalPayload: {
          pool: canonicalAddress(observation.address),
          sender: canonicalAddress(String(decoded.sender)),
          recipient: canonicalAddress(String(decoded.recipient)),
          amount0,
          amount1,
          zeroForOne,
          amountIn: zeroForOne ? amount0 : amount1,
          amountOut: zeroForOne ? -amount1 : -amount0,
          exactPostState: {
            sqrtPriceX96: BigInt(decoded.sqrtPriceX96),
            tick: Number(decoded.tick),
            liquidity: BigInt(decoded.liquidity),
          },
        },
      })];
    }
    if (
      topic === UNIV3_INITIALIZE_TOPIC ||
      topic === UNIV3_MINT_TOPIC ||
      topic === UNIV3_BURN_TOPIC
    ) {
      return [Object.freeze({
        kind: "mutation" as const,
        canonicalPayload: {
          pool: canonicalAddress(observation.address),
          topic,
        },
      })];
    }
    return [];
  } catch {
    return [];
  }
}
