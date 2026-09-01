import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  candidateFinalOutcomeHash,
  identityMemoHash,
  type AttestationProgramPort,
  type InstanceLifecycleSingleFlightPort,
  type RawEffectObservationV1,
  type RawTransportExecutionRecordV1,
  type RejectionTransportExecutorV1,
} from "../../attestation/src/index.ts";
import {
  createAttestationService,
  createFrameworkFailureRuntime,
  createRejectionExecutorAuthorityIssuer,
  createRejectionFactRuntime,
} from "../../attestation/src/internal/composition.ts";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { erc20AssetPortBindingV1 } from "../../asset-ref/src/index.ts";
import { sealInstancePublication } from "../../catalog/src/index.ts";
import {
  candidatePartitionRoot,
  mergeAndDedupeNominations,
  sealPersistedSourcePlanExecution,
  sealPersistedSourcePlanExecutionSet,
  sealSourceCoverage,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  sourcePlanIdentity,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
} from "../../discovery/src/index.ts";
import { sealRecentObservation } from "../../observation/src/index.ts";
import { createCanonicalSource, SQLiteCanonicalJournalStore } from "../../canonical-source/src/index.ts";
import { createSqliteDurableStore } from "../../durable-store/src/index.ts";
import { createReadyPromotionAuthority } from "../../ready-generation/src/index.ts";
import {
  createRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";
import {
  nominationEvidenceRefHash,
  sealNominationClosureV1,
  sealQualifiedSourcePlanNominationReceiptV1,
} from "../../../specs/nomination-authority/src/index.ts";
import {
  CheckpointStore,
  type CheckpointSixStepArtifactPortV1,
} from "../src/index.ts";
import { issueCheckpointSixStepArtifactPortV1 } from "../src/internal/six-step-artifact-port-owner.ts";
import {
  candidatePartitionBootstrapReader,
  createCandidatePartitionBootstrap,
} from "../src/candidate-partition.ts";

const h = (label: string): Hash => hashDomain("test/checkpoint-runtime", label);
const cutoff: CanonicalCutoffV1 = Object.freeze({
  chainId: "1",
  number: "49",
  hash: h("block:49"),
  stateRoot: h("state:49"),
});
const head = Object.freeze({ ...cutoff, parentHash: h("block:48") });
const policy = Object.freeze({
  observationWindowBlocks: "50" as const,
  targetRefreshAgeBlocks: "10",
  maxServingAgeBlocks: "30",
  minPromotionMarginBlocks: "2",
  maxInProgressRuns: "1" as const,
});

function rawLocator(label: string) {
  const bytes = encodeCanonicalBytes({ kind: "chain-log", label });
  return Object.freeze({
    kind: "raw-evidence-locator" as const,
    version: 1 as const,
    rawLocatorHash: sha256Hex(bytes),
    bytes,
  });
}

function candidate(label: string, locator: ReturnType<typeof rawLocator>): CandidateRecordV1 {
  return mergeAndDedupeNominations([{
    kind: "aloha.candidate-nomination",
    version: "2",
    familyId: "family-a",
    familyDefinitionHash: h("family-definition"),
    instanceNominationKey: `instance-${label}`,
    evidence: {
      kind: "recent-log",
      version: 1,
      sourcePlanRef: null,
      ownerRef: null,
      blockNumber: cutoff.number,
      blockHash: cutoff.hash,
      txHash: h(`tx:${label}`),
      logIndex: "0",
      address: `0x${"1".repeat(40)}`,
      topic: h(`topic:${label}`),
      rawLocatorHash: locator.rawLocatorHash,
    },
  }])[0]!;
}

function runtimeAuthority() {
  return projectRuntimeAuthorityDescriptorV1(createRuntimeAuthorityDescriptorV1({
    runtimeBindingId: h("runtime-binding"),
    implementationCommit: "a".repeat(40),
  }));
}

function lifecycle(): InstanceLifecycleSingleFlightPort {
  return Object.freeze({ async getOrBuild<T>(_key: string, build: () => Promise<T>) { return build(); } });
}

function sixStepArtifacts(): CheckpointSixStepArtifactPortV1 {
  return issueCheckpointSixStepArtifactPortV1(Object.freeze({
    async emitVerifiedOutcome() { return Object.freeze(Object.create(null)); },
    async emitReadyEdge() { return Object.freeze(Object.create(null)); },
  }));
}

function programs(): AttestationProgramPort {
  const result: AttestationProgramPort = {
    async attestIdentity(value: CandidateRecordV1) {
      const memo = { kind: "checkpoint-identity-memo", value: value.familyCandidateKey } as const;
      return Object.freeze({
        kind: "identityVerified" as const,
        familyInstanceKey: value.instanceNominationKey,
        identityMemo: memo,
        identityMemoHash: identityMemoHash(memo),
        descriptorHash: h("descriptor"),
        evidenceRoot: value.candidateEvidenceRoot,
      });
    },
    async reuseVerifiedMemo() { return Object.freeze({ kind: "requiresAttestation" as const }); },
    async materializeAndProject(value, identity) {
      return Object.freeze({
        kind: "verified" as const,
        publication: sealInstancePublication({
          familyId: value.familyId,
          familyDefinitionHash: value.familyDefinitionHash,
          familyCandidateKey: value.familyCandidateKey,
          instanceKey: value.instanceNominationKey,
          cutoff,
          identityMemo: identity.identityMemo,
          identityMemoHash: identity.identityMemoHash,
          descriptorHash: identity.descriptorHash,
          staticProjectionMemoHash: h("static-projection-memo"),
          requestedArtifactDependencyRoot: h("requested-artifacts"),
          validityDependencyRoot: h("validity"),
          transitions: [{
            inputAssetPorts: [{ ...erc20AssetPortBindingV1("1", `0x${"2".repeat(40)}`), portRef: h("in-port"), ordinal: "0" }],
            outputAssetPorts: [{ ...erc20AssetPortBindingV1("1", `0x${"3".repeat(40)}`), portRef: h("out-port"), ordinal: "0" }],
            opaqueTransitionRef: h("transition"),
            constraintRefs: [],
            staticProjectionHash: h("static-projection"),
          }],
          evidenceRoot: identity.evidenceRoot,
        }),
      });
    },
  };
  return Object.freeze(result);
}

function makeService(
  authority: ReturnType<typeof runtimeAuthority>,
  reader: ReturnType<typeof candidatePartitionBootstrapReader>,
) {
  const frameworkRuntime = createFrameworkFailureRuntime(authority, Object.freeze({ classify() { return null; } }));
  const executorIssuer = createRejectionExecutorAuthorityIssuer({
    runtimeAuthority: authority,
    workerEpoch: "epoch-1",
    executorSessionHash: h("executor-session"),
  });
  let executorAuthorityRoot = h("uninitialized-executor-authority");
  const executor: RejectionTransportExecutorV1 = {
    async execute(program) {
      const source = Object.freeze({
        chainId: cutoff.chainId,
        blockNumber: cutoff.number,
        blockHash: cutoff.hash,
        stateRoot: cutoff.stateRoot,
        executorAuthorityRoot,
        workerEpoch: "epoch-1",
        executorSessionHash: h("executor-session"),
      });
      const transport: RawTransportExecutionRecordV1 = Object.freeze({
        requestId: program.request.requestId,
        kind: "returned",
        data: encodeCanonicalBytes({ ok: true }),
        source,
      });
      const effect: RawEffectObservationV1 = Object.freeze({
        requestId: program.request.requestId,
        source,
        observation: { ok: true },
      });
      return Object.freeze({ transport: [transport], effects: [effect] });
    },
  };
  const executorCapability = executorIssuer.issue(executor);
  executorAuthorityRoot = executorCapability.authorityRoot;
  const rejectionRuntime = createRejectionFactRuntime(executorCapability);
  return createAttestationService({
    runtimeAuthority: authority,
    frameworkRuntime,
    rejectionRuntime,
    programs: programs(),
    instanceLifecycle: lifecycle(),
    candidatePartitionReader: reader,
  });
}

interface Harness {
  readonly directory: string;
  readonly filename: string;
  durable: ReturnType<typeof createSqliteDurableStore>;
  readonly journal: SQLiteCanonicalJournalStore;
  readonly source: ReturnType<typeof createCanonicalSource>;
  readonly authority: ReturnType<typeof runtimeAuthority>;
  service: ReturnType<typeof makeService>;
  checkpoint: CheckpointStore;
  run: Awaited<ReturnType<CheckpointStore["loadRun"]>>;
  close(): void;
}

async function harness(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "aloha-checkpoint-runtime-"));
  const filename = join(directory, "checkpoint.sqlite");
  const journal = new SQLiteCanonicalJournalStore(join(directory, "canonical.sqlite"));
  const source = createCanonicalSource({
    async getLatestHeader() { return head; },
    async getHeader(number) {
      return number === cutoff.number
        ? { kind: "found" as const, header: head }
        : { kind: "unavailable" as const, failureCode: "not-indexed" };
    },
  }, { journalStore: journal });
  await source.freezeView();
  const durable = createSqliteDurableStore(filename);
  const authority = runtimeAuthority();
  const bootstrap = createCandidatePartitionBootstrap();
  const service = makeService(authority, candidatePartitionBootstrapReader(bootstrap));
  const promotionAuthority = createReadyPromotionAuthority(
    () => ({ definitionCatalogRoot: h("definitions"), policy }),
    Object.freeze({ readCurrent: () => Object.freeze({ runtimeAuthority: authority }) }),
  );
  const checkpoint = new CheckpointStore(
    durable,
    source,
    Object.freeze({}),
    promotionAuthority,
    service.validationAuthority,
    sixStepArtifacts(),
    bootstrap,
  );
  const locator = rawLocator("a");
  const value = candidate("a", locator);
  const recentEvidence = value.evidence.filter(evidence => evidence.kind === "recent-log");
  const blocks = Array.from({ length: 50 }, (_, index) => ({
    number: String(index),
    hash: index === 49 ? cutoff.hash : h(`block:${index}`),
    parentHash: index === 0 ? h("genesis-parent") : h(`block:${index - 1}`),
    evidence: index === 49 ? recentEvidence : [],
  }));
  const recentObservation = sealRecentObservation(
    cutoff,
    source.recentObservationRange(cutoff),
    blocks,
    [locator],
  );
  const plan = Object.freeze({
    ownerRef: h("source-owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash: value.familyDefinitionHash,
    completeness: "nomination-only" as const,
    historyStartBlock: null,
  });
  const sourcePlanEvidence = [Object.freeze({
    kind: "source-plan-evidence" as const,
    version: 1 as const,
    plan,
    cutoff,
    refs: [],
    rawLocatorHashes: [],
    evidenceRoot: sourcePlanEvidenceRoot({ plan, cutoff, refs: [], rawLocatorHashes: [] }),
  })];
  const executionCore = Object.freeze({
    kind: "source-plan-execution" as const,
    version: 1 as const,
    plan,
    cutoff,
    outcome: "complete" as const,
    from: cutoff.number,
    through: cutoff.number,
    previousAppliedThrough: null,
    resultPartitionRoot: h("source-result-partition"),
    opaqueResult: { kind: "test-source-result", value: "complete" } as const,
    sourceEvidenceRefs: [],
    rawLocatorHashes: [],
    sourceEvidenceRoot: sourcePlanEvidence[0]!.evidenceRoot,
  });
  const execution = Object.freeze({ ...executionCore, executionRoot: sourcePlanExecutionRoot(executionCore) });
  const sourceCoverage = sealSourceCoverage(cutoff, [plan], [execution]);
  const sourceExecutionSet = sealPersistedSourcePlanExecutionSet(cutoff, [sealPersistedSourcePlanExecution({
    execution,
    sourcePlanLeafDigest: h("source-plan-leaf"),
    sourcePlanSchemaHash: h("source-plan-schema"),
    sourcePlanClosureRoot: h("source-plan-closure"),
    sourceAuthorityRoot: h("source-authority"),
    runtimeAuthority: authority,
    sourceAnchorRoot: h("source-anchor"),
    previousExecutionRoot: null,
  })]);
  const evidenceRefHash = nominationEvidenceRefHash(value.evidence[0]!);
  const nominationReceipt = sealQualifiedSourcePlanNominationReceiptV1({
    cutoff,
    familyId: value.familyId,
    familyDefinitionHash: value.familyDefinitionHash,
    sourcePlanIdentity: sourcePlanIdentity(plan),
    sourcePlanLeafDigest: h("source-plan-leaf"),
    nominationProgramRoot: h("nomination-program"),
    nominationProgramProposalLeafDigest: h("nomination-proposal"),
    qualificationRoot: h("nomination-qualification"),
    denominator: {
      kind: "recent-observation",
      recentObservationRoot: recentObservation.observationRoot,
      relevantEvidenceRefHashes: [evidenceRefHash],
      relevantEvidenceRoot: hashCanonicalPartition("aloha/relevant-nomination-evidence/v1", [evidenceRefHash]),
      relevantEvidenceCount: "1",
    },
    claims: [{
      sourcePlanIdentity: sourcePlanIdentity(plan),
      familyCandidateKey: value.familyCandidateKey,
      instanceNominationKey: value.instanceNominationKey,
      evidenceRefHash,
    }],
  });
  const candidates = [value];
  const nominationClosure = sealNominationClosureV1({
    cutoff,
    recentObservationRoot: recentObservation.observationRoot,
    sourceExecutionSetRoot: sourceExecutionSet.executionSetRoot,
    sourceCoverageRoot: sourceCoverage.sourceCoverageRoot,
    sourcePlanIdentities: [sourcePlanIdentity(plan)],
    receipts: [nominationReceipt],
    candidates,
    candidatePartitionRoot: candidatePartitionRoot(candidates),
  });
  const root = await checkpoint.loadAndValidateRoot();
  const run = await checkpoint.beginNewRunAndPersistPartition({
    expectedRootRevision: root.revision,
    parentGenerationId: root.readyGenerationId,
    cutoff,
    recentObservation,
    sourcePlanEvidence,
    definitionCatalogRoot: h("definitions"),
    sourceCoverage,
    sourceExecutionSet,
    nominationClosure,
    candidates,
    recentRawEvidenceLocators: [locator],
    sourcePlanRawEvidenceLocators: [],
  });
  return {
    directory,
    filename,
    durable,
    journal,
    source,
    authority,
    service,
    checkpoint,
    run,
    close(this: Harness) {
      this.durable.close();
      this.journal.close();
      rmSync(this.directory, { recursive: true, force: true });
    },
  };
}

test("candidate commitment is exact and checkpoint-issued", async () => {
  const value = await harness();
  try {
    assert.deepEqual(value.run.candidatePartitionBinding.runtimeAuthority, value.authority);
    assert.equal(value.checkpoint.candidatePartitionReader.listKeys(value.run.candidatePartition).length, 1);
    assert.throws(
      () => value.checkpoint.candidatePartitionReader.listKeys({ ...value.run.candidatePartition }),
      /not checkpoint-issued|invalid/i,
    );
  } finally {
    value.close();
  }
});

test("partial commitment survives reopen and final persistence removes it", async () => {
  const value = await harness();
  try {
    const session = value.service.openRunSession({ candidatePartition: value.run.candidatePartition });
    const identity = await session.resolveIdentityOrReuseProofOnce(
      value.run.candidatePartitionBinding.candidateKeysRoot === h("never")
        ? h("never")
        : value.checkpoint.candidatePartitionReader.listKeys(value.run.candidatePartition)[0]!,
      new AbortController().signal,
    );
    assert.equal(identity.kind, "identityVerified");
    if (identity.kind !== "identityVerified") throw new Error("identity was not verified");
    const partialWriter = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: session.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await partialWriter.enqueue(identity.persistenceCapability);
    await partialWriter.closeAfterAllProducersAndFlush();
    assert.equal(value.durable.listIndex(`partial-outcome/${value.run.runId}`).length, 1);

    value.durable.close();
    value.durable = createSqliteDurableStore(value.filename);
    const bootstrap = createCandidatePartitionBootstrap();
    value.service = makeService(value.authority, candidatePartitionBootstrapReader(bootstrap));
    value.checkpoint = new CheckpointStore(
      value.durable,
      value.source,
      Object.freeze({}),
      createReadyPromotionAuthority(
        () => ({ definitionCatalogRoot: h("definitions"), policy }),
        Object.freeze({ readCurrent: () => Object.freeze({ runtimeAuthority: value.authority }) }),
      ),
      value.service.validationAuthority,
      sixStepArtifacts(),
      bootstrap,
    );
    value.run = await value.checkpoint.loadRun(value.run.runId);
    const resume = await value.checkpoint.loadAttestationResumeCapabilities(value.run.runId);
    assert.equal(resume.identity.length, 1);
    const resumed = value.service.openRunSession({
      candidatePartition: value.run.candidatePartition,
      identityResumeCapabilities: resume.identity,
    });
    const resumedIdentity = await resumed.resolveIdentityOrReuseProofOnce(
      value.checkpoint.candidatePartitionReader.listKeys(value.run.candidatePartition)[0]!,
      new AbortController().signal,
    );
    assert.equal(resumedIdentity.kind, "identityVerified");
    if (resumedIdentity.kind !== "identityVerified") throw new Error("identity resume failed");
    const final = await resumed.materializeAndProjectOnce(resumedIdentity.continuation, new AbortController().signal);
    const finalWriter = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: resumed.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await finalWriter.enqueue(final.persistenceCapability);
    await finalWriter.closeAfterAllProducersAndFlush();
    resume.claim.commit();
    assert.equal(value.durable.listIndex(`partial-outcome/${value.run.runId}`).length, 0);
    const partition = resumed.sealExactPartition([candidateFinalOutcomeHash(final.outcome)]);
    await value.checkpoint.sealAttestationPartition(value.run.runId, partition);
  } finally {
    value.close();
  }
});

test("writer rejects cloned, cross-session, and duplicate persistence capabilities", async () => {
  const value = await harness();
  try {
    const key = value.checkpoint.candidatePartitionReader.listKeys(value.run.candidatePartition)[0]!;
    const first = value.service.openRunSession({ candidatePartition: value.run.candidatePartition });
    const identity = await first.resolveIdentityOrReuseProofOnce(key, new AbortController().signal);
    const cloneWriter = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: first.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await cloneWriter.enqueue({ ...identity.persistenceCapability } as never);
    await assert.rejects(() => cloneWriter.closeAfterAllProducersAndFlush(), /not-issued|capability/i);

    const second = value.service.openRunSession({ candidatePartition: value.run.candidatePartition });
    const other = await second.resolveIdentityOrReuseProofOnce(key, new AbortController().signal);
    const crossWriter = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: first.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await crossWriter.enqueue(other.persistenceCapability);
    await assert.rejects(() => crossWriter.closeAfterAllProducersAndFlush(), /session|binding|not-issued|capability/i);

    const duplicateWriter = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: second.writerCapability,
      flushEveryItems: 2,
      flushEveryMs: 2_000,
    });
    await duplicateWriter.enqueue(other.persistenceCapability);
    await duplicateWriter.enqueue(other.persistenceCapability);
    await assert.rejects(() => duplicateWriter.closeAfterAllProducersAndFlush(), /duplicate|consumed|capability/i);
  } finally {
    value.close();
  }
});

test("seal fails before durable drain and succeeds after exact final commitment", async () => {
  const value = await harness();
  try {
    const key = value.checkpoint.candidatePartitionReader.listKeys(value.run.candidatePartition)[0]!;
    const session = value.service.openRunSession({ candidatePartition: value.run.candidatePartition });
    const identity = await session.resolveIdentityOrReuseProofOnce(key, new AbortController().signal);
    if (identity.kind !== "identityVerified") throw new Error("identity was not verified");
    const final = await session.materializeAndProjectOnce(identity.continuation, new AbortController().signal);
    assert.throws(
      () => session.sealExactPartition([candidateFinalOutcomeHash(final.outcome)]),
      /writer-not-drained|persistence/i,
    );
    const writer = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: session.writerCapability,
      flushEveryItems: 2,
      flushEveryMs: 2_000,
    });
    await writer.enqueue(identity.persistenceCapability);
    await writer.enqueue(final.persistenceCapability);
    await writer.closeAfterAllProducersAndFlush();
    const partition = session.sealExactPartition([candidateFinalOutcomeHash(final.outcome)]);
    await value.checkpoint.sealAttestationPartition(value.run.runId, partition);
  } finally {
    value.close();
  }
});

test("checkpoint rejects a shape-only validation authority", async () => {
  const value = await harness();
  try {
    assert.throws(
      () => new CheckpointStore(
        value.durable,
        value.source,
        Object.freeze({}),
        createReadyPromotionAuthority(
          () => ({ definitionCatalogRoot: h("definitions"), policy }),
          Object.freeze({ readCurrent: () => Object.freeze({ runtimeAuthority: value.authority }) }),
        ),
        { ...value.service.validationAuthority } as never,
        sixStepArtifacts(),
      ),
      /attestation-authority-invalid|not[- ]issued/i,
    );
  } finally {
    value.close();
  }
});

test("persisted partial bytes carry only exact runtime and attestation authority facts", async () => {
  const value = await harness();
  try {
    const key = value.checkpoint.candidatePartitionReader.listKeys(value.run.candidatePartition)[0]!;
    const session = value.service.openRunSession({ candidatePartition: value.run.candidatePartition });
    const identity = await session.resolveIdentityOrReuseProofOnce(key, new AbortController().signal);
    const writer = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: session.writerCapability,
      flushEveryItems: 1,
      flushEveryMs: 2_000,
    });
    await writer.enqueue(identity.persistenceCapability);
    await writer.closeAfterAllProducersAndFlush();
    const indexed = value.durable.listIndex(`partial-outcome/${value.run.runId}`)[0]!;
    const record = value.durable.readContent(indexed.contentHash);
    assert.ok(record);
    const decoded = decodeCanonicalJson(record.bytes) as Record<string, unknown>;
    assert.ok(decoded.runtimeAuthority);
    assert.ok(decoded.attestationAuthorityRoot);
    assert.ok(decoded.frameworkAuthorityRoot);
    assert.ok(decoded.executorAuthorityRoot);
  } finally {
    value.close();
  }
});
