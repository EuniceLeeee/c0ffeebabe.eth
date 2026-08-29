import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  deepFreeze,
  gitSha40Schema,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import type {
  FinalDurableEventAppendBindingV1,
  FinalDurableWindowBindingV1,
  FinalDurableWindowCapabilityV1,
  FinalDurableWindowDraftV1,
  FinalDurableWindowHeadV1,
  FinalDurableWindowReleaseV1,
  FinalDurableWindowRuntimeAnchorV1,
  FinalDurableWindowServingV1,
  TerminalPhaseHeadObservationV1,
  TerminalPhaseInvalidDraftV1,
  TerminalPhaseInvalidFactV1,
  TerminalPhaseInvalidReasonV1,
} from "../index.ts";

const states = new WeakMap<object, FinalDurableWindowBindingV1>();
const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;

function nonZeroHash(value: unknown, path: string): Hash {
  const decoded = assertHash(value, path);
  if (decoded === ZERO_HASH) throw new TypeError(`${path} must be non-zero`);
  return decoded;
}

function exactRelease(value: FinalDurableWindowReleaseV1): FinalDurableWindowReleaseV1 {
  assertExactKeys(value, ["bindingId", "releaseProvenanceHash", "candidateReleaseCommit"], "finalDurableWindow.release");
  return Object.freeze({
    bindingId: assertHash(value.bindingId, "finalDurableWindow.release.bindingId"),
    releaseProvenanceHash: assertHash(value.releaseProvenanceHash, "finalDurableWindow.release.releaseProvenanceHash"),
    candidateReleaseCommit: gitSha40Schema.decode(value.candidateReleaseCommit, "finalDurableWindow.release.candidateReleaseCommit"),
  });
}

function exactRuntimeAnchor(value: FinalDurableWindowRuntimeAnchorV1): FinalDurableWindowRuntimeAnchorV1 {
  assertExactKeys(value, [
    "kind", "manifestHash", "manifestArtifactSha256", "bindingId", "releaseProvenanceHash",
    "candidateReleaseCommit", "runtimeArtifactRoot", "implementationClosureDigest", "entrypointSha256",
    "nodeExecutableSha256", "bundleModulePath", "bundleModuleSha256", "serviceName", "systemdUnit",
    "bootId", "invocationId", "logDevice", "logInode", "pid", "processStartTicks", "dryRun",
  ], "finalDurableWindow.runtimeAnchor");
  if (value.kind !== "aloha.searcher-runtime-anchor-v1" || value.dryRun !== true) {
    throw new TypeError("final durable window runtime anchor kind/dry-run mismatch");
  }
  const anchor = {
    kind: value.kind,
    manifestHash: assertHash(value.manifestHash, "finalDurableWindow.runtimeAnchor.manifestHash"),
    manifestArtifactSha256: assertHash(value.manifestArtifactSha256, "finalDurableWindow.runtimeAnchor.manifestArtifactSha256"),
    bindingId: assertHash(value.bindingId, "finalDurableWindow.runtimeAnchor.bindingId"),
    releaseProvenanceHash: assertHash(value.releaseProvenanceHash, "finalDurableWindow.runtimeAnchor.releaseProvenanceHash"),
    candidateReleaseCommit: gitSha40Schema.decode(value.candidateReleaseCommit, "finalDurableWindow.runtimeAnchor.candidateReleaseCommit"),
    runtimeArtifactRoot: assertHash(value.runtimeArtifactRoot, "finalDurableWindow.runtimeAnchor.runtimeArtifactRoot"),
    implementationClosureDigest: assertHash(value.implementationClosureDigest, "finalDurableWindow.runtimeAnchor.implementationClosureDigest"),
    entrypointSha256: assertHash(value.entrypointSha256, "finalDurableWindow.runtimeAnchor.entrypointSha256"),
    nodeExecutableSha256: assertHash(value.nodeExecutableSha256, "finalDurableWindow.runtimeAnchor.nodeExecutableSha256"),
    bundleModulePath: assertNonEmptyString(value.bundleModulePath, "finalDurableWindow.runtimeAnchor.bundleModulePath"),
    bundleModuleSha256: assertHash(value.bundleModuleSha256, "finalDurableWindow.runtimeAnchor.bundleModuleSha256"),
    serviceName: assertNonEmptyString(value.serviceName, "finalDurableWindow.runtimeAnchor.serviceName"),
    systemdUnit: assertNonEmptyString(value.systemdUnit, "finalDurableWindow.runtimeAnchor.systemdUnit"),
    bootId: assertNonEmptyString(value.bootId, "finalDurableWindow.runtimeAnchor.bootId"),
    invocationId: assertNonEmptyString(value.invocationId, "finalDurableWindow.runtimeAnchor.invocationId"),
    logDevice: assertDecimalString(value.logDevice, "finalDurableWindow.runtimeAnchor.logDevice"),
    logInode: assertDecimalString(value.logInode, "finalDurableWindow.runtimeAnchor.logInode"),
    pid: assertDecimalString(value.pid, "finalDurableWindow.runtimeAnchor.pid"),
    processStartTicks: assertDecimalString(value.processStartTicks, "finalDurableWindow.runtimeAnchor.processStartTicks"),
    dryRun: true as const,
  };
  return Object.freeze(anchor);
}

function exactServing(value: FinalDurableWindowServingV1): FinalDurableWindowServingV1 {
  assertExactKeys(value, ["generationId", "graphRoot", "readyRecordHash", "sourceCoverageRoot"], "finalDurableWindow.serving");
  return Object.freeze({
    generationId: assertNonEmptyString(value.generationId, "finalDurableWindow.serving.generationId"),
    graphRoot: assertHash(value.graphRoot, "finalDurableWindow.serving.graphRoot"),
    readyRecordHash: assertHash(value.readyRecordHash, "finalDurableWindow.serving.readyRecordHash"),
    sourceCoverageRoot: assertHash(value.sourceCoverageRoot, "finalDurableWindow.serving.sourceCoverageRoot"),
  });
}

function exactHead(value: FinalDurableWindowHeadV1): FinalDurableWindowHeadV1 {
  assertExactKeys(value, ["chainId", "number", "hash", "parentHash", "stateRoot"], "finalDurableWindow.head");
  return Object.freeze({
    chainId: assertDecimalString(value.chainId, "finalDurableWindow.head.chainId"),
    number: assertDecimalString(value.number, "finalDurableWindow.head.number"),
    hash: assertHash(value.hash, "finalDurableWindow.head.hash"),
    parentHash: assertHash(value.parentHash, "finalDurableWindow.head.parentHash"),
    stateRoot: assertHash(value.stateRoot, "finalDurableWindow.head.stateRoot"),
  });
}

function exactAppend(value: FinalDurableEventAppendBindingV1, path: string): FinalDurableEventAppendBindingV1 {
  assertExactKeys(value, ["namespace", "sequence", "eventId", "contentSha256", "byteLength", "offsetStart", "offsetEnd"], path);
  const byteLength = assertDecimalString(value.byteLength, `${path}.byteLength`);
  const offsetStart = assertDecimalString(value.offsetStart, `${path}.offsetStart`);
  const offsetEnd = assertDecimalString(value.offsetEnd, `${path}.offsetEnd`);
  if (BigInt(offsetEnd) - BigInt(offsetStart) !== BigInt(byteLength)) {
    throw new TypeError(`${path} byte interval mismatch`);
  }
  return Object.freeze({
    namespace: assertNonEmptyString(value.namespace, `${path}.namespace`),
    sequence: assertDecimalString(value.sequence, `${path}.sequence`),
    eventId: assertHash(value.eventId, `${path}.eventId`),
    contentSha256: assertHash(value.contentSha256, `${path}.contentSha256`),
    byteLength,
    offsetStart,
    offsetEnd,
  });
}

function exactDraft(value: FinalDurableWindowDraftV1): FinalDurableWindowDraftV1 {
  assertExactKeys(value, [
    "release", "runtimeAnchor", "serving", "windowId", "targetCount", "ordinal", "head", "revision",
    "terminalId", "terminalBindingRoot", "performanceFactStatus", "performanceAppend", "producerTerminalAppend",
  ], "finalDurableWindow");
  if (value.targetCount !== "100" || value.ordinal !== "100") {
    throw new TypeError("final durable window is not the exact 100-head performance denominator");
  }
  if (value.performanceFactStatus !== "complete" && value.performanceFactStatus !== "incomplete") {
    throw new TypeError("final durable window performance fact status is invalid");
  }
  const release = exactRelease(value.release);
  const runtimeAnchor = exactRuntimeAnchor(value.runtimeAnchor);
  if (runtimeAnchor.bindingId !== release.bindingId
    || runtimeAnchor.releaseProvenanceHash !== release.releaseProvenanceHash
    || runtimeAnchor.candidateReleaseCommit !== release.candidateReleaseCommit) {
    throw new TypeError("final durable window runtime/release lineage mismatch");
  }
  return deepFreeze({
    release,
    runtimeAnchor,
    serving: exactServing(value.serving),
    windowId: assertHash(value.windowId, "finalDurableWindow.windowId"),
    targetCount: "100" as const,
    ordinal: "100" as const,
    head: exactHead(value.head),
    revision: assertDecimalString(value.revision, "finalDurableWindow.revision"),
    terminalId: assertHash(value.terminalId, "finalDurableWindow.terminalId"),
    terminalBindingRoot: assertHash(value.terminalBindingRoot, "finalDurableWindow.terminalBindingRoot"),
    performanceFactStatus: value.performanceFactStatus,
    performanceAppend: exactAppend(value.performanceAppend, "finalDurableWindow.performanceAppend"),
    producerTerminalAppend: exactAppend(value.producerTerminalAppend, "finalDurableWindow.producerTerminalAppend"),
  });
}

/** Owner-only issuer. Production evidence calls this only after exact durable
 * replay has reconstructed and verified both append records. */
export function issueFinalDurableWindowCapabilityV1(
  input: FinalDurableWindowDraftV1,
): FinalDurableWindowCapabilityV1 {
  const draft = exactDraft(input);
  const finalDurableWindowId = hashDomain(
    "aloha/final-durable-window/v1",
    draft as unknown as CanonicalJson,
  );
  const binding = deepFreeze({
    kind: "aloha.final-durable-window-binding-v1" as const,
    finalDurableWindowId,
    ...draft,
  });
  const capability = Object.freeze(Object.create(null)) as FinalDurableWindowCapabilityV1;
  states.set(capability, binding);
  return capability;
}

export function readFinalDurableWindowBindingCapabilityV1(
  capability: FinalDurableWindowCapabilityV1,
): FinalDurableWindowBindingV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("final durable window capability is invalid");
  }
  const binding = states.get(capability);
  if (binding === undefined) throw new TypeError("final durable window capability was not owner-issued");
  const { kind: _kind, finalDurableWindowId, ...draft } = binding;
  if (finalDurableWindowId !== hashDomain("aloha/final-durable-window/v1", draft as unknown as CanonicalJson)) {
    throw new TypeError("final durable window identity mismatch");
  }
  return binding;
}

function exactTerminalPhaseObservation(
  value: TerminalPhaseHeadObservationV1,
  path: string,
): TerminalPhaseHeadObservationV1 {
  assertExactKeys(value, ["head", "journalEpoch", "canonicalJournalRoot", "observedMonotonicNs", "observationId"], path);
  const head = exactHead(value.head);
  for (const [field, hash] of [["hash", head.hash], ["parentHash", head.parentHash], ["stateRoot", head.stateRoot]] as const) {
    nonZeroHash(hash, `${path}.head.${field}`);
  }
  const observation = Object.freeze({
    head,
    journalEpoch: assertDecimalString(value.journalEpoch, `${path}.journalEpoch`),
    canonicalJournalRoot: nonZeroHash(value.canonicalJournalRoot, `${path}.canonicalJournalRoot`),
    observedMonotonicNs: assertDecimalString(value.observedMonotonicNs, `${path}.observedMonotonicNs`),
  });
  const observationId = nonZeroHash(value.observationId, `${path}.observationId`);
  if (observationId !== hashDomain("aloha/searcher-terminal-phase-head-observation/v1", observation as unknown as CanonicalJson)) {
    throw new TypeError(`${path}.observationId mismatch`);
  }
  return Object.freeze({ ...observation, observationId });
}

function exactTerminalPhaseInvalidDraft(
  value: TerminalPhaseInvalidDraftV1,
): TerminalPhaseInvalidDraftV1 {
  assertExactKeys(value, ["finalDurableWindowId", "reasonCode", "observed", "recordedMonotonicNs"], "terminalPhaseInvalid");
  const reasonCode: TerminalPhaseInvalidReasonV1 = value.reasonCode;
  if (reasonCode !== "terminal-phase-process-anchor-changed"
    && reasonCode !== "terminal-phase-current-source-moved") {
    throw new TypeError("terminalPhaseInvalid.reasonCode is invalid");
  }
  const observed = value.observed === null
    ? null
    : exactTerminalPhaseObservation(value.observed, "terminalPhaseInvalid.observed");
  if ((reasonCode === "terminal-phase-process-anchor-changed") !== (observed === null)) {
    throw new TypeError("terminalPhaseInvalid.observed does not match reasonCode");
  }
  return deepFreeze({
    finalDurableWindowId: nonZeroHash(value.finalDurableWindowId, "terminalPhaseInvalid.finalDurableWindowId"),
    reasonCode,
    observed,
    recordedMonotonicNs: assertDecimalString(value.recordedMonotonicNs, "terminalPhaseInvalid.recordedMonotonicNs"),
  });
}

export function createTerminalPhaseHeadObservationV1(
  input: Omit<TerminalPhaseHeadObservationV1, "observationId">,
): TerminalPhaseHeadObservationV1 {
  assertExactKeys(input, ["head", "journalEpoch", "canonicalJournalRoot", "observedMonotonicNs"], "terminalPhaseObservation");
  const head = exactHead(input.head);
  for (const [field, hash] of [["hash", head.hash], ["parentHash", head.parentHash], ["stateRoot", head.stateRoot]] as const) {
    nonZeroHash(hash, `terminalPhaseObservation.head.${field}`);
  }
  const observation = deepFreeze({
    head,
    journalEpoch: assertDecimalString(input.journalEpoch, "terminalPhaseObservation.journalEpoch"),
    canonicalJournalRoot: nonZeroHash(input.canonicalJournalRoot, "terminalPhaseObservation.canonicalJournalRoot"),
    observedMonotonicNs: assertDecimalString(input.observedMonotonicNs, "terminalPhaseObservation.observedMonotonicNs"),
  });
  return deepFreeze({
    ...observation,
    observationId: hashDomain("aloha/searcher-terminal-phase-head-observation/v1", observation as unknown as CanonicalJson),
  });
}

export function createTerminalPhaseInvalidFactV1(
  input: TerminalPhaseInvalidDraftV1,
): TerminalPhaseInvalidFactV1 {
  const draft = exactTerminalPhaseInvalidDraft(input);
  return deepFreeze({
    kind: "aloha.terminal-phase-invalid-v1" as const,
    factId: hashDomain("aloha/searcher-terminal-phase-invalid/v1", {
      kind: "aloha.terminal-phase-invalid-v1",
      ...draft,
    } as unknown as CanonicalJson),
    ...draft,
  });
}

export function decodeTerminalPhaseInvalidFactCapabilityV1(
  value: unknown,
): TerminalPhaseInvalidFactV1 {
  if (value === null || typeof value !== "object") throw new TypeError("terminalPhaseInvalid must be an object");
  const record = value as TerminalPhaseInvalidFactV1;
  assertExactKeys(record, ["kind", "factId", "finalDurableWindowId", "reasonCode", "observed", "recordedMonotonicNs"], "terminalPhaseInvalid");
  if (record.kind !== "aloha.terminal-phase-invalid-v1") throw new TypeError("terminalPhaseInvalid.kind is invalid");
  const expected = createTerminalPhaseInvalidFactV1({
    finalDurableWindowId: record.finalDurableWindowId,
    reasonCode: record.reasonCode,
    observed: record.observed,
    recordedMonotonicNs: record.recordedMonotonicNs,
  });
  if (nonZeroHash(record.factId, "terminalPhaseInvalid.factId") !== expected.factId) {
    throw new TypeError("terminalPhaseInvalid.factId mismatch");
  }
  return expected;
}
