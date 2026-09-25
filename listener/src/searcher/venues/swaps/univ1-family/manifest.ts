import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const ID = familyId("custom-swap:uniswap-v1");
export const LINEAGE = lineageId("uniswap-v1:anyswap-issuer-fee");
export const ACTION = "univ1-exact-input";
export const manifest = {
  familyId: ID, domain: "swap", ownedActionAdapterIds: [ACTION], requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "swap" }], supportedLineages: [LINEAGE],
  poolAdapterIds: ["univ1-exchange"], edgeAdapterIds: [ACTION], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
