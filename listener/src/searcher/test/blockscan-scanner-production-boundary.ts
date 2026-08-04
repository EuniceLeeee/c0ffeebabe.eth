import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADDR } from "../../shared/constants/addresses.js";
import type { AdapterRuntimeSnapshot } from "../adapter-runtime-coordinator.js";
import type {
  BlockScanStateCoverage,
  BlockScanStateSnapshot,
} from "../blockscan-state-coordinator.js";
import {
  detectBlockScanOpportunities,
  type BlockScanConfig,
} from "../detector/blockscan-scanner.js";
import {
  assertAtomicBlockScanPricingView,
  assertAtomicBlockScanRuntime,
  detectProductionBlockScanOpportunities,
} from "../detector/blockscan-scanner-production.js";
import {
  enumerateNMinusOneCoarseCandidates,
  promoteNMinusOneExactCandidates,
} from "../detector/blockscan-nminus1-fallback.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  blockScanEdgeKey,
  createVerifiedGraphView,
  exactSetHash,
} from "../venues/blockscan-state-capability.js";
import {
  LegacyConcentratedLiquidityPrecisionUnsupportedError,
  readV2WarmMid,
  type RouteVenueMid,
} from "../venues/mid-readers.js";

const block = 100;
const blockHash = `0x${"11".repeat(32)}`;
const token = "0x00000000000000000000000000000000000000a1";
const pool1 = "0x00000000000000000000000000000000000000b1";
const pool2 = "0x00000000000000000000000000000000000000b2";
const unit = 10n ** 18n;
const edges = [
  ...venueEdges(pool1),
  ...venueEdges(pool2),
];
const cache = new PoolStateCache();
cache.seedV2({
  pool: pool1,
  token0: token,
  token1: ADDR.WETH,
  reserve0: 2_000_000n * unit,
  reserve1: 1_000n * unit,
  feeBps: 30n,
  blockNumber: block,
});
cache.seedV2({
  pool: pool2,
  token0: token,
  token1: ADDR.WETH,
  reserve0: 2_000_000n * unit,
  reserve1: 1_100n * unit,
  feeBps: 30n,
  blockNumber: block,
});

const cfg: BlockScanConfig = {
  maxHops: 3,
  minSpreadBps: 0,
  maxCandidates: 20,
  budgetMs: 10_000,
  pricedTokens: new Map([[ADDR.WETH.toLowerCase(), { maxBorrow: 10_000n * unit }]]),
  pinnedOutsideBudget: true,
};
const mids = buildMids();
const runtime = buildRuntime(edges, mids);
const runtimeEdges = [...runtime.graph.edges];

const legacy = detectBlockScanOpportunities({
  edges: runtimeEdges,
  cache,
  sourceBlock: block,
  swapTouched: null,
  cfg,
});
const production = detectProductionBlockScanOpportunities({
  runtime,
  swapTouched: null,
  cfg,
});
assert(legacy.opportunities.length > 0, "fixture must exercise a real opportunity");
const {
  completeness: productionCompleteness,
  incompleteFamilyIds: productionIncompleteFamilies,
  selectionMode: productionSelectionMode,
  forcedSelectionCount: productionForcedSelectionCount,
  ...productionCore
} = production;
assert.equal(productionCompleteness, "complete");
assert.deepEqual(productionIncompleteFamilies, []);
assert.equal(productionSelectionMode, "production");
assert.equal(productionForcedSelectionCount, 0);
assert.deepEqual(
  productionCore,
  legacy,
  "strict atomic wrapper must preserve the single scanner kernel output",
);
console.log("[blockscan-production-boundary] legacy/current-N kernel equivalence: PASS");

{
  const graphHashBefore = runtime.graph.orderedEdgeHash;
  const eligibleFixtureEdges = runtime.graph.edges.filter(
    (edge) => edge.target.toLowerCase() !== pool2,
  );
  assert.equal(
    eligibleFixtureEdges.length,
    2,
    `fixture predicate retained unexpected targets: ${eligibleFixtureEdges
      .map((edge) => edge.target)
      .join(",")}`,
  );
  const unavailable = detectProductionBlockScanOpportunities({
    runtime,
    swapTouched: null,
    cfg: { ...cfg, maxCandidates: 1 },
    edgeEligible: (edge) => edge.target.toLowerCase() !== pool2,
    routeEligible: () => true,
  });
  assert.equal(
    unavailable.opportunities.length,
    0,
    "an unavailable venue must be removed before it can consume ranking",
  );
  assert.equal(
    runtime.graph.orderedEdgeHash,
    graphHashBefore,
    "per-pass execution availability must not mutate the frozen graph",
  );
  const routeRejected = detectProductionBlockScanOpportunities({
    runtime,
    swapTouched: null,
    cfg: { ...cfg, maxCandidates: 1 },
    edgeEligible: () => true,
    routeEligible: () => false,
  });
  assert.equal(
    routeRejected.selection.enumeratedCount,
    0,
    "route availability must apply before candidate selection",
  );
}
console.log("[blockscan-production-boundary] execution availability before ranking: PASS");

{
  const precisionPool = "0x00000000000000000000000000000000000000c1";
  const precisionCache = new PoolStateCache();
  precisionCache.seedV3Ticks({
    pool: precisionPool,
    token0: token,
    token1: ADDR.WETH,
    fee: 100n,
    tickSpacing: 1,
    tickBitmap: new Map(),
    ticks: new Map(),
    blockNumber: block,
  });
  precisionCache.seedV3Live({
    pool: precisionPool,
    sqrtPriceX96: 1n << 120n,
    tick: 0,
    liquidity: 1n,
    blockNumber: block,
  });
  const precisionEdge: TokenEdge = {
    adapterId: "univ3-swap",
    target: precisionPool,
    tokenIn: token,
    tokenOut: ADDR.WETH,
    poolToken0: token,
    poolToken1: ADDR.WETH,
    v3Fee: 100,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
  };
  assert.throws(
    () =>
      detectBlockScanOpportunities({
        edges: [precisionEdge],
        cache: precisionCache,
        sourceBlock: block,
        swapTouched: null,
        cfg,
      }),
    (error) =>
      error instanceof LegacyConcentratedLiquidityPrecisionUnsupportedError &&
      error.code === "LEGACY_CONCENTRATED_LIQUIDITY_PRECISION_UNSUPPORTED" &&
      /production pricing-state precision path/.test(error.message),
    "trusted legacy caller must surface unsupported precision, not skip the venue",
  );
}
console.log("[blockscan-production-boundary] legacy precision unsupported passthrough: PASS");

assertRejectsRuntime(
  {
    ...runtime,
    generation: runtime.generation + 1,
  },
  /generation mismatch/,
);
assertRejectsRuntime(
  {
    ...runtime,
    funding: {
      ...runtime.funding,
      sourceBlock: runtime.sourceBlock + 1,
      borrowable: runtime.funding.borrowable.bind(runtime.funding),
      source: runtime.funding.source.bind(runtime.funding),
    },
  },
  /source block mismatch/,
);
assertRejectsRuntime(
  {
    ...runtime,
    pricing: {
      ...runtime.pricing,
      sourceBlockHash: `0x${"22".repeat(32)}`,
    },
  },
  /source block hash mismatch/,
);
console.log("[blockscan-production-boundary] generation/block/hash pinning: PASS");

{
  const missingKey = runtime.pricing.coverage.expectedEdgeKeys[0];
  const resolved = runtime.pricing.coverage.expectedEdgeKeys.slice(1);
  const coverage = coverageFor(
    runtime.pricing.coverage.expectedStateKeys,
    runtime.pricing.coverage.expectedStateKeys,
    [],
    runtime.pricing.coverage.expectedReadKeys,
    runtime.pricing.coverage.expectedReadKeys,
    [],
    runtime.pricing.coverage.expectedEdgeKeys,
    resolved,
    [missingKey],
  );
  assertRejectsRuntime(
    {
      ...runtime,
      pricing: { ...runtime.pricing, coverage },
    },
    /non-exact atomic mid coverage|incomplete edge (?:keys|availability) coverage/,
  );
}
{
  const missing = new Map(runtime.pricing.mids);
  missing.delete(runtime.pricing.coverage.expectedEdgeKeys[0]);
  assertRejectsRuntime(
    {
      ...runtime,
      pricing: { ...runtime.pricing, mids: missing },
    },
    /non-exact atomic mid coverage/,
  );
}
{
  const extra = new Map(runtime.pricing.mids);
  extra.set("unexpected-edge", runtime.pricing.mids.values().next().value!);
  assertRejectsRuntime(
    {
      ...runtime,
      pricing: { ...runtime.pricing, mids: extra },
    },
    /non-exact atomic mid coverage/,
  );
}
{
  const omittedKey = runtime.pricing.coverage.expectedEdgeKeys[0];
  const expected = runtime.pricing.coverage.expectedEdgeKeys.slice(1);
  const omitted = new Map(runtime.pricing.mids);
  omitted.delete(omittedKey);
  const coverage = coverageFor(
    runtime.pricing.coverage.expectedStateKeys,
    runtime.pricing.coverage.expectedStateKeys,
    [],
    runtime.pricing.coverage.expectedReadKeys,
    runtime.pricing.coverage.expectedReadKeys,
    [],
    expected,
    expected,
    [],
  );
  assertRejectsRuntime(
    {
      ...runtime,
      pricing: {
        ...runtime.pricing,
        coverage,
        mids: omitted,
        coverageByEdgeKey: new Map(expected.map((edgeKey) => [
          edgeKey,
          { status: "resolved" as const },
        ])),
      },
    },
    /missing current-N mid/,
  );
}
{
  const unavailableKey = runtime.pricing.coverage.expectedEdgeKeys[0];
  const resolved = runtime.pricing.coverage.expectedEdgeKeys.filter(
    (edgeKey) => edgeKey !== unavailableKey,
  );
  const availableMids = new Map(runtime.pricing.mids);
  availableMids.delete(unavailableKey);
  const coverage = coverageFor(
    runtime.pricing.coverage.expectedStateKeys,
    runtime.pricing.coverage.expectedStateKeys,
    [],
    runtime.pricing.coverage.expectedReadKeys,
    runtime.pricing.coverage.expectedReadKeys,
    [],
    runtime.pricing.coverage.expectedEdgeKeys,
    resolved,
    [],
    [unavailableKey],
  );
  const unavailableRuntime = {
    ...runtime,
    pricing: {
      ...runtime.pricing,
      mids: availableMids,
      coverage,
      coverageByEdgeKey: new Map(
        runtime.pricing.coverage.expectedEdgeKeys.map((edgeKey) => [
          edgeKey,
          edgeKey === unavailableKey
            ? {
                status: "rejected" as const,
                reason: "pinned balance proves no behavior-safe atomic input",
              }
            : { status: "resolved" as const },
        ]),
      ),
    },
  };
  assert.doesNotThrow(() =>
    detectProductionBlockScanOpportunities({
      runtime: unavailableRuntime,
      swapTouched: null,
      cfg,
    })
  );
}
console.log("[blockscan-production-boundary] exact edge/mid coverage: PASS");

{
  const readKeys = Array.from(
    { length: 20_000 },
    (_, index) => `large-read-key-${index.toString().padStart(5, "0")}`,
  );
  const coverage = coverageFor(
    runtime.pricing.coverage.expectedStateKeys,
    runtime.pricing.coverage.resolvedStateKeys,
    runtime.pricing.coverage.unresolvedStateKeys,
    readKeys,
    readKeys,
    [],
    runtime.pricing.coverage.expectedEdgeKeys,
    runtime.pricing.coverage.resolvedEdgeKeys,
    runtime.pricing.coverage.unresolvedEdgeKeys,
  );
  const freshness = runtime.pricing.freshnessByReadKey.values().next().value!;
  const pricing = {
    ...runtime.pricing,
    coverage,
    coverageByReadKey: new Map(readKeys.map((key) => [
      key,
      { status: "resolved" as const },
    ])),
    freshnessByReadKey: new Map(readKeys.map((key) => [key, freshness])),
  };
  const startedAtMs = performance.now();
  assert.doesNotThrow(() =>
    assertAtomicBlockScanPricingView(pricing.graph, pricing)
  );
  const wallMs = performance.now() - startedAtMs;
  assert.ok(
    wallMs < 2_000,
    `atomic pricing validation must remain linear at 20k read keys; wallMs=${wallMs}`,
  );
}
console.log("[blockscan-production-boundary] large coverage validation: PASS");

{
  const invalidFunding = {
    ...runtime.funding,
    borrowable: runtime.funding.borrowable.bind(runtime.funding),
    source: runtime.funding.source.bind(runtime.funding),
    coverage: {
      ...runtime.funding.coverage,
      unresolvedKeys: ["missing-funding"],
      unresolvedHash: exactSetHash(["missing-funding"]),
    },
  };
  assertRejectsRuntime(
    { ...runtime, funding: invalidFunding },
    /non-partitioned funding keys coverage/,
  );
}
console.log("[blockscan-production-boundary] atomic funding coverage: PASS");

{
  const exactBlockHash = `0x${"33".repeat(32)}`;
  const exactGraph = createVerifiedGraphView({
    id: "production-boundary-exact-n",
    generation: runtime.generation + 1,
    sourceBlock: block + 1,
    sourceBlockHash: exactBlockHash,
    completenessWatermark: block + 1,
    perSourceCoverage: [{
      familyId: "fixture",
      sourceId: "fixture",
      sourceFingerprint: "fixture-v1",
      completeThroughBlock: block + 1,
      completeThroughHash: exactBlockHash,
    }],
    edges: runtime.graph.edges,
  });
  const fallback = enumerateNMinusOneCoarseCandidates({
    coarsePricing: runtime.pricing,
    canonicalPredecessorHash: blockHash,
    exactGraph,
    cfg,
  });
  assert(fallback.candidates.length > 0);
  assert.equal(fallback.fullCoverage, false);
  assert.equal(fallback.recallMode, "stale-positive-only");
  assert(
    fallback.candidates.every(
      (candidate) =>
        candidate.exactProbeOpportunity.sourceBlock === block + 1 &&
        candidate.exactProbeOpportunity.seedEdges.every(
          (edge) => exactGraph.edges.includes(edge),
        ),
    ),
  );
  const promoted = promoteNMinusOneExactCandidates(
    fallback.candidates,
    [fallback.candidates[0]!.exactProbeOpportunity],
  );
  assert.equal(promoted[0]!.sourceBlock, block + 1);
  assert.throws(
    () =>
      promoteNMinusOneExactCandidates(
        fallback.candidates,
        [{ ...fallback.candidates[0]!.exactProbeOpportunity }],
      ),
    /outside the exact probe set/,
  );
  assert.throws(
    () =>
      enumerateNMinusOneCoarseCandidates({
        coarsePricing: runtime.pricing,
        canonicalPredecessorHash: `0x${"44".repeat(32)}`,
        exactGraph,
        cfg,
      }),
    /no longer canonical/,
  );
  const nPlusTwoGraph = createVerifiedGraphView({
    ...exactGraph,
    id: "production-boundary-n-plus-two",
    generation: exactGraph.generation + 1,
    sourceBlock: block + 2,
    sourceBlockHash: `0x${"55".repeat(32)}`,
    completenessWatermark: block + 2,
    perSourceCoverage: [{
      familyId: "fixture",
      sourceId: "fixture",
      sourceFingerprint: "fixture-v1",
      completeThroughBlock: block + 2,
      completeThroughHash: `0x${"55".repeat(32)}`,
    }],
  });
  assert.throws(
    () =>
      enumerateNMinusOneCoarseCandidates({
        coarsePricing: runtime.pricing,
        canonicalPredecessorHash: blockHash,
        exactGraph: nPlusTwoGraph,
        cfg,
      }),
    /exactly N-1/,
    "a non-adjacent coarse source must be rejected",
  );
  const sameBlockGraph = createVerifiedGraphView({
    ...exactGraph,
    id: "production-boundary-same-block",
    generation: exactGraph.generation,
    sourceBlock: block,
    sourceBlockHash: blockHash,
    completenessWatermark: block,
    perSourceCoverage: [{
      familyId: "fixture",
      sourceId: "fixture",
      sourceFingerprint: "fixture-v1",
      completeThroughBlock: block,
      completeThroughHash: blockHash,
    }],
  });
  assert.throws(
    () =>
      enumerateNMinusOneCoarseCandidates({
        coarsePricing: runtime.pricing,
        canonicalPredecessorHash: blockHash,
        exactGraph: sameBlockGraph,
        cfg,
      }),
    /exactly N-1/,
  );
  const changedEdges = exactGraph.edges.map((edgeValue) => ({
    ...edgeValue,
    v2FeeBps: 31n,
  }));
  const changedGraph = createVerifiedGraphView({
    id: "production-boundary-changed-edge",
    generation: exactGraph.generation,
    sourceBlock: exactGraph.sourceBlock,
    sourceBlockHash: exactGraph.sourceBlockHash,
    completenessWatermark: exactGraph.sourceBlock,
    perSourceCoverage: exactGraph.perSourceCoverage,
    edges: changedEdges,
  });
  const changed = enumerateNMinusOneCoarseCandidates({
    coarsePricing: runtime.pricing,
    canonicalPredecessorHash: blockHash,
    exactGraph: changedGraph,
    cfg,
  });
  assert(changed.rejectedRouteCount > 0);
  const taxonomyChangedGraph = createVerifiedGraphView({
    id: "production-boundary-changed-taxonomy",
    generation: exactGraph.generation,
    sourceBlock: exactGraph.sourceBlock,
    sourceBlockHash: exactGraph.sourceBlockHash,
    completenessWatermark: exactGraph.sourceBlock,
    perSourceCoverage: exactGraph.perSourceCoverage,
    edges: exactGraph.edges.map((edgeValue) => ({
      ...edgeValue,
      leavesStandingPosition: !edgeValue.leavesStandingPosition,
    })),
  });
  const taxonomyChanged = enumerateNMinusOneCoarseCandidates({
    coarsePricing: runtime.pricing,
    canonicalPredecessorHash: blockHash,
    exactGraph: taxonomyChangedGraph,
    cfg,
  });
  assert(
    taxonomyChanged.rejectedRouteCount > 0,
    "taxonomy/ownership metadata changes must reject a stale route",
  );
}
console.log("[blockscan-production-boundary] N-1 coarse isolation: PASS");

const coreSource = readFileSync(
  new URL("../detector/blockscan-scanner-core.ts", import.meta.url),
  "utf8",
);
const productionSource = readFileSync(
  new URL("../detector/blockscan-scanner-production.ts", import.meta.url),
  "utf8",
);
for (const [name, source] of [
  ["core", coreSource],
  ["production", productionSource],
] as const) {
  assert.doesNotMatch(
    source,
    /PoolStateCache|protocolMids|PRODUCTION_ADAPTER_FAMILIES|\breadMid\b|WarmSpec|mid-readers|adapterId\s*[!=]==?|family\.id\s*[!=]==?/,
    `${name} scanner must have no legacy fallback dependency`,
  );
}
assert.match(
  productionSource,
  /runtime:\s*AdapterRuntimeSnapshot/,
  "production API must accept the atomic runtime as one value",
);
console.log("[blockscan-production-boundary] structural no-fallback contract: PASS");

console.log("blockscan-scanner-production-boundary PASS");

function venueEdges(pool: string): TokenEdge[] {
  return [
    edge(pool, token, ADDR.WETH),
    edge(pool, ADDR.WETH, token),
  ];
}

function edge(pool: string, tokenIn: string, tokenOut: string): TokenEdge {
  return {
    adapterId: "univ2-swap",
    target: pool,
    tokenIn,
    tokenOut,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
  };
}

function buildMids(): ReadonlyMap<string, RouteVenueMid> {
  const out = new Map<string, RouteVenueMid>();
  for (const edgeValue of edges) {
    const mid = readV2WarmMid({
      cache,
      sourceBlock: block,
      a: edgeValue.tokenIn.toLowerCase(),
      b: edgeValue.tokenOut.toLowerCase(),
      pool: edgeValue.target,
      edges: [edgeValue],
    });
    assert(mid, `missing test mid for ${blockScanEdgeKey(edgeValue)}`);
    out.set(blockScanEdgeKey(edgeValue), mid);
  }
  return out;
}

function buildRuntime(
  graphEdges: readonly TokenEdge[],
  stateMids: ReadonlyMap<string, RouteVenueMid>,
): AdapterRuntimeSnapshot {
  const graph = createVerifiedGraphView({
    id: "production-boundary-fixture",
    generation: 7,
    sourceBlock: block,
    sourceBlockHash: blockHash,
    completenessWatermark: block,
    perSourceCoverage: [{
      familyId: "fixture",
      sourceId: "fixture",
      sourceFingerprint: "fixture-v1",
      completeThroughBlock: block,
      completeThroughHash: blockHash,
    }],
    edges: graphEdges,
  });
  const canonicalMids = new Map<string, RouteVenueMid>(
    graph.edges.map((edgeValue, index): [string, RouteVenueMid] => {
    const priorKey = blockScanEdgeKey(graphEdges[index]);
    const mid = stateMids.get(priorKey);
    if (!mid) throw new Error(`missing fixture mid ${priorKey}`);
    return [blockScanEdgeKey(edgeValue), {
      ...mid,
      edges: [edgeValue],
    }];
  }));
  const edgeKeys = [...canonicalMids.keys()].sort();
  const stateKeys = [pool1.toLowerCase(), pool2.toLowerCase()].sort();
  const readKeys = stateKeys.map((stateKey) => `${stateKey}\u001fstate`);
  const coverage = coverageFor(
    stateKeys,
    stateKeys,
    [],
    readKeys,
    readKeys,
    [],
    edgeKeys,
    edgeKeys,
    [],
  );
  const pricing: BlockScanStateSnapshot = {
    generation: graph.generation,
    sourceBlock: graph.sourceBlock,
    sourceBlockHash: graph.sourceBlockHash,
    graph,
    mids: canonicalMids,
    coverageByReadKey: new Map(readKeys.map((readKey) => [
      readKey,
      { status: "resolved" as const },
    ])),
    coverageByEdgeKey: new Map(edgeKeys.map((edgeKey) => [
      edgeKey,
      { status: "resolved" as const },
    ])),
    freshnessByReadKey: new Map(readKeys.map((readKey) => [
      readKey,
      {
        kind: "direct-read" as const,
        source: {
          number: graph.sourceBlock,
          hash: graph.sourceBlockHash,
          generation: graph.generation,
        },
        provenance: {
          kind: "eip1898" as const,
          source: {
            number: graph.sourceBlock,
            hash: graph.sourceBlockHash,
            generation: graph.generation,
          },
          requireCanonical: true as const,
        },
      },
    ])),
    stateByStateKey: new Map(),
    resolvedFamilyIds: ["univ2-swap"],
    incompleteFamilyIds: [],
    coverage,
    laneTelemetry: [],
  };
  const emptyHash = exactSetHash([]);
  return {
    completeness: "complete",
    generation: graph.generation,
    sourceBlock: graph.sourceBlock,
    sourceBlockHash: graph.sourceBlockHash,
    graph,
    pricing,
    funding: {
      generation: graph.generation,
      sourceBlock: graph.sourceBlock,
      sourceBlockHash: graph.sourceBlockHash,
      coverage: {
        expectedKeys: [],
        resolvedKeys: [],
        unresolvedKeys: [],
        expectedHash: emptyHash,
        resolvedHash: emptyHash,
        unresolvedHash: emptyHash,
      },
      coverageByFundingId: new Map(),
      freshnessByFundingId: new Map(),
      sources: new Map(),
      borrowable: () => 0n,
      source: () => null,
    },
  };
}

function coverageFor(
  expectedStateKeys: readonly string[],
  resolvedStateKeys: readonly string[],
  unresolvedStateKeys: readonly string[],
  expectedReadKeys: readonly string[],
  resolvedReadKeys: readonly string[],
  unresolvedReadKeys: readonly string[],
  expectedEdgeKeys: readonly string[],
  resolvedEdgeKeys: readonly string[],
  unresolvedEdgeKeys: readonly string[],
  unavailableEdgeKeys: readonly string[] = [],
): BlockScanStateCoverage {
  return {
    expectedStateKeys,
    resolvedStateKeys,
    unresolvedStateKeys,
    expectedReadKeys,
    resolvedReadKeys,
    unresolvedReadKeys,
    expectedEdgeKeys,
    resolvedEdgeKeys,
    unavailableEdgeKeys,
    unresolvedEdgeKeys,
    expectedStateKeyHash: exactSetHash(expectedStateKeys),
    resolvedStateKeyHash: exactSetHash(resolvedStateKeys),
    unresolvedStateKeyHash: exactSetHash(unresolvedStateKeys),
    expectedReadKeyHash: exactSetHash(expectedReadKeys),
    resolvedReadKeyHash: exactSetHash(resolvedReadKeys),
    unresolvedReadKeyHash: exactSetHash(unresolvedReadKeys),
    expectedEdgeKeyHash: exactSetHash(expectedEdgeKeys),
    resolvedEdgeKeyHash: exactSetHash(resolvedEdgeKeys),
    unavailableEdgeKeyHash: exactSetHash(unavailableEdgeKeys),
    unresolvedEdgeKeyHash: exactSetHash(unresolvedEdgeKeys),
  };
}

function assertRejectsRuntime(
  candidate: AdapterRuntimeSnapshot,
  expected: RegExp,
): void {
  assert.throws(() => assertAtomicBlockScanRuntime(candidate), expected);
}
