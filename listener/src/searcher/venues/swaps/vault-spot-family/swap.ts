import type { SwapDomainSemantics } from "../../adapter-family-plugin.js";
import { createStrictSwapObservation } from "../../swap-observation.js";
import { ABI } from "./codec.js";
import { LOG, decodeSwapLog } from "./discovery.js";
import { ACTION } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";
export const swap = {
  landedEvents: { patternIds: [LOG], classify: ({ observation: o }) => o.kind === "log" && decodeSwapLog(o) ? "swap" : null },
  observation: { patternIds: [LOG], decode: ({ observation: o }) => {
    const found = o.kind === "log" ? decodeSwapLog(o) : null;
    return found ? [{ kind: "swap", canonicalPayload: { ...found } }] : [];
  } },
  receiptObservation: createStrictSwapObservation({ topics: [ABI.getEvent("Swap")!.topicHash], canonicalIntakeTargets: [],
    observedPoolIdentity: log => decodeSwapLog(log) ? log.address.toLowerCase() : null,
    async decodeSwapImpacts(ctx) { return ctx.matchedOwnedTriggers.map(trigger => {
      const log = ctx.logs[trigger.logIndex], s = decodeSwapLog(log);
      if (!s) throw new Error("vault-spot malformed owned log");
      const edge = ctx.graph.find(e => e.adapterId === ACTION && e.target.toLowerCase() === log.address.toLowerCase() &&
        e.tokenIn.toLowerCase() === s.tokenIn && e.tokenOut.toLowerCase() === s.tokenOut);
      return edge ? { logIndex: trigger.logIndex, impact: { pool: edge.target, tokenIn: s.tokenIn, tokenOut: s.tokenOut,
        amountIn: s.amountIn, amountOut: s.amountOut, matchedAdapterId: ACTION } } :
        { logIndex: trigger.logIndex, mutationOnlyReason: "vault-spot market absent from admitted graph" };
    }); },
  }), victimSupport: "detect-only",
} satisfies SwapDomainSemantics<Descriptor, Route>;
