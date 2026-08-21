import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  CANONICAL_LIMITS,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createReadOnlyArtifactRef,
  createSemanticArtifact,
  createProductionReceipt,
  decodeProductionReceipt,
  decodeSemanticArtifact,
  CORE_SCHEMA_MANIFESTS,
  encodeProductionReceipt,
  encodeSemanticArtifact,
  hashProcessAnchor,
  type ProcessAnchorV1,
  type ReadOnlyArtifactRefV1,
} from "../../../specs/core-envelope/src/index.ts";
import {
  createArtifactResolutionClaim,
  createObservedImmutableMirror,
  createResolverPolicy,
  createRetentionLeaseReceipt,
  type ArtifactResolutionClaimV1,
  type ObservedImmutableMirrorV1,
  type ResolverPolicyV1,
  type RetentionLeaseReceiptV1,
} from "../../../specs/artifact-resolution/src/index.ts";
import { decodeArtifactBytes, encodeArtifactBytes } from "../../../specs/artifact-resolution/src/index.ts";
import {
  createObserverQualificationCertificate,
  createObserverSigningKey,
  createPredicateSpec,
  createQualificationRegistry,
  createVerifierQualificationCertificate,
  createExternalQualificationIssuerKeyV2,
  createExternalQualificationTrustAnchorV2,
  createSignedObserverCertificateV2,
  createSignedQualificationRegistryApprovalV2,
  createSignedReleaseAuthorityApprovalV2,
  createSignedVerifierCertificateV2,
  hashExternalQualificationIssuerKeySetRoot,
  hashExternalQualificationIssuerSetRoot,
  hashSignedReleaseAuthorityObserverCertificateIdsRoot,
  observerCertificateSigningBytes,
  qualificationRegistryApprovalSigningBytes,
  releaseAuthorityApprovalSigningBytes,
  verifierCertificateSigningBytes,
  type ObserverQualificationCertificateV1,
  type QualificationRegistrySnapshotV1,
  type VerifierQualificationCertificateV1,
} from "../../../specs/qualification/src/index.ts";
import {
  computeObserverSemanticConfigDigest,
  createAcquisitionProcessObservation,
  createAcceptanceQuery,
  createQualifiedFactSnapshot,
  createQualifiedObservation,
  createStoreEpochObservation,
  createTargetProcessObservation,
  createUnsignedSignedObserverInvocationSnapshot,
  observerInvocationSigningBytes,
  sealSignedObserverInvocationSnapshot,
  type AcceptanceQueryV1,
  type QualifiedFactSnapshotV1,
  type QualifiedObservationEnvelopeV1,
  type SignedObserverInvocationSnapshotV1,
} from "../../../specs/qualified-facts/src/index.ts";
import {
  ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS,
  ARTIFACT_LINEAGE_VERIFIER_QUALIFICATION_MATERIAL,
  ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION,
  ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION,
  ARTIFACT_LINEAGE_STORE_EPOCH_QUALIFICATION,
  ARTIFACT_LINEAGE_TARGET_PROCESS_QUALIFICATION,
} from "../../artifact-lineage-facts/src/qualification.ts";
import {
  ARTIFACT_LINEAGE_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE,
  ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS,
  ARTIFACT_LINEAGE_INVOCATION_AUDIENCE_HASH,
  ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  ARTIFACT_LINEAGE_PREDICATE_SPEC,
} from "../../artifact-lineage-facts/src/runtime.ts";
import {
  createArtifactLineageClaim,
  createArtifactLineageObservationFromBytes,
  type ArtifactLineageClaimV1,
  type ArtifactLineageFactBundleV1,
} from "../../artifact-lineage-facts/src/schema.ts";
import {
  ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
} from "../../artifact-lineage-facts/src/reference-model.ts";
import {
  PREDICATE_COMPOSITION_ROOT_DIGEST,
  RELEASE_PREDICATE_BINDINGS,
  resolvePredicateEvaluator,
} from "../src/generated/predicate-composition.ts";
import {
  decodeAcceptanceCertificate,
  computeGateCoreAuthorityPinDigest,
  recomputeAcceptanceCertificateId,
  recomputeAcceptanceCertificatePayloadHash,
  type GateCoreAuthorityPinV1,
  type GateCoreInputV1,
  type RegistryMembershipFactsV1,
} from "../src/index.ts";
import type { PredicateCompositionPortV1, PredicateEvaluatorV1 } from "../src/predicate-composition.ts";
import { evaluateGateCoreForQualification } from "../src/qualification/internal.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;
const CURRENT_PREDICATE_BINDING = RELEASE_PREDICATE_BINDINGS[0]!;

const QUALIFICATION_COMPOSITION = Object.freeze({
  rootDigest: PREDICATE_COMPOSITION_ROOT_DIGEST,
  resolve: resolvePredicateEvaluator,
});

function evaluateQualification(authority: GateCoreAuthorityPinV1, input: GateCoreInputV1, nowUnixNs = "500") {
  return evaluateGateCoreForQualification(authority, input, QUALIFICATION_COMPOSITION, nowUnixNs);
}

function evaluateQualificationWithComposition(
  authority: GateCoreAuthorityPinV1,
  input: GateCoreInputV1,
  composition: PredicateCompositionPortV1,
  nowUnixNs = "500",
) {
  return evaluateGateCoreForQualification(authority, input, composition, nowUnixNs);
}

/**
 * This builder is test-only qualification material. It is intentionally not
 * exported from production and no result from it is an acceptance oracle.
 */
function makeLineageFixture(
  contentMutation = false,
  includeUnrelatedExpiredKey = false,
  externalOptions: {
    readonly qualificationKeyValidFromEpoch?: string;
    readonly qualificationKeyValidThroughEpoch?: string;
    readonly revokeFirstObserverCertificate?: boolean;
  } = {},
): {
  readonly authority: GateCoreAuthorityPinV1;
  readonly input: GateCoreInputV1;
  readonly mainArtifactRef: ReadOnlyArtifactRefV1;
  readonly signInvocation: (unsigned: ReturnType<typeof createUnsignedSignedObserverInvocationSnapshot>) => SignedObserverInvocationSnapshotV1;
} {
  const predicate = ARTIFACT_LINEAGE_PREDICATE_SPEC;
  const predicateClosure = h("3");
  const issuerId = "lineage-issuer";
  const observerImplementationDigest = h("a");
  const storeIdentityHash = h("b");
  const bootIdHash = h("c");
  const systemId = "qualified-lineage-test";
  const { publicKey: invocationPublicKey, privateKey: invocationPrivateKey } = generateKeyPairSync("ed25519");
  const invocationPublicKeyDer = invocationPublicKey.export({ format: "der", type: "spki" });
  const invocationPublicKeyHex = `0x${invocationPublicKeyDer.subarray(-32).toString("hex")}` as `0x${string}`;
  const { publicKey: qualificationPublicKey, privateKey: qualificationPrivateKey } = generateKeyPairSync("ed25519");
  const qualificationPublicKeyDer = qualificationPublicKey.export({ format: "der", type: "spki" });
  const qualificationPublicKeyHex = `0x${qualificationPublicKeyDer.subarray(-32).toString("hex")}` as `0x${string}`;
  const qualificationAudienceHash = hashDomain("aloha/test-qualification-audience/v2", {
    predicateId: predicate.predicateId,
  });
  const qualificationIssuerKey = createExternalQualificationIssuerKeyV2({
    schemaVersion: 2,
    kind: "aloha.external-qualification-issuer-key",
    issuerId,
    algorithm: "ed25519",
    publicKeyHex: qualificationPublicKeyHex,
    validFromRegistryEpoch: externalOptions.qualificationKeyValidFromEpoch ?? "1",
    validThroughRegistryEpoch: externalOptions.qualificationKeyValidThroughEpoch ?? "1",
    audienceHash: qualificationAudienceHash,
  });
  const qualificationIssuerKeys = [qualificationIssuerKey] as const;
  const qualificationIssuerKeySetRoot = hashExternalQualificationIssuerKeySetRoot(qualificationIssuerKeys);
  const rawRoleMaterial = ARTIFACT_LINEAGE_VERIFIER_QUALIFICATION_MATERIAL.roleMaterials.find((material) => material.roleId === ARTIFACT_LINEAGE_OBSERVER_ROLE.roleId);
  if (rawRoleMaterial === undefined) throw new TypeError("missing raw observer role material");
  const observerCertificate = createObserverQualificationCertificate({
    schemaVersion: 1,
    kind: "aloha.observer-qualification",
    qualificationSpecDigest: ARTIFACT_LINEAGE_OBSERVER_ROLE.observerQualificationSpecDigest,
    observerImplementationDigest,
    observedSchemaIds: [ARTIFACT_LINEAGE_OBSERVER_ROLE.observationSchema],
    qualifiedLocatorKinds: ["file-range"],
    anchorValidationMethodDigest: h("d"),
    positiveCaseRoot: rawRoleMaterial.roots.positiveCaseRoot,
    negativeCaseRoot: rawRoleMaterial.roots.negativeCaseRoot,
    invalidCaseRoot: rawRoleMaterial.roots.invalidCaseRoot,
    declaredCriticalMutationIds: ARTIFACT_LINEAGE_OBSERVER_ROLE.requiredCriticalMutationIds,
    rejectedOrInvalidMutationIds: rawRoleMaterial.actuallyExecutedRejectedOrInvalidMutationIds,
    independentOracleCaseRoot: rawRoleMaterial.roots.independentOracleCaseRoot,
    independentOracleCaseCount: rawRoleMaterial.roots.independentOracleCaseCount,
    issuerId,
    issuedAtRegistryEpoch: "1",
    verdict: "qualified",
  });
  const createSidecarObserver = (
    role: typeof ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE,
    material: typeof ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION,
    implementationDigest: Hash,
    qualifiedLocatorKinds: readonly ("file-range" | "checkpoint-record" | "chain-object" | "content-object" | "json-pointer")[] = ["file-range"],
  ): ObserverQualificationCertificateV1 => createObserverQualificationCertificate({
    schemaVersion: 1,
    kind: "aloha.observer-qualification",
    qualificationSpecDigest: role.observerQualificationSpecDigest,
    observerImplementationDigest: implementationDigest,
    observedSchemaIds: [role.observationSchema],
    qualifiedLocatorKinds,
    anchorValidationMethodDigest: h("d"),
    positiveCaseRoot: material.roots.positiveCaseRoot,
    negativeCaseRoot: material.roots.negativeCaseRoot,
    invalidCaseRoot: material.roots.invalidCaseRoot,
    declaredCriticalMutationIds: role.requiredCriticalMutationIds,
    rejectedOrInvalidMutationIds: material.actuallyExecutedRejectedOrInvalidMutationIds,
    independentOracleCaseRoot: material.roots.independentOracleCaseRoot,
    independentOracleCaseCount: material.roots.independentOracleCaseCount,
    issuerId,
    issuedAtRegistryEpoch: "1",
    verdict: "qualified",
  });
  const acquisitionObserverCertificate = createSidecarObserver(ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE, ARTIFACT_LINEAGE_ACQUISITION_PROCESS_QUALIFICATION, h("1"));
  const targetObserverCertificate = createSidecarObserver(ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE, ARTIFACT_LINEAGE_TARGET_PROCESS_QUALIFICATION, h("2"));
  const storeObserverCertificate = createSidecarObserver(ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE, ARTIFACT_LINEAGE_STORE_EPOCH_QUALIFICATION, h("4"), ["file-range"]);
  const invocationObserverCertificate = createSidecarObserver(ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE, ARTIFACT_LINEAGE_INVOCATION_SEAL_QUALIFICATION, h("9"), ["content-object", "file-range"]);
  const verifierRoles = [
    { ...ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE, observerQualificationId: acquisitionObserverCertificate.certificateId },
    { ...ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE, observerQualificationId: invocationObserverCertificate.certificateId },
    { ...ARTIFACT_LINEAGE_OBSERVER_ROLE, observerQualificationId: observerCertificate.certificateId },
    { ...ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE, observerQualificationId: storeObserverCertificate.certificateId },
    { ...ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE, observerQualificationId: targetObserverCertificate.certificateId },
  ];
  const verifierCertificate = createVerifierQualificationCertificate({
    schemaVersion: 1,
    kind: "aloha.verifier-qualification",
    qualificationSpecDigest: predicate.verifierQualificationSpecDigest,
    predicateSpecDigest: predicate.specDigest,
    predicateImplementationDigest: predicateClosure,
    predicateImplementationExportDigest: CURRENT_PREDICATE_BINDING.predicateImplementationExportDigest,
    predicateProgramDescriptorDigest: ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
    oracleProgramDescriptorDigest: ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
    oracleImplementationClosureDigest: h("5"),
    oracleImplementationExportDigest: CURRENT_PREDICATE_BINDING.oracleImplementationExportDigest,
    predicateCompositionLeafDigest: CURRENT_PREDICATE_BINDING.compositionLeafDigest,
    gateCoreImplementationClosureDigest: h("6"),
    observerQualificationIds: [
      observerCertificate.certificateId,
      acquisitionObserverCertificate.certificateId,
      invocationObserverCertificate.certificateId,
      targetObserverCertificate.certificateId,
      storeObserverCertificate.certificateId,
    ].sort(),
    requiredObserverRoles: verifierRoles,
    caseSetRoot: ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS.caseSetRoot,
    declaredCriticalMutationIds: predicate.criticalMutationIds,
    rejectedOrInvalidMutationIds: ARTIFACT_LINEAGE_VERIFIER_QUALIFICATION_MATERIAL.actuallyExecutedRejectedOrInvalidMutationIds,
    independentOracleCaseRoot: ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS.independentOracleCaseRoot,
    independentOracleCaseCount: ARTIFACT_LINEAGE_VERIFIER_CASE_ROOTS.independentOracleCaseCount,
    oldReferenceCaseCount: "0",
    counterexampleRoot: h("e"),
    issuerId,
    issuedAtRegistryEpoch: "1",
    verdict: "qualified",
  });
  const invocationKey = createObserverSigningKey({
    schemaVersion: 1,
    kind: "aloha.observer-signing-key",
    observerQualificationId: invocationObserverCertificate.certificateId,
    roleId: ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE.roleId,
    algorithm: "ed25519",
    publicKeyHex: invocationPublicKeyHex,
    validFromRegistryEpoch: "1",
    validThroughRegistryEpoch: "1",
    audienceHash: ARTIFACT_LINEAGE_INVOCATION_AUDIENCE_HASH,
  });
  const unrelatedExpiredKey = includeUnrelatedExpiredKey
    ? (() => {
      const { publicKey } = generateKeyPairSync("ed25519");
      const der = publicKey.export({ format: "der", type: "spki" });
      return createObserverSigningKey({
        schemaVersion: 1,
        kind: "aloha.observer-signing-key",
        observerQualificationId: invocationObserverCertificate.certificateId,
        roleId: ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE.roleId,
        algorithm: "ed25519",
        publicKeyHex: `0x${der.subarray(-32).toString("hex")}` as `0x${string}`,
        validFromRegistryEpoch: "0",
        validThroughRegistryEpoch: "0",
        audienceHash: ARTIFACT_LINEAGE_INVOCATION_AUDIENCE_HASH,
      });
    })()
    : null;
  const observerSigningKeys = [invocationKey, ...(unrelatedExpiredKey === null ? [] : [unrelatedExpiredKey])]
    .sort((left, right) => left.keyId.localeCompare(right.keyId));
  const observerMemberships = [
    observerCertificate,
    acquisitionObserverCertificate,
    invocationObserverCertificate,
    targetObserverCertificate,
    storeObserverCertificate,
  ].map((certificate) => ({
    certificateKind: "observer" as const,
    certificateId: certificate.certificateId,
    certificatePayloadHash: certificate.payloadHash,
    issuerId,
  }));
  const certificateMemberships: Array<{
    readonly certificateKind: "observer" | "verifier";
    readonly certificateId: Hash;
    readonly certificatePayloadHash: Hash;
    readonly issuerId: string;
  }> = [
    ...observerMemberships,
    {
      certificateKind: "verifier" as const,
      certificateId: verifierCertificate.certificateId,
      certificatePayloadHash: verifierCertificate.payloadHash,
      issuerId,
    },
  ].sort((left, right) => left.certificateId.localeCompare(right.certificateId));
  const revokedExternalCertificateIds = externalOptions.revokeFirstObserverCertificate
    ? [observerCertificate.certificateId]
    : [];
  const trustedIssuerSetRoot = hashDomain("aloha/trusted-issuer-set/v1", [issuerId]);
  const qualificationTrustAnchor = createExternalQualificationTrustAnchorV2({
    schemaVersion: 2,
    kind: "aloha.external-qualification-trust-anchor",
    issuerSetRoot: hashExternalQualificationIssuerSetRoot([issuerId]),
    issuerKeySetRoot: qualificationIssuerKeySetRoot,
    governanceIssuerId: issuerId,
    governanceKeyId: qualificationIssuerKey.keyId,
    validFromRegistryEpoch: "1",
    validThroughRegistryEpoch: "1",
    currentRegistryEpoch: "1",
    audienceHash: qualificationAudienceHash,
  });
  const registry = createQualificationRegistry({
    schemaVersion: 1,
    kind: "aloha.qualification-registry",
    epoch: "1",
    trustedIssuerSetRoot,
    certificateSetRoot: hashDomain("aloha/certificate-set/v1", certificateMemberships),
    revokedCertificateIdsRoot: hashDomain("aloha/revoked-certificate-set/v1", revokedExternalCertificateIds),
    observerKeySetRoot: hashDomain("aloha/observer-signing-key-set/v1", observerSigningKeys.map((key) => key.keyId)),
    revokedObserverKeyIdsRoot: hashDomain("aloha/revoked-observer-key-set/v1", []),
    previousRegistryRoot: null,
    governanceTrustAnchorHash: qualificationTrustAnchor.anchorId,
  });
  const registryFacts: RegistryMembershipFactsV1 = {
    trustedIssuerIds: [issuerId],
    certificateMemberships,
    revokedCertificateIds: revokedExternalCertificateIds,
    observerSigningKeys,
    revokedObserverKeyIds: [],
  };
  const signQualification = (bytes: Uint8Array): string =>
    `0x${sign(null, Buffer.from(bytes), qualificationPrivateKey).toString("hex")}`;
  const registryApprovalInput = {
    schemaVersion: 2 as const,
    kind: "aloha.signed-qualification-registry-approval" as const,
    registryRoot: registry.registryId,
    registryPayloadHash: registry.payloadHash,
    issuerKeySetRoot: qualificationIssuerKeySetRoot,
    epoch: registry.epoch,
    audienceHash: qualificationAudienceHash,
    issuerId,
    keyId: qualificationIssuerKey.keyId,
  };
  const registryApproval = createSignedQualificationRegistryApprovalV2(
    registryApprovalInput,
    signQualification(qualificationRegistryApprovalSigningBytes(registryApprovalInput)),
  );
  const detailedObserverCertificates = [
    observerCertificate,
    acquisitionObserverCertificate,
    invocationObserverCertificate,
    targetObserverCertificate,
    storeObserverCertificate,
  ];
  const signedObserverCertificates = detailedObserverCertificates.map((certificate) => {
    const input = {
      schemaVersion: 2 as const,
      kind: "aloha.observer-qualification" as const,
      certificateId: certificate.certificateId,
      payloadHash: certificate.payloadHash,
      registryRoot: registry.registryId,
      epoch: registry.epoch,
      audienceHash: qualificationAudienceHash,
      issuerId,
      keyId: qualificationIssuerKey.keyId,
    };
    return createSignedObserverCertificateV2(
      input,
      signQualification(observerCertificateSigningBytes(input)),
    );
  }).sort((left, right) => left.certificateId.localeCompare(right.certificateId));
  const signedVerifierInput = {
    schemaVersion: 2 as const,
    kind: "aloha.verifier-qualification" as const,
    certificateId: verifierCertificate.certificateId,
    payloadHash: verifierCertificate.payloadHash,
    registryRoot: registry.registryId,
    epoch: registry.epoch,
    audienceHash: qualificationAudienceHash,
    issuerId,
    keyId: qualificationIssuerKey.keyId,
  };
  const signedVerifierCertificate = createSignedVerifierCertificateV2(
    signedVerifierInput,
    signQualification(verifierCertificateSigningBytes(signedVerifierInput)),
  );
  const externalQualificationPinBase = {
    expectedTrustAnchorRoot: qualificationTrustAnchor.anchorId,
    expectedIssuerKeySetRoot: qualificationIssuerKeySetRoot,
    expectedRegistryApprovalId: registryApproval.approvalId,
    expectedQualificationAudienceHash: qualificationAudienceHash,
    expectedReleaseRoleManifestRoot: h("d"),
    expectedCandidateReleaseCommit: "0123456789012345678901234567890123456789",
  };
  const authorityBeforeReleaseApproval: GateCoreAuthorityPinV1 = {
    registry: {
      expectedRegistryRoot: registry.registryId,
      expectedGovernanceTrustAnchorHash: registry.governanceTrustAnchorHash,
      expectedEpoch: registry.epoch,
    },
    externalQualification: {
      ...externalQualificationPinBase,
      expectedReleaseAuthorityApprovalId: h("e"),
    },
    predicate,
    predicateProgramDescriptorDigest: ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
    oracleProgramDescriptorDigest: ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
    predicateCompositionLeafDigest: CURRENT_PREDICATE_BINDING.compositionLeafDigest,
    predicateCompositionRootDigest: PREDICATE_COMPOSITION_ROOT_DIGEST,
    predicateImplementationClosureDigest: predicateClosure,
    predicateImplementationExportDigest: CURRENT_PREDICATE_BINDING.predicateImplementationExportDigest,
    oracleImplementationClosureDigest: h("5"),
    oracleImplementationExportDigest: CURRENT_PREDICATE_BINDING.oracleImplementationExportDigest,
    gateCoreImplementationClosureDigest: h("6"),
    gateCoreRuntimeClosureDigest: h("7"),
    verifierQualificationId: verifierCertificate.certificateId,
    signedInvocationRoleId: ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE.roleId,
    maxInvocationTtlUnixNs: "1000000000",
    expectedAudienceHash: ARTIFACT_LINEAGE_INVOCATION_AUDIENCE_HASH,
  };
  const observerQualificationIds = detailedObserverCertificates
    .map((certificate) => certificate.certificateId)
    .sort();
  const releaseApprovalInput = {
    schemaVersion: 2 as const,
    kind: "aloha.signed-release-authority-approval" as const,
    authorityPinDigest: computeGateCoreAuthorityPinDigest(authorityBeforeReleaseApproval),
    externalTrustAnchorRoot: qualificationTrustAnchor.anchorId,
    issuerKeySetRoot: qualificationIssuerKeySetRoot,
    registryApprovalId: registryApproval.approvalId,
    registryRoot: registry.registryId,
    verifierCertificateId: verifierCertificate.certificateId,
    observerCertificateIds: observerQualificationIds,
    observerCertificateIdsRoot: hashSignedReleaseAuthorityObserverCertificateIdsRoot(observerQualificationIds),
    predicateCompositionRootDigest: PREDICATE_COMPOSITION_ROOT_DIGEST,
    gateCoreRuntimeClosureDigest: authorityBeforeReleaseApproval.gateCoreRuntimeClosureDigest,
    gateCoreImplementationClosureDigest: authorityBeforeReleaseApproval.gateCoreImplementationClosureDigest,
    releaseRoleManifestRoot: externalQualificationPinBase.expectedReleaseRoleManifestRoot,
    candidateReleaseCommit: externalQualificationPinBase.expectedCandidateReleaseCommit,
    epoch: registry.epoch,
    audienceHash: qualificationAudienceHash,
    issuerId,
    keyId: qualificationIssuerKey.keyId,
  };
  const releaseAuthorityApproval = createSignedReleaseAuthorityApprovalV2(
    releaseApprovalInput,
    signQualification(releaseAuthorityApprovalSigningBytes(releaseApprovalInput)),
  );
  const authority: GateCoreAuthorityPinV1 = {
    ...authorityBeforeReleaseApproval,
    externalQualification: {
      ...externalQualificationPinBase,
      expectedReleaseAuthorityApprovalId: releaseAuthorityApproval.approvalId,
    },
  };

  const targetAnchor: ProcessAnchorV1 = {
    systemId,
    commitSha: "0123456789012345678901234567890123456789",
    executableHash: h("7"),
    deploymentManifestHash: h("8"),
    serviceIdentityHash: h("9"),
    pid: "501",
    processStartTicks: "1001",
    bootIdHash,
  };
  const acquisitionAnchor: ProcessAnchorV1 = {
    ...targetAnchor,
    pid: "502",
    processStartTicks: "1002",
  };
  const storeRawFacts = encodeArtifactBytes(new TextEncoder().encode(encodeCanonicalJson({
    schemaVersion: 1,
    kind: "aloha.store-epoch-raw-facts",
    storeIdentityHash,
    currentStoreEpoch: "11",
  })));
  const bytes = ["0x00ff4100", "0x01ff4100", "0x02ff4100", "0x03ff4100", "0x04ff4100", "0x06ff4100", storeRawFacts];
  const triples: ArtifactLineageFactBundleV1[] = [];
  const refs: ReadOnlyArtifactRefV1[] = [];
  const refsByOriginalIndex: ReadOnlyArtifactRefV1[] = [];
  const policies: ResolverPolicyV1[] = [];
  const leases: RetentionLeaseReceiptV1[] = [];
  const resolutionClaims: ArtifactResolutionClaimV1[] = [];
  for (const [index, rawBytes] of bytes.entries()) {
    const policy = createResolverPolicy({
      schemaVersion: 1,
      kind: "aloha.artifact-resolver-policy",
      allowedLocatorKind: "content-object",
      digestAlgorithm: "sha256",
      maxByteLength: "4096",
      requireExactLengthMediaAndSchema: true,
      minimumRemainingStoreEpochs: "1",
      failureOutcome: "invalid",
    });
    // The content hash is obtained through the same canonical mirror codec
    // used by production; this fixture never supplies a precomputed verdict.
    const mirrorDraft = createObservedImmutableMirror({
      storeIdentityHash,
      objectKey: h("0"),
      bytes: rawBytes,
      mediaType: "application/octet-stream",
      schema: null,
    });
    const lease = createRetentionLeaseReceipt({
      storeIdentityHash,
      objectKey: mirrorDraft.contentSha256,
      contentSha256: mirrorDraft.contentSha256,
      validFromStoreEpoch: "10",
      validThroughStoreEpoch: "20",
      issuerId,
      issuerQualificationId: observerCertificate.certificateId,
      qualificationRegistryRoot: registry.registryId,
    });
    const start = String(10 + index * 10);
    const locator = {
      kind: "file-range" as const,
      systemId,
      bootIdHash,
      device: "7",
      inode: String(100 + index),
      startInclusive: start,
      endExclusive: String(Number(start) + (rawBytes.length - 2) / 2),
    };
    const ref = createReadOnlyArtifactRef({
      locator,
      immutableMirrorLocator: {
        kind: "content-object",
        storeIdentityHash,
        objectKey: mirrorDraft.contentSha256,
      },
      contentSha256: mirrorDraft.contentSha256,
      byteLength: mirrorDraft.byteLength,
      mediaType: mirrorDraft.mediaType,
      schema: null,
      resolverPolicyHash: policy.policyHash,
      retentionLeaseReceiptId: lease.receiptId,
    });
    const mirror: ObservedImmutableMirrorV1 = {
      ...mirrorDraft,
      objectKey: ref.contentSha256,
    };
    const resolutionClaim = createArtifactResolutionClaim({
      artifactRefId: ref.artifactRefId,
      resolverPolicyHash: policy.policyHash,
      observedMirror: mirror,
      outcome: "content-observed",
    });
    const lineageClaim: ArtifactLineageClaimV1 = createArtifactLineageClaim({
      schemaVersion: 1,
      kind: "aloha.artifact-lineage-claim",
      artifactRef: ref,
      resolverPolicy: policy,
      resolutionClaim,
      retentionLease: lease,
      observedStoreEpoch: "11",
    });
    const observation = createArtifactLineageObservationFromBytes({
      schemaVersion: 1,
      kind: "aloha.artifact-lineage-observation",
      artifactRefId: ref.artifactRefId,
      locator,
      immutableMirrorLocator: {
        kind: "content-object",
        storeIdentityHash,
        objectKey: ref.contentSha256,
      },
      rawBytes,
      mediaType: "application/octet-stream",
      schema: null,
      observedStoreEpoch: "11",
    });
    refs.push(ref);
    refsByOriginalIndex.push(ref);
    policies.push(policy);
    leases.push(lease);
    resolutionClaims.push(resolutionClaim);
    triples.push({
      claim: lineageClaim,
      observation,
      rawFacts: {
        rawBytes,
        locator,
        immutableMirrorLocator: {
          kind: "content-object",
          storeIdentityHash,
          objectKey: ref.contentSha256,
        },
        mediaType: "application/octet-stream",
        schema: null,
        observedStoreEpoch: "11",
      },
    });
  }
  if (contentMutation) {
    const original = triples[0]!;
    const mutatedBytes = "0xdeadbeef";
    const mutatedMirror = createObservedImmutableMirror({
      storeIdentityHash,
      objectKey: original.claim.artifactRef.contentSha256,
      bytes: mutatedBytes,
      mediaType: original.claim.artifactRef.mediaType,
      schema: null,
    });
    const mutatedResolutionClaim = createArtifactResolutionClaim({
      artifactRefId: original.claim.artifactRef.artifactRefId,
      resolverPolicyHash: original.claim.resolverPolicy.policyHash,
      observedMirror: mutatedMirror,
      outcome: "content-observed",
    });
    const mutatedLineageClaim = createArtifactLineageClaim({
      schemaVersion: 1,
      kind: "aloha.artifact-lineage-claim",
      artifactRef: original.claim.artifactRef,
      resolverPolicy: original.claim.resolverPolicy,
      resolutionClaim: mutatedResolutionClaim,
      retentionLease: original.claim.retentionLease,
      observedStoreEpoch: original.claim.observedStoreEpoch,
    });
    const mutatedObservation = createArtifactLineageObservationFromBytes({
      schemaVersion: 1,
      kind: "aloha.artifact-lineage-observation",
      artifactRefId: original.claim.artifactRef.artifactRefId,
      locator: original.observation.locator,
      immutableMirrorLocator: original.observation.immutableMirrorLocator,
      rawBytes: mutatedBytes,
      mediaType: original.observation.mediaType!,
      schema: original.observation.schema,
      observedStoreEpoch: original.observation.observedStoreEpoch,
    });
    triples[0] = {
      claim: mutatedLineageClaim,
      observation: mutatedObservation,
      rawFacts: {
        ...original.rawFacts,
        rawBytes: mutatedBytes,
      },
    };
    resolutionClaims[0] = mutatedResolutionClaim;
  }
  const ordinarySortedRefs = [...refs].sort((left, right) => left.artifactRefId.localeCompare(right.artifactRefId));
  const ordinarySortedClaims = [...resolutionClaims].sort((left, right) => left.claimId.localeCompare(right.claimId));
  const outerFacts = { source: "qualification-fixture" };
  const outerObservationDraft = {
    schemaVersion: 1 as const,
    kind: "aloha.qualified-observation" as const,
    observationSchema: ARTIFACT_LINEAGE_OBSERVER_ROLE.observationSchema,
    observerImplementationDigest,
    observerQualificationId: observerCertificate.certificateId,
    qualificationRegistryRoot: registry.registryId,
    anchorPolicyDigest: ARTIFACT_LINEAGE_OBSERVER_ROLE.anchorPolicyDigest,
    observedClaimIds: ordinarySortedClaims.map((claim) => claim.claimId),
    rawArtifactRefs: ordinarySortedRefs,
    acquisitionProductionReceiptId: h("0"),
    canonicalFacts: outerFacts,
  };
  const semanticConfigDigest = computeObserverSemanticConfigDigest(outerObservationDraft);
  const acquisitionReceipt = createProductionReceipt({
    artifactId: h("0"),
    producer: acquisitionAnchor,
    logRangeArtifactRef: refsByOriginalIndex[0]!,
    sourceAnchorHash: h("1"),
    startedMonotonicNs: "1",
    finishedMonotonicNs: "2",
    durationUs: "1",
    rawBoundaryArtifactRef: refsByOriginalIndex[1]!,
    semanticConfigDigest,
    resourceMetricsHash: h("2"),
  });
  const outerObservation = createQualifiedObservation({
    ...outerObservationDraft,
    acquisitionProductionReceiptId: acquisitionReceipt.receiptId,
  });
  const semanticArtifact = createSemanticArtifact({
    schema: ARTIFACT_LINEAGE_OBSERVER_ROLE.observationSchema,
    inputArtifactIds: ordinarySortedRefs.map((ref) => ref.artifactRefId),
    dependencyClosureRoot: h("a"),
    canonicalPayloadHash: outerObservation.canonicalFactsHash,
  });
  const fixedAcquisitionReceipt = createProductionReceipt({
    artifactId: semanticArtifact.artifactId,
    producer: acquisitionAnchor,
    logRangeArtifactRef: refsByOriginalIndex[0]!,
    sourceAnchorHash: h("1"),
    startedMonotonicNs: "1",
    finishedMonotonicNs: "2",
    durationUs: "1",
    rawBoundaryArtifactRef: refsByOriginalIndex[1]!,
    semanticConfigDigest,
    resourceMetricsHash: h("2"),
  });
  const finalOuterObservation = createQualifiedObservation({
    ...outerObservationDraft,
    acquisitionProductionReceiptId: fixedAcquisitionReceipt.receiptId,
  });
  // Subject inputs are independently consumed by the target artifact, but
  // remain a subset of the globally observed, content-addressed refs. The
  // receipt's log/boundary pair is only a process-evidence subset; the target
  // artifact may require additional inputs beyond that process evidence.
  const acquisitionProcessRefs = [refsByOriginalIndex[0]!, refsByOriginalIndex[1]!];
  const targetProcessRefs = [refsByOriginalIndex[2]!, refsByOriginalIndex[3]!];
  const subjectArtifactRefs = [refsByOriginalIndex[4]!, refsByOriginalIndex[6]!];
  const subjectArtifact = createSemanticArtifact({
    schema: ARTIFACT_LINEAGE_OBSERVER_ROLE.observationSchema,
    inputArtifactIds: subjectArtifactRefs.map((ref) => ref.artifactRefId).sort(),
    dependencyClosureRoot: h("c"),
    canonicalPayloadHash: h("d"),
  });
  const targetReceipt = createProductionReceipt({
    artifactId: subjectArtifact.artifactId,
    producer: targetAnchor,
    logRangeArtifactRef: targetProcessRefs[0]!,
    sourceAnchorHash: h("4"),
    startedMonotonicNs: "3",
    finishedMonotonicNs: "4",
    durationUs: "1",
    rawBoundaryArtifactRef: targetProcessRefs[1]!,
    semanticConfigDigest: h("e"),
    resourceMetricsHash: h("5"),
  });
  const appendCanonicalObjectRef = (
    canonicalBytes: Uint8Array,
    index: number,
    canonicalSchema: { readonly id: string; readonly version: string; readonly schemaHash: Hash },
  ): ReadOnlyArtifactRefV1 => {
    const rawBytes = encodeArtifactBytes(canonicalBytes);
    const policy = policies[0]!;
    const mirrorDraft = createObservedImmutableMirror({
      storeIdentityHash,
      objectKey: h("0"),
      bytes: rawBytes,
      mediaType: "application/json",
      schema: { id: canonicalSchema.id, version: canonicalSchema.version, schemaHash: canonicalSchema.schemaHash },
    });
    const lease = createRetentionLeaseReceipt({
      storeIdentityHash,
      objectKey: mirrorDraft.contentSha256,
      contentSha256: mirrorDraft.contentSha256,
      validFromStoreEpoch: "10",
      validThroughStoreEpoch: "20",
      issuerId,
      issuerQualificationId: observerCertificate.certificateId,
      qualificationRegistryRoot: registry.registryId,
    });
    const locator = {
      kind: "file-range" as const,
      systemId,
      bootIdHash,
      device: "7",
      inode: String(1000 + index),
      startInclusive: String(1000 + index * 100),
      endExclusive: String(1000 + index * 100 + canonicalBytes.byteLength),
    };
    const ref = createReadOnlyArtifactRef({
      locator,
      immutableMirrorLocator: { kind: "content-object", storeIdentityHash, objectKey: mirrorDraft.contentSha256 },
      contentSha256: mirrorDraft.contentSha256,
      byteLength: String(canonicalBytes.byteLength),
      mediaType: "application/json",
      schema: { id: canonicalSchema.id, version: canonicalSchema.version, schemaHash: canonicalSchema.schemaHash },
      resolverPolicyHash: policy.policyHash,
      retentionLeaseReceiptId: lease.receiptId,
    });
    const mirror = { ...mirrorDraft, objectKey: ref.contentSha256 };
    const resolutionClaim = createArtifactResolutionClaim({
      artifactRefId: ref.artifactRefId,
      resolverPolicyHash: policy.policyHash,
      observedMirror: mirror,
      outcome: "content-observed",
    });
    refs.push(ref);
    leases.push(lease);
    resolutionClaims.push(resolutionClaim);
    return ref;
  };
  const acquisitionArtifactBytesRef = appendCanonicalObjectRef(encodeSemanticArtifact(semanticArtifact), 0, CORE_SCHEMA_MANIFESTS.semanticArtifact);
  const subjectArtifactBytesRef = appendCanonicalObjectRef(encodeSemanticArtifact(subjectArtifact), 1, CORE_SCHEMA_MANIFESTS.semanticArtifact);
  const acquisitionReceiptBytesRef = appendCanonicalObjectRef(encodeProductionReceipt(fixedAcquisitionReceipt), 2, CORE_SCHEMA_MANIFESTS.productionReceipt);
  const targetReceiptBytesRef = appendCanonicalObjectRef(encodeProductionReceipt(targetReceipt), 3, CORE_SCHEMA_MANIFESTS.productionReceipt);
  const sortedRefs = [...refs].sort((left, right) => left.artifactRefId.localeCompare(right.artifactRefId));
  const sortedClaims = [...resolutionClaims].sort((left, right) => left.claimId.localeCompare(right.claimId));
  const acquisitionSidecar = createAcquisitionProcessObservation({
    schemaVersion: 1,
    kind: "aloha.acquisition-process-observation",
    observationSchema: ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE.observationSchema,
    observerImplementationDigest: acquisitionObserverCertificate.observerImplementationDigest,
    observerQualificationId: acquisitionObserverCertificate.certificateId,
    qualificationRegistryRoot: registry.registryId,
    anchorPolicyDigest: ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE.anchorPolicyDigest,
    roleId: ARTIFACT_LINEAGE_ACQUISITION_PROCESS_OBSERVER_ROLE.roleId,
    canonicalFacts: {
      receiptId: fixedAcquisitionReceipt.receiptId,
      processAnchorHash: hashProcessAnchor(acquisitionAnchor),
      logRangeArtifactRefId: fixedAcquisitionReceipt.logRangeArtifactRef.artifactRefId,
      rawBoundaryArtifactRefId: fixedAcquisitionReceipt.rawBoundaryArtifactRef.artifactRefId,
    },
  });
  const targetSidecar = createTargetProcessObservation({
    schemaVersion: 1,
    kind: "aloha.target-process-observation",
    observationSchema: ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE.observationSchema,
    observerImplementationDigest: targetObserverCertificate.observerImplementationDigest,
    observerQualificationId: targetObserverCertificate.certificateId,
    qualificationRegistryRoot: registry.registryId,
    anchorPolicyDigest: ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE.anchorPolicyDigest,
    roleId: ARTIFACT_LINEAGE_TARGET_PROCESS_OBSERVER_ROLE.roleId,
    canonicalFacts: {
      receiptId: targetReceipt.receiptId,
      processAnchorHash: hashProcessAnchor(targetAnchor),
      logRangeArtifactRefId: targetReceipt.logRangeArtifactRef.artifactRefId,
      rawBoundaryArtifactRefId: targetReceipt.rawBoundaryArtifactRef.artifactRefId,
    },
  });
  const storeSidecar = createStoreEpochObservation({
    schemaVersion: 1,
    kind: "aloha.store-epoch-observation",
    observationSchema: ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE.observationSchema,
    observerImplementationDigest: storeObserverCertificate.observerImplementationDigest,
    observerQualificationId: storeObserverCertificate.certificateId,
    qualificationRegistryRoot: registry.registryId,
    anchorPolicyDigest: ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE.anchorPolicyDigest,
    roleId: ARTIFACT_LINEAGE_STORE_EPOCH_OBSERVER_ROLE.roleId,
    canonicalFacts: {
      storeIdentityHash,
      currentStoreEpoch: "11",
      rawArtifactRefId: refsByOriginalIndex[6]!.artifactRefId,
    },
  });
  const sidecarObservations = [acquisitionSidecar, storeSidecar, targetSidecar];
  const snapshot = createQualifiedFactSnapshot({
    schemaVersion: 1,
    kind: "aloha.qualified-fact-snapshot",
    qualificationRegistryRoot: registry.registryId,
    orderedClaimIds: sortedClaims.map((claim) => claim.claimId),
    orderedObservationIds: [finalOuterObservation.observationId, ...sidecarObservations.map((value) => value.observationId)].sort(),
    orderedRawArtifactRefIds: sortedRefs.map((ref) => ref.artifactRefId),
  });
  const query = createAcceptanceQuery({
    schemaVersion: 1,
    kind: "aloha.acceptance-query",
    predicateSpecDigest: predicate.specDigest,
    qualificationRegistryRoot: registry.registryId,
    subjectArtifactRoot: hashDomain("aloha/acceptance-query/subject-artifact-root/v1", [subjectArtifact.artifactId]),
    qualifiedFactSnapshotId: snapshot.snapshotId,
    processAnchorHash: hashProcessAnchor(targetAnchor),
    correlationId: "qualification-fixture",
  });
  const binding = (
    kind: "semantic-artifact" | "production-receipt",
    objectId: Hash,
    rawArtifactRefId: Hash,
    canonicalBytes: Uint8Array,
  ) => ({
    kind,
    objectId,
    rawArtifactRefId,
    canonicalBytesSha256: sha256Hex(canonicalBytes),
    byteLength: String(canonicalBytes.byteLength),
  });
  const acquisitionArtifactBytes = encodeSemanticArtifact(semanticArtifact);
  const subjectArtifactBytes = encodeSemanticArtifact(subjectArtifact);
  const acquisitionReceiptBytes = encodeProductionReceipt(fixedAcquisitionReceipt);
  const targetReceiptBytes = encodeProductionReceipt(targetReceipt);
  // Bindings carry the exact canonical mirror bytes; the private key stays in
  // this test-only closure and is never placed in the input envelope.
  const unsignedInvocation = createUnsignedSignedObserverInvocationSnapshot({
    schemaVersion: 1,
    kind: "aloha.signed-observer-invocation-snapshot",
    registryRoot: registry.registryId,
    registryEpoch: registry.epoch,
    observerQualificationId: invocationObserverCertificate.certificateId,
    roleId: ARTIFACT_LINEAGE_INVOCATION_SEAL_OBSERVER_ROLE.roleId,
    keyId: invocationKey.keyId,
    audienceHash: ARTIFACT_LINEAGE_INVOCATION_AUDIENCE_HASH,
    invocationNonce: h("a"),
    issuedAtUnixNs: "100",
    expiresAtUnixNs: "900",
    acceptanceQueryId: query.queryId,
    qualifiedFactSnapshotId: snapshot.snapshotId,
    semanticArtifactBindings: [
      binding("semantic-artifact", semanticArtifact.artifactId, acquisitionArtifactBytesRef.artifactRefId, acquisitionArtifactBytes),
      binding("semantic-artifact", subjectArtifact.artifactId, subjectArtifactBytesRef.artifactRefId, subjectArtifactBytes),
    ].sort((left, right) => left.objectId.localeCompare(right.objectId)),
    productionReceiptBindings: [
      binding("production-receipt", fixedAcquisitionReceipt.receiptId, acquisitionReceiptBytesRef.artifactRefId, acquisitionReceiptBytes),
      binding("production-receipt", targetReceipt.receiptId, targetReceiptBytesRef.artifactRefId, targetReceiptBytes),
    ].sort((left, right) => left.objectId.localeCompare(right.objectId)),
    signatureAlgorithm: "ed25519",
  });
  const signInvocation = (unsigned: ReturnType<typeof createUnsignedSignedObserverInvocationSnapshot>): SignedObserverInvocationSnapshotV1 => {
    const invocationSignatureHex = `0x${sign(null, Buffer.from(observerInvocationSigningBytes(unsigned)), invocationPrivateKey).toString("hex")}`;
    return sealSignedObserverInvocationSnapshot(unsigned, invocationSignatureHex);
  };
  const signedInvocationSnapshot = signInvocation(unsignedInvocation);
  return {
    authority,
    input: {
      query,
      snapshot,
      registry,
      registryFacts,
      externalQualification: {
        trustAnchor: qualificationTrustAnchor,
        issuerKeys: qualificationIssuerKeys,
        registryApproval,
        signedVerifierCertificate,
        signedObserverCertificates,
        releaseAuthorityApproval,
      },
      verifierCertificate,
      observerCertificates: detailedObserverCertificates,
      artifactRefs: sortedRefs,
      resolverPolicies: [policies[0]!],
      retentionLeases: leases,
      artifactClaims: sortedClaims,
      observations: [finalOuterObservation],
      sidecarObservations,
      signedInvocationSnapshot,
      predicateFacts: triples,
    },
    mainArtifactRef: sortedRefs[0]!,
    signInvocation,
  };
}

function unsignedInvocationWithPatch(
  snapshot: SignedObserverInvocationSnapshotV1,
  patch: Record<string, unknown> = {},
): SignedObserverInvocationSnapshotV1 {
  const {
    attestationId: _attestationId,
    payloadHash: _payloadHash,
    semanticArtifactSetRoot: _semanticArtifactSetRoot,
    productionReceiptSetRoot: _productionReceiptSetRoot,
    bindingSetRoot: _bindingSetRoot,
    signatureHex: _signatureHex,
    ...draft
  } = snapshot;
  return createUnsignedSignedObserverInvocationSnapshot({ ...draft, ...patch } as never);
}

function resealInvocation(
  snapshot: SignedObserverInvocationSnapshotV1,
  patch: Record<string, unknown> = {},
  signatureHex = snapshot.signatureHex,
): SignedObserverInvocationSnapshotV1 {
  return sealSignedObserverInvocationSnapshot(unsignedInvocationWithPatch(snapshot, patch), signatureHex);
}

function replaceCanonicalObject(
  input: GateCoreInputV1,
  oldArtifactRefId: Hash,
  bytes: Uint8Array,
): {
  readonly oldRef: ReadOnlyArtifactRefV1;
  readonly newRef: ReadOnlyArtifactRefV1;
  readonly oldLeaseId: Hash;
  readonly newLease: RetentionLeaseReceiptV1;
  readonly oldClaimId: Hash;
  readonly newClaim: ArtifactResolutionClaimV1;
} {
  const oldRef = input.artifactRefs.find((value) => value.artifactRefId === oldArtifactRefId);
  if (oldRef === undefined) throw new TypeError(`missing canonical object ref ${oldArtifactRefId}`);
  const oldClaim = input.artifactClaims.find((value) => value.artifactRefId === oldArtifactRefId);
  if (oldClaim === undefined || oldClaim.observedMirror === null) throw new TypeError(`missing canonical object claim ${oldArtifactRefId}`);
  const oldLease = input.retentionLeases.find((value) => value.receiptId === oldRef.retentionLeaseReceiptId);
  if (oldLease === undefined) throw new TypeError(`missing canonical object lease ${oldArtifactRefId}`);
  const encodedBytes = encodeArtifactBytes(bytes);
  const mirror = createObservedImmutableMirror({
    storeIdentityHash: oldRef.immutableMirrorLocator.storeIdentityHash,
    objectKey: sha256Hex(bytes),
    bytes: encodedBytes,
    mediaType: oldRef.mediaType,
    schema: oldRef.schema,
  });
  const { receiptId: _oldLeaseId, ...leaseDraft } = oldLease;
  const newLease = createRetentionLeaseReceipt({
    ...leaseDraft,
    objectKey: mirror.objectKey,
    contentSha256: mirror.contentSha256,
  });
  const {
    artifactRefId: _oldRefId,
    locatorId: _oldLocatorId,
    immutableMirrorLocatorId: _oldImmutableMirrorLocatorId,
    ...refDraft
  } = oldRef;
  const adjustedLocator = oldRef.locator.kind === "file-range"
    ? {
      ...oldRef.locator,
      endExclusive: (BigInt(oldRef.locator.startInclusive) + BigInt(bytes.byteLength)).toString(),
    }
    : oldRef.locator;
  const newRef = createReadOnlyArtifactRef({
    ...refDraft,
    locator: adjustedLocator,
    immutableMirrorLocator: { ...oldRef.immutableMirrorLocator, objectKey: mirror.objectKey },
    contentSha256: mirror.contentSha256,
    byteLength: mirror.byteLength,
    retentionLeaseReceiptId: newLease.receiptId,
  });
  const newClaim = createArtifactResolutionClaim({
    artifactRefId: newRef.artifactRefId,
    resolverPolicyHash: newRef.resolverPolicyHash,
    observedMirror: mirror,
    outcome: "content-observed",
  });
  return {
    oldRef,
    newRef,
    oldLeaseId: oldLease.receiptId,
    newLease,
    oldClaimId: oldClaim.claimId,
    newClaim,
  };
}

function subjectInputOverlapInput(
  fixture: ReturnType<typeof makeLineageFixture>,
): GateCoreInputV1 {
  const input = fixture.input;
  const invocation = input.signedInvocationSnapshot;
  const acquisitionReceiptId = input.observations[0]!.acquisitionProductionReceiptId;
  const laterSignedBinding = invocation.productionReceiptBindings.find((binding) => binding.objectId === acquisitionReceiptId);
  if (laterSignedBinding === undefined) throw new TypeError("missing acquisition receipt binding");
  const targetReceiptBinding = invocation.productionReceiptBindings.find((binding) => binding.objectId !== acquisitionReceiptId);
  if (targetReceiptBinding === undefined) throw new TypeError("missing target receipt binding");
  const targetReceiptClaim = input.artifactClaims.find((claim) => claim.artifactRefId === targetReceiptBinding.rawArtifactRefId);
  if (targetReceiptClaim?.observedMirror === null || targetReceiptClaim?.observedMirror === undefined) throw new TypeError("missing target receipt mirror");
  const targetReceipt = decodeProductionReceipt(decodeArtifactBytes(targetReceiptClaim.observedMirror.bytes));
  const subjectBinding = invocation.semanticArtifactBindings.find((binding) => binding.objectId === targetReceipt.artifactId);
  if (subjectBinding === undefined) throw new TypeError("missing subject artifact binding");
  const subjectClaim = input.artifactClaims.find((claim) => claim.artifactRefId === subjectBinding.rawArtifactRefId);
  if (subjectClaim?.observedMirror === null || subjectClaim?.observedMirror === undefined) throw new TypeError("missing subject artifact mirror");
  const subjectArtifact = decodeSemanticArtifact(decodeArtifactBytes(subjectClaim.observedMirror.bytes));
  // The production-receipt partition is later than the semantic-artifact
  // partition. The rebuilt subject artifact intentionally points at the
  // unchanged acquisition-receipt binding's raw ref.
  const laterSignedBindingRefId = laterSignedBinding.rawArtifactRefId;
  const mutatedSubjectArtifact = createSemanticArtifact({
    schema: subjectArtifact.schema,
    inputArtifactIds: [...subjectArtifact.inputArtifactIds, laterSignedBindingRefId].sort(),
    dependencyClosureRoot: subjectArtifact.dependencyClosureRoot,
    canonicalPayloadHash: subjectArtifact.canonicalPayloadHash,
  });
  const { receiptId: _oldTargetReceiptId, ...targetReceiptDraft } = targetReceipt;
  const mutatedTargetReceipt = createProductionReceipt({
    ...targetReceiptDraft,
    artifactId: mutatedSubjectArtifact.artifactId,
  });
  const mutatedSubjectBytes = encodeSemanticArtifact(mutatedSubjectArtifact);
  const mutatedTargetReceiptBytes = encodeProductionReceipt(mutatedTargetReceipt);
  const subjectReplacement = replaceCanonicalObject(input, subjectBinding.rawArtifactRefId, mutatedSubjectBytes);
  const targetReceiptReplacement = replaceCanonicalObject(input, targetReceiptBinding.rawArtifactRefId, mutatedTargetReceiptBytes);
  const artifactRefs = input.artifactRefs.map((ref) => {
    if (ref.artifactRefId === subjectReplacement.oldRef.artifactRefId) return subjectReplacement.newRef;
    if (ref.artifactRefId === targetReceiptReplacement.oldRef.artifactRefId) return targetReceiptReplacement.newRef;
    return ref;
  }).sort((left, right) => left.artifactRefId.localeCompare(right.artifactRefId));
  const retentionLeases = input.retentionLeases.map((lease) => {
    if (lease.receiptId === subjectReplacement.oldLeaseId) return subjectReplacement.newLease;
    if (lease.receiptId === targetReceiptReplacement.oldLeaseId) return targetReceiptReplacement.newLease;
    return lease;
  });
  const artifactClaims = input.artifactClaims.map((claim) => {
    if (claim.claimId === subjectReplacement.oldClaimId) return subjectReplacement.newClaim;
    if (claim.claimId === targetReceiptReplacement.oldClaimId) return targetReceiptReplacement.newClaim;
    return claim;
  }).sort((left, right) => left.claimId.localeCompare(right.claimId));
  const targetSidecar = input.sidecarObservations.find((observation) => observation.kind === "aloha.target-process-observation");
  if (targetSidecar === undefined) throw new TypeError("missing target process sidecar");
  const {
    observationId: _targetObservationId,
    payloadHash: _targetPayloadHash,
    canonicalFactsHash: _targetFactsHash,
    ...targetSidecarDraft
  } = targetSidecar;
  const mutatedTargetSidecar = createTargetProcessObservation({
    ...targetSidecarDraft,
    canonicalFacts: { ...targetSidecar.canonicalFacts, receiptId: mutatedTargetReceipt.receiptId },
  });
  const sidecarObservations = input.sidecarObservations.map((observation) => observation.observationId === targetSidecar.observationId ? mutatedTargetSidecar : observation);
  const snapshot = createQualifiedFactSnapshot({
    schemaVersion: 1,
    kind: "aloha.qualified-fact-snapshot",
    qualificationRegistryRoot: input.snapshot.qualificationRegistryRoot,
    orderedClaimIds: artifactClaims.map((claim) => claim.claimId).sort(),
    orderedObservationIds: [...input.observations, ...sidecarObservations].map((observation) => observation.observationId).sort(),
    orderedRawArtifactRefIds: artifactRefs.map((ref) => ref.artifactRefId).sort(),
  });
  const { queryId: _queryId, payloadHash: _queryPayloadHash, ...queryDraft } = input.query;
  const query = createAcceptanceQuery({
    ...queryDraft,
    subjectArtifactRoot: hashDomain("aloha/acceptance-query/subject-artifact-root/v1", [mutatedSubjectArtifact.artifactId]),
    qualifiedFactSnapshotId: snapshot.snapshotId,
  });
  const semanticArtifactBindings = invocation.semanticArtifactBindings.map((binding) => binding.objectId === subjectBinding.objectId
    ? {
      ...binding,
      objectId: mutatedSubjectArtifact.artifactId,
      rawArtifactRefId: subjectReplacement.newRef.artifactRefId,
      canonicalBytesSha256: sha256Hex(mutatedSubjectBytes),
      byteLength: String(mutatedSubjectBytes.byteLength),
    }
    : binding).sort((left, right) => left.objectId.localeCompare(right.objectId));
  const productionReceiptBindings = invocation.productionReceiptBindings.map((binding) => binding.objectId === targetReceiptBinding.objectId
    ? {
      ...binding,
      objectId: mutatedTargetReceipt.receiptId,
      rawArtifactRefId: targetReceiptReplacement.newRef.artifactRefId,
      canonicalBytesSha256: sha256Hex(mutatedTargetReceiptBytes),
      byteLength: String(mutatedTargetReceiptBytes.byteLength),
    }
    : binding).sort((left, right) => left.objectId.localeCompare(right.objectId));
  const unsigned = unsignedInvocationWithPatch(invocation, {
    acceptanceQueryId: query.queryId,
    qualifiedFactSnapshotId: snapshot.snapshotId,
    semanticArtifactBindings,
    productionReceiptBindings,
  });
  const signedInvocationSnapshot = fixture.signInvocation(unsigned as ReturnType<typeof createUnsignedSignedObserverInvocationSnapshot>);
  return {
    ...input,
    query,
    snapshot,
    artifactRefs,
    retentionLeases,
    artifactClaims,
    sidecarObservations,
    signedInvocationSnapshot,
  };
}

function withInvocation(
  input: GateCoreInputV1,
  signedInvocationSnapshot: SignedObserverInvocationSnapshotV1,
): GateCoreInputV1 {
  return { ...input, signedInvocationSnapshot };
}

test("mechanically valid test-only fixture reaches the strict predicate", () => {
  const fixture = makeLineageFixture();
  const result = evaluateQualification(fixture.authority, fixture.input);
  assert.equal(result.verdict, "pass", JSON.stringify(result.reasons));
  assert.equal(result.certificate.verdict, "pass");
});

test("external qualification trust, signatures, validity, revocation, and release bindings fail closed", () => {
  const fixture = makeLineageFixture();
  const wrongSignatureHex = `0x${"11".repeat(64)}` as `0x${string}`;
  const assertInvalid = (
    label: string,
    authority: GateCoreAuthorityPinV1,
    input: GateCoreInputV1,
  ): void => {
    const result = evaluateQualification(authority, input);
    assert.equal(result.verdict, "invalid", `${label}: ${JSON.stringify(result.reasons)}`);
    assert.equal(result.certificate.verdict, "invalid", label);
  };

  const attacker = makeLineageFixture();
  assertInvalid("self-consistent attacker chain", fixture.authority, attacker.input);

  assertInvalid("registry approval signature", fixture.authority, {
    ...fixture.input,
    externalQualification: {
      ...fixture.input.externalQualification,
      registryApproval: { ...fixture.input.externalQualification.registryApproval, signatureHex: wrongSignatureHex },
    },
  });
  assertInvalid("observer certificate signature", fixture.authority, {
    ...fixture.input,
    externalQualification: {
      ...fixture.input.externalQualification,
      signedObserverCertificates: fixture.input.externalQualification.signedObserverCertificates.map((certificate, index) =>
        index === 0 ? { ...certificate, signatureHex: wrongSignatureHex } : certificate),
    },
  });
  assertInvalid("verifier certificate signature", fixture.authority, {
    ...fixture.input,
    externalQualification: {
      ...fixture.input.externalQualification,
      signedVerifierCertificate: { ...fixture.input.externalQualification.signedVerifierCertificate, signatureHex: wrongSignatureHex },
    },
  });
  assertInvalid("release approval signature", fixture.authority, {
    ...fixture.input,
    externalQualification: {
      ...fixture.input.externalQualification,
      releaseAuthorityApproval: { ...fixture.input.externalQualification.releaseAuthorityApproval, signatureHex: wrongSignatureHex },
    },
  });

  const notYetValid = makeLineageFixture(false, false, {
    qualificationKeyValidFromEpoch: "2",
    qualificationKeyValidThroughEpoch: "3",
  });
  assertInvalid("qualification key not yet valid", notYetValid.authority, notYetValid.input);
  const expired = makeLineageFixture(false, false, {
    qualificationKeyValidFromEpoch: "0",
    qualificationKeyValidThroughEpoch: "0",
  });
  assertInvalid("qualification key expired", expired.authority, expired.input);
  const revoked = makeLineageFixture(false, false, { revokeFirstObserverCertificate: true });
  assertInvalid("revoked observer certificate", revoked.authority, revoked.input);

  assertInvalid("wrong qualification audience", {
    ...fixture.authority,
    externalQualification: {
      ...fixture.authority.externalQualification,
      expectedQualificationAudienceHash: h("f"),
    },
  }, fixture.input);
  assertInvalid("unsigned V1 downgrade", fixture.authority, {
    ...fixture.input,
    externalQualification: {
      ...fixture.input.externalQualification,
      signedVerifierCertificate: undefined as never,
    },
  });
  assertInvalid("signed payload mutation", fixture.authority, {
    ...fixture.input,
    externalQualification: {
      ...fixture.input.externalQualification,
      registryApproval: {
        ...fixture.input.externalQualification.registryApproval,
        registryPayloadHash: h("f"),
      },
    },
  });

  const releaseBindingMutations: readonly GateCoreAuthorityPinV1[] = [
    {
      ...fixture.authority,
      externalQualification: {
        ...fixture.authority.externalQualification,
        expectedReleaseRoleManifestRoot: h("f"),
      },
    },
    {
      ...fixture.authority,
      externalQualification: {
        ...fixture.authority.externalQualification,
        expectedCandidateReleaseCommit: "f".repeat(40),
      },
    },
    {
      ...fixture.authority,
      externalQualification: {
        ...fixture.authority.externalQualification,
        expectedCandidateReleaseCommit: "0".repeat(40),
      },
    },
    { ...fixture.authority, predicateCompositionRootDigest: h("f") },
    { ...fixture.authority, gateCoreRuntimeClosureDigest: h("f") },
  ];
  for (const [index, authority] of releaseBindingMutations.entries()) {
    assertInvalid(`release binding ${index}`, authority, fixture.input);
  }
});

test("generated binding export identities must match the qualified authority", () => {
  const fixture = makeLineageFixture();
  const binding = resolvePredicateEvaluator(ARTIFACT_LINEAGE_PREDICATE_SPEC.predicateId);
  assert.ok(binding);
  for (const field of ["predicateImplementationExportDigest", "oracleImplementationExportDigest"] as const) {
    const result = evaluateQualificationWithComposition(fixture.authority, fixture.input, {
      rootDigest: PREDICATE_COMPOSITION_ROOT_DIGEST,
      resolve: () => Object.freeze({ ...binding, [field]: h("0") }),
    });
    assert.equal(result.verdict, "invalid");
    assert.ok(result.reasons.some((reason) => reason.code === "predicate-composition-mismatch" && reason.path === `$.authority.${field}`));
  }
});

test("authority cannot substitute a different predicate composition leaf or root", () => {
  const fixture = makeLineageFixture();
  for (const field of ["predicateCompositionLeafDigest", "predicateCompositionRootDigest"] as const) {
    const result = evaluateQualification({ ...fixture.authority, [field]: h("b") }, fixture.input);
    assert.equal(result.verdict, "invalid", field);
    assert.ok(result.reasons.some((reason) => reason.code === "predicate-composition-mismatch"), field);
  }
});

test("evaluator verdict and predicate-failed reason must agree", () => {
  const fixture = makeLineageFixture();
  const binding = resolvePredicateEvaluator(ARTIFACT_LINEAGE_PREDICATE_SPEC.predicateId);
  assert.ok(binding);
  const compositionFor = (evaluateLive: PredicateEvaluatorV1["evaluateLive"]): PredicateCompositionPortV1 => ({
    rootDigest: PREDICATE_COMPOSITION_ROOT_DIGEST,
    resolve: () => Object.freeze({
      ...binding,
      evaluator: Object.freeze({ ...binding.evaluator, evaluateLive }),
    }),
  });

  const failWithoutReason = evaluateQualificationWithComposition(
    fixture.authority,
    fixture.input,
    compositionFor(() => "fail"),
  );
  assert.equal(failWithoutReason.verdict, "invalid");
  assert.equal(failWithoutReason.reasons.some((reason) => reason.code === "predicate-failed"), false);

  const passWithReason = evaluateQualificationWithComposition(
    fixture.authority,
    fixture.input,
    compositionFor((_facts, issues) => {
      issues.add("predicate-failed", "$.predicateFacts[0]");
      return "pass";
    }),
  );
  assert.equal(passWithReason.verdict, "invalid");
  assert.ok(passWithReason.reasons.some((reason) => reason.code === "predicate-failed"));

  const failWithReason = evaluateQualificationWithComposition(
    fixture.authority,
    fixture.input,
    compositionFor((_facts, issues) => {
      issues.add("predicate-failed", "$.predicateFacts[0]");
      return "fail";
    }),
  );
  assert.equal(failWithReason.verdict, "fail", JSON.stringify(failWithReason.reasons));
});

test("artifactRefId enumerable accessor is rejected without being invoked", () => {
  const fixture = makeLineageFixture();
  const sourceClaim = fixture.input.artifactClaims[0]!;
  let getterInvoked = false;
  const hostileClaim = { ...sourceClaim } as Record<string, unknown>;
  Object.defineProperty(hostileClaim, "artifactRefId", {
    configurable: true,
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("artifactRefId accessor must not run");
    },
  });
  const input = {
    ...fixture.input,
    artifactClaims: [hostileClaim, ...fixture.input.artifactClaims.slice(1)],
  } as unknown as GateCoreInputV1;
  const result = evaluateQualification(fixture.authority, input);
  assert.equal(getterInvoked, false);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some((reason) => reason.code === "artifact-claim-mismatch"));
});

test("oversized non-hex mirror bytes stop at resolver-policy preflight", () => {
  const fixture = makeLineageFixture();
  const sourceClaim = fixture.input.artifactClaims[0]!;
  const oversizedNonHexBytes = `0x${"gg".repeat(4097)}`;
  const mutatedMirror = {
    ...sourceClaim.observedMirror!,
    bytes: oversizedNonHexBytes,
  };
  const input = {
    ...fixture.input,
    artifactClaims: [
      {
        ...sourceClaim,
        observedMirror: mutatedMirror,
      },
      ...fixture.input.artifactClaims.slice(1),
    ],
  } as unknown as GateCoreInputV1;
  const result = evaluateQualification(fixture.authority, input);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some((reason) =>
    reason.code === "resolver-policy-mismatch" &&
    reason.path === "$.artifactClaims[0].observedMirror.byteLength",
  ));
});

test("top-level input arrays are bounded dense data arrays before decoding", () => {
  const fixture = makeLineageFixture();
  const evaluate = (input: unknown) => evaluateQualification(fixture.authority, input as GateCoreInputV1);

  const oversized = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  (oversized.artifactRefs as unknown as { length: number }).length = 16_385;
  const oversizedResult = evaluate(oversized);
  assert.equal(oversizedResult.verdict, "invalid");
  assert.ok(oversizedResult.reasons.some((reason) => reason.code === "schema-invalid" && reason.path === "$.input"));

  const sparse = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  delete (sparse.artifactRefs as unknown as unknown[])[0];
  const sparseResult = evaluate(sparse);
  assert.equal(sparseResult.verdict, "invalid");
  assert.ok(sparseResult.reasons.some((reason) => reason.code === "schema-invalid" && reason.path === "$.input"));

  const extra = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  (extra.artifactRefs as unknown as Record<string, unknown>).extra = fixture.input.artifactRefs[0];
  const extraResult = evaluate(extra);
  assert.equal(extraResult.verdict, "invalid");
  assert.ok(extraResult.reasons.some((reason) => reason.code === "schema-invalid" && reason.path === "$.input"));

  const accessor = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  let getterInvoked = false;
  Object.defineProperty(accessor.artifactRefs, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("array element accessor must not run");
    },
  });
  const accessorResult = evaluate(accessor);
  assert.equal(getterInvoked, false);
  assert.equal(accessorResult.verdict, "invalid");
  assert.ok(accessorResult.reasons.some((reason) => reason.code === "schema-invalid" && reason.path === "$.input"));
});

test("proxied input arrays are rejected before any proxy trap runs", () => {
  const fixture = makeLineageFixture();
  let getTrapInvoked = false;
  let ownKeysTrapInvoked = false;
  let descriptorTrapInvoked = false;
  const proxiedRefs = new Proxy([...fixture.input.artifactRefs], {
    get(target, property, receiver) {
      getTrapInvoked = true;
      return Reflect.get(target, property, receiver);
    },
    ownKeys() {
      ownKeysTrapInvoked = true;
      throw new Error("array ownKeys trap must not run");
    },
    getOwnPropertyDescriptor() {
      descriptorTrapInvoked = true;
      throw new Error("array descriptor trap must not run");
    },
  });
  const input = { ...fixture.input, artifactRefs: proxiedRefs } as unknown as GateCoreInputV1;
  const result = evaluateQualification(fixture.authority, input);
  assert.equal(getTrapInvoked, false);
  assert.equal(ownKeysTrapInvoked, false);
  assert.equal(descriptorTrapInvoked, false);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some((reason) => reason.code === "schema-invalid" && reason.path === "$.input"));
});

test("nested registry and invocation arrays reject accessors without invoking them", () => {
  const fixture = makeLineageFixture();
  const input = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  let getterInvoked = false;
  Object.defineProperty(input.registryFacts.trustedIssuerIds, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("nested registry array accessor must not run");
    },
  });
  const registryResult = evaluateQualification(fixture.authority, input);
  assert.equal(getterInvoked, false);
  assert.equal(registryResult.verdict, "invalid");
  assert.ok(registryResult.reasons.some((reason) => reason.code === "schema-invalid" && reason.path === "$.input"));

  const invocationInput = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  getterInvoked = false;
  Object.defineProperty(invocationInput.signedInvocationSnapshot.semanticArtifactBindings, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("nested invocation array accessor must not run");
    },
  });
  const invocationResult = evaluateQualification(fixture.authority, invocationInput);
  assert.equal(getterInvoked, false);
  assert.equal(invocationResult.verdict, "invalid");
  assert.ok(invocationResult.reasons.some((reason) => reason.code === "schema-invalid" && reason.path === "$.input"));
});

test("cumulative mirror byte budget stops before downstream decoding", () => {
  const fixture = makeLineageFixture();
  const input = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  const mirrorBytes = `0x${"00".repeat(Math.floor(CANONICAL_LIMITS.maxBytes / 2) + 1)}`;
  (input as unknown as { artifactClaims: GateCoreInputV1["artifactClaims"] }).artifactClaims = input.artifactClaims.map((claim, index) => index < 2
    ? { ...claim, observedMirror: { ...claim.observedMirror!, bytes: mirrorBytes } }
    : claim);
  const result = evaluateQualification(fixture.authority, input);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some((reason) => reason.code === "artifact-claim-mismatch"));
  assert.equal(result.reasons.some((reason) => reason.code === "invocation-signature-mismatch"), false);
});

test("an unrelated expired signing key does not invalidate the selected seal key", () => {
  const fixture = makeLineageFixture(false, true);
  const result = evaluateQualification(fixture.authority, fixture.input);
  assert.equal(result.verdict, "pass", JSON.stringify(result.reasons));
  assert.equal(fixture.input.registryFacts.observerSigningKeys.length, 2);
});

test("invocation seal fixture binds exact canonical artifact and receipt mirror bytes", () => {
  const fixture = makeLineageFixture();
  const invocation = fixture.input.signedInvocationSnapshot;
  assert.equal("privateKey" in (fixture.input as unknown as Record<string, unknown>), false);
  for (const binding of [...invocation.semanticArtifactBindings, ...invocation.productionReceiptBindings]) {
    const claim = fixture.input.artifactClaims.find((candidate) => candidate.artifactRefId === binding.rawArtifactRefId);
    assert.ok(claim?.observedMirror);
    const bytes = decodeArtifactBytes(claim!.observedMirror!.bytes);
    assert.equal(bytes.byteLength, Number(binding.byteLength));
    assert.equal(binding.canonicalBytesSha256, sha256Hex(bytes));
    assert.equal(claim!.observedMirror!.byteLength, binding.byteLength);
  }
  assert.equal(invocation.observerQualificationId, fixture.input.observerCertificates.find((candidate) =>
    candidate.certificateId === invocation.observerQualificationId,
  )?.certificateId);
});

test("invocation seal mutations are individually fail-closed", () => {
  const fixture = makeLineageFixture();
  const baseInvocation = fixture.input.signedInvocationSnapshot;
  const exercised = new Set<string>();
  const expectInvalid = (mutationId: string, input: GateCoreInputV1, now = "500") => {
    const result = evaluateQualification(fixture.authority, input, now);
    assert.equal(result.verdict, "invalid", mutationId);
    exercised.add(mutationId);
  };
  const directInvocation = (patch: Record<string, unknown>): GateCoreInputV1 => {
    const input = structuredClone(fixture.input) as unknown as GateCoreInputV1;
    (input as unknown as { signedInvocationSnapshot: unknown }).signedInvocationSnapshot = { ...input.signedInvocationSnapshot, ...patch };
    return input;
  };

  expectInvalid("invocation-signature-missing", directInvocation({ signatureHex: `0x${"0".repeat(128)}` }));
  expectInvalid("invocation-signature-random", withInvocation(fixture.input, resealInvocation(baseInvocation, {}, `0x${"11".repeat(64)}`)));
  expectInvalid("invocation-signature-byte", directInvocation({ signatureHex: `0x${"22".repeat(64)}` }));
  expectInvalid("invocation-signature-payload", withInvocation(fixture.input, resealInvocation(baseInvocation, { audienceHash: h("9") })));
  expectInvalid("invocation-key-unregistered", directInvocation({ keyId: h("f") }));
  const revokedKey = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  (revokedKey as unknown as { registryFacts: RegistryMembershipFactsV1 }).registryFacts = { ...revokedKey.registryFacts, revokedObserverKeyIds: [baseInvocation.keyId] };
  expectInvalid("invocation-key-revoked", revokedKey);
  const expiredKey = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  (expiredKey as unknown as { registryFacts: RegistryMembershipFactsV1 }).registryFacts = {
    ...expiredKey.registryFacts,
    observerSigningKeys: expiredKey.registryFacts.observerSigningKeys.map((key) => ({ ...key, validFromRegistryEpoch: "2", validThroughRegistryEpoch: "2" })),
  };
  expectInvalid("invocation-key-expired", expiredKey);
  expectInvalid("invocation-key-locator-capability", {
    ...fixture.input,
    observerCertificates: fixture.input.observerCertificates.map((certificate) => certificate.certificateId === baseInvocation.observerQualificationId
      ? { ...certificate, qualifiedLocatorKinds: ["file-range"] }
      : certificate),
  } as GateCoreInputV1);
  expectInvalid("invocation-key-role", withInvocation(fixture.input, resealInvocation(baseInvocation, { roleId: ARTIFACT_LINEAGE_OBSERVER_ROLE.roleId })));
  expectInvalid("invocation-key-audience", withInvocation(fixture.input, resealInvocation(baseInvocation, { audienceHash: h("9") })));
  expectInvalid("invocation-query", withInvocation(fixture.input, resealInvocation(baseInvocation, { acceptanceQueryId: h("f") })));
  expectInvalid("invocation-snapshot", withInvocation(fixture.input, resealInvocation(baseInvocation, { qualifiedFactSnapshotId: h("f") })));
  expectInvalid("invocation-expiry-boundary", fixture.input, "900");
  expectInvalid("invocation-ordinary-observer-role", withInvocation(fixture.input, resealInvocation(baseInvocation, { roleId: ARTIFACT_LINEAGE_OBSERVER_ROLE.roleId })));

  const subsetInvocation = resealInvocation(baseInvocation, {
    semanticArtifactBindings: [baseInvocation.semanticArtifactBindings[0]!],
  });
  expectInvalid("invocation-binding-subset", withInvocation(fixture.input, subsetInvocation));
  expectInvalid("invocation-binding-extra", directInvocation({
    semanticArtifactBindings: [...baseInvocation.semanticArtifactBindings, baseInvocation.semanticArtifactBindings[0]!],
  }));
  expectInvalid("invocation-binding-duplicate", directInvocation({
    productionReceiptBindings: [baseInvocation.productionReceiptBindings[0]!, baseInvocation.productionReceiptBindings[0]!],
  }));
  expectInvalid("invocation-binding-reorder", directInvocation({
    semanticArtifactBindings: [...baseInvocation.semanticArtifactBindings].reverse(),
  }));
  expectInvalid("invocation-binding-object-id", directInvocation({
    semanticArtifactBindings: [{ ...baseInvocation.semanticArtifactBindings[0]!, objectId: h("f") }, baseInvocation.semanticArtifactBindings[1]!],
  }));
  expectInvalid("invocation-binding-raw-ref", directInvocation({
    semanticArtifactBindings: [{ ...baseInvocation.semanticArtifactBindings[0]!, rawArtifactRefId: h("f") }, baseInvocation.semanticArtifactBindings[1]!],
  }));
  expectInvalid("invocation-binding-hash", directInvocation({
    semanticArtifactBindings: [{ ...baseInvocation.semanticArtifactBindings[0]!, canonicalBytesSha256: h("f") }, baseInvocation.semanticArtifactBindings[1]!],
  }));
  expectInvalid("invocation-binding-length", directInvocation({
    semanticArtifactBindings: [{ ...baseInvocation.semanticArtifactBindings[0]!, byteLength: "1" }, baseInvocation.semanticArtifactBindings[1]!],
  }));
  const mirrorHash = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  const mirrorHashIndex = mirrorHash.artifactClaims.findIndex((claim) => claim.artifactRefId === baseInvocation.semanticArtifactBindings[0]!.rawArtifactRefId);
  const mirrorHashClaim = mirrorHash.artifactClaims[mirrorHashIndex]!;
  (mirrorHash as unknown as { artifactClaims: ArtifactResolutionClaimV1[] }).artifactClaims[mirrorHashIndex] = {
    ...mirrorHashClaim,
    observedMirror: { ...mirrorHashClaim.observedMirror!, contentSha256: h("f") },
  };
  expectInvalid("invocation-binding-mirror-hash", mirrorHash);
  const mirrorMedia = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  const mirrorMediaIndex = mirrorMedia.artifactClaims.findIndex((claim) => claim.artifactRefId === baseInvocation.semanticArtifactBindings[0]!.rawArtifactRefId);
  const mirrorMediaClaim = mirrorMedia.artifactClaims[mirrorMediaIndex]!;
  (mirrorMedia as unknown as { artifactClaims: ArtifactResolutionClaimV1[] }).artifactClaims[mirrorMediaIndex] = {
    ...mirrorMediaClaim,
    observedMirror: { ...mirrorMediaClaim.observedMirror!, mediaType: "text/plain" },
  };
  expectInvalid("invocation-binding-mirror-media", mirrorMedia);
  const mirrorSchema = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  const mirrorSchemaIndex = mirrorSchema.artifactClaims.findIndex((claim) => claim.artifactRefId === baseInvocation.semanticArtifactBindings[0]!.rawArtifactRefId);
  const mirrorSchemaClaim = mirrorSchema.artifactClaims[mirrorSchemaIndex]!;
  (mirrorSchema as unknown as { artifactClaims: ArtifactResolutionClaimV1[] }).artifactClaims[mirrorSchemaIndex] = {
    ...mirrorSchemaClaim,
    observedMirror: { ...mirrorSchemaClaim.observedMirror!, schema: null },
  };
  expectInvalid("invocation-binding-mirror-schema", mirrorSchema);
  expectInvalid("invocation-binding-raw-partition-overlap", directInvocation({
    productionReceiptBindings: [{ ...baseInvocation.productionReceiptBindings[0]!, rawArtifactRefId: baseInvocation.semanticArtifactBindings[0]!.rawArtifactRefId }, baseInvocation.productionReceiptBindings[1]!],
  }));
  expectInvalid("invocation-binding-receipt-boundary-overlap", directInvocation({
    productionReceiptBindings: [{ ...baseInvocation.productionReceiptBindings[0]!, rawArtifactRefId: baseInvocation.semanticArtifactBindings[0]!.rawArtifactRefId }, baseInvocation.productionReceiptBindings[1]!],
  }));
  const forged = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  const forgedBinding = forged.signedInvocationSnapshot.semanticArtifactBindings[0]!;
  const forgedClaimIndex = forged.artifactClaims.findIndex((claim) => claim.artifactRefId === forgedBinding.rawArtifactRefId);
  const forgedClaim = forged.artifactClaims[forgedClaimIndex]!;
  (forged as unknown as { artifactClaims: ArtifactResolutionClaimV1[] }).artifactClaims[forgedClaimIndex] = {
    ...forgedClaim,
    observedMirror: { ...forgedClaim.observedMirror!, bytes: encodeArtifactBytes(new Uint8Array([0x7f])) },
  };
  expectInvalid("invocation-binding-forged-object", forged);
  const signedRawRefs = new Set([
    ...baseInvocation.semanticArtifactBindings.map((binding) => binding.rawArtifactRefId),
    ...baseInvocation.productionReceiptBindings.map((binding) => binding.rawArtifactRefId),
  ]);
  const unsignedDerivedRef = fixture.input.artifactRefs.find((ref) => !signedRawRefs.has(ref.artifactRefId));
  assert.ok(unsignedDerivedRef);
  expectInvalid("invocation-binding-unsigned-derived-object", directInvocation({
    semanticArtifactBindings: [{ ...baseInvocation.semanticArtifactBindings[0]!, rawArtifactRefId: unsignedDerivedRef.artifactRefId }, baseInvocation.semanticArtifactBindings[1]!],
  }));
  const subjectOverlap = subjectInputOverlapInput(fixture);
  const overlapSignedRawRefs = new Set([
    ...subjectOverlap.signedInvocationSnapshot.semanticArtifactBindings.map((binding) => binding.rawArtifactRefId),
    ...subjectOverlap.signedInvocationSnapshot.productionReceiptBindings.map((binding) => binding.rawArtifactRefId),
  ]);
  assert.ok(subjectOverlap.signedInvocationSnapshot.semanticArtifactBindings.some((binding) => {
    const claim = subjectOverlap.artifactClaims.find((candidate) => candidate.artifactRefId === binding.rawArtifactRefId);
    return claim?.observedMirror !== null && claim?.observedMirror !== undefined &&
      decodeSemanticArtifact(decodeArtifactBytes(claim.observedMirror.bytes)).inputArtifactIds.some((refId) => overlapSignedRawRefs.has(refId));
  }));
  const subjectOverlapResult = evaluateQualification(fixture.authority, subjectOverlap);
  assert.equal(subjectOverlapResult.verdict, "invalid", "invocation-binding-subject-input-overlap");
  assert.ok(subjectOverlapResult.reasons.some((reason) => reason.code === "invocation-binding-mismatch" && reason.path.includes("inputArtifactIds")));
  exercised.add("invocation-binding-subject-input-overlap");

  assert.deepEqual([...exercised].sort(), [...ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS].sort());
});

test("observed subject content mutation invalidates the content-addressed artifact binding", () => {
  const fixture = makeLineageFixture(true);
  const result = evaluateQualification(fixture.authority, fixture.input);
  assert.equal(result.verdict, "invalid", JSON.stringify(result.reasons));
  assert.ok(result.reasons.some((reason) => reason.code === "artifact-content-mismatch"));
});

test("snapshot orphan is invalid even when the live predicate facts are valid", () => {
  const fixture = makeLineageFixture();
  const mutated = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  (mutated as unknown as { snapshot: unknown }).snapshot = { ...mutated.snapshot, orderedClaimIds: [...mutated.snapshot.orderedClaimIds, h("d")] };
  const result = evaluateQualification(fixture.authority, mutated);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some((reason) => reason.code === "snapshot-mismatch"));
});

test("raw artifact partition rejects an orphan ref even when snapshot includes it", () => {
  const fixture = makeLineageFixture();
  const replacement = replaceCanonicalObject(fixture.input, fixture.mainArtifactRef.artifactRefId, new Uint8Array([0x99, 0x88, 0x77, 0x66]));
  const artifactRefs = [...fixture.input.artifactRefs, replacement.newRef].sort((left, right) => left.artifactRefId.localeCompare(right.artifactRefId));
  const artifactClaims = [...fixture.input.artifactClaims, replacement.newClaim].sort((left, right) => left.claimId.localeCompare(right.claimId));
  const retentionLeases = [...fixture.input.retentionLeases, replacement.newLease];
  const snapshot = createQualifiedFactSnapshot({
    schemaVersion: 1,
    kind: "aloha.qualified-fact-snapshot",
    qualificationRegistryRoot: fixture.input.snapshot.qualificationRegistryRoot,
    orderedClaimIds: artifactClaims.map((claim) => claim.claimId),
    orderedObservationIds: fixture.input.snapshot.orderedObservationIds,
    orderedRawArtifactRefIds: artifactRefs.map((ref) => ref.artifactRefId),
  });
  const query = createAcceptanceQuery({
    schemaVersion: 1,
    kind: "aloha.acceptance-query",
    predicateSpecDigest: fixture.input.query.predicateSpecDigest,
    qualificationRegistryRoot: fixture.input.query.qualificationRegistryRoot,
    subjectArtifactRoot: fixture.input.query.subjectArtifactRoot,
    qualifiedFactSnapshotId: snapshot.snapshotId,
    processAnchorHash: fixture.input.query.processAnchorHash,
    correlationId: fixture.input.query.correlationId,
  });
  const signedInvocationSnapshot = fixture.signInvocation(unsignedInvocationWithPatch(fixture.input.signedInvocationSnapshot, {
    acceptanceQueryId: query.queryId,
    qualifiedFactSnapshotId: snapshot.snapshotId,
  }));
  const mutated = {
    ...fixture.input,
    artifactRefs,
    artifactClaims,
    retentionLeases,
    snapshot,
    query,
    signedInvocationSnapshot,
  } as GateCoreInputV1;
  const result = evaluateQualification(fixture.authority, mutated);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some((reason) => reason.code === "artifact-ref-mismatch" && reason.path === "$.artifactRefs"));
});

test("missing fact, stale lease epoch, and producer oracle fields are fail-closed", () => {
  const fixture = makeLineageFixture();
  const missing = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  (missing.predicateFacts as unknown as unknown[]).pop();
  const missingResult = evaluateQualification(fixture.authority, missing);
  assert.equal(missingResult.verdict, "invalid");
  assert.ok(missingResult.reasons.some((reason) => reason.code === "predicate-observation-missing"));

  const stale = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  const staleStore = stale.sidecarObservations.find((value) => value.kind === "aloha.store-epoch-observation")!;
  (stale.sidecarObservations as unknown as Array<Record<string, unknown>>)[stale.sidecarObservations.indexOf(staleStore)] = {
    ...staleStore,
    canonicalFacts: { ...staleStore.canonicalFacts, currentStoreEpoch: "999" },
  };
  const staleResult = evaluateQualification(fixture.authority, stale);
  assert.equal(staleResult.verdict, "invalid");
  assert.ok(staleResult.reasons.some((reason) => reason.code === "observation-mismatch"));

  const oracleField = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  const first = oracleField.predicateFacts[0] as ArtifactLineageFactBundleV1;
  (oracleField.predicateFacts as unknown as unknown[])[0] = { ...first, producerVerdict: "fail" };
  const oracleFieldResult = evaluateQualification(fixture.authority, oracleField);
  assert.equal(oracleFieldResult.verdict, "invalid");
  assert.ok(oracleFieldResult.reasons.some((reason) => reason.code === "predicate-observation-mismatch" || reason.code === "schema-invalid"));
});

test("authority closure or verifier subject mismatch is invalid", () => {
  const fixture = makeLineageFixture();
  const result = evaluateQualification({ ...fixture.authority, gateCoreImplementationClosureDigest: h("0") }, fixture.input);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some((reason) => reason.code === "registry-mismatch" || reason.code === "verifier-qualification-mismatch"));

  const wrongSealRole = evaluateQualification({
    ...fixture.authority,
    signedInvocationRoleId: ARTIFACT_LINEAGE_OBSERVER_ROLE.roleId,
  }, fixture.input);
  assert.equal(wrongSealRole.verdict, "invalid");
  assert.ok(wrongSealRole.reasons.some((reason) => reason.code === "invocation-role-mismatch"));
});

test("predicate and oracle export identities are independently authority-bound", () => {
  const fixture = makeLineageFixture();
  for (const [field, replacement] of [
    ["predicateImplementationExportDigest", h("9")],
    ["oracleImplementationExportDigest", h("a")],
  ] as const) {
    const result = evaluateQualification({ ...fixture.authority, [field]: replacement }, fixture.input);
    assert.equal(result.verdict, "invalid", field);
    assert.ok(result.reasons.some((reason) => reason.code === "verifier-qualification-mismatch"), field);
  }

  const result = evaluateQualification(fixture.authority, fixture.input);
  assert.equal(result.verdict, "pass");
  assert.equal(result.certificate.verdict, result.verdict);
  assert.equal(result.certificate.predicateImplementationExportDigest, fixture.authority.predicateImplementationExportDigest);
  assert.equal(result.certificate.oracleImplementationExportDigest, fixture.authority.oracleImplementationExportDigest);
  assert.equal(recomputeAcceptanceCertificatePayloadHash(result.certificate), result.certificate.payloadHash);
  assert.equal(recomputeAcceptanceCertificateId(result.certificate), result.certificate.certificateId);
  assert.deepEqual(decodeAcceptanceCertificate(result.certificate), result.certificate);

  for (const field of ["predicateImplementationExportDigest", "oracleImplementationExportDigest"] as const) {
    assert.throws(() => decodeAcceptanceCertificate({ ...result.certificate, [field]: h("b") }), field);
  }
  assert.throws(() => decodeAcceptanceCertificate({ ...result.certificate, verdict: "invalid" }), "verdict");
  const { predicateImplementationExportDigest: _predicateExport, ...missingPredicateExport } = result.certificate;
  assert.throws(() => decodeAcceptanceCertificate(missingPredicateExport), "predicateImplementationExportDigest");
  const { oracleImplementationExportDigest: _oracleExport, ...missingOracleExport } = result.certificate;
  assert.throws(() => decodeAcceptanceCertificate(missingOracleExport), "oracleImplementationExportDigest");
});

test("acquisition and target process raw ranges cannot be spliced", () => {
  const fixture = makeLineageFixture();
  const mutated = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  const acquisitionIndex = mutated.sidecarObservations.findIndex((value) => value.kind === "aloha.acquisition-process-observation");
  const acquisition = mutated.sidecarObservations[acquisitionIndex]!;
  const target = mutated.sidecarObservations.find((value) => value.kind === "aloha.target-process-observation")!;
  (mutated.sidecarObservations as unknown as Array<Record<string, unknown>>)[acquisitionIndex] = {
    ...acquisition,
    canonicalFacts: { ...acquisition.canonicalFacts, logRangeArtifactRefId: target.canonicalFacts.logRangeArtifactRefId },
  };
  const result = evaluateQualification(fixture.authority, mutated);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some((reason) => reason.code === "observation-mismatch"));
});

test("sidecar exact partition rejects duplicate, orphan, and cross-role receipt/ref joins", () => {
  const fixture = makeLineageFixture();
  const acquisition = fixture.input.sidecarObservations.find((value) => value.kind === "aloha.acquisition-process-observation")!;
  const target = fixture.input.sidecarObservations.find((value) => value.kind === "aloha.target-process-observation")!;

  const duplicate = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  (duplicate as unknown as { sidecarObservations: GateCoreInputV1["sidecarObservations"] }).sidecarObservations = [...duplicate.sidecarObservations, acquisition];
  const duplicateResult = evaluateQualification(fixture.authority, duplicate);
  assert.equal(duplicateResult.verdict, "invalid");
  assert.ok(duplicateResult.reasons.some((reason) => reason.code === "observation-mismatch" || reason.code === "process-observation-missing"));

  const orphan = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  (orphan as unknown as { sidecarObservations: GateCoreInputV1["sidecarObservations"] }).sidecarObservations = orphan.sidecarObservations.filter((value) => value.observationId !== target.observationId);
  const orphanResult = evaluateQualification(fixture.authority, orphan);
  assert.equal(orphanResult.verdict, "invalid");
  assert.ok(orphanResult.reasons.some((reason) => reason.code === "snapshot-mismatch" || reason.code === "process-observation-missing"));

  const receiptSplice = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  const receiptSpliceIndex = receiptSplice.sidecarObservations.findIndex((value) => value.kind === "aloha.target-process-observation");
  const receiptSpliceTarget = receiptSplice.sidecarObservations[receiptSpliceIndex]!;
  const acquisitionReceiptId = acquisition.canonicalFacts.receiptId;
  (receiptSplice.sidecarObservations as unknown as Array<Record<string, unknown>>)[receiptSpliceIndex] = {
    ...receiptSpliceTarget,
    canonicalFacts: { ...receiptSpliceTarget.canonicalFacts, receiptId: acquisitionReceiptId },
  };
  const receiptSpliceResult = evaluateQualification(fixture.authority, receiptSplice);
  assert.equal(receiptSpliceResult.verdict, "invalid");

  const rawSplice = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  const rawSpliceIndex = rawSplice.sidecarObservations.findIndex((value) => value.kind === "aloha.target-process-observation");
  const rawSpliceTarget = rawSplice.sidecarObservations[rawSpliceIndex]!;
  (rawSplice.sidecarObservations as unknown as Array<Record<string, unknown>>)[rawSpliceIndex] = {
    ...rawSpliceTarget,
    canonicalFacts: {
      ...rawSpliceTarget.canonicalFacts,
      rawBoundaryArtifactRefId: acquisition.canonicalFacts.rawBoundaryArtifactRefId,
    },
  };
  const rawSpliceResult = evaluateQualification(fixture.authority, rawSplice);
  assert.equal(rawSpliceResult.verdict, "invalid");
});

test("sidecar role, observer certificate, and content hash mutations are fail-closed", () => {
  const fixture = makeLineageFixture();
  const wrongRole = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  const targetIndex = wrongRole.sidecarObservations.findIndex((value) => value.kind === "aloha.target-process-observation");
  const target = wrongRole.sidecarObservations[targetIndex]!;
  (wrongRole.sidecarObservations as unknown as Array<Record<string, unknown>>)[targetIndex] = {
    ...target,
    roleId: "acquisition-observer-process",
  };
  const wrongRoleResult = evaluateQualification(fixture.authority, wrongRole);
  assert.equal(wrongRoleResult.verdict, "invalid");
  assert.ok(wrongRoleResult.reasons.some((reason) => reason.code === "observation-mismatch" || reason.code === "observer-qualification-mismatch"));

  const wrongCert = structuredClone(fixture.input) as unknown as GateCoreInputV1;
  const storeIndex = wrongCert.sidecarObservations.findIndex((value) => value.kind === "aloha.store-epoch-observation");
  const store = wrongCert.sidecarObservations[storeIndex]!;
  (wrongCert.sidecarObservations as unknown as Array<Record<string, unknown>>)[storeIndex] = {
    ...store,
    observerQualificationId: fixture.input.observerCertificates[0]!.certificateId,
  };
  const wrongCertResult = evaluateQualification(fixture.authority, wrongCert);
  assert.equal(wrongCertResult.verdict, "invalid");
  assert.ok(wrongCertResult.reasons.some((reason) => reason.code === "observation-mismatch" || reason.code === "observer-qualification-mismatch"));
});

test("store epoch sidecar must equal independently decoded store raw facts", () => {
  const fixture = makeLineageFixture();
  const store = fixture.input.sidecarObservations.find((value) => value.kind === "aloha.store-epoch-observation")!;
  const { observationId: _observationId, payloadHash: _payloadHash, canonicalFactsHash: _canonicalFactsHash, ...storeDraft } = store;
  const changedStore = createStoreEpochObservation({
    ...storeDraft,
    canonicalFacts: { ...store.canonicalFacts, currentStoreEpoch: "12" },
  });
  const sidecars = fixture.input.sidecarObservations.map((value) => value.observationId === store.observationId ? changedStore : value);
  const snapshot = createQualifiedFactSnapshot({
    schemaVersion: 1,
    kind: "aloha.qualified-fact-snapshot",
    qualificationRegistryRoot: fixture.input.snapshot.qualificationRegistryRoot,
    orderedClaimIds: fixture.input.snapshot.orderedClaimIds,
    orderedObservationIds: sidecars.map((value) => value.observationId).concat(fixture.input.observations.map((value) => value.observationId)).sort(),
    orderedRawArtifactRefIds: fixture.input.snapshot.orderedRawArtifactRefIds,
  });
  const query = createAcceptanceQuery({
    schemaVersion: 1,
    kind: "aloha.acceptance-query",
    predicateSpecDigest: fixture.input.query.predicateSpecDigest,
    qualificationRegistryRoot: fixture.input.query.qualificationRegistryRoot,
    subjectArtifactRoot: fixture.input.query.subjectArtifactRoot,
    qualifiedFactSnapshotId: snapshot.snapshotId,
    processAnchorHash: fixture.input.query.processAnchorHash,
    correlationId: fixture.input.query.correlationId,
  });
  const mutated = { ...fixture.input, query, snapshot, sidecarObservations: sidecars } as GateCoreInputV1;
  const result = evaluateQualification(fixture.authority, mutated);
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some((reason) => reason.code === "store-epoch-mismatch"));
});
