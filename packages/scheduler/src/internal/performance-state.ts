import { randomUUID } from "node:crypto";
import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalBytes,
  deepFreeze,
  encodeCanonicalBytes,
  hashDomain,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import type {
  SchedulerPermitAccountingFactV1,
  SchedulerQueueTelemetryFactV1,
  SchedulerResourceSampleFactV1,
  SchedulerWorkCompletionCapabilityV1,
  SchedulerWorkCompletionFactV1,
  SchedulerWorkCompletionFactDraftV1,
  SchedulerWorkCompletionHandleV1,
  SchedulerPerformanceRuntimeBindingV1,
  SchedulerPerformanceCursorCapabilityV1,
  SchedulerPerformanceRangeCapabilityV1,
  SchedulerPerformanceRangeFactV1,
  SchedulerSnapshot,
  SchedulerWorkDescriptor,
  WorkScheduler,
} from "../index.ts";

interface LaneTelemetryStateV1 {
  readonly lane: string;
  readonly resource: string;
  current: bigint;
  max: bigint;
  currentOldestAgeUs: bigint;
  maxOldestAgeUs: bigint;
  accepted: bigint;
  rejected: bigint;
  cancelled: bigint;
}

interface PermitTelemetryStateV1 {
  readonly ownerRef: string;
  readonly lane: string;
  readonly resource: string;
  issued: bigint;
  released: bigint;
}

interface ResourceTelemetryStateV1 {
  readonly resource: string;
  current: bigint;
  capacity: bigint;
  max: bigint;
}

interface SchedulerPerformanceJournalV1 {
  nextSequence: bigint;
  baseSequence: bigint;
  attemptedWorkCount: bigint;
  baseAttemptedWorkCount: bigint;
  baseOpenedAtMonotonicNs: bigint;
  baseSnapshot: SchedulerSnapshot;
  binding: SchedulerPerformanceRuntimeBindingV1 | null;
  readonly capabilities: SchedulerWorkCompletionCapabilityV1[];
  readonly lanes: Map<string, LaneTelemetryStateV1>;
  readonly permits: Map<string, PermitTelemetryStateV1>;
  readonly resources: Map<string, ResourceTelemetryStateV1>;
  openCursor: SchedulerPerformanceCursorCapabilityV1 | null;
  unacknowledgedRange: SchedulerPerformanceRangeCapabilityV1 | null;
}

const journals = new WeakMap<object, SchedulerPerformanceJournalV1>();
const facts = new WeakMap<object, Readonly<{
  scheduler: WorkScheduler;
  fact: SchedulerWorkCompletionFactV1;
}>>();
const readerStates = new WeakMap<object, WorkScheduler>();
const completionHandles = new WeakMap<object, {
  readonly scheduler: WorkScheduler;
  settled: boolean;
  capability: SchedulerWorkCompletionCapabilityV1 | null;
  error: unknown;
}>();
const cursorStates = new WeakMap<object, Readonly<{
  scheduler: WorkScheduler;
  startSequence: bigint;
  attemptedWorkStart: bigint;
  openedAtMonotonicNs: bigint;
  startSnapshot: SchedulerSnapshot;
}>>();
const rangeStates = new WeakMap<object, {
  readonly scheduler: WorkScheduler;
  readonly fact: SchedulerPerformanceRangeFactV1;
  readonly capabilities: readonly SchedulerWorkCompletionCapabilityV1[];
  acknowledged: boolean;
}>();

const MAX_UNACKNOWLEDGED_COMPLETIONS = 100_000;
const COMPLETION_OUTCOMES = new Set([
  "completed",
  "execution-failed",
  "aborted",
  "deadline",
  "queue-full",
  "resource-limit",
  "invalid-program",
]);

function telemetryKey(...parts: readonly string[]): string {
  return parts.join("\u0000");
}

function laneTelemetry(
  journal: SchedulerPerformanceJournalV1,
  lane: string,
  resource: string,
): LaneTelemetryStateV1 {
  const key = telemetryKey(lane, resource);
  const existing = journal.lanes.get(key);
  if (existing !== undefined) return existing;
  const state: LaneTelemetryStateV1 = {
    lane,
    resource,
    current: 0n,
    max: 0n,
    currentOldestAgeUs: 0n,
    maxOldestAgeUs: 0n,
    accepted: 0n,
    rejected: 0n,
    cancelled: 0n,
  };
  journal.lanes.set(key, state);
  return state;
}

function permitTelemetry(
  journal: SchedulerPerformanceJournalV1,
  work: Pick<SchedulerWorkDescriptor, "ownerRef" | "lane" | "resource">,
): PermitTelemetryStateV1 {
  const key = telemetryKey(work.ownerRef, work.lane, work.resource);
  const existing = journal.permits.get(key);
  if (existing !== undefined) return existing;
  const state: PermitTelemetryStateV1 = {
    ownerRef: work.ownerRef,
    lane: work.lane,
    resource: work.resource,
    issued: 0n,
    released: 0n,
  };
  journal.permits.set(key, state);
  return state;
}

function sortedQueueTelemetry(journal: SchedulerPerformanceJournalV1): readonly SchedulerQueueTelemetryFactV1[] {
  return Object.freeze([...journal.lanes.values()]
    .sort((left, right) => telemetryKey(left.lane, left.resource).localeCompare(telemetryKey(right.lane, right.resource)))
    .map(state => Object.freeze({
      lane: state.lane,
      resource: state.resource,
      current: state.current.toString(),
      max: state.max.toString(),
      oldestAgeUs: state.maxOldestAgeUs.toString(),
      accepted: state.accepted.toString(),
      rejected: state.rejected.toString(),
      cancelled: state.cancelled.toString(),
    })));
}

function sortedPermitAccounting(journal: SchedulerPerformanceJournalV1): readonly SchedulerPermitAccountingFactV1[] {
  return Object.freeze([...journal.permits.values()]
    .sort((left, right) => telemetryKey(left.ownerRef, left.lane, left.resource).localeCompare(telemetryKey(right.ownerRef, right.lane, right.resource)))
    .map(state => Object.freeze({
      ownerRef: state.ownerRef,
      lane: state.lane,
      resource: state.resource,
      issued: state.issued.toString(),
      released: state.released.toString(),
      active: (state.issued - state.released).toString(),
    })));
}

function sortedResourceSamples(journal: SchedulerPerformanceJournalV1): readonly SchedulerResourceSampleFactV1[] {
  return Object.freeze([...journal.resources.values()]
    .sort((left, right) => left.resource.localeCompare(right.resource))
    .map(state => Object.freeze({
      resource: state.resource,
      current: state.current.toString(),
      capacity: state.capacity.toString(),
      max: state.max.toString(),
    })));
}

function canonicalNonNegativeDecimal(value: unknown, path: string): bigint {
  if (typeof value !== "string") throw new TypeError(`${path} must be a canonical non-negative decimal`);
  const decoded = BigInt(value);
  if (decoded < 0n || decoded.toString() !== value) throw new TypeError(`${path} must be a canonical non-negative decimal`);
  return decoded;
}

function positiveDecimal(value: unknown, path: string): bigint {
  const decoded = canonicalNonNegativeDecimal(value, path);
  if (decoded === 0n) throw new TypeError(`${path} must be positive`);
  return decoded;
}

function exactRuntime(value: unknown, path: string): SchedulerPerformanceRuntimeBindingV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "schedulerRuntimeId", "qualifiedExecutorRegistryRoot", "executorAuthorityRoot",
    "workerEpoch", "executorSession", "authorityVersion",
  ], path);
  const runtime = value as unknown as SchedulerPerformanceRuntimeBindingV1;
  assertHash(runtime.schedulerRuntimeId, `${path}.schedulerRuntimeId`);
  assertHash(runtime.qualifiedExecutorRegistryRoot, `${path}.qualifiedExecutorRegistryRoot`);
  assertHash(runtime.executorAuthorityRoot, `${path}.executorAuthorityRoot`);
  assertNonEmptyString(runtime.workerEpoch, `${path}.workerEpoch`);
  assertHash(runtime.executorSession, `${path}.executorSession`);
  canonicalNonNegativeDecimal(runtime.authorityVersion, `${path}.authorityVersion`);
  return runtime;
}

function exactNonNegativeRecord(value: unknown, path: string): Readonly<Record<string, number>> {
  assertPlainObject(value, path);
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (!Number.isSafeInteger(item) || (item as number) < 0) throw new TypeError(`${path}.${key} must be a non-negative safe integer`);
  }
  return record as Readonly<Record<string, number>>;
}

function exactSnapshot(value: unknown, path: string): SchedulerSnapshot {
  assertPlainObject(value, path);
  assertExactKeys(value, ["activeByResource", "queuedByLane", "activeByLane", "activeByQuota", "accounting"], path);
  const snapshot = value as unknown as SchedulerSnapshot;
  exactNonNegativeRecord(snapshot.activeByResource, `${path}.activeByResource`);
  exactNonNegativeRecord(snapshot.queuedByLane, `${path}.queuedByLane`);
  exactNonNegativeRecord(snapshot.activeByLane, `${path}.activeByLane`);
  exactNonNegativeRecord(snapshot.activeByQuota, `${path}.activeByQuota`);
  assertPlainObject(snapshot.accounting, `${path}.accounting`);
  assertExactKeys(snapshot.accounting, [
    "accepted", "rejected", "queueFull", "resourceLimit", "cancelled", "completed",
    "failed", "blocked", "notProbed", "permitsIssued", "permitsReleased",
  ], `${path}.accounting`);
  exactNonNegativeRecord(snapshot.accounting as unknown, `${path}.accounting`);
  const active = Object.values(snapshot.activeByResource).reduce((sum, item) => sum + item, 0);
  if (snapshot.accounting.permitsIssued - snapshot.accounting.permitsReleased !== active) {
    throw new TypeError(`${path} permit conservation mismatch`);
  }
  return snapshot;
}

function completionPayload(value: SchedulerWorkCompletionFactV1): Omit<SchedulerWorkCompletionFactV1, "completionId"> {
  const { completionId: _completionId, ...payload } = value;
  return payload;
}

/** Pure exact decoder/replay validator; it accepts no scheduler capability. */
export function validateSchedulerWorkCompletionFactValue(value: unknown): SchedulerWorkCompletionFactV1 {
  const decoded = deepFreeze(decodeCanonicalBytes(encodeCanonicalBytes(value))) as unknown as SchedulerWorkCompletionFactV1;
  assertPlainObject(decoded, "schedulerWorkCompletion");
  assertExactKeys(decoded, [
    "schemaVersion", "kind", "runtime", "sequence", "completionId", "work", "callerId", "permitId",
    "queuedAtMonotonicUs", "permitIssuedAtMonotonicUs", "finishedAtMonotonicUs", "queueWaitUs",
    "serviceUs", "permitsIssued", "permitsReleased", "outcome",
  ], "schedulerWorkCompletion");
  if (decoded.schemaVersion !== 1 || decoded.kind !== "aloha.scheduler-work-completion-v1") throw new TypeError("scheduler work completion schema/kind mismatch");
  exactRuntime(decoded.runtime, "schedulerWorkCompletion.runtime");
  canonicalNonNegativeDecimal(decoded.sequence, "schedulerWorkCompletion.sequence");
  assertHash(decoded.completionId, "schedulerWorkCompletion.completionId");
  assertPlainObject(decoded.work, "schedulerWorkCompletion.work");
  assertExactKeys(decoded.work, ["workId", "phase", "workClassRef", "ownerRef", "lane", "resource", "cost", "quotaKey"], "schedulerWorkCompletion.work");
  assertNonEmptyString(decoded.work.workId, "schedulerWorkCompletion.work.workId");
  assertNonEmptyString(decoded.work.phase, "schedulerWorkCompletion.work.phase");
  assertNonEmptyString(decoded.work.workClassRef, "schedulerWorkCompletion.work.workClassRef");
  assertNonEmptyString(decoded.work.ownerRef, "schedulerWorkCompletion.work.ownerRef");
  assertNonEmptyString(decoded.work.lane, "schedulerWorkCompletion.work.lane");
  assertNonEmptyString(decoded.work.resource, "schedulerWorkCompletion.work.resource");
  const cost = positiveDecimal(decoded.work.cost, "schedulerWorkCompletion.work.cost");
  if (decoded.work.quotaKey !== null) assertNonEmptyString(decoded.work.quotaKey, "schedulerWorkCompletion.work.quotaKey");
  assertNonEmptyString(decoded.callerId, "schedulerWorkCompletion.callerId");
  if (decoded.permitId !== null) assertNonEmptyString(decoded.permitId, "schedulerWorkCompletion.permitId");
  const queued = canonicalNonNegativeDecimal(decoded.queuedAtMonotonicUs, "schedulerWorkCompletion.queuedAtMonotonicUs");
  const finished = canonicalNonNegativeDecimal(decoded.finishedAtMonotonicUs, "schedulerWorkCompletion.finishedAtMonotonicUs");
  if (finished < queued) throw new TypeError("scheduler work completion clock moved backwards");
  const issued = decoded.permitIssuedAtMonotonicUs === null
    ? null
    : canonicalNonNegativeDecimal(decoded.permitIssuedAtMonotonicUs, "schedulerWorkCompletion.permitIssuedAtMonotonicUs");
  const queueWait = decoded.queueWaitUs === null ? null : canonicalNonNegativeDecimal(decoded.queueWaitUs, "schedulerWorkCompletion.queueWaitUs");
  const service = decoded.serviceUs === null ? null : canonicalNonNegativeDecimal(decoded.serviceUs, "schedulerWorkCompletion.serviceUs");
  const permitsIssued = canonicalNonNegativeDecimal(decoded.permitsIssued, "schedulerWorkCompletion.permitsIssued");
  const permitsReleased = canonicalNonNegativeDecimal(decoded.permitsReleased, "schedulerWorkCompletion.permitsReleased");
  if (!COMPLETION_OUTCOMES.has(decoded.outcome)) throw new TypeError("scheduler work completion outcome is invalid");
  if (decoded.permitId === null) {
    if (issued !== null || service !== null || permitsIssued !== 0n || permitsReleased !== 0n || queueWait !== finished - queued) {
      throw new TypeError("scheduler rejected completion permit accounting mismatch");
    }
  } else {
    if (issued === null || issued < queued || issued > finished || queueWait !== issued - queued || service !== finished - issued
      || permitsIssued !== cost || permitsReleased !== cost) {
      throw new TypeError("scheduler admitted completion permit accounting mismatch");
    }
  }
  if (decoded.completionId !== hashDomain("aloha/scheduler-work-completion/v1", completionPayload(decoded))) {
    throw new TypeError("scheduler work completion identity mismatch");
  }
  return decoded;
}

function rangePayloadValue(value: SchedulerPerformanceRangeFactV1): Omit<SchedulerPerformanceRangeFactV1, "rangeId"> {
  const { rangeId: _rangeId, ...payload } = value;
  return payload;
}

function exactQueueTelemetry(
  value: unknown,
  endSnapshot: SchedulerSnapshot,
): readonly SchedulerQueueTelemetryFactV1[] {
  if (!Array.isArray(value)) throw new TypeError("schedulerPerformanceRange.queueTelemetry must be an array");
  const seen = new Set<string>();
  const queuedByLane = new Map<string, bigint>();
  let accepted = 0n;
  let rejected = 0n;
  let cancelled = 0n;
  let previous = "";
  const decoded = value.map((entry, index) => {
    const path = `schedulerPerformanceRange.queueTelemetry[${index}]`;
    assertPlainObject(entry, path);
    assertExactKeys(entry, ["lane", "resource", "current", "max", "oldestAgeUs", "accepted", "rejected", "cancelled"], path);
    const record = entry as unknown as SchedulerQueueTelemetryFactV1;
    const lane = assertNonEmptyString(record.lane, `${path}.lane`);
    const resource = assertNonEmptyString(record.resource, `${path}.resource`);
    const key = telemetryKey(lane, resource);
    if (seen.has(key) || (index > 0 && key <= previous)) throw new TypeError("scheduler queue telemetry must be strictly sorted and unique");
    seen.add(key);
    previous = key;
    const current = canonicalNonNegativeDecimal(record.current, `${path}.current`);
    const max = canonicalNonNegativeDecimal(record.max, `${path}.max`);
    canonicalNonNegativeDecimal(record.oldestAgeUs, `${path}.oldestAgeUs`);
    const entryAccepted = canonicalNonNegativeDecimal(record.accepted, `${path}.accepted`);
    const entryRejected = canonicalNonNegativeDecimal(record.rejected, `${path}.rejected`);
    const entryCancelled = canonicalNonNegativeDecimal(record.cancelled, `${path}.cancelled`);
    if (current > max) throw new TypeError(`${path}.current exceeds max`);
    queuedByLane.set(lane, (queuedByLane.get(lane) ?? 0n) + current);
    accepted += entryAccepted;
    rejected += entryRejected;
    cancelled += entryCancelled;
    return record;
  });
  for (const [lane, current] of Object.entries(endSnapshot.queuedByLane)) {
    if ((queuedByLane.get(lane) ?? 0n) !== BigInt(current)) throw new TypeError(`scheduler queue telemetry current mismatch for ${lane}`);
    queuedByLane.delete(lane);
  }
  if ([...queuedByLane.values()].some(current => current !== 0n)) throw new TypeError("scheduler queue telemetry contains an unknown active lane");
  if (accepted !== BigInt(endSnapshot.accounting.accepted)
    || rejected !== BigInt(endSnapshot.accounting.rejected)
    || cancelled !== BigInt(endSnapshot.accounting.cancelled)) {
    throw new TypeError("scheduler queue telemetry accounting mismatch");
  }
  return Object.freeze(decoded);
}

function exactPermitAccounting(
  value: unknown,
  endSnapshot: SchedulerSnapshot,
): readonly SchedulerPermitAccountingFactV1[] {
  if (!Array.isArray(value)) throw new TypeError("schedulerPerformanceRange.permitAccounting must be an array");
  let issuedTotal = 0n;
  let releasedTotal = 0n;
  const activeByResource = new Map<string, bigint>();
  let previous = "";
  const decoded = value.map((entry, index) => {
    const path = `schedulerPerformanceRange.permitAccounting[${index}]`;
    assertPlainObject(entry, path);
    assertExactKeys(entry, ["ownerRef", "lane", "resource", "issued", "released", "active"], path);
    const record = entry as unknown as SchedulerPermitAccountingFactV1;
    const ownerRef = assertNonEmptyString(record.ownerRef, `${path}.ownerRef`);
    const lane = assertNonEmptyString(record.lane, `${path}.lane`);
    const resource = assertNonEmptyString(record.resource, `${path}.resource`);
    const key = telemetryKey(ownerRef, lane, resource);
    if (index > 0 && key <= previous) throw new TypeError("scheduler permit accounting must be strictly sorted and unique");
    previous = key;
    const issued = canonicalNonNegativeDecimal(record.issued, `${path}.issued`);
    const released = canonicalNonNegativeDecimal(record.released, `${path}.released`);
    const active = canonicalNonNegativeDecimal(record.active, `${path}.active`);
    if (released > issued || active !== issued - released) throw new TypeError(`${path} is not conserved`);
    issuedTotal += issued;
    releasedTotal += released;
    activeByResource.set(resource, (activeByResource.get(resource) ?? 0n) + active);
    return record;
  });
  if (issuedTotal !== BigInt(endSnapshot.accounting.permitsIssued)
    || releasedTotal !== BigInt(endSnapshot.accounting.permitsReleased)) {
    throw new TypeError("scheduler permit accounting totals mismatch");
  }
  for (const [resource, active] of Object.entries(endSnapshot.activeByResource)) {
    if ((activeByResource.get(resource) ?? 0n) !== BigInt(active)) throw new TypeError(`scheduler permit active count mismatch for ${resource}`);
    activeByResource.delete(resource);
  }
  if ([...activeByResource.values()].some(active => active !== 0n)) throw new TypeError("scheduler permit accounting contains an unknown active resource");
  return Object.freeze(decoded);
}

function exactResourceSamples(
  value: unknown,
  endSnapshot: SchedulerSnapshot,
): readonly SchedulerResourceSampleFactV1[] {
  if (!Array.isArray(value)) throw new TypeError("schedulerPerformanceRange.resourceSamples must be an array");
  let previous = "";
  const seen = new Set<string>();
  const decoded = value.map((entry, index) => {
    const path = `schedulerPerformanceRange.resourceSamples[${index}]`;
    assertPlainObject(entry, path);
    assertExactKeys(entry, ["resource", "current", "capacity", "max"], path);
    const record = entry as unknown as SchedulerResourceSampleFactV1;
    const resource = assertNonEmptyString(record.resource, `${path}.resource`);
    if (seen.has(resource) || (index > 0 && resource <= previous)) throw new TypeError("scheduler resource samples must be strictly sorted and unique");
    seen.add(resource);
    previous = resource;
    const current = canonicalNonNegativeDecimal(record.current, `${path}.current`);
    const capacity = positiveDecimal(record.capacity, `${path}.capacity`);
    const max = canonicalNonNegativeDecimal(record.max, `${path}.max`);
    if (current > max || max > capacity) throw new TypeError(`${path} exceeds resource capacity`);
    if (BigInt(endSnapshot.activeByResource[resource] ?? -1) !== current) throw new TypeError(`${path}.current does not match scheduler snapshot`);
    return record;
  });
  if (Object.keys(endSnapshot.activeByResource).some(resource => !seen.has(resource))) throw new TypeError("scheduler resource sample coverage is incomplete");
  return Object.freeze(decoded);
}

/** Pure exact decoder/replay validator; completion membership remains bound by orderedCompletionRoot. */
export function validateSchedulerPerformanceRangeFactValue(value: unknown): SchedulerPerformanceRangeFactV1 {
  const decoded = deepFreeze(decodeCanonicalBytes(encodeCanonicalBytes(value))) as unknown as SchedulerPerformanceRangeFactV1;
  assertPlainObject(decoded, "schedulerPerformanceRange");
  assertExactKeys(decoded, [
    "schemaVersion", "kind", "rangeId", "runtime", "startSequence", "endSequence", "completionCount",
    "attemptedWorkStart", "attemptedWorkEnd", "openedAtMonotonicNs", "sealedAtMonotonicNs",
    "startSnapshot", "endSnapshot", "orderedCompletionRoot", "queueTelemetry", "permitAccounting", "resourceSamples",
  ], "schedulerPerformanceRange");
  if (decoded.schemaVersion !== 1 || decoded.kind !== "aloha.scheduler-performance-range-v1") throw new TypeError("scheduler performance range schema/kind mismatch");
  assertHash(decoded.rangeId, "schedulerPerformanceRange.rangeId");
  exactRuntime(decoded.runtime, "schedulerPerformanceRange.runtime");
  const start = canonicalNonNegativeDecimal(decoded.startSequence, "schedulerPerformanceRange.startSequence");
  const end = canonicalNonNegativeDecimal(decoded.endSequence, "schedulerPerformanceRange.endSequence");
  const count = canonicalNonNegativeDecimal(decoded.completionCount, "schedulerPerformanceRange.completionCount");
  if (end < start || count !== end - start) throw new TypeError("scheduler performance range sequence/count mismatch");
  const attemptedStart = canonicalNonNegativeDecimal(decoded.attemptedWorkStart, "schedulerPerformanceRange.attemptedWorkStart");
  const attemptedEnd = canonicalNonNegativeDecimal(decoded.attemptedWorkEnd, "schedulerPerformanceRange.attemptedWorkEnd");
  if (attemptedEnd < attemptedStart) throw new TypeError("scheduler performance attempted-work counter regressed");
  const opened = canonicalNonNegativeDecimal(decoded.openedAtMonotonicNs, "schedulerPerformanceRange.openedAtMonotonicNs");
  const sealed = canonicalNonNegativeDecimal(decoded.sealedAtMonotonicNs, "schedulerPerformanceRange.sealedAtMonotonicNs");
  if (sealed < opened) throw new TypeError("scheduler performance range clock moved backwards");
  const startSnapshot = exactSnapshot(decoded.startSnapshot, "schedulerPerformanceRange.startSnapshot");
  const endSnapshot = exactSnapshot(decoded.endSnapshot, "schedulerPerformanceRange.endSnapshot");
  for (const key of Object.keys(startSnapshot.accounting) as (keyof SchedulerSnapshot["accounting"])[]) {
    if (endSnapshot.accounting[key] < startSnapshot.accounting[key]) throw new TypeError(`scheduler performance accounting regressed: ${key}`);
  }
  assertHash(decoded.orderedCompletionRoot, "schedulerPerformanceRange.orderedCompletionRoot");
  exactQueueTelemetry(decoded.queueTelemetry, endSnapshot);
  exactPermitAccounting(decoded.permitAccounting, endSnapshot);
  exactResourceSamples(decoded.resourceSamples, endSnapshot);
  if (decoded.rangeId !== hashDomain("aloha/scheduler-performance-range/v1", rangePayloadValue(decoded))) {
    throw new TypeError("scheduler performance range identity mismatch");
  }
  return decoded;
}

export type SchedulerPerformanceReaderPortV1 = object;

export function issueSchedulerWorkCompletionHandle(
  scheduler: WorkScheduler,
): SchedulerWorkCompletionHandleV1 {
  if (!journals.has(scheduler)) throw new TypeError("scheduler performance journal is unavailable");
  const handle = Object.freeze(Object.create(null)) as SchedulerWorkCompletionHandleV1;
  completionHandles.set(handle, { scheduler, settled: false, capability: null, error: null });
  return handle;
}

export function settleSchedulerWorkCompletionHandle(
  scheduler: WorkScheduler,
  handle: SchedulerWorkCompletionHandleV1,
  capability: SchedulerWorkCompletionCapabilityV1 | null,
  error: unknown,
): void {
  const state = completionHandles.get(handle);
  if (state === undefined || state.scheduler !== scheduler) throw new TypeError("scheduler completion handle is not owner-issued");
  if (state.settled) throw new TypeError("scheduler completion handle is already settled");
  state.settled = true;
  state.capability = capability;
  state.error = error;
}

export function registerSchedulerPerformanceJournal(scheduler: WorkScheduler): void {
  if (journals.has(scheduler)) throw new TypeError("scheduler performance journal is already registered");
  journals.set(scheduler, {
    nextSequence: 0n,
    baseSequence: 0n,
    attemptedWorkCount: 0n,
    baseAttemptedWorkCount: 0n,
    baseOpenedAtMonotonicNs: process.hrtime.bigint(),
    baseSnapshot: scheduler.snapshot(),
    binding: null,
    capabilities: [],
    lanes: new Map(),
    permits: new Map(),
    resources: new Map(),
    openCursor: null,
    unacknowledgedRange: null,
  });
}

export function observeSchedulerPerformanceState(scheduler: WorkScheduler): void {
  const journal = journals.get(scheduler);
  if (journal === undefined) throw new TypeError("scheduler performance journal is unavailable");
  const observation = scheduler.performanceObservation();
  for (const state of journal.lanes.values()) {
    state.current = 0n;
    state.currentOldestAgeUs = 0n;
  }
  for (const lane of observation.lanes) {
    const state = laneTelemetry(journal, lane.lane, lane.resource);
    const current = canonicalNonNegativeDecimal(lane.current, `schedulerPerformanceObservation.${lane.lane}.current`);
    const oldest = canonicalNonNegativeDecimal(lane.oldestAgeUs, `schedulerPerformanceObservation.${lane.lane}.oldestAgeUs`);
    state.current = current;
    state.currentOldestAgeUs = oldest;
    if (current > state.max) state.max = current;
    if (oldest > state.maxOldestAgeUs) state.maxOldestAgeUs = oldest;
  }
  for (const resource of observation.resources) {
    const current = canonicalNonNegativeDecimal(resource.current, `schedulerPerformanceObservation.${resource.resource}.current`);
    const capacity = positiveDecimal(resource.capacity, `schedulerPerformanceObservation.${resource.resource}.capacity`);
    let state = journal.resources.get(resource.resource);
    if (state === undefined) {
      state = { resource: resource.resource, current, capacity, max: current };
      journal.resources.set(resource.resource, state);
    } else {
      if (state.capacity !== capacity) throw new TypeError("scheduler resource capacity changed during a performance runtime");
      state.current = current;
      if (current > state.max) state.max = current;
    }
  }
}

export function markSchedulerPermitIssued(
  scheduler: WorkScheduler,
  work: Pick<SchedulerWorkDescriptor, "ownerRef" | "lane" | "resource">,
  cost: number,
): void {
  const journal = journals.get(scheduler);
  if (journal === undefined) throw new TypeError("scheduler performance journal is unavailable");
  if (!Number.isSafeInteger(cost) || cost <= 0) throw new TypeError("scheduler permit issue cost must be a positive safe integer");
  const permit = permitTelemetry(journal, work);
  permit.issued += BigInt(cost);
  laneTelemetry(journal, work.lane, work.resource).accepted += 1n;
}

export function markSchedulerPermitReleased(
  scheduler: WorkScheduler,
  work: Pick<SchedulerWorkDescriptor, "ownerRef" | "lane" | "resource">,
  cost: number,
): void {
  const journal = journals.get(scheduler);
  if (journal === undefined) throw new TypeError("scheduler performance journal is unavailable");
  if (!Number.isSafeInteger(cost) || cost <= 0) throw new TypeError("scheduler permit release cost must be a positive safe integer");
  const permit = permitTelemetry(journal, work);
  permit.released += BigInt(cost);
  if (permit.released > permit.issued) throw new TypeError("scheduler permit release exceeded issued units");
}

export function markSchedulerWorkAttempt(scheduler: WorkScheduler): void {
  const journal = journals.get(scheduler);
  if (journal === undefined) throw new TypeError("scheduler performance journal is unavailable");
  journal.attemptedWorkCount += 1n;
}

export function bindSchedulerPerformanceJournal(
  scheduler: WorkScheduler,
  input: Omit<SchedulerPerformanceRuntimeBindingV1, "schedulerRuntimeId">,
): SchedulerPerformanceRuntimeBindingV1 {
  const journal = journals.get(scheduler);
  if (journal === undefined) throw new TypeError("scheduler performance journal is unavailable");
  if (journal.binding !== null) throw new TypeError("scheduler performance journal is already release-bound");
  if (journal.attemptedWorkCount !== 0n || journal.nextSequence !== 0n || journal.capabilities.length !== 0) {
    throw new TypeError("scheduler performance journal cannot bind after any work attempt");
  }
  const binding = Object.freeze({
    schedulerRuntimeId: hashDomain("aloha/scheduler-runtime-instance/v1", {
      ...input,
      processLocalNonce: randomUUID(),
    }),
    ...input,
  });
  journal.binding = binding;
  journal.baseOpenedAtMonotonicNs = process.hrtime.bigint();
  journal.baseSnapshot = scheduler.snapshot();
  return binding;
}

export function recordSchedulerWorkCompletion(
  scheduler: WorkScheduler,
  draft: SchedulerWorkCompletionFactDraftV1,
): SchedulerWorkCompletionCapabilityV1 | null {
  const journal = journals.get(scheduler);
  if (journal === undefined) throw new TypeError("scheduler performance journal is unavailable");
  if (journal.binding === null) return null;
  if (journal.capabilities.length >= MAX_UNACKNOWLEDGED_COMPLETIONS) {
    throw new TypeError("scheduler performance journal reached its unacknowledged completion limit");
  }
  const sequence = journal.nextSequence.toString();
  const body = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.scheduler-work-completion-v1" as const,
    runtime: journal.binding,
    sequence,
    ...draft,
  });
  const completionId = hashDomain("aloha/scheduler-work-completion/v1", body) as Hash;
  const fact: SchedulerWorkCompletionFactV1 = Object.freeze({ ...body, completionId });
  const lane = laneTelemetry(journal, fact.work.lane, fact.work.resource);
  const queueWait = canonicalNonNegativeDecimal(fact.queueWaitUs ?? "0", "schedulerWorkCompletion.queueWaitUs");
  if (queueWait > lane.maxOldestAgeUs) lane.maxOldestAgeUs = queueWait;
  if (fact.permitId === null) {
    if (fact.outcome === "aborted" || fact.outcome === "deadline") lane.cancelled += 1n;
    else lane.rejected += 1n;
  }
  const capability = Object.freeze(Object.create(null)) as SchedulerWorkCompletionCapabilityV1;
  facts.set(capability, Object.freeze({ scheduler, fact }));
  journal.capabilities.push(capability);
  journal.nextSequence += 1n;
  return capability;
}

export function issueSchedulerPerformanceReaderPort(
  scheduler: WorkScheduler,
): SchedulerPerformanceReaderPortV1 {
  const journal = journals.get(scheduler);
  if (journal === undefined) throw new TypeError("scheduler performance journal is unavailable");
  if (journal.binding === null) throw new TypeError("scheduler performance journal is not release-bound");
  const port = Object.freeze(Object.create(null));
  readerStates.set(port, scheduler);
  return port;
}

export function readSchedulerWorkCompletionCapability(
  port: SchedulerPerformanceReaderPortV1,
  capability: SchedulerWorkCompletionCapabilityV1,
): SchedulerWorkCompletionFactV1 {
  const scheduler = readerStates.get(port);
  if (scheduler === undefined) throw new TypeError("scheduler performance reader is not owner-issued");
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("scheduler work completion capability is required");
  }
  const state = facts.get(capability);
  if (state === undefined) throw new TypeError("scheduler work completion capability is not owner-issued");
  if (state.scheduler !== scheduler) throw new TypeError("scheduler work completion belongs to another scheduler");
  return state.fact;
}

export function readSchedulerWorkCompletionHandle(
  port: SchedulerPerformanceReaderPortV1,
  handle: SchedulerWorkCompletionHandleV1,
): SchedulerWorkCompletionCapabilityV1 {
  const scheduler = readerStates.get(port);
  if (scheduler === undefined) throw new TypeError("scheduler performance reader is not owner-issued");
  if (handle === null || typeof handle !== "object") throw new TypeError("scheduler completion handle is required");
  const state = completionHandles.get(handle);
  if (state === undefined || state.scheduler !== scheduler) throw new TypeError("scheduler completion handle belongs to another scheduler");
  if (!state.settled) throw new TypeError("scheduler completion handle is not settled");
  if (state.error !== null) throw new TypeError("scheduler completion handle failed to seal", { cause: state.error });
  if (state.capability === null) throw new TypeError("scheduler completion handle is not release-qualified");
  return state.capability;
}

function rangePayload(value: SchedulerPerformanceRangeFactV1): Omit<SchedulerPerformanceRangeFactV1, "rangeId"> {
  const { rangeId: _rangeId, ...payload } = value;
  return payload;
}

export function openSchedulerPerformanceCursor(
  port: SchedulerPerformanceReaderPortV1,
): SchedulerPerformanceCursorCapabilityV1 {
  const scheduler = readerStates.get(port);
  if (scheduler === undefined) throw new TypeError("scheduler performance reader is not owner-issued");
  const journal = journals.get(scheduler)!;
  if (journal.binding === null) throw new TypeError("scheduler performance journal is not release-bound");
  if (journal.openCursor !== null || journal.unacknowledgedRange !== null) {
    throw new TypeError("scheduler performance range is already open or unacknowledged");
  }
  const cursor = Object.freeze(Object.create(null)) as SchedulerPerformanceCursorCapabilityV1;
  cursorStates.set(cursor, Object.freeze({
    scheduler,
    // Every retained completion belongs to the next durable range. Opening a
    // cursor must never skip work that completed before the caller arrived.
    startSequence: journal.baseSequence,
    attemptedWorkStart: journal.baseAttemptedWorkCount,
    openedAtMonotonicNs: journal.baseOpenedAtMonotonicNs,
    startSnapshot: journal.baseSnapshot,
  }));
  journal.openCursor = cursor;
  return cursor;
}

export function sealSchedulerPerformanceRange(
  port: SchedulerPerformanceReaderPortV1,
  cursor: SchedulerPerformanceCursorCapabilityV1,
): SchedulerPerformanceRangeCapabilityV1 {
  const scheduler = readerStates.get(port);
  if (scheduler === undefined) throw new TypeError("scheduler performance reader is not owner-issued");
  const journal = journals.get(scheduler)!;
  const cursorState = cursorStates.get(cursor);
  if (cursorState === undefined || cursorState.scheduler !== scheduler || journal.openCursor !== cursor) {
    throw new TypeError("scheduler performance cursor is not the active owner-issued cursor");
  }
  observeSchedulerPerformanceState(scheduler);
  const startOffset = cursorState.startSequence - journal.baseSequence;
  const endOffset = journal.nextSequence - journal.baseSequence;
  if (startOffset < 0n || endOffset < startOffset || endOffset > BigInt(journal.capabilities.length)) {
    throw new TypeError("scheduler performance journal range is not retained");
  }
  const capabilities = Object.freeze(journal.capabilities.slice(Number(startOffset), Number(endOffset)));
  const completionIds = capabilities.map(capability => {
    const state = facts.get(capability);
    if (state === undefined || state.scheduler !== scheduler) throw new TypeError("scheduler performance range contains a foreign completion");
    return state.fact.completionId;
  });
  const draft = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.scheduler-performance-range-v1" as const,
    runtime: journal.binding!,
    startSequence: cursorState.startSequence.toString(),
    endSequence: journal.nextSequence.toString(),
    completionCount: capabilities.length.toString(),
    attemptedWorkStart: cursorState.attemptedWorkStart.toString(),
    attemptedWorkEnd: journal.attemptedWorkCount.toString(),
    openedAtMonotonicNs: cursorState.openedAtMonotonicNs.toString(),
    sealedAtMonotonicNs: process.hrtime.bigint().toString(),
    startSnapshot: cursorState.startSnapshot,
    endSnapshot: scheduler.snapshot(),
    orderedCompletionRoot: hashDomain("aloha/scheduler-performance-range-completions/v1", completionIds),
    queueTelemetry: sortedQueueTelemetry(journal),
    permitAccounting: sortedPermitAccounting(journal),
    resourceSamples: sortedResourceSamples(journal),
  });
  const fact = Object.freeze({
    ...draft,
    rangeId: hashDomain("aloha/scheduler-performance-range/v1", draft),
  });
  const range = Object.freeze(Object.create(null)) as SchedulerPerformanceRangeCapabilityV1;
  rangeStates.set(range, { scheduler, fact, capabilities, acknowledged: false });
  journal.openCursor = null;
  journal.unacknowledgedRange = range;
  return range;
}

export function readSchedulerPerformanceRange(
  port: SchedulerPerformanceReaderPortV1,
  range: SchedulerPerformanceRangeCapabilityV1,
): Readonly<{
  fact: SchedulerPerformanceRangeFactV1;
  completions: readonly SchedulerWorkCompletionCapabilityV1[];
}> {
  const scheduler = readerStates.get(port);
  if (scheduler === undefined) throw new TypeError("scheduler performance reader is not owner-issued");
  const state = rangeStates.get(range);
  if (state === undefined || state.scheduler !== scheduler) throw new TypeError("scheduler performance range is not owner-issued");
  if (state.acknowledged) throw new TypeError("scheduler performance range is already acknowledged");
  if (state.fact.rangeId !== hashDomain("aloha/scheduler-performance-range/v1", rangePayload(state.fact))) {
    throw new TypeError("scheduler performance range identity mismatch");
  }
  const completionIds = state.capabilities.map(capability => {
    const completion = facts.get(capability);
    if (completion === undefined || completion.scheduler !== scheduler) throw new TypeError("scheduler performance range contains a foreign completion");
    return completion.fact.completionId;
  });
  if (state.fact.orderedCompletionRoot !== hashDomain("aloha/scheduler-performance-range-completions/v1", completionIds)) {
    throw new TypeError("scheduler performance range completion root mismatch");
  }
  validateSchedulerPerformanceRangeFactValue(state.fact);
  return Object.freeze({ fact: state.fact, completions: state.capabilities });
}

export function acknowledgeSchedulerPerformanceRange(
  port: SchedulerPerformanceReaderPortV1,
  range: SchedulerPerformanceRangeCapabilityV1,
): void {
  const scheduler = readerStates.get(port);
  if (scheduler === undefined) throw new TypeError("scheduler performance reader is not owner-issued");
  const journal = journals.get(scheduler)!;
  const state = rangeStates.get(range);
  if (state === undefined || state.scheduler !== scheduler || journal.unacknowledgedRange !== range) {
    throw new TypeError("scheduler performance range is not the active unacknowledged range");
  }
  if (state.acknowledged) throw new TypeError("scheduler performance range is already acknowledged");
  const endSequence = BigInt(state.fact.endSequence);
  const dropCount = endSequence - journal.baseSequence;
  if (dropCount < 0n || dropCount > BigInt(journal.capabilities.length)) {
    throw new TypeError("scheduler performance acknowledgement is outside retained journal");
  }
  journal.capabilities.splice(0, Number(dropCount));
  journal.baseSequence = endSequence;
  journal.baseAttemptedWorkCount = BigInt(state.fact.attemptedWorkEnd);
  journal.baseOpenedAtMonotonicNs = BigInt(state.fact.sealedAtMonotonicNs);
  journal.baseSnapshot = state.fact.endSnapshot;
  observeSchedulerPerformanceState(scheduler);
  for (const lane of journal.lanes.values()) {
    lane.max = lane.current;
    lane.maxOldestAgeUs = lane.currentOldestAgeUs;
  }
  for (const resource of journal.resources.values()) resource.max = resource.current;
  state.acknowledged = true;
  journal.unacknowledgedRange = null;
}
