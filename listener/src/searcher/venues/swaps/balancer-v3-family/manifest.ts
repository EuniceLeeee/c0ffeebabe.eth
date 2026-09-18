import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const BALANCER_V3_FAMILY_ID = familyId("balancer-v3");
export const BALANCER_V3_LINEAGE = lineageId("balancer-v3:vault-registered-pool");
export const balancerV3Manifest = {
  familyId: BALANCER_V3_FAMILY_ID, domain: "swap",
  ownedActionAdapterIds: ["balancer-v3-router-swap"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  allowedTaxonomy: [{ slotKind: "swap" }], supportedLineages: [BALANCER_V3_LINEAGE],
  poolAdapterIds: ["balancer-v3"], edgeAdapterIds: ["balancer-v3-router-swap"], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
