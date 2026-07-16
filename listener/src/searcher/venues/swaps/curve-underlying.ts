import { ethers } from "ethers";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import {
  probeCurveUnderlyingQuote,
  quoteCurveUnderlyingByIndex,
  resolveCurveUnderlyingMetadata,
  type CurveUnderlyingCallBackend,
} from "../curve-underlying.js";
import type {
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  SwapAdapter,
} from "../route-leg-adapter.js";
import { readCurveUnderlyingExternalMid } from "../mid-readers.js";

const MAX_UINT = (1n << 256n) - 1n;
const curveUnderlyingIface = new ethers.Interface([
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);

export const curveUnderlyingAdapter = Object.freeze({
  id: "curve-underlying",
  kind: "swap",
  poolAdapters: ["curve-underlying"],
  edgeAdapterIds: ["curve-exchange-underlying"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  actionAdapterIds: ["curve-exchange-underlying", "erc20-approve"],
  readMid: readCurveUnderlyingExternalMid,
  warm: { kind: "external-mid" },
  prepared: {
    quote: async (ctx: PreparedRouteContext) => {
      const started = Date.now();
      const amountOut = await quoteCurveUnderlying(
        { call: async ({ to, data }) => (await ctx.callPrepared(to, data)).output },
        ctx.request.target,
        ctx.request.tokenIn,
        ctx.request.tokenOut,
        ctx.request.amountIn,
      );
      return { amountOut, latencyMs: Date.now() - started };
    },
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => {
      if (ctx.edge?.curveI === undefined || ctx.edge.curveJ === undefined) return [];
      return [{
        from: ethers.ZeroAddress,
        to: ctx.request.target,
        calldata: curveUnderlyingIface.encodeFunctionData("get_dy_underlying", [
          BigInt(ctx.edge.curveI),
          BigInt(ctx.edge.curveJ),
          ctx.request.amountIn,
        ]),
        gasLimit: 3_000_000,
      }];
    },
    allowanceSpender: (request) => ethers.getAddress(request.target),
    prewarmAddresses: () => [],
  },

  buildEdges: buildCurveUnderlyingEdges,
  quoteExact: quoteCurveUnderlyingExact,
  buildPlanFragment: buildCurveUnderlyingPlanFragment,
} satisfies SwapAdapter);

export async function resolveCurveUnderlyingIndices(
  state: CurveUnderlyingCallBackend,
  pool: string,
  tokenIn: string,
  tokenOut: string,
): Promise<[number, number]> {
  const metadata = await resolveCurveUnderlyingMetadata(state, pool, {
    allowDirectPoolFallback: true,
  });
  return [findIndex(metadata.coins, tokenIn), findIndex(metadata.coins, tokenOut)];
}

export async function quoteCurveUnderlying(
  state: CurveUnderlyingCallBackend,
  pool: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const [i, j] = await resolveCurveUnderlyingIndices(state, pool, tokenIn, tokenOut);
  return quoteCurveUnderlyingByIndex(state, pool, i, j, amountIn);
}

async function buildCurveUnderlyingEdges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  const { coins } = await resolveCurveUnderlyingMetadata(backend, pool.address, {
    allowDirectPoolFallback: true,
  });
  const taxonomy = deriveEdgeTaxonomy("swap");
  const edges: TokenEdge[] = [];
  for (let i = 0; i < coins.length; i++) {
    for (let j = 0; j < coins.length; j++) {
      if (i === j) continue;
      if (!await probeCurveUnderlyingQuote(backend, pool.address, i, j)) continue;
      edges.push({
        adapterId: "curve-exchange-underlying",
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
  if (edges.length === 0) {
    throw new Error(`curve-underlying pool ${pool.address} exposed no quotable directions`);
  }
  return edges;
}

async function quoteCurveUnderlyingExact(ctx: ExactQuoteContext): Promise<bigint> {
  const { state, target, tokenIn, tokenOut, amountIn } = ctx;
  if (!tokenIn || !tokenOut) throw new Error("curve-underlying quote requires tokenIn/tokenOut");
  if (amountIn <= 0n) return 0n;
  return quoteCurveUnderlying(state, target, tokenIn, tokenOut, amountIn);
}

async function buildCurveUnderlyingPlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
  const { edge, amountIn } = ctx;
  if (edge.curveI === undefined || edge.curveJ === undefined) {
    throw new Error(`curve-underlying edge ${edge.target} missing resolved indices`);
  }
  return {
    requirements: [{
      kind: "approve",
      token: edge.tokenIn,
      spender: edge.target,
      amount: MAX_UINT,
    }],
    nodes: [{
      adapterId: "curve-exchange-underlying",
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: amountIn,
      params: { i: BigInt(edge.curveI), j: BigInt(edge.curveJ), minDy: 0n },
      children: [],
    }],
  };
}

function findIndex(coins: readonly string[], token: string): number {
  const key = token.toLowerCase();
  const index = coins.findIndex((coin) => coin.toLowerCase() === key);
  if (index < 0) {
    throw new Error(`token ${token} not in curve underlying coins [${coins.join(",")}]`);
  }
  return index;
}
