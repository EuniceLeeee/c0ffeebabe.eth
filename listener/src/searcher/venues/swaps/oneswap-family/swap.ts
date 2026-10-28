import type { SwapDomainSemantics } from "../../adapter-family-plugin.js";
import { createStrictSwapObservation } from "../../swap-observation.js";
import { POOL } from "./codec.js";
import { decodeEvent, EVENTS } from "./discovery.js";
import type { Descriptor, Route } from "./types.js";
export const swap = {
  landedEvents: { patternIds: EVENTS.map(n => `oneswap-${n}`), classify: ({ observation: o }) => o.kind === "log" && decodeEvent(o) ? "swap" : null },
  observation: { patternIds: EVENTS.map(n => `oneswap-${n}`), decode({ observation: o }) {
    const e = o.kind === "log" ? decodeEvent(o) : null;
    return e ? [{ kind: "swap", canonicalPayload: { ...e } }] : [];
  } },
  // DealWithPool is gross AMM output, not total fee-adjusted taker receipt;
  // never manufacture a V2 impact from one of several partial fill events.
  receiptObservation: createStrictSwapObservation({ topics: EVENTS.map(n => POOL.getEvent(n)!.topicHash), canonicalIntakeTargets: [],
    observedPoolIdentity: log => decodeEvent(log) ? log.address.toLowerCase() : null,
    async decodeSwapImpacts(ctx) { return ctx.matchedOwnedTriggers.map(t => ({ logIndex: t.logIndex,
      mutationOnlyReason: "oneswap partial fill events require chain replay; refresh the complete AMM/orderbook state" })); },
  }),
  victimSupport: "detect-only",
} satisfies SwapDomainSemantics<Descriptor, Route>;
