import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { decodeCanonicalJson, encodeCanonicalBytes, hashDomain, sha256Hex, type Hash } from "../../canonical-codec/src/index.ts";
import { erc20AssetPortBindingV1, erc20AssetReferenceV1 } from "../../asset-ref/src/index.ts";
import { encodeEconomicSafetyObjectiveTemplatesV1 } from "../../economics-safety/src/index.ts";
import {
  type AttestationCompositionBindingV1,
  type InstanceLifecycleSingleFlightPort,
  type RejectionTransportExecutorV1,
} from "../../attestation/src/index.ts";
import {
  createFrameworkFailureRuntime,
  createRejectionExecutorAuthorityIssuer,
  createRejectionFactRuntime,
} from "../../attestation/src/internal/composition.ts";
import {
  attestationProofPortForReleaseApproval,
  releaseApproval,
  runtimeAuthorityForReleaseApproval,
} from "../../attestation/test/authority-fixture.ts";
import { createCandidatePartitionProofIssuerFixture } from "../../checkpoint/test/candidate-partition-authority-fixture.ts";
import { createSqliteDurableStore } from "../../durable-store/src/index.ts";
import {
  WorkScheduler,
  createQualifiedExecutorRegistry,
  type QualifiedExecutorRegistryEntryV1,
} from "../../scheduler/src/index.ts";
import { issueQualifiedSharedSchedulerRuntimePort } from "../../scheduler/src/internal/shared-runtime-owner.ts";
import { createTestQualifiedExecutorAuthorityIssuer, testReleaseApprovalPort } from "../../scheduler/test/fixtures/qualified-release.ts";
import { QUALIFIED_EXECUTOR_AUTHORITY } from "../../scheduler/src/generated/qualified-executor-authority.ts";
import {
  decodeRuntimeReleaseQualifiedCapabilityProjectionV1,
  runtimeReleaseBindingProvenanceHash,
  sealRuntimeReleaseNominationQualificationSetV1,
  type RuntimeReleaseBindingV1,
} from "../../../specs/release-authority/src/index.ts";
import { decodeReleaseQualifiedCapabilitySetV1 } from "../../../specs/capability-index/src/index.ts";
import {
  buildRuntimeReleaseComposition,
  type RuntimeReleaseCompositionInputV1,
} from "../src/index.ts";
import { issueRevmWorkerDeploymentPort } from "../../../runtime/revm-workers/src/internal/authority.ts";
import { issueRuntimeReleaseRevmWorkerDeploymentPort } from "../src/internal/revm-worker-owner.ts";
import {
  issueRuntimeReleaseQualifiedDiscoverySourcePort,
  readRuntimeReleaseQualifiedDiscoverySourcePort,
} from "../src/internal/discovery-source-authority-owner.ts";
import { issueRuntimeReleaseEconomicSafetyEvaluatorCapabilityV1 } from "../src/internal/economic-safety-owner.ts";
import { readGeneratedEconomicValuationOwnerProposalRegistryV1 } from "../../../generated/valuation-owner-registry/index.ts";
import {
  issueQualifiedPhysicalExecutionPort,
} from "../../work-plane/src/internal/family-execution-port.ts";
import {
  readGeneratedFamilyRuntimeFactoryMetadata,
} from "../../family-composition/src/internal/generated-runtime-composition.ts";
import {
  createReleaseFamilyRuntimeComposition,
} from "../../../generated/runtime-composition/index.ts";
import {
  issueSearcherRuntimeApplicationOwnerV1,
} from "../../../apps/searcher-runtime/src/internal/application-owner.ts";
import { issueStartupSixStepRouteParentCapabilityV1 } from "../../startup-runtime/src/internal/six-step-route-parent-owner.ts";
import { issueProductionFullFamilyObservationPortV1 } from "../../full-family-observation-port/src/internal/owner.ts";
import { issueProductionSixStepObservationPortV1 } from "../../six-step-observation-port/src/internal/owner.ts";
import { issueProductionTerminalPhaseObservationPortV1 } from "../../terminal-phase-observation-port/src/internal/owner.ts";
import {
  assertProductionTerminalPhaseReleaseMetadataV1,
  ContentAddressedObserverSinkV1,
  ProductionTerminalPhaseLocatorIndexV1,
  decodeProductionTerminalPhaseLocatorV1,
  decodeProductionTerminalPhaseFullFamilyProjectionV1,
  decodeProductionTerminalPhaseManifestV1,
  issueProductionTerminalPhaseCollectorPortV1,
  observeFullFamilyReleaseArtifacts,
  observeProductionSixStep,
  readProductionTerminalPhaseCollectorResultV1,
} from "../../../acceptance/collectors/src/index.ts";
import {
  createRawTerminalSelectionObservationV1,
  createTerminalSelectionMissingFactV1,
  evaluateTerminalSelectionPredicate,
  TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS,
} from "../../../acceptance/terminal-selection-facts/src/runtime.ts";
import { evaluateTerminalSelectionReferenceModel } from "../../../acceptance/terminal-selection-facts/src/reference-model.ts";
import { TERMINAL_SELECTION_INVOCATION_SEAL_ROLE } from "../../../acceptance/terminal-selection-facts/src/spec.ts";
import { currentCatalogInput } from "../../../tools/catalog-generator/src/current-release.ts";
import { readFinalDurableWindowBindingV1 } from "../../final-durable-window/src/index.ts";
import { readReleaseOwnedObserverStoreV1 } from "../../../acceptance/collectors/src/internal/release-owned-observer-store.ts";
import {
  assertRuntimeReleaseObserverStoreOwnedByServiceV1,
  readRuntimeReleaseObserverStoreBindingV1,
  runtimeReleaseObserverStoreEpochV1,
  runtimeReleaseObserverStoreIdentityV1,
} from "../src/internal/observer-store-owner.ts";
import { createResolverPolicy } from "../../../specs/artifact-resolution/src/index.ts";
import { readRuntimeReleaseFullFamilyTerminalBindingV1 } from "../src/full-family-terminal-consumer.ts";
import {
  issueSearcherProductionEvidenceOwnerV1,
  SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES,
} from "../../../apps/searcher-runtime/src/production-evidence.ts";
import {
  createRethSearcherRuntimeSourceV1,
  type RethSearcherRuntimeSourceV1,
} from "../../../apps/searcher-runtime/src/internal/reth-source.ts";
import { issueQualifiedFinalSimulationPortFactoryV1 } from "../../final-sim/src/internal/final-simulation-owner.ts";
import {
  issueStartupRuntime,
  issueStartupRuntimeWithStage12Evidence,
} from "../../startup-runtime/src/internal/runtime-owner.ts";
import { registerCheckpointReadyFullFamilyEvidenceReader } from "../../checkpoint/src/internal/ready-full-family-evidence-issuer.ts";
import {
  createDeploymentPerformanceWindowBasisV1,
  createHardwareProfileObservationV1,
  createProductionPerformanceProfile,
  DEFAULT_PRODUCTION_PERFORMANCE_PROFILE,
  encodeDeploymentPerformanceWindowBasisV1,
  encodeHardwareProfileObservationV1,
  encodeProductionPerformanceProfile,
  PERFORMANCE_ELIGIBILITY_RULE_HASH,
  type DeploymentPerformanceWindowBasisV1,
} from "../../../specs/performance/src/index.ts";
import {
  issueRuntimeReleasePerformanceDeploymentPortFromExactBytesV1,
  readRuntimeReleasePerformanceDeploymentPortV1,
} from "../src/internal/performance-deployment-owner.ts";
import {
  issueInstalledRuntimeReleasePerformancePolicyPortV1,
  issuePreReleaseRuntimeReleasePerformancePolicyPortV1,
  readRuntimeReleasePerformancePolicyPortV1,
} from "../src/internal/performance-policy-owner.ts";
import {
  ProducerRuntimeV1,
  readIssuedProducerHeadFactsCapabilityV1,
  readIssuedProducerHeadTerminalCapabilityV1,
  readIssuedProducerLaneFactsV1,
  readIssuedProducerLaneSearchTerminalCapabilityV1,
  type CanonicalHead,
  type ProducerHeadFactsCapabilityV1,
  type ProducerHeadTerminalCapabilityV1,
} from "../../producer/src/index.ts";
import { readIssuedSearchTerminalCapabilityV1 } from "../../search-pipeline/src/index.ts";
import {
  issueProducerCurrentSourceHeadPortV1,
  issueProducerIngressPortV1,
  issueProducerLanePortV1,
  issueProducerPerformancePortV1,
  issueProducerSessionOwnerV1,
  issueProducerTerminalPortV1,
  readIssuedProducerBackrunIntakeV1,
} from "../../producer/src/internal/owners.ts";
import { issueProducerIngressSourceForTestV1 } from "../../producer/test/fixtures/ingress-source.ts";
import { createSearchTerminalFixture } from "../../producer/test/fixtures/search-terminal.ts";
import { observeProductionPerformanceDatabaseV1 } from "../../performance-collector/src/raw-sqlite-observer.ts";
import { issueFullGraphCoarseSweepInvocationCapabilityV1 } from "../../full-graph-coarse-sweep/src/internal/invocation-owner.ts";
import {
  decodeFullGraphCoarseSweepV1,
  encodeFullGraphCoarseSweepV1,
  type FullGraphCoarseSweepCapabilityV1,
  type FullGraphCoarseSweepV1,
} from "../../full-graph-coarse-sweep/src/index.ts";
import {
  readRuntimeReleaseFullGraphCoarseSweepEntryChunkV1,
  readRuntimeReleaseFullGraphCoarseSweepManifestV1,
} from "../src/full-graph-coarse-sweep-consumer.ts";

const h = (value: string): Hash => hashDomain("test/runtime-release-bootstrap", value);

function readFullGraphSweep(capability: FullGraphCoarseSweepCapabilityV1): FullGraphCoarseSweepV1 {
  const manifest = readRuntimeReleaseFullGraphCoarseSweepManifestV1(capability);
  const chunks = new Map<Hash, Uint8Array>();
  for (let ordinal = 0; ordinal < Number(manifest.entryChunkCount); ordinal += 1) {
    const bytes = encodeCanonicalBytes(readRuntimeReleaseFullGraphCoarseSweepEntryChunkV1(capability, String(ordinal)) as never);
    chunks.set(sha256Hex(bytes), bytes);
  }
  return decodeFullGraphCoarseSweepV1(encodeCanonicalBytes(manifest as never), ref => {
    const bytes = chunks.get(ref.contentSha256);
    if (bytes === undefined) throw new TypeError("test full-Graph chunk is missing");
    return bytes;
  });
}

function issueTestStartupLeaseV1<T extends object>(
  body: T,
  read: (orderedEdgeIds: readonly Hash[]) => Readonly<{
    readonly stage1: readonly object[];
    readonly stage2: readonly object[];
  }>,
): Readonly<T & { readonly sixStepRouteParents: object }> {
  const lease = { ...body, sixStepRouteParents: null as object | null };
  lease.sixStepRouteParents = issueStartupSixStepRouteParentCapabilityV1({
    lease,
    binding: (body as { readonly binding: never }).binding,
    readOwned: read,
  });
  return Object.freeze(lease) as Readonly<T & { readonly sixStepRouteParents: object }>;
}

function applicationObservationPorts(directory: string) {
  const calls = { fullFamily: 0, sixStep: 0, terminal: 0 };
  let lastFullFamilyResult: unknown = null;
  let lastTerminalBinding: ReturnType<typeof readRuntimeReleaseFullFamilyTerminalBindingV1> | null = null;
  let lastFinalWindow: ReturnType<typeof readFinalDurableWindowBindingV1> | null = null;
  const sink = new ContentAddressedObserverSinkV1({
    directory,
    storeIdentityHash: h("terminal-observer-store"),
    resolverPolicy: createResolverPolicy({
      schemaVersion: 1,
      kind: "aloha.artifact-resolver-policy",
      allowedLocatorKind: "content-object",
      digestAlgorithm: "sha256",
      maxByteLength: "10000000",
      requireExactLengthMediaAndSchema: true,
      minimumRemainingStoreEpochs: "0",
      failureOutcome: "invalid",
    }),
    lease: {
      validFromStoreEpoch: "1",
      validThroughStoreEpoch: "2",
      issuerId: "runtime-release-bootstrap-observer",
      issuerQualificationId: h("terminal-observer-qualification"),
      qualificationRegistryRoot: h("terminal-observer-registry"),
    },
  });
  const fullFamilyObservation = issueProductionFullFamilyObservationPortV1(async invocation => {
    calls.fullFamily += 1;
    const terminal = readRuntimeReleaseFullFamilyTerminalBindingV1(
      invocation.runtimeReleaseTerminalBindingCapability as never,
    );
    const sweep = readFullGraphSweep(
      invocation.fullGraphCoarseSweepCapability as never,
    );
    const releaseIntent = currentCatalogInput(
      fileURLToPath(new URL("../../..", import.meta.url)),
    ).releaseIntent;
    const release = observeFullFamilyReleaseArtifacts({
      releaseIntentCanonicalBytes: encodeCanonicalBytes(releaseIntent),
      familyCatalogSourceBytes: new Uint8Array(readFileSync(new URL("../../../generated/family-catalog/index.ts", import.meta.url))),
      runtimeCompositionSourceBytes: new Uint8Array(readFileSync(new URL("../../../generated/runtime-composition/index.ts", import.meta.url))),
      strategyCatalogSourceBytes: new Uint8Array(readFileSync(new URL("../../../generated/strategy-catalog/index.ts", import.meta.url))),
    });
    const terminalArtifact = await sink.write({
      bytes: encodeCanonicalBytes(terminal),
      mediaType: "application/json",
      schema: Object.freeze({
        id: "aloha.runtime-release-full-family-terminal-binding",
        version: "1.0.0",
        schemaHash: hashDomain("aloha/schema-definition/v1", {
          id: "aloha.runtime-release-full-family-terminal-binding",
          version: "1.0.0",
          descriptor: { owner: "runtime-release-authority", exactKind: "aloha.runtime-release-full-family-terminal-binding-v1" },
        }),
      }),
    });
    const encodedSweep = encodeFullGraphCoarseSweepV1(sweep);
    for (const chunk of encodedSweep.chunks) {
      await sink.write({
        bytes: chunk.bytes,
        mediaType: "application/json",
        schema: Object.freeze({
          id: "aloha.full-graph-coarse-sweep-entry-chunk",
          version: "1.0.0",
          schemaHash: hashDomain("aloha/schema-definition/v1", {
            id: "aloha.full-graph-coarse-sweep-entry-chunk",
            version: "1.0.0",
            descriptor: { owner: "runtime-release-authority", exactKind: "aloha.full-graph-coarse-sweep-entry-chunk-v1" },
          }),
        }),
      });
    }
    const sweepArtifact = await sink.write({
      bytes: encodedSweep.manifestBytes,
      mediaType: "application/json",
      schema: Object.freeze({
        id: "aloha.full-graph-coarse-sweep",
        version: "1.0.0",
        schemaHash: hashDomain("aloha/schema-definition/v1", {
          id: "aloha.full-graph-coarse-sweep",
          version: "1.0.0",
          descriptor: { owner: "runtime-release-authority", exactKind: "aloha.full-graph-coarse-sweep-manifest-v1" },
        }),
      }),
    });
    const result = Object.freeze({
      kind: "aloha.production-full-family-observation-missing-v1" as const,
      release,
      candidateReleaseCommit: terminal.candidateReleaseCommit,
      finalDurableWindowId: terminal.finalDurableWindowId,
      producerTerminalBindingRoot: terminal.producerTerminalBindingRoot,
      laneTerminalSetRoot: terminal.laneTerminalSetRoot,
      readyRecordHash: terminal.readyRecordHash,
      auditRoot: terminal.nativeAuditManifest.auditRoot,
      fullGraphCoarseSweepRoot: sweep.sweepRoot,
      actualCurrentSource: terminal.actualCurrentSource,
      actualCurrentSourceRoot: hashDomain(
        "aloha/production-full-family-actual-current-source/v1",
        terminal.actualCurrentSource,
      ),
      missing: Object.freeze([Object.freeze({
        code: "graph-transition-audit-denominator-incomplete" as const,
        subjectRoot: sweep.sweepRoot,
      })]),
      families: Object.freeze([]),
      observedArtifacts: Object.freeze([
        Object.freeze({ role: "runtime-release-full-family-terminal-binding", artifact: terminalArtifact }),
        Object.freeze({ role: "full-graph-coarse-sweep", artifact: sweepArtifact }),
      ]),
      bundle: null,
      bundleArtifact: null,
      locator: null,
      locatorArtifact: null,
    });
    lastTerminalBinding = terminal;
    lastFullFamilyResult = result;
    return result;
  });
  const sixStepObservation = issueProductionSixStepObservationPortV1(async invocation => {
    calls.sixStep += 1;
    return observeProductionSixStep({
      windowSelectionCapability: invocation.windowSelectionCapability as never,
      terminalBindingCapability: invocation.terminalBindingCapability as never,
      joinedProcessCapability: invocation.joinedProcessCapability as never,
      sink,
    });
  });
  const locatorIndex = new ProductionTerminalPhaseLocatorIndexV1({ directory: `${directory}.index`, sink });
  const terminalCollector = issueProductionTerminalPhaseCollectorPortV1({ sink, locatorIndex });
  const terminalPhaseObservation = issueProductionTerminalPhaseObservationPortV1(async invocation => {
    calls.terminal += 1;
    lastFinalWindow = readFinalDurableWindowBindingV1(invocation.finalDurableWindowCapability as never);
    const capability = await terminalCollector.seal(invocation);
    return readProductionTerminalPhaseCollectorResultV1(capability);
  });
  return Object.freeze({
    directory,
    locatorIndexDirectory: `${directory}.index`,
    sink,
    locatorIndex,
    calls: () => Object.freeze({ ...calls }),
    lastReleaseJoin() {
      if (lastFullFamilyResult === null || lastTerminalBinding === null || lastFinalWindow === null) {
        throw new TypeError("application observation release join is not complete");
      }
      return Object.freeze({
        result: lastFullFamilyResult,
        terminal: lastTerminalBinding,
        finalWindow: lastFinalWindow,
      });
    },
    fullFamilyObservation,
    sixStepObservation,
    terminalPhaseObservation,
  });
}
const selectedExecutor: QualifiedExecutorRegistryEntryV1 = Object.freeze({
  executorKind: "test-executor",
  engineBuildFingerprint: hashDomain("test/executor-engine", "v2"),
  executableFingerprint: hashDomain("test/executor-executable", "v2"),
  closureFingerprint: hashDomain("test/executor-closure", "v2"),
  protocolFingerprint: hashDomain("test/executor-protocol", "v2"),
  schemaFingerprint: hashDomain("test/executor-schema", "v2"),
  releaseRoleManifestRoot: hashDomain("test/release-role-manifest", "v2"),
  candidateCommit: "a".repeat(40),
});
const registry = createQualifiedExecutorRegistry(selectedExecutor);
const executorAuthorityRoot = hashDomain("aloha/qualified-executor-authority/v1", {
  registryRoot: registry.registryRoot,
  releaseBinding: {
    registryRoot: registry.registryRoot,
    releaseRoleManifestRoot: selectedExecutor.releaseRoleManifestRoot,
    candidateCommit: selectedExecutor.candidateCommit,
  },
});
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("cutoff"), stateRoot: h("state") });
const policy = Object.freeze({
  observationWindowBlocks: "50" as const,
  targetRefreshAgeBlocks: "20",
  maxServingAgeBlocks: "50",
  minPromotionMarginBlocks: "2",
  maxInProgressRuns: "1" as const,
});

function currentHardwareProfile() {
  const processors = cpus();
  return createHardwareProfileObservationV1({
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    availableParallelism: availableParallelism().toString(),
    logicalCpuCount: processors.length.toString(),
    cpuModelSetRoot: hashDomain("aloha/hardware-profile-cpu-model-set/v1", [...new Set(processors.map(cpu => cpu.model))].sort()),
    totalMemoryBytes: totalmem().toString(),
  });
}

function exact100Head(index: number, parentHash: Hash): CanonicalHead {
  return Object.freeze({
    chainId: "1",
    number: (101 + index).toString(),
    hash: h(`exact100-head-${index}`),
    parentHash,
    stateRoot: h(`exact100-state-${index}`),
  });
}

async function exact100IngressEnvelope(head: CanonicalHead) {
  const source = issueProducerIngressSourceForTestV1({
    async observe() {
      const snapshotBody = Object.freeze({
        pendingNumber: (BigInt(head.number) + 1n).toString(),
        parentHash: head.hash,
        orderedTransactionHashes: Object.freeze([]),
        orderedTransactionHashesRoot: hashDomain("aloha/public-pending-transaction-set/v1", []),
        transactionCount: "0",
      });
      const snapshot = Object.freeze({
        ...snapshotBody,
        snapshotHash: hashDomain("aloha/public-pending-snapshot/v1", { head, ...snapshotBody }),
      });
      return Object.freeze({
        head,
        blockscan: Object.freeze({ input: Object.freeze({ kind: "blockscan" }) }),
        backrun: Object.freeze({
          kind: "observed-empty" as const,
          snapshot,
          absenceEvidenceHash: hashDomain("aloha/public-pending-absence-evidence/v1", {
            head,
            snapshotHash: snapshot.snapshotHash,
          }),
        }),
      });
    },
  });
  const envelope = await issueProducerIngressPortV1(source).observe({
    head,
    signal: new AbortController().signal,
  });
  if (envelope === null) throw new TypeError("exact-100 ingress unexpectedly returned null");
  return envelope;
}

function rebuildDeploymentBasis(
  value: DeploymentPerformanceWindowBasisV1,
  patch: Partial<Omit<DeploymentPerformanceWindowBasisV1, "schemaVersion" | "kind" | "basisId">>,
): DeploymentPerformanceWindowBasisV1 {
  return createDeploymentPerformanceWindowBasisV1({
    bindingId: value.bindingId,
    releaseProvenanceHash: value.releaseProvenanceHash,
    candidateReleaseCommit: value.candidateReleaseCommit,
    performanceProfileHash: value.performanceProfileHash,
    eligibilityRuleHash: value.eligibilityRuleHash,
    targetCount: value.targetCount,
    providerRoot: value.providerRoot,
    hardwareProfileRoot: value.hardwareProfileRoot,
    commitContextBindingId: value.commitContextBindingId,
    commitAppendRecordId: value.commitAppendRecordId,
    ...patch,
  });
}

interface BootstrapFixture {
  readonly authority: ReturnType<typeof runtimeAuthorityForReleaseApproval>;
  readonly binding: RuntimeReleaseBindingV1;
  readonly input: RuntimeReleaseCompositionInputV1<BootstrapFact>;
  readonly performanceDeployment: ReturnType<typeof issueRuntimeReleasePerformanceDeploymentPortFromExactBytesV1>;
  readonly runtimeSource: RethSearcherRuntimeSourceV1;
  readonly setRuntimeHead: (head: CanonicalHead) => void;
  readonly runtimeRpcRequestCount: () => number;
  readonly close: () => Promise<void>;
}

interface BootstrapFact { readonly kind: "returned"; readonly requestId: Hash; readonly dataHex: string; }

function qualifiedCapabilityProjection(binding: RuntimeReleaseBindingV1) {
  const input = JSON.parse(readFileSync(new URL("../../../generated/catalog-generation.inputs.json", import.meta.url), "utf8")) as {
    readonly proposedCapabilitySet: unknown;
  };
  const set = decodeReleaseQualifiedCapabilitySetV1(input.proposedCapabilitySet);
  return decodeRuntimeReleaseQualifiedCapabilityProjectionV1({
    schemaVersion: 1,
    kind: "aloha.runtime-release-qualified-capability-projection",
    bindingId: binding.bindingId,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    qualifiedCapabilityRefsRoot: set.root,
    refs: set.refs,
  });
}

async function fixture(workerEpoch: string = "epoch-1"): Promise<BootstrapFixture> {
  const familyFactoryMetadata = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
  const nominationQualificationSet = sealRuntimeReleaseNominationQualificationSetV1(
    familyFactoryMetadata.nominationProgramProposalLeafDigests.map(proposalLeafDigest => ({
      proposalLeafDigest,
      criticalMutationCorpusRoot: h(`nomination-mutations:${proposalLeafDigest}`),
      independentOracleCaseRoot: h(`nomination-oracle:${proposalLeafDigest}`),
      qualificationSpecDigest: h(`nomination-spec:${proposalLeafDigest}`),
      verifierQualificationCertificateRoot: h(`nomination-certificate:${proposalLeafDigest}`),
    })),
  );
  const approval = releaseApproval(
    h("framework"),
    executorAuthorityRoot,
    workerEpoch,
    h("executor-session"),
    h("release-authority"),
    familyFactoryMetadata.proposedCapabilitySetRoot,
    "http://127.0.0.1:8545",
    nominationQualificationSet,
  );
  const authority = runtimeAuthorityForReleaseApproval(approval);
  const binding = authority.resolver.resolve(authority.capability);
  const schedulerIssuer = createTestQualifiedExecutorAuthorityIssuer(
    registry,
    testReleaseApprovalPort(registry, selectedExecutor.releaseRoleManifestRoot, selectedExecutor.candidateCommit),
    { workerEpoch: binding.workerEpoch, executorSessionHash: binding.executorSessionHash },
  );
  const schedulerCapability = schedulerIssuer.open({ worker: { workerEpoch: binding.workerEpoch, ...selectedExecutor } });
  const sharedScheduler = new WorkScheduler();
  const schedulerRuntime = issueQualifiedSharedSchedulerRuntimePort({
    scheduler: sharedScheduler,
    issuer: schedulerIssuer,
    capability: schedulerCapability,
  });
  const physicalExecution = issueQualifiedPhysicalExecutionPort<BootstrapFact>({
    issuer: schedulerIssuer,
    capability: schedulerCapability,
    schedulerRuntime,
    async execute() {
      return { kind: "returned", requestId: h("bootstrap-request"), dataHex: "0x" };
    },
  });
  const deploymentPort = issueRuntimeReleaseRevmWorkerDeploymentPort(
    authority,
    issueRevmWorkerDeploymentPort({
      factory: {
        async spawn() { throw new Error("bootstrap contract does not spawn a worker"); },
      },
      qualification: {
        engineBuildFingerprint: binding.selectedExecutor.engineBuildFingerprint,
        executableFingerprint: binding.selectedExecutor.executableFingerprint,
      },
      selectedExecutor,
      selectedExecutorLeafHash: binding.selectedExecutorLeafHash,
      qualifiedExecutorRegistryRoot: binding.qualifiedExecutorRegistryRoot,
    }),
  );
  const directory = mkdtempSync(join(tmpdir(), "aloha-runtime-release-bootstrap-"));
  const cutoffHeader: CanonicalHead = Object.freeze({ ...cutoff, parentHash: h("cutoff-parent") });
  let runtimeHead = cutoffHeader;
  let runtimeRpcRequestCount = 0;
  const runtimeHeaders = new Map<string, CanonicalHead>([[cutoffHeader.number, cutoffHeader]]);
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += String(chunk); });
    request.on("end", () => {
      runtimeRpcRequestCount += 1;
      const parsed = JSON.parse(body) as { readonly id: number; readonly method: string; readonly params?: readonly unknown[] };
      const blockTag = parsed.params?.[0];
      const numberedHead = typeof blockTag === "string" && blockTag !== "latest" && blockTag !== "pending"
        ? runtimeHeaders.get(BigInt(blockTag).toString())
        : runtimeHead;
      const result = parsed.method === "eth_chainId"
        ? "0x1"
        : parsed.method === "eth_getBlockByNumber" && blockTag === "pending"
          ? {
              number: `0x${(BigInt(runtimeHead.number) + 1n).toString(16)}`,
              parentHash: runtimeHead.hash,
              transactions: [],
            }
        : parsed.method === "eth_getBlockByNumber" && numberedHead !== undefined
          ? {
              number: `0x${BigInt(numberedHead.number).toString(16)}`,
              hash: numberedHead.hash,
              stateRoot: numberedHead.stateRoot,
              parentHash: numberedHead.parentHash,
            }
          : { number: "0x64", hash: cutoff.hash, stateRoot: cutoff.stateRoot, parentHash: cutoffHeader.parentHash };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const serverAddress = server.address();
  if (serverAddress === null || typeof serverAddress === "string") throw new Error("runtime-release Reth fixture did not bind");
  const endpoint = `http://127.0.0.1:${serverAddress.port}/`;
  const runtimeSource = createRethSearcherRuntimeSourceV1({
    canonical: {
      profile: "reth-json-rpc-v1",
      endpoint,
      chainId: "1",
      journalPath: join(directory, "canonical-journal.sqlite"),
      headPollIntervalMs: 5,
    },
    ingress: {
      profile: "reth-json-rpc-v1",
      endpoint,
      pending: "public-pending-v1",
      blockscan: {
        objective: (() => {
          const payload = {
            numeraireAssetRef: h("bootstrap-numeraire"),
            minNetGain: "1",
            maxGas: "1000000",
            maxValueAtRisk: "1",
          } as const;
          return { objectiveRef: hashDomain("aloha/search-objective/v1", payload), payload };
        })(),
        callerId: "runtime-release-bootstrap",
        deadlineMs: 5_000,
        admission: { topK: 1, boundedUnrankedBudget: 0 },
      },
    },
  });
  const canonical = runtimeSource.canonical;
  await canonical.freezeView();
  const durable = createSqliteDurableStore(join(directory, "checkpoint.sqlite"));
  const lifecycle: InstanceLifecycleSingleFlightPort = {
    async getOrBuild() { throw new Error("bootstrap contract does not build instances"); },
  };
  const qualifiedSource = issueRuntimeReleaseQualifiedDiscoverySourcePort(authority, {
    profile: "reth-json-rpc-v1",
    endpoint: "http://127.0.0.1:8545",
    chainId: "1",
    providerIdentity: "reth-mainnet",
    backendEpoch: "reth-backend-1",
  });
  const providerRoot = readRuntimeReleaseQualifiedDiscoverySourcePort(authority, qualifiedSource).sourceAuthorityRoot;
  const hardwareProfile = currentHardwareProfile();
  const performanceProfile = DEFAULT_PRODUCTION_PERFORMANCE_PROFILE;
  const deploymentBasis = createDeploymentPerformanceWindowBasisV1({
      bindingId: binding.bindingId,
      releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
      candidateReleaseCommit: binding.candidateReleaseCommit,
      performanceProfileHash: performanceProfile.profileHash,
      eligibilityRuleHash: PERFORMANCE_ELIGIBILITY_RULE_HASH,
      targetCount: "100",
      providerRoot,
      hardwareProfileRoot: hardwareProfile.profileRoot,
      commitContextBindingId: h("performance-context-binding"),
      commitAppendRecordId: h("performance-append-record"),
  });
  const performanceDeployment = issueRuntimeReleasePerformanceDeploymentPortFromExactBytesV1({
      authority,
      basisBytes: encodeDeploymentPerformanceWindowBasisV1(deploymentBasis),
      profileBytes: encodeProductionPerformanceProfile(performanceProfile),
      hardwareBytes: encodeHardwareProfileObservationV1(hardwareProfile),
    });
  const performance = Object.freeze({
    policy: issueInstalledRuntimeReleasePerformancePolicyPortV1({
      authority,
      deployment: performanceDeployment,
    }),
  });
  const input = {
    authority,
    catalog: {
      qualifiedCapabilityProjection: qualifiedCapabilityProjection(binding),
    },
    attestation: {
      proofPort: attestationProofPortForReleaseApproval(approval),
      build(composition: AttestationCompositionBindingV1) {
        const frameworkRuntime = createFrameworkFailureRuntime(composition, { classify() { return null; } });
        const rejectionIssuer = createRejectionExecutorAuthorityIssuer(composition);
        const executor: RejectionTransportExecutorV1 = {
          async execute() { return { transport: [], effects: [] }; },
        };
        return {
          frameworkRuntime,
          rejectionRuntime: createRejectionFactRuntime(rejectionIssuer.issue(executor)),
          instanceLifecycle: lifecycle,
        };
      },
    },
    candidatePartitionProofIssuer: createCandidatePartitionProofIssuerFixture(binding),
    checkpoint: { durable, canonical },
    scheduler: {
      issuer: schedulerIssuer,
      capability: schedulerCapability,
      physicalExecution,
      runtime: schedulerRuntime,
    },
    revm: {
      deploymentPort,
    },
    ready: {
      policy,
      monotonicNow: () => "1",
    },
    performance,
    finalSimulation: {
      endpoint,
      timeoutMs: 5_000,
      executorAddress: "0x0000000000000000000000000000000000000002",
      callerAddress: "0x0000000000000000000000000000000000000001",
      qualifiedExecutorCodeHash: h("bootstrap-executor-code"),
      executorConfig: {},
      accounts: [],
    },
    sixStep: {
      process: {
        systemId: "aloha-runtime-release-bootstrap/test.service",
        commitSha: binding.candidateReleaseCommit,
        executableHash: h("six-step-bootstrap-executable"),
        deploymentManifestHash: h("six-step-bootstrap-manifest"),
        serviceIdentityHash: h("six-step-bootstrap-service"),
        pid: String(process.pid),
        processStartTicks: "1",
        bootIdHash: h("six-step-bootstrap-boot"),
      },
      emitterCodeHash: h("six-step-bootstrap-emitter"),
      observerContentDirectory: join(directory, "six-step-observer-content"),
      evidenceDirectory: join(directory, "six-step-evidence"),
    },
    startup: {
      source: qualifiedSource,
      processEpoch: "bootstrap-process-epoch",
    },
  } satisfies RuntimeReleaseCompositionInputV1<BootstrapFact>;
  return {
    authority,
    binding,
    input,
    performanceDeployment,
    runtimeSource,
    setRuntimeHead(head) {
      runtimeHead = Object.freeze({ ...head });
      runtimeHeaders.set(runtimeHead.number, runtimeHead);
    },
    runtimeRpcRequestCount: () => runtimeRpcRequestCount,
    async close() {
      durable.close();
      runtimeSource.close();
      server.close();
      await once(server, "close");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("generated scheduler authority remains fail-closed until deployment composition", () => {
  assert.equal(QUALIFIED_EXECUTOR_AUTHORITY, null);
});

test("runtime-release bootstrap rejects an objective outside its selected valuation-owner coverage", async () => {
  const value = await fixture();
  try {
    const valuationOwnerRef = readGeneratedEconomicValuationOwnerProposalRegistryV1().entries[0]!.ownerRef;
    const unsupportedProfitAsset = erc20AssetReferenceV1("1", "0x0000000000000000000000000000000000000001");
    assert.throws(
      () => issueRuntimeReleaseEconomicSafetyEvaluatorCapabilityV1(
        value.authority,
        encodeEconomicSafetyObjectiveTemplatesV1([Object.freeze({
          objectiveRef: h("unsupported-profit-objective"),
          profitAsset: unsupportedProfitAsset,
          profitAccount: "0x0000000000000000000000000000000000000001",
          minNetGain: "1",
          maxGas: "1000000",
          maxValueAtRisk: "1000000",
          priorityFeePerGas: "0",
          bidCostNative: "0",
          valuationOwnerRef,
        })]),
      ),
      /does not uniquely cover the selected profit asset/,
    );
  } finally {
    await value.close();
  }
});

test("performance deployment port is exact-byte, process-local, release-bound, and rotation-fenced", async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const port = first.performanceDeployment;
    const facts = readRuntimeReleasePerformanceDeploymentPortV1(first.authority, port);
    assert.equal(facts.deploymentBasis.bindingId, first.binding.bindingId);
    assert.throws(
      () => readRuntimeReleasePerformanceDeploymentPortV1(first.authority, { ...port }),
      /foreign, cloned, or stale/,
    );
    assert.throws(
      () => readRuntimeReleasePerformanceDeploymentPortV1(second.authority, port),
      /foreign, cloned, or stale/,
    );

    const basisBytes = encodeDeploymentPerformanceWindowBasisV1(facts.deploymentBasis);
    const profileBytes = encodeProductionPerformanceProfile(facts.performanceProfile);
    const hardwareBytes = encodeHardwareProfileObservationV1(facts.hardwareProfile);
    for (const [name, bytes] of [
      ["basis", basisBytes],
      ["profile", profileBytes],
      ["hardware", hardwareBytes],
    ] as const) {
      const nonCanonical = new Uint8Array(bytes.byteLength + 1);
      nonCanonical.set(bytes);
      nonCanonical[bytes.byteLength] = 0x0a;
      assert.throws(
        () => issueRuntimeReleasePerformanceDeploymentPortFromExactBytesV1({
          authority: first.authority,
          basisBytes: name === "basis" ? nonCanonical : basisBytes,
          profileBytes: name === "profile" ? nonCanonical : profileBytes,
          hardwareBytes: name === "hardware" ? nonCanonical : hardwareBytes,
        }),
        /canonical|exact|JSON/,
        `${name} accepted non-canonical bytes`,
      );
    }

    first.authority.rotate(first.binding);
    assert.throws(
      () => readRuntimeReleasePerformanceDeploymentPortV1(first.authority, port),
      /foreign, cloned, or stale/,
    );
  } finally {
    await first.close();
    await second.close();
  }
});

test("performance deployment rejects self-consistent release mutations and raw bootstrap seams", async () => {
  const value = await fixture();
  try {
    const facts = readRuntimeReleasePerformanceDeploymentPortV1(
      value.authority,
      value.performanceDeployment,
    );
    const profileBytes = encodeProductionPerformanceProfile(facts.performanceProfile);
    const hardwareBytes = encodeHardwareProfileObservationV1(facts.hardwareProfile);
    const mutations = [
      ["bindingId", h("foreign-performance-binding")],
      ["releaseProvenanceHash", h("foreign-performance-provenance")],
      ["candidateReleaseCommit", "b".repeat(40)],
      ["performanceProfileHash", h("foreign-performance-profile")],
      ["eligibilityRuleHash", h("foreign-performance-eligibility")],
      ["providerRoot", h("foreign-performance-provider")],
      ["hardwareProfileRoot", h("foreign-performance-hardware")],
    ] as const;
    for (const [field, replacement] of mutations) {
      const basis = rebuildDeploymentBasis(facts.deploymentBasis, { [field]: replacement });
      assert.throws(
        () => issueRuntimeReleasePerformanceDeploymentPortFromExactBytesV1({
          authority: value.authority,
          basisBytes: encodeDeploymentPerformanceWindowBasisV1(basis),
          profileBytes,
          hardwareBytes,
        }),
        /do not match the signed release/,
        `${field} mutation escaped the deployment join`,
      );
    }

    const alteredProfile = createProductionPerformanceProfile({
      version: "1.0.1",
      targetCount: facts.performanceProfile.targetCount,
      percentileAlgorithm: facts.performanceProfile.percentileAlgorithm,
      percentiles: [...facts.performanceProfile.percentiles],
      budgets: { ...facts.performanceProfile.budgets },
      queueProfile: { ...facts.performanceProfile.queueProfile },
      requireSixStepDryRunCandidate: facts.performanceProfile.requireSixStepDryRunCandidate,
    });
    assert.throws(
      () => issueRuntimeReleasePerformanceDeploymentPortFromExactBytesV1({
        authority: value.authority,
        basisBytes: encodeDeploymentPerformanceWindowBasisV1(facts.deploymentBasis),
        profileBytes: encodeProductionPerformanceProfile(alteredProfile),
        hardwareBytes,
      }),
      /do not match the signed release/,
    );

    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...value.input,
        performance: {
          ...value.input.performance,
          deploymentBasis: facts.deploymentBasis,
          performanceProfile: facts.performanceProfile,
          hardwareProfile: facts.hardwareProfile,
        },
      } as never),
      /performance input has non-exact fields/,
    );
  } finally {
    await value.close();
  }
});

test("pre-release performance policy is source-owner-bound and rejects clones and unpinned bytes", async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const profileBytes = encodeProductionPerformanceProfile(DEFAULT_PRODUCTION_PERFORMANCE_PROFILE);
    const policy = issuePreReleaseRuntimeReleasePerformancePolicyPortV1({
      authority: first.authority,
      performanceProfileBytes: profileBytes,
      qualifiedSource: first.input.startup.source,
    });
    const facts = readRuntimeReleasePerformancePolicyPortV1(first.authority, policy);
    assert.equal(facts.performanceProfile.profileHash, DEFAULT_PRODUCTION_PERFORMANCE_PROFILE.profileHash);
    assert.throws(
      () => readRuntimeReleasePerformancePolicyPortV1(first.authority, { ...policy }),
      /foreign, cloned, or stale/,
    );
    assert.throws(
      () => issuePreReleaseRuntimeReleasePerformancePolicyPortV1({
        authority: first.authority,
        performanceProfileBytes: profileBytes,
        qualifiedSource: second.input.startup.source,
      }),
      /not issued by this authority|not owner-issued|foreign|stale/,
    );
    const nonCanonical = new Uint8Array(profileBytes.byteLength + 1);
    nonCanonical.set(profileBytes);
    nonCanonical[profileBytes.byteLength] = 0x0a;
    assert.throws(
      () => issuePreReleaseRuntimeReleasePerformancePolicyPortV1({
        authority: first.authority,
        performanceProfileBytes: nonCanonical,
        qualifiedSource: first.input.startup.source,
      }),
      /canonical|exact|JSON/,
    );
  } finally {
    await first.close();
    await second.close();
  }
});

test("performance runtime rejects a canonically packaged profile for different physical hardware", async () => {
  const value = await fixture();
  try {
    const facts = readRuntimeReleasePerformanceDeploymentPortV1(
      value.authority,
      value.performanceDeployment,
    );
    const foreignHardware = createHardwareProfileObservationV1({
      platform: facts.hardwareProfile.platform,
      architecture: facts.hardwareProfile.architecture,
      nodeVersion: facts.hardwareProfile.nodeVersion,
      availableParallelism: facts.hardwareProfile.availableParallelism,
      logicalCpuCount: facts.hardwareProfile.logicalCpuCount,
      cpuModelSetRoot: h("foreign-hardware-cpu-models"),
      totalMemoryBytes: facts.hardwareProfile.totalMemoryBytes,
    });
    const foreignBasis = rebuildDeploymentBasis(facts.deploymentBasis, {
      hardwareProfileRoot: foreignHardware.profileRoot,
    });
    const deployment = issueRuntimeReleasePerformanceDeploymentPortFromExactBytesV1({
      authority: value.authority,
      basisBytes: encodeDeploymentPerformanceWindowBasisV1(foreignBasis),
      profileBytes: encodeProductionPerformanceProfile(facts.performanceProfile),
      hardwareBytes: encodeHardwareProfileObservationV1(foreignHardware),
    });
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...value.input,
        performance: {
          policy: issueInstalledRuntimeReleasePerformancePolicyPortV1({
            authority: value.authority,
            deployment,
          }),
        },
      }),
      /current hardware does not match the deployment-qualified hardware profile/,
    );
  } finally {
    await value.close();
  }
});

test("bootstrap rejects removed caller-provided attestation and physical-discovery seams", async () => {
  const value = await fixture();
  try {
    const startup = {
      ...value.input.startup,
      attestation: {
        async attestAndPersistDifference() {
          throw new Error("caller-provided attestation must never run");
        },
      },
    };
    assert.throws(
      () => buildRuntimeReleaseComposition({ ...value.input, startup } as never),
      /startup input has non-exact fields/,
    );
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...value.input,
        startup: {
          ...value.input.startup,
          physicalDiscovery: { async request() { return { forged: true }; } },
        },
      } as never),
      /startup input has non-exact fields/,
    );
  } finally {
    await value.close();
  }
});

test("bootstrap composes real release-bound owners and returns no authority surface", async () => {
  const value = await fixture();
  try {
    const services = buildRuntimeReleaseComposition(value.input);
    assert.equal(services.release.releaseAuthorityRoot, value.binding.releaseAuthorityRoot);
    assert.equal("bindPromotion" in services.startup, false);
    assert.equal("promote" in services.startup, false);
    assert.equal("findLatestReusable" in services.startup, false);
    assert.equal("ready" in services, false);
    assert.equal("startStartup" in services, false);
    assert.deepEqual(Object.keys(services).sort(), ["attestation", "catalog", "checkpoint", "economicSafety", "familyExecution", "familyRuntime", "finalSimulationFactory", "fullFamilyTerminalBinding", "fullGraphCoarseSweep", "observerStore", "performance", "release", "revmPool", "sixStepTerminalBinding", "startup", "strategyRuntime"]);
    assert.deepEqual(Object.keys(services.observerStore), ["issueObserverStore"]);
    assert.deepEqual(Object.keys(services.fullFamilyTerminalBinding), ["bindFinalHead"]);
    assert.equal("read" in services.fullFamilyTerminalBinding, false);
    assert.deepEqual(Object.keys(services.fullGraphCoarseSweep), ["run"]);
    assert.equal("read" in services.fullGraphCoarseSweep, false);
    const catalog = services.catalog.loadExact();
    assert.equal(catalog.bindingId, value.binding.bindingId);
    assert.equal(catalog.releaseProvenanceHash, runtimeReleaseBindingProvenanceHash(value.binding));
    assert.equal(catalog.qualifiedCapabilityRefsRoot, value.binding.qualifiedCapabilityRefsRoot);
    assert.equal(catalog.qualifiedCapabilityRefs.length > 0, true);
    const familyComposition = services.familyRuntime.openComposition();
    const generatedFamilyMetadata = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
    assert.equal(familyComposition.entries.length, generatedFamilyMetadata.families.length);
    assert.equal("deploymentPort" in services.familyRuntime, false);
    assert.equal("authorities" in services.familyRuntime, false);
    for (const key of ["authority", "resolver", "issuer", "signer", "rotate", "revoke", "capability"]) {
      assert.equal(key in services, false, `composition leaked ${key}`);
    }
    assert.equal("validationAuthority" in services.attestation, false);
    assert.equal("issuer" in services.familyExecution, false);
    assert.equal("authority" in services.revmPool, false);
  } finally {
    await value.close();
  }
});

test("predicate observer store is derived from the signed release and rejects cross-release splice", async () => {
  const first = await fixture();
  const second = await fixture("epoch-observer-store-second-release");
  const directory = mkdtempSync(join(tmpdir(), "aloha-release-owned-observer-store-"));
  const secondDirectory = mkdtempSync(join(tmpdir(), "aloha-release-owned-observer-store-foreign-"));
  try {
    const firstServices = buildRuntimeReleaseComposition(first.input);
    const secondServices = buildRuntimeReleaseComposition(second.input);
    const observerStore = firstServices.observerStore.issueObserverStore({
      directory,
    });
    const state = readReleaseOwnedObserverStoreV1(observerStore);
    assert.equal(state.observedStoreEpoch, runtimeReleaseObserverStoreEpochV1(first.binding.bindingId));
    assert.equal(state.storeAuthorityRoot, runtimeReleaseObserverStoreIdentityV1(first.binding, directory));
    const markerPath = join(directory, ".aloha-observer-store-identity-v1");
    assert.equal(
      existsSync(markerPath),
      false,
      "capability issuance must not be confused with the sink's first durable publication",
    );
    const controlSchema = Object.freeze({
      id: "aloha.test.runtime-release-observer-store-control",
      version: "1.0.0",
      schemaHash: h("runtime-release-observer-store-control-schema"),
    });
    const controlArtifact = await state.sink.write({
      bytes: encodeCanonicalBytes(Object.freeze({
        kind: "aloha.test.runtime-release-observer-store-control-v1",
        bindingId: first.binding.bindingId,
      })),
      mediaType: "application/json",
      schema: controlSchema,
    });
    assert.equal(controlArtifact.lease.storeIdentityHash, state.storeAuthorityRoot);
    assert.equal(
      readFileSync(markerPath, "utf8"),
      `${runtimeReleaseObserverStoreIdentityV1(first.binding, directory)}\n`,
    );
    assert.equal(state.authority.bindingId, first.binding.bindingId);
    assert.equal(state.authority.candidateReleaseCommit, first.binding.candidateReleaseCommit);
    assert.equal(state.authority.releaseAuthorityApprovalId, first.binding.releaseAuthorityApprovalId);
    assert.equal(state.authority.qualificationRegistryRoot, first.binding.qualificationRegistryRoot);
    assert.equal(state.authority.releaseRoleManifestRoot, first.binding.releaseRoleManifestRoot);
    assert.equal(state.authority.predicateCompositionRootDigest, first.binding.predicateCompositionRootDigest);
    assert.throws(
      () => assertRuntimeReleaseObserverStoreOwnedByServiceV1(
        secondServices.observerStore,
        observerStore,
      ),
      /another or stale release/,
    );
    assert.doesNotThrow(() => assertRuntimeReleaseObserverStoreOwnedByServiceV1(
      firstServices.observerStore,
      observerStore,
    ));
    const crossReleaseStore = secondServices.observerStore.issueObserverStore({ directory });
    const crossReleaseState = readReleaseOwnedObserverStoreV1(crossReleaseStore);
    await assert.rejects(
      crossReleaseState.sink.write({
        bytes: encodeCanonicalBytes(Object.freeze({
          kind: "aloha.test.runtime-release-observer-store-control-v1",
          bindingId: second.binding.bindingId,
        })),
        mediaType: "application/json",
        schema: controlSchema,
      }),
      /physical store identity mismatch/,
      "another signed release must not materialize over the first release's store",
    );
    const physicalMutationStore = secondServices.observerStore.issueObserverStore({
      directory: secondDirectory,
    });
    const physicalMutationState = readReleaseOwnedObserverStoreV1(physicalMutationStore);
    await physicalMutationState.sink.write({
      bytes: encodeCanonicalBytes(Object.freeze({
        kind: "aloha.test.runtime-release-observer-store-physical-mutation-v1",
        bindingId: second.binding.bindingId,
      })),
      mediaType: "application/json",
      schema: controlSchema,
    });
    renameSync(
      join(secondDirectory, ".aloha-observer-store-identity-v1"),
      markerPath,
    );
    await assert.rejects(
      state.sink.write({
        bytes: encodeCanonicalBytes(Object.freeze({
          kind: "aloha.test.runtime-release-observer-store-after-mutation-v1",
          bindingId: first.binding.bindingId,
        })),
        mediaType: "application/json",
        schema: controlSchema,
      }),
      /store identity marker changed|physical store identity mismatch/,
      "a cross-release physical marker replacement must invalidate the original sink",
    );
    assert.throws(
      () => readRuntimeReleaseObserverStoreBindingV1({ ...firstServices.observerStore }),
      /not issued/,
    );
    let getterExecuted = false;
    const accessorInput = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorInput, "directory", {
      enumerable: true,
      get() { getterExecuted = true; return directory; },
    });
    assert.throws(
      () => firstServices.observerStore.issueObserverStore(accessorInput as never),
      /data property|accessor/i,
    );
    assert.equal(getterExecuted, false);
    assert.throws(
      () => firstServices.observerStore.issueObserverStore({
        directory,
        candidateReleaseCommit: "f".repeat(40),
      } as never),
      /unknown field/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(secondDirectory, { recursive: true, force: true });
    await first.close();
    await second.close();
  }
});

test("release-owned full-Graph sweep preserves all 2x2 missing transitions and rejects clone/replay/rotation", async () => {
  const value = await fixture();
  try {
    const services = buildRuntimeReleaseComposition(value.input);
    const source = value.runtimeSource;
    const family = services.familyRuntime.openComposition().entries[0]!;
    const rehydrationRef = Object.freeze({
      familyDefinitionHash: family.familyDefinitionHash,
      instanceKey: "full-graph-sweep-instance",
      instancePublicationHash: h("full-graph-sweep-publication"),
      staticProjectionMemoHash: h("full-graph-sweep-static-memo"),
      requestedArtifactDependencyRoot: h("full-graph-sweep-dependencies"),
    });
    const edgeBody = Object.freeze({
      inputAssetPorts: Object.freeze([]),
      outputAssetPorts: Object.freeze([]),
      opaqueTransitionRef: h("full-graph-sweep-transition"),
      constraintRefs: Object.freeze([]),
      owningFamilyId: family.familyId,
      owningFamilyDefinitionHash: family.familyDefinitionHash,
      owningInstanceKey: rehydrationRef.instanceKey,
      instancePublicationHash: rehydrationRef.instancePublicationHash,
      staticProjectionHash: h("full-graph-sweep-static-projection"),
      projectionHash: h("full-graph-sweep-projection"),
      rehydrationRef,
    });
    const inputAsset = erc20AssetPortBindingV1("1", "0x1111111111111111111111111111111111111111");
    const outputAsset = erc20AssetPortBindingV1("1", "0x2222222222222222222222222222222222222222");
    const unknownFamilyEdgeBody = Object.freeze({
      ...edgeBody,
      inputAssetPorts: Object.freeze([
        { ...inputAsset, portRef: h("full-graph-unknown-input-port-0"), ordinal: "0" },
        { ...inputAsset, portRef: h("full-graph-unknown-input-port-1"), ordinal: "1" },
      ]),
      outputAssetPorts: Object.freeze([
        { ...outputAsset, portRef: h("full-graph-unknown-output-port-0"), ordinal: "0" },
        { ...outputAsset, portRef: h("full-graph-unknown-output-port-1"), ordinal: "1" },
      ]),
      opaqueTransitionRef: h("full-graph-unknown-transition"),
      owningFamilyId: "unknown-full-graph-family",
      owningFamilyDefinitionHash: h("unknown-full-graph-family-definition"),
      owningInstanceKey: "unknown-full-graph-instance",
      instancePublicationHash: h("unknown-full-graph-publication"),
      staticProjectionHash: h("unknown-full-graph-static-projection"),
      projectionHash: h("unknown-full-graph-projection"),
      rehydrationRef: Object.freeze({
        familyDefinitionHash: h("unknown-full-graph-family-definition"),
        instanceKey: "unknown-full-graph-instance",
        instancePublicationHash: h("unknown-full-graph-publication"),
        staticProjectionMemoHash: h("unknown-full-graph-static-memo"),
        requestedArtifactDependencyRoot: h("unknown-full-graph-dependencies"),
      }),
    });
    const unknownPersistedEdge = Object.freeze({
      edgeId: hashDomain("aloha/persisted-graph-edge/v1", unknownFamilyEdgeBody),
      ...unknownFamilyEdgeBody,
    });
    const unknownRuntimeEdge = Object.freeze({ ...unknownPersistedEdge, routeHandle: Object.freeze({}) as never });
    const instanceCatalogRoot = h("full-graph-sweep-instance-catalog");
    const graphRoot = hashDomain("aloha/persisted-graph/v1", {
      cutoff,
      instanceCatalogRoot,
      edges: [unknownPersistedEdge],
    });
    const leaseBinding = Object.freeze({
        generationId: "full-graph-sweep-generation",
        readyRecordHash: h("full-graph-sweep-ready"),
        generationRefreshPolicyHash: h("full-graph-sweep-policy"),
        cutoff,
        definitionCatalogRoot: services.catalog.loadExact().definitionCatalogRoot,
        instanceCatalogRoot,
        graphRoot,
        releaseProvenanceHash: services.release.releaseProvenanceHash,
        candidatePartitionProofStorageHash: h("full-graph-sweep-partition"),
        nominationClosureRoot: h("full-graph-sweep-nomination"),
        nominationClosureStorageHash: h("full-graph-sweep-nomination-storage"),
    });
    const makeLease = (assertActive: () => void | Promise<void>) => issueTestStartupLeaseV1({
      binding: leaseBinding,
      edges: Object.freeze([unknownRuntimeEdge]),
      async assertActive() { await assertActive(); },
      async resolveRouteHandle() { throw new Error("missing-owner full-Graph edge must not resolve a route handle"); },
      release() {},
    }, () => Object.freeze({ stage1: Object.freeze([]), stage2: Object.freeze([]) }));
    const head = await source.headSource.next(new AbortController().signal);
    assert.ok(head);
    const headObservation = source.consumeHeadObservation(head);
    const sweepExecution = Object.freeze({
      transactionOrigin: "runtime-release-bootstrap",
      executorAddress: "acceptance-recipient",
    });

    let failingFenceCount = 0;
    const failingLease = makeLease(() => {
      failingFenceCount += 1;
      if (failingFenceCount === 8) throw new Error("transient full-Graph fence failure");
    });
    const failingSession = await source.canonical.openHeadSession(headObservation, failingLease);
    try {
      await assert.rejects(
        services.fullGraphCoarseSweep.run(issueFullGraphCoarseSweepInvocationCapabilityV1({
          session: failingSession,
          sourceRead: source.issueFullGraphCoarseSweepSourceRead(failingSession.currentSourceCapability),
          amountSeed: { amountIn: "1", recipient: "acceptance-recipient" },
          execution: sweepExecution,
        })),
        /transient full-Graph fence failure/,
      );
    } finally {
      await failingSession.close();
    }

    let releaseBlockedFence!: () => void;
    let markFenceBlocked!: () => void;
    const fenceBlocked = new Promise<void>(resolve => { markFenceBlocked = resolve; });
    const releaseFence = new Promise<void>(resolve => { releaseBlockedFence = resolve; });
    let blockingFenceCount = 0;
    const blockingLease = makeLease(async () => {
      blockingFenceCount += 1;
      if (blockingFenceCount === 7) {
        markFenceBlocked();
        await releaseFence;
      }
    });
    const session = await source.canonical.openHeadSession(headObservation, blockingLease);
    const inFlight = services.fullGraphCoarseSweep.run(issueFullGraphCoarseSweepInvocationCapabilityV1({
      session,
      sourceRead: source.issueFullGraphCoarseSweepSourceRead(session.currentSourceCapability),
      amountSeed: { amountIn: "1", recipient: "acceptance-recipient" },
      execution: sweepExecution,
    }));
    await fenceBlocked;
    const competingSession = await source.canonical.openHeadSession(headObservation, makeLease(() => {}));
    try {
      await assert.rejects(
        services.fullGraphCoarseSweep.run(issueFullGraphCoarseSweepInvocationCapabilityV1({
          session: competingSession,
          sourceRead: source.issueFullGraphCoarseSweepSourceRead(competingSession.currentSourceCapability),
          amountSeed: { amountIn: "1", recipient: "acceptance-recipient" },
          execution: sweepExecution,
        })),
        /already in flight/,
      );
    } finally {
      await competingSession.close();
    }
    releaseBlockedFence();
    const capability = await (async () => {
      try {
        return await inFlight;
      } finally {
        await session.close();
      }
    })();
    const sweep = readFullGraphSweep(capability);
    assert.equal(sweep.expectedTransitionCount, "4");
    assert.equal(sweep.observedTransitionCount, "0");
    assert.equal(sweep.missingTransitionCount, "4");
    assert.equal(sweep.entries.length, 4);
    assert.equal(new Set(sweep.entries.map(entry => entry.transitionId)).size, 4);
    assert.equal(sweep.entries.every(entry => entry.edge.edgeId === unknownPersistedEdge.edgeId), true);
    assert.equal(sweep.entries.every(entry => entry.missingReason === "coarse-owner-missing"), true);
    assert.deepEqual(sweep.familyTransitionCounts, [{
      familyId: "unknown-full-graph-family",
      expectedTransitionCount: "4",
      observedTransitionCount: "0",
      missingTransitionCount: "4",
    }]);
    assert.deepEqual(sweep.binding.recentObservationRange, { from: "51", to: "100", blockCount: "50" });
    assert.throws(() => readRuntimeReleaseFullGraphCoarseSweepManifestV1({ ...capability }), /invalid|not issued/);

    const replaySession = await source.canonical.openHeadSession(headObservation, makeLease(() => {}));
    try {
      await assert.rejects(
        services.fullGraphCoarseSweep.run(issueFullGraphCoarseSweepInvocationCapabilityV1({
          session: replaySession,
          sourceRead: source.issueFullGraphCoarseSweepSourceRead(replaySession.currentSourceCapability),
          amountSeed: { amountIn: "1", recipient: "acceptance-recipient" },
          execution: sweepExecution,
        })),
        /already ran for this exact Ready\/current-source snapshot/,
      );
    } finally {
      await replaySession.close();
    }
    value.authority.rotate(value.binding);
    assert.throws(() => readRuntimeReleaseFullGraphCoarseSweepManifestV1(capability), /stale|rotation/);
  } finally {
    await value.close();
  }
});

test("bootstrap rejects cloned or foreign proof/scheduler issuers before constructing checkpoint", async () => {
  const cloned = await fixture();
  try {
    const proofClone = { ...cloned.input.candidatePartitionProofIssuer };
    assert.throws(
      () => buildRuntimeReleaseComposition({ ...cloned.input, candidatePartitionProofIssuer: proofClone }),
      /not release-issued/,
    );
  } finally {
    await cloned.close();
  }

  const foreign = await fixture();
  try {
    const scheduler = foreign.input.scheduler;
    const foreignIssuer = createTestQualifiedExecutorAuthorityIssuer(
      registry,
      testReleaseApprovalPort(registry, selectedExecutor.releaseRoleManifestRoot, selectedExecutor.candidateCommit),
    );
    const foreignCapability = foreignIssuer.open({ worker: { workerEpoch: foreign.binding.workerEpoch, ...selectedExecutor } });
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...foreign.input,
        scheduler: { ...scheduler, capability: foreignCapability },
      }),
      /unknown-capability|not issued|stale|revoked/,
    );
  } finally {
    await foreign.close();
  }
});

test("bootstrap accepts only an owner-issued deployment port with an exact signed selected-executor join", async () => {
  const value = await fixture();
  try {
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...value.input,
        startup: {
          ...value.input.startup,
          source: { profile: "reth-json-rpc-v1", endpoint: "http://127.0.0.1:8545", chainId: "1" },
        },
      } as never),
      /qualified discovery source port|owner-issued/,
    );
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...value.input,
        startup: { ...value.input.startup, source: { ...value.input.startup.source } },
      }),
      /qualified discovery source port|owner-issued/,
    );
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...value.input,
        revm: {
          factory: { async spawn() { throw new Error("must not spawn"); } },
          qualification: {
            engineBuildFingerprint: value.binding.selectedExecutor.engineBuildFingerprint,
            executableFingerprint: value.binding.selectedExecutor.executableFingerprint,
          },
        },
      } as never),
      /deployment port|owner-issued|not issued/,
    );
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...value.input,
        revm: { deploymentPort: { ...value.input.revm.deploymentPort } },
      }),
      /deployment port|owner-issued|not issued/,
    );

    const executorFields = [
      "executorKind",
      "engineBuildFingerprint",
      "executableFingerprint",
      "closureFingerprint",
      "protocolFingerprint",
      "schemaFingerprint",
      "releaseRoleManifestRoot",
      "candidateCommit",
    ] as const;
    for (const field of executorFields) {
      const altered = {
        ...selectedExecutor,
        [field]: field === "executorKind" ? "other-executor" : field === "candidateCommit" ? "b".repeat(40) : h(`altered-${field}`),
      } as QualifiedExecutorRegistryEntryV1;
      const rawPort = issueRevmWorkerDeploymentPort({
        factory: { async spawn() { throw new Error("must not spawn"); } },
        qualification: {
          engineBuildFingerprint: altered.engineBuildFingerprint,
          executableFingerprint: altered.executableFingerprint,
        },
        selectedExecutor: altered,
        selectedExecutorLeafHash: h(`altered-leaf-${field}`),
        qualifiedExecutorRegistryRoot: value.binding.qualifiedExecutorRegistryRoot,
      });
      assert.throws(
        () => issueRuntimeReleaseRevmWorkerDeploymentPort(value.authority, rawPort),
        /signed selected executor/,
        `selected executor field ${field} was not bound`,
      );
    }

    const alteredQualification = issueRevmWorkerDeploymentPort({
      factory: { async spawn() { throw new Error("must not spawn"); } },
      qualification: {
        engineBuildFingerprint: h("altered-qualification-engine"),
        executableFingerprint: value.binding.selectedExecutor.executableFingerprint,
      },
      selectedExecutor,
      selectedExecutorLeafHash: value.binding.selectedExecutorLeafHash,
      qualifiedExecutorRegistryRoot: value.binding.qualifiedExecutorRegistryRoot,
    });
    assert.throws(
      () => issueRuntimeReleaseRevmWorkerDeploymentPort(value.authority, alteredQualification),
      /signed selected executor/,
    );

    const alteredRegistryRoot = issueRevmWorkerDeploymentPort({
      factory: { async spawn() { throw new Error("must not spawn"); } },
      qualification: {
        engineBuildFingerprint: selectedExecutor.engineBuildFingerprint,
        executableFingerprint: selectedExecutor.executableFingerprint,
      },
      selectedExecutor,
      selectedExecutorLeafHash: value.binding.selectedExecutorLeafHash,
      qualifiedExecutorRegistryRoot: h("altered-registry-root"),
    });
    assert.throws(
      () => issueRuntimeReleaseRevmWorkerDeploymentPort(value.authority, alteredRegistryRoot),
      /signed selected executor/,
    );
  } finally {
    await value.close();
  }
});

test("bootstrap rejects a cloned physical execution port and keeps the Family capability release-bound", async () => {
  const value = await fixture();
  try {
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...value.input,
        scheduler: {
          ...value.input.scheduler,
          runtime: { ...value.input.scheduler.runtime },
        },
      }),
      /scheduler runtime port.*owner-issued|not owner-issued/,
    );
    const otherRuntime = issueQualifiedSharedSchedulerRuntimePort({
      scheduler: new WorkScheduler(),
      issuer: value.input.scheduler.issuer,
      capability: value.input.scheduler.capability,
    });
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...value.input,
        scheduler: { ...value.input.scheduler, runtime: otherRuntime },
      }),
      /do not share one scheduler runtime/,
    );
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...value.input,
        scheduler: {
          ...value.input.scheduler,
          physicalExecution: { ...value.input.scheduler.physicalExecution },
        },
      }),
      /owner-issued|not bound/,
    );
    const services = buildRuntimeReleaseComposition(value.input);
    value.authority.rotate(value.binding);
    assert.throws(
      () => services.familyRuntime.openComposition(),
      /stale|rotation/,
    );
    assert.throws(() => services.catalog.loadExact(), /stale|rotation/);
    value.authority.revoke();
    assert.throws(
      () => services.familyRuntime.openComposition(),
      /revoked/,
    );
  } finally {
    await value.close();
  }
});

test("catalog projection is exact-bound and rejects every self-consistent mutation", async () => {
  const value = await fixture();
  try {
    const projection = value.input.catalog.qualifiedCapabilityProjection as Record<string, unknown>;
    const mutations = [
      ["bindingId", h("foreign-binding")],
      ["releaseProvenanceHash", h("foreign-provenance")],
      ["qualifiedCapabilityRefsRoot", h("foreign-capability-root")],
    ] as const;
    for (const [field, replacement] of mutations) {
      assert.throws(
        () => buildRuntimeReleaseComposition({
          ...value.input,
          catalog: {
            ...value.input.catalog,
            qualifiedCapabilityProjection: { ...projection, [field]: replacement },
          },
        }),
        /catalog|projection|root|provenance|binding/,
        `catalog projection mutation ${field} was accepted`,
      );
    }
    const refs = projection.refs as readonly Record<string, unknown>[];
    const foreignProjection = {
      ...projection,
      refs: refs.map((ref, index) => index === 0 ? { ...ref, ownerRef: h("foreign-owner") } : ref),
    };
    assert.throws(
      () => buildRuntimeReleaseComposition({
        ...value.input,
        catalog: {
          ...value.input.catalog,
          qualifiedCapabilityProjection: foreignProjection,
        },
      }),
      /root|catalog|projection/,
      "a projection with a different qualified ref must not bypass exact decoding",
    );
  } finally {
    await value.close();
  }
});

test("every public service call fails closed after runtime rotation and revoke", async () => {
  const value = await fixture();
  try {
    const services = buildRuntimeReleaseComposition(value.input);
    assert.equal("bindPromotion" in services.startup, false);
    assert.equal("promote" in services.startup, false);
    value.authority.rotate(value.binding);
    await assert.rejects(services.startup.startStartup(), /stale|rotation|release/);
    assert.throws(() => services.performance.openWindow({} as never), /stale|rotation|release/);
    assert.throws(() => services.attestation.openRunSession({ candidatePartition: {} as never }), /stale|rotation/);
    assert.throws(() => services.checkpoint.loadAndValidateRoot(), /stale|rotation/);
    await assert.rejects(services.familyExecution.executeFrozenProgram({} as never), /stale|rotation/);
    await assert.rejects(services.fullGraphCoarseSweep.run({} as never), /stale|rotation/);
    assert.throws(() => services.observerStore.issueObserverStore({} as never), /stale|rotation/);

    value.authority.revoke();
    await assert.rejects(services.startup.startStartup(), /revoked/);
    assert.throws(() => services.performance.openWindow({} as never), /revoked/);
    assert.throws(() => services.attestation.openRunSession({ candidatePartition: {} as never }), /revoked/);
    assert.throws(() => services.checkpoint.loadAndValidateRoot(), /revoked/);
    await assert.rejects(services.familyExecution.executeFrozenProgram({} as never), /revoked/);
    await assert.rejects(services.fullGraphCoarseSweep.run({} as never), /revoked/);
    assert.throws(() => services.observerStore.issueObserverStore({} as never), /revoked/);
  } finally {
    await value.close();
  }
});

test("release-owned application submits an observed head, emits a producer terminal, and rejects an early sweep read", async () => {
  const value = await fixture();
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "aloha-runtime-release-evidence-"));
  const evidencePath = join(evidenceDirectory, "production-evidence.sqlite");
  const services = buildRuntimeReleaseComposition(value.input);
  const catalog = services.catalog.loadExact();
  const head = cutoff;
  const strategy = services.strategyRuntime;
  try {
    const startup = issueStartupRuntime({
      ready: {
        releaseProvenanceHash: services.release.releaseProvenanceHash,
        definitionCatalogRoot: catalog.definitionCatalogRoot,
        readyRecordHash: h("service-ready"),
        sourceCoverageRoot: h("service-source-coverage"),
      } as never,
      familyRuntimeComposition: services.familyRuntime.openComposition(),
      generationId: "service-generation",
      graphRoot: h("service-graph"),
      releaseBindingId: services.release.bindingId,
      candidateReleaseCommit: services.release.candidateReleaseCommit,
      canonicalSourceAuthority: value.input.checkpoint.canonical.authority,
      readActiveGeneration() {
        return Object.freeze({
          ready: {
            releaseProvenanceHash: services.release.releaseProvenanceHash,
            definitionCatalogRoot: catalog.definitionCatalogRoot,
            readyRecordHash: h("service-ready"),
            sourceCoverageRoot: h("service-source-coverage"),
          } as never,
          generationId: "service-generation",
          graphRoot: h("service-graph"),
          readyRecordHash: h("service-ready"),
          sourceCoverageRoot: h("service-source-coverage"),
          definitionCatalogRoot: catalog.definitionCatalogRoot,
          releaseProvenanceHash: services.release.releaseProvenanceHash,
        });
      },
      readServingGeneration(requestedGenerationId) {
        if (requestedGenerationId !== "service-generation") throw new TypeError("unknown service generation");
        return this.readActiveGeneration();
      },
      readProducerSessionGeneration(session) {
        if (session.generationId !== "service-generation") throw new TypeError("unknown service session");
        return this.readActiveGeneration();
      },
      async withProducerSession(headObservation, run) {
        const binding = {
          generationId: "service-generation",
          readyRecordHash: h("service-ready"),
          generationRefreshPolicyHash: h("service-policy"),
          cutoff,
          definitionCatalogRoot: catalog.definitionCatalogRoot,
          instanceCatalogRoot: h("service-instance-catalog"),
          graphRoot: h("service-graph"),
          releaseProvenanceHash: services.release.releaseProvenanceHash,
          candidatePartitionProofStorageHash: h("service-candidate-partition"),
          nominationClosureRoot: h("service-nomination-closure"),
          nominationClosureStorageHash: h("service-nomination-closure-storage"),
        };
        const lease = issueTestStartupLeaseV1({
          binding,
          edges: Object.freeze([]),
          async assertActive() {},
          async resolveRouteHandle() { return {} as never; },
          release() {},
        }, () => { throw new TypeError("empty service Graph has no Six-Step route parents"); });
        const session = await value.input.checkpoint.canonical.openHeadSession(headObservation, lease);
        try {
          return await run(session);
        } finally {
          await session.close();
        }
      },
      async waitForGenerationIdle() {},
      async close() {},
    });
    const finalSimulationFactory = issueQualifiedFinalSimulationPortFactoryV1({
      async issue() {
        return {
          rejectionAuthority: Object.freeze({ read() { throw new TypeError("final simulation rejection was not issued"); } }),
          async simulate() { return { kind: "retryable", stage: "final-sim", code: "not-reached" }; },
        };
      },
    });
    const source = value.runtimeSource;
    const observations = applicationObservationPorts(join(evidenceDirectory, "observer-store"));
    const evidence = issueSearcherProductionEvidenceOwnerV1({
      databasePath: evidencePath,
      economicSafety: services.economicSafety,
      release: {
        bindingId: services.release.bindingId,
        releaseProvenanceHash: services.release.releaseProvenanceHash,
        candidateReleaseCommit: services.release.candidateReleaseCommit,
      },
      runtimeAnchor: {
        kind: "aloha.searcher-runtime-anchor-v1",
        bindingId: services.release.bindingId,
        releaseProvenanceHash: services.release.releaseProvenanceHash,
        manifestHash: h("evidence-manifest"),
        manifestArtifactSha256: h("evidence-manifest-artifact"),
        runtimeArtifactRoot: h("evidence-runtime"),
        implementationClosureDigest: h("evidence-closure"),
        candidateReleaseCommit: services.release.candidateReleaseCommit,
        entrypointSha256: h("evidence-entrypoint"),
        nodeExecutableSha256: h("evidence-node"),
        bundleModulePath: "/opt/aloha/release.mjs",
        bundleModuleSha256: h("evidence-bundle"),
        serviceName: "aloha-searcher",
        systemdUnit: "aloha-searcher.service",
        bootId: "boot-1",
        invocationId: "invocation-1",
        logDevice: "8",
        logInode: "9",
        pid: "42",
        processStartTicks: "7",
        dryRun: true,
      },
    });
    const applicationInput = {
      strategyRuntime: strategy,
      performanceRuntime: services.performance,
      fullGraphCoarseSweep: services.fullGraphCoarseSweep,
      fullFamilyTerminalBinding: services.fullFamilyTerminalBinding,
      sixStepTerminalBinding: services.sixStepTerminalBinding,
      fullFamilyObservation: observations.fullFamilyObservation,
      sixStepObservation: observations.sixStepObservation,
      terminalPhaseObservation: observations.terminalPhaseObservation,
      economicSafety: services.economicSafety,
      release: {
        bindingId: services.release.bindingId,
        releaseProvenanceHash: services.release.releaseProvenanceHash,
        candidateReleaseCommit: services.release.candidateReleaseCommit,
      },
      coreInput: {
        amountSeed: { amountIn: "1", recipient: "0x0000000000000000000000000000000000000001" },
        execution: {
          transactionOrigin: "runtime-release-bootstrap",
          executorAddress: "0x0000000000000000000000000000000000000001",
        },
      },
      finalSimulationFactory,
      evidence,
      source,
    };
    const applicationOwner = issueSearcherRuntimeApplicationOwnerV1(applicationInput);
    const application = applicationOwner.open(startup);
    const competingApplicationOwner = issueSearcherRuntimeApplicationOwnerV1(applicationInput);
    assert.throws(() => competingApplicationOwner.open(startup), /already bound to an application/);
    try {
      const observedHead = await source.headSource.next(new AbortController().signal);
      assert.ok(observedHead);
      assert.equal(Reflect.has(application, "producer"), false, "the application must not expose raw ProducerRuntime");
      const telemetryBeforeInjection = application.telemetry();
      await assert.rejects(
        application.submitHead({
          ...observedHead,
          sourceHeadSeenAtMs: 0,
          sourceHeadSeenMonotonicMs: 0,
          blockscanInput: {},
          backrunInput: {},
        } as never),
        /non-exact|unknown.*field/,
      );
      assert.deepEqual(application.telemetry(), telemetryBeforeInjection, "raw timing and lane input must not enter Producer");
      await application.submitHead(observedHead);
      await application.waitForIdle();
      assert.equal(application.telemetry().terminalCount, 1);
      assert.throws(
        () => application.readFullGraphCoarseSweep(),
        /not complete/,
        "one durable terminal must not authorize the acceptance sweep",
      );
      assert.throws(() => applicationOwner.open(startup), /already bound to an application/);
      const replay = evidence.replay();
      assert.equal(replay.producerTerminalCount, "1");
      assert.equal(replay.performanceFactsCompleteCount, "1");
      assert.equal(replay.performanceFactsIncompleteCount, "0");
    } finally {
      await application.stop();
    }
    const persisted = createSqliteDurableStore(evidencePath);
    try {
      persisted.bindStoreRole("searcher-production-evidence");
      const rows = persisted.readAppendLog(SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.headCoverage);
      assert.equal(rows.length, 1);
      const event = decodeCanonicalJson(rows[0]!.bytes) as Record<string, unknown>;
      const payload = event.payload as Record<string, unknown>;
      assert.equal("laneCoverageFacts" in payload, false);
      assert.ok(Array.isArray(payload.laneTerminalFacts));
      const laneTerminalFacts = payload.laneTerminalFacts as readonly Record<string, unknown>[];
      assert.deepEqual(laneTerminalFacts.map(fact => [fact.kind, fact.lane]), [
        ["coverage", "blockscan"],
        ["coverage", "backrun"],
      ]);
      for (const coverage of laneTerminalFacts) {
        assert.deepEqual(Object.keys(coverage).sort(), ["correlationId", "coverageRoot", "kind", "lane"]);
      }
      assert.equal(payload.laneTerminalFactsRoot, hashDomain(
        "aloha/searcher-production-evidence-lane-terminal-facts-root/v1",
        laneTerminalFacts,
      ));
    } finally {
      persisted.close();
    }
  } finally {
    await value.close();
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

/**
 * Lifecycle-only fixture: the application, release services, Producer,
 * evidence owner, and Reth/canonical sessions are all their real owner-issued
 * implementations.  It deliberately starts at the StartupRuntime boundary;
 * it is not a qualification fixture for discovery/attestation/Ready startup.
 */
function openApplicationLifecycleFixture(
  value: BootstrapFixture,
  services: ReturnType<typeof buildRuntimeReleaseComposition<BootstrapFact>>,
  evidencePath: string,
  processIdentity: Readonly<{
    readonly bootId: string;
    readonly invocationId: string;
    readonly pid: string;
    readonly processStartTicks: string;
  }> = Object.freeze({
    bootId: "application-lifecycle-boot",
    invocationId: "application-lifecycle-invocation",
    pid: "42",
    processStartTicks: "7",
  }),
) {
  const catalog = services.catalog.loadExact();
  const generationId = "application-lifecycle-generation";
  const graphRoot = h("application-lifecycle-graph");
  const readyRecordHash = h("application-lifecycle-ready");
  const stage12Capability = Object.freeze(Object.create(null));
  const stage12Reader = Object.freeze({
    binding() { throw new TypeError("typed-missing lifecycle fixture does not decode Stage 1/2"); },
    async read() { throw new TypeError("typed-missing lifecycle fixture does not decode Stage 1/2"); },
    async verify() { throw new TypeError("typed-missing lifecycle fixture does not decode Stage 1/2"); },
    routeParents() { throw new TypeError("typed-missing lifecycle fixture has no Stage 1/2 route parents"); },
  });
  const fullFamilyReader = Object.freeze({
    async read() { throw new TypeError("typed-missing lifecycle fixture does not decode Full-Family"); },
  });
  registerCheckpointReadyFullFamilyEvidenceReader(fullFamilyReader);
  const startup = issueStartupRuntimeWithStage12Evidence({
    ready: {
      releaseProvenanceHash: services.release.releaseProvenanceHash,
      definitionCatalogRoot: catalog.definitionCatalogRoot,
      readyRecordHash,
      sourceCoverageRoot: h("application-lifecycle-source-coverage"),
    } as never,
    familyRuntimeComposition: services.familyRuntime.openComposition(),
    generationId,
    graphRoot,
    releaseBindingId: services.release.bindingId,
    candidateReleaseCommit: services.release.candidateReleaseCommit,
    canonicalSourceAuthority: value.runtimeSource.canonicalAuthority,
    readActiveGeneration() {
      return Object.freeze({
        ready: {
          releaseProvenanceHash: services.release.releaseProvenanceHash,
          definitionCatalogRoot: catalog.definitionCatalogRoot,
          readyRecordHash,
          sourceCoverageRoot: h("application-lifecycle-source-coverage"),
        } as never,
        generationId,
        graphRoot,
        readyRecordHash,
        sourceCoverageRoot: h("application-lifecycle-source-coverage"),
        definitionCatalogRoot: catalog.definitionCatalogRoot,
        releaseProvenanceHash: services.release.releaseProvenanceHash,
      });
    },
    readServingGeneration(requestedGenerationId) {
      if (requestedGenerationId !== generationId) throw new TypeError("unknown lifecycle generation");
      return this.readActiveGeneration();
    },
    readProducerSessionGeneration(session) {
      if (session.generationId !== generationId) throw new TypeError("unknown lifecycle session");
      return this.readActiveGeneration();
    },
    async withProducerSession(headObservation, run, signal) {
      const binding = Object.freeze({
        generationId,
        readyRecordHash,
        generationRefreshPolicyHash: h("application-lifecycle-policy"),
        cutoff,
        definitionCatalogRoot: catalog.definitionCatalogRoot,
        instanceCatalogRoot: h("application-lifecycle-instance-catalog"),
        graphRoot,
        releaseProvenanceHash: services.release.releaseProvenanceHash,
        candidatePartitionProofStorageHash: h("application-lifecycle-candidate-partition"),
        nominationClosureRoot: h("application-lifecycle-nomination-closure"),
        nominationClosureStorageHash: h("application-lifecycle-nomination-closure-storage"),
      });
      const lease = issueTestStartupLeaseV1({
        binding,
        edges: Object.freeze([]),
        async assertActive() {},
        async resolveRouteHandle() { throw new TypeError("empty lifecycle Graph has no route handle"); },
        release() {},
      }, () => { throw new TypeError("empty lifecycle Graph has no Six-Step route parents"); });
      const session = await value.runtimeSource.canonical.openHeadSession(headObservation, lease, signal);
      try {
        return await run(session);
      } finally {
        await session.close();
      }
    },
    async waitForGenerationIdle() {},
    async close() {},
  }, {
    capability: stage12Capability,
    reader: stage12Reader,
    fullFamilyReader,
  });
  const observations = applicationObservationPorts(`${evidencePath}.observer-store`);
  const evidence = issueSearcherProductionEvidenceOwnerV1({
    databasePath: evidencePath,
    economicSafety: services.economicSafety,
    release: {
      bindingId: services.release.bindingId,
      releaseProvenanceHash: services.release.releaseProvenanceHash,
      candidateReleaseCommit: services.release.candidateReleaseCommit,
    },
    runtimeAnchor: {
      kind: "aloha.searcher-runtime-anchor-v1",
      bindingId: services.release.bindingId,
      releaseProvenanceHash: services.release.releaseProvenanceHash,
      manifestHash: h("application-lifecycle-manifest"),
      manifestArtifactSha256: h("application-lifecycle-manifest-artifact"),
      runtimeArtifactRoot: h("application-lifecycle-runtime"),
      implementationClosureDigest: h("application-lifecycle-closure"),
      candidateReleaseCommit: services.release.candidateReleaseCommit,
      entrypointSha256: h("application-lifecycle-entrypoint"),
      nodeExecutableSha256: h("application-lifecycle-node"),
      bundleModulePath: "/opt/aloha/application-lifecycle.mjs",
      bundleModuleSha256: h("application-lifecycle-bundle"),
      serviceName: "aloha-searcher",
      systemdUnit: "aloha-searcher.service",
      bootId: processIdentity.bootId,
      invocationId: processIdentity.invocationId,
      logDevice: "8",
      logInode: "9",
      pid: processIdentity.pid,
      processStartTicks: processIdentity.processStartTicks,
      dryRun: true,
    },
  });
  const application = issueSearcherRuntimeApplicationOwnerV1({
    strategyRuntime: services.strategyRuntime,
    performanceRuntime: services.performance,
    fullGraphCoarseSweep: services.fullGraphCoarseSweep,
    fullFamilyTerminalBinding: services.fullFamilyTerminalBinding,
    sixStepTerminalBinding: services.sixStepTerminalBinding,
    fullFamilyObservation: observations.fullFamilyObservation,
    sixStepObservation: observations.sixStepObservation,
    terminalPhaseObservation: observations.terminalPhaseObservation,
    economicSafety: services.economicSafety,
    release: {
      bindingId: services.release.bindingId,
      releaseProvenanceHash: services.release.releaseProvenanceHash,
      candidateReleaseCommit: services.release.candidateReleaseCommit,
    },
    source: value.runtimeSource,
    coreInput: {
      amountSeed: { amountIn: "1", recipient: "0x0000000000000000000000000000000000000001" },
      execution: {
        transactionOrigin: "runtime-release-bootstrap",
        executorAddress: "0x0000000000000000000000000000000000000001",
      },
    },
    finalSimulationFactory: issueQualifiedFinalSimulationPortFactoryV1({
      async issue() {
        throw new TypeError("empty lifecycle Graph must not request final simulation");
      },
    }),
    evidence,
  }).open(startup);
  return Object.freeze({ application, evidence, observations });
}

async function completeApplicationWindow(
  value: BootstrapFixture,
  application: ReturnType<typeof openApplicationLifecycleFixture>["application"],
): Promise<CanonicalHead> {
  let parentHash = h("cutoff-parent");
  let finalHead: CanonicalHead | null = null;
  for (let index = 0; index < 100; index += 1) {
    const head = index === 0
      ? Object.freeze({ ...cutoff, parentHash })
      : exact100Head(index - 1, parentHash);
    value.setRuntimeHead(head);
    const observed = await value.runtimeSource.headSource.next(new AbortController().signal);
    assert.deepEqual(observed, head);
    const submission = await application.submitHead(head);
    assert.equal(submission?.accepted, true);
    await application.waitForIdle();
    parentHash = head.hash;
    finalHead = head;
  }
  if (finalHead === null) throw new TypeError("application lifecycle did not observe a final head");
  return finalHead;
}

test("application lifecycle freezes exact-100 admission, runs one same-head sweep, and preserves Producer/F5 facts", { timeout: 120_000 }, async () => {
  const value = await fixture();
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "aloha-application-lifecycle-"));
  const services = buildRuntimeReleaseComposition(value.input);
  const lifecycleProcessIdentity = Object.freeze({
    bootId: "application-lifecycle-boot",
    invocationId: "application-lifecycle-invocation",
    pid: "42",
    processStartTicks: "7",
  });
  const { application, observations } = openApplicationLifecycleFixture(
    value,
    services,
    join(evidenceDirectory, "production-evidence.sqlite"),
    lifecycleProcessIdentity,
  );
  try {
    const finalHead = await completeApplicationWindow(value, application);
    const beforeSweep = application.telemetry();
    assert.equal(beforeSweep.terminalCount, 100);
    assert.equal(beforeSweep.state, "accepting");
    const finalProducerCapability = application.readFinalDurableProducerTerminal();
    assert.ok(finalProducerCapability);
    const finalProducer = readIssuedProducerHeadTerminalCapabilityV1(finalProducerCapability);
    assert.ok(finalProducer.facts);
    const finalFacts = readIssuedProducerHeadFactsCapabilityV1(finalProducer.facts);
    assert.equal(finalProducer.terminal.status, "completed", JSON.stringify(finalProducer.terminal));
    assert.equal(finalFacts.complete, true, JSON.stringify(finalFacts));
    const decodedLaneFacts = finalFacts.laneFacts.map(facts => readIssuedProducerLaneFactsV1(facts));
    const blockscanFacts = decodedLaneFacts.find(facts => facts.lane === "blockscan");
    assert.ok(blockscanFacts, JSON.stringify({
      lanes: decodedLaneFacts.map(facts => [facts.lane, facts.terminalKind]),
      failures: finalFacts.laneFailureObservations,
    }));
    const searchTerminalCapability = readIssuedProducerLaneSearchTerminalCapabilityV1(blockscanFacts);
    assert.ok(searchTerminalCapability, "the real empty-Graph blockscan must retain its route-set terminal/native audit");
    assert.equal(readIssuedSearchTerminalCapabilityV1(searchTerminalCapability).kind, "route-set-terminal");
    assert.throws(() => application.readFullGraphCoarseSweep(), /not complete/);
    assert.throws(() => application.readTerminalPhaseObservation(), /not complete/);
    assert.deepEqual(observations.calls(), { fullFamily: 0, sixStep: 0, terminal: 0 });

    const requestsBeforeRejectedAdmission = value.runtimeRpcRequestCount();
    const forbiddenHead = new Proxy({} as CanonicalHead, {
      get() { throw new TypeError("101st head reached ingress"); },
    });
    await assert.rejects(
      application.submitHead(forbiddenHead),
      /performance window/,
      "the 101st admission must fail before reading ingress input",
    );
    assert.equal(value.runtimeRpcRequestCount(), requestsBeforeRejectedAdmission);
    assert.deepEqual(application.telemetry(), beforeSweep);

    await application.run();
    const capability = application.readFullGraphCoarseSweep();
    const fullFamilyCapability = application.readFullFamilyObservation();
    const sixStepCapability = application.readSixStepObservation();
    const terminalCapability = application.readTerminalPhaseObservation();
    assert.equal(application.readTerminalPhaseInvalid(), null);
    assert.equal(application.readFullGraphCoarseSweep(), capability, "the application must expose one sealed sweep capability");
    assert.equal(application.readFullFamilyObservation(), fullFamilyCapability);
    assert.equal(application.readSixStepObservation(), sixStepCapability);
    assert.equal(application.readTerminalPhaseObservation(), terminalCapability);
    assert.deepEqual(observations.calls(), { fullFamily: 1, sixStep: 1, terminal: 1 });
    const terminal = readProductionTerminalPhaseCollectorResultV1(terminalCapability);
    const terminalManifest = terminal.manifest as unknown as Readonly<{
      readonly sixStep: Readonly<{ readonly status: string; readonly reason: string }>;
    }>;
    assert.throws(() => readProductionTerminalPhaseCollectorResultV1({ ...terminalCapability }), /not issued/);
    const fullFamilyProjection = decodeProductionTerminalPhaseFullFamilyProjectionV1(
      decodeCanonicalJson(terminal.fullFamilyProjectionArtifact.bytes),
    );
    assert.equal(fullFamilyProjection.status, "missing");
    assert.equal(terminalManifest.sixStep.status, "missing");
    assert.equal(terminalManifest.sixStep.reason, "no-successful-dry-run");
    const releaseJoin = observations.lastReleaseJoin();
    assert.doesNotThrow(() => assertProductionTerminalPhaseReleaseMetadataV1(
      releaseJoin.result,
      releaseJoin.terminal,
      releaseJoin.finalWindow,
    ));
    assert.throws(
      () => assertProductionTerminalPhaseReleaseMetadataV1(
        Object.freeze({ ...(releaseJoin.result as object), release: Object.freeze(Object.create(null)) }),
        releaseJoin.terminal,
        releaseJoin.finalWindow,
      ),
      /release metadata is incomplete/,
      "an empty release object must not survive the production terminal join",
    );
    const observedResult = releaseJoin.result as Readonly<{
      readonly release: Readonly<{
        readonly releaseIntentRoot: Hash;
        readonly runtimeDescriptorRoot: Hash;
        readonly globalDefinitionCatalogRoot: Readonly<{ readonly kind: "complete"; readonly definitionCatalogRoot: Hash }>;
        readonly families: readonly Readonly<{
          readonly familyId: string;
          readonly familyDefinitionHash: Hash;
          readonly sourcePlanRoot: Hash;
          readonly sourcePlanRefs: readonly object[];
        }>[];
      }>;
    }>;
    const fakeRoot = h("self-consistent-fake-release");
    const selfConsistentFakeRelease = Object.freeze({
      ...observedResult.release,
      releaseIntentRoot: fakeRoot,
      runtimeDescriptorRoot: fakeRoot,
      globalDefinitionCatalogRoot: Object.freeze({
        ...observedResult.release.globalDefinitionCatalogRoot,
        definitionCatalogRoot: fakeRoot,
      }),
      families: Object.freeze(observedResult.release.families.map(family => Object.freeze({
        ...family,
        familyDefinitionHash: fakeRoot,
        sourcePlanRoot: fakeRoot,
      }))),
    });
    assert.throws(
      () => assertProductionTerminalPhaseReleaseMetadataV1(
        Object.freeze({ ...(releaseJoin.result as object), release: selfConsistentFakeRelease }),
        releaseJoin.terminal,
        releaseJoin.finalWindow,
      ),
      /does not equal the release-owned generated runtime/,
      "self-consistent release metadata must not replace owner-derived generated runtime facts",
    );
    assert.equal(terminal.manifest.processAnchorRoot, hashDomain("aloha/production-terminal-phase-process-anchor/v1", {
      bootId: lifecycleProcessIdentity.bootId,
      invocationId: lifecycleProcessIdentity.invocationId,
      logDevice: "8",
      logInode: "9",
      pid: lifecycleProcessIdentity.pid,
      processStartTicks: lifecycleProcessIdentity.processStartTicks,
    }), "process identity must remain bound even when Six-Step is missing");
    const rawPerformance = observeProductionPerformanceDatabaseV1(join(evidenceDirectory, "production-evidence.sqlite"));
    assert.equal(rawPerformance.status, "raw-complete");
    assert.ok(rawPerformance.sixStepWindowSelection);
    assert.equal(rawPerformance.sixStepWindowSelection.eligibleSuccessCount, "0");
    assert.equal(rawPerformance.sixStepWindowSelection.selectionPolicyDigest, terminal.manifest.sixStep.selectionPolicyDigest);
    assert.equal(rawPerformance.sixStepWindowSelection.eligibleSuccessRoot, terminal.manifest.sixStep.eligibleSuccessRoot);
    assert.equal(rawPerformance.sixStepWindowSelection.selectedIndex, terminal.manifest.sixStep.selectedIndex);
    assert.equal(rawPerformance.sixStepWindowSelection.selectedProducerTerminalId, terminal.manifest.sixStep.selectedProducerTerminalId);
    assert.equal(rawPerformance.sixStepWindowSelection.selectionRoot, terminal.manifest.sixStep.windowSelectionRoot);
    assert.equal(rawPerformance.sixStepWindowSelection.finalDurableWindowId, terminal.manifest.finalDurableWindowId);
    assert.equal(terminal.manifest.sixStep.selectedIndex, null);
    assert.equal(terminal.manifest.sixStep.selectedProducerTerminalId, null);
    assert.ok(rawPerformance.release);
    const terminalServing = rawPerformance.servingPartitions.find(value =>
      value.generationId === releaseJoin.finalWindow.serving.generationId);
    assert.ok(terminalServing);
    const rawSelectionObservation = createRawTerminalSelectionObservationV1({
      databaseSha256Before: rawPerformance.databaseSha256Before,
      databaseSha256After: rawPerformance.databaseSha256After,
      storageSetRootBefore: rawPerformance.storageSetRootBefore,
      storageSetRootAfter: rawPerformance.storageSetRootAfter,
      sqliteSchemaRoot: rawPerformance.sqliteSchemaRoot,
      rawRowRoot: rawPerformance.rawRowRoot,
      eventRoot: rawPerformance.eventRoot,
      terminalPhaseRowCount: rawPerformance.terminalPhaseRowCount,
      terminalPhaseRowRoot: rawPerformance.terminalPhaseRowRoot,
      release: rawPerformance.release,
      serving: terminalServing,
      selection: Object.freeze({
        finalDurableWindowId: rawPerformance.sixStepWindowSelection.finalDurableWindowId,
        selectionPolicyDigest: rawPerformance.sixStepWindowSelection.selectionPolicyDigest,
        eligibleSuccessCount: "0" as const,
        eligibleSuccessRoot: rawPerformance.sixStepWindowSelection.eligibleSuccessRoot,
        selectedIndex: null,
        selectedProducerTerminalId: null,
        selectedPerformanceEventId: null,
        selectedProducerTerminalEventId: null,
        selectionRoot: rawPerformance.sixStepWindowSelection.selectionRoot,
      }),
    });
    const rawSelectionArtifact = await observations.sink.write({
      bytes: encodeCanonicalBytes(rawSelectionObservation),
      mediaType: "application/json",
      schema: TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.rawSelection,
    });
    const terminalFact = createTerminalSelectionMissingFactV1({
      rawSelectionArtifactRefId: rawSelectionArtifact.ref.artifactRefId,
      terminalManifestArtifactRefId: terminal.manifestArtifact.ref.artifactRefId,
      fullFamilyProjectionArtifactRefId: terminal.fullFamilyProjectionArtifact.ref.artifactRefId,
    });
    const terminalArtifacts = Object.freeze([
      rawSelectionArtifact,
      terminal.manifestArtifact,
      terminal.fullFamilyProjectionArtifact,
    ]);
    const terminalFacts = Object.freeze({
      facts: Object.freeze([terminalFact]),
      refs: Object.freeze(terminalArtifacts.map(value => value.ref)),
      claims: Object.freeze(terminalArtifacts.map(value => value.claim)),
      policies: Object.freeze([observations.sink.resolverPolicy]),
      leases: Object.freeze(terminalArtifacts.map(value => value.lease)),
      observations: Object.freeze([Object.freeze({
        observationId: "runtime-release-real-terminal-no-success",
        rawArtifactRefs: Object.freeze(terminalArtifacts.map(value => value.ref)),
        observedClaimIds: Object.freeze(terminalArtifacts.map(value => value.claim.claimId)),
      })]),
      trustedObserverInvocation: Object.freeze({
        keyId: h("runtime-release-terminal-observer-key"),
        observerQualificationId: h("runtime-release-terminal-observer-qualification"),
        roleId: TERMINAL_SELECTION_INVOCATION_SEAL_ROLE.roleId,
        authenticatedArtifactRefIds: Object.freeze(terminalArtifacts.map(value => value.ref.artifactRefId).sort()),
        candidateReleaseCommit: rawPerformance.release.candidateReleaseCommit,
      }),
    });
    assert.equal(evaluateTerminalSelectionPredicate(terminalFacts).verdict, "fail");
    assert.equal(evaluateTerminalSelectionReferenceModel(terminalFacts).verdict, "fail");
    assert.equal(terminal.locator.manifestRoot, terminal.manifest.manifestRoot);
    assert.equal(terminal.locator.manifestContentSha256, terminal.manifestArtifact.contentSha256);
    assert.throws(
      () => decodeProductionTerminalPhaseManifestV1({ ...terminal.manifest, fullGraphCoarseSweepRoot: h("spliced-sweep") }),
      /invocationRoot mismatch|manifestRoot mismatch/i,
    );
    const { selectionPolicyDigest: _omittedSelectionPolicyDigest, ...sixStepWithoutSelectionPolicy } = terminal.manifest.sixStep;
    assert.throws(
      () => decodeProductionTerminalPhaseManifestV1({ ...terminal.manifest, sixStep: sixStepWithoutSelectionPolicy }),
      /exact|keys|missing field/i,
    );
    for (const sixStepMutation of [
      { ...terminal.manifest.sixStep, eligibleSuccessCount: "1" },
      { ...terminal.manifest.sixStep, eligibleSuccessRoot: h("spliced-eligible-success-root") },
      { ...terminal.manifest.sixStep, selectedIndex: "0" },
      { ...terminal.manifest.sixStep, selectedProducerTerminalId: h("spliced-selected-terminal") },
      { ...terminal.manifest.sixStep, windowSelectionRoot: h("spliced-window-selection-root") },
      { ...terminal.manifest.sixStep, verdict: "pass" },
    ]) {
      assert.throws(
        () => decodeProductionTerminalPhaseManifestV1({ ...terminal.manifest, sixStep: sixStepMutation }),
        /exact|unknown field|inconsistent|manifestRoot mismatch/i,
      );
    }
    assert.throws(
      () => decodeProductionTerminalPhaseLocatorV1({ ...terminal.locator, unexpectedVerdict: "pass" }),
      /exact|unexpected/i,
    );
    assert.deepEqual(
      new Uint8Array(readFileSync(join(observations.directory, terminal.manifestArtifact.contentSha256.slice(2)))),
      terminal.manifestArtifact.bytes,
    );
    assert.deepEqual(
      new Uint8Array(readFileSync(join(observations.directory, terminal.locatorArtifact.contentSha256.slice(2)))),
      terminal.locatorArtifact.bytes,
    );
    const reopened = applicationObservationPorts(observations.directory);
    await assert.rejects(
      reopened.locatorIndex.read(terminal.manifest.finalDurableWindowId),
      /not authorized by this process publication/,
    );
    const discovered = await observations.locatorIndex.read(terminal.manifest.finalDurableWindowId);
    assert.deepEqual(discovered.manifest, terminal.manifest);
    assert.deepEqual(discovered.locator, terminal.locator);
    assert.equal(discovered.index.indexRoot, terminal.locatorIndexRoot);
    const restartReader = fileURLToPath(new URL(
      "../../../acceptance/collectors/test/terminal-phase-restart-reader.fixture.ts",
      import.meta.url,
    ));
    const restartedProcess = spawnSync(process.execPath, [
      "--experimental-strip-types",
      restartReader,
      observations.directory,
      observations.locatorIndexDirectory,
      terminal.manifest.finalDurableWindowId,
      h("terminal-observer-store"),
    ], { encoding: "utf8", timeout: 30_000 });
    assert.equal(restartedProcess.status, 0, restartedProcess.stderr);
    const restartedDiscovery = JSON.parse(restartedProcess.stdout) as Readonly<Record<string, unknown>>;
    assert.notEqual(restartedDiscovery.pid, process.pid);
    assert.deepEqual(restartedDiscovery, {
      pid: restartedDiscovery.pid,
      rawWindowRejected: true,
    });
    const unknownWindow = h("unknown-final-window");
    const forgedIndexPayload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.production-terminal-phase-locator-index-v1" as const,
      finalDurableWindowId: unknownWindow,
      locatorRoot: h("forged-locator-root"),
      locatorContentSha256: h("forged-locator-content"),
      locatorArtifactRefId: h("forged-locator-ref"),
      manifestRoot: h("forged-manifest-root"),
      manifestContentSha256: terminal.manifestArtifact.contentSha256,
      manifestArtifact: Object.freeze({
        contentSha256: terminal.manifestArtifact.contentSha256,
        ref: terminal.manifestArtifact.ref,
        claim: terminal.manifestArtifact.claim,
        lease: terminal.manifestArtifact.lease,
      }),
      fullFamilyBundleArtifact: null,
      fullFamilyLocatorArtifact: null,
      sixStepTerminalBindingArtifact: null,
      selectedProcessArtifact: null,
    });
    writeFileSync(
      join(observations.locatorIndexDirectory, `${unknownWindow.slice(2)}.json`),
      encodeCanonicalBytes({
        ...forgedIndexPayload,
        indexRoot: hashDomain("aloha/production-terminal-phase-locator-index/v1", forgedIndexPayload),
      }),
    );
    await assert.rejects(
      reopened.locatorIndex.read(unknownWindow),
      /not authorized by this process publication/,
    );
    await application.run();
    assert.deepEqual(observations.calls(), { fullFamily: 1, sixStep: 1, terminal: 1 }, "terminal seal must not repeat");
    const sweep = readFullGraphSweep(capability);
    assert.deepEqual(sweep.binding.actualCurrentSource, {
      chainId: finalHead.chainId,
      number: finalHead.number,
      hash: finalHead.hash,
      stateRoot: finalHead.stateRoot,
    });
    assert.equal(sweep.binding.recentObservationRange.blockCount, "50");
    assert.equal(sweep.expectedTransitionCount, "0");

    const afterSweep = application.telemetry();
    assert.equal(afterSweep.state, "closed");
    const { state: _beforeState, ...beforeFacts } = beforeSweep;
    const { state: _afterState, ...afterFacts } = afterSweep;
    assert.deepEqual(afterFacts, beforeFacts, "the sweep must not change the Producer/F5 denominator");
    await Promise.all([application.stop(), application.stop()]);
    assert.equal(application.telemetry().state, "closed");
  } finally {
    await application.stop();
    await value.close();
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

test("application lifecycle fails closed on a moved sweep head and never re-samples", { timeout: 120_000 }, async () => {
  const value = await fixture();
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "aloha-application-head-moved-"));
  const evidencePath = join(evidenceDirectory, "production-evidence.sqlite");
  const services = buildRuntimeReleaseComposition(value.input);
  const { application, observations } = openApplicationLifecycleFixture(
    value,
    services,
    evidencePath,
  );
  try {
    const finalHead = await completeApplicationWindow(value, application);
    const beforeMovedHead = application.telemetry();
    value.setRuntimeHead(Object.freeze({
      chainId: finalHead.chainId,
      number: (BigInt(finalHead.number) + 1n).toString(),
      hash: h("application-lifecycle-moved-head"),
      parentHash: finalHead.hash,
      stateRoot: h("application-lifecycle-moved-state"),
    }));
    await assert.rejects(application.run(), /current source moved/);
    assert.deepEqual(observations.calls(), { fullFamily: 0, sixStep: 0, terminal: 0 });
    const requestsAfterFailure = value.runtimeRpcRequestCount();
    await assert.rejects(application.run(), /current source moved/);
    assert.equal(value.runtimeRpcRequestCount(), requestsAfterFailure, "a failed same-head fence must not re-sample");
    assert.throws(() => application.readFullGraphCoarseSweep(), /not complete/);
    const invalid = application.readTerminalPhaseInvalid();
    assert.ok(invalid);
    assert.equal(invalid.reasonCode, "terminal-phase-current-source-moved");
    assert.equal(invalid.finalDurableWindowId.length, 66);
    assert.deepEqual(invalid.observed?.head, {
      chainId: finalHead.chainId,
      number: (BigInt(finalHead.number) + 1n).toString(),
      hash: h("application-lifecycle-moved-head"),
      parentHash: finalHead.hash,
      stateRoot: h("application-lifecycle-moved-state"),
    });
    const afterMovedHead = application.telemetry();
    assert.equal(afterMovedHead.state, "closed");
    const { state: _beforeState, ...beforeFacts } = beforeMovedHead;
    const { state: _afterState, ...afterFacts } = afterMovedHead;
    assert.deepEqual(afterFacts, beforeFacts, "a moved acceptance head must not alter the Producer/F5 denominator");
    const persisted = createSqliteDurableStore(evidencePath);
    try {
      persisted.bindStoreRole("searcher-production-evidence");
      assert.equal(persisted.readAppendLog(SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.performance).length, 100);
      assert.equal(persisted.readAppendLog(SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.producerTerminals).length, 100);
      const invalidRows = persisted.readAppendLog(SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.terminalPhase);
      assert.equal(invalidRows.length, 1, "one moved-head observation must produce one durable terminal fact");
      const invalidEvent = decodeCanonicalJson(invalidRows[0]!.bytes) as Record<string, unknown>;
      assert.equal((invalidEvent.payload as Record<string, unknown>).factId, invalid.factId);
    } finally {
      persisted.close();
    }
  } finally {
    await application.stop();
    await value.close();
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

test("application lifecycle detects a completed window after process restart without reading or replaying heads", { timeout: 120_000 }, async () => {
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "aloha-application-restart-before-terminal-"));
  const evidencePath = join(evidenceDirectory, "production-evidence.sqlite");
  const firstValue = await fixture();
  const firstServices = buildRuntimeReleaseComposition(firstValue.input);
  const first = openApplicationLifecycleFixture(firstValue, firstServices, evidencePath);
  try {
    await completeApplicationWindow(firstValue, first.application);
    assert.equal(first.application.telemetry().terminalCount, 100);
    assert.throws(() => first.application.readFullGraphCoarseSweep(), /not complete/);
  } finally {
    await first.application.stop();
    await firstValue.close();
  }

  const restartedValue = await fixture();
  const restartedServices = buildRuntimeReleaseComposition(restartedValue.input);
  assert.equal(restartedServices.release.bindingId, firstServices.release.bindingId);
  assert.equal(restartedServices.release.releaseProvenanceHash, firstServices.release.releaseProvenanceHash);
  const restarted = openApplicationLifecycleFixture(
    restartedValue,
    restartedServices,
    evidencePath,
    Object.freeze({
      bootId: "application-lifecycle-restarted-boot",
      invocationId: "application-lifecycle-restarted-invocation",
      pid: "43",
      processStartTicks: "8",
    }),
  );
  try {
    assert.equal(restarted.application.telemetry().terminalCount, 0, "restart must not re-mint Producer terminal capabilities");
    const requestsBeforeRun = restartedValue.runtimeRpcRequestCount();
    await assert.rejects(restarted.application.run(), /terminal-phase-process-anchor-changed/);
    assert.deepEqual(restarted.observations.calls(), { fullFamily: 0, sixStep: 0, terminal: 0 });
    assert.equal(restartedValue.runtimeRpcRequestCount(), requestsBeforeRun, "restart terminal handling must not read a new head");
    assert.equal(restarted.application.telemetry().terminalCount, 0);
    assert.throws(() => restarted.application.readFullGraphCoarseSweep(), /not complete/);
    const invalid = restarted.application.readTerminalPhaseInvalid();
    assert.ok(invalid);
    assert.equal(invalid.reasonCode, "terminal-phase-process-anchor-changed");
    assert.equal(invalid.observed, null);
    await assert.rejects(restarted.application.run(), /terminal-phase-process-anchor-changed/);
    assert.equal(restartedValue.runtimeRpcRequestCount(), requestsBeforeRun, "failed restart terminal phase must not retry");
  } finally {
    await restarted.application.stop();
    await restartedValue.close();
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

test("aborted application run publishes no sweep and stop remains single/idempotent", async () => {
  const value = await fixture();
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "aloha-application-abort-"));
  const services = buildRuntimeReleaseComposition(value.input);
  const { application } = openApplicationLifecycleFixture(
    value,
    services,
    join(evidenceDirectory, "production-evidence.sqlite"),
  );
  try {
    const controller = new AbortController();
    controller.abort("test-abort");
    await application.run(controller.signal);
    assert.equal(application.telemetry().terminalCount, 0);
    assert.equal(application.readTerminalPhaseInvalid(), null);
    assert.throws(() => application.readFullGraphCoarseSweep(), /not complete/);
    await Promise.all([application.stop(), application.stop(), application.stop()]);
    assert.equal(application.telemetry().state, "closed");
    await assert.rejects(
      application.submitHead(new Proxy({} as CanonicalHead, {
        get() { throw new TypeError("stopped application reached ingress"); },
      })),
      /admission is closed/,
    );
  } finally {
    await application.stop();
    await value.close();
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

test("release-owned performance evidence closes exact 100 complete heads and rejects a 101st append", async () => {
  const value = await fixture();
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "aloha-runtime-release-exact100-"));
  const evidencePath = join(evidenceDirectory, "production-evidence.sqlite");
  const services = buildRuntimeReleaseComposition(value.input);
  const catalog = services.catalog.loadExact();
  const generationAId = "exact100-generation-a";
  const generationBId = "exact100-generation-b";
  const firstHead = exact100Head(0, h("exact100-parent"));
  const firstFixture = createSearchTerminalFixture({ head: firstHead, generationId: generationAId, mode: "no-candidate" });
  const generationBSeedHead = exact100Head(20, h("exact100-generation-b-parent"));
  const generationBSeedFixture = createSearchTerminalFixture({ head: generationBSeedHead, generationId: generationBId, mode: "no-candidate" });
  const graphRootA = firstFixture.session.lease.binding.graphRoot;
  const graphRootB = generationBSeedFixture.session.lease.binding.graphRoot;
  const servingA = Object.freeze({
    ready: {
      releaseProvenanceHash: services.release.releaseProvenanceHash,
      definitionCatalogRoot: catalog.definitionCatalogRoot,
      readyRecordHash: h("exact100-ready-a"),
      sourceCoverageRoot: h("exact100-generation-source-coverage-a"),
    } as never,
    generationId: generationAId,
    graphRoot: graphRootA,
    readyRecordHash: h("exact100-ready-a"),
    sourceCoverageRoot: h("exact100-generation-source-coverage-a"),
    definitionCatalogRoot: catalog.definitionCatalogRoot,
    releaseProvenanceHash: services.release.releaseProvenanceHash,
  });
  const servingB = Object.freeze({
    ready: {
      releaseProvenanceHash: services.release.releaseProvenanceHash,
      definitionCatalogRoot: catalog.definitionCatalogRoot,
      readyRecordHash: h("exact100-ready-b"),
      sourceCoverageRoot: h("exact100-generation-source-coverage-b"),
    } as never,
    generationId: generationBId,
    graphRoot: graphRootB,
    readyRecordHash: h("exact100-ready-b"),
    sourceCoverageRoot: h("exact100-generation-source-coverage-b"),
    definitionCatalogRoot: catalog.definitionCatalogRoot,
    releaseProvenanceHash: services.release.releaseProvenanceHash,
  });
  const servingForGeneration = (requestedGenerationId: string) => {
    if (requestedGenerationId === generationAId) return servingA;
    if (requestedGenerationId === generationBId) return servingB;
    throw new TypeError("unknown exact100 generation");
  };
  const startup = issueStartupRuntime({
    ready: servingA.ready,
    familyRuntimeComposition: services.familyRuntime.openComposition(),
    generationId: generationAId,
    graphRoot: graphRootA,
    releaseBindingId: services.release.bindingId,
    candidateReleaseCommit: services.release.candidateReleaseCommit,
    canonicalSourceAuthority: value.input.checkpoint.canonical.authority,
    readActiveGeneration() {
      return servingA;
    },
    readServingGeneration(requestedGenerationId) {
      return servingForGeneration(requestedGenerationId);
    },
    readProducerSessionGeneration(session) {
      return servingForGeneration(session.generationId);
    },
    async withProducerSession() { throw new TypeError("exact-100 test owns Producer sessions directly"); },
    async waitForGenerationIdle() {},
    async close() {},
  });
  const evidence = issueSearcherProductionEvidenceOwnerV1({
    databasePath: evidencePath,
    economicSafety: services.economicSafety,
    release: {
      bindingId: services.release.bindingId,
      releaseProvenanceHash: services.release.releaseProvenanceHash,
      candidateReleaseCommit: services.release.candidateReleaseCommit,
    },
    runtimeAnchor: {
      kind: "aloha.searcher-runtime-anchor-v1",
      bindingId: services.release.bindingId,
      releaseProvenanceHash: services.release.releaseProvenanceHash,
      manifestHash: h("exact100-manifest"),
      manifestArtifactSha256: h("exact100-manifest-artifact"),
      runtimeArtifactRoot: h("exact100-runtime"),
      implementationClosureDigest: h("exact100-closure"),
      candidateReleaseCommit: services.release.candidateReleaseCommit,
      entrypointSha256: h("exact100-entrypoint"),
      nodeExecutableSha256: h("exact100-node"),
      bundleModulePath: "/opt/aloha/release.mjs",
      bundleModuleSha256: h("exact100-bundle"),
      serviceName: "aloha-searcher",
      systemdUnit: "aloha-searcher.service",
      bootId: "exact100-boot",
      invocationId: "exact100-invocation",
      logDevice: "8",
      logInode: "9",
      pid: "42",
      processStartTicks: "7",
      dryRun: true,
    },
  });
  const ports = evidence.bindServing(startup, services.performance);
  const fixtures = new Map<Hash, ReturnType<typeof createSearchTerminalFixture>>([[firstHead.hash, firstFixture]]);
  const generationForHead = (head: CanonicalHead) => BigInt(head.number) <= 120n ? generationAId : generationBId;
  const fixtureFor = (head: CanonicalHead) => {
    let current = fixtures.get(head.hash);
    if (current === undefined) {
      const generationId = generationForHead(head);
      current = createSearchTerminalFixture({ head, generationId, mode: "no-candidate" });
      const serving = servingForGeneration(generationId);
      if (current.session.lease.binding.graphRoot !== serving.graphRoot) throw new TypeError("exact-100 fixture Graph changed within generation");
      fixtures.set(head.hash, current);
    }
    return current;
  };
  let capturedFacts: ProducerHeadFactsCapabilityV1 | null = null;
  let capturedPerformanceTerminal: ProducerHeadTerminalCapabilityV1 | null = null;
  let capturedProducerTerminal: ProducerHeadTerminalCapabilityV1 | null = null;
  const producerOrdinalByHeight = new Map<string, string>();
  const runtime = new ProducerRuntimeV1({
    sessionOwner: issueProducerSessionOwnerV1({
      async withProducerSession(head, run) { return run(fixtureFor(head).session); },
    }),
    blockscan: issueProducerLanePortV1({
      kind: "blockscan",
      async run(request) { return (await fixtureFor(request.head).run(request)).draft; },
    }),
    backrun: issueProducerLanePortV1({
      kind: "backrun",
      run(request) {
        const intake = readIssuedProducerBackrunIntakeV1(request.input);
        return {
          kind: "no-input",
          absence: request.input as never,
          currentSource: fixtureFor(request.head).logicalFacts("backrun", intake.correlationId),
        };
      },
    }),
    currentSource: issueProducerCurrentSourceHeadPortV1({
      closeHead: session => fixtureFor(session.head).closePhysicalFacts(),
    }),
    performance: issueProducerPerformancePortV1<unknown>({
      acceptEligibleHead(input) {
        let ordinal = producerOrdinalByHeight.get(input.head.number);
        if (ordinal === undefined) {
          ordinal = (producerOrdinalByHeight.size + 1).toString();
          producerOrdinalByHeight.set(input.head.number, ordinal);
        }
        return Object.freeze({
          admissionId: hashDomain("test/runtime-release/producer-performance-admission/v1", { ordinal, head: input.head, revision: input.revision }),
          ordinal,
          headHash: input.head.hash,
          revision: input.revision,
        });
      },
      readEligibleHeadBinding(eligibleHead) {
        if (eligibleHead === null || typeof eligibleHead !== "object" || !("admissionId" in eligibleHead)) {
          throw new TypeError("exact-100 Producer eligible head is not owner-issued");
        }
        return eligibleHead as never;
      },
      bindEligibleHeadSession({ eligibleHead }) { return eligibleHead; },
      bindEligibleHeadFacts({ eligibleHead, facts }) { capturedFacts = facts; return eligibleHead; },
      sealHeadTerminal({ terminal }) { capturedPerformanceTerminal = terminal; },
    }),
    terminal: issueProducerTerminalPortV1({
      appendTerminal({ terminal }) { capturedProducerTerminal = terminal; },
    }),
  });
  try {
    try {
      let parentHash = firstHead.parentHash;
      let lastHead = firstHead;
      for (let index = 0; index < 100; index += 1) {
        const head = index === 0 ? firstHead : exact100Head(index, parentHash);
        const replacementHead: CanonicalHead | null = index === 0 ? Object.freeze({
          ...head,
          hash: h("exact100-head-0-replacement"),
          stateRoot: h("exact100-state-0-replacement"),
        }) : null;
        const eligibleHead = await ports.performance.acceptEligibleHead({ head, revision: "0" });
        if (replacementHead !== null) {
          const replayBeforePrematureReplacement = evidence.replay();
          await assert.rejects(
            async () => { await ports.performance.acceptEligibleHead({ head: replacementHead, revision: "1" }); },
            /active durable orphan terminal/,
          );
          assert.deepEqual(evidence.replay(), replayBeforePrematureReplacement, "premature replacement must not append evidence");
        }
        capturedFacts = null;
        capturedPerformanceTerminal = null;
        capturedProducerTerminal = null;
        const submission = await runtime.submit(await exact100IngressEnvelope(head));
        assert.equal(submission.accepted, true);
        await runtime.waitForIdle();
        assert.ok(capturedFacts);
        assert.ok(capturedPerformanceTerminal);
        assert.equal(capturedProducerTerminal, capturedPerformanceTerminal);
        await ports.performance.bindEligibleHeadSession({ eligibleHead, session: fixtureFor(head).session });
        await ports.performance.bindEligibleHeadFacts({ eligibleHead, facts: capturedFacts });
        await ports.performance.sealHeadTerminal({ eligibleHead, terminal: capturedPerformanceTerminal });
        await ports.terminal.appendTerminal({ terminal: capturedProducerTerminal });
        assert.equal(ports.window.isComplete(), index === 99);
        if (replacementHead !== null) {
          const orphanTerminal = capturedPerformanceTerminal;
          const replayBeforeInvalidReplacements = evidence.replay();
          await assert.rejects(
            async () => { await ports.performance.acceptEligibleHead({ head: replacementHead, revision: "2" }); },
            /active durable orphan terminal/,
          );
          await assert.rejects(
            async () => {
              await ports.performance.acceptEligibleHead({
                head: Object.freeze({ ...replacementHead, number: (BigInt(replacementHead.number) + 1n).toString() }),
                revision: "1",
              });
            },
            /lacks an active same-height orphan/,
          );
          assert.deepEqual(evidence.replay(), replayBeforeInvalidReplacements, "invalid replacement mutations must not append evidence");
          const replacementEligible = await ports.performance.acceptEligibleHead({ head: replacementHead, revision: "1" });
          capturedFacts = null;
          capturedPerformanceTerminal = null;
          capturedProducerTerminal = null;
          const replacementIngress = await exact100IngressEnvelope(replacementHead);
          const replacementSubmission = await runtime.submit({ ...replacementIngress, revision: "1" });
          assert.equal(replacementSubmission.accepted, true);
          await runtime.waitForIdle();
          assert.ok(capturedFacts);
          assert.ok(capturedPerformanceTerminal);
          assert.equal(capturedProducerTerminal, capturedPerformanceTerminal);
          await ports.performance.bindEligibleHeadSession({ eligibleHead: replacementEligible, session: fixtureFor(replacementHead).session });
          await assert.rejects(
            async () => {
              await ports.performance.bindEligibleHeadFacts({
                eligibleHead: structuredClone(replacementEligible),
                facts: capturedFacts!,
              });
            },
            /not owner-issued/,
          );
          await ports.performance.bindEligibleHeadFacts({ eligibleHead: replacementEligible, facts: capturedFacts });
          await ports.performance.sealHeadTerminal({ eligibleHead: replacementEligible, terminal: capturedPerformanceTerminal });
          await ports.terminal.appendTerminal({ terminal: capturedProducerTerminal });
          await assert.rejects(
            async () => { await ports.performance.sealHeadTerminal({ eligibleHead, terminal: orphanTerminal }); },
            /already sealed|not pending|terminal binding/,
          );
          assert.equal(ports.window.isComplete(), false);
          parentHash = replacementHead.hash;
          lastHead = replacementHead;
        } else {
          parentHash = head.hash;
          lastHead = head;
        }
      }
      const replayAt100 = evidence.replay();
      assert.equal(replayAt100.eligibleHeadCount, "101");
      assert.equal(replayAt100.orphanReplacementCount, "1");
      assert.equal(replayAt100.performanceFactsCompleteCount, "101");
      assert.equal(replayAt100.performanceFactsIncompleteCount, "0");
      assert.equal(replayAt100.producerTerminalCount, "101");
      assert.equal(replayAt100.terminalPhaseInvalidCount, "0");
      const finalWindowCapability = ports.window.readFinalDurableWindow();
      assert.ok(finalWindowCapability);
      const finalWindow = ports.window.readFinalDurableWindowBinding(finalWindowCapability);
      assert.equal(finalWindow.ordinal, "100");
      assert.equal(finalWindow.targetCount, "100");
      assert.deepEqual(finalWindow.head, lastHead);
      assert.equal(finalWindow.revision, "0");
      assert.equal(finalWindow.performanceAppend.namespace, SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.performance);
      assert.equal(finalWindow.producerTerminalAppend.namespace, SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.producerTerminals);
      assert.throws(
        () => ports.window.readFinalDurableWindowBinding(structuredClone(finalWindowCapability)),
        /not owner-issued/,
      );
      const nextHead = exact100Head(100, lastHead.hash);
      await assert.rejects(
        async () => { await ports.performance.acceptEligibleHead({ head: nextHead, revision: "0" }); },
        /performance window is complete/,
      );
      assert.deepEqual(evidence.replay(), replayAt100, "a rejected 101st head must not append an orphan event");
    } finally {
      await runtime.shutdown();
      await startup.close();
      evidence.close();
    }
    const observed = observeProductionPerformanceDatabaseV1(evidencePath);
    assert.equal(observed.status, "raw-complete", JSON.stringify(observed.reasons));
    assert.ok(observed.bundle);
    assert.equal(observed.bundle.heads.length, 100);
    assert.equal(observed.bundle.lineages.length, 1);
    assert.equal(observed.bundle.lineages[0]?.ordinal, "1");
    assert.equal(observed.bundle.lineages[0]?.replacementHeadRecordId, observed.bundle.heads[0]?.headRecordId);
    assert.equal(observed.bundle.terminals.length, 100);
    assert.equal(observed.bundle.windowReceipt.headCount, "100");
    assert.equal(observed.bundle.windowReceipt.healthyHeadCount, "100");
    assert.equal(observed.bundle.heads.every(head => head.candidateCount === "0"), true);
    assert.deepEqual(observed.bundle.generationSegments.map(segment => ({
      segmentOrdinal: segment.segmentOrdinal,
      firstHeadOrdinal: segment.firstHeadOrdinal,
      lastHeadOrdinal: segment.lastHeadOrdinal,
      generationId: segment.generationId,
      graphRoot: segment.graphRoot,
      readyRecordHash: segment.readyRecordHash,
      generationSourceCoverageRoot: segment.generationSourceCoverageRoot,
    })), [
      {
        segmentOrdinal: "1",
        firstHeadOrdinal: "1",
        lastHeadOrdinal: "20",
        generationId: generationAId,
        graphRoot: graphRootA,
        readyRecordHash: servingA.readyRecordHash,
        generationSourceCoverageRoot: servingA.sourceCoverageRoot,
      },
      {
        segmentOrdinal: "2",
        firstHeadOrdinal: "21",
        lastHeadOrdinal: "100",
        generationId: generationBId,
        graphRoot: graphRootB,
        readyRecordHash: servingB.readyRecordHash,
        generationSourceCoverageRoot: servingB.sourceCoverageRoot,
      },
    ]);
    assert.equal(observed.bundle.heads.some(item => item.sourceCoverageRoot !== servingForGeneration(item.generationId).sourceCoverageRoot), true, "per-head source coverage must remain distinct from generation source-plan coverage");
    const terminalByAdmission = new Map(observed.events
      .filter(event => event.eventType === "performance-facts-complete")
      .map(event => [event.payload.admissionId as Hash, event.payload.terminalMonotonicNs as string]));
    assert.equal(observed.events.filter(event => event.eventType === "eligible-head").some(event => {
      const terminalNs = terminalByAdmission.get(event.payload.admissionId as Hash);
      return terminalNs !== undefined
        && (BigInt(terminalNs) - BigInt(event.payload.acceptedMonotonicNs as string)) % 1_000n !== 0n;
    }), true, "real monotonic nanoseconds must be converted to integer microseconds without an exact-divisibility precondition");

    const replacementEvent = observed.events.find(event => event.eventType === "orphan-replacement");
    assert.ok(replacementEvent);
    const originalStore = createSqliteDurableStore(evidencePath);
    originalStore.bindStoreRole("searcher-production-evidence");
    const originalRow = originalStore.readAppendLog(SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.eligibleHeads)
      .find(row => row.sequence === replacementEvent.sequence);
    originalStore.close();
    assert.ok(originalRow);
    const originalPayload = replacementEvent.payload as Record<string, unknown>;
    const originalLineage = originalPayload.lineage as Record<string, unknown>;
    const replacementRevision = "2";
    const admissionId = hashDomain("aloha/searcher-production-evidence-admission/v1", {
      release: replacementEvent.release,
      runtimeAnchor: replacementEvent.runtimeAnchor,
      windowId: originalPayload.windowId,
      ordinal: originalPayload.ordinal,
      head: originalPayload.head,
      revision: replacementRevision,
      acceptedMonotonicNs: originalPayload.acceptedMonotonicNs,
    });
    const lineageWithoutId = {
      ...originalLineage,
      replacementAdmissionId: admissionId,
      replacementRevision,
    };
    delete (lineageWithoutId as { lineageId?: unknown }).lineageId;
    const lineage = Object.freeze({
      ...lineageWithoutId,
      lineageId: hashDomain("aloha/performance-admission-orphan-replacement/v1", lineageWithoutId),
    });
    const payload = Object.freeze({ ...originalPayload, admissionId, revision: replacementRevision, lineage });
    const eventWithoutId = { ...replacementEvent, payload };
    delete (eventWithoutId as { eventId?: unknown }).eventId;
    const eventId = hashDomain("aloha/searcher-production-evidence-event/v1", eventWithoutId);
    const bytes = encodeCanonicalBytes({ ...eventWithoutId, eventId });
    assert.equal(bytes.byteLength, originalRow.bytes.byteLength, "revision-gap mutation must preserve physical offsets");
    const require = createRequire(import.meta.url);
    const DatabaseSync = (require("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...parameters: readonly unknown[]): void };
        close(): void;
      };
    }).DatabaseSync;
    const rewriteReplacementRow = (nextEventId: Hash, nextBytes: Uint8Array): void => {
      const mutable = new DatabaseSync(evidencePath);
      try {
        mutable.exec("DROP TRIGGER durable_append_log_no_update");
        mutable.prepare(`
          UPDATE durable_append_log
          SET event_id=?, content_sha256=?, bytes=?, byte_length=?
          WHERE namespace=? AND sequence=?
        `).run(
          nextEventId,
          sha256Hex(nextBytes),
          nextBytes,
          nextBytes.byteLength.toString(),
          SEARCHER_PRODUCTION_EVIDENCE_NAMESPACES.eligibleHeads,
          replacementEvent.sequence,
        );
        mutable.exec(`
          CREATE TRIGGER durable_append_log_no_update
          BEFORE UPDATE ON durable_append_log
          BEGIN
            SELECT RAISE(ABORT, 'durable append-log is append-only');
          END
        `);
      } finally {
        mutable.close();
      }
    };
    rewriteReplacementRow(eventId, bytes);
    const revisionGap = observeProductionPerformanceDatabaseV1(evidencePath);
    assert.equal(revisionGap.status, "invalid");
    assert.match(revisionGap.reasons[0] ?? "", /advance exactly once/);

    rewriteReplacementRow(originalRow.eventId, originalRow.bytes);
    const splicedLineageWithoutId = {
      ...originalLineage,
      orphanProducerTerminalEventId: h("spliced-orphan-producer-terminal-event"),
    };
    delete (splicedLineageWithoutId as { lineageId?: unknown }).lineageId;
    const splicedPayload = Object.freeze({
      ...originalPayload,
      lineage: Object.freeze({
        ...splicedLineageWithoutId,
        lineageId: hashDomain("aloha/performance-admission-orphan-replacement/v1", splicedLineageWithoutId),
      }),
    });
    const splicedEventWithoutId = { ...replacementEvent, payload: splicedPayload };
    delete (splicedEventWithoutId as { eventId?: unknown }).eventId;
    const splicedEventId = hashDomain("aloha/searcher-production-evidence-event/v1", splicedEventWithoutId);
    const splicedBytes = encodeCanonicalBytes({ ...splicedEventWithoutId, eventId: splicedEventId });
    assert.equal(splicedBytes.byteLength, originalRow.bytes.byteLength, "terminal-event splice must preserve physical offsets");
    rewriteReplacementRow(splicedEventId, splicedBytes);
    const terminalSplice = observeProductionPerformanceDatabaseV1(evidencePath);
    assert.equal(terminalSplice.status, "invalid");
    assert.match(terminalSplice.reasons[0] ?? "", /exact durable orphan terminal join/);
  } finally {
    await runtime.shutdown();
    evidence.close();
    await value.close();
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});
