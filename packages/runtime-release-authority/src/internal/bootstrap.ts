import type {
  AttestationServiceConstructorV1,
  AttestationServiceV1,
  AttestationCompositionBindingV1,
} from "../../../../packages/attestation/src/index.ts";
import { createAttestationProgramPortFromFamilyComposition } from "../../../../packages/attestation/src/internal/family-program-adapter.ts";
import { createAttestationService } from "../../../../packages/attestation/src/internal/composition.ts";
import type {
  CandidatePartitionProofIssuerPortV1,
  CandidatePartitionReaderPortV1,
} from "../../../../specs/candidate-partition-authority/src/index.ts";
import {
  createCandidatePartitionBootstrap,
  candidatePartitionBootstrapReader,
} from "../../../../packages/checkpoint/src/candidate-partition.ts";
import {
  createCheckpointStore,
  type CheckpointStore,
} from "../../../../packages/checkpoint/src/index.ts";
import type { ProcessAnchorV1 } from "../../../../specs/core-envelope/src/index.ts";
import type { CanonicalSource } from "../../../../packages/canonical-source/src/index.ts";
import type { SQLiteDurableStore } from "../../../../packages/durable-store/src/index.ts";
import { decodeSourcePlanRef, type SourcePlanRefV1 } from "../../../../packages/discovery/src/index.ts";
import {
  createReadyPromotionAuthority,
  generationRefreshPolicyHash,
  ReadyGenerationServiceV1,
  type GenerationRefreshPolicyV1,
} from "../../../../packages/ready-generation/src/index.ts";
import type { RuntimeReleaseReadyBindingPortV1 } from "../../../../specs/release-authority/src/index.ts";
import {
  decodeRuntimeReleaseQualifiedCapabilityProjectionV1,
  runtimeReleaseBindingProvenanceHash,
  type ReleaseQualifiedCapabilityRefV1,
  type RuntimeReleaseQualifiedCapabilityProjectionV1,
} from "../../../../specs/release-authority/src/index.ts";
import type {
  QualifiedExecutorAuthorityCapability,
  QualifiedExecutorAuthorityIssuer,
  WorkScheduler,
} from "../../../../packages/scheduler/src/index.ts";
import {
  readQualifiedSharedSchedulerRuntimePort,
  type QualifiedSharedSchedulerRuntimePortV1,
} from "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts";
import {
  assertQualifiedPhysicalExecutionSchedulerRuntime,
  createSchedulerOwnedFamilyExecutionPort,
} from "../../../../packages/work-plane/src/internal/family-execution-port.ts";
import type {
  FamilyFrozenProgramExecutionPort,
  QualifiedPhysicalExecutionPortV1,
} from "../../../../packages/work-plane/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import type { FamilyRuntimeCompositionV1 } from "../../../../packages/family-composition/src/index.ts";
import {
  createReleaseFamilyRuntimeComposition,
  createReleaseStrategyRuntimeComposition,
} from "../../../../generated/runtime-composition/index.ts";
import {
  readGeneratedFamilyRuntimeFactoryMetadata,
  readGeneratedFamilySourcePlanRuntimes,
} from "../../../../packages/family-composition/src/internal/generated-runtime-composition.ts";
import {
  issueRuntimeReleaseFamilyRuntimeAuthorityCapability,
} from "./family-runtime-owner.ts";
import type { RuntimeReleaseAttestationProofPortV1 } from "./attestation-proof-owner.ts";
import { issueRuntimeReleaseAttestationComposition } from "./attestation-composition-owner.ts";
import { issueRuntimeReleaseAttestationProofPort } from "./attestation-proof-owner.ts";
import { issueRuntimeReleaseCandidatePartitionProofIssuer } from "./candidate-partition-proof-owner.ts";
import { issueRuntimeReleaseNominationQualificationVerifier } from "./nomination-qualification-owner.ts";
import {
  assertRuntimeReleaseQualifiedExecutorAuthorityInitialCapability,
  issueRuntimeReleaseQualifiedExecutorAuthorityIssuer,
} from "./scheduler-authority-owner.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";
import {
  issueRuntimeReleaseRevmWorkerAuthorityIssuer,
  readRuntimeReleaseRevmWorkerDeploymentPort,
  type RuntimeReleaseRevmWorkerDeploymentPortV1,
} from "./revm-worker-owner.ts";
import { RevmWorkerPool } from "../../../../runtime/revm-workers/src/lifecycle.ts";
import { RevmSimulationClient } from "../../../../runtime/revm-workers/src/index.ts";
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
import { hashDomain, type CanonicalJson, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { startStartupRuntime, type StartupRuntimeV1 } from "../../../../packages/startup-runtime/src/index.ts";
import { issueStartupReadyPort } from "../../../../packages/startup-runtime/src/internal/ready-owner.ts";
import {
  createRuntimeReleaseDiscoveryPort,
  type RuntimeReleaseSourcePlanBindingV1,
} from "./discovery-owner.ts";
import {
  readRuntimeReleaseQualifiedDiscoverySourcePort,
  type RuntimeReleaseQualifiedDiscoverySourcePortV1,
} from "./discovery-source-authority-owner.ts";
import { issueRuntimeReleasePersistedAttestationPort } from "./persisted-attestation-owner.ts";
import {
  issueRuntimeReleaseStrategyRuntimeService,
  type RuntimeReleaseStrategyRuntimeServiceV1,
} from "./strategy-runtime-owner.ts";
import {
  issueRuntimeReleasePerformanceRuntimeService,
  type RuntimeReleasePerformanceRuntimeServiceV1,
} from "./performance-runtime-owner.ts";
import type {
  RuntimeReleasePerformancePolicyPortV1,
} from "./performance-policy-owner.ts";
import type { EconomicSafetyFinalizationServiceV1 } from "../../../../packages/economics-safety/src/index.ts";
import {
  issueRuntimeReleaseEconomicSafetyServiceV1,
  type RuntimeReleaseEconomicSafetyEvaluatorCapabilityV1,
} from "./economic-safety-owner.ts";
import {
  issueRuntimeReleaseSearcherStartupService,
  type RuntimeReleaseSearcherStartupServiceV1,
} from "./searcher-startup-owner.ts";
import {
  issueRuntimeReleaseFullFamilyTerminalBindingServiceV1,
  type RuntimeReleaseFullFamilyTerminalBindingServiceV1,
} from "./full-family-terminal-owner.ts";
import {
  issueRuntimeReleaseFullGraphCoarseSweepServiceV1,
  type RuntimeReleaseFullGraphCoarseSweepServiceV1,
} from "./full-graph-coarse-sweep-owner.ts";
import {
  issueRuntimeReleaseSixStepTerminalBindingServiceV1,
  type RuntimeReleaseSixStepTerminalBindingServiceV1,
} from "./six-step-terminal-owner.ts";
import {
  issueRuntimeReleaseObserverStoreServiceV1,
  type RuntimeReleaseObserverStoreServiceV1,
} from "./observer-store-owner.ts";
import { readReleaseOwnedObserverStoreV1 } from "../../../../acceptance/collectors/src/internal/release-owned-observer-store.ts";
import { issueRuntimeReleaseSixStepProductionV1 } from "./six-step-production-owner.ts";

export type { RuntimeReleaseStrategyRuntimeServiceV1 } from "./strategy-runtime-owner.ts";
export type { RuntimeReleaseFullFamilyTerminalBindingServiceV1 } from "./full-family-terminal-owner.ts";
export type { RuntimeReleaseFullGraphCoarseSweepServiceV1 } from "./full-graph-coarse-sweep-owner.ts";
export type { RuntimeReleaseSixStepTerminalBindingServiceV1 } from "./six-step-terminal-owner.ts";

export interface RuntimeReleaseCheckpointInputV1 {
  readonly durable: SQLiteDurableStore;
  readonly canonical: CanonicalSource;
}

export interface RuntimeReleaseSchedulerInputV1<Fact> {
  /** Already-issued by deployment-side qualified executor composition. */
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  /** Capability issued by the same external issuer. */
  readonly capability: QualifiedExecutorAuthorityCapability;
  /** Owner-issued physical executor edge; raw callbacks never enter release bootstrap. */
  readonly physicalExecution: QualifiedPhysicalExecutionPortV1<Fact>;
  /** One owner-issued scheduler shared by physical execution and startup discovery. */
  readonly runtime: QualifiedSharedSchedulerRuntimePortV1;
}

export interface RuntimeReleaseRevmInputV1 {
  /** Deployment-issued and signed-runtime-bound; raw structural inputs are rejected. */
  readonly deploymentPort: RuntimeReleaseRevmWorkerDeploymentPortV1;
  readonly maxWorkers?: number;
  readonly queueCap?: number;
  readonly timeoutMs?: number;
  readonly perOwnerConcurrency?: number;
}

export interface RuntimeReleaseReadyInputV1 {
  /** Policy is data; the promotion authority is created inside this release join. */
  readonly policy: GenerationRefreshPolicyV1;
  /** Monotonic clock used for the durable promotion receipt. */
  readonly monotonicNow: () => string;
}

export interface RuntimeReleasePerformanceInputV1 {
  /** Phase owner-issued profile/hardware/provider/release policy. */
  readonly policy: RuntimeReleasePerformancePolicyPortV1;
}

export interface RuntimeReleaseFinalSimulationInputV1 {
  readonly endpoint: string;
  readonly timeoutMs?: number;
  readonly executorAddress: string;
  readonly callerAddress: string;
  readonly qualifiedExecutorCodeHash: Hash;
  readonly executorConfig: CanonicalJson;
  readonly accounts: readonly Readonly<{
    readonly address: string;
    readonly storageSlots: readonly string[];
  }>[];
}

/**
 * The catalog projection is an external release fact, not an authority.  It
 * is decoded and joined to the verified RuntimeReleaseBinding before any
 * catalog is exposed.  Source plans remain deployment data; the definition
 * root and source plans are always taken from the generated catalog/runtime
 * descriptor. Deployment cannot omit a Family plan or widen its semantics.
 */
export interface RuntimeReleaseCatalogInputV1 {
  readonly qualifiedCapabilityProjection: unknown;
}

export interface RuntimeReleaseCatalogSnapshotV1 {
  readonly bindingId: `0x${string}`;
  readonly releaseProvenanceHash: `0x${string}`;
  readonly definitionCatalogRoot: `0x${string}`;
  readonly qualifiedCapabilityRefsRoot: `0x${string}`;
  readonly qualifiedCapabilityRefs: readonly ReleaseQualifiedCapabilityRefV1[];
  readonly declaredSourcePlans: readonly SourcePlanRefV1[];
}

export interface RuntimeReleaseCatalogServiceV1 {
  readonly loadExact: () => RuntimeReleaseCatalogSnapshotV1;
}

export interface RuntimeReleaseCompositionInputV1<Fact> {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly catalog: RuntimeReleaseCatalogInputV1;
  readonly attestation: {
    readonly proofPort: RuntimeReleaseAttestationProofPortV1;
    /** Build only framework/rejection/lifecycle ports after release composition is issued. */
    readonly build: (
      composition: AttestationCompositionBindingV1,
      candidatePartitionReader: CandidatePartitionReaderPortV1,
    ) => Omit<AttestationServiceConstructorV1, "composition" | "candidatePartitionReader" | "programs">;
  };
  /** Already-issued by deployment-side candidate-partition proof composition. */
  readonly candidatePartitionProofIssuer: CandidatePartitionProofIssuerPortV1;
  readonly checkpoint: RuntimeReleaseCheckpointInputV1;
  readonly scheduler: RuntimeReleaseSchedulerInputV1<Fact>;
  readonly revm: RuntimeReleaseRevmInputV1;
  readonly ready: RuntimeReleaseReadyInputV1;
  /** Exact deployment package facts; decoded and release-joined by the performance owner. */
  readonly performance: RuntimeReleasePerformanceInputV1;
  /** Deployment data only. The current-source state owner and executable
   * final-simulation factory are created inside this release closure. */
  readonly finalSimulation: RuntimeReleaseFinalSimulationInputV1;
  /** Optional deployment-packaging capability. Absence stays owner-issued but fail-closed. */
  readonly economicSafetyEvaluator?: RuntimeReleaseEconomicSafetyEvaluatorCapabilityV1;
  /**
   * Startup-only ports. The release bootstrap owns the ReadyGeneration
   * service, canonical source and promotion caller; callers provide only the
   * already-composed discovery/attestation ports and a process epoch.
   */
  readonly startup: {
    /** Opaque deployment-qualified Reth source; raw URL/config cannot cross this seam. */
    readonly source: RuntimeReleaseQualifiedDiscoverySourcePortV1;
    readonly processEpoch: string;
  };
  /** Release- and process-owned physical evidence storage. No caller-supplied
   * append callback or stage port crosses this seam. */
  readonly sixStep: Readonly<{
    readonly process: ProcessAnchorV1;
    readonly emitterCodeHash: Hash;
    readonly observerContentDirectory: string;
    readonly evidenceDirectory: string;
  }>;
}

export interface RuntimeReleaseCompositionServicesV1<Fact> {
  /** Public Attestation facade; its validation authority stays checkpoint-private. */
  readonly attestation: Pick<AttestationServiceV1, "openRunSession">;
  readonly checkpoint: CheckpointStore;
  /** Release-bound generated definition catalog plus externally qualified refs. */
  readonly catalog: RuntimeReleaseCatalogServiceV1;
  readonly familyExecution: FamilyFrozenProgramExecutionPort<Fact>;
  readonly revmPool: Pick<RevmWorkerPool, "submit" | "snapshot" | "retireAll">;
  /** Final release-owned Family runtime seam; no deployment callback or raw authority set. */
  readonly familyRuntime: RuntimeReleaseFamilyRuntimeServiceV1;
  /** Generated Strategy composition bound to the same release authority. */
  readonly strategyRuntime: RuntimeReleaseStrategyRuntimeServiceV1;
  /** Release-owned scheduler/resource fact port; issuer and raw readers stay private. */
  readonly performance: RuntimeReleasePerformanceRuntimeServiceV1;
  /** Release-bound final economics/safety authority used between final-sim and dry-run. */
  readonly economicSafety: EconomicSafetyFinalizationServiceV1;
  /** Candidate-owned Reth/REVM final simulation; no deployment callback. */
  readonly finalSimulationFactory: QualifiedFinalSimulationPortFactoryV1<QualifiedFinalSimulationFactV1>;
  /** Branded startup service closing over the owner-issued Ready port. */
  readonly startup: RuntimeReleaseSearcherStartupServiceV1;
  /** Exact search-terminal/native-audit binding, fenced by this release. */
  readonly fullFamilyTerminalBinding: RuntimeReleaseFullFamilyTerminalBindingServiceV1;
  /** Explicit acceptance-only complete-Graph coarse observation. It is never
   * invoked by startup producer lanes or planner/ranking. */
  readonly fullGraphCoarseSweep: RuntimeReleaseFullGraphCoarseSweepServiceV1;
  /** Successful owner-issued Stage 3-6 trace fenced by this exact release and Strategy composition. */
  readonly sixStepTerminalBinding: RuntimeReleaseSixStepTerminalBindingServiceV1;
  /** Lightweight release-owned observer store. It carries no repository/Git
   * material observers into the runtime bundle. */
  readonly observerStore: RuntimeReleaseObserverStoreServiceV1;
  /** Non-sensitive identity for logs/lineage; no signer, resolver, or issuer. */
  readonly release: Readonly<{
    readonly bindingId: `0x${string}`;
    readonly releaseProvenanceHash: `0x${string}`;
    readonly candidateReleaseCommit: `${string}`;
    readonly releaseAuthorityRoot: `0x${string}`;
    readonly executorAuthorityRoot: `0x${string}`;
    readonly workerEpoch: string;
    readonly executorSessionHash: `0x${string}`;
    readonly qualifiedCapabilityRefsRoot: `0x${string}`;
  }>;
}

export interface RuntimeReleaseFamilyRuntimeServiceV1 {
  /** The only production Family composition entry; it is release-guarded and memoized by generated code. */
  readonly openComposition: () => FamilyRuntimeCompositionV1;
}

interface RuntimeReleasePrivatePortsV1 {
  readonly attestationComposition: AttestationCompositionBindingV1;
  readonly candidatePartitionProofIssuer: CandidatePartitionProofIssuerPortV1;
  readonly schedulerIssuer: QualifiedExecutorAuthorityIssuer;
  readonly scheduler: WorkScheduler;
  readonly familyExecution: FamilyFrozenProgramExecutionPort<unknown>;
  readonly readyBinding: RuntimeReleaseReadyBindingPortV1;
  readonly familyRuntime: RuntimeReleaseFamilyRuntimeServiceV1;
  /** Private generated source-plan runtimes; only the release-owned discovery port consumes them. */
  readonly sourcePlans: readonly RuntimeReleaseSourcePlanBindingV1[];
}

const privatePortStates = new WeakMap<object, { readonly authority: RuntimeReleaseAuthorityV1; readonly version: bigint }>();

/** Single internal join used by the production bootstrap and its boundary tests. */
function composeRuntimeReleasePrivatePorts<Fact>(input: {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly attestationProofPort: RuntimeReleaseAttestationProofPortV1;
  readonly candidatePartitionProofIssuer: CandidatePartitionProofIssuerPortV1;
  readonly schedulerIssuer: QualifiedExecutorAuthorityIssuer;
  /** Deployment-created initial capability; joined here, before any public service is built. */
  readonly schedulerCapability: QualifiedExecutorAuthorityCapability;
  readonly schedulerRuntime: QualifiedSharedSchedulerRuntimePortV1;
  readonly physicalExecution: RuntimeReleaseSchedulerInputV1<Fact>["physicalExecution"];
}): RuntimeReleasePrivatePortsV1 {
  const state = assertActiveRuntimeReleaseAuthorityState(input.authority);
  const proofCapability = issueRuntimeReleaseAttestationProofPort(input.authority, input.attestationProofPort);
  const schedulerIssuer = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(input.authority, input.schedulerIssuer);
  assertRuntimeReleaseQualifiedExecutorAuthorityInitialCapability(
    input.authority,
    schedulerIssuer,
    input.schedulerCapability,
  );
  const scheduler = readQualifiedSharedSchedulerRuntimePort(
    input.schedulerRuntime,
    schedulerIssuer,
    input.schedulerCapability,
  );
  assertQualifiedPhysicalExecutionSchedulerRuntime(
    input.physicalExecution,
    input.schedulerRuntime,
    schedulerIssuer,
    input.schedulerCapability,
  );
  // The physical execution port is built before Family composition. Every
  // generated stage executor below is derived from this one owner-issued
  // identity; no deployment stage callback can enter the composition root.
  const familyExecutionInternal = createSchedulerOwnedFamilyExecutionPort({
    issuer: schedulerIssuer,
    capability: input.schedulerCapability,
    physicalExecution: input.physicalExecution,
  });
  const familyRuntimeCapability = issueRuntimeReleaseFamilyRuntimeAuthorityCapability(
    input.authority,
    familyExecutionInternal,
    createReleaseFamilyRuntimeComposition,
  );
  const sourcePlans = readGeneratedFamilySourcePlanRuntimes(
    createReleaseFamilyRuntimeComposition,
    familyRuntimeCapability,
  );
  const nominationQualifications = issueRuntimeReleaseNominationQualificationVerifier(
    input.authority,
    createReleaseFamilyRuntimeComposition,
    familyRuntimeCapability,
  );
  let ports: RuntimeReleasePrivatePortsV1;
  const familyRuntime = Object.freeze({
    openComposition(): FamilyRuntimeCompositionV1 {
      assertRuntimeReleasePrivatePortsCurrent(ports);
      return createReleaseFamilyRuntimeComposition(familyRuntimeCapability);
    },
  });
  ports = Object.freeze({
    attestationComposition: issueRuntimeReleaseAttestationComposition(input.authority, proofCapability),
    candidatePartitionProofIssuer: issueRuntimeReleaseCandidatePartitionProofIssuer(
      input.authority,
      input.candidatePartitionProofIssuer,
      nominationQualifications,
    ),
    schedulerIssuer,
    scheduler,
    familyExecution: familyExecutionInternal as FamilyFrozenProgramExecutionPort<unknown>,
    readyBinding: input.authority.readyGeneration,
    familyRuntime,
    sourcePlans,
  });
  privatePortStates.set(ports, { authority: input.authority, version: state.version });
  return ports;
}

function assertRuntimeReleasePrivatePortsCurrent(value: RuntimeReleasePrivatePortsV1): void {
  const issued = privatePortStates.get(value);
  if (!issued) throw new TypeError("runtime release private ports not composed");
  const current = assertActiveRuntimeReleaseAuthorityState(issued.authority);
  if (current.version !== issued.version) throw new TypeError("runtime release private ports stale after rotation");
  value.readyBinding.currentProvenanceHash();
  value.candidatePartitionProofIssuer.currentRelease();
}

/**
 * Deployment-only composition root.  It consumes one verified runtime
 * authority and returns only final services.  The authority, signer pin,
 * rotation, and all downstream issuer capabilities remain private to this
 * function and its private wrappers.
 */
function releaseGuardedFacade<Service extends object>(
  ports: RuntimeReleasePrivatePortsV1,
  service: Service,
): Service {
  return new Proxy(service, {
    get(target, property) {
      assertRuntimeReleasePrivatePortsCurrent(ports);
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: readonly unknown[]) => {
        assertRuntimeReleasePrivatePortsCurrent(ports);
        return Reflect.apply(value, target, args);
      };
    },
  });
}

function releaseGuardedCatalogFacade(
  ports: RuntimeReleasePrivatePortsV1,
  catalog: RuntimeReleaseCatalogServiceV1,
): RuntimeReleaseCatalogServiceV1 {
  // The catalog is frozen and its method is a non-configurable own property;
  // wrapping it in the generic Proxy facade would violate the Proxy get
  // invariant by returning a different function object.  Use a fresh narrow
  // service instead, preserving the same release fence without exposing the
  // internal object.
  return Object.freeze({
    loadExact() {
      assertRuntimeReleasePrivatePortsCurrent(ports);
      return catalog.loadExact();
    },
  });
}

function createRuntimeReleaseCatalog(
  authority: RuntimeReleaseAuthorityV1,
  input: RuntimeReleaseCatalogInputV1,
): RuntimeReleaseCatalogServiceV1 {
  const state = assertActiveRuntimeReleaseAuthorityState(authority);
  const projection: RuntimeReleaseQualifiedCapabilityProjectionV1 =
    decodeRuntimeReleaseQualifiedCapabilityProjectionV1(input.qualifiedCapabilityProjection);
  const release = state.binding;
  const provenanceHash = runtimeReleaseBindingProvenanceHash(release);
  const generated = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
  if (projection.bindingId !== release.bindingId) throw new TypeError("qualified capability catalog binding mismatch");
  if (projection.releaseProvenanceHash !== provenanceHash) throw new TypeError("qualified capability catalog provenance mismatch");
  if (projection.qualifiedCapabilityRefsRoot !== release.qualifiedCapabilityRefsRoot) {
    throw new TypeError("qualified capability catalog root mismatch");
  }
  if (projection.qualifiedCapabilityRefsRoot !== generated.proposedCapabilitySetRoot) {
    throw new TypeError("generated catalog capability root mismatch");
  }
  const generatedPlans = generated.families.flatMap(family => family.sourcePlanRefs);
  const declaredSourcePlans = Object.freeze(generatedPlans.map((plan, index) =>
    decodeSourcePlanRef(plan, `runtimeRelease.catalog.declaredSourcePlans[${index}]`),
  ).sort((left, right) => left.sourcePlanRef.localeCompare(right.sourcePlanRef)));
  if (declaredSourcePlans.length === 0) throw new TypeError("generated catalog has no declared source plans");
  if (new Set(declaredSourcePlans.map(plan => plan.sourcePlanRef)).size !== declaredSourcePlans.length) {
    throw new TypeError("generated catalog contains duplicate source plans");
  }
  const snapshot = Object.freeze({
    bindingId: release.bindingId,
    releaseProvenanceHash: provenanceHash,
    definitionCatalogRoot: generated.definitionCatalogRoot,
    qualifiedCapabilityRefsRoot: projection.qualifiedCapabilityRefsRoot,
    qualifiedCapabilityRefs: Object.freeze([...projection.refs]),
    declaredSourcePlans,
  });
  return Object.freeze({
    loadExact() {
      const current = assertActiveRuntimeReleaseAuthorityState(authority);
      if (current.binding.bindingId !== snapshot.bindingId || runtimeReleaseBindingProvenanceHash(current.binding) !== snapshot.releaseProvenanceHash) {
        throw new TypeError("runtime release catalog stale after rotation");
      }
      return snapshot;
    },
  });
}

function assertExactStartupInput(value: unknown): asserts value is RuntimeReleaseCompositionInputV1<unknown>["startup"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("runtime release startup input is required");
  }
  const expected = ["processEpoch", "source"].sort();
  const actual = Reflect.ownKeys(value).map(key => {
    if (typeof key !== "string") throw new TypeError("runtime release startup input has a symbol field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`runtime release startup input has an accessor field ${key}`);
    }
    return key;
  }).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("runtime release startup input has non-exact fields");
  }
}

function assertExactPerformanceInput(value: unknown): asserts value is RuntimeReleasePerformanceInputV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("runtime release performance input is required");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "policy") {
    throw new TypeError("runtime release performance input has non-exact fields");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "policy");
  if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError("runtime release performance input has an invalid policy field");
  }
}

function assertExactSixStepInput(value: unknown): asserts value is RuntimeReleaseCompositionInputV1<unknown>["sixStep"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("runtime release Six-Step input is required");
  }
  const expected = ["process", "emitterCodeHash", "observerContentDirectory", "evidenceDirectory"].sort();
  const actual = Reflect.ownKeys(value).map(key => {
    if (typeof key !== "string") throw new TypeError("runtime release Six-Step input has a symbol field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`runtime release Six-Step input has an invalid field ${key}`);
    }
    return key;
  }).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("runtime release Six-Step input has non-exact fields");
  }
}

export function buildRuntimeReleaseComposition<Fact>(
  input: RuntimeReleaseCompositionInputV1<Fact>,
): RuntimeReleaseCompositionServicesV1<Fact> {
  if (input === null || typeof input !== "object") throw new TypeError("runtime release composition input is required");
  if (input.catalog === undefined) throw new TypeError("runtime release catalog input is required");
  assertExactStartupInput(input.startup);
  assertExactPerformanceInput(input.performance);
  assertExactSixStepInput(input.sixStep);
  const authority = input.authority;
  const qualifiedDiscoverySource = readRuntimeReleaseQualifiedDiscoverySourcePort(
    authority,
    input.startup.source,
  );
  const catalogInternal = createRuntimeReleaseCatalog(authority, input.catalog);
  const ports = composeRuntimeReleasePrivatePorts({
    authority,
    attestationProofPort: input.attestation.proofPort,
    candidatePartitionProofIssuer: input.candidatePartitionProofIssuer,
    schedulerIssuer: input.scheduler.issuer,
    schedulerCapability: input.scheduler.capability,
    schedulerRuntime: input.scheduler.runtime,
    physicalExecution: input.scheduler.physicalExecution,
  });
  const strategyRuntime = issueRuntimeReleaseStrategyRuntimeService(
    authority,
    createReleaseStrategyRuntimeComposition,
  );
  const observerStore = issueRuntimeReleaseObserverStoreServiceV1(authority);
  const sixStepObserverStore = observerStore.issueObserverStore({
    directory: input.sixStep.observerContentDirectory,
  });
  const sixStepSink = readReleaseOwnedObserverStoreV1(sixStepObserverStore).sink;
  const sixStepCatalog = catalogInternal.loadExact();
  const sixStepStrategy = strategyRuntime.readMetadata();
  const sixStepProduction = issueRuntimeReleaseSixStepProductionV1({
    strategyRuntime,
    process: input.sixStep.process,
    emitterCodeHash: input.sixStep.emitterCodeHash,
    directory: input.sixStep.evidenceDirectory,
    sink: sixStepSink,
    definitionCatalogRoot: sixStepCatalog.definitionCatalogRoot,
    strategyCatalogRoot: sixStepStrategy.strategyCatalogRoot,
    releaseProvenanceHash: sixStepCatalog.releaseProvenanceHash,
    generationRefreshPolicyHash: generationRefreshPolicyHash(input.ready.policy),
    capabilities: sixStepCatalog.qualifiedCapabilityRefs.map(ref => Object.freeze({
      capabilityId: ref.capabilityId,
      version: ref.version,
      schemaHash: ref.schemaHash,
      interpreterHash: ref.interpreterHash,
    })),
    semanticConfigDigest: hashDomain("aloha/production-six-step-semantic-config/v1", {
      definitionCatalogRoot: sixStepCatalog.definitionCatalogRoot,
      strategyCatalogRoot: sixStepStrategy.strategyCatalogRoot,
      generationRefreshPolicyHash: generationRefreshPolicyHash(input.ready.policy),
      releaseProvenanceHash: sixStepCatalog.releaseProvenanceHash,
    }),
    resourceMetricsHash: hashDomain("aloha/production-six-step-process-resource-basis/v1", input.sixStep.process),
  });
  const { attestationComposition, candidatePartitionProofIssuer, schedulerIssuer } = ports;

  const candidatePartitionBootstrap = createCandidatePartitionBootstrap();
  const candidatePartitionReader = candidatePartitionBootstrapReader(candidatePartitionBootstrap);
  const attestationConstructor = input.attestation.build(attestationComposition, candidatePartitionReader);
  // Identity/materialization meaning is owned by the exact generated Family
  // composition joined above.  It must never arrive through the caller's
  // framework callback, even if a structural object happens to contain a
  // property named `programs`.
  const attestationPrograms = createAttestationProgramPortFromFamilyComposition({
    composition: ports.familyRuntime.openComposition(),
  });
  const attestationInternal = createAttestationService({
    ...attestationConstructor,
    composition: attestationComposition,
    candidatePartitionReader,
    programs: attestationPrograms,
  });
  const promotionAuthority = createReadyPromotionAuthority(
    () => ({
      definitionCatalogRoot: catalogInternal.loadExact().definitionCatalogRoot,
      policy: input.ready.policy,
    }),
    authority.readyGeneration,
  );
  const checkpointCaller = Object.freeze({ runtimeReleaseCheckpoint: Symbol("runtime-release-checkpoint") });
  const checkpointInternal = createCheckpointStore(
    input.checkpoint.durable,
    input.checkpoint.canonical,
    checkpointCaller,
    promotionAuthority,
    attestationInternal.validationAuthority,
    candidatePartitionProofIssuer,
    sixStepProduction.checkpoint,
    candidatePartitionBootstrap,
  );
  const persistedAttestation = issueRuntimeReleasePersistedAttestationPort(
    authority,
    attestationInternal,
    checkpointInternal,
  );
  const checkpoint = releaseGuardedFacade(ports, checkpointInternal) as CheckpointStore;
  const familyExecution = Object.freeze({
    async executeFrozenProgram(request: Parameters<typeof ports.familyExecution.executeFrozenProgram>[0]) {
      assertRuntimeReleasePrivatePortsCurrent(ports);
      return ports.familyExecution.executeFrozenProgram(request);
    },
  }) as FamilyFrozenProgramExecutionPort<Fact>;
  const revmAuthority = issueRuntimeReleaseRevmWorkerAuthorityIssuer(authority, schedulerIssuer);
  const revmDeployment = readRuntimeReleaseRevmWorkerDeploymentPort(authority, input.revm.deploymentPort);
  const revmPoolInternal = new RevmWorkerPool({
    factory: revmDeployment.factory,
    qualification: revmDeployment.qualification,
    maxWorkers: input.revm.maxWorkers,
    queueCap: input.revm.queueCap,
    timeoutMs: input.revm.timeoutMs,
    perOwnerConcurrency: input.revm.perOwnerConcurrency,
    authority: revmAuthority,
  });
  const executorStateOwner = createRethQualifiedExecutorStateOwner({
    endpoint: input.finalSimulation.endpoint,
    ...(input.finalSimulation.timeoutMs === undefined ? {} : { timeoutMs: input.finalSimulation.timeoutMs }),
  });
  const finalSimulationFactory = issueQualifiedFinalSimulationPortFactoryV1<QualifiedFinalSimulationFactV1>({
    async issue(_currentSource, currentSourceCapability) {
      const snapshot = await executorStateOwner.issue({
        session: currentSourceCapability,
        authority: revmAuthority,
        executorAddress: input.finalSimulation.executorAddress,
        callerAddress: input.finalSimulation.callerAddress,
        qualifiedExecutorCodeHash: input.finalSimulation.qualifiedExecutorCodeHash,
        executorConfig: input.finalSimulation.executorConfig,
        accounts: input.finalSimulation.accounts,
      });
      return createQualifiedFinalSimulationPort({
        scheduler: ports.scheduler,
        client: new RevmSimulationClient({ pool: revmPoolInternal }),
        qualification: Object.freeze({
          ...revmDeployment.qualification,
          qualifiedExecutorRegistryRoot: assertActiveRuntimeReleaseAuthorityState(authority).binding.qualifiedExecutorRegistryRoot,
          selectedExecutorLeafHash: assertActiveRuntimeReleaseAuthorityState(authority).binding.selectedExecutorLeafHash,
          releaseRoleManifestRoot: assertActiveRuntimeReleaseAuthorityState(authority).binding.selectedExecutor.releaseRoleManifestRoot,
        }),
        schemaHash: assertActiveRuntimeReleaseAuthorityState(authority).binding.selectedExecutor.schemaFingerprint,
        projection: createSourceBoundExecutorProjection({ snapshot, authority: revmAuthority }),
      });
    },
  });
  const revmPool = Object.freeze({
    submit(request: Parameters<RevmWorkerPool["submit"]>[0], signal?: AbortSignal) {
      assertRuntimeReleasePrivatePortsCurrent(ports);
      return revmPoolInternal.submit(request, signal);
    },
    snapshot() {
      assertRuntimeReleasePrivatePortsCurrent(ports);
      return revmPoolInternal.snapshot();
    },
    retireAll() {
      assertRuntimeReleasePrivatePortsCurrent(ports);
      return revmPoolInternal.retireAll();
    },
  }) satisfies Pick<RevmWorkerPool, "submit" | "snapshot" | "retireAll">;
  const performance = issueRuntimeReleasePerformanceRuntimeService({
    authority,
    schedulerRuntime: input.scheduler.runtime,
    schedulerIssuer,
    schedulerCapability: input.scheduler.capability,
    workerPool: revmPoolInternal,
    providerRoot: qualifiedDiscoverySource.sourceAuthorityRoot,
    policy: input.performance.policy,
  });
  const economicSafety = issueRuntimeReleaseEconomicSafetyServiceV1({
    authority,
    familyRuntimeComposition: ports.familyRuntime.openComposition(),
    ...(input.economicSafetyEvaluator === undefined ? {} : { evaluatorCapability: input.economicSafetyEvaluator }),
  });
  const attestation = Object.freeze({
    openRunSession(sessionInput: Parameters<AttestationServiceV1["openRunSession"]>[0]) {
      assertRuntimeReleasePrivatePortsCurrent(ports);
      return attestationInternal.openRunSession(sessionInput);
    },
  }) satisfies Pick<AttestationServiceV1, "openRunSession">;
  const readyCaller = Object.freeze({ runtimeReleaseReady: Symbol("runtime-release-ready") });
  const readyInternal = new ReadyGenerationServiceV1(
    readyCaller,
    checkpointInternal,
    input.checkpoint.canonical,
    input.ready.monotonicNow,
    () => {
      const catalog = catalogInternal.loadExact();
      return {
        definitionCatalogRoot: catalog.definitionCatalogRoot,
        declaredSourcePlans: catalog.declaredSourcePlans,
        releaseProvenanceHash: catalog.releaseProvenanceHash,
      };
    },
    promotionAuthority,
    checkpointInternal.sealedRunReader,
    authority.readyGeneration,
  );
  // This owner-issued port already closes every load/promote/serving action
  // over readyInternal, whose release binding is rotation/revoke fenced.  Do
  // not proxy the frozen opaque port: doing so would both violate Proxy
  // invariants and destroy the WeakSet identity checked by startup-runtime.
  const ready = issueStartupReadyPort({ service: readyInternal, promotionCaller: readyCaller });
  const catalog = releaseGuardedCatalogFacade(ports, catalogInternal);
  const discoveryRelease = assertActiveRuntimeReleaseAuthorityState(authority).binding;
  const discovery = createRuntimeReleaseDiscoveryPort({
    bindings: ports.sourcePlans,
    source: qualifiedDiscoverySource,
    scheduler: ports.scheduler,
    release: {
      bindingId: discoveryRelease.bindingId,
      releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(discoveryRelease),
      processEpoch: input.startup.processEpoch,
    },
    assertCurrent: () => assertRuntimeReleasePrivatePortsCurrent(ports),
  });
  let startupPromise: Promise<StartupRuntimeV1> | null = null;
  const startStartup = async (signal: AbortSignal = new AbortController().signal): Promise<StartupRuntimeV1> => {
    assertRuntimeReleasePrivatePortsCurrent(ports);
    if (startupPromise === null) {
      const startupRelease = assertActiveRuntimeReleaseAuthorityState(authority).binding;
      startupPromise = startStartupRuntime({
        policy: input.ready.policy,
        catalog,
        checkpoint,
        canonical: input.checkpoint.canonical,
        discovery,
        attestation: persistedAttestation,
        ready,
        familyRuntime: ports.familyRuntime.openComposition(),
        processEpoch: input.startup.processEpoch,
        releaseBindingId: startupRelease.bindingId,
        candidateReleaseCommit: startupRelease.candidateReleaseCommit,
      }, signal).catch(error => {
        startupPromise = null;
        throw error;
      });
    }
    const runtime = await startupPromise;
    assertRuntimeReleasePrivatePortsCurrent(ports);
    return runtime;
  };
  const release = authority.resolver.resolve(authority.capability);
  const startup = issueRuntimeReleaseSearcherStartupService({ authority, ready, start: startStartup });
  const fullFamilyTerminalBinding = issueRuntimeReleaseFullFamilyTerminalBindingServiceV1(
    authority,
    createReleaseFamilyRuntimeComposition,
  );
  const fullGraphCoarseSweep = issueRuntimeReleaseFullGraphCoarseSweepServiceV1({
    authority,
    familyRuntime: ports.familyRuntime,
  });
  const sixStepTerminalBinding = issueRuntimeReleaseSixStepTerminalBindingServiceV1(authority, strategyRuntime, economicSafety);
  assertRuntimeReleasePrivatePortsCurrent(ports);
  return Object.freeze({
    attestation,
    checkpoint,
    catalog,
    familyExecution,
    revmPool,
    familyRuntime: ports.familyRuntime,
    strategyRuntime,
    performance,
    economicSafety,
    finalSimulationFactory,
    startup,
    fullFamilyTerminalBinding,
    fullGraphCoarseSweep,
    sixStepTerminalBinding,
    observerStore,
    release: Object.freeze({
      bindingId: release.bindingId,
      releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(release),
      candidateReleaseCommit: release.candidateReleaseCommit,
      releaseAuthorityRoot: release.releaseAuthorityRoot,
      executorAuthorityRoot: release.executorAuthorityRoot,
      workerEpoch: release.workerEpoch,
      executorSessionHash: release.executorSessionHash,
      qualifiedCapabilityRefsRoot: release.qualifiedCapabilityRefsRoot,
    }),
  });
}
