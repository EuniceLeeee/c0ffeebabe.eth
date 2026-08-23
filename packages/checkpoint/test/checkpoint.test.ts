import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  attestationPartialIdentitySemanticHash,
  candidateFinalOutcomeHash,
  type CandidateFinalOutcomeV1,
  type AttestationFinalSessionResultV1,
  type AttestationPersistenceCapabilityV1,
  type AttestationProgramPort,
  type AttestationRunSessionV1,
  type AttestationServiceV1,
  type IdentityVerifiedV1,
  type InstanceDecisionV1,
  type InstanceLifecycleSingleFlightPort,
  type RawEffectObservationV1,
  type RawTransportExecutionRecordV1,
  type RejectionTransportExecutorV1,
  type AttestationValidationAuthorityV1,
  type AttestationCompositionBindingV1,
  type AttestationIdentityResumeCapabilityV1,
} from "../../attestation/src/index.ts";
import {
  createAttestationService,
  createFrameworkFailureRuntime,
  createRejectionExecutorAuthorityIssuer,
  createRejectionFactRuntime,
} from "../../attestation/src/internal/composition.ts";
import { readyBindingPortForReleaseApproval, releaseApproval, rotateReleaseApproval } from "../../attestation/test/authority-fixture.ts";
import { createCandidatePartitionProofIssuerFixture } from "./candidate-partition-authority-fixture.ts";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { sealInstancePublication } from "../../catalog/src/index.ts";
import { sealInstanceCatalog } from "../../catalog/src/index.ts";
import { candidatePartitionRoot, mergeAndDedupeNominations, sealSourceCoverage, type CandidateRecordV1, type CanonicalCutoffV1 } from "../../discovery/src/index.ts";
import { sealRecentObservation, type ObservedBlockV1 } from "../../observation/src/index.ts";
import { createCanonicalSource, SQLiteCanonicalJournalStore } from "../../canonical-source/src/index.ts";
import { createSqliteDurableStore } from "../../durable-store/src/index.ts";
import { createReadyPromotionAuthority } from "../../ready-generation/src/index.ts";
import { ReadyGenerationServiceV1 } from "../../ready-generation/src/index.ts";
import type {
  CandidatePartitionCapabilityV1,
  CandidatePartitionReaderPortV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import {
  CHECKPOINT_SCHEMA_AUTHORITY,
  CheckpointStore,
} from "../src/index.ts";
import {
  candidatePartitionBootstrapReader,
  createCandidatePartitionBootstrap,
  type CandidatePartitionBootstrapV1,
} from "../src/candidate-partition.ts";

const h = (value: string): Hash => hashDomain("test/checkpoint-v3", value);
const cutoff: CanonicalCutoffV1 = { chainId: "1", number: "49", hash: h("block:49"), stateRoot: h("state") };
const promotionPolicy = {
  observationWindowBlocks: "50" as const,
  targetRefreshAgeBlocks: "10",
  maxServingAgeBlocks: "30",
  minPromotionMarginBlocks: "2",
  maxInProgressRuns: "1" as const,
};

function rawLocator(id: string): { readonly rawLocatorHash: Hash; readonly bytes: Uint8Array } {
  const bytes = encodeCanonicalBytes({ kind: "chain-log", id });
  return { rawLocatorHash: sha256Hex(bytes), bytes };
}

function candidate(id: string): CandidateRecordV1 {
  const raw = rawLocator(id);
  return mergeAndDedupeNominations([{
    familyId: "family-a",
    familyDefinitionHash: h("definition"),
    instanceNominationKey: `instance-${id}`,
    candidateSnapshotHash: h(`snapshot:${id}`),
    evidence: {
      blockNumber: cutoff.number,
      blockHash: cutoff.hash,
      txHash: h(`tx:${id}`),
      logIndex: id,
      address: `0x${id.padStart(40, "0")}`,
      topic: h(`topic:${id}`),
      rawLocatorHash: raw.rawLocatorHash,
    },
  }])[0]!;
}

function observationBlocks(evidence: CandidateRecordV1["evidence"]): readonly ObservedBlockV1[] {
  const result: ObservedBlockV1[] = [];
  let parentHash = h("parent");
  for (let index = 0; index < 50; index += 1) {
    const blockHash = index === 49 ? cutoff.hash : h(`block:${index}`);
    result.push({
      number: String(index),
      hash: blockHash,
      parentHash,
      evidence: index === 49 ? evidence : [],
    });
    parentHash = blockHash;
  }
  return result;
}

function lifecycle(): InstanceLifecycleSingleFlightPort {
  return { async getOrBuild(_key, build) { return build(); } };
}

function makePublication(value: CandidateRecordV1, identity: IdentityVerifiedV1) {
  return sealInstancePublication({
    familyId: value.familyId,
    familyDefinitionHash: value.familyDefinitionHash,
    familyCandidateKey: value.familyCandidateKey,
    instanceKey: identity.familyInstanceKey,
    cutoff,
    identityMemoHash: identity.identityMemoHash,
    descriptorHash: identity.descriptorHash,
    staticProjectionMemoHash: h("projection-memo"),
    requestedArtifactDependencyRoot: h("dependencies"),
    validityDependencyRoot: h("validity"),
    transitions: [{
      inputAssetPorts: [{ assetRef: h("in"), portRef: h("in-port"), ordinal: "0" }],
      outputAssetPorts: [{ assetRef: h("out"), portRef: h("out-port"), ordinal: "0" }],
      opaqueTransitionRef: h("transition"),
      constraintRefs: [],
      staticProjectionHash: h("projection"),
    }],
    evidenceRoot: identity.evidenceRoot,
  });
}

interface ProgramCalls {
  identity: number;
  materialization: number;
}

interface AttestationTestBehavior {
  materialization: "verified" | "retryable";
}

function makeAttestationService(
  calls: ProgramCalls = { identity: 0, materialization: 0 },
  authorityLabel = "",
  behavior: AttestationTestBehavior = { materialization: "verified" },
  suppliedApproval?: AttestationCompositionBindingV1,
  candidatePartitionReader?: CandidatePartitionReaderPortV1,
): AttestationServiceV1 {
  const suffix = authorityLabel.length === 0 ? "" : `:${authorityLabel}`;
  const frameworkRoot = h(`framework${suffix}`);
  const executorRoot = h(`executor${suffix}`);
  const executorSessionHash = h(`executor-session${suffix}`);
  const workerEpoch = authorityLabel.length === 0 ? "epoch-1" : `epoch-${authorityLabel}`;
  const approval = suppliedApproval ?? releaseApproval(frameworkRoot, executorRoot, workerEpoch, executorSessionHash);
  const frameworkRuntime = createFrameworkFailureRuntime(approval, { classify() { return null; } });
  const executorAuthority = createRejectionExecutorAuthorityIssuer(approval);
  const executor: RejectionTransportExecutorV1 = {
    async execute(program) {
      const source = {
        chainId: cutoff.chainId,
        blockNumber: cutoff.number,
        blockHash: cutoff.hash,
        stateRoot: cutoff.stateRoot,
        executorAuthorityRoot: executorRoot,
        workerEpoch,
        executorSessionHash,
      };
      const transport: RawTransportExecutionRecordV1 = {
        requestId: program.request.requestId,
        kind: "returned",
        data: encodeCanonicalBytes({ ok: true }),
        source,
      };
      const effect: RawEffectObservationV1 = {
        requestId: program.request.requestId,
        source,
        observation: { ok: true },
      };
      return { transport: [transport], effects: [effect] };
    },
  };
  const rejectionRuntime = createRejectionFactRuntime(executorAuthority.issue(executor));
  const programs: AttestationProgramPort = {
    async attestIdentity(value) {
      calls.identity += 1;
      return {
        kind: "identityVerified" as const,
        familyInstanceKey: `instance:${value.familyCandidateKey}`,
        identityMemoHash: h(`identity:${value.familyCandidateKey}`),
        descriptorHash: h("descriptor"),
        evidenceRoot: h(`evidence:${value.familyCandidateKey}`),
      };
    },
    async materializeAndProject(value, identity): Promise<InstanceDecisionV1> {
      calls.materialization += 1;
      if (behavior.materialization === "retryable") {
        return {
          kind: "retryable",
          failure: {
            stage: "materialization",
            failureCode: "resource-limited",
            attemptCount: "1",
            candidateSnapshotHash: value.candidateSnapshotHash,
            evidenceRoot: h(`retryable:${value.familyCandidateKey}`),
            frameworkBinding: null,
          },
        };
      }
      return { kind: "verified", publication: makePublication(value, identity) };
    },
  };
  return createAttestationService({
    composition: approval,
    frameworkRuntime,
    rejectionRuntime,
    programs,
    instanceLifecycle: lifecycle(),
    candidatePartitionReader: candidatePartitionReader!,
  });
}

/**
 * The checkpoint owns the real capability registry, but the attestation
 * service must be constructed before the checkpoint can expose its reader
 * (the validation authority is a constructor dependency of checkpoint).
 * This narrow test-only late binding keeps that cycle explicit without
 * adding a production injection or a shape-only fake capability.
 */
interface Harness {
  readonly directory: string;
  readonly filename: string;
  durable: ReturnType<typeof createSqliteDurableStore>;
  readonly journalStore: SQLiteCanonicalJournalStore;
  readonly source: ReturnType<typeof createCanonicalSource>;
  readonly promotionAuthority: ReturnType<typeof createReadyPromotionAuthority>;
  readonly authority: AttestationValidationAuthorityV1;
  readonly service: AttestationServiceV1;
  readonly approval: AttestationCompositionBindingV1;
  partitionBootstrap: CandidatePartitionBootstrapV1;
  readonly probeCaller: object;
  readonly candidates: readonly CandidateRecordV1[];
  readonly run: Awaited<ReturnType<CheckpointStore["loadRun"]>>;
  checkpoint: CheckpointStore;
  armBeforeCommitFailure(): void;
  armPostCommitCanonicalFailure(): void;
  setCurrentProofBinding(binding: import("../../../specs/release-authority/src/index.ts").RuntimeReleaseBindingV1): void;
  close(): void;
}

interface HarnessOptions {
  readonly calls?: ProgramCalls;
  readonly behavior?: AttestationTestBehavior;
}

async function makeHarness(count = 1, options: HarnessOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "aloha-checkpoint-v3-"));
  const filename = join(directory, "checkpoint.sqlite");
  let failNextCommit = false;
  let invalidateCanonicalAfterNextCommit = false;
  let canonicalInvalidated = false;
  const journalStore = new SQLiteCanonicalJournalStore(join(directory, "canonical-journal.sqlite"));
  const source = createCanonicalSource({
    async getLatestHeader() { return cutoff; },
    async getHeader(number) {
      return number === cutoff.number
        ? {
          kind: "found" as const,
          header: canonicalInvalidated ? { ...cutoff, hash: h("reorged-cutoff") } : cutoff,
        }
        : { kind: "unavailable" as const, failureCode: "not-indexed" };
    },
  }, { journalStore });
  await source.freezeView();
  const durable = createSqliteDurableStore(filename, {
    beforeCommit() {
      if (failNextCommit) {
        failNextCommit = false;
        throw new Error("checkpoint-test-before-commit");
      }
      if (invalidateCanonicalAfterNextCommit) {
        invalidateCanonicalAfterNextCommit = false;
        canonicalInvalidated = true;
      }
    },
  });
  const frameworkRoot = h("framework");
  const executorRoot = h("executor");
  const executorSessionHash = h("executor-session");
  const approval = releaseApproval(frameworkRoot, executorRoot, "epoch-1", executorSessionHash);
  const partitionBootstrap = createCandidatePartitionBootstrap();
  const service = makeAttestationService(
    options.calls,
    "",
    options.behavior,
    approval,
    candidatePartitionBootstrapReader(partitionBootstrap),
  );
  const promotionAuthority = createReadyPromotionAuthority(() => ({
    definitionCatalogRoot: h("definitions"),
    policy: promotionPolicy,
  }), readyBindingPortForReleaseApproval(approval));
  const candidates = Array.from({ length: count }, (_, index) => candidate(String(index)));
  const probeCaller = {};
  const releaseBinding = approval.resolver.resolve(approval.capability).provenance.runtimeBinding;
  let currentProofBinding = releaseBinding;
  const partitionProofIssuer = createCandidatePartitionProofIssuerFixture(releaseBinding, () => currentProofBinding);
  const checkpoint = new CheckpointStore(
    durable,
    source,
    probeCaller,
    promotionAuthority,
    service.validationAuthority,
    partitionProofIssuer,
    partitionBootstrap,
  );
  const recentObservation = sealRecentObservation(
    cutoff,
    source.recentObservationRange(cutoff),
    observationBlocks(candidates.flatMap(value => value.evidence)),
  );
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("plan"),
    familyDefinitionHash: h("definition"),
    completeness: "complete-snapshot" as const,
    historyStartBlock: null,
  };
  const sourceCoverage = sealSourceCoverage(cutoff, [plan], [{
    plan,
    cutoff,
    outcome: "complete" as const,
    from: cutoff.number,
    through: cutoff.number,
    previousAppliedThrough: null,
    resultPartitionRoot: h("source-results"),
  }]);
  const locators = candidates.map(value => rawLocator(value.instanceNominationKey.slice(-1)));
  const root = await checkpoint.loadAndValidateRoot();
  const run = await checkpoint.beginNewRunAndPersistPartition({
    expectedRootRevision: root.revision,
    parentGenerationId: root.readyGenerationId,
    cutoff,
    recentObservation,
    definitionCatalogRoot: h("definitions"),
    sourceCoverage,
    candidates,
    rawEvidenceLocators: locators,
  });
  return {
    directory,
    filename,
    durable,
    journalStore,
    source,
    promotionAuthority,
    authority: service.validationAuthority,
    service,
    approval,
    partitionBootstrap,
    probeCaller,
    candidates,
    run,
    checkpoint,
    armBeforeCommitFailure() {
      failNextCommit = true;
    },
    armPostCommitCanonicalFailure() {
      invalidateCanonicalAfterNextCommit = true;
    },
    setCurrentProofBinding(binding) {
      currentProofBinding = binding;
    },
    close(this: Harness) {
      this.durable.close();
      journalStore.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

interface SessionFixture {
  readonly session: AttestationRunSessionV1;
  readonly persistenceCapabilities: readonly AttestationPersistenceCapabilityV1[];
  readonly finalResults: readonly AttestationFinalSessionResultV1[];
}

async function openSession(value: Harness): Promise<SessionFixture> {
  const session = value.service.openRunSession({
    candidatePartition: value.run.candidatePartition,
  });
  const persistenceCapabilities: AttestationPersistenceCapabilityV1[] = [];
  const finalResults: AttestationFinalSessionResultV1[] = [];
  for (const candidateValue of value.candidates) {
    const identityResult = await session.resolveIdentityOrReuseProofOnce(candidateValue.familyCandidateKey, new AbortController().signal);
    persistenceCapabilities.push(identityResult.persistenceCapability);
    assert.equal(identityResult.kind, "identityVerified");
    const finalResult = await session.materializeAndProjectOnce(identityResult.continuation, new AbortController().signal);
    persistenceCapabilities.push(finalResult.persistenceCapability);
    finalResults.push(finalResult);
  }
  return { session, persistenceCapabilities, finalResults };
}

function partitionRoot(value: Harness): Hash {
  return value.run.candidatePartitionBinding.candidatePartitionRoot;
}

function partitionBinding(value: Harness): Harness["run"]["candidatePartitionBinding"] {
  return value.run.candidatePartitionBinding;
}

function candidateFromPartition(
  value: Harness,
  capability: Parameters<CandidatePartitionReaderPortV1["readCandidate"]>[0],
  key: Hash,
): CandidateRecordV1 {
  return value.checkpoint.candidatePartitionReader.readCandidate(capability, key);
}

function openSessionFor(
  value: Harness,
  candidatePartition: CandidatePartitionCapabilityV1 = value.run.candidatePartition,
  identityResumeCapabilities?: readonly AttestationIdentityResumeCapabilityV1[],
): AttestationRunSessionV1 {
  return value.service.openRunSession({
    candidatePartition,
    ...(identityResumeCapabilities === undefined ? {} : { identityResumeCapabilities }),
  });
}

async function flushCapabilities(
  value: Harness,
  fixture: SessionFixture,
  capabilities: readonly AttestationPersistenceCapabilityV1[],
): Promise<void> {
  const writer = value.checkpoint.createOutcomeWriter(value.run.runId, {
    writerCapability: fixture.session.writerCapability,
    flushEveryItems: 25,
    flushEveryMs: 2_000,
  });
  for (const capability of capabilities) await writer.enqueue(capability);
  await writer.closeAfterAllProducersAndFlush();
}

async function activateReadyForHarness(value: Harness): Promise<Awaited<ReturnType<ReadyGenerationServiceV1["promote"]>>> {
  const fixture = await openSession(value);
  await flushCapabilities(value, fixture, fixture.persistenceCapabilities);
  const partition = fixture.session.sealExactPartition([
    candidateFinalOutcomeHash(fixture.finalResults[0]!.outcome),
  ]);
  const sealedRun = await value.checkpoint.sealAttestationPartition(value.run.runId, partition);
  const outcomeHash = value.durable.readIndex(`outcome/${value.run.runId}`, value.candidates[0]!.familyCandidateKey);
  assert.ok(outcomeHash);
  const outcomeRecord = value.durable.readContent(outcomeHash);
  assert.ok(outcomeRecord);
  const outcome = decodeCanonicalJson(outcomeRecord.bytes) as Record<string, unknown>;
  const instanceCatalog = sealInstanceCatalog(cutoff, [outcome.publication as Parameters<typeof sealInstanceCatalog>[1][number]]);
  const readyCaller = {};
  const ready = new ReadyGenerationServiceV1(
    readyCaller,
    value.checkpoint,
    value.source,
    () => "1",
    () => ({
      definitionCatalogRoot: h("definitions"),
      declaredSourcePlans: [{
        ownerRef: h("owner"),
        sourcePlanRef: h("plan"),
        familyDefinitionHash: h("definition"),
        completeness: "complete-snapshot" as const,
        historyStartBlock: null,
      }],
      releaseProvenanceHash: value.run.candidatePartitionBinding.releaseProvenanceHash,
    }),
    value.promotionAuthority,
    value.checkpoint.sealedRunReader,
    readyBindingPortForReleaseApproval(value.approval),
  );
  return ready.promote(readyCaller, {
    sealedRun,
    instanceCatalog,
    parentGenerationId: value.run.parentGenerationId,
    policy: promotionPolicy,
  });
}

function activeRunEnvelope(value: Harness): Record<string, unknown> {
  const rootRecord = value.durable.readRoot();
  assert.ok(rootRecord);
  const root = CHECKPOINT_SCHEMA_AUTHORITY.decodeRoot(rootRecord.envelopeBytes);
  const runHash = rootRecord.references.find(hash => value.durable.readContent(hash)?.kind === "aloha/in-progress-run/v2");
  assert.ok(runHash);
  assert.ok(root.inProgressRunId);
  return CHECKPOINT_SCHEMA_AUTHORITY.decodeRun(value.durable.readContent(runHash)!.bytes) as unknown as Record<string, unknown>;
}

/** Mutate the candidate manifest and rewrite the run/root closure, but retain
 * the old externally signed proof.  The checkpoint must reject this even
 * though the candidate bytes, manifest, run envelope, and root are all
 * internally recomputed. */
function rewriteCandidatePartitionWithoutProof(value: Harness): void {
  const lease = value.durable.acquireWriterLease("checkpoint-test-candidate-proof-closure");
  try {
    value.durable.transaction(lease, tx => {
      const rootRecord = tx.readRoot();
      assert.ok(rootRecord);
      const root = CHECKPOINT_SCHEMA_AUTHORITY.decodeRoot(rootRecord.envelopeBytes) as unknown as Record<string, unknown>;
      const runHash = rootRecord.references.find(hash => tx.readContent(hash)?.kind === "aloha/in-progress-run/v2");
      assert.ok(runHash);
      const run = CHECKPOINT_SCHEMA_AUTHORITY.decodeRun(tx.readContent(runHash)!.bytes) as unknown as Record<string, unknown>;
      const manifest = decodeCanonicalJson(tx.readContent(String(run.candidatePartitionStorageHash) as Hash)!.bytes) as Record<string, unknown>;
      const pageHash = String((manifest.pageStorageHashes as unknown[])[0]) as Hash;
      const page = decodeCanonicalJson(tx.readContent(pageHash)!.bytes) as Record<string, unknown>;
      const entries = page.entries as Record<string, unknown>[];
      assert.equal(entries.length, 1);
      const oldCandidateHash = String(entries[0]!.storageHash) as Hash;
      const oldCandidate = decodeCanonicalJson(tx.readContent(oldCandidateHash)!.bytes) as unknown as CandidateRecordV1;
      const mutatedCandidate = { ...oldCandidate, candidateSnapshotHash: h("candidate-proof-splice") };
      const mutatedCandidateHash = tx.putImmutable("aloha/candidate-record/v1", encodeCanonicalBytes(mutatedCandidate));
      const mutatedPageHash = tx.putImmutable(
        "aloha/checkpoint-partition-page/v1",
        encodeCanonicalBytes({
          ...page,
          entries: [{ key: entries[0]!.key, storageHash: mutatedCandidateHash }],
        }),
        [mutatedCandidateHash],
      );
      const mutatedManifestHash = tx.putImmutable(
        "aloha/checkpoint-partition-manifest/v1",
        encodeCanonicalBytes({ ...manifest, pageStorageHashes: [mutatedPageHash] }),
        [mutatedPageHash],
      );
      const nextRevision = (BigInt(String(root.revision)) + 1n).toString();
      const nextRun = {
        ...run,
        checkpointRevision: nextRevision,
        candidatePartitionRoot: candidatePartitionRoot([mutatedCandidate]),
        candidatePartitionStorageHash: mutatedManifestHash,
      } as Record<string, unknown>;
      const nextRunHash = tx.putImmutable(
        "aloha/in-progress-run/v2",
        encodeCanonicalBytes(nextRun),
        [
          String(nextRun.recentObservationStorageHash) as Hash,
          String(nextRun.sourceCoverageStorageHash) as Hash,
          String(nextRun.candidatePartitionStorageHash) as Hash,
          String(nextRun.candidatePartitionProofStorageHash) as Hash,
          String(nextRun.outcomePartitionStorageHash) as Hash,
          ...(nextRun.partialOutcomePartitionStorageHash === null ? [] : [String(nextRun.partialOutcomePartitionStorageHash) as Hash]),
          String(nextRun.verifiedMemoSetStorageHash) as Hash,
        ] as Hash[],
      );
      tx.compareAndSwapRoot(
        String(root.revision),
        encodeCanonicalBytes({ ...root, revision: nextRevision }),
        rootRecord.references.map(hash => hash === runHash ? nextRunHash : hash),
      );
    });
  } finally {
    value.durable.releaseWriterLease(lease);
  }
}

/**
 * Replace one outcome/partial row and rebuild only the active run's durable
 * closure. This deliberately leaves the candidate partition and ready
 * closure untouched, so a mutation that survives these roots reaches the
 * current attestation verifier rather than failing at an unrelated index.
 */
function replaceActivePartitionRecord(
  value: Harness,
  partitionKind: "outcome" | "partial-outcome",
  key: Hash,
  nextPayload: Record<string, unknown>,
): void {
  const lease = value.durable.acquireWriterLease(`checkpoint-test-rewrite-${partitionKind}`);
  try {
    value.durable.transaction(lease, tx => {
      const rootRecord = tx.readRoot();
      assert.ok(rootRecord);
      const root = CHECKPOINT_SCHEMA_AUTHORITY.decodeRoot(rootRecord.envelopeBytes) as unknown as Record<string, unknown>;
      const runHash = rootRecord.references.find(hash => tx.readContent(hash)?.kind === "aloha/in-progress-run/v2");
      assert.ok(runHash);
      const run = CHECKPOINT_SCHEMA_AUTHORITY.decodeRun(tx.readContent(runHash)!.bytes) as unknown as Record<string, unknown>;
      const runId = String(run.runId);
      const namespace = `${partitionKind}/${runId}`;
      const recordKind = partitionKind === "outcome"
        ? "aloha/candidate-final-outcome/v1"
        : "aloha/attestation-partial-outcome/v1";
      const nextRecordHash = tx.putImmutable(recordKind, encodeCanonicalBytes(nextPayload));
      tx.setIndex(namespace, key, nextRecordHash);
      const entries = tx.listIndex(namespace).map(entry => ({ key: entry.key, storageHash: entry.contentHash }));
      const pageHash = tx.putImmutable(
        "aloha/checkpoint-partition-page/v1",
        encodeCanonicalBytes({ runId, partitionKind, pageIndex: "0", entries }),
        entries.map(entry => entry.storageHash),
      );
      const manifestHash = tx.putImmutable(
        "aloha/checkpoint-partition-manifest/v1",
        encodeCanonicalBytes({ runId, partitionKind, count: String(entries.length), pageStorageHashes: [pageHash] }),
        [pageHash],
      );
      const nextRevision = (BigInt(String(root.revision)) + 1n).toString();
      const outcomes = tx.listIndex(`outcome/${runId}`).map(entry =>
        decodeCanonicalJson(tx.readContent(entry.contentHash)!.bytes) as unknown as CandidateFinalOutcomeV1,
      ).sort((left, right) => left.familyCandidateKey.localeCompare(right.familyCandidateKey));
      const nextRun = {
        ...run,
        checkpointRevision: nextRevision,
        ...(partitionKind === "outcome"
          ? {
            outcomePartitionStorageHash: manifestHash,
            outcomePartitionRoot: hashDomain("aloha/checkpoint-outcome-partition/v1", {
              runId,
              outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", outcomes),
            }),
          }
          : { partialOutcomePartitionStorageHash: manifestHash }),
      } as Record<string, unknown>;
      const runReferences = [
        nextRun.recentObservationStorageHash,
        nextRun.sourceCoverageStorageHash,
        nextRun.candidatePartitionStorageHash,
        nextRun.outcomePartitionStorageHash,
        ...(nextRun.partialOutcomePartitionStorageHash === null ? [] : [nextRun.partialOutcomePartitionStorageHash]),
        nextRun.verifiedMemoSetStorageHash,
        ...(nextRun.attestationPartitionStorageHash === null ? [] : [nextRun.attestationPartitionStorageHash]),
      ] as Hash[];
      const nextRunHash = tx.putImmutable(
        "aloha/in-progress-run/v2",
        encodeCanonicalBytes(nextRun),
        runReferences,
      );
      const rootReferences = rootRecord.references.map(hash => hash === runHash ? nextRunHash : hash);
      tx.compareAndSwapRoot(
        String(root.revision),
        encodeCanonicalBytes({ ...root, revision: nextRevision }),
        rootReferences,
      );
    });
  } finally {
    value.durable.releaseWriterLease(lease);
  }
}

function partialIdentityHash(
  value: Harness,
  partial: Record<string, unknown>,
): Hash {
  const identity = partial.identity as IdentityVerifiedV1;
  const candidate = value.candidates.find(item => item.familyCandidateKey === partial.familyCandidateKey);
  assert.ok(candidate);
  return attestationPartialIdentitySemanticHash({
    runId: String(partial.runId),
    cutoff,
    candidatePartitionRoot: String(partial.candidatePartitionRoot) as Hash,
    candidate,
    identity,
    releaseProvenanceHash: String(partial.releaseProvenanceHash) as Hash,
    attestationAuthorityRoot: String(partial.attestationAuthorityRoot) as Hash,
    releaseAuthorityRoot: String(partial.releaseAuthorityRoot) as Hash,
    executorAuthorityRoot: String(partial.executorAuthorityRoot) as Hash,
  });
}

function persistedOutcome(value: Harness, familyCandidateKey: Hash): CandidateFinalOutcomeV1 {
  const storageHash = value.durable.readIndex(`outcome/${value.run.runId}`, familyCandidateKey);
  assert.ok(storageHash);
  const record = value.durable.readContent(storageHash);
  assert.ok(record);
  const candidateValue = value.candidates.find(candidate => candidate.familyCandidateKey === familyCandidateKey);
  assert.ok(candidateValue);
  return value.authority.validateDurableOutcome(decodeCanonicalJson(record.bytes), {
    runId: value.run.runId,
    cutoff,
    candidatePartitionRoot: partitionRoot(value),
    candidate: candidateValue,
  });
}

test("restart identity resume rejects signed-proof mutations after partial closure roots are recomputed", async () => {
  const mutations: readonly [string, (identity: Record<string, unknown>) => Record<string, unknown>][] = [
    ["signature", identity => ({
      ...identity,
      issuerProof: {
        ...(identity.issuerProof as Record<string, unknown>),
        signatureHex: `0x${"11".repeat(64)}`,
      },
    })],
    ["issuer", identity => ({
      ...identity,
      issuerProof: {
        ...(identity.issuerProof as Record<string, unknown>),
        issuerKeyId: h("foreign-identity-issuer"),
      },
    })],
    ["candidate", identity => ({
      ...identity,
      issuerProof: {
        ...(identity.issuerProof as Record<string, unknown>),
        candidateSnapshotHash: h("spliced-candidate-snapshot"),
      },
    })],
    ["cutoff", identity => ({
      ...identity,
      issuerProof: {
        ...(identity.issuerProof as Record<string, unknown>),
        cutoff: {
          ...(identity.issuerProof as Record<string, unknown>).cutoff as Record<string, unknown>,
          hash: h("spliced-cutoff"),
        },
      },
    })],
    ["partition", identity => ({
      ...identity,
      issuerProof: {
        ...(identity.issuerProof as Record<string, unknown>),
        candidatePartitionRoot: h("spliced-partition"),
      },
    })],
    ["release", identity => ({
      ...identity,
      issuerProof: {
        ...(identity.issuerProof as Record<string, unknown>),
        releaseProvenanceHash: h("spliced-release"),
      },
    })],
    ["family-instance", identity => ({
      ...identity,
      familyInstanceKey: "spliced-family-instance",
    })],
    ["identity-memo", identity => ({
      ...identity,
      identityMemoHash: h("spliced-identity-memo"),
    })],
    ["descriptor", identity => ({
      ...identity,
      descriptorHash: h("spliced-descriptor"),
    })],
    ["identity-evidence", identity => ({
      ...identity,
      evidenceRoot: h("spliced-identity-observation"),
    })],
  ];

  for (const [label, mutateIdentity] of mutations) {
    const value = await makeHarness(1);
    try {
      const fixture = await openSession(value);
      await flushCapabilities(value, fixture, [fixture.persistenceCapabilities[0]!]);
      const key = value.candidates[0]!.familyCandidateKey;
      const storageHash = value.durable.readIndex(`partial-outcome/${value.run.runId}`, key);
      assert.ok(storageHash);
      const record = value.durable.readContent(storageHash);
      assert.ok(record);
      const partial = decodeCanonicalJson(record.bytes) as Record<string, unknown>;
      const nextPartial: Record<string, unknown> = {
        ...partial,
        identity: mutateIdentity(partial.identity as Record<string, unknown>),
      };
      nextPartial.outcomeHash = partialIdentityHash(value, nextPartial);
      replaceActivePartitionRecord(value, "partial-outcome", key, nextPartial);
      await assert.rejects(
        () => value.checkpoint.loadIdentityResumeCapabilities(value.run.runId),
        /identity|proof|signature|issuer|authority|binding|semantic|mismatch|corrupt/i,
        label,
      );
    } finally {
      value.close();
    }
  }
});

test("durable final identity proof mutations remain rejected after outcome roots are recomputed", async () => {
  const mutations: readonly [string, number, (outcome: Record<string, unknown>, value: Harness) => Record<string, unknown>][] = [
    ["signature", 1, outcome => ({
      ...outcome,
      identityProof: {
        ...(outcome.identityProof as Record<string, unknown>),
        signatureHex: `0x${"22".repeat(64)}`,
      },
    })],
    ["issuer", 1, outcome => ({
      ...outcome,
      identityProof: {
        ...(outcome.identityProof as Record<string, unknown>),
        issuerKeyId: h("foreign-final-issuer"),
      },
    })],
    ["candidate", 1, outcome => ({
      ...outcome,
      identityProof: {
        ...(outcome.identityProof as Record<string, unknown>),
        candidateSnapshotHash: h("foreign-final-candidate"),
      },
    })],
    ["cutoff", 1, outcome => ({
      ...outcome,
      identityProof: {
        ...(outcome.identityProof as Record<string, unknown>),
        cutoff: {
          ...(outcome.identityProof as Record<string, unknown>).cutoff as Record<string, unknown>,
          hash: h("foreign-final-cutoff"),
        },
      },
    })],
    ["partition", 1, outcome => ({
      ...outcome,
      identityProof: {
        ...(outcome.identityProof as Record<string, unknown>),
        candidatePartitionRoot: h("foreign-final-partition"),
      },
    })],
    ["release", 1, outcome => ({
      ...outcome,
      identityProof: {
        ...(outcome.identityProof as Record<string, unknown>),
        releaseProvenanceHash: h("foreign-final-release"),
      },
    })],
    ["identity-observation-family-instance", 1, outcome => ({
      ...outcome,
      identityProof: {
        ...(outcome.identityProof as Record<string, unknown>),
        identityObservation: {
          ...(outcome.identityProof as Record<string, unknown>).identityObservation as Record<string, unknown>,
          familyInstanceKey: "foreign-final-instance",
        },
      },
    })],
    ["identity-observation-memo", 1, outcome => ({
      ...outcome,
      identityProof: {
        ...(outcome.identityProof as Record<string, unknown>),
        identityObservation: {
          ...(outcome.identityProof as Record<string, unknown>).identityObservation as Record<string, unknown>,
          identityMemoHash: h("foreign-final-memo"),
        },
      },
    })],
    ["identity-observation-descriptor", 1, outcome => ({
      ...outcome,
      identityProof: {
        ...(outcome.identityProof as Record<string, unknown>),
        identityObservation: {
          ...(outcome.identityProof as Record<string, unknown>).identityObservation as Record<string, unknown>,
          descriptorHash: h("foreign-final-descriptor"),
        },
      },
    })],
    ["identity-observation-evidence", 1, outcome => ({
      ...outcome,
      identityProof: {
        ...(outcome.identityProof as Record<string, unknown>),
        identityObservation: {
          ...(outcome.identityProof as Record<string, unknown>).identityObservation as Record<string, unknown>,
          evidenceRoot: h("foreign-final-observation"),
        },
      },
    })],
    ["publication-evidence", 1, outcome => ({
      ...outcome,
      publication: {
        ...(outcome.publication as Record<string, unknown>),
        evidenceRoot: h("foreign-publication-evidence"),
      },
    })],
    ["outcome-proof-signature", 1, outcome => ({
      ...outcome,
      outcomeIssuerProof: {
        ...(outcome.outcomeIssuerProof as Record<string, unknown>),
        signatureHex: `0x${"33".repeat(64)}`,
      },
    })],
    ["cross-candidate", 2, (outcome, value) => ({
      ...outcome,
      identityProof: {
        ...(outcome.identityProof as Record<string, unknown>),
        familyCandidateKey: value.candidates[1]!.familyCandidateKey,
      },
    })],
  ];

  for (const [label, count, mutateOutcome] of mutations) {
    const value = await makeHarness(count);
    try {
      const fixture = await openSession(value);
      await flushCapabilities(value, fixture, fixture.persistenceCapabilities);
      const candidateValue = value.candidates[0]!;
      const storageHash = value.durable.readIndex(`outcome/${value.run.runId}`, candidateValue.familyCandidateKey);
      assert.ok(storageHash);
      const record = value.durable.readContent(storageHash);
      assert.ok(record);
      const outcome = decodeCanonicalJson(record.bytes) as Record<string, unknown>;
      replaceActivePartitionRecord(
        value,
        "outcome",
        candidateValue.familyCandidateKey,
        mutateOutcome(outcome, value),
      );
      const mutatedHash = value.durable.readIndex(`outcome/${value.run.runId}`, candidateValue.familyCandidateKey);
      assert.ok(mutatedHash);
      const mutatedRecord = value.durable.readContent(mutatedHash);
      assert.ok(mutatedRecord);
      assert.throws(
        () => value.authority.validateDurableOutcome(decodeCanonicalJson(mutatedRecord.bytes), {
          runId: value.run.runId,
          cutoff,
          candidatePartitionRoot: partitionRoot(value),
          candidate: candidateValue,
        }),
        /identity|proof|signature|issuer|authority|binding|publication|body|candidate|cutoff|partition|release|mismatch/i,
        label,
      );
      await assert.rejects(
        () => value.checkpoint.loadRun(value.run.runId),
        /identity|proof|signature|issuer|authority|binding|publication|body|candidate|cutoff|partition|release|mismatch|outcome/i,
        label,
      );
    } finally {
      value.close();
    }
  }
});

test("partial identity is durable, excluded from accounting, survives durable-store reopen, and is removed by final", async () => {
  const value = await makeHarness(1);
  try {
    const fixture = await openSession(value);
    const identityCapability = fixture.persistenceCapabilities[0]!;
    const finalCapability = fixture.persistenceCapabilities[1]!;
    const firstWriter = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: fixture.session.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await firstWriter.enqueue(identityCapability);
    await firstWriter.closeAfterAllProducersAndFlush();
    assert.equal(value.durable.listIndex(`partial-outcome/${value.run.runId}`).length, 1);
    const partialEnvelope = activeRunEnvelope(value);
    assert.notEqual(partialEnvelope.partialOutcomePartitionStorageHash, null);
    assert.deepEqual(partialEnvelope.accounting, {
      pending: "1",
      verified: "0",
      chainProvenRejected: "0",
      retryable: "0",
      invalidProgram: "0",
    });
    await value.checkpoint.loadRun(value.run.runId);

    value.durable.close();
    value.durable = createSqliteDurableStore(value.filename);
    const reopenedBinding = value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding;
    value.partitionBootstrap = createCandidatePartitionBootstrap();
    value.checkpoint = new CheckpointStore(
      value.durable,
      value.source,
      value.probeCaller,
      value.promotionAuthority,
      value.authority,
      createCandidatePartitionProofIssuerFixture(reopenedBinding),
      value.partitionBootstrap,
    );
    await value.checkpoint.loadRun(value.run.runId);
    await flushCapabilities(value, fixture, [finalCapability]);
    assert.equal(value.durable.listIndex(`partial-outcome/${value.run.runId}`).length, 0);
    const finalEnvelope = activeRunEnvelope(value);
    assert.equal(finalEnvelope.partialOutcomePartitionStorageHash, null);
    const partition = fixture.session.sealExactPartition([candidateFinalOutcomeHash(fixture.finalResults[0]!.outcome)]);
    await value.checkpoint.sealAttestationPartition(value.run.runId, partition);
  } finally {
    value.close();
  }
});

test("durable final outcome proof rejects a rewritten publication after restart", async () => {
  const value = await makeHarness(1);
  try {
    const fixture = await openSession(value);
    await flushCapabilities(value, fixture, fixture.persistenceCapabilities);
    const key = value.candidates[0]!.familyCandidateKey;
    const storageHash = value.durable.readIndex(`outcome/${value.run.runId}`, key);
    assert.ok(storageHash);
    const record = value.durable.readContent(storageHash);
    assert.ok(record);
    const outcome = decodeCanonicalJson(record.bytes) as Record<string, unknown>;
    const publication = outcome.publication as Record<string, unknown>;
    const tamperedHash = value.durable.putImmutableContent(
      "aloha/candidate-final-outcome/v1",
      encodeCanonicalBytes({
        ...outcome,
        publication: { ...publication, staticProjectionMemoHash: h("rewritten-publication") },
      }),
    );
    assert.throws(
      () => value.authority.validateDurableOutcome(decodeCanonicalJson(value.durable.readContent(tamperedHash)!.bytes), {
        runId: value.run.runId,
        cutoff,
          candidatePartitionRoot: partitionRoot(value),
        candidate: value.candidates[0]!,
      }),
      /proof|body|mismatch/i,
    );
    const lease = value.durable.acquireWriterLease("checkpoint-test-outcome-proof-tamper");
    try {
      value.durable.transaction(lease, tx => tx.setIndex(`outcome/${value.run.runId}`, key, tamperedHash));
    } finally {
      value.durable.releaseWriterLease(lease);
    }
    await assert.rejects(
      () => value.checkpoint.loadRun(value.run.runId),
      /outcome|proof|publication|root|mismatch/i,
    );
  } finally {
    value.close();
  }
});

test("partial identity rehydrates an opaque capability across a new service and rejects transplant or authority mutation", async () => {
  const value = await makeHarness(2);
  try {
    const firstSession = openSessionFor(value);
    const firstIdentity = await firstSession.resolveIdentityOrReuseProofOnce(value.candidates[0]!.familyCandidateKey, new AbortController().signal);
    assert.equal(firstIdentity.kind, "identityVerified");
    const writer = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: firstSession.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await writer.enqueue(firstIdentity.persistenceCapability);
    await writer.closeAfterAllProducersAndFlush();

    const partialEntry = value.durable.listIndex(`partial-outcome/${value.run.runId}`)[0]!;
    const partialRecord = value.durable.readContent(partialEntry.contentHash);
    assert.ok(partialRecord);
    const partialObject = decodeCanonicalJson(partialRecord.bytes) as Record<string, unknown>;
    const tamperedHash = value.durable.putImmutableContent(
      "aloha/attestation-partial-outcome/v1",
      encodeCanonicalBytes({
        ...partialObject,
        identity: { ...(partialObject.identity as Record<string, unknown>), evidenceRoot: h("tampered") },
      }),
    );
    const tamperLease = value.durable.acquireWriterLease("checkpoint-test-tamper");
    try {
      value.durable.transaction(tamperLease, tx => tx.setIndex(`partial-outcome/${value.run.runId}`, partialEntry.key, tamperedHash));
    } finally {
      value.durable.releaseWriterLease(tamperLease);
    }
    await assert.rejects(
      () => value.checkpoint.loadIdentityResumeCapabilities(value.run.runId),
      /manifest|partial|hash|corrupt/i,
    );
    const restoreLease = value.durable.acquireWriterLease("checkpoint-test-tamper-restore");
    try {
      value.durable.transaction(restoreLease, tx => tx.setIndex(`partial-outcome/${value.run.runId}`, partialEntry.key, partialEntry.contentHash));
    } finally {
      value.durable.releaseWriterLease(restoreLease);
    }

    const rotatedApproval = releaseApproval(h("framework:rotated"), h("executor:rotated"), "epoch-rotated", h("executor-session:rotated"));
    const rotatedBootstrap = createCandidatePartitionBootstrap();
    const rotatedService = makeAttestationService(
      { identity: 0, materialization: 0 },
      "rotated",
      undefined,
      rotatedApproval,
      candidatePartitionBootstrapReader(rotatedBootstrap),
    );
    const rotatedBinding = rotatedApproval.resolver.resolve(rotatedApproval.capability).provenance.runtimeBinding;
    const rotatedCheckpoint = new CheckpointStore(
      value.durable,
      value.source,
      {},
      value.promotionAuthority,
      rotatedService.validationAuthority,
      createCandidatePartitionProofIssuerFixture(rotatedBinding),
      rotatedBootstrap,
    );
    await assert.rejects(
      () => rotatedCheckpoint.loadIdentityResumeCapabilities(value.run.runId),
      /authority|binding|mismatch|current|provenance/i,
    );

    value.durable.close();
    value.durable = createSqliteDurableStore(value.filename);
    const restartCalls: ProgramCalls = { identity: 0, materialization: 0 };
    value.partitionBootstrap = createCandidatePartitionBootstrap();
    const restartedService = makeAttestationService(restartCalls, "", undefined, value.approval, candidatePartitionBootstrapReader(value.partitionBootstrap));
    const restartedBinding = value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding;
    const restartedCheckpoint = new CheckpointStore(
      value.durable,
      value.source,
      {},
      value.promotionAuthority,
      restartedService.validationAuthority,
      createCandidatePartitionProofIssuerFixture(restartedBinding),
      value.partitionBootstrap,
    );
    const capabilities = await restartedCheckpoint.loadIdentityResumeCapabilities(value.run.runId);
    const restartedRun = await restartedCheckpoint.loadRun(value.run.runId);
    assert.equal(capabilities.length, 1);
    const capability = capabilities[0]!;
    assert.deepEqual(Object.keys(capability), []);
    assert.equal(Object.prototype.hasOwnProperty.call(restartedService.validationAuthority, "issueIdentityResumeCapability"), false);

    assert.throws(
      () => restartedService.openRunSession({
        candidatePartition: restartedRun.candidatePartition,
        identityResumeCapabilities: [{ ...capability }],
      }),
      /not-issued|resume|candidate partition capability/i,
    );
    const resumedSession = restartedService.openRunSession({
      candidatePartition: restartedRun.candidatePartition,
      identityResumeCapabilities: capabilities,
    });
    const resumedIdentity = await resumedSession.resolveIdentityOrReuseProofOnce(value.candidates[0]!.familyCandidateKey, new AbortController().signal);
    assert.equal(resumedIdentity.kind, "identityVerified");
    assert.equal(restartCalls.identity, 0);
    const resumedFinal = await resumedSession.materializeAndProjectOnce(
      resumedIdentity.continuation,
      new AbortController().signal,
    );
    assert.equal(restartCalls.materialization, 1);
    const resumedWriter = restartedCheckpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: resumedSession.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await resumedWriter.enqueue(resumedFinal.persistenceCapability);
    await resumedWriter.closeAfterAllProducersAndFlush();
    assert.equal(value.durable.listIndex(`partial-outcome/${value.run.runId}`).length, 0);
    assert.throws(
      () => restartedService.openRunSession({
        candidatePartition: restartedRun.candidatePartition,
        identityResumeCapabilities: [capability],
      }),
      /consumed|resume|not-issued/i,
    );
  } finally {
    value.close();
  }
});

test("identity resume capability is consumed at the resolve point when two sessions opened first", async () => {
  const calls: ProgramCalls = { identity: 0, materialization: 0 };
  const value = await makeHarness(1, { calls });
  try {
    const sourceSession = openSessionFor(value);
    const sourceIdentity = await sourceSession.resolveIdentityOrReuseProofOnce(value.candidates[0]!.familyCandidateKey, new AbortController().signal);
    assert.equal(sourceIdentity.kind, "identityVerified");
    const writer = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: sourceSession.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await writer.enqueue(sourceIdentity.persistenceCapability);
    await writer.closeAfterAllProducersAndFlush();

    const capabilities = await value.checkpoint.loadIdentityResumeCapabilities(value.run.runId);
    assert.equal(capabilities.length, 1);
    calls.identity = 0;
    const sessionA = value.service.openRunSession({
      candidatePartition: value.run.candidatePartition,
      identityResumeCapabilities: capabilities,
    });
    const sessionB = value.service.openRunSession({
      candidatePartition: value.run.candidatePartition,
      identityResumeCapabilities: capabilities,
    });

    const resumed = await sessionA.resolveIdentityOrReuseProofOnce(value.candidates[0]!.familyCandidateKey, new AbortController().signal);
    assert.equal(resumed.kind, "identityVerified");
    await assert.rejects(
      () => sessionB.resolveIdentityOrReuseProofOnce(value.candidates[0]!.familyCandidateKey, new AbortController().signal),
      /consumed|resume/i,
    );
    assert.equal(calls.identity, 0);
  } finally {
    value.close();
  }
});

test("one-shot beforeCommit failure rolls back a two-outcome batch and permits the same claim to retry", async () => {
  const value = await makeHarness(2);
  try {
    const fixture = await openSession(value);
    const batch = fixture.finalResults.map(result => result.persistenceCapability);
    const beforeEnvelope = activeRunEnvelope(value);
    value.armBeforeCommitFailure();
    const failedWriter = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: fixture.session.writerCapability,
      flushEveryItems: 2,
      flushEveryMs: 2_000,
    });
    for (const capability of batch) await failedWriter.enqueue(capability);
    await assert.rejects(
      () => failedWriter.closeAfterAllProducersAndFlush(),
      /before-commit|SQLite transaction failed|sqlite/i,
    );
    assert.equal(value.durable.listIndex(`outcome/${value.run.runId}`).length, 0);
    assert.equal(value.durable.listIndex(`partial-outcome/${value.run.runId}`).length, 0);
    assert.equal(activeRunEnvelope(value).checkpointRevision, beforeEnvelope.checkpointRevision);

    const retryWriter = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: fixture.session.writerCapability,
      flushEveryItems: 2,
      flushEveryMs: 2_000,
    });
    for (const capability of batch) await retryWriter.enqueue(capability);
    await retryWriter.closeAfterAllProducersAndFlush();
    assert.equal(value.durable.listIndex(`outcome/${value.run.runId}`).length, 2);
    const envelope = activeRunEnvelope(value);
    assert.deepEqual(envelope.accounting, {
      pending: "0",
      verified: "2",
      chainProvenRejected: "0",
      retryable: "0",
      invalidProgram: "0",
    });
  } finally {
    value.close();
  }
});

test("probe replacement carries the full active candidate partition and leaves the other retryable", async () => {
  const behavior: AttestationTestBehavior = { materialization: "retryable" };
  const value = await makeHarness(2, { behavior });
  try {
    const initial = await openSession(value);
    assert.deepEqual(initial.finalResults.map(result => result.outcome.kind), ["retryable", "retryable"]);
    await flushCapabilities(value, initial, initial.finalResults.map(result => result.persistenceCapability));
    const probe = value.checkpoint.bindProbeStore(value.probeCaller);
    const first = await probe.loadRetryable(value.run.runId, value.candidates[0]!.familyCandidateKey);
    const second = await probe.loadRetryable(value.run.runId, value.candidates[1]!.familyCandidateKey);
    assert.equal(first.candidatePartitionBinding.candidatePartitionRoot, partitionRoot(value));
    assert.equal(second.candidatePartitionBinding.candidatePartitionRoot, partitionRoot(value));
    const firstCandidate = candidateFromPartition(value, first.candidatePartition, first.before.familyCandidateKey);
    const secondCandidate = candidateFromPartition(value, second.candidatePartition, second.before.familyCandidateKey);
    assert.notEqual(first.candidatePartitionBinding.candidatePartitionRoot, candidatePartitionRoot([firstCandidate]));
    assert.notEqual(second.candidatePartitionBinding.candidatePartitionRoot, candidatePartitionRoot([secondCandidate]));

    behavior.materialization = "verified";
    const replacementSession = openSessionFor(value, first.candidatePartition);
    const replacementIdentity = await replacementSession.resolveIdentityOrReuseProofOnce(first.before.familyCandidateKey, new AbortController().signal);
    assert.equal(replacementIdentity.kind, "identityVerified");
    const replacement = await replacementSession.materializeAndProjectOnce(
      replacementIdentity.continuation,
      new AbortController().signal,
    );
    assert.equal(replacement.outcome.kind, "verified");
    const receipt = await probe.replaceRetryableCAS(
      first.probeCapability,
      replacementSession.writerCapability,
      replacement.persistenceCapability,
    );
    assert.equal(receipt.afterKind, "verified");
    await assert.rejects(
      () => probe.loadRetryable(value.run.runId, first.before.familyCandidateKey),
      /not retryable|probe target|state conflict/i,
    );
    const remaining = await probe.loadRetryable(value.run.runId, second.before.familyCandidateKey);
    assert.equal(remaining.before.kind, "retryable");
    assert.equal(remaining.candidatePartitionBinding.candidatePartitionRoot, partitionRoot(value));
  } finally {
    value.close();
  }
});

test("probe replacement remains durable and consumes its capability when the post-commit canonical fence fails", async () => {
  const behavior: AttestationTestBehavior = { materialization: "retryable" };
  const value = await makeHarness(1, { behavior });
  try {
    const initial = await openSession(value);
    const initialCapability = initial.finalResults[0]!.persistenceCapability;
    await flushCapabilities(value, initial, [initialCapability]);
    const probe = value.checkpoint.bindProbeStore(value.probeCaller);
    const before = await probe.loadRetryable(value.run.runId, value.candidates[0]!.familyCandidateKey);
    const beforeEnvelope = activeRunEnvelope(value);

    behavior.materialization = "verified";
    const replacementSession = openSessionFor(value, before.candidatePartition);
    const replacementIdentity = await replacementSession.resolveIdentityOrReuseProofOnce(before.before.familyCandidateKey, new AbortController().signal);
    assert.equal(replacementIdentity.kind, "identityVerified");
    const replacement = await replacementSession.materializeAndProjectOnce(
      replacementIdentity.continuation,
      new AbortController().signal,
    );
    assert.equal(replacement.outcome.kind, "verified");

    value.armPostCommitCanonicalFailure();
    await assert.rejects(
      () => probe.replaceRetryableCAS(
        before.probeCapability,
        replacementSession.writerCapability,
        replacement.persistenceCapability,
      ),
      /canonical|fence|revoked|reorg|no longer active/i,
    );
    const afterEnvelope = activeRunEnvelope(value);
    assert.notEqual(afterEnvelope.checkpointRevision, beforeEnvelope.checkpointRevision);
    assert.deepEqual(afterEnvelope.accounting, {
      pending: "0",
      verified: "1",
      chainProvenRejected: "0",
      retryable: "0",
      invalidProgram: "0",
    });
    assert.equal(persistedOutcome(value, before.before.familyCandidateKey).kind, "verified");
    assert.throws(
      () => value.authority.claimWriterCapabilities(
        replacementSession.writerCapability,
        [replacement.persistenceCapability],
      ),
      /consumed|not-issued/i,
    );
  } finally {
    value.close();
  }
});

test("writer rejects a cloned persistence capability and a cross-session capability", async () => {
  const value = await makeHarness(1);
  try {
    const fixture = await openSession(value);
    const clone = { ...fixture.persistenceCapabilities[0]! } as AttestationPersistenceCapabilityV1;
    const cloneWriter = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: fixture.session.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await cloneWriter.enqueue(clone);
    await assert.rejects(() => cloneWriter.closeAfterAllProducersAndFlush(), /not-issued|capability/i);

    const otherSession = openSessionFor(value);
    const otherIdentity = await otherSession.resolveIdentityOrReuseProofOnce(value.candidates[0]!.familyCandidateKey, new AbortController().signal);
    assert.equal(otherIdentity.kind, "identityVerified");
    const crossWriter = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: fixture.session.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await crossWriter.enqueue(otherIdentity.persistenceCapability);
    await assert.rejects(() => crossWriter.closeAfterAllProducersAndFlush(), /binding|mismatch|session|not-issued|consumed/i);
  } finally {
    value.close();
  }
});

test("duplicate persistence capability cannot be consumed twice", async () => {
  const value = await makeHarness(1);
  try {
    const fixture = await openSession(value);
    const capability = fixture.persistenceCapabilities[0]!;
    const writer = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: fixture.session.writerCapability,
      flushEveryItems: 2,
      flushEveryMs: 2_000,
    });
    await writer.enqueue(capability);
    await writer.enqueue(capability);
    await assert.rejects(() => writer.closeAfterAllProducersAndFlush(), /duplicate|consumed|capability/i);
  } finally {
    value.close();
  }
});

test("checkpoint rejects a validation authority that was not engine-issued", async () => {
  const value = await makeHarness(1);
  try {
    assert.throws(
      () => new CheckpointStore(
        value.durable,
        value.source,
        value.probeCaller,
        value.promotionAuthority,
        {} as never,
        createCandidatePartitionProofIssuerFixture(
          value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding,
        ),
      ),
      /attestation-validation-authority-not-issued|attestation-authority-invalid/i,
    );
  } finally {
    value.close();
  }
});

test("checkpoint rejects a shape-complete candidate partition proof issuer that was not release-issued", async () => {
  const value = await makeHarness(1);
  try {
    const binding = value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding;
    const real = createCandidatePartitionProofIssuerFixture(binding);
    const fake = Object.freeze({ currentRelease: real.currentRelease, issue: real.issue, verify: real.verify });
    assert.throws(
      () => new CheckpointStore(value.durable, value.source, value.probeCaller, value.promotionAuthority, value.authority, fake),
      /proof issuer.*not release-issued|proof-issuer-invalid/i,
    );
  } finally { value.close(); }
});

test("session sealing fails before final persistence and succeeds from exact durable hashes", async () => {
  const value = await makeHarness(1);
  try {
    const fixture = await openSession(value);
    const final = fixture.finalResults[0]!;
    assert.throws(
      () => fixture.session.sealExactPartition([candidateFinalOutcomeHash(final.outcome)]),
      /writer-not-drained|persistence/i,
    );
    await flushCapabilities(value, fixture, fixture.persistenceCapabilities);
    const partition = fixture.session.sealExactPartition([candidateFinalOutcomeHash(final.outcome)]);
    await value.checkpoint.sealAttestationPartition(value.run.runId, partition);
    const envelope = activeRunEnvelope(value);
    assert.ok(envelope.attestationPartitionStorageHash);
    assert.equal(envelope.partialOutcomePartitionStorageHash, null);
  } finally {
    value.close();
  }
});

test("candidate partition capability rejects clones, restart-old handles, and cross-checkpoint handles", async () => {
  const value = await makeHarness(1);
  const other = await makeHarness(1);
  try {
    const capability = value.run.candidatePartition;
    assert.deepEqual(Object.keys(capability), []);
    assert.throws(
      () => value.service.openRunSession({ candidatePartition: { ...capability } }),
      /candidate.*partition|not.*issued|capability/i,
    );
    assert.throws(
      () => value.service.openRunSession({ candidatePartition: other.run.candidatePartition }),
      /candidate.*partition|not.*issued|capability/i,
    );

    value.durable.close();
    value.durable = createSqliteDurableStore(value.filename);
    value.partitionBootstrap = createCandidatePartitionBootstrap();
    const restartedService = makeAttestationService(
      { identity: 0, materialization: 0 },
      "",
      undefined,
      value.approval,
      candidatePartitionBootstrapReader(value.partitionBootstrap),
    );
    const restartedCheckpoint = new CheckpointStore(
      value.durable,
      value.source,
      value.probeCaller,
      value.promotionAuthority,
      restartedService.validationAuthority,
      createCandidatePartitionProofIssuerFixture(
        value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding,
      ),
      value.partitionBootstrap,
    );
    assert.doesNotThrow(
      () => value.service.openRunSession({ candidatePartition: capability }),
      "a still-live old process owner retains its own capability; process restart is not simulated in-process",
    );
    const current = await restartedCheckpoint.loadRun(value.run.runId);
    assert.doesNotThrow(() => restartedService.openRunSession({ candidatePartition: current.candidatePartition }));
  } finally {
    value.close();
    other.close();
  }
});

test("candidate partition proof cannot be resigned under an unknown issuer key", async () => {
  const value = await makeHarness(1);
  try {
    const envelope = activeRunEnvelope(value);
    const proofHash = envelope.candidatePartitionProofStorageHash as Hash;
    const proofRecord = value.durable.readContent(proofHash);
    assert.ok(proofRecord);
    const proof = decodeCanonicalJson(proofRecord.bytes) as Record<string, unknown>;
    const unknownKey = h("unknown-candidate-partition-issuer");
    const mutated = {
      ...proof,
      issuerKeyId: unknownKey,
      signerKeyId: unknownKey,
    };
    const binding = value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding;
    const issuer = createCandidatePartitionProofIssuerFixture(binding);
    assert.throws(
      () => issuer.verify(mutated, {
        binding: value.run.candidatePartitionBinding,
        release: {
          releaseProvenanceHash: value.run.candidatePartitionBinding.releaseProvenanceHash,
          releaseAuthorityRoot: binding.releaseAuthorityRoot,
          candidatePartitionProofIssuerKeyId: binding.candidatePartitionProofIssuerKeyId,
        },
      }),
      /issuer|key|signature|binding|payload hash/i,
    );
  } finally {
    value.close();
  }
});

test("joint candidate-manifest-run-root recomputation cannot bypass the signed partition proof", async () => {
  const value = await makeHarness(1);
  try {
    rewriteCandidatePartitionWithoutProof(value);
    await assert.rejects(
      () => value.checkpoint.loadRun(value.run.runId),
      /candidate partition proof|proof|binding|mismatch|corrupt/i,
    );
  } finally {
    value.close();
  }
});

test("ready restart revalidates the candidate manifest/records closure and rejects a replaced manifest", async () => {
  const value = await makeHarness(1);
  try {
    const ready = await activateReadyForHarness(value);
    const loaded = await value.checkpoint.loadReadyClosure(ready);
    assert.equal(loaded.graph.graphRoot, ready.graphRoot);

    value.durable.close();
    value.durable = createSqliteDurableStore(value.filename);
    value.partitionBootstrap = createCandidatePartitionBootstrap();
    const restartedBinding = value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding;
    value.checkpoint = new CheckpointStore(
      value.durable,
      value.source,
      value.probeCaller,
      value.promotionAuthority,
      value.authority,
      createCandidatePartitionProofIssuerFixture(restartedBinding),
      value.partitionBootstrap,
    );
    await value.checkpoint.loadReadyClosure(ready);

    const lease = value.durable.acquireWriterLease("checkpoint-test-ready-candidate-manifest-replacement");
    try {
      value.durable.transaction(lease, tx => {
        const rootRecord = tx.readRoot();
        assert.ok(rootRecord);
        const root = CHECKPOINT_SCHEMA_AUTHORITY.decodeRoot(rootRecord.envelopeBytes);
        const closureHash = rootRecord.references.find(hash => tx.readContent(hash)?.kind === "aloha/ready-closure/v1");
        assert.ok(closureHash);
        const closureRecord = tx.readContent(closureHash);
        assert.ok(closureRecord);
        const closure = CHECKPOINT_SCHEMA_AUTHORITY.decodeReadyClosure(closureRecord.bytes);
        const manifestRecord = tx.readContent(String(closure.candidatePartitionStorageHash) as Hash);
        assert.ok(manifestRecord);
        const manifest = decodeCanonicalJson(manifestRecord.bytes) as Record<string, unknown>;
        const pageHash = String((manifest.pageStorageHashes as unknown[])[0]) as Hash;
        const pageRecord = tx.readContent(pageHash);
        assert.ok(pageRecord);
        const page = decodeCanonicalJson(pageRecord.bytes) as Record<string, unknown>;
        const entry = (page.entries as Record<string, unknown>[])[0]!;
        const candidateRecord = tx.readContent(String(entry.storageHash) as Hash);
        assert.ok(candidateRecord);
        const candidateValue = decodeCanonicalJson(candidateRecord.bytes) as Record<string, unknown>;
        const replacementCandidateHash = tx.putImmutable(
          "aloha/candidate-record/v1",
          encodeCanonicalBytes({ ...candidateValue, candidateSnapshotHash: h("ready-manifest-replacement") }),
          candidateRecord.references,
        );
        const replacementPageHash = tx.putImmutable(
          "aloha/checkpoint-partition-page/v1",
          encodeCanonicalBytes({ ...page, entries: [{ ...entry, storageHash: replacementCandidateHash }] }),
          [replacementCandidateHash],
        );
        const replacementManifestHash = tx.putImmutable(
          "aloha/checkpoint-partition-manifest/v1",
          encodeCanonicalBytes({ ...manifest, pageStorageHashes: [replacementPageHash] }),
          [replacementPageHash],
        );
        const replacementClosure = {
          ...closure,
          candidatePartitionStorageHash: replacementManifestHash,
        };
        const replacementClosureHash = tx.putImmutable(
          "aloha/ready-closure/v1",
          encodeCanonicalBytes(replacementClosure),
          [
            replacementClosure.sourceCoverageStorageHash,
            replacementClosure.candidatePartitionStorageHash,
            replacementClosure.candidatePartitionCommitmentStorageHash,
            replacementClosure.candidatePartitionProofStorageHash,
            replacementClosure.verifiedMemoSetStorageHash,
            replacementClosure.instanceCatalogStorageHash,
            replacementClosure.graphStorageHash,
          ],
        );
        const nextRevision = (BigInt(root.revision) + 1n).toString();
        tx.compareAndSwapRoot(
          root.revision,
          encodeCanonicalBytes({ ...root, revision: nextRevision }),
          rootRecord.references.map(hash => hash === closureHash ? replacementClosureHash : hash),
        );
      });
    } finally {
      value.durable.releaseWriterLease(lease);
    }
    await assert.rejects(
      () => value.checkpoint.loadReadyClosure(ready),
      /candidate partition|closure|manifest|physical|mismatch|corrupt/i,
    );
  } finally {
    value.close();
  }
});

test("checkpoint content authority rejects a runtime release rotation during its async read", async () => {
  const value = await makeHarness(1);
  try {
    const ready = await activateReadyForHarness(value);
    let rotated = false;
    queueMicrotask(() => {
      const nextApproval = releaseApproval(
        h("framework:checkpoint-content-rotation"),
        h("executor:checkpoint-content-rotation"),
        "epoch-checkpoint-content-rotation",
        h("executor-session:checkpoint-content-rotation"),
      );
      const nextBinding = nextApproval.resolver.resolve(nextApproval.capability).provenance.runtimeBinding;
      rotateReleaseApproval(value.approval, {
        frameworkAuthorityRoot: nextBinding.frameworkAuthorityRoot,
        executorAuthorityRoot: nextBinding.executorAuthorityRoot,
        workerEpoch: nextBinding.workerEpoch,
        executorSessionHash: nextBinding.executorSessionHash,
        releaseAuthorityRoot: nextBinding.releaseAuthorityRoot,
      });
      value.setCurrentProofBinding(nextBinding);
      rotated = true;
    });
    await assert.rejects(
      () => value.checkpoint.assertContentRoot("candidate-partition", ready.candidatePartitionRoot),
      /release|rotat|binding|current|commitment root mismatch/i,
    );
    assert.equal(rotated, true);
  } finally {
    value.close();
  }
});

test("checkpoint content authority rejects an already-rotated release even when it stays stable during the read", async () => {
  const value = await makeHarness(1);
  try {
    const ready = await activateReadyForHarness(value);
    const nextApproval = releaseApproval(
      h("framework:checkpoint-pre-rotated"),
      h("executor:checkpoint-pre-rotated"),
      "epoch-checkpoint-pre-rotated",
      h("executor-session:checkpoint-pre-rotated"),
    );
    value.setCurrentProofBinding(
      nextApproval.resolver.resolve(nextApproval.capability).provenance.runtimeBinding,
    );
    await assert.rejects(
      () => value.checkpoint.assertContentRoot("candidate-partition", ready.candidatePartitionRoot),
      /release|stale|binding/i,
    );
  } finally {
    value.close();
  }
});

test("duplicate durable partial resume load is rejected rather than minting a second capability", async () => {
  const value = await makeHarness(1);
  try {
    const session = openSessionFor(value);
    const identity = await session.resolveIdentityOrReuseProofOnce(
      value.candidates[0]!.familyCandidateKey,
      new AbortController().signal,
    );
    const writer = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: session.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await writer.enqueue(identity.persistenceCapability);
    await writer.closeAfterAllProducersAndFlush();
    const first = await value.checkpoint.loadIdentityResumeCapabilities(value.run.runId);
    assert.equal(first.length, 1);
    await assert.rejects(
      () => value.checkpoint.loadIdentityResumeCapabilities(value.run.runId),
      /already claimed|resume|capability/i,
    );
  } finally {
    value.close();
  }
});

test("probe capability is one-shot and rejects a stale revision and a cross-run persistence capability", async () => {
  const behavior: AttestationTestBehavior = { materialization: "retryable" };
  const value = await makeHarness(2, { behavior });
  const other = await makeHarness(1, { behavior: { materialization: "retryable" } });
  try {
    const initial = await openSession(value);
    await flushCapabilities(value, initial, initial.finalResults.map(result => result.persistenceCapability));
    const probe = value.checkpoint.bindProbeStore(value.probeCaller);
    const before = await probe.loadRetryable(value.run.runId, value.candidates[0]!.familyCandidateKey);

    const otherInitial = await openSession(other);
    await flushCapabilities(other, otherInitial, otherInitial.finalResults.map(result => result.persistenceCapability));
    const otherProbe = other.checkpoint.bindProbeStore(other.probeCaller);
    const otherBefore = await otherProbe.loadRetryable(other.run.runId, other.candidates[0]!.familyCandidateKey);
    const otherReplacementSession = openSessionFor(other, otherBefore.candidatePartition);
    const otherIdentity = await otherReplacementSession.resolveIdentityOrReuseProofOnce(
      otherBefore.before.familyCandidateKey,
      new AbortController().signal,
    );
    if (otherIdentity.kind !== "identityVerified") throw new Error("other probe fixture did not produce identity");
    const otherFinal = await otherReplacementSession.materializeAndProjectOnce(
      otherIdentity.continuation,
      new AbortController().signal,
    );
    await assert.rejects(
      () => probe.replaceRetryableCAS(
        before.probeCapability,
        otherReplacementSession.writerCapability,
        otherFinal.persistenceCapability,
      ),
      /not-issued|lineage|session|run|binding/i,
    );

    behavior.materialization = "verified";
    const replacementSession = openSessionFor(value, before.candidatePartition);
    const replacementIdentity = await replacementSession.resolveIdentityOrReuseProofOnce(
      before.before.familyCandidateKey,
      new AbortController().signal,
    );
    if (replacementIdentity.kind !== "identityVerified") throw new Error("replacement fixture did not produce identity");
    const replacementFinal = await replacementSession.materializeAndProjectOnce(
      replacementIdentity.continuation,
      new AbortController().signal,
    );
    await probe.replaceRetryableCAS(
      before.probeCapability,
      replacementSession.writerCapability,
      replacementFinal.persistenceCapability,
    );
    await assert.rejects(
      () => probe.replaceRetryableCAS(
        before.probeCapability,
        replacementSession.writerCapability,
        replacementFinal.persistenceCapability,
      ),
      /used|revision|state conflict|probe|consumed/i,
    );
  } finally {
    value.close();
    other.close();
  }
});

test("sealed run capability is opaque, store-owned, immutable-bound, and one seal only", async () => {
  const value = await makeHarness(1);
  const other = await makeHarness(1);
  try {
    const fixture = await openSession(value);
    await flushCapabilities(value, fixture, fixture.finalResults.map(result => result.persistenceCapability));
    const partition = fixture.session.sealExactPartition(
      fixture.finalResults.map(result => candidateFinalOutcomeHash(result.outcome)),
    );
    const capability = await value.checkpoint.sealAttestationPartition(value.run.runId, partition);
    assert.deepEqual(Object.keys(capability), []);
    const firstBinding = value.checkpoint.sealedRunReader.binding(capability);
    assert.equal(Object.isFrozen(firstBinding), true);
    assert.equal(Object.isFrozen(firstBinding.cutoff), true);
    assert.throws(
      () => { (firstBinding as { runId: string }).runId = "tampered"; },
      /read only property|not extensible/i,
    );
    assert.deepEqual(value.checkpoint.sealedRunReader.binding(capability), firstBinding);
    await assert.rejects(
      () => value.checkpoint.sealCompletedRunAsMemoSeedAndClearCAS({ ...capability }),
      /not checkpoint-issued|capability/i,
    );
    await assert.rejects(
      () => other.checkpoint.sealCompletedRunAsMemoSeedAndClearCAS(capability),
      /not checkpoint-issued|capability/i,
    );
    await assert.rejects(
      () => value.checkpoint.sealAttestationPartition(value.run.runId, partition),
      /already sealed/i,
    );
  } finally {
    value.close();
    other.close();
  }
});
