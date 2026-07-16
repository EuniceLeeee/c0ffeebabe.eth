import { ADDR } from "../../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type {
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  ProtocolConversionAdapter,
} from "../route-leg-adapter.js";
import { readProtocolExternalMid } from "../mid-readers.js";
import { quotePSM, quotePSMSellGemPrewarm } from "./protocol-quote.js";

const MAX_UINT = (1n << 256n) - 1n;

export const psmAdapter = Object.freeze({
  id: "protocol:psm",
  kind: "protocol-conversion",
  poolAdapters: ["psm"],
  edgeAdapterIds: ["psm"],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }],
  actionAdapterIds: ["psm", "erc20-approve"],
  readMid: readProtocolExternalMid,
  warm: {
    kind: "protocol-mid",
    priority: 0,
    async quotePrewarm(ctx: ExactQuoteContext): Promise<bigint> {
      if (!ctx.tokenIn || !ctx.tokenOut) throw new Error("psm prewarm requires tokenIn/tokenOut");
      return quotePSMSellGemPrewarm(
        ctx.state, ctx.target, ctx.tokenIn, ctx.tokenOut, ctx.amountIn,
      );
    },
  },
  prepared: {
    quote: async (ctx: PreparedRouteContext) => ({
      amountOut: quotePreparedPSM(
        ctx.request.tokenIn,
        ctx.request.tokenOut,
        ctx.request.amountIn,
      ),
      latencyMs: 0,
    }),
    encodeQuotePrewarm: async () => [],
    allowanceSpender: () => null,
    prewarmAddresses: () => [ADDR.SKY_PSM_LITE],
  },
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

function quotePreparedPSM(tokenIn: string, tokenOut: string, amountIn: bigint): bigint {
  const usdc = ADDR.USDC.toLowerCase();
  const dai = ADDR.DAI.toLowerCase();
  const tIn = tokenIn.toLowerCase();
  const tOut = tokenOut.toLowerCase();
  if (tIn === usdc && tOut === dai) return amountIn * 10n ** 12n;
  if (tIn === dai && tOut === usdc) return amountIn / 10n ** 12n;
  throw new Error(`PSM only supports USDC<->DAI, got ${tokenIn} -> ${tokenOut}`);
}
