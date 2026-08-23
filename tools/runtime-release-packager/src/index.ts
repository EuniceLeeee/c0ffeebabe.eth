import { createPublicKey, verify as verifySignature } from "node:crypto";
import { encodeCanonicalBytes, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { decodeAcceptanceCertificateV1, type AcceptanceCertificateV1 } from "../../../specs/acceptance-certificate/src/index.ts";
import {
  createRuntimeReleaseBindingV1,
  decodeRuntimeReleaseSignerPinV1,
  decodeRuntimeReleaseBindingV1,
  hashQualifiedExecutorRegistryEntry,
  hashQualifiedExecutorRegistryRoot,
  runtimeReleaseBindingSigningBytes,
  type QualifiedExecutorRegistryEntryV1,
  type RuntimeReleaseBindingPayloadV1,
  type RuntimeReleaseBindingV1,
  type RuntimeReleaseSignerPinV1,
} from "../../../specs/release-authority/src/index.ts";
import { decodeSignedReleaseAuthorityApprovalV2 } from "../../../specs/qualification/src/index.ts";
import {
  verifyExternalQualificationV2,
  type VerifyExternalQualificationInputV2,
} from "../../../packages/external-qualification-verifier/src/index.ts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface QualifiedExecutorRegistryArtifactV1 {
  readonly entries: readonly QualifiedExecutorRegistryEntryV1[];
  readonly registryRoot: Hash;
}

export interface RuntimeReleaseWorkerObservationV1 {
  readonly selectedExecutor: QualifiedExecutorRegistryEntryV1;
  readonly workerEpoch: string;
  readonly executorSessionHash: Hash;
  readonly frameworkAuthorityRoot: Hash;
  readonly executorAuthorityRoot: Hash;
  readonly releaseAuthorityRoot: Hash;
  readonly attestationProofIssuerKeyId: Hash;
  readonly candidatePartitionProofIssuerKeyId: Hash;
}

export interface PrepareRuntimeReleaseBindingInputV1 {
  readonly acceptanceCertificate: AcceptanceCertificateV1;
  readonly externalQualification: VerifyExternalQualificationInputV2;
  readonly executorRegistry: QualifiedExecutorRegistryArtifactV1;
  readonly worker: RuntimeReleaseWorkerObservationV1;
}

export function prepareRuntimeReleaseBindingPayloadV1(input: PrepareRuntimeReleaseBindingInputV1): RuntimeReleaseBindingPayloadV1 {
  const certificate = decodeAcceptanceCertificateV1(input.acceptanceCertificate);
  if (certificate.verdict !== "pass") throw new TypeError("runtime release requires GateCore pass certificate");
  const external = verifyExternalQualificationV2(input.externalQualification);
  if (!external.verified) throw new TypeError(`external qualification invalid:${external.issues.map(value => value.code).join(",")}`);
  const approval = decodeSignedReleaseAuthorityApprovalV2(input.externalQualification.evidence.releaseAuthorityApproval);
  if (
    certificate.releaseAuthorityApprovalId !== approval.approvalId
    || certificate.authorityPinDigest !== approval.authorityPinDigest
    || certificate.externalTrustAnchorRoot !== approval.externalTrustAnchorRoot
    || certificate.externalIssuerKeySetRoot !== approval.issuerKeySetRoot
    || certificate.qualificationRegistryApprovalId !== approval.registryApprovalId
    || certificate.qualificationRegistryRoot !== approval.registryRoot
    || certificate.qualificationAudienceHash !== approval.audienceHash
    || certificate.predicateCompositionRootDigest !== approval.predicateCompositionRootDigest
    || certificate.gateCoreRuntimeClosureDigest !== approval.gateCoreRuntimeClosureDigest
    || certificate.gateCoreImplementationClosureDigest !== approval.gateCoreImplementationClosureDigest
    || certificate.releaseRoleManifestRoot !== approval.releaseRoleManifestRoot
    || certificate.candidateReleaseCommit !== approval.candidateReleaseCommit
  ) throw new TypeError("acceptance certificate and signed release approval mismatch");
  const entries = input.executorRegistry.entries.map(entry => ({ ...entry }));
  const leaves = entries.map(hashQualifiedExecutorRegistryEntry);
  const ordered = entries.map((entry, index) => ({ entry, leaf: leaves[index]! })).sort((a, b) => a.leaf < b.leaf ? -1 : 1);
  if (ordered.some((value, index) => index > 0 && ordered[index - 1]!.leaf >= value.leaf)) throw new TypeError("executor registry leaves not unique");
  const expectedRegistryRoot = hashQualifiedExecutorRegistryRoot(ordered.map(value => value.entry));
  if (input.executorRegistry.registryRoot !== expectedRegistryRoot) throw new TypeError("executor registry root mismatch");
  const selected = input.worker.selectedExecutor;
  const selectedLeaf = hashQualifiedExecutorRegistryEntry(selected);
  const selectedBytes = Buffer.from(encodeCanonicalBytes(selected));
  if (!ordered.some(value => value.leaf === selectedLeaf && Buffer.from(encodeCanonicalBytes(value.entry)).equals(selectedBytes))) {
    throw new TypeError("selected executor is not a registry member");
  }
  if (selected.releaseRoleManifestRoot !== approval.releaseRoleManifestRoot || selected.candidateCommit !== approval.candidateReleaseCommit) {
    throw new TypeError("selected executor release identity mismatch");
  }
  return {
    schemaVersion: 1, kind: "aloha.runtime-release-binding",
    acceptanceCertificate: { certificateId: certificate.certificateId, payloadHash: certificate.payloadHash, verdict: "pass" },
    releaseAuthorityApprovalId: approval.approvalId, releaseAuthorityApprovalPayloadHash: approval.payloadHash,
    authorityPinDigest: approval.authorityPinDigest, externalTrustAnchorRoot: approval.externalTrustAnchorRoot,
    externalIssuerKeySetRoot: approval.issuerKeySetRoot, qualificationRegistryApprovalId: approval.registryApprovalId,
    qualificationRegistryRoot: approval.registryRoot, qualificationEpoch: approval.epoch,
    qualificationAudienceHash: approval.audienceHash, predicateCompositionRootDigest: approval.predicateCompositionRootDigest,
    gateCoreRuntimeClosureDigest: approval.gateCoreRuntimeClosureDigest,
    gateCoreImplementationClosureDigest: approval.gateCoreImplementationClosureDigest,
    qualifiedExecutorRegistryRoot: expectedRegistryRoot, selectedExecutorLeafHash: selectedLeaf, selectedExecutor: selected,
    releaseRoleManifestRoot: approval.releaseRoleManifestRoot, candidateReleaseCommit: approval.candidateReleaseCommit,
    workerEpoch: input.worker.workerEpoch, executorSessionHash: input.worker.executorSessionHash,
    frameworkAuthorityRoot: input.worker.frameworkAuthorityRoot, executorAuthorityRoot: input.worker.executorAuthorityRoot,
    releaseAuthorityRoot: input.worker.releaseAuthorityRoot, attestationProofIssuerKeyId: input.worker.attestationProofIssuerKeyId,
    candidatePartitionProofIssuerKeyId: input.worker.candidatePartitionProofIssuerKeyId,
  };
}

export function runtimeReleaseSigningRequestV1(payload: RuntimeReleaseBindingPayloadV1, signerKeyId: Hash): Uint8Array {
  return runtimeReleaseBindingSigningBytes(payload, signerKeyId);
}

export function verifySignedRuntimeReleaseBindingV1(
  payload: RuntimeReleaseBindingPayloadV1,
  signerPinValue: RuntimeReleaseSignerPinV1,
  signatureHex: `0x${string}`,
): RuntimeReleaseBindingV1 {
  const signerPin = decodeRuntimeReleaseSignerPinV1(signerPinValue);
  const binding = createRuntimeReleaseBindingV1(payload, signerPin.signerKeyId, signatureHex);
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(signerPin.publicKeyHex.slice(2), "hex")]),
    format: "der", type: "spki",
  });
  if (!verifySignature(null, Buffer.from(runtimeReleaseBindingSigningBytes(binding)), publicKey, Buffer.from(signatureHex.slice(2), "hex"))) {
    throw new TypeError("runtime release binding signature invalid");
  }
  return decodeRuntimeReleaseBindingV1(binding);
}
