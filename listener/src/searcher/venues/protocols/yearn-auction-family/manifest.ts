import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const FAMILY = familyId("protocol:yearn-auction");
export const LINEAGE = lineageId("yearn-auction:clone-1.0.4");
export const ACTION = "yearn-auction";
export const manifest = { familyId: FAMILY, domain: "protocol", ownedActionAdapterIds: [ACTION], requiredInfraActionAdapterIds: [],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }], supportedLineages: [LINEAGE],
  poolAdapterIds: [ACTION], edgeAdapterIds: [ACTION], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"protocol">;
