import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { olympusStaticBindingProjection } from "./binding.js";
import { OLYMPUS_FAMILY_ID, OLYMPUS_LINEAGE_ID } from "./manifest.js";
import type { OlympusDescriptor, OlympusIdentity } from "./types.js";

export const olympusInstance = {
  instanceKey: (identity: OlympusIdentity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft: (identity: OlympusIdentity) => Object.freeze({
    familyId: OLYMPUS_FAMILY_ID,
    lineageId: OLYMPUS_LINEAGE_ID,
    instanceKey: instanceKey(lowerAddress(identity.subject)),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([{
      kind: "source-state" as const,
      freshness: "pinned-block" as const,
    }]),
    // `index` is mutable per-block state owned by pricing/exact reads, not a
    // descriptor constant.
    staking: canonicalAddress(identity.subject),
    gOHM: canonicalAddress(identity.gOHM),
    OHM: canonicalAddress(identity.OHM),
    gOhmDecimals: identity.gOhmDecimals,
    ohmDecimals: identity.ohmDecimals,
  }),
  finalizeDescriptor: ({ draft }: { readonly draft: OlympusDescriptor }) => draft,
  staticBindingProjection: olympusStaticBindingProjection,
} satisfies InstanceSemantics<OlympusIdentity, OlympusDescriptor>;
