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
import {
  curveIdentityResolver,
  isRetryablePoolIdentityFailure,
} from "../identity.js";
import { createAddressLandedPoolMaterializer } from "../landed-pool-discovery.js";
import { createCurveSwapObservation } from "../swap-observation.js";
import { currentBlockRead } from "./blockscan-state-shared.js";
import { curveUnderlyingLandedEvents } from "./curve-landed-events.js";
import {
  createCurrentBlockViewQuoteCapability,
  quoteReadId,
} from "./view-quote-blockscan-state.js";

const MAX_UINT = (1n << 256n) - 1n;
const curveUnderlyingSwapObservation = createCurveSwapObservation({
  adapterIds: ["curve-exchange-underlying"],
  canonicalIntakeTargets: [
    "0x99a58482bd75cbab83b27ec03ca68ff489b5788f",
    "0x16c6521dff6bab339122a0fe25a9116693265353",
  ],
  landedEvents: curveUnderlyingLandedEvents.swaps,
});
const curveUnderlyingIface = new ethers.Interface([
  "function get_dy_underlying(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);

interface CurveUnderlyingStateSchema {
  readonly pool: string;
}

const curveUnderlyingPoolDiscovery = createAddressLandedPoolMaterializer({
  version: "curve-underlying-address-metadata-v1",
  eventIds: ["curve-underlying-i128", "curve-underlying-uint"],
  async materializePool(candidate, context) {
    const identity = await curveIdentityResolver({
      backend: context.backend,
      pool: candidate.address,
      poolAdapter: "curve-underlying",
      candidate: {
        address: candidate.address,
        adapter: "curve-underlying",
      },
      admissionPolicy: context.admissionPolicy,
      isPoolAdapterSupported: (poolAdapter) =>
        poolAdapter === "curve-underlying",
    });
    if (!identity.ok) {
      if (isRetryablePoolIdentityFailure(identity.reason)) {
        throw new Error(
          `Curve underlying identity read incomplete: ${identity.reason}`,
        );
      }
      return null;
    }
    const metadata = await resolveCurveUnderlyingMetadata(
      context.backend,
      candidate.address,
      { allowDirectPoolFallback: true },
    );
    return {
      address: candidate.address,
      adapter: identity.adapter,
      venueId: identity.venueId,
      identitySource: identity.identitySource,
      ...(identity.factory === undefined ? {} : { factory: identity.factory }),
      underlyingCoins: metadata.coins,
    };
  },
});

export const curveUnderlyingBlockScanState =
  createCurrentBlockViewQuoteCapability<CurveUnderlyingStateSchema>({
    kind: "curve-underlying",
    edgeAdapterIds: new Set(["curve-exchange-underlying"]),
    compileGroup(edges) {
      const pool = ethers.getAddress(edges[0].target).toLowerCase();
      for (const edge of edges) {
        if (
          ethers.getAddress(edge.target).toLowerCase() !== pool ||
          edge.curveI === undefined ||
          edge.curveJ === undefined
        ) {
          throw new Error(`curve-underlying block-scan edge ${pool} is incomplete`);
        }
      }
      return Object.freeze({ pool });
    },
    quoteRead(ctx) {
      if (ctx.edge.curveI === undefined || ctx.edge.curveJ === undefined) {
        throw new Error("curve-underlying current-N quote is missing indices");
      }
      return currentBlockRead({
        id: quoteReadId(ctx.stateKey, ctx.edge),
        sourceBlock: ctx.sourceBlock,
        sourceBlockHash: ctx.sourceBlockHash,
        to: ctx.edge.target,
        data: curveUnderlyingIface.encodeFunctionData("get_dy_underlying", [
          BigInt(ctx.edge.curveI),
          BigInt(ctx.edge.curveJ),
          ctx.amountIn,
        ]),
      });
    },
    decodeQuote(_edge, data) {
      return BigInt(
        curveUnderlyingIface.decodeFunctionResult("get_dy_underlying", data)[0],
      );
    },
  });

export const curveUnderlyingAdapter = Object.freeze({
  id: "curve-underlying",
  kind: "swap",
  poolAdapters: ["curve-underlying"],
  identityPolicies: [{
    poolAdapter: "curve-underlying",
    policy: "onchain-resolver",
    resolve: curveIdentityResolver,
  }],
  edgeAdapterIds: ["curve-exchange-underlying"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  requiresProtocolEdgesFlag: false,
  ownedActionAdapterIds: ["curve-exchange-underlying"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  landedEvents: curveUnderlyingLandedEvents,
  poolDiscovery: curveUnderlyingPoolDiscovery,
  observation: curveUnderlyingSwapObservation,
  victimModel: {
    id: "pool-swap:curve-underlying-detect-only",
    mode: "detect-only",
  },
  pricingState: curveUnderlyingBlockScanState,
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
    quoteUnsupportedReason: null,
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
