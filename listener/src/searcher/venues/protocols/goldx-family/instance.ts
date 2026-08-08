import { ADDR } from "../../../../shared/constants/addresses.js";
import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { goldxStaticBindingProjection } from "./binding.js";
import { GOLDX_FAMILY_ID, GOLDX_LINEAGE_ID } from "./manifest.js";
import type { GoldxDescriptor, GoldxIdentity } from "./types.js";

export const goldxInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft: (identity) => Object.freeze({
    familyId: GOLDX_FAMILY_ID,
    lineageId: GOLDX_LINEAGE_ID,
    instanceKey: instanceKey(lowerAddress(identity.subject)),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([{
      kind: "source-state" as const,
      freshness: "pinned-block" as const,
    }]),
    target: canonicalAddress(identity.subject),
    collateral: canonicalAddress(ADDR.PAXG),
    receipt: canonicalAddress(ADDR.GOLDX),
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: goldxStaticBindingProjection,
} satisfies InstanceSemantics<GoldxIdentity, GoldxDescriptor>;
