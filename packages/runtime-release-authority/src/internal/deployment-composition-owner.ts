import {
  assertExactKeys,
  assertPlainObject,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodeRuntimeReleaseBindingV1,
  runtimeReleaseBindingProvenanceHash,
  type RuntimeReleaseBindingV1,
} from "../../../../specs/release-authority/src/index.ts";
import type { CandidatePartitionProofIssuerPortV1 } from "../../../../specs/candidate-partition-authority/src/index.ts";
import { assertIssuedCandidatePartitionProofIssuer } from "../../../../specs/candidate-partition-authority/src/internal/issuer-consumer.ts";
import type {
  QualifiedExecutorAuthorityCapability,
  QualifiedExecutorAuthorityIssuer,
} from "../../../../packages/scheduler/src/index.ts";
import { assertIssuedQualifiedExecutorAuthorityIssuer } from "../../../../packages/scheduler/src/internal/authority-consumer.ts";
import {
  readQualifiedSharedSchedulerRuntimePort,
  type QualifiedSharedSchedulerRuntimePortV1,
} from "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts";
import {
  assertQualifiedPhysicalExecutionSchedulerRuntime,
} from "../../../../packages/work-plane/src/internal/family-execution-port.ts";
import type { QualifiedPhysicalExecutionPortV1 } from "../../../../packages/work-plane/src/index.ts";
import {
  readIssuedRevmWorkerDeploymentPort,
  type RevmWorkerDeploymentPortV1,
} from "../../../../runtime/revm-workers/src/internal/authority.ts";
import {
  issueDeploymentAttestationProofPort,
  type RuntimeReleaseAttestationProofPortV1,
} from "./attestation-proof-owner.ts";

/** The only export an approved external composition module may expose. */
export type DeploymentCompositionCapabilityV1 = object;

export interface DeploymentCompositionExternalPortsV1<Fact = unknown> {
  readonly attestationProof: RuntimeReleaseAttestationProofPortV1;
  readonly candidatePartitionProofIssuer: CandidatePartitionProofIssuerPortV1;
  readonly scheduler: Readonly<{
    readonly issuer: QualifiedExecutorAuthorityIssuer;
    readonly capability: QualifiedExecutorAuthorityCapability;
    readonly runtime: QualifiedSharedSchedulerRuntimePortV1;
    readonly physicalExecution: QualifiedPhysicalExecutionPortV1<Fact>;
  }>;
  readonly revmDeployment: RevmWorkerDeploymentPortV1;
}

interface DeploymentCompositionStateV1<Fact> {
  readonly binding: RuntimeReleaseBindingV1;
  readonly ports: DeploymentCompositionExternalPortsV1<Fact>;
}

const states = new WeakMap<object, DeploymentCompositionStateV1<unknown>>();

function validateExternalPorts<Fact>(
  binding: RuntimeReleaseBindingV1,
  ports: DeploymentCompositionExternalPortsV1<Fact>,
): DeploymentCompositionExternalPortsV1<Fact> {
  assertPlainObject(ports, "deploymentComposition.ports");
  assertExactKeys(
    ports,
    ["attestationProof", "candidatePartitionProofIssuer", "scheduler", "revmDeployment"],
    "deploymentComposition.ports",
  );
  const attestationProof = issueDeploymentAttestationProofPort(ports.attestationProof);
  assertIssuedCandidatePartitionProofIssuer(ports.candidatePartitionProofIssuer);
  const candidatePartitionProofIssuer = ports.candidatePartitionProofIssuer;
  assertPlainObject(ports.scheduler, "deploymentComposition.ports.scheduler");
  assertExactKeys(
    ports.scheduler,
    ["issuer", "capability", "runtime", "physicalExecution"],
    "deploymentComposition.ports.scheduler",
  );
  const issuer = assertIssuedQualifiedExecutorAuthorityIssuer(ports.scheduler.issuer);
  const provenance = issuer.provenance(ports.scheduler.capability);
  if (issuer.registryRoot !== binding.qualifiedExecutorRegistryRoot
    || issuer.authorityRoot !== binding.executorAuthorityRoot
    || provenance.authorityRoot !== binding.executorAuthorityRoot
    || provenance.workerEpoch !== binding.workerEpoch
    || provenance.executorSession !== binding.executorSessionHash) {
    throw new TypeError("deployment scheduler does not join the signed release");
  }
  readQualifiedSharedSchedulerRuntimePort(
    ports.scheduler.runtime,
    issuer,
    ports.scheduler.capability,
  );
  assertQualifiedPhysicalExecutionSchedulerRuntime(
    ports.scheduler.physicalExecution,
    ports.scheduler.runtime,
    issuer,
    ports.scheduler.capability,
  );
  const revm = readIssuedRevmWorkerDeploymentPort(ports.revmDeployment);
  if (revm.qualifiedExecutorRegistryRoot !== binding.qualifiedExecutorRegistryRoot
    || revm.selectedExecutorLeafHash !== binding.selectedExecutorLeafHash
    || revm.qualification.engineBuildFingerprint !== binding.selectedExecutor.engineBuildFingerprint
    || revm.qualification.executableFingerprint !== binding.selectedExecutor.executableFingerprint) {
    throw new TypeError("deployment REVM port does not join the signed release");
  }
  return Object.freeze({
    attestationProof,
    candidatePartitionProofIssuer,
    scheduler: Object.freeze({
      issuer,
      capability: ports.scheduler.capability,
      runtime: ports.scheduler.runtime,
      physicalExecution: ports.scheduler.physicalExecution,
    }),
    revmDeployment: ports.revmDeployment,
  });
}

/**
 * Candidate-owned issuance edge invoked by the exact package-approved module.
 * Raw keys and signer callbacks stay closed inside that module; runtime code
 * receives only this empty process-local capability.
 */
export function issueDeploymentCompositionCapabilityV1<Fact>(input: Readonly<{
  readonly binding: RuntimeReleaseBindingV1;
  readonly ports: DeploymentCompositionExternalPortsV1<Fact>;
}>): DeploymentCompositionCapabilityV1 {
  assertPlainObject(input, "deploymentComposition");
  assertExactKeys(input, ["binding", "ports"], "deploymentComposition");
  const binding = decodeRuntimeReleaseBindingV1(input.binding);
  const ports = validateExternalPorts(binding, input.ports);
  const capability = Object.freeze(Object.create(null));
  states.set(capability, Object.freeze({ binding, ports }) as DeploymentCompositionStateV1<unknown>);
  return capability;
}

/** Production-bootstrap-only read; clones and cross-release capabilities fail. */
export function readDeploymentCompositionCapabilityV1<Fact>(
  capability: DeploymentCompositionCapabilityV1,
  bindingValue: RuntimeReleaseBindingV1,
): DeploymentCompositionExternalPortsV1<Fact> {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("deployment composition capability is invalid");
  }
  const state = states.get(capability);
  if (state === undefined) throw new TypeError("deployment composition capability was not candidate-issued");
  const binding = decodeRuntimeReleaseBindingV1(bindingValue);
  if (state.binding.bindingId !== binding.bindingId
    || state.binding.payloadHash !== binding.payloadHash
    || runtimeReleaseBindingProvenanceHash(state.binding) !== runtimeReleaseBindingProvenanceHash(binding)
    || state.binding.attestationProofIssuerKeyId !== binding.attestationProofIssuerKeyId
    || state.binding.candidatePartitionProofIssuerKeyId !== binding.candidatePartitionProofIssuerKeyId
    || state.binding.qualifiedExecutorRegistryRoot !== binding.qualifiedExecutorRegistryRoot
    || state.binding.selectedExecutorLeafHash !== binding.selectedExecutorLeafHash
    || state.binding.frameworkAuthorityRoot !== binding.frameworkAuthorityRoot
    || state.binding.executorAuthorityRoot !== binding.executorAuthorityRoot
    || state.binding.releaseAuthorityRoot !== binding.releaseAuthorityRoot) {
    throw new TypeError("deployment composition capability release identity mismatch");
  }
  validateExternalPorts(binding, state.ports);
  return state.ports as DeploymentCompositionExternalPortsV1<Fact>;
}
