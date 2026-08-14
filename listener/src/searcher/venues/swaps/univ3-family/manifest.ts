import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const UNIV3_FAMILY_ID = familyId("univ3-standard");
export const UNIV3_FACTORY_LINEAGE_ID = lineageId("univ3:factory-child");

export const univ3FamilyManifest = {
  familyId: UNIV3_FAMILY_ID,
  domain: "swap",
  ownedActionAdapterIds: ["univ3-swap"],
  requiredInfraActionAdapterIds: ["erc20-transfer"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  supportedLineages: [UNIV3_FACTORY_LINEAGE_ID],
  poolAdapterIds: ["univ3"],
} satisfies FamilyManifest<"swap">;
