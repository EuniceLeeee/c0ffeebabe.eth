import type { SwapDomainSemantics } from "../../adapter-family-plugin.js";
import { createStrictSwapObservation } from "../../swap-observation.js";
import { MOONISWAP_ACTION, lower } from "./codec.js";
import { SWAPPED_ID, SWAPPED_TOPIC, decodeSwapped } from "./discovery.js";
import type { MooniswapDescriptor, MooniswapRoute } from "./types.js";
export const mooniswapSwap = {
  landedEvents: { patternIds: [SWAPPED_ID], classify: ({ observation }) =>
    observation.kind === "log" && decodeSwapped(observation) ? "swap" : null },
  observation: { patternIds: [SWAPPED_ID], decode({ observation }) {
    const swap = observation.kind === "log" ? decodeSwapped(observation) : null;
    return swap ? [{ kind: "swap", canonicalPayload: { ...swap } }] : [];
  } },
  receiptObservation: createStrictSwapObservation({ topics: [SWAPPED_TOPIC], canonicalIntakeTargets: [],
    observedPoolIdentity: log => decodeSwapped(log)?.pool ?? null,
    async decodeSwapImpacts(ctx) {
      return ctx.matchedOwnedTriggers.map(trigger => {
        const swap = decodeSwapped(ctx.logs[trigger.logIndex]);
        if (!swap) throw new Error("mooniswap invalid owned swap log");
        const edge = ctx.graph.find(e => e.adapterId === MOONISWAP_ACTION && lower(e.target) === swap.pool &&
          lower(e.tokenIn) === swap.tokenIn && lower(e.tokenOut) === swap.tokenOut);
        if (!edge) return { logIndex: trigger.logIndex, mutationOnlyReason: "mooniswap direction absent from admitted graph" };
        // Swapped reports pool-side confirmed input/output, not independent net
        // receiver receipt. No local V2 reserve application is declared.
        return { logIndex: trigger.logIndex, impact: { pool: swap.pool, tokenIn: swap.tokenIn, tokenOut: swap.tokenOut,
          amountIn: swap.amountIn, amountOut: swap.amountOut, matchedAdapterId: MOONISWAP_ACTION,
          poolToken0: BigInt(swap.tokenIn) < BigInt(swap.tokenOut) ? swap.tokenIn : swap.tokenOut,
          poolToken1: BigInt(swap.tokenIn) < BigInt(swap.tokenOut) ? swap.tokenOut : swap.tokenIn } };
      });
    },
  }),
  victimSupport: "detect-only",
  poolMaterialization: { patternIds: [SWAPPED_ID], candidateBinding({ observation }) {
    const swap = observation.kind === "log" ? decodeSwapped(observation) : null;
    return swap ? { pool: swap.pool, tokenIn: swap.tokenIn, tokenOut: swap.tokenOut } : null;
  } },
} satisfies SwapDomainSemantics<MooniswapDescriptor, MooniswapRoute>;
