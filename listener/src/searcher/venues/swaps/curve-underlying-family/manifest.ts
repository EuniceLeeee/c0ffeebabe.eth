import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const CURVE_UNDERLYING_FAMILY_ID = familyId("curve-underlying");
export const CURVE_UNDERLYING_REGISTRY_LINEAGE_ID = lineageId(
  "curve-underlying:metaregistry-member",
);

export const curveUnderlyingFamilyManifest = {
  familyId: CURVE_UNDERLYING_FAMILY_ID,
  domain: "swap",
  ownedActionAdapterIds: ["curve-exchange-underlying"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  supportedLineages: [CURVE_UNDERLYING_REGISTRY_LINEAGE_ID],
  poolAdapterIds: ["curve-underlying"],
} satisfies FamilyManifest<"swap">;
