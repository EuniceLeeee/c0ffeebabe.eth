import { ethers } from "ethers";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { ExactQuoteContext, ProtocolConversionAdapter } from "../route-leg-adapter.js";
import { readProtocolExternalMid } from "../mid-readers.js";
import { buildDescriptorProtocolPlan } from "./protocol-plan.js";
import { quoteProtocolLeg } from "./protocol-quote.js";

export const rocksolidAdapter = Object.freeze({
  id: "protocol:rocksolid",
  kind: "protocol-conversion",
  poolAdapters: ["rocksolid"],
  edgeAdapterIds: ["rocksolid-sync-deposit"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "wrap" }],
  actionAdapterIds: ["rocksolid-sync-deposit", "erc20-approve"],
  readMid: readProtocolExternalMid,
  warm: { kind: "protocol-mid", priority: 2 },
  async buildEdges(pool: PoolEntry, _backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (!pool.fixedTokenIn) throw new Error(`rocksolid pool ${pool.address} missing fixedTokenIn`);
    return [{
      adapterId: "rocksolid-sync-deposit", target: ethers.getAddress(pool.address),
      tokenIn: ethers.getAddress(pool.fixedTokenIn), tokenOut: ethers.getAddress(pool.address),
      slotKind: "protocol", protocolAction: "wrap", score: pool.score,
      ...deriveEdgeTaxonomy("protocol", "wrap"),
    }];
  },
  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    return quoteProtocolLeg(ctx.state, ctx.target, ctx.edgeAdapterId, ctx.amountIn);
  },
  buildPlanFragment: buildDescriptorProtocolPlan,
} satisfies ProtocolConversionAdapter);
