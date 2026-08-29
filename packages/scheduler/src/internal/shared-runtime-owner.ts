import type {
  QualifiedExecutorAuthorityCapability,
  QualifiedExecutorAuthorityIssuer,
  QualifiedExecutorAuthorityProvenanceV1,
  SchedulerWorkCompletionCapabilityV1,
  SchedulerWorkCompletionFactV1,
  SchedulerWorkCompletionHandleV1,
  SchedulerPerformanceCursorCapabilityV1,
  SchedulerPerformanceRangeCapabilityV1,
  SchedulerPerformanceRangeFactV1,
} from "../index.ts";
import { WorkScheduler } from "../index.ts";
import { assertIssuedQualifiedExecutorAuthorityIssuer } from "./authority-consumer.ts";
import {
  bindSchedulerPerformanceJournal,
  acknowledgeSchedulerPerformanceRange,
  issueSchedulerPerformanceReaderPort,
  openSchedulerPerformanceCursor,
  readSchedulerPerformanceRange,
  readSchedulerWorkCompletionCapability,
  readSchedulerWorkCompletionHandle,
  sealSchedulerPerformanceRange,
  type SchedulerPerformanceReaderPortV1,
} from "./performance-state.ts";

/** Opaque process-local ownership of the one scheduler shared by release work. */
export type QualifiedSharedSchedulerRuntimePortV1 = object;

interface SharedSchedulerStateV1 {
  readonly scheduler: WorkScheduler;
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly capability: QualifiedExecutorAuthorityCapability;
  readonly provenance: QualifiedExecutorAuthorityProvenanceV1;
  readonly runtime: SchedulerWorkCompletionFactV1["runtime"];
}

const issued = new WeakMap<object, SharedSchedulerStateV1>();

/** Release-bound read-only view over scheduler-owned work completions. */
export type QualifiedSharedSchedulerPerformanceReaderPortV1 = object;

interface SharedSchedulerPerformanceReaderStateV1 {
  readonly runtimePort: QualifiedSharedSchedulerRuntimePortV1;
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly capability: QualifiedExecutorAuthorityCapability;
  readonly provenance: QualifiedExecutorAuthorityProvenanceV1;
  readonly reader: SchedulerPerformanceReaderPortV1;
}

const performanceReaders = new WeakMap<object, SharedSchedulerPerformanceReaderStateV1>();

function sameProvenance(
  left: QualifiedExecutorAuthorityProvenanceV1,
  right: QualifiedExecutorAuthorityProvenanceV1,
): boolean {
  return left.authorityRoot === right.authorityRoot
    && left.workerEpoch === right.workerEpoch
    && left.executorSession === right.executorSession
    && left.version === right.version;
}

export function issueQualifiedSharedSchedulerRuntimePort(input: {
  readonly scheduler: WorkScheduler;
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly capability: QualifiedExecutorAuthorityCapability;
}): QualifiedSharedSchedulerRuntimePortV1 {
  if (!(input.scheduler instanceof WorkScheduler)) throw new TypeError("shared scheduler runtime requires WorkScheduler");
  const issuer = assertIssuedQualifiedExecutorAuthorityIssuer(input.issuer);
  const provenance = issuer.provenance(input.capability);
  const runtime = bindSchedulerPerformanceJournal(input.scheduler, {
    qualifiedExecutorRegistryRoot: issuer.registryRoot,
    executorAuthorityRoot: provenance.authorityRoot,
    workerEpoch: provenance.workerEpoch,
    executorSession: provenance.executorSession,
    authorityVersion: String(provenance.version),
  });
  const port = Object.freeze(Object.create(null)) as QualifiedSharedSchedulerRuntimePortV1;
  issued.set(port, Object.freeze({ scheduler: input.scheduler, issuer, capability: input.capability, provenance, runtime }));
  return port;
}

/** Internal consumer join; clones and ports issued for another capability fail closed. */
export function readQualifiedSharedSchedulerRuntimePort(
  portValue: unknown,
  issuerValue: QualifiedExecutorAuthorityIssuer,
  capability: QualifiedExecutorAuthorityCapability,
): WorkScheduler {
  if (portValue === null || typeof portValue !== "object") {
    throw new TypeError("shared scheduler runtime port is not owner-issued");
  }
  const state = issued.get(portValue);
  if (state === undefined) throw new TypeError("shared scheduler runtime port is not owner-issued");
  if (state.capability !== capability) {
    throw new TypeError("shared scheduler runtime port is not bound to this qualified executor");
  }
  const issuer = assertIssuedQualifiedExecutorAuthorityIssuer(issuerValue);
  const current = issuer.provenance(capability);
  const issuedCurrent = state.issuer.provenance(state.capability);
  if (!sameProvenance(state.provenance, current) || !sameProvenance(issuedCurrent, current)) {
    throw new TypeError("shared scheduler runtime port is stale or cross-release");
  }
  return state.scheduler;
}

export function issueQualifiedSharedSchedulerPerformanceReaderPort(input: {
  readonly runtimePort: QualifiedSharedSchedulerRuntimePortV1;
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  readonly capability: QualifiedExecutorAuthorityCapability;
}): QualifiedSharedSchedulerPerformanceReaderPortV1 {
  const scheduler = readQualifiedSharedSchedulerRuntimePort(input.runtimePort, input.issuer, input.capability);
  const issuer = assertIssuedQualifiedExecutorAuthorityIssuer(input.issuer);
  const provenance = issuer.provenance(input.capability);
  const port = Object.freeze(Object.create(null));
  performanceReaders.set(port, Object.freeze({
    runtimePort: input.runtimePort,
    issuer,
    capability: input.capability,
    provenance,
    reader: issueSchedulerPerformanceReaderPort(scheduler),
  }));
  return port;
}

function readPerformanceReaderState(
  portValue: unknown,
  issuerValue: QualifiedExecutorAuthorityIssuer,
  capability: QualifiedExecutorAuthorityCapability,
): SharedSchedulerPerformanceReaderStateV1 {
  if (portValue === null || typeof portValue !== "object") {
    throw new TypeError("shared scheduler performance reader is not owner-issued");
  }
  const state = performanceReaders.get(portValue);
  if (state === undefined) throw new TypeError("shared scheduler performance reader is not owner-issued");
  if (state.capability !== capability) throw new TypeError("shared scheduler performance reader is not bound to this qualified executor");
  const issuer = assertIssuedQualifiedExecutorAuthorityIssuer(issuerValue);
  const current = issuer.provenance(capability);
  const issuedCurrent = state.issuer.provenance(state.capability);
  if (!sameProvenance(state.provenance, current) || !sameProvenance(issuedCurrent, current)) {
    throw new TypeError("shared scheduler performance reader is stale or cross-release");
  }
  readQualifiedSharedSchedulerRuntimePort(state.runtimePort, issuer, capability);
  return state;
}

export function readQualifiedSchedulerWorkCompletionCapability(
  portValue: QualifiedSharedSchedulerPerformanceReaderPortV1,
  completion: SchedulerWorkCompletionCapabilityV1,
  issuerValue: QualifiedExecutorAuthorityIssuer,
  capability: QualifiedExecutorAuthorityCapability,
): SchedulerWorkCompletionFactV1 {
  const state = readPerformanceReaderState(portValue, issuerValue, capability);
  const fact = readSchedulerWorkCompletionCapability(state.reader, completion);
  const runtime = issued.get(state.runtimePort)?.runtime;
  if (runtime === undefined
    || fact.runtime.schedulerRuntimeId !== runtime.schedulerRuntimeId
    || fact.runtime.qualifiedExecutorRegistryRoot !== runtime.qualifiedExecutorRegistryRoot
    || fact.runtime.executorAuthorityRoot !== runtime.executorAuthorityRoot
    || fact.runtime.workerEpoch !== runtime.workerEpoch
    || fact.runtime.executorSession !== runtime.executorSession
    || fact.runtime.authorityVersion !== runtime.authorityVersion) {
    throw new TypeError("scheduler work completion runtime binding mismatch");
  }
  return fact;
}

export function readQualifiedSchedulerWorkCompletionHandle(
  portValue: QualifiedSharedSchedulerPerformanceReaderPortV1,
  handle: SchedulerWorkCompletionHandleV1,
  issuerValue: QualifiedExecutorAuthorityIssuer,
  capability: QualifiedExecutorAuthorityCapability,
): SchedulerWorkCompletionCapabilityV1 {
  const state = readPerformanceReaderState(portValue, issuerValue, capability);
  return readSchedulerWorkCompletionHandle(state.reader, handle);
}

export function openQualifiedSchedulerPerformanceCursor(
  portValue: QualifiedSharedSchedulerPerformanceReaderPortV1,
  issuerValue: QualifiedExecutorAuthorityIssuer,
  capability: QualifiedExecutorAuthorityCapability,
): SchedulerPerformanceCursorCapabilityV1 {
  const state = readPerformanceReaderState(portValue, issuerValue, capability);
  return openSchedulerPerformanceCursor(state.reader);
}

export function sealQualifiedSchedulerPerformanceRange(
  portValue: QualifiedSharedSchedulerPerformanceReaderPortV1,
  cursor: SchedulerPerformanceCursorCapabilityV1,
  issuerValue: QualifiedExecutorAuthorityIssuer,
  capability: QualifiedExecutorAuthorityCapability,
): SchedulerPerformanceRangeCapabilityV1 {
  const state = readPerformanceReaderState(portValue, issuerValue, capability);
  return sealSchedulerPerformanceRange(state.reader, cursor);
}

export function readQualifiedSchedulerPerformanceRange(
  portValue: QualifiedSharedSchedulerPerformanceReaderPortV1,
  range: SchedulerPerformanceRangeCapabilityV1,
  issuerValue: QualifiedExecutorAuthorityIssuer,
  capability: QualifiedExecutorAuthorityCapability,
): Readonly<{
  fact: SchedulerPerformanceRangeFactV1;
  completions: readonly SchedulerWorkCompletionCapabilityV1[];
}> {
  const state = readPerformanceReaderState(portValue, issuerValue, capability);
  const observed = readSchedulerPerformanceRange(state.reader, range);
  for (const completion of observed.completions) {
    readQualifiedSchedulerWorkCompletionCapability(portValue, completion, issuerValue, capability);
  }
  return observed;
}

export function acknowledgeQualifiedSchedulerPerformanceRange(
  portValue: QualifiedSharedSchedulerPerformanceReaderPortV1,
  range: SchedulerPerformanceRangeCapabilityV1,
  issuerValue: QualifiedExecutorAuthorityIssuer,
  capability: QualifiedExecutorAuthorityCapability,
): void {
  const state = readPerformanceReaderState(portValue, issuerValue, capability);
  acknowledgeSchedulerPerformanceRange(state.reader, range);
}
