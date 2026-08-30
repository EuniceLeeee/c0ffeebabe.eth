import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  decodeCanonicalBytes,
  deepFreeze,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import {
  readDurableAppendCapabilityV1,
  type DurableAppendCapabilityV1,
  type DurableAppendReceipt,
} from "../../../durable-store/src/index.ts";
import {
  readIssuedProducerHeadFactsCapabilityV1,
  readIssuedProducerHeadTerminalCapabilityV1,
  readIssuedProducerLaneFactsV1,
  readIssuedProducerLaneSearchTerminalCapabilityV1,
  producerHeadFactsRootV1,
  type ProducerHeadTerminalCapabilityV1,
} from "../../../producer/src/index.ts";
import {
  readIssuedSearchTerminalCapabilityV1,
  readIssuedSearchTerminalSchedulerResourceJoinV1,
  readIssuedSearchTerminalSixStepTraceV1,
  type SearchTerminalCapabilityV1,
  type SearchTerminalSixStepTraceV1,
} from "../../../search-pipeline/src/index.ts";
import type {
  ReadyStage12EvidenceBindingV1,
  ReadyStage12EvidenceSnapshotV1,
} from "../../../checkpoint/src/index.ts";
import {
  assertIssuedRuntimeReleasePerformanceRuntimeService,
  type RuntimeReleasePerformanceHeadClaimCapabilityV1,
  type RuntimeReleasePerformanceHeadFactsV1,
  type RuntimeReleasePerformanceRuntimeServiceV1,
} from "../../../runtime-release-authority/src/performance-runtime-consumer.ts";
import {
  assertIssuedStartupRuntime,
  readStartupStage12Evidence,
  verifyStartupStage12Evidence,
  type StartupRuntimeV1,
} from "../../../startup-runtime/src/index.ts";
import type {
  SearcherProductionSixStepSchedulerJoinV1,
  SixStepRuntimeAnchorV1,
} from "./owner.ts";

const EVENT_KIND = "aloha.searcher-production-evidence-event";
const PERFORMANCE_NAMESPACE = "searcher-production-evidence/performance/v1";
const PRODUCER_TERMINAL_NAMESPACE = "searcher-production-evidence/producer-terminals/v1";

export type SearcherProductionSixStepPerformanceAppendCapabilityV1 = object;
export type SearcherProductionSixStepCompleteAppendCapabilityV1 = object;

export interface SearcherProductionSelectedStage12ParentV1 {
  readonly edgeId: Hash;
  readonly selectedLegRoot: Hash;
  readonly stage1EventId: Hash;
  readonly stage1ArtifactSetRoot: Hash;
  readonly stage2EventId: Hash;
  readonly stage2ArtifactSetRoot: Hash;
  readonly instancePublicationRoot: Hash;
  readonly edgeContentRoot: Hash;
}

export interface SearcherProductionSelectedStage12FactsV1 {
  readonly binding: ReadyStage12EvidenceBindingV1;
  readonly selectedParents: readonly SearcherProductionSelectedStage12ParentV1[];
  readonly stage3EventId: Hash;
  readonly stage3ArtifactSetRoot: Hash;
}

export interface SearcherProductionSixStepCompleteAppendIssueInputV1 {
  readonly startup: StartupRuntimeV1;
  readonly performanceRuntime: RuntimeReleasePerformanceRuntimeServiceV1;
  readonly performanceClaim: RuntimeReleasePerformanceHeadClaimCapabilityV1;
  readonly headTerminalCapability: ProducerHeadTerminalCapabilityV1;
  readonly durableAppend: DurableAppendCapabilityV1;
}

export interface SearcherProductionSixStepCompleteAppendFinalizeInputV1 {
  readonly performanceAppend: SearcherProductionSixStepPerformanceAppendCapabilityV1;
  readonly headTerminalCapability: ProducerHeadTerminalCapabilityV1;
  readonly producerTerminalAppend: DurableAppendCapabilityV1;
}

export interface SearcherProductionSixStepCompleteAppendMaterialV1 {
  readonly searchTerminalCapability: SearchTerminalCapabilityV1;
  readonly stage12: SearcherProductionSelectedStage12FactsV1;
  readonly runtimeFacts: RuntimeReleasePerformanceHeadFactsV1;
  readonly producerSchedulerJoin: SearcherProductionSixStepSchedulerJoinV1;
  readonly runtimeAnchor: SixStepRuntimeAnchorV1;
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
  readonly ordinal: string;
  readonly lane: "blockscan" | "backrun";
  readonly candidateStableKey: Hash;
  readonly producerTerminalId: Hash;
  readonly producerTerminalBindingRoot: Hash;
  readonly durableAppend: DurableAppendReceipt;
  readonly producerTerminalDurableAppend: DurableAppendReceipt;
}

interface CapabilityStateV1 {
  readonly material: SearcherProductionSixStepCompleteAppendMaterialV1;
  readonly eventContentSha256: Hash;
  readonly eventId: Hash;
}

interface PerformanceCapabilityStateV1 {
  readonly headTerminalCapability: ProducerHeadTerminalCapabilityV1;
  readonly material: Omit<SearcherProductionSixStepCompleteAppendMaterialV1, "producerTerminalDurableAppend">;
  readonly eventContentSha256: Hash;
  readonly eventId: Hash;
  consumed: boolean;
}

const performanceStates = new WeakMap<object, PerformanceCapabilityStateV1>();
const states = new WeakMap<object, CapabilityStateV1>();
const performanceByHeadTerminal = new WeakMap<object, SearcherProductionSixStepPerformanceAppendCapabilityV1>();
const byHeadTerminal = new WeakMap<object, SearcherProductionSixStepCompleteAppendCapabilityV1>();

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    return Buffer.compare(Buffer.from(encodeCanonicalBytes(left)), Buffer.from(encodeCanonicalBytes(right))) === 0;
  } catch {
    return false;
  }
}

function positiveHash(value: unknown, path: string): Hash {
  const hash = assertHash(value, path);
  if (/^0x0{64}$/.test(hash)) throw new TypeError(`${path} must be non-zero`);
  return hash;
}

function exactSelectedStage12Facts(
  value: unknown,
  startup: ReadyStage12EvidenceSnapshotV1,
  trace: SearchTerminalSixStepTraceV1,
): SearcherProductionSelectedStage12FactsV1 {
  const stage12 = record(value, "sixStepCompleteAppend.sixStepFacts.stage12");
  assertExactKeys(stage12, ["binding", "selectedParents", "stage3EventId", "stage3ArtifactSetRoot"], "sixStepCompleteAppend.sixStepFacts.stage12");
  if (!sameCanonical(stage12.binding, startup.binding)) {
    throw new TypeError("Six-Step selected Stage1/2 binding does not match the Checkpoint snapshot");
  }
  if (!Array.isArray(stage12.selectedParents)
    || stage12.selectedParents.length !== trace.selectedGraphLegs.length
    || stage12.selectedParents.length < 2) {
    throw new TypeError("Six-Step selected Stage1/2 parent denominator mismatch");
  }
  const selectedParents = stage12.selectedParents.map((rawParent, index) => {
    const path = `sixStepCompleteAppend.sixStepFacts.stage12.selectedParents[${index}]`;
    const parent = record(rawParent, path);
    assertExactKeys(parent, ["edgeId", "selectedLegRoot", "stage1EventId", "stage1ArtifactSetRoot", "stage2EventId", "stage2ArtifactSetRoot", "instancePublicationRoot", "edgeContentRoot"], path);
    const leg = trace.selectedGraphLegs[index]!;
    const edgeId = positiveHash(parent.edgeId, `${path}.edgeId`);
    const selectedLegRoot = positiveHash(parent.selectedLegRoot, `${path}.selectedLegRoot`);
    if (edgeId !== leg.edgeId
      || selectedLegRoot !== hashDomain("aloha/searcher-production-evidence-selected-graph-leg/v1", leg as unknown as CanonicalJson)) {
      throw new TypeError(`${path} does not bind the retained terminal route leg`);
    }
    return Object.freeze({
      edgeId,
      selectedLegRoot,
      stage1EventId: positiveHash(parent.stage1EventId, `${path}.stage1EventId`),
      stage1ArtifactSetRoot: positiveHash(parent.stage1ArtifactSetRoot, `${path}.stage1ArtifactSetRoot`),
      stage2EventId: positiveHash(parent.stage2EventId, `${path}.stage2EventId`),
      stage2ArtifactSetRoot: positiveHash(parent.stage2ArtifactSetRoot, `${path}.stage2ArtifactSetRoot`),
      instancePublicationRoot: positiveHash(parent.instancePublicationRoot, `${path}.instancePublicationRoot`),
      edgeContentRoot: positiveHash(parent.edgeContentRoot, `${path}.edgeContentRoot`),
    });
  });
  if (new Set(selectedParents.map(parent => parent.edgeId)).size !== selectedParents.length) {
    throw new TypeError("Six-Step selected Stage1/2 parents contain duplicate edges");
  }
  return deepFreeze({
    binding: startup.binding,
    selectedParents: Object.freeze(selectedParents),
    stage3EventId: positiveHash(stage12.stage3EventId, "sixStepCompleteAppend.sixStepFacts.stage12.stage3EventId"),
    stage3ArtifactSetRoot: positiveHash(stage12.stage3ArtifactSetRoot, "sixStepCompleteAppend.sixStepFacts.stage12.stage3ArtifactSetRoot"),
  });
}

function exactAppend(
  value: DurableAppendReceipt,
  namespace: string,
  eventId: Hash,
  contentSha256: Hash,
  sequence: string,
  byteLength: number,
): DurableAppendReceipt {
  if (value === null || typeof value !== "object" || value.fsynced !== true
    || value.namespace !== namespace
    || value.eventId !== eventId
    || value.contentSha256 !== contentSha256
    || value.sequence !== sequence) {
    throw new TypeError("Six-Step complete append is not the exact fsynced performance event");
  }
  const length = assertDecimalString(value.byteLength, "sixStepCompleteAppend.byteLength");
  const offsetStart = assertDecimalString(value.offsetStart, "sixStepCompleteAppend.offsetStart");
  const offsetEnd = assertDecimalString(value.offsetEnd, "sixStepCompleteAppend.offsetEnd");
  if (length !== byteLength.toString()
    || BigInt(offsetEnd) - BigInt(offsetStart) !== BigInt(length)) {
    throw new TypeError("Six-Step complete append byte interval mismatch");
  }
  return Object.freeze({ namespace, sequence, eventId, contentSha256, byteLength: length, offsetStart, offsetEnd, fsynced: true as const });
}

function runtimeFactsWithoutProducerJoin(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  assertExactKeys(value, [
    "schedulerRange", "schedulerCompletions", "selectedSchedulerCompletion", "resource", "producerSchedulerJoin",
  ], "sixStepCompleteAppend.runtimeFacts");
  const { producerSchedulerJoin: _producerSchedulerJoin, ...facts } = value;
  return Object.freeze(facts);
}

function fixedProducerSchedulerJoin(searchTerminalCapability: SearchTerminalCapabilityV1): SearcherProductionSixStepSchedulerJoinV1 {
  const fixed = readIssuedSearchTerminalSchedulerResourceJoinV1(searchTerminalCapability);
  if (fixed === null) throw new TypeError("Six-Step successful search terminal lacks its scheduler join");
  const { schedulerCompletion: _schedulerCompletion, ...wire } = fixed;
  return deepFreeze(wire) as SearcherProductionSixStepSchedulerJoinV1;
}

function eventIdentity(event: Record<string, unknown>): Hash {
  const { eventId: _eventId, ...draft } = event;
  return hashDomain("aloha/searcher-production-evidence-event/v1", draft as CanonicalJson);
}

/**
 * Re-read the active release-owned performance claim and Startup Stage1/2
 * capability, join them to the exact fsynced complete-event bytes, and then
 * perform the claim commit. No receipt or caller-shaped DTO can authorize a
 * process evidence capability.
 */
export async function issueSearcherProductionSixStepPerformanceAppendCapabilityV1(
  input: SearcherProductionSixStepCompleteAppendIssueInputV1,
): Promise<SearcherProductionSixStepPerformanceAppendCapabilityV1> {
  assertIssuedStartupRuntime(input.startup);
  assertIssuedRuntimeReleasePerformanceRuntimeService(input.performanceRuntime);
  if (byHeadTerminal.has(input.headTerminalCapability) || performanceByHeadTerminal.has(input.headTerminalCapability)) {
    throw new TypeError("Producer terminal already has Six-Step append authority");
  }
  const terminalEvidence = readIssuedProducerHeadTerminalCapabilityV1(input.headTerminalCapability);
  if (terminalEvidence.facts === null || terminalEvidence.terminal.status !== "completed") {
    throw new TypeError("Six-Step complete append requires completed Producer head facts");
  }
  const headFacts = readIssuedProducerHeadFactsCapabilityV1(terminalEvidence.facts);
  const retained = headFacts.laneFacts
    .map(laneCapability => Object.freeze({
      lane: readIssuedProducerLaneFactsV1(laneCapability).lane,
      terminal: readIssuedProducerLaneSearchTerminalCapabilityV1(laneCapability),
    }))
    .filter((value): value is Readonly<{ readonly lane: "blockscan" | "backrun"; readonly terminal: SearchTerminalCapabilityV1 }> => value.terminal !== null);
  if (retained.length !== 1) throw new TypeError("Six-Step successful search terminal is not uniquely retained by the Producer head");
  const retainedTerminal = retained[0]!;
  const searchTerminalCapability = retainedTerminal.terminal;
  const searchTerminal = readIssuedSearchTerminalCapabilityV1(searchTerminalCapability);
  if (searchTerminal.kind !== "unsigned-dry-run") throw new TypeError("Six-Step complete append requires the successful search terminal");

  const observedRuntimeFacts = input.performanceRuntime.readClaim(input.performanceClaim);
  const claimBinding = input.performanceRuntime.readClaimBinding(input.performanceClaim);
  const appendRecord = readDurableAppendCapabilityV1(input.durableAppend);
  const bytes = Uint8Array.from(appendRecord.bytes);
  const eventContentSha256 = sha256Hex(bytes);
  const event = record(decodeCanonicalBytes(bytes), "sixStepCompleteAppend.event");
  assertExactKeys(event, ["schemaVersion", "kind", "eventId", "eventType", "sequence", "namespace", "release", "runtimeAnchor", "serving", "payload"], "sixStepCompleteAppend.event");
  if (event.schemaVersion !== 1 || event.kind !== EVENT_KIND || event.eventType !== "performance-facts-complete" || event.namespace !== PERFORMANCE_NAMESPACE) {
    throw new TypeError("Six-Step complete append event kind is invalid");
  }
  const eventId = assertHash(event.eventId, "sixStepCompleteAppend.eventId");
  if (eventId !== eventIdentity(event)) throw new TypeError("Six-Step complete append eventId mismatch");
  const sequence = assertDecimalString(event.sequence, "sixStepCompleteAppend.sequence");
  const durableAppend = exactAppend(appendRecord, PERFORMANCE_NAMESPACE, eventId, eventContentSha256, sequence, bytes.byteLength);

  const release = record(event.release, "sixStepCompleteAppend.release");
  assertExactKeys(release, ["bindingId", "releaseProvenanceHash", "candidateReleaseCommit"], "sixStepCompleteAppend.release");
  const runtimeAnchor = record(event.runtimeAnchor, "sixStepCompleteAppend.runtimeAnchor");
  const serving = record(event.serving, "sixStepCompleteAppend.serving");
  assertExactKeys(serving, ["generationId", "graphRoot", "readyRecordHash", "sourceCoverageRoot"], "sixStepCompleteAppend.serving");
  if (release.bindingId !== input.startup.releaseBindingId
    || release.releaseProvenanceHash !== input.startup.ready.releaseProvenanceHash
    || release.candidateReleaseCommit !== input.startup.candidateReleaseCommit
    || runtimeAnchor.bindingId !== release.bindingId
    || runtimeAnchor.releaseProvenanceHash !== release.releaseProvenanceHash
    || runtimeAnchor.candidateReleaseCommit !== release.candidateReleaseCommit
    || serving.generationId !== input.startup.generationId
    || serving.graphRoot !== input.startup.graphRoot
    || serving.readyRecordHash !== input.startup.ready.readyRecordHash
    || serving.sourceCoverageRoot !== input.startup.ready.sourceCoverageRoot) {
    throw new TypeError("Six-Step complete append release/serving lineage mismatch");
  }

  const payload = record(event.payload, "sixStepCompleteAppend.payload");
  assertExactKeys(payload, ["admissionId", "terminalBindingRoot", "terminalId", "terminalMonotonicNs", "headHash", "sourceCoverageRoot", "candidateSetRoot", "candidateCount", "runtimeFacts", "sixStepFacts", "factStatus"], "sixStepCompleteAppend.payload");
  assertDecimalString(payload.terminalMonotonicNs, "sixStepCompleteAppend.terminalMonotonicNs");
  const admissionId = assertHash(payload.admissionId, "sixStepCompleteAppend.admissionId");
  const expectedHeadFactsRoot = producerHeadFactsRootV1(headFacts);
  const expectedTerminalBindingRoot = hashDomain("aloha/searcher-production-evidence-terminal-binding/v1", { terminalId: terminalEvidence.terminal.terminalId, headFactsRoot: expectedHeadFactsRoot });
  const candidateRefs = [...headFacts.candidateRefs].sort();
  if (new Set(candidateRefs).size !== candidateRefs.length) throw new TypeError("Producer head candidate refs are not unique");
  const expectedCandidateSetRoot = hashDomain("aloha/performance-candidate-set-root/v1", candidateRefs);
  if (payload.factStatus !== "complete"
    || payload.terminalId !== terminalEvidence.terminal.terminalId
    || payload.terminalBindingRoot !== expectedTerminalBindingRoot
    || payload.headHash !== terminalEvidence.terminal.head.hash
    || payload.sourceCoverageRoot !== headFacts.sourceCoverageRoot
    || payload.candidateSetRoot !== expectedCandidateSetRoot
    || payload.candidateCount !== candidateRefs.length.toString()
    || payload.sixStepFacts === null
    || claimBinding.admissionId !== admissionId
    || claimBinding.headHash !== terminalEvidence.terminal.head.hash
    || claimBinding.ordinal !== terminalEvidence.terminal.ordinal
    || claimBinding.revision !== terminalEvidence.terminal.revision
    || claimBinding.terminalId !== terminalEvidence.terminal.terminalId
    || claimBinding.generationId !== terminalEvidence.terminal.generationId
    || claimBinding.graphRoot !== terminalEvidence.terminal.graphRoot
    || claimBinding.readyRecordHash !== serving.readyRecordHash) {
    throw new TypeError("Six-Step complete append payload/Producer claim binding mismatch");
  }

  const runtimeFacts = record(payload.runtimeFacts, "sixStepCompleteAppend.runtimeFacts");
  const producerSchedulerJoin = record(runtimeFacts.producerSchedulerJoin, "sixStepCompleteAppend.producerSchedulerJoin");
  const fixedJoin = fixedProducerSchedulerJoin(searchTerminalCapability);
  if (!sameCanonical(runtimeFactsWithoutProducerJoin(runtimeFacts), observedRuntimeFacts) || !sameCanonical(producerSchedulerJoin, fixedJoin)) {
    throw new TypeError("Six-Step complete append runtime facts are not the active owner-issued claim");
  }

  const sixStepFacts = record(payload.sixStepFacts, "sixStepCompleteAppend.sixStepFacts");
  assertExactKeys(sixStepFacts, ["stage12", "stage36", "stage12Root", "stage36Root", "lineageRoot"], "sixStepCompleteAppend.sixStepFacts");
  const startupStage12 = await readStartupStage12Evidence(input.startup);
  await verifyStartupStage12Evidence(input.startup, startupStage12);
  const retainedTrace = readIssuedSearchTerminalSixStepTraceV1(searchTerminalCapability);
  const stage12 = exactSelectedStage12Facts(sixStepFacts.stage12, startupStage12, retainedTrace);
  const expectedStage12Root = hashDomain("aloha/searcher-production-evidence-stage12/v1", stage12 as unknown as CanonicalJson);
  const expectedLineageRoot = hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", { stage12Root: expectedStage12Root, stage36Root: retainedTrace.traceRoot });
  if (!sameCanonical(sixStepFacts.stage12, stage12)
    || !sameCanonical(sixStepFacts.stage36, retainedTrace)
    || sixStepFacts.stage12Root !== expectedStage12Root
    || sixStepFacts.stage36Root !== retainedTrace.traceRoot
    || sixStepFacts.lineageRoot !== expectedLineageRoot) {
    throw new TypeError("Six-Step complete append Stage1-6 authority mismatch");
  }
  assertHash(terminalEvidence.terminal.head.parentHash, "sixStepCompleteAppend.head.parentHash");

  input.performanceRuntime.commitClaim(input.performanceClaim);
  const material: Omit<SearcherProductionSixStepCompleteAppendMaterialV1, "producerTerminalDurableAppend"> = Object.freeze({
    searchTerminalCapability,
    stage12: deepFreeze(stage12),
    runtimeFacts: deepFreeze(observedRuntimeFacts),
    producerSchedulerJoin: deepFreeze(fixedJoin),
    runtimeAnchor: deepFreeze(event.runtimeAnchor as SixStepRuntimeAnchorV1),
    serving: deepFreeze(event.serving as SearcherProductionSixStepCompleteAppendMaterialV1["serving"]),
    canonicalHead: deepFreeze(terminalEvidence.terminal.head),
    admissionId,
    ordinal: terminalEvidence.terminal.ordinal,
    lane: retainedTerminal.lane,
    candidateStableKey: retainedTrace.resolved.routeCandidateId,
    producerTerminalId: terminalEvidence.terminal.terminalId,
    producerTerminalBindingRoot: expectedTerminalBindingRoot,
    durableAppend,
  });
  const capability = Object.freeze(Object.create(null)) as SearcherProductionSixStepPerformanceAppendCapabilityV1;
  performanceStates.set(capability, { headTerminalCapability: input.headTerminalCapability, material, eventContentSha256, eventId, consumed: false });
  performanceByHeadTerminal.set(input.headTerminalCapability, capability);
  return capability;
}

export function issueSearcherProductionSixStepCompleteAppendCapabilityV1(
  input: SearcherProductionSixStepCompleteAppendFinalizeInputV1,
): SearcherProductionSixStepCompleteAppendCapabilityV1 {
  if (input.performanceAppend === null || typeof input.performanceAppend !== "object" || Reflect.ownKeys(input.performanceAppend).length !== 0) {
    throw new TypeError("Six-Step performance append capability is invalid");
  }
  const pending = performanceStates.get(input.performanceAppend);
  if (pending === undefined || pending.consumed || pending.headTerminalCapability !== input.headTerminalCapability) {
    throw new TypeError("Six-Step performance append capability is stale or belongs to another terminal");
  }
  const terminalEvidence = readIssuedProducerHeadTerminalCapabilityV1(input.headTerminalCapability);
  if (terminalEvidence.facts === null) throw new TypeError("Six-Step Producer terminal facts are missing");
  const headFacts = readIssuedProducerHeadFactsCapabilityV1(terminalEvidence.facts);
  const expectedHeadFactsRoot = producerHeadFactsRootV1(headFacts);
  const expectedTerminalBindingRoot = hashDomain("aloha/searcher-production-evidence-terminal-binding/v1", {
    terminalId: terminalEvidence.terminal.terminalId,
    headFactsRoot: expectedHeadFactsRoot,
  });
  if (expectedTerminalBindingRoot !== pending.material.producerTerminalBindingRoot) {
    throw new TypeError("Six-Step Producer terminal binding changed before final append");
  }
  const recordValue = readDurableAppendCapabilityV1(input.producerTerminalAppend);
  const bytes = Uint8Array.from(recordValue.bytes);
  const contentSha256 = sha256Hex(bytes);
  const event = record(decodeCanonicalBytes(bytes), "sixStepCompleteAppend.producerTerminalEvent");
  assertExactKeys(event, ["schemaVersion", "kind", "eventId", "eventType", "sequence", "namespace", "release", "runtimeAnchor", "serving", "payload"], "sixStepCompleteAppend.producerTerminalEvent");
  if (event.schemaVersion !== 1 || event.kind !== EVENT_KIND || event.eventType !== "producer-terminal" || event.namespace !== PRODUCER_TERMINAL_NAMESPACE) {
    throw new TypeError("Six-Step Producer terminal append event kind is invalid");
  }
  const eventId = assertHash(event.eventId, "sixStepCompleteAppend.producerTerminalEvent.eventId");
  if (eventId !== eventIdentity(event)) throw new TypeError("Six-Step Producer terminal append eventId mismatch");
  const sequence = assertDecimalString(event.sequence, "sixStepCompleteAppend.producerTerminalEvent.sequence");
  const producerTerminalDurableAppend = exactAppend(recordValue, PRODUCER_TERMINAL_NAMESPACE, eventId, contentSha256, sequence, bytes.byteLength);
  const payload = record(event.payload, "sixStepCompleteAppend.producerTerminalEvent.payload");
  assertExactKeys(payload, ["terminalBindingRoot", "terminal", "headFactsRoot"], "sixStepCompleteAppend.producerTerminalEvent.payload");
  if (payload.terminalBindingRoot !== expectedTerminalBindingRoot
    || payload.headFactsRoot !== expectedHeadFactsRoot
    || !sameCanonical(payload.terminal, terminalEvidence.terminal)
    || !sameCanonical(event.release, {
      bindingId: (pending.material.runtimeAnchor as SixStepRuntimeAnchorV1).bindingId,
      releaseProvenanceHash: pending.material.runtimeAnchor.releaseProvenanceHash,
      candidateReleaseCommit: pending.material.runtimeAnchor.candidateReleaseCommit,
    })
    || !sameCanonical(event.runtimeAnchor, pending.material.runtimeAnchor)
    || !sameCanonical(event.serving, pending.material.serving)) {
    throw new TypeError("Six-Step Producer terminal append does not exact-join the performance append");
  }
  const material: SearcherProductionSixStepCompleteAppendMaterialV1 = Object.freeze({
    ...pending.material,
    producerTerminalDurableAppend,
  });
  const capability = Object.freeze(Object.create(null)) as SearcherProductionSixStepCompleteAppendCapabilityV1;
  states.set(capability, Object.freeze({ material, eventContentSha256: contentSha256, eventId }));
  pending.consumed = true;
  performanceByHeadTerminal.delete(input.headTerminalCapability);
  byHeadTerminal.set(input.headTerminalCapability, capability);
  return capability;
}

export function readSearcherProductionSixStepCompleteAppendMaterialV1(
  capability: SearcherProductionSixStepCompleteAppendCapabilityV1,
): SearcherProductionSixStepCompleteAppendMaterialV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) throw new TypeError("Six-Step complete append capability is invalid");
  const state = states.get(capability);
  if (state === undefined) throw new TypeError("Six-Step complete append capability was not issued");
  return state.material;
}
