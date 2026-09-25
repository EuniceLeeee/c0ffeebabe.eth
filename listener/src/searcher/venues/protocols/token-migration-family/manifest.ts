import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const FAMILY = familyId("protocol:token-migration");
export const LINEAGE = lineageId("token-migration:mantle-solc-0.8.13-v1");
export const manifest = {
  familyId: FAMILY, domain: "protocol", ownedActionAdapterIds: ["token-migration"],
  requiredInfraActionAdapterIds: [], supportedLineages: [LINEAGE],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  poolAdapterIds: ["token-migration"], edgeAdapterIds: ["token-migration"], requiresProtocolEdgesFlag: true,
} satisfies FamilyManifest<"protocol">;
