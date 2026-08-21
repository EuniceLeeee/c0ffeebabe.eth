import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeExternalQualificationIssuerKeyV2,
  decodeExternalQualificationTrustAnchorV2,
  decodeSignedObserverCertificateV2,
  decodeSignedQualificationRegistryApprovalV2,
  decodeSignedReleaseAuthorityApprovalV2,
  decodeSignedVerifierCertificateV2,
  hashExternalQualificationIssuerKeySetRoot,
  hashExternalQualificationIssuerSetRoot,
  observerCertificateSigningBytes,
  qualificationRegistryApprovalSigningBytes,
  releaseAuthorityApprovalSigningBytes,
  verifierCertificateSigningBytes,
  type ExternalQualificationIssuerKeyV2,
  type ExternalQualificationTrustAnchorV2,
  type SignedObserverCertificateV2,
  type SignedQualificationRegistryApprovalV2,
  type SignedReleaseAuthorityApprovalV2,
  type SignedVerifierCertificateV2,
} from "../../../specs/qualification/src/index.ts";
import type {
  CertificateMembershipMaterialV1,
  ObserverQualificationCertificateV1,
  QualificationRegistrySnapshotV1,
  VerifierQualificationCertificateV1,
} from "../../../specs/qualification/src/index.ts";

export type ExternalQualificationIssueCode =
  | "external-trust-anchor-mismatch"
  | "external-issuer-key-mismatch"
  | "external-registry-approval-mismatch"
  | "external-certificate-signature-mismatch"
  | "external-release-approval-mismatch";

export interface ExternalQualificationIssueV2 {
  readonly code: ExternalQualificationIssueCode;
  readonly path: string;
}

/**
 * These values are selected outside the untrusted live envelope.  A repository
 * copy of the trust anchor is only evidence to compare with this pin; it never
 * creates trust by matching itself.
 */
export interface ExternalQualificationAuthorityPinV2 {
  readonly expectedTrustAnchorRoot: Hash;
  readonly expectedIssuerKeySetRoot: Hash;
  readonly expectedRegistryApprovalId: Hash;
  readonly expectedReleaseAuthorityApprovalId: Hash;
  readonly expectedQualificationAudienceHash: Hash;
  readonly expectedReleaseRoleManifestRoot: Hash;
  readonly expectedCandidateReleaseCommit: string;
}

export interface ExternalQualificationEvidenceV2 {
  readonly trustAnchor: ExternalQualificationTrustAnchorV2;
  readonly issuerKeys: readonly ExternalQualificationIssuerKeyV2[];
  readonly registryApproval: SignedQualificationRegistryApprovalV2;
  readonly signedVerifierCertificate: SignedVerifierCertificateV2;
  readonly signedObserverCertificates: readonly SignedObserverCertificateV2[];
  readonly releaseAuthorityApproval: SignedReleaseAuthorityApprovalV2;
}

export interface ExternalQualificationRegistryFactsV1 {
  readonly trustedIssuerIds: readonly string[];
  readonly certificateMemberships: readonly CertificateMembershipMaterialV1[];
  readonly revokedCertificateIds: readonly Hash[];
}

export interface ExternalQualificationReleaseBindingsV2 {
  readonly authorityPinDigest: Hash;
  readonly predicateCompositionRootDigest: Hash;
  readonly gateCoreRuntimeClosureDigest: Hash;
  readonly gateCoreImplementationClosureDigest: Hash;
  readonly verifierQualificationId: Hash;
  readonly observerQualificationIds: readonly Hash[];
}

export interface VerifyExternalQualificationInputV2 {
  readonly pin: ExternalQualificationAuthorityPinV2;
  readonly evidence: ExternalQualificationEvidenceV2;
  readonly registry: QualificationRegistrySnapshotV1;
  readonly registryFacts: ExternalQualificationRegistryFactsV1;
  readonly verifierCertificate: VerifierQualificationCertificateV1;
  readonly observerCertificates: readonly ObserverQualificationCertificateV1[];
  readonly release: ExternalQualificationReleaseBindingsV2;
}

export interface ExternalQualificationVerificationResultV2 {
  readonly verified: boolean;
  readonly issues: readonly ExternalQualificationIssueV2[];
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return encodeCanonicalJson(left) === encodeCanonicalJson(right);
  } catch {
    return false;
  }
}

function add(
  issues: ExternalQualificationIssueV2[],
  code: ExternalQualificationIssueCode,
  path: string,
): void {
  if (!issues.some((issue) => issue.code === code && issue.path === path)) {
    issues.push(Object.freeze({ code, path }));
  }
}

function verifyEd25519(
  key: ExternalQualificationIssuerKeyV2,
  message: Uint8Array,
  signatureHex: string,
): boolean {
  try {
    const rawKey = Buffer.from(key.publicKeyHex.slice(2), "hex");
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: "der",
      type: "spki",
    });
    return verifySignature(
      null,
      Buffer.from(message),
      publicKey,
      Buffer.from(signatureHex.slice(2), "hex"),
    );
  } catch {
    return false;
  }
}

function keyFor(
  keys: readonly ExternalQualificationIssuerKeyV2[],
  issuerId: string,
  keyId: Hash,
  epoch: string,
  audienceHash: Hash,
  issues: ExternalQualificationIssueV2[],
  path: string,
): ExternalQualificationIssuerKeyV2 | null {
  const candidates = keys.filter((key) => key.keyId === keyId);
  if (candidates.length !== 1) {
    add(issues, "external-issuer-key-mismatch", `${path}.keyId`);
    return null;
  }
  const key = candidates[0]!;
  if (
    key.issuerId !== issuerId ||
    key.audienceHash !== audienceHash ||
    BigInt(epoch) < BigInt(key.validFromRegistryEpoch) ||
    BigInt(epoch) > BigInt(key.validThroughRegistryEpoch)
  ) {
    add(issues, "external-issuer-key-mismatch", path);
    return null;
  }
  return key;
}

function decodeEvidence(
  evidence: ExternalQualificationEvidenceV2,
  issues: ExternalQualificationIssueV2[],
): ExternalQualificationEvidenceV2 | null {
  try {
    return Object.freeze({
      trustAnchor: decodeExternalQualificationTrustAnchorV2(evidence.trustAnchor),
      issuerKeys: Object.freeze(evidence.issuerKeys.map((key) => decodeExternalQualificationIssuerKeyV2(key))),
      registryApproval: decodeSignedQualificationRegistryApprovalV2(evidence.registryApproval),
      signedVerifierCertificate: decodeSignedVerifierCertificateV2(evidence.signedVerifierCertificate),
      signedObserverCertificates: Object.freeze(
        evidence.signedObserverCertificates.map((certificate) => decodeSignedObserverCertificateV2(certificate)),
      ),
      releaseAuthorityApproval: decodeSignedReleaseAuthorityApprovalV2(evidence.releaseAuthorityApproval),
    });
  } catch {
    add(issues, "external-trust-anchor-mismatch", "$.externalQualification");
    return null;
  }
}

function membershipFor(
  certificateId: Hash,
  registryFacts: ExternalQualificationRegistryFactsV1,
): CertificateMembershipMaterialV1 | undefined {
  return registryFacts.certificateMemberships.find((entry) => entry.certificateId === certificateId);
}

/**
 * Pure live verification of externally signed qualification material.  This
 * function owns no signing key, accepts no verifier callback, and does not
 * derive its authority pin from the supplied evidence.
 */
export function verifyExternalQualificationV2(
  input: VerifyExternalQualificationInputV2,
): ExternalQualificationVerificationResultV2 {
  const issues: ExternalQualificationIssueV2[] = [];
  const decoded = decodeEvidence(input.evidence, issues);
  if (decoded === null) return Object.freeze({ verified: false, issues: Object.freeze(issues) });

  const { trustAnchor, issuerKeys, registryApproval, releaseAuthorityApproval } = decoded;
  let issuerKeySetRoot: Hash | null = null;
  try {
    issuerKeySetRoot = hashExternalQualificationIssuerKeySetRoot(issuerKeys);
  } catch {
    add(issues, "external-issuer-key-mismatch", "$.externalQualification.issuerKeys");
  }
  const issuerIds = [...new Set(issuerKeys.map((key) => key.issuerId))].sort();
  const externalIssuerSetRoot = hashExternalQualificationIssuerSetRoot(issuerIds);
  const registryIssuerSetRoot = hashDomain("aloha/trusted-issuer-set/v1", issuerIds);
  if (
    trustAnchor.anchorId !== input.pin.expectedTrustAnchorRoot ||
    trustAnchor.issuerKeySetRoot !== input.pin.expectedIssuerKeySetRoot ||
    trustAnchor.issuerKeySetRoot !== issuerKeySetRoot ||
    trustAnchor.issuerSetRoot !== externalIssuerSetRoot ||
    input.registry.trustedIssuerSetRoot !== registryIssuerSetRoot ||
    input.registry.governanceTrustAnchorHash !== trustAnchor.anchorId ||
    trustAnchor.currentRegistryEpoch !== input.registry.epoch ||
    trustAnchor.audienceHash !== input.pin.expectedQualificationAudienceHash ||
    !sameJson(issuerIds, input.registryFacts.trustedIssuerIds)
  ) {
    add(issues, "external-trust-anchor-mismatch", "$.externalQualification.trustAnchor");
  }

  const governanceKey = keyFor(
    issuerKeys,
    trustAnchor.governanceIssuerId,
    trustAnchor.governanceKeyId,
    input.registry.epoch,
    input.pin.expectedQualificationAudienceHash,
    issues,
    "$.externalQualification.trustAnchor.governanceKeyId",
  );
  if (
    registryApproval.approvalId !== input.pin.expectedRegistryApprovalId ||
    registryApproval.registryRoot !== input.registry.registryId ||
    registryApproval.registryPayloadHash !== input.registry.payloadHash ||
    registryApproval.issuerKeySetRoot !== input.pin.expectedIssuerKeySetRoot ||
    registryApproval.epoch !== input.registry.epoch ||
    registryApproval.audienceHash !== input.pin.expectedQualificationAudienceHash ||
    registryApproval.issuerId !== trustAnchor.governanceIssuerId ||
    registryApproval.keyId !== trustAnchor.governanceKeyId ||
    governanceKey === null ||
    !verifyEd25519(
      governanceKey,
      qualificationRegistryApprovalSigningBytes(registryApproval),
      registryApproval.signatureHex,
    )
  ) {
    add(issues, "external-registry-approval-mismatch", "$.externalQualification.registryApproval");
  }

  const detailedObservers = new Map(
    input.observerCertificates.map((certificate) => [certificate.certificateId, certificate] as const),
  );
  const signedObserverIds = decoded.signedObserverCertificates.map((certificate) => certificate.certificateId);
  const sortedSignedObserverIds = [...signedObserverIds].sort();
  if (
    detailedObservers.size !== input.observerCertificates.length ||
    !sameJson(signedObserverIds, sortedSignedObserverIds) ||
    new Set(signedObserverIds).size !== signedObserverIds.length ||
    !sameJson(sortedSignedObserverIds, [...detailedObservers.keys()].sort())
  ) {
    add(issues, "external-certificate-signature-mismatch", "$.externalQualification.signedObserverCertificates");
  }
  for (const [index, signed] of decoded.signedObserverCertificates.entries()) {
    const path = `$.externalQualification.signedObserverCertificates[${index}]`;
    const detailed = detailedObservers.get(signed.certificateId);
    const membership = membershipFor(signed.certificateId, input.registryFacts);
    const key = keyFor(
      issuerKeys,
      signed.issuerId,
      signed.keyId,
      signed.epoch,
      input.pin.expectedQualificationAudienceHash,
      issues,
      `${path}.keyId`,
    );
    if (
      detailed === undefined ||
      signed.payloadHash !== detailed.payloadHash ||
      signed.issuerId !== detailed.issuerId ||
      signed.registryRoot !== input.registry.registryId ||
      signed.epoch !== input.registry.epoch ||
      signed.audienceHash !== input.pin.expectedQualificationAudienceHash ||
      membership === undefined ||
      membership.certificateKind !== "observer" ||
      membership.certificatePayloadHash !== signed.payloadHash ||
      membership.issuerId !== signed.issuerId ||
      input.registryFacts.revokedCertificateIds.includes(signed.certificateId) ||
      key === null ||
      !verifyEd25519(key, observerCertificateSigningBytes(signed), signed.signatureHex)
    ) {
      add(issues, "external-certificate-signature-mismatch", path);
    }
  }

  const signedVerifier = decoded.signedVerifierCertificate;
  const verifierMembership = membershipFor(signedVerifier.certificateId, input.registryFacts);
  const verifierKey = keyFor(
    issuerKeys,
    signedVerifier.issuerId,
    signedVerifier.keyId,
    signedVerifier.epoch,
    input.pin.expectedQualificationAudienceHash,
    issues,
    "$.externalQualification.signedVerifierCertificate.keyId",
  );
  if (
    signedVerifier.certificateId !== input.verifierCertificate.certificateId ||
    signedVerifier.payloadHash !== input.verifierCertificate.payloadHash ||
    signedVerifier.issuerId !== input.verifierCertificate.issuerId ||
    signedVerifier.registryRoot !== input.registry.registryId ||
    signedVerifier.epoch !== input.registry.epoch ||
    signedVerifier.audienceHash !== input.pin.expectedQualificationAudienceHash ||
    verifierMembership === undefined ||
    verifierMembership.certificateKind !== "verifier" ||
    verifierMembership.certificatePayloadHash !== signedVerifier.payloadHash ||
    verifierMembership.issuerId !== signedVerifier.issuerId ||
    input.registryFacts.revokedCertificateIds.includes(signedVerifier.certificateId) ||
    verifierKey === null ||
    !verifyEd25519(verifierKey, verifierCertificateSigningBytes(signedVerifier), signedVerifier.signatureHex)
  ) {
    add(
      issues,
      "external-certificate-signature-mismatch",
      "$.externalQualification.signedVerifierCertificate",
    );
  }

  const expectedObserverIds = [...input.release.observerQualificationIds].sort();
  if (
    releaseAuthorityApproval.approvalId !== input.pin.expectedReleaseAuthorityApprovalId ||
    releaseAuthorityApproval.authorityPinDigest !== input.release.authorityPinDigest ||
    releaseAuthorityApproval.externalTrustAnchorRoot !== input.pin.expectedTrustAnchorRoot ||
    releaseAuthorityApproval.issuerKeySetRoot !== input.pin.expectedIssuerKeySetRoot ||
    releaseAuthorityApproval.registryApprovalId !== input.pin.expectedRegistryApprovalId ||
    releaseAuthorityApproval.registryRoot !== input.registry.registryId ||
    releaseAuthorityApproval.verifierCertificateId !== input.release.verifierQualificationId ||
    !sameJson(releaseAuthorityApproval.observerCertificateIds, expectedObserverIds) ||
    releaseAuthorityApproval.predicateCompositionRootDigest !== input.release.predicateCompositionRootDigest ||
    releaseAuthorityApproval.gateCoreRuntimeClosureDigest !== input.release.gateCoreRuntimeClosureDigest ||
    releaseAuthorityApproval.gateCoreImplementationClosureDigest !== input.release.gateCoreImplementationClosureDigest ||
    releaseAuthorityApproval.releaseRoleManifestRoot !== input.pin.expectedReleaseRoleManifestRoot ||
    releaseAuthorityApproval.candidateReleaseCommit !== input.pin.expectedCandidateReleaseCommit ||
    releaseAuthorityApproval.epoch !== input.registry.epoch ||
    releaseAuthorityApproval.audienceHash !== input.pin.expectedQualificationAudienceHash ||
    releaseAuthorityApproval.issuerId !== trustAnchor.governanceIssuerId ||
    releaseAuthorityApproval.keyId !== trustAnchor.governanceKeyId ||
    governanceKey === null ||
    !verifyEd25519(
      governanceKey,
      releaseAuthorityApprovalSigningBytes(releaseAuthorityApproval),
      releaseAuthorityApproval.signatureHex,
    )
  ) {
    add(issues, "external-release-approval-mismatch", "$.externalQualification.releaseAuthorityApproval");
  }

  return Object.freeze({
    verified: issues.length === 0,
    issues: Object.freeze([...issues]),
  });
}
