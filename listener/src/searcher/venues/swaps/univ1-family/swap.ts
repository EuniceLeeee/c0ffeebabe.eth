import type { SwapDomainSemantics } from "../../adapter-family-plugin.js";
import { createStrictSwapObservation } from "../../swap-observation.js";
import { POOL, same, WETH } from "./codec.js";
import { EVENTS } from "./discovery.js";
import { ACTION } from "./manifest.js";
import type { Descriptor, Route } from "./types.js";
function decode(log: { address: string; topics: readonly string[]; data: string }) {
  if (log.topics.length !== 4 || log.data !== "0x") return null;
  try {
    const name = EVENTS.find(n => POOL.getEvent(n)!.topicHash === log.topics[0].toLowerCase());
    if (!name) return null;
    const args = POOL.decodeEventLog(name, log.data, [...log.topics]);
    return { buy: name === "TokenPurchase", amountIn: BigInt(args[1]), amountOut: BigInt(args[2]) };
  } catch { return null; }
}
export const swap = {
  landedEvents: { patternIds: EVENTS.map(n => `univ1-${n}`), classify: ({ observation: o }) => o.kind === "log" && decode(o) ? "swap" : null },
  observation: { patternIds: EVENTS.map(n => `univ1-${n}`), decode: ({ observation: o }) => {
    const found = o.kind === "log" ? decode(o) : null;
    return found ? [{ kind: "swap", canonicalPayload: { ...found } }] : [];
  } },
  receiptObservation: createStrictSwapObservation({ topics: EVENTS.map(n => POOL.getEvent(n)!.topicHash), canonicalIntakeTargets: [],
    observedPoolIdentity: log => decode(log) ? log.address.toLowerCase() : null,
    async decodeSwapImpacts(ctx) {
      return ctx.matchedOwnedTriggers.map(trigger => {
        const log = ctx.logs[trigger.logIndex], found = decode(log);
        if (!found) throw new Error("univ1 invalid owned swap log");
        const edge = ctx.graph.find(e => e.adapterId === ACTION && same(e.target, log.address) && same(found.buy ? e.tokenIn : e.tokenOut, WETH));
        if (!edge) return { logIndex: trigger.logIndex, mutationOnlyReason: "univ1 direction absent from admitted graph" };
        return { logIndex: trigger.logIndex, impact: { pool: edge.target, tokenIn: edge.tokenIn, tokenOut: edge.tokenOut,
          matchedAdapterId: ACTION, amountIn: found.amountIn, amountOut: found.amountOut } };
      });
    },
  }),
  victimSupport: "detect-only",
} satisfies SwapDomainSemantics<Descriptor, Route>;
