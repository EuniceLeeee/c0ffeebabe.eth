import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { isStateCallAbortedError } from "../../../shared/state/state-backend.js";
import type { ResolvedPlanNode } from "../../../shared/types/plan.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend, V4PoolKey } from "../../planner/token-graph.js";
import type { V4PostImpactSeed } from "../../solver/pool-state-cache.js";
import { quoteV4ExactInLocal } from "../../solver/v4-math.js";
import type {
  BlockScanStateCapability,
  StateRead,
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
} from "../blockscan-state-capability.js";
import type {
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  PreparedRouteQuoteResult,
  SwapAdapter,
  V4QuotePathStats,
} from "../route-leg-adapter.js";
import { RouteInstanceNotApplicableError } from "../route-instance-availability.js";
import {
  createUniV4SwapObservation,
  type PoolImpact,
} from "../swap-observation.js";
import type {
  LocalVictimApplyContext,
  LocalVictimApplyResult,
} from "../victim-runtime-capability.js";
import {
  defineSwapLandedEvents,
  singletonIndexedBytes32Emitter,
  UNIV4_INITIALIZE_TOPIC,
  UNIV4_MODIFY_LIQUIDITY_TOPIC,
  UNIV4_SWAP_TOPIC,
} from "../landed-event-registry.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
  currentBlockRead,
  directedPoolMid,
  encodeMulticall,
  q96DirectedReserves,
  q96PrecisionProbeAmount,
  requireRead,
} from "./blockscan-state-shared.js";
import {
  int24,
  normalizeV4Currency,
  normalizeV4PoolKey,
  realV4Currency,
  rejectNativeWethV4Pool,
  UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK,
  uint24,
  v4HooksAffectSwap,
  v4PoolId,
  validateV4CurrencyPair,
} from "./univ4-common.js";
import { univ4PoolDiscovery } from "./univ4-pool-discovery.js";

const MIN_SQRT_PRICE = 4295128740n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341n;
const MAX_UINT128 = (1n << 128n) - 1n;
const DYNAMIC_FEE_FLAG = 0x800000;
const UNISWAP_UNIVERSAL_ROUTER_V1 = "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad";
const UNISWAP_UNIVERSAL_ROUTER_V2 = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";
const initializeIface = new ethers.Interface([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);
const poolKeyCache = new Map<string, V4PoolKey>();
const univ4Emitter = singletonIndexedBytes32Emitter(
  ADDR.UNISWAP_V4_POOL_MANAGER,
  1,
);
const univ4LandedEvents = defineSwapLandedEvents({
  swaps: [{
    id: "univ4-swap",
    topic: UNIV4_SWAP_TOPIC,
    emitter: univ4Emitter,
    materialization: "family",
    discovery: { poolAdapter: "univ4", label: "univ4" },
    invalidatesWarmState: true,
  }],
  mutations: [{
    id: "univ4-modify-liquidity",
    topic: UNIV4_MODIFY_LIQUIDITY_TOPIC,
    emitter: univ4Emitter,
  }],
});

export const uniV4QuoterIface = new ethers.Interface([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const uniV4StateViewIface = new ethers.Interface([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const UNIV4_MUTATION_TOPICS = Object.freeze([
  UNIV4_INITIALIZE_TOPIC.toLowerCase(),
  UNIV4_MODIFY_LIQUIDITY_TOPIC.toLowerCase(),
  UNIV4_SWAP_TOPIC.toLowerCase(),
]);
const UNIV4_MUTATION_TOPIC_SET = new Set(UNIV4_MUTATION_TOPICS);
const UNIV4_MUTATION_QUERY = createMutationQueryDescriptor({
  addresses: [ADDR.UNISWAP_V4_POOL_MANAGER],
  topics: [UNIV4_MUTATION_TOPICS],
});
const UNIV4_CLASSIFIER_FINGERPRINT = deterministicHash({
  family: "univ4",
  version: 1,
  semantics:
    "Initialize/ModifyLiquidity/Swap invalidate slot0+liquidity; dynamic-fee pools always direct-read",
});

interface UniV4StateSchema {
  readonly pools: ReadonlyMap<string, {
    readonly currency0: string;
    readonly currency1: string;
    readonly fee: number;
  }>;
}

interface UniV4CurrentState {
  readonly poolId: string;
  readonly currency0: string;
  readonly currency1: string;
  readonly sqrtPriceX96: bigint;
  readonly liquidity: bigint;
  readonly protocolFee: bigint;
  readonly lpFee: bigint;
  readonly inactiveReason: string | null;
  readonly precisionOutputs: ReadonlyMap<string, bigint>;
  readonly precisionFailures: ReadonlyMap<string, string>;
}

export interface UniV4PoolSchemaEntry {
  readonly currency0: string;
  readonly currency1: string;
  readonly fee: number;
}

/**
 * Shared per-pool compiler core: both the legacy full compile path and the
 * state-instance path call this, so full-vs-instance parity is structural.
 * All edges of one stateKey must agree on the PoolKey-derived metadata.
 */
function compileUniV4PoolEntry(
  edges: readonly TokenEdge[],
): UniV4PoolSchemaEntry {
  const poolId = statePoolId(edges[0]);
  if (edges[0].adapterId !== "univ4-unlock" || !edges[0].v4PoolKey) {
    throw new Error("univ4 block-scan edge is missing PoolKey");
  }
  const currency0 = graphV4Currency(edges[0].v4PoolKey.currency0);
  const currency1 = graphV4Currency(edges[0].v4PoolKey.currency1);
  const fee = uint24(
    edges[0].v4PoolKey.fee,
    "fee",
    "univ4 block-scan PoolKey",
  );
  for (const edge of edges.slice(1)) {
    if (statePoolId(edge) !== poolId) {
      throw new Error(`univ4 state group mixes pools for ${poolId}`);
    }
    if (
      edge.adapterId !== "univ4-unlock" ||
      !edge.v4PoolKey ||
      graphV4Currency(edge.v4PoolKey.currency0) !== currency0 ||
      graphV4Currency(edge.v4PoolKey.currency1) !== currency1 ||
      uint24(edge.v4PoolKey.fee, "fee", "univ4 block-scan PoolKey") !== fee
    ) {
      throw new Error(`univ4 block-scan pool ${poolId} has inconsistent PoolKey`);
    }
  }
  return Object.freeze({ currency0, currency1, fee });
}

export const univ4BlockScanState = Object.freeze({
  schemaMode: "state-instance-v1",
  adapterSchemaRevision: "univ4-v1",
  stateKey(edge) {
    return statePoolId(edge);
  },

  compileStaticSchema({ edges }) {
    const pools = new Map<string, UniV4PoolSchemaEntry>();
    const byPool = new Map<string, TokenEdge[]>();
    for (const edge of edges) {
      const poolId = statePoolId(edge);
      const group = byPool.get(poolId) ?? [];
      group.push(edge);
      byPool.set(poolId, group);
    }
    for (const [poolId, groupEdges] of byPool) {
      pools.set(poolId, compileUniV4PoolEntry(groupEdges));
    }
    return Object.freeze({ pools });
  },

  compileStateInstance(input: CompileStateInstanceInput): CompiledStateInstance {
    const spec = input.spec;
    if (spec.edges.length === 0) {
      throw new Error(`univ4 instance ${spec.key} has no edges`);
    }
    const staticBindingFingerprint = stateSchemaFingerprint(spec.edges);
    const sharedFingerprint = "";
    const schemaInput = schemaInputFingerprint({
      key: spec.key,
      adapterSchemaRevision: "univ4-v1",
      staticBindingFingerprint,
      sharedFingerprint,
    });
    return Object.freeze({
      familyId: "univ4",
      stateKey: spec.stateKey,
      specFingerprint: schemaInput,
      instanceFingerprint: instanceFingerprint({
        key: spec.key,
        schemaInput,
        staticEvidence: "",
      }),
      staticEvidenceFingerprint: "",
      carryPolicy: "activity-proof",
      opaque: compileUniV4PoolEntry(spec.edges),
    });
  },

  assembleSchema(entries: ReadonlyMap<string, unknown>) {
    const pools = new Map<string, UniV4PoolSchemaEntry>();
    for (const [stateKey, opaque] of entries) {
      pools.set(stateKey, opaque as UniV4PoolSchemaEntry);
    }
    return Object.freeze({ pools });
  },

  buildCurrentBlockReads({ sourceBlock, sourceBlockHash, edges }) {
    const poolId = assertV4Group(edges);
    return Object.freeze([
      currentBlockRead({
        id: `slot0:${poolId}`,
        sourceBlock,
        sourceBlockHash,
        to: ADDR.UNISWAP_V4_STATE_VIEW,
        data: uniV4StateViewIface.encodeFunctionData("getSlot0", [poolId]),
      }),
      currentBlockRead({
        id: `liquidity:${poolId}`,
        sourceBlock,
        sourceBlockHash,
        to: ADDR.UNISWAP_V4_STATE_VIEW,
        data: uniV4StateViewIface.encodeFunctionData("getLiquidity", [poolId]),
      }),
    ]);
  },

  buildDependentBlockReads({
    sourceBlock,
    sourceBlockHash,
    schema,
    edges,
    completedRound,
    priorResults,
  }) {
    if (completedRound > 0) return Object.freeze([]);
    const snapshot = decodeUniV4State(schema, priorResults);
    if (snapshot.inactiveReason) return Object.freeze([]);
    const reads: StateRead[] = [];
    for (const edge of edges) {
      const amountIn = q96PrecisionProbeAmount({
        sqrtPriceX96: snapshot.sqrtPriceX96,
        liquidity: snapshot.liquidity,
        token0: snapshot.currency0,
        token1: snapshot.currency1,
        edge,
        maxAmountIn: MAX_UINT128,
      });
      if (amountIn === null) continue;
      const id = univ4PrecisionReadId(edge);
      if (priorResults.some((result) => result.id === id)) continue;
      reads.push(currentBlockRead({
        id,
        sourceBlock,
        sourceBlockHash,
        to: BLOCKSCAN_MULTICALL3,
        data: encodeMulticall([{
          label: id,
          target: ADDR.UNISWAP_V4_QUOTER,
          callData: encodeUniV4QuoteExactInputSingle(
            edge.tokenIn,
            edge.tokenOut,
            amountIn,
            edge.v4PoolKey,
          ),
          allowFailure: true,
        }]),
        transport: "rpc-batch",
      }));
    }
    return Object.freeze(reads);
  },

  decodeState(schema, results) {
    return decodeUniV4State(schema, results);
  },

  deriveMids(snapshot, edges) {
    if (snapshot.inactiveReason) {
      for (const edge of edges) {
        if (statePoolId(edge) !== snapshot.poolId) {
          throw new Error(
            `univ4 snapshot ${snapshot.poolId} used for ${statePoolId(edge)}`,
          );
        }
      }
      return new Map();
    }
    const mids = new Map();
    for (const edge of edges) {
      if (statePoolId(edge) !== snapshot.poolId) {
        throw new Error(`univ4 snapshot ${snapshot.poolId} used for ${statePoolId(edge)}`);
      }
      const amountIn = q96PrecisionProbeAmount({
        sqrtPriceX96: snapshot.sqrtPriceX96,
        liquidity: snapshot.liquidity,
        token0: snapshot.currency0,
        token1: snapshot.currency1,
        edge,
        maxAmountIn: MAX_UINT128,
      });
      const precisionOutput = amountIn === null
        ? undefined
        : uniV4PrecisionOutput(snapshot, edge);
      if (amountIn !== null && precisionOutput === undefined) continue;
      const precisionQuote = amountIn === null || precisionOutput === undefined
        ? undefined
        : { amountIn, amountOut: precisionOutput };
      const directed = q96DirectedReserves({
        sqrtPriceX96: snapshot.sqrtPriceX96,
        liquidity: snapshot.liquidity,
        token0: snapshot.currency0,
        token1: snapshot.currency1,
        edge,
        precisionQuote,
      });
      if (!directed) continue;
      mids.set(blockScanEdgeKey(edge), directedPoolMid({
        kind: "v4",
        edge,
        reserveIn: directed.reserveIn,
        reserveOut: directed.reserveOut,
        mid: directed.mid,
        sqrtPriceX96: directed.sqrtPriceInOutX96,
        liquidity: snapshot.liquidity,
        feeBps: Number(snapshot.lpFee) / 100,
      }));
    }
    return mids;
  },

  behaviorProvenUnavailableEdges(snapshot, edges) {
    const unavailable = new Map<string, string>();
    if (snapshot.inactiveReason) {
      for (const edge of edges) {
        if (statePoolId(edge) !== snapshot.poolId) {
          throw new Error(
            `univ4 snapshot ${snapshot.poolId} used for ${statePoolId(edge)}`,
          );
        }
        unavailable.set(blockScanEdgeKey(edge), snapshot.inactiveReason);
      }
      return unavailable;
    }
    for (const edge of edges) {
      const amountIn = q96PrecisionProbeAmount({
        sqrtPriceX96: snapshot.sqrtPriceX96,
        liquidity: snapshot.liquidity,
        token0: snapshot.currency0,
        token1: snapshot.currency1,
        edge,
        maxAmountIn: MAX_UINT128,
      });
      if (amountIn === null) continue;
      const edgeKey = blockScanEdgeKey(edge);
      const precisionOutput = snapshot.precisionOutputs.get(
        univ4PrecisionReadId(edge),
      );
      const precisionFailure = snapshot.precisionFailures.get(
        univ4PrecisionReadId(edge),
      );
      if (precisionFailure) {
        unavailable.set(
          edgeKey,
          `univ4 direction ${edge.tokenIn}->${edge.tokenOut} ` +
            `current-source precision witness failed: ${precisionFailure}`,
        );
      } else if (precisionOutput === undefined) {
        throw new Error(
          `univ4 current-source precision result missing ` +
            `${univ4PrecisionReadId(edge)}`,
        );
      } else if (precisionOutput === 0n) {
        unavailable.set(
          edgeKey,
          `univ4 direction ${edge.tokenIn}->${edge.tokenOut} returned zero ` +
            `at its current-source scanner ceiling ${amountIn}`,
        );
      }
    }
    return unavailable;
  },

  dependencies(edges) {
    assertV4Group(edges);
    return Object.freeze([
      ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase(),
      ADDR.UNISWAP_V4_STATE_VIEW.toLowerCase(),
    ]);
  },

  incremental: {
    mutationQueryDescriptor() {
      return UNIV4_MUTATION_QUERY;
    },

    classifyMutations({ schema, range }) {
      const changed = new Map<string, ReadonlySet<string>>();
      for (const [poolId, metadata] of schema.pools) {
        // PoolManager.updateDynamicLPFee has no mutation event. Dynamic-fee
        // pools therefore cannot use an unchanged-log proof.
        if ((metadata.fee & DYNAMIC_FEE_FLAG) !== 0) {
          changed.set(
            poolId,
            new Set([`slot0:${poolId}`, `liquidity:${poolId}`]),
          );
        }
      }
      for (const event of range.events) {
        const topic = event.topics[0]?.toLowerCase() ?? "";
        if (
          event.address.toLowerCase() !==
            ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase() ||
          !UNIV4_MUTATION_TOPIC_SET.has(topic)
        ) {
          throw new Error(
            "univ4 mutation range contains an unknown emitter or event",
          );
        }
        const poolId = event.topics[1]?.toLowerCase();
        if (!poolId || !ethers.isHexString(poolId, 32)) {
          throw new Error("univ4 mutation event is missing indexed poolId");
        }
        if (!schema.pools.has(poolId)) continue;
        changed.set(
          poolId,
          new Set([`slot0:${poolId}`, `liquidity:${poolId}`]),
        );
      }
      return Object.freeze({
        mutationRangeFingerprint: range.rangeFingerprint,
        classifierFingerprint: UNIV4_CLASSIFIER_FINGERPRINT,
        changedReadKeysByStateKey: changed,
      });
    },
  },
} satisfies BlockScanStateCapability<UniV4StateSchema, UniV4CurrentState>);

function decodeUniV4State(
  schema: UniV4StateSchema,
  results: readonly StateReadResult[],
): UniV4CurrentState {
  const poolId = statePoolFromResults(results, "slot0:");
  const metadata = schema.pools.get(poolId);
  if (!metadata) throw new Error(`univ4 block-scan schema missing ${poolId}`);
  const slot0 = uniV4StateViewIface.decodeFunctionResult(
    "getSlot0",
    requireRead(results, `slot0:${poolId}`).data,
  );
  const liquidity = uniV4StateViewIface.decodeFunctionResult(
    "getLiquidity",
    requireRead(results, `liquidity:${poolId}`).data,
  );
  const sqrtPriceX96 = BigInt(slot0[0]);
  const activeLiquidity = BigInt(liquidity[0]);
  const inactiveFields = [
    sqrtPriceX96 === 0n ? "sqrtPriceX96" : null,
    activeLiquidity === 0n ? "liquidity" : null,
  ].filter((field): field is string => field !== null);
  const precisionOutputs = new Map<string, bigint>();
  const precisionFailures = new Map<string, string>();
  for (const result of results) {
    if (!result.ok || !result.id.startsWith("v4-precision:")) continue;
    try {
      const aggregate = blockScanMulticallIface.decodeFunctionResult(
        "aggregate3",
        result.data,
      )[0] as readonly { success: boolean; returnData: string }[];
      if (aggregate.length !== 1) {
        precisionFailures.set(
          result.id,
          `multicall returned ${aggregate.length}/1 results`,
        );
        continue;
      }
      if (!aggregate[0].success) {
        precisionFailures.set(result.id, "quote call reverted");
        continue;
      }
      precisionOutputs.set(
        result.id,
        BigInt(
          uniV4QuoterIface.decodeFunctionResult(
            "quoteExactInputSingle",
            aggregate[0].returnData,
          )[0],
        ),
      );
    } catch (error) {
      precisionFailures.set(
        result.id,
        `malformed quote result: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return Object.freeze({
    poolId,
    currency0: metadata.currency0,
    currency1: metadata.currency1,
    sqrtPriceX96,
    liquidity: activeLiquidity,
    protocolFee: BigInt(slot0[2]),
    lpFee: BigInt(slot0[3]),
    inactiveReason:
      inactiveFields.length > 0
        ? `univ4 pool ${poolId} has zero ${inactiveFields.join(" and ")} ` +
          `at the current source`
        : null,
    precisionOutputs,
    precisionFailures,
  });
}

function univ4PrecisionReadId(edge: TokenEdge): string {
  return `v4-precision:${blockScanEdgeKey(edge)}`;
}

function uniV4PrecisionOutput(
  snapshot: UniV4CurrentState,
  edge: TokenEdge,
): bigint | undefined {
  const id = univ4PrecisionReadId(edge);
  if (snapshot.precisionFailures.has(id)) return undefined;
  return snapshot.precisionOutputs.get(id);
}

export const univ4Adapter = Object.freeze({
  id: "univ4",
  kind: "swap",
  livePoolState: { kind: "singleton-v4" },
  poolAdapters: ["univ4"],
  routeIdentity: {
    instanceKey(pool: PoolEntry) {
      if (!pool.poolId) throw new Error("univ4 route identity requires poolId");
      return JSON.stringify([
        pool.address.toLowerCase(),
        pool.poolId.toLowerCase(),
      ]);
    },
    executionVariantKey(edge: TokenEdge) {
      if (!edge.poolId) throw new Error("univ4 execution identity requires poolId");
      return JSON.stringify([edge.adapterId, edge.poolId.toLowerCase()]);
    },
  },
  planExecutionIdentity: {
    resolve(node) {
      const swaps = node.children.filter((child) =>
        child.adapterId === "univ4-swap"
      );
      if (swaps.length !== 1) {
        throw new Error(
          "univ4 resolved plan must contain one pool-bound swap child",
        );
      }
      const swap = swaps[0];
      const key = normalizeV4PoolKey({
        currency0: resolvedPlanString(swap, "currency0"),
        currency1: resolvedPlanString(swap, "currency1"),
        fee: resolvedPlanSafeNumber(swap, "fee"),
        tickSpacing: resolvedPlanSafeNumber(swap, "tickSpacing"),
        hooks: resolvedPlanString(swap, "hooks"),
      }, "univ4 resolved plan execution identity");
      return {
        routeTarget: node.target,
        poolId: v4PoolId(key),
      };
    },
  },
  identityPolicies: [{
    poolAdapter: "univ4",
    policy: "trusted-singleton-seed",
    canonicalAddress: ADDR.UNISWAP_V4_POOL_MANAGER,
    canonicalVenueId: "univ4",
    canonicalIdentitySource: "v4-manager",
  }],
  edgeAdapterIds: ["univ4-unlock"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  requiresProtocolEdgesFlag: false,
  ownedActionAdapterIds: [
    "univ4-unlock",
    "univ4-swap",
    "univ4-take",
    "univ4-sync",
    "univ4-settle",
    "univ4-settle-value",
  ],
  requiredInfraActionAdapterIds: [
    "erc20-transfer",
    "weth-deposit-value",
    "weth-withdraw-amount",
  ],
  landedEvents: univ4LandedEvents,
  poolDiscovery: univ4PoolDiscovery,
  observation: createUniV4SwapObservation({
    adapterIds: ["univ4-unlock"],
    canonicalIntakeTargets: [
      ADDR.UNISWAP_V4_POOL_MANAGER,
      UNISWAP_UNIVERSAL_ROUTER_V1,
      UNISWAP_UNIVERSAL_ROUTER_V2,
    ],
    landedEvents: univ4LandedEvents.swaps,
  }),
  victimModel: {
    id: "pool-swap:univ4",
    mode: "replay",
    runtime: {
      localApply: {
        cacheBacked: false,
        needsMutablePoolRefresh: false,
        apply: applyUniV4Victim,
      },
      exactPostImpact: uniV4ExactPostImpact,
      buildOverlay: null,
    },
  },
  pricingState: univ4BlockScanState,
  prepared: {
    quote: quoteUniV4Prepared,
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => [{
      from: ethers.ZeroAddress,
      to: ADDR.UNISWAP_V4_QUOTER,
      calldata: encodeUniV4QuoteExactInputSingle(
        ctx.request.tokenIn,
        ctx.request.tokenOut,
        ctx.request.amountIn,
        ctx.request.v4PoolKey ?? ctx.edge?.v4PoolKey,
      ),
      gasLimit: 3_000_000,
    }],
    allowanceSpender: () => null,
    prewarmAddresses: () => [],
  },

  buildEdges: buildUniV4Edges,
  quoteExact: quoteUniV4Exact,
  buildPlanFragment: buildUniV4PlanFragment,
} satisfies SwapAdapter);

function resolvedPlanString(
  node: ResolvedPlanNode,
  field: string,
): string {
  const value = node.params[field];
  if (typeof value !== "string") {
    throw new Error(`univ4 resolved plan ${field} must be a string`);
  }
  return value;
}

function resolvedPlanSafeNumber(
  node: ResolvedPlanNode,
  field: string,
): number {
  const value = node.params[field];
  if (typeof value !== "bigint") {
    throw new Error(`univ4 resolved plan ${field} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`univ4 resolved plan ${field} exceeds safe integer range`);
  }
  return parsed;
}

function applyUniV4Victim(
  ctx: LocalVictimApplyContext,
): LocalVictimApplyResult | null {
  const postImpact = uniV4ExactPostImpact(ctx.impact, ctx.blockNumber);
  if (
    !postImpact ||
    ctx.impact.amountOut === undefined ||
    ctx.impact.amountOut <= 0n
  ) {
    return null;
  }
  return { postImpact, amountOut: ctx.impact.amountOut };
}

function uniV4ExactPostImpact(
  impact: PoolImpact,
  blockNumber: number,
): V4PostImpactSeed | null {
  if (!impact.v4PostState) return null;
  return {
    kind: "v4",
    poolManager: impact.pool,
    poolId: impact.v4PostState.poolId,
    sqrtPriceX96: impact.v4PostState.sqrtPriceX96,
    tick: impact.v4PostState.tick,
    liquidity: impact.v4PostState.liquidity,
    lpFee: impact.v4PostState.lpFee,
    blockNumber,
  };
}

async function quoteUniV4Prepared(ctx: PreparedRouteContext): Promise<PreparedRouteQuoteResult> {
  const data = encodeUniV4QuoteExactInputSingle(
    ctx.request.tokenIn,
    ctx.request.tokenOut,
    ctx.request.amountIn,
    ctx.request.v4PoolKey ?? ctx.edge?.v4PoolKey,
  );
  const quoted = await ctx.callPrepared(ADDR.UNISWAP_V4_QUOTER, data, {
    gasLimit: 3_000_000,
  });
  return {
    amountOut: BigInt(
      uniV4QuoterIface.decodeFunctionResult("quoteExactInputSingle", quoted.output)[0],
    ),
    latencyMs: quoted.latencyMs,
    cacheStats: quoted.cacheStats,
  };
}

export function encodeUniV4QuoteExactInputSingle(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  poolKey: V4PoolKey | undefined,
): string {
  const key = validateQuoteInput(tokenIn, tokenOut, amountIn, poolKey);
  const zeroForOne = v4ZeroForOne(key, tokenIn, tokenOut, "V4 quoter");
  return uniV4QuoterIface.encodeFunctionData("quoteExactInputSingle", [{
    poolKey: key,
    zeroForOne,
    exactAmount: amountIn,
    hookData: "0x",
  }]);
}

async function buildUniV4Edges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  if (!pool.fixedTokenIn || !pool.fixedTokenOut) {
    throw new Error(`univ4 pool ${pool.address} requires fixedTokenIn/fixedTokenOut`);
  }
  const poolKey = await resolveV4PoolKey(pool, backend);
  const poolId = v4PoolId(poolKey);
  if (
    !pool.poolId ||
    normalizeBytes32(pool.poolId, "poolId") !== poolId
  ) {
    throw new Error(
      `univ4 PoolKey does not match registered poolId ${pool.poolId ?? "missing"}`,
    );
  }
  if (v4HooksAffectSwap(poolKey.hooks)) {
    throw new RouteInstanceNotApplicableError(
      `univ4-standard excludes swap-affecting hooks ${poolKey.hooks}`,
    );
  }
  const tIn = normalizeV4Currency(pool.fixedTokenIn, "fixedTokenIn", "univ4 PoolKey");
  const tOut = normalizeV4Currency(pool.fixedTokenOut, "fixedTokenOut", "univ4 PoolKey");
  validateGraphPair(pool.address, poolKey, tIn, tOut);
  const graphIn = tIn === ethers.ZeroAddress ? ADDR.WETH : tIn;
  const graphOut = tOut === ethers.ZeroAddress ? ADDR.WETH : tOut;
  if (graphIn.toLowerCase() === graphOut.toLowerCase()) {
    throw new RouteInstanceNotApplicableError(
      "univ4-standard excludes pools whose currencies collapse to one graph token",
    );
  }
  const nativeCurrency0 = poolKey.currency0 === ethers.ZeroAddress;
  const nativeCurrency1 = poolKey.currency1 === ethers.ZeroAddress;
  const taxonomy = deriveEdgeTaxonomy("swap");
  const common = {
    adapterId: "univ4-unlock",
    target: pool.address,
    slotKind: "swap" as const,
    v4PoolKey: poolKey,
    poolId,
    nativeCurrency0,
    nativeCurrency1,
    score: pool.score,
    ...taxonomy,
  };
  return [
    { ...common, tokenIn: graphIn, tokenOut: graphOut },
    { ...common, tokenIn: graphOut, tokenOut: graphIn },
  ];
}

async function quoteUniV4Exact(ctx: ExactQuoteContext): Promise<bigint> {
  const { state, tokenIn, tokenOut, amountIn, v4PoolKey, v4QuoteStats: stats } = ctx;
  if (!tokenIn || !tokenOut) throw new Error("univ4 quote requires tokenIn/tokenOut");
  if (amountIn <= 0n) return 0n;
  const key = validateQuoteInput(tokenIn, tokenOut, amountIn, v4PoolKey);
  if (isLocalQuoteEligible(key)) {
    try {
      const amountOut = await quoteV4ExactInLocal(state, key, tokenIn, tokenOut, amountIn);
      if (stats) stats.local++;
      return amountOut;
    } catch (error) {
      if (isStateCallAbortedError(error)) throw error;
      if (stats) stats.localFailures++;
    }
  } else if (stats) {
    stats.hookSkipped++;
  }

  if (stats) stats.fallback++;
  const data = encodeUniV4QuoteExactInputSingle(tokenIn, tokenOut, amountIn, key);
  const result = await state.call({ to: ADDR.UNISWAP_V4_QUOTER, data });
  return BigInt(uniV4QuoterIface.decodeFunctionResult("quoteExactInputSingle", result)[0]);
}

async function buildUniV4PlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
  const { edge, amountIn, amountOut, rawOut } = ctx;
  if (!edge.v4PoolKey) {
    throw new Error(`univ4-unlock edge missing v4PoolKey: ${edge.tokenIn} -> ${edge.tokenOut}`);
  }
  const key = normalizeV4PoolKey(edge.v4PoolKey, "plan-builder: v4 PoolKey");
  rejectNativeWethV4Pool(key, "plan-builder");
  const realIn = realV4Currency(edge.tokenIn, key, "tokenIn", "plan-builder: v4");
  const realOut = realV4Currency(edge.tokenOut, key, "tokenOut", "plan-builder: v4");
  validateV4CurrencyPair(realIn, realOut, key, "plan-builder");
  const zeroForOne = realIn.toLowerCase() === key.currency0.toLowerCase();
  const inputIsNative = realIn.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  const outputIsNative = realOut.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  const takeAmount = rawOut ?? amountOut;

  const children: ResolvedPlanNode[] = [
    {
      adapterId: "univ4-swap",
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: amountIn,
      params: {
        currency0: key.currency0,
        currency1: key.currency1,
        fee: BigInt(key.fee),
        tickSpacing: BigInt(key.tickSpacing),
        hooks: key.hooks,
        zeroForOne,
        amountSpecified: -amountIn,
        sqrtPriceLimit: zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE,
      },
      children: [],
    },
    {
      adapterId: "univ4-take",
      target: edge.target,
      tokenIn: "",
      tokenOut: edge.tokenOut,
      amount: takeAmount,
      params: { currency: realOut },
      children: [],
    },
  ];

  if (outputIsNative) {
    children.push({
      adapterId: "weth-deposit-value",
      target: ADDR.WETH,
      tokenIn: realOut,
      tokenOut: ADDR.WETH,
      amount: takeAmount,
      params: {},
      children: [],
    });
  }

  if (inputIsNative) {
    children.push(
      {
        adapterId: "weth-withdraw-amount",
        target: ADDR.WETH,
        tokenIn: ADDR.WETH,
        tokenOut: realIn,
        amount: amountIn,
        params: {},
        children: [],
      },
      {
        adapterId: "univ4-sync",
        target: edge.target,
        tokenIn: realIn,
        tokenOut: "",
        amount: 0n,
        params: { currency: ethers.ZeroAddress },
        children: [],
      },
      {
        adapterId: "univ4-settle-value",
        target: edge.target,
        tokenIn: "",
        tokenOut: "",
        amount: amountIn,
        params: {},
        children: [],
      },
    );
  } else {
    children.push(
      {
        adapterId: "univ4-sync",
        target: edge.target,
        tokenIn: realIn,
        tokenOut: "",
        amount: 0n,
        params: { currency: realIn },
        children: [],
      },
      {
        adapterId: "erc20-transfer",
        target: realIn,
        tokenIn: realIn,
        tokenOut: realIn,
        amount: amountIn,
        params: { to: edge.target, amount: amountIn },
        children: [],
      },
      {
        adapterId: "univ4-settle",
        target: edge.target,
        tokenIn: "",
        tokenOut: "",
        amount: 0n,
        params: {},
        children: [],
      },
    );
  }

  return {
    requirements: [],
    nodes: [{
      adapterId: "univ4-unlock",
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: 0n,
      params: {},
      children,
    }],
  };
}

function validateQuoteInput(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  poolKey: V4PoolKey | undefined,
): V4PoolKey {
  if (!poolKey) throw new Error(`V4 quoter: missing PoolKey for ${tokenIn} -> ${tokenOut}`);
  if (amountIn < 0n || amountIn > MAX_UINT128) {
    throw new Error(`V4 quoter: exactAmount does not fit uint128: ${amountIn}`);
  }
  const key = normalizeV4PoolKey(poolKey, "V4 quoter: PoolKey");
  v4ZeroForOne(key, tokenIn, tokenOut, "V4 quoter");
  return key;
}

function v4ZeroForOne(
  key: V4PoolKey,
  tokenIn: string,
  tokenOut: string,
  context: string,
): boolean {
  rejectNativeWethV4Pool(key, context);
  const realIn = realV4Currency(tokenIn, key, "tokenIn", context);
  const realOut = realV4Currency(tokenOut, key, "tokenOut", context);
  validateV4CurrencyPair(realIn, realOut, key, context);
  if (realIn.toLowerCase() === key.currency0.toLowerCase()) return true;
  if (realIn.toLowerCase() === key.currency1.toLowerCase()) return false;
  throw new Error(`V4 quoter: tokens ${tokenIn} -> ${tokenOut} do not match PoolKey`);
}

function isLocalQuoteEligible(key: V4PoolKey): boolean {
  return key.hooks.toLowerCase() === ethers.ZeroAddress.toLowerCase() &&
    !v4HooksAffectSwap(key.hooks);
}

async function resolveV4PoolKey(pool: PoolEntry, backend: TokenQueryBackend): Promise<V4PoolKey> {
  if (hasInlineV4PoolKey(pool)) return v4PoolKeyFromEntry(pool);
  if (pool.poolId && backend.getLogs) {
    const cacheKey = pool.poolId.toLowerCase();
    const cached = poolKeyCache.get(cacheKey);
    if (cached) return cached;
    const logs = await backend.getLogs({
      address: ADDR.UNISWAP_V4_POOL_MANAGER,
      topics: [UNIV4_INITIALIZE_TOPIC, normalizeBytes32(pool.poolId, "poolId")],
      fromBlock: ethers.toQuantity(UNISWAP_V4_POOL_MANAGER_DEPLOY_BLOCK),
      toBlock: "latest",
    });
    const first = logs[0];
    if (first) {
      const parsed = initializeIface.parseLog({ topics: first.topics, data: first.data });
      if (parsed) {
        const key = {
          currency0: normalizeV4Currency(String(parsed.args.currency0), "currency0", "univ4 PoolKey"),
          currency1: normalizeV4Currency(String(parsed.args.currency1), "currency1", "univ4 PoolKey"),
          fee: uint24(Number(parsed.args.fee), "fee", "univ4 PoolKey"),
          tickSpacing: int24(Number(parsed.args.tickSpacing), "tickSpacing", "univ4 PoolKey"),
          hooks: normalizeV4Currency(String(parsed.args.hooks), "hooks", "univ4 PoolKey"),
        };
        poolKeyCache.set(cacheKey, key);
        return key;
      }
    }
  }
  return v4PoolKeyFromEntry(pool);
}

function hasInlineV4PoolKey(pool: PoolEntry): boolean {
  return pool.currency0 !== undefined && pool.currency1 !== undefined && pool.fee !== undefined &&
    pool.tickSpacing !== undefined && pool.hooks !== undefined;
}

function v4PoolKeyFromEntry(pool: PoolEntry): V4PoolKey {
  const missing: string[] = [];
  if (pool.currency0 === undefined) missing.push("currency0");
  if (pool.currency1 === undefined) missing.push("currency1");
  if (pool.fee === undefined) missing.push("fee");
  if (pool.tickSpacing === undefined) missing.push("tickSpacing");
  if (pool.hooks === undefined) missing.push("hooks");
  if (missing.length > 0) {
    const id = pool.poolId ? `${pool.address} poolId=${pool.poolId}` : pool.address;
    throw new Error(`univ4 pool ${id} missing PoolKey field(s): ${missing.join(", ")}`);
  }
  return normalizeV4PoolKey({
    currency0: pool.currency0!,
    currency1: pool.currency1!,
    fee: pool.fee!,
    tickSpacing: pool.tickSpacing!,
    hooks: pool.hooks!,
  }, "univ4 PoolKey");
}

function normalizeBytes32(value: string, field: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`univ4 ${field} must be bytes32, got ${value}`);
  }
  return value.toLowerCase();
}

function validateGraphPair(pool: string, key: V4PoolKey, tokenIn: string, tokenOut: string): void {
  const currencies = new Set([key.currency0.toLowerCase(), key.currency1.toLowerCase()]);
  if (!currencies.has(tokenIn.toLowerCase()) || !currencies.has(tokenOut.toLowerCase())) {
    throw new Error(
      `univ4 pool ${pool} fixed tokens ${tokenIn}/${tokenOut} do not match PoolKey ` +
        `${key.currency0}/${key.currency1}`,
    );
  }
}

function statePoolId(edge: TokenEdge): string {
  if (edge.adapterId !== "univ4-unlock" || !edge.v4PoolKey) {
    throw new Error(`univ4 block-scan edge ${edge.target} is missing PoolKey`);
  }
  const computed = v4PoolId(edge.v4PoolKey);
  if (edge.poolId && edge.poolId.toLowerCase() !== computed) {
    throw new Error(
      `univ4 block-scan edge poolId ${edge.poolId} does not match ${computed}`,
    );
  }
  return computed;
}

function assertV4Group(edges: readonly TokenEdge[]): string {
  if (edges.length === 0) throw new Error("univ4 block-scan state group has no edges");
  const poolId = statePoolId(edges[0]);
  for (const edge of edges) {
    if (statePoolId(edge) !== poolId) {
      throw new Error(`mixed univ4 pools in state group ${poolId}`);
    }
  }
  return poolId;
}

function graphV4Currency(currency: string): string {
  return currency.toLowerCase() === ethers.ZeroAddress.toLowerCase()
    ? ADDR.WETH.toLowerCase()
    : ethers.getAddress(currency).toLowerCase();
}

function statePoolFromResults(
  results: readonly StateReadResult[],
  prefix: string,
): string {
  const read = results.find((candidate) => candidate.id.startsWith(prefix));
  if (!read) throw new Error(`missing block-scan read prefix ${prefix}`);
  return read.id.slice(prefix.length);
}

export type { V4QuotePathStats };
