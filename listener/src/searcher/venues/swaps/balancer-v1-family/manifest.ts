import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const ID = familyId("balancer-v1");
export const LINEAGE = lineageId("balancer-v1:finalized-bpool");
export const ACTION = "balancer-v1-swap";
export const manifest = {
  familyId: ID, domain: "swap", ownedActionAdapterIds: [ACTION], requiredInfraActionAdapterIds: [],
  allowedTaxonomy: [{ slotKind: "swap" }], supportedLineages: [LINEAGE],
  poolAdapterIds: ["balancer-v1"], edgeAdapterIds: [ACTION], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
