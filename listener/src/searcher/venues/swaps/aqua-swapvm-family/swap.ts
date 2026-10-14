import type { SwapDomainSemantics } from "../../adapter-family-plugin.js";
import { createStrictSwapObservation } from "../../swap-observation.js";
import { ABI } from "./codec.js";
import { SWAPPED, decodeSwapLog } from "./discovery.js";
import { ACTION } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";
export const swap = {
  landedEvents: { patternIds: [SWAPPED], classify: ({ observation: o }) => o.kind === "log" && decodeSwapLog(o) ? "swap" : null },
  observation: { patternIds: [SWAPPED], decode: ({ observation: o }) => { const s = o.kind === "log" ? decodeSwapLog(o) : null;
    return s ? [{ kind: "swap", canonicalPayload: { ...s } }] : []; } },
  receiptObservation: createStrictSwapObservation({ topics: [ABI.getEvent("Swapped")!.topicHash], canonicalIntakeTargets: [],
    observedPoolIdentity: l => decodeSwapLog(l) ? l.address.toLowerCase() : null,
    async decodeSwapImpacts(ctx) { return ctx.matchedOwnedTriggers.map(t => {
      const l = ctx.logs[t.logIndex], s = decodeSwapLog(l); if (!s) throw new Error("aqua malformed swap log");
      const e = ctx.graph.find(e => e.adapterId === ACTION && e.target.toLowerCase() === l.address.toLowerCase() &&
        e.instanceKey?.includes(`:${s.maker}:${s.orderHash}:`) && e.tokenIn.toLowerCase() === s.tokenIn && e.tokenOut.toLowerCase() === s.tokenOut);
      return e ? { logIndex: t.logIndex, impact: { pool: e.target, tokenIn: s.tokenIn, tokenOut: s.tokenOut,
        amountIn: s.amountIn, amountOut: s.amountOut, matchedAdapterId: ACTION } } :
        { logIndex: t.logIndex, mutationOnlyReason: "aqua strategy absent from admitted graph" };
    }); },
  }), victimSupport: "detect-only",
} satisfies SwapDomainSemantics<Descriptor, Route>;
