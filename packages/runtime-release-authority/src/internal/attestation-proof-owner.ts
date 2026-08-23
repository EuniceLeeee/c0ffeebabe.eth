import {
  assertExactKeys,
  assertPlainObject,
} from "../../../canonical-codec/src/index.ts";
import {
  assertActiveRuntimeReleaseAuthorityState,
  type RuntimeReleaseAuthorityStateV1,
} from "./state.ts";

/** Neutral callable surface; Attestation owns the concrete proof schemas. */
export interface RuntimeReleaseAttestationProofPortV1 {
  issueIdentity(input: unknown): unknown;
  verifyIdentity(value: unknown, context: unknown): unknown;
  issueOutcome(input: unknown): unknown;
  verifyOutcome(value: unknown, context: unknown): unknown;
}

export type RuntimeReleaseAttestationProofCapabilityV1 = object;

export interface IssuedRuntimeReleaseAttestationProofV1 {
  readonly authority: object;
  readonly version: bigint;
  readonly bindingId: string;
  readonly state: RuntimeReleaseAuthorityStateV1;
  readonly port: RuntimeReleaseAttestationProofPortV1;
}

const proofStates = new WeakMap<object, IssuedRuntimeReleaseAttestationProofV1>();
const deploymentProofPorts = new WeakSet<object>();

/**
 * Deployment packaging owns the concrete signer/verifier implementation.
 * Runtime composition accepts only a port registered through this exact
 * owner edge; a structurally identical object is never sufficient.
 */
export function issueDeploymentAttestationProofPort(
  value: RuntimeReleaseAttestationProofPortV1,
): RuntimeReleaseAttestationProofPortV1 {
  assertPlainObject(value, "deploymentAttestationProofPort");
  assertExactKeys(value, ["issueIdentity", "verifyIdentity", "issueOutcome", "verifyOutcome"], "deploymentAttestationProofPort");
  if (
    typeof value.issueIdentity !== "function"
    || typeof value.verifyIdentity !== "function"
    || typeof value.issueOutcome !== "function"
    || typeof value.verifyOutcome !== "function"
  ) throw new TypeError("deployment attestation proof port invalid");
  deploymentProofPorts.add(value);
  return value;
}

/** Runtime-release owner: issue a proof-port capability bound to one lease. */
export function issueRuntimeReleaseAttestationProofPort(
  authorityValue: unknown,
  value: unknown,
): RuntimeReleaseAttestationProofCapabilityV1 {
  const state = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  if (value === null || typeof value !== "object" || !deploymentProofPorts.has(value)) {
    throw new TypeError("runtime release attestation proof port not deployment-issued");
  }
  assertPlainObject(value, "runtimeReleaseAttestationProofPort");
  assertExactKeys(value, ["issueIdentity", "verifyIdentity", "issueOutcome", "verifyOutcome"], "runtimeReleaseAttestationProofPort");
  if (
    typeof value.issueIdentity !== "function"
    || typeof value.verifyIdentity !== "function"
    || typeof value.issueOutcome !== "function"
    || typeof value.verifyOutcome !== "function"
  ) throw new TypeError("runtime release attestation proof port invalid");
  const port = Object.freeze({
    issueIdentity: value.issueIdentity,
    verifyIdentity: value.verifyIdentity,
    issueOutcome: value.issueOutcome,
    verifyOutcome: value.verifyOutcome,
  }) as RuntimeReleaseAttestationProofPortV1;
  const capability = Object.freeze(Object.create(null)) as object;
  proofStates.set(capability, {
    authority: authorityValue as object,
    version: state.version,
    bindingId: state.binding.bindingId,
    state,
    port,
  });
  return capability;
}

export function readIssuedRuntimeReleaseAttestationProof(
  value: unknown,
): IssuedRuntimeReleaseAttestationProofV1 {
  if (value === null || typeof value !== "object") {
    throw new TypeError("runtime release attestation proof capability invalid");
  }
  const issued = proofStates.get(value);
  if (!issued) throw new TypeError("runtime release attestation proof capability not issued");
  return issued;
}
