import assert from "node:assert/strict";
import test from "node:test";
import {
  createExternalQualificationIssuerKeyV2,
  createExternalQualificationTrustAnchorV2,
  createSignedQualificationRegistryApprovalV2,
  createSignedObserverCertificateV2,
  createSignedReleaseAuthorityApprovalV2,
  createSignedVerifierCertificateV2,
  decodeExternalQualificationIssuerKeyV2,
  decodeExternalQualificationTrustAnchorV2,
  decodeSignedQualificationRegistryApprovalV2,
  decodeSignedObserverCertificateV2,
  decodeSignedReleaseAuthorityApprovalV2,
  decodeSignedVerifierCertificateV2,
  encodeExternalQualificationIssuerKeyV2,
  encodeExternalQualificationTrustAnchorV2,
  encodeSignedQualificationRegistryApprovalV2,
  encodeSignedObserverCertificateV2,
  encodeSignedReleaseAuthorityApprovalV2,
  encodeSignedVerifierCertificateV2,
  hashExternalQualificationIssuerKeySetRoot,
  hashExternalQualificationIssuerSetRoot,
  hashSignedReleaseAuthorityObserverCertificateIdsRoot,
  observerCertificateSigningBytes,
  qualificationRegistryApprovalSigningBytes,
  releaseAuthorityApprovalSigningBytes,
  recomputeExternalQualificationIssuerKeyId,
  recomputeExternalQualificationTrustAnchorId,
  recomputeSignedQualificationRegistryApprovalId,
  recomputeSignedQualificationRegistryApprovalPayloadHash,
  recomputeSignedReleaseAuthorityApprovalId,
  recomputeSignedReleaseAuthorityApprovalPayloadHash,
  recomputeSignedObserverCertificateV2Id,
  recomputeSignedVerifierCertificateV2Id,
  verifierCertificateSigningBytes,
  validateExternalQualificationTrustAnchorGovernanceKey,
  type Hash,
} from "../src/index.ts";
import { decodeCanonicalJson, encodeCanonicalJson, hashDomain } from "../../../packages/canonical-codec/src/index.ts";

const h = (digit: string): Hash => (`0x${digit.repeat(64)}`) as Hash;
const sig = (byte: string): string => `0x${byte.repeat(64)}`;

const keyA = createExternalQualificationIssuerKeyV2({
  schemaVersion: 2,
  kind: "aloha.external-qualification-issuer-key",
  issuerId: "issuer-a",
  algorithm: "ed25519",
  publicKeyHex: `0x${"11".repeat(32)}`,
  validFromRegistryEpoch: "7",
  validThroughRegistryEpoch: "9",
  audienceHash: h("a"),
});
const keyB = createExternalQualificationIssuerKeyV2({
  schemaVersion: 2,
  kind: "aloha.external-qualification-issuer-key",
  issuerId: "issuer-b",
  algorithm: "ed25519",
  publicKeyHex: `0x${"22".repeat(32)}`,
  validFromRegistryEpoch: "7",
  validThroughRegistryEpoch: "9",
  audienceHash: h("b"),
});
const issuerKeySetRoot = hashExternalQualificationIssuerKeySetRoot([keyA, keyB]);
const issuerSetRoot = hashExternalQualificationIssuerSetRoot([keyA.issuerId, keyB.issuerId]);

const approvalInput = {
  schemaVersion: 2 as const,
  kind: "aloha.signed-qualification-registry-approval" as const,
  registryRoot: h("1"),
  registryPayloadHash: h("2"),
  issuerKeySetRoot,
  epoch: "7",
  audienceHash: h("3"),
  issuerId: keyA.issuerId,
  keyId: keyA.keyId,
};
const approval = createSignedQualificationRegistryApprovalV2(approvalInput, sig("aa"));

const observerInput = {
  schemaVersion: 2 as const,
  kind: "aloha.observer-qualification" as const,
  certificateId: hashDomain("aloha/observer-qualification/id/v1", h("4")),
  payloadHash: h("4"),
  registryRoot: h("1"),
  epoch: "7",
  audienceHash: h("3"),
  issuerId: keyA.issuerId,
  keyId: keyA.keyId,
};
const observer = createSignedObserverCertificateV2(observerInput, sig("bb"));

const verifierInput = {
  schemaVersion: 2 as const,
  kind: "aloha.verifier-qualification" as const,
  certificateId: hashDomain("aloha/verifier-qualification/id/v1", h("5")),
  payloadHash: h("5"),
  registryRoot: h("1"),
  epoch: "7",
  audienceHash: h("3"),
  issuerId: keyA.issuerId,
  keyId: keyA.keyId,
};
const verifier = createSignedVerifierCertificateV2(verifierInput, sig("cc"));

const trustAnchor = createExternalQualificationTrustAnchorV2({
  schemaVersion: 2,
  kind: "aloha.external-qualification-trust-anchor",
  issuerSetRoot,
  issuerKeySetRoot,
  governanceIssuerId: keyA.issuerId,
  governanceKeyId: keyA.keyId,
  validFromRegistryEpoch: "7",
  validThroughRegistryEpoch: "9",
  currentRegistryEpoch: "8",
  audienceHash: keyA.audienceHash,
});

const observerCertificateIds = [observer.certificateId] as const;
const releaseInput = {
  schemaVersion: 2 as const,
  kind: "aloha.signed-release-authority-approval" as const,
  authorityPinDigest: h("7"),
  externalTrustAnchorRoot: trustAnchor.anchorId,
  issuerKeySetRoot,
  registryApprovalId: approval.approvalId,
  registryRoot: approval.registryRoot,
  verifierCertificateId: verifier.certificateId,
  observerCertificateIds,
  observerCertificateIdsRoot: hashSignedReleaseAuthorityObserverCertificateIdsRoot(observerCertificateIds),
  predicateCompositionRootDigest: h("8"),
  gateCoreRuntimeClosureDigest: h("9"),
  gateCoreImplementationClosureDigest: h("a"),
  releaseRoleManifestRoot: h("b"),
  candidateReleaseCommit: "a".repeat(40),
  epoch: "8",
  audienceHash: h("3"),
  issuerId: keyA.issuerId,
  keyId: keyA.keyId,
};
const release = createSignedReleaseAuthorityApprovalV2(releaseInput, sig("dd"));

test("V2 objects are exact signed wire objects and round-trip byte-identically", () => {
  assert.deepEqual(decodeExternalQualificationIssuerKeyV2(encodeExternalQualificationIssuerKeyV2(keyA)), keyA);
  assert.deepEqual(decodeSignedQualificationRegistryApprovalV2(encodeSignedQualificationRegistryApprovalV2(approval)), approval);
  assert.deepEqual(decodeSignedObserverCertificateV2(encodeSignedObserverCertificateV2(observer)), observer);
  assert.deepEqual(decodeSignedVerifierCertificateV2(encodeSignedVerifierCertificateV2(verifier)), verifier);
  assert.deepEqual(decodeExternalQualificationTrustAnchorV2(encodeExternalQualificationTrustAnchorV2(trustAnchor)), trustAnchor);
  assert.deepEqual(decodeSignedReleaseAuthorityApprovalV2(encodeSignedReleaseAuthorityApprovalV2(release)), release);
  assert.equal(recomputeExternalQualificationIssuerKeyId(keyA), keyA.keyId);
  assert.equal(recomputeSignedQualificationRegistryApprovalPayloadHash(approval), approval.payloadHash);
  assert.equal(recomputeSignedQualificationRegistryApprovalId(approval), approval.approvalId);
  assert.equal(recomputeSignedObserverCertificateV2Id(observer), observer.certificateId);
  assert.equal(recomputeSignedVerifierCertificateV2Id(verifier), verifier.certificateId);
  assert.equal(recomputeExternalQualificationTrustAnchorId(trustAnchor), trustAnchor.anchorId);
  assert.equal(recomputeSignedReleaseAuthorityApprovalPayloadHash(release), release.payloadHash);
  assert.equal(recomputeSignedReleaseAuthorityApprovalId(release), release.approvalId);
});

test("issuer key root commits complete issuerId/key/epoch/audience material and is sorted unique", () => {
  const root = hashExternalQualificationIssuerKeySetRoot([keyA, keyB]);
  const { keyId: _keyId, ...keyBPayload } = keyB;
  const changedFrom = createExternalQualificationIssuerKeyV2({ ...keyBPayload, validFromRegistryEpoch: "8" });
  const changedThrough = createExternalQualificationIssuerKeyV2({ ...keyBPayload, validThroughRegistryEpoch: "10" });
  assert.notEqual(root, hashExternalQualificationIssuerKeySetRoot([keyA, changedFrom]));
  assert.notEqual(root, hashExternalQualificationIssuerKeySetRoot([keyA, changedThrough]));
});

test("issuer key root rejects reordering and duplicate material", () => {
  assert.throws(() => hashExternalQualificationIssuerKeySetRoot([keyB, keyA]));
  assert.throws(() => hashExternalQualificationIssuerKeySetRoot([keyA, keyA]));
  const { keyId: _keyId, ...keyBPayload } = keyB;
  const changedAudience = createExternalQualificationIssuerKeyV2({ ...keyBPayload, audienceHash: h("c") });
  assert.notEqual(hashExternalQualificationIssuerKeySetRoot([keyA, keyB]), hashExternalQualificationIssuerKeySetRoot([keyA, changedAudience]));
});

test("signature fields are mandatory, exact lowercase Ed25519 hex, and never optional", () => {
  assert.throws(() => decodeSignedQualificationRegistryApprovalV2({ ...approval, signatureHex: undefined } as never));
  const withoutSignature = { ...approval } as Record<string, unknown>;
  delete withoutSignature.signatureHex;
  assert.throws(() => decodeSignedQualificationRegistryApprovalV2(withoutSignature));
  assert.throws(() => createSignedQualificationRegistryApprovalV2(approvalInput, "0x11"));
  assert.throws(() => createSignedQualificationRegistryApprovalV2(approvalInput, sig("AA")));
  assert.throws(() => createSignedQualificationRegistryApprovalV2(approvalInput, sig("00")));
  assert.throws(() => decodeExternalQualificationIssuerKeyV2({ ...keyA, publicKeyHex: keyA.publicKeyHex.toUpperCase() }));
  const { keyId: _keyId, ...keyAPayload } = keyA;
  assert.throws(() => createExternalQualificationIssuerKeyV2({ ...keyAPayload, validFromRegistryEpoch: "10", validThroughRegistryEpoch: "9" }));
});

test("registry approval signs the exact issuer key-set root and rejects its omission", () => {
  const changedRoot = { ...approvalInput, issuerKeySetRoot: h("f") };
  assert.notDeepEqual(qualificationRegistryApprovalSigningBytes(approval), qualificationRegistryApprovalSigningBytes(changedRoot));
  assert.throws(() => decodeSignedQualificationRegistryApprovalV2({ ...approval, issuerKeySetRoot: h("f") }));
  const withoutRoot = { ...approval } as Record<string, unknown>;
  delete withoutRoot.issuerKeySetRoot;
  assert.throws(() => decodeSignedQualificationRegistryApprovalV2(withoutRoot));
});

test("unknown, V1, duplicate-key, and non-canonical inputs fail closed", () => {
  assert.throws(() => decodeSignedObserverCertificateV2({ ...observer, extra: true } as never));
  assert.throws(() => decodeSignedObserverCertificateV2({ ...observer, schemaVersion: 1 } as never));
  assert.throws(() => decodeSignedVerifierCertificateV2({ ...verifier, signatureAlgorithm: undefined } as never));
  assert.throws(() => decodeExternalQualificationIssuerKeyV2(`{"schemaVersion":2,"kind":"aloha.external-qualification-issuer-key","issuerId":"a","issuerId":"b"}`));
  const nonCanonical = encodeCanonicalJson(approval).replace("{", "{ ");
  assert.throws(() => decodeSignedQualificationRegistryApprovalV2(nonCanonical));
});

test("identity and payload mutation cannot be repaired by the signed seal", () => {
  assert.throws(() => decodeSignedQualificationRegistryApprovalV2({ ...approval, payloadHash: h("f") }));
  assert.throws(() => decodeSignedQualificationRegistryApprovalV2({ ...approval, approvalId: h("f") }));
  assert.throws(() => decodeSignedObserverCertificateV2({ ...observer, certificateId: h("f") }));
  assert.throws(() => decodeSignedVerifierCertificateV2({ ...verifier, payloadHash: h("f") }));
  assert.notDeepEqual(
    qualificationRegistryApprovalSigningBytes(approval),
    qualificationRegistryApprovalSigningBytes({ ...approvalInput, registryRoot: h("f") }),
  );
  assert.notDeepEqual(observerCertificateSigningBytes(observer), observerCertificateSigningBytes({ ...observer, epoch: "8" }));
  assert.notDeepEqual(verifierCertificateSigningBytes(verifier), verifierCertificateSigningBytes({ ...verifier, audienceHash: h("f") }));
  const decodedSigningPayload = decodeCanonicalJson(observerCertificateSigningBytes(observer));
  assert.deepEqual(decodedSigningPayload, {
    audienceHash: observer.audienceHash,
    domain: "aloha/signed-qualification-certificate/v2",
    epoch: observer.epoch,
    id: observer.certificateId,
    issuerId: observer.issuerId,
    keyId: observer.keyId,
    kind: observer.kind,
    payloadHash: observer.payloadHash,
    registryRoot: observer.registryRoot,
    version: 2,
  });
});

test("trust anchor is an observed, content-addressed interval with designated governance key", () => {
  assert.equal(trustAnchor.anchorId, recomputeExternalQualificationTrustAnchorId(trustAnchor));
  assert.doesNotThrow(() => validateExternalQualificationTrustAnchorGovernanceKey(trustAnchor, [keyA, keyB]));
  const { anchorId: _anchorId, ...anchorPayload } = trustAnchor;
  assert.notEqual(
    trustAnchor.anchorId,
    createExternalQualificationTrustAnchorV2({ ...anchorPayload, governanceKeyId: h("f") }).anchorId,
  );
  assert.throws(() => createExternalQualificationTrustAnchorV2({ ...anchorPayload, currentRegistryEpoch: "10" }));
  assert.throws(() => createExternalQualificationTrustAnchorV2({ ...anchorPayload, validFromRegistryEpoch: "10", validThroughRegistryEpoch: "9" }));
  assert.throws(() => decodeExternalQualificationTrustAnchorV2({ ...trustAnchor, unknown: true } as never));
  assert.throws(() => decodeExternalQualificationTrustAnchorV2({ ...trustAnchor, schemaVersion: 1 } as never));
  assert.throws(() => decodeExternalQualificationTrustAnchorV2({ ...trustAnchor, governanceKeyId: h("0") }));
  assert.throws(() => validateExternalQualificationTrustAnchorGovernanceKey(trustAnchor, [keyB]));
  assert.throws(() => validateExternalQualificationTrustAnchorGovernanceKey({ ...trustAnchor, governanceIssuerId: "missing" }, [keyA, keyB]));

  const rotatedKeyA = createExternalQualificationIssuerKeyV2({
    schemaVersion: 2,
    kind: "aloha.external-qualification-issuer-key",
    issuerId: keyA.issuerId,
    algorithm: "ed25519",
    publicKeyHex: `0x${"33".repeat(32)}`,
    validFromRegistryEpoch: "7",
    validThroughRegistryEpoch: "9",
    audienceHash: keyA.audienceHash,
  });
  const rotatedKeys = [keyA, rotatedKeyA]
    .sort((left, right) => encodeCanonicalJson(left).localeCompare(encodeCanonicalJson(right)));
  const rotatedAnchor = createExternalQualificationTrustAnchorV2({
    ...anchorPayload,
    issuerSetRoot: hashExternalQualificationIssuerSetRoot([keyA.issuerId]),
    issuerKeySetRoot: hashExternalQualificationIssuerKeySetRoot(rotatedKeys),
  });
  assert.doesNotThrow(() => validateExternalQualificationTrustAnchorGovernanceKey(rotatedAnchor, rotatedKeys));
});

test("release authority approval binds every release and qualification root without self-authority", () => {
  const signingBytes = releaseAuthorityApprovalSigningBytes(release);
  const mutatedFields = [
    "authorityPinDigest",
    "externalTrustAnchorRoot",
    "issuerKeySetRoot",
    "registryApprovalId",
    "registryRoot",
    "verifierCertificateId",
    "predicateCompositionRootDigest",
    "gateCoreRuntimeClosureDigest",
    "gateCoreImplementationClosureDigest",
    "releaseRoleManifestRoot",
    "audienceHash",
    "keyId",
  ] as const;
  for (const field of mutatedFields) {
    assert.notDeepEqual(signingBytes, releaseAuthorityApprovalSigningBytes({ ...release, [field]: h("f") }), field);
  }
  assert.notDeepEqual(signingBytes, releaseAuthorityApprovalSigningBytes({ ...release, candidateReleaseCommit: "b".repeat(40) }));
  assert.notDeepEqual(signingBytes, releaseAuthorityApprovalSigningBytes({ ...release, epoch: "9" }));
  assert.notDeepEqual(signingBytes, releaseAuthorityApprovalSigningBytes({ ...release, observerCertificateIdsRoot: h("f") }));
  assert.throws(() => decodeSignedReleaseAuthorityApprovalV2({ ...release, observerCertificateIds: [h("f"), observer.certificateId] }));
  assert.throws(() => hashSignedReleaseAuthorityObserverCertificateIdsRoot([observer.certificateId, observer.certificateId]));
  assert.throws(() => hashSignedReleaseAuthorityObserverCertificateIdsRoot([observer.certificateId, h("0")]));
  assert.throws(() => decodeSignedReleaseAuthorityApprovalV2({ ...release, candidateReleaseCommit: "A".repeat(40) }));
  assert.throws(() => createSignedReleaseAuthorityApprovalV2({ ...releaseInput, candidateReleaseCommit: "0".repeat(40) }, sig("ee")));
  assert.throws(() => decodeSignedReleaseAuthorityApprovalV2({ ...release, extra: true } as never));
  const withoutSignature = { ...release } as Record<string, unknown>;
  delete withoutSignature.signatureHex;
  assert.throws(() => decodeSignedReleaseAuthorityApprovalV2(withoutSignature));
  assert.throws(() => decodeSignedReleaseAuthorityApprovalV2({ ...release, schemaVersion: 1 } as never));
  assert.notEqual(recomputeSignedReleaseAuthorityApprovalId(release), recomputeSignedReleaseAuthorityApprovalId(
    createSignedReleaseAuthorityApprovalV2({ ...releaseInput, authorityPinDigest: h("f") }, sig("ee")),
  ));
});
