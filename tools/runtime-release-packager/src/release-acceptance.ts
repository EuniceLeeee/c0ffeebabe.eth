import { createPublicKey, verify as verifySignature } from "node:crypto";
import { encodeCanonicalBytes, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeAcceptanceCertificateV1,
  type AcceptanceCertificateV1,
} from "../../../specs/acceptance-certificate/src/index.ts";
import {
  decodeReleaseAcceptanceSetV1,
  decodeSignedReleaseAcceptanceApprovalV1,
  decodeSignedReleaseAuthorityApprovalV3,
  encodeSignedReleaseAuthorityApprovalV3,
  releaseAcceptanceApprovalSigningBytes,
  sealReleaseAcceptanceSetV1,
  type ReleaseAcceptanceSetV1,
  type SignedReleaseAcceptanceApprovalSigningInputV1,
  type SignedReleaseAcceptanceApprovalV1,
  type SignedReleaseAuthorityApprovalV3,
} from "../../../specs/qualification/src/index.ts";
import {
  decodeRuntimeReleaseBindingV1,
  type RuntimeReleaseBindingV1,
} from "../../../specs/release-authority/src/index.ts";
import {
  verifyExternalQualificationV2,
  type VerifyExternalQualificationInputV2,
} from "../../../packages/external-qualification-verifier/src/index.ts";
import { RELEASE_ROLE_MANIFEST } from "../../../acceptance/gate-core/src/generated/release-role-manifest.ts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function equalBytes(left: unknown, right: unknown): boolean {
  return Buffer.from(encodeCanonicalBytes(left)).equals(Buffer.from(encodeCanonicalBytes(right)));
}

export interface VerifiedReleaseRequirementDenominatorV1 {
  readonly approval: SignedReleaseAuthorityApprovalV3;
  readonly externalQualifications: readonly VerifyExternalQualificationInputV2[];
}

/**
 * The generated release-role manifest is the denominator.  The external V3
 * signer may bind qualification identities, but it cannot add, remove, swap,
 * or rename a predicate relative to the exact candidate composition.
 */
export function verifyReleaseRequirementDenominatorV1(
  values: readonly VerifyExternalQualificationInputV2[],
): VerifiedReleaseRequirementDenominatorV1 {
  if (values.length === 0) throw new TypeError("release qualification denominator is empty");
  const approval = decodeSignedReleaseAuthorityApprovalV3(values[0]!.evidence.releaseAuthorityApproval);
  const approvalBytes = Buffer.from(encodeSignedReleaseAuthorityApprovalV3(approval));
  if (approval.releaseRoleManifestRoot !== RELEASE_ROLE_MANIFEST.rootDigest
    || approval.predicateCompositionRootDigest !== RELEASE_ROLE_MANIFEST.predicateCompositionRootDigest) {
    throw new TypeError("V3 release approval does not bind the generated release-role manifest");
  }
  const manifestEntries = [...RELEASE_ROLE_MANIFEST.predicateAdapters]
    .sort((left, right) => left.predicateId.localeCompare(right.predicateId));
  if (approval.releaseAcceptanceRequirements.length !== manifestEntries.length) {
    throw new TypeError("V3 release requirement count does not equal the generated predicate denominator");
  }
  for (let index = 0; index < manifestEntries.length; index += 1) {
    const manifest = manifestEntries[index]!;
    const requirement = approval.releaseAcceptanceRequirements[index]!;
    if (requirement.predicateId !== manifest.predicateId
      || requirement.predicateSpecDigest !== manifest.predicateSpecDigest
      || requirement.predicateCompositionLeafDigest !== manifest.compositionLeafDigest) {
      throw new TypeError(`V3 release requirement does not equal generated predicate ${manifest.predicateId}`);
    }
  }
  const byPredicate = new Map<string, VerifyExternalQualificationInputV2>();
  for (const value of values) {
    const result = verifyExternalQualificationV2(value);
    if (!result.verified) {
      throw new TypeError(`external qualification invalid:${result.issues.map(issue => issue.code).join(",")}`);
    }
    const currentApproval = decodeSignedReleaseAuthorityApprovalV3(value.evidence.releaseAuthorityApproval);
    if (!Buffer.from(encodeSignedReleaseAuthorityApprovalV3(currentApproval)).equals(approvalBytes)) {
      throw new TypeError("release qualifications do not share one exact V3 approval");
    }
    if (byPredicate.has(value.release.predicateId)) {
      throw new TypeError("release qualification denominator contains a duplicate predicate");
    }
    byPredicate.set(value.release.predicateId, value);
  }
  if (byPredicate.size !== approval.releaseAcceptanceRequirements.length
    || approval.releaseAcceptanceRequirements.some(requirement => !byPredicate.has(requirement.predicateId))) {
    throw new TypeError("release qualifications do not cover the exact V3 requirement set");
  }
  return Object.freeze({ approval, externalQualifications: Object.freeze([...values]) });
}

export interface ReleaseAcceptanceEvidenceInputV1 {
  readonly runtimeBinding: RuntimeReleaseBindingV1;
  readonly externalQualifications: readonly VerifyExternalQualificationInputV2[];
  readonly acceptanceCertificates: readonly AcceptanceCertificateV1[];
  readonly releaseAcceptanceSet: ReleaseAcceptanceSetV1;
  readonly releaseAcceptanceApproval: SignedReleaseAcceptanceApprovalV1;
}

export interface VerifiedReleaseAcceptanceEvidenceV1 {
  readonly runtimeBinding: RuntimeReleaseBindingV1;
  readonly releaseAuthorityApproval: SignedReleaseAuthorityApprovalV3;
  readonly acceptanceCertificates: readonly AcceptanceCertificateV1[];
  readonly releaseAcceptanceSet: ReleaseAcceptanceSetV1;
  readonly releaseAcceptanceApproval: SignedReleaseAcceptanceApprovalV1;
}

export interface PreparedReleaseAcceptanceV1 {
  readonly runtimeBinding: RuntimeReleaseBindingV1;
  readonly releaseAuthorityApproval: SignedReleaseAuthorityApprovalV3;
  readonly acceptanceCertificates: readonly AcceptanceCertificateV1[];
  readonly releaseAcceptanceSet: ReleaseAcceptanceSetV1;
  readonly signingInput: SignedReleaseAcceptanceApprovalSigningInputV1;
  readonly signingBytes: Uint8Array;
}

export function assertRuntimeBindingJoinsReleaseApprovalV1(
  bindingValue: RuntimeReleaseBindingV1,
  approvalValue: SignedReleaseAuthorityApprovalV3,
): RuntimeReleaseBindingV1 {
  const binding = decodeRuntimeReleaseBindingV1(bindingValue);
  const approval = decodeSignedReleaseAuthorityApprovalV3(approvalValue);
  if (binding.releaseAuthorityApprovalId !== approval.approvalId
    || binding.releaseAuthorityApprovalPayloadHash !== approval.payloadHash
    || binding.releaseAcceptanceRequirementSetRoot !== approval.releaseAcceptanceRequirementSetRoot
    || binding.externalTrustAnchorRoot !== approval.externalTrustAnchorRoot
    || binding.externalIssuerKeySetRoot !== approval.issuerKeySetRoot
    || binding.qualificationRegistryApprovalId !== approval.registryApprovalId
    || binding.qualificationRegistryRoot !== approval.registryRoot
    || binding.qualificationEpoch !== approval.epoch
    || binding.qualificationAudienceHash !== approval.audienceHash
    || binding.predicateCompositionRootDigest !== approval.predicateCompositionRootDigest
    || binding.gateCoreRuntimeClosureDigest !== approval.gateCoreRuntimeClosureDigest
    || binding.gateCoreImplementationClosureDigest !== approval.gateCoreImplementationClosureDigest
    || binding.releaseRoleManifestRoot !== approval.releaseRoleManifestRoot
    || binding.candidateReleaseCommit !== approval.candidateReleaseCommit) {
    throw new TypeError("runtime execution binding does not join the V3 release requirements");
  }
  return binding;
}

function verifyAcceptanceApprovalSignature(
  approval: SignedReleaseAcceptanceApprovalV1,
  releaseApproval: SignedReleaseAuthorityApprovalV3,
  qualification: VerifyExternalQualificationInputV2,
): void {
  const trustAnchor = qualification.evidence.trustAnchor;
  const keyCandidates = qualification.evidence.issuerKeys.filter(key => key.keyId === approval.keyId);
  if (keyCandidates.length !== 1) throw new TypeError("release acceptance signer key is unavailable");
  const key = keyCandidates[0]!;
  if (approval.externalTrustAnchorRoot !== trustAnchor.anchorId
    || approval.issuerKeySetRoot !== trustAnchor.issuerKeySetRoot
    || approval.issuerId !== releaseApproval.qualifiedRunnerIssuerId
    || approval.keyId !== releaseApproval.qualifiedRunnerKeyId
    || approval.qualifiedRunnerImplementationClosureDigest !== releaseApproval.qualifiedRunnerImplementationClosureDigest
    || approval.qualifiedRunnerImplementationExportDigest !== releaseApproval.qualifiedRunnerImplementationExportDigest
    || key.issuerId !== approval.issuerId
    || key.audienceHash !== approval.audienceHash
    || BigInt(approval.epoch) < BigInt(key.validFromRegistryEpoch)
    || BigInt(approval.epoch) > BigInt(key.validThroughRegistryEpoch)) {
    throw new TypeError("release acceptance signer is not the V3-authorized qualified runner");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(key.publicKeyHex.slice(2), "hex")]),
    format: "der",
    type: "spki",
  });
  if (!verifySignature(
    null,
    Buffer.from(releaseAcceptanceApprovalSigningBytes(approval)),
    publicKey,
    Buffer.from(approval.signatureHex.slice(2), "hex"),
  )) throw new TypeError("release acceptance approval signature invalid");
}

/** Build only the exact bytes an external qualified runner must sign.  The
 * packager neither accepts a verdict DTO nor owns a signing key. */
export function prepareReleaseAcceptanceV1(input: Omit<
  ReleaseAcceptanceEvidenceInputV1,
  "releaseAcceptanceSet" | "releaseAcceptanceApproval"
>): PreparedReleaseAcceptanceV1 {
  const binding = decodeRuntimeReleaseBindingV1(input.runtimeBinding);
  const denominator = verifyReleaseRequirementDenominatorV1(input.externalQualifications);
  const requirements = denominator.approval.releaseAcceptanceRequirements;
  assertRuntimeBindingJoinsReleaseApprovalV1(binding, denominator.approval);

  const certificates = input.acceptanceCertificates.map(value => decodeAcceptanceCertificateV1(value));
  const certificateByPredicate = new Map<string, AcceptanceCertificateV1>();
  for (const requirement of requirements) {
    const matches = certificates.filter(certificate =>
      certificate.predicateSpecDigest === requirement.predicateSpecDigest
      && certificate.predicateCompositionLeafDigest === requirement.predicateCompositionLeafDigest);
    if (matches.length !== 1) throw new TypeError(`predicate ${requirement.predicateId} does not have exactly one acceptance certificate`);
    const certificate = matches[0]!;
    if (certificateByPredicate.has(requirement.predicateId)) throw new TypeError("acceptance certificate denominator contains a duplicate");
    if (certificate.verdict !== "pass"
      || certificate.releaseAuthorityApprovalId !== denominator.approval.approvalId
      || certificate.authorityPinDigest !== requirement.authorityPinDigest
      || certificate.verifierQualificationId !== requirement.verifierCertificateId
      || !equalBytes(certificate.observerQualificationIds, requirement.observerCertificateIds)
      || certificate.externalTrustAnchorRoot !== denominator.approval.externalTrustAnchorRoot
      || certificate.externalIssuerKeySetRoot !== denominator.approval.issuerKeySetRoot
      || certificate.qualificationRegistryApprovalId !== denominator.approval.registryApprovalId
      || certificate.qualificationRegistryRoot !== denominator.approval.registryRoot
      || certificate.qualificationAudienceHash !== denominator.approval.audienceHash
      || certificate.predicateCompositionRootDigest !== denominator.approval.predicateCompositionRootDigest
      || certificate.gateCoreRuntimeClosureDigest !== denominator.approval.gateCoreRuntimeClosureDigest
      || certificate.gateCoreImplementationClosureDigest !== denominator.approval.gateCoreImplementationClosureDigest
      || certificate.releaseRoleManifestRoot !== denominator.approval.releaseRoleManifestRoot
      || certificate.candidateReleaseCommit !== denominator.approval.candidateReleaseCommit) {
      throw new TypeError(`acceptance certificate does not join requirement ${requirement.predicateId}`);
    }
    certificateByPredicate.set(requirement.predicateId, certificate);
  }
  if (certificates.length !== requirements.length) throw new TypeError("acceptance certificate set contains an extra certificate");
  const releaseAcceptanceSet = sealReleaseAcceptanceSetV1(
    denominator.approval.releaseAcceptanceRequirementSetRoot,
    requirements.map(requirement => {
      const certificate = certificateByPredicate.get(requirement.predicateId)!;
      return {
        predicateId: requirement.predicateId,
        predicateSpecDigest: requirement.predicateSpecDigest,
        predicateCompositionLeafDigest: requirement.predicateCompositionLeafDigest,
        requirementLeafDigest: requirement.requirementLeafDigest,
        acceptanceCertificateId: certificate.certificateId,
        acceptanceCertificatePayloadHash: certificate.payloadHash,
        verdict: "pass" as const,
      };
    }),
  );
  const signingInput: SignedReleaseAcceptanceApprovalSigningInputV1 = Object.freeze({
    schemaVersion: 1,
    kind: "aloha.signed-release-acceptance-approval",
    releaseAuthorityApprovalId: denominator.approval.approvalId,
    releaseAuthorityApprovalPayloadHash: denominator.approval.payloadHash,
    runtimeReleaseBindingId: binding.bindingId,
    releaseAcceptanceRequirementSetRoot: releaseAcceptanceSet.releaseAcceptanceRequirementSetRoot,
    releaseAcceptanceSetRoot: releaseAcceptanceSet.root,
    predicateCompositionRootDigest: binding.predicateCompositionRootDigest,
    gateCoreRuntimeClosureDigest: binding.gateCoreRuntimeClosureDigest,
    gateCoreImplementationClosureDigest: binding.gateCoreImplementationClosureDigest,
    releaseRoleManifestRoot: binding.releaseRoleManifestRoot,
    candidateReleaseCommit: binding.candidateReleaseCommit,
    externalTrustAnchorRoot: binding.externalTrustAnchorRoot,
    issuerKeySetRoot: binding.externalIssuerKeySetRoot,
    registryApprovalId: binding.qualificationRegistryApprovalId,
    registryRoot: binding.qualificationRegistryRoot,
    epoch: binding.qualificationEpoch,
    audienceHash: binding.qualificationAudienceHash,
    issuerId: denominator.approval.qualifiedRunnerIssuerId,
    keyId: denominator.approval.qualifiedRunnerKeyId,
    qualifiedRunnerImplementationClosureDigest: denominator.approval.qualifiedRunnerImplementationClosureDigest,
    qualifiedRunnerImplementationExportDigest: denominator.approval.qualifiedRunnerImplementationExportDigest,
  });
  return Object.freeze({
    runtimeBinding: binding,
    releaseAuthorityApproval: denominator.approval,
    acceptanceCertificates: Object.freeze(certificates),
    releaseAcceptanceSet,
    signingInput,
    signingBytes: releaseAcceptanceApprovalSigningBytes(signingInput),
  });
}

export function verifyReleaseAcceptanceEvidenceV1(
  input: ReleaseAcceptanceEvidenceInputV1,
): VerifiedReleaseAcceptanceEvidenceV1 {
  const prepared = prepareReleaseAcceptanceV1(input);
  const binding = prepared.runtimeBinding;
  const denominator = verifyReleaseRequirementDenominatorV1(input.externalQualifications);
  const certificates = prepared.acceptanceCertificates;
  const expectedSet = prepared.releaseAcceptanceSet;
  const acceptanceSet = decodeReleaseAcceptanceSetV1(input.releaseAcceptanceSet);
  if (!equalBytes(acceptanceSet, expectedSet)) throw new TypeError("release acceptance set does not equal the exact certificate denominator");
  const acceptanceApproval = decodeSignedReleaseAcceptanceApprovalV1(input.releaseAcceptanceApproval);
  if (acceptanceApproval.releaseAuthorityApprovalId !== denominator.approval.approvalId
    || acceptanceApproval.releaseAuthorityApprovalPayloadHash !== denominator.approval.payloadHash
    || acceptanceApproval.runtimeReleaseBindingId !== binding.bindingId
    || acceptanceApproval.releaseAcceptanceRequirementSetRoot !== acceptanceSet.releaseAcceptanceRequirementSetRoot
    || acceptanceApproval.releaseAcceptanceSetRoot !== acceptanceSet.root
    || acceptanceApproval.predicateCompositionRootDigest !== binding.predicateCompositionRootDigest
    || acceptanceApproval.gateCoreRuntimeClosureDigest !== binding.gateCoreRuntimeClosureDigest
    || acceptanceApproval.gateCoreImplementationClosureDigest !== binding.gateCoreImplementationClosureDigest
    || acceptanceApproval.releaseRoleManifestRoot !== binding.releaseRoleManifestRoot
    || acceptanceApproval.candidateReleaseCommit !== binding.candidateReleaseCommit
    || acceptanceApproval.externalTrustAnchorRoot !== binding.externalTrustAnchorRoot
    || acceptanceApproval.issuerKeySetRoot !== binding.externalIssuerKeySetRoot
    || acceptanceApproval.registryApprovalId !== binding.qualificationRegistryApprovalId
    || acceptanceApproval.registryRoot !== binding.qualificationRegistryRoot
    || acceptanceApproval.epoch !== binding.qualificationEpoch
    || acceptanceApproval.audienceHash !== binding.qualificationAudienceHash) {
    throw new TypeError("post-run release acceptance approval does not join the execution binding and result set");
  }
  verifyAcceptanceApprovalSignature(acceptanceApproval, denominator.approval, input.externalQualifications[0]!);
  return Object.freeze({
    runtimeBinding: binding,
    releaseAuthorityApproval: denominator.approval,
    acceptanceCertificates: Object.freeze(certificates),
    releaseAcceptanceSet: acceptanceSet,
    releaseAcceptanceApproval: acceptanceApproval,
  });
}
