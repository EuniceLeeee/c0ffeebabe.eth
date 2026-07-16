import { ethers } from "ethers";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { ExactQuoteContext, ProtocolConversionAdapter } from "../route-leg-adapter.js";
import { readProtocolExternalMid } from "../mid-readers.js";
import { buildDescriptorProtocolPlan } from "./protocol-plan.js";
import { quoteGoldxMint } from "./protocol-quote.js";

export const goldxAdapter = Object.freeze({
  id: "protocol:goldx",
  kind: "protocol-conversion",
  poolAdapters: ["goldx"],
  edgeAdapterIds: ["goldx-mint"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  actionAdapterIds: ["goldx-mint", "erc20-approve"],
  readMid: readProtocolExternalMid,
  warm: { kind: "protocol-mid", priority: 0 },
  async buildEdges(pool: PoolEntry, _backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
      throw new Error(`goldx pool ${pool.address} missing fixed token metadata`);
    }
    return [{
      adapterId: "goldx-mint", target: pool.address,
      tokenIn: ethers.getAddress(pool.fixedTokenIn), tokenOut: ethers.getAddress(pool.fixedTokenOut),
      slotKind: "protocol", protocolAction: "convert", score: pool.score,
      ...deriveEdgeTaxonomy("protocol", "convert"),
    }];
  },
  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    if (!ctx.tokenIn || !ctx.tokenOut) throw new Error("goldx quote requires tokenIn/tokenOut");
    return quoteGoldxMint(ctx.state, ctx.target, ctx.tokenIn, ctx.tokenOut, ctx.amountIn);
  },
  buildPlanFragment: buildDescriptorProtocolPlan,
} satisfies ProtocolConversionAdapter);
