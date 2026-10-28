import type { FamilyManifest } from "../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../adapter-family-identifiers.js";

/**
 * KyberSwap Elastic (concentrated liquidity, reinvestment-token pools).
 *
 * The pools are EIP-1167 clones whose contract IS the ERC20 "KyberSwap v2
 * Reinvestment Token"; the fee is `swapFeeUnits()` (not `fee()`) and the spacing
 * is `tickDistance()` (not `tickSpacing()`), which is why the Uniswap-V3 family
 * binder never resolved these pools. This family owns exactly two routed
 * directions, both EXACT INPUT:
 *
 *   - `token0-in` (`isToken0 = true`), `token1-in` (`isToken0 = false`).
 *
 * The source proves `isExactInput = swapQty > 0` and `willUpTick = (isExactInput
 * != isToken0)`; for a NEGATIVE `swapQty` the same `isToken0` flag denotes the
 * exact-output token instead of the input token, so `isToken0` is NOT UniV3's
 * `zeroForOne`. Exact-output (`swapQty < 0`) is therefore not a routed variant:
 * it is never admitted, rather than admitted and then declined at runtime.
 */
export const KYSWAP_FAMILY_ID = familyId("kyberswap-elastic");
export const KYSWAP_LINEAGE_ID = lineageId(
  "kyberswap-elastic:factory-getpool-child",
);
export const KYSWAP_SWAP_ACTION = "kyberswap-elastic-swap";

export const kyberswapElasticManifest = {
  familyId: KYSWAP_FAMILY_ID,
  domain: "swap",
  ownedActionAdapterIds: [KYSWAP_SWAP_ACTION],
  requiredInfraActionAdapterIds: ["erc20-transfer"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  supportedLineages: [KYSWAP_LINEAGE_ID],
  poolAdapterIds: ["kyberswap-elastic"],
  edgeAdapterIds: [KYSWAP_SWAP_ACTION],
  requiresProtocolEdgesFlag: false,
} satisfies FamilyManifest<"swap">;
