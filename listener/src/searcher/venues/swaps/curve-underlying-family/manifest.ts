import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const CURVE_UNDERLYING_FAMILY_ID = familyId("curve-underlying");
export const CURVE_UNDERLYING_REGISTRY_LINEAGE_ID = lineageId(
  "curve-underlying:metaregistry-member",
);

export const CURVE_UNDERLYING_FACTORY_LINEAGE_ID = lineageId(
  "curve-underlying:legacy-factory-member",
);

export const CURVE_UNDERLYING_V1_FACTORY_LINEAGE_ID = lineageId("curve-underlying:factory-v1-member");

export const CURVE_UNDERLYING_LENDING_LINEAGE_ID = lineageId("curve-underlying:legacy-lending-lp-reverse");

export const curveUnderlyingFamilyManifest = {
  familyId: CURVE_UNDERLYING_FAMILY_ID,
  domain: "swap",
  ownedActionAdapterIds: ["curve-exchange-underlying", "curve-exchange-underlying-uint-native", "curve-exchange-underlying-lending"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  supportedLineages: [CURVE_UNDERLYING_REGISTRY_LINEAGE_ID, CURVE_UNDERLYING_FACTORY_LINEAGE_ID, CURVE_UNDERLYING_V1_FACTORY_LINEAGE_ID, CURVE_UNDERLYING_LENDING_LINEAGE_ID],
  poolAdapterIds: ["curve-underlying"],
  edgeAdapterIds: ["curve-exchange-underlying", "curve-exchange-underlying-uint-native", "curve-exchange-underlying-lending"],
  requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
