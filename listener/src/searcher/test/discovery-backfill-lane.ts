import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DEFAULT_DISCOVERY_BACKFILL_CHUNK_BLOCKS,
  DiscoveryBackfillLane,
  resolveDiscoveryBackfillChunkBlocks,
  type DiscoveryBackfillCanonicalProof,
  type DiscoveryBackfillPlan,
  type DiscoveryBackfillRequest,
  type DiscoveryBackfillStateDescriptor,
  type DiscoveryBackfillSource,
} from "../discovery-backfill-lane.js";
import { ProtocolDiscoveryMutationQueue } from "../protocol-discovery-coordinator.js";

const OBSERVED = "family-a\u001fobserved-interaction";
const ADDRESS = "family-a\u001fdex-token-domain";

interface LiveDiscoveryState {
  revision: number;
  graph: string[];
  evidenceVersion: number;
  dex: {
    sourceCompleteThrough: number;
    graphCompleteThrough: number;
  };
  protocol: Record<string, number>;
}

interface RawBackfill {
  readonly scannedThrough: number;
  readonly source: DiscoveryBackfillSource;
  readonly retryableDex: boolean;
  readonly protocolComplete: Readonly<Record<string, boolean>>;
  readonly edge: string;
}

chunkSizingSeparatesRetentionFromWorkUnits();
await preparationDoesNotHoldMutationQueue();
await boundedChunksAdvanceContiguously();
await exactCoverageTransitionCannotJumpHoles();
await baseAndReadyMutationFailClosed();
await laneAwareRebasePreservesIndependentState();
await deadlineCancelsEveryBudgetedRead();
await futureReadyWaitsForNewestHead();
await producerYieldDelaysScanUntilProducerIdle();
await producerYieldPerReadDelaysWorkWhileProducerCritical();
await producerYieldDefersScanWhenProducerStaysCritical();

console.log("[discovery-backfill-lane] bounded background publication: PASS (11/11)");

function chunkSizingSeparatesRetentionFromWorkUnits(): void {
  assert.equal(
    resolveDiscoveryBackfillChunkBlocks(20_000, undefined),
    DEFAULT_DISCOVERY_BACKFILL_CHUNK_BLOCKS,
  );
  assert.equal(resolveDiscoveryBackfillChunkBlocks(4, undefined), 4);
  assert.equal(
    resolveDiscoveryBackfillChunkBlocks(20_000, "1024"),
    1_024,
  );
}

async function boundedChunksAdvanceContiguously(): Promise<void> {
  let liveState = stateAt(100, 1);
  for (const request of [
    requestFor(101, 105, 110),
    requestFor(106, 110, 110),
  ]) {
    const lane = createLane(async () => rawFor(request));
    lane.schedule(request, liveState);
    await lane.settled();
    const taken = lane.takeForHotHead({
      targetSource: source(110),
      currentState: liveState,
      canonicalPreparedSource: proof(110, 1),
      currentCanonicalRevision: 1,
    });
    assert.notEqual(taken.status, "degraded");
    if (taken.status === "degraded") throw new Error("chunk was not published");
    liveState = taken.state;
  }
  assert.equal(liveState.dex.sourceCompleteThrough, 110);
  assert.equal(liveState.dex.graphCompleteThrough, 110);
  assert.equal(liveState.protocol[OBSERVED], 110);
  assert.equal(liveState.protocol[ADDRESS], 110);
}

async function preparationDoesNotHoldMutationQueue(): Promise<void> {
  const gate = deferred<RawBackfill>();
  const started = deferred<void>();
  const lane = createLane(async () => {
    started.resolve();
    return gate.promise;
  });
  const base = stateAt(100, 7);
  const request = requestFor(101, 105, 105);
  assert.deepEqual(lane.schedule(request, base), {
    scheduled: true,
    jobId: 1,
  });
  await started.promise;

  const queue = new ProtocolDiscoveryMutationQueue();
  let observedCommitted = false;
  await queue.enqueue("observed", async () => {
    observedCommitted = true;
  });
  assert.equal(
    observedCommitted,
    true,
    "real mutation queue must remain available while preparation is pending",
  );
  assert.equal(
    reasonOf(lane.takeForHotHead({
      targetSource: source(105),
      currentState: base,
      canonicalPreparedSource: proof(105, 3),
      currentCanonicalRevision: 3,
    })),
    "preparing",
  );

  gate.resolve(rawFor(request));
  await waitFor(() => lane.readyDescriptor() !== null);
  let liveState = base;
  const result = await queue.enqueue("dex-refresh", async () => {
    const taken = lane.takeForHotHead({
      targetSource: source(110),
      currentState: liveState,
      canonicalPreparedSource: proof(105, 3),
      currentCanonicalRevision: 3,
    });
    if (taken.status !== "degraded") liveState = taken.state;
    return taken;
  });
  assert.equal(result.status, "ready_degraded");
  assert.equal(liveState.dex.sourceCompleteThrough, 105);
  assert.equal(liveState.dex.graphCompleteThrough, 105);
  assert.equal(liveState.protocol[OBSERVED], 105);
  assert.equal(liveState.protocol[ADDRESS], 105);
  assert.equal(describe(liveState).graphCompleteThrough, 105);
  assert.deepEqual(lane.telemetry(), {
    scheduled: 1,
    prepared: 1,
    taken: 1,
    deferred: 0,
    rejectedBusy: 0,
    rejectedReady: 0,
    failed: 0,
    timedOut: 0,
    stale: 0,
    invalidated: 0,
    activeJobId: null,
    readyJobId: null,
    activeReads: 0,
    peakReads: 0,
    lastFailure: null,
  });
}

async function exactCoverageTransitionCannotJumpHoles(): Promise<void> {
  const base = stateAt(100, 1);
  const gapRequest = requestFor(104, 105, 110);
  const gapLane = createLane(async () => rawFor(gapRequest));
  gapLane.schedule(gapRequest, base);
  await waitFor(() => gapLane.telemetry().failed === 1);
  const gap = gapLane.takeForHotHead({
    targetSource: source(110),
    currentState: base,
    canonicalPreparedSource: proof(110, 1),
    currentCanonicalRevision: 1,
  });
  assert.equal(reasonOf(gap), "preparation_failed");
  assert.match(gap.status === "degraded" ? gap.error ?? "" : "", /non-contiguous/);

  const request = requestFor(101, 105, 105);
  const familyGapLane = createLane(async () => rawFor(request, {
    protocolComplete: { [OBSERVED]: true, [ADDRESS]: false },
  }));
  familyGapLane.schedule(request, base);
  await waitFor(() => familyGapLane.readyDescriptor() !== null);
  const familyGap = familyGapLane.takeForHotHead({
    targetSource: source(105),
    currentState: base,
    canonicalPreparedSource: proof(105, 2),
    currentCanonicalRevision: 2,
  });
  assert.equal(familyGap.status, "ready_degraded");
  if (familyGap.status !== "ready_degraded") throw new Error("expected family gap");
  assert.equal(familyGap.state.protocol[OBSERVED], 105);
  assert.equal(familyGap.state.protocol[ADDRESS], 100);
  assert.equal(familyGap.graphCompleteThrough, 100);

  const retryLane = createLane(async () => rawFor(request, {
    retryableDex: true,
  }));
  retryLane.schedule(request, base);
  await waitFor(() => retryLane.readyDescriptor() !== null);
  const retry = retryLane.takeForHotHead({
    targetSource: source(105),
    currentState: base,
    canonicalPreparedSource: proof(105, 2),
    currentCanonicalRevision: 2,
  });
  assert.equal(retry.status, "ready_degraded");
  if (retry.status !== "ready_degraded") throw new Error("expected a ready state");
  assert.equal(retry.state.dex.sourceCompleteThrough, 105);
  assert.equal(retry.state.dex.graphCompleteThrough, 100);
  assert.equal(retry.graphCompleteThrough, 100);
}

async function futureReadyWaitsForNewestHead(): Promise<void> {
  const base = stateAt(100, 1);
  const request = requestFor(101, 105, 105);
  const lane = createLane(async () => rawFor(request));
  lane.schedule(request, base);
  await lane.settled();

  const oldHead = lane.takeForHotHead({
    targetSource: source(104),
    currentState: base,
    canonicalPreparedSource: proof(105, 4),
    currentCanonicalRevision: 4,
  });
  assert.equal(reasonOf(oldHead), "projection_from_future");
  assert.equal(
    lane.readyDescriptor()?.source.number,
    105,
    "an older coalesced head must not destroy the newer prepared generation",
  );

  const newestHead = lane.takeForHotHead({
    targetSource: source(105),
    currentState: base,
    canonicalPreparedSource: proof(105, 4),
    currentCanonicalRevision: 4,
  });
  assert.equal(newestHead.status, "ready");
  assert.equal(lane.readyDescriptor(), null);
}

async function baseAndReadyMutationFailClosed(): Promise<void> {
  const request = requestFor(101, 101, 101);
  const baseGate = deferred<RawBackfill>();
  const mutableBase = stateAt(100, 4);
  const baseLane = createLane(async () => baseGate.promise);
  baseLane.schedule(request, mutableBase);
  mutableBase.graph.push("queue-outside-mutation");
  baseGate.resolve(rawFor(request));
  await waitFor(() => baseLane.telemetry().failed === 1);
  assert.match(baseLane.telemetry().lastFailure ?? "", /base snapshot mutated/);

  let preparedState: LiveDiscoveryState | null = null;
  const readyLane = createLane(
    async () => rawFor(request),
    (plan, raw) => {
      const validated = validateTransition(plan, raw);
      preparedState = validated.state;
      return validated;
    },
  );
  const cleanBase = stateAt(100, 4);
  readyLane.schedule(request, cleanBase);
  await waitFor(() => readyLane.readyDescriptor() !== null);
  const stateToMutate = preparedState as LiveDiscoveryState | null;
  assert(stateToMutate);
  stateToMutate.graph.push("late-projection-mutation");
  assert.equal(
    reasonOf(readyLane.takeForHotHead({
      targetSource: source(101),
      currentState: cleanBase,
      canonicalPreparedSource: proof(101, 9),
      currentCanonicalRevision: 9,
    })),
    "prepared_state_mutated",
  );

  const staleLane = createLane(async () => rawFor(request));
  staleLane.schedule(request, cleanBase);
  await waitFor(() => staleLane.readyDescriptor() !== null);
  const changedBase = cloneState(cleanBase);
  changedBase.revision++;
  changedBase.evidenceVersion++;
  assert.equal(
    reasonOf(staleLane.takeForHotHead({
      targetSource: source(101),
      currentState: changedBase,
      canonicalPreparedSource: proof(101, 9),
      currentCanonicalRevision: 9,
    })),
    "stale_base",
  );

  const reorgLane = createLane(async () => rawFor(request));
  reorgLane.schedule(request, cleanBase);
  await waitFor(() => reorgLane.readyDescriptor() !== null);
  assert.equal(
    reasonOf(reorgLane.takeForHotHead({
      targetSource: { number: 101, hash: hash(999) },
      currentState: cleanBase,
      canonicalPreparedSource: proof(101, 9),
      currentCanonicalRevision: 9,
    })),
    "non_canonical_source",
  );

  const journalRaceLane = createLane(async () => rawFor(request));
  journalRaceLane.schedule(request, cleanBase);
  await waitFor(() => journalRaceLane.readyDescriptor() !== null);
  assert.equal(
    reasonOf(journalRaceLane.takeForHotHead({
      targetSource: source(102),
      currentState: cleanBase,
      canonicalPreparedSource: proof(101, 9),
      currentCanonicalRevision: 10,
    })),
    "non_canonical_source",
  );
}

async function laneAwareRebasePreservesIndependentState(): Promise<void> {
  const request = requestFor(101, 101, 101);
  const base = stateAt(100, 4);
  const lane = new DiscoveryBackfillLane<LiveDiscoveryState, RawBackfill>({
    maxBlocksPerJob: 25,
    maxPreparationMs: 5_000,
    maxConcurrency: 2,
    describeState: describe,
    prepare: async () => rawFor(request, {
      protocolComplete: {
        [OBSERVED]: false,
        [ADDRESS]: false,
      },
    }),
    validateTransition,
    rebaseTransition: (plan, raw, current) => {
      if (current.graph.join(",") !== plan.baseState.graph.join(",")) {
        return null;
      }
      const next = cloneState(current);
      next.revision++;
      next.graph.push(raw.edge);
      next.dex.sourceCompleteThrough = raw.scannedThrough;
      if (!raw.retryableDex) {
        next.dex.graphCompleteThrough = raw.scannedThrough;
      }
      return { state: next, source: raw.source };
    },
  });
  lane.schedule(request, base);
  await waitFor(() => lane.readyDescriptor() !== null);

  const protocolOnly = cloneState(base);
  protocolOnly.revision++;
  protocolOnly.evidenceVersion++;
  protocolOnly.protocol[OBSERVED] = 101;
  const rebased = lane.takeForHotHead({
    targetSource: source(101),
    currentState: protocolOnly,
    canonicalPreparedSource: proof(101, 11),
    currentCanonicalRevision: 11,
  });
  assert.notEqual(rebased.status, "degraded");
  if (rebased.status === "degraded") throw new Error("expected rebased state");
  assert.equal(rebased.state.revision, protocolOnly.revision + 1);
  assert.equal(rebased.state.evidenceVersion, protocolOnly.evidenceVersion);
  assert.equal(rebased.state.protocol[OBSERVED], 101);
  assert.equal(rebased.state.dex.graphCompleteThrough, 101);
  assert(rebased.state.graph.includes("edge-101"));

  const conflictLane = new DiscoveryBackfillLane<
    LiveDiscoveryState,
    RawBackfill
  >({
    maxBlocksPerJob: 25,
    maxPreparationMs: 5_000,
    maxConcurrency: 2,
    describeState: describe,
    prepare: async () => rawFor(request),
    validateTransition,
    rebaseTransition: (plan, raw, current) => {
      if (current.graph.join(",") !== plan.baseState.graph.join(",")) {
        return null;
      }
      return validateTransition(
        { ...plan, baseState: current },
        raw,
      );
    },
  });
  conflictLane.schedule(request, base);
  await waitFor(() => conflictLane.readyDescriptor() !== null);
  const dexConflict = cloneState(base);
  dexConflict.revision++;
  dexConflict.graph.push("concurrent-dex-edge");
  assert.equal(
    reasonOf(conflictLane.takeForHotHead({
      targetSource: source(101),
      currentState: dexConflict,
      canonicalPreparedSource: proof(101, 12),
      currentCanonicalRevision: 12,
    })),
    "stale_base",
  );
}

async function producerYieldDelaysScanUntilProducerIdle(): Promise<void> {
  const request = requestFor(101, 101, 101);
  const base = stateAt(100, 4);
  let started = false;
  let producerActive = true;
  const lane = new DiscoveryBackfillLane<LiveDiscoveryState, RawBackfill>({
    maxBlocksPerJob: 25,
    maxPreparationMs: 5_000,
    maxConcurrency: 2,
    describeState: describe,
    prepare: async () => {
      started = true;
      return rawFor(request);
    },
    validateTransition,
    producerYield: { active: () => producerActive, maxWaitMs: 2_000 },
  });
  lane.schedule(request, base);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(
    started,
    false,
    "a scheduled backfill scan must not start while the producer is critical",
  );
  producerActive = false;
  await waitFor(() => started === true);
  await waitFor(() => lane.readyDescriptor() !== null);
  assert.equal(lane.telemetry().scheduled, 1);

  // The runtime-loop setter can attach the hook after construction.
  let startedSecond = false;
  let producerActiveSecond = true;
  const secondLane = createLane(async () => {
    startedSecond = true;
    return rawFor(request);
  });
  secondLane.setProducerYield({
    active: () => producerActiveSecond,
    maxWaitMs: 2_000,
  });
  secondLane.schedule(request, base);
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal(startedSecond, false);
  secondLane.setProducerYield(null);
  producerActiveSecond = false;
  await waitFor(() => secondLane.readyDescriptor() !== null);
}

async function producerYieldPerReadDelaysWorkWhileProducerCritical(): Promise<void> {
  const request = requestFor(101, 101, 101);
  const base = stateAt(100, 4);
  let workRan = false;
  let producerActive = true;
  const lane = new DiscoveryBackfillLane<LiveDiscoveryState, RawBackfill>({
    maxBlocksPerJob: 25,
    maxPreparationMs: 5_000,
    maxConcurrency: 2,
    describeState: describe,
    prepare: async (_plan, control) => {
      await control.run(async () => {
        workRan = true;
        return "ok";
      });
      return rawFor(request);
    },
    validateTransition,
    producerYield: {
      active: () => producerActive,
      maxWaitMs: 0,
      perReadMaxWaitMs: 150,
    },
  });
  lane.schedule(request, base);
  await waitFor(() => lane.telemetry().deferred === 1);
  assert.equal(
    workRan,
    false,
    "per-read yield must defer the whole job while the producer is critical",
  );
  assert.equal(lane.telemetry().failed, 0, "per-read deferral is not a failure");
  producerActive = false;
  lane.schedule(request, base);
  await waitFor(() => workRan === true);
  await waitFor(() => lane.readyDescriptor() !== null);
  assert.equal(lane.telemetry().deferred, 1);
}

async function producerYieldDefersScanWhenProducerStaysCritical(): Promise<void> {
  const request = requestFor(101, 101, 101);
  const base = stateAt(100, 4);
  let started = false;
  let producerActive = true;
  const lane = new DiscoveryBackfillLane<LiveDiscoveryState, RawBackfill>({
    maxBlocksPerJob: 25,
    maxPreparationMs: 5_000,
    maxConcurrency: 2,
    describeState: describe,
    prepare: async () => {
      started = true;
      return rawFor(request);
    },
    validateTransition,
    producerYield: { active: () => producerActive, maxWaitMs: 150 },
  });
  lane.schedule(request, base);
  await waitFor(() => lane.telemetry().deferred === 1);
  assert.equal(
    started,
    false,
    "a backfill scan must not start after the producer-yield cap; it is deferred",
  );
  assert.equal(lane.telemetry().failed, 0, "deferral is not a failure");
  assert.equal(lane.telemetry().activeJobId, null, "deferred job releases the worker");

  producerActive = false;
  lane.schedule(request, base);
  await waitFor(() => started === true);
  await waitFor(() => lane.readyDescriptor() !== null);
  assert.equal(lane.telemetry().deferred, 1);
  assert.equal(lane.telemetry().prepared, 1);
  assert.equal(lane.telemetry().failed, 0);
}

async function deadlineCancelsEveryBudgetedRead(): Promise<void> {
  let externalActive = 0;
  let externalPeak = 0;
  const lane = new DiscoveryBackfillLane<LiveDiscoveryState, never>({
    maxBlocksPerJob: 1,
    maxPreparationMs: 15,
    maxConcurrency: 2,
    describeState: describe,
    prepare: async (_plan, control) => {
      await Promise.all(Array.from({ length: 8 }, () =>
        control.run((signal) => new Promise<never>((_resolve, reject) => {
          externalActive++;
          externalPeak = Math.max(externalPeak, externalActive);
          const abort = () => {
            externalActive--;
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
        }))));
      throw new Error("unreachable");
    },
    validateTransition: () => {
      throw new Error("timed-out preparation cannot validate");
    },
  });
  const base = stateAt(10, 1);
  const request = requestFor(11, 11, 11);
  lane.schedule(request, base);
  await waitFor(() => lane.telemetry().activeReads === 2);
  assert.deepEqual(lane.schedule(request, base), {
    scheduled: false,
    reason: "preparing",
    jobId: 1,
  });
  await waitFor(() => lane.telemetry().failed === 1);
  assert.equal(externalPeak, 2);
  assert.equal(externalActive, 0);
  assert.equal(lane.telemetry().activeReads, 0);
  assert.equal(lane.telemetry().peakReads, 2);
  assert.equal(lane.telemetry().timedOut, 1);
  assert.equal(
    reasonOf(lane.takeForHotHead({
      targetSource: source(11),
      currentState: base,
      canonicalPreparedSource: proof(11, 1),
      currentCanonicalRevision: 1,
    })),
    "preparation_timeout",
  );
}

function createLane(
  prepare: (
    plan: DiscoveryBackfillPlan<LiveDiscoveryState>,
  ) => Promise<RawBackfill>,
  validate = validateTransition,
): DiscoveryBackfillLane<LiveDiscoveryState, RawBackfill> {
  return new DiscoveryBackfillLane({
    maxBlocksPerJob: 25,
    maxPreparationMs: 5_000,
    maxConcurrency: 2,
    describeState: describe,
    prepare,
    validateTransition: validate,
  });
}

function validateTransition(
  plan: DiscoveryBackfillPlan<LiveDiscoveryState>,
  raw: RawBackfill,
): { state: LiveDiscoveryState; source: DiscoveryBackfillSource } {
  const base = plan.baseState;
  if (plan.range.fromBlock !== base.dex.sourceCompleteThrough + 1) {
    throw new Error(
      `non-contiguous DEX range ${plan.range.fromBlock}; expected ` +
        `${base.dex.sourceCompleteThrough + 1}`,
    );
  }
  if (raw.scannedThrough !== plan.range.toBlock) {
    throw new Error("raw scanner range does not match the planned range");
  }
  const next = cloneState(base);
  next.revision++;
  next.graph.push(raw.edge);
  next.dex.sourceCompleteThrough = raw.scannedThrough;
  if (!raw.retryableDex) {
    next.dex.graphCompleteThrough = raw.scannedThrough;
  }
  for (const key of Object.keys(next.protocol)) {
    if (raw.protocolComplete[key] !== true) continue;
    next.protocol[key] = key.endsWith("dex-token-domain")
      ? plan.source.number
      : raw.scannedThrough;
  }
  return { state: next, source: raw.source };
}

function describe(
  state: LiveDiscoveryState,
): DiscoveryBackfillStateDescriptor {
  const protocol = Object.entries(state.protocol).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  const coverage = {
    dex: state.dex,
    protocol,
  };
  return {
    revision: state.revision,
    baseFingerprint: digest({
      graph: state.graph,
      evidenceVersion: state.evidenceVersion,
      coverage,
    }),
    coverageFingerprint: digest(coverage),
    graphCompleteThrough: Math.min(
      state.dex.graphCompleteThrough,
      ...protocol.map(([, through]) => through),
    ),
  };
}

function stateAt(blockNumber: number, revision: number): LiveDiscoveryState {
  return {
    revision,
    graph: ["base-edge"],
    evidenceVersion: 1,
    dex: {
      sourceCompleteThrough: blockNumber,
      graphCompleteThrough: blockNumber,
    },
    protocol: {
      [OBSERVED]: blockNumber,
      [ADDRESS]: blockNumber,
    },
  };
}

function cloneState(state: LiveDiscoveryState): LiveDiscoveryState {
  return {
    revision: state.revision,
    graph: [...state.graph],
    evidenceVersion: state.evidenceVersion,
    dex: { ...state.dex },
    protocol: { ...state.protocol },
  };
}

function requestFor(
  fromBlock: number,
  toBlock: number,
  sourceBlock: number,
): DiscoveryBackfillRequest {
  return {
    id: `combined:${fromBlock}-${toBlock}@${sourceBlock}`,
    range: { fromBlock, toBlock },
    source: source(sourceBlock),
  };
}

function rawFor(
  request: DiscoveryBackfillRequest,
  overrides: Partial<RawBackfill> = {},
): RawBackfill {
  return {
    scannedThrough: overrides.scannedThrough ?? request.range.toBlock,
    source: overrides.source ?? request.source,
    retryableDex: overrides.retryableDex ?? false,
    protocolComplete: overrides.protocolComplete ?? {
      [OBSERVED]: true,
      [ADDRESS]: true,
    },
    edge: overrides.edge ?? `edge-${request.range.toBlock}`,
  };
}

function proof(
  blockNumber: number,
  revision: number,
): DiscoveryBackfillCanonicalProof {
  return { revision, source: source(blockNumber) };
}

function source(number: number): DiscoveryBackfillSource {
  return { number, hash: hash(number) };
}

function hash(number: number): string {
  return `0x${number.toString(16).padStart(64, "0")}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function reasonOf<State>(
  result: ReturnType<DiscoveryBackfillLane<State, unknown>["takeForHotHead"]>,
): string {
  if (result.status === "ready") {
    throw new Error("expected a degraded discovery result");
  }
  return result.reason;
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 1_000; attempts++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("discovery backfill test condition did not settle");
}
