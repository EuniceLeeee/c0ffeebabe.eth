import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const ROCKSOLID_FAMILY_ID = familyId("protocol:rocksolid");
export const ROCKSOLID_LINEAGE_ID = lineageId(
  "rocksolid:active-sync-deposit",
);

export const rocksolidFamilyManifest = {
  familyId: ROCKSOLID_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: ["rocksolid-sync-deposit"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "wrap" }],
  supportedLineages: [ROCKSOLID_LINEAGE_ID],
  poolAdapterIds: ["rocksolid"],
  requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
