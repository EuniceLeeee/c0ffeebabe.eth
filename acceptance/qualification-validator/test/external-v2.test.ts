import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  createObserverQualificationCertificate,
  createMembershipInput,
  createMembershipResult,
  createQualificationRegistry,
  createVerifierQualificationCertificate,
  hashObserverSigningKeySetRoot,
  hashRevokedObserverKeyIdsRoot,
  type Hash,
} from "../../../specs/qualification/src/index.ts";
import {
  createExternalQualificationIssuerKeyV2,
  createExternalQualificationTrustAnchorV2,
  createSignedQualificationRegistryApprovalV2,
  createSignedObserverCertificateV2,
  createSignedVerifierCertificateV2,
  hashExternalQualificationIssuerKeySetRoot,
  hashExternalQualificationIssuerSetRoot,
  observerCertificateSigningBytes,
  qualificationRegistryApprovalSigningBytes,
  verifierCertificateSigningBytes,
} from "../../../specs/qualification/src/external-v2.ts";
import { encodeCanonicalJson, hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import {
  validateExternalQualificationV2,
  type ExternalQualificationAuthorityPinV2,
  type ExternalQualificationV2Input,
} from "../src/index.ts";

const h = (digit: string): Hash => (`0x${digit.repeat(64)}`) as Hash;
const issuerId = "external-issuer";
const audienceHash = h("a");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = `0x${(publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex")}`;
const { publicKey: delegatePublicKey, privateKey: delegatePrivateKey } = generateKeyPairSync("ed25519");
const delegatePublicKeyHex = `0x${(delegatePublicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex")}`;

const issuerKey = createExternalQualificationIssuerKeyV2({
  schemaVersion: 2,
  kind: "aloha.external-qualification-issuer-key",
  issuerId,
  algorithm: "ed25519",
  publicKeyHex,
  validFromRegistryEpoch: "0",
  validThroughRegistryEpoch: "10",
  audienceHash,
});
const delegateIssuerKey = createExternalQualificationIssuerKeyV2({
  schemaVersion: 2,
  kind: "aloha.external-qualification-issuer-key",
  issuerId,
  algorithm: "ed25519",
  publicKeyHex: delegatePublicKeyHex,
  validFromRegistryEpoch: "0",
  validThroughRegistryEpoch: "10",
  audienceHash,
});
const issuerKeys = [issuerKey, delegateIssuerKey]
  .sort((left, right) => encodeCanonicalJson(left).localeCompare(encodeCanonicalJson(right)));
const issuerKeySetRoot = hashExternalQualificationIssuerKeySetRoot(issuerKeys);

const observer = createObserverQualificationCertificate({
  schemaVersion: 1,
  kind: "aloha.observer-qualification",
  qualificationSpecDigest: h("1"),
  observerImplementationDigest: h("2"),
  observedSchemaIds: [{ id: "observed", version: "1.0.0", schemaHash: h("3") }],
  qualifiedLocatorKinds: ["chain-object"],
  anchorValidationMethodDigest: h("4"),
  positiveCaseRoot: h("5"),
  negativeCaseRoot: h("6"),
  invalidCaseRoot: h("7"),
  declaredCriticalMutationIds: ["mutation-a"],
  rejectedOrInvalidMutationIds: ["mutation-a"],
  independentOracleCaseRoot: h("8"),
  independentOracleCaseCount: "1",
  issuerId,
  issuedAtRegistryEpoch: "7",
  verdict: "qualified",
});

const verifier = createVerifierQualificationCertificate({
  schemaVersion: 1,
  kind: "aloha.verifier-qualification",
  qualificationSpecDigest: h("9"),
  predicateSpecDigest: h("b"),
  predicateImplementationDigest: h("c"),
  predicateImplementationExportDigest: h("d"),
  predicateProgramDescriptorDigest: h("e"),
  oracleProgramDescriptorDigest: h("f"),
  oracleImplementationClosureDigest: h("1"),
  oracleImplementationExportDigest: h("2"),
  predicateCompositionLeafDigest: h("3"),
  gateCoreImplementationClosureDigest: h("4"),
  observerQualificationIds: [observer.certificateId],
  requiredObserverRoles: [],
  caseSetRoot: h("5"),
  declaredCriticalMutationIds: ["mutation-a"],
  rejectedOrInvalidMutationIds: ["mutation-a"],
  independentOracleCaseRoot: h("6"),
  independentOracleCaseCount: "1",
  oldReferenceCaseCount: "0",
  counterexampleRoot: h("7"),
  issuerId,
  issuedAtRegistryEpoch: "7",
  verdict: "qualified",
});

const certificateMemberships = [
  { certificateKind: "observer" as const, certificateId: observer.certificateId, certificatePayloadHash: observer.payloadHash, issuerId },
  { certificateKind: "verifier" as const, certificateId: verifier.certificateId, certificatePayloadHash: verifier.payloadHash, issuerId },
].sort((left, right) => left.certificateId.localeCompare(right.certificateId));
const trustedIssuerIds = [issuerId];
const trustAnchor = createExternalQualificationTrustAnchorV2({
  schemaVersion: 2,
  kind: "aloha.external-qualification-trust-anchor",
  issuerSetRoot: hashExternalQualificationIssuerSetRoot(trustedIssuerIds),
  issuerKeySetRoot,
  governanceIssuerId: issuerId,
  governanceKeyId: issuerKey.keyId,
  validFromRegistryEpoch: "0",
  validThroughRegistryEpoch: "10",
  currentRegistryEpoch: "7",
  audienceHash,
});
const registry = createQualificationRegistry({
  schemaVersion: 1,
  kind: "aloha.qualification-registry",
  epoch: "7",
  trustedIssuerSetRoot: hashDomain("aloha/trusted-issuer-set/v1", trustedIssuerIds),
  certificateSetRoot: hashDomain("aloha/certificate-set/v1", certificateMemberships),
  revokedCertificateIdsRoot: hashDomain("aloha/revoked-certificate-set/v1", []),
  observerKeySetRoot: hashObserverSigningKeySetRoot([]),
  revokedObserverKeyIdsRoot: hashRevokedObserverKeyIdsRoot([]),
  previousRegistryRoot: null,
  governanceTrustAnchorHash: trustAnchor.anchorId,
});

const approvalInput = {
  schemaVersion: 2 as const,
  kind: "aloha.signed-qualification-registry-approval" as const,
  registryRoot: registry.registryId,
  registryPayloadHash: registry.payloadHash,
  issuerKeySetRoot,
  epoch: registry.epoch,
  audienceHash,
  issuerId,
  keyId: issuerKey.keyId,
};

function signedHex(bytes: Uint8Array): string {
  return `0x${sign(null, Buffer.from(bytes), privateKey).toString("hex")}`;
}

const approval = createSignedQualificationRegistryApprovalV2(approvalInput, signedHex(qualificationRegistryApprovalSigningBytes(approvalInput)));
const observerSignedInput = {
  schemaVersion: 2 as const,
  kind: "aloha.observer-qualification" as const,
  certificateId: observer.certificateId,
  payloadHash: observer.payloadHash,
  registryRoot: registry.registryId,
  epoch: registry.epoch,
  audienceHash,
  issuerId,
  keyId: issuerKey.keyId,
};
const verifierSignedInput = {
  schemaVersion: 2 as const,
  kind: "aloha.verifier-qualification" as const,
  certificateId: verifier.certificateId,
  payloadHash: verifier.payloadHash,
  registryRoot: registry.registryId,
  epoch: registry.epoch,
  audienceHash,
  issuerId,
  keyId: issuerKey.keyId,
};
const observerSigned = createSignedObserverCertificateV2(observerSignedInput, signedHex(observerCertificateSigningBytes(observerSignedInput)));
const verifierSigned = createSignedVerifierCertificateV2(verifierSignedInput, signedHex(verifierCertificateSigningBytes(verifierSignedInput)));

function membership(kind: "observer" | "verifier", certificateId: Hash, payloadHash: Hash) {
  const input = {
    registryRoot: registry.registryId,
    registryEpoch: registry.epoch,
    certificateKind: kind,
    certificateId,
    certificatePayloadHash: payloadHash,
    issuerId,
    trustedIssuerIds,
    certificateMemberships,
    revokedCertificateIds: [] as Hash[],
    observerSigningKeys: [],
    revokedObserverKeyIds: [] as Hash[],
  };
  return {
    input: createMembershipInput(input),
    result: createMembershipResult({
      inputId: createMembershipInput(input).inputId,
      registryRoot: registry.registryId,
      registryEpoch: registry.epoch,
      certificateKind: kind,
      certificateId,
      certificatePayloadHash: payloadHash,
      issuerId,
      status: "member",
    }),
  };
}

const pin: ExternalQualificationAuthorityPinV2 = {
  expectedRegistryRoot: registry.registryId,
  expectedRegistryPayloadHash: registry.payloadHash,
  expectedRegistryEpoch: registry.epoch,
  expectedGovernanceTrustAnchorHash: registry.governanceTrustAnchorHash,
  expectedRegistryApprovalId: approval.approvalId,
  expectedAudienceHash: audienceHash,
  expectedIssuerKeySetRoot: issuerKeySetRoot,
};

const validInput: ExternalQualificationV2Input = {
  registry,
  trustAnchor,
  issuerKeys,
  registryApproval: approval,
  observer: { signed: observerSigned, certificate: observer, membershipProof: membership("observer", observer.certificateId, observer.payloadHash) },
  verifier: { signed: verifierSigned, certificate: verifier, membershipProof: membership("verifier", verifier.certificateId, verifier.payloadHash) },
};

test("external V2 validator verifies all three Ed25519 seals without granting authority", () => {
  const result = validateExternalQualificationV2(validInput, pin);
  assert.equal(result.factsConsistent, true);
  assert.equal(result.signatureVerified, true);
  assert.equal(result.authority, false);
});

test("external V2 rejects a wrong signature, changed V1 binding, and replaced issuer key", () => {
  const wrongSignature = validateExternalQualificationV2({
    ...validInput,
    registryApproval: { ...approval, signatureHex: `0x${"11".repeat(64)}` },
  }, pin);
  assert.equal(wrongSignature.factsConsistent, false);
  assert.equal(wrongSignature.signatureVerified, false);

  const delegatedApprovalInput = {
    ...approvalInput,
    keyId: delegateIssuerKey.keyId,
  };
  const delegatedApproval = createSignedQualificationRegistryApprovalV2(
    delegatedApprovalInput,
    `0x${sign(null, Buffer.from(qualificationRegistryApprovalSigningBytes(delegatedApprovalInput)), delegatePrivateKey).toString("hex")}`,
  );
  const delegatedGovernance = validateExternalQualificationV2({
    ...validInput,
    registryApproval: delegatedApproval,
  }, {
    ...pin,
    expectedRegistryApprovalId: delegatedApproval.approvalId,
  });
  assert.equal(delegatedGovernance.factsConsistent, false);
  assert.equal(delegatedGovernance.signatureVerified, false);
  assert.ok(delegatedGovernance.issues.some((issue) =>
    issue.code === "external-key-mismatch" && issue.path === "$.registryApproval.issuerKey"));

  const { certificateId: _observerCertificateId, payloadHash: _observerPayloadHash, ...observerPayload } = observer;
  const changedCertificate = createObserverQualificationCertificate({
    ...observerPayload,
    observerImplementationDigest: h("f"),
  });
  const changedBinding = validateExternalQualificationV2({
    ...validInput,
    observer: { ...validInput.observer, certificate: changedCertificate },
  }, pin);
  assert.equal(changedBinding.factsConsistent, false);
  assert.ok(changedBinding.issues.some((issue) => issue.code === "external-root-mismatch" || issue.code === "external-membership-mismatch"));

  const { keyId: _keyId, ...issuerKeyPayload } = issuerKey;
  const replacement = createExternalQualificationIssuerKeyV2({ ...issuerKeyPayload, publicKeyHex: `0x${"22".repeat(32)}` });
  const replaced = validateExternalQualificationV2({ ...validInput, issuerKeys: [replacement] }, pin);
  assert.equal(replaced.factsConsistent, false);
  assert.equal(replaced.signatureVerified, false);
});

test("external V2 rejects missing/revoked membership, invalid epoch/audience, and unsigned downgrade", () => {
  const missingMembership = validateExternalQualificationV2({
    ...validInput,
    observer: { ...validInput.observer, membershipProof: undefined },
  }, pin);
  assert.equal(missingMembership.factsConsistent, false);
  assert.ok(missingMembership.issues.some((issue) => issue.code === "missing-membership"));

  const revokedProof = membership("observer", observer.certificateId, observer.payloadHash);
  const revoked = validateExternalQualificationV2({
    ...validInput,
    observer: { ...validInput.observer, membershipProof: { ...revokedProof, input: { ...revokedProof.input, revokedCertificateIds: [observer.certificateId] } as never } },
  }, pin);
  assert.equal(revoked.factsConsistent, false);

  const wrongAudience = validateExternalQualificationV2({
    ...validInput,
    registryApproval: { ...approval, audienceHash: h("b") },
  }, pin);
  assert.equal(wrongAudience.factsConsistent, false);

  const wrongAnchor = validateExternalQualificationV2({
    ...validInput,
    trustAnchor: { ...trustAnchor, anchorId: h("f") },
  }, pin);
  assert.equal(wrongAnchor.factsConsistent, false);

  const unsignedDowngrade = validateExternalQualificationV2({
    ...validInput,
    observer: { ...validInput.observer, signed: undefined as never },
  }, pin);
  assert.equal(unsignedDowngrade.factsConsistent, false);
  assert.equal(unsignedDowngrade.signatureVerified, false);
});

test("external V2 rejects a self-consistent certificate issued after the current registry epoch", () => {
  const { certificateId: _observerId, payloadHash: _observerHash, ...observerPayload } = observer;
  const futureObserver = createObserverQualificationCertificate({
    ...observerPayload,
    issuedAtRegistryEpoch: "8",
  });
  const futureMemberships = [
    { certificateKind: "observer" as const, certificateId: futureObserver.certificateId, certificatePayloadHash: futureObserver.payloadHash, issuerId },
    { certificateKind: "verifier" as const, certificateId: verifier.certificateId, certificatePayloadHash: verifier.payloadHash, issuerId },
  ].sort((left, right) => left.certificateId.localeCompare(right.certificateId));
  const futureRegistry = createQualificationRegistry({
    schemaVersion: 1,
    kind: "aloha.qualification-registry",
    epoch: "7",
    trustedIssuerSetRoot: hashDomain("aloha/trusted-issuer-set/v1", trustedIssuerIds),
    certificateSetRoot: hashDomain("aloha/certificate-set/v1", futureMemberships),
    revokedCertificateIdsRoot: hashDomain("aloha/revoked-certificate-set/v1", []),
    observerKeySetRoot: hashObserverSigningKeySetRoot([]),
    revokedObserverKeyIdsRoot: hashRevokedObserverKeyIdsRoot([]),
    previousRegistryRoot: null,
    governanceTrustAnchorHash: trustAnchor.anchorId,
  });
  const futureApprovalInput = {
    ...approvalInput,
    registryRoot: futureRegistry.registryId,
    registryPayloadHash: futureRegistry.payloadHash,
  };
  const futureApproval = createSignedQualificationRegistryApprovalV2(
    futureApprovalInput,
    signedHex(qualificationRegistryApprovalSigningBytes(futureApprovalInput)),
  );
  const futureObserverSignedInput = {
    ...observerSignedInput,
    certificateId: futureObserver.certificateId,
    payloadHash: futureObserver.payloadHash,
    registryRoot: futureRegistry.registryId,
  };
  const futureVerifierSignedInput = {
    ...verifierSignedInput,
    registryRoot: futureRegistry.registryId,
  };
  const futureObserverSigned = createSignedObserverCertificateV2(
    futureObserverSignedInput,
    signedHex(observerCertificateSigningBytes(futureObserverSignedInput)),
  );
  const futureVerifierSigned = createSignedVerifierCertificateV2(
    futureVerifierSignedInput,
    signedHex(verifierCertificateSigningBytes(futureVerifierSignedInput)),
  );
  const membershipAtFutureRegistry = (
    kind: "observer" | "verifier",
    certificateId: Hash,
    payloadHash: Hash,
  ) => {
    const input = createMembershipInput({
      registryRoot: futureRegistry.registryId,
      registryEpoch: futureRegistry.epoch,
      certificateKind: kind,
      certificateId,
      certificatePayloadHash: payloadHash,
      issuerId,
      trustedIssuerIds,
      certificateMemberships: futureMemberships,
      revokedCertificateIds: [],
      observerSigningKeys: [],
      revokedObserverKeyIds: [],
    });
    return {
      input,
      result: createMembershipResult({
        inputId: input.inputId,
        registryRoot: futureRegistry.registryId,
        registryEpoch: futureRegistry.epoch,
        certificateKind: kind,
        certificateId,
        certificatePayloadHash: payloadHash,
        issuerId,
        status: "member",
      }),
    };
  };
  const result = validateExternalQualificationV2({
    registry: futureRegistry,
    trustAnchor,
    issuerKeys,
    registryApproval: futureApproval,
    observer: {
      signed: futureObserverSigned,
      certificate: futureObserver,
      membershipProof: membershipAtFutureRegistry("observer", futureObserver.certificateId, futureObserver.payloadHash),
    },
    verifier: {
      signed: futureVerifierSigned,
      certificate: verifier,
      membershipProof: membershipAtFutureRegistry("verifier", verifier.certificateId, verifier.payloadHash),
    },
  }, {
    ...pin,
    expectedRegistryRoot: futureRegistry.registryId,
    expectedRegistryPayloadHash: futureRegistry.payloadHash,
    expectedRegistryApprovalId: futureApproval.approvalId,
  });
  assert.equal(result.factsConsistent, false);
  assert.equal(result.signatureVerified, true);
  assert.ok(result.issues.some((issue) =>
    issue.code === "external-epoch-mismatch" && issue.path === "$.observer.certificate.issuedAtRegistryEpoch"));
});
