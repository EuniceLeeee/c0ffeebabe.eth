import type { SwapDomainSemantics } from "../../adapter-family-plugin.js";
import { createStrictSwapObservation } from "../../swap-observation.js";
import { POOL } from "./codec.js";
import { decodeEvent } from "./discovery.js";
import type { Descriptor, Route } from "./types.js";
export const swap = {
  landedEvents: { patternIds: ["precision-pool-Swap"], classify: ({ observation: o }) => o.kind === "log" && decodeEvent(o)?.name === "Swap" ? "swap" : null },
  observation: { patternIds: ["precision-pool-Swap"], decode({ observation: o }) {
    const e = o.kind === "log" ? decodeEvent(o) : null;
    return e?.name === "Swap" ? [{ kind: "swap", canonicalPayload: { ...e.payload } }] : [];
  } },
  receiptObservation: createStrictSwapObservation({ topics: [POOL.getEvent("Swap")!.topicHash], canonicalIntakeTargets: [],
    observedPoolIdentity: log => decodeEvent(log)?.name === "Swap" ? log.address.toLowerCase() : null,
    async decodeSwapImpacts(ctx) { return ctx.matchedOwnedTriggers.map(t => ({ logIndex: t.logIndex,
      mutationOnlyReason: "PrecisionPool LP-supply/virtual-reserve transition requires chain replay; refresh complete state" })); },
  }),
  victimSupport: "detect-only",
} satisfies SwapDomainSemantics<Descriptor, Route>;
