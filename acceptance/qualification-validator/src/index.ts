import {
  decodeMembershipInput,
  decodeMembershipResult,
  decodeObserverCertificate,
  decodeObserverSigningKey,
  decodeObserverRole,
  decodePredicate,
  decodeQualificationRegistry,
  decodeVerifierCertificate,
  hashObserverSigningKeySetRoot,
  hashRevokedObserverKeyIdsRoot,
  type CurrentRegistryMembershipInputV1,
  type CurrentRegistryMembershipResultV1,
  type Hash,
  type ObserverQualificationCertificateV1,
  type ObserverSigningKeyV1,
  type ObserverRoleSpecV1,
  type PredicateSpecV1,
  type QualificationRegistrySnapshotV1,
  type VerifierQualificationCertificateV1,
} from "../../../specs/qualification/src/index.ts";
import {
  decodeSignedObserverInvocationSnapshot,
  recomputeSignedObserverInvocationSnapshotId,
  recomputeSignedObserverInvocationSnapshotPayloadHash,
  type SignedObserverInvocationSnapshotV1,
} from "../../../specs/qualified-facts/src/index.ts";
import { encodeCanonicalJson, hashDomain } from "../../../packages/canonical-codec/src/index.ts";

export type QualificationIssueCode =
  | "malformed"
  | "identity-mismatch"
  | "stale-registry"
  | "governance-mismatch"
  | "revoked"
  | "untrusted-issuer"
  | "missing-membership"
  | "payload-mismatch"
  | "role-mismatch"
  | "predicate-mismatch"
  | "spec-mismatch"
  | "observer-role-set-mismatch"
  | "mutation-coverage-mismatch"
  | "oracle-coverage-mismatch"
  | "locator-coverage-mismatch"
  | "observer-certificate-mismatch"
  | "implementation-mismatch"
  | "observer-key-mismatch"
  | "invocation-mismatch"
  | "self-reported-verdict"
  | "external-signature-invalid"
  | "external-key-mismatch"
  | "external-root-mismatch"
  | "external-audience-mismatch"
  | "external-epoch-mismatch"
  | "external-membership-mismatch"
  | "external-downgrade";

export interface QualificationIssue {
  readonly code: QualificationIssueCode;
  readonly path: string;
}

/**
 * This package reports whether supplied qualification materials are mutually
 * consistent. Only GateCore may join them to independent corpus/oracle facts
 * and current authority; this result deliberately has no `valid` verdict.
 */
export interface QualificationValidationResult {
  readonly factsConsistent: boolean;
  readonly authority: false;
  /** This package never verifies Ed25519 signatures. */
  readonly signatureVerified: false;
  readonly issues: readonly QualificationIssue[];
}

export interface RegistryAuthorityPinV1 {
  readonly expectedRegistryRoot: Hash;
  readonly expectedGovernanceTrustAnchorHash: Hash;
}

export interface CertificateMembershipProof {
  readonly input: CurrentRegistryMembershipInputV1;
  readonly result: CurrentRegistryMembershipResultV1;
}

function result(issues: QualificationIssue[]): QualificationValidationResult {
  return Object.freeze({ factsConsistent: issues.length === 0, authority: false as const, signatureVerified: false as const, issues: Object.freeze([...issues]) });
}

function add(issues: QualificationIssue[], code: QualificationIssueCode, path: string): void {
  issues.push(Object.freeze({ code, path }));
}

function decode<T>(fn: () => T, issues: QualificationIssue[], path: string): T | null {
  try {
    return fn();
  } catch {
    add(issues, "malformed", path);
    return null;
  }
}

function checkPin(
  registry: QualificationRegistrySnapshotV1,
  pin: RegistryAuthorityPinV1,
  issues: QualificationIssue[],
): void {
  if (registry.registryId === undefined || pin.expectedRegistryRoot !== registry.registryId) add(issues, "stale-registry", "$.registryRoot");
  if (pin.expectedGovernanceTrustAnchorHash !== registry.governanceTrustAnchorHash) add(issues, "governance-mismatch", "$.governanceTrustAnchorHash");
}

function checkProof(
  registry: QualificationRegistrySnapshotV1,
  certificate: { readonly certificateId: Hash; readonly payloadHash: Hash; readonly issuerId: string; readonly issuedAtRegistryEpoch: string },
  kind: "observer" | "verifier",
  proof: CertificateMembershipProof | undefined,
  pin: RegistryAuthorityPinV1,
  issues: QualificationIssue[],
): void {
  if (proof === undefined) {
    add(issues, "missing-membership", "$.membershipProof");
    return;
  }
  const input = decode(() => decodeMembershipInput(proof.input), issues, "$.membershipProof.input");
  const membership = decode(() => decodeMembershipResult(proof.result), issues, "$.membershipProof.result");
  if (input === null || membership === null) return;
  if (input.registryRoot !== pin.expectedRegistryRoot || membership.registryRoot !== pin.expectedRegistryRoot) add(issues, "stale-registry", "$.membershipProof.registryRoot");
  if (input.registryEpoch !== registry.epoch || membership.registryEpoch !== registry.epoch || BigInt(certificate.issuedAtRegistryEpoch) > BigInt(registry.epoch)) add(issues, "stale-registry", "$.membershipProof.registryEpoch");
  const trustedRoot = hashDomain("aloha/trusted-issuer-set/v1", input.trustedIssuerIds);
  const certificateRoot = hashDomain("aloha/certificate-set/v1", input.certificateMemberships);
  const revokedRoot = hashDomain("aloha/revoked-certificate-set/v1", input.revokedCertificateIds);
  if (trustedRoot !== registry.trustedIssuerSetRoot) add(issues, "identity-mismatch", "$.membershipProof.trustedIssuerIds");
  if (certificateRoot !== registry.certificateSetRoot) add(issues, "identity-mismatch", "$.membershipProof.certificateMemberships");
  if (revokedRoot !== registry.revokedCertificateIdsRoot) add(issues, "identity-mismatch", "$.membershipProof.revokedCertificateIds");
  checkObserverKeyRoots(registry, input, issues, "$.membershipProof");
  if (input.certificateKind !== kind || input.certificateId !== certificate.certificateId || input.certificatePayloadHash !== certificate.payloadHash || input.issuerId !== certificate.issuerId) add(issues, "identity-mismatch", "$.membershipProof.input");
  if (membership.inputId !== input.inputId || membership.certificateKind !== input.certificateKind || membership.certificateId !== input.certificateId || membership.certificatePayloadHash !== input.certificatePayloadHash || membership.issuerId !== input.issuerId) add(issues, "identity-mismatch", "$.membershipProof.result");
  const material = input.certificateMemberships.find((entry) => entry.certificateKind === kind && entry.certificateId === certificate.certificateId);
  const materialStatus = input.revokedCertificateIds.includes(certificate.certificateId)
    ? "revoked"
    : material === undefined
      ? "missing"
      : !input.trustedIssuerIds.includes(material.issuerId)
        ? "untrusted-issuer"
        : material.certificatePayloadHash !== certificate.payloadHash
          ? "payload-mismatch"
          : "member";
  if (material !== undefined && material.issuerId !== certificate.issuerId) add(issues, "identity-mismatch", "$.membershipProof.certificateIssuerId");
  if (membership.status !== materialStatus) add(issues, "identity-mismatch", "$.membershipProof.result.status");
  if (materialStatus !== "member") add(issues, materialStatus === "revoked" ? "revoked" : materialStatus === "untrusted-issuer" ? "untrusted-issuer" : materialStatus === "payload-mismatch" ? "payload-mismatch" : "missing-membership", "$.membershipProof.result.status");
}

function exactMutations(
  declared: readonly string[],
  rejected: readonly string[],
  expected: readonly string[],
  issues: QualificationIssue[],
  path: string,
): void {
  if (encodeCanonicalJson(declared) !== encodeCanonicalJson(expected) || encodeCanonicalJson(rejected) !== encodeCanonicalJson(expected) || encodeCanonicalJson(declared) !== encodeCanonicalJson(rejected)) add(issues, "mutation-coverage-mismatch", path);
}

function roleMatches(left: ObserverRoleSpecV1, right: ObserverRoleSpecV1): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function checkObserverKeyRoots(
  registry: QualificationRegistrySnapshotV1,
  input: CurrentRegistryMembershipInputV1,
  issues: QualificationIssue[],
  path: string,
): void {
  const keyIds = input.observerSigningKeys.map((key) => key.keyId);
  if (hashObserverSigningKeySetRoot(keyIds) !== registry.observerKeySetRoot) {
    add(issues, "observer-key-mismatch", `${path}.observerSigningKeys`);
  }
  if (hashRevokedObserverKeyIdsRoot(input.revokedObserverKeyIds) !== registry.revokedObserverKeyIdsRoot) {
    add(issues, "observer-key-mismatch", `${path}.revokedObserverKeyIds`);
  }
}

function checkObserverKeyEpoch(
  registry: QualificationRegistrySnapshotV1,
  key: ObserverSigningKeyV1,
  issues: QualificationIssue[],
  path: string,
): void {
  const epoch = BigInt(registry.epoch);
  if (epoch < BigInt(key.validFromRegistryEpoch) || epoch > BigInt(key.validThroughRegistryEpoch)) {
    add(issues, "stale-registry", `${path}.validity`);
  }
}

/**
 * Validates key structure, registry key-set roots and the current epoch only.
 * This is deliberately fact-only: it never treats an observer key as an
 * oracle or produces an authority verdict.
 */
export function validateObserverSigningKey(
  registryInput: QualificationRegistrySnapshotV1,
  keyInput: ObserverSigningKeyV1,
  membershipInput: CurrentRegistryMembershipInputV1,
  pin: RegistryAuthorityPinV1,
): QualificationValidationResult {
  const issues: QualificationIssue[] = [];
  const registry = decode(() => decodeQualificationRegistry(registryInput), issues, "$.registry");
  const key = decode(() => decodeObserverSigningKey(keyInput), issues, "$.observerSigningKey");
  const membership = decode(() => decodeMembershipInput(membershipInput), issues, "$.membership");
  if (registry === null || key === null || membership === null) return result(issues);
  checkPin(registry, pin, issues);
  if (membership.registryRoot !== pin.expectedRegistryRoot || membership.registryRoot !== registry.registryId) add(issues, "stale-registry", "$.membership.registryRoot");
  if (membership.registryEpoch !== registry.epoch) add(issues, "stale-registry", "$.membership.registryEpoch");
  checkObserverKeyRoots(registry, membership, issues, "$.membership");
  checkObserverKeyEpoch(registry, key, issues, "$.observerSigningKey");
  const material = membership.observerSigningKeys.find((entry) => entry.keyId === key.keyId);
  if (material === undefined || encodeCanonicalJson(material) !== encodeCanonicalJson(key)) add(issues, "observer-key-mismatch", "$.observerSigningKey.membership");
  if (membership.revokedObserverKeyIds.includes(key.keyId)) add(issues, "revoked", "$.observerSigningKey.keyId");
  const observerCertificate = membership.certificateMemberships.find(
    (entry) => entry.certificateKind === "observer" && entry.certificateId === key.observerQualificationId,
  );
  if (observerCertificate === undefined || membership.revokedCertificateIds.includes(key.observerQualificationId)) {
    add(issues, "missing-membership", "$.observerSigningKey.observerQualificationId");
  }
  return result(issues);
}

/** Validates an invocation's unsigned bindings; it never verifies its Ed25519 signature. */
export function validateUnsignedInvocationBindings(
  registryInput: QualificationRegistrySnapshotV1,
  snapshotInput: SignedObserverInvocationSnapshotV1,
  keyInput: ObserverSigningKeyV1,
  membershipInput: CurrentRegistryMembershipInputV1,
  pin: RegistryAuthorityPinV1,
): QualificationValidationResult {
  const issues: QualificationIssue[] = [];
  const registry = decode(() => decodeQualificationRegistry(registryInput), issues, "$.registry");
  const snapshot = decode(() => decodeSignedObserverInvocationSnapshot(snapshotInput), issues, "$.snapshot");
  const key = decode(() => decodeObserverSigningKey(keyInput), issues, "$.observerSigningKey");
  const membership = decode(() => decodeMembershipInput(membershipInput), issues, "$.membership");
  if (registry === null || snapshot === null || key === null || membership === null) return result(issues);
  checkPin(registry, pin, issues);
  if (snapshot.registryRoot !== registry.registryId || snapshot.registryRoot !== pin.expectedRegistryRoot) add(issues, "stale-registry", "$.snapshot.registryRoot");
  if (snapshot.registryEpoch !== registry.epoch) add(issues, "stale-registry", "$.snapshot.registryEpoch");
  if (snapshot.keyId !== key.keyId || snapshot.observerQualificationId !== key.observerQualificationId || snapshot.roleId !== key.roleId || snapshot.audienceHash !== key.audienceHash) {
    add(issues, "invocation-mismatch", "$.snapshot.observerKey");
  }
  if (recomputeSignedObserverInvocationSnapshotPayloadHash(snapshot) !== snapshot.payloadHash || recomputeSignedObserverInvocationSnapshotId(snapshot) !== snapshot.attestationId) {
    add(issues, "invocation-mismatch", "$.snapshot.attestationId");
  }
  const keyResult = validateObserverSigningKey(registry, key, membership, pin);
  for (const issue of keyResult.issues) add(issues, issue.code, `$.observerSigningKey${issue.path === "$" ? "" : issue.path.slice(1)}`);
  return result(issues);
}

export function validateCurrentRegistryMembership(
  registryInput: QualificationRegistrySnapshotV1,
  inputInput: CurrentRegistryMembershipInputV1,
  resultInput: CurrentRegistryMembershipResultV1,
  pin: RegistryAuthorityPinV1,
): QualificationValidationResult {
  const issues: QualificationIssue[] = [];
  const registry = decode(() => decodeQualificationRegistry(registryInput), issues, "$.registry");
  const input = decode(() => decodeMembershipInput(inputInput), issues, "$.input");
  const membership = decode(() => decodeMembershipResult(resultInput), issues, "$.result");
  if (registry === null || input === null || membership === null) return result(issues);
  checkPin(registry, pin, issues);
  if (input.registryRoot !== pin.expectedRegistryRoot || membership.registryRoot !== pin.expectedRegistryRoot) add(issues, "stale-registry", "$.registryRoot");
  if (input.registryEpoch !== registry.epoch || membership.registryEpoch !== registry.epoch) add(issues, "stale-registry", "$.registryEpoch");
  if (membership.inputId !== input.inputId || membership.registryEpoch !== input.registryEpoch || membership.certificateId !== input.certificateId || membership.certificatePayloadHash !== input.certificatePayloadHash) add(issues, "identity-mismatch", "$.result");
  if (membership.registryRoot !== input.registryRoot || membership.certificateKind !== input.certificateKind || membership.issuerId !== input.issuerId) add(issues, "identity-mismatch", "$.result");
  if (hashDomain("aloha/trusted-issuer-set/v1", input.trustedIssuerIds) !== registry.trustedIssuerSetRoot) add(issues, "identity-mismatch", "$.trustedIssuerIds");
  if (hashDomain("aloha/certificate-set/v1", input.certificateMemberships) !== registry.certificateSetRoot) add(issues, "identity-mismatch", "$.certificateMemberships");
  if (hashDomain("aloha/revoked-certificate-set/v1", input.revokedCertificateIds) !== registry.revokedCertificateIdsRoot) add(issues, "identity-mismatch", "$.revokedCertificateIds");
  checkObserverKeyRoots(registry, input, issues, "$");
  const material = input.certificateMemberships.find((entry) => entry.certificateKind === input.certificateKind && entry.certificateId === input.certificateId);
  const expectedStatus = input.revokedCertificateIds.includes(input.certificateId)
    ? "revoked"
    : material === undefined
      ? "missing"
      : !input.trustedIssuerIds.includes(material.issuerId)
        ? "untrusted-issuer"
        : material.certificatePayloadHash !== input.certificatePayloadHash
          ? "payload-mismatch"
          : "member";
  if (material !== undefined && material.issuerId !== input.issuerId) add(issues, "identity-mismatch", "$.issuerId");
  if (membership.status !== expectedStatus) add(issues, "identity-mismatch", "$.result.status");
  if (expectedStatus !== "member") add(issues, expectedStatus === "revoked" ? "revoked" : expectedStatus === "untrusted-issuer" ? "untrusted-issuer" : expectedStatus === "payload-mismatch" ? "payload-mismatch" : "missing-membership", "$.result.status");
  return result(issues);
}

export function validateObserverQualificationCertificate(
  registryInput: QualificationRegistrySnapshotV1,
  roleInput: ObserverRoleSpecV1,
  certificateInput: ObserverQualificationCertificateV1,
  membershipProof: CertificateMembershipProof | undefined,
  pin: RegistryAuthorityPinV1,
): QualificationValidationResult {
  const issues: QualificationIssue[] = [];
  const registry = decode(() => decodeQualificationRegistry(registryInput), issues, "$.registry");
  const role = decode(() => decodeObserverRole(roleInput), issues, "$.role");
  const certificate = decode(() => decodeObserverCertificate(certificateInput), issues, "$.certificate");
  if (registry === null || role === null || certificate === null) return result(issues);
  checkPin(registry, pin, issues);
  checkProof(registry, certificate, "observer", membershipProof, pin, issues);
  if (certificate.qualificationSpecDigest !== role.observerQualificationSpecDigest) add(issues, "spec-mismatch", "$.qualificationSpecDigest");
  if (encodeCanonicalJson(certificate.observedSchemaIds) !== encodeCanonicalJson([role.observationSchema])) add(issues, "spec-mismatch", "$.observedSchemaIds");
  if (certificate.qualifiedLocatorKinds.length === 0) add(issues, "locator-coverage-mismatch", "$.qualifiedLocatorKinds");
  if (certificate.observerImplementationDigest === ("0x" + "0".repeat(64))) add(issues, "implementation-mismatch", "$.observerImplementationDigest");
  if (certificate.anchorValidationMethodDigest === ("0x" + "0".repeat(64))) add(issues, "implementation-mismatch", "$.anchorValidationMethodDigest");
  if (certificate.positiveCaseRoot === ("0x" + "0".repeat(64)) || certificate.negativeCaseRoot === ("0x" + "0".repeat(64)) || certificate.invalidCaseRoot === ("0x" + "0".repeat(64)) || certificate.independentOracleCaseRoot === ("0x" + "0".repeat(64))) add(issues, "oracle-coverage-mismatch", "$.caseRoots");
  exactMutations(certificate.declaredCriticalMutationIds, certificate.rejectedOrInvalidMutationIds, role.requiredCriticalMutationIds, issues, "$.mutationIds");
  if (BigInt(certificate.independentOracleCaseCount) < BigInt(role.minimumIndependentOracleCases)) add(issues, "oracle-coverage-mismatch", "$.independentOracleCaseCount");
  if (certificate.verdict !== "qualified") add(issues, "self-reported-verdict", "$.verdict");
  else if (issues.length > 0) add(issues, "self-reported-verdict", "$.verdict");
  return result(issues);
}

export function validateVerifierQualificationCertificate(
  registryInput: QualificationRegistrySnapshotV1,
  predicateInput: PredicateSpecV1,
  certificateInput: VerifierQualificationCertificateV1,
  observerInputs: readonly { readonly role: ObserverRoleSpecV1; readonly certificate: ObserverQualificationCertificateV1; readonly membershipProof?: CertificateMembershipProof }[],
  membershipProof: CertificateMembershipProof | undefined,
  pin: RegistryAuthorityPinV1,
): QualificationValidationResult {
  const issues: QualificationIssue[] = [];
  const registry = decode(() => decodeQualificationRegistry(registryInput), issues, "$.registry");
  const predicate = decode(() => decodePredicate(predicateInput), issues, "$.predicate");
  const certificate = decode(() => decodeVerifierCertificate(certificateInput), issues, "$.certificate");
  if (registry === null || predicate === null || certificate === null) return result(issues);
  checkPin(registry, pin, issues);
  checkProof(registry, certificate, "verifier", membershipProof, pin, issues);
  if (certificate.predicateSpecDigest !== predicate.specDigest) add(issues, "predicate-mismatch", "$.predicateSpecDigest");
  const zeroHash = "0x" + "0".repeat(64);
  for (const field of [
    "predicateImplementationDigest",
    "predicateImplementationExportDigest",
    "predicateProgramDescriptorDigest",
    "oracleProgramDescriptorDigest",
    "oracleImplementationClosureDigest",
    "oracleImplementationExportDigest",
    "predicateCompositionLeafDigest",
    "gateCoreImplementationClosureDigest",
  ] as const) {
    if (certificate[field] === zeroHash) add(issues, "implementation-mismatch", `$.${field}`);
  }
  if (certificate.qualificationSpecDigest !== predicate.verifierQualificationSpecDigest) add(issues, "spec-mismatch", "$.qualificationSpecDigest");
  if (encodeCanonicalJson(certificate.requiredObserverRoles.map(({ observerQualificationId: _id, ...role }) => role)) !== encodeCanonicalJson(predicate.requiredObserverRoles)) add(issues, "observer-role-set-mismatch", "$.requiredObserverRoles");
  if (encodeCanonicalJson(certificate.observerQualificationIds) !== encodeCanonicalJson(observerInputs.map(({ certificate: observer }) => observer.certificateId).sort())) add(issues, "observer-role-set-mismatch", "$.observerQualificationIds");
  exactMutations(certificate.declaredCriticalMutationIds, certificate.rejectedOrInvalidMutationIds, predicate.criticalMutationIds, issues, "$.mutationIds");
  if (BigInt(certificate.independentOracleCaseCount) <= 0n) add(issues, "oracle-coverage-mismatch", "$.independentOracleCaseCount");
  if (certificate.caseSetRoot === ("0x" + "0".repeat(64)) || certificate.independentOracleCaseRoot === ("0x" + "0".repeat(64)) || certificate.counterexampleRoot === ("0x" + "0".repeat(64))) add(issues, "oracle-coverage-mismatch", "$.caseRoots");
  for (const entry of observerInputs) {
    const expected = predicate.requiredObserverRoles.find((role) => role.roleId === entry.role.roleId);
    if (expected === undefined || !roleMatches(expected, entry.role)) add(issues, "role-mismatch", `$.observerRoles.${entry.role.roleId}`);
    const declaredRole = certificate.requiredObserverRoles.find((role) => role.roleId === entry.role.roleId);
    if (declaredRole === undefined || declaredRole.observerQualificationId !== entry.certificate.certificateId) add(issues, "observer-certificate-mismatch", `$.observerRoles.${entry.role.roleId}.observerQualificationId`);
    const nested = validateObserverQualificationCertificate(registry, entry.role, entry.certificate, entry.membershipProof, pin);
    if (!nested.factsConsistent || entry.certificate.verdict !== "qualified") add(issues, "observer-certificate-mismatch", `$.observerRoles.${entry.role.roleId}`);
  }
  if (certificate.verdict !== "qualified") add(issues, "self-reported-verdict", "$.verdict");
  else if (issues.length > 0) add(issues, "self-reported-verdict", "$.verdict");
  return result(issues);
}

export * from "./external-v2.ts";
