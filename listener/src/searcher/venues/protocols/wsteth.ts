import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { ExactQuoteContext, ProtocolConversionAdapter } from "../route-leg-adapter.js";
import { readProtocolExternalMid } from "../mid-readers.js";
import { buildDescriptorProtocolPlan } from "./protocol-plan.js";
import { quoteProtocolLeg } from "./protocol-quote.js";

const wstethIface = new ethers.Interface(["function stETH() view returns (address)"]);

export const wstethAdapter = Object.freeze({
  id: "protocol:wsteth",
  kind: "protocol-conversion",
  poolAdapters: ["wsteth"],
  declaredVenues: [{
    address: ADDR.WSTETH,
    adapter: "wsteth",
    graphOrder: 2,
  }],
  undeclaredVenueReason: null,
  edgeAdapterIds: ["wsteth-wrap", "wsteth-unwrap"],
  allowedTaxonomy: [
    { slotKind: "protocol", protocolAction: "wrap" },
    { slotKind: "protocol", protocolAction: "unwrap" },
  ],
  requiresProtocolEdgesFlag: true,
  actionAdapterIds: ["wsteth-wrap", "wsteth-unwrap", "erc20-approve"],
  readMid: readProtocolExternalMid,
  warm: { kind: "protocol-mid", priority: 1 },
  prepared: null,
  async buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
    // The declared singleton is a hypothesis until the venue's own interface
    // confirms it: a wrong pin must fail edge build, not surface in the sim.
    const raw = await backend.call({
      to: pool.address,
      data: wstethIface.encodeFunctionData("stETH"),
    });
    const reported = String(wstethIface.decodeFunctionResult("stETH", raw)[0]);
    if (reported.toLowerCase() !== ADDR.STETH.toLowerCase()) {
      throw new Error(`wsteth identity attestation failed: ${pool.address} reports stETH ${reported}`);
    }
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
