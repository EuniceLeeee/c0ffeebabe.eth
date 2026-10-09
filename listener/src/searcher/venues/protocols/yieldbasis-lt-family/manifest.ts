import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

/**
 * Yield Basis LT single-asset crypto redemption. This family owns exactly one
 * routed action: burn LT shares for the LT's own ASSET_TOKEN (WETH / cbBTC /
 * WBTC), the direction implemented by `withdraw(uint256 shares, uint256
 * min_assets)`.
 *
 * `deposit(uint256,uint256,uint256[,address])` is deliberately NOT routed: it
 * takes TWO inputs (the crypto asset plus the borrowed stablecoin), so it is a
 * leveraged position mint, not a single-leg conversion.
 *
 * `emergency_withdraw(uint256[,address[,address]])` is deliberately NOT routed:
 * it returns a tuple `(uint256 assets, int256 stables)` whose second member is
 * SIGNED. LT-1 (yb-WETH) returned `-11522880896743474386578` at its
 * representative transaction, i.e. the caller had to bring stablecoins IN, and
 * LT-2 returned `+10130059459396459764578` (stablecoins OUT). The LT source
 * states it "does not necessarily work as single asset withdrawal" and
 * specifies no minimal output. A one-tokenIn/one-tokenOut route cannot express
 * either branch, so the entry point is excluded before route projection and is
 * covered by family-local negative contracts instead.
 *
 * Keeper/reward/admin surfaces (`allocate_stablecoins`,
 * `checkpoint_staker_rebase`, `distribute_borrower_fees`,
 * `withdraw_admin_fees`, `set_*`) are outside this family entirely.
 */
export const YIELDBASIS_FAMILY_ID = familyId("protocol:yieldbasis-lt");
export const YIELDBASIS_LINEAGE_ID = lineageId(
  "yieldbasis:levamm-bound-single-asset-withdraw",
);
export const YIELDBASIS_WITHDRAW_ACTION = "yieldbasis-lt-withdraw";

export const yieldBasisLtManifest: FamilyManifest<"protocol"> = Object.freeze({
  familyId: YIELDBASIS_FAMILY_ID,
  domain: "protocol",
  ownedActionAdapterIds: Object.freeze([YIELDBASIS_WITHDRAW_ACTION]),
  requiredInfraActionAdapterIds: Object.freeze(["erc20-approve"]),
  allowedTaxonomy: Object.freeze([
    Object.freeze({
      slotKind: "protocol" as const,
      protocolAction: "redeem" as const,
    }),
  ]),
  supportedLineages: Object.freeze([YIELDBASIS_LINEAGE_ID]),
  poolAdapterIds: Object.freeze(["yieldbasis-lt"]),
  edgeAdapterIds: Object.freeze([YIELDBASIS_WITHDRAW_ACTION]),
  requiresProtocolEdgesFlag: true,
});
