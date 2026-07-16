import { ethers } from "ethers";
import type { ResolvedPlanNode } from "../../../shared/types/plan.js";
import type { StateBackend } from "../../../shared/state/state-backend.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type {
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  PreparedRouteQuoteResult,
  SwapAdapter,
} from "../route-leg-adapter.js";
import { readV3WarmMid } from "../mid-readers.js";
import { createUniV3SwapObservation } from "../swap-observation.js";

const UNIV3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const UNIV3_SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const UNIV3_SWAP_ROUTER_V1 = "0xe592427a0aece92de3edee1f18e0157c05861564";
const MIN_SQRT_PRICE = 4295128740n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341n;
const poolIface = new ethers.Interface([
  "function fee() view returns (uint24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const quoterV2Iface = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const poolTokensCache = new Map<string, [string, string]>();
const preparedFeeCache = new Map<string, number>();

export const univ3StandardAdapter = Object.freeze({
  id: "univ3-standard",
  kind: "swap",
  poolAdapters: ["univ3"],
  edgeAdapterIds: ["univ3-swap"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  actionAdapterIds: ["univ3-swap", "erc20-transfer"],
  observation: createUniV3SwapObservation({
    adapterIds: ["univ3-swap"],
    canonicalIntakeTargets: [UNIV3_SWAP_ROUTER, UNIV3_SWAP_ROUTER_V1],
  }),
  readMid: readV3WarmMid,
  warm: { kind: "mutable-pool", cache: "v3" },
  prepared: {
    quote: quoteUniV3Prepared,
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => {
      const fee = await resolvePreparedFee(ctx, ctx.request.target);
      return [{
        from: ethers.ZeroAddress,
        to: UNIV3_QUOTER_V2,
        calldata: quoterV2Iface.encodeFunctionData("quoteExactInputSingle", [{
          tokenIn: ctx.request.tokenIn,
          tokenOut: ctx.request.tokenOut,
          amountIn: ctx.request.amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        }]),
        gasLimit: 3_000_000,
      }];
    },
    allowanceSpender: () => UNIV3_SWAP_ROUTER,
    prewarmAddresses: () => [],
  },

  buildEdges: buildUniV3Edges,
  quoteExact: quoteUniV3Exact,
  buildPlanFragment: buildUniV3PlanFragment,
} satisfies SwapAdapter);

async function buildUniV3Edges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  const [token0, token1] = pool.token0 && pool.token1
    ? [ethers.getAddress(pool.token0), ethers.getAddress(pool.token1)]
    : await queryPoolTokens(backend, pool.address);
  const taxonomy = deriveEdgeTaxonomy("swap");
  return [
    {
      adapterId: "univ3-swap",
      target: pool.address,
      tokenIn: token0,
      tokenOut: token1,
      slotKind: "swap",
      poolToken0: token0,
      poolToken1: token1,
      score: pool.score,
      ...taxonomy,
    },
    {
      adapterId: "univ3-swap",
      target: pool.address,
      tokenIn: token1,
      tokenOut: token0,
      slotKind: "swap",
      poolToken0: token0,
      poolToken1: token1,
      score: pool.score,
      ...taxonomy,
    },
  ];
}

async function quoteUniV3Exact(ctx: ExactQuoteContext): Promise<bigint> {
  const { state, target, tokenIn, tokenOut, amountIn, cache } = ctx;
  if (!tokenIn || !tokenOut) throw new Error("univ3 quote requires tokenIn/tokenOut");
  if (amountIn <= 0n) return 0n;
  if (cache) {
    try {
      return await cache.quoteV3(state, target, tokenIn, tokenOut, amountIn);
    } catch {
      // Crossed ticks outside the warm window fall back to QuoterV2.
    }
  }
  const feeResult = await state.call({
    to: target,
    data: poolIface.encodeFunctionData("fee"),
  });
  const fee = Number(BigInt(feeResult));
  const data = quoterV2Iface.encodeFunctionData("quoteExactInputSingle", [{
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0n,
  }]);
  const result = await state.call({ to: UNIV3_QUOTER_V2, data });
  return BigInt(quoterV2Iface.decodeFunctionResult("quoteExactInputSingle", result)[0]);
}

async function buildUniV3PlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
  const { edge, amountIn, state } = ctx;
  const [token0] = edge.poolToken0 && edge.poolToken1
    ? [edge.poolToken0, edge.poolToken1]
    : await queryPoolTokens(state, edge.target);
  const zeroForOne = edge.tokenIn.toLowerCase() === token0.toLowerCase();
  const transfer: ResolvedPlanNode = {
    adapterId: "erc20-transfer",
    target: edge.tokenIn,
    tokenIn: edge.tokenIn,
    tokenOut: edge.tokenIn,
    amount: amountIn,
    params: { to: edge.target, amount: amountIn },
    children: [],
  };
  return {
    requirements: [],
    nodes: [{
      adapterId: "univ3-swap",
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: amountIn,
      params: {
        zeroForOne,
        amountSpecified: amountIn,
        sqrtPriceLimit: zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE,
      },
      children: [transfer],
    }],
  };
}

async function quoteUniV3Prepared(ctx: PreparedRouteContext): Promise<PreparedRouteQuoteResult> {
  const fee = await resolvePreparedFee(ctx, ctx.request.target);
  const data = quoterV2Iface.encodeFunctionData("quoteExactInputSingle", [{
    tokenIn: ctx.request.tokenIn,
    tokenOut: ctx.request.tokenOut,
    amountIn: ctx.request.amountIn,
    fee,
    sqrtPriceLimitX96: 0n,
  }]);
  const quoted = await ctx.callPrepared(UNIV3_QUOTER_V2, data, { gasLimit: 3_000_000 });
  const decoded = quoterV2Iface.decodeFunctionResult("quoteExactInputSingle", quoted.output);
  return {
    amountOut: BigInt(decoded[0]),
    latencyMs: quoted.latencyMs,
    cacheStats: quoted.cacheStats,
  };
}

async function resolvePreparedFee(ctx: PreparedRouteContext, pool: string): Promise<number> {
  const key = pool.toLowerCase();
  const cached = preparedFeeCache.get(key);
  if (cached !== undefined) return cached;
  const raw = await ctx.readChain({ to: pool, data: poolIface.encodeFunctionData("fee", []) });
  const fee = Number(BigInt(raw));
  preparedFeeCache.set(key, fee);
  return fee;
}

async function queryPoolTokens(
  backend: Pick<StateBackend, "call"> | TokenQueryBackend,
  pool: string,
): Promise<[string, string]> {
  const key = pool.toLowerCase();
  const cached = poolTokensCache.get(key);
  if (cached) return cached;
  const [token0Raw, token1Raw] = await Promise.all([
    backend.call({ to: pool, data: poolIface.encodeFunctionData("token0") }),
    backend.call({ to: pool, data: poolIface.encodeFunctionData("token1") }),
  ]);
  const tokens: [string, string] = [
    ethers.getAddress(`0x${token0Raw.slice(-40)}`),
    ethers.getAddress(`0x${token1Raw.slice(-40)}`),
  ];
  poolTokensCache.set(key, tokens);
  return tokens;
}
