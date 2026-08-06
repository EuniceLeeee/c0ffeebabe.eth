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
  staticEvidenceFingerprint,
  type CompiledStateInstance,
  type CompileStateInstanceInput,
} from "../blockscan-state-capability.js";
import { findVenueByFactory } from "../capability.js";
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
  BLOCKSCAN_MULTICALL3,
  assertPoolGroup,
  blockScanMulticallIface,
  canonicalPoolStateKey,
  currentBlockRead,
  encodeMulticall,
  directedPoolMid,
  q96DirectedReserves,
  q96PrecisionProbeAmount,
  requireRead,
} from "./blockscan-state-shared.js";

const UNIV3_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const PANCAKE_V3_QUOTER_V2 = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const UNIV3_SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const UNIV3_SWAP_ROUTER_V1 = "0xe592427a0aece92de3edee1f18e0157c05861564";
const MIN_SQRT_PRICE = 4295128740n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341n;
const MAX_V3_EXACT_INPUT = (1n << 255n) - 1n;
const poolIface = new ethers.Interface([
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const v3StateIface = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
const v3FactoryIface = new ethers.Interface([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
]);
const quoterV2Iface = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const univ3RouterIface = new ethers.Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)",
]);
const poolTokensCache = new Map<string, [string, string]>();
const preparedBindingCache = new Map<
  string,
  Promise<{ readonly quoter: string; readonly fee: number }>
>();
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

interface UniV3PoolSchema {
  readonly token0: string;
  readonly token1: string;
  readonly fee: bigint;
  readonly tickSpacing: number;
  readonly factory: string | null;
  readonly reverseBindingStatus:
    | "pending"
    | "verified"
    | "unsupported"
    | "rejected";
  readonly reverseBindingFailure: string | null;
  readonly precisionQuoterCandidate: string | null;
}

interface UniV3StateSchema {
  readonly pools: ReadonlyMap<string, UniV3PoolSchema>;
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
  readonly inactiveReason: string | null;
  readonly factory: string | null;
  readonly reverseBindingStatus: UniV3PoolSchema["reverseBindingStatus"];
  readonly precisionQuoter: string | null;
  readonly reverseBindingFailure: string | null;
  readonly precisionOutputs: ReadonlyMap<string, bigint>;
  readonly precisionFailures: ReadonlyMap<string, string>;
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
  schemaMode: "state-instance-v1",
  adapterSchemaRevision: "univ3-v1",
  stateKey: canonicalPoolStateKey,

  compileStaticSchema({ edges }) {
    return compileUniV3StateSchema(edges);
  },

  extendStaticSchema(previousSchema, { edges }) {
    return compileUniV3StateSchema(edges, previousSchema);
  },

  buildStaticSchemaReads({ sourceBlock, sourceBlockHash, schema }) {
    const reads: StateRead[] = [];
    for (const [pool, metadata] of schema.pools) {
      if (
        metadata.reverseBindingStatus !== "pending" ||
        metadata.factory === null
      ) {
        continue;
      }
      reads.push(v3FactoryBindingRead({
        pool,
        metadata,
        sourceBlock,
        sourceBlockHash,
      }));
    }
    return Object.freeze(reads);
  },

  hydrateStaticSchema(schema, results) {
    const pools = new Map<string, UniV3PoolSchema>();
    for (const [pool, metadata] of schema.pools) {
      if (metadata.reverseBindingStatus !== "pending") {
        pools.set(pool, metadata);
        continue;
      }
      const result = results.find(
        (candidate) => candidate.id === v3FactoryBindingReadId(pool),
      );
      if (!result || !result.ok) {
        // Transport/deadline failures carry no negative identity proof. The
        // state-key-local current read below retries without poisoning peers.
        pools.set(pool, metadata);
        continue;
      }
      const failure = decodeV3FactoryBinding(metadata, pool, result.data);
      pools.set(pool, Object.freeze({
        ...metadata,
        reverseBindingStatus: failure === null
          ? "verified"
          : "rejected",
        reverseBindingFailure: failure,
      }));
    }
    return Object.freeze({ pools });
  },

  async compileStateInstance(
    input: CompileStateInstanceInput,
  ): Promise<CompiledStateInstance> {
    const spec = input.spec;
    if (spec.edges.length === 0) {
      throw new Error(`univ3 instance ${spec.key} has no edges`);
    }
    let entry = compileUniV3InstanceCore(
      spec.stateKey,
      spec.edges,
      input.previous?.opaque as UniV3PoolSchema | undefined,
    );
    let staticEvidence = "";
    if (
      entry.reverseBindingStatus === "pending" &&
      entry.factory !== null &&
      input.readStatic
    ) {
      const results = await input.readStatic(Object.freeze([
        v3FactoryBindingRead({
          pool: spec.stateKey,
          metadata: entry,
          sourceBlock: input.sourceBlock,
          sourceBlockHash: input.sourceBlockHash,
        }),
      ]));
      if (results.length === 1) {
        const result = results[0];
        if (result.ok) {
          const failure = decodeV3FactoryBinding(
            entry,
            spec.stateKey,
            result.data,
          );
          entry = Object.freeze({
            ...entry,
            reverseBindingStatus: failure === null
              ? "verified"
              : "rejected",
            reverseBindingFailure: failure,
          });
        }
        staticEvidence = staticEvidenceFingerprint(results);
      }
    }
    const schemaInput = schemaInputFingerprint({
      key: spec.key,
      adapterSchemaRevision: "univ3-v1",
      staticBindingFingerprint: stateSchemaFingerprint(spec.edges),
      sharedFingerprint: "",
    });
    return Object.freeze({
      familyId: "univ3-standard",
      stateKey: spec.stateKey,
      specFingerprint: schemaInput,
      staticEvidenceFingerprint: staticEvidence,
      instanceFingerprint: instanceFingerprint({
        key: spec.key,
        schemaInput,
        staticEvidence,
      }),
      carryPolicy: "activity-proof",
      opaque: entry,
    });
  },

  assembleSchema(entries: ReadonlyMap<string, unknown>) {
    const pools = new Map<string, UniV3PoolSchema>();
    for (const [stateKey, opaque] of entries) {
      pools.set(stateKey, opaque as UniV3PoolSchema);
    }
    return Object.freeze({ pools });
  },

  buildCurrentBlockReads({ sourceBlock, sourceBlockHash, schema, edges }) {
    const pool = assertPoolGroup(edges, UNIV3_EDGE_IDS);
    const metadata = schema.pools.get(pool);
    if (!metadata) throw new Error(`univ3 block-scan schema missing ${pool}`);
    const reads: StateRead[] = [
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
    ];
    if (
      metadata.factory &&
      metadata.reverseBindingStatus === "pending"
    ) {
      reads.push(v3FactoryBindingRead({
        pool,
        metadata,
        sourceBlock,
        sourceBlockHash,
      }));
    }
    return Object.freeze(reads);
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
    const snapshot = decodeUniV3State(schema, priorResults);
    if (
      snapshot.inactiveReason ||
      snapshot.reverseBindingStatus === "rejected"
    ) {
      return Object.freeze([]);
    }
    if (!snapshot.precisionQuoter) return Object.freeze([]);
    const reads: StateRead[] = [];
    for (const edge of edges) {
      const amountIn = q96PrecisionProbeAmount({
        sqrtPriceX96: snapshot.sqrtPriceX96,
        liquidity: snapshot.liquidity,
        token0: snapshot.token0,
        token1: snapshot.token1,
        edge,
        maxAmountIn: MAX_V3_EXACT_INPUT,
      });
      if (amountIn === null) continue;
      const id = univ3PrecisionReadId(edge);
      if (priorResults.some((result) => result.id === id)) continue;
      const quoteCallData = quoterV2Iface.encodeFunctionData(
        "quoteExactInputSingle",
        [{
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenOut,
          amountIn,
          fee: snapshot.fee,
          sqrtPriceLimitX96: 0n,
        }],
      );
      reads.push(currentBlockRead({
        id,
        sourceBlock,
        sourceBlockHash,
        to: BLOCKSCAN_MULTICALL3,
        data: encodeMulticall([{
          label: id,
          target: snapshot.precisionQuoter,
          callData: quoteCallData,
          allowFailure: true,
        }]),
        transport: "rpc-batch",
      }));
    }
    return Object.freeze(reads);
  },

  decodeState(schema, results) {
    return decodeUniV3State(schema, results);
  },

  deriveMids(snapshot, edges) {
    if (
      snapshot.inactiveReason ||
      snapshot.reverseBindingStatus === "rejected"
    ) {
      for (const edge of edges) {
        if (canonicalPoolStateKey(edge) !== snapshot.pool) {
          throw new Error(
            `univ3 snapshot ${snapshot.pool} used for ${edge.target}`,
          );
        }
      }
      return new Map();
    }
    const mids = new Map();
    for (const edge of edges) {
      if (canonicalPoolStateKey(edge) !== snapshot.pool) {
        throw new Error(`univ3 snapshot ${snapshot.pool} used for ${edge.target}`);
      }
      const amountIn = q96PrecisionProbeAmount({
        sqrtPriceX96: snapshot.sqrtPriceX96,
        liquidity: snapshot.liquidity,
        token0: snapshot.token0,
        token1: snapshot.token1,
        edge,
        maxAmountIn: MAX_V3_EXACT_INPUT,
      });
      const precisionOutput = amountIn === null
        ? undefined
        : uniV3PrecisionOutput(snapshot, edge);
      if (amountIn !== null && precisionOutput === undefined) continue;
      const precisionQuote = amountIn === null || precisionOutput === undefined
        ? undefined
        : { amountIn, amountOut: precisionOutput };
      const directed = q96DirectedReserves({
        sqrtPriceX96: snapshot.sqrtPriceX96,
        liquidity: snapshot.liquidity,
        token0: snapshot.token0,
        token1: snapshot.token1,
        edge,
        precisionQuote,
      });
      if (!directed) continue;
      mids.set(blockScanEdgeKey(edge), directedPoolMid({
        kind: "v3",
        edge,
        reserveIn: directed.reserveIn,
        reserveOut: directed.reserveOut,
        mid: directed.mid,
        sqrtPriceX96: directed.sqrtPriceInOutX96,
        liquidity: snapshot.liquidity,
        feeBps: Number(snapshot.fee) / 100,
      }));
    }
    return mids;
  },

  behaviorProvenUnavailableEdges(snapshot, edges) {
    const unavailable = new Map<string, string>();
    if (
      snapshot.inactiveReason ||
      snapshot.reverseBindingStatus === "rejected"
    ) {
      const reason =
        snapshot.inactiveReason ?? snapshot.reverseBindingFailure!;
      for (const edge of edges) {
        if (canonicalPoolStateKey(edge) !== snapshot.pool) {
          throw new Error(
            `univ3 snapshot ${snapshot.pool} used for ${edge.target}`,
          );
        }
        unavailable.set(blockScanEdgeKey(edge), reason);
      }
      return unavailable;
    }
    for (const edge of edges) {
      const amountIn = q96PrecisionProbeAmount({
        sqrtPriceX96: snapshot.sqrtPriceX96,
        liquidity: snapshot.liquidity,
        token0: snapshot.token0,
        token1: snapshot.token1,
        edge,
        maxAmountIn: MAX_V3_EXACT_INPUT,
      });
      if (amountIn === null) continue;
      const edgeKey = blockScanEdgeKey(edge);
      const precisionOutput = snapshot.precisionOutputs.get(
        univ3PrecisionReadId(edge),
      );
      const precisionFailure = snapshot.precisionFailures.get(
        univ3PrecisionReadId(edge),
      );
      if (!snapshot.precisionQuoter) {
        unavailable.set(
          edgeKey,
          `univ3 direction ${edge.tokenIn}->${edge.tokenOut} requires a ` +
            `factory-bound current-source precision witness, but factory ` +
            `${snapshot.factory ?? "unknown"} has no registered witness`,
        );
      } else if (precisionFailure) {
        unavailable.set(
          edgeKey,
          `univ3 direction ${edge.tokenIn}->${edge.tokenOut} factory-bound ` +
            `current-source precision witness failed: ${precisionFailure}`,
        );
      } else if (precisionOutput === undefined) {
        throw new Error(
          `univ3 current-source precision result missing ` +
            `${univ3PrecisionReadId(edge)}`,
        );
      } else if (precisionOutput === 0n) {
        unavailable.set(
          edgeKey,
          `univ3 direction ${edge.tokenIn}->${edge.tokenOut} returned zero ` +
            `at its current-source scanner ceiling ${amountIn}`,
        );
      }
    }
    return unavailable;
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

function decodeUniV3State(
  schema: UniV3StateSchema,
  results: readonly StateReadResult[],
): UniV3CurrentState {
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
  const sqrtPriceX96 = BigInt(slot0[0]);
  const activeLiquidity = BigInt(liquidity[0]);
  const inactiveFields = [
    sqrtPriceX96 === 0n ? "sqrtPriceX96" : null,
    activeLiquidity === 0n ? "liquidity" : null,
  ].filter((field): field is string => field !== null);
  let precisionQuoter: string | null = null;
  let reverseBindingFailure = metadata.reverseBindingFailure;
  let reverseBindingStatus = metadata.reverseBindingStatus;
  if (metadata.reverseBindingStatus === "verified") {
    precisionQuoter = metadata.precisionQuoterCandidate;
  } else if (metadata.reverseBindingStatus === "pending") {
    const failure = decodeV3FactoryBinding(
      metadata,
      pool,
      requireRead(results, v3FactoryBindingReadId(pool)).data,
    );
    if (failure === null) {
      precisionQuoter = metadata.precisionQuoterCandidate;
      reverseBindingFailure = null;
      reverseBindingStatus = "verified";
    } else {
      reverseBindingFailure = failure;
      reverseBindingStatus = "rejected";
    }
  }
  const precisionOutputs = new Map<string, bigint>();
  const precisionFailures = new Map<string, string>();
  for (const result of results) {
    if (!result.ok || !result.id.startsWith("v3-precision:")) continue;
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
      precisionOutputs.set(result.id, BigInt(
        quoterV2Iface.decodeFunctionResult(
          "quoteExactInputSingle",
          aggregate[0].returnData,
        )[0],
      ));
    } catch (error) {
      precisionFailures.set(
        result.id,
        `malformed quote result: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return Object.freeze({
    pool,
    token0: metadata.token0,
    token1: metadata.token1,
    sqrtPriceX96,
    tick: Number(slot0[1]),
    liquidity: activeLiquidity,
    fee: metadata.fee,
    tickSpacing: metadata.tickSpacing,
    observationIndex: Number(slot0[2]),
    observationCardinality: Number(slot0[3]),
    observationCardinalityNext: Number(slot0[4]),
    feeProtocol: Number(slot0[5]),
    unlocked: Boolean(slot0[6]),
    factory: metadata.factory,
    reverseBindingStatus,
    precisionQuoter,
    reverseBindingFailure,
    inactiveReason:
      inactiveFields.length > 0
        ? `univ3 pool ${pool} has zero ${inactiveFields.join(" and ")} ` +
          `at the current source`
        : null,
    precisionOutputs,
    precisionFailures,
  });
}

function univ3PrecisionReadId(edge: TokenEdge): string {
  return `v3-precision:${blockScanEdgeKey(edge)}`;
}

function v3FactoryBindingReadId(pool: string): string {
  return `v3-factory-binding:${pool}`;
}

function compileUniV3StateSchema(
  edges: readonly TokenEdge[],
  previousSchema?: UniV3StateSchema,
): UniV3StateSchema {
  const pools = new Map<string, UniV3PoolSchema>();
  const byPool = new Map<string, TokenEdge[]>();
  for (const edge of edges) {
    const pool = canonicalPoolStateKey(edge);
    const group = byPool.get(pool) ?? [];
    group.push(edge);
    byPool.set(pool, group);
  }
  for (const [pool, group] of byPool) {
    pools.set(
      pool,
      compileUniV3InstanceCore(
        pool,
        group,
        previousSchema?.pools.get(pool),
      ),
    );
  }
  return Object.freeze({ pools });
}

/**
 * Shared per-instance compiler core: both the legacy full compile path and the
 * state-instance path call this, so full-vs-instance parity is structural.
 * All edges of one stateKey must agree on token order, fee, tick spacing and
 * factory.
 */
function compileUniV3InstanceCore(
  pool: string,
  edges: readonly TokenEdge[],
  previous?: UniV3PoolSchema,
): UniV3PoolSchema {
  const first = edges[0];
  if (!first) {
    throw new Error(`univ3 instance ${pool} has no edges`);
  }
  if (canonicalPoolStateKey(first) !== pool) {
    throw new Error(`univ3 state group mixes pools for ${pool}`);
  }
  if (!first.poolToken0 || !first.poolToken1) {
    throw new Error(`univ3 block-scan edge ${pool} is missing token order`);
  }
  const token0 = ethers.getAddress(first.poolToken0);
  const token1 = ethers.getAddress(first.poolToken1);
  if (
    first.v3Fee === undefined ||
    !Number.isSafeInteger(first.v3Fee) ||
    first.v3Fee < 0
  ) {
    throw new Error(`univ3 block-scan edge ${pool} is missing attested fee`);
  }
  const fee = BigInt(first.v3Fee);
  if (
    first.v3TickSpacing === undefined ||
    !Number.isSafeInteger(first.v3TickSpacing) ||
    first.v3TickSpacing <= 0
  ) {
    throw new Error(
      `univ3 block-scan edge ${pool} is missing attested tick spacing`,
    );
  }
  const tickSpacing = first.v3TickSpacing;
  const factory = first.factory === undefined
    ? null
    : ethers.getAddress(first.factory);
  const reverseBindingRequired = isRegisteredStandardUniV3Factory(factory);
  const publishedBindingMatches =
    reverseBindingRequired &&
    previous?.reverseBindingStatus === "verified" &&
    previous.token0 === token0 &&
    previous.token1 === token1 &&
    previous.fee === fee &&
    previous.tickSpacing === tickSpacing &&
    previous.factory === factory;
  const reverseBindingStatus = reverseBindingRequired
    ? publishedBindingMatches
      ? "verified"
      : "pending"
    : "unsupported";
  const reverseBindingFailure = reverseBindingRequired
    ? null
    : factory === null
      ? `univ3 pool ${pool} has no reverse-attested factory`
      : `univ3 pool ${pool} factory ${factory} is not a registered ` +
        "standard V3 reverse-binding factory";
  const precisionQuoterCandidate = uniV3QuoterForFactory(factory);
  for (const edge of edges.slice(1)) {
    if (canonicalPoolStateKey(edge) !== pool) {
      throw new Error(`univ3 state group mixes pools for ${pool}`);
    }
    if (
      !edge.poolToken0 ||
      !edge.poolToken1 ||
      ethers.getAddress(edge.poolToken0) !== token0 ||
      ethers.getAddress(edge.poolToken1) !== token1 ||
      edge.v3Fee === undefined ||
      BigInt(edge.v3Fee) !== fee ||
      edge.v3TickSpacing === undefined ||
      edge.v3TickSpacing !== tickSpacing ||
      (edge.factory === undefined ? null : ethers.getAddress(edge.factory)) !==
        factory
    ) {
      throw new Error(`univ3 block-scan pool ${pool} has inconsistent metadata`);
    }
  }
  return Object.freeze({
    token0,
    token1,
    fee,
    tickSpacing,
    factory,
    reverseBindingStatus,
    reverseBindingFailure,
    precisionQuoterCandidate,
  });
}

function v3FactoryBindingRead(input: {
  readonly pool: string;
  readonly metadata: UniV3PoolSchema;
  readonly sourceBlock: number;
  readonly sourceBlockHash: string;
}): StateRead {
  if (input.metadata.factory === null) {
    throw new Error(`univ3 pool ${input.pool} has no factory for reverse binding`);
  }
  const [tokenA, tokenB] = sortUniV3TokenPair(
    input.metadata.token0,
    input.metadata.token1,
  );
  return currentBlockRead({
    id: v3FactoryBindingReadId(input.pool),
    sourceBlock: input.sourceBlock,
    sourceBlockHash: input.sourceBlockHash,
    to: input.metadata.factory,
    data: v3FactoryIface.encodeFunctionData("getPool", [
      tokenA,
      tokenB,
      input.metadata.fee,
    ]),
  });
}

function decodeV3FactoryBinding(
  metadata: UniV3PoolSchema,
  pool: string,
  rawBinding: string,
): string | null {
  try {
    const boundPool = ethers.getAddress(String(
      v3FactoryIface.decodeFunctionResult("getPool", rawBinding)[0],
    ));
    return boundPool === ethers.getAddress(pool)
      ? null
      : `univ3 factory ${metadata.factory} binds ` +
        `${metadata.token0}/${metadata.token1}/${metadata.fee} to ` +
        `${boundPool}, not target ${pool}, at the current source`;
  } catch (error) {
    return `univ3 factory ${metadata.factory} returned malformed getPool ` +
      `evidence for ${pool}: ` +
      `${error instanceof Error ? error.message : String(error)}`;
  }
}

function uniV3PrecisionOutput(
  snapshot: UniV3CurrentState,
  edge: TokenEdge,
): bigint | undefined {
  const id = univ3PrecisionReadId(edge);
  if (snapshot.precisionFailures.has(id)) return undefined;
  return snapshot.precisionOutputs.get(id);
}

function uniV3QuoterForFactory(
  factory: string | null,
): string | null {
  const identity = findVenueByFactory(factory);
  // Each QuoterV2 deterministically routes through its own factory. Reusing
  // one lineage's quoter for another can quote a different pool with the same
  // token/fee tuple, so provisional factories remain fail-closed.
  if (
    identity?.compatibility !== "standard" ||
    identity.poolAdapter !== "univ3"
  ) {
    return null;
  }
  if (identity.venue === "univ3") return UNIV3_QUOTER_V2;
  if (identity.venue === "pancake-v3") return PANCAKE_V3_QUOTER_V2;
  return null;
}

function isRegisteredStandardUniV3Factory(factory: string | null): boolean {
  const identity = findVenueByFactory(factory);
  return identity?.compatibility === "standard" &&
    identity.poolAdapter === "univ3";
}

async function resolveUniV3FactoryBoundQuoter(
  read: (req: { readonly to: string; readonly data: string }) => Promise<string>,
  pool: string,
  tokenIn: string,
  tokenOut: string,
): Promise<{ readonly quoter: string; readonly fee: number }> {
  const [rawFactory, rawToken0, rawToken1, rawFee] = await Promise.all([
    read({
      to: pool,
      data: poolIface.encodeFunctionData("factory"),
    }),
    read({
      to: pool,
      data: poolIface.encodeFunctionData("token0"),
    }),
    read({
      to: pool,
      data: poolIface.encodeFunctionData("token1"),
    }),
    read({
      to: pool,
      data: poolIface.encodeFunctionData("fee"),
    }),
  ]);
  const factory = ethers.getAddress(
    String(poolIface.decodeFunctionResult("factory", rawFactory)[0]),
  );
  const token0 = ethers.getAddress(
    String(poolIface.decodeFunctionResult("token0", rawToken0)[0]),
  );
  const token1 = ethers.getAddress(
    String(poolIface.decodeFunctionResult("token1", rawToken1)[0]),
  );
  const requested = new Set([
    ethers.getAddress(tokenIn).toLowerCase(),
    ethers.getAddress(tokenOut).toLowerCase(),
  ]);
  if (
    requested.size !== 2 ||
    !requested.has(token0.toLowerCase()) ||
    !requested.has(token1.toLowerCase())
  ) {
    throw new Error(
      `univ3 target ${pool} token pair ${token0}/${token1} does not match ` +
        `requested ${tokenIn}/${tokenOut}`,
    );
  }
  const feeBigInt = BigInt(poolIface.decodeFunctionResult("fee", rawFee)[0]);
  if (feeBigInt < 0n || feeBigInt > 0xffffffn) {
    throw new Error(`univ3 pool ${pool} returned invalid fee ${feeBigInt}`);
  }
  const quoter = uniV3QuoterForFactory(factory);
  if (!quoter) {
    throw new Error(
      `univ3 pool ${pool} factory ${factory} has no registered ` +
        "factory-bound quoter",
    );
  }
  const [tokenA, tokenB] = sortUniV3TokenPair(token0, token1);
  const rawBinding = await read({
    to: factory,
    data: v3FactoryIface.encodeFunctionData("getPool", [
      tokenA,
      tokenB,
      feeBigInt,
    ]),
  });
  const boundPool = ethers.getAddress(
    String(v3FactoryIface.decodeFunctionResult("getPool", rawBinding)[0]),
  );
  if (boundPool !== ethers.getAddress(pool)) {
    throw new Error(
      `univ3 factory ${factory} binds ${tokenA}/${tokenB}/${feeBigInt} ` +
        `to ${boundPool}, not target ${pool}`,
    );
  }
  return Object.freeze({ quoter, fee: Number(feeBigInt) });
}

function sortUniV3TokenPair(
  token0: string,
  token1: string,
): readonly [string, string] {
  return BigInt(token0) < BigInt(token1)
    ? [token0, token1]
    : [token1, token0];
}

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
      const { quoter, fee } = await resolvePreparedUniV3FactoryBoundQuoter(ctx);
      return [{
        from: ethers.ZeroAddress,
        to: quoter,
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
      factory: pool.factory,
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
      factory: pool.factory,
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
  const { quoter, fee } = await resolveUniV3FactoryBoundQuoter(
    (request) => state.call(request),
    target,
    tokenIn,
    tokenOut,
  );
  const data = quoterV2Iface.encodeFunctionData("quoteExactInputSingle", [{
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0n,
  }]);
  const result = await state.call({ to: quoter, data });
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
  const { quoter, fee } = await resolvePreparedUniV3FactoryBoundQuoter(ctx);
  const data = quoterV2Iface.encodeFunctionData("quoteExactInputSingle", [{
    tokenIn: ctx.request.tokenIn,
    tokenOut: ctx.request.tokenOut,
    amountIn: ctx.request.amountIn,
    fee,
    sqrtPriceLimitX96: 0n,
  }]);
  const quoted = await ctx.callPrepared(quoter, data, { gasLimit: 3_000_000 });
  const decoded = quoterV2Iface.decodeFunctionResult("quoteExactInputSingle", quoted.output);
  return {
    amountOut: BigInt(decoded[0]),
    latencyMs: quoted.latencyMs,
    cacheStats: quoted.cacheStats,
  };
}

async function resolvePreparedUniV3FactoryBoundQuoter(
  ctx: PreparedRouteContext,
): Promise<{ readonly quoter: string; readonly fee: number }> {
  const key = [
    ctx.request.target,
    ctx.request.tokenIn,
    ctx.request.tokenOut,
  ].map((value) => value.toLowerCase()).join(":");
  const cached = preparedBindingCache.get(key);
  if (cached) return cached;
  const pending = resolveUniV3FactoryBoundQuoter(
    ctx.readChain,
    ctx.request.target,
    ctx.request.tokenIn,
    ctx.request.tokenOut,
  );
  preparedBindingCache.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (preparedBindingCache.get(key) === pending) {
      preparedBindingCache.delete(key);
    }
    throw error;
  }
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
