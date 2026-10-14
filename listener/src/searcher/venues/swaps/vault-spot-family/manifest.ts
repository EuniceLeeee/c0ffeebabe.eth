import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const ID = familyId("vault-spot");
export const LINEAGE = lineageId("vault-spot:gmx-v1-abi");
export const ACTION = "vault-spot-swap";
export const manifest = {
  familyId: ID, domain: "swap", ownedActionAdapterIds: [ACTION], requiredInfraActionAdapterIds: [],
  allowedTaxonomy: [{ slotKind: "swap" }], supportedLineages: [LINEAGE],
  poolAdapterIds: ["vault-spot"], edgeAdapterIds: [ACTION], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
