import {
  createPrivateKey,
  createPublicKey,
  sign as signSignature,
  verify as verifySignature,
} from "node:crypto";
import {
  hashDomain,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import {
  candidatePartitionRoot,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
} from "../../discovery/src/index.ts";
import { CandidatePartitionCapabilityRegistryV1 } from "../../checkpoint/src/candidate-partition.ts";
import type {
  AttestationCompositionBindingV1,
} from "../src/index.ts";
import {
  issueRuntimeReleaseAttestationComposition,
} from "../../runtime-release-authority/src/internal/attestation-composition-owner.ts";
import {
  issueDeploymentAttestationProofPort,
  issueRuntimeReleaseAttestationProofPort,
} from "../../runtime-release-authority/src/internal/attestation-proof-owner.ts";
import type { RuntimeReleaseAttestationProofPortV1 } from "../../runtime-release-authority/src/internal/attestation-proof-owner.ts";
import {
  verifyAndIssueRuntimeReleaseAuthorityV1,
  type RuntimeReleaseAuthorityV1,
} from "../../runtime-release-authority/src/index.ts";
import {
  createRuntimeReleaseBindingV1,
  hashQualifiedExecutorRegistryEntry,
  runtimeReleaseBindingProvenanceHash,
  runtimeReleaseBindingSigningBytes,
  decodeRuntimeReleaseBindingV1,
  type QualifiedExecutorRegistryEntryV1,
  type RuntimeReleaseBindingV1,
  type RuntimeReleaseReadyBindingPortV1,
} from "../../../specs/release-authority/src/index.ts";
import {
  identityProofSigningBytes,
  issueIdentityIssuerProof,
  validateIdentityIssuerProof,
} from "../src/internal/identity-proof.ts";
import {
  issueOutcomeIssuerProof,
  outcomeProofSigningBytes,
  validateOutcomeIssuerProof,
} from "../src/internal/outcome-proof.ts";
import type {
  AttestationIdentityProofIssueInputV1,
  AttestationIdentityProofVerificationContextV1,
  AttestationOutcomeProofIssueInputV1,
  AttestationOutcomeProofVerificationContextV1,
  AttestationProofIssuerVerifierPortV1,
} from "../src/internal-authority.ts";
import {
  candidatePartitionBindingFromProof,
  candidatePartitionProofId,
  candidatePartitionProofPayloadHash,
  candidatePartitionProofSigningBytes,
  makeCandidatePartitionProofPayload,
  validateCandidatePartitionProof,
  type CandidatePartitionCapabilityV1,
  type CandidatePartitionBindingV1,
  type CandidatePartitionProofV1,
  type CandidatePartitionReaderPortV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";

// Fake test-only keys. The runtime-release signer and the attestation-proof
// signer are intentionally independent authorities even though both remain
// local, non-deployment test secrets.
const TEST_RUNTIME_PRIVATE_KEY_DER_BASE64 = "MC4CAQAwBQYDK2VwBCIEIEBAOLzUm+xCyUyxN7J7I7T+HnXDpbspGV2pkeJ9n+wu";
const TEST_PROOF_PRIVATE_KEY_DER_BASE64 = "MC4CAQAwBQYDK2VwBCIEIMACddI2GBQNxi2x3jdjynvkIVlghMd4ZDqSXQ0gvw+L";
const TEST_CANDIDATE_PARTITION_PRIVATE_KEY_DER_BASE64 = "MC4CAQAwBQYDK2VwBCIEIBkwnjY4jrp3lZ5OHLbf6/zyv+KqmljVVV38rJEoFMrv";
const TEST_RUNTIME_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(TEST_RUNTIME_PRIVATE_KEY_DER_BASE64, "base64"),
  format: "der",
  type: "pkcs8",
});
const TEST_PROOF_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(TEST_PROOF_PRIVATE_KEY_DER_BASE64, "base64"),
  format: "der",
  type: "pkcs8",
});
const TEST_CANDIDATE_PARTITION_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(TEST_CANDIDATE_PARTITION_PRIVATE_KEY_DER_BASE64, "base64"),
  format: "der",
  type: "pkcs8",
});
const TEST_RUNTIME_PUBLIC_KEY = createPublicKey(TEST_RUNTIME_PRIVATE_KEY);
const TEST_PROOF_PUBLIC_KEY = createPublicKey(TEST_PROOF_PRIVATE_KEY);
const TEST_CANDIDATE_PARTITION_PUBLIC_KEY = createPublicKey(TEST_CANDIDATE_PARTITION_PRIVATE_KEY);
const TEST_RUNTIME_SIGNER_KEY_ID = hashDomain("test/runtime-release-signer-key", "v2");
const TEST_ATTESTATION_PROOF_KEY_ID = hashDomain("test/attestation-proof-signer-key", "v2");
export const TEST_CANDIDATE_PARTITION_PROOF_KEY_ID = hashDomain("test/candidate-partition-proof-signer-key", "v1");

interface ActiveApprovalState {
  readonly authority: RuntimeReleaseAuthorityV1;
}

// Test-only release composition.  Runtime authority owns the actual
// capability and version fence; this map only lets the fixture request
// revoke/rotation operations without exposing those controls to production.
const approvals = new WeakMap<object, ActiveApprovalState>();

function signRuntimeHex(bytes: Uint8Array): `0x${string}` {
  const signature = signSignature(null, bytes, TEST_RUNTIME_PRIVATE_KEY);
  let signatureHex = "0x";
  for (const byte of signature) signatureHex += byte.toString(16).padStart(2, "0");
  return signatureHex as `0x${string}`;
}

function signProofHex(bytes: Uint8Array): `0x${string}` {
  const signature = signSignature(null, bytes, TEST_PROOF_PRIVATE_KEY);
  let signatureHex = "0x";
  for (const byte of signature) signatureHex += byte.toString(16).padStart(2, "0");
  return signatureHex as `0x${string}`;
}

export function signCandidatePartitionProofHex(bytes: Uint8Array): `0x${string}` {
  const signature = signSignature(null, bytes, TEST_CANDIDATE_PARTITION_PRIVATE_KEY);
  let signatureHex = "0x";
  for (const byte of signature) signatureHex += byte.toString(16).padStart(2, "0");
  return signatureHex as `0x${string}`;
}

export function verifyCandidatePartitionProofHex(bytes: Uint8Array, signatureHex: string): void {
  const signature = Buffer.from(signatureHex.slice(2), "hex");
  if (!verifySignature(null, bytes, TEST_CANDIDATE_PARTITION_PUBLIC_KEY, signature)) {
    throw new TypeError("test candidate partition Ed25519 signature invalid");
  }
}

export interface CandidatePartitionFixtureV1 {
  readonly capability: CandidatePartitionCapabilityV1;
  readonly reader: CandidatePartitionReaderPortV1;
  readonly binding: CandidatePartitionBindingV1;
}

/**
 * Issue and verify a real test-only partition proof, then register it in the
 * checkpoint-owned capability registry. Tests must use this path instead of
 * passing a shape-compatible object as a candidate partition capability.
 */
export function issueCandidatePartitionFixture(
  approval: AttestationCompositionBindingV1,
  registry: CandidatePartitionCapabilityRegistryV1,
  candidates: readonly CandidateRecordV1[],
  cutoff: CanonicalCutoffV1,
  runId = "run-a",
  checkpointRevision = "1",
): CandidatePartitionFixtureV1 {
  const binding = approval.resolver.resolve(approval.capability).provenance.runtimeBinding;
  const payload = makeCandidatePartitionProofPayload({
    runId,
    cutoff,
    candidatePartitionRoot: candidatePartitionRoot(candidates),
    candidatePartitionStorageHash: hashDomain("test/candidate-partition-storage", `${runId}:${checkpointRevision}`),
    candidates,
    recentObservationRoot: hashDomain("test/candidate-partition-observation", `${runId}:${checkpointRevision}`),
    sourceCoverageRoot: hashDomain("test/candidate-partition-coverage", `${runId}:${checkpointRevision}`),
    checkpointRevision,
    releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
    issuerKeyId: binding.candidatePartitionProofIssuerKeyId,
  });
  const payloadHash = candidatePartitionProofPayloadHash(payload);
  const proofValue: CandidatePartitionProofV1 = {
    ...payload,
    proofId: candidatePartitionProofId(payloadHash),
    payloadHash,
    signatureAlgorithm: "ed25519",
    signerKeyId: payload.issuerKeyId,
    signatureHex: signCandidatePartitionProofHex(candidatePartitionProofSigningBytes(payload, payload.issuerKeyId)),
  };
  const proof = validateCandidatePartitionProof(proofValue, {
    binding: candidatePartitionBindingFromProof(proofValue),
    release: {
      releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(binding),
      releaseAuthorityRoot: binding.releaseAuthorityRoot,
      candidatePartitionProofIssuerKeyId: binding.candidatePartitionProofIssuerKeyId,
    },
  });
  verifyCandidatePartitionProofHex(candidatePartitionProofSigningBytes(proof), proof.signatureHex);
  const capability = registry.registerVerifiedProof(proof, candidates);
  return Object.freeze({ capability, reader: registry.reader, binding: candidatePartitionBindingFromProof(proof) });
}

function verifyRuntimeHex(bytes: Uint8Array, signatureHex: string): void {
  const signature = Buffer.from(signatureHex.slice(2), "hex");
  if (!verifySignature(null, bytes, TEST_RUNTIME_PUBLIC_KEY, signature)) throw new TypeError("test runtime Ed25519 signature invalid");
}

function verifyProofHex(bytes: Uint8Array, signatureHex: string): void {
  const signature = Buffer.from(signatureHex.slice(2), "hex");
  if (!verifySignature(null, bytes, TEST_PROOF_PUBLIC_KEY, signature)) throw new TypeError("test attestation Ed25519 signature invalid");
}

function runtimePublicKeyHex(): `0x${string}` {
  const der = TEST_RUNTIME_PUBLIC_KEY.export({ format: "der", type: "spki" });
  return `0x${Buffer.from(der).subarray(-32).toString("hex")}`;
}

function verifyActiveBinding(
  state: ActiveApprovalState,
  expectedBinding: RuntimeReleaseBindingV1 | null = null,
): RuntimeReleaseBindingV1 {
  const binding = decodeRuntimeReleaseBindingV1(
    state.authority.resolver.resolve(state.authority.capability),
  );
  if (binding.signerKeyId !== TEST_RUNTIME_SIGNER_KEY_ID) throw new TypeError("test runtime release signer key mismatch");
  verifyRuntimeHex(runtimeReleaseBindingSigningBytes(binding), binding.signatureHex);
  if (expectedBinding !== null && binding.bindingId !== expectedBinding.bindingId) {
    throw new TypeError("test runtime release binding stale");
  }
  return binding;
}

function assertIdentityProofBinding(
  input: AttestationIdentityProofIssueInputV1 | AttestationIdentityProofVerificationContextV1,
  binding: RuntimeReleaseBindingV1,
): void {
  if (
    input.attestationProofIssuerKeyId !== binding.attestationProofIssuerKeyId
    || input.releaseProvenanceHash !== runtimeReleaseBindingProvenanceHash(binding)
    || input.frameworkAuthorityRoot !== binding.frameworkAuthorityRoot
    || input.executorAuthorityRoot !== binding.executorAuthorityRoot
    || input.releaseAuthorityRoot !== binding.releaseAuthorityRoot
  ) throw new TypeError("test identity proof runtime binding mismatch");
}

function assertOutcomeProofBinding(
  input: AttestationOutcomeProofIssueInputV1 | AttestationOutcomeProofVerificationContextV1,
  binding: RuntimeReleaseBindingV1,
): void {
  if (
    input.attestationProofIssuerKeyId !== binding.attestationProofIssuerKeyId
    || input.releaseProvenanceHash !== runtimeReleaseBindingProvenanceHash(binding)
    || input.frameworkAuthorityRoot !== binding.frameworkAuthorityRoot
    || input.executorAuthorityRoot !== binding.executorAuthorityRoot
    || input.releaseAuthorityRoot !== binding.releaseAuthorityRoot
  ) throw new TypeError("test outcome proof runtime binding mismatch");
}

function proofPort(
  state: ActiveApprovalState,
  binding: RuntimeReleaseBindingV1,
): AttestationProofIssuerVerifierPortV1 {
  let proofSequence = 0n;
  return Object.freeze({
    issueIdentity(input: AttestationIdentityProofIssueInputV1) {
      const activeBinding = verifyActiveBinding(state, binding);
      assertIdentityProofBinding(input, activeBinding);
      proofSequence += 1n;
      return issueIdentityIssuerProof(input, TEST_ATTESTATION_PROOF_KEY_ID, proofSequence.toString(), bytes => signProofHex(bytes));
    },
    verifyIdentity(value: unknown, context: AttestationIdentityProofVerificationContextV1) {
      const activeBinding = verifyActiveBinding(state, binding);
      assertIdentityProofBinding(context, activeBinding);
      const proof = validateIdentityIssuerProof(value, context);
      if (proof.issuerKeyId !== activeBinding.attestationProofIssuerKeyId) throw new TypeError("test identity proof key mismatch");
      verifyProofHex(identityProofSigningBytes(proof), proof.signatureHex);
      return proof;
    },
    issueOutcome(input: AttestationOutcomeProofIssueInputV1) {
      const activeBinding = verifyActiveBinding(state, binding);
      assertOutcomeProofBinding(input, activeBinding);
      proofSequence += 1n;
      return issueOutcomeIssuerProof(input, TEST_ATTESTATION_PROOF_KEY_ID, proofSequence.toString(), bytes => signProofHex(bytes));
    },
    verifyOutcome(value: unknown, context: AttestationOutcomeProofVerificationContextV1) {
      const activeBinding = verifyActiveBinding(state, binding);
      assertOutcomeProofBinding(context, activeBinding);
      const proof = validateOutcomeIssuerProof(value, context);
      if (proof.issuerKeyId !== activeBinding.attestationProofIssuerKeyId) throw new TypeError("test outcome proof key mismatch");
      verifyProofHex(outcomeProofSigningBytes(proof), proof.signatureHex);
      return proof;
    },
  });
}

function runtimeBinding(
  frameworkAuthorityRoot: Hash,
  executorAuthorityRoot: Hash,
  workerEpoch: string,
  executorSessionHash: Hash,
  releaseAuthorityRoot: Hash,
): RuntimeReleaseBindingV1 {
  const selectedExecutor: QualifiedExecutorRegistryEntryV1 = {
    executorKind: "test-executor",
    engineBuildFingerprint: hashDomain("test/executor-engine", "v2"),
    executableFingerprint: hashDomain("test/executor-executable", "v2"),
    closureFingerprint: hashDomain("test/executor-closure", "v2"),
    protocolFingerprint: hashDomain("test/executor-protocol", "v2"),
    schemaFingerprint: hashDomain("test/executor-schema", "v2"),
    releaseRoleManifestRoot: hashDomain("test/release-role-manifest", "v2"),
    candidateCommit: "a".repeat(40),
  };
  const selectedExecutorLeafHash = hashQualifiedExecutorRegistryEntry(selectedExecutor);
  const qualifiedExecutorRegistryRoot = hashDomain("aloha/qualified-executor-registry-root/v1", {
    entries: [selectedExecutor],
    leafRoots: [selectedExecutorLeafHash],
  });
  const payload = {
    schemaVersion: 1 as const,
    kind: "aloha.runtime-release-binding" as const,
    acceptanceCertificate: {
      certificateId: hashDomain("test/acceptance-certificate", "id"),
      payloadHash: hashDomain("test/acceptance-certificate", "payload"),
      verdict: "pass" as const,
    },
    releaseAuthorityApprovalId: hashDomain("test/release-approval", "id"),
    releaseAuthorityApprovalPayloadHash: hashDomain("test/release-approval", "payload"),
    authorityPinDigest: hashDomain("test/release-approval", "pin"),
    externalTrustAnchorRoot: hashDomain("test/release-approval", "trust-anchor"),
    externalIssuerKeySetRoot: hashDomain("test/release-approval", "issuer-key-set"),
    qualificationRegistryApprovalId: hashDomain("test/release-approval", "registry-approval"),
    qualificationRegistryRoot: hashDomain("test/release-approval", "registry"),
    qualificationEpoch: "1",
    qualificationAudienceHash: hashDomain("test/release-approval", "audience"),
    predicateCompositionRootDigest: hashDomain("test/release-approval", "predicate-composition"),
    gateCoreRuntimeClosureDigest: hashDomain("test/release-approval", "runtime-closure"),
    gateCoreImplementationClosureDigest: hashDomain("test/release-approval", "core-closure"),
    qualifiedExecutorRegistryRoot,
    selectedExecutorLeafHash,
    selectedExecutor,
    releaseRoleManifestRoot: selectedExecutor.releaseRoleManifestRoot,
    candidateReleaseCommit: selectedExecutor.candidateCommit,
    workerEpoch,
    executorSessionHash,
    frameworkAuthorityRoot,
    executorAuthorityRoot,
    releaseAuthorityRoot,
    attestationProofIssuerKeyId: TEST_ATTESTATION_PROOF_KEY_ID,
    candidatePartitionProofIssuerKeyId: TEST_CANDIDATE_PARTITION_PROOF_KEY_ID,
  };
  return createRuntimeReleaseBindingV1(payload, TEST_RUNTIME_SIGNER_KEY_ID, signRuntimeHex(runtimeReleaseBindingSigningBytes(payload, TEST_RUNTIME_SIGNER_KEY_ID)));
}
export function releaseApproval(
  frameworkAuthorityRoot: Hash,
  executorAuthorityRoot: Hash,
  workerEpoch = "epoch-1",
  executorSessionHash: Hash = hashDomain("test/executor-session", executorAuthorityRoot),
  releaseAuthorityRoot: Hash = hashDomain("test/release-authority", "v1"),
): AttestationCompositionBindingV1 {
  const binding = runtimeBinding(frameworkAuthorityRoot, executorAuthorityRoot, workerEpoch, executorSessionHash, releaseAuthorityRoot);
  const authority = verifyAndIssueRuntimeReleaseAuthorityV1(binding, {
    signerKeyId: TEST_RUNTIME_SIGNER_KEY_ID,
    publicKeyHex: runtimePublicKeyHex(),
  });
  const state: ActiveApprovalState = { authority };
  const proofPortCapability = issueRuntimeReleaseAttestationProofPort(
    authority,
    issueDeploymentAttestationProofPort(proofPort(state, binding)),
  );
  const approval = issueRuntimeReleaseAttestationComposition(authority, proofPortCapability);
  approvals.set(approval, state);
  return approval;
}

export function revokeReleaseApproval(approval: AttestationCompositionBindingV1): void {
  const state = approvals.get(approval);
  if (!state) throw new TypeError("qualified-composition-capability-not-issued");
  state.authority.revoke();
}

/** Test-only access to the already-issued runtime authority for composition-root contracts. */
export function runtimeAuthorityForReleaseApproval(
  approval: AttestationCompositionBindingV1,
): RuntimeReleaseAuthorityV1 {
  const state = approvals.get(approval);
  if (!state) throw new TypeError("qualified-composition-capability-not-issued");
  return state.authority;
}

/** Test-only access to the external proof port that was qualified for this release. */
export function attestationProofPortForReleaseApproval(
  approval: AttestationCompositionBindingV1,
): RuntimeReleaseAttestationProofPortV1 {
  const state = approvals.get(approval);
  if (!state) throw new TypeError("qualified-composition-capability-not-issued");
  return issueDeploymentAttestationProofPort(proofPort(state, verifyActiveBinding(state)));
}

/** Test-only bridge for consumers that require the runtime-owned narrow
 * current-release port.  Production code never imports this fixture. */
export function readyBindingPortForReleaseApproval(
  approval: AttestationCompositionBindingV1,
): RuntimeReleaseReadyBindingPortV1 {
  const state = approvals.get(approval);
  if (!state) throw new TypeError("qualified-composition-capability-not-issued");
  return state.authority.readyGeneration;
}

export function rotateReleaseApproval(
  approval: AttestationCompositionBindingV1,
  next: {
    readonly frameworkAuthorityRoot?: Hash;
    readonly executorAuthorityRoot?: Hash;
    readonly workerEpoch?: string;
    readonly executorSessionHash?: Hash;
    readonly releaseAuthorityRoot?: Hash;
  },
): void {
  const state = approvals.get(approval);
  if (!state) throw new TypeError("qualified-composition-capability-not-issued");
  const current = verifyActiveBinding(state);
  const nextBinding = runtimeBinding(
    next.frameworkAuthorityRoot ?? current.frameworkAuthorityRoot,
    next.executorAuthorityRoot ?? current.executorAuthorityRoot,
    next.workerEpoch ?? current.workerEpoch,
    next.executorSessionHash ?? current.executorSessionHash,
    next.releaseAuthorityRoot ?? current.releaseAuthorityRoot,
  );
  state.authority.rotate(nextBinding);
}
