import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const FAMILY = familyId("protocol:curve-lp");
export const LINEAGE = lineageId("curve-lp:stableswap2-18-6-v031");
export const ACTION = "curve-lp";
export const manifest = { familyId: FAMILY, domain: "protocol", ownedActionAdapterIds: [ACTION], requiredInfraActionAdapterIds: [],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }], supportedLineages: [LINEAGE],
  poolAdapterIds: [ACTION], edgeAdapterIds: [ACTION], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"protocol">;
