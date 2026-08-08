import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress } from "./codec.js";
import type { UniV2Descriptor, UniV2Identity } from "./types.js";

export const univ2Instance = {
  instanceKey: (identity) => instanceKey(canonicalAddress(identity.subject).toLowerCase()),
  compileDraft(identity) {
    return {
      familyId: identity.familyId,
      lineageId: identity.lineageId,
      instanceKey: instanceKey(canonicalAddress(identity.subject).toLowerCase()),
      provenance: identity.provenance,
      runtimeRequirements: [],
      pool: identity.facts.pool,
      token0: identity.facts.token0,
      token1: identity.facts.token1,
      feeRule: identity.facts.feeRule,
      factoryBinding: identity.facts.factoryBinding,
    };
  },
  finalizeDescriptor({ draft }) {
    return Object.freeze({
      ...draft,
      provenance: Object.freeze([...draft.provenance]),
      runtimeRequirements: Object.freeze([...draft.runtimeRequirements]),
      feeRule: Object.freeze({ ...draft.feeRule }),
      factoryBinding: Object.freeze({ ...draft.factoryBinding }),
    });
  },
  staticBindingProjection: (descriptor) => ({
    pool: descriptor.pool,
    token0: descriptor.token0,
    token1: descriptor.token1,
    feeRule: {
      kind: descriptor.feeRule.kind,
      feeBps: descriptor.feeRule.feeBps,
      evidence: descriptor.feeRule.evidence,
    },
    factoryBinding: {
      factory: descriptor.factoryBinding.factory,
      reversePool: descriptor.factoryBinding.reversePool,
    },
  }),
} satisfies InstanceSemantics<UniV2Identity, UniV2Descriptor>;
