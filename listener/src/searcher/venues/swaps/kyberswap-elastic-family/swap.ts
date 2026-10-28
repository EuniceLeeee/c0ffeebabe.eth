import type {
  SwapDomainSemantics,
  UnifiedObservation,
} from "../../adapter-family-plugin.js";
import { createStrictSwapObservation } from "../../swap-observation.js";
import {
  KYSWAP_BURN_RTOKENS_TOPIC,
  KYSWAP_BURN_TOPIC,
  KYSWAP_MINT_TOPIC,
  KYSWAP_MUTATION_LOG_PATTERN_ID,
  KYSWAP_POOL_INTERFACE,
  KYSWAP_SWAP_CALL_PATTERN_ID,
  KYSWAP_SWAP_LOG_PATTERN_ID,
  KYSWAP_SWAP_TOPIC,
} from "./abi.js";
import { decodeSwapLog, lower, same } from "./codec.js";
import { KYSWAP_FAMILY_ID, KYSWAP_SWAP_ACTION } from "./manifest.js";
import type {
  KyberSwapDescriptor,
  KyberSwapRoute,
} from "./types.js";

const SWAP_PATTERN_IDS = Object.freeze([KYSWAP_SWAP_LOG_PATTERN_ID]);
const MUTATION_PATTERN_IDS = Object.freeze([KYSWAP_MUTATION_LOG_PATTERN_ID]);
const MUTATION_TOPICS = Object.freeze([
  KYSWAP_MINT_TOPIC,
  KYSWAP_BURN_TOPIC,
  KYSWAP_BURN_RTOKENS_TOPIC,
]);

/**
 * Swap-domain semantics for Elastic pools. `isToken0` is carried verbatim
 * (it is the input-token selector only for positive `swapQty`), and the receipt
 * observation resolves a direction through the admitted graph rather than
 * guessing from the event alone.
 */
export const kyberswapElasticSwap = {
  landedEvents: {
    patternIds: [...SWAP_PATTERN_IDS, ...MUTATION_PATTERN_IDS],
    classify({ observation }) {
      if (observation.kind !== "log") return null;
      const topic = observation.topics[0]?.toLowerCase();
      if (topic === KYSWAP_SWAP_TOPIC) return "swap";
      if (topic !== undefined && MUTATION_TOPICS.includes(topic)) {
        return "mutation";
      }
      return null;
    },
  },
  observation: {
    patternIds: [KYSWAP_SWAP_CALL_PATTERN_ID, ...SWAP_PATTERN_IDS],
    decode: ({ observation }) => decodeEffects(observation),
  },
  receiptObservation: createStrictSwapObservation({
    topics: [KYSWAP_SWAP_TOPIC],
    canonicalIntakeTargets: [],
    observedPoolIdentity: (log) =>
      decodeSwapLog(log) === null ? null : lower(log.address),
    async decodeSwapImpacts(ctx) {
      return ctx.matchedOwnedTriggers.map((trigger) => {
        const log = ctx.logs[trigger.logIndex];
        const found = log === undefined ? null : decodeSwapLog(log);
        if (found === null) {
          throw new Error("kyberswap elastic invalid owned swap log");
        }
        const edge = ctx.graph.find((candidate) => {
          if (
            candidate.adapterId !== KYSWAP_SWAP_ACTION ||
            !same(candidate.target, log!.address)
          ) {
            return false;
          }
          const binding = ctx.resolveBinding?.(candidate);
          if (binding === undefined || binding === null ||
              binding.familyId !== KYSWAP_FAMILY_ID) {
            return false;
          }
          const descriptor = binding.descriptor as KyberSwapDescriptor;
          return same(
            candidate.tokenIn,
            found.isToken0 ? descriptor.token0 : descriptor.token1,
          );
        });
        if (edge === undefined) {
          return {
            logIndex: trigger.logIndex,
            mutationOnlyReason:
              "kyberswap elastic direction absent from admitted graph",
          };
        }
        return {
          logIndex: trigger.logIndex,
          impact: {
            pool: edge.target,
            tokenIn: edge.tokenIn,
            tokenOut: edge.tokenOut,
            matchedAdapterId: KYSWAP_SWAP_ACTION,
            amountIn: found.amountIn,
            amountOut: found.amountOut,
          },
        };
      });
    },
  }),
  victimSupport: "detect-only" as const,
} satisfies SwapDomainSemantics<KyberSwapDescriptor, KyberSwapRoute>;

function decodeEffects(
  observation: UnifiedObservation,
): ReturnType<SwapDomainSemantics["observation"]["decode"]> {
  try {
    if (observation.kind === "call") {
      const decoded = KYSWAP_POOL_INTERFACE.decodeFunctionData(
        "swap",
        observation.data,
      );
      const swapQty = BigInt(decoded.swapQty);
      if (swapQty <= 0n) return [];
      return [Object.freeze({
        kind: "swap" as const,
        canonicalPayload: {
          pool: observation.target,
          recipient: String(decoded.recipient),
          isToken0: Boolean(decoded.isToken0),
          swapQty,
          exactInput: true,
          limitSqrtP: BigInt(decoded.limitSqrtP),
          callbackData: String(decoded.data),
        },
      })];
    }
    if (observation.kind !== "log") return [];
    const found = decodeSwapLog(observation);
    if (found === null) return [];
    return [Object.freeze({
      kind: "swap" as const,
      canonicalPayload: {
        pool: found.pool,
        sender: found.sender,
        recipient: found.recipient,
        deltaQty0: found.deltaQty0,
        deltaQty1: found.deltaQty1,
        isToken0: found.isToken0,
        amountIn: found.amountIn,
        amountOut: found.amountOut,
        exactPostState: {
          sqrtP: found.sqrtP,
          tick: found.tick,
          liquidity: found.liquidity,
        },
      },
    })];
  } catch {
    return [];
  }
}
