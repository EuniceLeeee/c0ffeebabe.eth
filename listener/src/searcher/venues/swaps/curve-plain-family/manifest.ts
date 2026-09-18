import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const CURVE_PLAIN_FAMILY_ID = familyId("curve-plain");
export const CURVE_PLAIN_LINEAGE = lineageId("curve-plain:registry-direct-coin-behavior");
export const curvePlainManifest = {
  familyId: CURVE_PLAIN_FAMILY_ID,
  domain: "swap",
  ownedActionAdapterIds: ["curve-exchange", "curve-exchange-nr", "curve-exchange-plain", "curve-exchange-received-uint"],
  requiredInfraActionAdapterIds: ["erc20-transfer", "erc20-approve"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  supportedLineages: [CURVE_PLAIN_LINEAGE],
  poolAdapterIds: ["curve", "curve-nr", "curve-plain"],
  edgeAdapterIds: ["curve-exchange", "curve-exchange-nr", "curve-exchange-plain", "curve-exchange-received-uint"],
  requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
