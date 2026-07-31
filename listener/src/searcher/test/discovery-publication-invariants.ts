import assert from "node:assert/strict";
import {
  CanonicalHeaderJournal,
  type CanonicalHeader,
} from "../canonical-header-journal.js";
import {
  DiscoveryBackfillLane,
  type DiscoveryBackfillPlan,
  type DiscoveryBackfillRequest,
  type DiscoveryBackfillSource,
} from "../discovery-backfill-lane.js";
import type { DiscoveryRange } from "../discovery-source-watermark.js";
import {
  cloneLiveDiscoveryPublicationState,
  describeDexPublicationSlice,
  describeDexRoutingSlice,
  describeLiveDiscoveryPublicationState,
  describeProtocolPublicationSlice,
  rebaseHotDexPublication,
  type DiscoveryCoverageAnchor,
  type LiveDiscoveryPublicationState,
} from "../live-discovery-publication.js";
import {
  planLiveDiscoveryBackfillLanes,
  prepareDexIdentityRetryForResolution,
} from "../live-discovery-coordinator.js";
import {
  createProtocolDiscoveryEvidenceCache,
  recordProtocolRouteOwnership,
} from "../protocol-discovery-cache.js";
import { ProtocolDiscoveryMutationQueue } from
  "../protocol-discovery-coordinator.js";
import {
  deriveVerifiedRouteClaims,
  projectVerifiedProtocolPool,
  protocolEdgeKey,
  protocolInstanceKey,
  semanticRouteKey,
  type VerifiedProtocolAdmission,
} from "../protocol-instance-discovery.js";
import {
  buildTokenIndex,
  type PoolEntry,
  type TokenEdge,
} from "../planner/token-graph.js";
import { poolProjectionRowKey } from "../pool-universe.js";
import type { RuntimePoolRefreshDelta } from "../runtime-pool-refresh.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import { buildStrategyViews } from "../strategy-views.js";
import { bindRouteInstanceIdentity } from
  "../venues/route-instance-identity.js";
import type { AttestedProtocolInstance } from
  "../venues/route-leg-adapter.js";
import { fluidDexAdapter } from "../venues/swaps/fluid-dex.js";

const PROTOCOL_FAMILY = "protocol:erc4626";
const OBSERVED = `${PROTOCOL_FAMILY}\u001fobserved-interaction`;
const ADDRESS = `${PROTOCOL_FAMILY}\u001fdex-token-domain`;
const TEST_CHAIN_ID = "1";

interface PreparedTransition {
  readonly dexRange: DiscoveryRange;
  readonly observedRange: DiscoveryRange;
  readonly addressSnapshotAt: number;
  readonly source: DiscoveryBackfillSource;
}

await divergentCursorsAdvanceWithoutSkipping();
await observedPublicationRejectsPreparedBackgroundState();
await sameHeightReorgRejectsOldPreparedState();
await hotHeadAdvancesFromPreviousBlock();
await slowTraceDoesNotBlockShortPublicationQueue();
hotDexRebasePreservesReplacedProtocolPublication();
hotDexRebaseRejectsGraphOnlyDexConflict();
hotDexRebaseRejectsProtocolSemanticCollision();
dexRoutingSliceIgnoresCoverageOnlyPublication();
dexRoutingSliceDetectsTopologyChange();
projectionRetryDoesNotPreemptProtocolBackfill();
await identityRetryRunsOnlyInDetachedCompleteLane();

console.log(
  "[discovery-publication-invariants] cursor/CAS/reorg/hot/queue: PASS (12/12)",
);

async function identityRetryRunsOnlyInDetachedCompleteLane(): Promise<void> {
  let invoked = false;
  const gate = deferred<string>();
  const operation = () => {
    invoked = true;
    return gate.promise;
  };
  const hot = await prepareDexIdentityRetryForResolution(
    "bounded",
    operation,
  );
  assert.equal(hot, null);
  assert.equal(
    invoked,
    false,
    "current-head bounded discovery must neither invoke nor await the identity backlog",
  );

  const detached = prepareDexIdentityRetryForResolution(
    "complete",
    operation,
  );
  assert.equal(
    invoked,
    true,
    "detached complete discovery owns identity backlog healing",
  );
  gate.resolve("healed");
  assert.equal(await detached, "healed");
}

function projectionRetryDoesNotPreemptProtocolBackfill(): void {
  assert.deepEqual(
    planLiveDiscoveryBackfillLanes({
      dexSourceCompleteThrough: 99,
      dexTargetThrough: 100,
      hasDexProjectionRetry: true,
    }),
    { dex: "source", protocol: "preempt" },
    "raw DEX source lag keeps priority over protocol history",
  );
  assert.deepEqual(
    planLiveDiscoveryBackfillLanes({
      dexSourceCompleteThrough: 100,
      dexTargetThrough: 100,
      hasDexProjectionRetry: true,
    }),
    { dex: "projection", protocol: "schedule" },
    "family-local projection retry must not starve protocol history",
  );
}

async function divergentCursorsAdvanceWithoutSkipping(): Promise<void> {
  const base = publicationAt({
    dexSource: 105,
    dexGraph: 105,
    observed: 100,
    address: 103,
  });
  const source = sourceAt(106);
  const request = combinedRequest(base, source);
  assert.deepEqual(
    request.range,
    { fromBlock: 101, toBlock: 106 },
    "the combined request starts after the least contiguous cursor",
  );

  const skipped = transition({
    dexRange: { fromBlock: 106, toBlock: 106 },
    observedRange: { fromBlock: 104, toBlock: 106 },
    addressSnapshotAt: 106,
    source,
  });
  const skippedLane = laneFor(async () => skipped);
  skippedLane.schedule(request, base);
  await waitFor(() => skippedLane.telemetry().failed === 1);
  assert.match(
    skippedLane.telemetry().lastFailure ?? "",
    /observed range skipped blocks: expected 101, received 104/,
  );

  const exact = transition({
    dexRange: { fromBlock: 106, toBlock: 106 },
    observedRange: { fromBlock: 101, toBlock: 106 },
    addressSnapshotAt: 106,
    source,
  });
  const lane = laneFor(async () => exact);
  lane.schedule(request, base);
  await waitFor(() => lane.readyDescriptor() !== null);
  const taken = lane.takeForHotHead({
    targetSource: source,
    currentState: base,
    canonicalPreparedSource: { revision: 9, source },
    currentCanonicalRevision: 9,
  });
  assert.equal(taken.status, "ready");
  if (taken.status !== "ready") throw new Error("expected exact transition");
  assert.equal(taken.state.dexGraphCoverage.sourceCompleteThrough, 106);
  assert.equal(taken.state.dexGraphCoverage.graphCompleteThrough, 106);
  assert.equal(
    taken.state.protocolEvidenceCache.runtime.observedCursor,
    106,
  );
  assert.equal(
    taken.state.protocolFamilySourceCoverage.get(ADDRESS)
      ?.completeThroughBlock,
    106,
  );
}

async function observedPublicationRejectsPreparedBackgroundState(): Promise<
  void
> {
  const base = publicationAt({
    dexSource: 200,
    dexGraph: 200,
    observed: 200,
    address: 200,
  });
  const source = sourceAt(201);
  const prepared = exactTransition(base, source);
  const lane = laneFor(async () => prepared);
  lane.schedule(combinedRequest(base, source), base);
  await waitFor(() => lane.readyDescriptor() !== null);

  const observedClone = cloneLiveDiscoveryPublicationState(base);
  observedClone.protocolEvidenceCache.runtime.recentProcessedTxs.set(
    blockHash(0xbeef),
    200,
  );
  const observedPublication: LiveDiscoveryPublicationState = {
    ...observedClone,
    revision: base.revision + 1,
  };

  const queue = new ProtocolDiscoveryMutationQueue();
  let live = base;
  await queue.enqueue("observed", async () => {
    live = observedPublication;
  });
  const result = await queue.enqueue("dex-refresh", async () =>
    lane.takeForHotHead({
      targetSource: source,
      currentState: live,
      canonicalPreparedSource: { revision: 4, source },
      currentCanonicalRevision: 4,
    })
  );
  assert.equal(result.status, "degraded");
  if (result.status !== "degraded") {
    throw new Error("expected stale background state");
  }
  assert.equal(result.reason, "stale_base");
  assert.strictEqual(
    live,
    observedPublication,
    "a stale background projection must not overwrite the observed commit",
  );
}

async function sameHeightReorgRejectsOldPreparedState(): Promise<void> {
  const baseHeight = 300;
  const sourceHeight = baseHeight + 1;
  const base = publicationAt({
    dexSource: baseHeight,
    dexGraph: baseHeight,
    observed: baseHeight,
    address: baseHeight,
  });
  const journal = new CanonicalHeaderJournal();
  const baseHeader = header(
    baseHeight,
    blockHash(baseHeight),
    blockHash(baseHeight - 1),
  );
  const sourceA = header(
    sourceHeight,
    variantHash(sourceHeight, 0xaa),
    baseHeader.hash,
  );
  const sourceB = header(
    sourceHeight,
    variantHash(sourceHeight, 0xbb),
    baseHeader.hash,
  );
  journal.ingest(baseHeader);
  journal.ingest(sourceA);

  const oldSource = { number: sourceHeight, hash: sourceA.hash };
  const lane = laneFor(async () => exactTransition(base, oldSource));
  lane.schedule(combinedRequest(base, oldSource), base);
  await waitFor(() => lane.readyDescriptor() !== null);

  const reorg = journal.ingest(sourceB);
  assert.equal(reorg.status, "reorganized");
  assert.equal(reorg.sameHeightReplacement, true);
  assert.equal(reorg.invalidatedFrom, sourceHeight);
  const proof = journal.proof(sourceHeight);
  assert(proof);
  const canonicalSource = {
    number: sourceHeight,
    hash: sourceB.hash,
  };
  const result = lane.takeForHotHead({
    targetSource: canonicalSource,
    currentState: base,
    canonicalPreparedSource: {
      revision: proof.revision,
      source: proof.source,
    },
    currentCanonicalRevision: journal.revision,
  });
  assert.equal(result.status, "degraded");
  if (result.status !== "degraded") {
    throw new Error("expected reorg rejection");
  }
  assert.equal(result.reason, "non_canonical_source");
}

async function hotHeadAdvancesFromPreviousBlock(): Promise<void> {
  const previous = 400;
  const current = previous + 1;
  const base = publicationAt({
    dexSource: previous,
    dexGraph: previous,
    observed: previous,
    address: previous,
  });
  const journal = new CanonicalHeaderJournal();
  const previousHeader = header(
    previous,
    blockHash(previous),
    blockHash(previous - 1),
  );
  const currentHeader = header(
    current,
    blockHash(current),
    previousHeader.hash,
  );
  journal.ingest(previousHeader);
  journal.ingest(currentHeader);
  const source = { number: current, hash: currentHeader.hash };

  const lane = laneFor(async () => exactTransition(base, source));
  lane.schedule(combinedRequest(base, source), base);
  await waitFor(() => lane.readyDescriptor() !== null);
  const proof = journal.proof(current);
  assert(proof);
  const result = lane.takeForHotHead({
    targetSource: source,
    currentState: base,
    canonicalPreparedSource: {
      revision: proof.revision,
      source: proof.source,
    },
    currentCanonicalRevision: journal.revision,
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("expected hot transition");
  assert.equal(result.graphCompleteThrough, current);
  assert.equal(
    describeLiveDiscoveryPublicationState(result.state)
      .graphCompleteThrough,
    current,
    "all exact coverage anchors must advance from N-1 to N atomically",
  );
}

async function slowTraceDoesNotBlockShortPublicationQueue(): Promise<void> {
  const base = publicationAt({
    dexSource: 500,
    dexGraph: 500,
    observed: 500,
    address: 500,
  });
  const source = sourceAt(501);
  const trace = deferred<void>();
  const traceStarted = deferred<void>();
  const lane = laneFor(async (_plan, control) =>
    control.run(async (signal) => {
      traceStarted.resolve();
      await trace.promise;
      if (signal.aborted) throw signal.reason;
      return exactTransition(base, source);
    })
  );
  lane.schedule(combinedRequest(base, source), base);
  await traceStarted.promise;
  assert.equal(lane.telemetry().activeReads, 1);

  const queue = new ProtocolDiscoveryMutationQueue();
  let shortPublishCommitted = false;
  await queue.enqueue("observed", async () => {
    shortPublishCommitted = true;
  });
  assert.equal(
    shortPublishCommitted,
    true,
    "a pending trace outside the queue cannot delay a short publication",
  );
  assert.equal(
    lane.readyDescriptor(),
    null,
    "the trace remains pending while the queue publication completes",
  );

  trace.resolve();
  await waitFor(() => lane.readyDescriptor() !== null);
}

function hotDexRebasePreservesReplacedProtocolPublication(): void {
  const staleSupplement: PoolEntry = {
    address: address(0x70ff),
    adapter: "univ2",
    token0: address(0x71ff),
    token1: address(0x72ff),
  };
  const emptyBase = publicationAt({
    dexSource: 600,
    dexGraph: 600,
    observed: 600,
    address: 600,
  });
  const empty: LiveDiscoveryPublicationState = {
    ...emptyBase,
    suppressedDexPoolKeys: new Set([
      poolProjectionRowKey(staleSupplement),
    ]),
  };
  const oldAdmission = protocolAdmission(0x7100, 0x7200);
  const base = replaceProtocolPublication(empty, oldAdmission, 600);
  const replacement = protocolAdmission(0x7101, 0x7201);
  const current = replaceProtocolPublication(base, replacement, 601);
  const currentClone = cloneLiveDiscoveryPublicationState(current);
  currentClone.protocolEvidenceCache.runtime.recentProcessedTxs.set(
    blockHash(0xbeef),
    601,
  );
  const concurrent: LiveDiscoveryPublicationState = {
    ...currentClone,
    revision: currentClone.revision + 1,
  };
  assert.equal(
    describeDexPublicationSlice(concurrent),
    describeDexPublicationSlice(base),
    "replacing only protocol ownership must leave the DEX CAS slice stable",
  );
  assert.notEqual(
    describeProtocolPublicationSlice(concurrent),
    describeProtocolPublicationSlice(base),
    "the interleave fixture must contain a real protocol projection change",
  );
  const protocolBefore = describeProtocolPublicationSlice(concurrent);
  const sourceAnchor = anchor(601);
  const delta = dexDelta(0x7300, 0x7400, 0x7500);
  const rebased = rebaseHotDexPublication({
    current: concurrent,
    patch: {
      baseDexFingerprint: describeDexPublicationSlice(base),
      chainId: TEST_CHAIN_ID,
      delta,
      retryableDexGraphPools: concurrent.retryableDexGraphPools,
      retryableDexIdentityPools: concurrent.retryableDexIdentityPools,
      dexGraphCoverage: {
        sourceCompleteThrough: 601,
        graphCompleteThrough: 601,
      },
      dexSourceAnchor: sourceAnchor,
      dexGraphAnchor: sourceAnchor,
      landedCoverage: concurrent.landedCoverage,
    },
    buildStrategyViews: (pools, suppressed = new Set<string>()) =>
      buildStrategyViews(
        pools,
        suppressed.has(poolProjectionRowKey(staleSupplement))
          ? []
          : [staleSupplement],
        [],
        {
          blockscanMaxPools: 10_000,
          poolUniverseGeneratedAt: "2026-07-26T00:00:00.000Z",
        },
      ),
  });
  assert(rebased);
  assert.equal(rebased.revision, concurrent.revision + 1);
  assert.equal(rebased.dexGraphCoverage.graphCompleteThrough, 601);
  assert.equal(
    describeProtocolPublicationSlice(rebased),
    protocolBefore,
    "a protocol-only concurrent publication must survive the DEX rebase",
  );
  assert(
    rebased.backrunGraph.some((edge) =>
      edge.target.toLowerCase() ===
        delta.successfulBuilds[0]!.pool.address.toLowerCase()
    ),
    "the prepared non-empty DEX delta must enter the rebased graph",
  );
  assert.equal(
    rebased.strategyViews.blockscan.some((pool) =>
      poolProjectionRowKey(pool) === poolProjectionRowKey(staleSupplement)
    ),
    false,
    "a hot DEX rebase must preserve stale-row tombstones when rebuilding supplements",
  );
  assert(
    rebased.strategyViews.backrun.some((pool) =>
      pool.address.toLowerCase() === replacement.instance.pool.address.toLowerCase()
    ),
    "the replacement protocol pool must remain published",
  );
  assert(
    !rebased.backrunGraph.some((edge) =>
      protocolEdgeKey(edge) === protocolEdgeKey(oldAdmission.edges[0]!)
    ),
    "the DEX rebase must not resurrect the protocol route replaced concurrently",
  );
  assert.equal(
    rebased.protocolFamilySourceCoverage.get(OBSERVED)?.completeThroughBlock,
    601,
    "the concurrent protocol family coverage sentinel must survive",
  );
  assert.equal(
    rebased.protocolEvidenceCache.runtime.recentProcessedTxs.has(
      blockHash(0xbeef),
    ),
    true,
    "the concurrent protocol evidence-cache sentinel must survive",
  );
}

function hotDexRebaseRejectsGraphOnlyDexConflict(): void {
  const base = publicationAt({
    dexSource: 610,
    dexGraph: 610,
    observed: 610,
    address: 610,
  });
  const current = appendDexPublication(
    base,
    dexDelta(0x7600, 0x7700, 0x7800),
  );
  assert.notEqual(
    describeDexPublicationSlice(current),
    describeDexPublicationSlice(base),
    "the negative control must change only the DEX graph slice",
  );
  assert.deepEqual(
    current.dexGraphCoverage,
    base.dexGraphCoverage,
    "the graph-only negative control must not rely on coverage drift",
  );
  const sourceAnchor = anchor(611);
  assert.equal(
    rebaseHotDexPublication({
      current,
      patch: {
        baseDexFingerprint: describeDexPublicationSlice(base),
        chainId: TEST_CHAIN_ID,
        delta: dexDelta(0x7601, 0x7701, 0x7801),
        retryableDexGraphPools: current.retryableDexGraphPools,
        retryableDexIdentityPools: current.retryableDexIdentityPools,
        dexGraphCoverage: {
          sourceCompleteThrough: 611,
          graphCompleteThrough: 611,
        },
        dexSourceAnchor: sourceAnchor,
        dexGraphAnchor: sourceAnchor,
        landedCoverage: current.landedCoverage,
      },
      buildStrategyViews: fixtureStrategyViews,
    }),
    null,
    "a graph-only concurrent DEX publication must remain a real CAS conflict",
  );
}

function hotDexRebaseRejectsProtocolSemanticCollision(): void {
  const base = publicationAt({
    dexSource: 620,
    dexGraph: 620,
    observed: 620,
    address: 620,
  });
  const admission = fluidDexAdmission(0x7900, 0x7a00, 0x7b00);
  const current = replaceProtocolPublication(base, admission, 621);
  const collisionPool: PoolEntry = {
    ...admission.instance.pool,
    discoveryOwnerAdapterId: undefined,
    verifiedRoutes: undefined,
  };
  const collisionEdges = fluidDexEdges(collisionPool);
  const collisionEdge = collisionEdges[0]!;
  const collisionDelta: RuntimePoolRefreshDelta = {
    attemptedPools: [collisionPool],
    successfulBuilds: [{
      pool: collisionPool,
      edges: collisionEdges,
    }],
    failedPools: [],
  };
  assert.equal(
    describeDexPublicationSlice(current),
    describeDexPublicationSlice(base),
    "a protocol-only publication must be eligible for lane-aware rebase",
  );
  assert.equal(
    semanticRouteKey(TEST_CHAIN_ID, collisionEdge),
    admission.claims[0]!.semanticRouteKey,
    "the negative control must collide on the exact semantic route key",
  );
  const sourceAnchor = anchor(621);
  assert.equal(
    rebaseHotDexPublication({
      current,
      patch: {
        baseDexFingerprint: describeDexPublicationSlice(base),
        chainId: TEST_CHAIN_ID,
        delta: collisionDelta,
        retryableDexGraphPools: current.retryableDexGraphPools,
        retryableDexIdentityPools: current.retryableDexIdentityPools,
        dexGraphCoverage: {
          sourceCompleteThrough: 621,
          graphCompleteThrough: 621,
        },
        dexSourceAnchor: sourceAnchor,
        dexGraphAnchor: sourceAnchor,
        landedCoverage: current.landedCoverage,
      },
      buildStrategyViews: fixtureStrategyViews,
    }),
    null,
    "a prepared DEX edge may not overwrite a protocol-owned semantic route",
  );
}

function dexRoutingSliceIgnoresCoverageOnlyPublication(): void {
  const base = publicationAt({
    dexSource: 630,
    dexGraph: 630,
    observed: 630,
    address: 630,
  });
  const coverageOnly: LiveDiscoveryPublicationState = {
    ...cloneLiveDiscoveryPublicationState(base),
    revision: base.revision + 1,
    dexGraphCoverage: {
      sourceCompleteThrough: 631,
      graphCompleteThrough: 631,
    },
    dexSourceAnchor: anchor(631),
    dexGraphAnchor: anchor(631),
  };
  assert.equal(
    describeDexRoutingSlice(coverageOnly),
    describeDexRoutingSlice(base),
    "protocol rebase must cross a DEX coverage-only publication",
  );
}

function dexRoutingSliceDetectsTopologyChange(): void {
  const base = publicationAt({
    dexSource: 640,
    dexGraph: 640,
    observed: 640,
    address: 640,
  });
  const topologyChanged = appendDexPublication(
    base,
    dexDelta(0x7c00, 0x7d00, 0x7e00),
  );
  assert.notEqual(
    describeDexRoutingSlice(topologyChanged),
    describeDexRoutingSlice(base),
    "protocol rebase must reject a concurrent DEX routing change",
  );
}

function fluidDexAdmission(
  poolAddress: number,
  token0Address: number,
  token1Address: number,
): VerifiedProtocolAdmission {
  const instance: AttestedProtocolInstance = {
    pool: {
      address: address(poolAddress),
      adapter: "fluid-dex",
      venueId: "fluid",
      factory: address(0x7c00),
      identitySource: "fluid-dex-factory-behavior",
      token0: address(token0Address),
      token1: address(token1Address),
    },
    sources: ["dex-token-domain"],
    selectors: [],
    evidence: [{ kind: "fluid-dex-constants", blockNumber: 620 }],
    ownerAdapterId: fluidDexAdapter.id,
  };
  const edges = fluidDexEdges(instance.pool);
  return {
    adapterId: fluidDexAdapter.id,
    instance,
    edges,
    claims: deriveVerifiedRouteClaims(
      fluidDexAdapter.id,
      instance,
      edges,
      TEST_CHAIN_ID,
      fluidDexAdapter.discoveryIdentityAuthority,
    ),
  };
}

function fluidDexEdges(pool: PoolEntry): TokenEdge[] {
  return bindRouteInstanceIdentity(fluidDexAdapter, pool, [
    fluidDexEdge(pool, pool.token0!, pool.token1!),
    fluidDexEdge(pool, pool.token1!, pool.token0!),
  ]);
}

function fluidDexEdge(
  pool: PoolEntry,
  tokenIn: string,
  tokenOut: string,
): TokenEdge {
  return {
    adapterId: "fluid-dex-swap",
    target: pool.address,
    tokenIn,
    tokenOut,
    poolToken0: pool.token0,
    poolToken1: pool.token1,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
  };
}

function protocolAdmission(
  poolAddress: number,
  assetAddress: number,
): VerifiedProtocolAdmission {
  const pool = address(poolAddress);
  const asset = address(assetAddress);
  const instance: AttestedProtocolInstance = {
    pool: {
      address: pool,
      adapter: "erc4626",
      venueId: "erc4626",
      identitySource: "erc4626-standard",
      fixedTokenIn: asset,
      fixedTokenOut: pool,
      fixedSlotKind: "protocol",
      fixedProtocolAction: "wrap",
    },
    sources: ["observed-interaction"],
    selectors: ["0x12345678"],
    evidence: [{ kind: "fixture", blockNumber: 600 }],
    ownerAdapterId: PROTOCOL_FAMILY,
  };
  const edge: TokenEdge = {
    adapterId: "erc4626-deposit",
    target: pool,
    tokenIn: asset,
    tokenOut: pool,
    slotKind: "protocol",
    protocolAction: "wrap",
    ...deriveEdgeTaxonomy("protocol", "wrap"),
  };
  return {
    adapterId: PROTOCOL_FAMILY,
    instance,
    edges: [edge],
    claims: deriveVerifiedRouteClaims(
      PROTOCOL_FAMILY,
      instance,
      [edge],
      TEST_CHAIN_ID,
      { class: "canonical-onchain", strength: 100 },
    ),
  };
}

function replaceProtocolPublication(
  source: LiveDiscoveryPublicationState,
  admission: VerifiedProtocolAdmission,
  through: number,
): LiveDiscoveryPublicationState {
  const next = cloneLiveDiscoveryPublicationState(source);
  const priorEdgeKeys = new Set(
    [...source.protocolOwnership.admissions.values()].flatMap((item) =>
      item.edges.map(protocolEdgeKey)
    ),
  );
  const basePools = source.strategyViews.backrun.filter(
    (pool) => pool.discoveryOwnerAdapterId === undefined,
  );
  const baseBackrunGraph = source.backrunGraph.filter(
    (edge) => !priorEdgeKeys.has(protocolEdgeKey(edge)),
  );
  const baseBlockscanGraph = source.blockscanGraph?.filter(
    (edge) => !priorEdgeKeys.has(protocolEdgeKey(edge)),
  );
  const pool = projectVerifiedProtocolPool(admission);
  const strategyViews = fixtureStrategyViews([...basePools, pool]);
  const backrunGraph = [...baseBackrunGraph, ...admission.edges];
  const blockscanGraph = baseBlockscanGraph === undefined
    ? undefined
    : [...baseBlockscanGraph, ...admission.edges];
  const ownership = {
    version: source.protocolOwnership.version + 1,
    admissions: new Map([[
      protocolInstanceKey(admission.adapterId, admission.instance.pool),
      admission,
    ]]),
  };
  recordProtocolRouteOwnership(next.protocolEvidenceCache, ownership);
  next.protocolEvidenceCache.runtime.observedCursor = through;
  next.protocolEvidenceCache.runtime.observedCursorHash = blockHash(through);
  const sourceAnchor = anchor(through);
  const pools = strategyViews.backrun;
  const tokenIndex = buildTokenIndex([...backrunGraph]);
  return {
    ...next,
    revision: source.revision + 1,
    strategyViews,
    backrunGraph,
    ...(blockscanGraph === undefined ? {} : { blockscanGraph }),
    tokenIndex,
    poolAddressMap: new Map(
      pools.map((item) => [item.address.toLowerCase(), item.adapter]),
    ),
    knownPoolKeys: new Set(pools.map(poolProjectionRowKey)),
    knownPoolAddresses: new Set(
      pools.map((item) => item.address.toLowerCase()),
    ),
    flashTokens: [...tokenIndex.keys()],
    protocolOwnership: ownership,
    protocolEvidenceCache: next.protocolEvidenceCache,
    protocolFamilySourceCoverage: new Map([
      [`${admission.adapterId}\u001fobserved-interaction`, sourceAnchor],
      [`${admission.adapterId}\u001fdex-token-domain`, sourceAnchor],
    ]),
    protocolObservedCursor: sourceAnchor,
  };
}

function dexDelta(
  poolAddress: number,
  token0Address: number,
  token1Address: number,
): RuntimePoolRefreshDelta {
  const pool: PoolEntry = {
    address: address(poolAddress),
    adapter: "univ2",
    token0: address(token0Address),
    token1: address(token1Address),
  };
  const edges: TokenEdge[] = [
    dexEdge(pool, pool.token0!, pool.token1!),
    dexEdge(pool, pool.token1!, pool.token0!),
  ];
  return {
    attemptedPools: [pool],
    successfulBuilds: [{ pool, edges }],
    failedPools: [],
  };
}

function dexEdge(
  pool: PoolEntry,
  tokenIn: string,
  tokenOut: string,
): TokenEdge {
  return {
    adapterId: "univ2-swap",
    target: pool.address,
    tokenIn,
    tokenOut,
    poolToken0: pool.token0,
    poolToken1: pool.token1,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
  };
}

function appendDexPublication(
  source: LiveDiscoveryPublicationState,
  delta: RuntimePoolRefreshDelta,
): LiveDiscoveryPublicationState {
  const built = delta.successfulBuilds[0]!;
  const strategyViews = fixtureStrategyViews([
    ...source.strategyViews.backrun,
    built.pool,
  ]);
  const backrunGraph = [...source.backrunGraph, ...built.edges];
  const blockscanGraph = source.blockscanGraph === undefined
    ? undefined
    : [...source.blockscanGraph, ...built.edges];
  const tokenIndex = buildTokenIndex([...backrunGraph]);
  return {
    ...cloneLiveDiscoveryPublicationState(source),
    revision: source.revision + 1,
    strategyViews,
    backrunGraph,
    ...(blockscanGraph === undefined ? {} : { blockscanGraph }),
    tokenIndex,
    poolAddressMap: new Map(
      strategyViews.backrun.map((pool) => [
        pool.address.toLowerCase(),
        pool.adapter,
      ]),
    ),
    knownPoolKeys: new Set(
      strategyViews.backrun.map(poolProjectionRowKey),
    ),
    knownPoolAddresses: new Set(
      strategyViews.backrun.map((pool) => pool.address.toLowerCase()),
    ),
    flashTokens: [...tokenIndex.keys()],
  };
}

function fixtureStrategyViews(pools: PoolEntry[]) {
  return buildStrategyViews(pools, [], [], {
    blockscanMaxPools: 10_000,
    poolUniverseGeneratedAt: "2026-07-26T00:00:00.000Z",
  });
}

function address(value: number): string {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function laneFor(
  prepare: (
    plan: DiscoveryBackfillPlan<LiveDiscoveryPublicationState>,
    control: Parameters<
      ConstructorParameters<
        typeof DiscoveryBackfillLane<
          LiveDiscoveryPublicationState,
          PreparedTransition
        >
      >[0]["prepare"]
    >[1],
  ) => Promise<PreparedTransition>,
): DiscoveryBackfillLane<
  LiveDiscoveryPublicationState,
  PreparedTransition
> {
  return new DiscoveryBackfillLane({
    maxBlocksPerJob: 32,
    maxPreparationMs: 5_000,
    maxConcurrency: 2,
    describeState: describeLiveDiscoveryPublicationState,
    prepare,
    validateTransition: validateTransition,
  });
}

function validateTransition(
  plan: DiscoveryBackfillPlan<LiveDiscoveryPublicationState>,
  prepared: PreparedTransition,
): {
  readonly state: LiveDiscoveryPublicationState;
  readonly source: DiscoveryBackfillSource;
} {
  const base = plan.baseState;
  const dexFrom = base.dexGraphCoverage.sourceCompleteThrough + 1;
  const observedCursor =
    base.protocolEvidenceCache.runtime.observedCursor ?? -1;
  const observedFrom = observedCursor + 1;
  assert.equal(
    plan.range.fromBlock,
    Math.min(dexFrom, observedFrom),
    "combined range must begin at the least next contiguous cursor",
  );
  if (prepared.dexRange.fromBlock !== dexFrom) {
    throw new Error(
      `DEX range skipped blocks: expected ${dexFrom}, received ` +
        prepared.dexRange.fromBlock,
    );
  }
  if (prepared.observedRange.fromBlock !== observedFrom) {
    throw new Error(
      `observed range skipped blocks: expected ${observedFrom}, received ` +
        prepared.observedRange.fromBlock,
    );
  }
  assert.equal(prepared.dexRange.toBlock, plan.source.number);
  assert.equal(prepared.observedRange.toBlock, plan.source.number);
  assert.equal(prepared.addressSnapshotAt, plan.source.number);
  assert.deepEqual(prepared.source, plan.source);
  return {
    state: advancePublication(base, prepared),
    source: prepared.source,
  };
}

function advancePublication(
  base: LiveDiscoveryPublicationState,
  prepared: PreparedTransition,
): LiveDiscoveryPublicationState {
  const next = cloneLiveDiscoveryPublicationState(base);
  const through = prepared.source.number;
  const sourceAnchor = anchorAt(through, prepared.source.hash);
  next.protocolEvidenceCache.runtime.observedCursor = through;
  next.protocolEvidenceCache.runtime.observedCursorHash =
    prepared.source.hash;
  return {
    ...next,
    revision: base.revision + 1,
    dexGraphCoverage: {
      sourceCompleteThrough: through,
      graphCompleteThrough: through,
    },
    dexSourceAnchor: sourceAnchor,
    dexGraphAnchor: sourceAnchor,
    protocolFamilySourceCoverage: new Map([
      [OBSERVED, sourceAnchor],
      [ADDRESS, sourceAnchor],
    ]),
    protocolObservedCursor: sourceAnchor,
  };
}

function exactTransition(
  base: LiveDiscoveryPublicationState,
  source: DiscoveryBackfillSource,
): PreparedTransition {
  return transition({
    dexRange: {
      fromBlock: base.dexGraphCoverage.sourceCompleteThrough + 1,
      toBlock: source.number,
    },
    observedRange: {
      fromBlock:
        (base.protocolEvidenceCache.runtime.observedCursor ?? -1) + 1,
      toBlock: source.number,
    },
    addressSnapshotAt: source.number,
    source,
  });
}

function transition(value: PreparedTransition): PreparedTransition {
  return Object.freeze({
    ...value,
    dexRange: Object.freeze({ ...value.dexRange }),
    observedRange: Object.freeze({ ...value.observedRange }),
    source: Object.freeze({ ...value.source }),
  });
}

function combinedRequest(
  base: LiveDiscoveryPublicationState,
  source: DiscoveryBackfillSource,
): DiscoveryBackfillRequest {
  const observed =
    base.protocolEvidenceCache.runtime.observedCursor ?? -1;
  return {
    id: `combined:${source.number}`,
    range: {
      fromBlock: Math.min(
        base.dexGraphCoverage.sourceCompleteThrough,
        observed,
      ) + 1,
      toBlock: source.number,
    },
    source,
  };
}

function publicationAt(input: {
  readonly dexSource: number;
  readonly dexGraph: number;
  readonly observed: number;
  readonly address: number;
}): LiveDiscoveryPublicationState {
  const evidence = createProtocolDiscoveryEvidenceCache(1);
  evidence.runtime.observedCursor = input.observed;
  evidence.runtime.observedCursorHash = blockHash(input.observed);
  const ownership = { version: 0, admissions: new Map() };
  return {
    revision: 0,
    strategyViews: {
      backrun: [],
      blockscan: [],
      versions: {
        strategy_view_version: "fixture:v1",
        backrun_view_hash: "fixture:backrun",
        blockscan_view_hash: "fixture:blockscan",
        pool_universe_generated_at: "2026-07-24T00:00:00.000Z",
        overrides_hash: "fixture:overrides",
      },
    },
    backrunGraph: [],
    blockscanGraph: [],
    tokenIndex: new Map(),
    poolAddressMap: new Map(),
    flashTokens: [],
    knownPoolKeys: new Set(),
    knownPoolAddresses: new Set(),
    protocolOwnership: ownership,
    protocolEvidenceCache: evidence,
    retryableDexGraphPools: new Map(),
    retryableDexIdentityPools: new Map(),
    dexGraphCoverage: {
      sourceCompleteThrough: input.dexSource,
      graphCompleteThrough: input.dexGraph,
    },
    dexSourceAnchor: anchor(input.dexSource),
    dexGraphAnchor: anchor(input.dexGraph),
    landedCoverage: [],
    protocolFamilySourceCoverage: new Map([
      [OBSERVED, anchor(input.observed)],
      [ADDRESS, anchor(input.address)],
    ]),
    protocolObservedCursor: anchor(input.observed),
  };
}

function anchor(block: number): DiscoveryCoverageAnchor {
  return anchorAt(block, blockHash(block));
}

function anchorAt(
  block: number,
  hash: string,
): DiscoveryCoverageAnchor {
  return {
    completeThroughBlock: block,
    completeThroughHash: hash,
  };
}

function header(
  number: number,
  hash: string,
  parentHash: string,
): CanonicalHeader {
  return { number, hash, parentHash };
}

function sourceAt(number: number): DiscoveryBackfillSource {
  return { number, hash: blockHash(number) };
}

function blockHash(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function variantHash(value: number, suffix: number): string {
  return `0x${value.toString(16).padStart(62, "0")}${
    suffix.toString(16).padStart(2, "0")
  }`;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for discovery invariant test");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
