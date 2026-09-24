import type { SwapDomainSemantics } from "../../adapter-family-plugin.js";
import { ethers } from "ethers";
import type { ObservedSwapImpact, SwapObservationCapability, SwapEventLog } from "../../swap-observation.js";
import { CURVE_METAREGISTRY, META, addressArray, lower, same } from "./codec.js";
import { LOG_ID, SWAP_TOPIC, UINT_LOG_ID, UINT_SWAP_TOPIC, UINT_NG_LOG_ID, UINT_NG_SWAP_TOPIC, decodeSwapLog } from "./discovery.js";
import type { CurvePlainDescriptor, CurvePlainRoute } from "./types.js";
const patternIds = [LOG_ID, UINT_LOG_ID, UINT_NG_LOG_ID];
const actionIds = new Set(["curve-exchange", "curve-exchange-nr", "curve-exchange-plain", "curve-exchange-received-uint", "curve-exchange-uint"]);
const receiptSwap = (log: SwapEventLog) => decodeSwapLog({ ...log, kind: "log" });
// Strict Graph edges deliberately omit protocol indices. Resolve the event's
// coin indices with the same on-chain registry binding used by identity, then
// require an already-admitted direction. Never infer indices from edge order.
export const curvePlainReceiptObservation: SwapObservationCapability = {
  topics: [SWAP_TOPIC, UINT_SWAP_TOPIC, UINT_NG_SWAP_TOPIC], canonicalIntakeTargets: [],
  observedPoolIdentity: log => receiptSwap(log)?.pool.toLowerCase() ?? null,
  async decodeReceiptImpacts(ctx) {
    if (ctx.matchedOwnedTriggers.length === 0) return { status: "no-match" };
    const sourceBlock = ctx.sourceGeneration.sourceBlock;
    if (!ctx.tokenQuery || sourceBlock === null || !Number.isSafeInteger(sourceBlock) || sourceBlock < 0 ||
        !ethers.isHexString(ctx.sourceGeneration.sourceBlockHash, 32)) {
      return { status: "unresolved", reason: "curve-plain receipt requires source-bound coin reads" };
    }
    const coins = new Map<string, readonly string[]>();
    const impacts: ObservedSwapImpact[] = [], consumed: string[] = [];
    const indexes = new Set<number>();
    const open = () => !ctx.control.signal.aborted && Date.now() < ctx.control.deadlineAtMs;
    for (const trigger of ctx.matchedOwnedTriggers) {
      if (!open()) return { status: "unresolved", reason: "curve-plain receipt cancelled" };
      const log = ctx.logs[trigger.logIndex];
      const swap = log && receiptSwap(log);
      if (!swap || trigger.emitter.toLowerCase() !== swap.pool.toLowerCase() ||
          trigger.topic0.toLowerCase() !== log.topics[0]?.toLowerCase() ||
          consumed.includes(trigger.triggerId) || indexes.has(trigger.logIndex)) {
        return { status: "unresolved", reason: "curve-plain malformed owned swap" };
      }
      const edges = ctx.graph.filter(edge => actionIds.has(edge.adapterId) && same(edge.target, swap.pool));
      if (edges.length === 0) return { status: "unresolved", reason: "curve-plain swap has no admitted pool" };
      try {
        let poolCoins = coins.get(lower(swap.pool));
        if (!poolCoins) {
          poolCoins = addressArray(await ctx.tokenQuery.call({ to: CURVE_METAREGISTRY,
            data: META.encodeFunctionData("get_coins", [swap.pool]), blockTag: sourceBlock }, ctx.control), 8);
          coins.set(lower(swap.pool), poolCoins);
        }
        if (!open()) return { status: "unresolved", reason: "curve-plain receipt cancelled" };
        const tokenIn = poolCoins[swap.i], tokenOut = poolCoins[swap.j];
        const edge = tokenIn && tokenOut && edges.find(edge => same(edge.tokenIn, tokenIn) && same(edge.tokenOut, tokenOut));
        if (!edge) return { status: "unresolved", reason: "curve-plain swap has no admitted direction" };
        consumed.push(trigger.triggerId); indexes.add(trigger.logIndex);
        impacts.push({ logIndex: trigger.logIndex, consumedTriggerIds: [trigger.triggerId], impact: {
          pool: swap.pool, tokenIn: edge.tokenIn, tokenOut: edge.tokenOut, amountIn: swap.amountIn,
          amountOut: swap.amountOut, matchedAdapterId: edge.adapterId, sourceGeneration: ctx.sourceGeneration,
        } });
      } catch { return { status: "unresolved", reason: "curve-plain source coin binding unavailable" }; }
    }
    return { status: "resolved", impacts, mutations: [], consumedTriggerIds: consumed as [string, ...string[]] };
  },
};
export const curvePlainSwap = {
  landedEvents: { patternIds, classify: ({ observation }) => decodeSwapLog(observation) ? "swap" : null },
  observation: { patternIds, decode({ observation }) {
    const swap = decodeSwapLog(observation);
    return swap ? [{ kind: "swap" as const, canonicalPayload: { ...swap, semantics: "direct-coins" } }] : [];
  } },
  receiptObservation: curvePlainReceiptObservation,
  victimSupport: "detect-only",
  poolMaterialization: { patternIds, candidateBinding({ observation }) {
    const swap = decodeSwapLog(observation);
    return swap ? { ...swap, semantics: "direct-coins" } : null;
  } },
} satisfies SwapDomainSemantics<CurvePlainDescriptor, CurvePlainRoute>;
