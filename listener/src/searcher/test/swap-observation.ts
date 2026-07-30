import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { BackrunDetector } from "../detector/detector.js";
import {
  createVictimSourceGeneration,
  decodeReceiptObservationWithDeadline,
  detectImpactFromLogs,
  detectImpactTransitionFromLogs,
  detectPoolImpact,
  detectPoolImpactTransition,
} from "../detector/pool-impact.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import {
  CURVE_TOKEN_EXCHANGE_TOPICS,
  LandedEventRegistry,
} from "../venues/landed-event-registry.js";
import { scanAddressLandedSwapActivity } from "../venues/landed-event-scanner.js";
import { createStrictSwapObservation } from "../venues/swap-observation.js";
import { v4PoolId } from "../venues/swaps/univ4-common.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const POOL = "0x0000000000000000000000000000000000000c01";
const TOKEN0 = "0x00000000000000000000000000000000000000a0";
const TOKEN1 = "0x00000000000000000000000000000000000000b1";
const SENDER = "0x0000000000000000000000000000000000000aaa";
const RECIPIENT = "0x0000000000000000000000000000000000000bbb";

const V2_IFACE = new ethers.Interface([
  "event Sync(uint112 reserve0,uint112 reserve1)",
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
]);
const BALANCER_V3_IFACE = new ethers.Interface([
  "event Swap(address indexed pool,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,uint256 swapFeePercentage,uint256 swapFeeAmount)",
]);
const V3_IFACE = new ethers.Interface([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);
const DODO_IFACE = new ethers.Interface([
  "event DODOSwap(address fromToken,address toToken,uint256 fromAmount,uint256 toAmount,address trader,address receiver)",
]);
const V4_IFACE = new ethers.Interface([
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
]);
const CURVE_IFACE = new ethers.Interface([
  "function exchange(int128 i,int128 j,uint256 dx,uint256 minDy)",
  "function exchange_received(uint256 i,uint256 j,uint256 dx,uint256 minDy)",
  "function exchange_underlying(uint256 i,uint256 j,uint256 dx,uint256 minDy)",
  "event TokenExchange(address indexed buyer,int128 soldId,uint256 tokensSold,int128 boughtId,uint256 tokensBought)",
]);
const ERC20_IFACE = new ethers.Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const V2_READ_IFACE = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32 blockTimestampLast)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

function eventLog(
  iface: ethers.Interface,
  event: string,
  address: string,
  args: readonly unknown[],
): { address: string; topics: string[]; data: string } {
  const fragment = iface.getEvent(event);
  if (!fragment) throw new Error(`missing event ${event}`);
  const encoded = iface.encodeEventLog(fragment, args);
  return { address, topics: [...encoded.topics], data: encoded.data };
}

function edge(input: Partial<TokenEdge> & Pick<TokenEdge, "adapterId" | "target">): TokenEdge {
  return {
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
    ...input,
  };
}

async function testReceiptLevelV2Correlation(): Promise<void> {
  const graph = [edge({
    adapterId: "univ2-swap",
    target: POOL,
    poolToken0: TOKEN0,
    poolToken1: TOKEN1,
  })];
  const impacts = await detectImpactFromLogs([
    eventLog(V2_IFACE, "Sync", POOL, [101n, 202n]),
    eventLog(V2_IFACE, "Swap", POOL, [SENDER, 10n, 0n, 0n, 9n, RECIPIENT]),
  ], graph);
  const impact = impacts.find((candidate) => candidate.matchedAdapterId === "univ2-swap");
  assert(impact !== undefined, "V2 Swap should decode from the receipt");
  assert(impact.v2PostState?.reserve0 === 101n, "V2 observer should pair the Sync reserve0");
  assert(impact.v2PostState?.reserve1 === 202n, "V2 observer should pair the Sync reserve1");
}

async function testV2FinalReceiptStateAndMalformedIsolation(): Promise<void> {
  const v3Pool = "0x0000000000000000000000000000000000000c03";
  const graph = [
    edge({
      adapterId: "univ2-swap",
      target: POOL,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }),
    edge({
      adapterId: "univ3-swap",
      target: v3Pool,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }),
  ];
  const malformed = eventLog(V2_IFACE, "Swap", POOL, [SENDER, 10n, 0n, 0n, 9n, RECIPIENT]);
  malformed.data = "0x1234";
  const logs = [
    malformed,
    eventLog(V2_IFACE, "Sync", POOL, [101n, 202n]),
    eventLog(V2_IFACE, "Swap", POOL, [SENDER, 10n, 0n, 0n, 9n, RECIPIENT]),
    eventLog(V2_IFACE, "Sync", POOL, [111n, 193n]),
    eventLog(V2_IFACE, "Swap", POOL, [SENDER, 10n, 0n, 0n, 9n, RECIPIENT]),
    eventLog(V3_IFACE, "Swap", v3Pool, [
      SENDER,
      RECIPIENT,
      11n,
      -10n,
      (1n << 96n) + 1n,
      123n,
      1,
    ]),
  ];
  const sourceGeneration = createVictimSourceGeneration({
    sourceBlock: 123,
    sourceBlockHash: ethers.ZeroHash,
    receiptId: ethers.id("malformed-v2-healthy-v3"),
    logs,
    logsCompleteness: "complete-receipt",
  });
  const transition = await detectImpactTransitionFromLogs(
    logs,
    graph,
    sourceGeneration,
  );
  assert(!transition.complete, "a malformed owned V2 trigger must fail the V2 family closed");
  assert(
    transition.impacts.every((impact) => impact.matchedAdapterId !== "univ2-swap"),
    "no partial V2 impact may escape an unresolved family receipt",
  );
  assert(
    transition.impacts.some((impact) => impact.matchedAdapterId === "univ3-swap"),
    "a healthy sibling family must remain actionable",
  );
}

async function testUnknownSameTopicPoolIsNoMatch(): Promise<void> {
  const unknownPool = "0x0000000000000000000000000000000000000c99";
  const graph = [edge({
    adapterId: "univ2-swap",
    target: POOL,
    poolToken0: TOKEN0,
    poolToken1: TOKEN1,
  })];
  const logs = [
    eventLog(V2_IFACE, "Sync", POOL, [101n, 202n]),
    eventLog(V2_IFACE, "Swap", POOL, [
      SENDER,
      10n,
      0n,
      0n,
      9n,
      RECIPIENT,
    ]),
    eventLog(V2_IFACE, "Swap", unknownPool, [
      SENDER,
      10n,
      0n,
      0n,
      9n,
      RECIPIENT,
    ]),
  ];
  const sourceGeneration = createVictimSourceGeneration({
    sourceBlock: 123,
    sourceBlockHash: ethers.ZeroHash,
    receiptId: ethers.id("unknown-same-topic"),
    logs,
    logsCompleteness: "complete-receipt",
  });
  let readCount = 0;
  const transition = await detectImpactTransitionFromLogs(
    logs,
    graph,
    sourceGeneration,
    undefined,
    {
      async call() {
        readCount++;
        throw new Error("an unowned same-topic pool must never trigger enrichment reads");
      },
    },
  );
  assert(
    transition.complete && transition.impacts.length === 1,
    "same topic from an unowned pool is no-match while the owned trigger resolves",
  );
  assert(readCount === 0, "unowned same-topic pools must not fan out V2 state reads");
}

async function testStrictTriggerConsumptionContract(): Promise<void> {
  const logs = [
    eventLog(V2_IFACE, "Swap", POOL, [
      SENDER,
      10n,
      0n,
      0n,
      9n,
      RECIPIENT,
    ]),
    eventLog(V2_IFACE, "Swap", POOL, [
      SENDER,
      11n,
      0n,
      0n,
      10n,
      RECIPIENT,
    ]),
  ];
  const baseImpact = {
    pool: POOL,
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    amountIn: 10n,
    matchedAdapterId: "univ2-swap",
  };
  let mode: "missing" | "duplicate" | "unknown" | "empty" | "valid" =
    "valid";
  const observation = createStrictSwapObservation({
    topics: [logs[0].topics[0]],
    canonicalIntakeTargets: [],
    observedPoolIdentity: (log) => log.address,
    async decodeSwapImpacts() {
      if (mode === "empty") return [];
      if (mode === "unknown") {
        return [{ logIndex: 99, impact: baseImpact }];
      }
      if (mode === "missing") {
        return [{ logIndex: 0, impact: baseImpact }];
      }
      if (mode === "duplicate") {
        return [
          { logIndex: 0, impact: baseImpact },
          { logIndex: 0, impact: baseImpact },
          { logIndex: 1, impact: { ...baseImpact, amountIn: 11n } },
        ];
      }
      return [
        { logIndex: 0, impact: baseImpact },
        { logIndex: 1, impact: { ...baseImpact, amountIn: 11n } },
      ];
    },
  });
  const matchedOwnedTriggers = logs.map((log, logIndex) => ({
    triggerId: `strict-trigger-${logIndex}`,
    logIndex,
    emitter: log.address,
    topic0: log.topics[0],
  }));
  const context = {
    logs,
    graph: [] as TokenEdge[],
    edgesByTarget: new Map<string, readonly TokenEdge[]>(),
    tokenQuery: null,
    sourceGeneration: createVictimSourceGeneration({
      sourceBlock: 123,
      sourceBlockHash: ethers.ZeroHash,
      receiptId: ethers.id("strict-trigger-contract"),
      logs,
      logsCompleteness: "complete-receipt",
    }),
    matchedOwnedTriggers,
    control: {
      deadlineAtMs: Date.now() + 1_000,
      signal: new AbortController().signal,
    },
  };
  for (const invalid of ["missing", "duplicate", "unknown", "empty"] as const) {
    mode = invalid;
    const result = await observation.decodeReceiptImpacts(context);
    assert(
      result.status === "unresolved",
      `${invalid} trigger consumption must fail closed`,
    );
  }
  mode = "valid";
  const resolved = await observation.decodeReceiptImpacts(context);
  assert(
    resolved.status === "resolved" &&
      resolved.impacts.length === 2 &&
      resolved.consumedTriggerIds.length === 2,
    "exact trigger consumption must resolve",
  );

  const hanging = createStrictSwapObservation({
    topics: [logs[0].topics[0]],
    canonicalIntakeTargets: [],
    observedPoolIdentity: (log) => log.address,
    async decodeSwapImpacts() {
      return await new Promise<never>(() => {});
    },
  });
  const { control: _control, ...deadlineInput } = context;
  const startedAt = Date.now();
  const timedOut = await decodeReceiptObservationWithDeadline(
    hanging,
    deadlineInput,
    5,
  );
  assert(
    timedOut.status === "unresolved" && Date.now() - startedAt < 500,
    "a hung family must time out without blocking later families",
  );
  const healthyAfterTimeout = await decodeReceiptObservationWithDeadline(
    observation,
    deadlineInput,
    100,
  );
  assert(
    healthyAfterTimeout.status === "resolved",
    "a healthy sibling must still resolve after another family times out",
  );
}

async function testBalancerV3IndexedPoolIdentity(): Promise<void> {
  const graph = [edge({ adapterId: "balancer-v3-unlock", target: POOL })];
  const impacts = await detectImpactFromLogs([
    eventLog(BALANCER_V3_IFACE, "Swap", ADDR.BALANCER_V3_VAULT, [
      POOL,
      TOKEN0,
      TOKEN1,
      123n,
      120n,
      1n,
      3n,
    ]),
  ], graph);
  const impact = impacts.find((candidate) => candidate.matchedAdapterId === "balancer-v3-unlock");
  assert(impact !== undefined, "Balancer V3 Vault event should match the indexed pool");
  assert(impact.pool.toLowerCase() === POOL.toLowerCase(), "Vault emitter must not replace pool identity");
  assert(impact.amountIn === 123n && impact.amountOut === 120n, "Balancer V3 amounts");
}

async function testCrossFamilyReceiptOrder(): Promise<void> {
  const v3Pool = "0x0000000000000000000000000000000000000c03";
  const graph = [
    edge({
      adapterId: "univ3-swap",
      target: v3Pool,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }),
    edge({
      adapterId: "univ2-swap",
      target: POOL,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }),
  ];
  const impacts = await detectImpactFromLogs([
    eventLog(V3_IFACE, "Swap", v3Pool, [SENDER, RECIPIENT, 10n, -9n, 1n << 96n, 123n, 1]),
    eventLog(V2_IFACE, "Sync", POOL, [101n, 202n]),
    eventLog(V2_IFACE, "Swap", POOL, [SENDER, 10n, 0n, 0n, 9n, RECIPIENT]),
  ], graph);
  assert(impacts[0]?.matchedAdapterId === "univ3-swap", "first log impact must stay first");
  assert(impacts[1]?.matchedAdapterId === "univ2-swap", "later V2 impact must stay second");
}

async function testMultiPoolTransitionRetainsEveryAffectedPool(): Promise<void> {
  const v3Pool = "0x0000000000000000000000000000000000000c03";
  const graph = [
    edge({
      adapterId: "univ2-swap",
      target: POOL,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }),
    edge({
      adapterId: "univ3-swap",
      target: v3Pool,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }),
  ];
  const logs = [
    eventLog(V2_IFACE, "Sync", POOL, [101n, 202n]),
    eventLog(V2_IFACE, "Swap", POOL, [SENDER, 10n, 0n, 0n, 9n, RECIPIENT]),
    eventLog(V3_IFACE, "Swap", v3Pool, [
      SENDER,
      RECIPIENT,
      11n,
      -10n,
      (1n << 96n) + 1n,
      123n,
      1,
    ]),
  ];
  const sourceGeneration = createVictimSourceGeneration({
    sourceBlock: 123,
    sourceBlockHash: ethers.ZeroHash,
    receiptId: ethers.id("multi-pool-receipt"),
    logs,
    logsCompleteness: "complete-receipt",
  });
  const transition = await detectImpactTransitionFromLogs(
    logs,
    graph,
    sourceGeneration,
  );
  assert(transition.complete, "two admitted pool observations should form a complete transition");
  assert(transition.steps.length === 2, "transition should retain both receipt swap steps");
  assert(transition.impacts.length === 2, "transition should retain both affected pools");
  assert(
    transition.impacts.every((impact) => impact.sourceGeneration?.id === sourceGeneration.id),
    "every production impact must bind the receipt source generation",
  );
  assert(
    !transition.hashOnlyReplayable,
    "multi-pool transition must not enter a single-impact hash-only overlay",
  );
}

async function testRepeatedV3UsesTransactionFinalPostState(): Promise<void> {
  const graph = [edge({
    adapterId: "univ3-swap",
    target: POOL,
    poolToken0: TOKEN0,
    poolToken1: TOKEN1,
  })];
  const impacts = await detectImpactFromLogs([
    eventLog(V3_IFACE, "Swap", POOL, [
      SENDER,
      RECIPIENT,
      10n,
      -9n,
      (1n << 96n) + 111n,
      111n,
      1,
    ]),
    eventLog(V3_IFACE, "Swap", POOL, [
      SENDER,
      RECIPIENT,
      20n,
      -18n,
      (1n << 96n) + 222n,
      222n,
      2,
    ]),
  ], graph);
  assert(impacts.length === 1, "repeated same-pool V3 impacts should collapse to final state");
  assert(
    impacts[0].amountIn === 20n &&
      impacts[0].v3PostState?.liquidity === 222n &&
      impacts[0].v3PostState?.tick === 2,
    "same-pool V3 impact must retain the transaction-final direction and post-state",
  );
}

async function testMalformedObserverCannotFallBackToTransfers(): Promise<void> {
  const graph = [edge({
    adapterId: "univ3-swap",
    target: POOL,
    poolToken0: TOKEN0,
    poolToken1: TOKEN1,
  })];
  const malformed = eventLog(V3_IFACE, "Swap", POOL, [
    SENDER,
    RECIPIENT,
    10n,
    -9n,
    1n << 96n,
    123n,
    1,
  ]);
  malformed.data = "0x1234";
  const logs = [
    eventLog(ERC20_IFACE, "Transfer", TOKEN0, [SENDER, POOL, 10n]),
    malformed,
    eventLog(ERC20_IFACE, "Transfer", TOKEN1, [POOL, RECIPIENT, 9n]),
  ];
  const transition = await detectImpactTransitionFromLogs(
    logs,
    graph,
    createVictimSourceGeneration({
      sourceBlock: 123,
      sourceBlockHash: ethers.ZeroHash,
      receiptId: ethers.id("malformed-observer"),
      logs,
      logsCompleteness: "complete-receipt",
    }),
  );
  assert(transition.impacts.length === 0, "malformed family observation must not become an impact");
  assert(!transition.complete, "malformed family observation must make the transition unresolved");
  assert(
    transition.unresolved.some((item) => item.reason === "observer-decode-failed"),
    "observer decode failure must be explicit",
  );
  assert(
    !transition.unresolved.some((item) => item.reason === "transfer-only-candidate"),
    "paired Transfers must not replace a failed family observer",
  );
}

async function testReceiptFragmentsAndGenerationMismatchFailClosed(): Promise<void> {
  const graph = [edge({
    adapterId: "univ3-swap",
    target: POOL,
    poolToken0: TOKEN0,
    poolToken1: TOKEN1,
  })];
  const logs = [
    eventLog(V3_IFACE, "Swap", POOL, [
      SENDER,
      RECIPIENT,
      10n,
      -9n,
      1n << 96n,
      123n,
      1,
    ]),
  ];
  const fragmentGeneration = createVictimSourceGeneration({
    sourceBlock: 123,
    sourceBlockHash: ethers.ZeroHash,
    receiptId: ethers.id("fragment"),
    logs,
    logsCompleteness: "fragment",
  });
  const fragment = await detectImpactTransitionFromLogs(
    logs,
    graph,
    fragmentGeneration,
  );
  assert(fragment.impacts.length === 1, "fragment may retain observation evidence");
  assert(!fragment.complete && !fragment.hashOnlyReplayable, "fragment must never certify a receipt");
  assert(
    fragment.unresolved.some((item) => item.reason === "receipt-fragment"),
    "fragment provenance must remain explicit",
  );

  const differentLogs = [
    eventLog(V3_IFACE, "Swap", POOL, [
      SENDER,
      RECIPIENT,
      20n,
      -18n,
      (1n << 96n) + 1n,
      124n,
      2,
    ]),
  ];
  const mismatch = await detectImpactTransitionFromLogs(
    differentLogs,
    graph,
    createVictimSourceGeneration({
      sourceBlock: 123,
      sourceBlockHash: ethers.ZeroHash,
      receiptId: ethers.id("mismatch"),
      logs,
      logsCompleteness: "complete-receipt",
    }),
  );
  assert(mismatch.impacts.length === 0, "receipt B must not be relabeled with generation A");
  assert(
    mismatch.unresolved.some((item) => item.reason === "source-generation-mismatch"),
    "source-generation mismatch must be explicit",
  );

  const detector = new BackrunDetector();
  detector.setGraph(graph);
  const baseEvent = {
    txHash: ethers.id("fragment-detector"),
    blockNumber: 124,
    rawTx: "0x",
    from: SENDER,
    nonce: 0,
    to: null,
    input: "0x",
    logs,
    sourceBlockHash: ethers.ZeroHash,
    logsCompleteness: "fragment" as const,
  };
  const mustOverlay = await detector.detect({
    ...baseEvent,
    victimState: "must-overlay",
  }, {} as StateBackend);
  assert(
    mustOverlay.length === 0,
    "detector must suppress fragment impacts when victim state still needs an overlay",
  );
  const materialized = await detector.detect({
    ...baseEvent,
    victimState: "materialized",
  }, {} as StateBackend);
  assert(
    materialized.length === 1,
    "materialized victim state may use fragment impacts only as opportunity evidence",
  );
}

async function testAmbiguousDeltaSignsNeverGuessDirection(): Promise<void> {
  const v3Pool = "0x0000000000000000000000000000000000000c03";
  const v4Key = {
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: 3000,
    tickSpacing: 60,
    hooks: ethers.ZeroAddress,
  };
  const poolId = v4PoolId(v4Key);
  const graph = [
    edge({
      adapterId: "univ2-swap",
      target: POOL,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }),
    edge({
      adapterId: "univ3-swap",
      target: v3Pool,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    }),
    edge({
      adapterId: "univ4-unlock",
      target: ADDR.UNISWAP_V4_POOL_MANAGER,
      poolId,
      v4PoolKey: v4Key,
    }),
  ];
  const logs = [
    eventLog(V2_IFACE, "Swap", POOL, [SENDER, 10n, 10n, 0n, 9n, RECIPIENT]),
    eventLog(V3_IFACE, "Swap", v3Pool, [
      SENDER,
      RECIPIENT,
      10n,
      9n,
      1n << 96n,
      123n,
      1,
    ]),
    eventLog(V4_IFACE, "Swap", ADDR.UNISWAP_V4_POOL_MANAGER, [
      poolId,
      SENDER,
      -9n,
      -10n,
      1n << 96n,
      123n,
      1,
      3000,
    ]),
  ];
  const transition = await detectImpactTransitionFromLogs(
    logs,
    graph,
    createVictimSourceGeneration({
      sourceBlock: 123,
      sourceBlockHash: ethers.ZeroHash,
      receiptId: ethers.id("ambiguous-signs"),
      logs,
      logsCompleteness: "complete-receipt",
    }),
  );
  assert(transition.impacts.length === 0, "ambiguous V2/V3/V4 signs must not create directions");
  assert(
    transition.unresolved.filter((item) => item.reason === "observer-decode-failed").length === 3,
    "each ambiguous family log must be explicitly unresolved",
  );
}

async function testTransferOnlyCandidateNeverGuessesProtocol(): Promise<void> {
  const logs = [
    eventLog(ERC20_IFACE, "Transfer", TOKEN0, [SENDER, POOL, 10n]),
    eventLog(ERC20_IFACE, "Transfer", TOKEN1, [POOL, RECIPIENT, 9n]),
  ];
  const broadOnly = await detectImpactTransitionFromLogs(
    logs,
    [],
    createVictimSourceGeneration({
      sourceBlock: 123,
      sourceBlockHash: ethers.ZeroHash,
      receiptId: ethers.id("transfer-only"),
      logs,
      logsCompleteness: "complete-receipt",
    }),
    new Map([[POOL.toLowerCase(), "curve"]]),
  );
  assert(broadOnly.impacts.length === 0, "paired Transfers must never create an actionable impact");
  assert(
    broadOnly.complete,
    "Transfer touches of an unowned broad-map pool are diagnostics only",
  );

  const admitted = await detectImpactTransitionFromLogs(
    logs,
    [edge({
      adapterId: "univ2-swap",
      target: POOL,
      poolToken0: TOKEN0,
      poolToken1: TOKEN1,
    })],
    createVictimSourceGeneration({
      sourceBlock: 123,
      sourceBlockHash: ethers.ZeroHash,
      receiptId: ethers.id("transfer-only-admitted"),
      logs,
      logsCompleteness: "complete-receipt",
    }),
  );
  assert(
    admitted.unresolved.some(
      (item) => item.reason === "transfer-only-candidate",
    ),
    "Transfer touches of an admitted pool must block hash-only replay",
  );
}

async function testV2EnrichmentIsPinnedToSourceGeneration(): Promise<void> {
  const graph = [edge({
    adapterId: "univ2-swap",
    target: POOL,
    poolToken0: TOKEN0,
    poolToken1: TOKEN1,
  })];
  const logs = [
    eventLog(V2_IFACE, "Swap", POOL, [SENDER, 10n, 0n, 0n, 9n, RECIPIENT]),
  ];
  const seenBlockTags: ethers.BlockTag[] = [];
  const sourceGeneration = createVictimSourceGeneration({
    sourceBlock: 123,
    sourceBlockHash: ethers.ZeroHash,
    receiptId: ethers.id("v2-pinned-state"),
    logs,
    logsCompleteness: "complete-receipt",
  });
  const transition = await detectImpactTransitionFromLogs(
    logs,
    graph,
    sourceGeneration,
    undefined,
    {
      async call(request) {
        if (request.blockTag !== undefined) seenBlockTags.push(request.blockTag);
        const selector = request.data.slice(0, 10);
        if (selector === V2_READ_IFACE.getFunction("getReserves")!.selector) {
          return V2_READ_IFACE.encodeFunctionResult("getReserves", [100n, 200n, 7]);
        }
        if (selector === V2_READ_IFACE.getFunction("factory")!.selector) {
          return V2_READ_IFACE.encodeFunctionResult("factory", [
            "0x0000000000000000000000000000000000000fac",
          ]);
        }
        if (selector === V2_READ_IFACE.getFunction("token0")!.selector) {
          return V2_READ_IFACE.encodeFunctionResult("token0", [TOKEN0]);
        }
        if (selector === V2_READ_IFACE.getFunction("token1")!.selector) {
          return V2_READ_IFACE.encodeFunctionResult("token1", [TOKEN1]);
        }
        throw new Error(`unexpected V2 selector ${selector}`);
      },
    },
  );
  assert(transition.complete, "source-pinned V2 enrichment should decode");
  assert(transition.impacts[0]?.v2PostState?.reserve0 === 110n, "V2 final reserve0");
  assert(transition.impacts[0]?.v2PostState?.reserve1 === 191n, "V2 final reserve1");
  assert(
    transition.impacts[0]?.v2PostState?.feeBps === 30n,
    "unmeasured V2 enrichment must use the standard fee",
  );
  assert(seenBlockTags.length === 4, "all V2 enrichment reads should be source-pinned");
  assert(
    seenBlockTags.every((blockTag) => blockTag === sourceGeneration.sourceBlock),
    "V2 enrichment must not read latest state",
  );
}

async function testDodoV2ReceiptObservation(): Promise<void> {
  const graph = [edge({
    adapterId: "dodo-v2-swap",
    target: POOL,
    poolToken0: TOKEN0,
    poolToken1: TOKEN1,
  })];
  const impacts = await detectImpactFromLogs([
    eventLog(DODO_IFACE, "DODOSwap", POOL, [TOKEN0, TOKEN1, 123n, 120n, SENDER, RECIPIENT]),
  ], graph);
  const impact = impacts.find((candidate) => candidate.matchedAdapterId === "dodo-v2-swap");
  assert(impact !== undefined, "DODO V2 receipt should decode through its SwapAdapter");
  assert(impact.amountIn === 123n && impact.amountOut === 120n, "DODO V2 amounts");
}

async function testTopicAndBroadMapDoNotCreateIdentity(): Promise<void> {
  const unknownPool = "0x0000000000000000000000000000000000000bad";
  const impacts = await detectImpactFromLogs([
    eventLog(
      V2_IFACE,
      "Swap",
      unknownPool,
      [SENDER, 10n, 0n, 0n, 9n, RECIPIENT],
    ),
  ], [], new Map([[unknownPool.toLowerCase(), "univ2"]]), {
    async call() {
      throw new Error("identity-less observations must not query token views");
    },
  });
  assert(
    impacts.length === 0,
    "Swap topic + broad address label must not manufacture an admitted V2 edge",
  );
}

async function testCurveDirectCallIsFamilyOwnedAndDirectional(): Promise<void> {
  const graph = [edge({
    adapterId: "curve-exchange",
    target: POOL,
    curveI: 0,
    curveJ: 1,
  })];
  const baseEvent = {
    txHash: ethers.ZeroHash,
    blockNumber: 1,
    rawTx: "0x",
    from: SENDER,
    nonce: 0,
    to: POOL,
    logs: [],
    sourceBlockHash: ethers.ZeroHash,
    receiptBlockNumber: 1,
    receiptBlockHash: ethers.ZeroHash,
    receiptParentBlockHash: ethers.ZeroHash,
    receiptTransactionHash: ethers.ZeroHash,
    logsCompleteness: "complete-receipt" as const,
    victimState: "materialized" as const,
  };
  const matched = await detectPoolImpact({
    ...baseEvent,
    input: CURVE_IFACE.encodeFunctionData("exchange", [0, 1, 123n, 0n]),
  }, graph);
  assert(matched.length === 1, "Curve family should decode its admitted direct call");
  assert(matched[0].amountIn === 123n, "Curve direct-call amount");
  assert(
    matched[0].sourceGeneration?.sourceBlockHash === ethers.ZeroHash,
    "direct-call impact must bind the supplied pre-victim block hash",
  );
  const receiptPreferred = await detectPoolImpactTransition({
    ...baseEvent,
    input: CURVE_IFACE.encodeFunctionData("exchange", [0, 1, 123n, 0n]),
    logs: [
      eventLog(CURVE_IFACE, "TokenExchange", POOL, [
        SENDER,
        0,
        122n,
        1,
        120n,
      ]),
    ],
  }, graph);
  assert(
    receiptPreferred.steps.length === 1 &&
      receiptPreferred.steps[0].origin === "family-receipt" &&
      receiptPreferred.impacts[0]?.amountIn === 122n,
    "an admitted receipt observation must replace direct-call evidence for the same pool",
  );
  const uintReceived = await detectPoolImpact({
    ...baseEvent,
    input: CURVE_IFACE.encodeFunctionData(
      "exchange_received(uint256,uint256,uint256,uint256)",
      [0, 1, 123n, 0n],
    ),
  }, graph);
  assert(
    uintReceived.length === 1,
    "Curve family should decode its admitted uint-index exchange_received call",
  );
  const wrongFamilyEntrypoint = await detectPoolImpactTransition({
    ...baseEvent,
    input: CURVE_IFACE.encodeFunctionData(
      "exchange_underlying(uint256,uint256,uint256,uint256)",
      [0, 1, 123n, 0n],
    ),
  }, graph);
  assert(
    wrongFamilyEntrypoint.impacts.length === 0 &&
      wrongFamilyEntrypoint.unresolved.some((item) =>
        item.reason === "direct-call-decode-failed"
      ),
    "underlying entrypoint must not be coerced onto a plain Curve edge",
  );

  const mismatched = await detectPoolImpactTransition({
    ...baseEvent,
    input: CURVE_IFACE.encodeFunctionData("exchange", [2, 3, 123n, 0n]),
  }, graph);
  assert(
    mismatched.impacts.length === 0,
    "single Curve edge must not coerce mismatched coin indexes into a direction",
  );
  assert(
    mismatched.unresolved.some((item) => item.reason === "direct-call-decode-failed"),
    "family direct-call direction mismatch must be explicitly unresolved",
  );

  const wrongReceiptSource = await detectPoolImpactTransition({
    ...baseEvent,
    receiptBlockNumber: 2,
    input: CURVE_IFACE.encodeFunctionData("exchange", [0, 1, 123n, 0n]),
  }, graph);
  assert(
    !wrongReceiptSource.complete &&
      wrongReceiptSource.unresolved.some((item) =>
        item.reason === "source-generation-mismatch"
      ),
    "complete receipt must bind to source block + 1 inside the detector boundary",
  );
  const wrongReceiptParent = await detectPoolImpactTransition({
    ...baseEvent,
    receiptParentBlockHash: ethers.id("other-parent"),
    input: CURVE_IFACE.encodeFunctionData("exchange", [0, 1, 123n, 0n]),
  }, graph);
  assert(
    !wrongReceiptParent.complete &&
      wrongReceiptParent.unresolved.some((item) =>
        item.reason === "source-generation-mismatch"
      ),
    "complete receipt must bind its header parent to the pre-victim source hash",
  );
}

async function testV4SwapperDeltaSign(): Promise<void> {
  const key = {
    currency0: TOKEN0,
    currency1: TOKEN1,
    fee: 3000,
    tickSpacing: 60,
    hooks: ethers.ZeroAddress,
  };
  const poolId = v4PoolId(key);
  const graph = [edge({
    adapterId: "univ4-unlock",
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    tokenIn: TOKEN0,
    tokenOut: TOKEN1,
    poolId,
    v4PoolKey: key,
  })];
  const impacts = await detectImpactFromLogs([
    eventLog(V4_IFACE, "Swap", ADDR.UNISWAP_V4_POOL_MANAGER, [
      poolId,
      SENDER,
      -900n,
      1_000n,
      1n << 96n,
      123n,
      1,
      3000,
    ]),
  ], graph);
  const impact = impacts.find((candidate) => candidate.matchedAdapterId === "univ4-unlock");
  assert(impact !== undefined, "V4 swapper delta should match the route edge");
  assert(impact.tokenIn.toLowerCase() === TOKEN0.toLowerCase(), "negative currency0 is input");
  assert(impact.tokenOut.toLowerCase() === TOKEN1.toLowerCase(), "positive currency1 is output");
  assert(impact.amountIn === 900n && impact.amountOut === 1_000n, "V4 absolute amounts");
}

function testRegistryConformance(): void {
  const registry = PRODUCTION_ADAPTER_FAMILIES.landedEvents();
  for (const adapter of PRODUCTION_ADAPTER_FAMILIES.swaps()) {
    assert(adapter.observation.topics.length > 0, `${adapter.id} observation topics`);
    assert(
      adapter.observation.canonicalIntakeTargets.every((target) => ethers.isAddress(target)),
      `${adapter.id} canonical intake targets`,
    );
  }
  assert(CURVE_TOKEN_EXCHANGE_TOPICS.length === 4, "all Curve plain/underlying swap topics");
  assert(
    registry.swapEvents.every((event) => registry.isSwapTopic(event.topic)),
    "debug swap classification must derive from landed events",
  );
  const warmTopics = new Set(registry.warmTopics);
  assert(
    registry.mutationEvents.every((event) => warmTopics.has(event.topic)),
    "warm invalidation must contain every landed mutation event",
  );
  assert(
    registry.swapEvents
      .filter((event) => event.invalidatesWarmState)
      .every((event) => warmTopics.has(event.topic)),
    "warm invalidation must contain every state-changing swap event",
  );
  let missingEventError = "";
  try {
    const existing = PRODUCTION_ADAPTER_FAMILIES.swaps()[0];
    new LandedEventRegistry([{
      ...existing,
      observation: {
        ...existing.observation,
        topics: [ethers.ZeroHash],
      },
    }]);
  } catch (error) {
    missingEventError = error instanceof Error ? error.message : String(error);
  }
  assert(
    missingEventError.includes("observation topics do not match"),
    "family observation/event mismatch must fail explicitly",
  );
}

async function testSharedAddressScanner(): Promise<void> {
  const queried = new Set<string>();
  const result = await scanAddressLandedSwapActivity({
    events: PRODUCTION_ADAPTER_FAMILIES.landedEvents().swapEvents,
    fromBlock: 10,
    toBlock: 11,
    batchSize: 1,
    async getLogs(event, fromBlock) {
      queried.add(event.id);
      if (event.id !== "curve-underlying-uint") return [];
      return [{ address: POOL, blockNumber: fromBlock }];
    },
  });
  const activity = result.activity.get(POOL.toLowerCase());
  assert(activity?.count === 2, "shared scanner must aggregate both block batches");
  assert(activity.lastSwapBlock === 11, "shared scanner last swap block");
  assert(
    activity.adapterCounts.get("curve-underlying") === 2,
    "shared scanner must project descriptor pool adapter",
  );
  assert(
    queried.has("univ2-swap") && queried.has("balancer-v3-swap") === false,
    "shared address scanner must query address emitters only",
  );
}

await testReceiptLevelV2Correlation();
await testV2FinalReceiptStateAndMalformedIsolation();
await testUnknownSameTopicPoolIsNoMatch();
await testStrictTriggerConsumptionContract();
await testBalancerV3IndexedPoolIdentity();
await testCrossFamilyReceiptOrder();
await testMultiPoolTransitionRetainsEveryAffectedPool();
await testRepeatedV3UsesTransactionFinalPostState();
await testMalformedObserverCannotFallBackToTransfers();
await testReceiptFragmentsAndGenerationMismatchFailClosed();
await testAmbiguousDeltaSignsNeverGuessDirection();
await testTransferOnlyCandidateNeverGuessesProtocol();
await testV2EnrichmentIsPinnedToSourceGeneration();
await testDodoV2ReceiptObservation();
await testTopicAndBroadMapDoNotCreateIdentity();
await testCurveDirectCallIsFamilyOwnedAndDirectional();
await testV4SwapperDeltaSign();
testRegistryConformance();
await testSharedAddressScanner();
console.log("swap-observation PASS (receipt transition + source generation + family observers)");
