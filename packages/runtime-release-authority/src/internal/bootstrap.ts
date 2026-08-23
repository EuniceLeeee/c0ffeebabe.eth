import type {
  AttestationServiceConstructorV1,
  AttestationServiceV1,
  AttestationCompositionBindingV1,
} from "../../../../packages/attestation/src/index.ts";
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
import type { CanonicalSource } from "../../../../packages/canonical-source/src/index.ts";
import type { SQLiteDurableStore } from "../../../../packages/durable-store/src/index.ts";
import type { ReadyPromotionAuthorityGuardPort } from "../../../../packages/ready-generation/src/index.ts";
import type { RuntimeReleaseReadyBindingPortV1 } from "../../../../specs/release-authority/src/index.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../../specs/release-authority/src/index.ts";
import type {
  QualifiedExecutorAuthorityCapability,
  QualifiedExecutorAuthorityIssuer,
} from "../../../../packages/scheduler/src/index.ts";
import {
  createSchedulerOwnedFamilyExecutionPort,
} from "../../../../packages/work-plane/src/internal/family-execution-port.ts";
import type {
  CapabilityWorkIntentV1,
  FamilyFrozenProgramExecutionPort,
} from "../../../../packages/work-plane/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import type { RuntimeReleaseAttestationProofPortV1 } from "./attestation-proof-owner.ts";
import { issueRuntimeReleaseAttestationComposition } from "./attestation-composition-owner.ts";
import { issueRuntimeReleaseAttestationProofPort } from "./attestation-proof-owner.ts";
import { issueRuntimeReleaseCandidatePartitionProofIssuer } from "./candidate-partition-proof-owner.ts";
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

export interface RuntimeReleaseCheckpointInputV1 {
  readonly durable: SQLiteDurableStore;
  readonly canonical: CanonicalSource;
  readonly probeCaller: object;
  readonly promotionAuthority: ReadyPromotionAuthorityGuardPort;
}

export interface RuntimeReleaseSchedulerInputV1<Fact> {
  /** Already-issued by deployment-side qualified executor composition. */
  readonly issuer: QualifiedExecutorAuthorityIssuer;
  /** Capability issued by the same external issuer. */
  readonly capability: QualifiedExecutorAuthorityCapability;
  /** Physical executor callback; it receives release-stamped provenance only. */
  readonly execute: (input: {
    readonly intent: CapabilityWorkIntentV1;
    readonly signal: AbortSignal;
    readonly provenance: ReturnType<QualifiedExecutorAuthorityIssuer["provenance"]>;
    readonly executionSessionHash: `0x${string}`;
  }) => Promise<Fact>;
}

export interface RuntimeReleaseRevmInputV1 {
  /** Deployment-issued and signed-runtime-bound; raw structural inputs are rejected. */
  readonly deploymentPort: RuntimeReleaseRevmWorkerDeploymentPortV1;
  readonly maxWorkers?: number;
  readonly queueCap?: number;
  readonly timeoutMs?: number;
  readonly perOwnerConcurrency?: number;
}

export interface RuntimeReleaseReadyInputV1<ReadyService extends object> {
  /** The application-specific Ready constructor receives only the narrow port. */
  readonly build: (binding: RuntimeReleaseReadyBindingPortV1) => ReadyService;
}

export interface RuntimeReleaseCompositionInputV1<ReadyService extends object, Fact> {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly attestation: {
    readonly proofPort: RuntimeReleaseAttestationProofPortV1;
    /** Build framework/rejection/program ports after the release composition is issued. */
    readonly build: (
      composition: AttestationCompositionBindingV1,
      candidatePartitionReader: CandidatePartitionReaderPortV1,
    ) => Omit<AttestationServiceConstructorV1, "composition" | "candidatePartitionReader">;
  };
  /** Already-issued by deployment-side candidate-partition proof composition. */
  readonly candidatePartitionProofIssuer: CandidatePartitionProofIssuerPortV1;
  readonly checkpoint: RuntimeReleaseCheckpointInputV1;
  readonly scheduler: RuntimeReleaseSchedulerInputV1<Fact>;
  readonly revm: RuntimeReleaseRevmInputV1;
  readonly ready: RuntimeReleaseReadyInputV1<ReadyService>;
}

export interface RuntimeReleaseCompositionServicesV1<ReadyService extends object, Fact> {
  /** Public Attestation facade; its validation authority stays checkpoint-private. */
  readonly attestation: Pick<AttestationServiceV1, "openRunSession">;
  readonly checkpoint: CheckpointStore;
  readonly familyExecution: FamilyFrozenProgramExecutionPort<Fact>;
  readonly revmPool: Pick<RevmWorkerPool, "submit" | "snapshot" | "retireAll">;
  readonly ready: ReadyService;
  /** Non-sensitive identity for logs/lineage; no signer, resolver, or issuer. */
  readonly release: Readonly<{
    readonly bindingId: `0x${string}`;
    readonly releaseProvenanceHash: `0x${string}`;
    readonly releaseAuthorityRoot: `0x${string}`;
    readonly executorAuthorityRoot: `0x${string}`;
    readonly workerEpoch: string;
    readonly executorSessionHash: `0x${string}`;
  }>;
}

interface RuntimeReleasePrivatePortsV1 {
  readonly attestationComposition: AttestationCompositionBindingV1;
  readonly candidatePartitionProofIssuer: CandidatePartitionProofIssuerPortV1;
  readonly schedulerIssuer: QualifiedExecutorAuthorityIssuer;
  readonly readyBinding: RuntimeReleaseReadyBindingPortV1;
}

const privatePortStates = new WeakMap<object, { readonly authority: RuntimeReleaseAuthorityV1; readonly version: bigint }>();

/** Single internal join used by the production bootstrap and its boundary tests. */
export function composeRuntimeReleasePrivatePorts(input: {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly attestationProofPort: RuntimeReleaseAttestationProofPortV1;
  readonly candidatePartitionProofIssuer: CandidatePartitionProofIssuerPortV1;
  readonly schedulerIssuer: QualifiedExecutorAuthorityIssuer;
  /** Deployment-created initial capability; joined here, before any public service is built. */
  readonly schedulerCapability: QualifiedExecutorAuthorityCapability;
}): RuntimeReleasePrivatePortsV1 {
  const state = assertActiveRuntimeReleaseAuthorityState(input.authority);
  const proofCapability = issueRuntimeReleaseAttestationProofPort(input.authority, input.attestationProofPort);
  const schedulerIssuer = issueRuntimeReleaseQualifiedExecutorAuthorityIssuer(input.authority, input.schedulerIssuer);
  assertRuntimeReleaseQualifiedExecutorAuthorityInitialCapability(
    input.authority,
    schedulerIssuer,
    input.schedulerCapability,
  );
  const ports = Object.freeze({
    attestationComposition: issueRuntimeReleaseAttestationComposition(input.authority, proofCapability),
    candidatePartitionProofIssuer: issueRuntimeReleaseCandidatePartitionProofIssuer(input.authority, input.candidatePartitionProofIssuer),
    schedulerIssuer,
    readyBinding: input.authority.readyGeneration,
  });
  privatePortStates.set(ports, { authority: input.authority, version: state.version });
  return ports;
}

export function assertRuntimeReleasePrivatePortsCurrent(value: RuntimeReleasePrivatePortsV1): void {
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

export function buildRuntimeReleaseComposition<ReadyService extends object, Fact>(
  input: RuntimeReleaseCompositionInputV1<ReadyService, Fact>,
): RuntimeReleaseCompositionServicesV1<ReadyService, Fact> {
  if (input === null || typeof input !== "object") throw new TypeError("runtime release composition input is required");
  const authority = input.authority;
  const ports = composeRuntimeReleasePrivatePorts({
    authority,
    attestationProofPort: input.attestation.proofPort,
    candidatePartitionProofIssuer: input.candidatePartitionProofIssuer,
    schedulerIssuer: input.scheduler.issuer,
    schedulerCapability: input.scheduler.capability,
  });
  const { attestationComposition, candidatePartitionProofIssuer, schedulerIssuer } = ports;

  const candidatePartitionBootstrap = createCandidatePartitionBootstrap();
  const candidatePartitionReader = candidatePartitionBootstrapReader(candidatePartitionBootstrap);
  const attestationConstructor = input.attestation.build(attestationComposition, candidatePartitionReader);
  const attestationInternal = createAttestationService({
    ...attestationConstructor,
    composition: attestationComposition,
    candidatePartitionReader,
  });
  const checkpointInternal = createCheckpointStore(
    input.checkpoint.durable,
    input.checkpoint.canonical,
    input.checkpoint.probeCaller,
    input.checkpoint.promotionAuthority,
    attestationInternal.validationAuthority,
    candidatePartitionProofIssuer,
    candidatePartitionBootstrap,
  );
  const checkpoint = releaseGuardedFacade(ports, checkpointInternal) as CheckpointStore;
  const familyExecutionInternal = createSchedulerOwnedFamilyExecutionPort({
    issuer: schedulerIssuer,
    capability: input.scheduler.capability,
    execute: input.scheduler.execute,
  });
  const familyExecution = Object.freeze({
    async executeFrozenProgram(request: Parameters<typeof familyExecutionInternal.executeFrozenProgram>[0]) {
      assertRuntimeReleasePrivatePortsCurrent(ports);
      return familyExecutionInternal.executeFrozenProgram(request);
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
  const attestation = Object.freeze({
    openRunSession(sessionInput: Parameters<AttestationServiceV1["openRunSession"]>[0]) {
      assertRuntimeReleasePrivatePortsCurrent(ports);
      return attestationInternal.openRunSession(sessionInput);
    },
  }) satisfies Pick<AttestationServiceV1, "openRunSession">;
  const readyInternal = input.ready.build(authority.readyGeneration);
  if (readyInternal === null || typeof readyInternal !== "object") {
    throw new TypeError("runtime release ready service must be an object");
  }
  const ready = releaseGuardedFacade(ports, readyInternal);
  const release = authority.resolver.resolve(authority.capability);
  assertRuntimeReleasePrivatePortsCurrent(ports);
  return Object.freeze({
    attestation,
    checkpoint,
    familyExecution,
    revmPool,
    ready,
    release: Object.freeze({
      bindingId: release.bindingId,
      releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(release),
      releaseAuthorityRoot: release.releaseAuthorityRoot,
      executorAuthorityRoot: release.executorAuthorityRoot,
      workerEpoch: release.workerEpoch,
      executorSessionHash: release.executorSessionHash,
    }),
  });
}
