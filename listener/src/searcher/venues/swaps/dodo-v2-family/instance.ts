import type {
  InstanceSemantics,
  RuntimeRequirement,
} from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "./codec.js";
import type { DodoV2Descriptor, DodoV2Identity } from "./types.js";

const DODO_RUNTIME_REQUIREMENTS = Object.freeze([
  Object.freeze({
    kind: "source-state" as const,
    freshness: "pinned-block" as const,
  }),
  Object.freeze({
    kind: "execution-actor" as const,
    role: "verified-actor" as const,
  }),
  Object.freeze({
    kind: "quote-completion" as const,
    mode: "return-data" as const,
  }),
] satisfies readonly RuntimeRequirement[]);

export const dodoV2Instance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft(identity) {
    return {
      familyId: identity.familyId,
      lineageId: identity.lineageId,
      instanceKey: instanceKey(lowerAddress(identity.subject)),
      provenance: identity.provenance,
      runtimeRequirements: DODO_RUNTIME_REQUIREMENTS,
      pool: canonicalAddress(identity.facts.pool),
      baseToken: canonicalAddress(identity.facts.baseToken),
      quoteToken: canonicalAddress(identity.facts.quoteToken),
      registryBinding: identity.facts.registryBinding,
      quoteActorBinding: identity.facts.quoteActorBinding,
    };
  },
  finalizeDescriptor({ draft }) {
    return Object.freeze({
      ...draft,
      provenance: Object.freeze([...draft.provenance]),
      runtimeRequirements: Object.freeze([...draft.runtimeRequirements]),
      registryBinding: Object.freeze({ ...draft.registryBinding }),
      quoteActorBinding: Object.freeze({ ...draft.quoteActorBinding }),
    });
  },
  staticBindingProjection: staticBindingProjection,
} satisfies InstanceSemantics<DodoV2Identity, DodoV2Descriptor>;

export function staticBindingProjection(descriptor: DodoV2Descriptor) {
  return {
    pool: descriptor.pool,
    baseToken: descriptor.baseToken,
    quoteToken: descriptor.quoteToken,
    registryBinding: {
      registry: descriptor.registryBinding.registry,
      listedPool: descriptor.registryBinding.listedPool,
    },
    quoteActorBinding: {
      actor: descriptor.quoteActorBinding.actor,
      role: descriptor.quoteActorBinding.role,
      feeSemantics: descriptor.quoteActorBinding.feeSemantics,
      querySemantics: descriptor.quoteActorBinding.querySemantics,
      inputSemantics: descriptor.quoteActorBinding.inputSemantics,
    },
  };
}
