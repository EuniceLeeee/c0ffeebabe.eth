import type {
  SwapDomainSemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import {
  ALGEBRA_BURN_TOPIC,
  ALGEBRA_FACTORY_INTERFACE,
  ALGEBRA_FACTORY_POOL_PATTERN_ID,
  ALGEBRA_FACTORY_POOL_TOPIC,
  ALGEBRA_INTEGRAL_ADAPTER_ID,
  ALGEBRA_INITIALIZE_LOG_PATTERN_ID,
  ALGEBRA_INITIALIZE_TOPIC,
  ALGEBRA_MINT_LOG_PATTERN_ID,
  ALGEBRA_MINT_TOPIC,
  ALGEBRA_BURN_LOG_PATTERN_ID,
  ALGEBRA_POOL_INTERFACE,
  ALGEBRA_SWAP_CALL_PATTERN_ID,
  ALGEBRA_SWAP_LOG_PATTERN_ID,
  ALGEBRA_SWAP_TOPIC,
} from "./abi.js";
import { canonicalAddress, sameAddress } from "./codec.js";
import { createUniV3SwapObservation } from "../../swap-observation.js";
import { ALGEBRA_INTEGRAL_FAMILY_ID } from "./manifest.js";
import type {
  AlgebraIntegralDescriptor,
  AlgebraIntegralRoute,
} from "./types.js";

const SWAP_PATTERN_IDS = Object.freeze([ALGEBRA_SWAP_LOG_PATTERN_ID]);
const MUTATION_PATTERN_IDS = Object.freeze([
  ALGEBRA_INITIALIZE_LOG_PATTERN_ID,
  ALGEBRA_MINT_LOG_PATTERN_ID,
  ALGEBRA_BURN_LOG_PATTERN_ID,
]);

/**
 * Landed-event semantics for the Algebra swap domain. `Swap` carries the
 * executed `overrideFee`/`pluginFee` next to the amounts, so this decoder can
 * see (and the family test asserts) whether the pool's own `fee()` view agreed
 * with the fee the pool actually charged.
 */
export const algebraIntegralSwap = {
  landedEvents: {
    patternIds: [...SWAP_PATTERN_IDS, ...MUTATION_PATTERN_IDS],
    classify({ observation }) {
      if (observation.kind !== "log") return null;
      const topic = observation.topics[0]?.toLowerCase();
      if (topic === ALGEBRA_SWAP_TOPIC) return "swap";
      if (
        topic === ALGEBRA_INITIALIZE_TOPIC ||
        topic === ALGEBRA_MINT_TOPIC ||
        topic === ALGEBRA_BURN_TOPIC
      ) {
        return "mutation";
      }
      return null;
    },
  },
  observation: {
    patternIds: [ALGEBRA_SWAP_CALL_PATTERN_ID, ...SWAP_PATTERN_IDS],
    decode: ({ observation }) => decodeEffects(observation),
  },
  /**
   * Receipt-side observation for landed swaps. The Algebra `Swap` payload begins
   * with exactly the UniV3 head (amount0, amount1, price, liquidity, tick) and
   * then carries `overrideFee`/`pluginFee`, so the central V3-shaped decoder
   * reads this family's events unambiguously; the two trailing fee words stay
   * owned by this family's landed-event decoder above. No canonical intake
   * target is declared: these pools are called directly, so a mempool shortlist
   * of a router would be a guess, not evidence.
   */
  receiptObservation: createUniV3SwapObservation({
    adapterIds: [ALGEBRA_INTEGRAL_ADAPTER_ID],
    canonicalIntakeTargets: [],
    topics: [ALGEBRA_SWAP_TOPIC],
    resolvePool(ctx, edge) {
      const binding = ctx.resolveBinding?.(edge);
      if (!binding || String(binding.familyId) !== String(ALGEBRA_INTEGRAL_FAMILY_ID)) {
        return null;
      }
      const descriptor = binding.descriptor as AlgebraIntegralDescriptor;
      if (!sameAddress(descriptor.pool, edge.target)) return null;
      const forward = sameAddress(edge.tokenIn, descriptor.token0) &&
        sameAddress(edge.tokenOut, descriptor.token1);
      const reverse = sameAddress(edge.tokenIn, descriptor.token1) &&
        sameAddress(edge.tokenOut, descriptor.token0);
      return forward || reverse
        ? { token0: descriptor.token0, token1: descriptor.token1 }
        : null;
    },
  }),
  // Victim replay/overlay is not declared: this family publishes no overlay
  // intent, so a backrun on these pools cannot claim a family-owned replay.
  victimSupport: "none",
  poolMaterialization: {
    patternIds: [ALGEBRA_FACTORY_POOL_PATTERN_ID],
    candidateBinding({ observation }) {
      if (
        observation.kind !== "log" ||
        observation.topics[0]?.toLowerCase() !== ALGEBRA_FACTORY_POOL_TOPIC
      ) {
        return null;
      }
      try {
        const decoded = ALGEBRA_FACTORY_INTERFACE.decodeEventLog(
          "Pool",
          observation.data,
          [...observation.topics],
        );
        return {
          pool: canonicalAddress(String(decoded.pool)),
          factory: canonicalAddress(observation.address),
          token0: canonicalAddress(String(decoded.token0)),
          token1: canonicalAddress(String(decoded.token1)),
        };
      } catch {
        return null;
      }
    },
  },
} satisfies SwapDomainSemantics<AlgebraIntegralDescriptor, AlgebraIntegralRoute>;

function decodeEffects(
  observation: UnifiedObservation,
): ReturnType<SwapDomainSemantics["observation"]["decode"]> {
  try {
    if (observation.kind === "call") {
      const decoded = ALGEBRA_POOL_INTERFACE.decodeFunctionData(
        "swap",
        observation.data,
      );
      return [Object.freeze({
        kind: "swap" as const,
        canonicalPayload: {
          pool: canonicalAddress(observation.target),
          recipient: canonicalAddress(String(decoded.recipient)),
          zeroForOne: Boolean(decoded.zeroToOne),
          amountRequired: BigInt(decoded.amountRequired),
          limitSqrtPrice: BigInt(decoded.limitSqrtPrice),
          callbackData: String(decoded.data),
        },
      })];
    }
    if (observation.kind !== "log") return [];
    if (observation.topics[0]?.toLowerCase() !== ALGEBRA_SWAP_TOPIC) return [];
    const decoded = ALGEBRA_POOL_INTERFACE.decodeEventLog(
      "Swap",
      observation.data,
      [...observation.topics],
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
        // The fee the pool ACTUALLY executed, plus the plugin's separate cut.
        overrideFee: BigInt(decoded.overrideFee),
        pluginFee: BigInt(decoded.pluginFee),
        exactPostState: {
          sqrtPriceX96: BigInt(decoded.price),
          tick: Number(decoded.tick),
          liquidity: BigInt(decoded.liquidity),
        },
      },
    })];
  } catch {
    return [];
  }
}
