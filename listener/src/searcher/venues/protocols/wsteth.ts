import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { ExactQuoteContext, ProtocolConversionAdapter } from "../route-leg-adapter.js";
import { buildDescriptorProtocolPlan } from "./protocol-plan.js";
import { quoteProtocolLeg } from "./protocol-quote.js";
import {
  createProtocolQuoteStateCapability,
  decodeUintResult,
} from "./protocol-state-framework.js";

const wstethIface = new ethers.Interface([
  "function stETH() view returns (address)",
  "function getWstETHByStETH(uint256 stETHAmount) view returns (uint256)",
  "function getStETHByWstETH(uint256 wstETHAmount) view returns (uint256)",
]);

const wstethPricingState = createProtocolQuoteStateCapability({
  familyId: "protocol:wsteth",
  edgeAdapterIds: ["wsteth-wrap", "wsteth-unwrap"],
  addressTouchCarryPolicy: "dependency-touch",
  buildQuoteReads(edge, amountIn) {
    const functionName = edge.adapterId === "wsteth-wrap"
      ? "getWstETHByStETH"
      : "getStETHByWstETH";
    return [{
      suffix: functionName,
      to: edge.target,
      data: wstethIface.encodeFunctionData(functionName, [amountIn]),
    }];
  },
  deriveAmountOut(edge, _amountIn, result) {
    const functionName = edge.adapterId === "wsteth-wrap"
      ? "getWstETHByStETH"
      : "getStETHByWstETH";
    return decodeUintResult(wstethIface, functionName, result(functionName));
  },
});

export const wstethAdapter = Object.freeze({
  id: "protocol:wsteth",
  kind: "protocol-conversion",
  poolAdapters: ["wsteth"],
  identityPolicies: [{ poolAdapter: "wsteth", policy: "trusted-singleton-seed" }],
  declaredVenues: [{
    address: ADDR.WSTETH,
    adapter: "wsteth",
  }],
  undeclaredVenueReason: null,
  edgeAdapterIds: ["wsteth-wrap", "wsteth-unwrap"],
  allowedTaxonomy: [
    { slotKind: "protocol", protocolAction: "wrap" },
    { slotKind: "protocol", protocolAction: "unwrap" },
  ],
  requiresProtocolEdgesFlag: true,
  ownedActionAdapterIds: ["wsteth-wrap", "wsteth-unwrap"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  pricingState: wstethPricingState,
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
