import type { SwapDomainSemantics } from "../../adapter-family-plugin.js";
import { createStrictSwapObservation, type SwapEventLog } from "../../swap-observation.js";
import { EKUBO_CORE, EKUBO_ROUTER, EKUBO_POOL_INITIALIZED_TOPIC, EKUBO_CORE_SWAP_DATA_BYTES, EKUBO_CORE_SWAP_POOL_ID_OFFSET_BYTES,
  parseEkuboCoreSwapLog } from "../ekubo/abi.js";
import { decodeInitialized, decodeSwapCall, same } from "./codec.js";
import { CALL_ID, CALL_NO_RECEIVER_ID, INIT_ID } from "./discovery.js";
import { EKUBO_ACTION_ID } from "./manifest.js";
import type { EkuboDescriptor, EkuboRoute } from "./types.js";

function observed(log: Pick<SwapEventLog, "address" | "topics" | "data">) {
  if (!same(log.address, EKUBO_CORE) || log.topics.length !== 0) return null;
  try { return parseEkuboCoreSwapLog(log.data); } catch { return null; }
}
export const ekuboSwap = {
  // Anonymous swap data has no LogPattern topic; receiptObservation below
  // declares its exact structural selector. Do not invent a synthetic topic.
  landedEvents: { patternIds: [INIT_ID], classify: ({ observation }) =>
    observation.kind === "log" && decodeInitialized(observation) ? "mutation" : null },
  observation: { patternIds: [CALL_ID, CALL_NO_RECEIVER_ID, INIT_ID], decode({ observation }) {
    const swap = decodeSwapCall(observation);
    if (swap) return [{ kind: "swap" as const, canonicalPayload: { poolId: swap.poolId,
      isToken1: swap.isToken1, amountIn: swap.amountIn } }];
    const initialized = observation.kind === "log" ? decodeInitialized(observation) : null;
    return initialized ? [{ kind: "mutation" as const, canonicalPayload: { poolId: initialized.poolId } }] : [];
  } },
  receiptObservation: createStrictSwapObservation({
    topics: [EKUBO_POOL_INITIALIZED_TOPIC], canonicalIntakeTargets: [],
    anonymousLogs: [{ address: EKUBO_CORE, dataLengthBytes: EKUBO_CORE_SWAP_DATA_BYTES, identityOffsetBytes: EKUBO_CORE_SWAP_POOL_ID_OFFSET_BYTES }],
    observedPoolIdentity: log => decodeInitialized(log)?.poolId ?? observed(log)?.poolId ?? null,
    async decodeSwapImpacts(ctx) {
      return ctx.matchedOwnedTriggers.map(trigger => {
        if (decodeInitialized(ctx.logs[trigger.logIndex])) return { logIndex: trigger.logIndex, mutationOnlyReason: "ekubo pool initialized" };
        const swap = observed(ctx.logs[trigger.logIndex]);
        if (!swap) throw new Error("ekubo invalid owned anonymous log");
        const isToken1 = swap.delta1 > 0n && swap.delta0 < 0n;
        if (!isToken1 && !(swap.delta0 > 0n && swap.delta1 < 0n)) {
          if (swap.delta0 === 0n || swap.delta1 === 0n) return { logIndex: trigger.logIndex, mutationOnlyReason: "ekubo no directed token flow" };
          throw new Error("ekubo invalid signed swap deltas");
        }
        // Strict graph edges carry the Family's instanceKey, not legacy
        // poolToken fields. PoolKey sorting determines the signed direction.
        const edge = ctx.graph.find(edge => edge.adapterId === EKUBO_ACTION_ID && same(edge.target, EKUBO_ROUTER) &&
          edge.instanceKey === swap.poolId && (BigInt(edge.tokenIn) > BigInt(edge.tokenOut)) === isToken1);
        if (!edge) return { logIndex: trigger.logIndex, mutationOnlyReason: "ekubo direction absent from admitted graph" };
        return { logIndex: trigger.logIndex, impact: { pool: edge.target, poolId: swap.poolId,
          tokenIn: edge.tokenIn, tokenOut: edge.tokenOut, matchedAdapterId: EKUBO_ACTION_ID,
          amountIn: isToken1 ? swap.delta1 : swap.delta0, amountOut: -(isToken1 ? swap.delta0 : swap.delta1),
          poolToken0: isToken1 ? edge.tokenOut : edge.tokenIn, poolToken1: isToken1 ? edge.tokenIn : edge.tokenOut } };
      });
    },
  }),
  victimSupport: "detect-only",
  poolMaterialization: { patternIds: [INIT_ID], candidateBinding({ observation }) {
    const found = observation.kind === "log" ? decodeInitialized(observation) : null;
    return found ? { poolId: found.poolId, poolKey: { ...found.poolKey } } : null;
  } },
} satisfies SwapDomainSemantics<EkuboDescriptor, EkuboRoute>;
