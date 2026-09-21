import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const ELLA_ID = familyId("ella-exchange");
export const ELLA_LINEAGE = lineageId("ella-exchange:native-base-v1");
export const ellaManifest = {
  familyId: ELLA_ID, domain: "swap", supportedLineages: [ELLA_LINEAGE],
  ownedActionAdapterIds: ["ella-buy-token", "ella-sell-token"],
  requiredInfraActionAdapterIds: ["erc20-approve", "weth-withdraw-amount", "weth-deposit-value"],
  allowedTaxonomy: [{ slotKind: "swap" }], poolAdapterIds: ["ella-exchange"],
  edgeAdapterIds: ["ella-buy-token", "ella-sell-token"], requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
