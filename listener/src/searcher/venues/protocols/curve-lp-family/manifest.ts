import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const FAMILY = familyId("protocol:curve-lp");
export const LINEAGE = lineageId("curve-lp:stableswap2-18-6-v031");
export const NG_LINEAGE = lineageId("curve-lp:registry-stableswap-ng");
export const GENERIC_LINEAGE = lineageId("curve-lp:registry-fixed-array");
export const ZAP_LINEAGE = lineageId("curve-lp:registry-underlying-zap");
export const ACTION = "curve-lp";
export const manifest = { familyId: FAMILY, domain: "protocol", ownedActionAdapterIds: [ACTION], requiredInfraActionAdapterIds: [],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }], supportedLineages: [LINEAGE, NG_LINEAGE, GENERIC_LINEAGE, ZAP_LINEAGE],
  poolAdapterIds: [ACTION], edgeAdapterIds: [ACTION], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"protocol">;
