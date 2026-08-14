import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const PSM_FAMILY_ID = familyId("protocol:psm");
export const PSM_LINEAGE_ID = lineageId("psm:lite-active-pair");

export const psmFamilyManifest = {
  familyId: PSM_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: ["psm"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  supportedLineages: [PSM_LINEAGE_ID],
  poolAdapterIds: ["psm"],
  requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"protocol">;
