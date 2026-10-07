import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const FAMILY = familyId("protocol:set-redemption");
export const LINEAGE = lineageId("set-redemption:basic-issuance-0.7.6");
export const ACTION = "set-basic-redeem";
export const manifest = {
  familyId: FAMILY, domain: "protocol", ownedActionAdapterIds: [ACTION],
  requiredInfraActionAdapterIds: ["assert-balance"], supportedLineages: [LINEAGE],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  poolAdapterIds: ["set-redemption"], edgeAdapterIds: [ACTION], requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
