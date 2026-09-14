import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { angstromV4StaticBindingProjection } from "./binding.js";
import type {
  AngstromV4Descriptor,
  AngstromV4Identity,
} from "./types.js";

export const angstromV4Instance = {
  instanceKey: (identity) => instanceKey(identity.subject),
  compileDraft(identity) {
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
        // Signed payload requirements are method-specific. Empty-data quotes
        // still execute the real hook and never authorize next-block execution.
        mode: "quote-and-final-sim" as const,
        extensionBinding: identity.facts.immutableBinding.hook,
      }],
      poolId: identity.facts.poolId,
      poolKey: identity.facts.poolKey,
      immutableBinding: identity.facts.immutableBinding,
    };
  },
  finalizeDescriptor({ draft }) {
    return Object.freeze({
      ...draft,
      provenance: Object.freeze([...draft.provenance]),
      runtimeRequirements: Object.freeze([...draft.runtimeRequirements]),
      poolKey: Object.freeze({ ...draft.poolKey }),
      immutableBinding: Object.freeze({ ...draft.immutableBinding }),
    });
  },
  staticBindingProjection: angstromV4StaticBindingProjection,
} satisfies InstanceSemantics<AngstromV4Identity, AngstromV4Descriptor>;
