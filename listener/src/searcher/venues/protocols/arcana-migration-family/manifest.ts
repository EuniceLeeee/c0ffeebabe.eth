import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const FAMILY = familyId("protocol:arcana-migration");
export const LINEAGE = lineageId("arcana-migration:v1");

export const manifest = {
  familyId: FAMILY,
  domain: "protocol",
  ownedActionAdapterIds: ["arcana-migration"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  supportedLineages: [LINEAGE],
  poolAdapterIds: ["arcana-migration"],
  edgeAdapterIds: ["arcana-migration"],
  requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
