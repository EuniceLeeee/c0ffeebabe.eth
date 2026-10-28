import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const ID = familyId("custom-swap:oneswap");
export const LINEAGE = lineageId("oneswap:amm-orderbook-v1");
export const ACTION = "oneswap-market-order";
export const manifest = {
  familyId: ID, domain: "swap", ownedActionAdapterIds: [ACTION], requiredInfraActionAdapterIds: [],
  supportedLineages: [LINEAGE], allowedTaxonomy: [{ slotKind: "swap" }],
  poolAdapterIds: ["oneswap"], edgeAdapterIds: [ACTION], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
