import type { SwapDomainSemantics } from "../../adapter-family-plugin.js";
import type { SwapObservationCapability, ObservedSwapImpact } from "../../swap-observation.js";
import { VAULT, same } from "./codec.js";
import { LOG_ID, SWAP_TOPIC, decodeSwapLog } from "./discovery.js";
import { BALANCER_V2_FAMILY_ID } from "./manifest.js";
import type { BalancerV2Descriptor, BalancerV2Route } from "./types.js";
export const receiptObservation: SwapObservationCapability = {
  topics: [SWAP_TOPIC], canonicalIntakeTargets: [VAULT],
  observedPoolIdentity: log => decodeSwapLog(log)?.pool.toLowerCase() ?? null,
  async decodeReceiptImpacts(ctx) {
    if (!ctx.matchedOwnedTriggers.length) return { status: "no-match" };
    const impacts: ObservedSwapImpact[] = [], consumed: string[] = [], indexes = new Set<number>();
    for (const trigger of ctx.matchedOwnedTriggers) {
      if (ctx.control.signal.aborted || Date.now() >= ctx.control.deadlineAtMs) return { status: "unresolved", reason: "balancer-v2 receipt cancelled" };
      const log = ctx.logs[trigger.logIndex], decoded = log && decodeSwapLog(log);
      if (!decoded || !same(trigger.emitter, VAULT) || trigger.topic0.toLowerCase() !== SWAP_TOPIC ||
          consumed.includes(trigger.triggerId) || indexes.has(trigger.logIndex)) return { status: "unresolved", reason: "balancer-v2 malformed owned swap" };
      const edge = ctx.graph.find(e => {
        if (e.adapterId !== "balancer-v2-vault-swap" || !same(e.target, decoded.pool) ||
            !same(e.tokenIn, decoded.tokenIn) || !same(e.tokenOut, decoded.tokenOut)) return false;
        const binding = ctx.resolveBinding?.(e);
        return binding?.familyId === BALANCER_V2_FAMILY_ID && (binding.descriptor as BalancerV2Descriptor).poolId === decoded.poolId;
      });
      if (!edge) return { status: "unresolved", reason: "balancer-v2 swap has no admitted direction/binding" };
      consumed.push(trigger.triggerId); indexes.add(trigger.logIndex);
      impacts.push({ logIndex: trigger.logIndex, consumedTriggerIds: [trigger.triggerId],
        // poolId remains Family-owned binding evidence, not a legacy edge field.
        impact: { pool: edge.target, tokenIn: decoded.tokenIn, tokenOut: decoded.tokenOut,
          amountIn: decoded.amountIn, amountOut: decoded.amountOut,
          matchedAdapterId: edge.adapterId, sourceGeneration: ctx.sourceGeneration } });
    }
    return { status: "resolved", impacts, mutations: [], consumedTriggerIds: consumed as [string, ...string[]] };
  },
};
export const swap = {
  landedEvents: { patternIds: [LOG_ID], classify: ({ observation }) => observation.kind === "log" && decodeSwapLog(observation) ? "swap" : null },
  observation: { patternIds: [LOG_ID], decode({ observation }) {
    const value = observation.kind === "log" ? decodeSwapLog(observation) : null;
    return value ? [{ kind: "swap" as const, canonicalPayload: { ...value } }] : [];
  } },
  receiptObservation, victimSupport: "detect-only",
  poolMaterialization: { patternIds: [LOG_ID], candidateBinding({ observation }) {
    const value = observation.kind === "log" ? decodeSwapLog(observation) : null;
    return value ? { poolId: value.poolId, pool: value.pool } : null;
  } },
} satisfies SwapDomainSemantics<BalancerV2Descriptor, BalancerV2Route>;
