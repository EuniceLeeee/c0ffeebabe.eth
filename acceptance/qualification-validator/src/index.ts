import {
  decodeMembershipInput,
  decodeMembershipResult,
  decodeObserverCertificate,
  decodeObserverRole,
  decodePredicate,
  decodeQualificationRegistry,
  decodeVerifierCertificate,
  type CurrentRegistryMembershipInputV1,
  type CurrentRegistryMembershipResultV1,
  type Hash,
  type ObserverQualificationCertificateV1,
  type ObserverRoleSpecV1,
  type PredicateSpecV1,
  type QualificationRegistrySnapshotV1,
  type VerifierQualificationCertificateV1,
} from "../../../specs/qualification/src/index.ts";
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
  | "self-reported-verdict";

export interface QualificationIssue {
  readonly code: QualificationIssueCode;
  readonly path: string;
}

/** This package returns qualification facts only; it never grants production authority. */
export interface QualificationValidationResult {
  readonly valid: boolean;
  readonly authority: false;
  readonly issues: readonly QualificationIssue[];
}

export interface RegistryAuthorityPinV1 {
  readonly expectedRegistryRoot: Hash;
  readonly expectedGovernanceApprovalHash: Hash;
}

export interface CertificateMembershipProof {
  readonly input: CurrentRegistryMembershipInputV1;
  readonly result: CurrentRegistryMembershipResultV1;
}

function result(issues: QualificationIssue[]): QualificationValidationResult {
  return Object.freeze({ valid: issues.length === 0, authority: false as const, issues: Object.freeze([...issues]) });
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
  if (pin.expectedGovernanceApprovalHash !== registry.governanceApprovalHash) add(issues, "governance-mismatch", "$.governanceApprovalHash");
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
  if (certificate.predicateImplementationDigest === ("0x" + "0".repeat(64))) add(issues, "implementation-mismatch", "$.predicateImplementationDigest");
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
    if (!nested.valid || entry.certificate.verdict !== "qualified") add(issues, "observer-certificate-mismatch", `$.observerRoles.${entry.role.roleId}`);
  }
  if (certificate.verdict !== "qualified") add(issues, "self-reported-verdict", "$.verdict");
  else if (issues.length > 0) add(issues, "self-reported-verdict", "$.verdict");
  return result(issues);
}
