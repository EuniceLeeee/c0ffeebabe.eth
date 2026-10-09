import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const FAMILY = familyId("protocol:set-redemption");
export const LINEAGE = lineageId("set-redemption:basic-issuance-0.7.6");
export const ACTION = "set-basic-redeem";
export const LEGACY_LINEAGE = lineageId("set-redemption:legacy-core-0.5.7");
export const LEGACY_ACTION = "set-legacy-core-redeem";
export const manifest = {
  familyId: FAMILY, domain: "protocol", ownedActionAdapterIds: [ACTION, LEGACY_ACTION],
  requiredInfraActionAdapterIds: ["assert-balance"], supportedLineages: [LINEAGE, LEGACY_LINEAGE],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  poolAdapterIds: ["set-redemption"], edgeAdapterIds: [ACTION, LEGACY_ACTION], requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
