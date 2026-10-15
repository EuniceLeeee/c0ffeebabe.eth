import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const ID = familyId("custom-swap:precision-pool");
export const LINEAGE = lineageId("precision-pool:direct-zero-hook-v1");
export const ACTION = "precision-pool-swap";
export const manifest = {
  familyId: ID, domain: "swap", ownedActionAdapterIds: [ACTION], requiredInfraActionAdapterIds: [],
  supportedLineages: [LINEAGE], allowedTaxonomy: [{ slotKind: "swap" }],
  poolAdapterIds: ["precision-pool"], edgeAdapterIds: [ACTION], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
