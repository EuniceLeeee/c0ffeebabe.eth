import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const FAMILY = familyId("protocol:peapods-debond");
export const LINEAGE = lineageId("peapods:weighted-single-asset-v1");
export const ACTION = "peapods-debond";
export const manifest = {
  familyId: FAMILY, domain: "protocol", ownedActionAdapterIds: [ACTION], requiredInfraActionAdapterIds: [],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }], supportedLineages: [LINEAGE],
  poolAdapterIds: [ACTION], edgeAdapterIds: [ACTION], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"protocol">;
