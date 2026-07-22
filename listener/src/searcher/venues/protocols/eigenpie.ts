import { ethers } from "ethers";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type {
  ExactQuoteContext,
  PreparedRouteContext,
  ProtocolConversionAdapter,
} from "../route-leg-adapter.js";
import { readProtocolExternalMid } from "../mid-readers.js";
import {
  pairInstanceId,
  EIGENPIE_DEPOSIT_EDGE_ADAPTER,
  EIGENPIE_POOL_ADAPTER,
  eigenpieDiscovery,
  eigenpieIdentityResolver,
  eigenpieIface,
  quoteEigenpieDeposit,
} from "./eigenpie-discovery.js";
import {
  buildReceiptDepositEdge,
  buildReceiptDepositPlanFragment,
  requireVerifiedReceiptDepositRoute,
} from "./receipt-deposit-framework.js";

export const eigenpieAdapter = Object.freeze({
  id: "protocol:eigenpie",
  kind: "protocol-conversion",
  poolAdapters: [EIGENPIE_POOL_ADAPTER],
  declaredVenues: [],
  undeclaredVenueReason:
    "instances require observed interaction plus pair-scoped identity and nonzero simulation",
  discovery: eigenpieDiscovery,
  discoveryIdentityResolver: eigenpieIdentityResolver,
  edgeAdapterIds: [EIGENPIE_DEPOSIT_EDGE_ADAPTER],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "wrap" }],
  actionAdapterIds: [EIGENPIE_DEPOSIT_EDGE_ADAPTER, "erc20-approve"],
  requiresProtocolEdgesFlag: true,
  readMid: readProtocolExternalMid,
  warm: {
    kind: "protocol-mid",
    priority: 2,
    async quotePrewarm(ctx: ExactQuoteContext): Promise<bigint> {
      if (!ctx.tokenIn || !ctx.tokenOut) {
        throw new Error("Eigenpie deposit prewarm requires tokenIn/tokenOut");
      }
      return quoteEigenpieDeposit(
        ctx.state,
        ctx.target,
        ctx.tokenIn,
        ctx.tokenOut,
        ctx.amountIn,
      );
    },
  },
  prepared: {
    quote: async (ctx: PreparedRouteContext) => {
      const started = Date.now();
      const amountOut = await quoteEigenpieDeposit(
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
      calldata: eigenpieIface.encodeFunctionData("getMLRTAmountToMint", [
        ctx.request.tokenIn,
        ctx.request.amountIn,
      ]),
      gasLimit: 300_000,
    }],
    allowanceSpender: (request) => request.target,
    prewarmAddresses: (request) => [request.target, request.tokenIn, request.tokenOut],
  },

  async buildEdges(pool: PoolEntry, backend: TokenQueryBackend): Promise<TokenEdge[]> {
    const tokenIn = ethers.getAddress(pool.fixedTokenIn ?? ethers.ZeroAddress);
    const tokenOut = ethers.getAddress(pool.fixedTokenOut ?? ethers.ZeroAddress);
    const pair = requireVerifiedReceiptDepositRoute({
      pool,
      edgeAdapterId: EIGENPIE_DEPOSIT_EDGE_ADAPTER,
      logicalInstanceId: pairInstanceId(tokenIn, tokenOut),
    });
    await quoteEigenpieDeposit(
      { call: ({ to, data }) => backend.call({ to, data }) },
      pool.address,
      pair.asset,
      pair.receipt,
      0n,
    );
    return [buildReceiptDepositEdge({
      edgeAdapterId: EIGENPIE_DEPOSIT_EDGE_ADAPTER,
      target: pool.address,
      asset: pair.asset,
      receipt: pair.receipt,
      score: pool.score,
    })];
  },

  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    if (!ctx.tokenIn || !ctx.tokenOut) {
      throw new Error("Eigenpie deposit quote requires tokenIn/tokenOut");
    }
    return quoteEigenpieDeposit(
      ctx.state,
      ctx.target,
      ctx.tokenIn,
      ctx.tokenOut,
      ctx.amountIn,
    );
  },

  async buildPlanFragment(ctx) {
    // Eigenpie keeps an exact allowance; the shared framework only owns the
    // approval/asset->receipt shape, not this family-specific allowance policy.
    return buildReceiptDepositPlanFragment(ctx, {
      allowance: "exact",
      params: { minAmountOut: ctx.amountOut },
    });
  },
} satisfies ProtocolConversionAdapter);
