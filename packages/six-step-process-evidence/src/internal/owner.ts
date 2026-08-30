import {
  assertDecimalString,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalBytes,
  deepFreeze,
  encodeCanonicalBytes,
  gitSha40Schema,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import type { DurableAppendReceipt } from "../../../durable-store/src/index.ts";
import type {
  RuntimeReleasePerformanceHeadFactsV1,
} from "../../../runtime-release-authority/src/performance-runtime-consumer.ts";
import {
  readRuntimeReleaseSixStepTerminalBindingV1,
  type RuntimeReleaseSixStepTerminalBindingCapabilityV1,
  type RuntimeReleaseSixStepTerminalBindingV1,
} from "../../../runtime-release-authority/src/six-step-terminal-consumer.ts";
import { hashProcessLogAnchor } from "../../../../specs/performance/src/index.ts";
import {
  readSearcherProductionSixStepCompleteAppendMaterialV1,
  type SearcherProductionSixStepCompleteAppendCapabilityV1,
  type SearcherProductionSelectedStage12FactsV1,
} from "./complete-append-owner.ts";

const PERFORMANCE_NAMESPACE = "searcher-production-evidence/performance/v1";
const PRODUCER_TERMINAL_NAMESPACE = "searcher-production-evidence/producer-terminals/v1";

export type SearcherProductionSixStepProcessCapabilityV1 = object;

/** Neutral process identity projection. The app's runtime anchor receipt is
 * structurally compatible, but this owner never imports an app module. */
export interface SixStepRuntimeAnchorV1 {
  readonly kind: "aloha.searcher-runtime-anchor-v1";
  readonly manifestHash: Hash;
  readonly manifestArtifactSha256: Hash;
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidateReleaseCommit: string;
  readonly runtimeArtifactRoot: Hash;
  readonly implementationClosureDigest: Hash;
  readonly entrypointSha256: Hash;
  readonly nodeExecutableSha256: Hash;
  readonly bundleModulePath: string;
  readonly bundleModuleSha256: Hash;
  readonly serviceName: string;
  readonly systemdUnit: string;
  readonly bootId: string;
  readonly invocationId: string;
  readonly logDevice: string;
  readonly logInode: string;
  readonly pid: string;
  readonly processStartTicks: string;
  readonly dryRun: true;
}

export interface SearcherProductionSixStepSchedulerJoinV1 {
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly source: RuntimeReleaseSixStepTerminalBindingV1["currentSource"];
  readonly programHash: Hash;
  readonly finalSimulationReceiptHash: Hash;
  readonly unsignedDryRunCandidateId: Hash;
  readonly unsignedDryRunLineageHash: Hash;
}

export interface SearcherProductionSixStepProcessEvidenceV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.searcher-production-six-step-process-evidence-v1";
  readonly runtimeBindingId: Hash;
  readonly candidateReleaseCommit: string;
  readonly releaseProvenanceHash: Hash;
  readonly terminalBindingRoot: Hash;
  readonly traceRoot: Hash;
  readonly correlationId: Hash;
  readonly generationId: string;
  readonly readyRecordHash: Hash;
  readonly graphRoot: Hash;
  readonly currentSource: RuntimeReleaseSixStepTerminalBindingV1["currentSource"];
  readonly programHash: Hash;
  readonly finalSimulationReceiptHash: Hash;
  readonly stage12: SearcherProductionSelectedStage12FactsV1;
  readonly stage12Root: Hash;
  readonly sixStepLineageRoot: Hash;
  readonly runtimeFacts: RuntimeReleasePerformanceHeadFactsV1;
  readonly runtimeFactsRoot: Hash;
  readonly producerSchedulerJoin: SearcherProductionSixStepSchedulerJoinV1;
  readonly producerSchedulerJoinRoot: Hash;
  readonly runtimeAnchor: SixStepRuntimeAnchorV1;
  readonly runtimeAnchorRoot: Hash;
  readonly serving: Readonly<{
    readonly generationId: string;
    readonly graphRoot: Hash;
    readonly readyRecordHash: Hash;
    readonly sourceCoverageRoot: Hash;
  }>;
  readonly canonicalHead: Readonly<{
    readonly chainId: string;
    readonly number: string;
    readonly hash: Hash;
    readonly parentHash: Hash;
    readonly stateRoot: Hash;
  }>;
  readonly admissionId: Hash;
  readonly producerTerminalId: Hash;
  readonly producerTerminalBindingRoot: Hash;
  readonly durableAppend: DurableAppendReceipt;
  readonly durableAppendRecordId: Hash;
  readonly producerTerminalDurableAppend: DurableAppendReceipt;
  readonly producerTerminalDurableAppendRecordId: Hash;
  readonly evidenceRoot: Hash;
}

export interface SearcherProductionSixStepProcessIssueInputV1 {
  readonly terminalBinding: RuntimeReleaseSixStepTerminalBindingCapabilityV1;
  readonly completeAppend: SearcherProductionSixStepCompleteAppendCapabilityV1;
}

const capabilities = new WeakMap<object, SearcherProductionSixStepProcessEvidenceV1>();
const consumedTerminals = new WeakSet<object>();

function canonicalSnapshot<T>(value: T, path: string): T {
  try {
    return deepFreeze(decodeCanonicalBytes(encodeCanonicalBytes(value))) as T;
  } catch (error) {
    throw new TypeError(`${path} is not canonical: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sameSource(
  left: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: string; readonly stateRoot: string }>,
  right: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: string; readonly stateRoot: string }>,
): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function appendRecordId(append: DurableAppendReceipt): Hash {
  return hashDomain("aloha/searcher-production-six-step-durable-append/v1", {
    namespace: append.namespace,
    sequence: append.sequence,
    eventId: append.eventId,
    contentSha256: append.contentSha256,
    byteLength: append.byteLength,
    offsetStart: append.offsetStart,
    offsetEnd: append.offsetEnd,
    fsynced: append.fsynced,
  });
}

function exactAppend(value: DurableAppendReceipt, namespace: string): DurableAppendReceipt {
  if (value === null || typeof value !== "object" || value.fsynced !== true) {
    throw new TypeError("Six-Step process evidence requires a real fsynced durable append");
  }
  if (value.namespace !== namespace) throw new TypeError("Six-Step process evidence durable namespace mismatch");
  const sequence = assertDecimalString(value.sequence, "sixStepProcess.durableAppend.sequence");
  const byteLength = assertDecimalString(value.byteLength, "sixStepProcess.durableAppend.byteLength");
  const offsetStart = assertDecimalString(value.offsetStart, "sixStepProcess.durableAppend.offsetStart");
  const offsetEnd = assertDecimalString(value.offsetEnd, "sixStepProcess.durableAppend.offsetEnd");
  if (BigInt(byteLength) <= 0n || BigInt(offsetEnd) <= BigInt(offsetStart)) {
    throw new TypeError("Six-Step process evidence durable append interval is invalid");
  }
  return Object.freeze({
    namespace,
    sequence,
    eventId: assertHash(value.eventId, "sixStepProcess.durableAppend.eventId"),
    contentSha256: assertHash(value.contentSha256, "sixStepProcess.durableAppend.contentSha256"),
    byteLength,
    offsetStart,
    offsetEnd,
    fsynced: true as const,
  });
}

function exactRuntimeAnchor(
  value: SixStepRuntimeAnchorV1,
  terminal: RuntimeReleaseSixStepTerminalBindingV1,
): SixStepRuntimeAnchorV1 {
  const anchor = canonicalSnapshot(value, "sixStepProcess.runtimeAnchor");
  if (anchor.kind !== "aloha.searcher-runtime-anchor-v1"
    || anchor.bindingId !== terminal.runtimeBindingId
    || anchor.releaseProvenanceHash !== terminal.releaseProvenanceHash
    || anchor.candidateReleaseCommit !== terminal.candidateReleaseCommit
    || anchor.dryRun !== true) {
    throw new TypeError("Six-Step process runtime anchor release mismatch");
  }
  assertDecimalString(anchor.pid, "sixStepProcess.runtimeAnchor.pid");
  assertDecimalString(anchor.processStartTicks, "sixStepProcess.runtimeAnchor.processStartTicks");
  assertDecimalString(anchor.logDevice, "sixStepProcess.runtimeAnchor.logDevice");
  assertDecimalString(anchor.logInode, "sixStepProcess.runtimeAnchor.logInode");
  assertNonEmptyString(anchor.bootId, "sixStepProcess.runtimeAnchor.bootId");
  assertNonEmptyString(anchor.invocationId, "sixStepProcess.runtimeAnchor.invocationId");
  gitSha40Schema.decode(anchor.candidateReleaseCommit, "sixStepProcess.runtimeAnchor.candidateReleaseCommit");
  return anchor;
}

function selectedSchedulerJoin(
  facts: RuntimeReleasePerformanceHeadFactsV1,
  join: SearcherProductionSixStepSchedulerJoinV1,
  terminal: RuntimeReleaseSixStepTerminalBindingV1,
  runtimeAnchor: SixStepRuntimeAnchorV1,
  admissionId: Hash,
): void {
  const selected = facts.selectedSchedulerCompletion;
  const bootIdHash = hashDomain("aloha/searcher-runtime-boot-id/v1", runtimeAnchor.bootId);
  const expectedProcessLogAnchorHash = hashProcessLogAnchor({
    commitSha: runtimeAnchor.candidateReleaseCommit,
    executableHash: runtimeAnchor.entrypointSha256,
    pid: runtimeAnchor.pid,
    processStartTicks: runtimeAnchor.processStartTicks,
    bootIdHash,
    logSystemId: `${runtimeAnchor.serviceName}/${runtimeAnchor.systemdUnit}`,
    logBootIdHash: bootIdHash,
    logDevice: runtimeAnchor.logDevice,
    logInode: runtimeAnchor.logInode,
  });
  if (selected === null
    || selected.outcome !== "completed"
    || selected.work.phase !== "final-sim"
    || selected.work.workClassRef !== "qualified-revm-final-simulation-v1"
    || selected.work.lane !== "final-sim"
    || selected.work.resource !== "final-sim"
    || !facts.schedulerCompletions.some(value => value.completionId === selected.completionId)
    || facts.resource.scope.processLogAnchorHash !== expectedProcessLogAnchorHash
    || facts.resource.scope.admissionId !== admissionId
    || facts.resource.scope.generationId !== terminal.generationId
    || join.correlationId !== terminal.correlationId
    || join.generationId !== terminal.generationId
    || !sameSource(join.source, terminal.currentSource)
    || join.programHash !== terminal.programHash
    || join.finalSimulationReceiptHash !== terminal.finalSimulationReceiptHash
    || join.unsignedDryRunCandidateId !== terminal.routeCandidateId
    || join.unsignedDryRunLineageHash !== terminal.terminalLineageHash) {
    throw new TypeError("Six-Step process scheduler/terminal join mismatch");
  }
}

/** Internal production owner only. Public app surfaces export the reader, never this issuer. */
export function issueSearcherProductionSixStepProcessEvidenceV1(
  input: SearcherProductionSixStepProcessIssueInputV1,
): SearcherProductionSixStepProcessCapabilityV1 {
  if (input === null || typeof input !== "object") throw new TypeError("Six-Step process evidence input is required");
  if (input.terminalBinding === null || typeof input.terminalBinding !== "object") throw new TypeError("Six-Step terminal binding is required");
  if (consumedTerminals.has(input.terminalBinding)) throw new TypeError("Six-Step process evidence was already issued for this terminal");
  const complete = readSearcherProductionSixStepCompleteAppendMaterialV1(input.completeAppend);
  const terminal = readRuntimeReleaseSixStepTerminalBindingV1(input.terminalBinding);
  const stage12 = canonicalSnapshot(complete.stage12, "sixStepProcess.stage12");
  const runtimeFacts = canonicalSnapshot(complete.runtimeFacts, "sixStepProcess.runtimeFacts");
  const producerSchedulerJoin = canonicalSnapshot(complete.producerSchedulerJoin, "sixStepProcess.producerSchedulerJoin");
  const runtimeAnchor = exactRuntimeAnchor(complete.runtimeAnchor, terminal);
  const serving = canonicalSnapshot(complete.serving, "sixStepProcess.serving");
  const canonicalHead = canonicalSnapshot(complete.canonicalHead, "sixStepProcess.canonicalHead");
  const durableAppend = exactAppend(complete.durableAppend, PERFORMANCE_NAMESPACE);
  const producerTerminalDurableAppend = exactAppend(complete.producerTerminalDurableAppend, PRODUCER_TERMINAL_NAMESPACE);
  if (stage12.binding.readyRecordHash !== terminal.readyRecordHash
    || stage12.binding.generationId !== terminal.generationId
    || stage12.binding.graphRoot !== terminal.graphRoot
    || stage12.binding.definitionCatalogRoot !== terminal.definitionCatalogRoot
    || stage12.binding.releaseProvenanceHash !== terminal.releaseProvenanceHash
    || serving.readyRecordHash !== terminal.readyRecordHash
    || serving.generationId !== terminal.generationId
    || serving.graphRoot !== terminal.graphRoot
    || !sameSource(canonicalHead, terminal.currentSource)) {
    throw new TypeError("Six-Step process Stage1/2/serving/head join mismatch");
  }
  const admissionId = assertHash(complete.admissionId, "sixStepProcess.admissionId");
  selectedSchedulerJoin(runtimeFacts, producerSchedulerJoin, terminal, runtimeAnchor, admissionId);
  const stage12Root = hashDomain("aloha/searcher-production-evidence-stage12/v1", stage12 as unknown as CanonicalJson);
  const sixStepLineageRoot = hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", {
    stage12Root,
    stage36Root: terminal.traceRoot,
  });
  const runtimeFactsRoot = hashDomain("aloha/searcher-production-six-step-runtime-facts/v1", runtimeFacts as unknown as CanonicalJson);
  const producerSchedulerJoinRoot = hashDomain("aloha/searcher-production-six-step-producer-scheduler-join/v1", producerSchedulerJoin as unknown as CanonicalJson);
  const runtimeAnchorRoot = hashDomain("aloha/searcher-production-six-step-runtime-anchor/v1", runtimeAnchor as unknown as CanonicalJson);
  const durableAppendRecordId = appendRecordId(durableAppend);
  const producerTerminalDurableAppendRecordId = appendRecordId(producerTerminalDurableAppend);
  const payload = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.searcher-production-six-step-process-evidence-v1" as const,
    runtimeBindingId: terminal.runtimeBindingId,
    candidateReleaseCommit: terminal.candidateReleaseCommit,
    releaseProvenanceHash: terminal.releaseProvenanceHash,
    terminalBindingRoot: terminal.bindingRoot,
    traceRoot: terminal.traceRoot,
    correlationId: terminal.correlationId,
    generationId: terminal.generationId,
    readyRecordHash: terminal.readyRecordHash,
    graphRoot: terminal.graphRoot,
    currentSource: terminal.currentSource,
    programHash: terminal.programHash,
    finalSimulationReceiptHash: terminal.finalSimulationReceiptHash,
    stage12,
    stage12Root,
    sixStepLineageRoot,
    runtimeFacts,
    runtimeFactsRoot,
    producerSchedulerJoin,
    producerSchedulerJoinRoot,
    runtimeAnchor,
    runtimeAnchorRoot,
    serving,
    canonicalHead,
    admissionId,
    producerTerminalId: assertHash(complete.producerTerminalId, "sixStepProcess.producerTerminalId"),
    producerTerminalBindingRoot: assertHash(complete.producerTerminalBindingRoot, "sixStepProcess.producerTerminalBindingRoot"),
    durableAppend,
    durableAppendRecordId,
    producerTerminalDurableAppend,
    producerTerminalDurableAppendRecordId,
  });
  const evidence = deepFreeze({
    ...payload,
    evidenceRoot: hashDomain("aloha/searcher-production-six-step-process-evidence/v1", payload as unknown as CanonicalJson),
  });
  const capability = Object.freeze(Object.create(null)) as SearcherProductionSixStepProcessCapabilityV1;
  capabilities.set(capability, evidence);
  consumedTerminals.add(input.terminalBinding);
  return capability;
}

export function readSearcherProductionSixStepProcessEvidenceCapabilityV1(
  capability: SearcherProductionSixStepProcessCapabilityV1,
): SearcherProductionSixStepProcessEvidenceV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("Six-Step process evidence capability is invalid");
  }
  const evidence = capabilities.get(capability);
  if (evidence === undefined) throw new TypeError("Six-Step process evidence capability was not issued");
  const { evidenceRoot: _evidenceRoot, ...payload } = evidence;
  if (evidence.evidenceRoot !== hashDomain("aloha/searcher-production-six-step-process-evidence/v1", payload as unknown as CanonicalJson)
    || evidence.durableAppend.fsynced !== true
    || evidence.durableAppendRecordId !== appendRecordId(evidence.durableAppend)
    || evidence.producerTerminalDurableAppend.fsynced !== true
    || evidence.producerTerminalDurableAppendRecordId !== appendRecordId(evidence.producerTerminalDurableAppend)) {
    throw new TypeError("Six-Step process evidence identity mismatch");
  }
  return evidence;
}
