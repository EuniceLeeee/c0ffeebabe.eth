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
  describeLiveDiscoveryPublicationState,
  type DiscoveryCoverageAnchor,
  type LiveDiscoveryPublicationState,
} from "../live-discovery-publication.js";
import {
  createProtocolDiscoveryEvidenceCache,
} from "../protocol-discovery-cache.js";
import { ProtocolDiscoveryMutationQueue } from
  "../protocol-discovery-coordinator.js";

const OBSERVED = "protocol:fixture\u001fobserved-interaction";
const ADDRESS = "protocol:fixture\u001fdex-token-domain";

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

console.log(
  "[discovery-publication-invariants] cursor/CAS/reorg/hot/queue: PASS (5/5)",
);

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
