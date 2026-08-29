import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  attestationPartialIdentitySemanticHash,
  identityMemoHash,
  candidateFinalOutcomeHash,
  sealProbeReceipt,
  type CandidateFinalOutcomeV1,
  type ChainProvenRejectedDecisionV1,
  type AttestationFinalSessionResultV1,
  type AttestationPersistenceCapabilityV1,
  type AttestationProgramPort,
  type AttestationRunSessionV1,
  type AttestationServiceV1,
  type IdentityVerifiedV1,
  type IdentityVerifiedObservationV1,
  type InstanceDecisionV1,
  type InstanceLifecycleSingleFlightPort,
  type RawEffectObservationV1,
  type RawTransportExecutionRecordV1,
  type RejectionTransportExecutorV1,
  type AttestationValidationAuthorityV1,
  type AttestationCompositionBindingV1,
  type AttestationIdentityResumeCapabilityV1,
  type ProbeReceiptV1,
  type VerifiedMemoReuseProofV1,
} from "../../attestation/src/index.ts";
import {
  createAttestationService,
  createFrameworkFailureRuntime,
  createRejectionExecutorAuthorityIssuer,
  createRejectionFactRuntime,
} from "../../attestation/src/internal/composition.ts";
import { readyBindingPortForReleaseApproval, releaseApproval, rotateReleaseApproval, runtimeAuthorityForReleaseApproval } from "../../attestation/test/authority-fixture.ts";
import { createCandidatePartitionProofIssuerFixture } from "./candidate-partition-authority-fixture.ts";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { createResolverPolicy } from "../../../specs/artifact-resolution/src/index.ts";
import { erc20AssetPortBindingV1 } from "../../asset-ref/src/index.ts";
import { sealInstancePublication, type InstancePublicationV1 } from "../../catalog/src/index.ts";
import { sealInstanceCatalog } from "../../catalog/src/index.ts";
import {
  candidatePartitionRoot,
  mergeAndDedupeNominations,
  sealSourceCoverage,
  sealPersistedSourcePlanExecution,
  sealPersistedSourcePlanExecutionSet,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  sourcePlanIdentity,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
  type RecentLogEvidenceRefV1,
} from "../../discovery/src/index.ts";
import { sealRecentObservation, type ObservedBlockV1 } from "../../observation/src/index.ts";
import { createCanonicalSource, SQLiteCanonicalJournalStore } from "../../canonical-source/src/index.ts";
import { createSqliteDurableStore, type DurableTransaction } from "../../durable-store/src/index.ts";
import { GraphViewLeaseV1 } from "../../graph/src/index.ts";
import { createReadyPromotionAuthority, type ReadyStorePort } from "../../ready-generation/src/index.ts";
import { ReadyGenerationServiceV1 } from "../../ready-generation/src/index.ts";
import { WorkScheduler } from "../../scheduler/src/index.ts";
import {
  createRuntimeReleaseDiscoveryPort,
  type RuntimeReleaseSourcePlanBindingV1,
} from "../../runtime-release-authority/src/internal/discovery-owner.ts";
import {
  issueRuntimeReleaseQualifiedDiscoverySourcePort,
  readRuntimeReleaseQualifiedDiscoverySourcePort,
} from "../../runtime-release-authority/src/internal/discovery-source-authority-owner.ts";
import {
  UNIV2_PAIR_CREATED_TOPIC0,
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_FAMILY_ID,
  UNIV2_STANDARD_HISTORY_NOMINATION_PROGRAM,
  UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME,
  UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
} from "../../../families/univ2-standard/src/public.ts";
import type {
  CandidatePartitionCapabilityV1,
  CandidatePartitionReaderPortV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import { candidatePartitionKeysRoot } from "../../../specs/candidate-partition-authority/src/index.ts";
import {
  nominationEvidenceRefHash,
  sealNominationClosureV1,
  sealQualifiedSourcePlanNominationReceiptV1,
} from "../../../specs/nomination-authority/src/index.ts";
import { assertCheckpointReadyStage12EvidenceReader } from "../src/internal/ready-stage12-evidence-consumer.ts";
import { assertCheckpointReadyFullFamilyEvidenceReader } from "../src/internal/ready-full-family-evidence-consumer.ts";
import { readCheckpointReadyFullFamilyEvidence } from "../src/ready-full-family-evidence-consumer.ts";
import { CHECKPOINT_SCHEMA_AUTHORITY, CheckpointStore, type CheckpointSixStepArtifactPortV1 } from "../src/index.ts";
import { issueCheckpointSixStepArtifactPortV1 } from "../src/internal/six-step-artifact-port-owner.ts";
import {
  candidatePartitionBootstrapReader,
  createCandidatePartitionBootstrap,
  type CandidatePartitionBootstrapV1,
} from "../src/candidate-partition.ts";
import { startStartupRuntime } from "../../startup-runtime/src/index.ts";
import { issueStartupReadyPort } from "../../startup-runtime/src/internal/ready-owner.ts";
import { generatedCompositionFixture } from "../../startup-runtime/test/generated-composition-fixture.ts";
import {
  closeProductionRuntimeAcceptanceEvidenceV1,
  installProductionRuntimeSigtermEvidenceV1,
  issueProductionRuntimeAcceptanceEvidenceOwnerV1,
  recordProductionRuntimeProcessReadyV1,
} from "../../../apps/searcher-runtime/src/runtime-acceptance-evidence.ts";
import { issueSearcherProductionEvidenceOwnerV1 } from "../../../apps/searcher-runtime/src/production-evidence.ts";
import {
  decodeDeploymentManifestV1,
  encodeDeploymentManifestV1,
  runtimeAnchorReceiptV1,
  type RuntimeAnchorObservationV1,
} from "../../../apps/searcher-runtime/src/deployment.ts";
import { issueProducerHeadFactsCapabilityV1 } from "../../producer/src/internal/owners.ts";
import { sealReleaseIntent } from "../../../specs/release-intent/src/index.ts";
import { ContentAddressedObserverSinkV1 } from "../../../acceptance/collectors/src/content-addressed-sink.ts";
import { observeRuntimeAcceptanceProcessDatabaseV1 } from "../../../acceptance/collectors/src/raw-runtime-acceptance-observer.ts";
import { observeProductionRuntimeRestartFactsV1 } from "../../../acceptance/collectors/src/runtime-restart-facts-observer.ts";
import { evaluateRuntimeRestartPredicate } from "../../../acceptance/runtime-acceptance-facts/src/predicate.ts";
import { observeProductionPerformanceDatabaseV1 } from "../../performance-collector/src/raw-sqlite-observer.ts";
import { PRE_RELEASE_SYSTEMD_UNIT_V1 } from "../../../tools/runtime-release-packager/src/internal/pre-release-staging-schema.ts";

const h = (value: string): Hash => hashDomain("test/checkpoint-v3", value);
const checkpointSixStepArtifacts = (): CheckpointSixStepArtifactPortV1 => issueCheckpointSixStepArtifactPortV1(Object.freeze({
  async emitVerifiedOutcome() { return Object.freeze(Object.create(null)); },
  async emitReadyEdge() { return Object.freeze(Object.create(null)); },
}));
const identityMemo = (value: string) => ({ kind: "checkpoint-identity-memo", value } as const);
const cutoff: CanonicalCutoffV1 = { chainId: "1", number: "49", hash: h("block:49"), stateRoot: h("state") };
const canonicalHead = { ...cutoff, parentHash: h("block:48") };
const promotionPolicy = {
  observationWindowBlocks: "50" as const,
  targetRefreshAgeBlocks: "10",
  maxServingAgeBlocks: "30",
  minPromotionMarginBlocks: "2",
  maxInProgressRuns: "1" as const,
};

function rawLocator(id: string): { readonly kind: "raw-evidence-locator"; readonly version: 1; readonly rawLocatorHash: Hash; readonly bytes: Uint8Array } {
  const bytes = encodeCanonicalBytes({ kind: "chain-log", id });
  return { kind: "raw-evidence-locator", version: 1, rawLocatorHash: sha256Hex(bytes), bytes };
}

function candidate(id: string): CandidateRecordV1 {
  const raw = rawLocator(id);
  return mergeAndDedupeNominations([{
    kind: "aloha.candidate-nomination",
    version: "2",
    familyId: "family-a",
    familyDefinitionHash: h("definition"),
    instanceNominationKey: `instance-${id}`,
    evidence: {
      kind: "recent-log",
      version: 1,
      sourcePlanRef: null,
      ownerRef: null,
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

function observationBlocks(evidence: readonly RecentLogEvidenceRefV1[]): readonly ObservedBlockV1[] {
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

function makePublication(
  value: CandidateRecordV1,
  identity: IdentityVerifiedV1,
  dependencySuffix = "",
  transitionCount = 1,
) {
  return sealInstancePublication({
    familyId: value.familyId,
    familyDefinitionHash: value.familyDefinitionHash,
    familyCandidateKey: value.familyCandidateKey,
    instanceKey: value.instanceNominationKey,
    cutoff,
    identityMemo: identity.identityMemo,
    identityMemoHash: identity.identityMemoHash,
    descriptorHash: identity.descriptorHash,
    staticProjectionMemoHash: h("projection-memo"),
    requestedArtifactDependencyRoot: h(`dependencies${dependencySuffix}`),
    validityDependencyRoot: h(`validity${dependencySuffix}`),
    transitions: Array.from({ length: transitionCount }, (_, transitionIndex) => ({
      inputAssetPorts: [{ ...erc20AssetPortBindingV1(cutoff.chainId, `0x${h("in").slice(-40)}`), portRef: h("in-port"), ordinal: "0" }],
      outputAssetPorts: [{ ...erc20AssetPortBindingV1(cutoff.chainId, `0x${h("out").slice(-40)}`), portRef: h("out-port"), ordinal: "0" }],
      opaqueTransitionRef: h(`transition:${transitionIndex}`),
      constraintRefs: [],
      staticProjectionHash: h(`projection:${transitionIndex}`),
    })),
    evidenceRoot: identity.evidenceRoot,
  });
}

interface ProgramCalls {
  identity: number;
  materialization: number;
}

interface AttestationTestBehavior {
  materialization: "verified" | "retryable";
  readonly transitionCount?: number;
  readonly decideMaterialization?: (candidate: CandidateRecordV1) => "verified" | "retryable" | "invalidProgram";
  readonly dependencySuffix?: (candidate: CandidateRecordV1) => string;
  readonly reuseMemo?: (candidate: CandidateRecordV1) => boolean;
  readonly rejectIdentity?: (candidate: CandidateRecordV1) => boolean;
  readonly currentRunId?: () => string;
}

function verifiedMemoReuseProof(
  value: CandidateRecordV1,
  publication: InstancePublicationV1,
  identity: IdentityVerifiedObservationV1,
  currentCutoff: CanonicalCutoffV1,
): VerifiedMemoReuseProofV1 {
  const core = {
    kind: "verifiedMemoReuseProof" as const,
    familyId: value.familyId,
    familyDefinitionHash: value.familyDefinitionHash,
    familyCandidateKey: value.familyCandidateKey,
    candidateSubjectHash: value.candidateSubjectHash,
    instanceNominationKey: value.instanceNominationKey,
    cutoff: currentCutoff,
    oldInstancePublicationHash: publication.instancePublicationHash,
    requestedArtifactDependencyRoot: publication.requestedArtifactDependencyRoot,
    descriptorHash: publication.descriptorHash,
    validityDependencyRoot: publication.validityDependencyRoot,
    candidateToCanonicalIdentityBindingProof: hashDomain("aloha/candidate-to-canonical-identity-binding/v1", {
      familyId: value.familyId,
      familyDefinitionHash: value.familyDefinitionHash,
      familyCandidateKey: value.familyCandidateKey,
      candidateSubjectHash: value.candidateSubjectHash,
      instanceNominationKey: value.instanceNominationKey,
      cutoff: currentCutoff,
      oldInstancePublicationHash: publication.instancePublicationHash,
      identityMemoHash: identity.identityMemoHash,
      descriptorHash: publication.descriptorHash,
    }),
    identityMemo: identity.identityMemo,
    identityMemoHash: identity.identityMemoHash,
    evidenceRoot: identity.evidenceRoot,
  };
  return { ...core, proofHash: hashDomain("aloha/verified-memo-reuse-proof/v1", core) };
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
    async attestIdentity(value, _currentCutoff, signal) {
      calls.identity += 1;
      if (behavior.rejectIdentity?.(value) === true) {
        const input = {
          context: {
            runId: behavior.currentRunId?.() ?? "run-a",
            candidate: value,
            cutoff,
            stage: "identity" as const,
            identitySubjectHash: null,
          },
          request: {
            requestId: h(`rejection-request:${value.familyCandidateKey}`),
            record: { method: "eth_call", to: value.instanceNominationKey, data: "0x", block: cutoff.number },
          },
        };
        const program = rejectionRuntime.workPlane.builder.freezeProgram(input);
        const result = await rejectionRuntime.workPlane.executeAndInterpret(
          program,
          async (_facts, token): Promise<ChainProvenRejectedDecisionV1> => ({
            kind: "chainProvenRejected" as const,
            rejectionFacts: token,
            decisionCode: "chain-absence",
            decisionBytes: encodeCanonicalBytes({ code: "chain-absence", candidate: value.familyCandidateKey }),
          }),
          signal,
        );
        if (result.decision.kind !== "chainProvenRejected" || result.rejectionEvidence === null) {
          throw new Error("runtime restart expected executor-backed identity rejection");
        }
        return result.decision;
      }
      return {
        kind: "identityVerified" as const,
        familyInstanceKey: value.instanceNominationKey,
        identityMemo: identityMemo(value.familyCandidateKey),
        identityMemoHash: identityMemoHash(identityMemo(value.familyCandidateKey)),
        descriptorHash: h("descriptor"),
        evidenceRoot: h(`evidence:${value.familyCandidateKey}`),
      };
    },
    async reuseVerifiedMemo(value, publication, currentCutoff) {
      if (behavior.reuseMemo?.(value) === false) return { kind: "requiresAttestation" };
      const identity: IdentityVerifiedObservationV1 = {
        kind: "identityVerified",
        familyInstanceKey: publication.instanceKey,
        identityMemo: publication.identityMemo,
        identityMemoHash: publication.identityMemoHash,
        descriptorHash: publication.descriptorHash,
        evidenceRoot: publication.evidenceRoot,
      };
      return { kind: "reusable", identity, proof: verifiedMemoReuseProof(value, publication, identity, currentCutoff) };
    },
    async materializeAndProject(value, identity): Promise<InstanceDecisionV1> {
      calls.materialization += 1;
      const decision = behavior.decideMaterialization?.(value) ?? behavior.materialization;
      if (decision === "retryable") {
        return {
          kind: "retryable",
          failure: {
            stage: "materialization",
            failureCode: "resource-limited",
            attemptCount: "1",
            candidateSubjectHash: value.candidateSubjectHash,
            evidenceRoot: h(`retryable:${value.familyCandidateKey}`),
            frameworkBinding: null,
          },
        };
      }
      if (decision === "invalidProgram") {
        return {
          kind: "invalidProgram",
          failure: {
            stage: "materialization",
            failureCode: "test-invalid-program",
            attemptCount: "1",
            candidateSubjectHash: value.candidateSubjectHash,
            evidenceRoot: value.candidateEvidenceRoot,
            frameworkBinding: null,
          },
        };
      }
      return {
        kind: "verified",
        publication: makePublication(
          value,
          identity,
          behavior.dependencySuffix?.(value) ?? "",
          behavior.transitionCount ?? 1,
        ),
      };
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
  readonly partitionProofIssuer: ReturnType<typeof createCandidatePartitionProofIssuerFixture>;
  readonly sixStepArtifacts: CheckpointSixStepArtifactPortV1;
  partitionBootstrap: CandidatePartitionBootstrapV1;
  readonly probeCaller: object;
  readonly candidates: readonly CandidateRecordV1[];
  run: Awaited<ReturnType<CheckpointStore["loadRun"]>>;
  readonly recentRawEvidenceLocators: readonly ReturnType<typeof rawLocator>[];
  readonly sourcePlanRawEvidenceLocators: readonly ReturnType<typeof rawLocator>[];
  checkpoint: CheckpointStore;
  armBeforeCommitFailure(): void;
  armPostCommitCanonicalFailure(): void;
  setCurrentProofBinding(binding: import("../../../specs/release-authority/src/index.ts").RuntimeReleaseBindingV1): void;
  close(): void;
}

interface HarnessOptions {
  readonly calls?: ProgramCalls;
  readonly behavior?: AttestationTestBehavior;
  readonly historySource?: boolean;
  readonly candidateEvidence?: "recent-log" | "source-plan";
  readonly directory?: string;
  readonly preserveDirectory?: boolean;
  readonly reopen?: boolean;
  readonly leaseTtlMs?: number;
}

async function makeHarness(count = 1, options: HarnessOptions = {}): Promise<Harness> {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "aloha-checkpoint-v3-"));
  const filename = join(directory, "checkpoint.sqlite");
  let failNextCommit = false;
  let invalidateCanonicalAfterNextCommit = false;
  let canonicalInvalidated = false;
  const journalStore = new SQLiteCanonicalJournalStore(join(directory, "canonical-journal.sqlite"));
  const source = createCanonicalSource({
    async getLatestHeader() { return canonicalHead; },
    async getHeader(number) {
      return number === cutoff.number
        ? {
          kind: "found" as const,
          header: canonicalInvalidated ? { ...canonicalHead, hash: h("reorged-cutoff") } : canonicalHead,
        }
        : { kind: "unavailable" as const, failureCode: "not-indexed" };
    },
  }, { journalStore });
  await source.freezeView();
  const durable = createSqliteDurableStore(filename, {
    leaseTtlMs: options.leaseTtlMs,
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
  const usesSourcePlanEvidence = options.candidateEvidence === "source-plan" || options.historySource === true;
  const plan = {
    ownerRef: h("owner"),
    sourcePlanRef: h("plan"),
    familyDefinitionHash: h("definition"),
    completeness: options.historySource
      ? "contiguous-history" as const
      : usesSourcePlanEvidence
        ? "complete-snapshot" as const
        : "nomination-only" as const,
    historyStartBlock: options.historySource ? "0" : null,
  };
  const candidateFixtures = Array.from({ length: count }, (_, index) => {
    const id = String(index);
    if (!usesSourcePlanEvidence) {
      return { candidate: candidate(id), locator: rawLocator(id) };
    }
    const locator = rawLocator(`source:${id}`);
    const candidateValue = mergeAndDedupeNominations([{
      kind: "aloha.candidate-nomination",
      version: "2",
      familyId: "family-a",
      familyDefinitionHash: h("definition"),
      instanceNominationKey: `instance-${id}`,
      evidence: {
        kind: "source-plan" as const,
        version: 1 as const,
        ownerRef: plan.ownerRef,
        sourcePlanRef: plan.sourcePlanRef,
        evidenceRef: h(`source-evidence:${id}`),
        rawLocatorHash: locator.rawLocatorHash,
      },
    }])[0]!;
    return { candidate: candidateValue, locator };
  });
  const candidates = candidateFixtures.map(value => value.candidate);
  const probeCaller = {};
  const releaseBinding = approval.resolver.resolve(approval.capability).provenance.runtimeBinding;
  let currentProofBinding = releaseBinding;
  const partitionProofIssuer = createCandidatePartitionProofIssuerFixture(releaseBinding, () => currentProofBinding);
  const sixStepArtifacts = checkpointSixStepArtifacts();
  const checkpoint = new CheckpointStore(
    durable,
    source,
    probeCaller,
    promotionAuthority,
    service.validationAuthority,
    partitionProofIssuer,
    sixStepArtifacts,
    partitionBootstrap,
  );
  const recentEvidence = candidates.flatMap(value => value.evidence).filter((value): value is RecentLogEvidenceRefV1 => value.kind === "recent-log");
  const recentLocators = candidateFixtures
    .filter(value => value.candidate.evidence.some(evidence => evidence.kind === "recent-log"))
    .map(value => value.locator)
    .sort((left, right) => left.rawLocatorHash.localeCompare(right.rawLocatorHash));
  const sourceEvidenceRefs = candidates.flatMap(value => value.evidence).filter(value => value.kind === "source-plan");
  const sourceLocators = candidateFixtures
    .filter(value => value.candidate.evidence.some(evidence => evidence.kind === "source-plan"))
    .map(value => value.locator)
    .sort((left, right) => left.rawLocatorHash.localeCompare(right.rawLocatorHash));
  const sourceRawLocatorHashes = sourceLocators.map(value => value.rawLocatorHash);
  const recentObservation = sealRecentObservation(
    cutoff,
    source.recentObservationRange(cutoff),
    observationBlocks(recentEvidence),
    recentLocators,
  );
  const sourcePlanEvidence = [{
    kind: "source-plan-evidence" as const,
    version: 1 as const,
    plan,
    cutoff,
    refs: sourceEvidenceRefs,
    rawLocatorHashes: sourceRawLocatorHashes,
    evidenceRoot: sourcePlanEvidenceRoot({ plan, cutoff, refs: sourceEvidenceRefs, rawLocatorHashes: sourceRawLocatorHashes }),
  }];
  const sourceExecutionWithoutRoot = {
    kind: "source-plan-execution" as const,
    version: 1 as const,
    plan,
    cutoff,
    outcome: "complete" as const,
    from: options.historySource ? "0" : cutoff.number,
    through: cutoff.number,
    previousAppliedThrough: null,
    resultPartitionRoot: h("source-results"),
    opaqueResult: { kind: "test-source-result", value: "complete" } as const,
    sourceEvidenceRefs,
    rawLocatorHashes: sourceRawLocatorHashes,
    sourceEvidenceRoot: sourcePlanEvidence[0]!.evidenceRoot,
  };
  const sourceExecution = {
    ...sourceExecutionWithoutRoot,
    executionRoot: sourcePlanExecutionRoot(sourceExecutionWithoutRoot),
  };
  const sourceCoverage = sealSourceCoverage(cutoff, [plan], [sourceExecution]);
  const sourceExecutionSet = sealPersistedSourcePlanExecutionSet(cutoff, [sealPersistedSourcePlanExecution({
    execution: sourceExecution,
    sourcePlanLeafDigest: h("source-plan-leaf"),
    sourcePlanSchemaHash: h("source-plan-schema"),
    sourcePlanClosureRoot: h("source-plan-closure"),
    sourceAuthorityRoot: h("source-authority"),
    releaseBindingId: h("source-release-binding"),
    releaseProvenanceHash: h("source-release-provenance"),
    sourceAnchorRoot: h("source-anchor"),
    previousExecutionRoot: null,
  })]);
  const planIdentity = sourcePlanIdentity(plan);
  const claims = candidates.flatMap(candidateValue => candidateValue.evidence.map(evidence => ({
    sourcePlanIdentity: planIdentity,
    familyCandidateKey: candidateValue.familyCandidateKey,
    instanceNominationKey: candidateValue.instanceNominationKey,
    evidenceRefHash: nominationEvidenceRefHash(evidence),
  })));
  const nominationReceipt = sealQualifiedSourcePlanNominationReceiptV1({
    cutoff,
    familyId: "family-a",
    familyDefinitionHash: h("definition"),
    sourcePlanIdentity: planIdentity,
    sourcePlanLeafDigest: h("source-plan-leaf"),
    nominationProgramRoot: h("nomination-program"),
    nominationProgramProposalLeafDigest: releaseBinding.nominationQualificationSet.entries[0]!.proposalLeafDigest,
    qualificationRoot: releaseBinding.nominationQualificationSet.entries[0]!.qualificationLeafDigest,
    denominator: plan.completeness === "nomination-only"
      ? {
        kind: "recent-observation" as const,
        recentObservationRoot: recentObservation.observationRoot,
        relevantEvidenceRefHashes: claims.map(claim => claim.evidenceRefHash).sort(),
        relevantEvidenceRoot: hashCanonicalPartition(
          "aloha/relevant-nomination-evidence/v1",
          claims.map(claim => claim.evidenceRefHash).sort(),
        ),
        relevantEvidenceCount: String(claims.length),
      }
      : {
        kind: "complete-source-result" as const,
        persistedExecutionRoot: sourceExecutionSet.executions[0]!.persistedExecutionRoot,
        resultPartitionRoot: sourceExecution.resultPartitionRoot,
      },
    claims,
  });
  const nominationClosure = sealNominationClosureV1({
    cutoff,
    recentObservationRoot: recentObservation.observationRoot,
    sourceExecutionSetRoot: sourceExecutionSet.executionSetRoot,
    sourceCoverageRoot: sourceCoverage.sourceCoverageRoot,
    sourcePlanIdentities: [planIdentity],
    receipts: [nominationReceipt],
    candidates,
    candidatePartitionRoot: candidatePartitionRoot(candidates),
  });
  const root = await checkpoint.loadAndValidateRoot();
  const run = options.reopen
    ? root.inProgressRunId === null
      ? (() => { throw new Error("checkpoint restart fixture has no active run"); })()
      : await checkpoint.loadRun(root.inProgressRunId)
    : await checkpoint.beginNewRunAndPersistPartition({
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
        recentRawEvidenceLocators: recentLocators,
        sourcePlanRawEvidenceLocators: sourceLocators,
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
    partitionProofIssuer,
    sixStepArtifacts,
    partitionBootstrap,
    probeCaller,
    candidates,
    run,
    recentRawEvidenceLocators: recentLocators,
    sourcePlanRawEvidenceLocators: sourceLocators,
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
      if (options.preserveDirectory !== true) rmSync(directory, { recursive: true, force: true });
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
    if (identityResult.kind === "final") {
      finalResults.push(identityResult);
      continue;
    }
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

type ReadyActivationTimings = Record<string, number>;

async function timeReadyStep<T>(
  timings: ReadyActivationTimings | undefined,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await work();
  } finally {
    if (timings !== undefined) timings[key] = (timings[key] ?? 0) + Date.now() - startedAt;
  }
}

function readyStoreWithTimings(value: Harness, timings: ReadyActivationTimings | undefined): ReadyStorePort {
  if (timings === undefined) return value.checkpoint;
  return {
    putContentAndFsync: (kind, content) => timeReadyStep(
      timings,
      kind === "instance-catalog" ? "persistCatalog" : "persistGraph",
      () => value.checkpoint.putContentAndFsync(kind, content),
    ),
    stageReadyCAS: input => timeReadyStep(timings, "stageReady", () => value.checkpoint.stageReadyCAS(input)),
    activateReadyCAS: input => timeReadyStep(timings, "activateReady", () => value.checkpoint.activateReadyCAS(input)),
    loadActiveReady: () => value.checkpoint.loadActiveReady(),
    loadReadyClosure: ready => value.checkpoint.loadReadyClosure(ready),
    assertContentRoot: (kind, root) => value.checkpoint.assertContentRoot(kind, root),
    assertReadyAuthorityActive: binding => value.checkpoint.assertReadyAuthorityActive(binding),
  };
}

function readyServiceForHarness(value: Harness, timings?: ReadyActivationTimings): Readonly<{
  readonly readyCaller: object;
  readonly readyService: ReadyGenerationServiceV1;
}> {
  const readyCaller = {};
  const readyService = new ReadyGenerationServiceV1(
    readyCaller,
    readyStoreWithTimings(value, timings),
    value.source,
    () => "1",
    () => ({
      definitionCatalogRoot: h("definitions"),
      declaredSourcePlans: value.run.sourceCoverage.entries.map(entry => ({
        ownerRef: entry.ownerRef,
        sourcePlanRef: entry.sourcePlanRef,
        familyDefinitionHash: entry.familyDefinitionHash,
        completeness: entry.completeness,
        historyStartBlock: entry.historyStartBlock,
      })),
      releaseProvenanceHash: value.run.candidatePartitionBinding.releaseProvenanceHash,
    }),
    value.promotionAuthority,
    value.checkpoint.sealedRunReader,
    readyBindingPortForReleaseApproval(value.approval),
  );
  return Object.freeze({ readyCaller, readyService });
}

async function activateReadyServiceForHarness(value: Harness, timings?: ReadyActivationTimings): Promise<Readonly<{
  readonly ready: Awaited<ReturnType<ReadyGenerationServiceV1["promote"]>>;
  readonly readyCaller: object;
  readonly readyService: ReadyGenerationServiceV1;
}>> {
  const fixture = await timeReadyStep(timings, "openSession", () => openSession(value));
  await timeReadyStep(timings, "flushOutcomeBatches", () => (
    flushCapabilities(value, fixture, fixture.persistenceCapabilities)
  ));
  const partitionStartedAt = Date.now();
  const partition = fixture.session.sealExactPartition(fixture.finalResults.map(result => candidateFinalOutcomeHash(result.outcome)));
  if (timings !== undefined) timings.sealExactPartition = Date.now() - partitionStartedAt;
  const sealedRun = await timeReadyStep(timings, "sealPartitionAndMemo", () => (
    value.checkpoint.sealAttestationPartition(value.run.runId, partition)
  ));
  const publications = fixture.finalResults.flatMap(result => result.outcome.kind === "verified" ? [result.outcome.publication] : []);
  const catalogStartedAt = Date.now();
  const instanceCatalog = sealInstanceCatalog(cutoff, publications);
  if (timings !== undefined) timings.sealInstanceCatalog = Date.now() - catalogStartedAt;
  const { readyCaller, readyService } = readyServiceForHarness(value, timings);
  const ready = await timeReadyStep(timings, "readyPromote", () => readyService.promote(readyCaller, {
      sealedRun,
      instanceCatalog,
      parentGenerationId: value.run.parentGenerationId,
      policy: promotionPolicy,
    }));
  if (timings !== undefined) {
    timings.promoteBuildAndValidation = timings.readyPromote
      - timings.persistCatalog
      - timings.persistGraph
      - timings.stageReady
      - timings.activateReady;
  }
  return Object.freeze({ ready, readyCaller, readyService });
}

async function activateReadyForHarness(
  value: Harness,
  timings?: ReadyActivationTimings,
): Promise<Awaited<ReturnType<ReadyGenerationServiceV1["promote"]>>> {
  return (await activateReadyServiceForHarness(value, timings)).ready;
}

async function beginSuccessorRunForHarness(value: Harness): Promise<Harness["run"]> {
  const root = await value.checkpoint.loadAndValidateRoot();
  value.run = await value.checkpoint.beginNewRunAndPersistPartition({
    expectedRootRevision: root.revision,
    parentGenerationId: root.readyGenerationId,
    cutoff: value.run.cutoff,
    recentObservation: value.run.recentObservation,
    sourcePlanEvidence: value.run.sourcePlanEvidence,
    definitionCatalogRoot: value.run.definitionCatalogRoot,
    sourceCoverage: value.run.sourceCoverage,
    sourceExecutionSet: value.run.sourceExecutionSet,
    nominationClosure: value.run.nominationClosure,
    candidates: value.candidates,
    recentRawEvidenceLocators: value.recentRawEvidenceLocators,
    sourcePlanRawEvidenceLocators: value.sourcePlanRawEvidenceLocators,
  });
  return value.run;
}

type RuntimeRestartChildRole = "child-1" | "child-2";

interface RuntimeRestartBehaviorState {
  phase: "initial-ready" | "successor" | "probe";
  runId: string;
}

function runtimeRestartBehavior(state: RuntimeRestartBehaviorState): AttestationTestBehavior {
  return {
    materialization: "verified",
    currentRunId: () => state.runId,
    rejectIdentity(candidateValue) {
      return state.phase === "initial-ready" && candidateValue.instanceNominationKey === "instance-2";
    },
    reuseMemo(candidateValue) {
      return state.phase !== "initial-ready" && candidateValue.instanceNominationKey === "instance-0";
    },
    decideMaterialization(candidateValue) {
      const instance = candidateValue.instanceNominationKey;
      if (state.phase === "initial-ready") return "verified";
      if (instance === "instance-3") return "retryable";
      if (instance === "instance-1" && state.phase !== "probe") return "retryable";
      return "verified";
    },
    dependencySuffix(candidateValue) {
      if (candidateValue.instanceNominationKey === "instance-1" && state.phase === "probe") return ":probe";
      if (candidateValue.instanceNominationKey === "instance-2" && state.phase !== "initial-ready") return ":new";
      return "";
    },
  };
}

async function persistRuntimeRestartSuccessor(
  value: Harness,
  state: RuntimeRestartBehaviorState,
): Promise<void> {
  state.phase = "successor";
  await beginSuccessorRunForHarness(value);
  state.runId = value.run.runId;
  const resume = await value.checkpoint.loadAttestationResumeCapabilities(value.run.runId);
  const session = value.service.openRunSession({
    candidatePartition: value.run.candidatePartition,
    identityResumeCapabilities: resume.identity,
    outcomeResumeCapabilities: resume.final,
    verifiedMemoReuseCapabilities: resume.memoReuse,
  });
  const capabilities: AttestationPersistenceCapabilityV1[] = [];
  for (const candidateValue of value.candidates) {
    const identity = await session.resolveIdentityOrReuseProofOnce(
      candidateValue.familyCandidateKey,
      new AbortController().signal,
    );
    if (identity.kind !== "identityVerified") throw new Error("runtime restart successor identity was not verified");
    capabilities.push(identity.persistenceCapability);
    const final = await session.materializeAndProjectOnce(identity.continuation, new AbortController().signal);
    capabilities.push(final.persistenceCapability);
  }
  const writer = value.checkpoint.createOutcomeWriter(value.run.runId, {
    writerCapability: session.writerCapability,
    flushEveryItems: 25,
    flushEveryMs: 2_000,
  });
  for (const capability of capabilities) await writer.enqueue(capability);
  await writer.closeAfterAllProducersAndFlush();
  resume.claim.commit();

  const probe = value.checkpoint.bindProbeStore(value.probeCaller);
  const target = value.candidates[1]!;
  const before = await probe.loadRetryable(value.run.runId, target.familyCandidateKey);
  state.phase = "probe";
  const replacementSession = openSessionFor(value, before.candidatePartition);
  const identity = await replacementSession.resolveIdentityOrReuseProofOnce(
    target.familyCandidateKey,
    new AbortController().signal,
  );
  if (identity.kind !== "identityVerified") throw new Error("runtime restart probe identity was not verified");
  const replacement = await replacementSession.materializeAndProjectOnce(
    identity.continuation,
    new AbortController().signal,
  );
  if (replacement.outcome.kind !== "verified") throw new Error("runtime restart probe did not produce verified outcome");
  await probe.replaceRetryableCAS(
    before.probeCapability,
    replacementSession.writerCapability,
    replacement.persistenceCapability,
  );
}

function runtimeRestartDeclaredPlans(value: Harness) {
  return value.run.sourceCoverage.entries.map(entry => ({
    ownerRef: entry.ownerRef,
    sourcePlanRef: entry.sourcePlanRef,
    familyDefinitionHash: entry.familyDefinitionHash,
    completeness: entry.completeness,
    historyStartBlock: entry.historyStartBlock,
  }));
}

async function startRuntimeRestartFixture(
  value: Harness,
  readyService: ReadyGenerationServiceV1,
  readyCaller: object,
) {
  const binding = value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding;
  return startStartupRuntime({
    policy: promotionPolicy,
    catalog: {
      loadExact: () => ({
        definitionCatalogRoot: h("definitions"),
        declaredSourcePlans: runtimeRestartDeclaredPlans(value),
      }),
    },
    checkpoint: value.checkpoint,
    canonical: value.source,
    discovery: {
      async executeAllDeclaredPlans() { throw new Error("runtime restart must reuse the active Ready"); },
      async scanRecentBlocks() { throw new Error("runtime restart must reuse the active Ready"); },
      async nominateAll() { throw new Error("runtime restart must reuse the active Ready"); },
      readIssuedNomination() { throw new Error("runtime restart must reuse the active Ready"); },
    },
    attestation: { async attestAndPersistDifference() { throw new Error("runtime restart must not rebuild while reopening"); } },
    ready: issueStartupReadyPort({ service: readyService, promotionCaller: readyCaller }),
    familyRuntime: generatedCompositionFixture({ familyId: "family-a", familyDefinitionHash: h("definition") }),
    processEpoch: `runtime-restart-${process.pid}`,
    releaseBindingId: binding.bindingId,
    candidateReleaseCommit: binding.candidateReleaseCommit,
  });
}

function runtimeRestartStaticArtifacts(value: Harness, logPath: string) {
  const binding = value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding;
  const release = Object.freeze({
    bindingId: binding.bindingId,
    releaseProvenanceHash: value.run.candidatePartitionBinding.releaseProvenanceHash,
    candidateReleaseCommit: binding.candidateReleaseCommit,
  });
  const bundleModulePath = realpathSync(fileURLToPath(new URL("../../startup-runtime/test/generated-composition-fixture.ts", import.meta.url)));
  const entrypointPath = realpathSync(fileURLToPath(import.meta.url));
  const systemdUnitBytes = new TextEncoder().encode(PRE_RELEASE_SYSTEMD_UNIT_V1);
  const releaseEnvironmentBytes = new TextEncoder().encode("SEARCHER_DRY_RUN=1\n");
  const releaseIntentBytes = encodeCanonicalBytes(sealReleaseIntent([], []));
  const manifestBytes = encodeDeploymentManifestV1({
    schemaVersion: 1,
    kind: "aloha.searcher-deployment-manifest",
    bindingId: release.bindingId,
    releaseProvenanceHash: release.releaseProvenanceHash,
    candidateReleaseCommit: release.candidateReleaseCommit,
    searcherRuntimeArtifactRoot: binding.searcherRuntime.runtimeArtifactRoot,
    searcherRuntimeImplementationClosureDigest: binding.searcherRuntime.implementationClosureDigest,
    searcherRuntimeNodeExecutableSha256: sha256Hex(readFileSync(realpathSync(process.execPath))),
    searcherRuntimeEntrypointSha256: sha256Hex(readFileSync(entrypointPath)),
    searcherRuntimeBundleModulePath: bundleModulePath,
    searcherRuntimeBundleModuleSha256: sha256Hex(readFileSync(bundleModulePath)),
    deploymentCompositionModulePath: bundleModulePath,
    deploymentCompositionModuleSha256: sha256Hex(readFileSync(bundleModulePath)),
    deploymentSourceConfigPath: entrypointPath,
    deploymentSourceConfigSha256: sha256Hex(readFileSync(entrypointPath)),
    deploymentRuntimePolicyPath: entrypointPath,
    deploymentRuntimePolicySha256: sha256Hex(readFileSync(entrypointPath)),
    deploymentExecutorStatePath: entrypointPath,
    deploymentExecutorStateSha256: sha256Hex(readFileSync(entrypointPath)),
    releaseIntentPath: entrypointPath,
    releaseIntentSha256: sha256Hex(releaseIntentBytes),
    candidateProofVerifierBindingPath: entrypointPath,
    candidateProofVerifierBindingSha256: sha256Hex(readFileSync(entrypointPath)),
    processCommandSha256: sha256Hex(encodeCanonicalBytes(process.argv)),
    serviceName: "aloha-checkpoint-restart-test",
    systemdUnit: "aloha-checkpoint-restart-test.service",
    systemdUnitPath: entrypointPath,
    systemdUnitSha256: sha256Hex(systemdUnitBytes),
    releaseEnvironmentPath: entrypointPath,
    releaseEnvironmentSha256: sha256Hex(releaseEnvironmentBytes),
    logPath,
    dryRun: true,
  });
  const manifest = decodeDeploymentManifestV1(decodeCanonicalJson(manifestBytes));
  const log = statSync(logPath, { bigint: true });
  const anchors: RuntimeAnchorObservationV1 = Object.freeze({
    candidateReleaseCommit: manifest.candidateReleaseCommit,
    entrypointSha256: manifest.searcherRuntimeEntrypointSha256,
    nodeExecutableSha256: manifest.searcherRuntimeNodeExecutableSha256,
    bundleModulePath: manifest.searcherRuntimeBundleModulePath,
    bundleModuleSha256: manifest.searcherRuntimeBundleModuleSha256,
    processCommandSha256: manifest.processCommandSha256,
    manifestArtifactSha256: sha256Hex(manifestBytes),
    serviceName: manifest.serviceName,
    systemdUnit: manifest.systemdUnit,
    systemdUnitPath: manifest.systemdUnitPath,
    systemdUnitSha256: manifest.systemdUnitSha256,
    releaseEnvironmentPath: manifest.releaseEnvironmentPath,
    releaseEnvironmentSha256: manifest.releaseEnvironmentSha256,
    bootId: "offline-runtime-restart-boot",
    invocationId: `offline-runtime-restart-${process.pid}`,
    logDevice: String(log.dev),
    logInode: String(log.ino),
    pid: String(process.pid),
    processStartTicks: String(process.pid * 1_000),
    dryRun: true,
  });
  return Object.freeze({
    release,
    manifestBytes,
    runtimeAnchor: runtimeAnchorReceiptV1(manifest, anchors, manifestBytes),
    releaseIntentBytes,
    systemdUnitBytes,
    releaseEnvironmentBytes,
  });
}

function runtimeRestartEvidenceOwner(value: Harness, logPath: string, databasePath: string) {
  const artifacts = runtimeRestartStaticArtifacts(value, logPath);
  return Object.freeze({
    artifacts,
    owner: issueProductionRuntimeAcceptanceEvidenceOwnerV1({
      databasePath,
      release: artifacts.release,
      runtimeAnchor: artifacts.runtimeAnchor,
      checkpoint: value.checkpoint,
      strategy: {
        definitionCatalogRoot: h("definitions"),
        strategyCatalogRoot: h("runtime-restart-strategy-catalog"),
        releaseProvenanceHash: artifacts.release.releaseProvenanceHash,
        compositionRoot: h("runtime-restart-strategy-composition"),
      },
      phaseManifest: Object.freeze({ kind: "production", bytes: artifacts.manifestBytes }),
      releaseIntentBytes: artifacts.releaseIntentBytes,
      systemdUnitBytes: artifacts.systemdUnitBytes,
      releaseEnvironmentBytes: artifacts.releaseEnvironmentBytes,
      logPath,
    }),
  });
}

async function runRuntimeRestartChild(role: RuntimeRestartChildRole, directory: string, logPath: string, checkpointDirectory = directory): Promise<void> {
  const databasePath = join(directory, "production-evidence.sqlite");
  const state: RuntimeRestartBehaviorState = { phase: role === "child-1" ? "initial-ready" : "probe", runId: "pending" };
  const value = await makeHarness(4, {
    directory: checkpointDirectory,
    preserveDirectory: true,
    reopen: role === "child-2",
    behavior: runtimeRestartBehavior(state),
  });
  state.runId = value.run.runId;
  let startup: Awaited<ReturnType<typeof startStartupRuntime>> | null = null;
  let acceptance: ReturnType<typeof runtimeRestartEvidenceOwner> | null = null;
  try {
    let readyService: ReadyGenerationServiceV1;
    let readyCaller: object;
    if (role === "child-1") {
      const activated = await activateReadyServiceForHarness(value);
      readyService = activated.readyService;
      readyCaller = activated.readyCaller;
      await persistRuntimeRestartSuccessor(value, state);
    } else {
      ({ readyService, readyCaller } = readyServiceForHarness(value));
    }
    startup = await startRuntimeRestartFixture(value, readyService, readyCaller);
    acceptance = runtimeRestartEvidenceOwner(value, logPath, databasePath);
    await recordProductionRuntimeProcessReadyV1(acceptance.owner, startup);

    if (role === "child-1") {
      const signal = installProductionRuntimeSigtermEvidenceV1({ owner: acceptance.owner, stop: () => startup!.close() });
      process.send?.({ kind: "runtime-restart-child-ready", role, pid: process.pid });
      while (signal.task() === null) await new Promise<void>(resolve => setTimeout(resolve, 5));
      await signal.task();
      signal.uninstall();
      process.send?.({ kind: "runtime-restart-child-drained", role, pid: process.pid });
    } else {
      const evidence = issueSearcherProductionEvidenceOwnerV1({
        databasePath,
        release: acceptance.artifacts.release,
        runtimeAnchor: acceptance.artifacts.runtimeAnchor,
      });
      try {
        const ports = evidence.bindServing(startup);
        const headObservation = await value.source.observeCurrentHead();
        await startup.withProducerSession(headObservation, async session => {
          const observedHead = value.source.headObservationReader.read(headObservation).head;
          const eligibleHead = await ports.performance.acceptEligibleHead({ head: observedHead, revision: "0" });
          await ports.performance.bindEligibleHeadSession({ eligibleHead, session });
          const generation = startup!.readProducerSessionGeneration(session);
          const facts = issueProducerHeadFactsCapabilityV1({
            kind: "aloha.producer-head-facts-v1",
            headHash: observedHead.hash,
            generationId: generation.generationId,
            graphRoot: generation.graphRoot,
            laneFacts: Object.freeze([]),
            laneFailureObservations: Object.freeze([]),
            candidateRefs: Object.freeze([]),
            currentSourcePhysical: null,
            sourceCoverageRoot: generation.sourceCoverageRoot,
            complete: false,
          });
          await ports.performance.bindEligibleHeadFacts({ eligibleHead, facts });
        });
      } finally {
        evidence.close();
      }
      process.send?.({ kind: "runtime-restart-child-ready", role, pid: process.pid });
      await startup.close();
    }
  } finally {
    if (startup !== null) await startup.close();
    if (acceptance !== null) closeProductionRuntimeAcceptanceEvidenceV1(acceptance.owner);
    value.close();
  }
}

function restartObserverSink(directory: string): ContentAddressedObserverSinkV1 {
  return new ContentAddressedObserverSinkV1({
    directory,
    storeIdentityHash: h("runtime-restart-observer-store"),
    resolverPolicy: createResolverPolicy({
      schemaVersion: 1,
      kind: "aloha.artifact-resolver-policy",
      allowedLocatorKind: "content-object",
      digestAlgorithm: "sha256",
      maxByteLength: "100000000",
      requireExactLengthMediaAndSchema: true,
      minimumRemainingStoreEpochs: "0",
      failureOutcome: "invalid",
    }),
    lease: {
      validFromStoreEpoch: "0",
      validThroughStoreEpoch: "18446744073709551615",
      issuerId: "runtime-restart-integration-observer",
      issuerQualificationId: h("runtime-restart-observer-qualification"),
      qualificationRegistryRoot: h("runtime-restart-observer-registry"),
    },
  });
}

type RuntimeRestartChildMessage = Readonly<{
  readonly kind: "runtime-restart-child-ready" | "runtime-restart-child-drained";
  readonly role: RuntimeRestartChildRole;
  readonly pid: number;
}>;

function waitForRuntimeRestartChildMessage(
  child: ReturnType<typeof spawn>,
  kind: RuntimeRestartChildMessage["kind"],
  stderr: { value: string },
): Promise<RuntimeRestartChildMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${kind}; stderr=${stderr.value}`)), 30_000);
    const onMessage = (message: unknown) => {
      if (message === null || typeof message !== "object") return;
      const candidate = message as Partial<RuntimeRestartChildMessage>;
      if (candidate.kind !== kind || (candidate.role !== "child-1" && candidate.role !== "child-2") || typeof candidate.pid !== "number") return;
      finish(null, candidate as RuntimeRestartChildMessage);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`child exited before ${kind}: code=${String(code)} signal=${String(signal)} stderr=${stderr.value}`));
    };
    const finish = (error: Error | null, message?: RuntimeRestartChildMessage) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error !== null) reject(error);
      else resolve(message!);
    };
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

function waitForRuntimeRestartChildExit(
  child: ReturnType<typeof spawn>,
  stderr: { value: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for child exit; stderr=${stderr.value}`)), 30_000);
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0 && signal === null) finish(null);
      else finish(new Error(`child failed: code=${String(code)} signal=${String(signal)} stderr=${stderr.value}`));
    };
    const finish = (error: Error | null) => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error !== null) reject(error);
      else resolve();
    };
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

function spawnRuntimeRestartChild(
  role: RuntimeRestartChildRole,
  directory: string,
  logPath: string,
  logFd: number,
  checkpointDirectory = directory,
): Readonly<{ readonly child: ReturnType<typeof spawn>; readonly stderr: { value: string } }> {
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--test",
    "--test-isolation=none",
    "--test-name-pattern=runtime restart child role",
    realpathSync(fileURLToPath(import.meta.url)),
  ], {
    cwd: realpathSync(join(fileURLToPath(new URL("../../../", import.meta.url)))),
    env: {
      ...process.env,
      ALOHA_RUNTIME_RESTART_CHILD_ROLE: role,
      ALOHA_RUNTIME_RESTART_DIRECTORY: directory,
      ALOHA_RUNTIME_RESTART_CHECKPOINT_DIRECTORY: checkpointDirectory,
      ALOHA_RUNTIME_RESTART_LOG_PATH: logPath,
    },
    stdio: ["ignore", logFd, "pipe", "ipc"],
  });
  const stderr = { value: "" };
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", chunk => { stderr.value += String(chunk); });
  child.on("exit", () => {
    stderr.value += `\nphysical-log:\n${readFileSync(logPath, "utf8")}`;
  });
  return Object.freeze({ child, stderr });
}

async function executeRuntimeRestartChildren(input: Readonly<{
  readonly directory: string;
  readonly logPath: string;
  readonly logFd: number;
  readonly secondCheckpointDirectory?: string;
  readonly beforeSecondChild?: () => void;
}>): Promise<Readonly<{ readonly firstPid: number; readonly secondPid: number }>> {
  let child1: ReturnType<typeof spawn> | null = null;
  let child2: ReturnType<typeof spawn> | null = null;
  try {
    const first = spawnRuntimeRestartChild("child-1", input.directory, input.logPath, input.logFd);
    child1 = first.child;
    const firstExit = waitForRuntimeRestartChildExit(first.child, first.stderr);
    const firstReady = await waitForRuntimeRestartChildMessage(first.child, "runtime-restart-child-ready", first.stderr);
    const firstDrained = waitForRuntimeRestartChildMessage(first.child, "runtime-restart-child-drained", first.stderr);
    assert.equal(first.child.kill("SIGTERM"), true);
    const drained = await firstDrained;
    assert.equal(drained.pid, firstReady.pid);
    await firstExit;
    child1 = null;

    input.beforeSecondChild?.();
    const second = spawnRuntimeRestartChild(
      "child-2",
      input.directory,
      input.logPath,
      input.logFd,
      input.secondCheckpointDirectory ?? input.directory,
    );
    child2 = second.child;
    const secondExit = waitForRuntimeRestartChildExit(second.child, second.stderr);
    const secondReady = await waitForRuntimeRestartChildMessage(second.child, "runtime-restart-child-ready", second.stderr);
    await secondExit;
    child2 = null;
    assert.notEqual(secondReady.pid, firstReady.pid);
    return Object.freeze({ firstPid: firstReady.pid, secondPid: secondReady.pid });
  } finally {
    if (child1 !== null && child1.exitCode === null && child1.signalCode === null) child1.kill("SIGKILL");
    if (child2 !== null && child2.exitCode === null && child2.signalCode === null) child2.kill("SIGKILL");
  }
}

function copyRuntimeRestartSqliteStore(sourceDirectory: string, destinationDirectory: string): void {
  for (const basename of ["checkpoint.sqlite", "canonical-journal.sqlite"] as const) {
    for (const suffix of ["", "-wal", "-shm"] as const) {
      const source = join(sourceDirectory, `${basename}${suffix}`);
      if (existsSync(source)) copyFileSync(source, join(destinationDirectory, `${basename}${suffix}`));
    }
  }
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

interface StoredProbeTestEnvelopeV1 {
  readonly receipt: ProbeReceiptV1;
  readonly candidatePartitionStorageHash: Hash;
  readonly priorOutcomePartitionStorageHash: Hash;
  readonly activeOutcomePartitionStorageHash: Hash;
}

function resealProbeReceipt(
  receipt: ProbeReceiptV1,
  override: Partial<Omit<ProbeReceiptV1, "transitionAuthorityRoot" | "receiptLineageRoot" | "probeReceiptHash">>,
): ProbeReceiptV1 {
  const { transitionAuthorityRoot: _transition, receiptLineageRoot: _lineage, probeReceiptHash: _hash, ...input } = receipt;
  return sealProbeReceipt({ ...input, ...override });
}

function rewriteLatestProbeEnvelope(
  value: Harness,
  mutate: (envelope: StoredProbeTestEnvelopeV1, tx: DurableTransaction) => StoredProbeTestEnvelopeV1,
): void {
  const lease = value.durable.acquireWriterLease("checkpoint-test-rewrite-probe-evidence");
  try {
    value.durable.transaction(lease, tx => {
      const rootRecord = tx.readRoot();
      assert.ok(rootRecord);
      const root = CHECKPOINT_SCHEMA_AUTHORITY.decodeRoot(rootRecord.envelopeBytes) as unknown as Record<string, unknown>;
      const priorReceiptStorageHash = String(root.latestProbeReceiptHash) as Hash;
      assert.ok(priorReceiptStorageHash);
      const priorReceiptRecord = tx.readContent(priorReceiptStorageHash);
      assert.equal(priorReceiptRecord?.kind, "aloha/probe-transition-receipt/v1");
      const envelope = decodeCanonicalJson(priorReceiptRecord!.bytes) as unknown as StoredProbeTestEnvelopeV1;
      const nextEnvelope = mutate(envelope, tx);
      const nextReceiptReferences = [
        ...(nextEnvelope.receipt.priorReceiptHash === null ? [] : [nextEnvelope.receipt.priorReceiptHash]),
        nextEnvelope.candidatePartitionStorageHash,
        nextEnvelope.priorOutcomePartitionStorageHash,
        nextEnvelope.activeOutcomePartitionStorageHash,
      ];
      const nextReceiptStorageHash = tx.putImmutable(
        "aloha/probe-transition-receipt/v1",
        encodeCanonicalBytes(nextEnvelope),
        nextReceiptReferences,
      );
      const runStorageHash = rootRecord.references.find(hash => tx.readContent(hash)?.kind === "aloha/in-progress-run/v2");
      assert.ok(runStorageHash);
      const runRecord = tx.readContent(runStorageHash);
      assert.ok(runRecord);
      const run = CHECKPOINT_SCHEMA_AUTHORITY.decodeRun(runRecord.bytes) as unknown as Record<string, unknown>;
      const nextRevision = (BigInt(String(root.revision)) + 1n).toString();
      const nextRunStorageHash = tx.putImmutable(
        "aloha/in-progress-run/v2",
        encodeCanonicalBytes({ ...run, checkpointRevision: nextRevision }),
        runRecord.references,
      );
      tx.compareAndSwapRoot(
        String(root.revision),
        encodeCanonicalBytes({
          ...root,
          revision: nextRevision,
          latestProbeReceiptHash: nextReceiptStorageHash,
          probeReceiptSequence: nextEnvelope.receipt.sequence,
          probeReceiptLineageRoot: nextEnvelope.receipt.receiptLineageRoot,
        }),
        rootRecord.references.map(hash =>
          hash === runStorageHash
            ? nextRunStorageHash
            : hash === priorReceiptStorageHash ? nextReceiptStorageHash : hash
        ),
      );
    });
  } finally {
    value.durable.releaseWriterLease(lease);
  }
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
      const mutatedCandidate = { ...oldCandidate, familyId: "family-proof-splice" };
      const mutatedCandidateHash = tx.putImmutable("aloha/candidate-record/v2", encodeCanonicalBytes(mutatedCandidate));
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
          String(nextRun.sourceExecutionSetStorageHash) as Hash,
          String(nextRun.sourcePlanEvidenceStorageHash) as Hash,
          String(nextRun.nominationClosureStorageHash) as Hash,
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
        nextRun.sourceExecutionSetStorageHash,
        nextRun.sourcePlanEvidenceStorageHash,
        nextRun.nominationClosureStorageHash,
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

function mutateAttestationPartitionClosure(
  value: Harness,
  mode: "missing" | "reordered" | "duplicate" | "cross-partition",
): void {
  const lease = value.durable.acquireWriterLease(`checkpoint-test-attestation-${mode}`);
  try {
    value.durable.transaction(lease, tx => {
      const rootRecord = tx.readRoot();
      assert.ok(rootRecord);
      const root = CHECKPOINT_SCHEMA_AUTHORITY.decodeRoot(rootRecord.envelopeBytes) as unknown as Record<string, unknown>;
      const runHash = rootRecord.references.find(hash => tx.readContent(hash)?.kind === "aloha/in-progress-run/v2");
      assert.ok(runHash);
      const runRecord = tx.readContent(runHash);
      assert.ok(runRecord);
      const run = CHECKPOINT_SCHEMA_AUTHORITY.decodeRun(runRecord.bytes) as unknown as Record<string, unknown>;
      const attestationHash = String(run.attestationPartitionStorageHash) as Hash;
      const attestationRecord = tx.readContent(attestationHash);
      assert.ok(attestationRecord);
      const originalOutcomeHash = String(run.outcomePartitionStorageHash) as Hash;
      let outcomeHash = originalOutcomeHash;
      let attestationReferences: Hash[] = [originalOutcomeHash];
      if (mode === "missing") {
        attestationReferences = [];
      } else if (mode === "cross-partition") {
        attestationReferences = [String(run.candidatePartitionStorageHash) as Hash];
      } else {
        const outcomeManifestRecord = tx.readContent(originalOutcomeHash);
        assert.ok(outcomeManifestRecord);
        const outcomeManifest = decodeCanonicalJson(outcomeManifestRecord.bytes) as Record<string, unknown>;
        const firstPageHash = (outcomeManifest.pageStorageHashes as Hash[])[0]!;
        const firstPageRecord = tx.readContent(firstPageHash);
        assert.ok(firstPageRecord);
        const firstPage = decodeCanonicalJson(firstPageRecord.bytes) as Record<string, unknown>;
        const entries = firstPage.entries as Array<Record<string, unknown>>;
        assert.ok(entries.length >= 2);
        const mutatedEntries = mode === "reordered"
          ? [...entries].reverse()
          : [entries[0]!, entries[0]!, ...entries.slice(1)];
        const pageHash = tx.putImmutable(
          "aloha/checkpoint-partition-page/v1",
          encodeCanonicalBytes({ ...firstPage, entries: mutatedEntries }),
          mutatedEntries.map(entry => String(entry.storageHash) as Hash),
        );
        outcomeHash = tx.putImmutable(
          "aloha/checkpoint-partition-manifest/v1",
          encodeCanonicalBytes({
            ...outcomeManifest,
            count: String(mutatedEntries.length),
            pageStorageHashes: [pageHash],
          }),
          [pageHash],
        );
        attestationReferences = [outcomeHash];
      }
      const replacementAttestationHash = tx.putImmutable(
        "aloha/attestation-partition/v1",
        attestationRecord.bytes,
        attestationReferences,
      );
      const nextRevision = (BigInt(String(root.revision)) + 1n).toString();
      const nextRun = {
        ...run,
        checkpointRevision: nextRevision,
        outcomePartitionStorageHash: outcomeHash,
        attestationPartitionStorageHash: replacementAttestationHash,
      } as Record<string, unknown>;
      const nextRunHash = tx.putImmutable(
        "aloha/in-progress-run/v2",
        encodeCanonicalBytes(nextRun),
        [
          nextRun.recentObservationStorageHash,
          nextRun.sourceCoverageStorageHash,
          nextRun.sourceExecutionSetStorageHash,
          nextRun.sourcePlanEvidenceStorageHash,
          nextRun.nominationClosureStorageHash,
          nextRun.candidatePartitionStorageHash,
          nextRun.candidatePartitionProofStorageHash,
          nextRun.outcomePartitionStorageHash,
          nextRun.verifiedMemoSetStorageHash,
          nextRun.attestationPartitionStorageHash,
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

function selfConsistentForgedReuseOrigin(
  value: Harness,
  identity: Record<string, unknown>,
): Record<string, unknown> {
  const candidateValue = value.candidates[0]!;
  const oldInstancePublicationHash = h("forged-prior-publication");
  const identityMemo = identity.identityMemo;
  const identityMemoHashValue = String(identity.identityMemoHash) as Hash;
  const descriptorHash = String(identity.descriptorHash) as Hash;
  const proofCore = {
    kind: "verifiedMemoReuseProof" as const,
    familyId: candidateValue.familyId,
    familyDefinitionHash: candidateValue.familyDefinitionHash,
    familyCandidateKey: candidateValue.familyCandidateKey,
    candidateSubjectHash: candidateValue.candidateSubjectHash,
    instanceNominationKey: candidateValue.instanceNominationKey,
    cutoff,
    oldInstancePublicationHash,
    requestedArtifactDependencyRoot: h("forged-prior-requested-dependencies"),
    descriptorHash,
    validityDependencyRoot: h("forged-prior-validity"),
    candidateToCanonicalIdentityBindingProof: hashDomain("aloha/candidate-to-canonical-identity-binding/v1", {
      familyId: candidateValue.familyId,
      familyDefinitionHash: candidateValue.familyDefinitionHash,
      familyCandidateKey: candidateValue.familyCandidateKey,
      candidateSubjectHash: candidateValue.candidateSubjectHash,
      instanceNominationKey: candidateValue.instanceNominationKey,
      cutoff,
      oldInstancePublicationHash,
      identityMemoHash: identityMemoHashValue,
      descriptorHash,
    }),
    identityMemo,
    identityMemoHash: identityMemoHashValue,
    evidenceRoot: String(identity.evidenceRoot) as Hash,
  };
  return {
    kind: "verified-memo-reuse",
    verifiedMemoSetRoot: h("forged-prior-memo-set"),
    proof: {
      ...proofCore,
      proofHash: hashDomain("aloha/verified-memo-reuse-proof/v1", proofCore),
    },
  };
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
  const mutations: readonly [string, (identity: Record<string, unknown>, value: Harness) => Record<string, unknown>][] = [
    ["v1-proof-wire", identity => ({
      ...identity,
      issuerProof: {
        ...(identity.issuerProof as Record<string, unknown>),
        version: "1",
      },
    })],
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
        candidateSubjectHash: h("spliced-candidate-snapshot"),
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
    ["fresh-to-reuse-origin-splice", (identity, value) => ({
      ...identity,
      issuerProof: {
        ...(identity.issuerProof as Record<string, unknown>),
        identityOrigin: selfConsistentForgedReuseOrigin(value, identity),
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
        identity: mutateIdentity(partial.identity as Record<string, unknown>, value),
      };
      nextPartial.outcomeHash = partialIdentityHash(value, nextPartial);
      replaceActivePartitionRecord(value, "partial-outcome", key, nextPartial);
      await assert.rejects(
        () => value.checkpoint.loadAttestationResumeCapabilities(value.run.runId),
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
    ["v1-identity-proof-wire", 1, outcome => ({
      ...outcome,
      identityProof: {
        ...(outcome.identityProof as Record<string, unknown>),
        version: "1",
      },
    })],
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
        candidateSubjectHash: h("foreign-final-candidate"),
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
    ["v1-outcome-proof-wire", 1, outcome => ({
      ...outcome,
      outcomeIssuerProof: {
        ...(outcome.outcomeIssuerProof as Record<string, unknown>),
        version: "1",
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
      await assert.rejects(
        () => value.checkpoint.loadAttestationResumeCapabilities(value.run.runId),
        /identity|proof|signature|issuer|authority|binding|publication|body|candidate|cutoff|partition|release|mismatch|outcome/i,
        `${label}:combined-resume`,
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
      value.sixStepArtifacts,
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

test("combined restart difference uses a two-phase claim and exposes retryable outcomes for CAS", async () => {
  const value = await makeHarness(2);
  try {
    const session = openSessionFor(value);
    const identity0 = await session.resolveIdentityOrReuseProofOnce(
      value.candidates[0]!.familyCandidateKey,
      new AbortController().signal,
    );
    const identity1 = await session.resolveIdentityOrReuseProofOnce(
      value.candidates[1]!.familyCandidateKey,
      new AbortController().signal,
    );
    if (identity0.kind !== "identityVerified" || identity1.kind !== "identityVerified") {
      throw new Error("checkpoint resume fixture did not produce identity");
    }
    const final1 = await session.materializeAndProjectOnce(identity1.continuation, new AbortController().signal);
    const writer = value.checkpoint.createOutcomeWriter(value.run.runId, {
      writerCapability: session.writerCapability,
      flushEveryItems: 2,
      flushEveryMs: 2_000,
    });
    await writer.enqueue(identity0.persistenceCapability);
    await writer.enqueue(final1.persistenceCapability);
    await writer.closeAfterAllProducersAndFlush();

    const first = await value.checkpoint.loadAttestationResumeCapabilities(value.run.runId);
    assert.equal(first.identity.length, 1);
    assert.equal(first.final.length, 1);
    assert.deepEqual(first.retryable, []);
    first.claim.abort();
    const retried = await value.checkpoint.loadAttestationResumeCapabilities(value.run.runId);
    assert.equal(retried.identity.length, 1);
    assert.equal(retried.final.length, 1);
    assert.notEqual(retried.identity[0], first.identity[0]);
    retried.claim.commit();
    await assert.rejects(
      () => value.checkpoint.loadAttestationResumeCapabilities(value.run.runId),
      /already claimed|resume|capability/i,
    );

    value.durable.close();
    value.durable = createSqliteDurableStore(value.filename);
    value.partitionBootstrap = createCandidatePartitionBootstrap();
    value.checkpoint = new CheckpointStore(
      value.durable,
      value.source,
      value.probeCaller,
      value.promotionAuthority,
      value.authority,
      createCandidatePartitionProofIssuerFixture(
        value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding,
      ),
      value.sixStepArtifacts,
      value.partitionBootstrap,
    );
    const reopened = await value.checkpoint.loadAttestationResumeCapabilities(value.run.runId);
    assert.equal(reopened.identity.length, 1);
    assert.equal(reopened.final.length, 1);
    reopened.claim.abort();
  } finally {
    value.close();
  }
});

test("durable retryable outcomes are re-execution work, never unconditional final resume", async () => {
  const value = await makeHarness(1, { behavior: { materialization: "retryable" } });
  try {
    const fixture = await openSession(value);
    await flushCapabilities(value, fixture, [fixture.finalResults[0]!.persistenceCapability]);
    const resume = await value.checkpoint.loadAttestationResumeCapabilities(value.run.runId);
    assert.deepEqual(resume.final, []);
    assert.deepEqual(resume.retryable, [value.candidates[0]!.familyCandidateKey]);
    resume.claim.abort();
  } finally {
    value.close();
  }
});

test("combined resume rejects a forged durable retryable proof before exposing a retry key", async () => {
  const value = await makeHarness(1, { behavior: { materialization: "retryable" } });
  try {
    const fixture = await openSession(value);
    await flushCapabilities(value, fixture, [fixture.finalResults[0]!.persistenceCapability]);
    const key = value.candidates[0]!.familyCandidateKey;
    const storageHash = value.durable.readIndex(`outcome/${value.run.runId}`, key);
    assert.ok(storageHash);
    const record = value.durable.readContent(storageHash);
    assert.ok(record);
    const forged = {
      ...(decodeCanonicalJson(record.bytes) as Record<string, unknown>),
      outcomeIssuerProof: {
        ...((decodeCanonicalJson(record.bytes) as Record<string, unknown>).outcomeIssuerProof as Record<string, unknown>),
        signatureHex: `0x${"44".repeat(64)}`,
      },
    };
    replaceActivePartitionRecord(value, "outcome", key, forged);
    await assert.rejects(
      () => value.checkpoint.loadAttestationResumeCapabilities(value.run.runId),
      /proof|signature|issuer|authority|binding|mismatch|outcome/i,
    );
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
      () => value.checkpoint.loadAttestationResumeCapabilities(value.run.runId),
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
      checkpointSixStepArtifacts(),
      rotatedBootstrap,
    );
    await assert.rejects(
      () => rotatedCheckpoint.loadAttestationResumeCapabilities(value.run.runId),
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
      value.sixStepArtifacts,
      value.partitionBootstrap,
    );
    const resume = await restartedCheckpoint.loadAttestationResumeCapabilities(value.run.runId);
    const capabilities = resume.identity;
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
    resume.claim.commit();
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

    const resume = await value.checkpoint.loadAttestationResumeCapabilities(value.run.runId);
    const capabilities = resume.identity;
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
    resume.claim.abort();
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

test("release-owner retry CAS releases a pre-commit probe claim and retries the same final capability", async () => {
  const behavior: AttestationTestBehavior = { materialization: "retryable" };
  const value = await makeHarness(1, { behavior });
  try {
    const initial = await openSession(value);
    await flushCapabilities(value, initial, [initial.finalResults[0]!.persistenceCapability]);
    behavior.materialization = "verified";
    const replacement = openSessionFor(value);
    const identity = await replacement.resolveIdentityOrReuseProofOnce(
      value.candidates[0]!.familyCandidateKey,
      new AbortController().signal,
    );
    if (identity.kind !== "identityVerified") throw new Error("retry fixture did not produce identity");
    const final = await replacement.materializeAndProjectOnce(identity.continuation, new AbortController().signal);
    if (final.outcome.kind !== "verified") throw new Error("retry fixture did not produce verified outcome");

    value.armBeforeCommitFailure();
    await assert.rejects(
      () => value.checkpoint._replaceRetryableOutcomeForOwner(
        value.run.runId,
        value.candidates[0]!.familyCandidateKey,
        replacement.writerCapability,
        final.persistenceCapability,
      ),
      /before-commit|SQLite transaction failed|sqlite/i,
    );
    await value.checkpoint._replaceRetryableOutcomeForOwner(
      value.run.runId,
      value.candidates[0]!.familyCandidateKey,
      replacement.writerCapability,
      final.persistenceCapability,
    );
    assert.equal(persistedOutcome(value, value.candidates[0]!.familyCandidateKey).kind, "verified");
  } finally {
    value.close();
  }
});

async function commitVerifiedProbe(
  value: Harness,
  behavior: AttestationTestBehavior,
  candidate: CandidateRecordV1,
): Promise<ProbeReceiptV1> {
  const probe = value.checkpoint.bindProbeStore(value.probeCaller);
  const before = await probe.loadRetryable(value.run.runId, candidate.familyCandidateKey);
  behavior.materialization = "verified";
  const session = openSessionFor(value, before.candidatePartition);
  const identity = await session.resolveIdentityOrReuseProofOnce(candidate.familyCandidateKey, new AbortController().signal);
  if (identity.kind !== "identityVerified") throw new Error("probe fixture did not produce identity");
  const replacement = await session.materializeAndProjectOnce(identity.continuation, new AbortController().signal);
  if (replacement.outcome.kind !== "verified") throw new Error("probe fixture did not produce a verified outcome");
  return probe.replaceRetryableCAS(
    before.probeCapability,
    session.writerCapability,
    replacement.persistenceCapability,
  );
}

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

    const durableEvidence = value.checkpoint.loadLatestProbeEvidence();
    assert.ok(durableEvidence);
    assert.equal(durableEvidence.receipt.probeReceiptHash, receipt.probeReceiptHash);
    assert.deepEqual(durableEvidence.beforeOutcomes.map(outcome => outcome.kind), ["retryable", "retryable"]);
    assert.deepEqual(durableEvidence.afterOutcomes.map(outcome => outcome.kind), ["verified", "retryable"]);
    assert.equal(
      durableEvidence.beforeOutcomes.filter(outcome =>
        candidateFinalOutcomeHash(outcome) !== candidateFinalOutcomeHash(
          durableEvidence.afterOutcomes.find(next => next.familyCandidateKey === outcome.familyCandidateKey)!,
        )
      ).length,
      1,
    );

    value.durable.close();
    value.durable = createSqliteDurableStore(value.filename);
    value.partitionBootstrap = createCandidatePartitionBootstrap();
    value.checkpoint = new CheckpointStore(
      value.durable,
      value.source,
      value.probeCaller,
      value.promotionAuthority,
      value.authority,
      value.partitionProofIssuer,
      value.sixStepArtifacts,
      value.partitionBootstrap,
    );
    assert.deepEqual(value.checkpoint.loadLatestProbeEvidence(), durableEvidence);
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

test("durable probe evidence rejects a removed outcome and a valid non-target transition", async () => {
  const removalBehavior: AttestationTestBehavior = { materialization: "retryable" };
  const removal = await makeHarness(2, { behavior: removalBehavior });
  try {
    const initial = await openSession(removal);
    await flushCapabilities(removal, initial, initial.finalResults.map(result => result.persistenceCapability));
    await commitVerifiedProbe(removal, removalBehavior, removal.candidates[0]!);
    rewriteLatestProbeEnvelope(removal, (envelope, tx) => {
      const manifest = decodeCanonicalJson(tx.readContent(envelope.activeOutcomePartitionStorageHash)!.bytes) as Record<string, unknown>;
      const pageHash = (manifest.pageStorageHashes as Hash[])[0]!;
      const page = decodeCanonicalJson(tx.readContent(pageHash)!.bytes) as Record<string, unknown>;
      const targetEntry = (page.entries as { readonly key: string; readonly storageHash: Hash }[])
        .find(entry => entry.key === envelope.receipt.familyCandidateKey);
      assert.ok(targetEntry);
      const reducedPageHash = tx.putImmutable(
        "aloha/checkpoint-partition-page/v1",
        encodeCanonicalBytes({ ...page, entries: [targetEntry] }),
        [targetEntry.storageHash],
      );
      const reducedManifestHash = tx.putImmutable(
        "aloha/checkpoint-partition-manifest/v1",
        encodeCanonicalBytes({ ...manifest, count: "1", pageStorageHashes: [reducedPageHash] }),
        [reducedPageHash],
      );
      const targetOutcome = decodeCanonicalJson(tx.readContent(targetEntry.storageHash)!.bytes) as unknown as CandidateFinalOutcomeV1;
      const activeOutcomePartitionRoot = hashDomain("aloha/checkpoint-outcome-partition/v1", {
        runId: envelope.receipt.runId,
        outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", [targetOutcome]),
      });
      return {
        ...envelope,
        receipt: resealProbeReceipt(envelope.receipt, { activeOutcomePartitionRoot }),
        activeOutcomePartitionStorageHash: reducedManifestHash,
      };
    });
    assert.throws(
      () => removal.checkpoint.loadLatestProbeEvidence(),
      /denominator|partition|outcome/i,
    );
  } finally {
    removal.close();
  }

  const nonTargetBehavior: AttestationTestBehavior = { materialization: "retryable" };
  const nonTarget = await makeHarness(2, { behavior: nonTargetBehavior });
  try {
    const initial = await openSession(nonTarget);
    await flushCapabilities(nonTarget, initial, initial.finalResults.map(result => result.persistenceCapability));
    await commitVerifiedProbe(nonTarget, nonTargetBehavior, nonTarget.candidates[0]!);
    const firstEvidence = nonTarget.checkpoint.loadLatestProbeEvidence();
    assert.ok(firstEvidence);
    await commitVerifiedProbe(nonTarget, nonTargetBehavior, nonTarget.candidates[1]!);
    rewriteLatestProbeEnvelope(nonTarget, envelope => ({
      ...envelope,
      receipt: resealProbeReceipt(envelope.receipt, {
        priorOutcomePartitionRoot: firstEvidence.receipt.priorOutcomePartitionRoot,
      }),
      priorOutcomePartitionStorageHash: firstEvidence.priorOutcomePartitionStorageHash,
    }));
    assert.throws(
      () => nonTarget.checkpoint.loadLatestProbeEvidence(),
      /non-target outcome/i,
    );
  } finally {
    nonTarget.close();
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
        value.sixStepArtifacts,
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
    const fake = Object.freeze({
      currentRelease: real.currentRelease,
      assertNominationQualificationsQualified: real.assertNominationQualificationsQualified,
      issue: real.issue,
      verify: real.verify,
    });
    assert.throws(
      () => new CheckpointStore(value.durable, value.source, value.probeCaller, value.promotionAuthority, value.authority, fake, value.sixStepArtifacts),
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

test("compact attestation manifest rejects missing, reordered, duplicate, and cross-partition outcome closure", async (t) => {
  for (const mode of ["missing", "reordered", "duplicate", "cross-partition"] as const) {
    await t.test(mode, async () => {
      const value = await makeHarness(2);
      try {
        const fixture = await openSession(value);
        await flushCapabilities(value, fixture, fixture.persistenceCapabilities);
        const partition = fixture.session.sealExactPartition(
          fixture.finalResults.map(result => candidateFinalOutcomeHash(result.outcome)),
        );
        await value.checkpoint.sealAttestationPartition(value.run.runId, partition);
        const sealedEnvelope = activeRunEnvelope(value);
        const attestationRecord = value.durable.readContent(
          String(sealedEnvelope.attestationPartitionStorageHash) as Hash,
        );
        assert.ok(attestationRecord);
        assert.equal(
          Object.prototype.hasOwnProperty.call(decodeCanonicalJson(attestationRecord.bytes), "manifestRoot"),
          false,
        );
        mutateAttestationPartitionClosure(value, mode);
        await assert.rejects(
          () => value.checkpoint.loadRun(value.run.runId),
          /attestation|outcome|partition|reference|order|duplicate|mismatch|corrupt/i,
        );
      } finally {
        value.close();
      }
    });
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
      value.sixStepArtifacts,
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

test("candidate partition exposes only each candidate's exact durable raw evidence", async () => {
  const value = await makeHarness(2);
  try {
    const [first, second] = value.candidates;
    assert.ok(first && second);
    const firstHash = first.evidence[0]!.rawLocatorHash;
    const firstRead = value.checkpoint.candidatePartitionReader.readRawEvidence(
      value.run.candidatePartition,
      first.familyCandidateKey,
      firstHash,
    );
    assert.equal(sha256Hex(firstRead), firstHash);

    const originalByte = firstRead[0]!;
    firstRead[0] = originalByte ^ 0xff;
    const secondRead = value.checkpoint.candidatePartitionReader.readRawEvidence(
      value.run.candidatePartition,
      first.familyCandidateKey,
      firstHash,
    );
    assert.equal(secondRead[0], originalByte, "reader must return a defensive copy");

    assert.throws(
      () => value.checkpoint.candidatePartitionReader.readRawEvidence(
        value.run.candidatePartition,
        second.familyCandidateKey,
        firstHash,
      ),
      /outside|locator|candidate/i,
    );
    assert.throws(
      () => value.checkpoint.candidatePartitionReader.readRawEvidence(
        { ...value.run.candidatePartition },
        first.familyCandidateKey,
        firstHash,
      ),
      /checkpoint-issued|capability/i,
    );
  } finally {
    value.close();
  }
});

test("candidate partition proof rejects v1 wire and cannot be resigned under an unknown issuer key", async () => {
  const value = await makeHarness(2);
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
      () => issuer.verify({ ...proof, schemaVersion: "1", proofVersion: "1" }, {
        binding: value.run.candidatePartitionBinding,
        release: {
          releaseProvenanceHash: value.run.candidatePartitionBinding.releaseProvenanceHash,
          releaseAuthorityRoot: binding.releaseAuthorityRoot,
          candidatePartitionProofIssuerKeyId: binding.candidatePartitionProofIssuerKeyId,
        },
      }),
      /version|schema/i,
    );
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
    assert.throws(
      () => issuer.verify(proof, {
        binding: {
          ...value.run.candidatePartitionBinding,
          nominationClosureRoot: h("spliced-nomination-root"),
          nominationClosureStorageHash: h("spliced-nomination-storage"),
        },
        release: {
          releaseProvenanceHash: value.run.candidatePartitionBinding.releaseProvenanceHash,
          releaseAuthorityRoot: binding.releaseAuthorityRoot,
          candidatePartitionProofIssuerKeyId: binding.candidatePartitionProofIssuerKeyId,
        },
      }),
      /binding|nomination|payload/i,
    );
    const retained = value.candidates.slice(0, 1);
    assert.throws(
      () => issuer.verify(proof, {
        binding: {
          ...value.run.candidatePartitionBinding,
          candidatePartitionRoot: candidatePartitionRoot(retained),
          recordCount: String(retained.length),
          candidateKeysRoot: candidatePartitionKeysRoot(retained.map(candidateValue => candidateValue.familyCandidateKey)),
          nominationClosureRoot: h("recomputed-a-only-nomination-root"),
          nominationClosureStorageHash: h("recomputed-a-only-nomination-storage"),
        },
        release: {
          releaseProvenanceHash: value.run.candidatePartitionBinding.releaseProvenanceHash,
          releaseAuthorityRoot: binding.releaseAuthorityRoot,
          candidatePartitionProofIssuerKeyId: binding.candidatePartitionProofIssuerKeyId,
        },
      }),
      /binding|payload|candidate|nomination/i,
    );
  } finally {
    value.close();
  }
});

test("run reopen rejects a self-consistent nomination closure outside the release-owned qualification map", async () => {
  const value = await makeHarness(1);
  try {
    const receipt = value.run.nominationClosure.receipts[0]!;
    const binding = value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding;
    value.durable.close();
    value.durable = createSqliteDurableStore(value.filename);
    value.partitionBootstrap = createCandidatePartitionBootstrap();
    value.checkpoint = new CheckpointStore(
      value.durable,
      value.source,
      value.probeCaller,
      value.promotionAuthority,
      value.authority,
      createCandidatePartitionProofIssuerFixture(binding, () => binding, [{
        sourcePlanIdentity: receipt.sourcePlanIdentity,
        sourcePlanLeafDigest: receipt.sourcePlanLeafDigest,
        nominationProgramRoot: h("release-owned-other-nomination-program"),
        nominationProgramProposalLeafDigest: receipt.nominationProgramProposalLeafDigest,
        qualificationLeafDigest: receipt.qualificationRoot,
      }]),
      value.sixStepArtifacts,
      value.partitionBootstrap,
    );
    await assert.rejects(
      () => value.checkpoint.loadRun(value.run.runId),
      /nomination qualification binding mismatch|qualification/i,
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
    const active = await value.checkpoint.loadActiveReady();
    assert.equal(active?.generationId, ready.generationId);
    assert.equal(active?.readyRecordHash, ready.readyRecordHash);
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
      value.sixStepArtifacts,
      value.partitionBootstrap,
    );
    const restartedActive = await value.checkpoint.loadActiveReady();
    assert.equal(restartedActive?.generationId, ready.generationId);
    assert.equal(restartedActive?.readyRecordHash, ready.readyRecordHash);
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
          "aloha/candidate-record/v2",
          encodeCanonicalBytes({ ...candidateValue, candidateSubjectHash: h("ready-manifest-replacement") }),
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
            replacementClosure.sourceExecutionSetStorageHash,
            replacementClosure.sourcePlanEvidenceStorageHash,
            replacementClosure.nominationClosureStorageHash,
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

test("30k Ready graph persists as exact chunks, survives fresh reopen, and opens a complete lease", async (t) => {
  const timings: Record<string, number> = {};
  let mark = Date.now();
  const value = await makeHarness(150, {
    behavior: { materialization: "verified", transitionCount: 200 },
    leaseTtlMs: 600_000,
  });
  timings.harness = Date.now() - mark;
  try {
    mark = Date.now();
    const ready = await activateReadyForHarness(value, timings);
    timings.promoteAndPersist = Date.now() - mark;
    assert.equal(ready.edgeCount, "30000");
    const catalogStorageHash = value.durable.readIndex("semantic/instance-catalog", ready.instanceCatalogRoot);
    const graphStorageHash = value.durable.readIndex("semantic/persisted-graph", ready.graphRoot);
    assert.ok(catalogStorageHash);
    assert.ok(graphStorageHash);
    const catalogManifestRecord = value.durable.readContent(catalogStorageHash);
    const graphManifestRecord = value.durable.readContent(graphStorageHash);
    assert.ok(catalogManifestRecord);
    assert.ok(graphManifestRecord);
    assert.equal(catalogManifestRecord.kind, "aloha/instance-catalog-manifest/v1");
    assert.equal(graphManifestRecord.kind, "aloha/persisted-graph-manifest/v1");
    assert.ok(graphManifestRecord.references.length > 1);
    for (const hash of [...catalogManifestRecord.references, ...graphManifestRecord.references]) {
      const chunk = value.durable.readContent(hash);
      assert.ok(chunk);
      assert.ok(chunk.bytes.byteLength <= 500_000);
      assert.deepEqual(chunk.references, []);
    }

    mark = Date.now();
    value.durable.close();
    value.durable = createSqliteDurableStore(value.filename);
    value.partitionBootstrap = createCandidatePartitionBootstrap();
    const binding = value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding;
    value.checkpoint = new CheckpointStore(
      value.durable,
      value.source,
      value.probeCaller,
      value.promotionAuthority,
      value.authority,
      createCandidatePartitionProofIssuerFixture(binding),
      value.sixStepArtifacts,
      value.partitionBootstrap,
    );
    timings.freshStoreReopen = Date.now() - mark;
    mark = Date.now();
    const active = await value.checkpoint.loadActiveReady();
    timings.loadActiveReady = Date.now() - mark;
    assert.equal(active?.readyRecordHash, ready.readyRecordHash);
    mark = Date.now();
    const closure = await value.checkpoint.loadReadyClosure(ready);
    timings.loadReadyClosure = Date.now() - mark;
    assert.equal(closure.graph.edges.length, 30_000);
    assert.equal(closure.graph.graphRoot, ready.graphRoot);
    const admission = { opaque: {} };
    let issued = 0;
    mark = Date.now();
    const lease = await GraphViewLeaseV1.open(
      admission,
      closure.graph,
      closure.instanceCatalog,
      { issueRouteHandle() { issued += 1; return { opaque: {} }; } },
      "checkpoint-30k-reopen",
      { assertViewAuthorityActive() {} },
      {
        async consumeServingAdmission(value) {
          if (value !== admission) throw new Error("unexpected admission");
          return {
            generationId: ready.generationId,
            readyRecordHash: ready.readyRecordHash,
            generationRefreshPolicyHash: ready.generationRefreshPolicyHash,
            cutoff: ready.cutoff,
            definitionCatalogRoot: ready.definitionCatalogRoot,
            instanceCatalogRoot: ready.instanceCatalogRoot,
            graphRoot: ready.graphRoot,
            releaseProvenanceHash: ready.releaseProvenanceHash,
            candidatePartitionProofStorageHash: ready.candidatePartitionProofStorageHash,
            nominationClosureRoot: ready.nominationClosureRoot,
            nominationClosureStorageHash: ready.nominationClosureStorageHash,
          };
        },
        async assertServingBindingCurrent() {},
      },
    );
    timings.openLease = Date.now() - mark;
    assert.equal(lease.edges.length, 30_000);
    assert.equal(issued, 30_000);
    lease.release();
  } finally {
    t.diagnostic(`30k stage timings ms ${JSON.stringify(timings)}`);
    value.close();
  }
});

test("ready Stage 1/2 evidence is one owner-issued handle over the original durable closure", async () => {
  const value = await makeHarness(1);
  try {
    const ready = await activateReadyForHarness(value);
    const firstClosure = await value.checkpoint.loadReadyClosure(ready);
    const firstCapability = firstClosure.stage12EvidenceCapability;
    const firstReader = value.checkpoint.readyStage12EvidenceReader;
    assert.equal((await value.checkpoint.loadReadyClosure(ready)).stage12EvidenceCapability, firstCapability);
    assert.deepEqual(firstReader.binding(firstCapability), {
      readyRecordHash: ready.readyRecordHash,
      generationId: ready.generationId,
      cutoff: ready.cutoff,
      definitionCatalogRoot: ready.definitionCatalogRoot,
      sourceCoverageRoot: ready.sourceCoverageRoot,
      candidatePartitionRoot: ready.candidatePartitionRoot,
      exactOutcomePartitionRoot: ready.exactOutcomePartitionRoot,
      verifiedMemoSetRoot: ready.verifiedMemoSetRoot,
      instanceCatalogRoot: ready.instanceCatalogRoot,
      graphRoot: ready.graphRoot,
      releaseProvenanceHash: ready.releaseProvenanceHash,
      promotionRevision: ready.promotionRevision,
    });
    const firstSnapshot = await firstReader.read(firstCapability);
    assert.deepEqual(await firstReader.verify(firstCapability, firstSnapshot), firstSnapshot);
    await assert.rejects(
      () => firstReader.verify(firstCapability, { ...firstSnapshot, runId: `${firstSnapshot.runId}-forged` }),
      /does not match checkpoint authority/,
    );
    assert.equal(firstSnapshot.candidates.length, 1);
    assert.equal(firstSnapshot.outcomes.length, 1);
    assert.equal(firstSnapshot.verifiedInstances.length, 1);
    assert.equal(firstSnapshot.verifiedInstances[0]!.outcome.kind, "verified");
    assert.equal(
      firstSnapshot.verifiedInstances[0]!.identityProof.proofHash,
      firstSnapshot.verifiedInstances[0]!.outcome.identityProof.proofHash,
    );
    assert.deepEqual(firstSnapshot.verifiedInstances[0]!.attestationOrigin, { kind: "fresh" });
    assert.equal(firstSnapshot.sourceCoverage.sourceCoverageRoot, ready.sourceCoverageRoot);
    assert.equal(firstSnapshot.instanceCatalog.instanceCatalogRoot, ready.instanceCatalogRoot);
    assert.equal(firstSnapshot.graph.graphRoot, ready.graphRoot);
    assert.equal(firstSnapshot.promotionLineage.promotionRevision, ready.promotionRevision);
    await assert.rejects(
      () => firstReader.read({ ...firstCapability }),
      /capability is not checkpoint-issued/,
    );
    assert.throws(
      () => assertCheckpointReadyStage12EvidenceReader({ ...firstReader }),
      /reader is not checkpoint-issued/,
    );

    value.durable.close();
    value.durable = createSqliteDurableStore(value.filename);
    value.partitionBootstrap = createCandidatePartitionBootstrap();
    const binding = value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding;
    value.checkpoint = new CheckpointStore(
      value.durable,
      value.source,
      value.probeCaller,
      value.promotionAuthority,
      value.authority,
      createCandidatePartitionProofIssuerFixture(binding),
      value.sixStepArtifacts,
      value.partitionBootstrap,
    );
    const restartedClosure = await value.checkpoint.loadReadyClosure(ready);
    const restartedCapability = restartedClosure.stage12EvidenceCapability;
    const restartedReader = value.checkpoint.readyStage12EvidenceReader;
    assert.notEqual(restartedCapability, firstCapability);
    await assert.rejects(() => restartedReader.read(firstCapability), /capability is not checkpoint-issued/);
    await assert.rejects(() => firstReader.read(restartedCapability), /capability is not checkpoint-issued/);
    const restartedSnapshot = await restartedReader.read(restartedCapability);
    assert.deepEqual(restartedSnapshot, firstSnapshot);

    const lease = value.durable.acquireWriterLease("checkpoint-test-stage12-cross-generation");
    try {
      value.durable.transaction(lease, tx => {
        const rootRecord = tx.readRoot();
        assert.ok(rootRecord);
        const root = CHECKPOINT_SCHEMA_AUTHORITY.decodeRoot(rootRecord.envelopeBytes);
        tx.compareAndSwapRoot(
          root.revision,
          encodeCanonicalBytes({
            ...root,
            revision: (BigInt(root.revision) + 1n).toString(),
            readyGenerationId: h("foreign-generation"),
          }),
          rootRecord.references,
        );
      });
    } finally {
      value.durable.releaseWriterLease(lease);
    }
    await assert.rejects(
      () => restartedReader.read(restartedCapability),
      /generation|pointer|binding|root/i,
    );
    await assert.rejects(
      () => value.checkpoint.readyFullFamilyEvidenceReader.read(restartedCapability),
      /generation|pointer|binding|root/i,
    );
  } finally {
    value.close();
  }
});

test("ready full-Family evidence rewalks the active durable closure with the Stage 1/2 handle", async () => {
  const value = await makeHarness(1, { candidateEvidence: "source-plan" });
  try {
    const ready = await activateReadyForHarness(value);
    const closureView = await value.checkpoint.loadReadyClosure(ready);
    const capability = closureView.stage12EvidenceCapability;
    const reader = value.checkpoint.readyFullFamilyEvidenceReader;
    assert.equal(assertCheckpointReadyFullFamilyEvidenceReader(reader), reader);

    const snapshot = await readCheckpointReadyFullFamilyEvidence(reader, capability);
    const stage12 = await value.checkpoint.readyStage12EvidenceReader.read(capability);
    assert.deepEqual(snapshot.ready, ready);
    assert.deepEqual(snapshot.stage12, stage12);
    assert.deepEqual(snapshot.nominationClosure, value.run.nominationClosure);
    assert.deepEqual(snapshot.sourceExecutionSet, value.run.sourceExecutionSet);
    assert.deepEqual(snapshot.sourcePlanEvidenceReceipts, value.run.sourcePlanEvidence);
    assert.deepEqual(
      snapshot.rawEvidenceLocatorContents.map(value => value.rawLocatorHash),
      value.run.sourcePlanEvidence.flatMap(value => value.rawLocatorHashes).sort(),
    );
    assert.equal(snapshot.nominationClosureStorageHash, ready.nominationClosureStorageHash);
    assert.equal(snapshot.candidatePartitionProofStorageHash, ready.candidatePartitionProofStorageHash);
    for (const storageHash of [
      snapshot.sourceCoverageStorageHash,
      snapshot.sourceExecutionSetStorageHash,
      snapshot.sourcePlanEvidenceStorageHash,
      snapshot.nominationClosureStorageHash,
      snapshot.candidatePartitionStorageHash,
      snapshot.candidatePartitionProofStorageHash,
    ]) assert.match(storageHash, /^0x[0-9a-f]{64}$/);

    await assert.rejects(
      () => reader.read({ ...capability }),
      /capability is not checkpoint-issued/,
    );
    assert.throws(
      () => assertCheckpointReadyFullFamilyEvidenceReader({ ...reader }),
      /reader is not checkpoint-issued/,
    );
    assert.throws(
      () => readCheckpointReadyFullFamilyEvidence({ ...reader }, capability),
      /reader is not checkpoint-issued/,
    );

    const lease = value.durable.acquireWriterLease("checkpoint-test-full-family-raw-splice");
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
        const sourceEvidenceRecord = tx.readContent(String(closure.sourcePlanEvidenceStorageHash) as Hash);
        assert.ok(sourceEvidenceRecord);
        const foreignRawHash = tx.putImmutable(
          "aloha/raw-evidence-locator/v1",
          encodeCanonicalBytes({ kind: "forged-source-evidence" }),
        );
        const replacementSourceEvidenceHash = tx.putImmutable(
          "aloha/source-plan-evidence/v1",
          sourceEvidenceRecord.bytes,
          [foreignRawHash],
        );
        const replacementClosure = {
          ...closure,
          sourcePlanEvidenceStorageHash: replacementSourceEvidenceHash,
        };
        const replacementClosureHash = tx.putImmutable(
          "aloha/ready-closure/v1",
          encodeCanonicalBytes(replacementClosure),
          [
            replacementClosure.sourceCoverageStorageHash,
            replacementClosure.sourceExecutionSetStorageHash,
            replacementClosure.sourcePlanEvidenceStorageHash,
            replacementClosure.nominationClosureStorageHash,
            replacementClosure.candidatePartitionStorageHash,
            replacementClosure.outcomePartitionStorageHash,
            replacementClosure.attestationPartitionStorageHash,
            replacementClosure.candidatePartitionCommitmentStorageHash,
            replacementClosure.candidatePartitionProofStorageHash,
            replacementClosure.verifiedMemoSetStorageHash,
            replacementClosure.instanceCatalogStorageHash,
            replacementClosure.graphStorageHash,
          ],
        );
        tx.compareAndSwapRoot(
          root.revision,
          encodeCanonicalBytes({ ...root, revision: (BigInt(root.revision) + 1n).toString() }),
          rootRecord.references.map(hash => hash === closureHash ? replacementClosureHash : hash),
        );
      });
    } finally {
      value.durable.releaseWriterLease(lease);
    }
    await assert.rejects(
      () => reader.read(capability),
      /source-plan evidence|raw locator|nomination closure|physical references|mismatch|corrupt/i,
    );
  } finally {
    value.close();
  }
});

test("ready reopen rechecks the durable nomination receipt against release-owned qualification", async () => {
  const value = await makeHarness(1);
  try {
    const ready = await activateReadyForHarness(value);
    const receipt = value.run.nominationClosure.receipts[0]!;
    const binding = value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding;
    value.durable.close();
    value.durable = createSqliteDurableStore(value.filename);
    value.partitionBootstrap = createCandidatePartitionBootstrap();
    value.checkpoint = new CheckpointStore(
      value.durable,
      value.source,
      value.probeCaller,
      value.promotionAuthority,
      value.authority,
      createCandidatePartitionProofIssuerFixture(binding, () => binding, [{
        sourcePlanIdentity: receipt.sourcePlanIdentity,
        sourcePlanLeafDigest: receipt.sourcePlanLeafDigest,
        nominationProgramRoot: h("release-owned-other-ready-program"),
        nominationProgramProposalLeafDigest: receipt.nominationProgramProposalLeafDigest,
        qualificationLeafDigest: receipt.qualificationRoot,
      }]),
      value.sixStepArtifacts,
      value.partitionBootstrap,
    );
    await assert.rejects(
      () => value.checkpoint.loadActiveReady(),
      /nomination qualification binding mismatch|qualification/i,
    );
    await assert.rejects(
      () => value.checkpoint.loadReadyClosure(ready),
      /nomination qualification binding mismatch|qualification/i,
    );
  } finally {
    value.close();
  }
});

test("ready restart rejects missing nomination/source-evidence or extra physical references", async () => {
  const mutateReferences = async (extra: boolean, missing: "nomination" | "source-evidence" = "nomination") => {
    const value = await makeHarness(1);
    try {
      const ready = await activateReadyForHarness(value);
      value.durable.close();
      value.durable = createSqliteDurableStore(value.filename);
      value.partitionBootstrap = createCandidatePartitionBootstrap();
      const binding = value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding;
      value.checkpoint = new CheckpointStore(
        value.durable,
        value.source,
        value.probeCaller,
        value.promotionAuthority,
        value.authority,
        createCandidatePartitionProofIssuerFixture(binding),
        value.sixStepArtifacts,
        value.partitionBootstrap,
      );
      const lease = value.durable.acquireWriterLease(`checkpoint-test-ready-nomination-ref-${extra ? "extra" : "missing"}`);
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
          const extraHash = extra
            ? tx.putImmutable("aloha/test-unowned-reference/v1", encodeCanonicalBytes({ extra: true }))
            : null;
          const references = extraHash === null
            ? closureRecord.references.filter(hash => hash !== (
              missing === "nomination"
                ? closure.nominationClosureStorageHash
                : closure.sourcePlanEvidenceStorageHash
            ))
            : [...closureRecord.references, extraHash];
          const replacementClosureHash = tx.putImmutable(
            "aloha/ready-closure/v1",
            closureRecord.bytes,
            references,
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
        /ready closure physical references|root-reference|not root-reachable|corrupt/i,
      );
    } finally {
      value.close();
    }
  };
  await mutateReferences(false, "nomination");
  await mutateReferences(false, "source-evidence");
  await mutateReferences(true);
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
    const first = await value.checkpoint.loadAttestationResumeCapabilities(value.run.runId);
    assert.equal(first.identity.length, 1);
    await assert.rejects(
      () => value.checkpoint.loadAttestationResumeCapabilities(value.run.runId),
      /already claimed|resume|capability/i,
    );
    first.claim.abort();
    const retried = await value.checkpoint.loadAttestationResumeCapabilities(value.run.runId);
    assert.equal(retried.identity.length, 1);
    retried.claim.commit();
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

test("contiguous-history cursor rejects forged predecessors atomically and survives durable-store reopen", async () => {
  const value = await makeHarness(1, { historySource: true });
  try {
    const ready = await activateReadyForHarness(value);
    const predecessor = await value.checkpoint.loadSourcePlanPredecessor(ready.generationId);
    assert.ok(predecessor);
    assert.equal(predecessor.sourceCoverage.cutoff.number, "49");
    assert.equal(predecessor.sourceExecutionSet.executions[0]!.execution.through, "49");

    const nextCutoff: CanonicalCutoffV1 = {
      chainId: "1",
      number: "50",
      hash: h("block:50"),
      stateRoot: h("state:50"),
    };
    const evidence = value.candidates.flatMap(candidateValue => candidateValue.evidence)
      .filter((item): item is RecentLogEvidenceRefV1 => item.kind === "recent-log");
    assert.equal(evidence.length, 0);
    const sourceEvidenceRefs = value.candidates.flatMap(candidateValue => candidateValue.evidence)
      .filter(item => item.kind === "source-plan");
    assert.equal(sourceEvidenceRefs.length, 1);
    const sourceLocator = rawLocator("source:0");
    const blocks: ObservedBlockV1[] = [];
    for (let number = 1; number <= 50; number += 1) {
      blocks.push({
        number: String(number),
        hash: number === 49 ? cutoff.hash : number === 50 ? nextCutoff.hash : h(`block:${number}`),
        parentHash: number === 50 ? cutoff.hash : h(`block:${number - 1}`),
        evidence: number === 49 ? evidence : [],
      });
    }
    const recentObservation = sealRecentObservation(
      nextCutoff,
      value.source.recentObservationRange(nextCutoff),
      blocks,
      [],
    );
    assert.equal(recentObservation.orderedHeaders.length, 50);

    const prior = predecessor.sourceExecutionSet.executions[0]!;
    const plan = prior.execution.plan;
    const sourcePlanEvidence = [{
      kind: "source-plan-evidence" as const,
      version: 1 as const,
      plan,
      cutoff: nextCutoff,
      refs: sourceEvidenceRefs,
      rawLocatorHashes: [sourceLocator.rawLocatorHash],
      evidenceRoot: sourcePlanEvidenceRoot({
        plan,
        cutoff: nextCutoff,
        refs: sourceEvidenceRefs,
        rawLocatorHashes: [sourceLocator.rawLocatorHash],
      }),
    }];
    const executionFor = (previousAppliedThrough: string, from: string) => {
      const withoutRoot = {
        kind: "source-plan-execution" as const,
        version: 1 as const,
        plan,
        cutoff: nextCutoff,
        outcome: "complete" as const,
        from,
        through: nextCutoff.number,
        previousAppliedThrough,
        resultPartitionRoot: h(`source-results:${previousAppliedThrough}:${from}`),
        opaqueResult: { kind: "test-source-result", value: "cumulative-through-50" } as const,
        sourceEvidenceRefs,
        rawLocatorHashes: [sourceLocator.rawLocatorHash],
        sourceEvidenceRoot: sourcePlanEvidence[0]!.evidenceRoot,
      };
      return { ...withoutRoot, executionRoot: sourcePlanExecutionRoot(withoutRoot) };
    };
    const validExecution = executionFor("49", "50");
    const validCoverage = sealSourceCoverage(nextCutoff, [plan], [validExecution]);
    const persistedFor = (
      execution: typeof validExecution,
      patch: Partial<Pick<typeof prior, "sourcePlanLeafDigest" | "sourceAuthorityRoot" | "previousExecutionRoot">> = {},
    ) => sealPersistedSourcePlanExecution({
      execution,
      sourcePlanLeafDigest: patch.sourcePlanLeafDigest ?? prior.sourcePlanLeafDigest,
      sourcePlanSchemaHash: prior.sourcePlanSchemaHash,
      sourcePlanClosureRoot: prior.sourcePlanClosureRoot,
      sourceAuthorityRoot: patch.sourceAuthorityRoot ?? prior.sourceAuthorityRoot,
      releaseBindingId: h("source-release-binding:50"),
      releaseProvenanceHash: h("source-release-provenance:50"),
      sourceAnchorRoot: h("source-anchor:50"),
      previousExecutionRoot: patch.previousExecutionRoot ?? prior.persistedExecutionRoot,
    });
    const rootBefore = await value.checkpoint.loadAndValidateRoot();
    assert.equal(rootBefore.inProgressRunId, null);
    const inputFor = (
      sourceCoverage: typeof validCoverage,
      sourceExecutionSet: ReturnType<typeof sealPersistedSourcePlanExecutionSet>,
    ) => {
      const persistedExecution = sourceExecutionSet.executions[0]!;
      const planIdentity = sourcePlanIdentity(plan);
      const claims = value.candidates.flatMap(candidateValue => candidateValue.evidence.map(evidenceRef => ({
        sourcePlanIdentity: planIdentity,
        familyCandidateKey: candidateValue.familyCandidateKey,
        instanceNominationKey: candidateValue.instanceNominationKey,
        evidenceRefHash: nominationEvidenceRefHash(evidenceRef),
      })));
      const receipt = sealQualifiedSourcePlanNominationReceiptV1({
        cutoff: nextCutoff,
        familyId: "family-a",
        familyDefinitionHash: h("definition"),
        sourcePlanIdentity: planIdentity,
        sourcePlanLeafDigest: persistedExecution.sourcePlanLeafDigest,
        nominationProgramRoot: h("nomination-program:50"),
        nominationProgramProposalLeafDigest: value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding.nominationQualificationSet.entries[0]!.proposalLeafDigest,
        qualificationRoot: value.approval.resolver.resolve(value.approval.capability).provenance.runtimeBinding.nominationQualificationSet.entries[0]!.qualificationLeafDigest,
        denominator: {
          kind: "complete-source-result",
          persistedExecutionRoot: persistedExecution.persistedExecutionRoot,
          resultPartitionRoot: persistedExecution.execution.resultPartitionRoot,
        },
        claims,
      });
      return {
        expectedRootRevision: rootBefore.revision,
        parentGenerationId: ready.generationId,
        cutoff: nextCutoff,
        recentObservation,
        sourcePlanEvidence,
        definitionCatalogRoot: h("definitions"),
        sourceCoverage,
        sourceExecutionSet,
        nominationClosure: sealNominationClosureV1({
          cutoff: nextCutoff,
          recentObservationRoot: recentObservation.observationRoot,
          sourceExecutionSetRoot: sourceExecutionSet.executionSetRoot,
          sourceCoverageRoot: sourceCoverage.sourceCoverageRoot,
          sourcePlanIdentities: [planIdentity],
          receipts: [receipt],
          candidates: value.candidates,
          candidatePartitionRoot: candidatePartitionRoot(value.candidates),
        }),
        candidates: value.candidates,
        recentRawEvidenceLocators: [],
        sourcePlanRawEvidenceLocators: [sourceLocator],
      };
    };

    const overlappingExecution = executionFor("48", "49");
    const invalidInputs = [
      inputFor(validCoverage, sealPersistedSourcePlanExecutionSet(nextCutoff, [
        persistedFor(validExecution, { previousExecutionRoot: h("forged-previous-execution") }),
      ])),
      inputFor(validCoverage, sealPersistedSourcePlanExecutionSet(nextCutoff, [
        persistedFor(validExecution, { sourcePlanLeafDigest: h("changed-source-plan-leaf") }),
      ])),
      inputFor(validCoverage, sealPersistedSourcePlanExecutionSet(nextCutoff, [
        persistedFor(validExecution, { sourceAuthorityRoot: h("changed-source-authority") }),
      ])),
      inputFor(
        sealSourceCoverage(nextCutoff, [plan], [overlappingExecution]),
        sealPersistedSourcePlanExecutionSet(nextCutoff, [persistedFor(overlappingExecution)]),
      ),
    ];
    for (const invalidInput of invalidInputs) {
      await assert.rejects(
        () => value.checkpoint.beginNewRunAndPersistPartition(invalidInput),
        /predecessor lineage mismatch/,
      );
      const unchanged = await value.checkpoint.loadAndValidateRoot();
      assert.equal(unchanged.revision, rootBefore.revision);
      assert.equal(unchanged.inProgressRunId, null);
      assert.equal(unchanged.readyGenerationId, ready.generationId);
    }

    const validExecutionSet = sealPersistedSourcePlanExecutionSet(nextCutoff, [persistedFor(validExecution)]);
    const run = await value.checkpoint.beginNewRunAndPersistPartition(inputFor(validCoverage, validExecutionSet));
    assert.equal(run.sourceExecutionSet.executionSetRoot, validExecutionSet.executionSetRoot);
    assert.equal(run.sourceExecutionSet.executions[0]!.previousExecutionRoot, prior.persistedExecutionRoot);

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
      value.sixStepArtifacts,
      value.partitionBootstrap,
    );
    const restarted = await value.checkpoint.loadRun(run.runId);
    assert.equal(restarted.sourceExecutionSet.executionSetRoot, validExecutionSet.executionSetRoot);
    assert.equal(restarted.sourceExecutionSet.executions[0]!.previousExecutionRoot, prior.persistedExecutionRoot);
  } finally {
    value.close();
  }
});

test("promoted Ready history survives SQLite reopen and drives only the real HTTP successor delta", async () => {
  const requests: Array<{ readonly method: string; readonly params: readonly CanonicalJson[] }> = [];
  const pair = `0x${"11".repeat(20)}`;
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      readonly id: string;
      readonly method: string;
      readonly params: readonly CanonicalJson[];
    };
    requests.push({ method: rpc.method, params: rpc.params });
    let result: CanonicalJson;
    if (rpc.method === "eth_chainId") {
      result = "0x1";
    } else if (rpc.method === "eth_getBlockByNumber") {
      const number = BigInt(String(rpc.params[0]));
      result = {
        number: `0x${number.toString(16)}`,
        hash: h(`block:${number}`),
        parentHash: h(`block:${number - 1n}`),
        stateRoot: number === 49n ? cutoff.stateRoot : h(`state:${number}`),
      };
    } else if (rpc.method === "eth_getLogs") {
      const filter = rpc.params[0] as Readonly<Record<string, CanonicalJson>>;
      result = filter.fromBlock === "0x0" && filter.toBlock === "0x31"
        ? [{
          address: `0x${"ff".repeat(20)}`,
          topics: [
            UNIV2_PAIR_CREATED_TOPIC0,
            `0x${"0".repeat(24)}${"22".repeat(20)}`,
            `0x${"0".repeat(24)}${"33".repeat(20)}`,
          ],
          data: `0x${"0".repeat(24)}${pair.slice(2)}${"1".padStart(64, "0")}`,
          blockNumber: "0x31",
          blockHash: h("block:49"),
          transactionHash: h("pair-created-tx"),
          transactionIndex: "0x0",
          logIndex: "0x0",
          removed: false,
        }]
        : [];
    } else {
      throw new Error(`unexpected RPC method ${rpc.method}`);
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("history integration RPC did not bind");
  const endpoint = `http://127.0.0.1:${address.port}`;
  let value: Harness | null = null;
  try {
    const plan = Object.freeze({
      ownerRef: h("real-history-owner"),
      sourcePlanRef: h("real-history-plan"),
      familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
      completeness: "contiguous-history" as const,
      historyStartBlock: "0",
    });
    const approval = releaseApproval(
      h("real-history-framework"),
      h("real-history-executor"),
      "real-history-epoch",
      h("real-history-session"),
      h("real-history-release"),
      h("real-history-capabilities"),
      endpoint,
    );
    const runtimeAuthority = runtimeAuthorityForReleaseApproval(approval);
    const releaseBinding = approval.resolver.resolve(approval.capability).provenance.runtimeBinding;
    const qualification = releaseBinding.nominationQualificationSet.entries[0]!;
    const qualifiedSource = readRuntimeReleaseQualifiedDiscoverySourcePort(
      runtimeAuthority,
      issueRuntimeReleaseQualifiedDiscoverySourcePort(runtimeAuthority, {
        profile: "reth-json-rpc-v1",
        endpoint,
        chainId: "1",
        providerIdentity: "reth-mainnet",
        backendEpoch: "reth-backend-1",
      }),
    );
    const binding: RuntimeReleaseSourcePlanBindingV1 = Object.freeze({
      familyId: UNIV2_STANDARD_FAMILY_ID,
      familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
      sourcePlanRef: plan,
      sourcePlanLeafDigest: h("real-history-leaf"),
      sourcePlanSchemaHash: UNIV2_STANDARD_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
      sourcePlanClosureRoot: h("real-history-closure"),
      runtime: UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME,
      nominationProgram: UNIV2_STANDARD_HISTORY_NOMINATION_PROGRAM,
      nominationProgramRoot: h("real-history-nomination-program"),
      nominationProgramProposalLeafDigest: qualification.proposalLeafDigest,
      nominationQualificationLeafDigest: qualification.qualificationLeafDigest,
    });
    const discoveryPort = (processEpoch: string) => createRuntimeReleaseDiscoveryPort({
      bindings: [binding],
      source: qualifiedSource,
      scheduler: new WorkScheduler(),
      release: {
        bindingId: qualifiedSource.release.bindingId,
        releaseProvenanceHash: qualifiedSource.release.releaseProvenanceHash,
        processEpoch,
      },
      assertCurrent() {},
    });
    const catalog = { definitionCatalogRoot: h("definitions"), declaredSourcePlans: [plan] };
    const firstPort = discoveryPort("real-history-initial-process");
    const firstSource = await firstPort.executeAllDeclaredPlans(catalog, cutoff, null, new AbortController().signal);
    const recentScan = await firstPort.scanRecentBlocks(cutoff, new AbortController().signal);
    const recentObservation = sealRecentObservation(
      cutoff,
      { from: "0", to: "49" },
      recentScan.blocks,
      recentScan.rawEvidenceLocators,
    );
    const firstCoverage = sealSourceCoverage(cutoff, [plan], firstSource.discovery.executions);
    const nominationCapability = await firstPort.nominateAll(
      catalog,
      cutoff,
      firstSource.discovery.executions,
      firstSource.discovery.evidence,
      firstSource.discovery.rawEvidenceLocators,
      recentObservation,
      recentScan.rawEvidenceLocators,
      firstSource.sourceExecutionSet,
      firstCoverage,
      new AbortController().signal,
    );
    const issuedNomination = firstPort.readIssuedNomination(nominationCapability);
    assert.equal(issuedNomination.candidates.length, 1);
    assert.equal(issuedNomination.candidates[0]!.instanceNominationKey, pair);

    const directory = mkdtempSync(join(tmpdir(), "aloha-ready-history-http-"));
    const filename = join(directory, "checkpoint.sqlite");
    const journalStore = new SQLiteCanonicalJournalStore(join(directory, "canonical-journal.sqlite"));
    const canonical = createCanonicalSource({
      async getLatestHeader() { return canonicalHead; },
      async getHeader(number) {
        return number === cutoff.number
          ? { kind: "found" as const, header: canonicalHead }
          : { kind: "unavailable" as const, failureCode: "not-indexed" };
      },
    }, { journalStore });
    await canonical.freezeView();
    const durable = createSqliteDurableStore(filename);
    const partitionBootstrap = createCandidatePartitionBootstrap();
    const service = makeAttestationService(
      undefined,
      "real-history",
      undefined,
      approval,
      candidatePartitionBootstrapReader(partitionBootstrap),
    );
    const promotionAuthority = createReadyPromotionAuthority(() => ({
      definitionCatalogRoot: h("definitions"),
      policy: promotionPolicy,
    }), readyBindingPortForReleaseApproval(approval));
    const probeCaller = {};
    const partitionProofIssuer = createCandidatePartitionProofIssuerFixture(releaseBinding);
    const sixStepArtifacts = checkpointSixStepArtifacts();
    const checkpoint = new CheckpointStore(
      durable,
      canonical,
      probeCaller,
      promotionAuthority,
      service.validationAuthority,
      partitionProofIssuer,
      sixStepArtifacts,
      partitionBootstrap,
    );
    const root = await checkpoint.loadAndValidateRoot();
    const run = await checkpoint.beginNewRunAndPersistPartition({
      expectedRootRevision: root.revision,
      parentGenerationId: root.readyGenerationId,
      cutoff,
      recentObservation,
      sourcePlanEvidence: firstSource.discovery.evidence,
      definitionCatalogRoot: h("definitions"),
      sourceCoverage: firstCoverage,
      sourceExecutionSet: firstSource.sourceExecutionSet,
      nominationClosure: issuedNomination.nominationClosure,
      candidates: issuedNomination.candidates,
      recentRawEvidenceLocators: recentScan.rawEvidenceLocators,
      sourcePlanRawEvidenceLocators: firstSource.discovery.rawEvidenceLocators,
    });
    value = {
      directory,
      filename,
      durable,
      journalStore,
      source: canonical,
      promotionAuthority,
      authority: service.validationAuthority,
      service,
      approval,
      partitionProofIssuer,
      sixStepArtifacts,
      partitionBootstrap,
      probeCaller,
      candidates: issuedNomination.candidates,
      run,
      recentRawEvidenceLocators: recentScan.rawEvidenceLocators,
      sourcePlanRawEvidenceLocators: firstSource.discovery.rawEvidenceLocators,
      checkpoint,
      armBeforeCommitFailure() {},
      armPostCommitCanonicalFailure() {},
      setCurrentProofBinding() {},
      close(this: Harness) {
        this.durable.close();
        journalStore.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
    const ready = await activateReadyForHarness(value);
    value.durable.close();
    value.durable = createSqliteDurableStore(filename);
    value.partitionBootstrap = createCandidatePartitionBootstrap();
    value.checkpoint = new CheckpointStore(
      value.durable,
      value.source,
      value.probeCaller,
      value.promotionAuthority,
      value.authority,
      value.partitionProofIssuer,
      value.sixStepArtifacts,
      value.partitionBootstrap,
    );
    const predecessor = await value.checkpoint.loadSourcePlanPredecessor(ready.generationId);
    assert.ok(predecessor);
    assert.equal(predecessor.sourceExecutionSet.executions[0]!.execution.through, "49");
    assert.deepEqual(
      predecessor.rawEvidenceLocators.map(locator => locator.rawLocatorHash),
      firstSource.discovery.rawEvidenceLocators.map(locator => locator.rawLocatorHash),
    );

    const successor = await discoveryPort("real-history-successor-process").executeAllDeclaredPlans(
      catalog,
      { chainId: "1", number: "50", hash: h("block:50"), stateRoot: h("state:50") },
      predecessor,
      new AbortController().signal,
    );
    assert.equal(successor.sourceExecutionSet.executions[0]!.execution.previousAppliedThrough, "49");
    assert.equal(successor.sourceExecutionSet.executions[0]!.execution.from, "50");
    assert.equal(
      successor.sourceExecutionSet.executions[0]!.previousExecutionRoot,
      predecessor.sourceExecutionSet.executions[0]!.persistedExecutionRoot,
    );
    const rangeFilters = requests
      .filter(item => item.method === "eth_getLogs")
      .map(item => item.params[0] as Readonly<Record<string, CanonicalJson>>)
      .filter(filter => Object.prototype.hasOwnProperty.call(filter, "fromBlock"));
    assert.deepEqual(rangeFilters, [{
      fromBlock: "0x0",
      toBlock: "0x31",
      topics: [UNIV2_PAIR_CREATED_TOPIC0],
    }, {
      fromBlock: "0x32",
      toBlock: "0x32",
      topics: [UNIV2_PAIR_CREATED_TOPIC0],
    }]);
  } finally {
    value?.close();
    server.close();
    await once(server, "close");
  }
});

test("verified memo retains a source-plan-only raw locator", async () => {
  const value = await makeHarness(1, { candidateEvidence: "source-plan" });
  try {
    const fixture = await openSession(value);
    await flushCapabilities(value, fixture, fixture.persistenceCapabilities);
    const partition = fixture.session.sealExactPartition([
      candidateFinalOutcomeHash(fixture.finalResults[0]!.outcome),
    ]);
    await value.checkpoint.sealAttestationPartition(value.run.runId, partition);

    const envelope = activeRunEnvelope(value);
    const memoRecord = value.durable.readContent(String(envelope.verifiedMemoSetStorageHash) as Hash);
    assert.ok(memoRecord);
    const memo = decodeCanonicalJson(memoRecord.bytes) as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(memo, "manifestRoot"), false);
    const expectedLocatorHash = rawLocator("source:0").rawLocatorHash;
    assert.equal(memo.retainedRawLocatorCount, "1");
    assert.equal(
      memo.retainedRawLocatorSequenceRoot,
      hashCanonicalPartition("aloha/verified-memo-raw-locator-sequence/v1", [expectedLocatorHash]),
    );
    const rawReferences = memoRecord.references.filter(reference => (
      value.durable.readContent(reference)?.payloadHash === expectedLocatorHash
    ));
    assert.equal(rawReferences.length, 1);

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
      value.sixStepArtifacts,
      value.partitionBootstrap,
    );
    await value.checkpoint.loadRun(value.run.runId);
  } finally {
    value.close();
  }
});

const runtimeRestartChildRole = process.env.ALOHA_RUNTIME_RESTART_CHILD_ROLE;

test("runtime restart child role", {
  skip: runtimeRestartChildRole !== "child-1" && runtimeRestartChildRole !== "child-2",
}, async () => {
  if (runtimeRestartChildRole !== "child-1" && runtimeRestartChildRole !== "child-2") {
    throw new Error("runtime restart child role was not selected");
  }
  const directory = process.env.ALOHA_RUNTIME_RESTART_DIRECTORY;
  const checkpointDirectory = process.env.ALOHA_RUNTIME_RESTART_CHECKPOINT_DIRECTORY ?? directory;
  const logPath = process.env.ALOHA_RUNTIME_RESTART_LOG_PATH;
  if (directory === undefined || checkpointDirectory === undefined || logPath === undefined) throw new Error("runtime restart child paths are missing");
  // This process is the runtime under test.  The node:test runner installs a
  // SIGTERM interrupter of its own; remove only those inherited test-runner
  // listeners before production installs its real process.once handler.
  if (runtimeRestartChildRole === "child-1") {
    for (const listener of process.listeners("SIGTERM")) process.removeListener("SIGTERM", listener);
  }
  await runRuntimeRestartChild(runtimeRestartChildRole, realpathSync(directory), realpathSync(logPath), realpathSync(checkpointDirectory));
});

test("real child SIGTERM drains FULL-sync checkpoint and fresh child reopens exact runtime facts", {
  skip: runtimeRestartChildRole === "child-1" || runtimeRestartChildRole === "child-2",
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-runtime-restart-child-"));
  const logPath = join(directory, "runtime.log");
  writeFileSync(logPath, new Uint8Array());
  let logFd = openSync(logPath, "a");
  try {
    await executeRuntimeRestartChildren({ directory, logPath, logFd });

    closeSync(logFd);
    logFd = -1;
    const productionEvidenceDatabasePath = join(directory, "production-evidence.sqlite");
    const material = await observeProductionRuntimeRestartFactsV1({
      processDatabase: observeRuntimeAcceptanceProcessDatabaseV1(productionEvidenceDatabasePath),
      performanceDatabase: observeProductionPerformanceDatabaseV1(productionEvidenceDatabasePath),
      checkpointDatabasePath: join(directory, "checkpoint.sqlite"),
      sink: restartObserverSink(join(directory, "observer-cas")),
    });
    const verdict = evaluateRuntimeRestartPredicate(material.facts);
    assert.equal(verdict.verdict, "pass", JSON.stringify(verdict.reasons));
    if (verdict.facts === null) throw new Error("runtime restart pass omitted decoded facts");
    assert.deepEqual({
      memoReused: verdict.facts.difference.memoReused.count,
      newCandidates: verdict.facts.difference.newCandidates.count,
      invalidatedDependencyClosure: verdict.facts.difference.invalidatedDependencyClosure.count,
      retryable: verdict.facts.difference.retryable.count,
      rejectionNotReused: verdict.facts.difference.rejectionNotReused.count,
      probeChanges: verdict.facts.singleTargetProbe.changedRunCandidateKeys.count,
      flushed: verdict.facts.sigtermRecovery.flushedOutcomes.count,
      recovered: verdict.facts.sigtermRecovery.afterRestartOutcomes.count,
    }, {
      memoReused: "1",
      newCandidates: "1",
      invalidatedDependencyClosure: "1",
      retryable: "1",
      rejectionNotReused: "1",
      probeChanges: "1",
      flushed: "4",
      recovered: "4",
    });
  } finally {
    if (logFd >= 0) closeSync(logFd);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fresh child cannot splice an identical copied checkpoint SQLite store into restart acceptance", {
  skip: runtimeRestartChildRole === "child-1" || runtimeRestartChildRole === "child-2",
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-runtime-restart-store-splice-"));
  const copiedDirectory = mkdtempSync(join(tmpdir(), "aloha-runtime-restart-store-copy-"));
  const logPath = join(directory, "runtime.log");
  writeFileSync(logPath, new Uint8Array());
  let logFd = openSync(logPath, "a");
  try {
    await executeRuntimeRestartChildren({
      directory,
      logPath,
      logFd,
      secondCheckpointDirectory: copiedDirectory,
      beforeSecondChild: () => copyRuntimeRestartSqliteStore(directory, copiedDirectory),
    });
    closeSync(logFd);
    logFd = -1;
    const productionEvidenceDatabasePath = join(directory, "production-evidence.sqlite");
    await assert.rejects(
      () => observeProductionRuntimeRestartFactsV1({
        processDatabase: observeRuntimeAcceptanceProcessDatabaseV1(productionEvidenceDatabasePath),
        performanceDatabase: observeProductionPerformanceDatabaseV1(productionEvidenceDatabasePath),
        checkpointDatabasePath: join(directory, "checkpoint.sqlite"),
        sink: restartObserverSink(join(directory, "observer-cas")),
      }),
      /same physical checkpoint SQLite store/,
    );
  } finally {
    if (logFd >= 0) closeSync(logFd);
    rmSync(directory, { recursive: true, force: true });
    rmSync(copiedDirectory, { recursive: true, force: true });
  }
});
