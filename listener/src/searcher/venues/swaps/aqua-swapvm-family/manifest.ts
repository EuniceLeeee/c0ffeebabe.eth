import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const ID = familyId("aqua-swapvm");
export const LINEAGE = lineageId("aqua-swapvm:v1-concentrated-xyc");
export const ACTION = "aqua-swapvm-swap";
export const manifest = {
  familyId: ID, domain: "swap", ownedActionAdapterIds: [ACTION], requiredInfraActionAdapterIds: [],
  allowedTaxonomy: [{ slotKind: "swap" }], supportedLineages: [LINEAGE],
  poolAdapterIds: ["aqua-swapvm"], edgeAdapterIds: [ACTION], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
