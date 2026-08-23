import type {
  RevmWorkerAuthorityIssuer,
  RevmWorkerFactory,
  RevmWorkerQualification,
} from "../lifecycle.ts";

const issued = new WeakSet<object>();
const deploymentPorts = new WeakMap<object, RevmWorkerDeploymentStateV1>();

/**
 * The worker pool must not receive a structural factory/qualification pair.
 * Deployment packaging issues this process-local capability after it has
 * selected the executor implementation.  Runtime-release-authority performs
 * the second, signed-binding join before the port reaches bootstrap.
 */
export type RevmWorkerDeploymentPortV1 = object;

export type RevmWorkerDeploymentHashV1 = `0x${string}`;

/** Structural data held behind the opaque port; the signed exact join lives
 * in runtime-release-authority, not in this worker transport package. */
export interface RevmWorkerDeploymentSelectedExecutorV1 {
  readonly executorKind: string;
  readonly engineBuildFingerprint: RevmWorkerDeploymentHashV1;
  readonly executableFingerprint: RevmWorkerDeploymentHashV1;
  readonly closureFingerprint: RevmWorkerDeploymentHashV1;
  readonly protocolFingerprint: RevmWorkerDeploymentHashV1;
  readonly schemaFingerprint: RevmWorkerDeploymentHashV1;
  readonly releaseRoleManifestRoot: RevmWorkerDeploymentHashV1;
  readonly candidateCommit: string;
}

export interface RevmWorkerDeploymentStateV1 {
  readonly factory: RevmWorkerFactory;
  readonly qualification: RevmWorkerQualification;
  readonly selectedExecutor: RevmWorkerDeploymentSelectedExecutorV1;
  readonly selectedExecutorLeafHash: RevmWorkerDeploymentHashV1;
  readonly qualifiedExecutorRegistryRoot: RevmWorkerDeploymentHashV1;
}

function assertFactory(value: unknown): asserts value is RevmWorkerFactory {
  if (value === null || typeof value !== "object" || typeof (value as { spawn?: unknown }).spawn !== "function") {
    throw new TypeError("REVM worker deployment factory is invalid");
  }
}

function assertQualification(value: unknown): asserts value is RevmWorkerQualification {
  if (value === null || typeof value !== "object"
    || typeof (value as { engineBuildFingerprint?: unknown }).engineBuildFingerprint !== "string"
    || (value as { engineBuildFingerprint: string }).engineBuildFingerprint.length === 0
    || typeof (value as { executableFingerprint?: unknown }).executableFingerprint !== "string"
    || (value as { executableFingerprint: string }).executableFingerprint.length === 0) {
    throw new TypeError("REVM worker deployment qualification is invalid");
  }
}

/** Issue the low-level opaque deployment capability used by release packaging. */
export function issueRevmWorkerDeploymentPort(input: {
  readonly factory: RevmWorkerFactory;
  readonly qualification: RevmWorkerQualification;
  readonly selectedExecutor: RevmWorkerDeploymentSelectedExecutorV1;
  readonly selectedExecutorLeafHash: RevmWorkerDeploymentHashV1;
  readonly qualifiedExecutorRegistryRoot: RevmWorkerDeploymentHashV1;
}): RevmWorkerDeploymentPortV1 {
  assertFactory(input.factory);
  assertQualification(input.qualification);
  if (input.selectedExecutor === null || typeof input.selectedExecutor !== "object") throw new TypeError("REVM worker deployment selected executor is invalid");
  if (typeof input.selectedExecutorLeafHash !== "string" || input.selectedExecutorLeafHash.length === 0) throw new TypeError("REVM worker deployment selected executor leaf is invalid");
  if (typeof input.qualifiedExecutorRegistryRoot !== "string" || input.qualifiedExecutorRegistryRoot.length === 0) throw new TypeError("REVM worker deployment registry root is invalid");
  const port = Object.freeze(Object.create(null)) as RevmWorkerDeploymentPortV1;
  deploymentPorts.set(port, Object.freeze({
    factory: input.factory,
    qualification: Object.freeze({ ...input.qualification }),
    selectedExecutor: Object.freeze({ ...input.selectedExecutor }),
    selectedExecutorLeafHash: input.selectedExecutorLeafHash,
    qualifiedExecutorRegistryRoot: input.qualifiedExecutorRegistryRoot,
  }));
  return port;
}

export function readIssuedRevmWorkerDeploymentPort(value: unknown): RevmWorkerDeploymentStateV1 {
  if (value === null || typeof value !== "object") throw new TypeError("REVM worker deployment port is invalid");
  const state = deploymentPorts.get(value);
  if (!state) throw new TypeError("REVM worker deployment port is not deployment-issued");
  return state;
}

/** Runtime-release composition registers the narrow owner edge once. */
export function issueRevmWorkerAuthorityIssuer(value: RevmWorkerAuthorityIssuer): RevmWorkerAuthorityIssuer {
  if (value === null || typeof value !== "object" || typeof value.issue !== "function" || typeof value.assertCurrent !== "function") {
    throw new TypeError("REVM worker authority issuer is invalid");
  }
  issued.add(value);
  return value;
}

export function assertIssuedRevmWorkerAuthorityIssuer(value: unknown): RevmWorkerAuthorityIssuer {
  if (value === null || typeof value !== "object" || !issued.has(value)) throw new TypeError("REVM worker authority issuer is not release-issued");
  return value as RevmWorkerAuthorityIssuer;
}
