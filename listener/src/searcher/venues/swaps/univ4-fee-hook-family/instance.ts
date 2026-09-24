import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { graphCurrency } from "../univ4-family/codec.js";
import { uniV4StaticBindingProjection } from "../univ4-family/binding.js";
import {
  UNIV4_FEE_HOOK_LINEAGE_ID,
} from "./manifest.js";
import type { FeeHookDescriptor, FeeHookIdentity } from "./types.js";

export const univ4FeeHookInstance = {
  instanceKey: (identity) => instanceKey(identity.subject),
  compileDraft(identity) {
    const graphToken0 = graphCurrency(identity.facts.poolKey.currency0);
    const graphToken1 = graphCurrency(identity.facts.poolKey.currency1);
    if (graphToken0.toLowerCase() === graphToken1.toLowerCase()) {
      throw new Error("univ4 fee-hook PoolKey currencies collapse");
    }
    return {
      familyId: identity.familyId,
      lineageId: UNIV4_FEE_HOOK_LINEAGE_ID,
      instanceKey: instanceKey(identity.subject),
      provenance: identity.provenance,
      runtimeRequirements: [{
        kind: "source-state" as const,
        freshness: "pinned-block" as const,
      }, {
        kind: "extension-policy" as const,
        mode: identity.facts.hookModel === "sat1" ? "quote-and-final-sim" as const : "proven-transparent" as const,
        extensionBinding: identity.facts.poolKey.hooks,
      }],
      poolId: identity.facts.poolId,
      poolKey: identity.facts.poolKey,
      graphToken0,
      graphToken1,
      managerBinding: identity.facts.managerBinding,
      hookPolicy: "fee-hook" as const,
      hook: identity.facts.poolKey.hooks,
      ...(identity.facts.hookModel === "sat1" ? { hookModel: "sat1" as const } : {}),
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
  staticBindingProjection: descriptor => ({ base: uniV4StaticBindingProjection(descriptor), hookModel: descriptor.hookModel ?? "fee" }),
} satisfies InstanceSemantics<FeeHookIdentity, FeeHookDescriptor>;
