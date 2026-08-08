import type {
  InstanceSemantics,
  RuntimeRequirement,
} from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { astraStaticBindingProjection } from "./binding.js";
import { canonicalAddress, lowerAddress } from "./codec.js";
import type {
  AstraMultiTokenDescriptor,
  AstraMultiTokenIdentity,
} from "./types.js";

const ASTRA_RUNTIME_REQUIREMENTS = Object.freeze([
  Object.freeze({
    kind: "source-state" as const,
    freshness: "pinned-block" as const,
  }),
  Object.freeze({
    kind: "execution-actor" as const,
    role: "executor" as const,
  }),
  Object.freeze({
    kind: "quote-completion" as const,
    mode: "return-data" as const,
  }),
  Object.freeze({
    kind: "effect-observation" as const,
    effects: Object.freeze(["token-delta" as const, "logs" as const]),
  }),
] satisfies readonly RuntimeRequirement[]);

export const astraMultiTokenInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft(identity) {
    return {
      familyId: identity.familyId,
      lineageId: identity.lineageId,
      instanceKey: instanceKey(lowerAddress(identity.subject)),
      provenance: identity.provenance,
      runtimeRequirements: ASTRA_RUNTIME_REQUIREMENTS,
      target: canonicalAddress(identity.facts.target),
      registryBinding: identity.facts.registryBinding,
      behaviorBinding: identity.facts.behaviorBinding,
    };
  },
  finalizeDescriptor({ draft }) {
    return Object.freeze({
      ...draft,
      provenance: Object.freeze([...draft.provenance]),
      runtimeRequirements: Object.freeze([...draft.runtimeRequirements]),
      registryBinding: Object.freeze({
        ...draft.registryBinding,
        tokens: Object.freeze([...draft.registryBinding.tokens]),
        tokenWeights: Object.freeze(draft.registryBinding.tokenWeights.map(
          (binding) => Object.freeze({ ...binding }),
        )),
      }),
      behaviorBinding: Object.freeze({ ...draft.behaviorBinding }),
    });
  },
  staticBindingProjection,
} satisfies InstanceSemantics<
  AstraMultiTokenIdentity,
  AstraMultiTokenDescriptor
>;

export function staticBindingProjection(
  descriptor: AstraMultiTokenDescriptor,
) {
  return astraStaticBindingProjection(descriptor);
}
