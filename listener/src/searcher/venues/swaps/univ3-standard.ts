import { ethers } from "ethers";
import type { ResolvedPlanNode } from "../../../shared/types/plan.js";
import {
  isStateCallAbortedError,
  type StateBackend,
} from "../../../shared/state/state-backend.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { V3PostImpactSeed } from "../../solver/pool-state-cache.js";
import { v3SwapToState } from "../../solver/v3-math.js";
import type {
  BlockScanStateCapability,
  StateReadResult,
} from "../blockscan-state-capability.js";
import {
  createMutationQueryDescriptor,
  deterministicHash,
} from "../blockscan-state-capability.js";
import type {
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  PreparedRouteQuoteResult,
  SwapAdapter,
} from "../route-leg-adapter.js";
import { factoryIdentityResolver } from "../identity.js";
import {
  createUniV3SwapObservation,
  type PoolImpact,
} from "../swap-observation.js";
import type {
  LocalVictimApplyContext,
  LocalVictimApplyResult,
  VictimOverlayBuildContext,
} from "../victim-runtime-capability.js";
import { buildApprovedSwapVictimOverlay } from "../victim-runtime-shared.js";
import {
  ADDRESS_LANDED_EVENT_EMITTER,
  defineSwapLandedEvents,
  landedEventTopic,
  PANCAKE_V3_SWAP_TOPIC,
  UNIV3_SWAP_TOPIC,
} from "../landed-event-registry.js";
import {
  assertPoolGroup,
  canonicalPoolStateKey,
  currentBlockRead,
  directedPoolMid,
  midsForDirectedEdges,
  q96DirectedReserves,
  requireRead,
} from "./blockscan-state-shared.js";

const UNIV3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const UNIV3_SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const UNIV3_SWAP_ROUTER_V1 = "0xe592427a0aece92de3edee1f18e0157c05861564";
const MIN_SQRT_PRICE = 4295128740n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341n;
const poolIface = new ethers.Interface([
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const v3StateIface = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const quoterV2Iface = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const univ3RouterIface = new ethers.Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)",
]);
const poolTokensCache = new Map<string, [string, string]>();
const preparedFeeCache = new Map<string, number>();
const UNIV3_MUTATION_TOPICS = Object.freeze([
  ethers.id("Initialize(uint160,int24)").toLowerCase(),
  ethers.id(
    "Mint(address,address,int24,int24,uint128,uint256,uint256)",
  ).toLowerCase(),
  ethers.id(
    "Burn(address,int24,int24,uint128,uint256,uint256)",
  ).toLowerCase(),
  UNIV3_SWAP_TOPIC.toLowerCase(),
  PANCAKE_V3_SWAP_TOPIC.toLowerCase(),
]);
const UNIV3_MUTATION_TOPIC_SET = new Set(UNIV3_MUTATION_TOPICS);
const UNIV3_MUTATION_QUERY = createMutationQueryDescriptor({
  topics: [UNIV3_MUTATION_TOPICS],
});
const UNIV3_CLASSIFIER_FINGERPRINT = deterministicHash({
  family: "univ3-standard",
  version: 2,
  semantics:
    "Initialize/Mint/Burn/UniV3-Swap/PancakeV3-Swap invalidate slot0+liquidity",
});

interface UniV3StateSchema {
  readonly pools: ReadonlyMap<string, {
    readonly token0: string;
    readonly token1: string;
    readonly fee: bigint;
    readonly tickSpacing: number;
  }>;
}

interface UniV3CurrentState {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly fee: bigint;
  readonly tickSpacing: number;
  readonly observationIndex: number;
  readonly observationCardinality: number;
  readonly observationCardinalityNext: number;
  readonly feeProtocol: number;
  readonly unlocked: boolean;
}

const UNIV3_EDGE_IDS = new Set(["univ3-swap"]);

const univ3LandedEvents = defineSwapLandedEvents({
  swaps: [
    {
      id: "univ3-swap",
      topic: UNIV3_SWAP_TOPIC,
      emitter: ADDRESS_LANDED_EVENT_EMITTER,
      discovery: { poolAdapter: "univ3", label: "univ3" },
      invalidatesWarmState: true,
    },
    {
      id: "pancake-v3-swap",
      topic: PANCAKE_V3_SWAP_TOPIC,
      emitter: ADDRESS_LANDED_EVENT_EMITTER,
      discovery: { poolAdapter: "univ3", label: "pancake-v3" },
      invalidatesWarmState: true,
    },
  ],
  mutations: [
    {
      id: "univ3-mint",
      topic: landedEventTopic(
        "Mint(address,address,int24,int24,uint128,uint256,uint256)",
      ),
      emitter: ADDRESS_LANDED_EVENT_EMITTER,
    },
    {
      id: "univ3-burn",
      topic: landedEventTopic(
        "Burn(address,int24,int24,uint128,uint256,uint256)",
      ),
      emitter: ADDRESS_LANDED_EVENT_EMITTER,
    },
  ],
});

export const univ3BlockScanState = Object.freeze({
  stateKey: canonicalPoolStateKey,

  compileStaticSchema({ edges }) {
    const pools = new Map<string, {
      token0: string;
      token1: string;
      fee: bigint;
      tickSpacing: number;
    }>();
    for (const edge of edges) {
      const pool = canonicalPoolStateKey(edge);
      if (!edge.poolToken0 || !edge.poolToken1) {
        throw new Error(`univ3 block-scan edge ${pool} is missing token order`);
      }
      const token0 = ethers.getAddress(edge.poolToken0);
      const token1 = ethers.getAddress(edge.poolToken1);
      if (
        edge.v3Fee === undefined ||
        !Number.isSafeInteger(edge.v3Fee) ||
        edge.v3Fee < 0
      ) {
        throw new Error(`univ3 block-scan edge ${pool} is missing attested fee`);
      }
      const fee = BigInt(edge.v3Fee);
      if (
        edge.v3TickSpacing === undefined ||
        !Number.isSafeInteger(edge.v3TickSpacing) ||
        edge.v3TickSpacing <= 0
      ) {
        throw new Error(`univ3 block-scan edge ${pool} is missing attested tick spacing`);
      }
      const tickSpacing = edge.v3TickSpacing;
      const existing = pools.get(pool);
      if (
        existing &&
        (
          existing.token0 !== token0 ||
          existing.token1 !== token1 ||
          existing.fee !== fee ||
          existing.tickSpacing !== tickSpacing
        )
      ) {
        throw new Error(`univ3 block-scan pool ${pool} has inconsistent metadata`);
      }
      pools.set(pool, Object.freeze({ token0, token1, fee, tickSpacing }));
    }
    return Object.freeze({ pools });
  },

  buildCurrentBlockReads({ sourceBlock, sourceBlockHash, edges }) {
    const pool = assertPoolGroup(edges, UNIV3_EDGE_IDS);
    return Object.freeze([
      currentBlockRead({
        id: `slot0:${pool}`,
        sourceBlock,
        sourceBlockHash,
        to: pool,
        data: v3StateIface.encodeFunctionData("slot0"),
      }),
      currentBlockRead({
        id: `liquidity:${pool}`,
        sourceBlock,
        sourceBlockHash,
        to: pool,
        data: v3StateIface.encodeFunctionData("liquidity"),
      }),
    ]);
  },

  decodeState(schema, results) {
    const pool = statePoolFromResults(results, "slot0:");
    const metadata = schema.pools.get(pool);
    if (!metadata) throw new Error(`univ3 block-scan schema missing ${pool}`);
    const slot0 = v3StateIface.decodeFunctionResult(
      "slot0",
      requireRead(results, `slot0:${pool}`).data,
    );
    const liquidity = v3StateIface.decodeFunctionResult(
      "liquidity",
      requireRead(results, `liquidity:${pool}`).data,
    );
    const snapshot = {
      pool,
      token0: metadata.token0,
      token1: metadata.token1,
      sqrtPriceX96: BigInt(slot0[0]),
      tick: Number(slot0[1]),
      liquidity: BigInt(liquidity[0]),
      fee: metadata.fee,
      tickSpacing: metadata.tickSpacing,
      observationIndex: Number(slot0[2]),
      observationCardinality: Number(slot0[3]),
      observationCardinalityNext: Number(slot0[4]),
      feeProtocol: Number(slot0[5]),
      unlocked: Boolean(slot0[6]),
    };
    if (snapshot.sqrtPriceX96 <= 0n || snapshot.liquidity <= 0n) {
      throw new Error(`univ3 block-scan pool ${pool} has inactive state`);
    }
    return Object.freeze(snapshot);
  },

  deriveMids(snapshot, edges) {
    return midsForDirectedEdges(edges, (edge) => {
      if (canonicalPoolStateKey(edge) !== snapshot.pool) {
        throw new Error(`univ3 snapshot ${snapshot.pool} used for ${edge.target}`);
      }
      const directed = q96DirectedReserves({
        sqrtPriceX96: snapshot.sqrtPriceX96,
        liquidity: snapshot.liquidity,
        token0: snapshot.token0,
        token1: snapshot.token1,
        edge,
      });
      return directedPoolMid({
        kind: "v3",
        edge,
        reserveIn: directed.reserveIn,
        reserveOut: directed.reserveOut,
        sqrtPriceX96: directed.sqrtPriceInOutX96,
        liquidity: snapshot.liquidity,
        feeBps: Number(snapshot.fee) / 100,
      });
    });
  },

  projectBackrunState(snapshot, source) {
    return Object.freeze({
      kind: "v3-live" as const,
      state: Object.freeze({
        pool: snapshot.pool,
        sqrtPriceX96: snapshot.sqrtPriceX96,
        tick: snapshot.tick,
        liquidity: snapshot.liquidity,
        observationIndex: snapshot.observationIndex,
        observationCardinality: snapshot.observationCardinality,
        observationCardinalityNext: snapshot.observationCardinalityNext,
        feeProtocol: snapshot.feeProtocol,
        unlocked: snapshot.unlocked,
        blockNumber: source.number,
      }),
    });
  },

  dependencies(edges) {
    return Object.freeze([assertPoolGroup(edges, UNIV3_EDGE_IDS)]);
  },

  incremental: {
    mutationQueryDescriptor() {
      return UNIV3_MUTATION_QUERY;
    },

    classifyMutations({ schema, range }) {
      const changed = new Map<string, ReadonlySet<string>>();
      const backrunInvalidations = new Map<
        string,
        readonly [{ readonly kind: "v3-ticks"; readonly pool: string }]
      >();
      for (const event of range.events) {
        const topic = event.topics[0]?.toLowerCase() ?? "";
        if (!UNIV3_MUTATION_TOPIC_SET.has(topic)) {
          throw new Error("univ3 mutation range contains an unknown mutation event");
        }
        const pool = event.address.toLowerCase();
        if (!schema.pools.has(pool)) continue;
        // We deliberately invalidate both fields. Mint/Burn can move active
        // liquidity depending on the current tick, while Swap can cross ticks;
        // a coarse topic-only classifier must not guess a partial safe subset.
        changed.set(
          pool,
          new Set([`slot0:${pool}`, `liquidity:${pool}`]),
        );
        if (
          topic === landedEventTopic(
            "Mint(address,address,int24,int24,uint128,uint256,uint256)",
          ) ||
          topic === landedEventTopic(
            "Burn(address,int24,int24,uint128,uint256,uint256)",
          )
        ) {
          backrunInvalidations.set(
            pool,
            Object.freeze([
              Object.freeze({ kind: "v3-ticks" as const, pool }),
            ]),
          );
        }
      }
      return Object.freeze({
        mutationRangeFingerprint: range.rangeFingerprint,
        classifierFingerprint: UNIV3_CLASSIFIER_FINGERPRINT,
        changedReadKeysByStateKey: changed,
        backrunInvalidationsByStateKey: backrunInvalidations,
      });
    },
  },
} satisfies BlockScanStateCapability<UniV3StateSchema, UniV3CurrentState>);

export const univ3StandardAdapter = Object.freeze({
  id: "univ3-standard",
  kind: "swap",
  livePoolState: { kind: "concentrated-v3" },
  matureDexUniverseDiscovery: true,
  poolAdapters: ["univ3"],
  identityPolicies: [
    { poolAdapter: "univ3", policy: "onchain-resolver", resolve: factoryIdentityResolver },
  ],
  edgeAdapterIds: ["univ3-swap"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  requiresProtocolEdgesFlag: false,
  ownedActionAdapterIds: ["univ3-swap"],
  requiredInfraActionAdapterIds: ["erc20-transfer"],
  landedEvents: univ3LandedEvents,
  observation: createUniV3SwapObservation({
    adapterIds: ["univ3-swap"],
    canonicalIntakeTargets: [UNIV3_SWAP_ROUTER, UNIV3_SWAP_ROUTER_V1],
    landedEvents: univ3LandedEvents.swaps,
  }),
  victimModel: {
    id: "pool-swap:univ3",
    mode: "replay",
    runtime: {
      localApply: {
        cacheBacked: true,
        needsMutablePoolRefresh: true,
        apply: applyUniV3Victim,
      },
      exactPostImpact: uniV3ExactPostImpact,
      buildOverlay: buildUniV3VictimOverlay,
    },
  },
  pricingState: univ3BlockScanState,
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

function applyUniV3Victim(
  ctx: LocalVictimApplyContext,
): LocalVictimApplyResult | null {
  const { cache, impact, blockNumber } = ctx;
  const pre = cache.snapshotV3(impact.pool, blockNumber);
  if (!pre) return null;

  const tokenIn = impact.tokenIn.toLowerCase();
  const tokenOut = impact.tokenOut.toLowerCase();
  const zeroForOne = tokenIn === pre.token0 && tokenOut === pre.token1;
  const oneForZero = tokenIn === pre.token1 && tokenOut === pre.token0;
  if (!zeroForOne && !oneForZero) return null;

  const result = v3SwapToState(pre.state, zeroForOne, impact.amountIn);
  if (result.amountOut <= 0n) return null;

  const postImpact: V3PostImpactSeed = {
    kind: "v3",
    pool: impact.pool,
    sqrtPriceX96: result.state.sqrtPriceX96,
    tick: result.state.tick,
    liquidity: result.state.liquidity,
    observationIndex: result.state.observationIndex,
    observationCardinality: result.state.observationCardinality,
    observationCardinalityNext: result.state.observationCardinalityNext,
    feeProtocol: result.state.feeProtocol,
    unlocked: result.state.unlocked,
    blockNumber,
  };
  return { postImpact, amountOut: result.amountOut };
}

function uniV3ExactPostImpact(
  impact: PoolImpact,
  blockNumber: number,
): V3PostImpactSeed | null {
  if (!impact.v3PostState) return null;
  return {
    kind: "v3",
    pool: impact.pool,
    sqrtPriceX96: impact.v3PostState.sqrtPriceX96,
    tick: impact.v3PostState.tick,
    liquidity: impact.v3PostState.liquidity,
    blockNumber,
  };
}

async function buildUniV3VictimOverlay(
  ctx: VictimOverlayBuildContext,
) {
  const pool = ethers.getAddress(ctx.impact.pool);
  const rawFee = await ctx.read({
    to: pool,
    data: poolIface.encodeFunctionData("fee"),
  });
  const fee = Number(poolIface.decodeFunctionResult("fee", rawFee)[0]);
  const whale = "0x000000000000000000000000000000000000dEaD";
  return buildApprovedSwapVictimOverlay({
    impact: ctx.impact,
    approveTarget: UNIV3_SWAP_ROUTER,
    swapTarget: UNIV3_SWAP_ROUTER,
    swapCalldata: univ3RouterIface.encodeFunctionData("exactInputSingle", [{
      tokenIn: ethers.getAddress(ctx.impact.tokenIn),
      tokenOut: ethers.getAddress(ctx.impact.tokenOut),
      fee,
      recipient: whale,
      amountIn: ctx.impact.amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    }]),
    gasLimit: 0x1000000,
  });
}

async function buildUniV3Edges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  const [token0, token1] = pool.token0 && pool.token1
    ? [ethers.getAddress(pool.token0), ethers.getAddress(pool.token1)]
    : await queryPoolTokens(backend, pool.address);
  const fee = pool.fee ?? Number(BigInt(await backend.call({
    to: pool.address,
    data: poolIface.encodeFunctionData("fee"),
  })));
  const tickSpacing = pool.tickSpacing ?? Number(BigInt(await backend.call({
    to: pool.address,
    data: poolIface.encodeFunctionData("tickSpacing"),
  })));
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
      v3Fee: fee,
      v3TickSpacing: tickSpacing,
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
      v3Fee: fee,
      v3TickSpacing: tickSpacing,
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
    } catch (error) {
      if (isStateCallAbortedError(error)) throw error;
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

function statePoolFromResults(
  results: readonly StateReadResult[],
  prefix: string,
): string {
  const read = results.find((candidate) => candidate.id.startsWith(prefix));
  if (!read) throw new Error(`missing block-scan read prefix ${prefix}`);
  return read.id.slice(prefix.length);
}
