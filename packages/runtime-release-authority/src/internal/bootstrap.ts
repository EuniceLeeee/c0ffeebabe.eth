import type {
  AttestationServiceV1,
  InstanceDecisionV1,
  InstanceLifecycleSingleFlightPort,
  RejectionTransportExecutorV1,
} from "../../../../packages/attestation/src/index.ts";
import {
  createAttestationService,
  createFrameworkFailureRuntime,
  createRejectionExecutorAuthorityIssuer,
  createRejectionFactRuntime,
} from "../../../../packages/attestation/src/internal/composition.ts";
import {
  assertIssuedAttestationProgramPort,
  createAttestationProgramPortFromFamilyComposition,
} from "../../../../packages/attestation/src/internal/family-program-adapter.ts";
import type { CanonicalSource } from "../../../../packages/canonical-source/src/index.ts";
import type { CanonicalJson, Hash } from "../../../../packages/canonical-codec/src/index.ts";
import {
  createCandidatePartitionBootstrap,
  candidatePartitionBootstrapReader,
} from "../../../../packages/checkpoint/src/candidate-partition.ts";
import {
  createCheckpointStore,
  type CheckpointSixStepReadyEdgeInputV1,
  type CheckpointSixStepArtifactCapabilityV1,
  type CheckpointSixStepArtifactPortV1,
  type CheckpointStore,
} from "../../../../packages/checkpoint/src/index.ts";
import { issueCheckpointSixStepArtifactPortV1 } from "../../../../packages/checkpoint/src/internal/six-step-artifact-port-owner.ts";
import type { SQLiteDurableStore } from "../../../../packages/durable-store/src/index.ts";
import type { EconomicSafetyObjectiveTemplateV1 } from "../../../../packages/economics-safety/src/index.ts";
import {
  createQualifiedFinalSimulationPort,
  createRethQualifiedExecutorStateOwner,
  createSourceBoundExecutorProjection,
  type QualifiedFinalSimulationFactV1,
} from "../../../../packages/final-sim/src/index.ts";
import {
  issueQualifiedFinalSimulationPortFactoryV1,
  type QualifiedFinalSimulationPortFactoryV1,
} from "../../../../packages/final-sim/src/internal/final-simulation-owner.ts";
import {
  issueGeneratedFamilyLifecycleRuntimePort,
  issueGeneratedFamilySearchRuntimePort,
  readGeneratedFamilyRuntimeFactoryMetadata,
  readGeneratedFamilySourcePlanDeclarations,
  type GeneratedFamilySearchRuntimePortV1,
} from "../../../../packages/family-composition/src/internal/generated-runtime-composition.ts";
import type { FamilyRuntimeCompositionV1 } from "../../../../packages/family-composition/src/index.ts";
import {
  createReadyPromotionAuthority,
  ReadyGenerationServiceV1,
  type GenerationRefreshPolicyV1,
} from "../../../../packages/ready-generation/src/index.ts";
import {
  projectRuntimeAuthorityDescriptorV1,
  type RuntimeAuthorityProjectionV1,
} from "../../../../packages/runtime-authority/src/index.ts";
import { readQualifiedSharedSchedulerRuntimePort } from "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts";
import { RevmSimulationClient } from "../../../../runtime/revm-workers/src/index.ts";
import { RevmWorkerPool } from "../../../../runtime/revm-workers/src/lifecycle.ts";
import {
  startStartupRuntime,
  type StartupRuntimeV1,
} from "../../../../packages/startup-runtime/src/index.ts";
import { issueStartupReadyPort } from "../../../../packages/startup-runtime/src/internal/ready-owner.ts";
import { createSchedulerOwnedFamilyExecutionPort } from "../../../../packages/work-plane/src/internal/family-execution-port.ts";
import {
  createReleaseFamilyRuntimeComposition,
  createReleaseStrategyRuntimeComposition,
} from "../../../../generated/runtime-composition/index.ts";
import type { RuntimeAuthorityV1 } from "../index.ts";
import { createRuntimeDiscoveryPort, type RuntimeDiscoverySourceV1 } from "./discovery-owner.ts";
import { issueEconomicSafetyRuntimeServiceV1 } from "./economic-safety-owner.ts";
import { issueFamilyRuntimeAuthorityCapability } from "./family-runtime-owner.ts";
import { issueRuntimePersistedAttestationPort } from "./persisted-attestation-owner.ts";
import {
  issueRuntimeReleaseSearcherStartupService,
  type RuntimeReleaseSearcherStartupServiceV1,
} from "./searcher-startup-owner.ts";
import { assertActiveRuntimeAuthorityState } from "./state.ts";
import {
  issueStrategyRuntimeService,
  type StrategyRuntimeServiceV1,
} from "./strategy-runtime-owner.ts";
import {
  issueRuntimeInfrastructureV1,
  type RuntimeInfrastructureV1,
} from "./runtime-infrastructure-owner.ts";

export interface RuntimeCompositionInputV1 {
  readonly authority: RuntimeAuthorityV1;
  readonly durable: SQLiteDurableStore;
  readonly canonical: CanonicalSource;
  readonly source: RuntimeDiscoverySourceV1;
  readonly processEpoch: string;
  readonly revmWorkerExecutablePath: string;
  readonly generationPolicy: GenerationRefreshPolicyV1;
  readonly objectiveTemplates: readonly EconomicSafetyObjectiveTemplateV1[];
  readonly executor: Readonly<{
    readonly address: string;
    readonly callerAddress: string;
    readonly codeHash: Hash;
    readonly config: CanonicalJson;
    readonly accounts: readonly Readonly<{
      readonly address: string;
      readonly storageSlots: readonly string[];
    }>[];
  }>;
  readonly revm: Readonly<{
    readonly maxWorkers: number;
    readonly queueCap: number;
    readonly timeoutMs: number;
    readonly perOwnerConcurrency: number;
  }>;
}

export interface RuntimeCompositionServicesV1 {
  readonly runtimeAuthority: RuntimeAuthorityProjectionV1;
  readonly familyRuntime: FamilyRuntimeCompositionV1;
  readonly familySearchRuntime: GeneratedFamilySearchRuntimePortV1;
  readonly strategyRuntime: StrategyRuntimeServiceV1;
  readonly economicSafety: ReturnType<typeof issueEconomicSafetyRuntimeServiceV1>;
  readonly finalSimulationFactory: QualifiedFinalSimulationPortFactoryV1<QualifiedFinalSimulationFactV1>;
  readonly startup: RuntimeReleaseSearcherStartupServiceV1;
  readonly checkpoint: CheckpointStore;
  readonly revmPool: RevmWorkerPool;
  readonly infrastructure: RuntimeInfrastructureV1;
}

class RuntimeInstanceLifecycleV1 implements InstanceLifecycleSingleFlightPort {
  readonly #pending = new Map<Hash, Promise<InstanceDecisionV1>>();

  getOrBuild(key: Hash, build: () => Promise<InstanceDecisionV1>): Promise<InstanceDecisionV1> {
    const existing = this.#pending.get(key);
    if (existing !== undefined) return existing;
    const pending = Promise.resolve().then(build).finally(() => {
      if (this.#pending.get(key) === pending) this.#pending.delete(key);
    });
    this.#pending.set(key, pending);
    return pending;
  }
}

const FAIL_CLOSED_REJECTION_EXECUTOR: RejectionTransportExecutorV1 = Object.freeze({
  async execute(): Promise<never> {
    throw new TypeError("attestation rejection transport is unavailable");
  },
});

/** Preserve the actual Checkpoint outcome-to-edge parent relation without
 * replaying discovery, pricing, planning, exact, or simulation. */
function issueCheckpointInvocationParents(): CheckpointSixStepArtifactPortV1 {
  const stage1 = new WeakSet<object>();
  return issueCheckpointSixStepArtifactPortV1(Object.freeze({
    async emitVerifiedOutcome(): Promise<CheckpointSixStepArtifactCapabilityV1> {
      const capability = Object.freeze(Object.create(null));
      stage1.add(capability);
      return capability;
    },
    async emitReadyEdge(input: CheckpointSixStepReadyEdgeInputV1): Promise<CheckpointSixStepArtifactCapabilityV1> {
      if (input.parent === null || typeof input.parent !== "object" || !stage1.has(input.parent)) {
        throw new TypeError("checkpoint Ready edge parent is not from this invocation");
      }
      return Object.freeze(Object.create(null));
    },
  }));
}

function generatedCatalog() {
  const metadata = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
  return Object.freeze({
    definitionCatalogRoot: metadata.definitionCatalogRoot,
    declaredSourcePlans: Object.freeze(metadata.families
      .flatMap(family => family.sourcePlanRefs)
      .sort((left, right) => left.sourcePlanRef.localeCompare(right.sourcePlanRef))),
  });
}

/** Build the sole runtime composition. Every service is consumed by the same
 * canonical application invocation. */
export function buildRuntimeComposition(
  input: RuntimeCompositionInputV1,
): RuntimeCompositionServicesV1 {
  if (input === null || typeof input !== "object") throw new TypeError("runtime composition input is required");
  const authorityState = assertActiveRuntimeAuthorityState(input.authority);
  const runtimeAuthorityDescriptor = authorityState.descriptor;
  const runtimeAuthority = projectRuntimeAuthorityDescriptorV1(runtimeAuthorityDescriptor);
  const assertCurrent = (): void => {
    const current = assertActiveRuntimeAuthorityState(input.authority);
    if (current.version !== authorityState.version
      || current.descriptor.authorityBindingHash !== runtimeAuthority.authorityBindingHash
      || current.descriptor.implementationCommit !== runtimeAuthority.implementationCommit) {
      throw new TypeError("runtime composition authority is stale");
    }
  };

  const infrastructure = issueRuntimeInfrastructureV1({
    runtimeAuthority: runtimeAuthorityDescriptor,
    processEpoch: input.processEpoch,
    rpcEndpoint: input.source.endpoint,
    rpcTimeoutMs: input.source.timeoutMs,
    revmWorkerExecutablePath: input.revmWorkerExecutablePath,
  });
  const scheduler = readQualifiedSharedSchedulerRuntimePort(
    infrastructure.scheduler.runtime,
    infrastructure.scheduler.issuer,
    infrastructure.scheduler.capability,
  );
  const familyExecution = createSchedulerOwnedFamilyExecutionPort({
    issuer: infrastructure.scheduler.issuer,
    capability: infrastructure.scheduler.capability,
    physicalExecution: infrastructure.scheduler.physicalExecution,
  });
  const familyCapability = issueFamilyRuntimeAuthorityCapability({
    runtimeAuthority: runtimeAuthorityDescriptor,
    execution: familyExecution,
    factory: createReleaseFamilyRuntimeComposition,
    assertCurrent,
  });
  const familyRuntime = createReleaseFamilyRuntimeComposition(familyCapability);
  const familyLifecycle = issueGeneratedFamilyLifecycleRuntimePort(
    createReleaseFamilyRuntimeComposition,
    familyCapability,
  );
  const familySearchRuntime = issueGeneratedFamilySearchRuntimePort(
    createReleaseFamilyRuntimeComposition,
    familyCapability,
    familyLifecycle,
  );
  const sourcePlans = readGeneratedFamilySourcePlanDeclarations(
    createReleaseFamilyRuntimeComposition,
    familyCapability,
  );
  const catalog = generatedCatalog();

  const strategyRuntime = issueStrategyRuntimeService({
    runtimeAuthority: runtimeAuthorityDescriptor,
    factory: createReleaseStrategyRuntimeComposition,
    assertCurrent,
  });
  const schedulerProvenance = infrastructure.scheduler.issuer.provenance(
    infrastructure.scheduler.capability,
  );
  const frameworkRuntime = createFrameworkFailureRuntime(runtimeAuthority, {
    classify() { return null; },
  });
  const rejectionIssuer = createRejectionExecutorAuthorityIssuer({
    runtimeAuthority,
    workerEpoch: schedulerProvenance.workerEpoch,
    executorSessionHash: schedulerProvenance.executorSession,
  });
  const candidatePartitionBootstrap = createCandidatePartitionBootstrap();
  const candidatePartitionReader = candidatePartitionBootstrapReader(candidatePartitionBootstrap);
  const programs = assertIssuedAttestationProgramPort(
    createAttestationProgramPortFromFamilyComposition({ lifecycle: familyLifecycle }),
    runtimeAuthority,
  );
  const attestation: AttestationServiceV1 = createAttestationService({
    runtimeAuthority,
    frameworkRuntime,
    rejectionRuntime: createRejectionFactRuntime(
      rejectionIssuer.issue(FAIL_CLOSED_REJECTION_EXECUTOR),
    ),
    programs,
    instanceLifecycle: new RuntimeInstanceLifecycleV1(),
    candidatePartitionReader,
  });

  const promotionAuthority = createReadyPromotionAuthority(
    () => ({ definitionCatalogRoot: catalog.definitionCatalogRoot, policy: input.generationPolicy }),
    input.authority.readyGeneration,
  );
  const checkpointCaller = Object.freeze(Object.create(null));
  const checkpoint = createCheckpointStore(
    input.durable,
    input.canonical,
    checkpointCaller,
    promotionAuthority,
    attestation.validationAuthority,
    issueCheckpointInvocationParents(),
    candidatePartitionBootstrap,
  );
  const persistedAttestation = issueRuntimePersistedAttestationPort(
    input.authority,
    attestation,
    checkpoint,
  );
  const readyCaller = Object.freeze(Object.create(null));
  const readyService = new ReadyGenerationServiceV1(
    readyCaller,
    checkpoint,
    input.canonical,
    () => process.hrtime.bigint().toString(),
    () => catalog,
    promotionAuthority,
    checkpoint.sealedRunReader,
    input.authority.readyGeneration,
  );
  const ready = issueStartupReadyPort({ service: readyService, promotionCaller: readyCaller });
  const discovery = createRuntimeDiscoveryPort({
    bindings: sourcePlans,
    source: input.source,
    scheduler,
    runtime: { runtimeAuthority, processEpoch: input.processEpoch },
    assertCurrent,
  });

  const revmPool = new RevmWorkerPool({
    factory: infrastructure.revm.deployment.factory,
    qualification: infrastructure.revm.deployment.qualification,
    authority: infrastructure.revm.authority,
    maxWorkers: input.revm.maxWorkers,
    queueCap: input.revm.queueCap,
    timeoutMs: input.revm.timeoutMs,
    perOwnerConcurrency: input.revm.perOwnerConcurrency,
  });
  const executorState = createRethQualifiedExecutorStateOwner({
    endpoint: input.source.endpoint,
    timeoutMs: input.source.timeoutMs,
  });
  const finalSimulationFactory = issueQualifiedFinalSimulationPortFactoryV1<QualifiedFinalSimulationFactV1>({
    async issue(_currentSource, currentSourceCapability) {
      assertCurrent();
      const snapshot = await executorState.issue({
        session: currentSourceCapability,
        authority: infrastructure.revm.authority,
        executorAddress: input.executor.address,
        callerAddress: input.executor.callerAddress,
        qualifiedExecutorCodeHash: input.executor.codeHash,
        executorConfig: input.executor.config,
        accounts: input.executor.accounts,
      });
      return createQualifiedFinalSimulationPort({
        scheduler,
        client: new RevmSimulationClient({ pool: revmPool }),
        qualification: infrastructure.executorQualification,
        schemaHash: infrastructure.executorQualification.schemaFingerprint,
        projection: createSourceBoundExecutorProjection({
          snapshot,
          authority: infrastructure.revm.authority,
        }),
      });
    },
  });
  const economicSafety = issueEconomicSafetyRuntimeServiceV1({
    runtimeAuthority: runtimeAuthorityDescriptor,
    familyRuntimeFactory: createReleaseFamilyRuntimeComposition,
    familyRuntimeComposition: familyRuntime,
    objectiveTemplates: input.objectiveTemplates,
    executorQualification: Object.freeze({
      executorKind: infrastructure.executorQualification.executorKind,
      engineBuildFingerprint: infrastructure.executorQualification.engineBuildFingerprint,
      executableFingerprint: infrastructure.executorQualification.executableFingerprint,
      qualifiedExecutorRegistryRoot: infrastructure.executorQualification.qualifiedExecutorRegistryRoot,
      selectedExecutorLeafHash: infrastructure.executorQualification.selectedExecutorLeafHash,
      releaseRoleManifestRoot: infrastructure.executorQualification.releaseRoleManifestRoot,
    }),
    assertCurrent,
  });

  let startupPromise: Promise<StartupRuntimeV1> | null = null;
  const start = async (signal = new AbortController().signal): Promise<StartupRuntimeV1> => {
    assertCurrent();
    if (startupPromise === null) {
      startupPromise = startStartupRuntime({
        policy: input.generationPolicy,
        catalog: Object.freeze({ loadExact: () => catalog }),
        checkpoint,
        canonical: input.canonical,
        discovery,
        attestation: persistedAttestation,
        ready,
        familyRuntime,
        familySearchRuntime,
        processEpoch: input.processEpoch,
        runtimeAuthority,
      }, signal).catch(error => {
        startupPromise = null;
        throw error;
      });
    }
    return startupPromise;
  };
  const startup = issueRuntimeReleaseSearcherStartupService({
    authority: input.authority,
    ready,
    start,
  });
  assertCurrent();
  return Object.freeze({
    runtimeAuthority,
    familyRuntime,
    familySearchRuntime,
    strategyRuntime,
    economicSafety,
    finalSimulationFactory,
    startup,
    checkpoint,
    revmPool,
    infrastructure,
  });
}
