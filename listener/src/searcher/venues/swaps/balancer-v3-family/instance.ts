import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { lower } from "./codec.js";
import type { BalancerV3Descriptor, BalancerV3Identity } from "./types.js";

export function staticBinding(descriptor: BalancerV3Descriptor) {
  return { pool: descriptor.pool, binding: { ...descriptor.binding, tokens: [...descriptor.binding.tokens],
    decimals: [...descriptor.binding.decimals], tokenInfo: descriptor.binding.tokenInfo.map(info => ({ ...info })),
    hooks: { ...descriptor.binding.hooks, flags: [...descriptor.binding.hooks.flags] } } };
}
export const balancerV3Instance = {
  instanceKey: identity => instanceKey(lower(identity.subject)),
  compileDraft(identity) {
    return { familyId: identity.familyId, lineageId: identity.lineageId,
      instanceKey: instanceKey(lower(identity.subject)), provenance: identity.provenance,
      runtimeRequirements: [{ kind: "source-state" as const, freshness: "pinned-block" as const },
        { kind: "quote-completion" as const, mode: "return-data" as const }], ...identity.facts };
  },
  finalizeDescriptor: ({ draft }) => Object.freeze({ ...draft, proofSource: Object.freeze({ ...draft.proofSource }),
    binding: Object.freeze({ ...draft.binding, hooks: Object.freeze({ ...draft.binding.hooks, flags: Object.freeze([...draft.binding.hooks.flags]) }), tokens: Object.freeze([...draft.binding.tokens]),
      decimals: Object.freeze([...draft.binding.decimals]), tokenInfo: Object.freeze(draft.binding.tokenInfo.map(info => Object.freeze({ ...info }))) }) }),
  staticBindingProjection: staticBinding,
} satisfies InstanceSemantics<BalancerV3Identity, BalancerV3Descriptor>;
