import { ethers } from "ethers";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { ExactQuoteContext, ProtocolConversionAdapter } from "../route-leg-adapter.js";
import { readProtocolExternalMid } from "../mid-readers.js";
import { buildDescriptorProtocolPlan } from "./protocol-plan.js";
import { quoteProtocolLeg, quoteSiloRedeem } from "./protocol-quote.js";
import { erc4626Discovery } from "./erc4626-discovery.js";
import { erc4626IdentityResolver } from "../identity.js";
import {
  buildReceiptDepositEdge,
  buildReceiptDepositPlanFragment,
} from "./receipt-deposit-framework.js";

const erc4626Iface = new ethers.Interface(["function asset() view returns (address)"]);

export const erc4626Adapter = Object.freeze({
  id: "protocol:erc4626",
  kind: "protocol-conversion",
  poolAdapters: ["erc4626"],
  declaredVenues: [],
  undeclaredVenueReason: "ERC4626 instances require external discovery and per-vault probe admission",
  discovery: erc4626Discovery,
  discoveryIdentityResolver: erc4626IdentityResolver,
  edgeAdapterIds: ["erc4626-deposit", "erc4626-redeem", "erc4626-redeem-silo"],
  allowedTaxonomy: [
    { slotKind: "protocol", protocolAction: "wrap" },
    { slotKind: "protocol", protocolAction: "redeem" },
  ],
  requiresProtocolEdgesFlag: true,
  actionAdapterIds: [
    "erc4626-deposit", "erc4626-redeem", "erc4626-redeem-silo", "erc20-approve",
  ],
  readMid: readProtocolExternalMid,
  warm: { kind: "protocol-mid", priority: 2 },
  prepared: null,
  async buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (pool.nonStandardRedeem) {
      // fixedTokenIn feeds no edge here and silo payout semantics are verified
      // at the fork-receipt level, so no asset() attestation on this branch.
      if (!pool.redeemTokenOut) return [];
      return [{
        adapterId: "erc4626-redeem-silo", target: pool.address,
        tokenIn: pool.address, tokenOut: pool.redeemTokenOut,
        slotKind: "protocol", protocolAction: "redeem", score: pool.score,
        ...deriveEdgeTaxonomy("protocol", "redeem"),
      }];
    }
    // Discovery-owned instance: emit EXACTLY the probe-verified routes. The
    // generic builder can no longer regrow a leg the probe rejected, and the
    // asset() pin is re-attested for every emitted leg.
    if (pool.verifiedRoutes) {
      const raw = await backend.call({ to: pool.address, data: erc4626Iface.encodeFunctionData("asset") });
      const reported = String(erc4626Iface.decodeFunctionResult("asset", raw)[0]).toLowerCase();
      return pool.verifiedRoutes.map((route) => {
        const asset = route.protocolAction === "wrap" ? route.tokenIn : route.tokenOut;
        if (asset.toLowerCase() !== reported) {
          throw new Error(
            `erc4626 verified route asset drift: ${pool.address} reports ${reported}, route asset ${asset}`,
          );
        }
        if (route.edgeAdapterId === "erc4626-deposit") {
          return buildReceiptDepositEdge({
            edgeAdapterId: route.edgeAdapterId,
            target: pool.address,
            asset: route.tokenIn,
            receipt: route.tokenOut,
            score: pool.score,
          });
        }
        return {
          adapterId: route.edgeAdapterId, target: pool.address,
          tokenIn: route.tokenIn, tokenOut: route.tokenOut,
          slotKind: route.slotKind, score: pool.score,
          ...(route.protocolAction === undefined ? {} : { protocolAction: route.protocolAction }),
          ...deriveEdgeTaxonomy(route.slotKind, route.protocolAction),
        };
      });
    }
    // Legacy compat path (no discovery evidence): only reachable by a
    // non-discovery seed/harness. previewDeposit/previewRedeem quotes are
    // denominated in asset(); a vault whose asset drifts from the registry pin
    // must fail edge build.
    if (!pool.fixedTokenIn) throw new Error(`erc4626 pool ${pool.address} missing fixedTokenIn`);
    const raw = await backend.call({ to: pool.address, data: erc4626Iface.encodeFunctionData("asset") });
    const reported = String(erc4626Iface.decodeFunctionResult("asset", raw)[0]);
    if (reported.toLowerCase() !== pool.fixedTokenIn.toLowerCase()) {
      throw new Error(
        `erc4626 identity attestation failed: ${pool.address} reports asset ${reported}, pinned ${pool.fixedTokenIn}`,
      );
    }
    return [
      buildReceiptDepositEdge({
        edgeAdapterId: "erc4626-deposit",
        target: pool.address,
        asset: pool.fixedTokenIn,
        receipt: pool.address,
        score: pool.score,
      }),
      {
        adapterId: "erc4626-redeem", target: pool.address,
        tokenIn: pool.address, tokenOut: pool.fixedTokenIn,
        slotKind: "protocol", protocolAction: "redeem", score: pool.score,
        ...deriveEdgeTaxonomy("protocol", "redeem"),
      },
    ];
  },
  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    if (ctx.edgeAdapterId === "erc4626-redeem-silo") {
      if (!ctx.tokenOut) throw new Error("erc4626 silo quote requires tokenOut");
      return quoteSiloRedeem(ctx.state, ctx.target, ctx.tokenOut, ctx.amountIn);
    }
    return quoteProtocolLeg(ctx.state, ctx.target, ctx.edgeAdapterId, ctx.amountIn);
  },
  async buildPlanFragment(ctx) {
    if (ctx.edge.adapterId === "erc4626-deposit") {
      // Preserve the existing MAX_UINT allowance policy; the framework shares
      // the approval/plan shape without owning family-specific allowance rules.
      return buildReceiptDepositPlanFragment(ctx, { allowance: "max" });
    }
    return buildDescriptorProtocolPlan(ctx);
  },
} satisfies ProtocolConversionAdapter);
