import {
  assertDecimalString,
  assertExactKeys,
  assertPlainObject,
  CANONICAL_LIMITS,
  arraySchema,
  decodeCanonicalJson,
  deepFreeze,
  defineSchemaManifest,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  enumSchema,
  gitSha40Schema,
  hashDomain,
  hashSchema,
  sha256Hex,
  literalSchema,
  nullableSchema,
  objectSchema,
  readOwnEnumerableDataProperty,
  refineSchema,
  stringSchema,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { types as nodeTypes } from "node:util";
import {
  ACCEPTANCE_CERTIFICATE_SCHEMA_MANIFEST,
  acceptanceCertificateId,
  acceptanceCertificatePayloadHash,
  createAcceptanceCertificateV1,
  decodeAcceptanceCertificateV1,
  encodeAcceptanceCertificateV1,
  type AcceptanceCertificateDraftV1,
  type AcceptanceCertificateV1,
} from "../../../specs/acceptance-certificate/src/index.ts";
import {
  decodeProductionReceipt,
  decodeReadOnlyArtifactRef,
  decodeSemanticArtifact,
  hashProcessAnchor,
  recomputeProductionReceiptId,
  recomputeSemanticArtifactId,
  encodeProductionReceipt,
  encodeSemanticArtifact,
  CORE_SCHEMA_MANIFESTS,
  type ProcessAnchorV1,
  type ProductionReceiptV1,
  type ReadOnlyArtifactRefV1,
  type SemanticArtifactV1,
} from "../../../specs/core-envelope/src/index.ts";
import {
  decodeArtifactResolutionClaim,
  decodeArtifactBytes,
  decodeResolverPolicy,
  decodeRetentionLeaseReceipt,
  recomputeResolverPolicyHash,
  type ArtifactResolutionClaimV1,
  type ObservedImmutableMirrorV1,
  type ResolverPolicyV1,
  type RetentionLeaseReceiptV1,
} from "../../../specs/artifact-resolution/src/index.ts";
import {
  decodeObserverCertificate,
  decodePredicate,
  decodeQualificationRegistry,
  decodeVerifierCertificate,
  decodeObserverSigningKey,
  hashObserverSigningKeySetRoot,
  hashRevokedObserverKeyIdsRoot,
  hashObserverCertificatePayload,
  hashVerifierCertificatePayload,
  type CertificateMembershipMaterialV1,
  type ObserverQualificationCertificateV1,
  type ObserverRoleSpecV1,
  type PredicateSpecV1,
  type QualificationRegistrySnapshotV1,
  type ObserverSigningKeyV1,
  type VerifierQualificationCertificateV1,
} from "../../../specs/qualification/src/index.ts";
import {
  decodeAcceptanceQuery,
  decodeQualifiedFactSnapshot,
  decodeQualifiedObservation,
  decodeAcquisitionProcessObservation,
  decodeTargetProcessObservation,
  decodeStoreEpochObservation,
  decodeStoreEpochRawFacts,
  decodeSignedObserverInvocationSnapshot,
  observerInvocationSigningBytes,
  computeObserverSemanticConfigDigest,
  QUALIFIED_FACT_SCHEMA_MANIFESTS,
  type AcceptanceQueryV1,
  type AcquisitionProcessObservationEnvelopeV1,
  type QualifiedFactSnapshotV1,
  type QualifiedObservationEnvelopeV1,
  type QualifiedSidecarObservationV1,
  type StoreEpochObservationEnvelopeV1,
  type StoreEpochRawFactsV1,
  type SignedObserverInvocationSnapshotV1,
  type TargetProcessObservationEnvelopeV1,
} from "../../../specs/qualified-facts/src/index.ts";
import type {
  PredicateCompositionBindingV1,
  PredicateCompositionPortV1,
  PredicateEvaluatorV1,
} from "./predicate-composition.ts";
import {
  verifyExternalQualificationV2,
  type ExternalQualificationAuthorityPinV2,
  type ExternalQualificationEvidenceV2,
} from "../../../packages/external-qualification-verifier/src/index.ts";
import {
  GATE_REASON_CODES,
  type GateReasonCode,
  type GateVerdict,
} from "./predicate-contract.ts";

export type { Hash } from "../../../packages/canonical-codec/src/index.ts";
export type {
  AcceptanceQueryV1,
  AcquisitionProcessObservationEnvelopeV1,
  QualifiedFactSnapshotV1,
  QualifiedObservationEnvelopeV1,
  QualifiedSidecarObservationV1,
  StoreEpochObservationEnvelopeV1,
  TargetProcessObservationEnvelopeV1,
  SignedObserverInvocationSnapshotV1,
} from "../../../specs/qualified-facts/src/index.ts";
export type {
  ArtifactResolutionClaimV1,
  ResolverPolicyV1,
  RetentionLeaseReceiptV1,
} from "../../../specs/artifact-resolution/src/index.ts";
export type {
  ObserverQualificationCertificateV1,
  ObserverRoleSpecV1,
  PredicateSpecV1,
  QualificationRegistrySnapshotV1,
  VerifierQualificationCertificateV1,
  ObserverSigningKeyV1,
} from "../../../specs/qualification/src/index.ts";
export type {
  ProcessAnchorV1,
  ProductionReceiptV1,
  ReadOnlyArtifactRefV1,
  SemanticArtifactV1,
} from "../../../specs/core-envelope/src/index.ts";
export type { StoreEpochRawFactsV1 } from "../../../specs/qualified-facts/src/index.ts";
export type {
  ExternalQualificationAuthorityPinV2,
  ExternalQualificationEvidenceV2,
} from "../../../packages/external-qualification-verifier/src/index.ts";

/**
 * The reason catalog is intentionally closed.  A caller cannot smuggle a
 * producer-specific error string into an acceptance certificate.
 */
export { GATE_REASON_CODES } from "./predicate-contract.ts";
export type { GateReasonCode, GateVerdict } from "./predicate-contract.ts";

export interface GateReasonV1 {
  readonly code: GateReasonCode;
  readonly path: string;
}

/**
 * These are registry facts, rather than a `current: boolean` claim.  The
 * roots are recomputed from this exact material by GateCore.
 */
export interface RegistryMembershipFactsV1 {
  readonly trustedIssuerIds: readonly string[];
  readonly certificateMemberships: readonly CertificateMembershipMaterialV1[];
  readonly revokedCertificateIds: readonly Hash[];
  readonly observerSigningKeys: readonly ObserverSigningKeyV1[];
  readonly revokedObserverKeyIds: readonly Hash[];
}

export interface RegistryAuthorityPinV1 {
  readonly expectedRegistryRoot: Hash;
  /** Stable external trust-anchor identity, never a self-referential approval id. */
  readonly expectedGovernanceTrustAnchorHash: Hash;
  readonly expectedEpoch: string;
}

/**
 * Trusted release-boundary pins are deliberately outside the untrusted input
 * envelope. Descriptor digests identify the frozen predicate/oracle meaning;
 * closure digests identify the exact qualified programs.
 */
export interface GateCoreAuthorityPinV1 {
  readonly registry: RegistryAuthorityPinV1;
  readonly externalQualification: ExternalQualificationAuthorityPinV2;
  /** The typed, frozen predicate is authority; it is never selected by input. */
  readonly predicate: PredicateSpecV1;
  readonly predicateProgramDescriptorDigest: Hash;
  readonly oracleProgramDescriptorDigest: Hash;
  /** Exact selected predicate adapter leaf; adding an unrelated leaf does not change it. */
  readonly predicateCompositionLeafDigest: Hash;
  /** Release BOM root; it is separate from the selected predicate leaf. */
  readonly predicateCompositionRootDigest: Hash;
  readonly predicateImplementationClosureDigest: Hash;
  /** Exact exported predicate evaluator identity; distinct from its closure. */
  readonly predicateImplementationExportDigest: Hash;
  /** Exact qualification-only oracle compiler closure; never part of live execution. */
  readonly oracleImplementationClosureDigest: Hash;
  /** Exact exported oracle/reference implementation identity; distinct from its closure. */
  readonly oracleImplementationExportDigest: Hash;
  /** Generic GateCore closure only; it excludes predicate adapters and BOM composition. */
  readonly gateCoreImplementationClosureDigest: Hash;
  /** Exact release runtime closure from public wrapper through composition and adapters. */
  readonly gateCoreRuntimeClosureDigest: Hash;
  /** Exact verifier subject selected by release governance. */
  readonly verifierQualificationId: Hash;
  /** Predicate-owned invocation seal role selected by the generated release. */
  readonly signedInvocationRoleId: string;
  /** Maximum accepted signed-invocation lifetime in nanoseconds. */
  readonly maxInvocationTtlUnixNs: string;
  /** Release audience policy; signed invocations must carry this hash. */
  readonly expectedAudienceHash: Hash;
}

export interface GateCoreInputV1 {
  readonly query: AcceptanceQueryV1;
  readonly snapshot: QualifiedFactSnapshotV1;
  readonly registry: QualificationRegistrySnapshotV1;
  readonly registryFacts: RegistryMembershipFactsV1;
  /** Signed material is untrusted transport and is verified against the external pin. */
  readonly externalQualification: ExternalQualificationEvidenceV2;
  readonly verifierCertificate: VerifierQualificationCertificateV1;
  readonly observerCertificates: readonly ObserverQualificationCertificateV1[];
  readonly artifactRefs: readonly ReadOnlyArtifactRefV1[];
  readonly resolverPolicies: readonly ResolverPolicyV1[];
  readonly retentionLeases: readonly RetentionLeaseReceiptV1[];
  readonly artifactClaims: readonly ArtifactResolutionClaimV1[];
  readonly observations: readonly QualifiedObservationEnvelopeV1[];
  /** Independent content-addressed process/store observation sidecars. */
  readonly sidecarObservations: readonly QualifiedSidecarObservationV1[];
  /** Signed observer invocation is the sole source of artifact/receipt bindings. */
  readonly signedInvocationSnapshot: SignedObserverInvocationSnapshotV1;
  /** Exact predicate-owned fact bundles; the selected evaluator decodes them. */
  readonly predicateFacts: readonly unknown[];
}

export type { AcceptanceCertificateV1 } from "../../../specs/acceptance-certificate/src/index.ts";

export interface GateCoreResultV1 {
  readonly verdict: GateVerdict;
  readonly certificate: AcceptanceCertificateV1;
  readonly reasons: readonly GateReasonV1[];
}

function reasonSetRoot(reasons: readonly GateReasonV1[]): Hash {
  return hashDomain("aloha/acceptance-certificate/reason-set/v1", reasons);
}

export const GATE_CORE_SCHEMA_MANIFESTS = Object.freeze({
  acceptanceCertificate: ACCEPTANCE_CERTIFICATE_SCHEMA_MANIFEST,
});

function parseCodecInput(value: string | Uint8Array | object): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}

export function decodeAcceptanceCertificate(
  value: string | Uint8Array | object,
): AcceptanceCertificateV1 {
  return decodeAcceptanceCertificateV1(value);
}

export function encodeAcceptanceCertificate(value: AcceptanceCertificateV1): Uint8Array {
  return encodeAcceptanceCertificateV1(value);
}

export function recomputeAcceptanceCertificatePayloadHash(value: AcceptanceCertificateV1): Hash {
  return acceptanceCertificatePayloadHash(value);
}

export function recomputeAcceptanceCertificateId(value: AcceptanceCertificateV1): Hash {
  return acceptanceCertificateId(value);
}

export type AcceptanceCertificateDraft = AcceptanceCertificateDraftV1;

export function createAcceptanceCertificate(
  draft: AcceptanceCertificateDraft,
): AcceptanceCertificateV1 {
  return createAcceptanceCertificateV1(draft);
}

export function computeSubjectArtifactRoot(
  artifacts: readonly SemanticArtifactV1[],
): Hash {
  return hashDomain(
    "aloha/acceptance-query/subject-artifact-root/v1",
    artifacts.map((artifact) => artifact.artifactId),
  );
}

const ZERO_HASH = zeroHash();
const ZERO_GIT_SHA = "0".repeat(40);

function zeroHash(): Hash {
  return `0x${"0".repeat(64)}` as Hash;
}

/**
 * Digest signed by the external release approval.  The approval id is
 * deliberately excluded to avoid an approvalId <-> authorityPinDigest cycle.
 */
export function computeGateCoreAuthorityPinDigest(authority: GateCoreAuthorityPinV1): Hash {
  const {
    expectedReleaseAuthorityApprovalId: _releaseApprovalId,
    ...externalQualification
  } = authority.externalQualification;
  return hashDomain("aloha/gate-core-authority-pin/unsigned/v2", {
    ...authority,
    externalQualification,
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return encodeCanonicalJson(left) === encodeCanonicalJson(right);
  } catch {
    return false;
  }
}

function isHash(value: unknown): value is Hash {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
}

function strictSorted(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) return false;
  }
  return true;
}

function exactIds(actual: readonly Hash[], expected: readonly Hash[]): boolean {
  return sameJson(actual, expected);
}

function mapUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T> | null {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (result.has(id)) return null;
    result.set(id, value);
  }
  return result;
}

interface ArtifactClaimPreflightV1 {
  readonly artifactRefId: Hash;
  readonly resolverPolicyHash: Hash;
  readonly observedWireByteLength: bigint | null;
  readonly declaredByteLength: bigint | null;
}

function preflightArtifactResolutionClaim(
  value: unknown,
  path: string,
  mirrorBudget?: { totalBytes: bigint },
): ArtifactClaimPreflightV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["claimId", "artifactRefId", "resolverPolicyHash", "observedMirror", "outcome"], path);
  const claimId = readOwnEnumerableDataProperty(value, "claimId", path);
  const artifactRefId = readOwnEnumerableDataProperty(value, "artifactRefId", path);
  const resolverPolicyHash = readOwnEnumerableDataProperty(value, "resolverPolicyHash", path);
  const outcome = readOwnEnumerableDataProperty(value, "outcome", path);
  const observedMirror = readOwnEnumerableDataProperty(value, "observedMirror", path);
  if (!isHash(claimId) || !isHash(artifactRefId) || !isHash(resolverPolicyHash)) {
    throw new TypeError(`artifact claim hash invalid at ${path}`);
  }
  if (outcome !== "content-observed" && outcome !== "missing" && outcome !== "content-mismatch") {
    throw new TypeError(`artifact claim outcome invalid at ${path}.outcome`);
  }
  if (observedMirror === null) {
    if (outcome === "content-observed") throw new TypeError(`content-observed claim requires mirror at ${path}`);
    return { artifactRefId, resolverPolicyHash, observedWireByteLength: null, declaredByteLength: null };
  }
  if (outcome === "missing") throw new TypeError(`missing claim cannot carry mirror at ${path}`);
  const mirrorPath = `${path}.observedMirror`;
  assertPlainObject(observedMirror, mirrorPath);
  assertExactKeys(observedMirror, ["storeIdentityHash", "objectKey", "bytes", "contentSha256", "byteLength", "mediaType", "schema"], mirrorPath);
  const bytes = readOwnEnumerableDataProperty(observedMirror, "bytes", mirrorPath);
  const declaredByteLength = readOwnEnumerableDataProperty(observedMirror, "byteLength", mirrorPath);
  if (typeof bytes !== "string" || !bytes.startsWith("0x") || bytes.length % 2 !== 0) {
    throw new TypeError(`artifact bytes wire envelope invalid at ${mirrorPath}.bytes`);
  }
  const observedWireByteLength = BigInt((bytes.length - 2) / 2);
  const maximumMirrorBytes = BigInt(CANONICAL_LIMITS.maxBytes);
  if (observedWireByteLength > maximumMirrorBytes) {
    throw new TypeError(`artifact mirror exceeds canonical byte bound before decode at ${mirrorPath}.bytes`);
  }
  const decodedDeclaredByteLength = assertDecimalString(declaredByteLength, `${mirrorPath}.byteLength`);
  const declaredMirrorByteLength = BigInt(decodedDeclaredByteLength);
  if (declaredMirrorByteLength > maximumMirrorBytes) {
    throw new TypeError(`artifact mirror exceeds canonical byte bound before decode at ${mirrorPath}.byteLength`);
  }
  if (mirrorBudget !== undefined) {
    mirrorBudget.totalBytes += observedWireByteLength;
    if (mirrorBudget.totalBytes > maximumMirrorBytes) {
      throw new TypeError(`input mirror byte budget exceeded before decode at ${mirrorPath}.bytes`);
    }
  }
  return {
    artifactRefId,
    resolverPolicyHash,
    observedWireByteLength,
    declaredByteLength: declaredMirrorByteLength,
  };
}

interface IssueSink {
  readonly issues: GateReasonV1[];
  add(code: GateReasonCode, path: string): void;
}

function issueSink(): IssueSink {
  const issues: GateReasonV1[] = [];
  return {
    issues,
    add(code, path) {
      if (!issues.some((item) => item.code === code && item.path === path)) {
        issues.push(Object.freeze({ code, path }));
      }
    },
  };
}

function sortedReasons(issues: readonly GateReasonV1[]): readonly GateReasonV1[] {
  return Object.freeze(
    [...issues].sort((left, right) => {
      const a = `${left.code}\u0000${left.path}`;
      const b = `${right.code}\u0000${right.path}`;
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  );
}

function enforceEvaluatorVerdictContract(
  programVerdict: GateVerdict,
  reasons: readonly GateReasonV1[],
): GateVerdict {
  const hasPredicateFailure = reasons.some((reason) => reason.code === "predicate-failed");
  const hasOtherReason = reasons.some((reason) => reason.code !== "predicate-failed");
  if (hasOtherReason) return "invalid";
  if (programVerdict === "fail") return hasPredicateFailure ? "fail" : "invalid";
  if (programVerdict === "pass") return reasons.length === 0 ? "pass" : "invalid";
  return "invalid";
}

function safeDecode<T>(
  decode: () => T,
  issues: IssueSink,
  code: GateReasonCode,
  path: string,
): T | null {
  try {
    return decode();
  } catch {
    issues.add(code, path);
    return null;
  }
}

function decodeRegistryMembershipFacts(value: unknown, path: string): RegistryMembershipFactsV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["trustedIssuerIds", "certificateMemberships", "revokedCertificateIds", "observerSigningKeys", "revokedObserverKeyIds"], path);
  const trustedIssuerIds = readOwnEnumerableDataProperty(value, "trustedIssuerIds", path);
  const certificateMemberships = readOwnEnumerableDataProperty(value, "certificateMemberships", path);
  const revokedCertificateIds = readOwnEnumerableDataProperty(value, "revokedCertificateIds", path);
  const observerSigningKeys = readOwnEnumerableDataProperty(value, "observerSigningKeys", path);
  const revokedObserverKeyIds = readOwnEnumerableDataProperty(value, "revokedObserverKeyIds", path);
  if (!Array.isArray(trustedIssuerIds) || !trustedIssuerIds.every((entry) => typeof entry === "string" && entry.length > 0)) throw new TypeError(`trustedIssuerIds invalid at ${path}`);
  if (!Array.isArray(revokedCertificateIds) || !revokedCertificateIds.every(isHash)) throw new TypeError(`revokedCertificateIds invalid at ${path}`);
  if (!Array.isArray(revokedObserverKeyIds) || !revokedObserverKeyIds.every(isHash)) throw new TypeError(`revokedObserverKeyIds invalid at ${path}`);
  if (!Array.isArray(observerSigningKeys)) throw new TypeError(`observerSigningKeys invalid at ${path}`);
  if (!Array.isArray(certificateMemberships)) throw new TypeError(`certificateMemberships invalid at ${path}`);
  const memberships: CertificateMembershipMaterialV1[] = certificateMemberships.map((entry, index) => {
    assertPlainObject(entry, `${path}.certificateMemberships[${index}]`);
    assertExactKeys(entry, ["certificateKind", "certificateId", "certificatePayloadHash", "issuerId"], `${path}.certificateMemberships[${index}]`);
    const certificateKind = readOwnEnumerableDataProperty(entry, "certificateKind", `${path}.certificateMemberships[${index}]`);
    const certificateId = readOwnEnumerableDataProperty(entry, "certificateId", `${path}.certificateMemberships[${index}]`);
    const certificatePayloadHash = readOwnEnumerableDataProperty(entry, "certificatePayloadHash", `${path}.certificateMemberships[${index}]`);
    const issuerId = readOwnEnumerableDataProperty(entry, "issuerId", `${path}.certificateMemberships[${index}]`);
    if (certificateKind !== "observer" && certificateKind !== "verifier") throw new TypeError(`certificateKind invalid at ${path}.certificateMemberships[${index}]`);
    if (!isHash(certificateId) || !isHash(certificatePayloadHash) || typeof issuerId !== "string" || issuerId.length === 0) throw new TypeError(`certificate membership invalid at ${path}.certificateMemberships[${index}]`);
    return { certificateKind, certificateId, certificatePayloadHash, issuerId };
  });
  const keys: ObserverSigningKeyV1[] = observerSigningKeys.map((entry, index) => decodeObserverSigningKey(entry as object));
  const keyIds = keys.map((key) => key.keyId);
  if (!strictSorted(keyIds) || new Set(keyIds).size !== keyIds.length) throw new TypeError(`observerSigningKeys must be sorted and unique at ${path}`);
  if (!strictSorted(revokedObserverKeyIds as string[]) || new Set(revokedObserverKeyIds).size !== revokedObserverKeyIds.length) throw new TypeError(`revokedObserverKeyIds must be sorted and unique at ${path}`);
  return { trustedIssuerIds, certificateMemberships: memberships, revokedCertificateIds, observerSigningKeys: keys, revokedObserverKeyIds };
}

function decodeSidecarObservation(value: unknown, path: string): QualifiedSidecarObservationV1 {
  assertPlainObject(value, path);
  const kind = readOwnEnumerableDataProperty(value, "kind", path);
  if (kind === "aloha.acquisition-process-observation") return decodeAcquisitionProcessObservation(value as object);
  if (kind === "aloha.target-process-observation") return decodeTargetProcessObservation(value as object);
  if (kind === "aloha.store-epoch-observation") return decodeStoreEpochObservation(value as object);
  throw new TypeError(`unknown sidecar observation kind at ${path}.kind`);
}

function decodeRegistryAuthorityPin(value: unknown, path: string): RegistryAuthorityPinV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["expectedRegistryRoot", "expectedGovernanceTrustAnchorHash", "expectedEpoch"], path);
  const expectedRegistryRoot = readOwnEnumerableDataProperty(value, "expectedRegistryRoot", path);
  const expectedGovernanceTrustAnchorHash = readOwnEnumerableDataProperty(value, "expectedGovernanceTrustAnchorHash", path);
  const expectedEpoch = readOwnEnumerableDataProperty(value, "expectedEpoch", path);
  if (!isHash(expectedRegistryRoot) || !isHash(expectedGovernanceTrustAnchorHash)) throw new TypeError(`registry authority pin hashes invalid at ${path}`);
  return { expectedRegistryRoot, expectedGovernanceTrustAnchorHash, expectedEpoch: assertDecimalString(expectedEpoch, `${path}.expectedEpoch`) };
}

function decodeExternalQualificationAuthorityPin(
  value: unknown,
  path: string,
): ExternalQualificationAuthorityPinV2 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "expectedTrustAnchorRoot",
    "expectedIssuerKeySetRoot",
    "expectedRegistryApprovalId",
    "expectedReleaseAuthorityApprovalId",
    "expectedQualificationAudienceHash",
    "expectedReleaseRoleManifestRoot",
    "expectedCandidateReleaseCommit",
  ], path);
  const expectedTrustAnchorRoot = readOwnEnumerableDataProperty(value, "expectedTrustAnchorRoot", path);
  const expectedIssuerKeySetRoot = readOwnEnumerableDataProperty(value, "expectedIssuerKeySetRoot", path);
  const expectedRegistryApprovalId = readOwnEnumerableDataProperty(value, "expectedRegistryApprovalId", path);
  const expectedReleaseAuthorityApprovalId = readOwnEnumerableDataProperty(value, "expectedReleaseAuthorityApprovalId", path);
  const expectedQualificationAudienceHash = readOwnEnumerableDataProperty(value, "expectedQualificationAudienceHash", path);
  const expectedReleaseRoleManifestRoot = readOwnEnumerableDataProperty(value, "expectedReleaseRoleManifestRoot", path);
  const expectedCandidateReleaseCommit = gitSha40Schema.decode(
    readOwnEnumerableDataProperty(value, "expectedCandidateReleaseCommit", path),
    `${path}.expectedCandidateReleaseCommit`,
  );
  if (expectedCandidateReleaseCommit === ZERO_GIT_SHA) {
    throw new TypeError(`external qualification candidate release commit cannot be zero at ${path}`);
  }
  if (
    !isHash(expectedTrustAnchorRoot) ||
    !isHash(expectedIssuerKeySetRoot) ||
    !isHash(expectedRegistryApprovalId) ||
    !isHash(expectedReleaseAuthorityApprovalId) ||
    !isHash(expectedQualificationAudienceHash) ||
    !isHash(expectedReleaseRoleManifestRoot) ||
    [
      expectedTrustAnchorRoot,
      expectedIssuerKeySetRoot,
      expectedRegistryApprovalId,
      expectedReleaseAuthorityApprovalId,
      expectedQualificationAudienceHash,
      expectedReleaseRoleManifestRoot,
    ].includes(ZERO_HASH)
  ) {
    throw new TypeError(`external qualification authority pin invalid at ${path}`);
  }
  return {
    expectedTrustAnchorRoot,
    expectedIssuerKeySetRoot,
    expectedRegistryApprovalId,
    expectedReleaseAuthorityApprovalId,
    expectedQualificationAudienceHash,
    expectedReleaseRoleManifestRoot,
    expectedCandidateReleaseCommit,
  };
}

function decodeGateCoreAuthorityPin(value: unknown, path: string): GateCoreAuthorityPinV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["registry", "externalQualification", "predicate", "predicateProgramDescriptorDigest", "oracleProgramDescriptorDigest", "predicateCompositionLeafDigest", "predicateCompositionRootDigest", "predicateImplementationClosureDigest", "predicateImplementationExportDigest", "oracleImplementationClosureDigest", "oracleImplementationExportDigest", "gateCoreImplementationClosureDigest", "gateCoreRuntimeClosureDigest", "verifierQualificationId", "signedInvocationRoleId", "maxInvocationTtlUnixNs", "expectedAudienceHash"], path);
  const registry = decodeRegistryAuthorityPin(readOwnEnumerableDataProperty(value, "registry", path), `${path}.registry`);
  const externalQualification = decodeExternalQualificationAuthorityPin(readOwnEnumerableDataProperty(value, "externalQualification", path), `${path}.externalQualification`);
  const predicate = decodePredicate(readOwnEnumerableDataProperty(value, "predicate", path) as object);
  const predicateProgramDescriptorDigest = readOwnEnumerableDataProperty(value, "predicateProgramDescriptorDigest", path);
  const oracleProgramDescriptorDigest = readOwnEnumerableDataProperty(value, "oracleProgramDescriptorDigest", path);
  const predicateCompositionLeafDigest = readOwnEnumerableDataProperty(value, "predicateCompositionLeafDigest", path);
  const predicateCompositionRootDigest = readOwnEnumerableDataProperty(value, "predicateCompositionRootDigest", path);
  const predicateImplementationClosureDigest = readOwnEnumerableDataProperty(value, "predicateImplementationClosureDigest", path);
  const predicateImplementationExportDigest = readOwnEnumerableDataProperty(value, "predicateImplementationExportDigest", path);
  const oracleImplementationClosureDigest = readOwnEnumerableDataProperty(value, "oracleImplementationClosureDigest", path);
  const oracleImplementationExportDigest = readOwnEnumerableDataProperty(value, "oracleImplementationExportDigest", path);
  const gateCoreImplementationClosureDigest = readOwnEnumerableDataProperty(value, "gateCoreImplementationClosureDigest", path);
  const gateCoreRuntimeClosureDigest = readOwnEnumerableDataProperty(value, "gateCoreRuntimeClosureDigest", path);
  const verifierQualificationId = readOwnEnumerableDataProperty(value, "verifierQualificationId", path);
  const signedInvocationRoleId = readOwnEnumerableDataProperty(value, "signedInvocationRoleId", path);
  const maxInvocationTtlUnixNs = readOwnEnumerableDataProperty(value, "maxInvocationTtlUnixNs", path);
  const expectedAudienceHash = readOwnEnumerableDataProperty(value, "expectedAudienceHash", path);
  if (!isHash(predicateProgramDescriptorDigest) || !isHash(oracleProgramDescriptorDigest) || !isHash(predicateCompositionLeafDigest) || !isHash(predicateCompositionRootDigest) || !isHash(predicateImplementationClosureDigest) || !isHash(predicateImplementationExportDigest) || !isHash(oracleImplementationClosureDigest) || !isHash(oracleImplementationExportDigest) || !isHash(gateCoreImplementationClosureDigest) || !isHash(gateCoreRuntimeClosureDigest) || !isHash(verifierQualificationId) || !isHash(expectedAudienceHash)) throw new TypeError(`authority digest invalid at ${path}`);
  if (typeof signedInvocationRoleId !== "string" || signedInvocationRoleId.length === 0) throw new TypeError(`authority signedInvocationRoleId invalid at ${path}`);
  if (typeof maxInvocationTtlUnixNs !== "string") throw new TypeError(`authority maxInvocationTtlUnixNs invalid at ${path}`);
  assertDecimalString(maxInvocationTtlUnixNs, `${path}.maxInvocationTtlUnixNs`);
  if (BigInt(maxInvocationTtlUnixNs) <= 0n) throw new TypeError(`authority maxInvocationTtlUnixNs must be positive at ${path}`);
  if (expectedAudienceHash === ZERO_HASH) throw new TypeError(`authority expectedAudienceHash cannot be zero at ${path}`);
  if (predicateImplementationClosureDigest === ZERO_HASH || predicateImplementationExportDigest === ZERO_HASH || oracleImplementationClosureDigest === ZERO_HASH || oracleImplementationExportDigest === ZERO_HASH || gateCoreImplementationClosureDigest === ZERO_HASH || gateCoreRuntimeClosureDigest === ZERO_HASH) throw new TypeError(`authority implementation digest cannot be zero at ${path}`);
  return { registry, externalQualification, predicate, predicateProgramDescriptorDigest, oracleProgramDescriptorDigest, predicateCompositionLeafDigest, predicateCompositionRootDigest, predicateImplementationClosureDigest, predicateImplementationExportDigest, oracleImplementationClosureDigest, oracleImplementationExportDigest, gateCoreImplementationClosureDigest, gateCoreRuntimeClosureDigest, verifierQualificationId, signedInvocationRoleId, maxInvocationTtlUnixNs, expectedAudienceHash };
}

const GATE_CORE_INPUT_KEYS = [
  "query",
  "snapshot",
  "registry",
  "registryFacts",
  "externalQualification",
  "verifierCertificate",
  "observerCertificates",
  "artifactRefs",
  "resolverPolicies",
  "retentionLeases",
  "artifactClaims",
  "observations",
  "sidecarObservations",
  "signedInvocationSnapshot",
  "predicateFacts",
] as const;

function decodeExternalQualificationEvidenceEnvelope(
  value: unknown,
  path: string,
): ExternalQualificationEvidenceV2 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "trustAnchor",
    "issuerKeys",
    "registryApproval",
    "signedVerifierCertificate",
    "signedObserverCertificates",
    "releaseAuthorityApproval",
  ], path);
  return {
    trustAnchor: readOwnEnumerableDataProperty(value, "trustAnchor", path) as ExternalQualificationEvidenceV2["trustAnchor"],
    issuerKeys: copyExactInputArray(
      readOwnEnumerableDataProperty(value, "issuerKeys", path),
      `${path}.issuerKeys`,
    ) as readonly ExternalQualificationEvidenceV2["issuerKeys"][number][],
    registryApproval: readOwnEnumerableDataProperty(value, "registryApproval", path) as ExternalQualificationEvidenceV2["registryApproval"],
    signedVerifierCertificate: readOwnEnumerableDataProperty(value, "signedVerifierCertificate", path) as ExternalQualificationEvidenceV2["signedVerifierCertificate"],
    signedObserverCertificates: copyExactInputArray(
      readOwnEnumerableDataProperty(value, "signedObserverCertificates", path),
      `${path}.signedObserverCertificates`,
    ) as readonly ExternalQualificationEvidenceV2["signedObserverCertificates"][number][],
    releaseAuthorityApproval: readOwnEnumerableDataProperty(value, "releaseAuthorityApproval", path) as ExternalQualificationEvidenceV2["releaseAuthorityApproval"],
  };
}

function copyExactInputArray(value: unknown, path: string): readonly unknown[] {
  // util.types.isProxy is a non-trapping brand check. Reject before any
  // reflection so hostile array traps cannot run during the exactness check.
  if (value !== null && typeof value === "object" && nodeTypes.isProxy(value)) throw new TypeError(`${path} must not be a Proxy`);
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > CANONICAL_LIMITS.maxArrayItems
  ) {
    throw new TypeError(`${path} array length invalid`);
  }
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || ownKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
    throw new TypeError(`${path} must be a dense exact array`);
  }
  const copied: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${path}[${index}] must be an enumerable data property`);
    }
    copied.push(descriptor.value);
  }
  return Object.freeze(copied);
}

/**
 * Nested arrays are still untrusted input. Walk only data properties here so
 * accessors are never invoked, and apply the same dense/max-length contract
 * used by the top-level envelope arrays before any schema decoder runs.
 */
function preflightNestedInputArrays(value: unknown, path: string, seen: WeakSet<object> = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (nodeTypes.isProxy(value)) throw new TypeError(`${path} must not be a Proxy`);
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > CANONICAL_LIMITS.maxArrayItems
    ) {
      throw new TypeError(`${path} array length invalid`);
    }
    const length = lengthDescriptor.value;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1 || ownKeys.some((key) => key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
      throw new TypeError(`${path} must be a dense exact array`);
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`${path}[${index}] must be an enumerable data property`);
      }
      preflightNestedInputArrays(descriptor.value, `${path}[${index}]`, seen);
    }
    return;
  }
  // A nested object accessor is left for the exact schema decoder, which also
  // reads descriptors without invoking it. We only need to descend through
  // safe data properties to find arrays below it.
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) continue;
    preflightNestedInputArrays(descriptor.value, `${path}.${key}`, seen);
  }
}

function preflightInputMirrorBudget(input: GateCoreInputV1, issues: IssueSink): boolean {
  const mirrorBudget = { totalBytes: 0n };
  let valid = true;
  for (const [index, value] of input.artifactClaims.entries()) {
    try {
      preflightArtifactResolutionClaim(value, `$.artifactClaims[${index}]`, mirrorBudget);
    } catch {
      issues.add("artifact-claim-mismatch", `$.artifactClaims[${index}]`);
      valid = false;
    }
  }
  return valid;
}

/**
 * GateCore has one wire shape for untrusted input.  In particular, it does
 * not accept a second predicate/facts shape, a producer verdict, or an
 * opaque map from which authority could be reconstructed.  Exact top-level
 * decoding happens before any field is interpreted.
 */
function decodeGateCoreInput(value: unknown, path: string): GateCoreInputV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, GATE_CORE_INPUT_KEYS, path);
  preflightNestedInputArrays(value, path);
  const readArray = (key: string): readonly unknown[] => {
    const candidate = readOwnEnumerableDataProperty(value, key, path);
    return copyExactInputArray(candidate, `${path}.${key}`);
  };
  return {
    query: readOwnEnumerableDataProperty(value, "query", path) as AcceptanceQueryV1,
    snapshot: readOwnEnumerableDataProperty(value, "snapshot", path) as QualifiedFactSnapshotV1,
    registry: readOwnEnumerableDataProperty(value, "registry", path) as QualificationRegistrySnapshotV1,
    registryFacts: readOwnEnumerableDataProperty(value, "registryFacts", path) as RegistryMembershipFactsV1,
    externalQualification: decodeExternalQualificationEvidenceEnvelope(
      readOwnEnumerableDataProperty(value, "externalQualification", path),
      `${path}.externalQualification`,
    ),
    verifierCertificate: readOwnEnumerableDataProperty(value, "verifierCertificate", path) as VerifierQualificationCertificateV1,
    observerCertificates: readArray("observerCertificates") as readonly ObserverQualificationCertificateV1[],
    artifactRefs: readArray("artifactRefs") as readonly ReadOnlyArtifactRefV1[],
    resolverPolicies: readArray("resolverPolicies") as readonly ResolverPolicyV1[],
    retentionLeases: readArray("retentionLeases") as readonly RetentionLeaseReceiptV1[],
    artifactClaims: readArray("artifactClaims") as readonly ArtifactResolutionClaimV1[],
    observations: readArray("observations") as readonly QualifiedObservationEnvelopeV1[],
    sidecarObservations: readArray("sidecarObservations") as readonly QualifiedSidecarObservationV1[],
    signedInvocationSnapshot: readOwnEnumerableDataProperty(value, "signedInvocationSnapshot", path) as SignedObserverInvocationSnapshotV1,
    predicateFacts: readArray("predicateFacts"),
  };
}

function trustedIssuerFacts(
  registry: QualificationRegistrySnapshotV1,
  facts: RegistryMembershipFactsV1,
  issues: IssueSink,
): boolean {
  let valid = true;
  if (!strictSorted(facts.trustedIssuerIds)) {
    issues.add("registry-material-mismatch", "$.registryFacts.trustedIssuerIds");
    valid = false;
  }
  if (!strictSorted(facts.revokedCertificateIds)) {
    issues.add("registry-material-mismatch", "$.registryFacts.revokedCertificateIds");
    valid = false;
  }
  const keyIds = facts.observerSigningKeys.map((key) => key.keyId);
  if (!strictSorted(keyIds) || new Set(keyIds).size !== keyIds.length) {
    issues.add("registry-material-mismatch", "$.registryFacts.observerSigningKeys");
    valid = false;
  }
  if (!strictSorted(facts.revokedObserverKeyIds) || new Set(facts.revokedObserverKeyIds).size !== facts.revokedObserverKeyIds.length) {
    issues.add("registry-material-mismatch", "$.registryFacts.revokedObserverKeyIds");
    valid = false;
  }
  const membershipIds = facts.certificateMemberships.map((entry) => entry.certificateId);
  if (!strictSorted(membershipIds)) {
    issues.add("registry-material-mismatch", "$.registryFacts.certificateMemberships");
    valid = false;
  }
  if (new Set(membershipIds).size !== membershipIds.length) {
    issues.add("registry-material-mismatch", "$.registryFacts.certificateMemberships");
    valid = false;
  }
  if (hashDomain("aloha/trusted-issuer-set/v1", facts.trustedIssuerIds) !== registry.trustedIssuerSetRoot) {
    issues.add("registry-material-mismatch", "$.registryFacts.trustedIssuerIds");
    valid = false;
  }
  if (hashDomain("aloha/certificate-set/v1", facts.certificateMemberships) !== registry.certificateSetRoot) {
    issues.add("registry-material-mismatch", "$.registryFacts.certificateMemberships");
    valid = false;
  }
  if (hashDomain("aloha/revoked-certificate-set/v1", facts.revokedCertificateIds) !== registry.revokedCertificateIdsRoot) {
    issues.add("registry-material-mismatch", "$.registryFacts.revokedCertificateIds");
    valid = false;
  }
  if (hashObserverSigningKeySetRoot(keyIds) !== registry.observerKeySetRoot) {
    issues.add("registry-material-mismatch", "$.registryFacts.observerSigningKeys");
    valid = false;
  }
  if (hashRevokedObserverKeyIdsRoot(facts.revokedObserverKeyIds) !== registry.revokedObserverKeyIdsRoot) {
    issues.add("registry-material-mismatch", "$.registryFacts.revokedObserverKeyIds");
    valid = false;
  }
  return valid;
}

function currentMembership(
  kind: "observer" | "verifier" | null,
  certificateId: Hash,
  payloadHash: Hash | null,
  issuerId: string,
  registry: QualificationRegistrySnapshotV1,
  facts: RegistryMembershipFactsV1,
  issues: IssueSink,
  path: string,
): boolean {
  const material = facts.certificateMemberships.find(
    (entry) =>
      entry.certificateId === certificateId &&
      (kind === null || entry.certificateKind === kind),
  );
  let valid = true;
  if (material === undefined) {
    issues.add("qualification-membership-missing", path);
    valid = false;
  } else {
    if ((payloadHash !== null && material.certificatePayloadHash !== payloadHash) || material.issuerId !== issuerId) {
      issues.add("qualification-membership-missing", path);
      valid = false;
    }
  }
  if (!facts.trustedIssuerIds.includes(issuerId)) {
    issues.add("issuer-untrusted", path);
    valid = false;
  }
  if (facts.revokedCertificateIds.includes(certificateId)) {
    issues.add("qualification-revoked", path);
    valid = false;
  }
  if (registry.registryId === ZERO_HASH) {
    issues.add("registry-mismatch", path);
    valid = false;
  }
  return valid;
}

function validateArtifacts(
  input: GateCoreInputV1,
  registry: QualificationRegistrySnapshotV1,
  store: StoreEpochObservationEnvelopeV1["canonicalFacts"],
  issues: IssueSink,
): {
  refs: ReadOnlyArtifactRefV1[];
  claims: ArtifactResolutionClaimV1[];
  policies: ResolverPolicyV1[];
  leases: RetentionLeaseReceiptV1[];
} {
  const refs: ReadOnlyArtifactRefV1[] = [];
  const claims: ArtifactResolutionClaimV1[] = [];
  const parsedRefs = new Map<string, ReadOnlyArtifactRefV1>();
  for (const [index, value] of input.artifactRefs.entries()) {
    const parsed = safeDecode(() => decodeReadOnlyArtifactRef(value), issues, "artifact-ref-mismatch", `$.artifactRefs[${index}]`);
    if (parsed === null) continue;
    if (parsedRefs.has(parsed.artifactRefId)) {
      issues.add("artifact-ref-mismatch", `$.artifactRefs[${index}]`);
    } else {
      parsedRefs.set(parsed.artifactRefId, parsed);
    }
  }
  const parsedPolicies = new Map<string, ResolverPolicyV1>();
  for (const [index, value] of input.resolverPolicies.entries()) {
    const parsed = safeDecode(() => decodeResolverPolicy(value), issues, "resolver-policy-mismatch", `$.resolverPolicies[${index}]`);
    if (parsed === null) continue;
    if (parsedPolicies.has(parsed.policyHash)) {
      issues.add("resolver-policy-mismatch", `$.resolverPolicies[${index}]`);
    } else {
      parsedPolicies.set(parsed.policyHash, parsed);
    }
  }
  const parsedLeases = new Map<string, RetentionLeaseReceiptV1>();
  for (const [index, value] of input.retentionLeases.entries()) {
    const parsed = safeDecode(() => decodeRetentionLeaseReceipt(value), issues, "retention-lease-mismatch", `$.retentionLeases[${index}]`);
    if (parsed === null) continue;
    if (parsedLeases.has(parsed.receiptId)) {
      issues.add("retention-lease-mismatch", `$.retentionLeases[${index}]`);
    } else {
      parsedLeases.set(parsed.receiptId, parsed);
    }
  }
  const parsedClaimsById = new Map<string, ArtifactResolutionClaimV1>();
  const parsedClaimsByRef = new Map<string, ArtifactResolutionClaimV1>();
  for (const [index, value] of input.artifactClaims.entries()) {
    const path = `$.artifactClaims[${index}]`;
    const preflight = safeDecode(() => preflightArtifactResolutionClaim(value, path), issues, "artifact-claim-mismatch", path);
    if (preflight === null) continue;
    const ref = parsedRefs.get(preflight.artifactRefId);
    const policy = ref === undefined ? undefined : parsedPolicies.get(ref.resolverPolicyHash);
    if (ref === undefined || policy === undefined || preflight.resolverPolicyHash !== ref.resolverPolicyHash) {
      issues.add(policy === undefined ? "resolver-policy-missing" : "resolver-policy-mismatch", path);
      continue;
    }
    if (
      preflight.observedWireByteLength !== null &&
      (preflight.declaredByteLength !== preflight.observedWireByteLength || preflight.observedWireByteLength > BigInt(policy.maxByteLength))
    ) {
      issues.add("resolver-policy-mismatch", `${path}.observedMirror.byteLength`);
      continue;
    }
    const parsed = safeDecode(() => decodeArtifactResolutionClaim(value), issues, "artifact-claim-mismatch", path);
    if (parsed === null) continue;
    if (parsedClaimsById.has(parsed.claimId) || parsedClaimsByRef.has(parsed.artifactRefId)) {
      issues.add("artifact-claim-mismatch", path);
    } else {
      parsedClaimsById.set(parsed.claimId, parsed);
      parsedClaimsByRef.set(parsed.artifactRefId, parsed);
    }
  }
  let currentEpoch: bigint;
  try {
    currentEpoch = BigInt(store.currentStoreEpoch);
  } catch {
    issues.add("store-epoch-mismatch", "$.sidecarObservations.store.canonicalFacts.currentStoreEpoch");
    currentEpoch = 0n;
  }
  for (const [index, ref] of parsedRefs.entries()) {
    refs.push(ref);
    const claim = parsedClaimsByRef.get(ref.artifactRefId);
    if (claim === undefined) {
      issues.add("artifact-claim-missing", `$.artifactRefs.${index}`);
      continue;
    }
    claims.push(claim);
    const policy = parsedPolicies.get(ref.resolverPolicyHash);
    if (policy === undefined) {
      issues.add("resolver-policy-missing", `$.artifactRefs.${index}`);
    } else {
      if (recomputeResolverPolicyHash(policy) !== ref.resolverPolicyHash || policy.allowedLocatorKind !== "content-object" || policy.digestAlgorithm !== "sha256") issues.add("resolver-policy-mismatch", `$.artifactRefs.${index}`);
    }
    if (claim.resolverPolicyHash !== ref.resolverPolicyHash || claim.outcome !== "content-observed" || claim.observedMirror === null) {
      issues.add("artifact-claim-mismatch", `$.artifactRefs.${index}`);
      continue;
    }
    const decodedMirror: ObservedImmutableMirrorV1 = claim.observedMirror;
    // The mirror's bytes/hash/length and declared content binding are exact
    // facts. A typed predicate may add semantic checks, but it cannot repair a
    // mirror that is not the content-addressed object named by the ref.
    if (decodedMirror.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash || decodedMirror.objectKey !== ref.immutableMirrorLocator.objectKey || decodedMirror.contentSha256 !== ref.contentSha256 || decodedMirror.byteLength !== ref.byteLength || decodedMirror.mediaType !== ref.mediaType || !sameJson(decodedMirror.schema, ref.schema)) {
      issues.add("artifact-content-mismatch", `$.artifactRefs.${index}`);
    }
    if (decodedMirror.storeIdentityHash !== store.storeIdentityHash) issues.add("store-epoch-mismatch", `$.artifactRefs.${index}.storeIdentityHash`);
    const lease = parsedLeases.get(ref.retentionLeaseReceiptId);
    if (lease === undefined) {
      issues.add("retention-lease-missing", `$.artifactRefs.${index}`);
      continue;
    }
    if (lease.storeIdentityHash !== ref.immutableMirrorLocator.storeIdentityHash || lease.objectKey !== ref.immutableMirrorLocator.objectKey || lease.contentSha256 !== ref.contentSha256 || lease.qualificationRegistryRoot !== registry.registryId) {
      issues.add("retention-lease-mismatch", `$.artifactRefs.${index}`);
    }
    try {
      const from = BigInt(lease.validFromStoreEpoch);
      const through = BigInt(lease.validThroughStoreEpoch);
      if (currentEpoch < from || currentEpoch > through) issues.add("lease-expired", `$.artifactRefs.${index}`);
      if (through - currentEpoch < BigInt(policy?.minimumRemainingStoreEpochs ?? "0")) issues.add("lease-insufficient", `$.artifactRefs.${index}`);
    } catch {
      issues.add("lease-invalid", `$.artifactRefs.${index}`);
    }
    if (!currentMembership(null, lease.issuerQualificationId, null, lease.issuerId, registry, input.registryFacts, issues, `$.artifactRefs.${index}.lease.issuer`)) {
      issues.add("retention-lease-mismatch", `$.artifactRefs.${index}.lease.issuer`);
    }
  }
  for (const claim of parsedClaimsById.values()) {
    if (!parsedRefs.has(claim.artifactRefId)) issues.add("artifact-claim-mismatch", `$.artifactClaims.${claim.claimId}`);
  }
  for (const policy of parsedPolicies.values()) {
    if (![...parsedRefs.values()].some((ref) => ref.resolverPolicyHash === policy.policyHash)) issues.add("resolver-policy-mismatch", `$.resolverPolicies.${policy.policyHash}`);
  }
  for (const lease of parsedLeases.values()) {
    if (![...parsedRefs.values()].some((ref) => ref.retentionLeaseReceiptId === lease.receiptId)) issues.add("retention-lease-mismatch", `$.retentionLeases.${lease.receiptId}`);
  }
  if (parsedRefs.size !== input.artifactRefs.length || parsedClaimsById.size !== input.artifactClaims.length) issues.add("artifact-ref-mismatch", "$.artifactRefs");
  const referencedPolicyHashes = new Set([...parsedRefs.values()].map((ref) => ref.resolverPolicyHash));
  const referencedLeaseIds = new Set([...parsedRefs.values()].map((ref) => ref.retentionLeaseReceiptId));
  if (parsedClaimsByRef.size !== parsedRefs.size || parsedPolicies.size !== referencedPolicyHashes.size || parsedLeases.size !== referencedLeaseIds.size) {
    issues.add("artifact-claim-mismatch", "$.artifactClaims");
  }
  return {
    refs,
    claims,
    policies: [...parsedPolicies.values()],
    leases: [...parsedLeases.values()],
  };
}

interface MaterializedInvocationArtifacts {
  readonly subjectArtifacts: SemanticArtifactV1[];
  readonly subjectArtifactRefs: ReadOnlyArtifactRefV1[];
  readonly acquisitionArtifacts: SemanticArtifactV1[];
  readonly acquisitionProductionReceipts: ProductionReceiptV1[];
  readonly targetProductionReceipts: ProductionReceiptV1[];
  readonly invocationRawArtifactRefIds: Hash[];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function invocationKey(
  key: ObserverSigningKeyV1,
  snapshot: SignedObserverInvocationSnapshotV1,
  registry: QualificationRegistrySnapshotV1,
  registryFacts: RegistryMembershipFactsV1,
  query: AcceptanceQueryV1,
  factSnapshot: QualifiedFactSnapshotV1,
  predicate: PredicateSpecV1,
  verifier: VerifierQualificationCertificateV1,
  observers: readonly ObserverQualificationCertificateV1[],
  ordinaryObserverQualificationIds: ReadonlySet<Hash>,
  ordinaryRoleIds: ReadonlySet<string>,
  authority: GateCoreAuthorityPinV1,
  nowUnixNs: string,
  issues: IssueSink,
): void {
  if (snapshot.registryRoot !== registry.registryId || snapshot.registryRoot !== authority.registry.expectedRegistryRoot) {
    issues.add("invocation-registry-mismatch", "$.signedInvocationSnapshot.registryRoot");
  }
  if (snapshot.registryEpoch !== registry.epoch || snapshot.registryEpoch !== authority.registry.expectedEpoch) {
    issues.add("invocation-registry-mismatch", "$.signedInvocationSnapshot.registryEpoch");
  }
  if (snapshot.acceptanceQueryId !== query.queryId) issues.add("invocation-query-mismatch", "$.signedInvocationSnapshot.acceptanceQueryId");
  if (snapshot.qualifiedFactSnapshotId !== factSnapshot.snapshotId) issues.add("invocation-snapshot-mismatch", "$.signedInvocationSnapshot.qualifiedFactSnapshotId");
  if (snapshot.audienceHash !== key.audienceHash || snapshot.audienceHash !== authority.expectedAudienceHash) {
    issues.add("invocation-audience-mismatch", "$.signedInvocationSnapshot.audienceHash");
  }
  if (snapshot.keyId !== key.keyId || snapshot.observerQualificationId !== key.observerQualificationId || snapshot.roleId !== key.roleId) {
    issues.add("invocation-key-mismatch", "$.signedInvocationSnapshot.keyId");
  }
  if (registryFacts.revokedObserverKeyIds.includes(key.keyId)) {
    issues.add("invocation-key-mismatch", "$.signedInvocationSnapshot.keyId.revoked");
  }
  try {
    const registryEpoch = BigInt(registry.epoch);
    if (registryEpoch < BigInt(key.validFromRegistryEpoch) || registryEpoch > BigInt(key.validThroughRegistryEpoch)) {
      issues.add("invocation-key-mismatch", "$.signedInvocationSnapshot.keyId.epoch");
    }
  } catch {
    issues.add("invocation-key-mismatch", "$.signedInvocationSnapshot.keyId.epoch");
  }
  const observer = observers.find((candidate) => candidate.certificateId === snapshot.observerQualificationId);
  if (ordinaryObserverQualificationIds.has(snapshot.observerQualificationId)) {
    issues.add("invocation-role-mismatch", "$.signedInvocationSnapshot.observerQualificationId.reused");
  }
  if (observer === undefined) {
    issues.add("observer-qualification-missing", "$.signedInvocationSnapshot.observerQualificationId");
  } else {
    const membership = registryFacts.certificateMemberships.find((candidate) =>
      candidate.certificateKind === "observer" && candidate.certificateId === observer.certificateId,
    );
    if (membership === undefined || membership.certificatePayloadHash !== hashObserverCertificatePayload(observer) || membership.issuerId === "" || !registryFacts.trustedIssuerIds.includes(membership.issuerId) || registryFacts.revokedCertificateIds.includes(observer.certificateId) || !observer.qualifiedLocatorKinds.includes("content-object")) {
      issues.add("invocation-role-mismatch", "$.signedInvocationSnapshot.observerQualificationId");
    }
  }
  const verifierRole = verifier.requiredObserverRoles.find((candidate) =>
    candidate.roleId === snapshot.roleId && candidate.observerQualificationId === snapshot.observerQualificationId,
  );
  const predicateRole = predicate.requiredObserverRoles.find((candidate) => candidate.roleId === snapshot.roleId);
  const signedInvocationSchema = {
    id: QUALIFIED_FACT_SCHEMA_MANIFESTS.signedObserverInvocationSnapshot.id,
    version: QUALIFIED_FACT_SCHEMA_MANIFESTS.signedObserverInvocationSnapshot.version,
    schemaHash: QUALIFIED_FACT_SCHEMA_MANIFESTS.signedObserverInvocationSnapshot.schemaHash,
  };
  const predicateSealRoles = predicate.requiredObserverRoles.filter((role) => sameJson(role.observationSchema, signedInvocationSchema));
  const verifierSealRoles = verifier.requiredObserverRoles.filter((role) => sameJson(role.observationSchema, signedInvocationSchema));
  if (
    ordinaryRoleIds.has(snapshot.roleId) ||
    verifierRole === undefined ||
    predicateRole === undefined ||
    verifierRole.observerQualificationId !== snapshot.observerQualificationId ||
    predicateSealRoles.length !== 1 ||
    verifierSealRoles.length !== 1 ||
    authority.signedInvocationRoleId !== snapshot.roleId ||
    predicateSealRoles[0]?.roleId !== authority.signedInvocationRoleId ||
    verifierSealRoles[0]?.roleId !== authority.signedInvocationRoleId ||
    predicateSealRoles[0]?.roleId !== snapshot.roleId ||
    verifierSealRoles[0]?.roleId !== snapshot.roleId
  ) {
    issues.add("invocation-role-mismatch", "$.signedInvocationSnapshot.roleId");
  }
  try {
    const now = BigInt(nowUnixNs);
    const issued = BigInt(snapshot.issuedAtUnixNs);
    const expires = BigInt(snapshot.expiresAtUnixNs);
    const maxTtl = BigInt(authority.maxInvocationTtlUnixNs);
    if (snapshot.invocationNonce === ZERO_HASH) issues.add("invocation-mismatch", "$.signedInvocationSnapshot.invocationNonce");
    if (expires < issued || expires - issued > maxTtl) issues.add("invocation-ttl-exceeded", "$.signedInvocationSnapshot.expiresAtUnixNs");
    if (now < issued || now >= expires) issues.add("invocation-expired", "$.signedInvocationSnapshot.expiresAtUnixNs");
  } catch {
    issues.add("invocation-mismatch", "$.signedInvocationSnapshot.time");
  }
  try {
    const publicKeyBytes = new Uint8Array(key.publicKeyHex.slice(2).match(/../g)!.map((value) => Number.parseInt(value, 16)));
    const spkiPrefix = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
    const spki = Buffer.from([...spkiPrefix, ...publicKeyBytes]);
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    const signature = Buffer.from(snapshot.signatureHex.slice(2), "hex");
    if (!verifySignature(null, Buffer.from(observerInvocationSigningBytes(snapshot)), publicKey, signature)) {
      issues.add("invocation-signature-mismatch", "$.signedInvocationSnapshot.signatureHex");
    }
  } catch {
    issues.add("invocation-signature-mismatch", "$.signedInvocationSnapshot.signatureHex");
  }
}

function materializeInvocationArtifacts(
  input: GateCoreInputV1,
  invocation: SignedObserverInvocationSnapshotV1,
  observations: readonly QualifiedObservationEnvelopeV1[],
  artifactResult: ReturnType<typeof validateArtifacts>,
  issues: IssueSink,
): MaterializedInvocationArtifacts {
  const refsById = new Map(artifactResult.refs.map((ref) => [ref.artifactRefId, ref]));
  const claimsByRef = new Map(artifactResult.claims.map((claim) => [claim.artifactRefId, claim]));
  const semanticArtifacts: SemanticArtifactV1[] = [];
  const productionReceipts: ProductionReceiptV1[] = [];
  const boundObjectIds = new Set<Hash>();
  const boundRawRefIds = new Set<Hash>();
  const invocationRawRefIds = new Set<Hash>([
    ...invocation.semanticArtifactBindings.map((binding) => binding.rawArtifactRefId),
    ...invocation.productionReceiptBindings.map((binding) => binding.rawArtifactRefId),
  ]);

  const decodeBinding = (binding: SignedObserverInvocationSnapshotV1["semanticArtifactBindings"][number] | SignedObserverInvocationSnapshotV1["productionReceiptBindings"][number], index: number): void => {
    if (boundObjectIds.has(binding.objectId) || boundRawRefIds.has(binding.rawArtifactRefId)) {
      issues.add("invocation-binding-mismatch", `$.signedInvocationSnapshot.bindings[${index}]`);
      return;
    }
    boundObjectIds.add(binding.objectId);
    boundRawRefIds.add(binding.rawArtifactRefId);
    const ref = refsById.get(binding.rawArtifactRefId);
    const claim = claimsByRef.get(binding.rawArtifactRefId);
    const mirror = claim?.outcome === "content-observed" ? claim.observedMirror : null;
    if (ref === undefined || claim === undefined || mirror === null) {
      issues.add("invocation-binding-mismatch", `$.signedInvocationSnapshot.bindings[${index}].rawArtifactRefId`);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeArtifactBytes(mirror.bytes);
    } catch {
      issues.add("canonical-bytes-mismatch", `$.signedInvocationSnapshot.bindings[${index}]`);
      return;
    }
    if (binding.byteLength !== String(bytes.byteLength) || mirror.byteLength !== String(bytes.byteLength) || binding.canonicalBytesSha256 !== sha256Hex(bytes)) {
      issues.add("canonical-bytes-mismatch", `$.signedInvocationSnapshot.bindings[${index}]`);
      return;
    }
    const expectedCanonicalSchema = binding.kind === "semantic-artifact"
      ? CORE_SCHEMA_MANIFESTS.semanticArtifact
      : CORE_SCHEMA_MANIFESTS.productionReceipt;
    const expectedCanonicalSchemaRef = {
      id: expectedCanonicalSchema.id,
      version: expectedCanonicalSchema.version,
      schemaHash: expectedCanonicalSchema.schemaHash,
    };
    if (
      binding.canonicalBytesSha256 !== mirror.contentSha256 ||
      binding.canonicalBytesSha256 !== ref.contentSha256 ||
      ref.mediaType !== "application/json" ||
      mirror.mediaType !== "application/json" ||
      !sameJson(ref.schema, expectedCanonicalSchemaRef) ||
      !sameJson(mirror.schema, expectedCanonicalSchemaRef)
    ) {
      issues.add("canonical-bytes-mismatch", `$.signedInvocationSnapshot.bindings[${index}]`);
      return;
    }
    try {
      const decoded = binding.kind === "semantic-artifact" ? decodeSemanticArtifact(bytes) : decodeProductionReceipt(bytes);
      const encoded = binding.kind === "semantic-artifact" ? encodeSemanticArtifact(decoded as SemanticArtifactV1) : encodeProductionReceipt(decoded as ProductionReceiptV1);
      if (!bytesEqual(bytes, encoded) || sha256Hex(encoded) !== binding.canonicalBytesSha256) {
        issues.add("canonical-bytes-mismatch", `$.signedInvocationSnapshot.bindings[${index}]`);
        return;
      }
      if (binding.kind === "semantic-artifact") {
        const artifact = decoded as SemanticArtifactV1;
        if (artifact.artifactId !== binding.objectId) issues.add("invocation-binding-mismatch", `$.signedInvocationSnapshot.semanticArtifactBindings[${index}].objectId`);
        if (artifact.inputArtifactIds.some((refId) => invocationRawRefIds.has(refId))) issues.add("invocation-binding-mismatch", `$.signedInvocationSnapshot.semanticArtifactBindings[${index}].inputArtifactIds`);
        semanticArtifacts.push(artifact);
      } else {
        const receipt = decoded as ProductionReceiptV1;
        if (receipt.receiptId !== binding.objectId) issues.add("invocation-binding-mismatch", `$.signedInvocationSnapshot.productionReceiptBindings[${index}].objectId`);
        if (invocationRawRefIds.has(receipt.logRangeArtifactRef.artifactRefId) || invocationRawRefIds.has(receipt.rawBoundaryArtifactRef.artifactRefId)) issues.add("invocation-binding-mismatch", `$.signedInvocationSnapshot.productionReceiptBindings[${index}].rawArtifactRefs`);
        productionReceipts.push(receipt);
      }
    } catch {
      issues.add("canonical-bytes-mismatch", `$.signedInvocationSnapshot.bindings[${index}]`);
    }
  };
  invocation.semanticArtifactBindings.forEach(decodeBinding);
  invocation.productionReceiptBindings.forEach(decodeBinding);

  const acquisitionReceiptIds = new Set(observations.map((observation) => observation.acquisitionProductionReceiptId));
  const acquisitionProductionReceipts = productionReceipts.filter((receipt) => acquisitionReceiptIds.has(receipt.receiptId));
  const targetProductionReceipts = productionReceipts.filter((receipt) => !acquisitionReceiptIds.has(receipt.receiptId));
  const acquisitionArtifactIds = new Set(acquisitionProductionReceipts.map((receipt) => receipt.artifactId));
  const acquisitionArtifacts = semanticArtifacts.filter((artifact) => acquisitionArtifactIds.has(artifact.artifactId));
  const subjectArtifacts = semanticArtifacts.filter((artifact) => !acquisitionArtifactIds.has(artifact.artifactId));
  const subjectRefIds = [...new Set(subjectArtifacts.flatMap((artifact) => artifact.inputArtifactIds))].sort();
  const subjectArtifactRefs = subjectRefIds.map((refId) => refsById.get(refId)).filter((ref): ref is ReadOnlyArtifactRefV1 => ref !== undefined);
  if (subjectArtifactRefs.length !== subjectRefIds.length) issues.add("invocation-binding-mismatch", "$.signedInvocationSnapshot.semanticArtifactBindings.inputArtifactIds");
  if (input.artifactRefs.length === 0 && (semanticArtifacts.length > 0 || productionReceipts.length > 0)) issues.add("invocation-binding-mismatch", "$.signedInvocationSnapshot.bindings");
  return { subjectArtifacts, subjectArtifactRefs, acquisitionArtifacts, acquisitionProductionReceipts, targetProductionReceipts, invocationRawArtifactRefIds: [...invocationRawRefIds].sort() };
}

function validateSubjectArtifacts(
  subjectArtifactInputs: readonly SemanticArtifactV1[],
  subjectArtifactRefInputs: readonly ReadOnlyArtifactRefV1[],
  query: AcceptanceQueryV1,
  targetReceipts: readonly ProductionReceiptV1[],
  acquisitionArtifacts: readonly SemanticArtifactV1[],
  acquisitionReceipts: readonly ProductionReceiptV1[],
  observedRefs: readonly ReadOnlyArtifactRefV1[],
  issues: IssueSink,
): { artifacts: SemanticArtifactV1[]; refs: ReadOnlyArtifactRefV1[] } {
  const artifacts = subjectArtifactInputs.map((value, index) => safeDecode(() => decodeSemanticArtifact(value), issues, "observation-mismatch", `$.signedInvocationSnapshot.semanticArtifactBindings[${index}]`)).filter((value): value is SemanticArtifactV1 => value !== null);
  const refs = subjectArtifactRefInputs.map((value, index) => safeDecode(() => decodeReadOnlyArtifactRef(value), issues, "artifact-ref-mismatch", `$.signedInvocationSnapshot.semanticArtifactBindings.inputArtifactIds[${index}]`)).filter((value): value is ReadOnlyArtifactRefV1 => value !== null);
  const artifactMap = mapUnique(artifacts, (value) => value.artifactId);
  const refMap = mapUnique(refs, (value) => value.artifactRefId);
  const targetReceiptMap = mapUnique(targetReceipts, (value) => value.receiptId);
  const acquisitionArtifactIds = new Set(acquisitionArtifacts.map((value) => value.artifactId));
  const acquisitionReceiptIds = new Set(acquisitionReceipts.map((value) => value.receiptId));
  const observedRefMap = new Map(observedRefs.map((value) => [value.artifactRefId, value]));
  const referencedArtifactIds = new Set<string>();
  const referencedRefIds = new Set<string>();
  const targetArtifactIds = new Set<string>();
  if (artifactMap === null || refMap === null || targetReceiptMap === null) {
    issues.add("observation-mismatch", "$.subjectArtifacts");
  }
  if (artifactMap !== null && targetReceipts.length !== artifactMap.size) {
    issues.add("production-receipt-mismatch", "$.targetProductionReceipts");
  }
  for (const [index, ref] of refs.entries()) {
    const observedRef = observedRefMap.get(ref.artifactRefId);
    if (observedRef === undefined || !sameJson(observedRef, ref)) {
      issues.add("artifact-ref-mismatch", `$.subjectArtifactRefs[${index}]`);
    }
  }
  for (const [index, receipt] of targetReceipts.entries()) {
    if (acquisitionReceiptIds.has(receipt.receiptId)) issues.add("process-splice", `$.targetProductionReceipts[${index}].receiptId`);
    if (acquisitionArtifactIds.has(receipt.artifactId)) issues.add("process-splice", `$.targetProductionReceipts[${index}].artifactId`);
    const artifact = artifactMap?.get(receipt.artifactId);
    if (artifact === undefined) {
      issues.add("production-receipt-mismatch", `$.targetProductionReceipts[${index}].artifactId`);
      continue;
    }
    if (targetArtifactIds.has(artifact.artifactId)) {
      issues.add("production-receipt-mismatch", `$.targetProductionReceipts[${index}].artifactId`);
    }
    targetArtifactIds.add(artifact.artifactId);
    referencedArtifactIds.add(artifact.artifactId);
    const receiptRefIds = [receipt.logRangeArtifactRef.artifactRefId, receipt.rawBoundaryArtifactRef.artifactRefId];
    if (receiptRefIds[0] === receiptRefIds[1]) issues.add("process-splice", `$.targetProductionReceipts[${index}].rawArtifactRefs`);
    for (const refId of receiptRefIds) {
      const ref = observedRefMap.get(refId);
      if (ref === undefined) {
        issues.add("artifact-ref-mismatch", `$.targetProductionReceipts[${index}].rawArtifactRefs`);
      }
    }
    const inputRefIds = [...artifact.inputArtifactIds].sort();
    if (!inputRefIds.every((refId) => {
      const ref = refMap?.get(refId);
      const observedRef = observedRefMap.get(refId);
      if (ref === undefined || observedRef === undefined || !sameJson(ref, observedRef)) {
        issues.add("artifact-ref-mismatch", `$.subjectArtifacts.${artifact.artifactId}.inputArtifactIds`);
        return false;
      }
      referencedRefIds.add(refId);
      return true;
    })) {
      issues.add("observation-mismatch", `$.subjectArtifacts.${artifact.artifactId}.inputArtifactIds`);
    }
  }
  if (artifactMap !== null && referencedArtifactIds.size !== artifactMap.size) issues.add("observation-mismatch", "$.subjectArtifacts");
  if (refMap !== null && referencedRefIds.size !== refMap.size) issues.add("artifact-ref-mismatch", "$.subjectArtifactRefs");
  if (query.subjectArtifactRoot !== computeSubjectArtifactRoot(artifacts)) issues.add("snapshot-mismatch", "$.query.subjectArtifactRoot");
  return { artifacts, refs };
}

function validateObservationLineage(
  acquisitionArtifactInputs: readonly SemanticArtifactV1[],
  acquisitionReceiptInputs: readonly ProductionReceiptV1[],
  subjectArtifactInputs: readonly SemanticArtifactV1[],
  targetReceiptInputs: readonly ProductionReceiptV1[],
  query: AcceptanceQueryV1,
  snapshot: QualifiedFactSnapshotV1,
  observations: readonly QualifiedObservationEnvelopeV1[],
  sidecars: readonly QualifiedSidecarObservationV1[],
  refs: readonly ReadOnlyArtifactRefV1[],
  claims: readonly ArtifactResolutionClaimV1[],
  invocationRawArtifactRefIds: readonly Hash[],
  issues: IssueSink,
): { artifacts: SemanticArtifactV1[]; receipts: ProductionReceiptV1[] } {
  const artifacts: SemanticArtifactV1[] = [];
  const receipts: ProductionReceiptV1[] = [];
  const decodedArtifacts = acquisitionArtifactInputs.map((value, index) => safeDecode(() => decodeSemanticArtifact(value), issues, "observation-mismatch", `$.signedInvocationSnapshot.acquisitionArtifacts[${index}]`)).filter((value): value is SemanticArtifactV1 => value !== null);
  const decodedReceipts = acquisitionReceiptInputs.map((value, index) => safeDecode(() => decodeProductionReceipt(value), issues, "production-receipt-mismatch", `$.signedInvocationSnapshot.acquisitionProductionReceipts[${index}]`)).filter((value): value is ProductionReceiptV1 => value !== null);
  for (const [index, artifact] of decodedArtifacts.entries()) {
    if (recomputeSemanticArtifactId(artifact) !== artifact.artifactId) issues.add("observation-mismatch", `$.acquisitionArtifacts[${index}].artifactId`);
  }
  for (const [index, receipt] of decodedReceipts.entries()) {
    if (recomputeProductionReceiptId(receipt) !== receipt.receiptId) issues.add("production-receipt-mismatch", `$.acquisitionProductionReceipts[${index}].receiptId`);
  }
  const artifactMap = mapUnique(decodedArtifacts, (value) => value.artifactId);
  const receiptMap = mapUnique(decodedReceipts, (value) => value.receiptId);
  if (artifactMap === null) issues.add("observation-mismatch", "$.acquisitionArtifacts");
  if (receiptMap === null) issues.add("production-receipt-mismatch", "$.acquisitionProductionReceipts");
  if (decodedArtifacts.length !== acquisitionArtifactInputs.length) issues.add("observation-mismatch", "$.signedInvocationSnapshot.acquisitionArtifacts");
  if (decodedReceipts.length !== acquisitionReceiptInputs.length) issues.add("production-receipt-mismatch", "$.signedInvocationSnapshot.acquisitionProductionReceipts");
  const claimIds = new Set(claims.map((claim) => claim.claimId));
  const refIds = new Set(refs.map((ref) => ref.artifactRefId));
  const refsById = new Map(refs.map((ref) => [ref.artifactRefId, ref]));
  for (const [index, observationInput] of observations.entries()) {
    const observation = safeDecode(() => decodeQualifiedObservation(observationInput), issues, "observation-mismatch", `$.observations[${index}]`);
    if (observation === null) continue;
    const observationClaims = new Set(observation.observedClaimIds);
    const expectedClaimIds = claims.filter((claim) => observation.rawArtifactRefs.some((ref) => ref.artifactRefId === claim.artifactRefId)).map((claim) => claim.claimId).sort();
    if (observationClaims.size !== observation.observedClaimIds.length || !observation.observedClaimIds.every((id) => claimIds.has(id)) || !exactIds(observation.observedClaimIds, expectedClaimIds)) issues.add("observation-mismatch", `$.observations[${index}].observedClaimIds`);
    if (!observation.rawArtifactRefs.every((ref) => refIds.has(ref.artifactRefId) && sameJson(refsById.get(ref.artifactRefId), ref))) issues.add("observation-mismatch", `$.observations[${index}].rawArtifactRefs`);
    const receipt = receiptMap?.get(observation.acquisitionProductionReceiptId);
    if (receipt === undefined) {
      issues.add("production-receipt-missing", `$.observations[${index}]`);
      continue;
    }
    receipts.push(receipt);
    const artifact = artifactMap?.get(receipt.artifactId);
    if (artifact === undefined) {
      issues.add("observation-mismatch", `$.observations[${index}].acquisitionArtifact`);
    } else {
      artifacts.push(artifact);
      if (!sameJson(artifact.schema, observation.observationSchema) || !sameJson(artifact.inputArtifactIds, observation.rawArtifactRefs.map((ref) => ref.artifactRefId)) || artifact.canonicalPayloadHash !== observation.canonicalFactsHash) issues.add("observation-mismatch", `$.observations[${index}].acquisitionArtifact`);
      if (receipt.semanticConfigDigest !== computeObserverSemanticConfigDigest(observation)) issues.add("observation-mismatch", `$.observations[${index}].semanticConfigDigest`);
    }
    const observationRawIds = observation.rawArtifactRefs.map((ref) => ref.artifactRefId);
    const logRef = refs.find((ref) => ref.artifactRefId === receipt.logRangeArtifactRef.artifactRefId);
    const boundaryRef = refs.find((ref) => ref.artifactRefId === receipt.rawBoundaryArtifactRef.artifactRefId);
    if (!observationRawIds.includes(receipt.logRangeArtifactRef.artifactRefId) || !observationRawIds.includes(receipt.rawBoundaryArtifactRef.artifactRefId) || receipt.logRangeArtifactRef.artifactRefId === receipt.rawBoundaryArtifactRef.artifactRefId || logRef === undefined || boundaryRef === undefined || !sameJson(logRef, receipt.logRangeArtifactRef) || !sameJson(boundaryRef, receipt.rawBoundaryArtifactRef)) issues.add("process-splice", `$.observations[${index}].rawArtifactRefs`);
  }
  const ordinaryRawUnion = [...new Set([
    ...observations.flatMap((observation) => observation.rawArtifactRefs.map((ref) => ref.artifactRefId)),
    ...sidecars.flatMap((sidecar) => sidecar.kind === "aloha.store-epoch-observation"
      ? [sidecar.canonicalFacts.rawArtifactRefId]
      : [sidecar.canonicalFacts.logRangeArtifactRefId, sidecar.canonicalFacts.rawBoundaryArtifactRefId]),
    ...decodedArtifacts.flatMap((artifact) => artifact.inputArtifactIds),
    ...subjectArtifactInputs.flatMap((artifact) => artifact.inputArtifactIds),
    ...decodedReceipts.flatMap((receipt) => [receipt.logRangeArtifactRef.artifactRefId, receipt.rawBoundaryArtifactRef.artifactRefId]),
    ...targetReceiptInputs.flatMap((receipt) => [receipt.logRangeArtifactRef.artifactRefId, receipt.rawBoundaryArtifactRef.artifactRefId]),
  ])].sort();
  const inputRawRefIds = refs.map((ref) => ref.artifactRefId).sort();
  const inputRawRefSet = new Set(inputRawRefIds);
  const invocationRawRefIds = [...new Set(invocationRawArtifactRefIds)].sort();
  const invocationRawSet = new Set(invocationRawRefIds);
  const expectedOrdinaryRawRefIds = inputRawRefIds.filter((refId) => !invocationRawSet.has(refId));
  if (invocationRawRefIds.some((refId) => !inputRawRefSet.has(refId))) {
    issues.add("invocation-binding-mismatch", "$.signedInvocationSnapshot.bindings.rawArtifactRefId");
  }
  if (ordinaryRawUnion.some((refId) => invocationRawSet.has(refId))) issues.add("process-splice", "$.signedInvocationSnapshot.bindings.rawArtifactRefId");
  // Every decoded input ref must be in exactly one partition. Ordinary refs
  // are derived from all non-invocation evidence, while invocation refs come
  // only from the signed binding set; no orphan or splice may be tolerated.
  if (!exactIds(ordinaryRawUnion, expectedOrdinaryRawRefIds)) {
    issues.add("artifact-ref-mismatch", "$.artifactRefs");
  }
  if (!exactIds([...new Set([...ordinaryRawUnion, ...invocationRawRefIds])].sort(), inputRawRefIds)) {
    issues.add("artifact-ref-mismatch", "$.artifactRefs");
  }
  const expectedClaimUnion = claims.map((claim) => claim.claimId).sort();
  if (!exactIds(observations.flatMap((observation) => observation.observedClaimIds).sort(), claims.filter((claim) => !invocationRawSet.has(claim.artifactRefId)).map((claim) => claim.claimId).sort())) issues.add("snapshot-mismatch", "$.observations.observedClaimIds");
  const expectedObservationIds = [...observations, ...sidecars].map((observation) => observation.observationId).sort();
  if (!exactIds(snapshot.orderedObservationIds, expectedObservationIds)) issues.add("snapshot-mismatch", "$.snapshot.orderedObservationIds");
  if (!exactIds(snapshot.orderedClaimIds, expectedClaimUnion)) issues.add("snapshot-mismatch", "$.snapshot.orderedClaimIds");
  if (!exactIds(snapshot.orderedRawArtifactRefIds, inputRawRefIds)) issues.add("snapshot-mismatch", "$.snapshot.orderedRawArtifactRefIds");
  if (artifactMap !== null && artifactMap.size !== artifacts.length) issues.add("observation-mismatch", "$.acquisitionArtifacts");
  if (receiptMap !== null && receiptMap.size !== receipts.length) issues.add("production-receipt-mismatch", "$.acquisitionProductionReceipts");
  if (query.qualifiedFactSnapshotId !== snapshot.snapshotId) issues.add("snapshot-mismatch", "$.query.qualifiedFactSnapshotId");
  return { artifacts, receipts };
}

function validateObservationQualificationBindings(
  observations: readonly QualifiedObservationEnvelopeV1[],
  predicate: PredicateSpecV1 | null,
  verifier: VerifierQualificationCertificateV1 | null,
  observerCertificates: readonly ObserverQualificationCertificateV1[],
  registry: QualificationRegistrySnapshotV1 | null,
  issues: IssueSink,
): void {
  if (predicate === null || verifier === null || registry === null) {
    issues.add("observer-qualification-missing", "$.observations");
    return;
  }
  for (const [index, observation] of observations.entries()) {
    const observer = observerCertificates.find((candidate) => candidate.certificateId === observation.observerQualificationId);
    const verifierRole = verifier.requiredObserverRoles.find((role) => role.observerQualificationId === observation.observerQualificationId);
    const role = predicate.requiredObserverRoles.find((candidate) => candidate.roleId === verifierRole?.roleId);
    if (observer === undefined || verifierRole === undefined || role === undefined) {
      issues.add("observer-qualification-mismatch", `$.observations[${index}].observerQualificationId`);
      continue;
    }
    if (
      observation.observerImplementationDigest !== observer.observerImplementationDigest ||
      !sameJson(observation.observationSchema, role.observationSchema) ||
      observation.anchorPolicyDigest !== role.anchorPolicyDigest ||
      observation.qualificationRegistryRoot !== registry.registryId ||
      observation.observerQualificationId !== verifierRole.observerQualificationId
    ) {
      issues.add("observer-qualification-mismatch", `$.observations[${index}]`);
    }
    const allowedKinds = new Set(observer.qualifiedLocatorKinds);
    if (!observation.rawArtifactRefs.every((ref) => allowedKinds.has(ref.locator.kind))) {
      issues.add("observer-qualification-mismatch", `$.observations[${index}].rawArtifactRefs`);
    }
  }
}

function nonZeroHash(value: string): boolean {
  return value !== ZERO_HASH;
}

function atLeastDecimal(actual: string, minimum: string): boolean {
  try {
    return BigInt(actual) >= BigInt(minimum);
  } catch {
    return false;
  }
}

/**
 * Live GateCore verifies certificate structure, registry membership, and the
 * qualified roots supplied by governance. It does not rebuild a qualification
 * corpus or execute an oracle/reference model on the live path.
 */
function validateObserverQualificationCertificate(
  certificate: ObserverQualificationCertificateV1,
  role: ObserverRoleSpecV1,
  registry: QualificationRegistrySnapshotV1,
  registryFacts: RegistryMembershipFactsV1,
  issues: IssueSink,
  path: string,
): void {
  if (!currentMembership("observer", certificate.certificateId, hashObserverCertificatePayload(certificate), certificate.issuerId, registry, registryFacts, issues, `${path}.membership`)) {
    return;
  }
  if (certificate.qualificationSpecDigest !== role.observerQualificationSpecDigest) issues.add("observer-qualification-mismatch", `${path}.qualificationSpecDigest`);
  if (!sameJson(certificate.observedSchemaIds, [role.observationSchema])) issues.add("observer-qualification-mismatch", `${path}.observedSchemaIds`);
  if (!sameJson(certificate.declaredCriticalMutationIds, role.requiredCriticalMutationIds) || !sameJson(certificate.rejectedOrInvalidMutationIds, role.requiredCriticalMutationIds)) issues.add("mutation-set-mismatch", `${path}.declaredCriticalMutationIds`);
  if (certificate.issuedAtRegistryEpoch !== "0" && !atLeastDecimal(registry.epoch, certificate.issuedAtRegistryEpoch)) issues.add("qualification-stale", `${path}.issuedAtRegistryEpoch`);
  if (certificate.verdict !== "qualified") issues.add("observer-qualification-mismatch", `${path}.verdict`);
  if (!atLeastDecimal(certificate.independentOracleCaseCount, role.minimumIndependentOracleCases) || !nonZeroHash(certificate.independentOracleCaseRoot) || !nonZeroHash(certificate.positiveCaseRoot) || !nonZeroHash(certificate.negativeCaseRoot) || !nonZeroHash(certificate.invalidCaseRoot)) {
    issues.add("oracle-coverage-mismatch", `${path}.oracleCases`);
  }
}

function validateVerifierQualificationCertificate(
  certificate: VerifierQualificationCertificateV1,
  predicate: PredicateSpecV1,
  registry: QualificationRegistrySnapshotV1,
  registryFacts: RegistryMembershipFactsV1,
  authority: GateCoreAuthorityPinV1 | null,
  issues: IssueSink,
  path: string,
): void {
  if (authority === null) {
    issues.add("verifier-qualification-mismatch", `${path}.authority`);
    return;
  }
  if (certificate.certificateId !== authority.verifierQualificationId) issues.add("verifier-qualification-mismatch", `${path}.certificateId`);
  if (!currentMembership("verifier", certificate.certificateId, hashVerifierCertificatePayload(certificate), certificate.issuerId, registry, registryFacts, issues, `${path}.membership`)) return;
  if (certificate.predicateSpecDigest !== predicate.specDigest || certificate.qualificationSpecDigest !== predicate.verifierQualificationSpecDigest) issues.add("verifier-qualification-mismatch", path);
  if (certificate.predicateProgramDescriptorDigest !== authority.predicateProgramDescriptorDigest) issues.add("verifier-qualification-mismatch", `${path}.predicateProgramDescriptorDigest`);
  if (certificate.oracleProgramDescriptorDigest !== authority.oracleProgramDescriptorDigest) issues.add("verifier-qualification-mismatch", `${path}.oracleProgramDescriptorDigest`);
  if (certificate.oracleImplementationClosureDigest !== authority.oracleImplementationClosureDigest) issues.add("verifier-qualification-mismatch", `${path}.oracleImplementationClosureDigest`);
  if (certificate.oracleImplementationExportDigest !== authority.oracleImplementationExportDigest) issues.add("verifier-qualification-mismatch", `${path}.oracleImplementationExportDigest`);
  if (certificate.predicateCompositionLeafDigest !== authority.predicateCompositionLeafDigest) issues.add("verifier-qualification-mismatch", `${path}.predicateCompositionLeafDigest`);
  if (certificate.gateCoreImplementationClosureDigest !== authority.gateCoreImplementationClosureDigest) issues.add("verifier-qualification-mismatch", `${path}.gateCoreImplementationClosureDigest`);
  if (certificate.predicateImplementationDigest !== authority.predicateImplementationClosureDigest) issues.add("verifier-qualification-mismatch", `${path}.predicateImplementationDigest`);
  if (certificate.predicateImplementationExportDigest !== authority.predicateImplementationExportDigest) issues.add("verifier-qualification-mismatch", `${path}.predicateImplementationExportDigest`);
  if (!sameJson(certificate.declaredCriticalMutationIds, predicate.criticalMutationIds) || !sameJson(certificate.rejectedOrInvalidMutationIds, predicate.criticalMutationIds)) issues.add("mutation-set-mismatch", `${path}.declaredCriticalMutationIds`);
  if (certificate.issuedAtRegistryEpoch !== "0" && !atLeastDecimal(registry.epoch, certificate.issuedAtRegistryEpoch)) issues.add("qualification-stale", `${path}.issuedAtRegistryEpoch`);
  if (certificate.verdict !== "qualified") issues.add("verifier-qualification-mismatch", `${path}.verdict`);
  if (!nonZeroHash(certificate.caseSetRoot) || !nonZeroHash(certificate.independentOracleCaseRoot) || !nonZeroHash(certificate.counterexampleRoot) || !atLeastDecimal(certificate.independentOracleCaseCount, "1")) {
    issues.add("oracle-coverage-mismatch", `${path}.oracleCases`);
  }
}

function roleForSidecar(
  sidecar: QualifiedSidecarObservationV1,
  predicate: PredicateSpecV1,
  verifier: VerifierQualificationCertificateV1,
  observers: readonly ObserverQualificationCertificateV1[],
  registry: QualificationRegistrySnapshotV1,
  issues: IssueSink,
  path: string,
): ObserverRoleSpecV1 | null {
  const role = predicate.requiredObserverRoles.find((candidate) => candidate.roleId === sidecar.roleId);
  const verifierRole = verifier.requiredObserverRoles.find((candidate) => candidate.roleId === sidecar.roleId);
  const observer = observers.find((candidate) => candidate.certificateId === sidecar.observerQualificationId);
  if (
    role === undefined ||
    verifierRole === undefined ||
    observer === undefined ||
    sidecar.kind !== role?.observationSchema.id ||
    verifierRole.observerQualificationId !== sidecar.observerQualificationId ||
    !sameJson(verifierRole, { ...role, observerQualificationId: verifierRole.observerQualificationId }) ||
    !sameJson(sidecar.observationSchema, role.observationSchema) ||
    sidecar.observerImplementationDigest !== observer.observerImplementationDigest ||
    sidecar.anchorPolicyDigest !== role.anchorPolicyDigest ||
    sidecar.qualificationRegistryRoot !== registry.registryId
  ) {
    issues.add("observer-qualification-mismatch", path);
    return null;
  }
  return role;
}

function validateSidecarObservationBindings(
  sidecars: readonly QualifiedSidecarObservationV1[],
  observations: readonly QualifiedObservationEnvelopeV1[],
  predicate: PredicateSpecV1 | null,
  verifier: VerifierQualificationCertificateV1 | null,
  observers: readonly ObserverQualificationCertificateV1[],
  registry: QualificationRegistrySnapshotV1 | null,
  issues: IssueSink,
): void {
  if (predicate === null || verifier === null || registry === null) {
    issues.add("observer-qualification-missing", "$.sidecarObservations");
    return;
  }
  const ordinaryIds = new Set(observations.map((value) => value.observationId));
  const sidecarIds = new Set<string>();
  for (const [index, sidecar] of sidecars.entries()) {
    const path = `$.sidecarObservations[${index}]`;
    if (sidecarIds.has(sidecar.observationId) || ordinaryIds.has(sidecar.observationId)) {
      issues.add("observation-mismatch", `${path}.observationId`);
    }
    sidecarIds.add(sidecar.observationId);
    roleForSidecar(sidecar, predicate, verifier, observers, registry, issues, path);
  }
}

function validateProcessAndStoreObservations(
  input: GateCoreInputV1,
  query: AcceptanceQueryV1,
  sidecars: readonly QualifiedSidecarObservationV1[],
  acquisitionReceipts: readonly ProductionReceiptV1[],
  subjectArtifacts: readonly SemanticArtifactV1[],
  acquisitionRefs: readonly ReadOnlyArtifactRefV1[],
  targetReceipts: readonly ProductionReceiptV1[],
  claims: readonly ArtifactResolutionClaimV1[],
  observerCertificates: readonly ObserverQualificationCertificateV1[],
  predicate: PredicateSpecV1,
  verifier: VerifierQualificationCertificateV1,
  registry: QualificationRegistrySnapshotV1,
  issues: IssueSink,
): boolean {
  let valid = true;
  const sidecarMap = mapUnique(sidecars, (value) => value.observationId);
  if (sidecarMap === null) {
    issues.add("observation-mismatch", "$.sidecarObservations");
    valid = false;
  }
  const targetReceiptMap = mapUnique(targetReceipts, (value) => value.receiptId);
  const subjectArtifactIds = new Set(subjectArtifacts.map((artifact) => artifact.artifactId));
  const acquisitionReceiptIds = new Set<string>();
  const targetReceiptIds = new Set<string>();
  const acquisitionRawRefIds = new Set<string>();
  const targetRawRefIds = new Set<string>();
  const validateSidecarRefKinds = (sidecar: QualifiedSidecarObservationV1, refIds: readonly Hash[], availableRefs: readonly ReadOnlyArtifactRefV1[], path: string): void => {
    const observer = observerCertificates.find((candidate) => candidate.certificateId === sidecar.observerQualificationId);
    const allowedKinds = new Set(observer?.qualifiedLocatorKinds ?? []);
    if (observer === undefined || refIds.some((refId) => {
      const ref = availableRefs.find((candidate) => candidate.artifactRefId === refId);
      return ref === undefined || !allowedKinds.has(ref.locator.kind);
    })) {
      issues.add("observer-qualification-mismatch", path);
      valid = false;
    }
  };
  for (const [index, receipt] of targetReceipts.entries()) {
    if (!subjectArtifactIds.has(receipt.artifactId)) {
      issues.add("production-receipt-mismatch", `$.targetProductionReceipts[${index}].artifactId`);
    }
  }
  const ordinaryAcquisitionReceiptIds = new Set(acquisitionReceipts.map((receipt) => receipt.receiptId));
  let acquisitionCount = 0;
  let targetCount = 0;
  let storeCount = 0;
  for (const [index, sidecar] of sidecars.entries()) {
    const path = `$.sidecarObservations[${index}]`;
    if (sidecar.kind === "aloha.acquisition-process-observation") {
      acquisitionCount += 1;
      const facts = sidecar.canonicalFacts;
      const receipt = acquisitionReceipts.find((candidate) => candidate.receiptId === facts.receiptId);
      if (receipt === undefined || !ordinaryAcquisitionReceiptIds.has(facts.receiptId)) {
        issues.add("production-receipt-missing", `${path}.canonicalFacts.receiptId`);
        valid = false;
        continue;
      }
      if (acquisitionReceiptIds.has(facts.receiptId) || targetReceiptIds.has(facts.receiptId)) {
        issues.add("process-splice", `${path}.canonicalFacts.receiptId`);
        valid = false;
      }
      acquisitionReceiptIds.add(facts.receiptId);
      if (acquisitionRawRefIds.has(facts.logRangeArtifactRefId) || acquisitionRawRefIds.has(facts.rawBoundaryArtifactRefId) || targetRawRefIds.has(facts.logRangeArtifactRefId) || targetRawRefIds.has(facts.rawBoundaryArtifactRefId)) {
        issues.add("process-splice", path);
        valid = false;
      }
      acquisitionRawRefIds.add(facts.logRangeArtifactRefId);
      acquisitionRawRefIds.add(facts.rawBoundaryArtifactRefId);
      if (
        facts.processAnchorHash !== hashProcessAnchor(receipt.producer) ||
        facts.logRangeArtifactRefId !== receipt.logRangeArtifactRef.artifactRefId ||
        facts.rawBoundaryArtifactRefId !== receipt.rawBoundaryArtifactRef.artifactRefId ||
        facts.logRangeArtifactRefId === facts.rawBoundaryArtifactRefId ||
        acquisitionRefs.find((ref) => ref.artifactRefId === facts.logRangeArtifactRefId) === undefined ||
        acquisitionRefs.find((ref) => ref.artifactRefId === facts.rawBoundaryArtifactRefId) === undefined
      ) {
        issues.add("process-anchor-mismatch", path);
        valid = false;
      }
      validateSidecarRefKinds(sidecar, [facts.logRangeArtifactRefId, facts.rawBoundaryArtifactRefId], acquisitionRefs, `${path}.canonicalFacts.rawRefs`);
    } else if (sidecar.kind === "aloha.target-process-observation") {
      targetCount += 1;
      const facts = sidecar.canonicalFacts;
      const receipt = targetReceiptMap?.get(facts.receiptId);
      if (receipt === undefined) {
        issues.add("production-receipt-missing", `${path}.canonicalFacts.receiptId`);
        valid = false;
        continue;
      }
      if (targetReceiptIds.has(facts.receiptId) || acquisitionReceiptIds.has(facts.receiptId)) {
        issues.add("process-splice", `${path}.canonicalFacts.receiptId`);
        valid = false;
      }
      targetReceiptIds.add(facts.receiptId);
      if (targetRawRefIds.has(facts.logRangeArtifactRefId) || targetRawRefIds.has(facts.rawBoundaryArtifactRefId) || acquisitionRawRefIds.has(facts.logRangeArtifactRefId) || acquisitionRawRefIds.has(facts.rawBoundaryArtifactRefId)) {
        issues.add("process-splice", path);
        valid = false;
      }
      targetRawRefIds.add(facts.logRangeArtifactRefId);
      targetRawRefIds.add(facts.rawBoundaryArtifactRefId);
      if (
        !subjectArtifactIds.has(receipt.artifactId) ||
        facts.processAnchorHash !== hashProcessAnchor(receipt.producer) ||
        facts.processAnchorHash !== query.processAnchorHash ||
        facts.logRangeArtifactRefId !== receipt.logRangeArtifactRef.artifactRefId ||
        facts.rawBoundaryArtifactRefId !== receipt.rawBoundaryArtifactRef.artifactRefId ||
        facts.logRangeArtifactRefId === facts.rawBoundaryArtifactRefId ||
        acquisitionRefs.find((ref) => ref.artifactRefId === facts.logRangeArtifactRefId) === undefined ||
        acquisitionRefs.find((ref) => ref.artifactRefId === facts.rawBoundaryArtifactRefId) === undefined
      ) {
        issues.add("process-anchor-mismatch", path);
        valid = false;
      }
      validateSidecarRefKinds(sidecar, [facts.logRangeArtifactRefId, facts.rawBoundaryArtifactRefId], acquisitionRefs, `${path}.canonicalFacts.rawRefs`);
    } else {
      storeCount += 1;
      const storeObserver = observerCertificates.find((candidate) => candidate.certificateId === sidecar.observerQualificationId);
      if (storeObserver === undefined || storeObserver.qualifiedLocatorKinds.length === 0) {
        issues.add("observer-qualification-mismatch", `${path}.observerQualificationId`);
        valid = false;
      }
      const facts = sidecar.canonicalFacts;
      if (facts.storeIdentityHash === ZERO_HASH) {
        issues.add("store-epoch-mismatch", `${path}.canonicalFacts.storeIdentityHash`);
        valid = false;
      }
      try {
        if (BigInt(facts.currentStoreEpoch) < 0n) {
          issues.add("store-epoch-mismatch", `${path}.canonicalFacts.currentStoreEpoch`);
          valid = false;
        }
      } catch {
        issues.add("store-epoch-mismatch", `${path}.canonicalFacts.currentStoreEpoch`);
        valid = false;
      }
      validateSidecarRefKinds(sidecar, [facts.rawArtifactRefId], acquisitionRefs, `${path}.canonicalFacts.rawArtifactRefId`);
      const storeRef = acquisitionRefs.find((ref) => ref.artifactRefId === facts.rawArtifactRefId);
      const storeClaim = claims.find((claim) => claim.artifactRefId === facts.rawArtifactRefId);
      const observedMirror = storeClaim?.observedMirror ?? null;
      const rawFacts = observedMirror === null
        ? null
        : safeDecode(
          () => decodeStoreEpochRawFacts(decodeArtifactBytes(observedMirror.bytes)),
          issues,
          "store-epoch-mismatch",
          `${path}.canonicalFacts.rawArtifactRefId.rawFacts`,
        );
      if (
        storeRef === undefined ||
        storeRef.immutableMirrorLocator.storeIdentityHash !== facts.storeIdentityHash ||
        rawFacts === null ||
        rawFacts.storeIdentityHash !== facts.storeIdentityHash ||
        rawFacts.currentStoreEpoch !== facts.currentStoreEpoch
      ) {
        issues.add("store-epoch-mismatch", `${path}.canonicalFacts.rawArtifactRefId`);
        valid = false;
      }
    }
  }
  if (acquisitionCount === 0 || acquisitionCount !== acquisitionReceipts.length || acquisitionReceiptIds.size !== acquisitionReceipts.length) {
    issues.add("process-observation-missing", "$.sidecarObservations.acquisition");
    valid = false;
  }
  if (targetCount === 0 || targetReceiptMap === null || targetCount !== targetReceiptMap.size || targetReceiptIds.size !== targetReceiptMap.size) {
    issues.add("process-observation-missing", "$.sidecarObservations.target");
    valid = false;
  }
  if (storeCount !== 1) {
    issues.add("store-epoch-mismatch", "$.sidecarObservations.store");
    valid = false;
  }
  return valid;
}

function buildCertificate(
  query: AcceptanceQueryV1 | null,
  snapshot: QualifiedFactSnapshotV1 | null,
  predicate: PredicateSpecV1 | null,
  registry: QualificationRegistrySnapshotV1 | null,
  verifier: VerifierQualificationCertificateV1 | null,
  authority: GateCoreAuthorityPinV1 | null,
  invocation: SignedObserverInvocationSnapshotV1 | null,
  observers: readonly ObserverQualificationCertificateV1[],
  verdict: GateVerdict,
  reasons: readonly GateReasonV1[],
): AcceptanceCertificateV1 {
  const orderedObserverIds = [...observers.map((value) => value.certificateId)].sort();
  return createAcceptanceCertificate({
    schemaVersion: 1,
    kind: "aloha.acceptance-certificate",
    acceptanceQueryId: query?.queryId ?? ZERO_HASH,
    subjectArtifactRoot: query?.subjectArtifactRoot ?? ZERO_HASH,
    claimSetRoot: snapshot?.claimSetRoot ?? ZERO_HASH,
    observationSetRoot: snapshot?.observationSetRoot ?? ZERO_HASH,
    rawArtifactSetRoot: snapshot?.rawArtifactSetRoot ?? ZERO_HASH,
    qualificationRegistryRoot: registry?.registryId ?? query?.qualificationRegistryRoot ?? ZERO_HASH,
    externalTrustAnchorRoot: authority?.externalQualification.expectedTrustAnchorRoot ?? ZERO_HASH,
    externalIssuerKeySetRoot: authority?.externalQualification.expectedIssuerKeySetRoot ?? ZERO_HASH,
    qualificationRegistryApprovalId: authority?.externalQualification.expectedRegistryApprovalId ?? ZERO_HASH,
    releaseAuthorityApprovalId: authority?.externalQualification.expectedReleaseAuthorityApprovalId ?? ZERO_HASH,
    authorityPinDigest: authority === null ? ZERO_HASH : computeGateCoreAuthorityPinDigest(authority),
    qualificationAudienceHash: authority?.externalQualification.expectedQualificationAudienceHash ?? ZERO_HASH,
    releaseRoleManifestRoot: authority?.externalQualification.expectedReleaseRoleManifestRoot ?? ZERO_HASH,
    candidateReleaseCommit: authority?.externalQualification.expectedCandidateReleaseCommit ?? ZERO_GIT_SHA,
    predicateSpecDigest: predicate?.specDigest ?? query?.predicateSpecDigest ?? ZERO_HASH,
    predicateProgramDescriptorDigest: authority?.predicateProgramDescriptorDigest ?? ZERO_HASH,
    oracleProgramDescriptorDigest: authority?.oracleProgramDescriptorDigest ?? ZERO_HASH,
    predicateCompositionLeafDigest: authority?.predicateCompositionLeafDigest ?? ZERO_HASH,
    predicateCompositionRootDigest: authority?.predicateCompositionRootDigest ?? ZERO_HASH,
    predicateImplementationClosureDigest: authority?.predicateImplementationClosureDigest ?? ZERO_HASH,
    predicateImplementationExportDigest: authority?.predicateImplementationExportDigest ?? ZERO_HASH,
    oracleImplementationClosureDigest: authority?.oracleImplementationClosureDigest ?? ZERO_HASH,
    oracleImplementationExportDigest: authority?.oracleImplementationExportDigest ?? ZERO_HASH,
    gateCoreImplementationClosureDigest: authority?.gateCoreImplementationClosureDigest ?? ZERO_HASH,
    gateCoreRuntimeClosureDigest: authority?.gateCoreRuntimeClosureDigest ?? ZERO_HASH,
    verifierQualificationId: verifier?.certificateId ?? ZERO_HASH,
    observerQualificationIds: orderedObserverIds,
    signedInvocationAttestationId: invocation?.attestationId ?? ZERO_HASH,
    invocationBindingSetRoot: invocation?.bindingSetRoot ?? ZERO_HASH,
    reasonSetRoot: reasonSetRoot(reasons),
    verdict,
  });
}

/**
 * The only acceptance authority.  It performs no reads, network calls,
 * process inspection or callbacks; every load-bearing fact arrives in the
 * frozen input envelope and is independently re-derived here.
 */
function evaluateGateCoreInternal(inputValue: unknown, authority: GateCoreAuthorityPinV1, composition: PredicateCompositionPortV1, nowUnixNs: string): GateCoreResultV1 {
  const issues = issueSink();
  let query: AcceptanceQueryV1 | null = null;
  let snapshot: QualifiedFactSnapshotV1 | null = null;
  let predicate: PredicateSpecV1 | null = null;
  let registry: QualificationRegistrySnapshotV1 | null = null;
  let invocation: SignedObserverInvocationSnapshotV1 | null = null;
  const authorityPin = authority === null
    ? null
    : safeDecode(() => decodeGateCoreAuthorityPin(authority, "$.authority"), issues, "registry-mismatch", "$.authority");
  const input = safeDecode(() => decodeGateCoreInput(inputValue, "$.input"), issues, "schema-invalid", "$.input");
  if (input === null) {
    const reasons = sortedReasons(issues.issues);
    const certificate = buildCertificate(null, null, authorityPin?.predicate ?? null, null, null, authorityPin, null, [], "invalid", reasons);
    return deepFreeze({ verdict: "invalid", certificate, reasons });
  }
  // Mirror byte bounds run before any certificate/registry/claim decoding or
  // content-byte allocation. A failed preflight is terminal for this input.
  if (!preflightInputMirrorBudget(input, issues)) {
    const reasons = sortedReasons(issues.issues);
    const certificate = buildCertificate(null, null, authorityPin?.predicate ?? null, null, null, authorityPin, null, [], "invalid", reasons);
    return deepFreeze({ verdict: "invalid", certificate, reasons });
  }
  const verifier = safeDecode(() => decodeVerifierCertificate(input.verifierCertificate), issues, "verifier-qualification-mismatch", "$.verifierCertificate");
  const observers: ObserverQualificationCertificateV1[] = [];
  for (const [index, value] of input.observerCertificates.entries()) {
    const observer = safeDecode(() => decodeObserverCertificate(value), issues, "observer-qualification-mismatch", `$.observerCertificates[${index}]`);
    if (observer !== null) observers.push(observer);
  }
  query = safeDecode(() => decodeAcceptanceQuery(input.query), issues, "snapshot-mismatch", "$.query");
  snapshot = safeDecode(() => decodeQualifiedFactSnapshot(input.snapshot), issues, "snapshot-mismatch", "$.snapshot");
  predicate = authorityPin?.predicate ?? null;
  const predicateBinding: PredicateCompositionBindingV1 | null = predicate === null
    ? null
    : composition.resolve(predicate.predicateId);
  const evaluator: PredicateEvaluatorV1 | null = predicateBinding?.evaluator ?? null;
  if (predicateBinding === null || evaluator === null || predicate === null) {
    issues.add("predicate-composition-mismatch", "$.authority.predicate.predicateId");
  } else {
    if (!sameJson(predicate, evaluator.predicateSpec) || predicateBinding.predicateSpecDigest !== evaluator.predicateSpec.specDigest) {
      issues.add("predicate-composition-mismatch", "$.authority.predicate");
    }
    if (predicateBinding.predicateId !== evaluator.predicateId || predicateBinding.predicateId !== predicate.predicateId) {
      issues.add("predicate-composition-mismatch", "$.authority.predicate.predicateId");
    }
    if (predicateBinding.adapterVersion !== evaluator.adapterVersion) {
      issues.add("predicate-composition-mismatch", "$.authority.predicate.adapterVersion");
    }
    if (predicateBinding.predicateProgramDescriptorDigest !== evaluator.predicateProgramDescriptorDigest) {
      issues.add("predicate-composition-mismatch", "$.authority.predicateProgramDescriptorDigest");
    }
    if (predicateBinding.oracleProgramDescriptorDigest !== evaluator.oracleProgramDescriptorDigest) {
      issues.add("predicate-composition-mismatch", "$.authority.oracleProgramDescriptorDigest");
    }
  }
  registry = safeDecode(() => decodeQualificationRegistry(input.registry), issues, "registry-mismatch", "$.registry");
  const registryFacts = safeDecode(() => decodeRegistryMembershipFacts(input.registryFacts, "$.registryFacts"), issues, "registry-material-mismatch", "$.registryFacts");
  const sidecarObservations = input.sidecarObservations.map((value, index) => safeDecode(() => decodeSidecarObservation(value, `$.sidecarObservations[${index}]`), issues, "observation-mismatch", `$.sidecarObservations[${index}]`)).filter((value): value is QualifiedSidecarObservationV1 => value !== null);
  invocation = safeDecode(() => decodeSignedObserverInvocationSnapshot(input.signedInvocationSnapshot), issues, "invocation-mismatch", "$.signedInvocationSnapshot");
  const normalizedInput: GateCoreInputV1 = {
    ...input,
    registryFacts: registryFacts ?? input.registryFacts,
    sidecarObservations,
    signedInvocationSnapshot: invocation ?? input.signedInvocationSnapshot,
  };
  if (query !== null && predicate !== null && query.predicateSpecDigest !== predicate.specDigest) issues.add("snapshot-mismatch", "$.query.predicateSpecDigest");
  if (query !== null && registry !== null && query.qualificationRegistryRoot !== registry.registryId) issues.add("registry-mismatch", "$.query.qualificationRegistryRoot");
  if (registry !== null) {
    if (registryFacts === null) issues.add("registry-material-mismatch", "$.registryFacts");
    else trustedIssuerFacts(registry, registryFacts, issues);
    if (
      authorityPin === null ||
      authorityPin.registry.expectedRegistryRoot !== registry.registryId ||
      authorityPin.registry.expectedGovernanceTrustAnchorHash !== registry.governanceTrustAnchorHash ||
      authorityPin.registry.expectedEpoch !== registry.epoch
    ) issues.add("registry-mismatch", "$.authority.registry");
  }
  if (authorityPin === null) {
    issues.add("registry-mismatch", "$.authority");
  } else {
    if (predicateBinding === null || authorityPin.predicateProgramDescriptorDigest !== predicateBinding.predicateProgramDescriptorDigest) {
      issues.add("predicate-composition-mismatch", "$.authority.predicateProgramDescriptorDigest");
    }
    if (predicateBinding === null || authorityPin.oracleProgramDescriptorDigest !== predicateBinding.oracleProgramDescriptorDigest) {
      issues.add("predicate-composition-mismatch", "$.authority.oracleProgramDescriptorDigest");
    }
    if (predicateBinding === null || authorityPin.predicateCompositionLeafDigest !== predicateBinding.compositionLeafDigest) {
      issues.add("predicate-composition-mismatch", "$.authority.predicateCompositionLeafDigest");
    }
    if (predicateBinding === null || authorityPin.predicateImplementationExportDigest !== predicateBinding.predicateImplementationExportDigest) {
      issues.add("predicate-composition-mismatch", "$.authority.predicateImplementationExportDigest");
    }
    if (predicateBinding === null || authorityPin.oracleImplementationExportDigest !== predicateBinding.oracleImplementationExportDigest) {
      issues.add("predicate-composition-mismatch", "$.authority.oracleImplementationExportDigest");
    }
    if (authorityPin.predicateCompositionRootDigest !== composition.rootDigest) {
      issues.add("predicate-composition-mismatch", "$.authority.predicateCompositionRootDigest");
    }
    if (authorityPin.verifierQualificationId === ZERO_HASH) {
      issues.add("verifier-qualification-missing", "$.authority.verifierQualificationId");
    }
  }
  if (
    authorityPin !== null &&
    registry !== null &&
    registryFacts !== null &&
    verifier !== null
  ) {
    if (
      registry.governanceTrustAnchorHash !== authorityPin.externalQualification.expectedTrustAnchorRoot ||
      authorityPin.registry.expectedGovernanceTrustAnchorHash !== authorityPin.externalQualification.expectedTrustAnchorRoot
    ) {
      issues.add("external-trust-anchor-mismatch", "$.registry.governanceTrustAnchorHash");
    }
    const external = verifyExternalQualificationV2({
      pin: authorityPin.externalQualification,
      evidence: input.externalQualification,
      registry,
      registryFacts,
      verifierCertificate: verifier,
      observerCertificates: observers,
      release: {
        authorityPinDigest: computeGateCoreAuthorityPinDigest(authorityPin),
        predicateCompositionRootDigest: authorityPin.predicateCompositionRootDigest,
        gateCoreRuntimeClosureDigest: authorityPin.gateCoreRuntimeClosureDigest,
        gateCoreImplementationClosureDigest: authorityPin.gateCoreImplementationClosureDigest,
        verifierQualificationId: authorityPin.verifierQualificationId,
        observerQualificationIds: observers.map((observer) => observer.certificateId).sort(),
      },
    });
    for (const issue of external.issues) issues.add(issue.code, issue.path);
  } else {
    issues.add("external-trust-anchor-mismatch", "$.externalQualification");
  }
  const storeSidecar = sidecarObservations.find((value): value is StoreEpochObservationEnvelopeV1 => value.kind === "aloha.store-epoch-observation");
  const artifactResult = registry === null || registryFacts === null || storeSidecar === undefined
    ? { refs: [], claims: [], policies: [], leases: [] }
    : validateArtifacts(normalizedInput, registry, storeSidecar.canonicalFacts, issues);
  const observations: QualifiedObservationEnvelopeV1[] = [];
  for (const [index, value] of input.observations.entries()) {
    const observation = safeDecode(() => decodeQualifiedObservation(value), issues, "observation-mismatch", `$.observations[${index}]`);
    if (observation !== null) observations.push(observation);
  }
  if (invocation !== null && query !== null && snapshot !== null && predicate !== null && verifier !== null && registry !== null && registryFacts !== null && authorityPin !== null) {
    const key = registryFacts.observerSigningKeys.find((candidate) => candidate.keyId === invocation!.keyId);
    if (key === undefined) issues.add("invocation-key-mismatch", "$.signedInvocationSnapshot.keyId");
    else {
      const ordinaryObserverQualificationIds = new Set<Hash>([
        ...observations.map((observation) => observation.observerQualificationId),
        ...sidecarObservations.map((observation) => observation.observerQualificationId),
      ]);
      const ordinaryRoleIds = new Set<string>([
        ...sidecarObservations.map((observation) => observation.roleId),
        ...observations.map((observation) => verifier.requiredObserverRoles.find((role) => role.observerQualificationId === observation.observerQualificationId)?.roleId).filter((role): role is string => role !== undefined),
      ]);
      invocationKey(key, invocation, registry, registryFacts, query, snapshot, predicate, verifier, observers, ordinaryObserverQualificationIds, ordinaryRoleIds, authorityPin, nowUnixNs, issues);
    }
  }
  validateObservationQualificationBindings(observations, predicate, verifier, observers, registry, issues);
  if (snapshot !== null && query !== null && snapshot.qualificationRegistryRoot !== query.qualificationRegistryRoot) issues.add("snapshot-mismatch", "$.snapshot.qualificationRegistryRoot");
  validateSidecarObservationBindings(sidecarObservations, observations, predicate, verifier, observers, registry, issues);
  const materialized = invocation === null
    ? { subjectArtifacts: [], subjectArtifactRefs: [], acquisitionArtifacts: [], acquisitionProductionReceipts: [], targetProductionReceipts: [], invocationRawArtifactRefIds: [] as Hash[] }
    : materializeInvocationArtifacts(normalizedInput, invocation, observations, artifactResult, issues);
  const lineage = query !== null && snapshot !== null ? validateObservationLineage(materialized.acquisitionArtifacts, materialized.acquisitionProductionReceipts, materialized.subjectArtifacts, materialized.targetProductionReceipts, query, snapshot, observations, sidecarObservations, artifactResult.refs, artifactResult.claims, materialized.invocationRawArtifactRefIds, issues) : { artifacts: [], receipts: [] };
  const subjectResult = query === null
    ? { artifacts: [], refs: [] }
    : validateSubjectArtifacts(materialized.subjectArtifacts, materialized.subjectArtifactRefs, query, materialized.targetProductionReceipts, lineage.artifacts, lineage.receipts, artifactResult.refs, issues);
  if (query !== null && registryFacts !== null && predicate !== null && verifier !== null && registry !== null) validateProcessAndStoreObservations(normalizedInput, query, sidecarObservations, lineage.receipts, subjectResult.artifacts, artifactResult.refs, materialized.targetProductionReceipts, artifactResult.claims, observers, predicate, verifier, registry, issues);
  if (evaluator !== null && predicate !== null && registry !== null && registryFacts !== null && verifier !== null) {
    if (input.observerCertificates.length !== predicate.requiredObserverRoles.length) {
      issues.add("observer-qualification-missing", "$.observerCertificates");
    }
    const roleIds = new Set(predicate.requiredObserverRoles.map((role) => role.roleId));
    for (const [index, role] of predicate.requiredObserverRoles.entries()) {
      const verifierRole = verifier.requiredObserverRoles.find((value) => value.roleId === role.roleId);
      const observer = observers.find((value) => value.certificateId === verifierRole?.observerQualificationId);
      if (verifierRole === undefined || observer === undefined || !roleIds.has(role.roleId)) {
        issues.add("observer-qualification-missing", `$.predicate.requiredObserverRoles[${index}]`);
      } else {
        validateObserverQualificationCertificate(observer, role, registry, registryFacts, issues, `$.observerCertificates.${role.roleId}`);
      }
    }
    if (verifier.requiredObserverRoles.length !== predicate.requiredObserverRoles.length || !sameJson(verifier.requiredObserverRoles.map(({ observerQualificationId: _id, ...role }) => role), predicate.requiredObserverRoles)) issues.add("verifier-qualification-mismatch", "$.verifierCertificate.requiredObserverRoles");
    if (!sameJson(verifier.observerQualificationIds, observers.map((value) => value.certificateId).sort())) issues.add("verifier-qualification-mismatch", "$.verifierCertificate.observerQualificationIds");
    if (authorityPin === null) issues.add("verifier-qualification-mismatch", "$.authority.predicateImplementationClosureDigest");
    else validateVerifierQualificationCertificate(verifier, predicate, registry, registryFacts, authorityPin, issues, "$.verifierCertificate");
  }
  if (query === null || snapshot === null || registry === null || predicate === null || verifier === null) {
    issues.add("predicate-observation-missing", "$.predicateFacts");
  }
  const invocationRawRefSet = new Set(materialized.invocationRawArtifactRefIds);
  const programVerdict = evaluator === null
    ? "invalid"
    : evaluator.evaluateLive({
      facts: input.predicateFacts,
      refs: artifactResult.refs.filter((ref) => !invocationRawRefSet.has(ref.artifactRefId)),
      claims: artifactResult.claims.filter((claim) => !invocationRawRefSet.has(claim.artifactRefId)),
      policies: artifactResult.policies.filter((policy) => artifactResult.refs.some((ref) => ref.resolverPolicyHash === policy.policyHash && !invocationRawRefSet.has(ref.artifactRefId))),
      leases: artifactResult.leases.filter((lease) => artifactResult.refs.some((ref) => ref.retentionLeaseReceiptId === lease.receiptId && !invocationRawRefSet.has(ref.artifactRefId))),
      observations,
    }, issues);
  const reasons = sortedReasons(issues.issues);
  const verdict = enforceEvaluatorVerdictContract(programVerdict, reasons);
  const certificate = buildCertificate(query, snapshot, predicate, registry, verifier, authorityPin, invocation, observers, verdict, reasons);
  return deepFreeze({ verdict, certificate, reasons });
}

/**
 * Generic runtime evaluator.  It is intentionally absent from the package
 * export map; the release wrapper supplies only the generated authority and
 * fixed composition, while the qualification path uses it with a trusted
 * test pin.  No predicate oracle or caller-selected authority reaches this
 * function through the package API.
 */
export function evaluateGateCoreRuntime(
  authorityPin: GateCoreAuthorityPinV1,
  untrustedInput: unknown,
  composition: PredicateCompositionPortV1,
  nowUnixNs: string,
): GateCoreResultV1 {
  try {
    return evaluateGateCoreInternal(untrustedInput, authorityPin, composition, nowUnixNs);
  } catch {
    // The boundary is pure and total: hostile/proxy input must become an
    // invalid result, never escape as an exception or partially computed pass.
    const reasons = Object.freeze([{ code: "invalid-input" as const, path: "$" }]);
    const certificate = buildCertificate(null, null, null, null, null, null, null, [], "invalid", reasons);
    return deepFreeze({ verdict: "invalid", certificate, reasons });
  }
}

/** Deterministic fail-closed result used while release authority is absent. */
export function createReleaseAuthorityUnavailableResult(): GateCoreResultV1 {
  const reasons = Object.freeze([
    { code: "release-authority-unavailable" as const, path: "$.releaseAuthority" },
  ]);
  const certificate = buildCertificate(null, null, null, null, null, null, null, [], "invalid", reasons);
  return deepFreeze({ verdict: "invalid", certificate, reasons });
}
