import {
  arraySchema,
  decodeCanonicalJson,
  decimalStringSchema,
  defineSchema,
  defineSchemaManifest,
  deepFreeze,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  gitSha40Schema,
  hashDomain,
  hashSchema,
  literalSchema,
  nonEmptyStringSchema,
  objectSchema,
  type CodecSchema,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";

/**
 * V2 is the external-authority wire contract.  The V1 qualification objects
 * remain useful as internal material, but none of these schemas accepts a V1
 * object or an unsigned placeholder.
 */

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const ZERO_SIGNATURE = `0x${"0".repeat(128)}`;

function fixedHexSchema(byteLength: number, kind: string): CodecSchema<string> {
  const pattern = new RegExp(`^0x[0-9a-f]{${byteLength * 2}}$`);
  return defineSchema({ kind, byteLength }, (value, path = "$") => {
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new TypeError(`expected lowercase ${byteLength}-byte 0x hex at ${path}`);
    }
    return value;
  });
}

const issuerPublicKeyHexSchema = fixedHexSchema(32, "ed25519-public-key-hex-v2");
const signatureHexSchema = fixedHexSchema(64, "ed25519-signature-hex-v2");

const issuerKeyPayloadSchema = objectSchema({
  schemaVersion: literalSchema(2),
  kind: literalSchema("aloha.external-qualification-issuer-key"),
  issuerId: nonEmptyStringSchema,
  algorithm: literalSchema("ed25519"),
  publicKeyHex: issuerPublicKeyHexSchema,
  validFromRegistryEpoch: decimalStringSchema,
  validThroughRegistryEpoch: decimalStringSchema,
  audienceHash: hashSchema,
});

const issuerKeySchema = objectSchema({
  ...issuerKeyPayloadFields(),
  keyId: hashSchema,
});

function issuerKeyPayloadFields() {
  return {
    schemaVersion: literalSchema(2),
    kind: literalSchema("aloha.external-qualification-issuer-key"),
    issuerId: nonEmptyStringSchema,
    algorithm: literalSchema("ed25519"),
    publicKeyHex: issuerPublicKeyHexSchema,
    validFromRegistryEpoch: decimalStringSchema,
    validThroughRegistryEpoch: decimalStringSchema,
    audienceHash: hashSchema,
  } as const;
}

const registryApprovalCoreSchema = objectSchema({
  schemaVersion: literalSchema(2),
  kind: literalSchema("aloha.signed-qualification-registry-approval"),
  registryRoot: hashSchema,
  registryPayloadHash: hashSchema,
  issuerKeySetRoot: hashSchema,
  epoch: decimalStringSchema,
  audienceHash: hashSchema,
  issuerId: nonEmptyStringSchema,
  keyId: hashSchema,
});

const registryApprovalSigningInputSchema = objectSchema({
  ...registryApprovalCoreFields(),
});

function registryApprovalCoreFields() {
  return {
    schemaVersion: literalSchema(2),
    kind: literalSchema("aloha.signed-qualification-registry-approval"),
    registryRoot: hashSchema,
    registryPayloadHash: hashSchema,
    issuerKeySetRoot: hashSchema,
    epoch: decimalStringSchema,
    audienceHash: hashSchema,
    issuerId: nonEmptyStringSchema,
    keyId: hashSchema,
  } as const;
}

const registryApprovalSchema = objectSchema({
  ...registryApprovalCoreFields(),
  approvalId: hashSchema,
  payloadHash: hashSchema,
  signatureAlgorithm: literalSchema("ed25519"),
  signatureHex: signatureHexSchema,
});

const observerCertificateSigningInputSchema = objectSchema({
  schemaVersion: literalSchema(2),
  kind: literalSchema("aloha.observer-qualification"),
  certificateId: hashSchema,
  payloadHash: hashSchema,
  registryRoot: hashSchema,
  epoch: decimalStringSchema,
  audienceHash: hashSchema,
  issuerId: nonEmptyStringSchema,
  keyId: hashSchema,
});

const observerCertificateSchema = objectSchema({
  ...observerCertificateSigningInputFields(),
  signatureAlgorithm: literalSchema("ed25519"),
  signatureHex: signatureHexSchema,
});

function observerCertificateSigningInputFields() {
  return {
    schemaVersion: literalSchema(2),
    kind: literalSchema("aloha.observer-qualification"),
    certificateId: hashSchema,
    payloadHash: hashSchema,
    registryRoot: hashSchema,
    epoch: decimalStringSchema,
    audienceHash: hashSchema,
    issuerId: nonEmptyStringSchema,
    keyId: hashSchema,
  } as const;
}

const verifierCertificateSigningInputSchema = objectSchema({
  schemaVersion: literalSchema(2),
  kind: literalSchema("aloha.verifier-qualification"),
  certificateId: hashSchema,
  payloadHash: hashSchema,
  registryRoot: hashSchema,
  epoch: decimalStringSchema,
  audienceHash: hashSchema,
  issuerId: nonEmptyStringSchema,
  keyId: hashSchema,
});

const verifierCertificateSchema = objectSchema({
  ...verifierCertificateSigningInputFields(),
  signatureAlgorithm: literalSchema("ed25519"),
  signatureHex: signatureHexSchema,
});

function verifierCertificateSigningInputFields() {
  return {
    schemaVersion: literalSchema(2),
    kind: literalSchema("aloha.verifier-qualification"),
    certificateId: hashSchema,
    payloadHash: hashSchema,
    registryRoot: hashSchema,
    epoch: decimalStringSchema,
    audienceHash: hashSchema,
    issuerId: nonEmptyStringSchema,
    keyId: hashSchema,
  } as const;
}

const hashArrayV2Schema = arraySchema(hashSchema);

const trustAnchorPayloadSchema = objectSchema({
  schemaVersion: literalSchema(2),
  kind: literalSchema("aloha.external-qualification-trust-anchor"),
  issuerSetRoot: hashSchema,
  issuerKeySetRoot: hashSchema,
  governanceIssuerId: nonEmptyStringSchema,
  governanceKeyId: hashSchema,
  validFromRegistryEpoch: decimalStringSchema,
  validThroughRegistryEpoch: decimalStringSchema,
  currentRegistryEpoch: decimalStringSchema,
  audienceHash: hashSchema,
});

const trustAnchorSchema = objectSchema({
  ...trustAnchorPayloadFields(),
  anchorId: hashSchema,
});

function trustAnchorPayloadFields() {
  return {
    schemaVersion: literalSchema(2),
    kind: literalSchema("aloha.external-qualification-trust-anchor"),
    issuerSetRoot: hashSchema,
    issuerKeySetRoot: hashSchema,
    governanceIssuerId: nonEmptyStringSchema,
    governanceKeyId: hashSchema,
    validFromRegistryEpoch: decimalStringSchema,
    validThroughRegistryEpoch: decimalStringSchema,
    currentRegistryEpoch: decimalStringSchema,
    audienceHash: hashSchema,
  } as const;
}

const releaseAcceptanceRequirementCoreFields = {
  predicateId: nonEmptyStringSchema,
  predicateSpecDigest: hashSchema,
  predicateCompositionLeafDigest: hashSchema,
  authorityPinDigest: hashSchema,
  verifierCertificateId: hashSchema,
  observerCertificateIds: hashArrayV2Schema,
  observerCertificateIdsRoot: hashSchema,
} as const;

const releaseAcceptanceRequirementCoreSchema = objectSchema(releaseAcceptanceRequirementCoreFields);

const releaseAcceptanceRequirementSchema = objectSchema({
  ...releaseAcceptanceRequirementCoreFields,
  requirementLeafDigest: hashSchema,
});

const releaseAcceptanceRequirementArraySchema = arraySchema(releaseAcceptanceRequirementSchema);

const releaseAuthorityApprovalCoreSchema = objectSchema({
  schemaVersion: literalSchema(3),
  kind: literalSchema("aloha.signed-release-authority-approval"),
  externalTrustAnchorRoot: hashSchema,
  issuerKeySetRoot: hashSchema,
  registryApprovalId: hashSchema,
  registryRoot: hashSchema,
  releaseAcceptanceRequirements: releaseAcceptanceRequirementArraySchema,
  releaseAcceptanceRequirementSetRoot: hashSchema,
  predicateCompositionRootDigest: hashSchema,
  gateCoreRuntimeClosureDigest: hashSchema,
  gateCoreImplementationClosureDigest: hashSchema,
  releaseRoleManifestRoot: hashSchema,
  candidateReleaseCommit: gitSha40Schema,
  qualifiedRunnerIssuerId: nonEmptyStringSchema,
  qualifiedRunnerKeyId: hashSchema,
  qualifiedRunnerImplementationClosureDigest: hashSchema,
  qualifiedRunnerImplementationExportDigest: hashSchema,
  epoch: decimalStringSchema,
  audienceHash: hashSchema,
  issuerId: nonEmptyStringSchema,
  keyId: hashSchema,
});

const releaseAuthorityApprovalSigningInputSchema = objectSchema({
  ...releaseAuthorityApprovalCoreFields(),
});

function releaseAuthorityApprovalCoreFields() {
  return {
    schemaVersion: literalSchema(3),
    kind: literalSchema("aloha.signed-release-authority-approval"),
    externalTrustAnchorRoot: hashSchema,
    issuerKeySetRoot: hashSchema,
    registryApprovalId: hashSchema,
    registryRoot: hashSchema,
    releaseAcceptanceRequirements: releaseAcceptanceRequirementArraySchema,
    releaseAcceptanceRequirementSetRoot: hashSchema,
    predicateCompositionRootDigest: hashSchema,
    gateCoreRuntimeClosureDigest: hashSchema,
    gateCoreImplementationClosureDigest: hashSchema,
    releaseRoleManifestRoot: hashSchema,
    candidateReleaseCommit: gitSha40Schema,
    qualifiedRunnerIssuerId: nonEmptyStringSchema,
    qualifiedRunnerKeyId: hashSchema,
    qualifiedRunnerImplementationClosureDigest: hashSchema,
    qualifiedRunnerImplementationExportDigest: hashSchema,
    epoch: decimalStringSchema,
    audienceHash: hashSchema,
    issuerId: nonEmptyStringSchema,
    keyId: hashSchema,
  } as const;
}

const releaseAuthorityApprovalSchema = objectSchema({
  ...releaseAuthorityApprovalCoreFields(),
  approvalId: hashSchema,
  payloadHash: hashSchema,
  signatureAlgorithm: literalSchema("ed25519"),
  signatureHex: signatureHexSchema,
});

const releaseAcceptanceResultCoreFields = {
  predicateId: nonEmptyStringSchema,
  predicateSpecDigest: hashSchema,
  predicateCompositionLeafDigest: hashSchema,
  requirementLeafDigest: hashSchema,
  acceptanceCertificateId: hashSchema,
  acceptanceCertificatePayloadHash: hashSchema,
  verdict: literalSchema("pass"),
} as const;

const releaseAcceptanceResultCoreSchema = objectSchema(releaseAcceptanceResultCoreFields);
const releaseAcceptanceResultSchema = objectSchema({
  ...releaseAcceptanceResultCoreFields,
  resultLeafDigest: hashSchema,
});

const releaseAcceptanceSetSchema = objectSchema({
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.release-acceptance-set"),
  releaseAcceptanceRequirementSetRoot: hashSchema,
  entries: arraySchema(releaseAcceptanceResultSchema),
  root: hashSchema,
});

const signedReleaseAcceptanceApprovalCoreFields = {
  schemaVersion: literalSchema(1),
  kind: literalSchema("aloha.signed-release-acceptance-approval"),
  releaseAuthorityApprovalId: hashSchema,
  releaseAuthorityApprovalPayloadHash: hashSchema,
  runtimeReleaseBindingId: hashSchema,
  releaseAcceptanceRequirementSetRoot: hashSchema,
  releaseAcceptanceSetRoot: hashSchema,
  predicateCompositionRootDigest: hashSchema,
  gateCoreRuntimeClosureDigest: hashSchema,
  gateCoreImplementationClosureDigest: hashSchema,
  releaseRoleManifestRoot: hashSchema,
  candidateReleaseCommit: gitSha40Schema,
  externalTrustAnchorRoot: hashSchema,
  issuerKeySetRoot: hashSchema,
  registryApprovalId: hashSchema,
  registryRoot: hashSchema,
  epoch: decimalStringSchema,
  audienceHash: hashSchema,
  issuerId: nonEmptyStringSchema,
  keyId: hashSchema,
  qualifiedRunnerImplementationClosureDigest: hashSchema,
  qualifiedRunnerImplementationExportDigest: hashSchema,
} as const;

const signedReleaseAcceptanceApprovalCoreSchema = objectSchema(
  signedReleaseAcceptanceApprovalCoreFields,
);
const signedReleaseAcceptanceApprovalSchema = objectSchema({
  ...signedReleaseAcceptanceApprovalCoreFields,
  approvalId: hashSchema,
  payloadHash: hashSchema,
  signatureAlgorithm: literalSchema("ed25519"),
  signatureHex: signatureHexSchema,
});

export type ExternalQualificationIssuerKeyV2 = Infer<typeof issuerKeySchema>;
export type ExternalQualificationIssuerKeyMaterialV2 = Omit<ExternalQualificationIssuerKeyV2, "keyId">;
export type SignedQualificationRegistryApprovalV2 = Infer<typeof registryApprovalSchema>;
export type SignedQualificationRegistryApprovalSigningInputV2 = Infer<typeof registryApprovalSigningInputSchema>;
export type ExternalQualificationTrustAnchorV2 = Infer<typeof trustAnchorSchema>;
export type SignedObserverCertificateV2 = Infer<typeof observerCertificateSchema>;
export type SignedObserverCertificateSigningInputV2 = Infer<typeof observerCertificateSigningInputSchema>;
export type SignedVerifierCertificateV2 = Infer<typeof verifierCertificateSchema>;
export type SignedVerifierCertificateSigningInputV2 = Infer<typeof verifierCertificateSigningInputSchema>;
export type ReleaseAcceptanceRequirementV1 = Infer<typeof releaseAcceptanceRequirementSchema>;
export type ReleaseAcceptanceRequirementInputV1 = Infer<typeof releaseAcceptanceRequirementCoreSchema>;
export type SignedReleaseAuthorityApprovalV3 = Infer<typeof releaseAuthorityApprovalSchema>;
export type SignedReleaseAuthorityApprovalSigningInputV3 = Infer<typeof releaseAuthorityApprovalSigningInputSchema>;
export type ReleaseAcceptanceResultV1 = Infer<typeof releaseAcceptanceResultSchema>;
export type ReleaseAcceptanceResultInputV1 = Infer<typeof releaseAcceptanceResultCoreSchema>;
export type ReleaseAcceptanceSetV1 = Infer<typeof releaseAcceptanceSetSchema>;
export type SignedReleaseAcceptanceApprovalV1 = Infer<typeof signedReleaseAcceptanceApprovalSchema>;
export type SignedReleaseAcceptanceApprovalSigningInputV1 = Infer<typeof signedReleaseAcceptanceApprovalCoreSchema>;

export const EXTERNAL_QUALIFICATION_V2_DOMAINS = Object.freeze({
  issuerKey: "aloha/external-qualification-issuer-key/v2",
  issuerSet: "aloha/external-qualification-issuer-set/v2",
  issuerKeySet: "aloha/external-qualification-issuer-key-set/v2",
  registryApprovalPayload: "aloha/signed-qualification-registry-approval/payload/v2",
  registryApprovalId: "aloha/signed-qualification-registry-approval/id/v2",
  registryApprovalSigning: "aloha/signed-qualification-registry-approval/v2",
  certificateSigning: "aloha/signed-qualification-certificate/v2",
  trustAnchor: "aloha/external-qualification-trust-anchor/v2",
  releaseObserverCertificateSet: "aloha/signed-release-authority-approval/observer-certificate-set/v3",
  releaseAcceptanceRequirementLeaf: "aloha/release-acceptance-requirement/leaf/v1",
  releaseAcceptanceRequirementSet: "aloha/release-acceptance-requirement-set/v1",
  releaseAuthorityApprovalPayload: "aloha/signed-release-authority-approval/payload/v3",
  releaseAuthorityApprovalId: "aloha/signed-release-authority-approval/id/v3",
  releaseAuthorityApprovalSigning: "aloha/signed-release-authority-approval/v3",
});

export const RELEASE_ACCEPTANCE_APPROVAL_V1_DOMAINS = Object.freeze({
  resultLeaf: "aloha/release-acceptance-result/leaf/v1",
  resultSet: "aloha/release-acceptance-result-set/v1",
  approvalPayload: "aloha/signed-release-acceptance-approval/payload/v1",
  approvalId: "aloha/signed-release-acceptance-approval/id/v1",
  approvalSigning: "aloha/signed-release-acceptance-approval/signing/v1",
});

function positiveEpoch(value: string, path: string): void {
  if (BigInt(value) < 0n) throw new TypeError(`epoch must be non-negative at ${path}`);
}

function checkValidityInterval(
  validFromRegistryEpoch: string,
  validThroughRegistryEpoch: string,
  path: string,
): void {
  positiveEpoch(validFromRegistryEpoch, `${path}.validFromRegistryEpoch`);
  positiveEpoch(validThroughRegistryEpoch, `${path}.validThroughRegistryEpoch`);
  if (BigInt(validFromRegistryEpoch) > BigInt(validThroughRegistryEpoch)) {
    throw new TypeError(`issuer key validity interval is inverted at ${path}`);
  }
}

function requireNonZeroHash(value: Hash, path: string): void {
  if (value === ZERO_HASH) throw new TypeError(`hash must be non-zero at ${path}`);
}

function requireNonZeroSignature(value: string, path: string): void {
  if (value === ZERO_SIGNATURE) throw new TypeError(`signature must not be an unsigned placeholder at ${path}`);
}

function payloadWithoutFields<T extends object>(value: T, fields: readonly string[]): Record<string, unknown> {
  const output: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of fields) delete output[field];
  return output;
}

function parseV2Input(value: string | Uint8Array | object): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}

function checkIssuerKey(value: ExternalQualificationIssuerKeyV2, path: string): ExternalQualificationIssuerKeyV2 {
  checkValidityInterval(value.validFromRegistryEpoch, value.validThroughRegistryEpoch, path);
  requireNonZeroHash(value.audienceHash, `${path}.audienceHash`);
  if (value.publicKeyHex === `0x${"00".repeat(32)}`) throw new TypeError(`public key must not be all zero at ${path}.publicKeyHex`);
  const expected = hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.issuerKey, payloadWithoutFields(value, ["keyId"]));
  if (value.keyId !== expected) throw new TypeError(`issuer keyId mismatch at ${path}.keyId`);
  return deepFreeze(value);
}

function issuerKeyMaterial(value: ExternalQualificationIssuerKeyV2): Record<string, unknown> {
  return {
    issuerId: value.issuerId,
    algorithm: value.algorithm,
    publicKeyHex: value.publicKeyHex,
    validFromRegistryEpoch: value.validFromRegistryEpoch,
    validThroughRegistryEpoch: value.validThroughRegistryEpoch,
    audienceHash: value.audienceHash,
    keyId: value.keyId,
  };
}

function issuerKeyMaterialSortKey(value: ExternalQualificationIssuerKeyV2): string {
  return encodeCanonicalJson(issuerKeyMaterial(value));
}

function checkStrictSortedHashes(values: readonly Hash[], path: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      throw new TypeError(`hashes must be strictly sorted and unique at ${path}[${index}]`);
    }
  }
}

function observerCertificateIdsRoot(ids: readonly Hash[]): Hash {
  return hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.releaseObserverCertificateSet, ids);
}

function releaseAcceptanceRequirementLeaf(
  value: ReleaseAcceptanceRequirementInputV1,
): Hash {
  return hashDomain(
    EXTERNAL_QUALIFICATION_V2_DOMAINS.releaseAcceptanceRequirementLeaf,
    releaseAcceptanceRequirementCoreSchema.decode(value),
  );
}

function releaseAcceptanceRequirementSetRoot(
  values: readonly ReleaseAcceptanceRequirementV1[],
): Hash {
  return hashDomain(
    EXTERNAL_QUALIFICATION_V2_DOMAINS.releaseAcceptanceRequirementSet,
    values.map(value => value.requirementLeafDigest),
  );
}

function checkApproval(value: SignedQualificationRegistryApprovalV2, path: string): SignedQualificationRegistryApprovalV2 {
  positiveEpoch(value.epoch, `${path}.epoch`);
  requireNonZeroHash(value.registryRoot, `${path}.registryRoot`);
  requireNonZeroHash(value.registryPayloadHash, `${path}.registryPayloadHash`);
  requireNonZeroHash(value.issuerKeySetRoot, `${path}.issuerKeySetRoot`);
  requireNonZeroHash(value.audienceHash, `${path}.audienceHash`);
  requireNonZeroHash(value.keyId, `${path}.keyId`);
  requireNonZeroHash(value.payloadHash, `${path}.payloadHash`);
  requireNonZeroHash(value.approvalId, `${path}.approvalId`);
  requireNonZeroSignature(value.signatureHex, `${path}.signatureHex`);
  const core = registryApprovalCoreSchema.decode(payloadWithoutFields(value, ["approvalId", "payloadHash", "signatureAlgorithm", "signatureHex"]), path);
  const expectedPayloadHash = hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.registryApprovalPayload, core);
  if (value.payloadHash !== expectedPayloadHash) throw new TypeError(`registry approval payloadHash mismatch at ${path}.payloadHash`);
  const expectedId = hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.registryApprovalId, { payloadHash: expectedPayloadHash });
  if (value.approvalId !== expectedId) throw new TypeError(`registry approval approvalId mismatch at ${path}.approvalId`);
  return deepFreeze(value);
}

function checkTrustAnchor(value: ExternalQualificationTrustAnchorV2, path: string): ExternalQualificationTrustAnchorV2 {
  checkValidityInterval(value.validFromRegistryEpoch, value.validThroughRegistryEpoch, path);
  positiveEpoch(value.currentRegistryEpoch, `${path}.currentRegistryEpoch`);
  const current = BigInt(value.currentRegistryEpoch);
  if (current < BigInt(value.validFromRegistryEpoch) || current > BigInt(value.validThroughRegistryEpoch)) {
    throw new TypeError(`current registry epoch is outside trust-anchor validity interval at ${path}.currentRegistryEpoch`);
  }
  requireNonZeroHash(value.issuerSetRoot, `${path}.issuerSetRoot`);
  requireNonZeroHash(value.issuerKeySetRoot, `${path}.issuerKeySetRoot`);
  requireNonZeroHash(value.governanceKeyId, `${path}.governanceKeyId`);
  requireNonZeroHash(value.audienceHash, `${path}.audienceHash`);
  requireNonZeroHash(value.anchorId, `${path}.anchorId`);
  const expected = hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.trustAnchor, payloadWithoutFields(value, ["anchorId"]));
  if (value.anchorId !== expected) throw new TypeError(`trust anchor anchorId mismatch at ${path}.anchorId`);
  return deepFreeze(value);
}

function checkCertificateBase(
  value: SignedObserverCertificateV2 | SignedVerifierCertificateV2,
  path: string,
  kind: "observer" | "verifier",
): SignedObserverCertificateV2 | SignedVerifierCertificateV2 {
  positiveEpoch(value.epoch, `${path}.epoch`);
  requireNonZeroHash(value.certificateId, `${path}.certificateId`);
  requireNonZeroHash(value.payloadHash, `${path}.payloadHash`);
  requireNonZeroHash(value.registryRoot, `${path}.registryRoot`);
  requireNonZeroHash(value.audienceHash, `${path}.audienceHash`);
  requireNonZeroHash(value.keyId, `${path}.keyId`);
  requireNonZeroSignature(value.signatureHex, `${path}.signatureHex`);
  const expectedIdDomain = kind === "observer"
    ? "aloha/observer-qualification/id/v1"
    : "aloha/verifier-qualification/id/v1";
  const expectedId = hashDomain(expectedIdDomain, value.payloadHash);
  if (value.certificateId !== expectedId) throw new TypeError(`certificateId does not bind payloadHash at ${path}.certificateId`);
  return deepFreeze(value);
}

function checkReleaseAuthorityApproval(
  value: SignedReleaseAuthorityApprovalV3,
  path: string,
): SignedReleaseAuthorityApprovalV3 {
  if (value.candidateReleaseCommit === "0".repeat(40)) {
    throw new TypeError(`candidate release commit must be non-zero at ${path}.candidateReleaseCommit`);
  }
  for (const [field, digest] of [
    ["externalTrustAnchorRoot", value.externalTrustAnchorRoot],
    ["issuerKeySetRoot", value.issuerKeySetRoot],
    ["registryApprovalId", value.registryApprovalId],
    ["registryRoot", value.registryRoot],
    ["releaseAcceptanceRequirementSetRoot", value.releaseAcceptanceRequirementSetRoot],
    ["predicateCompositionRootDigest", value.predicateCompositionRootDigest],
    ["gateCoreRuntimeClosureDigest", value.gateCoreRuntimeClosureDigest],
    ["gateCoreImplementationClosureDigest", value.gateCoreImplementationClosureDigest],
    ["releaseRoleManifestRoot", value.releaseRoleManifestRoot],
    ["qualifiedRunnerKeyId", value.qualifiedRunnerKeyId],
    ["qualifiedRunnerImplementationClosureDigest", value.qualifiedRunnerImplementationClosureDigest],
    ["qualifiedRunnerImplementationExportDigest", value.qualifiedRunnerImplementationExportDigest],
    ["audienceHash", value.audienceHash],
    ["keyId", value.keyId],
    ["payloadHash", value.payloadHash],
    ["approvalId", value.approvalId],
  ] as const) {
    requireNonZeroHash(digest, `${path}.${field}`);
  }
  requireNonZeroSignature(value.signatureHex, `${path}.signatureHex`);
  if (value.releaseAcceptanceRequirements.length === 0) {
    throw new TypeError(`release acceptance requirements must not be empty at ${path}.releaseAcceptanceRequirements`);
  }
  for (let index = 0; index < value.releaseAcceptanceRequirements.length; index += 1) {
    const requirement = value.releaseAcceptanceRequirements[index]!;
    if (index > 0 && value.releaseAcceptanceRequirements[index - 1]!.predicateId >= requirement.predicateId) {
      throw new TypeError(`release acceptance requirements must be strictly sorted and unique at ${path}.releaseAcceptanceRequirements[${index}]`);
    }
    checkStrictSortedHashes(requirement.observerCertificateIds, `${path}.releaseAcceptanceRequirements[${index}].observerCertificateIds`);
    for (const [field, digest] of [
      ["predicateSpecDigest", requirement.predicateSpecDigest],
      ["predicateCompositionLeafDigest", requirement.predicateCompositionLeafDigest],
      ["authorityPinDigest", requirement.authorityPinDigest],
      ["verifierCertificateId", requirement.verifierCertificateId],
      ["observerCertificateIdsRoot", requirement.observerCertificateIdsRoot],
      ["requirementLeafDigest", requirement.requirementLeafDigest],
    ] as const) requireNonZeroHash(digest, `${path}.releaseAcceptanceRequirements[${index}].${field}`);
    if (requirement.observerCertificateIdsRoot !== observerCertificateIdsRoot(requirement.observerCertificateIds)) {
      throw new TypeError(`observer certificate root mismatch at ${path}.releaseAcceptanceRequirements[${index}].observerCertificateIdsRoot`);
    }
    const { requirementLeafDigest: _leaf, ...core } = requirement;
    if (requirement.requirementLeafDigest !== releaseAcceptanceRequirementLeaf(core)) {
      throw new TypeError(`release acceptance requirement leaf mismatch at ${path}.releaseAcceptanceRequirements[${index}].requirementLeafDigest`);
    }
  }
  if (value.releaseAcceptanceRequirementSetRoot !== releaseAcceptanceRequirementSetRoot(value.releaseAcceptanceRequirements)) {
    throw new TypeError(`release acceptance requirement set root mismatch at ${path}.releaseAcceptanceRequirementSetRoot`);
  }
  positiveEpoch(value.epoch, `${path}.epoch`);
  const core = releaseAuthorityApprovalCoreSchema.decode(
    payloadWithoutFields(value, ["approvalId", "payloadHash", "signatureAlgorithm", "signatureHex"]),
    path,
  );
  const expectedPayloadHash = hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.releaseAuthorityApprovalPayload, core);
  if (value.payloadHash !== expectedPayloadHash) throw new TypeError(`release authority approval payloadHash mismatch at ${path}.payloadHash`);
  const expectedId = hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.releaseAuthorityApprovalId, { payloadHash: expectedPayloadHash });
  if (value.approvalId !== expectedId) throw new TypeError(`release authority approval approvalId mismatch at ${path}.approvalId`);
  return deepFreeze(value);
}

function releaseAcceptanceResultLeaf(value: ReleaseAcceptanceResultInputV1): Hash {
  return hashDomain(
    RELEASE_ACCEPTANCE_APPROVAL_V1_DOMAINS.resultLeaf,
    releaseAcceptanceResultCoreSchema.decode(value),
  );
}

function releaseAcceptanceSetRoot(value: Pick<ReleaseAcceptanceSetV1, "releaseAcceptanceRequirementSetRoot" | "entries">): Hash {
  return hashDomain(RELEASE_ACCEPTANCE_APPROVAL_V1_DOMAINS.resultSet, {
    releaseAcceptanceRequirementSetRoot: value.releaseAcceptanceRequirementSetRoot,
    resultLeafDigests: value.entries.map(entry => entry.resultLeafDigest),
  });
}

function checkReleaseAcceptanceSet(value: ReleaseAcceptanceSetV1, path: string): ReleaseAcceptanceSetV1 {
  requireNonZeroHash(value.releaseAcceptanceRequirementSetRoot, `${path}.releaseAcceptanceRequirementSetRoot`);
  if (value.entries.length === 0) throw new TypeError(`release acceptance result set must not be empty at ${path}.entries`);
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = value.entries[index]!;
    if (index > 0 && value.entries[index - 1]!.predicateId >= entry.predicateId) {
      throw new TypeError(`release acceptance results must be strictly sorted and unique at ${path}.entries[${index}]`);
    }
    for (const [field, digest] of [
      ["predicateSpecDigest", entry.predicateSpecDigest],
      ["predicateCompositionLeafDigest", entry.predicateCompositionLeafDigest],
      ["requirementLeafDigest", entry.requirementLeafDigest],
      ["acceptanceCertificateId", entry.acceptanceCertificateId],
      ["acceptanceCertificatePayloadHash", entry.acceptanceCertificatePayloadHash],
      ["resultLeafDigest", entry.resultLeafDigest],
    ] as const) requireNonZeroHash(digest, `${path}.entries[${index}].${field}`);
    const { resultLeafDigest: _leaf, ...core } = entry;
    if (entry.resultLeafDigest !== releaseAcceptanceResultLeaf(core)) {
      throw new TypeError(`release acceptance result leaf mismatch at ${path}.entries[${index}].resultLeafDigest`);
    }
  }
  if (value.root !== releaseAcceptanceSetRoot(value)) {
    throw new TypeError(`release acceptance set root mismatch at ${path}.root`);
  }
  return deepFreeze(value);
}

function checkSignedReleaseAcceptanceApproval(
  value: SignedReleaseAcceptanceApprovalV1,
  path: string,
): SignedReleaseAcceptanceApprovalV1 {
  if (value.candidateReleaseCommit === "0".repeat(40)) {
    throw new TypeError(`candidate release commit must be non-zero at ${path}.candidateReleaseCommit`);
  }
  positiveEpoch(value.epoch, `${path}.epoch`);
  for (const [field, digest] of Object.entries(value)) {
    if (field.endsWith("Root") || field.endsWith("Digest") || field.endsWith("Id") || field.endsWith("Hash")) {
      if (typeof digest === "string" && /^0x[0-9a-f]{64}$/.test(digest)) requireNonZeroHash(digest as Hash, `${path}.${field}`);
    }
  }
  requireNonZeroSignature(value.signatureHex, `${path}.signatureHex`);
  const core = signedReleaseAcceptanceApprovalCoreSchema.decode(
    payloadWithoutFields(value, ["approvalId", "payloadHash", "signatureAlgorithm", "signatureHex"]),
    path,
  );
  const payloadHash = hashDomain(RELEASE_ACCEPTANCE_APPROVAL_V1_DOMAINS.approvalPayload, core);
  const approvalId = hashDomain(RELEASE_ACCEPTANCE_APPROVAL_V1_DOMAINS.approvalId, { payloadHash });
  if (value.payloadHash !== payloadHash || value.approvalId !== approvalId) {
    throw new TypeError(`release acceptance approval identity mismatch at ${path}`);
  }
  return deepFreeze(value);
}

export const QUALIFICATION_V2_SCHEMAS = Object.freeze({
  externalIssuerKey: defineSchema(
    { kind: "aloha.external-qualification-issuer-key-v2", fields: issuerKeySchema.descriptor },
    (value, path = "$") => checkIssuerKey(issuerKeySchema.decode(value, path), path),
  ),
  signedRegistryApproval: defineSchema(
    { kind: "aloha.signed-qualification-registry-approval-v2", fields: registryApprovalSchema.descriptor },
    (value, path = "$") => checkApproval(registryApprovalSchema.decode(value, path), path),
  ),
  externalTrustAnchor: defineSchema(
    { kind: "aloha.external-qualification-trust-anchor-v2", fields: trustAnchorSchema.descriptor },
    (value, path = "$") => checkTrustAnchor(trustAnchorSchema.decode(value, path), path),
  ),
  signedObserverCertificate: defineSchema(
    { kind: "aloha.signed-observer-certificate-v2", fields: observerCertificateSchema.descriptor },
    (value, path = "$") => checkCertificateBase(observerCertificateSchema.decode(value, path), path, "observer") as SignedObserverCertificateV2,
  ),
  signedVerifierCertificate: defineSchema(
    { kind: "aloha.signed-verifier-certificate-v2", fields: verifierCertificateSchema.descriptor },
    (value, path = "$") => checkCertificateBase(verifierCertificateSchema.decode(value, path), path, "verifier") as SignedVerifierCertificateV2,
  ),
  signedReleaseAuthorityApproval: defineSchema(
    { kind: "aloha.signed-release-authority-approval-v3", fields: releaseAuthorityApprovalSchema.descriptor },
    (value, path = "$") => checkReleaseAuthorityApproval(releaseAuthorityApprovalSchema.decode(value, path), path),
  ),
  releaseAcceptanceSet: defineSchema(
    { kind: "aloha.release-acceptance-set-v1", fields: releaseAcceptanceSetSchema.descriptor },
    (value, path = "$") => checkReleaseAcceptanceSet(releaseAcceptanceSetSchema.decode(value, path), path),
  ),
  signedReleaseAcceptanceApproval: defineSchema(
    { kind: "aloha.signed-release-acceptance-approval-v1", fields: signedReleaseAcceptanceApprovalSchema.descriptor },
    (value, path = "$") => checkSignedReleaseAcceptanceApproval(signedReleaseAcceptanceApprovalSchema.decode(value, path), path),
  ),
});

export const QUALIFICATION_V2_SCHEMA_MANIFESTS = Object.freeze({
  externalIssuerKey: defineSchemaManifest("aloha.external-qualification-issuer-key", "2.0.0", QUALIFICATION_V2_SCHEMAS.externalIssuerKey),
  signedRegistryApproval: defineSchemaManifest("aloha.signed-qualification-registry-approval", "2.0.0", QUALIFICATION_V2_SCHEMAS.signedRegistryApproval),
  externalTrustAnchor: defineSchemaManifest("aloha.external-qualification-trust-anchor", "2.0.0", QUALIFICATION_V2_SCHEMAS.externalTrustAnchor),
  signedObserverCertificate: defineSchemaManifest("aloha.signed-observer-certificate", "2.0.0", QUALIFICATION_V2_SCHEMAS.signedObserverCertificate),
  signedVerifierCertificate: defineSchemaManifest("aloha.signed-verifier-certificate", "2.0.0", QUALIFICATION_V2_SCHEMAS.signedVerifierCertificate),
  signedReleaseAuthorityApproval: defineSchemaManifest("aloha.signed-release-authority-approval", "3.0.0", QUALIFICATION_V2_SCHEMAS.signedReleaseAuthorityApproval),
  releaseAcceptanceSet: defineSchemaManifest("aloha.release-acceptance-set", "1.0.0", QUALIFICATION_V2_SCHEMAS.releaseAcceptanceSet),
  signedReleaseAcceptanceApproval: defineSchemaManifest("aloha.signed-release-acceptance-approval", "1.0.0", QUALIFICATION_V2_SCHEMAS.signedReleaseAcceptanceApproval),
});

export function decodeExternalQualificationIssuerKeyV2(value: string | Uint8Array | object): ExternalQualificationIssuerKeyV2 {
  return QUALIFICATION_V2_SCHEMAS.externalIssuerKey.decode(parseV2Input(value));
}

export function encodeExternalQualificationIssuerKeyV2(value: ExternalQualificationIssuerKeyV2): Uint8Array {
  return encodeCanonicalBytes(QUALIFICATION_V2_SCHEMAS.externalIssuerKey.decode(value));
}

export function createExternalQualificationIssuerKeyV2(input: Omit<ExternalQualificationIssuerKeyV2, "keyId">): ExternalQualificationIssuerKeyV2 {
  const payload = issuerKeyPayloadSchema.decode(input);
  const keyId = hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.issuerKey, payload);
  return QUALIFICATION_V2_SCHEMAS.externalIssuerKey.decode({ ...payload, keyId });
}

export function recomputeExternalQualificationIssuerKeyId(value: ExternalQualificationIssuerKeyV2): Hash {
  return hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.issuerKey, payloadWithoutFields(decodeExternalQualificationIssuerKeyV2(value), ["keyId"]));
}

export function hashExternalQualificationIssuerKeySetRoot(keys: readonly ExternalQualificationIssuerKeyV2[]): Hash {
  const decoded = arraySchema(QUALIFICATION_V2_SCHEMAS.externalIssuerKey).decode(keys, "issuerKeySet");
  const materialKeys = decoded.map(issuerKeyMaterialSortKey);
  for (let index = 1; index < materialKeys.length; index += 1) {
    if (materialKeys[index - 1]! >= materialKeys[index]!) throw new TypeError(`issuer keys must be strictly sorted and unique at issuerKeySet[${index}]`);
  }
  const keyIds = decoded.map((key) => key.keyId);
  if (new Set(keyIds).size !== keyIds.length) throw new TypeError("issuer key set contains duplicate keyId");
  return hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.issuerKeySet, decoded.map(issuerKeyMaterial));
}

export const recomputeExternalQualificationIssuerKeySetRoot = hashExternalQualificationIssuerKeySetRoot;

export function hashExternalQualificationIssuerSetRoot(issuerIds: readonly string[]): Hash {
  const decoded = arraySchema(nonEmptyStringSchema).decode(issuerIds, "issuerSet");
  for (let index = 1; index < decoded.length; index += 1) {
    if (decoded[index - 1]! >= decoded[index]!) {
      throw new TypeError(`issuer IDs must be strictly sorted and unique at issuerSet[${index}]`);
    }
  }
  return hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.issuerSet, decoded);
}

/**
 * This is an observation of an external trust anchor, not an authority
 * declaration. A repository copy may be inspected for consistency, but the
 * deployment-side expected anchorId/root remains the authority and is not
 * bootstrap-able from this package. The designated governance key is
 * resolved by the deployment validator from the exact issuer key set.
 */
export function decodeExternalQualificationTrustAnchorV2(value: string | Uint8Array | object): ExternalQualificationTrustAnchorV2 {
  return QUALIFICATION_V2_SCHEMAS.externalTrustAnchor.decode(parseV2Input(value));
}

export function encodeExternalQualificationTrustAnchorV2(value: ExternalQualificationTrustAnchorV2): Uint8Array {
  return encodeCanonicalBytes(QUALIFICATION_V2_SCHEMAS.externalTrustAnchor.decode(value));
}

export function createExternalQualificationTrustAnchorV2(
  input: Omit<ExternalQualificationTrustAnchorV2, "anchorId">,
): ExternalQualificationTrustAnchorV2 {
  const payload = trustAnchorPayloadSchema.decode(input);
  const anchorId = hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.trustAnchor, payload);
  return QUALIFICATION_V2_SCHEMAS.externalTrustAnchor.decode({ ...payload, anchorId });
}

export function recomputeExternalQualificationTrustAnchorId(value: ExternalQualificationTrustAnchorV2): Hash {
  return hashDomain(
    EXTERNAL_QUALIFICATION_V2_DOMAINS.trustAnchor,
    payloadWithoutFields(decodeExternalQualificationTrustAnchorV2(value), ["anchorId"]),
  );
}

/** The deployment root is the content-addressed anchor identity. */
export const recomputeExternalQualificationTrustAnchorRoot = recomputeExternalQualificationTrustAnchorId;

/**
 * Deployment-side governance-key join. This remains a pure fact check: it
 * does not issue authority or verify a signature. A missing key, wrong issuer
 * binding, interval, audience, issuer-set root, or key-set root is rejected.
 */
export function validateExternalQualificationTrustAnchorGovernanceKey(
  anchor: ExternalQualificationTrustAnchorV2,
  issuerKeys: readonly ExternalQualificationIssuerKeyV2[],
): ExternalQualificationTrustAnchorV2 {
  const decodedAnchor = decodeExternalQualificationTrustAnchorV2(anchor);
  const decodedKeys = arraySchema(QUALIFICATION_V2_SCHEMAS.externalIssuerKey).decode(issuerKeys, "issuerKeys");
  if (hashExternalQualificationIssuerKeySetRoot(decodedKeys) !== decodedAnchor.issuerKeySetRoot) {
    throw new TypeError("trust anchor issuerKeySetRoot does not match exact issuer keys");
  }
  const issuerIds = [...new Set(decodedKeys.map((key) => key.issuerId))].sort();
  if (hashExternalQualificationIssuerSetRoot(issuerIds) !== decodedAnchor.issuerSetRoot) {
    throw new TypeError("trust anchor issuerSetRoot does not match exact issuer IDs");
  }
  const governanceKey = decodedKeys.find(
    (key) => key.issuerId === decodedAnchor.governanceIssuerId && key.keyId === decodedAnchor.governanceKeyId,
  );
  if (governanceKey === undefined) throw new TypeError("trust anchor governance key is not in the exact issuer key set");
  const current = BigInt(decodedAnchor.currentRegistryEpoch);
  if (
    governanceKey.audienceHash !== decodedAnchor.audienceHash ||
    current < BigInt(governanceKey.validFromRegistryEpoch) ||
    current > BigInt(governanceKey.validThroughRegistryEpoch)
  ) {
    throw new TypeError("trust anchor governance key is not valid for the current epoch/audience");
  }
  return decodedAnchor;
}

function registryApprovalCore(value: SignedQualificationRegistryApprovalV2 | SignedQualificationRegistryApprovalSigningInputV2): SignedQualificationRegistryApprovalSigningInputV2 {
  try {
    return registryApprovalSigningInputSchema.decode(value);
  } catch {
    const decoded = registryApprovalSchema.decode(value);
    return registryApprovalCoreSchema.decode(payloadWithoutFields(decoded, ["approvalId", "payloadHash", "signatureAlgorithm", "signatureHex"]));
  }
}

function registryApprovalHashes(core: SignedQualificationRegistryApprovalSigningInputV2): { payloadHash: Hash; approvalId: Hash } {
  const payloadHash = hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.registryApprovalPayload, core);
  const approvalId = hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.registryApprovalId, { payloadHash });
  return { payloadHash, approvalId };
}

export function decodeSignedQualificationRegistryApprovalV2(value: string | Uint8Array | object): SignedQualificationRegistryApprovalV2 {
  return QUALIFICATION_V2_SCHEMAS.signedRegistryApproval.decode(parseV2Input(value));
}

export function encodeSignedQualificationRegistryApprovalV2(value: SignedQualificationRegistryApprovalV2): Uint8Array {
  return encodeCanonicalBytes(QUALIFICATION_V2_SCHEMAS.signedRegistryApproval.decode(value));
}

export function createSignedQualificationRegistryApprovalV2(
  input: SignedQualificationRegistryApprovalSigningInputV2,
  signatureHex: string,
): SignedQualificationRegistryApprovalV2 {
  const core = registryApprovalCoreSchema.decode(input);
  const signature = signatureHexSchema.decode(signatureHex);
  const { payloadHash, approvalId } = registryApprovalHashes(core);
  return QUALIFICATION_V2_SCHEMAS.signedRegistryApproval.decode({ ...core, approvalId, payloadHash, signatureAlgorithm: "ed25519", signatureHex: signature });
}

export function recomputeSignedQualificationRegistryApprovalPayloadHash(value: SignedQualificationRegistryApprovalV2): Hash {
  return registryApprovalHashes(registryApprovalCore(decodeSignedQualificationRegistryApprovalV2(value))).payloadHash;
}

export function recomputeSignedQualificationRegistryApprovalId(value: SignedQualificationRegistryApprovalV2): Hash {
  const decoded = decodeSignedQualificationRegistryApprovalV2(value);
  return registryApprovalHashes(registryApprovalCore(decoded)).approvalId;
}

/** Exact bytes an external Ed25519 signer must sign; this function never signs. */
export function qualificationRegistryApprovalSigningBytes(
  value: SignedQualificationRegistryApprovalV2 | SignedQualificationRegistryApprovalSigningInputV2,
): Uint8Array {
  const core = registryApprovalCore(value);
  const { payloadHash, approvalId } = registryApprovalHashes(core);
  return encodeCanonicalBytes({
    domain: EXTERNAL_QUALIFICATION_V2_DOMAINS.registryApprovalSigning,
    version: 2,
    kind: core.kind,
    id: approvalId,
    payloadHash,
    registryRoot: core.registryRoot,
    registryPayloadHash: core.registryPayloadHash,
    issuerKeySetRoot: core.issuerKeySetRoot,
    epoch: core.epoch,
    audienceHash: core.audienceHash,
    issuerId: core.issuerId,
    keyId: core.keyId,
  });
}

function releaseAuthorityApprovalCore(
  value: SignedReleaseAuthorityApprovalV3 | SignedReleaseAuthorityApprovalSigningInputV3,
): SignedReleaseAuthorityApprovalSigningInputV3 {
  if (Object.prototype.hasOwnProperty.call(value, "approvalId")) {
    const decoded = releaseAuthorityApprovalSchema.decode(value);
    return releaseAuthorityApprovalCoreSchema.decode(payloadWithoutFields(decoded, ["approvalId", "payloadHash", "signatureAlgorithm", "signatureHex"]));
  }
  return releaseAuthorityApprovalSigningInputSchema.decode(value);
}

function releaseAuthorityApprovalHashes(core: SignedReleaseAuthorityApprovalSigningInputV3): { payloadHash: Hash; approvalId: Hash } {
  const payloadHash = hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.releaseAuthorityApprovalPayload, core);
  const approvalId = hashDomain(EXTERNAL_QUALIFICATION_V2_DOMAINS.releaseAuthorityApprovalId, { payloadHash });
  return { payloadHash, approvalId };
}

/** Exact sorted observer-certificate root committed by release approval. */
export function hashSignedReleaseAuthorityObserverCertificateIdsRoot(ids: readonly Hash[]): Hash {
  const decoded = hashArrayV2Schema.decode(ids, "observerCertificateIds");
  checkStrictSortedHashes(decoded, "observerCertificateIds");
  return observerCertificateIdsRoot(decoded);
}

export function sealReleaseAcceptanceRequirementsV1(
  values: readonly ReleaseAcceptanceRequirementInputV1[],
): {
  readonly releaseAcceptanceRequirements: readonly ReleaseAcceptanceRequirementV1[];
  readonly releaseAcceptanceRequirementSetRoot: Hash;
} {
  const requirements = values.map((value, index) => {
    const core = releaseAcceptanceRequirementCoreSchema.decode(value, `releaseAcceptanceRequirements[${index}]`);
    checkStrictSortedHashes(core.observerCertificateIds, `releaseAcceptanceRequirements[${index}].observerCertificateIds`);
    if (core.observerCertificateIdsRoot !== observerCertificateIdsRoot(core.observerCertificateIds)) {
      throw new TypeError(`observer certificate root mismatch at releaseAcceptanceRequirements[${index}].observerCertificateIdsRoot`);
    }
    return releaseAcceptanceRequirementSchema.decode({
      ...core,
      requirementLeafDigest: releaseAcceptanceRequirementLeaf(core),
    });
  }).sort((left, right) => left.predicateId.localeCompare(right.predicateId));
  if (requirements.length === 0) throw new TypeError("release acceptance requirements must not be empty");
  for (let index = 1; index < requirements.length; index += 1) {
    if (requirements[index - 1]!.predicateId >= requirements[index]!.predicateId) {
      throw new TypeError("release acceptance requirements contain duplicate predicateId");
    }
  }
  return deepFreeze({
    releaseAcceptanceRequirements: requirements,
    releaseAcceptanceRequirementSetRoot: releaseAcceptanceRequirementSetRoot(requirements),
  });
}

export function decodeSignedReleaseAuthorityApprovalV3(value: string | Uint8Array | object): SignedReleaseAuthorityApprovalV3 {
  return QUALIFICATION_V2_SCHEMAS.signedReleaseAuthorityApproval.decode(parseV2Input(value));
}

export function encodeSignedReleaseAuthorityApprovalV3(value: SignedReleaseAuthorityApprovalV3): Uint8Array {
  return encodeCanonicalBytes(QUALIFICATION_V2_SCHEMAS.signedReleaseAuthorityApproval.decode(value));
}

/**
 * `authorityPinDigest` is supplied from AuthorityPinUnsigned before this
 * approval exists. It must exclude this approval's id/payload/signature and
 * must not hash a final runtime/commit that itself contains this approval.
 * This schema intentionally treats it as an externally issued digest and
 * never derives authority from the approval it carries.
 */
export function createSignedReleaseAuthorityApprovalV3(
  input: SignedReleaseAuthorityApprovalSigningInputV3,
  signatureHex: string,
): SignedReleaseAuthorityApprovalV3 {
  const core = releaseAuthorityApprovalCoreSchema.decode(input);
  const signature = signatureHexSchema.decode(signatureHex);
  const { payloadHash, approvalId } = releaseAuthorityApprovalHashes(core);
  return QUALIFICATION_V2_SCHEMAS.signedReleaseAuthorityApproval.decode({
    ...core,
    approvalId,
    payloadHash,
    signatureAlgorithm: "ed25519",
    signatureHex: signature,
  });
}

export function recomputeSignedReleaseAuthorityApprovalPayloadHash(value: SignedReleaseAuthorityApprovalV3): Hash {
  return releaseAuthorityApprovalHashes(releaseAuthorityApprovalCore(decodeSignedReleaseAuthorityApprovalV3(value))).payloadHash;
}

export function recomputeSignedReleaseAuthorityApprovalId(value: SignedReleaseAuthorityApprovalV3): Hash {
  return releaseAuthorityApprovalHashes(releaseAuthorityApprovalCore(decodeSignedReleaseAuthorityApprovalV3(value))).approvalId;
}

/** Exact bytes an external Ed25519 signer must sign; this function never signs. */
export function releaseAuthorityApprovalSigningBytes(
  value: SignedReleaseAuthorityApprovalV3 | SignedReleaseAuthorityApprovalSigningInputV3,
): Uint8Array {
  const core = releaseAuthorityApprovalCore(value);
  const { payloadHash, approvalId } = releaseAuthorityApprovalHashes(core);
  return encodeCanonicalBytes({
    domain: EXTERNAL_QUALIFICATION_V2_DOMAINS.releaseAuthorityApprovalSigning,
    version: 3,
    kind: core.kind,
    id: approvalId,
    payloadHash,
    externalTrustAnchorRoot: core.externalTrustAnchorRoot,
    issuerKeySetRoot: core.issuerKeySetRoot,
    registryApprovalId: core.registryApprovalId,
    registryRoot: core.registryRoot,
    releaseAcceptanceRequirements: core.releaseAcceptanceRequirements,
    releaseAcceptanceRequirementSetRoot: core.releaseAcceptanceRequirementSetRoot,
    predicateCompositionRootDigest: core.predicateCompositionRootDigest,
    gateCoreRuntimeClosureDigest: core.gateCoreRuntimeClosureDigest,
    gateCoreImplementationClosureDigest: core.gateCoreImplementationClosureDigest,
    releaseRoleManifestRoot: core.releaseRoleManifestRoot,
    candidateReleaseCommit: core.candidateReleaseCommit,
    qualifiedRunnerIssuerId: core.qualifiedRunnerIssuerId,
    qualifiedRunnerKeyId: core.qualifiedRunnerKeyId,
    qualifiedRunnerImplementationClosureDigest: core.qualifiedRunnerImplementationClosureDigest,
    qualifiedRunnerImplementationExportDigest: core.qualifiedRunnerImplementationExportDigest,
    epoch: core.epoch,
    audienceHash: core.audienceHash,
    issuerId: core.issuerId,
    keyId: core.keyId,
  });
}

export function sealReleaseAcceptanceSetV1(
  releaseAcceptanceRequirementSetRoot: Hash,
  values: readonly ReleaseAcceptanceResultInputV1[],
): ReleaseAcceptanceSetV1 {
  requireNonZeroHash(releaseAcceptanceRequirementSetRoot, "releaseAcceptanceRequirementSetRoot");
  const entries = values.map((value, index) => {
    const core = releaseAcceptanceResultCoreSchema.decode(value, `releaseAcceptanceSet.entries[${index}]`);
    return releaseAcceptanceResultSchema.decode({
      ...core,
      resultLeafDigest: releaseAcceptanceResultLeaf(core),
    });
  }).sort((left, right) => left.predicateId.localeCompare(right.predicateId));
  const draft = releaseAcceptanceSetSchema.decode({
    schemaVersion: 1,
    kind: "aloha.release-acceptance-set",
    releaseAcceptanceRequirementSetRoot,
    entries,
    root: ZERO_HASH,
  });
  return checkReleaseAcceptanceSet({ ...draft, root: releaseAcceptanceSetRoot(draft) }, "$" );
}

export function decodeReleaseAcceptanceSetV1(value: string | Uint8Array | object): ReleaseAcceptanceSetV1 {
  return QUALIFICATION_V2_SCHEMAS.releaseAcceptanceSet.decode(parseV2Input(value));
}

export function encodeReleaseAcceptanceSetV1(value: ReleaseAcceptanceSetV1): Uint8Array {
  return encodeCanonicalBytes(QUALIFICATION_V2_SCHEMAS.releaseAcceptanceSet.decode(value));
}

function releaseAcceptanceApprovalCore(
  value: SignedReleaseAcceptanceApprovalV1 | SignedReleaseAcceptanceApprovalSigningInputV1,
): SignedReleaseAcceptanceApprovalSigningInputV1 {
  if (Object.prototype.hasOwnProperty.call(value, "approvalId")) {
    const decoded = signedReleaseAcceptanceApprovalSchema.decode(value);
    return signedReleaseAcceptanceApprovalCoreSchema.decode(
      payloadWithoutFields(decoded, ["approvalId", "payloadHash", "signatureAlgorithm", "signatureHex"]),
    );
  }
  return signedReleaseAcceptanceApprovalCoreSchema.decode(value);
}

function releaseAcceptanceApprovalHashes(
  core: SignedReleaseAcceptanceApprovalSigningInputV1,
): { readonly payloadHash: Hash; readonly approvalId: Hash } {
  const payloadHash = hashDomain(RELEASE_ACCEPTANCE_APPROVAL_V1_DOMAINS.approvalPayload, core);
  return {
    payloadHash,
    approvalId: hashDomain(RELEASE_ACCEPTANCE_APPROVAL_V1_DOMAINS.approvalId, { payloadHash }),
  };
}

export function createSignedReleaseAcceptanceApprovalV1(
  input: SignedReleaseAcceptanceApprovalSigningInputV1,
  signatureHex: string,
): SignedReleaseAcceptanceApprovalV1 {
  const core = signedReleaseAcceptanceApprovalCoreSchema.decode(input);
  const hashes = releaseAcceptanceApprovalHashes(core);
  return QUALIFICATION_V2_SCHEMAS.signedReleaseAcceptanceApproval.decode({
    ...core,
    ...hashes,
    signatureAlgorithm: "ed25519",
    signatureHex: signatureHexSchema.decode(signatureHex),
  });
}

export function decodeSignedReleaseAcceptanceApprovalV1(
  value: string | Uint8Array | object,
): SignedReleaseAcceptanceApprovalV1 {
  return QUALIFICATION_V2_SCHEMAS.signedReleaseAcceptanceApproval.decode(parseV2Input(value));
}

export function encodeSignedReleaseAcceptanceApprovalV1(
  value: SignedReleaseAcceptanceApprovalV1,
): Uint8Array {
  return encodeCanonicalBytes(QUALIFICATION_V2_SCHEMAS.signedReleaseAcceptanceApproval.decode(value));
}

export function releaseAcceptanceApprovalSigningBytes(
  value: SignedReleaseAcceptanceApprovalV1 | SignedReleaseAcceptanceApprovalSigningInputV1,
): Uint8Array {
  const core = releaseAcceptanceApprovalCore(value);
  const { payloadHash, approvalId } = releaseAcceptanceApprovalHashes(core);
  return encodeCanonicalBytes({
    domain: RELEASE_ACCEPTANCE_APPROVAL_V1_DOMAINS.approvalSigning,
    version: 1,
    id: approvalId,
    payloadHash,
    ...core,
  });
}

export function recomputeSignedReleaseAcceptanceApprovalId(
  value: SignedReleaseAcceptanceApprovalV1,
): Hash {
  return releaseAcceptanceApprovalHashes(releaseAcceptanceApprovalCore(decodeSignedReleaseAcceptanceApprovalV1(value))).approvalId;
}

export function recomputeSignedReleaseAcceptanceApprovalPayloadHash(
  value: SignedReleaseAcceptanceApprovalV1,
): Hash {
  return releaseAcceptanceApprovalHashes(releaseAcceptanceApprovalCore(decodeSignedReleaseAcceptanceApprovalV1(value))).payloadHash;
}

export function decodeSignedObserverCertificateV2(value: string | Uint8Array | object): SignedObserverCertificateV2 {
  return QUALIFICATION_V2_SCHEMAS.signedObserverCertificate.decode(parseV2Input(value));
}

export function encodeSignedObserverCertificateV2(value: SignedObserverCertificateV2): Uint8Array {
  return encodeCanonicalBytes(QUALIFICATION_V2_SCHEMAS.signedObserverCertificate.decode(value));
}

export function createSignedObserverCertificateV2(
  input: SignedObserverCertificateSigningInputV2,
  signatureHex: string,
): SignedObserverCertificateV2 {
  const base = observerCertificateSigningInputSchema.decode(input);
  const signature = signatureHexSchema.decode(signatureHex);
  return QUALIFICATION_V2_SCHEMAS.signedObserverCertificate.decode({ ...base, signatureAlgorithm: "ed25519", signatureHex: signature });
}

export function recomputeSignedObserverCertificateV2Id(value: SignedObserverCertificateV2): Hash {
  const decoded = decodeSignedObserverCertificateV2(value);
  return hashDomain("aloha/observer-qualification/id/v1", decoded.payloadHash);
}

/** Exact bytes an external Ed25519 signer must sign; this function never signs. */
export function observerCertificateSigningBytes(
  value: SignedObserverCertificateV2 | SignedObserverCertificateSigningInputV2,
): Uint8Array {
  let base: SignedObserverCertificateSigningInputV2;
  try {
    base = observerCertificateSigningInputSchema.decode(value);
  } catch {
    const decoded = observerCertificateSchema.decode(value);
    base = observerCertificateSigningInputSchema.decode(payloadWithoutFields(decoded, ["signatureAlgorithm", "signatureHex"]));
  }
  return encodeCanonicalBytes({
    domain: EXTERNAL_QUALIFICATION_V2_DOMAINS.certificateSigning,
    version: 2,
    kind: base.kind,
    id: base.certificateId,
    payloadHash: base.payloadHash,
    registryRoot: base.registryRoot,
    epoch: base.epoch,
    audienceHash: base.audienceHash,
    issuerId: base.issuerId,
    keyId: base.keyId,
  });
}

export function decodeSignedVerifierCertificateV2(value: string | Uint8Array | object): SignedVerifierCertificateV2 {
  return QUALIFICATION_V2_SCHEMAS.signedVerifierCertificate.decode(parseV2Input(value));
}

export function encodeSignedVerifierCertificateV2(value: SignedVerifierCertificateV2): Uint8Array {
  return encodeCanonicalBytes(QUALIFICATION_V2_SCHEMAS.signedVerifierCertificate.decode(value));
}

export function createSignedVerifierCertificateV2(
  input: SignedVerifierCertificateSigningInputV2,
  signatureHex: string,
): SignedVerifierCertificateV2 {
  const base = verifierCertificateSigningInputSchema.decode(input);
  const signature = signatureHexSchema.decode(signatureHex);
  return QUALIFICATION_V2_SCHEMAS.signedVerifierCertificate.decode({ ...base, signatureAlgorithm: "ed25519", signatureHex: signature });
}

export function recomputeSignedVerifierCertificateV2Id(value: SignedVerifierCertificateV2): Hash {
  const decoded = decodeSignedVerifierCertificateV2(value);
  return hashDomain("aloha/verifier-qualification/id/v1", decoded.payloadHash);
}

/** Exact bytes an external Ed25519 signer must sign; this function never signs. */
export function verifierCertificateSigningBytes(
  value: SignedVerifierCertificateV2 | SignedVerifierCertificateSigningInputV2,
): Uint8Array {
  let base: SignedVerifierCertificateSigningInputV2;
  try {
    base = verifierCertificateSigningInputSchema.decode(value);
  } catch {
    const decoded = verifierCertificateSchema.decode(value);
    base = verifierCertificateSigningInputSchema.decode(payloadWithoutFields(decoded, ["signatureAlgorithm", "signatureHex"]));
  }
  return encodeCanonicalBytes({
    domain: EXTERNAL_QUALIFICATION_V2_DOMAINS.certificateSigning,
    version: 2,
    kind: base.kind,
    id: base.certificateId,
    payloadHash: base.payloadHash,
    registryRoot: base.registryRoot,
    epoch: base.epoch,
    audienceHash: base.audienceHash,
    issuerId: base.issuerId,
    keyId: base.keyId,
  });
}
