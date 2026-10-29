import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import { metafactoryStaticProjection } from "./binding.js";
import {
  METAFACTORY_FAMILY_ID,
  METAFACTORY_LINEAGE_ID,
} from "./manifest.js";
import type {
  MetafactoryDescriptor,
  MetafactoryIdentity,
} from "./types.js";

export const metafactoryInstance = {
  instanceKey: (identity: MetafactoryIdentity) =>
    instanceKey(lowerAddress(identity.subject)),
  compileDraft: (identity: MetafactoryIdentity) => Object.freeze({
    familyId: METAFACTORY_FAMILY_ID,
    lineageId: METAFACTORY_LINEAGE_ID,
    instanceKey: instanceKey(lowerAddress(identity.subject)),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([{
      kind: "source-state" as const,
      freshness: "pinned-block" as const,
    }]),
    target: canonicalAddress(identity.subject),
    tokenIn: canonicalAddress(identity.tokenIn),
    nativeAnchor: canonicalAddress(identity.nativeAnchor),
    deadAddress: canonicalAddress(identity.deadAddress),
    oneToken: identity.oneToken,
    codeHash: identity.codeHash.toLowerCase(),
  }),
  finalizeDescriptor: ({ draft }: { readonly draft: MetafactoryDescriptor }) =>
    draft,
  staticBindingProjection: metafactoryStaticProjection,
} satisfies InstanceSemantics<MetafactoryIdentity, MetafactoryDescriptor>;
