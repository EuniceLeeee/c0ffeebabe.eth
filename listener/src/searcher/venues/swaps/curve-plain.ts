import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { ExactQuoteContext, PlanBuildContext, PlanFragment, SwapAdapter } from "../route-leg-adapter.js";
import { queryCurveCoins, quoteCurvePlain, resolveCurveIndices } from "./curve-shared.js";

const MAX_UINT = (1n << 256n) - 1n;

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

  buildEdges: buildCurvePlainEdges,
  quoteExact: quoteCurvePlainExact,
  buildPlanFragment: buildCurvePlainPlanFragment,
} satisfies SwapAdapter);

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
