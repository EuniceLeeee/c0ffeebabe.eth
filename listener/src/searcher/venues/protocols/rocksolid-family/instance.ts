import { ADDR } from "../../../../shared/constants/addresses.js";
import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { rocksolidStaticBindingProjection } from "./binding.js";
import {
  ROCKSOLID_FAMILY_ID,
  ROCKSOLID_LINEAGE_ID,
} from "./manifest.js";
import type { RocksolidDescriptor, RocksolidIdentity } from "./types.js";

export const rocksolidInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft: (identity) => Object.freeze({
    familyId: ROCKSOLID_FAMILY_ID,
    lineageId: ROCKSOLID_LINEAGE_ID,
    instanceKey: instanceKey(lowerAddress(identity.subject)),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([{
      kind: "source-state" as const,
      freshness: "pinned-block" as const,
    }]),
    target: canonicalAddress(identity.subject),
    asset: canonicalAddress(ADDR.RETH),
    receipt: canonicalAddress(identity.subject),
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: rocksolidStaticBindingProjection,
} satisfies InstanceSemantics<RocksolidIdentity, RocksolidDescriptor>;
