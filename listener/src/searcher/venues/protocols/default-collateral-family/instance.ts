import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import {
  canonicalAddress,
  lowerAddress,
  sameAddress,
} from "../standard-family/common.js";
import { defaultCollateralStaticBindingProjection } from "./binding.js";
import {
  DEFAULT_COLLATERAL_ASSET,
  DEFAULT_COLLATERAL_DECIMALS,
} from "./codec.js";
import {
  DEFAULT_COLLATERAL_FAMILY_ID,
  DEFAULT_COLLATERAL_LINEAGE_ID,
} from "./manifest.js";
import type {
  DefaultCollateralDescriptor,
  DefaultCollateralIdentity,
} from "./types.js";

export const defaultCollateralInstance = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft: (identity: DefaultCollateralIdentity) => {
    if (!sameAddress(identity.asset, DEFAULT_COLLATERAL_ASSET)) {
      throw new Error(
        "default-collateral identity asset is not the verified swETH deployment",
      );
    }
    if (identity.decimals !== DEFAULT_COLLATERAL_DECIMALS) {
      throw new Error("default-collateral identity decimals are not 18");
    }
    if (!identity.oneToOne) {
      throw new Error(
        "default-collateral identity does not prove the 1:1 redeem rate",
      );
    }
    if (!sameAddress(identity.share, identity.subject)) {
      throw new Error("default-collateral share token is not the vault");
    }
    return Object.freeze({
      familyId: DEFAULT_COLLATERAL_FAMILY_ID,
      lineageId: DEFAULT_COLLATERAL_LINEAGE_ID,
      instanceKey: instanceKey(lowerAddress(identity.subject)),
      provenance: identity.provenance,
      runtimeRequirements: Object.freeze([{
        kind: "source-state" as const,
        freshness: "pinned-block" as const,
      }]),
      vault: canonicalAddress(identity.subject),
      share: canonicalAddress(identity.share),
      asset: canonicalAddress(identity.asset),
      implementation: canonicalAddress(identity.implementation),
      shareCodeHash: identity.shareCodeHash.toLowerCase(),
      implementationCodeHash: identity.implementationCodeHash.toLowerCase(),
      assetCodeHash: identity.assetCodeHash.toLowerCase(),
      decimals: identity.decimals,
    });
  },
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: defaultCollateralStaticBindingProjection,
} satisfies InstanceSemantics<
  DefaultCollateralIdentity,
  DefaultCollateralDescriptor
>;
