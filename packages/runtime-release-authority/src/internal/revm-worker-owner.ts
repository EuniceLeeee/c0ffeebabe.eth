import {
  createRuntimeReleaseExecutorLeaseV1,
  type RuntimeReleaseExecutorLeaseV1,
} from "../../../../specs/release-authority/src/index.ts";
import {
  type QualifiedExecutorAuthorityCapability,
  type QualifiedExecutorAuthorityIssuer,
} from "../../../../packages/scheduler/src/index.ts";
import { assertIssuedQualifiedExecutorAuthorityIssuer } from "../../../../packages/scheduler/src/internal/authority-consumer.ts";
import { assertRuntimeReleaseQualifiedExecutorAuthorityIssuerBoundTo } from "./scheduler-authority-owner.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import type { RevmWorkerAuthorityBindingV1 } from "../../../../runtime/revm-workers/src/protocol.ts";
import type {
  RevmWorkerAuthorityIssuer,
} from "../../../../runtime/revm-workers/src/lifecycle.ts";
import type { RevmWorkerFactory, RevmWorkerQualification } from "../../../../runtime/revm-workers/src/lifecycle.ts";
import {
  issueRevmWorkerAuthorityIssuer,
  readIssuedRevmWorkerDeploymentPort,
  type RevmWorkerDeploymentStateV1,
} from "../../../../runtime/revm-workers/src/internal/authority.ts";
import {
  hashQualifiedExecutorRegistryEntry,
  type QualifiedExecutorRegistryEntryV1,
  hashRuntimeReleaseExecutorLeaseV1,
} from "../../../../specs/release-authority/src/index.ts";

/** Runtime-release-owned wrapper around the deployment-issued worker port. */
export type RuntimeReleaseRevmWorkerDeploymentPortV1 = object;

interface RuntimeReleaseRevmWorkerDeploymentStateV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly version: bigint;
  readonly deployment: RevmWorkerDeploymentStateV1;
}

const runtimeDeploymentPorts = new WeakMap<object, RuntimeReleaseRevmWorkerDeploymentStateV1>();

const EXECUTOR_FIELDS = Object.freeze([
  "executorKind",
  "engineBuildFingerprint",
  "executableFingerprint",
  "closureFingerprint",
  "protocolFingerprint",
  "schemaFingerprint",
  "releaseRoleManifestRoot",
  "candidateCommit",
] as const);

function sameSelectedExecutor(
  left: QualifiedExecutorRegistryEntryV1,
  right: QualifiedExecutorRegistryEntryV1,
): boolean {
  if (hashQualifiedExecutorRegistryEntry(left) !== hashQualifiedExecutorRegistryEntry(right)) return false;
  return EXECUTOR_FIELDS.every((field) => left[field] === right[field]);
}

/**
 * Join a deployment-issued factory/qualification capability to the exact
 * executor selected by the verified signed runtime binding.  A structural
 * object, a cloned port, a different executor leaf, or a different registry
 * root cannot reach bootstrap.
 */
export function issueRuntimeReleaseRevmWorkerDeploymentPort(
  authorityValue: unknown,
  deploymentPortValue: unknown,
): RuntimeReleaseRevmWorkerDeploymentPortV1 {
  const authority = authorityValue as RuntimeReleaseAuthorityV1;
  const state = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  const deployment = readIssuedRevmWorkerDeploymentPort(deploymentPortValue);
  const selected = state.binding.selectedExecutor;
  if (
    deployment.qualifiedExecutorRegistryRoot !== state.binding.qualifiedExecutorRegistryRoot
    || deployment.selectedExecutorLeafHash !== state.binding.selectedExecutorLeafHash
    || !sameSelectedExecutor(deployment.selectedExecutor, selected)
    || deployment.qualification.engineBuildFingerprint !== selected.engineBuildFingerprint
    || deployment.qualification.executableFingerprint !== selected.executableFingerprint
  ) {
    throw new TypeError("REVM worker deployment is not bound to the signed selected executor");
  }
  const port = Object.freeze(Object.create(null)) as RuntimeReleaseRevmWorkerDeploymentPortV1;
  runtimeDeploymentPorts.set(port, Object.freeze({ authority, version: state.version, deployment }));
  return port;
}

/** Bootstrap-only read; the returned factory and qualification never cross a public facade. */
export function readRuntimeReleaseRevmWorkerDeploymentPort(
  authorityValue: unknown,
  portValue: unknown,
): Readonly<{ readonly factory: RevmWorkerFactory; readonly qualification: RevmWorkerQualification }> {
  if (portValue === null || typeof portValue !== "object") throw new TypeError("runtime release REVM deployment port is invalid");
  const state = runtimeDeploymentPorts.get(portValue);
  if (!state || state.authority !== authorityValue) throw new TypeError("runtime release REVM deployment port is not owner-issued");
  const current = assertActiveRuntimeReleaseAuthorityState(state.authority);
  if (current.version !== state.version) throw new TypeError("runtime release REVM deployment port stale after rotation");
  const selected = current.binding.selectedExecutor;
  if (
    state.deployment.qualifiedExecutorRegistryRoot !== current.binding.qualifiedExecutorRegistryRoot
    || state.deployment.selectedExecutorLeafHash !== current.binding.selectedExecutorLeafHash
    || !sameSelectedExecutor(state.deployment.selectedExecutor, selected)
    || state.deployment.qualification.engineBuildFingerprint !== selected.engineBuildFingerprint
    || state.deployment.qualification.executableFingerprint !== selected.executableFingerprint
  ) throw new TypeError("runtime release REVM deployment no longer matches signed selected executor");
  return Object.freeze({ factory: state.deployment.factory, qualification: state.deployment.qualification });
}

/**
 * Narrow release-owner edge for REVM workers.  The full signed binding stays
 * inside runtime-release-authority; only the schema-owned lease projection
 * crosses into the worker pool.  The scheduler capability supplies the
 * current epoch/session, so replacement workers cannot reuse stale state.
 */
export function issueRuntimeReleaseExecutorLeaseV1(
  authorityValue: unknown,
  schedulerIssuerValue: unknown,
  capability: QualifiedExecutorAuthorityCapability,
): RuntimeReleaseExecutorLeaseV1 {
  const authority = authorityValue as RuntimeReleaseAuthorityV1;
  const state = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  const issuer: QualifiedExecutorAuthorityIssuer = assertIssuedQualifiedExecutorAuthorityIssuer(schedulerIssuerValue);
  const provenance = issuer.provenance(capability);
  if (issuer.registryRoot !== state.binding.qualifiedExecutorRegistryRoot
    || issuer.authorityRoot !== state.binding.executorAuthorityRoot
    || provenance.authorityRoot !== state.binding.executorAuthorityRoot) {
    throw new TypeError("REVM worker lease is not bound to the current runtime release");
  }
  return createRuntimeReleaseExecutorLeaseV1(
    state.binding,
    provenance.workerEpoch,
    provenance.executorSession,
  );
}

/** Production owner for the REVM pool's continuously checked authority. */
export function issueRuntimeReleaseRevmWorkerAuthorityIssuer(
  authorityValue: unknown,
  schedulerIssuerValue: unknown,
): RevmWorkerAuthorityIssuer {
  const authority = authorityValue as RuntimeReleaseAuthorityV1;
  const state = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  const issuedVersion = state.version;
  const issuer = assertRuntimeReleaseQualifiedExecutorAuthorityIssuerBoundTo(schedulerIssuerValue, authority);
  if (
    issuer.registryRoot !== state.binding.qualifiedExecutorRegistryRoot
    || issuer.authorityRoot !== state.binding.executorAuthorityRoot
  ) {
    throw new TypeError("REVM worker issuer does not match the current runtime release");
  }
  const capabilities = new Map<string, QualifiedExecutorAuthorityCapability>();
  return issueRevmWorkerAuthorityIssuer(Object.freeze({
    issue(): RevmWorkerAuthorityBindingV1 {
      const current = assertActiveRuntimeReleaseAuthorityState(authority);
      if (current.version !== issuedVersion) throw new TypeError("REVM worker authority issuer stale after rotation");
      const capability = issuer.open({ worker: { workerEpoch: current.binding.workerEpoch, ...current.binding.selectedExecutor } });
      const initialProvenance = issuer.provenance(capability);
      const workerEpoch = `${current.binding.workerEpoch}/${initialProvenance.executorSession.slice(2)}`;
      const workerCapability = issuer.rotate({ worker: { workerEpoch, ...current.binding.selectedExecutor } });
      const lease = issueRuntimeReleaseExecutorLeaseV1(authority, issuer, workerCapability);
      capabilities.set(hashRuntimeReleaseExecutorLeaseV1(lease), workerCapability);
      return Object.freeze({
        release: lease,
        authorityRoot: lease.executorAuthorityRoot,
        workerEpoch: lease.workerEpoch,
        executorSessionHash: lease.executorSessionHash,
      });
    },
    assertCurrent(binding: RevmWorkerAuthorityBindingV1): void {
      const current = assertActiveRuntimeReleaseAuthorityState(authority);
      if (current.version !== issuedVersion) throw new TypeError("REVM worker authority issuer stale after rotation");
      const capability = capabilities.get(hashRuntimeReleaseExecutorLeaseV1(binding.release));
      if (!capability) throw new TypeError("REVM worker authority was not issued by this release owner");
      const provenance = issuer.provenance(capability);
      if (
        provenance.authorityRoot !== binding.authorityRoot
        || provenance.workerEpoch !== binding.workerEpoch
        || provenance.executorSession !== binding.executorSessionHash
      ) throw new TypeError("REVM worker authority is stale");
    },
  }));
}
