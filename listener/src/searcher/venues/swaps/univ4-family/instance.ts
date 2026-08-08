import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { graphCurrency } from "./codec.js";
import { uniV4StaticBindingProjection } from "./binding.js";
import type { UniV4Descriptor, UniV4Identity } from "./types.js";

export const univ4Instance = {
  instanceKey: (identity) => instanceKey(identity.subject),
  compileDraft(identity) {
    const graphToken0 = graphCurrency(identity.facts.poolKey.currency0);
    const graphToken1 = graphCurrency(identity.facts.poolKey.currency1);
    if (graphToken0.toLowerCase() === graphToken1.toLowerCase()) {
      throw new Error("univ4 PoolKey currencies collapse to one graph token");
    }
    return {
      familyId: identity.familyId,
      lineageId: identity.lineageId,
      instanceKey: instanceKey(identity.subject),
      provenance: identity.provenance,
      runtimeRequirements: [{
        kind: "source-state" as const,
        freshness: "pinned-block" as const,
      }, {
        kind: "extension-policy" as const,
        mode: "proven-transparent" as const,
        extensionBinding: identity.facts.poolKey.hooks,
      }],
      poolId: identity.facts.poolId,
      poolKey: identity.facts.poolKey,
      graphToken0,
      graphToken1,
      managerBinding: identity.facts.managerBinding,
      hookPolicy: "no-hook" as const,
    };
  },
  finalizeDescriptor({ draft }) {
    return Object.freeze({
      ...draft,
      provenance: Object.freeze([...draft.provenance]),
      runtimeRequirements: Object.freeze([...draft.runtimeRequirements]),
      poolKey: Object.freeze({ ...draft.poolKey }),
      managerBinding: Object.freeze({ ...draft.managerBinding }),
    });
  },
  staticBindingProjection: uniV4StaticBindingProjection,
} satisfies InstanceSemantics<UniV4Identity, UniV4Descriptor>;
