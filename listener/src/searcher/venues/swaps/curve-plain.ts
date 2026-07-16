import { ethers } from "ethers";
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
import { readCurveWarmMid } from "../mid-readers.js";
import { queryCurveCoins, quoteCurvePlain, resolveCurveIndices } from "./curve-shared.js";

const MAX_UINT = (1n << 256n) - 1n;
const curveIntIface = new ethers.Interface([
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);
const curveUintIface = new ethers.Interface([
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
]);

export const curvePlainAdapter = Object.freeze({
  id: "curve-plain",
  kind: "swap",
  poolAdapters: ["curve", "curve-nr"],
  edgeAdapterIds: [
    "curve-exchange",
    "curve-exchange-nr",
    "curve-exchange-plain",
    "curve-exchange-received-uint",
  ],
  allowedTaxonomy: [{ slotKind: "swap" }],
  actionAdapterIds: ["curve-exchange-plain", "erc20-approve"],
  readMid: readCurveWarmMid,
  warm: { kind: "curve-pool" },
  prepared: {
    quote: quoteCurvePlainPrepared,
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => {
      const [i, j] = preparedCurveIndices(ctx);
      const args = [BigInt(i), BigInt(j), ctx.request.amountIn] as const;
      return [
        {
          from: ethers.ZeroAddress,
          to: ctx.request.target,
          calldata: curveIntIface.encodeFunctionData("get_dy", args),
          gasLimit: 3_000_000,
        },
        {
          from: ethers.ZeroAddress,
          to: ctx.request.target,
          calldata: curveUintIface.encodeFunctionData("get_dy", args),
          gasLimit: 3_000_000,
        },
      ];
    },
    allowanceSpender: (request) => ethers.getAddress(request.target),
    prewarmAddresses: () => [],
  },

  buildEdges: buildCurvePlainEdges,
  quoteExact: quoteCurvePlainExact,
  buildPlanFragment: buildCurvePlainPlanFragment,
} satisfies SwapAdapter);

async function quoteCurvePlainPrepared(
  ctx: PreparedRouteContext,
): Promise<PreparedRouteQuoteResult> {
  const [i, j] = preparedCurveIndices(ctx);
  const args = [BigInt(i), BigInt(j), ctx.request.amountIn] as const;
  try {
    const quoted = await ctx.callPrepared(
      ctx.request.target,
      curveIntIface.encodeFunctionData("get_dy", args),
    );
    return {
      amountOut: BigInt(curveIntIface.decodeFunctionResult("get_dy", quoted.output)[0]),
      latencyMs: quoted.latencyMs,
      cacheStats: quoted.cacheStats,
    };
  } catch {
    const quoted = await ctx.callPrepared(
      ctx.request.target,
      curveUintIface.encodeFunctionData("get_dy", args),
    );
    return {
      amountOut: BigInt(curveUintIface.decodeFunctionResult("get_dy", quoted.output)[0]),
      latencyMs: quoted.latencyMs,
      cacheStats: quoted.cacheStats,
    };
  }
}

function preparedCurveIndices(ctx: PreparedRouteContext): [number, number] {
  if (ctx.edge?.curveI === undefined || ctx.edge.curveJ === undefined) {
    throw new Error(`revm curve quote missing graph indices for ${ctx.request.target}`);
  }
  return [ctx.edge.curveI, ctx.edge.curveJ];
}

async function buildCurvePlainEdges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  const coins = await queryCurveCoins(backend, pool.address);
  const adapterId = pool.adapter === "curve-nr" ? "curve-exchange-nr" : "curve-exchange-plain";
  const taxonomy = deriveEdgeTaxonomy("swap");
  const edges: TokenEdge[] = [];
  for (let i = 0; i < coins.length; i++) {
    for (let j = 0; j < coins.length; j++) {
      if (i === j) continue;
      edges.push({
        adapterId,
        target: pool.address,
        tokenIn: coins[i],
        tokenOut: coins[j],
        slotKind: "swap",
        curveI: i,
        curveJ: j,
        score: pool.score,
        ...taxonomy,
      });
    }
  }
  return edges;
}

async function quoteCurvePlainExact(ctx: ExactQuoteContext): Promise<bigint> {
  const { state, target, tokenIn, tokenOut, amountIn, cache } = ctx;
  if (!tokenIn || !tokenOut) throw new Error("curve quote requires tokenIn/tokenOut");
  if (amountIn <= 0n) return 0n;
  if (cache) {
    try {
      return await cache.quoteCurve(state, target, tokenIn, tokenOut, amountIn);
    } catch {
      // Pools outside the warmed local-math domain retain the get_dy fallback.
    }
  }
  return quoteCurvePlain(state, target, tokenIn, tokenOut, amountIn);
}

async function buildCurvePlainPlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
  const { edge, amountIn, state } = ctx;
  const [i, j] = await resolveCurveIndices(state, edge.target, edge.tokenIn, edge.tokenOut);
  return {
    requirements: [{
      kind: "approve",
      token: edge.tokenIn,
      spender: edge.target,
      amount: MAX_UINT,
    }],
    nodes: [{
      adapterId: "curve-exchange-plain",
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: amountIn,
      params: { i: BigInt(i), j: BigInt(j), minDy: 0n },
      children: [],
    }],
  };
}
