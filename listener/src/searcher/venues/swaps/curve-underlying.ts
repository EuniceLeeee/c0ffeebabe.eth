import { ethers } from "ethers";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import {
  CURVE_METAREGISTRY,
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
import {
  BLOCKSCAN_MULTICALL3,
  blockScanErc20Iface,
  currentBlockRead,
  decodeMulticall,
  encodeMulticall,
  optionalMulticallData,
  requireRead,
  type MulticallItem,
} from "./blockscan-state-shared.js";
import { curveUnderlyingLandedEvents } from "./curve-landed-events.js";
import {
  createAdaptiveCurrentBlockViewQuoteCapability,
  type AdaptiveViewQuoteContext,
} from "./adaptive-view-quote-blockscan-state.js";

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
const curveMetaRegistryStateIface = new ethers.Interface([
  "function get_underlying_decimals(address pool) view returns (uint256[8])",
  "function get_underlying_balances(address pool) view returns (uint256[8])",
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
  createAdaptiveCurrentBlockViewQuoteCapability<CurveUnderlyingStateSchema>({
    kind: "curve-underlying",
    edgeAdapterIds: new Set(["curve-exchange-underlying"]),
    compileDirection(edge) {
      const pool = ethers.getAddress(edge.target).toLowerCase();
      if (
        edge.curveI === undefined ||
        edge.curveJ === undefined ||
        edge.curveI < 0 ||
        edge.curveI >= 8 ||
        edge.curveJ < 0 ||
        edge.curveJ >= 8 ||
        edge.curveI === edge.curveJ
      ) {
        throw new Error(`curve-underlying block-scan edge ${pool} is incomplete`);
      }
      return Object.freeze({ pool });
    },
    initialReads(ctx) {
      return Object.freeze([
        currentBlockRead({
          id: curveUnderlyingRegistryScaleReadId(ctx.static.pool),
          sourceBlock: ctx.sourceBlock,
          sourceBlockHash: ctx.sourceBlockHash,
          to: BLOCKSCAN_MULTICALL3,
          data: encodeMulticall(curveUnderlyingRegistryScaleItems(
            ctx.static.pool,
          )),
          transport: "rpc-batch",
        }),
        currentBlockRead({
          id: curveUnderlyingTokenDecimalsReadId(ctx.edge.tokenIn),
          sourceBlock: ctx.sourceBlock,
          sourceBlockHash: ctx.sourceBlockHash,
          to: BLOCKSCAN_MULTICALL3,
          data: encodeMulticall(curveUnderlyingTokenDecimalsItems(
            ctx.edge.tokenIn,
          )),
          transport: "rpc-batch",
        }),
      ]);
    },
    quoteCandidates(ctx) {
      return curveUnderlyingQuoteCandidates(ctx);
    },
    quoteCall(ctx, amountIn) {
      if (ctx.edge.curveI === undefined || ctx.edge.curveJ === undefined) {
        throw new Error("curve-underlying current-N quote is missing indices");
      }
      return Object.freeze({
        target: ctx.edge.target,
        data: curveUnderlyingIface.encodeFunctionData("get_dy_underlying", [
          BigInt(ctx.edge.curveI),
          BigInt(ctx.edge.curveJ),
          amountIn,
        ]),
      });
    },
    decodeQuote(_edge, data) {
      return BigInt(
        curveUnderlyingIface.decodeFunctionResult("get_dy_underlying", data)[0],
      );
    },
    dependencies() {
      return Object.freeze([CURVE_METAREGISTRY]);
    },
  });

function curveUnderlyingQuoteCandidates(
  ctx: AdaptiveViewQuoteContext<CurveUnderlyingStateSchema>,
): readonly bigint[] {
  const index = ctx.edge.curveI;
  if (index === undefined) {
    throw new Error("curve-underlying scale lookup is missing input index");
  }
  const registryItems = curveUnderlyingRegistryScaleItems(ctx.static.pool);
  const registryResults = decodeMulticall(
    requireRead(
      ctx.priorResults,
      curveUnderlyingRegistryScaleReadId(ctx.static.pool),
    ),
    registryItems,
  );
  const decimalsData = optionalMulticallData(
    registryResults,
    "underlying-decimals",
  );
  const balancesData = optionalMulticallData(
    registryResults,
    "underlying-balances",
  );
  let unit: bigint | null = null;
  let reserve: bigint | null = null;
  if (decimalsData) {
    const decimals = Array.from(
      curveMetaRegistryStateIface.decodeFunctionResult(
        "get_underlying_decimals",
        decimalsData,
      )[0] as readonly bigint[],
    ).map(BigInt);
    const value = decimals[index];
    if (value !== undefined && value >= 0n && value <= 36n) {
      unit = 10n ** value;
    }
  }
  if (balancesData) {
    const balances = Array.from(
      curveMetaRegistryStateIface.decodeFunctionResult(
        "get_underlying_balances",
        balancesData,
      )[0] as readonly bigint[],
    ).map(BigInt);
    const value = balances[index];
    if (value !== undefined && value > 0n) reserve = value;
  }
  if (unit === null) {
    const tokenItems = curveUnderlyingTokenDecimalsItems(ctx.edge.tokenIn);
    const tokenResults = decodeMulticall(
      requireRead(
        ctx.priorResults,
        curveUnderlyingTokenDecimalsReadId(ctx.edge.tokenIn),
      ),
      tokenItems,
    );
    const tokenData = optionalMulticallData(tokenResults, "token-decimals");
    if (tokenData) {
      const decimals = Number(
        blockScanErc20Iface.decodeFunctionResult("decimals", tokenData)[0],
      );
      if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 36) {
        unit = 10n ** BigInt(decimals);
      }
    }
  }
  if (unit === null && reserve === null) {
    throw new Error(
      `curve-underlying ${ctx.static.pool} has no behavior-proven input scale`,
    );
  }

  const candidates: bigint[] = [];
  if (unit !== null) candidates.push(unit);
  if (reserve !== null) {
    const cap = reserve / 100n > 0n ? reserve / 100n : reserve;
    let probe = reserve / 1_000_000n > 0n
      ? reserve / 1_000_000n
      : 1n;
    candidates.push(probe);
    while (probe < cap) {
      const next = probe * 10n;
      probe = next > cap ? cap : next;
      candidates.push(probe);
    }
  } else if (unit !== null) {
    candidates.push(
      unit / 1_000_000n,
      unit / 1_000n,
      unit * 1_000n,
      unit * 1_000_000n,
    );
  }
  return Object.freeze(candidates);
}

function curveUnderlyingRegistryScaleReadId(pool: string): string {
  return `curve-underlying:registry-scale:${ethers.getAddress(pool).toLowerCase()}`;
}

function curveUnderlyingRegistryScaleItems(
  pool: string,
): readonly MulticallItem[] {
  return Object.freeze([
    {
      label: "underlying-decimals",
      target: CURVE_METAREGISTRY,
      callData: curveMetaRegistryStateIface.encodeFunctionData(
        "get_underlying_decimals",
        [pool],
      ),
      allowFailure: true,
    },
    {
      label: "underlying-balances",
      target: CURVE_METAREGISTRY,
      callData: curveMetaRegistryStateIface.encodeFunctionData(
        "get_underlying_balances",
        [pool],
      ),
      allowFailure: true,
    },
  ]);
}

function curveUnderlyingTokenDecimalsReadId(token: string): string {
  return `curve-underlying:token-decimals:${ethers.getAddress(token).toLowerCase()}`;
}

function curveUnderlyingTokenDecimalsItems(
  token: string,
): readonly MulticallItem[] {
  return Object.freeze([{
    label: "token-decimals",
    target: token,
    callData: blockScanErc20Iface.encodeFunctionData("decimals"),
    allowFailure: true,
  }]);
}

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
