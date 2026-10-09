import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import { compoundCTokenStaticProjection } from "./codec.js";
import {
  CTOKEN_FAMILY_ID,
  CTOKEN_LINEAGE_ID,
} from "./manifest.js";
import type {
  CompoundCTokenDescriptor,
  CompoundCTokenIdentity,
} from "./types.js";

export const compoundCTokenInstance: InstanceSemantics<
  CompoundCTokenIdentity,
  CompoundCTokenDescriptor
> = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft: (identity) => Object.freeze({
    familyId: CTOKEN_FAMILY_ID,
    lineageId: CTOKEN_LINEAGE_ID,
    instanceKey: instanceKey(lowerAddress(identity.subject)),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([Object.freeze({
      kind: "source-state" as const,
      freshness: "pinned-block" as const,
    })]),
    market: canonicalAddress(identity.subject),
    comptroller: canonicalAddress(identity.comptroller),
    underlying: canonicalAddress(identity.underlying),
    share: canonicalAddress(identity.subject),
    decimals: identity.decimals,
    redemptionPathVerified: identity.redemptionPathVerified,
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: compoundCTokenStaticProjection,
};
