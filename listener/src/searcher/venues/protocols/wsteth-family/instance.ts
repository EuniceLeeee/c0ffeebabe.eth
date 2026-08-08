import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import {
  canonicalAddress,
  lowerAddress,
} from "../standard-family/common.js";
import { wstethStaticBindingProjection } from "./binding.js";
import { WSTETH_FAMILY_ID, WSTETH_LINEAGE_ID } from "./manifest.js";
import type { WstethDescriptor, WstethIdentity } from "./types.js";

export const wstethInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft: (identity: WstethIdentity) => Object.freeze({
    familyId: WSTETH_FAMILY_ID,
    lineageId: WSTETH_LINEAGE_ID,
    instanceKey: instanceKey(lowerAddress(identity.subject)),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([{
      kind: "source-state" as const,
      freshness: "pinned-block" as const,
    }]),
    target: canonicalAddress(identity.subject),
    steth: canonicalAddress(identity.steth),
    wsteth: canonicalAddress(identity.subject),
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: wstethStaticBindingProjection,
} satisfies InstanceSemantics<WstethIdentity, WstethDescriptor>;
