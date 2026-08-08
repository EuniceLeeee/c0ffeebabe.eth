import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { uniV3StaticBindingProjection } from "./binding.js";
import { canonicalAddress } from "./codec.js";
import type { UniV3Descriptor, UniV3Identity } from "./types.js";

export const univ3Instance = {
  instanceKey: (identity) =>
    instanceKey(canonicalAddress(identity.subject).toLowerCase()),
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
      fee: identity.facts.fee,
      tickSpacing: identity.facts.tickSpacing,
      factoryBinding: identity.facts.factoryBinding,
      quoterBinding: identity.facts.quoterBinding,
    };
  },
  finalizeDescriptor({ draft }) {
    return Object.freeze({
      ...draft,
      provenance: Object.freeze([...draft.provenance]),
      runtimeRequirements: Object.freeze([...draft.runtimeRequirements]),
      factoryBinding: Object.freeze({ ...draft.factoryBinding }),
      quoterBinding: Object.freeze({ ...draft.quoterBinding }),
    });
  },
  staticBindingProjection: uniV3StaticBindingProjection,
} satisfies InstanceSemantics<UniV3Identity, UniV3Descriptor>;
