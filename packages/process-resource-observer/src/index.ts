import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { assertExactKeys, assertHash, assertNonEmptyString, decodeCanonicalBytes, deepFreeze, encodeCanonicalBytes, hashDomain } from "../../canonical-codec/src/index.ts";
import {
  hashCpuMemoryEventLoopRoot,
  hashWorkerRestartRoot,
  type CpuMemoryEventLoopSampleV1,
  type WorkerRestartSampleV1,
} from "../../../specs/performance/src/index.ts";
import {
  captureRevmWorkerResourceObservation,
  readRevmWorkerResourceObservation,
  type RevmWorkerResourceObservationFactV1,
  type RevmWorkerResourceObservationPortV1,
} from "../../../runtime/revm-workers/src/internal/resource-observation.ts";
import type {
  ProcessResourceObservationCapabilityV1,
  ProcessResourceObservationClaimCapabilityV1,
  ProcessResourceObservationHandleV1,
  ProcessResourceObservationReaderPortV1,
  ProcessResourceObservationV1,
  ProcessResourceScopeCapabilityV1,
  ProcessResourceScopeReaderPortV1,
} from "./contracts.ts";
import { readProcessResourceScope } from "./internal/scope-owner.ts";

export type {
  ProcessResourceObservationCapabilityV1,
  ProcessResourceObservationClaimCapabilityV1,
  ProcessResourceObservationHandleV1,
  ProcessResourceObservationReaderPortV1,
  ProcessResourceObservationV1,
  ProcessResourceScopeCapabilityV1,
  ProcessResourceScopeFactV1,
  ProcessResourceScopeReaderPortV1,
} from "./contracts.ts";

interface OpenState {
  readonly observer: ProcessResourceObserver;
  readonly scopeCapability: ProcessResourceScopeCapabilityV1;
  readonly scope: ProcessResourceObservationV1["scope"];
  readonly openedMonotonicNs: bigint;
  readonly cpuStart: NodeJS.CpuUsage;
  readonly rssStart: number;
  readonly workerStart: RevmWorkerResourceObservationFactV1;
  readonly eventLoop: IntervalHistogram;
  sealed: boolean;
}

interface CapabilityState {
  readonly observer: ProcessResourceObserver;
  readonly fact: ProcessResourceObservationV1;
  claim: ProcessResourceObservationClaimCapabilityV1 | null;
  consumed: boolean;
}

interface ClaimState {
  readonly capability: ProcessResourceObservationCapabilityV1;
  readonly state: CapabilityState;
  status: "active" | "committed" | "aborted";
}

const handles = new WeakMap<object, OpenState>();
const capabilities = new WeakMap<object, CapabilityState>();
const claims = new WeakMap<object, ClaimState>();
const readers = new WeakMap<object, ProcessResourceObserver>();

function nonNegativeBigInt(value: string, path: string): bigint {
  const decoded = BigInt(value);
  if (decoded < 0n || decoded.toString() !== value) throw new TypeError(`${path} is not a canonical non-negative decimal`);
  return decoded;
}

function nonZeroHash(value: unknown, path: string): string {
  const decoded = assertHash(value, path);
  if (decoded === `0x${"0".repeat(64)}`) throw new TypeError(`${path} must be non-zero`);
  return decoded;
}

function histogramCount(histogram: IntervalHistogram): bigint {
  const value = histogram.count;
  return typeof value === "bigint" ? value : BigInt(value);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new TypeError("resource observation denominator must be positive");
  return (numerator + denominator - 1n) / denominator;
}

function observationPayload(value: ProcessResourceObservationV1): Omit<ProcessResourceObservationV1, "observationId"> {
  const { observationId: _observationId, ...payload } = value;
  return payload;
}

function assertExactObservation(value: ProcessResourceObservationV1): void {
  assertExactKeys(value, [
    "schemaVersion", "kind", "observationId", "observerInstanceId", "sampleSequence", "scope",
    "openedMonotonicNs", "sealedMonotonicNs", "elapsedUs", "availableParallelism",
    "cpuUserStartUs", "cpuSystemStartUs", "cpuUserDeltaUs", "cpuSystemDeltaUs",
    "rssStartBytes", "rssEndBytes", "eventLoopObservationCount", "eventLoopMaxNs",
    "workerStartObservationId", "workerEndObservationId", "workerPoolInstanceId",
    "workerStartSequence", "workerEndSequence", "workerCountStart", "workerCountEnd",
    "workerSpawnedStart", "workerSpawnedEnd", "workerRestartedStart", "workerRestartedEnd",
    "workerReapedStart", "workerReapedEnd", "workerOrphanedStart", "workerOrphanedEnd",
    "workerReapedDelta", "workerStateRootStart", "workerStateRootEnd", "cpuMemoryEventLoop",
    "workerRestart", "cpuMemoryEventLoopRoot", "workerRestartRoot",
  ], "processResourceObservation");
  assertExactKeys(value.scope, ["schemaVersion", "kind", "scopeId", "processLogAnchorHash", "windowId", "generationId", "admissionId", "ordinal"], "processResourceObservation.scope");
  assertExactKeys(value.cpuMemoryEventLoop, ["cpuUtilizationBasisPoints", "rssBytes", "eventLoopLagUs"], "processResourceObservation.cpuMemoryEventLoop");
  assertExactKeys(value.workerRestart, ["workerCount", "restarted", "orphanedWorkers"], "processResourceObservation.workerRestart");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.process-resource-observation") throw new TypeError("process resource observation schema/kind mismatch");
  if (value.scope.schemaVersion !== 1 || value.scope.kind !== "aloha.process-resource-scope") throw new TypeError("process resource scope schema/kind mismatch");
  nonZeroHash(value.observationId, "observationId");
  nonZeroHash(value.observerInstanceId, "observerInstanceId");
  nonNegativeBigInt(value.sampleSequence, "sampleSequence");
  nonZeroHash(value.scope.scopeId, "scope.scopeId");
  nonZeroHash(value.scope.processLogAnchorHash, "scope.processLogAnchorHash");
  nonZeroHash(value.scope.windowId, "scope.windowId");
  assertNonEmptyString(value.scope.generationId, "scope.generationId");
  nonZeroHash(value.scope.admissionId, "scope.admissionId");
  const ordinal = nonNegativeBigInt(value.scope.ordinal, "scope.ordinal");
  if (ordinal < 1n || ordinal > 100n) throw new TypeError("scope.ordinal must be inside 1..100");
  nonZeroHash(value.workerStartObservationId, "workerStartObservationId");
  nonZeroHash(value.workerEndObservationId, "workerEndObservationId");
  nonZeroHash(value.workerPoolInstanceId, "workerPoolInstanceId");
  nonZeroHash(value.workerStateRootStart, "workerStateRootStart");
  nonZeroHash(value.workerStateRootEnd, "workerStateRootEnd");
  nonZeroHash(value.cpuMemoryEventLoopRoot, "cpuMemoryEventLoopRoot");
  nonZeroHash(value.workerRestartRoot, "workerRestartRoot");
  const opened = nonNegativeBigInt(value.openedMonotonicNs, "openedMonotonicNs");
  const sealed = nonNegativeBigInt(value.sealedMonotonicNs, "sealedMonotonicNs");
  if (sealed <= opened || value.elapsedUs !== ((sealed - opened) / 1_000n).toString()) throw new TypeError("process resource elapsed time mismatch");
  const parallelism = nonNegativeBigInt(value.availableParallelism, "availableParallelism");
  if (parallelism <= 0n) throw new TypeError("available parallelism must be positive");
  const cpuTotalUs = nonNegativeBigInt(value.cpuUserDeltaUs, "cpuUserDeltaUs") + nonNegativeBigInt(value.cpuSystemDeltaUs, "cpuSystemDeltaUs");
  const expectedCpu = ceilDiv(cpuTotalUs * 1_000n * 10_000n, (sealed - opened) * parallelism);
  if (value.cpuMemoryEventLoop.cpuUtilizationBasisPoints !== (expectedCpu > 10_000n ? 10_000n : expectedCpu).toString()) throw new TypeError("CPU utilization derivation mismatch");
  const rssStart = nonNegativeBigInt(value.rssStartBytes, "rssStartBytes");
  const rssEnd = nonNegativeBigInt(value.rssEndBytes, "rssEndBytes");
  if (value.cpuMemoryEventLoop.rssBytes !== (rssStart > rssEnd ? rssStart : rssEnd).toString()) throw new TypeError("RSS derivation mismatch");
  const eventLoopCount = nonNegativeBigInt(value.eventLoopObservationCount, "eventLoopObservationCount");
  const eventLoopMaxNs = nonNegativeBigInt(value.eventLoopMaxNs, "eventLoopMaxNs");
  if (eventLoopCount <= 0n || value.cpuMemoryEventLoop.eventLoopLagUs !== ceilDiv(eventLoopMaxNs, 1_000n).toString()) throw new TypeError("event-loop derivation mismatch");
  const workerStartSequence = nonNegativeBigInt(value.workerStartSequence, "workerStartSequence");
  const workerEndSequence = nonNegativeBigInt(value.workerEndSequence, "workerEndSequence");
  if (workerEndSequence <= workerStartSequence) throw new TypeError("worker observation sequence is not increasing");
  nonNegativeBigInt(value.cpuUserStartUs, "cpuUserStartUs");
  nonNegativeBigInt(value.cpuSystemStartUs, "cpuSystemStartUs");
  nonNegativeBigInt(value.workerCountStart, "workerCountStart");
  nonNegativeBigInt(value.workerCountEnd, "workerCountEnd");
  const spawnedStart = nonNegativeBigInt(value.workerSpawnedStart, "workerSpawnedStart");
  const spawnedEnd = nonNegativeBigInt(value.workerSpawnedEnd, "workerSpawnedEnd");
  const restartedStart = nonNegativeBigInt(value.workerRestartedStart, "workerRestartedStart");
  const restartedEnd = nonNegativeBigInt(value.workerRestartedEnd, "workerRestartedEnd");
  const reapedStart = nonNegativeBigInt(value.workerReapedStart, "workerReapedStart");
  const reapedEnd = nonNegativeBigInt(value.workerReapedEnd, "workerReapedEnd");
  const orphanedStart = nonNegativeBigInt(value.workerOrphanedStart, "workerOrphanedStart");
  const orphanedEnd = nonNegativeBigInt(value.workerOrphanedEnd, "workerOrphanedEnd");
  if (spawnedEnd < spawnedStart || restartedEnd < restartedStart || reapedEnd < reapedStart) throw new TypeError("worker cumulative counters regressed");
  if (value.workerRestart.workerCount !== value.workerCountEnd
    || value.workerRestart.restarted !== (restartedEnd - restartedStart).toString()
    || value.workerRestart.orphanedWorkers !== value.workerOrphanedEnd
    || value.workerReapedDelta !== (reapedEnd - reapedStart).toString()) {
    throw new TypeError("worker resource derivation mismatch");
  }
  const { scopeId: _scopeId, ...scopePayload } = value.scope;
  if (value.scope.scopeId !== hashDomain("aloha/process-resource-scope/v1", scopePayload)) throw new TypeError("process resource scope identity mismatch");
  if (value.cpuMemoryEventLoopRoot !== hashCpuMemoryEventLoopRoot(value.cpuMemoryEventLoop)) throw new TypeError("CPU/memory/event-loop root mismatch");
  if (value.workerRestartRoot !== hashWorkerRestartRoot(value.workerRestart)) throw new TypeError("worker restart root mismatch");
  if (value.observationId !== hashDomain("aloha/process-resource-observation/v1", observationPayload(value))) throw new TypeError("process resource observation identity mismatch");
}

/** Pure replay validator; it has no access to process-local issuers. */
export function validateProcessResourceObservationValue(value: unknown): ProcessResourceObservationV1 {
  const decoded = deepFreeze(decodeCanonicalBytes(encodeCanonicalBytes(value))) as unknown as ProcessResourceObservationV1;
  assertExactObservation(decoded);
  return decoded;
}

export interface ProcessResourceObserverOptionsV1 {
  readonly scopeReaderPort: ProcessResourceScopeReaderPortV1;
  readonly workerResourcePort: RevmWorkerResourceObservationPortV1;
}

/**
 * The physical event-loop histogram has not observed a real interval yet.
 * The same owner-issued handle remains active and may be sealed again after
 * yielding the event loop; no observation capability has been issued.
 */
export class ProcessResourceObservationSamplePendingError extends Error {
  constructor() {
    super("process resource observation has no event-loop samples yet");
    this.name = "ProcessResourceObservationSamplePendingError";
  }
}

/**
 * Process-local owner for one-at-a-time head resource samples. Production
 * code receives its reader port, never a raw metrics issuer or DTO ingress.
 */
export class ProcessResourceObserver {
  readonly #scopeReaderPort: ProcessResourceScopeReaderPortV1;
  readonly #workerResourcePort: RevmWorkerResourceObservationPortV1;
  readonly #observerInstanceId: ProcessResourceObservationV1["observerInstanceId"];
  #nextSequence = 0n;
  #active: ProcessResourceObservationHandleV1 | null = null;
  #reader: ProcessResourceObservationReaderPortV1 | null = null;

  constructor(options: ProcessResourceObserverOptionsV1) {
    assertExactKeys(options, ["scopeReaderPort", "workerResourcePort"], "processResourceObserverOptions");
    if (options.scopeReaderPort === null || typeof options.scopeReaderPort !== "object") throw new TypeError("process resource scope reader is required");
    if (options.workerResourcePort === null || typeof options.workerResourcePort !== "object") throw new TypeError("REVM worker resource port is required");
    this.#scopeReaderPort = options.scopeReaderPort;
    this.#workerResourcePort = options.workerResourcePort;
    this.#observerInstanceId = hashDomain("aloha/process-resource-observer-instance/v1", {
      processId: process.pid.toString(),
      createdMonotonicNs: process.hrtime.bigint().toString(),
      nonce: randomUUID(),
    });
  }

  issueReaderPort(): ProcessResourceObservationReaderPortV1 {
    if (this.#reader !== null) throw new TypeError("process resource observation reader is already issued");
    const reader = Object.freeze(Object.create(null)) as ProcessResourceObservationReaderPortV1;
    readers.set(reader, this);
    this.#reader = reader;
    return reader;
  }

  open(scopeCapability: ProcessResourceScopeCapabilityV1): ProcessResourceObservationHandleV1 {
    if (this.#active !== null) throw new TypeError("process resource observation overlaps an active sample");
    const scope = readProcessResourceScope(this.#scopeReaderPort, scopeCapability);
    const eventLoop = monitorEventLoopDelay({ resolution: 1 });
    eventLoop.enable();
    const workerStart = readRevmWorkerResourceObservation(
      this.#workerResourcePort,
      captureRevmWorkerResourceObservation(this.#workerResourcePort),
    );
    const handle = Object.freeze(Object.create(null)) as ProcessResourceObservationHandleV1;
    const state: OpenState = {
      observer: this,
      scopeCapability,
      scope,
      openedMonotonicNs: process.hrtime.bigint(),
      cpuStart: process.cpuUsage(),
      rssStart: process.memoryUsage().rss,
      workerStart,
      eventLoop,
      sealed: false,
    };
    handles.set(handle, state);
    this.#active = handle;
    return handle;
  }

  seal(
    handle: ProcessResourceObservationHandleV1,
    scopeCapability: ProcessResourceScopeCapabilityV1,
  ): ProcessResourceObservationCapabilityV1 {
    if (handle === null || typeof handle !== "object") throw new TypeError("process resource observation handle is invalid");
    const state = handles.get(handle);
    if (state === undefined || state.observer !== this || this.#active !== handle) throw new TypeError("process resource observation handle belongs to another observer");
    if (state.sealed) throw new TypeError("process resource observation handle is already sealed");
    if (state.scopeCapability !== scopeCapability) throw new TypeError("process resource observation scope changed before seal");
    const sealedMonotonicNs = process.hrtime.bigint();
    const cpuDelta = process.cpuUsage(state.cpuStart);
    const rssEnd = process.memoryUsage().rss;
    state.eventLoop.disable();
    const eventLoopObservationCount = histogramCount(state.eventLoop);
    const eventLoopMaxNsNumber = state.eventLoop.max;
    if (sealedMonotonicNs <= state.openedMonotonicNs) throw new TypeError("process resource observation interval is empty");
    if (eventLoopObservationCount <= 0n || !Number.isFinite(eventLoopMaxNsNumber) || eventLoopMaxNsNumber < 0) {
      state.eventLoop.enable();
      throw new ProcessResourceObservationSamplePendingError();
    }
    const workerEnd = readRevmWorkerResourceObservation(
      this.#workerResourcePort,
      captureRevmWorkerResourceObservation(this.#workerResourcePort),
    );
    if (workerEnd.poolInstanceId !== state.workerStart.poolInstanceId) throw new TypeError("REVM worker pool changed during resource observation");
    const workerRestartDelta = nonNegativeBigInt(workerEnd.restarted, "workerEnd.restarted") - nonNegativeBigInt(state.workerStart.restarted, "workerStart.restarted");
    const workerReapedDelta = nonNegativeBigInt(workerEnd.reaped, "workerEnd.reaped") - nonNegativeBigInt(state.workerStart.reaped, "workerStart.reaped");
    if (workerRestartDelta < 0n || workerReapedDelta < 0n) throw new TypeError("REVM worker counters regressed during resource observation");
    const elapsedNs = sealedMonotonicNs - state.openedMonotonicNs;
    const parallelism = availableParallelism();
    if (!Number.isSafeInteger(parallelism) || parallelism <= 0) throw new TypeError("available parallelism is invalid");
    const cpuTotalUs = BigInt(cpuDelta.user) + BigInt(cpuDelta.system);
    const cpuBasisPoints = ceilDiv(cpuTotalUs * 1_000n * 10_000n, elapsedNs * BigInt(parallelism));
    const eventLoopMaxNs = BigInt(Math.ceil(eventLoopMaxNsNumber));
    const cpuMemoryEventLoop: CpuMemoryEventLoopSampleV1 = Object.freeze({
      cpuUtilizationBasisPoints: (cpuBasisPoints > 10_000n ? 10_000n : cpuBasisPoints).toString(),
      rssBytes: BigInt(Math.max(state.rssStart, rssEnd)).toString(),
      eventLoopLagUs: ceilDiv(eventLoopMaxNs, 1_000n).toString(),
    });
    const workerRestart: WorkerRestartSampleV1 = Object.freeze({
      workerCount: workerEnd.workerCount,
      restarted: workerRestartDelta.toString(),
      // Gauge of workers that still occupy pool capacity at the end of this
      // exact interval. Historical incidents remain in reaped/restarted.
      orphanedWorkers: workerEnd.orphanedWorkers,
    });
    const body = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.process-resource-observation" as const,
      observerInstanceId: this.#observerInstanceId,
      sampleSequence: this.#nextSequence.toString(),
      scope: state.scope,
      openedMonotonicNs: state.openedMonotonicNs.toString(),
      sealedMonotonicNs: sealedMonotonicNs.toString(),
      elapsedUs: (elapsedNs / 1_000n).toString(),
      availableParallelism: parallelism.toString(),
      cpuUserStartUs: state.cpuStart.user.toString(),
      cpuSystemStartUs: state.cpuStart.system.toString(),
      cpuUserDeltaUs: cpuDelta.user.toString(),
      cpuSystemDeltaUs: cpuDelta.system.toString(),
      rssStartBytes: state.rssStart.toString(),
      rssEndBytes: rssEnd.toString(),
      eventLoopObservationCount: eventLoopObservationCount.toString(),
      eventLoopMaxNs: eventLoopMaxNs.toString(),
      workerStartObservationId: state.workerStart.observationId,
      workerEndObservationId: workerEnd.observationId,
      workerPoolInstanceId: workerEnd.poolInstanceId,
      workerStartSequence: state.workerStart.sequence,
      workerEndSequence: workerEnd.sequence,
      workerCountStart: state.workerStart.workerCount,
      workerCountEnd: workerEnd.workerCount,
      workerSpawnedStart: state.workerStart.spawned,
      workerSpawnedEnd: workerEnd.spawned,
      workerRestartedStart: state.workerStart.restarted,
      workerRestartedEnd: workerEnd.restarted,
      workerReapedStart: state.workerStart.reaped,
      workerReapedEnd: workerEnd.reaped,
      workerOrphanedStart: state.workerStart.orphanedWorkers,
      workerOrphanedEnd: workerEnd.orphanedWorkers,
      workerReapedDelta: workerReapedDelta.toString(),
      workerStateRootStart: state.workerStart.workerStateRoot,
      workerStateRootEnd: workerEnd.workerStateRoot,
      cpuMemoryEventLoop,
      workerRestart,
      cpuMemoryEventLoopRoot: hashCpuMemoryEventLoopRoot(cpuMemoryEventLoop),
      workerRestartRoot: hashWorkerRestartRoot(workerRestart),
    });
    const fact = Object.freeze({ ...body, observationId: hashDomain("aloha/process-resource-observation/v1", body) });
    assertExactObservation(fact);
    state.sealed = true;
    this.#active = null;
    const capability = Object.freeze(Object.create(null)) as ProcessResourceObservationCapabilityV1;
    capabilities.set(capability, { observer: this, fact, claim: null, consumed: false });
    this.#nextSequence += 1n;
    return capability;
  }
}

export function readProcessResourceObservation(
  readerPort: ProcessResourceObservationReaderPortV1,
  capability: ProcessResourceObservationCapabilityV1,
): ProcessResourceObservationV1 {
  const claim = claimProcessResourceObservation(readerPort, capability);
  const fact = readClaimedProcessResourceObservation(readerPort, claim);
  commitProcessResourceObservationClaim(readerPort, claim);
  return fact;
}

function capabilityState(
  readerPort: ProcessResourceObservationReaderPortV1,
  capability: ProcessResourceObservationCapabilityV1,
): CapabilityState {
  if (readerPort === null || typeof readerPort !== "object") throw new TypeError("process resource observation reader is invalid");
  const observer = readers.get(readerPort);
  if (observer === undefined) throw new TypeError("process resource observation reader is not owner-issued");
  if (capability === null || typeof capability !== "object") throw new TypeError("process resource observation capability is invalid");
  const state = capabilities.get(capability);
  if (state === undefined) throw new TypeError("process resource observation capability is not owner-issued");
  if (state.observer !== observer) throw new TypeError("process resource observation capability belongs to another observer");
  if (state.consumed) throw new TypeError("process resource observation capability is already consumed");
  return state;
}

/**
 * Reserve one observation for a durable writer without consuming it.  The
 * same capability becomes claimable again after abort and is consumed only
 * after an explicit commit.
 */
export function claimProcessResourceObservation(
  readerPort: ProcessResourceObservationReaderPortV1,
  capability: ProcessResourceObservationCapabilityV1,
): ProcessResourceObservationClaimCapabilityV1 {
  const state = capabilityState(readerPort, capability);
  if (state.claim !== null) throw new TypeError("process resource observation capability is already claimed");
  const claim = Object.freeze(Object.create(null)) as ProcessResourceObservationClaimCapabilityV1;
  state.claim = claim;
  claims.set(claim, { capability, state, status: "active" });
  return claim;
}

function activeClaim(
  readerPort: ProcessResourceObservationReaderPortV1,
  claim: ProcessResourceObservationClaimCapabilityV1,
): ClaimState {
  if (claim === null || typeof claim !== "object") throw new TypeError("process resource observation claim is invalid");
  const claimState = claims.get(claim);
  if (claimState === undefined) throw new TypeError("process resource observation claim is not owner-issued");
  const state = capabilityState(readerPort, claimState.capability);
  if (state !== claimState.state || state.claim !== claim || claimState.status !== "active") {
    throw new TypeError("process resource observation claim is not active");
  }
  return claimState;
}

export function readClaimedProcessResourceObservation(
  readerPort: ProcessResourceObservationReaderPortV1,
  claim: ProcessResourceObservationClaimCapabilityV1,
): ProcessResourceObservationV1 {
  const state = activeClaim(readerPort, claim).state;
  assertExactObservation(state.fact);
  return state.fact;
}

export function commitProcessResourceObservationClaim(
  readerPort: ProcessResourceObservationReaderPortV1,
  claim: ProcessResourceObservationClaimCapabilityV1,
): void {
  const claimState = activeClaim(readerPort, claim);
  claimState.status = "committed";
  claimState.state.consumed = true;
  claimState.state.claim = null;
}

export function abortProcessResourceObservationClaim(
  readerPort: ProcessResourceObservationReaderPortV1,
  claim: ProcessResourceObservationClaimCapabilityV1,
): void {
  const claimState = activeClaim(readerPort, claim);
  claimState.status = "aborted";
  claimState.state.claim = null;
}
