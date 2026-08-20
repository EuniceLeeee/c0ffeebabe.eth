import assert from "node:assert/strict";
import test from "node:test";
import {
  createMembershipInput,
  createMembershipResult,
  createObserverQualificationCertificate,
  createObserverRoleSpec,
  createPredicateSpec,
  createQualificationRegistry,
  createVerifierQualificationCertificate,
  type Hash,
} from "../../../specs/qualification/src/index.ts";
import {
  validateCurrentRegistryMembership,
  validateObserverQualificationCertificate,
  validateVerifierQualificationCertificate,
} from "../src/index.ts";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";

const h = (digit: string): Hash => (`0x${digit.repeat(64)}`) as Hash;
const role = createObserverRoleSpec({
  roleId: "observer",
  observationSchema: { id: "facts", version: "1.0.0", schemaHash: h("1") },
  anchorPolicyDigest: h("2"),
  observerQualificationSpecDigest: h("3"),
  requiredCriticalMutationIds: ["m1"],
  minimumIndependentOracleCases: "1",
});
const predicate = createPredicateSpec({
  predicateId: "predicate",
  version: "1.0.0",
  claimSchemaRefs: [{ id: "claim", version: "1.0.0", schemaHash: h("4") }],
  observationSchemaRefs: [role.observationSchema],
  requiredObserverRoles: [role],
  observerRoleSetHash: hashDomain("aloha/observer-role-set/v1", [role]),
  passRuleDigest: h("5"),
  failRuleDigest: h("6"),
  invalidRuleDigest: h("7"),
  anchorPolicyDigest: h("8"),
  tolerancePolicyDigest: h("9"),
  forbiddenProducerSelectors: [],
  criticalMutationIds: ["m1"],
  criticalMutationSetHash: hashDomain("aloha/critical-mutation-set/v1", ["m1"]),
  independentOracleKinds: ["chain"],
  verifierQualificationSpecDigest: h("a"),
});
const registryEpoch = "1";

const observer = createObserverQualificationCertificate({
  schemaVersion: 1,
  kind: "aloha.observer-qualification",
  qualificationSpecDigest: role.observerQualificationSpecDigest,
  observerImplementationDigest: h("f"),
  observedSchemaIds: [role.observationSchema],
  qualifiedLocatorKinds: ["chain-object"],
  anchorValidationMethodDigest: h("1"),
  positiveCaseRoot: h("2"),
  negativeCaseRoot: h("3"),
  invalidCaseRoot: h("4"),
  declaredCriticalMutationIds: role.requiredCriticalMutationIds,
  rejectedOrInvalidMutationIds: role.requiredCriticalMutationIds,
  independentOracleCaseRoot: h("5"),
  independentOracleCaseCount: "1",
  issuerId: "trusted",
  issuedAtRegistryEpoch: registryEpoch,
  verdict: "qualified",
});
const verifier = createVerifierQualificationCertificate({
  schemaVersion: 1,
  kind: "aloha.verifier-qualification",
  qualificationSpecDigest: predicate.verifierQualificationSpecDigest,
  predicateSpecDigest: predicate.specDigest,
  predicateImplementationDigest: h("7"),
  observerQualificationIds: [observer.certificateId],
  requiredObserverRoles: [{ ...role, observerQualificationId: observer.certificateId }],
  caseSetRoot: h("8"),
  declaredCriticalMutationIds: predicate.criticalMutationIds,
  rejectedOrInvalidMutationIds: predicate.criticalMutationIds,
  independentOracleCaseRoot: h("9"),
  independentOracleCaseCount: "1",
  oldReferenceCaseCount: "0",
  counterexampleRoot: h("a"),
  issuerId: "trusted",
  issuedAtRegistryEpoch: registryEpoch,
  verdict: "qualified",
});

const membershipMaterial = [
  { certificateKind: "observer" as const, certificateId: observer.certificateId, certificatePayloadHash: observer.payloadHash, issuerId: observer.issuerId },
  { certificateKind: "verifier" as const, certificateId: verifier.certificateId, certificatePayloadHash: verifier.payloadHash, issuerId: verifier.issuerId },
].sort((left, right) => left.certificateId.localeCompare(right.certificateId));
const registry = createQualificationRegistry({
  schemaVersion: 1,
  kind: "aloha.qualification-registry",
  epoch: registryEpoch,
  trustedIssuerSetRoot: hashDomain("aloha/trusted-issuer-set/v1", ["trusted"]),
  certificateSetRoot: hashDomain("aloha/certificate-set/v1", membershipMaterial),
  revokedCertificateIdsRoot: hashDomain("aloha/revoked-certificate-set/v1", []),
  previousRegistryRoot: null,
  governanceApprovalHash: h("e"),
});
const pin = { expectedRegistryRoot: registry.registryId, expectedGovernanceApprovalHash: registry.governanceApprovalHash } as const;

function proof(kind: "observer" | "verifier", certificate: { certificateId: Hash; payloadHash: Hash; issuerId: string }) {
  const input = createMembershipInput({
    registryRoot: registry.registryId,
    registryEpoch: registry.epoch,
    certificateKind: kind,
    certificateId: certificate.certificateId,
    certificatePayloadHash: certificate.payloadHash,
    issuerId: certificate.issuerId,
    trustedIssuerIds: ["trusted"],
    certificateMemberships: membershipMaterial,
    revokedCertificateIds: [],
  });
  return {
    input,
    result: createMembershipResult({
      inputId: input.inputId,
      registryRoot: registry.registryId,
      registryEpoch: registry.epoch,
      certificateKind: kind,
      certificateId: certificate.certificateId,
      certificatePayloadHash: certificate.payloadHash,
      issuerId: certificate.issuerId,
      status: "member",
    }),
  };
}

test("validator is fact-only and does not promote self-reported verdict", () => {
  const observerResult = validateObserverQualificationCertificate(registry, role, observer, proof("observer", observer), pin);
  assert.equal(observerResult.valid, true);
  assert.equal(observerResult.authority, false);
  const verifierResult = validateVerifierQualificationCertificate(
    registry,
    predicate,
    verifier,
    [{ role, certificate: observer, membershipProof: proof("observer", observer) }],
    proof("verifier", verifier),
    pin,
  );
  assert.equal(verifierResult.valid, true);
  assert.equal(verifierResult.authority, false);
});

test("wrong role schema, missing oracle, mutation drift, stale or revoked facts invalidate", () => {
  const wrongRole = createObserverRoleSpec({ ...role, observationSchema: { ...role.observationSchema, schemaHash: h("d") } });
  const wrong = validateObserverQualificationCertificate(registry, wrongRole, observer, proof("observer", observer), pin);
  assert.equal(wrong.valid, false);

  assert.throws(() => createObserverQualificationCertificate({ ...observer, rejectedOrInvalidMutationIds: [] }));

  const staleProof = proof("observer", observer);
  const stale = validateObserverQualificationCertificate(registry, role, observer, { ...staleProof, result: { ...staleProof.result, registryEpoch: "2" } }, pin);
  assert.equal(stale.valid, false);

  const revoked = validateObserverQualificationCertificate(registry, role, observer, { ...proof("observer", observer), result: { ...proof("observer", observer).result, status: "revoked" } }, pin);
  assert.equal(revoked.valid, false);
});

test("registry governance pin and certificate root splice are external facts", () => {
  const wrongPin = validateObserverQualificationCertificate(registry, role, observer, proof("observer", observer), { ...pin, expectedRegistryRoot: h("f") });
  assert.equal(wrongPin.valid, false);
  const result = validateCurrentRegistryMembership(registry, proof("observer", observer).input, proof("observer", observer).result, pin);
  assert.equal(result.valid, true);
  assert.equal(result.authority, false);
  const originalInput = proof("observer", observer).input;
  const { inputId: _inputId, payloadHash: _inputPayloadHash, ...originalInputPayload } = originalInput;
  const tamperedInput = createMembershipInput({ ...originalInputPayload, trustedIssuerIds: ["attacker"] });
  const originalResult = proof("observer", observer).result;
  const { resultId: _resultId, payloadHash: _resultPayloadHash, ...originalResultPayload } = originalResult;
  const tamperedResult = createMembershipResult({ ...originalResultPayload, inputId: tamperedInput.inputId });
  const tampered = validateCurrentRegistryMembership(registry, tamperedInput, tamperedResult, pin);
  assert.equal(tampered.valid, false);

  const { inputId: _epochInputId, payloadHash: _epochPayloadHash, ...epochInputPayload } = originalInput;
  const wrongEpochInput = createMembershipInput({ ...epochInputPayload, registryEpoch: "2" });
  const wrongEpochResult = createMembershipResult({
    ...originalResultPayload,
    inputId: wrongEpochInput.inputId,
    registryEpoch: "2",
  });
  assert.equal(validateCurrentRegistryMembership(registry, wrongEpochInput, wrongEpochResult, pin).valid, false);

  const wrongIssuerInput = createMembershipInput({ ...epochInputPayload, issuerId: "attacker" });
  const wrongIssuerResult = createMembershipResult({
    ...originalResultPayload,
    inputId: wrongIssuerInput.inputId,
    issuerId: "attacker",
  });
  assert.equal(validateCurrentRegistryMembership(registry, wrongIssuerInput, wrongIssuerResult, pin).valid, false);
});

test("a certificate issued in an earlier epoch remains current only through exact current membership", () => {
  const nextRegistry = createQualificationRegistry({
    schemaVersion: 1,
    kind: "aloha.qualification-registry",
    epoch: "2",
    trustedIssuerSetRoot: registry.trustedIssuerSetRoot,
    certificateSetRoot: registry.certificateSetRoot,
    revokedCertificateIdsRoot: registry.revokedCertificateIdsRoot,
    previousRegistryRoot: registry.registryId,
    governanceApprovalHash: h("d"),
  });
  const nextPin = {
    expectedRegistryRoot: nextRegistry.registryId,
    expectedGovernanceApprovalHash: nextRegistry.governanceApprovalHash,
  } as const;
  const input = createMembershipInput({
    registryRoot: nextRegistry.registryId,
    registryEpoch: nextRegistry.epoch,
    certificateKind: "observer",
    certificateId: observer.certificateId,
    certificatePayloadHash: observer.payloadHash,
    issuerId: observer.issuerId,
    trustedIssuerIds: ["trusted"],
    certificateMemberships: membershipMaterial,
    revokedCertificateIds: [],
  });
  const result = createMembershipResult({
    inputId: input.inputId,
    registryRoot: nextRegistry.registryId,
    registryEpoch: nextRegistry.epoch,
    certificateKind: "observer",
    certificateId: observer.certificateId,
    certificatePayloadHash: observer.payloadHash,
    issuerId: observer.issuerId,
    status: "member",
  });
  assert.equal(
    validateObserverQualificationCertificate(nextRegistry, role, observer, { input, result }, nextPin).valid,
    true,
  );
});
