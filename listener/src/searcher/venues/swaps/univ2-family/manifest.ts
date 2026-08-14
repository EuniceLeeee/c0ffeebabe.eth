import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const UNIV2_FAMILY_ID = familyId("univ2-standard");
export const UNIV2_FACTORY_LINEAGE_ID = lineageId("univ2:factory-child");

export const univ2FamilyManifest = {
  familyId: UNIV2_FAMILY_ID,
  domain: "swap",
  ownedActionAdapterIds: ["univ2-swap"],
  requiredInfraActionAdapterIds: ["erc20-transfer"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  supportedLineages: [UNIV2_FACTORY_LINEAGE_ID],
  poolAdapterIds: ["univ2"],
} satisfies FamilyManifest<"swap">;
