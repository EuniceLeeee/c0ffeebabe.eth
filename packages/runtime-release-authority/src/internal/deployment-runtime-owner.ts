import { statSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  sha256Hex,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import {
  WorkScheduler,
  type QualifiedExecutorAuthorityCapability,
  type QualifiedExecutorAuthorityIssuer,
  type QualifiedExecutorAuthorityProvenanceV1,
  type QualifiedExecutorWorkerBindingV1,
} from "../../../scheduler/src/index.ts";
import { issueQualifiedExecutorAuthorityIssuer } from "../../../scheduler/src/internal/authority-owner.ts";
import {
  issueQualifiedSharedSchedulerRuntimePort,
  readQualifiedSharedSchedulerRuntimePort,
  type QualifiedSharedSchedulerRuntimePortV1,
} from "../../../scheduler/src/internal/shared-runtime-owner.ts";
import { createNodeRevmWorkerFactory } from "../../../../runtime/revm-workers/src/node-worker-factory.ts";
import {
  issueRevmWorkerDeploymentPort,
  readIssuedRevmWorkerDeploymentPort,
  type RevmWorkerDeploymentPortV1,
} from "../../../../runtime/revm-workers/src/internal/authority.ts";
import {
  decodeRuntimeReleaseBindingV1,
  runtimeReleaseBindingProvenanceHash,
  type RuntimeReleaseBindingV1,
} from "../../../../specs/release-authority/src/index.ts";
import {
  decodeExternalProofSignerRequestV1,
  issueExternalProofPortsV1,
  type ExternalProofPortsV1,
  type ExternalProofSignerRequestV1,
} from "./external-proof-owner.ts";

export interface DeploymentRuntimeInfrastructureRequestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.deployment-runtime-infrastructure";
  readonly revmWorkerExecutablePath: string;
  readonly revmWorkerExecutableSha256: Hash;
  readonly externalProofSigner: ExternalProofSignerRequestV1;
}

export interface DeploymentRuntimeInfrastructurePortsV1 extends ExternalProofPortsV1 {
  readonly scheduler: Readonly<{
    readonly issuer: QualifiedExecutorAuthorityIssuer;
    readonly capability: QualifiedExecutorAuthorityCapability;
    readonly runtime: QualifiedSharedSchedulerRuntimePortV1;
  }>;
  readonly revmDeployment: RevmWorkerDeploymentPortV1;
}

export type DeploymentRuntimeInfrastructureCapabilityV1 = object;

interface DeploymentRuntimeInfrastructureStateV1 {
  readonly binding: RuntimeReleaseBindingV1;
  readonly ports: DeploymentRuntimeInfrastructurePortsV1;
}

const issuedInfrastructure = new WeakMap<object, DeploymentRuntimeInfrastructureStateV1>();

export function decodeDeploymentRuntimeInfrastructureRequestV1(
  value: unknown,
): DeploymentRuntimeInfrastructureRequestV1 {
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "revmWorkerExecutablePath",
    "revmWorkerExecutableSha256",
    "externalProofSigner",
  ]);
  if (value.schemaVersion !== 1 || value.kind !== "aloha.deployment-runtime-infrastructure") {
    throw new TypeError("deployment runtime infrastructure request is invalid");
  }
  const revmWorkerExecutablePath = assertNonEmptyString(
    value.revmWorkerExecutablePath,
    "deploymentRuntimeInfrastructure.revmWorkerExecutablePath",
  );
  if (!isAbsolute(revmWorkerExecutablePath)) {
    throw new TypeError("deployment REVM worker executable path must be absolute");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.deployment-runtime-infrastructure",
    revmWorkerExecutablePath,
    revmWorkerExecutableSha256: assertHash(
      value.revmWorkerExecutableSha256,
      "deploymentRuntimeInfrastructure.revmWorkerExecutableSha256",
    ),
    externalProofSigner: decodeExternalProofSignerRequestV1(value.externalProofSigner),
  });
}

function sameWorker(
  value: QualifiedExecutorWorkerBindingV1,
  expected: RuntimeReleaseBindingV1["selectedExecutor"],
  workerEpoch: string,
): boolean {
  return value.workerEpoch === workerEpoch
    && value.executorKind === expected.executorKind
    && value.engineBuildFingerprint === expected.engineBuildFingerprint
    && value.executableFingerprint === expected.executableFingerprint
    && value.closureFingerprint === expected.closureFingerprint
    && value.protocolFingerprint === expected.protocolFingerprint
    && value.schemaFingerprint === expected.schemaFingerprint
    && value.releaseRoleManifestRoot === expected.releaseRoleManifestRoot
    && value.candidateCommit === expected.candidateCommit;
}

function issueReleaseScheduler(
  binding: RuntimeReleaseBindingV1,
): DeploymentRuntimeInfrastructurePortsV1["scheduler"] {
  let revoked = false;
  const capability = Object.freeze(Object.create(null)) as QualifiedExecutorAuthorityCapability;
  const provenance: QualifiedExecutorAuthorityProvenanceV1 = Object.freeze({
    authorityRoot: binding.executorAuthorityRoot,
    workerEpoch: binding.workerEpoch,
    executorSession: binding.executorSessionHash,
    version: 1,
  });
  const assertCurrent = (value: QualifiedExecutorAuthorityCapability): QualifiedExecutorAuthorityProvenanceV1 => {
    if (value !== capability) throw new TypeError("deployment scheduler capability was not issued");
    if (revoked) throw new TypeError("deployment scheduler capability is revoked");
    return provenance;
  };
  const open = (input: { readonly worker: QualifiedExecutorWorkerBindingV1 }) => {
    assertExactKeys(input, ["worker"]);
    assertExactKeys(input.worker, [
      "workerEpoch",
      "executorKind",
      "engineBuildFingerprint",
      "executableFingerprint",
      "closureFingerprint",
      "protocolFingerprint",
      "schemaFingerprint",
      "releaseRoleManifestRoot",
      "candidateCommit",
    ]);
    if (!sameWorker(input.worker, binding.selectedExecutor, binding.workerEpoch)) {
      throw new TypeError("deployment scheduler worker does not join the signed release");
    }
    return capability;
  };
  const issuer = issueQualifiedExecutorAuthorityIssuer(Object.freeze({
    registryRoot: binding.qualifiedExecutorRegistryRoot,
    authorityRoot: binding.executorAuthorityRoot,
    open,
    rotate: () => {
      throw new TypeError("deployment scheduler rotation requires a new release composition");
    },
    revoke: (value?: QualifiedExecutorAuthorityCapability) => {
      if (value !== undefined) assertCurrent(value);
      revoked = true;
    },
    assert: assertCurrent,
    provenance: assertCurrent,
  }));
  open({ worker: { workerEpoch: binding.workerEpoch, ...binding.selectedExecutor } });
  const runtime = issueQualifiedSharedSchedulerRuntimePort({
    scheduler: new WorkScheduler(),
    issuer,
    capability,
  });
  return Object.freeze({ issuer, capability, runtime });
}

function issueReleaseRevmDeployment(
  binding: RuntimeReleaseBindingV1,
  request: DeploymentRuntimeInfrastructureRequestV1,
): RevmWorkerDeploymentPortV1 {
  const realPath = realpathSync(request.revmWorkerExecutablePath);
  const stat = statSync(realPath);
  if (realPath !== request.revmWorkerExecutablePath || !stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new TypeError("deployment REVM worker executable is not a canonical executable file");
  }
  const observedSha256 = sha256Hex(new Uint8Array(readFileSync(realPath)));
  if (observedSha256 !== request.revmWorkerExecutableSha256
    || observedSha256 !== binding.selectedExecutor.executableFingerprint) {
    throw new TypeError("deployment REVM worker executable does not join the signed release");
  }
  if (binding.selectedExecutor.executorKind !== "revm") {
    throw new TypeError("deployment selected executor is not REVM");
  }
  const qualification = Object.freeze({
    engineBuildFingerprint: binding.selectedExecutor.engineBuildFingerprint,
    executableFingerprint: binding.selectedExecutor.executableFingerprint,
  });
  return issueRevmWorkerDeploymentPort({
    factory: createNodeRevmWorkerFactory({
      command: realPath,
      args: Object.freeze([
        "--worker-epoch",
        binding.workerEpoch,
        "--engine-build-fingerprint",
        qualification.engineBuildFingerprint,
        "--executable-fingerprint",
        qualification.executableFingerprint,
      ]),
      qualification,
    }),
    qualification,
    selectedExecutor: binding.selectedExecutor,
    selectedExecutorLeafHash: binding.selectedExecutorLeafHash,
    qualifiedExecutorRegistryRoot: binding.qualifiedExecutorRegistryRoot,
  });
}

/**
 * Same-bundle production owner for scheduler and REVM infrastructure.  The
 * approved external module contributes data only; every usable capability is
 * minted by the statically bundled owner instance.
 */
export function issueDeploymentRuntimeInfrastructureV1(input: Readonly<{
  readonly binding: RuntimeReleaseBindingV1;
  readonly request: DeploymentRuntimeInfrastructureRequestV1;
}>): DeploymentRuntimeInfrastructureCapabilityV1 {
  assertExactKeys(input, ["binding", "request"]);
  const binding = decodeRuntimeReleaseBindingV1(input.binding);
  const request = decodeDeploymentRuntimeInfrastructureRequestV1(input.request);
  const scheduler = issueReleaseScheduler(binding);
  const revmDeployment = issueReleaseRevmDeployment(binding, request);
  const proofs = issueExternalProofPortsV1({ binding, request: request.externalProofSigner });
  const ports = Object.freeze({ ...proofs, scheduler, revmDeployment });
  const capability = Object.freeze(Object.create(null));
  issuedInfrastructure.set(capability, Object.freeze({ binding, ports }));
  return capability;
}

export function readDeploymentRuntimeInfrastructureV1(
  capability: DeploymentRuntimeInfrastructureCapabilityV1,
  bindingValue: RuntimeReleaseBindingV1,
): DeploymentRuntimeInfrastructurePortsV1 {
  if (capability === null || typeof capability !== "object" || Reflect.ownKeys(capability).length !== 0) {
    throw new TypeError("deployment runtime infrastructure capability is invalid");
  }
  const state = issuedInfrastructure.get(capability);
  if (state === undefined) throw new TypeError("deployment runtime infrastructure capability was not issued");
  const binding = decodeRuntimeReleaseBindingV1(bindingValue);
  if (state.binding.bindingId !== binding.bindingId
    || state.binding.payloadHash !== binding.payloadHash
    || runtimeReleaseBindingProvenanceHash(state.binding) !== runtimeReleaseBindingProvenanceHash(binding)) {
    throw new TypeError("deployment runtime infrastructure release identity mismatch");
  }
  readQualifiedSharedSchedulerRuntimePort(
    state.ports.scheduler.runtime,
    state.ports.scheduler.issuer,
    state.ports.scheduler.capability,
  );
  readIssuedRevmWorkerDeploymentPort(state.ports.revmDeployment);
  return state.ports;
}
