import type { InstanceSemantics } from "../../adapter-family-plugin.js";
import { instanceKey } from "../../adapter-family-identifiers.js";
import { canonicalAddress, lowerAddress } from "../standard-family/common.js";
import { yieldBasisLtStaticProjection } from "./codec.js";
import {
  YIELDBASIS_FAMILY_ID,
  YIELDBASIS_LINEAGE_ID,
} from "./manifest.js";
import type {
  YieldBasisLtDescriptor,
  YieldBasisLtIdentity,
} from "./types.js";

export const yieldBasisLtInstance: InstanceSemantics<
  YieldBasisLtIdentity,
  YieldBasisLtDescriptor
> = {
  instanceKey: (identity) => instanceKey(lowerAddress(identity.subject)),
  compileDraft: (identity) => Object.freeze({
    familyId: YIELDBASIS_FAMILY_ID,
    lineageId: YIELDBASIS_LINEAGE_ID,
    instanceKey: instanceKey(lowerAddress(identity.subject)),
    provenance: identity.provenance,
    runtimeRequirements: Object.freeze([Object.freeze({
      kind: "source-state" as const,
      freshness: "pinned-block" as const,
    })]),
    lt: canonicalAddress(identity.subject),
    share: canonicalAddress(identity.subject),
    asset: canonicalAddress(identity.asset),
    stablecoin: canonicalAddress(identity.stablecoin),
    cryptopool: canonicalAddress(identity.cryptopool),
    amm: canonicalAddress(identity.amm),
    agg: canonicalAddress(identity.agg),
    staker: canonicalAddress(identity.staker),
    admin: canonicalAddress(identity.admin),
    decimals: identity.decimals,
    assetDecimals: identity.assetDecimals,
    assetCoinIndex: identity.assetCoinIndex,
    redemptionPathVerified: identity.redemptionPathVerified,
  }),
  finalizeDescriptor: ({ draft }) => draft,
  staticBindingProjection: yieldBasisLtStaticProjection,
};
