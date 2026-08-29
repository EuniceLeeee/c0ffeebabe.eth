import {
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type Hash,
  type SchemaManifest,
} from "../../../packages/canonical-codec/src/index.ts";
import { candidateFinalOutcomeHash } from "../../../specs/candidate-final-outcome/src/index.ts";
import {
  decodeRuntimeRestartFacts,
  hashRuntimeCandidateDeltaPartition,
  hashRuntimeCandidateOutcomePartition,
  hashRuntimeFactRefRoot,
  hashRuntimeGraphViewLeaseObservations,
  hashRuntimeHashPartition,
  RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS,
  sealRuntimeFactRef,
  type RuntimeCandidateDeltaPartitionV1,
  type RuntimeCandidateDeltaV1,
  type RuntimeCandidateOutcomeV1,
  type RuntimeFactRefV1,
  type RuntimeGraphViewLeaseObservationV1,
  type RuntimeRestartFactsV1,
} from "../../runtime-acceptance-facts/src/runtime.ts";
import type { RawPerformanceObservationV1 } from "../../../packages/performance-collector/src/raw-sqlite-observer.ts";
import type {
  ObservedRuntimeAcceptanceProcessEventV1,
  RawRuntimeAcceptanceObservationV1,
} from "./raw-runtime-acceptance-observer.ts";
import {
  observeCheckpointRuntimeRestartSnapshotV1,
  type RawCheckpointRestartSnapshotObservationV1,
} from "./raw-checkpoint-restart-observer.ts";
import {
  ContentAddressedObserverSinkV1,
  type ObservedContentArtifactV1,
} from "./content-addressed-sink.ts";

const RAW_CHECKPOINT_SNAPSHOT_SCHEMA = Object.freeze({
  id: "aloha.raw-checkpoint-restart-snapshot",
  version: "1.0.0",
  schemaHash: hashDomain("aloha/schema-definition/v1", {
    id: "aloha.raw-checkpoint-restart-snapshot",
    version: "1.0.0",
    descriptor: { kind: "observer-exact-raw-checkpoint-restart-snapshot" },
  }),
});

function rawObserverSchema(id: string) {
  return Object.freeze({
    id,
    version: "1.0.0",
    schemaHash: hashDomain("aloha/schema-definition/v1", {
      id,
      version: "1.0.0",
      descriptor: { kind: "observer-exact-raw-runtime-restart-material" },
    }),
  });
}

const RAW_PROCESS_OBSERVATION_SCHEMA = rawObserverSchema("aloha.raw-runtime-restart-process-observation");
const RAW_PRODUCER_LEASE_SCHEMA = rawObserverSchema("aloha.raw-runtime-restart-producer-lease-observation");
const RAW_OBSERVATION_CHUNK_SCHEMA = rawObserverSchema("aloha.raw-runtime-restart-observation-chunk");
const RAW_OBSERVATION_CHUNK_BYTES = 24_000;

type RecordValue = Readonly<Record<string, unknown>>;

function bytesHex(bytes: Uint8Array): string {
  let value = "0x";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function checkpointSnapshotArtifact(snapshot: RawCheckpointRestartSnapshotObservationV1): object {
  return Object.freeze({
    ...snapshot,
    rawContents: snapshot.rawContents.map(content => Object.freeze({
      hash: content.hash,
      payloadHash: content.payloadHash,
      kind: content.kind,
      bytesHex: bytesHex(content.bytes),
      references: content.references,
    })),
  });
}

export interface ProductionRuntimeRestartFactsObservationV1 {
  readonly candidateReleaseCommit: string;
  readonly artifacts: readonly ObservedContentArtifactV1[];
  readonly facts: RuntimeRestartFactsV1;
}

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as RecordValue;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function hash(value: unknown, path: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value) || value === `0x${"0".repeat(64)}`) throw new TypeError(`${path} must be a non-zero hash`);
  return value as Hash;
}

function same(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function manifestRef<T>(manifest: SchemaManifest<T>) {
  return Object.freeze({ id: manifest.id, version: manifest.version, schemaHash: manifest.schemaHash });
}

class FactWriterV1 {
  readonly artifacts: ObservedContentArtifactV1[] = [];
  readonly refs = new Map<Hash, RuntimeFactRefV1>();
  readonly sink: ContentAddressedObserverSinkV1;

  constructor(sink: ContentAddressedObserverSinkV1) {
    this.sink = sink;
  }

  async write(payload: unknown, schema: Readonly<{ readonly id: string; readonly version: string; readonly schemaHash: Hash }>): Promise<RuntimeFactRefV1> {
    const artifact = await this.sink.write({ bytes: encodeCanonicalBytes(payload), mediaType: "application/json", schema });
    this.artifacts.push(artifact);
    const ref = sealRuntimeFactRef({
      artifactRefId: artifact.ref.artifactRefId,
      contentSha256: artifact.contentSha256,
      byteLength: artifact.ref.byteLength,
      schema,
      locator: artifact.ref.locator,
    });
    this.refs.set(ref.factId, ref);
    return ref;
  }

  async writeChunked(payload: unknown, schema: Readonly<{ readonly id: string; readonly version: string; readonly schemaHash: Hash }>): Promise<void> {
    const bytes = encodeCanonicalBytes(payload);
    const contentSha256 = sha256Hex(bytes);
    const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / RAW_OBSERVATION_CHUNK_BYTES));
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = bytes.subarray(index * RAW_OBSERVATION_CHUNK_BYTES, Math.min(bytes.byteLength, (index + 1) * RAW_OBSERVATION_CHUNK_BYTES));
      const chunkBytesHex = bytesHex(chunk);
      await this.write(Object.freeze({
        kind: "aloha.raw-runtime-restart-observation-chunk",
        version: "1",
        observationSchema: schema,
        contentSha256,
        byteLength: String(bytes.byteLength),
        chunkIndex: String(index),
        chunkCount: String(chunkCount),
        chunkBytesHex,
      }), RAW_OBSERVATION_CHUNK_SCHEMA);
    }
  }
}

interface SelectedRestartV1 {
  readonly beforeReady: ObservedRuntimeAcceptanceProcessEventV1;
  readonly observed: ObservedRuntimeAcceptanceProcessEventV1;
  readonly drained: ObservedRuntimeAcceptanceProcessEventV1;
  readonly afterReady: ObservedRuntimeAcceptanceProcessEventV1;
}

function selectRestart(events: readonly ObservedRuntimeAcceptanceProcessEventV1[]): SelectedRestartV1 {
  const selected: SelectedRestartV1[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const beforeReady = events[index];
    const observed = events[index + 1];
    const drained = events[index + 2];
    const afterReady = events[index + 3];
    if (beforeReady?.kind !== "aloha.runtime-process-ready"
      || observed?.kind !== "aloha.runtime-sigterm-observed"
      || drained?.kind !== "aloha.runtime-sigterm-drained"
      || afterReady?.kind !== "aloha.runtime-process-ready") continue;
    if (observed.processReadyEventId !== beforeReady.eventId
      || drained.sigtermObservedEventId !== observed.eventId
      || beforeReady.processAnchorHash !== observed.processAnchorHash
      || beforeReady.processAnchorHash !== drained.processAnchorHash
      || beforeReady.processAnchorHash === afterReady.processAnchorHash
      || !same(beforeReady.release, afterReady.release)) continue;
    selected.push({ beforeReady, observed, drained, afterReady });
  }
  if (selected.length !== 1) throw new TypeError(`runtime restart requires exactly one complete child-process lineage, observed ${selected.length}`);
  return selected[0]!;
}

function candidateMap(snapshot: RawCheckpointRestartSnapshotObservationV1 | RecordValue): Map<Hash, RecordValue> {
  const values = "candidates" in snapshot ? array(snapshot.candidates, "restart.candidates") : [];
  return new Map(values.map((value, index) => {
    const candidate = record(value, `restart.candidates[${index}]`);
    return [hash(candidate.familyCandidateKey, `restart.candidates[${index}].familyCandidateKey`), candidate];
  }));
}

function dependencyRoot(candidate: RecordValue, outcome: RecordValue): Hash {
  const publication = outcome.kind === "verified" ? record(outcome.publication, "restartOutcome.publication") : null;
  return hashDomain("aloha/runtime-acceptance/candidate-dependency-closure/v1", {
    familyDefinitionHash: hash(candidate.familyDefinitionHash, "restartCandidate.familyDefinitionHash"),
    candidateSubjectHash: hash(candidate.candidateSubjectHash, "restartCandidate.candidateSubjectHash"),
    candidateEvidenceRoot: hash(candidate.candidateEvidenceRoot, "restartCandidate.candidateEvidenceRoot"),
    requestedArtifactDependencyRoot: publication === null ? null : hash(publication.requestedArtifactDependencyRoot, "restartOutcome.publication.requestedArtifactDependencyRoot"),
    validityDependencyRoot: publication === null ? null : hash(publication.validityDependencyRoot, "restartOutcome.publication.validityDependencyRoot"),
  });
}

function outcomeClass(value: RecordValue): RuntimeCandidateOutcomeV1["outcome"] {
  if (value.kind === "verified") return "verified";
  if (value.kind === "retryable") return "retryable";
  if (value.kind === "chainProvenRejected" || value.kind === "invalidProgram") return "rejected";
  throw new TypeError("runtime restart encountered an unknown durable outcome kind");
}

/** Cross-run comparison uses the Family/result semantic identity.  Durable
 * outcome envelopes intentionally bind run/cutoff/issuer proofs, so their
 * storage hash must change on a legitimate memo reuse and cannot be used as
 * the reuse verdict.  Exact envelope recovery remains independently checked
 * against the raw checkpoint outcome hashes above. */
function semanticOutcomeHash(value: RecordValue): Hash {
  if (value.kind === "verified") {
    const publication = record(value.publication, "restartOutcome.publication");
    return hashDomain("aloha/runtime-acceptance/candidate-semantic-outcome/v1", {
      kind: value.kind,
      instancePublicationHash: hash(publication.instancePublicationHash, "restartOutcome.publication.instancePublicationHash"),
    });
  }
  if (value.kind === "chainProvenRejected") {
    const evidence = record(value.rejectionEvidence, "restartOutcome.rejectionEvidence");
    return hashDomain("aloha/runtime-acceptance/candidate-semantic-outcome/v1", {
      kind: value.kind,
      evidenceBundleRoot: hash(evidence.evidenceBundleRoot, "restartOutcome.rejectionEvidence.evidenceBundleRoot"),
    });
  }
  if (value.kind === "retryable" || value.kind === "invalidProgram") {
    return hashDomain("aloha/runtime-acceptance/candidate-semantic-outcome/v1", {
      kind: value.kind,
      failure: record(value.failure, "restartOutcome.failure"),
    });
  }
  throw new TypeError("runtime restart encountered an unknown durable outcome kind");
}

function runKey(candidateKey: Hash, outcome: "verified" | "rejected" | "retryable" | "pending", cutoff: RecordValue): Hash {
  return outcome === "rejected"
    ? hashDomain("aloha/runtime-acceptance/non-reusable-rejection-key/v1", { candidateKey, cutoff })
    : candidateKey;
}

async function outcomeFact(
  writer: FactWriterV1,
  candidate: RecordValue,
  outcome: RecordValue,
  cutoff: RecordValue,
): Promise<RuntimeCandidateOutcomeV1> {
  const candidateKey = hash(candidate.familyCandidateKey, "restartCandidate.familyCandidateKey");
  const classification = outcomeClass(outcome);
  const payload = Object.freeze({
    candidateKey,
    runCandidateKey: runKey(candidateKey, classification, cutoff),
    dependencyClosureRoot: dependencyRoot(candidate, outcome),
    outcomeHash: semanticOutcomeHash(outcome),
    outcome: classification,
  });
  const ref = await writer.write(payload, manifestRef(RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.candidateOutcomeFactPayload));
  return Object.freeze({ ...payload, factRefId: ref.factId });
}

async function partialFact(
  writer: FactWriterV1,
  candidate: RecordValue,
  partial: RecordValue,
  cutoff: RecordValue,
): Promise<RuntimeCandidateOutcomeV1> {
  const candidateKey = hash(candidate.familyCandidateKey, "restartCandidate.familyCandidateKey");
  const payload = Object.freeze({
    candidateKey,
    runCandidateKey: runKey(candidateKey, "pending", cutoff),
    dependencyClosureRoot: hashDomain("aloha/runtime-acceptance/candidate-dependency-closure/v1", {
      familyDefinitionHash: hash(candidate.familyDefinitionHash, "restartCandidate.familyDefinitionHash"),
      candidateSubjectHash: hash(candidate.candidateSubjectHash, "restartCandidate.candidateSubjectHash"),
      candidateEvidenceRoot: hash(candidate.candidateEvidenceRoot, "restartCandidate.candidateEvidenceRoot"),
      identitySemanticHash: hash(record(partial.identity, "restartPartial.identity").identitySemanticHash, "restartPartial.identity.identitySemanticHash"),
    }),
    outcomeHash: hash(partial.outcomeHash, "restartPartial.outcomeHash"),
    outcome: "pending" as const,
  });
  const ref = await writer.write(payload, manifestRef(RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.candidateOutcomeFactPayload));
  return Object.freeze({ ...payload, factRefId: ref.factId });
}

function factPartition(items: readonly RuntimeCandidateOutcomeV1[]) {
  const sorted = Object.freeze([...items].sort((left, right) => left.runCandidateKey.localeCompare(right.runCandidateKey)));
  return Object.freeze({ count: String(sorted.length), root: hashRuntimeCandidateOutcomePartition(sorted), items: sorted });
}

async function snapshotOutcomes(
  writer: FactWriterV1,
  snapshot: RawCheckpointRestartSnapshotObservationV1,
): Promise<ReturnType<typeof factPartition>> {
  const candidates = candidateMap(snapshot);
  const cutoff = snapshot.cutoff as unknown as RecordValue;
  const facts: RuntimeCandidateOutcomeV1[] = [];
  for (const [index, value] of snapshot.outcomes.entries()) {
    const outcome = record(value, `restart.outcomes[${index}]`);
    const key = hash(outcome.familyCandidateKey, `restart.outcomes[${index}].familyCandidateKey`);
    const candidate = candidates.get(key);
    if (!candidate) throw new TypeError("runtime restart outcome candidate is absent");
    facts.push(await outcomeFact(writer, candidate, outcome, cutoff));
  }
  for (const [index, value] of snapshot.partials.entries()) {
    const partial = record(value, `restart.partials[${index}]`);
    const key = hash(partial.familyCandidateKey, `restart.partials[${index}].familyCandidateKey`);
    const candidate = candidates.get(key);
    if (!candidate) throw new TypeError("runtime restart partial candidate is absent");
    facts.push(await partialFact(writer, candidate, partial, cutoff));
  }
  return factPartition(facts);
}

async function stage12Outcomes(writer: FactWriterV1, stage12Value: unknown): Promise<ReturnType<typeof factPartition>> {
  const stage12 = record(stage12Value, "restart.stage12");
  const binding = record(stage12.binding, "restart.stage12.binding");
  const cutoff = record(binding.cutoff, "restart.stage12.binding.cutoff");
  const candidates = candidateMap(stage12);
  const facts: RuntimeCandidateOutcomeV1[] = [];
  for (const [index, value] of array(stage12.outcomes, "restart.stage12.outcomes").entries()) {
    const outcome = record(value, `restart.stage12.outcomes[${index}]`);
    const key = hash(outcome.familyCandidateKey, `restart.stage12.outcomes[${index}].familyCandidateKey`);
    const candidate = candidates.get(key);
    if (!candidate) throw new TypeError("runtime restart Stage1/2 outcome candidate is absent");
    facts.push(await outcomeFact(writer, candidate, outcome, cutoff));
  }
  return factPartition(facts);
}

async function deltaFact(
  writer: FactWriterV1,
  change: RuntimeCandidateDeltaPartitionV1["change"],
  oldItem: RuntimeCandidateOutcomeV1 | undefined,
  newItem: RuntimeCandidateOutcomeV1 | undefined,
): Promise<RuntimeCandidateDeltaV1> {
  const item = newItem ?? oldItem;
  if (!item) throw new TypeError("runtime restart delta item is empty");
  const payload = Object.freeze({
    candidateKey: item.candidateKey,
    runCandidateKey: item.runCandidateKey,
    previousDependencyClosureRoot: oldItem?.dependencyClosureRoot ?? null,
    currentDependencyClosureRoot: newItem?.dependencyClosureRoot ?? null,
    previousOutcomeHash: oldItem?.outcomeHash ?? null,
    currentOutcomeHash: newItem?.outcomeHash ?? null,
  });
  const ref = await writer.write(payload, manifestRef(RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.candidateDeltaFactPayload));
  return Object.freeze({ ...payload, factRefId: ref.factId });
}

function deltaPartition(change: RuntimeCandidateDeltaPartitionV1["change"], items: readonly RuntimeCandidateDeltaV1[]) {
  const sorted = Object.freeze([...items].sort((left, right) => left.runCandidateKey.localeCompare(right.runCandidateKey)));
  return Object.freeze({ change, count: String(sorted.length), root: hashRuntimeCandidateDeltaPartition(change, sorted), items: sorted });
}

async function difference(writer: FactWriterV1, previous: ReturnType<typeof factPartition>, current: ReturnType<typeof factPartition>) {
  const oldByKey = new Map(previous.items.map(item => [item.runCandidateKey, item]));
  const newByKey = new Map(current.items.map(item => [item.runCandidateKey, item]));
  const memo: RuntimeCandidateDeltaV1[] = [];
  const added: RuntimeCandidateDeltaV1[] = [];
  const invalidated: RuntimeCandidateDeltaV1[] = [];
  const retryable: RuntimeCandidateDeltaV1[] = [];
  const rejected: RuntimeCandidateDeltaV1[] = [];
  for (const next of current.items) {
    const prior = oldByKey.get(next.runCandidateKey);
    if (next.outcome === "retryable") retryable.push(await deltaFact(writer, "retryable", prior, next));
    else if (!prior) added.push(await deltaFact(writer, "new", undefined, next));
    else if (prior.outcome === "rejected") throw new TypeError("runtime restart attempted to reuse a rejected outcome");
    else if (prior.dependencyClosureRoot !== next.dependencyClosureRoot) invalidated.push(await deltaFact(writer, "invalidated-dependency", prior, next));
    else if (prior.outcomeHash === next.outcomeHash) memo.push(await deltaFact(writer, "memo-reused", prior, next));
    else throw new TypeError(`runtime restart changed outcome without dependency/retryable transition: candidate=${next.candidateKey} run=${next.runCandidateKey} previous=${prior.outcomeHash} current=${next.outcomeHash} dependency=${next.dependencyClosureRoot}`);
  }
  for (const prior of previous.items) {
    if (prior.outcome === "rejected" && !newByKey.has(prior.runCandidateKey)) rejected.push(await deltaFact(writer, "rejection-not-reused", prior, undefined));
  }
  const payload = Object.freeze({
    previousCandidates: previous,
    currentCandidates: current,
    memoReused: deltaPartition("memo-reused", memo),
    newCandidates: deltaPartition("new", added),
    invalidatedDependencyClosure: deltaPartition("invalidated-dependency", invalidated),
    retryable: deltaPartition("retryable", retryable),
    rejectionNotReused: deltaPartition("rejection-not-reused", rejected),
    unchangedOldInstanceAttestations: deltaPartition("unchanged-old-instance-attestation", []),
  });
  const ref = await writer.write(payload, manifestRef(RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.restartDifferenceFactPayload));
  return Object.freeze({ ...payload, factRefId: ref.factId });
}

async function processFact(
  writer: FactWriterV1,
  ready: ObservedRuntimeAcceptanceProcessEventV1,
  raw: RawRuntimeAcceptanceObservationV1,
) {
  const processAnchor = record(ready.processAnchor, "runtimeReady.processAnchor");
  const runtimeAnchor = record(ready.runtimeAnchor, "runtimeReady.runtimeAnchor");
  const staticArtifacts = record(ready.staticArtifacts, "runtimeReady.staticArtifacts");
  const phaseManifest = record(staticArtifacts.phaseManifest, "runtimeReady.staticArtifacts.phaseManifest");
  const releaseIntent = record(staticArtifacts.releaseIntent, "runtimeReady.staticArtifacts.releaseIntent");
  const strategy = record(ready.strategy, "runtimeReady.strategy");
  const stage12 = record(ready.stage12, "runtimeReady.stage12");
  const binding = record(stage12.binding, "runtimeReady.stage12.binding");
  const log = raw.processLogs.find(value => value.processReadyEventId === ready.eventId);
  if (!log) throw new TypeError("runtime restart process-ready log observation is absent");
  const payload = Object.freeze({
    runtimeCommitSha: text(ready.release.candidateReleaseCommit, "runtimeReady.release.candidateReleaseCommit"),
    processAnchorHash: hash(ready.processAnchorHash, "runtimeReady.processAnchorHash"),
    processAnchor,
    systemdUnit: text(runtimeAnchor.systemdUnit, "runtimeReady.runtimeAnchor.systemdUnit"),
    systemdExecStartHash: hash(phaseManifest.processCommandSha256, "runtimeReady.phaseManifest.processCommandSha256"),
    executableHash: hash(processAnchor.executableHash, "runtimeReady.processAnchor.executableHash"),
    logAnchor: log.logAnchor,
    sourceAnchor: record(binding.cutoff, "runtimeReady.stage12.binding.cutoff"),
    releaseIntentRoot: hash(releaseIntent.releaseIntentRoot, "runtimeReady.releaseIntent.releaseIntentRoot"),
    definitionCatalogRoot: hash(binding.definitionCatalogRoot, "runtimeReady.stage12.binding.definitionCatalogRoot"),
    sourceCoverageRoot: hash(binding.sourceCoverageRoot, "runtimeReady.stage12.binding.sourceCoverageRoot"),
    strategyCatalogRoot: hash(strategy.strategyCatalogRoot, "runtimeReady.strategy.strategyCatalogRoot"),
    instanceCatalogRoot: hash(binding.instanceCatalogRoot, "runtimeReady.stage12.binding.instanceCatalogRoot"),
    graphRoot: hash(binding.graphRoot, "runtimeReady.stage12.binding.graphRoot"),
    readyRecordHash: hash(binding.readyRecordHash, "runtimeReady.stage12.binding.readyRecordHash"),
    generationId: text(binding.generationId, "runtimeReady.stage12.binding.generationId"),
  });
  const ref = await writer.write(payload, manifestRef(RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.processAnchorFactPayload));
  return Object.freeze({ ...payload, factRefId: ref.factId });
}

function servingLeaseEvents(performance: RawPerformanceObservationV1, after: ReturnType<typeof processFact> extends Promise<infer T> ? T : never) {
  return Object.freeze(performance.events.filter(event => {
    const anchor = event.runtimeAnchor;
    const serving = event.serving;
    return event.eventType === "head-coverage"
      && serving !== null
      && anchor.pid === after.processAnchor.pid
      && anchor.processStartTicks === after.processAnchor.processStartTicks
      && serving.generationId === after.generationId
      && serving.graphRoot === after.graphRoot
      && serving.readyRecordHash === after.readyRecordHash;
  }));
}

function servingLeaseObservations(
  events: ReturnType<typeof servingLeaseEvents>,
  after: ReturnType<typeof processFact> extends Promise<infer T> ? T : never,
): readonly RuntimeGraphViewLeaseObservationV1[] {
  return Object.freeze(events.map((event) => {
    const serving = event.serving;
    if (serving === null) throw new TypeError("runtime restart Producer Graph lease has no serving identity");
    return Object.freeze({
      eventType: "head-coverage" as const,
      eventId: event.eventId,
      processAnchorHash: after.processAnchorHash,
      pid: text(event.runtimeAnchor.pid, "runtimeRestart.graphViewLease.pid"),
      processStartTicks: text(event.runtimeAnchor.processStartTicks, "runtimeRestart.graphViewLease.processStartTicks"),
      generationId: serving.generationId,
      graphRoot: serving.graphRoot,
      readyRecordHash: serving.readyRecordHash,
      sourceCoverageRoot: serving.sourceCoverageRoot,
      headHash: hash(event.payload.headHash, "runtimeRestart.graphViewLease.headHash"),
    });
  }).sort((left, right) => left.eventId.localeCompare(right.eventId)));
}

export async function observeProductionRuntimeRestartFactsV1(input: Readonly<{
  readonly processDatabase: RawRuntimeAcceptanceObservationV1;
  readonly performanceDatabase: RawPerformanceObservationV1;
  readonly checkpointDatabasePath: string;
  readonly sink: ContentAddressedObserverSinkV1;
}>): Promise<ProductionRuntimeRestartFactsObservationV1> {
  if (input.processDatabase.status !== "raw-complete") throw new TypeError(`runtime process evidence incomplete: ${input.processDatabase.reasons.join(",")}`);
  if (input.performanceDatabase.status === "invalid") throw new TypeError(`runtime performance evidence invalid: ${input.performanceDatabase.reasons.join(",")}`);
  const selected = selectRestart(input.processDatabase.events);
  const beforeSnapshot = observeCheckpointRuntimeRestartSnapshotV1(input.checkpointDatabasePath, selected.observed.checkpointRestartBefore);
  const drainedSnapshot = observeCheckpointRuntimeRestartSnapshotV1(input.checkpointDatabasePath, selected.drained.checkpointRestartAfter);
  if (!same(selected.beforeReady.checkpointStore, beforeSnapshot.checkpointStore)
    || !same(selected.afterReady.checkpointStore, drainedSnapshot.checkpointStore)) {
    throw new TypeError("runtime restart child processes did not open the same physical checkpoint SQLite store");
  }
  if (beforeSnapshot.runId !== drainedSnapshot.runId
    || beforeSnapshot.candidatePartitionRoot !== drainedSnapshot.candidatePartitionRoot
    || !same(beforeSnapshot.cutoff, drainedSnapshot.cutoff)) {
    throw new TypeError("runtime SIGTERM raw checkpoint run/cutoff/partition changed while draining");
  }
  if (!same(beforeSnapshot.outcomeHashes, selected.observed.outcomeHashesBefore)
    || !same(drainedSnapshot.outcomeHashes, selected.drained.outcomeHashesAfter)
    || !same(drainedSnapshot.outcomeHashes, selected.drained.flushedOutcomeHashes)) {
    throw new TypeError("runtime SIGTERM event outcome hashes do not match raw checkpoint rows");
  }
  const beforeStage12 = record(selected.beforeReady.stage12, "runtimeRestart.beforeReady.stage12");
  const afterStage12 = record(selected.afterReady.stage12, "runtimeRestart.afterReady.stage12");
  if (!same(beforeStage12, afterStage12)) {
    throw new TypeError("runtime restart changed the serving Ready Stage1/2 closure");
  }
  if (!same(selected.afterReady.checkpointRoot, selected.drained.checkpointRootAfter)) {
    throw new TypeError("fresh process did not reopen the exact FULL-sync checkpoint root");
  }
  const writer = new FactWriterV1(input.sink);
  await writer.writeChunked(Object.freeze({
    databaseSha256Before: input.processDatabase.databaseSha256Before,
    databaseSha256After: input.processDatabase.databaseSha256After,
    storageSetRootBefore: input.processDatabase.storageSetRootBefore,
    storageSetRootAfter: input.processDatabase.storageSetRootAfter,
    sqliteSchemaRoot: input.processDatabase.sqliteSchemaRoot,
    rawRowRoot: input.processDatabase.rawRowRoot,
    eventRoot: input.processDatabase.eventRoot,
    events: input.processDatabase.events,
    processLogs: input.processDatabase.processLogs,
  }), RAW_PROCESS_OBSERVATION_SCHEMA);
  await writer.writeChunked(checkpointSnapshotArtifact(beforeSnapshot), RAW_CHECKPOINT_SNAPSHOT_SCHEMA);
  await writer.writeChunked(checkpointSnapshotArtifact(drainedSnapshot), RAW_CHECKPOINT_SNAPSHOT_SCHEMA);
  const before = await processFact(writer, selected.beforeReady, input.processDatabase);
  const after = await processFact(writer, selected.afterReady, input.processDatabase);
  const leaseEvents = servingLeaseEvents(input.performanceDatabase, after);
  if (leaseEvents.length === 0) throw new TypeError("runtime restart has no actual post-restart Producer Graph lease observation");
  const leaseObservations = servingLeaseObservations(leaseEvents, after);
  await writer.writeChunked(Object.freeze({
    databaseSha256Before: input.performanceDatabase.databaseSha256Before,
    databaseSha256After: input.performanceDatabase.databaseSha256After,
    storageSetRootBefore: input.performanceDatabase.storageSetRootBefore,
    storageSetRootAfter: input.performanceDatabase.storageSetRootAfter,
    sqliteSchemaRoot: input.performanceDatabase.sqliteSchemaRoot,
    rawRowRoot: input.performanceDatabase.rawRowRoot,
    eventRoot: input.performanceDatabase.eventRoot,
    events: leaseEvents,
  }), RAW_PRODUCER_LEASE_SCHEMA);
  // The restart has two independent authorities.  Ready Stage1/2 proves the
  // serving graph stayed byte-identical across the process boundary.  The
  // root-reachable active run proves the next-generation difference and must
  // remain durable without being promoted merely to manufacture evidence.
  const previousCandidates = await stage12Outcomes(writer, beforeStage12);
  const currentCandidates = await snapshotOutcomes(writer, drainedSnapshot);
  const restartDifference = await difference(writer, previousCandidates, currentCandidates);
  const graphPayload = Object.freeze({
    mode: before.sourceAnchor.hash === after.sourceAnchor.hash && before.sourceAnchor.stateRoot === after.sourceAnchor.stateRoot ? "direct-reuse" as const : "fail-closed" as const,
    beforeGraphRoot: before.graphRoot,
    afterGraphRoot: after.graphRoot,
    beforeReadyRecordHash: before.readyRecordHash,
    afterReadyRecordHash: after.readyRecordHash,
    graphViewLeaseObservations: leaseObservations,
    graphViewLeaseRoot: hashRuntimeGraphViewLeaseObservations(leaseObservations),
  });
  const graphRef = await writer.write(graphPayload, manifestRef(RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.graphReuseFactPayload));
  const graphReuse = Object.freeze({ ...graphPayload, factRefId: graphRef.factId });
  const probe = drainedSnapshot.probeEvidence ?? beforeSnapshot.probeEvidence;
  if (probe === null) throw new TypeError("runtime restart requires a raw root-reachable single-target probe");
  const probeCandidates = candidateMap(drainedSnapshot);
  const probeBeforeRaw = Object.freeze({ ...drainedSnapshot, outcomes: array(probe.beforeOutcomes, "restartProbe.beforeOutcomes"), partials: [] });
  const probeAfterRaw = Object.freeze({ ...drainedSnapshot, outcomes: array(probe.afterOutcomes, "restartProbe.afterOutcomes"), partials: [] });
  const probeBefore = await snapshotOutcomes(writer, probeBeforeRaw as unknown as RawCheckpointRestartSnapshotObservationV1);
  const probeAfter = await snapshotOutcomes(writer, probeAfterRaw as unknown as RawCheckpointRestartSnapshotObservationV1);
  const receipt = record(probe.receipt, "restartProbe.receipt");
  const targetCandidateKey = hash(receipt.familyCandidateKey, "restartProbe.receipt.familyCandidateKey");
  if (!probeCandidates.has(targetCandidateKey)) throw new TypeError("restart probe target candidate is absent");
  const beforeTarget = probeBefore.items.find(item => item.candidateKey === targetCandidateKey);
  const afterTarget = probeAfter.items.find(item => item.candidateKey === targetCandidateKey);
  if (!beforeTarget || !afterTarget) throw new TypeError("restart probe target outcomes are absent");
  const changed = probeBefore.items.filter(item => probeAfter.items.find(next => next.runCandidateKey === item.runCandidateKey)?.outcomeHash !== item.outcomeHash).map(item => item.runCandidateKey).sort();
  const probePayload = Object.freeze({
    targetRunCandidateKey: beforeTarget.runCandidateKey,
    beforeOutcomes: probeBefore,
    afterOutcomes: probeAfter,
    changedRunCandidateKeys: Object.freeze({ count: String(changed.length), root: hashRuntimeHashPartition(changed), items: Object.freeze(changed) }),
    targetBeforeOutcomeHash: beforeTarget.outcomeHash,
    targetAfterOutcomeHash: afterTarget.outcomeHash,
  });
  const probeRef = await writer.write(probePayload, manifestRef(RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.singleTargetProbeFactPayload));
  const singleTargetProbe = Object.freeze({ ...probePayload, factRefId: probeRef.factId });
  const flushedOutcomes = currentCandidates;
  // observeCheckpointRuntimeRestartSnapshotV1 re-read this closure from the
  // current SQLite bytes after the fresh process-ready event joined the same
  // root.  This is the post-restart observation, not a producer DTO.
  const afterRestartOutcomes = currentCandidates;
  if (!same(flushedOutcomes.items, afterRestartOutcomes.items)) throw new TypeError("fresh process outcome facts differ from the FULL-sync drained partition");
  const sigtermPayload = Object.freeze({
    observedSignal: "SIGTERM" as const,
    signalProcessAnchorHash: before.processAnchorHash,
    flushedOutcomes,
    afterRestartOutcomes,
    durableOutcomeRoot: afterRestartOutcomes.root,
  });
  const sigtermRef = await writer.write(sigtermPayload, manifestRef(RUNTIME_ACCEPTANCE_SCHEMA_MANIFESTS.sigtermRecoveryFactPayload));
  const sigtermRecovery = Object.freeze({ ...sigtermPayload, factRefId: sigtermRef.factId });
  const factRefs = Object.freeze([...writer.refs.values()].sort((left, right) => left.factId.localeCompare(right.factId)));
  const facts = decodeRuntimeRestartFacts({
    schemaVersion: 1,
    kind: "aloha.runtime-restart-facts",
    before,
    after,
    graphReuse,
    difference: restartDifference,
    singleTargetProbe,
    sigtermRecovery,
    factRefs,
    factRefsRoot: hashRuntimeFactRefRoot(factRefs),
  });
  return Object.freeze({
    candidateReleaseCommit: selected.beforeReady.release.candidateReleaseCommit,
    artifacts: Object.freeze(writer.artifacts),
    facts,
  });
}
