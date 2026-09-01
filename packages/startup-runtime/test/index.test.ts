import assert from "node:assert/strict";
import test from "node:test";
import {
  assertStartupObservationWindow,
  createGeneratedRouteHandleIssuer,
  readStartupFullFamilyEvidenceBinding,
  readStartupStage12Evidence,
  startStartupRuntime,
} from "../src/index.ts";
import { hashCanonicalPartition, hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { CanonicalSource, type CanonicalHead, type CanonicalJournalStorePort } from "../../canonical-source/src/index.ts";
import { sealInstanceCatalog } from "../../catalog/src/index.ts";
import {
  recentObservationRange,
  sealSourceCoverage,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
} from "../../discovery/src/index.ts";
import { buildPersistedGraph } from "../../graph/src/index.ts";
import {
  createReadyPromotionAuthority,
  generationRefreshPolicyHash,
  readyGenerationBaseHash,
  ReadyGenerationServiceV1,
  type ReadyActivationInputV1,
  type ReadyGenerationV1,
  type ReadyStageInputV1,
} from "../../ready-generation/src/index.ts";
import type { SealedRunBindingV1, SealedRunCapabilityV1, SealedRunSnapshotV1 } from "../../sealed-run-runtime/src/contract.ts";
import { issueCheckpointSealedRunReader } from "../../sealed-run-runtime/src/internal/reader-issuer.ts";
import { readyBindingPortForReleaseApproval, releaseApproval } from "../../attestation/test/authority-fixture.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../specs/release-authority/src/index.ts";
import {
  issueStartupReadyPort,
  startupReadyPromotionPort,
} from "../src/internal/ready-owner.ts";
import { assertIssuedStartupRuntime } from "../src/internal/runtime-owner.ts";
import {
  issueStartupSixStepRouteParentInvocationV1,
} from "../src/internal/six-step-route-parent-owner.ts";
import { sealEmptyNominationClosureFixture } from "../../../specs/nomination-authority/test/fixture.ts";
import { generatedCompositionFixture } from "./generated-composition-fixture.ts";
import {
  classifyNativeStartupPromotionRecovery,
  nativeStartupAuthoritiesEqual,
  pinNativeStartupAuthority,
  runNativeStartupStateMachineForExactAdapter,
} from "../src/internal/native-startup.ts";
import type {
  NativeStartupAuthorityProjectionV1,
  NativeStartupGenerationHandleV1,
  NativeStartupOwnerPortV1,
  NativeStartupPromotionBoundaryV1,
  NativeStartupPromotionRequestV1,
} from "../src/internal/native-startup-contract.ts";
import * as nativeContractModule from "../src/internal/native-startup-contract.ts";
import * as signedAdapterModule from "../src/internal/signed-release-native-startup-owner.ts";
import { registerCheckpointReadyFullFamilyEvidenceReader } from "../../checkpoint/src/internal/ready-full-family-evidence-issuer.ts";
import {
  createSignedReleaseRuntimeAuthorityDescriptorV1,
  createUnsignedDryRunRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../runtime-authority/src/index.ts";

const cutoff = { number: "100" };

const h = (value: string): Hash => hashDomain("test/startup-runtime", value);
const readyPolicy = {
  observationWindowBlocks: "50" as const,
  targetRefreshAgeBlocks: "20",
  maxServingAgeBlocks: "50",
  minPromotionMarginBlocks: "2",
  maxInProgressRuns: "1" as const,
};

class MemoryJournalStore implements CanonicalJournalStorePort {
  #token: string | null = null;
  #bytes: Uint8Array | null = null;
  load() {
    return this.#token === null || this.#bytes === null
      ? null
      : { token: this.#token, bytes: new Uint8Array(this.#bytes) };
  }
  compareAndSwap(expectedToken: string | null, bytes: Uint8Array): string {
    if (expectedToken !== this.#token) throw new Error("startup journal CAS conflict");
    this.#token = this.#token === null ? "1" : String(Number(this.#token) + 1);
    this.#bytes = new Uint8Array(bytes);
    return this.#token;
  }
}

test("startup admits exactly cutoff-49..cutoff and rejects shorter ranges", () => {
  assert.doesNotThrow(() => assertStartupObservationWindow(cutoff, { from: "51", to: "100" }));
  assert.throws(
    () => assertStartupObservationWindow(cutoff, { from: "52", to: "100" }),
    /startup-observation-window-not-50/,
  );
  assert.throws(
    () => assertStartupObservationWindow({ number: "48" }, { from: "0", to: "48" }),
    /startup-observation-window-not-50/,
  );
});

test("startup rejects structural Family composition fakes and clones", () => {
  const fake = {
    definitionCatalogRoot: "0x" + "1".repeat(64),
    openRehydrationSession() { return Object.freeze({}); },
    rehydrateRouteHandle() { return Object.freeze({ opaque: Object.freeze({}) }); },
  };
  assert.throws(() => createGeneratedRouteHandleIssuer(fake), /not generated/);
  assert.throws(() => createGeneratedRouteHandleIssuer({ ...fake }), /not generated/);
});

test("native startup has no owner registrar and null promotion recovery stays closed", () => {
  assert.deepEqual(Object.keys(nativeContractModule), ["decodeNativeStartupGenerationIdentityV1"]);
  assert.deepEqual(Object.keys(signedAdapterModule), [
    "startRuntimeAuthorityNativeStartupRuntime",
    "startSignedReleaseNativeStartupRuntime",
  ]);
  assert.equal(classifyNativeStartupPromotionRecovery(h("prior"), null, true), "keep-closed");
  assert.equal(classifyNativeStartupPromotionRecovery(h("prior"), h("prior"), true), "reopen-current");
  assert.equal(classifyNativeStartupPromotionRecovery(h("prior"), h("prior"), false), "keep-closed");
  assert.equal(classifyNativeStartupPromotionRecovery(h("prior"), h("next"), true), "load-current");
});

test("native startup pins the exact generic runtime authority projection", () => {
  const signedInput = Object.freeze({
    authorityClass: "signed-release",
    runtimeBindingId: h("authority-runtime-binding"),
    releaseProvenanceHash: h("authority-release-provenance"),
    implementationCommit: "a".repeat(40),
  } as const);
  const authority: NativeStartupAuthorityProjectionV1 = projectRuntimeAuthorityDescriptorV1(
    createSignedReleaseRuntimeAuthorityDescriptorV1(signedInput),
  );
  const pinned = pinNativeStartupAuthority(null, authority);
  assert.equal(Object.isFrozen(pinned), true);
  assert.equal(pinNativeStartupAuthority(pinned, Object.freeze({ ...authority })), pinned);
  assert.equal(nativeStartupAuthoritiesEqual(pinned, authority), true);
  const mutations: readonly NativeStartupAuthorityProjectionV1[] = [
    projectRuntimeAuthorityDescriptorV1(createSignedReleaseRuntimeAuthorityDescriptorV1({
      ...signedInput,
      runtimeBindingId: h("other-runtime-binding"),
    })),
    projectRuntimeAuthorityDescriptorV1(createSignedReleaseRuntimeAuthorityDescriptorV1({
      ...signedInput,
      releaseProvenanceHash: h("other-release-provenance"),
    })),
    projectRuntimeAuthorityDescriptorV1(createSignedReleaseRuntimeAuthorityDescriptorV1({
      ...signedInput,
      implementationCommit: "b".repeat(40),
    })),
    projectRuntimeAuthorityDescriptorV1(createUnsignedDryRunRuntimeAuthorityDescriptorV1({
      authorityClass: "unsigned-dry-run",
      runtimeBindingId: signedInput.runtimeBindingId,
      implementationCommit: signedInput.implementationCommit,
    })),
  ];
  for (const mutation of mutations) {
    assert.equal(nativeStartupAuthoritiesEqual(pinned, mutation), false);
    assert.throws(() => pinNativeStartupAuthority(pinned, mutation), /startup-generation-authority-changed/);
  }
});

test("native startup real recovery paths remain closed until close", async () => {
  const baseAuthority: NativeStartupAuthorityProjectionV1 = Object.freeze({
    authorityClass: "signed-release",
    authorityBindingHash: h("recovery-binding"),
    implementationCommit: "c".repeat(40),
  });
  const scenarios = ["null-current", "read-error", "load-error", "authority-mutation"] as const;
  for (const scenario of scenarios) {
    const initialCandidate = Object.freeze({});
    const initialLoaded = Object.freeze({});
    const nextCandidate = Object.freeze({});
    const nextLoaded = Object.freeze({});
    const promotionRequest = Object.freeze({});
    const initialRoot = h(`initial-root:${scenario}`);
    const nextRoot = h(`next-root:${scenario}`);
    let boundary: NativeStartupPromotionBoundaryV1 | null = null;
    const owner: NativeStartupOwnerPortV1<object, object, object> = Object.freeze({
      targetRefreshAgeBlocks: "0",
      createGenerationBuilder(value: NativeStartupPromotionBoundaryV1) {
        boundary = value;
        return Object.freeze({
          loadOrBuildInitial: async () => initialCandidate,
          buildNext: async () => {
            await boundary!.promote(promotionRequest as NativeStartupPromotionRequestV1);
          },
        });
      },
      async promote() {
        if (scenario === "authority-mutation") return nextCandidate;
        throw new Error(`promotion-observation-failed:${scenario}`);
      },
      async findLatestReusable() {
        if (scenario === "null-current") return null;
        if (scenario === "read-error") throw new Error("recovery-read-error");
        return nextCandidate;
      },
      generationRecordRoot(handle: NativeStartupGenerationHandleV1) {
        return handle === nextCandidate ? nextRoot : initialRoot;
      },
      async loadGeneration(handle: NativeStartupGenerationHandleV1) {
        if (handle === nextCandidate && scenario === "load-error") {
          throw new Error("recovery-load-error");
        }
        const next = handle === nextCandidate;
        return Object.freeze({
          handle: next ? nextLoaded : initialLoaded,
          identity: Object.freeze({
            generationId: next ? `next-${scenario}` : `initial-${scenario}`,
            graphRoot: h(`graph:${scenario}:${next}`),
            recordRoot: next ? nextRoot : initialRoot,
            sourceCoverageRoot: h(`coverage:${scenario}:${next}`),
            definitionCatalogRoot: h(`catalog:${scenario}:${next}`),
            cutoff: Object.freeze({ number: "100" }),
            observationRange: Object.freeze({ from: "51", to: "100" }),
            authority: next && scenario === "authority-mutation"
              ? Object.freeze({ ...baseAuthority, authorityBindingHash: h("mutated-runtime-binding") })
              : baseAuthority,
          }),
        });
      },
      async openProducerLease() { return Object.freeze({}); },
      releaseProducerLease() {},
      async openProducerSession() { return Object.freeze({}); },
      async closeProducerSession() {},
      producerSessionHeadNumber() { return "100"; },
    });
    const runtime = await runNativeStartupStateMachineForExactAdapter(
      owner,
      new AbortController().signal,
    );
    assert.throws(() => assertIssuedStartupRuntime(runtime), /not owner-issued/);
    await runtime.withProducerSession(Object.freeze({}), async () => undefined);
    await assert.rejects(
      runtime.waitForGenerationIdle(),
      scenario === "null-current"
        ? /promotion-observation-failed:null-current/
        : scenario === "read-error"
          ? /recovery-read-error/
          : scenario === "load-error"
            ? /recovery-load-error/
            : /startup-generation-authority-changed/,
    );

    let entered = false;
    const blocked = runtime.withProducerSession(Object.freeze({}), async () => {
      entered = true;
    });
    const blockedClosed = assert.rejects(blocked, /startup-runtime-closed/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(entered, false, `${scenario} must keep admission closed`);
    await runtime.close();
    await blockedClosed;
    await assert.rejects(
      runtime.withProducerSession(Object.freeze({}), async () => undefined),
      /startup-runtime-closed/,
    );
  }
});

test("startup reuses one durable ready closure while renewing the lease per producer session", async () => {
  const readyCutoff = Object.freeze({
    chainId: "1",
    number: "100",
    hash: h("startup-cutoff"),
    stateRoot: h("startup-cutoff-state"),
  });
  const initialProducerHead = Object.freeze({
    ...readyCutoff,
    parentHash: h("startup-cutoff-parent"),
  });
  let producerHead: CanonicalHead = initialProducerHead;
  const plan = Object.freeze({
    ownerRef: h("startup-plan-owner"),
    sourcePlanRef: h("startup-plan"),
    familyDefinitionHash: h("startup-family-definition"),
    completeness: "complete-snapshot" as const,
    historyStartBlock: null,
  });
  const sourceEvidenceRefs = Object.freeze([]);
  const rawLocatorHashes = Object.freeze([]);
  const sourceEvidenceRoot = sourcePlanEvidenceRoot({
    plan,
    cutoff: readyCutoff,
    refs: sourceEvidenceRefs,
    rawLocatorHashes,
  });
  const executionWithoutRoot = Object.freeze({
    kind: "source-plan-execution" as const,
    version: 1 as const,
    plan,
    cutoff: readyCutoff,
    outcome: "complete" as const,
    from: "100",
    through: "100",
    previousAppliedThrough: null,
    resultPartitionRoot: h("startup-source-results"),
    opaqueResult: Object.freeze({ kind: "startup-test-empty" }),
    sourceEvidenceRefs,
    rawLocatorHashes,
    sourceEvidenceRoot,
  });
  const coverage = sealSourceCoverage(readyCutoff, [plan], [{
    ...executionWithoutRoot,
    executionRoot: sourcePlanExecutionRoot(executionWithoutRoot),
  }]);
  const nomination = sealEmptyNominationClosureFixture({
    cutoff: readyCutoff,
    familyId: "startup-test-family",
    familyDefinitionHash: plan.familyDefinitionHash,
    sourcePlanIdentity: h("startup-source-plan-identity"),
    sourcePlanLeafDigest: h("startup-source-plan-leaf"),
    nominationProgramRoot: h("startup-nomination-program"),
    nominationProgramProposalLeafDigest: h("startup-nomination-program-proposal"),
    qualificationRoot: h("startup-nomination-qualification"),
    recentObservationRoot: h("startup-recent-observation"),
    sourceExecutionSetRoot: h("startup-source-execution-set"),
    sourceCoverageRoot: coverage.sourceCoverageRoot,
    persistedExecutionRoot: h("startup-persisted-execution"),
    resultPartitionRoot: executionWithoutRoot.resultPartitionRoot,
  });
  const instanceCatalog = sealInstanceCatalog(readyCutoff, []);
  const graph = buildPersistedGraph(instanceCatalog);
  const approval = releaseApproval(h("startup-framework"), h("startup-executor"));
  const releaseBindingPort = readyBindingPortForReleaseApproval(approval);
  const release = approval.resolver.resolve(approval.capability).provenance.runtimeBinding;
  const releaseProvenanceHash = runtimeReleaseBindingProvenanceHash(release);
  const runtimeAuthorityDescriptor = createSignedReleaseRuntimeAuthorityDescriptorV1({
    authorityClass: "signed-release",
    runtimeBindingId: release.bindingId,
    releaseProvenanceHash,
    implementationCommit: release.candidateReleaseCommit,
  });
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(runtimeAuthorityDescriptor);
  const runtimeAuthorityPort = Object.freeze({
    readCurrent: () => Object.freeze({ runtimeAuthority, releaseProvenanceHash }),
  });
  const policyHash = generationRefreshPolicyHash(readyPolicy);
  const freshnessPayload = {
    cutoff: readyCutoff,
    observedHead: initialProducerHead,
    observedAgeBlocks: "0",
    maxPromotionAgeBlocks: "48",
    generationRefreshPolicyHash: policyHash,
    journalEpoch: "1",
    canonicalJournalRoot: h("startup-journal"),
  };
  const promotionFreshness = {
    ...freshnessPayload,
    freshnessReceiptHash: hashDomain("aloha/promotion-freshness-receipt/v1", freshnessPayload),
  };
  const readyPayload = {
    generationId: h("startup-generation"),
    parentGenerationId: null,
    generationRefreshPolicyHash: policyHash,
    cutoff: readyCutoff,
    recentObservationRange: recentObservationRange(readyCutoff.number),
    definitionCatalogRoot: h("startup-definitions"),
    sourceCoverageRoot: coverage.sourceCoverageRoot,
    candidatePartitionRoot: nomination.closure.candidatePartitionRoot,
    candidatePartitionProofStorageHash: h("startup-candidate-proof"),
    nominationClosureRoot: nomination.closure.root,
    nominationClosureStorageHash: nomination.storageHash,
    runtimeAuthority,
    releaseProvenanceHash,
    exactOutcomePartitionRoot: h("startup-outcomes"),
    verifiedMemoSetRoot: h("startup-memos"),
    instanceCatalogRoot: instanceCatalog.instanceCatalogRoot,
    graphRoot: graph.graphRoot,
    edgeCount: graph.edgeCount,
    instanceCount: instanceCatalog.instanceCount,
    promotionFreshness,
    promotionRevision: "3",
    promotedAtMonotonicNs: "1",
  };
  const ready: ReadyGenerationV1 = Object.freeze({
    ...readyPayload,
    readyRecordHash: hashDomain("aloha/ready-generation/v1", readyPayload),
  });

  const refreshedCutoff = Object.freeze({
    chainId: "1",
    number: "120",
    hash: h("startup-refreshed-cutoff"),
    stateRoot: h("startup-refreshed-cutoff-state"),
  });
  const refreshedHead = Object.freeze({
    ...refreshedCutoff,
    parentHash: h("startup-refreshed-parent"),
  });
  const refreshedExecutionWithoutRoot = Object.freeze({
    ...executionWithoutRoot,
    cutoff: refreshedCutoff,
    from: refreshedCutoff.number,
    through: refreshedCutoff.number,
    sourceEvidenceRoot: sourcePlanEvidenceRoot({
      plan,
      cutoff: refreshedCutoff,
      refs: sourceEvidenceRefs,
      rawLocatorHashes,
    }),
  });
  const refreshedCoverage = sealSourceCoverage(refreshedCutoff, [plan], [{
    ...refreshedExecutionWithoutRoot,
    executionRoot: sourcePlanExecutionRoot(refreshedExecutionWithoutRoot),
  }]);
  const refreshedNomination = sealEmptyNominationClosureFixture({
    cutoff: refreshedCutoff,
    familyId: "startup-test-family",
    familyDefinitionHash: plan.familyDefinitionHash,
    sourcePlanIdentity: h("startup-source-plan-identity"),
    sourcePlanLeafDigest: h("startup-source-plan-leaf"),
    nominationProgramRoot: h("startup-nomination-program"),
    nominationProgramProposalLeafDigest: h("startup-nomination-program-proposal"),
    qualificationRoot: h("startup-nomination-qualification"),
    recentObservationRoot: h("startup-refreshed-recent-observation"),
    sourceExecutionSetRoot: h("startup-refreshed-source-execution-set"),
    sourceCoverageRoot: refreshedCoverage.sourceCoverageRoot,
    persistedExecutionRoot: h("startup-refreshed-persisted-execution"),
    resultPartitionRoot: refreshedExecutionWithoutRoot.resultPartitionRoot,
  });
  const refreshedInstanceCatalog = sealInstanceCatalog(refreshedCutoff, []);
  const refreshedGraph = buildPersistedGraph(refreshedInstanceCatalog);
  const refreshedBindingBase = Object.freeze({
    runId: "startup-refresh-run",
    parentGenerationId: ready.generationId,
    cutoff: refreshedCutoff,
    recentObservationRange: recentObservationRange(refreshedCutoff.number),
    definitionCatalogRoot: ready.definitionCatalogRoot,
    sourceCoverageRoot: refreshedCoverage.sourceCoverageRoot,
    candidatePartitionRoot: refreshedNomination.closure.candidatePartitionRoot,
    candidatePartitionStorageHash: h("startup-refreshed-candidate-storage"),
    nominationClosureRoot: refreshedNomination.closure.root,
    nominationClosureStorageHash: refreshedNomination.storageHash,
    candidatePartitionProofStorageHash: h("startup-refreshed-candidate-proof"),
    verifiedMemoSetRoot: h("startup-refreshed-memos"),
    checkpointRevision: "4",
    attestationAuthorityRoot: h("startup-refreshed-attestation-authority"),
    releaseAuthorityRoot: h("startup-refreshed-release-authority"),
    releaseProvenanceHash,
    executorAuthorityRoot: h("startup-refreshed-executor-authority"),
  });
  const refreshedExactOutcomePartitionRoot = hashDomain("aloha/exact-outcome-partition/v1", {
    runId: refreshedBindingBase.runId,
    cutoff: refreshedBindingBase.cutoff,
    candidatePartitionRoot: refreshedBindingBase.candidatePartitionRoot,
    attestationAuthorityRoot: refreshedBindingBase.attestationAuthorityRoot,
    releaseAuthorityRoot: refreshedBindingBase.releaseAuthorityRoot,
    releaseProvenanceHash: refreshedBindingBase.releaseProvenanceHash,
    executorAuthorityRoot: refreshedBindingBase.executorAuthorityRoot,
    outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", []),
  });
  const refreshedBinding: SealedRunBindingV1 = Object.freeze({
    ...refreshedBindingBase,
    exactOutcomePartitionRoot: refreshedExactOutcomePartitionRoot,
  });
  const refreshedSnapshot: SealedRunSnapshotV1 = Object.freeze({
    ...refreshedBinding,
    sourceCoverage: refreshedCoverage,
    candidateKeys: Object.freeze([]),
    partition: Object.freeze({
      runId: refreshedBinding.runId,
      cutoff: refreshedCutoff,
      candidatePartitionRoot: refreshedBinding.candidatePartitionRoot,
      outcomes: Object.freeze([]),
      attestationAuthorityRoot: refreshedBinding.attestationAuthorityRoot,
      releaseAuthorityRoot: refreshedBinding.releaseAuthorityRoot,
      releaseProvenanceHash: refreshedBinding.releaseProvenanceHash,
      executorAuthorityRoot: refreshedBinding.executorAuthorityRoot,
      accounting: Object.freeze({ pending: "0", verified: "0", chainProvenRejected: "0", retryable: "0", invalidProgram: "0" }),
      exactOutcomePartitionRoot: refreshedExactOutcomePartitionRoot,
    }),
  });
  const refreshedSealedRun = Object.freeze({}) as SealedRunCapabilityV1;

  const canonical = new CanonicalSource({
    async getLatestHeader() { return producerHead; },
    async getHeader(number: string) {
      if (number === readyCutoff.number) return { kind: "found" as const, header: initialProducerHead };
      if (number === producerHead.number) return { kind: "found" as const, header: producerHead };
      return { kind: "unavailable" as const, failureCode: "not-indexed" };
    },
  }, { journalStore: new MemoryJournalStore() });
  await canonical.freezeView();

  const structuralStage12Capability = Object.freeze({});
  const structuralStage12Reader = Object.freeze({
    binding() { throw new Error("startup test must not read stage1/2 evidence"); },
    async read() { throw new Error("startup test must not read stage1/2 evidence"); },
  });
  const structuralFullFamilyReader = Object.freeze({
    async read() { throw new Error("startup test must not read full-family evidence"); },
  });
  let activeReady = ready;
  let stagedReady: ReadyStageInputV1 | null = null;
  let refreshStageAvailable = false;
  let markRefreshStageRead: (() => void) | null = null;
  const refreshStageRead = new Promise<void>(resolve => { markRefreshStageRead = resolve; });
  const store = {
    readyStage12EvidenceReader: structuralStage12Reader,
    readyFullFamilyEvidenceReader: structuralFullFamilyReader,
    async putContentAndFsync(kind: "instance-catalog" | "persisted-graph", value: object) {
      return kind === "instance-catalog"
        ? (value as typeof instanceCatalog).instanceCatalogRoot
        : (value as typeof graph).graphRoot;
    },
    async stageReadyCAS(value: ReadyStageInputV1) {
      stagedReady = value;
      return {
        stage: {
          stageStorageHash: h("startup-refreshed-stage-storage"),
          runId: value.expectedInProgressRunId,
          expectedRevision: value.expectedRevision,
          sealedRevision: value.expectedRevision,
          stageRevision: (BigInt(value.expectedRevision) + 1n).toString(),
          stageRecordHash: h("startup-refreshed-stage-record"),
          readyBaseHash: readyGenerationBaseHash(value.ready),
          cutoff: value.ready.cutoff,
          generationRefreshPolicyHash: value.ready.generationRefreshPolicyHash,
          definitionCatalogRoot: value.ready.definitionCatalogRoot,
          runtimeAuthority: value.ready.runtimeAuthority,
          releaseProvenanceHash: value.ready.releaseProvenanceHash,
          candidatePartitionProofStorageHash: value.ready.candidatePartitionProofStorageHash,
          nominationClosureRoot: value.ready.nominationClosureRoot,
          nominationClosureStorageHash: value.ready.nominationClosureStorageHash,
        },
        stageRevision: (BigInt(value.expectedRevision) + 1n).toString(),
        stageRecordHash: h("startup-refreshed-stage-record"),
      };
    },
    async activateReadyCAS(value: ReadyActivationInputV1) {
      if (stagedReady === null) throw new Error("startup refreshed ready was not staged");
      const promotionRevision = (BigInt(value.stage.stageRevision) + 1n).toString();
      const readyWithoutHash = {
        ...stagedReady.ready,
        promotionFreshness: value.freshness.receipt,
        promotedAtMonotonicNs: value.promotedAtMonotonicNs,
        promotionRevision,
      };
      activeReady = Object.freeze({
        ...readyWithoutHash,
        readyRecordHash: hashDomain("aloha/ready-generation/v1", readyWithoutHash),
      });
      refreshStageAvailable = false;
      return { promotionRevision, readyRecordHash: activeReady.readyRecordHash };
    },
    async loadActiveReady() { return activeReady; },
    async loadReadyClosure(value: ReadyGenerationV1) {
      return value.readyRecordHash === ready.readyRecordHash
        ? { sourceCoverage: coverage, nominationClosure: nomination.closure, instanceCatalog, graph, stage12EvidenceCapability: structuralStage12Capability }
        : { sourceCoverage: refreshedCoverage, nominationClosure: refreshedNomination.closure, instanceCatalog: refreshedInstanceCatalog, graph: refreshedGraph, stage12EvidenceCapability: structuralStage12Capability };
    },
    async assertContentRoot() {},
    assertReadyAuthorityActive() {},
  };
  const authority = createReadyPromotionAuthority(
    () => ({ definitionCatalogRoot: readyPayload.definitionCatalogRoot, policy: readyPolicy }),
    runtimeAuthorityPort,
  );
  const promotionCaller = Object.freeze({ startupTestReadyCaller: true });
  const sealedReader = issueCheckpointSealedRunReader({
    binding(value: SealedRunCapabilityV1) {
      if (value !== refreshedSealedRun) throw new Error("startup test sealed run is not issued");
      return refreshedBinding;
    },
    readForPromotion(value: SealedRunCapabilityV1) {
      if (value !== refreshedSealedRun) throw new Error("startup test sealed run is not issued");
      return refreshedSnapshot;
    },
  });
  const readyService = new ReadyGenerationServiceV1(
    promotionCaller,
    store,
    canonical,
    () => "10",
    () => ({
      definitionCatalogRoot: readyPayload.definitionCatalogRoot,
      declaredSourcePlans: [plan],
    }),
    authority,
    sealedReader,
    runtimeAuthorityPort,
  );
  const readyPort = issueStartupReadyPort({ service: readyService, promotionCaller });
  assert.equal("bindPromotion" in readyPort, false);
  assert.equal(typeof startupReadyPromotionPort(readyPort).promote, "function");
  assert.throws(
    () => startupReadyPromotionPort({ ...readyPort }),
    /startup ready port is not owner-issued/,
  );
  const checkpoint = {
    ...store,
    async loadAndValidateRoot() { return { revision: "1", inProgressRunId: null, stagedReadyStorageHash: null, readyGenerationId: ready.generationId, readyGenerationRecordHash: ready.readyRecordHash }; },
    async loadRun() { throw new Error("startup test must not load a run"); },
    async loadStagedPromotion() {
      if (!refreshStageAvailable) return null;
      markRefreshStageRead?.();
      return {
        sealedRun: refreshedSealedRun,
        sealedRunBinding: refreshedBinding,
        instanceCatalog: refreshedInstanceCatalog,
        stage: {
          stageStorageHash: h("startup-existing-refresh-stage-storage"),
          runId: refreshedBinding.runId,
          expectedRevision: refreshedBinding.checkpointRevision,
          sealedRevision: refreshedBinding.checkpointRevision,
          stageRevision: (BigInt(refreshedBinding.checkpointRevision) + 1n).toString(),
          stageRecordHash: h("startup-existing-refresh-stage-record"),
          readyBaseHash: h("startup-existing-refresh-ready-base"),
          cutoff: refreshedBinding.cutoff,
          generationRefreshPolicyHash: generationRefreshPolicyHash(readyPolicy),
          definitionCatalogRoot: refreshedBinding.definitionCatalogRoot,
          runtimeAuthority,
          releaseProvenanceHash: refreshedBinding.releaseProvenanceHash,
          candidatePartitionProofStorageHash: refreshedBinding.candidatePartitionProofStorageHash,
          nominationClosureRoot: refreshedBinding.nominationClosureRoot,
          nominationClosureStorageHash: refreshedBinding.nominationClosureStorageHash,
        },
      };
    },
    async beginNewRunAndPersistPartition() { throw new Error("startup test must reuse ready"); },
    async sealRunAndClearInProgressCAS() { throw new Error("startup test must reuse ready"); },
    async resolveStagedPromotion(stage: object) { return { kind: "staged", stage }; },
    async abandonStagedPromotionCAS() { throw new Error("startup test must reuse ready"); },
    async sealCompletedRunAsMemoSeedAndClearCAS() { throw new Error("startup test must reuse ready"); },
  } as never;
  const catalog = {
    loadExact: () => ({ definitionCatalogRoot: readyPayload.definitionCatalogRoot, declaredSourcePlans: [plan] }),
  };
  const generatedRuntime = generatedCompositionFixture({ runtimeAuthority: runtimeAuthorityDescriptor });
  const startupInput = {
    policy: readyPolicy,
    catalog,
    checkpoint,
    canonical,
    discovery: {
      async executeAllDeclaredPlans() { throw new Error("startup test must reuse ready"); },
      async scanRecentBlocks() { throw new Error("startup test must reuse ready"); },
      async nominateAll() { throw new Error("startup test must reuse ready"); },
      readIssuedNomination() { throw new Error("startup test must reuse ready"); },
    },
    attestation: { async attestAndPersistDifference() { throw new Error("startup test must reuse ready"); } },
    ready: readyPort,
    familyRuntime: generatedRuntime.familyRuntime,
    familySearchRuntime: generatedRuntime.familySearchRuntime,
    processEpoch: "startup-test-process",
    runtimeAuthority,
  };
  const runtime = await startStartupRuntime(startupInput);
  const initialServing = runtime.readActiveGeneration();
  assert.deepEqual(runtime.runtimeAuthority, runtimeAuthority);
  assert.equal(initialServing.generationId, ready.generationId);
  assert.equal(initialServing.readyRecordHash, ready.readyRecordHash);
  assert.equal(initialServing.graphRoot, graph.graphRoot);
  assert.equal(initialServing.releaseProvenanceHash, ready.releaseProvenanceHash);
  assert.equal(Object.isFrozen(initialServing), true);

  const sessionGenerations: string[] = [];
  const sessions: Array<{ readonly session: Awaited<ReturnType<typeof canonical.openHeadSession>>; readonly lease: unknown }> = [];
  const headObservation = await canonical.observeCurrentHead();
  await runtime.withProducerSession(headObservation, async session => {
    sessionGenerations.push(session.generationId);
    sessions.push({ session, lease: session.lease });
    await session.lease.assertActive();
  });
  await runtime.withProducerSession(headObservation, async session => {
    sessionGenerations.push(session.generationId);
    sessions.push({ session, lease: session.lease });
    await session.lease.assertActive();
  });
  producerHead = refreshedHead;
  await canonical.freezeView();
  const refreshedHeadObservation = await canonical.observeCurrentHead();
  refreshStageAvailable = true;
  let releaseOldSession!: () => void;
  const holdOldSession = new Promise<void>(resolve => { releaseOldSession = resolve; });
  let oldSessionOpened: (() => void) | null = null;
  const oldSessionIsOpen = new Promise<void>(resolve => { oldSessionOpened = resolve; });
  const oldSession = runtime.withProducerSession(refreshedHeadObservation, async session => {
    sessionGenerations.push(session.generationId);
    sessions.push({ session, lease: session.lease });
    oldSessionOpened?.();
    await holdOldSession;
    await session.lease.assertActive();
  });
  await oldSessionIsOpen;
  await refreshStageRead;
  await Promise.resolve();
  await Promise.resolve();
  let refreshedSessionOpened = false;
  const refreshedSession = runtime.withProducerSession(refreshedHeadObservation, async session => {
    refreshedSessionOpened = true;
    sessionGenerations.push(session.generationId);
    sessions.push({ session, lease: session.lease });
    await session.lease.assertActive();
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(refreshedSessionOpened, false, "new admission must wait behind the promotion boundary");
  assert.equal(activeReady.readyRecordHash, ready.readyRecordHash, "durable Ready must not activate while the old session is live");
  releaseOldSession();
  await oldSession;
  await refreshedSession;
  await runtime.waitForGenerationIdle();
  assert.deepEqual(sessionGenerations, [ready.generationId, ready.generationId, ready.generationId, activeReady.generationId]);
  assert.notEqual(activeReady.readyRecordHash, ready.readyRecordHash);
  assert.equal(runtime.generationId, activeReady.generationId);
  assert.equal(runtime.graphRoot, refreshedGraph.graphRoot);
  assert.equal(runtime.ready.readyRecordHash, activeReady.readyRecordHash);
  const refreshedServing = runtime.readActiveGeneration();
  assert.equal(refreshedServing.generationId, activeReady.generationId);
  assert.equal(refreshedServing.graphRoot, refreshedGraph.graphRoot);
  assert.equal(refreshedServing.releaseProvenanceHash, activeReady.releaseProvenanceHash);
  assert.equal(runtime.readServingGeneration(ready.generationId), initialServing);
  assert.equal(runtime.readServingGeneration(activeReady.generationId), refreshedServing);
  assert.throws(() => runtime.readServingGeneration("unknown-generation"), /unknown/);
  assert.equal(sessions.length, 4);
  assert.notEqual(sessions[0]!.session, sessions[1]!.session);
  assert.notEqual(sessions[0]!.lease, sessions[1]!.lease);
  const firstLease = sessions[0]!.lease as {
    readonly sixStepRouteParents: object;
    readonly binding: Parameters<typeof issueStartupSixStepRouteParentInvocationV1>[1]["binding"];
    readonly edges: readonly { readonly edgeId: Hash }[];
  };
  assert.deepEqual(Reflect.ownKeys(firstLease.sixStepRouteParents), []);
  assert.throws(
    () => issueStartupSixStepRouteParentInvocationV1(Object.freeze(Object.create(null)), {
      lease: firstLease,
      binding: firstLease.binding,
      orderedEdgeIds: [h("counterfeit-route-edge")],
    }),
    /not owner-issued/,
  );
  await assert.rejects(() => sessions[0]!.session.assertCurrent(), /producer session is closed/);
  await assert.rejects(() => (sessions[0]!.lease as { assertActive(): Promise<void> }).assertActive(), /graph-lease-released/);
  assert.throws(() => assertIssuedStartupRuntime({ ...runtime }), /startup runtime is not owner-issued/);
  assert.throws(
    () => void readStartupStage12Evidence(runtime),
    /evidence reader is not checkpoint-issued/,
  );
  assert.throws(
    () => void readStartupFullFamilyEvidenceBinding(runtime),
    /full-Family evidence reader is not checkpoint-issued/,
  );
  registerCheckpointReadyFullFamilyEvidenceReader(structuralFullFamilyReader);
  assert.throws(
    () => void readStartupFullFamilyEvidenceBinding(runtime, ""),
    /startup-stage12-generation-unknown/,
  );
  await runtime.close();
  assert.equal(await runtime.close(), undefined);
});
