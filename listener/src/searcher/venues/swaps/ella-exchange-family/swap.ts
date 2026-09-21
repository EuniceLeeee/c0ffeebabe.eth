import type { SwapDomainSemantics } from "../../adapter-family-plugin.js";
import { BOUGHT_ID, BOUGHT_TOPIC, decodeBought } from "./discovery.js";
import type { EllaDescriptor, EllaRoute } from "./types.js";
// The shared Bought event does not identify the token variant nor net output.
// It nominates/touches the instance, but is not a fabricated directional impact.
export const ellaSwap = {
  landedEvents: { patternIds: [BOUGHT_ID], classify: ({ observation }) => decodeBought(observation) ? "swap" : null },
  observation: { patternIds: [BOUGHT_ID], decode: () => [] },
  receiptObservation: {
    topics: [BOUGHT_TOPIC], canonicalIntakeTargets: [],
    observedPoolIdentity: log => log.topics.length === 1 && log.topics[0]?.toLowerCase() === BOUGHT_TOPIC.toLowerCase() ? log.address.toLowerCase() : null,
    async decodeReceiptImpacts({ matchedOwnedTriggers }) {
      return matchedOwnedTriggers.length === 0 ? { status: "no-match" } :
        { status: "unresolved", reason: "ella Bought needs call context to distinguish token variant and net output" };
    },
  },
  victimSupport: "detect-only",
  poolMaterialization: { patternIds: [BOUGHT_ID], candidateBinding: ({ observation }) => decodeBought(observation) },
} satisfies SwapDomainSemantics<EllaDescriptor, EllaRoute>;
