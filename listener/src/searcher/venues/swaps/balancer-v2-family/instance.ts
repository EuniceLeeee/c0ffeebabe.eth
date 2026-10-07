import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import type { BalancerV2Descriptor, BalancerV2Identity } from "./types.js";
export function staticBinding(d: BalancerV2Descriptor) {
  return { pool: d.pool, poolId: d.poolId, binding: { ...d.binding, tokens: [...d.binding.tokens], decimals: [...d.binding.decimals] } };
}
export const instance = {
  instanceKey: i => instanceKey(i.facts.poolId),
  compileDraft(i) { return { familyId: i.familyId, lineageId: i.lineageId, instanceKey: instanceKey(i.facts.poolId),
    provenance: i.provenance, runtimeRequirements: [{ kind: "source-state" as const, freshness: "pinned-block" as const },
      { kind: "quote-completion" as const, mode: "return-data" as const }], ...i.facts }; },
  finalizeDescriptor: ({ draft }) => Object.freeze({ ...draft, proofSource: Object.freeze({ ...draft.proofSource }),
    binding: Object.freeze({ ...draft.binding, tokens: Object.freeze([...draft.binding.tokens]), decimals: Object.freeze([...draft.binding.decimals]) }) }),
  staticBindingProjection: staticBinding,
} satisfies InstanceSemantics<BalancerV2Identity, BalancerV2Descriptor>;
