import { ADDR } from "../../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { ExactQuoteContext, PlanBuildContext, PlanFragment, ProtocolConversionAdapter } from "../route-leg-adapter.js";
import { quotePSM } from "./protocol-quote.js";

const MAX_UINT = (1n << 256n) - 1n;

export const psmAdapter = Object.freeze({
  id: "protocol:psm",
  kind: "protocol-conversion",
  poolAdapters: ["psm"],
  edgeAdapterIds: ["psm"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  actionAdapterIds: ["psm", "erc20-approve"],
  async buildEdges(pool: PoolEntry, _backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
      throw new Error(`psm pool ${pool.address} missing fixedTokenIn/Out`);
    }
    return [{
      adapterId: "psm", target: pool.address,
      tokenIn: pool.fixedTokenIn, tokenOut: pool.fixedTokenOut,
      slotKind: "protocol", protocolAction: "convert", score: pool.score,
      ...deriveEdgeTaxonomy("protocol", "convert"),
    }];
  },
  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    if (!ctx.tokenIn || !ctx.tokenOut) throw new Error("psm quote requires tokenIn/tokenOut");
    return quotePSM(ctx.state, ctx.target, ctx.tokenIn, ctx.tokenOut, ctx.amountIn);
  },
  async buildPlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
    const { edge, amountIn, amountOut } = ctx;
    const gemAmount = edge.tokenIn.toLowerCase() === ADDR.USDC.toLowerCase() ? amountIn : amountOut;
    return {
      requirements: [{ kind: "approve", token: edge.tokenIn, spender: edge.target, amount: MAX_UINT }],
      nodes: [{
        adapterId: "psm", target: edge.target,
        tokenIn: edge.tokenIn, tokenOut: edge.tokenOut,
        amount: gemAmount, params: {}, children: [],
      }],
    };
  },
} satisfies ProtocolConversionAdapter);
