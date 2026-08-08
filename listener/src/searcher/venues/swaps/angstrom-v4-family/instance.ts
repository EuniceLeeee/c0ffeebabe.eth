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
        freshness: "tx-bound" as const,
      }, {
        kind: "head-evidence" as const,
        scope: "family" as const,
        evidenceKind: "angstrom-empty-block-attestation",
      }, {
        kind: "extension-policy" as const,
        mode: "tx-bound" as const,
        extensionBinding: identity.facts.immutableBinding.hook,
      }, {
        kind: "opaque-payload" as const,
        slot: "unlockData",
        evidenceKind: "angstrom-empty-block-attestation",
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
