import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { ExactQuoteContext, ProtocolConversionAdapter } from "../route-leg-adapter.js";
import { buildDescriptorProtocolPlan } from "./protocol-plan.js";
import { quoteProtocolLeg, quoteSiloRedeem } from "./protocol-quote.js";

export const erc4626Adapter = Object.freeze({
  id: "protocol:erc4626",
  kind: "protocol-conversion",
  poolAdapters: ["erc4626"],
  edgeAdapterIds: ["erc4626-deposit", "erc4626-redeem", "erc4626-redeem-silo"],
  allowedTaxonomy: [
    { slotKind: "protocol", protocolAction: "wrap" },
    { slotKind: "protocol", protocolAction: "redeem" },
  ],
  actionAdapterIds: [
    "erc4626-deposit", "erc4626-redeem", "erc4626-redeem-silo", "erc20-approve",
  ],
  async buildEdges(pool: PoolEntry, _backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (!pool.fixedTokenIn) throw new Error(`erc4626 pool ${pool.address} missing fixedTokenIn`);
    if (pool.nonStandardRedeem) {
      if (!pool.redeemTokenOut) return [];
      return [{
        adapterId: "erc4626-redeem-silo", target: pool.address,
        tokenIn: pool.address, tokenOut: pool.redeemTokenOut,
        slotKind: "protocol", protocolAction: "redeem", score: pool.score,
        ...deriveEdgeTaxonomy("protocol", "redeem"),
      }];
    }
    return [
      {
        adapterId: "erc4626-deposit", target: pool.address,
        tokenIn: pool.fixedTokenIn, tokenOut: pool.address,
        slotKind: "protocol", protocolAction: "wrap", score: pool.score,
        ...deriveEdgeTaxonomy("protocol", "wrap"),
      },
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
  buildPlanFragment: buildDescriptorProtocolPlan,
} satisfies ProtocolConversionAdapter);
