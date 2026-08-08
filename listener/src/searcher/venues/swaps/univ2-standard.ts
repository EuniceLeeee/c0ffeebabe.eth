import { ethers } from "ethers";
import type { ResolvedPlanNode } from "../../../shared/types/plan.js";
import {
  isStateCallAbortedError,
  type StateBackend,
} from "../../../shared/state/state-backend.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import { quoteV2ExactInput, v2FeeBpsForFactory } from "../../solver/v2-fee.js";
import type { V2PostImpactSeed } from "../../solver/pool-state-cache.js";
import { factoryIdentityResolver } from "../identity.js";
import type {
  BlockScanStateCapability,
  StateReadResult,
} from "../blockscan-state-capability.js";
import {
  blockScanEdgeKey,
  createMutationQueryDescriptor,
  deterministicHash,
  instanceFingerprint,
  schemaInputFingerprint,
  stateSchemaFingerprint,
  type CompiledStateInstance,
  type CompileStateInstanceInput,
  type StateInstanceSpec,
} from "../blockscan-state-capability.js";
import type {
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  PreparedRouteQuoteResult,
  SwapAdapter,
} from "../route-leg-adapter.js";
import {
  createUniV2SwapObservation,
  type PoolImpact,
} from "../swap-observation.js";
import type {
  LocalVictimApplyContext,
  LocalVictimApplyResult,
  VictimOverlay,
  VictimOverlayBuildContext,
} from "../victim-runtime-capability.js";
import {
  ADDRESS_LANDED_EVENT_EMITTER,
  defineSwapLandedEvents,
  UNIV2_SWAP_TOPIC,
  UNIV2_SYNC_TOPIC,
} from "../landed-event-registry.js";
import {
  assertPoolGroup,
  canonicalPoolStateKey,
  currentBlockRead,
  directedPoolMid,
  midsForDirectedEdges,
  requireRead,
} from "./blockscan-state-shared.js";
import { UNIV2_PAIR_INTERFACE as pairIface } from "./univ2-abi.js";
import {
  applyUniV2VictimState,
  buildUniV2VictimOverlayIntent,
  uniV2ExactPostImpact as buildUniV2ExactPostImpact,
  UNIV2_ROUTER,
} from "./univ2-family/victim.js";
const feeBpsCache = new Map<string, bigint>();

interface UniV2PoolSchemaEntry {
  readonly token0: string;
  readonly token1: string;
  readonly feeBps: bigint;
}

/**
 * Shared per-pool compiler core: both the legacy full compile path and the
 * state-instance path call this, so full-vs-instance parity is structural.
 * All edges of one stateKey must agree on token order and fee.
 */
function compileUniV2PoolEntry(
  edges: readonly TokenEdge[],
): UniV2PoolSchemaEntry {
  const pool = canonicalPoolStateKey(edges[0]);
  const first = edges[0];
  if (!first.poolToken0 || !first.poolToken1) {
    throw new Error(`univ2 block-scan edge ${pool} is missing token order`);
  }
  const token0 = ethers.getAddress(first.poolToken0);
  const token1 = ethers.getAddress(first.poolToken1);
  if (first.v2FeeBps === undefined || first.v2FeeBps < 0n) {
    throw new Error(`univ2 block-scan edge ${pool} is missing quote fee`);
  }
  const feeBps = first.v2FeeBps;
  for (const edge of edges.slice(1)) {
    if (canonicalPoolStateKey(edge) !== pool) {
      throw new Error(`univ2 state group mixes pools for ${pool}`);
    }
    if (
      !edge.poolToken0 ||
      !edge.poolToken1 ||
      ethers.getAddress(edge.poolToken0) !== token0 ||
      ethers.getAddress(edge.poolToken1) !== token1 ||
      edge.v2FeeBps !== feeBps
    ) {
      throw new Error(`univ2 block-scan pool ${pool} has inconsistent metadata`);
    }
  }
  return Object.freeze({ token0, token1, feeBps });
}
const UNIV2_MUTATION_QUERY = createMutationQueryDescriptor({
  // Address filtering a production-sized pool universe exceeds common RPC
  // filter limits. Sync is pair-emitted and the pure classifier intersects it
  // with this family's admitted pool set.
  topics: [[UNIV2_SYNC_TOPIC]],
});
const UNIV2_CLASSIFIER_FINGERPRINT = deterministicHash({
  family: "univ2-standard",
  version: 1,
  semantics: "Sync mutates reserves",
});

interface UniV2StateSchema {
  readonly pools: ReadonlyMap<string, {
    readonly token0: string;
    readonly token1: string;
    readonly feeBps: bigint;
  }>;
}

interface UniV2CurrentState {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly feeBps: bigint;
  readonly blockTimestampLast: number;
  readonly inactiveReason: string | null;
}

const UNIV2_EDGE_IDS = new Set(["univ2-swap"]);

const univ2LandedEvents = defineSwapLandedEvents({
  swaps: [{
    id: "univ2-swap",
    topic: UNIV2_SWAP_TOPIC,
    emitter: ADDRESS_LANDED_EVENT_EMITTER,
    discovery: { poolAdapter: "univ2", label: "univ2" },
    // Sync is the exact reserve publication and remains the V2 invalidation event.
    invalidatesWarmState: false,
  }],
  mutations: [{
    id: "univ2-sync",
    topic: UNIV2_SYNC_TOPIC,
    emitter: ADDRESS_LANDED_EVENT_EMITTER,
  }],
});

export const univ2BlockScanState = Object.freeze({
  schemaMode: "state-instance-v1",
  adapterSchemaRevision: "univ2-v1",
  stateKey: canonicalPoolStateKey,

  compileStaticSchema({ edges }) {
    const pools = new Map<string, UniV2PoolSchemaEntry>();
    const byPool = new Map<string, TokenEdge[]>();
    for (const edge of edges) {
      const pool = canonicalPoolStateKey(edge);
      const group = byPool.get(pool) ?? [];
      group.push(edge);
      byPool.set(pool, group);
    }
    for (const [pool, groupEdges] of byPool) {
      pools.set(pool, compileUniV2PoolEntry(groupEdges));
    }
    return Object.freeze({ pools });
  },

  compileStateInstance(input: CompileStateInstanceInput): CompiledStateInstance {
    const spec = input.spec as StateInstanceSpec;
    if (spec.edges.length === 0) {
      throw new Error(`univ2 instance ${spec.key} has no edges`);
    }
    const staticBindingFingerprint = stateSchemaFingerprint(spec.edges);
    const sharedFingerprint = "";
    const schemaInput = schemaInputFingerprint({
      key: spec.key,
      adapterSchemaRevision: "univ2-v1",
      staticBindingFingerprint,
      sharedFingerprint,
    });
    return Object.freeze({
      familyId: "univ2-standard",
      stateKey: spec.stateKey,
      specFingerprint: schemaInput,
      instanceFingerprint: instanceFingerprint({
        key: spec.key,
        schemaInput,
        staticEvidence: "",
      }),
      staticEvidenceFingerprint: "",
      carryPolicy: "activity-proof",
      opaque: compileUniV2PoolEntry(spec.edges),
    });
  },

  assembleSchema(entries: ReadonlyMap<string, unknown>) {
    const pools = new Map<string, UniV2PoolSchemaEntry>();
    for (const [stateKey, opaque] of entries) {
      pools.set(stateKey, opaque as UniV2PoolSchemaEntry);
    }
    return Object.freeze({ pools });
  },

  buildCurrentBlockReads({ sourceBlock, sourceBlockHash, edges }) {
    const pool = assertPoolGroup(edges, UNIV2_EDGE_IDS);
    return Object.freeze([
      currentBlockRead({
        id: `reserves:${pool}`,
        sourceBlock,
        sourceBlockHash,
        to: pool,
        data: pairIface.encodeFunctionData("getReserves"),
      }),
    ]);
  },

  decodeState(schema, results) {
    const pool = statePoolFromResults(results, "reserves:");
    const metadata = schema.pools.get(pool);
    if (!metadata) throw new Error(`univ2 block-scan schema missing ${pool}`);
    const reserves = pairIface.decodeFunctionResult(
      "getReserves",
      requireRead(results, `reserves:${pool}`).data,
    );
    const reserve0 = BigInt(reserves[0]);
    const reserve1 = BigInt(reserves[1]);
    return Object.freeze({
      pool,
      token0: metadata.token0,
      token1: metadata.token1,
      reserve0,
      reserve1,
      feeBps: metadata.feeBps,
      blockTimestampLast: Number(reserves[2]),
      inactiveReason:
        reserve0 === 0n || reserve1 === 0n
          ? `univ2 pool ${pool} has zero reserve at the current source`
          : null,
    });
  },

  deriveMids(snapshot, edges) {
    if (snapshot.inactiveReason) {
      for (const edge of edges) {
        if (canonicalPoolStateKey(edge) !== snapshot.pool) {
          throw new Error(
            `univ2 snapshot ${snapshot.pool} used for ${edge.target}`,
          );
        }
      }
      return new Map();
    }
    return midsForDirectedEdges(edges, (edge) => {
      if (canonicalPoolStateKey(edge) !== snapshot.pool) {
        throw new Error(`univ2 snapshot ${snapshot.pool} used for ${edge.target}`);
      }
      const tokenIn = edge.tokenIn.toLowerCase();
      const tokenOut = edge.tokenOut.toLowerCase();
      const zeroForOne =
        tokenIn === snapshot.token0.toLowerCase() &&
        tokenOut === snapshot.token1.toLowerCase();
      const oneForZero =
        tokenIn === snapshot.token1.toLowerCase() &&
        tokenOut === snapshot.token0.toLowerCase();
      if (!zeroForOne && !oneForZero) {
        throw new Error(`univ2 edge does not match pool ${snapshot.pool}`);
      }
      return directedPoolMid({
        kind: "v2",
        edge,
        reserveIn: zeroForOne ? snapshot.reserve0 : snapshot.reserve1,
        reserveOut: zeroForOne ? snapshot.reserve1 : snapshot.reserve0,
        feeBps: Number(snapshot.feeBps),
      });
    });
  },

  behaviorProvenUnavailableEdges(snapshot, edges) {
    if (!snapshot.inactiveReason) return new Map();
    const unavailable = new Map<string, string>();
    for (const edge of edges) {
      if (canonicalPoolStateKey(edge) !== snapshot.pool) {
        throw new Error(
          `univ2 snapshot ${snapshot.pool} used for ${edge.target}`,
        );
      }
      unavailable.set(blockScanEdgeKey(edge), snapshot.inactiveReason);
    }
    return unavailable;
  },

  projectBackrunState(snapshot, source) {
    return Object.freeze({
      kind: "v2" as const,
      state: Object.freeze({
        pool: snapshot.pool,
        token0: snapshot.token0,
        token1: snapshot.token1,
        reserve0: snapshot.reserve0,
        reserve1: snapshot.reserve1,
        feeBps: snapshot.feeBps,
        blockTimestampLast: snapshot.blockTimestampLast,
        blockNumber: source.number,
      }),
    });
  },

  dependencies(edges) {
    const pool = assertPoolGroup(edges, UNIV2_EDGE_IDS);
    return Object.freeze([
      pool,
      ...new Set(edges.flatMap((edge) => [edge.tokenIn, edge.tokenOut])),
    ]);
  },

  incremental: {
    mutationQueryDescriptor() {
      return UNIV2_MUTATION_QUERY;
    },

    classifyMutations({ schema, range }) {
      const changed = new Map<string, ReadonlySet<string>>();
      for (const event of range.events) {
        if (event.topics[0]?.toLowerCase() !== UNIV2_SYNC_TOPIC) {
          throw new Error("univ2 mutation range contains a non-Sync event");
        }
        const pool = event.address.toLowerCase();
        if (!schema.pools.has(pool)) continue;
        changed.set(pool, new Set([`reserves:${pool}`]));
      }
      return Object.freeze({
        mutationRangeFingerprint: range.rangeFingerprint,
        classifierFingerprint: UNIV2_CLASSIFIER_FINGERPRINT,
        changedReadKeysByStateKey: changed,
      });
    },
  },
} satisfies BlockScanStateCapability<UniV2StateSchema, UniV2CurrentState>);

export const univ2StandardAdapter = Object.freeze({
  id: "univ2-standard",
  kind: "swap",
  livePoolState: { kind: "constant-product-v2" },
  matureDexUniverseDiscovery: true,
  poolAdapters: ["univ2"],
  identityPolicies: [
    { poolAdapter: "univ2", policy: "onchain-resolver", resolve: factoryIdentityResolver },
  ],
  edgeAdapterIds: ["univ2-swap"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  requiresProtocolEdgesFlag: false,
  ownedActionAdapterIds: ["univ2-swap"],
  requiredInfraActionAdapterIds: ["erc20-transfer"],
  landedEvents: univ2LandedEvents,
  observation: createUniV2SwapObservation({
    adapterIds: ["univ2-swap"],
    canonicalIntakeTargets: [UNIV2_ROUTER],
    landedEvents: univ2LandedEvents.swaps,
  }),
  victimModel: {
    id: "pool-swap:univ2",
    mode: "replay",
    runtime: {
      localApply: {
        cacheBacked: true,
        needsMutablePoolRefresh: true,
        apply: applyUniV2Victim,
      },
      exactPostImpact: uniV2ExactPostImpact,
      buildOverlay: buildUniV2VictimOverlay,
    },
  },
  pricingState: univ2BlockScanState,
  prepared: {
    quote: quoteUniV2Prepared,
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => [{
      from: ethers.ZeroAddress,
      to: ctx.request.target,
      calldata: pairIface.encodeFunctionData("getReserves", []),
      gasLimit: 300_000,
    }],
    allowanceSpender: () => UNIV2_ROUTER,
    prewarmAddresses: () => [],
  },

  buildEdges: buildUniV2Edges,
  quoteExact: quoteUniV2Exact,
  buildPlanFragment: buildUniV2PlanFragment,
} satisfies SwapAdapter);

function applyUniV2Victim(
  ctx: LocalVictimApplyContext,
): LocalVictimApplyResult | null {
  const { cache, impact, blockNumber } = ctx;
  const pre = cache.snapshotV2(impact.pool, blockNumber);
  if (!pre) return null;
  return applyUniV2VictimState({ preState: pre, impact, blockNumber });
}

function uniV2ExactPostImpact(
  impact: PoolImpact,
  blockNumber: number,
): V2PostImpactSeed | null {
  if (!impact.v2PostState) return null;
  const token0 = impact.poolToken0 ?? impact.v2PostState.token0;
  const token1 = impact.poolToken1 ?? impact.v2PostState.token1;
  const feeBps = impact.v2PostState.feeBps;
  if (!token0 || !token1 || feeBps === undefined) return null;
  return buildUniV2ExactPostImpact({
    pool: impact.pool,
    token0,
    token1,
    exactPostState: {
      reserve0: impact.v2PostState.reserve0,
      reserve1: impact.v2PostState.reserve1,
      feeBps,
      ...(impact.v2PostState.blockTimestampLast === undefined
        ? {}
        : { blockTimestampLast: impact.v2PostState.blockTimestampLast }),
    },
    blockNumber,
  });
}

async function buildUniV2VictimOverlay(
  ctx: VictimOverlayBuildContext,
): Promise<VictimOverlay> {
  const overlay = buildUniV2VictimOverlayIntent({
    impact: ctx.impact,
    validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600),
  });
  return {
    whale: overlay.whale,
    tokenDeals: overlay.tokenDeals.map((deal) => ({ ...deal })),
    preCalls: overlay.preCalls.map((call) => ({ ...call })),
  };
}

async function buildUniV2Edges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  const [token0, token1] = pool.token0 && pool.token1
    ? [ethers.getAddress(pool.token0), ethers.getAddress(pool.token1)]
    : await queryPairTokens(backend, pool.address);
  const reserves = await backend.call({
    to: pool.address,
    data: pairIface.encodeFunctionData("getReserves"),
  });
  if (!reserves || reserves === "0x" || reserves.length < 194) {
    throw new Error(`${pool.address} failed getReserves — not a valid UniV2 pair`);
  }
  const factory = pool.factory ?? ethers.getAddress(String(
    pairIface.decodeFunctionResult(
      "factory",
      await backend.call({
        to: pool.address,
        data: pairIface.encodeFunctionData("factory"),
      }),
    )[0],
  ));
  const feeBps = v2FeeBpsForFactory(factory);
  if (feeBps === null) {
    throw new Error(`${pool.address} is missing V2 factory identity`);
  }
  const taxonomy = deriveEdgeTaxonomy("swap");
  return [
    {
      adapterId: "univ2-swap",
      target: pool.address,
      tokenIn: token0,
      tokenOut: token1,
      slotKind: "swap",
      poolToken0: token0,
      poolToken1: token1,
      v2FeeBps: feeBps,
      score: pool.score,
      ...taxonomy,
    },
    {
      adapterId: "univ2-swap",
      target: pool.address,
      tokenIn: token1,
      tokenOut: token0,
      slotKind: "swap",
      poolToken0: token0,
      poolToken1: token1,
      v2FeeBps: feeBps,
      score: pool.score,
      ...taxonomy,
    },
  ];
}

async function quoteUniV2Exact(ctx: ExactQuoteContext): Promise<bigint> {
  const { state, target, tokenIn, tokenOut, amountIn, cache } = ctx;
  if (!tokenIn || !tokenOut) throw new Error("univ2 quote requires tokenIn/tokenOut");
  if (amountIn <= 0n) return 0n;
  if (cache) {
    try {
      return await cache.quoteV2(state, target, tokenIn, tokenOut, amountIn);
    } catch (error) {
      if (isStateCallAbortedError(error)) throw error;
      // Preserve the existing exact-quote fallback to on-chain pair reads.
    }
  }
  return quoteUniV2Onchain(state, target, tokenIn, amountIn);
}

async function quoteUniV2Onchain(
  state: StateBackend,
  pool: string,
  tokenIn: string,
  amountIn: bigint,
): Promise<bigint> {
  const token0Raw = await state.call({
    to: pool,
    data: pairIface.encodeFunctionData("token0"),
  });
  const token0 = ethers.getAddress(`0x${token0Raw.slice(-40)}`);
  const zeroForOne = tokenIn.toLowerCase() === token0.toLowerCase();
  const reservesRaw = await state.call({
    to: pool,
    data: pairIface.encodeFunctionData("getReserves"),
  });
  const decoded = pairIface.decodeFunctionResult("getReserves", reservesRaw);
  const [reserve0, reserve1] = [BigInt(decoded[0]), BigInt(decoded[1])];
  const [reserveIn, reserveOut] = zeroForOne
    ? [reserve0, reserve1]
    : [reserve1, reserve0];
  const feeBps = await resolveFeeBps(state, pool);
  return quoteV2ExactInput(reserveIn, reserveOut, amountIn, feeBps);
}

async function resolveFeeBps(state: Pick<StateBackend, "call">, pool: string): Promise<bigint> {
  const key = pool.toLowerCase();
  const cached = feeBpsCache.get(key);
  if (cached !== undefined) return cached;
  const raw = await state.call({
    to: pool,
    data: pairIface.encodeFunctionData("factory"),
  });
  const factory = pairIface.decodeFunctionResult("factory", raw)[0] as string;
  const feeBps = v2FeeBpsForFactory(factory);
  if (feeBps === null) {
    throw new Error(`v2 ${pool.slice(0, 10)} factory identity is missing`);
  }
  feeBpsCache.set(key, feeBps);
  return feeBps;
}

async function quoteUniV2Prepared(ctx: PreparedRouteContext): Promise<PreparedRouteQuoteResult> {
  const { request, edge } = ctx;
  let token0 = edge?.poolToken0;
  let latencyMs = 0;
  if (!token0) {
    const token0Call = await ctx.callPrepared(
      request.target,
      pairIface.encodeFunctionData("token0", []),
    );
    token0 = ethers.getAddress(`0x${token0Call.output.slice(-40)}`);
    latencyMs += token0Call.latencyMs;
  }
  const reservesCall = await ctx.callPrepared(
    request.target,
    pairIface.encodeFunctionData("getReserves", []),
  );
  latencyMs += reservesCall.latencyMs;
  const decoded = pairIface.decodeFunctionResult("getReserves", reservesCall.output);
  const [reserve0, reserve1] = [BigInt(decoded[0]), BigInt(decoded[1])];
  const zeroForOne = request.tokenIn.toLowerCase() === token0.toLowerCase();
  const [reserveIn, reserveOut] = zeroForOne
    ? [reserve0, reserve1]
    : [reserve1, reserve0];
  const feeBps = await resolveFeeBps({ call: ctx.readChain }, request.target);
  return {
    amountOut: quoteV2ExactInput(reserveIn, reserveOut, request.amountIn, feeBps),
    latencyMs,
    cacheStats: reservesCall.cacheStats,
  };
}

async function buildUniV2PlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
  const { edge, amountIn, amountOut, executor } = ctx;
  const [token0] = sortedPair(edge.tokenIn, edge.tokenOut);
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
      adapterId: "univ2-swap",
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: amountIn,
      params: {
        amount0Out: zeroForOne ? 0n : amountOut,
        amount1Out: zeroForOne ? amountOut : 0n,
        to: executor,
      },
      children: [transfer],
    }],
  };
}

async function queryPairTokens(
  backend: TokenQueryBackend,
  pool: string,
): Promise<[string, string]> {
  const [token0Raw, token1Raw] = await Promise.all([
    backend.call({ to: pool, data: pairIface.encodeFunctionData("token0") }),
    backend.call({ to: pool, data: pairIface.encodeFunctionData("token1") }),
  ]);
  return [
    ethers.getAddress(`0x${token0Raw.slice(-40)}`),
    ethers.getAddress(`0x${token1Raw.slice(-40)}`),
  ];
}

function sortedPair(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function statePoolFromResults(
  results: readonly StateReadResult[],
  prefix: string,
): string {
  const read = results.find((candidate) => candidate.id.startsWith(prefix));
  if (!read) throw new Error(`missing block-scan read prefix ${prefix}`);
  return read.id.slice(prefix.length);
}
