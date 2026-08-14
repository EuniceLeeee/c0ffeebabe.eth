import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const GOLDX_FAMILY_ID = familyId("protocol:goldx");
export const GOLDX_LINEAGE_ID = lineageId("goldx:active-unit-mint");

export const goldxFamilyManifest = {
  familyId: GOLDX_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: ["goldx-mint"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  supportedLineages: [GOLDX_LINEAGE_ID],
  poolAdapterIds: ["goldx"],
  requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
