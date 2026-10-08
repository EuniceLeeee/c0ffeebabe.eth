import type { SwapDomainSemantics } from "../../adapter-family-plugin.js";
import { createStrictSwapObservation } from "../../swap-observation.js";
import { POOL, same } from "./codec.js";
import { decodeSwapLog, SWAP_PATTERN } from "./discovery.js";
import { ACTION } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";
export const swap = {
  landedEvents: { patternIds: [SWAP_PATTERN], classify: ({ observation: o }) => o.kind === "log" && decodeSwapLog(o) ? "swap" : null },
  observation: { patternIds: [SWAP_PATTERN], decode: ({ observation: o }) => {
    const found = o.kind === "log" ? decodeSwapLog(o) : null;
    return found ? [{ kind: "swap", canonicalPayload: { ...found } }] : [];
  } },
  receiptObservation: createStrictSwapObservation({ topics: [POOL.getEvent("LOG_SWAP")!.topicHash], canonicalIntakeTargets: [],
    observedPoolIdentity: log => decodeSwapLog(log) ? log.address.toLowerCase() : null,
    async decodeSwapImpacts(ctx) {
      return ctx.matchedOwnedTriggers.map(trigger => {
        const log = ctx.logs[trigger.logIndex], found = decodeSwapLog(log);
        if (!found) throw new Error("balancer-v1 invalid owned swap log");
        const edge = ctx.graph.find(e => e.adapterId === ACTION && same(e.target, log.address) && same(e.tokenIn, found.tokenIn) && same(e.tokenOut, found.tokenOut));
        if (!edge) return { logIndex: trigger.logIndex, mutationOnlyReason: "balancer-v1 direction absent from admitted graph" };
        return { logIndex: trigger.logIndex, impact: { pool: edge.target, ...found, matchedAdapterId: ACTION } };
      });
    },
  }),
  victimSupport: "detect-only",
} satisfies SwapDomainSemantics<Descriptor, Route>;
