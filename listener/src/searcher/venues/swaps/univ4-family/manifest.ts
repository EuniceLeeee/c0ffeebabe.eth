import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const UNIV4_FAMILY_ID = familyId("univ4");
export const UNIV4_MANAGER_LINEAGE_ID = lineageId(
  "univ4:pool-manager-subinstance",
);

export const univ4FamilyManifest = {
  familyId: UNIV4_FAMILY_ID,
  domain: "swap",
  ownedActionAdapterIds: [
    "univ4-unlock",
    "univ4-swap",
    "univ4-take",
    "univ4-sync",
    "univ4-settle",
    "univ4-settle-value",
  ],
  requiredInfraActionAdapterIds: [
    "erc20-transfer",
    "weth-deposit-value",
    "weth-withdraw-amount",
  ],
  allowedTaxonomy: [{ slotKind: "swap" }],
  supportedLineages: [UNIV4_MANAGER_LINEAGE_ID],
} satisfies FamilyManifest<"swap">;
