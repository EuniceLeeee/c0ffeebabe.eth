import { createPublicKey, verify as verifyEd25519 } from "node:crypto";
import {
  decodeExternalQualificationIssuerKeyV2,
  decodeExternalQualificationTrustAnchorV2,
  decodeSignedQualificationRegistryApprovalV2,
  decodeSignedObserverCertificateV2,
  decodeSignedVerifierCertificateV2,
  hashExternalQualificationIssuerKeySetRoot,
  hashExternalQualificationIssuerSetRoot,
  observerCertificateSigningBytes,
  qualificationRegistryApprovalSigningBytes,
  validateExternalQualificationTrustAnchorGovernanceKey,
  verifierCertificateSigningBytes,
  type ExternalQualificationIssuerKeyV2,
  type ExternalQualificationTrustAnchorV2,
  type SignedQualificationRegistryApprovalV2,
  type SignedObserverCertificateV2,
  type SignedVerifierCertificateV2,
} from "../../../specs/qualification/src/external-v2.ts";
import {
  decodeObserverCertificate,
  decodeMembershipInput,
  decodeMembershipResult,
  decodeQualificationRegistry,
  decodeVerifierCertificate,
  hashObserverSigningKeySetRoot,
  hashRevokedObserverKeyIdsRoot,
  type Hash,
  type ObserverQualificationCertificateV1,
  type QualificationRegistrySnapshotV1,
  type VerifierQualificationCertificateV1,
} from "../../../specs/qualification/src/index.ts";
import { hashDomain } from "../../../packages/canonical-codec/src/index.ts";
import {
  type CertificateMembershipProof,
  type QualificationIssue,
  type QualificationIssueCode,
} from "./index.ts";

/**
 * External qualification is still a fact check.  This result deliberately
 * does not grant authority; GateCore owns the release pin and the authority
 * decision.  Unlike the V1 unsigned validator, this result reports whether
 * all three external Ed25519 seals were actually verified.
 */
export interface ExternalQualificationValidationResult {
  readonly factsConsistent: boolean;
  readonly authority: false;
  readonly signatureVerified: boolean;
  readonly issues: readonly QualificationIssue[];
}

/**
 * The approval id is pinned separately from the V1 trust-anchor hash.
 * This is intentional: registryId/payloadHash include governanceTrustAnchorHash,
 * while approvalId signs registryId/payloadHash.  Equating those two values
 * would create an impossible self-referential fixed point.
 */
export interface ExternalQualificationAuthorityPinV2 {
  readonly expectedRegistryRoot: Hash;
  readonly expectedRegistryPayloadHash: Hash;
  readonly expectedRegistryEpoch: string;
  readonly expectedGovernanceTrustAnchorHash: Hash;
  readonly expectedRegistryApprovalId: Hash;
  readonly expectedAudienceHash: Hash;
  readonly expectedIssuerKeySetRoot: Hash;
}

export interface ExternalQualificationCertificateBindingV2<TSigned, TV1> {
  readonly signed: TSigned;
  readonly certificate: TV1;
  readonly membershipProof?: CertificateMembershipProof;
}

export interface ExternalQualificationV2Input {
  readonly registry: QualificationRegistrySnapshotV1;
  readonly trustAnchor: ExternalQualificationTrustAnchorV2;
  readonly issuerKeys: readonly ExternalQualificationIssuerKeyV2[];
  readonly registryApproval: SignedQualificationRegistryApprovalV2;
  readonly observer: ExternalQualificationCertificateBindingV2<SignedObserverCertificateV2, ObserverQualificationCertificateV1>;
  readonly verifier: ExternalQualificationCertificateBindingV2<SignedVerifierCertificateV2, VerifierQualificationCertificateV1>;
}

function externalResult(issues: QualificationIssue[], signatureVerified: boolean): ExternalQualificationValidationResult {
  return Object.freeze({
    factsConsistent: issues.length === 0,
    authority: false as const,
    signatureVerified,
    issues: Object.freeze([...issues]),
  });
}

function addExternal(issues: QualificationIssue[], code: QualificationIssueCode, path: string): void {
  issues.push(Object.freeze({ code, path }));
}

function decodeExternal<T>(fn: () => T, issues: QualificationIssue[], path: string): T | null {
  try {
    return fn();
  } catch {
    addExternal(issues, "malformed", path);
    return null;
  }
}

function nonZeroHash(value: Hash): boolean {
  return value !== (`0x${"0".repeat(64)}` as Hash);
}

function checkExternalPin(
  registry: QualificationRegistrySnapshotV1,
  approval: SignedQualificationRegistryApprovalV2,
  pin: ExternalQualificationAuthorityPinV2,
  issues: QualificationIssue[],
): void {
  if (registry.registryId !== pin.expectedRegistryRoot || approval.registryRoot !== pin.expectedRegistryRoot) {
    addExternal(issues, "external-root-mismatch", "$.registry.registryId");
  }
  if (registry.payloadHash !== pin.expectedRegistryPayloadHash || approval.registryPayloadHash !== registry.payloadHash) {
    addExternal(issues, "external-root-mismatch", "$.registry.payloadHash");
  }
  if (registry.epoch !== pin.expectedRegistryEpoch || approval.epoch !== registry.epoch) {
    addExternal(issues, "external-epoch-mismatch", "$.registry.epoch");
  }
  if (registry.governanceTrustAnchorHash !== pin.expectedGovernanceTrustAnchorHash) {
    addExternal(issues, "governance-mismatch", "$.registry.governanceTrustAnchorHash");
  }
  if (approval.approvalId !== pin.expectedRegistryApprovalId || !nonZeroHash(pin.expectedRegistryApprovalId)) {
    addExternal(issues, "external-root-mismatch", "$.registryApproval.approvalId");
  }
  if (approval.audienceHash !== pin.expectedAudienceHash || !nonZeroHash(pin.expectedAudienceHash)) {
    addExternal(issues, "external-audience-mismatch", "$.registryApproval.audienceHash");
  }
  if (approval.issuerKeySetRoot !== pin.expectedIssuerKeySetRoot) {
    addExternal(issues, "external-key-mismatch", "$.registryApproval.issuerKeySetRoot");
  }
}

function publicKeyFromIssuer(key: ExternalQualificationIssuerKeyV2): ReturnType<typeof createPublicKey> {
  // RFC 8410 SubjectPublicKeyInfo prefix for an Ed25519 raw public key.
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const raw = Buffer.from(key.publicKeyHex.slice(2), "hex");
  if (raw.length !== 32) throw new TypeError("issuer public key must contain exactly 32 bytes");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: "der", type: "spki" });
}

function verifyExternalSignature(
  bytes: Uint8Array,
  signatureHex: string,
  key: ExternalQualificationIssuerKeyV2,
): boolean {
  try {
    return verifyEd25519(null, Buffer.from(bytes), publicKeyFromIssuer(key), Buffer.from(signatureHex.slice(2), "hex"));
  } catch {
    return false;
  }
}

function checkIssuerKey(
  key: ExternalQualificationIssuerKeyV2 | undefined,
  issuerId: string,
  keyId: Hash,
  registryEpoch: string,
  audienceHash: Hash,
  issues: QualificationIssue[],
  path: string,
): key is ExternalQualificationIssuerKeyV2 {
  if (key === undefined) {
    addExternal(issues, "external-key-mismatch", `${path}.keyId`);
    return false;
  }
  let valid = true;
  if (key.issuerId !== issuerId || key.keyId !== keyId) {
    addExternal(issues, "external-key-mismatch", path);
    valid = false;
  }
  if (key.audienceHash !== audienceHash) {
    addExternal(issues, "external-audience-mismatch", `${path}.audienceHash`);
    valid = false;
  }
  try {
    const epoch = BigInt(registryEpoch);
    if (epoch < BigInt(key.validFromRegistryEpoch) || epoch > BigInt(key.validThroughRegistryEpoch)) {
      addExternal(issues, "external-epoch-mismatch", `${path}.validity`);
      valid = false;
    }
  } catch {
    addExternal(issues, "malformed", `${path}.validity`);
    valid = false;
  }
  return valid;
}

function checkCertificateMembership(
  registry: QualificationRegistrySnapshotV1,
  certificate: ObserverQualificationCertificateV1 | VerifierQualificationCertificateV1,
  kind: "observer" | "verifier",
  proof: CertificateMembershipProof | undefined,
  pin: ExternalQualificationAuthorityPinV2,
  issues: QualificationIssue[],
  path: string,
): void {
  if (certificate.verdict !== "qualified") addExternal(issues, "external-downgrade", `${path}.certificate.verdict`);
  if (BigInt(certificate.issuedAtRegistryEpoch) > BigInt(registry.epoch)) {
    addExternal(issues, "external-epoch-mismatch", `${path}.certificate.issuedAtRegistryEpoch`);
  }
  if (proof === undefined) {
    addExternal(issues, "missing-membership", `${path}.membershipProof`);
    return;
  }
  const membershipInput = decodeExternal(() => decodeMembershipInput(proof.input), issues, `${path}.membershipProof.input`);
  const membershipResult = decodeExternal(() => decodeMembershipResult(proof.result), issues, `${path}.membershipProof.result`);
  if (membershipInput === null || membershipResult === null) return;
  if (membershipInput.registryRoot !== registry.registryId || membershipResult.registryRoot !== registry.registryId) {
    addExternal(issues, "external-root-mismatch", `${path}.membershipProof.registryRoot`);
  }
  if (membershipInput.registryEpoch !== registry.epoch || membershipResult.registryEpoch !== registry.epoch) {
    addExternal(issues, "external-epoch-mismatch", `${path}.membershipProof.registryEpoch`);
  }
  if (hashDomain("aloha/trusted-issuer-set/v1", membershipInput.trustedIssuerIds) !== registry.trustedIssuerSetRoot) {
    addExternal(issues, "external-membership-mismatch", `${path}.membershipProof.trustedIssuerIds`);
  }
  if (hashDomain("aloha/certificate-set/v1", membershipInput.certificateMemberships) !== registry.certificateSetRoot) {
    addExternal(issues, "external-membership-mismatch", `${path}.membershipProof.certificateMemberships`);
  }
  if (hashDomain("aloha/revoked-certificate-set/v1", membershipInput.revokedCertificateIds) !== registry.revokedCertificateIdsRoot) {
    addExternal(issues, "external-membership-mismatch", `${path}.membershipProof.revokedCertificateIds`);
  }
  try {
    if (hashObserverSigningKeySetRoot(membershipInput.observerSigningKeys.map((key) => key.keyId)) !== registry.observerKeySetRoot) {
      addExternal(issues, "external-membership-mismatch", `${path}.membershipProof.observerSigningKeys`);
    }
    if (hashRevokedObserverKeyIdsRoot(membershipInput.revokedObserverKeyIds) !== registry.revokedObserverKeyIdsRoot) {
      addExternal(issues, "external-membership-mismatch", `${path}.membershipProof.revokedObserverKeyIds`);
    }
  } catch {
    addExternal(issues, "external-membership-mismatch", `${path}.membershipProof.observerKeyRoots`);
  }
  if (
    membershipInput.certificateKind !== kind ||
    membershipInput.certificateId !== certificate.certificateId ||
    membershipInput.certificatePayloadHash !== certificate.payloadHash ||
    membershipInput.issuerId !== certificate.issuerId ||
    membershipResult.inputId !== membershipInput.inputId ||
    membershipResult.certificateKind !== membershipInput.certificateKind ||
    membershipResult.certificateId !== membershipInput.certificateId ||
    membershipResult.certificatePayloadHash !== membershipInput.certificatePayloadHash ||
    membershipResult.issuerId !== membershipInput.issuerId ||
    membershipResult.status !== "member"
  ) {
    addExternal(issues, "external-membership-mismatch", `${path}.membershipProof`);
  }
  const material = membershipInput.certificateMemberships.find(
    (entry) => entry.certificateKind === kind && entry.certificateId === certificate.certificateId,
  );
  if (
    material === undefined ||
    material.certificatePayloadHash !== certificate.payloadHash ||
    material.issuerId !== certificate.issuerId ||
    membershipInput.revokedCertificateIds.includes(certificate.certificateId) ||
    !membershipInput.trustedIssuerIds.includes(certificate.issuerId)
  ) {
    addExternal(issues, "external-membership-mismatch", `${path}.membershipProof.material`);
  }
}

function checkSignedCertificate<TSigned extends SignedObserverCertificateV2 | SignedVerifierCertificateV2>(
  signed: TSigned,
  certificate: ObserverQualificationCertificateV1 | VerifierQualificationCertificateV1,
  kind: "observer" | "verifier",
  registry: QualificationRegistrySnapshotV1,
  issuerKey: ExternalQualificationIssuerKeyV2 | undefined,
  pin: ExternalQualificationAuthorityPinV2,
  membershipProof: CertificateMembershipProof | undefined,
  issues: QualificationIssue[],
  path: string,
): boolean {
  const decoded = kind === "observer"
    ? decodeExternal(() => decodeObserverCertificate(certificate), issues, `${path}.certificate`)
    : decodeExternal(() => decodeVerifierCertificate(certificate), issues, `${path}.certificate`);
  if (decoded === null) return false;
  let bindingsValid = true;
  if (
    signed.certificateId !== decoded.certificateId ||
    signed.payloadHash !== decoded.payloadHash ||
    signed.registryRoot !== registry.registryId ||
    signed.epoch !== registry.epoch ||
    signed.issuerId !== decoded.issuerId ||
    signed.audienceHash !== pin.expectedAudienceHash ||
    !nonZeroHash(pin.expectedAudienceHash)
  ) {
    addExternal(issues, "external-root-mismatch", path);
    bindingsValid = false;
  }
  if (issuerKey !== undefined && (signed.keyId !== issuerKey.keyId || signed.issuerId !== issuerKey.issuerId)) {
    addExternal(issues, "external-key-mismatch", `${path}.keyId`);
    bindingsValid = false;
  }
  checkCertificateMembership(registry, decoded, kind, membershipProof, pin, issues, path);
  if (issuerKey === undefined) return false;
  const bytes = kind === "observer"
    ? observerCertificateSigningBytes(signed as SignedObserverCertificateV2)
    : verifierCertificateSigningBytes(signed as SignedVerifierCertificateV2);
  const signatureVerified = verifyExternalSignature(bytes, signed.signatureHex, issuerKey);
  if (!signatureVerified) addExternal(issues, "external-signature-invalid", `${path}.signatureHex`);
  return signatureVerified && bindingsValid;
}

/**
 * Validates one externally signed registry approval and the selected V1
 * observer/verifier certificate bindings.  Every public key comes from the
 * exact issuer-key-set input and every signed byte string comes from the V2
 * canonical codec; callers cannot provide a callback or override a key.
 */
export function validateExternalQualificationV2(
  input: ExternalQualificationV2Input,
  pin: ExternalQualificationAuthorityPinV2,
): ExternalQualificationValidationResult {
  const issues: QualificationIssue[] = [];
  const registry = decodeExternal(() => decodeQualificationRegistry(input.registry), issues, "$.registry");
  const trustAnchor = decodeExternal(() => decodeExternalQualificationTrustAnchorV2(input.trustAnchor), issues, "$.trustAnchor");
  const approval = decodeExternal(() => decodeSignedQualificationRegistryApprovalV2(input.registryApproval), issues, "$.registryApproval");
  const observer = decodeExternal(() => decodeSignedObserverCertificateV2(input.observer.signed), issues, "$.observer.signed");
  const verifier = decodeExternal(() => decodeSignedVerifierCertificateV2(input.verifier.signed), issues, "$.verifier.signed");
  if (input.observer?.signed === undefined) addExternal(issues, "external-downgrade", "$.observer.signed");
  if (input.verifier?.signed === undefined) addExternal(issues, "external-downgrade", "$.verifier.signed");
  const keys: ExternalQualificationIssuerKeyV2[] = [];
  for (const [index, value] of input.issuerKeys.entries()) {
    const key = decodeExternal(() => decodeExternalQualificationIssuerKeyV2(value), issues, `$.issuerKeys[${index}]`);
    if (key !== null) keys.push(key);
  }
  if (registry === null || trustAnchor === null || approval === null || observer === null || verifier === null) return externalResult(issues, false);
  if (keys.length === 0) addExternal(issues, "missing-membership", "$.issuerKeys");
  try {
    if (hashExternalQualificationIssuerKeySetRoot(keys) !== pin.expectedIssuerKeySetRoot) {
      addExternal(issues, "external-key-mismatch", "$.issuerKeys.root");
    }
  } catch {
    addExternal(issues, "external-key-mismatch", "$.issuerKeys.root");
  }
  checkExternalPin(registry, approval, pin, issues);
  if (
    trustAnchor.anchorId !== pin.expectedGovernanceTrustAnchorHash ||
    registry.governanceTrustAnchorHash !== trustAnchor.anchorId ||
    !nonZeroHash(pin.expectedGovernanceTrustAnchorHash)
  ) {
    addExternal(issues, "governance-mismatch", "$.trustAnchor.anchorId");
  }
  if (trustAnchor.issuerKeySetRoot !== pin.expectedIssuerKeySetRoot || trustAnchor.currentRegistryEpoch !== registry.epoch || trustAnchor.audienceHash !== pin.expectedAudienceHash) {
    addExternal(issues, "external-root-mismatch", "$.trustAnchor");
  }
  try {
    validateExternalQualificationTrustAnchorGovernanceKey(trustAnchor, keys);
    const issuerIds = [...new Set(keys.map((key) => key.issuerId))].sort();
    if (
      hashExternalQualificationIssuerSetRoot(issuerIds) !== trustAnchor.issuerSetRoot ||
      hashDomain("aloha/trusted-issuer-set/v1", issuerIds) !== registry.trustedIssuerSetRoot
    ) {
      addExternal(issues, "external-key-mismatch", "$.trustAnchor.issuerSetRoot");
    }
  } catch {
    addExternal(issues, "external-key-mismatch", "$.trustAnchor.issuerSetRoot");
  }
  const approvalUsesGovernanceKey =
    approval.issuerId === trustAnchor.governanceIssuerId &&
    approval.keyId === trustAnchor.governanceKeyId;
  if (!approvalUsesGovernanceKey) {
    addExternal(issues, "external-key-mismatch", "$.registryApproval.issuerKey");
  }
  const approvalKey = keys.find((key) => key.keyId === approval.keyId);
  const approvalKeyUsable = approvalUsesGovernanceKey && checkIssuerKey(
    approvalKey,
    approval.issuerId,
    approval.keyId,
    registry.epoch,
    pin.expectedAudienceHash,
    issues,
    "$.registryApproval.issuerKey",
  );
  const approvalSignatureVerified = approvalKeyUsable && verifyExternalSignature(
    qualificationRegistryApprovalSigningBytes(approval),
    approval.signatureHex,
    approvalKey!,
  );
  if (!approvalSignatureVerified) addExternal(issues, "external-signature-invalid", "$.registryApproval.signatureHex");
  const observerKey = keys.find((key) => key.keyId === observer.keyId);
  const verifierKey = keys.find((key) => key.keyId === verifier.keyId);
  const observerKeyUsable = checkIssuerKey(observerKey, observer.issuerId, observer.keyId, registry.epoch, pin.expectedAudienceHash, issues, "$.observer.issuerKey");
  const verifierKeyUsable = checkIssuerKey(verifierKey, verifier.issuerId, verifier.keyId, registry.epoch, pin.expectedAudienceHash, issues, "$.verifier.issuerKey");
  const observerSignatureVerified = checkSignedCertificate(
    observer,
    input.observer.certificate,
    "observer",
    registry,
    observerKeyUsable ? observerKey : undefined,
    pin,
    input.observer.membershipProof,
    issues,
    "$.observer",
  );
  const verifierSignatureVerified = checkSignedCertificate(
    verifier,
    input.verifier.certificate,
    "verifier",
    registry,
    verifierKeyUsable ? verifierKey : undefined,
    pin,
    input.verifier.membershipProof,
    issues,
    "$.verifier",
  );
  return externalResult(issues, approvalSignatureVerified && observerSignatureVerified && verifierSignatureVerified);
}
