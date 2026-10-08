import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";
export const BALANCER_V2_FAMILY_ID = familyId("balancer-v2");
export const BALANCER_V2_LINEAGE = lineageId("balancer-v2:vault-registered-exact-in");
export const manifest = {
  familyId: BALANCER_V2_FAMILY_ID, domain: "swap",
  ownedActionAdapterIds: ["balancer-v2-vault-swap"], requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "swap" }], supportedLineages: [BALANCER_V2_LINEAGE],
  poolAdapterIds: ["balancer-v2"], edgeAdapterIds: ["balancer-v2-vault-swap"], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
