import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const EKUBO_FAMILY_ID = familyId("custom-swap:ekubo-router-v1");
export const EKUBO_LINEAGE = lineageId("ekubo:vanilla-core-pool-key-v1");
export const EKUBO_ACTION_ID = "ekubo-router-swap";
export const ekuboManifest = {
  familyId: EKUBO_FAMILY_ID, domain: "swap",
  ownedActionAdapterIds: [EKUBO_ACTION_ID], requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "swap" }], supportedLineages: [EKUBO_LINEAGE],
  poolAdapterIds: ["ekubo-core-pool-v1"], edgeAdapterIds: [EKUBO_ACTION_ID], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
