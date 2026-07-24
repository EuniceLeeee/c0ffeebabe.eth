import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type {
  ExactQuoteContext,
  PreparedRouteContext,
  ProtocolConversionAdapter,
} from "../route-leg-adapter.js";
import { buildDescriptorProtocolPlan } from "./protocol-plan.js";
import { quoteGoldxMint } from "./protocol-quote.js";
import {
  createProtocolQuoteStateCapability,
  decodeUintResult,
} from "./protocol-state-framework.js";

const goldxIface = new ethers.Interface(["function unit() view returns (uint256)"]);
const GOLDX_WAD = 10n ** 18n;

const goldxPricingState = createProtocolQuoteStateCapability({
  familyId: "protocol:goldx",
  edgeAdapterIds: ["goldx-mint"],
  buildQuoteReads(edge) {
    return [{
      suffix: "unit",
      to: edge.target,
      data: goldxIface.encodeFunctionData("unit"),
    }];
  },
  deriveAmountOut(_edge, amountIn, result) {
    const unit = decodeUintResult(goldxIface, "unit", result("unit"));
    return amountIn * unit / GOLDX_WAD;
  },
});

export const goldxAdapter = Object.freeze({
  id: "protocol:goldx",
  kind: "protocol-conversion",
  poolAdapters: ["goldx"],
  identityPolicies: [{ poolAdapter: "goldx", policy: "trusted-singleton-seed" }],
  declaredVenues: [{
    address: ADDR.GOLDX,
    adapter: "goldx",
    venueId: "goldx",
    identitySource: "seed",
    fixedTokenIn: ADDR.PAXG,
    fixedTokenOut: ADDR.GOLDX,
    fixedSlotKind: "protocol",
    fixedProtocolAction: "convert",
  }],
  undeclaredVenueReason: null,
  edgeAdapterIds: ["goldx-mint"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  requiresProtocolEdgesFlag: true,
  ownedActionAdapterIds: ["goldx-mint"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  pricingState: goldxPricingState,
  prepared: {
    quote: async (ctx: PreparedRouteContext) => {
      const started = Date.now();
      const amountOut = await quoteGoldxMint(
        { call: async ({ to, data }) => (await ctx.callPrepared(to, data)).output },
        ctx.request.target,
        ctx.request.tokenIn,
        ctx.request.tokenOut,
        ctx.request.amountIn,
      );
      return { amountOut, latencyMs: Date.now() - started };
    },
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => [{
      from: ethers.ZeroAddress,
      to: ctx.request.target,
      calldata: goldxIface.encodeFunctionData("unit"),
      gasLimit: 300_000,
    }],
    allowanceSpender: () => null,
    prewarmAddresses: () => [],
  },
  async buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
    if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
      throw new Error(`goldx pool ${pool.address} missing fixed token metadata`);
    }
    // GOLDx exposes no collateral-token view, so the pair stays code-owned;
    // attest the one identity-bearing view the mint quote depends on.
    const raw = await backend.call({ to: pool.address, data: goldxIface.encodeFunctionData("unit") });
    const unit = BigInt(goldxIface.decodeFunctionResult("unit", raw)[0]);
    if (unit <= 0n) {
      throw new Error(`goldx identity attestation failed: ${pool.address} unit() = ${unit}`);
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
