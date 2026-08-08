import type {
  SwapDomainSemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import {
  UNIV4_INITIALIZE_TOPIC,
  UNIV4_MODIFY_LIQUIDITY_TOPIC,
  UNIV4_POOL_MANAGER_INTERFACE,
  UNIV4_SWAP_TOPIC,
} from "../univ4-abi.js";
import { v4PoolId } from "../univ4-common.js";
import {
  canonicalAddress,
  canonicalPoolId,
  canonicalPoolKey,
  poolKeyProjection,
  UNIV4_INITIALIZE_PATTERN_ID,
  UNIV4_MODIFY_LIQUIDITY_PATTERN_ID,
  UNIV4_SWAP_CALL_PATTERN_ID,
  UNIV4_SWAP_LOG_PATTERN_ID,
} from "./codec.js";
import type { UniV4Descriptor, UniV4Route } from "./types.js";
import { univ4VictimReplay } from "./victim.js";

export const univ4Swap = {
  landedEvents: {
    patternIds: [
      UNIV4_SWAP_LOG_PATTERN_ID,
      UNIV4_MODIFY_LIQUIDITY_PATTERN_ID,
    ],
    classify({ observation }) {
      if (observation.kind !== "log") return null;
      const topic = observation.topics[0]?.toLowerCase();
      if (topic === UNIV4_SWAP_TOPIC) return "swap";
      if (topic === UNIV4_MODIFY_LIQUIDITY_TOPIC) return "mutation";
      return null;
    },
  },
  observation: {
    patternIds: [UNIV4_SWAP_CALL_PATTERN_ID, UNIV4_SWAP_LOG_PATTERN_ID],
    decode: ({ observation }) => decodeEffects(observation),
  },
  victimSupport: "replay",
  replay: univ4VictimReplay,
  poolMaterialization: {
    patternIds: [UNIV4_INITIALIZE_PATTERN_ID],
    candidateBinding({ observation }) {
      if (
        observation.kind !== "log" ||
        observation.topics[0]?.toLowerCase() !== UNIV4_INITIALIZE_TOPIC
      ) {
        return null;
      }
      try {
        const decoded = UNIV4_POOL_MANAGER_INTERFACE.decodeEventLog(
          "Initialize",
          observation.data,
          observation.topics,
        );
        const poolKey = canonicalPoolKey({
          currency0: String(decoded.currency0),
          currency1: String(decoded.currency1),
          fee: Number(decoded.fee),
          tickSpacing: Number(decoded.tickSpacing),
          hooks: String(decoded.hooks),
        });
        const poolId = canonicalPoolId(String(decoded.id));
        if (v4PoolId(poolKey) !== poolId) return null;
        return {
          manager: canonicalAddress(observation.address),
          poolId,
          poolKey: poolKeyProjection(poolKey),
        };
      } catch {
        return null;
      }
    },
  },
} satisfies SwapDomainSemantics<UniV4Descriptor, UniV4Route>;

function decodeEffects(
  observation: UnifiedObservation,
): ReturnType<SwapDomainSemantics["observation"]["decode"]> {
  try {
    if (observation.kind === "call") {
      const decoded = UNIV4_POOL_MANAGER_INTERFACE.decodeFunctionData(
        "swap",
        observation.data,
      );
      const key = decoded.key;
      const poolKey = canonicalPoolKey({
        currency0: String(key.currency0),
        currency1: String(key.currency1),
        fee: Number(key.fee),
        tickSpacing: Number(key.tickSpacing),
        hooks: String(key.hooks),
      });
      const params = decoded.params;
      return [Object.freeze({
        kind: "swap" as const,
        canonicalPayload: {
          manager: canonicalAddress(observation.target),
          poolId: v4PoolId(poolKey),
          poolKey: poolKeyProjection(poolKey),
          zeroForOne: Boolean(params.zeroForOne),
          amountSpecified: BigInt(params.amountSpecified),
          sqrtPriceLimitX96: BigInt(params.sqrtPriceLimitX96),
          hookData: String(decoded.hookData),
        },
      })];
    }
    if (
      observation.kind !== "log" ||
      observation.topics[0]?.toLowerCase() !== UNIV4_SWAP_TOPIC
    ) {
      return [];
    }
    const decoded = UNIV4_POOL_MANAGER_INTERFACE.decodeEventLog(
      "Swap",
      observation.data,
      observation.topics,
    );
    const amount0 = BigInt(decoded.amount0);
    const amount1 = BigInt(decoded.amount1);
    const zeroForOne = amount0 < 0n && amount1 > 0n;
    const oneForZero = amount1 < 0n && amount0 > 0n;
    if (!zeroForOne && !oneForZero) return [];
    return [Object.freeze({
      kind: "swap" as const,
      canonicalPayload: {
        manager: canonicalAddress(observation.address),
        poolId: canonicalPoolId(String(decoded.id)),
        sender: canonicalAddress(String(decoded.sender)),
        amount0,
        amount1,
        zeroForOne,
        amountIn: zeroForOne ? -amount0 : -amount1,
        amountOut: zeroForOne ? amount1 : amount0,
        exactPostState: {
          poolId: canonicalPoolId(String(decoded.id)),
          sqrtPriceX96: BigInt(decoded.sqrtPriceX96),
          liquidity: BigInt(decoded.liquidity),
          tick: Number(decoded.tick),
          lpFee: Number(decoded.fee),
        },
      },
    })];
  } catch {
    return [];
  }
}
