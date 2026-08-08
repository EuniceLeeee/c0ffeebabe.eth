import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import { erc4626StaticProjection } from "./binding.js";
import {
  ERC4626_FAMILY_ID,
  ERC4626_LINEAGE_ID,
} from "./manifest.js";
import type { Erc4626Descriptor, Erc4626Identity } from "./types.js";

export const erc4626Instance: InstanceSemantics<
  Erc4626Identity,
  Erc4626Descriptor
> = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft: (identity) => Object.freeze({
    familyId: ERC4626_FAMILY_ID,
    lineageId: ERC4626_LINEAGE_ID,
    instanceKey: instanceKey(lowerAddress(identity.subject)),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([Object.freeze({
      kind: "source-state" as const,
      freshness: "pinned-block" as const,
    })]),
    vault: canonicalAddress(identity.subject),
    asset: canonicalAddress(identity.asset),
    share: canonicalAddress(identity.subject),
    verifiedDirections: Object.freeze({ ...identity.verifiedDirections }),
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: erc4626StaticProjection,
};
