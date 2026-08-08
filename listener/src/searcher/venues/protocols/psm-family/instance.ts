import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { psmStaticBindingProjection } from "./binding.js";
import { PSM_GEM_TO_DAI_SCALE } from "./codec.js";
import { PSM_FAMILY_ID, PSM_LINEAGE_ID } from "./manifest.js";
import type { PsmDescriptor, PsmIdentity } from "./types.js";

export const psmInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft: (identity: PsmIdentity) => Object.freeze({
    familyId: PSM_FAMILY_ID,
    lineageId: PSM_LINEAGE_ID,
    instanceKey: instanceKey(lowerAddress(identity.subject)),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([{
      kind: "source-state" as const,
      freshness: "pinned-block" as const,
    }]),
    target: canonicalAddress(identity.subject),
    gem: canonicalAddress(identity.gem),
    dai: canonicalAddress(identity.dai),
    decimalScale: PSM_GEM_TO_DAI_SCALE,
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: psmStaticBindingProjection,
} satisfies InstanceSemantics<PsmIdentity, PsmDescriptor>;
