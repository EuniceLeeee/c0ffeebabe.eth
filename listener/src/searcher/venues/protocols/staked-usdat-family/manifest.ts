import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const STAKED_USDAT_FAMILY_ID = familyId("protocol:staked-usdat");
export const STAKED_USDAT_LINEAGE_ID = lineageId("staked-usdat:source-bound-deposit");
export const stakedUsdatFamilyManifest: FamilyManifest<"protocol"> = Object.freeze({
  familyId: STAKED_USDAT_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: Object.freeze(["staked-usdat-deposit"]),
  requiredInfraActionAdapterIds: Object.freeze(["erc20-approve"]),
  allowedTaxonomy: Object.freeze([Object.freeze({ slotKind: "protocol" as const, protocolAction: "wrap" as const })]),
  supportedLineages: Object.freeze([STAKED_USDAT_LINEAGE_ID]),
  poolAdapterIds: Object.freeze(["staked-usdat"]),
  edgeAdapterIds: Object.freeze(["staked-usdat-deposit"]),
  requiresProtocolEdgesFlag: true,
});
