import type { SwapDomainSemantics } from "../../adapter-family-plugin.js";
import type { SwapObservationCapability, ObservedSwapImpact } from "../../swap-observation.js";
import { VAULT, ROUTER, same } from "./codec.js";
import { LOG_ID, SWAP_TOPIC, decodeSwapLog } from "./discovery.js";
import type { BalancerV3Descriptor, BalancerV3Route } from "./types.js";

// No runtime import of the multi-family legacy observation/event registry.
export const balancerV3ReceiptObservation: SwapObservationCapability = {
  topics: [SWAP_TOPIC], canonicalIntakeTargets: [VAULT, ROUTER],
  observedPoolIdentity: log => decodeSwapLog(log)?.pool.toLowerCase() ?? null,
  async decodeReceiptImpacts(ctx) {
    if (ctx.matchedOwnedTriggers.length === 0) return { status: "no-match" };
    const impacts: ObservedSwapImpact[] = [];
    const consumed: string[] = [];
    const indexes = new Set<number>();
    for (const trigger of ctx.matchedOwnedTriggers) {
      if (ctx.control.signal.aborted || Date.now() >= ctx.control.deadlineAtMs) return { status: "unresolved", reason: "balancer-v3 receipt cancelled" };
      const log = ctx.logs[trigger.logIndex];
      const decoded = log && decodeSwapLog(log);
      if (!decoded || !same(trigger.emitter, VAULT) || trigger.topic0.toLowerCase() !== SWAP_TOPIC ||
          consumed.includes(trigger.triggerId) || indexes.has(trigger.logIndex)) return { status: "unresolved", reason: "balancer-v3 malformed owned swap" };
      const edge = ctx.graph.find(candidate => candidate.adapterId === "balancer-v3-router-swap" &&
        same(candidate.target, decoded.pool) && same(candidate.tokenIn, decoded.tokenIn) && same(candidate.tokenOut, decoded.tokenOut));
      if (!edge) return { status: "unresolved", reason: "balancer-v3 swap has no admitted direction" };
      consumed.push(trigger.triggerId); indexes.add(trigger.logIndex);
      impacts.push({ logIndex: trigger.logIndex, consumedTriggerIds: [trigger.triggerId],
        impact: { ...decoded, matchedAdapterId: edge.adapterId, sourceGeneration: ctx.sourceGeneration } });
    }
    return { status: "resolved", impacts, mutations: [], consumedTriggerIds: consumed as [string, ...string[]] };
  },
};
export const balancerV3Swap = {
  landedEvents: { patternIds: [LOG_ID], classify: ({ observation }) =>
    observation.kind === "log" && decodeSwapLog(observation) ? "swap" : null },
  observation: { patternIds: [LOG_ID], decode({ observation }) {
    const decoded = observation.kind === "log" ? decodeSwapLog(observation) : null;
    return decoded ? [{ kind: "swap" as const, canonicalPayload: { ...decoded } }] : [];
  } },
  receiptObservation: balancerV3ReceiptObservation,
  victimSupport: "detect-only",
  poolMaterialization: { patternIds: [LOG_ID], candidateBinding({ observation }) {
    const decoded = observation.kind === "log" ? decodeSwapLog(observation) : null;
    return decoded ? { ...decoded } : null;
  } },
} satisfies SwapDomainSemantics<BalancerV3Descriptor, BalancerV3Route>;
