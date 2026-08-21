import assert from "node:assert/strict";
import test from "node:test";
import {
  createMembershipInput,
  createMembershipResult,
  createObserverQualificationCertificate,
  createObserverRoleSpec,
  createPredicateSpec,
  createQualificationRegistry,
  createObserverSigningKey,
  hashObserverSigningKeySetRoot,
  hashRevokedObserverKeyIdsRoot,
  createVerifierQualificationCertificate,
  type Hash,
} from "../../../specs/qualification/src/index.ts";
import {
  createUnsignedSignedObserverInvocationSnapshot,
  sealSignedObserverInvocationSnapshot,
} from "../../../specs/qualified-facts/src/index.ts";
import {
  validateCurrentRegistryMembership,
  validateObserverQualificationCertificate,
  validateObserverSigningKey,
  validateUnsignedInvocationBindings,
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
  predicateImplementationExportDigest: h("8"),
  predicateProgramDescriptorDigest: h("8"),
  oracleProgramDescriptorDigest: h("9"),
  oracleImplementationClosureDigest: h("c"),
  oracleImplementationExportDigest: h("d"),
  predicateCompositionLeafDigest: h("a"),
  gateCoreImplementationClosureDigest: h("b"),
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

const observerSigningKey = createObserverSigningKey({
  schemaVersion: 1,
  kind: "aloha.observer-signing-key",
  observerQualificationId: observer.certificateId,
  roleId: role.roleId,
  algorithm: "ed25519",
  publicKeyHex: `0x${"ab".repeat(32)}`,
  validFromRegistryEpoch: registryEpoch,
  validThroughRegistryEpoch: "9",
  audienceHash: h("d"),
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
  observerKeySetRoot: hashObserverSigningKeySetRoot([observerSigningKey.keyId]),
  revokedObserverKeyIdsRoot: hashRevokedObserverKeyIdsRoot([]),
  previousRegistryRoot: null,
  governanceTrustAnchorHash: h("e"),
});
const pin = { expectedRegistryRoot: registry.registryId, expectedGovernanceTrustAnchorHash: registry.governanceTrustAnchorHash } as const;

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
    observerSigningKeys: [observerSigningKey],
    revokedObserverKeyIds: [],
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
  assert.equal(observerResult.factsConsistent, true);
  assert.equal(observerResult.authority, false);
  assert.equal(observerResult.signatureVerified, false);
  assert.equal("valid" in observerResult, false);
  const verifierResult = validateVerifierQualificationCertificate(
    registry,
    predicate,
    verifier,
    [{ role, certificate: observer, membershipProof: proof("observer", observer) }],
    proof("verifier", verifier),
    pin,
  );
  assert.equal(verifierResult.factsConsistent, true);
  assert.equal(verifierResult.authority, false);
  assert.equal(verifierResult.signatureVerified, false);
});

test("verifier program, composition and implementation bindings fail closed when absent", () => {
  const zeroHash = `0x${"0".repeat(64)}` as Hash;
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
    const checked = validateVerifierQualificationCertificate(
      registry,
      predicate,
      { ...verifier, [field]: zeroHash },
      [{ role, certificate: observer, membershipProof: proof("observer", observer) }],
      proof("verifier", verifier),
      pin,
    );
    assert.equal(checked.factsConsistent, false, field);
    assert.ok(checked.issues.some((issue) => issue.code === "malformed" || issue.code === "implementation-mismatch"), field);
  }
});

test("wrong role schema, missing oracle, mutation drift, stale or revoked facts invalidate", () => {
  const wrongRole = createObserverRoleSpec({ ...role, observationSchema: { ...role.observationSchema, schemaHash: h("d") } });
  const wrong = validateObserverQualificationCertificate(registry, wrongRole, observer, proof("observer", observer), pin);
  assert.equal(wrong.factsConsistent, false);

  assert.throws(() => createObserverQualificationCertificate({ ...observer, rejectedOrInvalidMutationIds: [] }));

  const staleProof = proof("observer", observer);
  const stale = validateObserverQualificationCertificate(registry, role, observer, { ...staleProof, result: { ...staleProof.result, registryEpoch: "2" } }, pin);
  assert.equal(stale.factsConsistent, false);

  const revoked = validateObserverQualificationCertificate(registry, role, observer, { ...proof("observer", observer), result: { ...proof("observer", observer).result, status: "revoked" } }, pin);
  assert.equal(revoked.factsConsistent, false);
});

test("registry governance pin and certificate root splice are external facts", () => {
  const wrongPin = validateObserverQualificationCertificate(registry, role, observer, proof("observer", observer), { ...pin, expectedRegistryRoot: h("f") });
  assert.equal(wrongPin.factsConsistent, false);
  const result = validateCurrentRegistryMembership(registry, proof("observer", observer).input, proof("observer", observer).result, pin);
  assert.equal(result.factsConsistent, true);
  assert.equal(result.authority, false);
  const originalInput = proof("observer", observer).input;
  const { inputId: _inputId, payloadHash: _inputPayloadHash, ...originalInputPayload } = originalInput;
  const tamperedInput = createMembershipInput({ ...originalInputPayload, trustedIssuerIds: ["attacker"] });
  const originalResult = proof("observer", observer).result;
  const { resultId: _resultId, payloadHash: _resultPayloadHash, ...originalResultPayload } = originalResult;
  const tamperedResult = createMembershipResult({ ...originalResultPayload, inputId: tamperedInput.inputId });
  const tampered = validateCurrentRegistryMembership(registry, tamperedInput, tamperedResult, pin);
  assert.equal(tampered.factsConsistent, false);

  const { inputId: _epochInputId, payloadHash: _epochPayloadHash, ...epochInputPayload } = originalInput;
  const wrongEpochInput = createMembershipInput({ ...epochInputPayload, registryEpoch: "2" });
  const wrongEpochResult = createMembershipResult({
    ...originalResultPayload,
    inputId: wrongEpochInput.inputId,
    registryEpoch: "2",
  });
  assert.equal(validateCurrentRegistryMembership(registry, wrongEpochInput, wrongEpochResult, pin).factsConsistent, false);

  const wrongIssuerInput = createMembershipInput({ ...epochInputPayload, issuerId: "attacker" });
  const wrongIssuerResult = createMembershipResult({
    ...originalResultPayload,
    inputId: wrongIssuerInput.inputId,
    issuerId: "attacker",
  });
  assert.equal(validateCurrentRegistryMembership(registry, wrongIssuerInput, wrongIssuerResult, pin).factsConsistent, false);
});

test("observer signing key and invocation validation are fact-only and root/epoch bound", () => {
  const membership = proof("observer", observer).input;
  const keyResult = validateObserverSigningKey(registry, observerSigningKey, membership, pin);
  assert.equal(keyResult.factsConsistent, true);
  assert.equal(keyResult.authority, false);
  assert.equal(keyResult.signatureVerified, false);

  const unsigned = createUnsignedSignedObserverInvocationSnapshot({
    schemaVersion: 1,
    kind: "aloha.signed-observer-invocation-snapshot",
    registryRoot: registry.registryId,
    registryEpoch: registry.epoch,
    observerQualificationId: observerSigningKey.observerQualificationId,
    roleId: observerSigningKey.roleId,
    keyId: observerSigningKey.keyId,
    audienceHash: observerSigningKey.audienceHash,
    invocationNonce: h("6"),
    issuedAtUnixNs: "10",
    expiresAtUnixNs: "20",
    acceptanceQueryId: h("7"),
    qualifiedFactSnapshotId: h("8"),
    semanticArtifactBindings: [],
    productionReceiptBindings: [],
    signatureAlgorithm: "ed25519",
  });
  const invocation = sealSignedObserverInvocationSnapshot(unsigned, `0x${"11".repeat(64)}`);
  const invocationResult = validateUnsignedInvocationBindings(registry, invocation, observerSigningKey, membership, pin);
  assert.equal(invocationResult.factsConsistent, true);
  assert.equal(invocationResult.authority, false);
  assert.equal(invocationResult.signatureVerified, false);

  const { inputId: _inputId, payloadHash: _inputPayloadHash, ...membershipPayload } = membership;
  const wrongRoot = createMembershipInput({
    ...membershipPayload,
    observerSigningKeys: [],
  });
  assert.equal(validateObserverSigningKey(registry, observerSigningKey, wrongRoot, pin).factsConsistent, false);
  const { keyId: _keyId, ...expiredKeyPayload } = observerSigningKey;
  const expiredKey = createObserverSigningKey({ ...expiredKeyPayload, validFromRegistryEpoch: "0", validThroughRegistryEpoch: "0" });
  assert.equal(validateObserverSigningKey(registry, expiredKey, membership, pin).factsConsistent, false);
  assert.equal(validateUnsignedInvocationBindings(registry, { ...invocation, registryEpoch: "8" } as never, observerSigningKey, membership, pin).factsConsistent, false);
});

test("a certificate issued in an earlier epoch remains current only through exact current membership", () => {
  const nextRegistry = createQualificationRegistry({
    schemaVersion: 1,
    kind: "aloha.qualification-registry",
    epoch: "2",
    trustedIssuerSetRoot: registry.trustedIssuerSetRoot,
    certificateSetRoot: registry.certificateSetRoot,
    revokedCertificateIdsRoot: registry.revokedCertificateIdsRoot,
    observerKeySetRoot: registry.observerKeySetRoot,
    revokedObserverKeyIdsRoot: registry.revokedObserverKeyIdsRoot,
    previousRegistryRoot: registry.registryId,
    governanceTrustAnchorHash: h("d"),
  });
  const nextPin = {
    expectedRegistryRoot: nextRegistry.registryId,
    expectedGovernanceTrustAnchorHash: nextRegistry.governanceTrustAnchorHash,
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
    observerSigningKeys: [observerSigningKey],
    revokedObserverKeyIds: [],
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
    validateObserverQualificationCertificate(nextRegistry, role, observer, { input, result }, nextPin).factsConsistent,
    true,
  );
});
