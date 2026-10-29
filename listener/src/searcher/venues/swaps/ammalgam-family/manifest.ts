import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const ID = familyId("custom-swap:ammalgam");
export const LINEAGE = lineageId("ammalgam:pair-beacon-v1");
export const ACTION = "ammalgam-swap";
export const manifest = {
  familyId: ID,
  domain: "swap",
  ownedActionAdapterIds: [ACTION],
  requiredInfraActionAdapterIds: [],
  supportedLineages: [LINEAGE],
  allowedTaxonomy: [{ slotKind: "swap" }],
  poolAdapterIds: ["ammalgam"],
  edgeAdapterIds: [ACTION],
  requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
