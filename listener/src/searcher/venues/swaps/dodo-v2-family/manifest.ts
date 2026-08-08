import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const DODO_V2_FAMILY_ID = familyId("custom-swap:dodo-v2");
export const DODO_V2_REGISTRY_LINEAGE_ID = lineageId(
  "dodo-v2:registry-member",
);

export const dodoV2FamilyManifest = {
  familyId: DODO_V2_FAMILY_ID,
  domain: "swap",
  ownedActionAdapterIds: ["dodo-v2-swap"],
  requiredInfraActionAdapterIds: ["erc20-transfer"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  supportedLineages: [DODO_V2_REGISTRY_LINEAGE_ID],
} satisfies FamilyManifest<"swap">;
