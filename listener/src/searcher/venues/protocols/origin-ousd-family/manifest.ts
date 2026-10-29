import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const ORIGIN_OUSD_FAMILY_ID = familyId("protocol:origin-ousd");
export const ORIGIN_OUSD_LINEAGE_ID = lineageId("origin-ousd-vault");
export const ORIGIN_OUSD_ACTION_ID = "origin-ousd-mint";

export const originOusdFamilyManifest = {
  familyId: ORIGIN_OUSD_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: [ORIGIN_OUSD_ACTION_ID],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  supportedLineages: [ORIGIN_OUSD_LINEAGE_ID],
  // Provenance label only. The OUSD vault is not part of the file-backed pool
  // universe; admission is the proxy/implementation proof in identity.ts.
  poolAdapterIds: ["origin-ousd"],
  edgeAdapterIds: [ORIGIN_OUSD_ACTION_ID],
  requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"protocol">;
