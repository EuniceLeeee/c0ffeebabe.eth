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
  assertAtomicBlockScanRuntime,
  detectProductionBlockScanOpportunities,
} from "../detector/blockscan-scanner-production.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { PoolStateCache } from "../solver/pool-state-cache.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import {
  blockScanEdgeKey,
  createVerifiedGraphView,
  exactSetHash,
} from "../venues/blockscan-state-capability.js";
import { readV2WarmMid, type RouteVenueMid } from "../venues/mid-readers.js";

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
