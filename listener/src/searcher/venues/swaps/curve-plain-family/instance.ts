import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { lower } from "./codec.js";
import type { CurvePlainDescriptor, CurvePlainIdentity } from "./types.js";

export function staticBinding(descriptor: CurvePlainDescriptor) {
  return {
    pool: descriptor.pool,
    binding: { ...descriptor.binding, coins: [...descriptor.binding.coins], decimals: [...descriptor.binding.decimals],
      handlers: [...descriptor.binding.handlers] },
    directions: descriptor.directions.map(({ i, j, tokenIn, tokenOut, executionMode }) =>
      ({ i, j, tokenIn, tokenOut, executionMode, quoteAbi: descriptor.binding.quoteAbi })),
  };
}
export const curvePlainInstance = {
  instanceKey: identity => instanceKey(lower(identity.subject)),
  compileDraft(identity) {
    return { familyId: identity.familyId, lineageId: identity.lineageId,
      instanceKey: instanceKey(lower(identity.subject)), provenance: identity.provenance,
      runtimeRequirements: [{ kind: "source-state" as const, freshness: "pinned-block" as const },
        { kind: "quote-completion" as const, mode: "return-data" as const }],
      ...identity.facts };
  },
  finalizeDescriptor: ({ draft }) => Object.freeze({ ...draft,
    binding: Object.freeze({ ...draft.binding, coins: Object.freeze([...draft.binding.coins]),
      decimals: Object.freeze([...draft.binding.decimals]), handlers: Object.freeze([...draft.binding.handlers]) }),
    directions: Object.freeze(draft.directions.map(item => Object.freeze({ ...item }))),
  }),
  staticBindingProjection: staticBinding,
} satisfies InstanceSemantics<CurvePlainIdentity, CurvePlainDescriptor>;
