import { ADDR } from "../../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { ExactQuoteContext, ProtocolConversionAdapter } from "../route-leg-adapter.js";
import { buildDescriptorProtocolPlan } from "./protocol-plan.js";
import { quoteProtocolLeg } from "./protocol-quote.js";

export const wstethAdapter = Object.freeze({
  id: "protocol:wsteth",
  kind: "protocol-conversion",
  poolAdapters: ["wsteth"],
  edgeAdapterIds: ["wsteth-wrap", "wsteth-unwrap"],
  allowedTaxonomy: [
    { slotKind: "protocol", protocolAction: "wrap" },
    { slotKind: "protocol", protocolAction: "unwrap" },
  ],
  actionAdapterIds: ["wsteth-wrap", "wsteth-unwrap", "erc20-approve"],
  async buildEdges(pool: PoolEntry, _backend: TokenQueryBackend): Promise<TokenEdge[]> {
    return [
      {
        adapterId: "wsteth-wrap", target: pool.address,
        tokenIn: ADDR.STETH, tokenOut: ADDR.WSTETH,
        slotKind: "protocol", protocolAction: "wrap", score: pool.score,
        ...deriveEdgeTaxonomy("protocol", "wrap"),
      },
      {
        adapterId: "wsteth-unwrap", target: pool.address,
        tokenIn: ADDR.WSTETH, tokenOut: ADDR.STETH,
        slotKind: "protocol", protocolAction: "unwrap", score: pool.score,
        ...deriveEdgeTaxonomy("protocol", "unwrap"),
      },
    ];
  },
  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    return quoteProtocolLeg(ctx.state, ctx.target, ctx.edgeAdapterId, ctx.amountIn);
  },
  buildPlanFragment: buildDescriptorProtocolPlan,
} satisfies ProtocolConversionAdapter);
