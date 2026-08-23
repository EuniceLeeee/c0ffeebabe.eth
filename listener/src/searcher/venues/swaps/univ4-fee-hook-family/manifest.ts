import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

export const UNIV4_FEE_HOOK_FAMILY_ID = familyId("univ4-fee-hook");
export const UNIV4_FEE_HOOK_LINEAGE_ID = lineageId(
  "univ4:pool-manager-fee-hook-subinstance",
);

/**
 * The audited tiered dynamic-fee hook deployed for the retained USDC/WETH
 * dynamic-fee pools. Identity proves the pool's hook code hash equals this
 * value on-chain (chain truth, not an allowlist admission) before a pool is
 * admitted; any other hook stays fail-closed in the standard univ4 family.
 */
export const UNIV4_FEE_HOOK_ADDRESS =
  "0xfa439315b015a4c283ded9815a4af6cef0b90880";
export const UNIV4_FEE_HOOK_CODE_HASH =
  "0x95f45883ea4c59deaeb445e6fb6e07383b72a1f5cc046e3f22bfbca4f9aa521d";

export const univ4FeeHookFamilyManifest = {
  familyId: UNIV4_FEE_HOOK_FAMILY_ID,
  domain: "swap",
  ownedActionAdapterIds: [
    "univ4-fee-hook-unlock",
    "univ4-fee-hook-swap",
    "univ4-fee-hook-take",
    "univ4-fee-hook-sync",
    "univ4-fee-hook-settle",
    "univ4-fee-hook-settle-value",
  ],
  requiredInfraActionAdapterIds: [
    "erc20-transfer",
    "weth-deposit-value",
    "weth-withdraw-amount",
  ],
  allowedTaxonomy: [{ slotKind: "swap" }],
  supportedLineages: [UNIV4_FEE_HOOK_LINEAGE_ID],
  poolAdapterIds: ["univ4-fee-hook", "univ4-fee-hook-unlock"],
  edgeAdapterIds: ["univ4-fee-hook-unlock"],
  requiresProtocolEdgesFlag: false,
  livePoolStateKind: "singleton-v4",
} satisfies FamilyManifest<"swap">;
