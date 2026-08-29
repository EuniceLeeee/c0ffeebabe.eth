import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  deepFreeze,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";

export interface EconomicSafetyActionOwnerProposalV1 {
  readonly familyDefinitionHash: Hash;
  readonly ownerId: string;
  readonly ownerRef: Hash;
  readonly implementationHash: Hash;
  readonly schemaRef: Hash;
  readonly implementationClosureRoot: Hash;
  readonly proposalLeafDigest: Hash;
}

export interface GeneratedEconomicSafetyActionOwnerRegistryV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.generated-economic-safety-action-owner-registry";
  readonly entries: readonly EconomicSafetyActionOwnerProposalV1[];
  readonly actionOwnerRegistryRoot: Hash;
}

export interface EconomicSafetyActionOwnerQualificationCertificateV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.economic-safety-action-owner-qualification-certificate";
  readonly familyDefinitionHash: Hash;
  readonly ownerId: string;
  readonly ownerRef: Hash;
  readonly proposedOwnerLeafDigest: Hash;
  readonly implementationHash: Hash;
  readonly schemaRef: Hash;
  readonly implementationClosureRoot: Hash;
  readonly claimSchemaRefs: readonly Hash[];
  readonly verifierProgramDigest: Hash;
  readonly qualificationSpecDigest: Hash;
  readonly criticalMutationCorpusRoot: Hash;
  readonly independentOracleCaseRoot: Hash;
  readonly executedPositiveCaseRoot: Hash;
  readonly executedNegativeCaseRoot: Hash;
  readonly executedInvalidCaseRoot: Hash;
  readonly qualificationAuthorityApprovalId: Hash;
  readonly qualificationAuthorityApprovalPayloadHash: Hash;
  readonly qualificationLeafDigest: Hash;
}

export interface EconomicSafetyProfileRequiredClaimV1 {
  readonly claimSchemaRef: Hash;
  readonly ownerRef: Hash;
  readonly qualificationLeafDigest: Hash;
  readonly revmObservationSchemaRef: Hash;
}

export interface SafetyProfileV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.economic-safety-profile";
  readonly profileRef: Hash;
  readonly requiredClaims: readonly EconomicSafetyProfileRequiredClaimV1[];
  readonly qualifiedOwnerSetRoot: Hash;
  readonly profileCompositionRoot: Hash;
}

export const ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1 = hashDomain(
  "aloha/economic-safety/revm-observation-schema-ref/v1",
  {
    workerReceipt: "aloha.qualified-final-simulation-owner-facts-v1",
    effects: "aloha.revm-effect-observation-v1",
    source: "canonical-current-source-v1",
  },
);

function nonZeroHash(value: unknown, path: string): Hash {
  const result = assertHash(value, path);
  if (result === `0x${"0".repeat(64)}`) throw new TypeError(`${path} must be non-zero`);
  return result;
}

function sortedUniqueHashes(value: unknown, path: string): readonly Hash[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${path} must be a non-empty array`);
  const hashes = value.map((item, index) => nonZeroHash(item, `${path}[${index}]`));
  for (let index = 1; index < hashes.length; index += 1) {
    if (hashes[index - 1]! >= hashes[index]!) throw new TypeError(`${path} must be strictly sorted and unique`);
  }
  return Object.freeze(hashes);
}

function proposalBody(value: Omit<EconomicSafetyActionOwnerProposalV1, "proposalLeafDigest">) {
  return deepFreeze({
    familyDefinitionHash: nonZeroHash(value.familyDefinitionHash, "actionOwnerProposal.familyDefinitionHash"),
    ownerId: assertNonEmptyString(value.ownerId, "actionOwnerProposal.ownerId"),
    ownerRef: nonZeroHash(value.ownerRef, "actionOwnerProposal.ownerRef"),
    implementationHash: nonZeroHash(value.implementationHash, "actionOwnerProposal.implementationHash"),
    schemaRef: nonZeroHash(value.schemaRef, "actionOwnerProposal.schemaRef"),
    implementationClosureRoot: nonZeroHash(value.implementationClosureRoot, "actionOwnerProposal.implementationClosureRoot"),
  });
}

export function sealEconomicSafetyActionOwnerProposalV1(
  value: Omit<EconomicSafetyActionOwnerProposalV1, "proposalLeafDigest">,
): EconomicSafetyActionOwnerProposalV1 {
  const body = proposalBody(value);
  return deepFreeze({
    ...body,
    proposalLeafDigest: hashDomain("aloha/economic-safety-action-owner-proposal-leaf/v1", body),
  });
}

export function sealGeneratedEconomicSafetyActionOwnerRegistryV1(
  values: readonly EconomicSafetyActionOwnerProposalV1[],
): GeneratedEconomicSafetyActionOwnerRegistryV1 {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError("economic safety action-owner registry must be non-empty");
  const entries = values.map((value, index) => {
    assertExactKeys(value, [
      "familyDefinitionHash", "ownerId", "ownerRef", "implementationHash", "schemaRef",
      "implementationClosureRoot", "proposalLeafDigest",
    ], `actionOwnerRegistry.entries[${index}]`);
    const normalized = sealEconomicSafetyActionOwnerProposalV1(
      value as unknown as Omit<EconomicSafetyActionOwnerProposalV1, "proposalLeafDigest">,
    );
    if (normalized.proposalLeafDigest !== value.proposalLeafDigest) {
      throw new TypeError(`economic safety action-owner proposal leaf mismatch at entries[${index}]`);
    }
    return normalized;
  });
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.ownerRef >= entries[index]!.ownerRef) {
      throw new TypeError("economic safety action-owner proposals must be strictly sorted and unique by ownerRef");
    }
  }
  const frozen = Object.freeze(entries);
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.generated-economic-safety-action-owner-registry" as const,
    entries: frozen,
    actionOwnerRegistryRoot: hashDomain("aloha/economic-safety-action-owner-registry/v1", frozen),
  });
}

const CERTIFICATE_KEYS = Object.freeze([
  "schemaVersion", "kind", "familyDefinitionHash", "ownerId", "ownerRef", "proposedOwnerLeafDigest",
  "implementationHash", "schemaRef", "implementationClosureRoot", "claimSchemaRefs",
  "verifierProgramDigest", "qualificationSpecDigest", "criticalMutationCorpusRoot",
  "independentOracleCaseRoot", "executedPositiveCaseRoot", "executedNegativeCaseRoot",
  "executedInvalidCaseRoot", "qualificationAuthorityApprovalId",
  "qualificationAuthorityApprovalPayloadHash", "qualificationLeafDigest",
] as const);

function qualificationBody(
  value: Omit<EconomicSafetyActionOwnerQualificationCertificateV1, "qualificationLeafDigest">,
) {
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.economic-safety-action-owner-qualification-certificate" as const,
    familyDefinitionHash: nonZeroHash(value.familyDefinitionHash, "actionOwnerQualification.familyDefinitionHash"),
    ownerId: assertNonEmptyString(value.ownerId, "actionOwnerQualification.ownerId"),
    ownerRef: nonZeroHash(value.ownerRef, "actionOwnerQualification.ownerRef"),
    proposedOwnerLeafDigest: nonZeroHash(value.proposedOwnerLeafDigest, "actionOwnerQualification.proposedOwnerLeafDigest"),
    implementationHash: nonZeroHash(value.implementationHash, "actionOwnerQualification.implementationHash"),
    schemaRef: nonZeroHash(value.schemaRef, "actionOwnerQualification.schemaRef"),
    implementationClosureRoot: nonZeroHash(value.implementationClosureRoot, "actionOwnerQualification.implementationClosureRoot"),
    claimSchemaRefs: sortedUniqueHashes(value.claimSchemaRefs, "actionOwnerQualification.claimSchemaRefs"),
    verifierProgramDigest: nonZeroHash(value.verifierProgramDigest, "actionOwnerQualification.verifierProgramDigest"),
    qualificationSpecDigest: nonZeroHash(value.qualificationSpecDigest, "actionOwnerQualification.qualificationSpecDigest"),
    criticalMutationCorpusRoot: nonZeroHash(value.criticalMutationCorpusRoot, "actionOwnerQualification.criticalMutationCorpusRoot"),
    independentOracleCaseRoot: nonZeroHash(value.independentOracleCaseRoot, "actionOwnerQualification.independentOracleCaseRoot"),
    executedPositiveCaseRoot: nonZeroHash(value.executedPositiveCaseRoot, "actionOwnerQualification.executedPositiveCaseRoot"),
    executedNegativeCaseRoot: nonZeroHash(value.executedNegativeCaseRoot, "actionOwnerQualification.executedNegativeCaseRoot"),
    executedInvalidCaseRoot: nonZeroHash(value.executedInvalidCaseRoot, "actionOwnerQualification.executedInvalidCaseRoot"),
    qualificationAuthorityApprovalId: nonZeroHash(value.qualificationAuthorityApprovalId, "actionOwnerQualification.qualificationAuthorityApprovalId"),
    qualificationAuthorityApprovalPayloadHash: nonZeroHash(value.qualificationAuthorityApprovalPayloadHash, "actionOwnerQualification.qualificationAuthorityApprovalPayloadHash"),
  });
}

export function sealEconomicSafetyActionOwnerQualificationCertificateV1(
  value: Omit<EconomicSafetyActionOwnerQualificationCertificateV1, "qualificationLeafDigest">,
): EconomicSafetyActionOwnerQualificationCertificateV1 {
  const body = qualificationBody(value);
  return deepFreeze({
    ...body,
    qualificationLeafDigest: hashDomain("aloha/economic-safety-action-owner-qualification-leaf/v1", body),
  });
}

export function decodeEconomicSafetyActionOwnerQualificationCertificateV1(
  value: unknown,
): EconomicSafetyActionOwnerQualificationCertificateV1 {
  assertExactKeys(value, CERTIFICATE_KEYS, "economicSafetyActionOwnerQualificationCertificate");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "aloha.economic-safety-action-owner-qualification-certificate") {
    throw new TypeError("economic safety action-owner qualification certificate kind/version mismatch");
  }
  const { qualificationLeafDigest: _leaf, ...body } = record;
  const normalized = sealEconomicSafetyActionOwnerQualificationCertificateV1(
    body as unknown as Omit<EconomicSafetyActionOwnerQualificationCertificateV1, "qualificationLeafDigest">,
  );
  if (normalized.qualificationLeafDigest !== nonZeroHash(record.qualificationLeafDigest, "actionOwnerQualification.qualificationLeafDigest")) {
    throw new TypeError("economic safety action-owner qualification leaf mismatch");
  }
  return normalized;
}

export function sealEconomicSafetyActionOwnerQualificationSetV1(
  values: readonly EconomicSafetyActionOwnerQualificationCertificateV1[],
): Readonly<{ certificates: readonly EconomicSafetyActionOwnerQualificationCertificateV1[]; root: Hash }> {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError("economic safety action-owner qualification set must be non-empty");
  const certificates = values.map(decodeEconomicSafetyActionOwnerQualificationCertificateV1);
  for (let index = 1; index < certificates.length; index += 1) {
    if (certificates[index - 1]!.ownerRef >= certificates[index]!.ownerRef) {
      throw new TypeError("economic safety action-owner certificates must be strictly sorted and unique by ownerRef");
    }
  }
  const frozen = Object.freeze(certificates);
  return deepFreeze({
    certificates: frozen,
    root: hashDomain("aloha/qualified-economic-safety-action-owner-set/v1", frozen),
  });
}

export function sealSafetyProfileV1(
  value: Omit<SafetyProfileV1, "schemaVersion" | "kind" | "profileCompositionRoot">,
): SafetyProfileV1 {
  const requiredClaims = value.requiredClaims.map((claim, index) => {
    assertExactKeys(claim, ["claimSchemaRef", "ownerRef", "qualificationLeafDigest", "revmObservationSchemaRef"], `safetyProfile.requiredClaims[${index}]`);
    return deepFreeze({
      claimSchemaRef: nonZeroHash(claim.claimSchemaRef, `safetyProfile.requiredClaims[${index}].claimSchemaRef`),
      ownerRef: nonZeroHash(claim.ownerRef, `safetyProfile.requiredClaims[${index}].ownerRef`),
      qualificationLeafDigest: nonZeroHash(claim.qualificationLeafDigest, `safetyProfile.requiredClaims[${index}].qualificationLeafDigest`),
      revmObservationSchemaRef: nonZeroHash(claim.revmObservationSchemaRef, `safetyProfile.requiredClaims[${index}].revmObservationSchemaRef`),
    });
  });
  if (requiredClaims.length === 0) throw new TypeError("economic safety profile required claim set must be non-empty");
  for (let index = 1; index < requiredClaims.length; index += 1) {
    const left = requiredClaims[index - 1]!;
    const right = requiredClaims[index]!;
    if (`${left.ownerRef}\u0000${left.claimSchemaRef}` >= `${right.ownerRef}\u0000${right.claimSchemaRef}`) {
      throw new TypeError("economic safety profile required claims must be strictly sorted and unique");
    }
  }
  const body = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.economic-safety-profile" as const,
    profileRef: nonZeroHash(value.profileRef, "safetyProfile.profileRef"),
    requiredClaims: Object.freeze(requiredClaims),
    qualifiedOwnerSetRoot: nonZeroHash(value.qualifiedOwnerSetRoot, "safetyProfile.qualifiedOwnerSetRoot"),
  });
  return deepFreeze({
    ...body,
    profileCompositionRoot: hashDomain("aloha/economic-safety-profile-composition/v1", body),
  });
}

export function decodeSafetyProfileV1(value: unknown): SafetyProfileV1 {
  assertExactKeys(value, [
    "schemaVersion", "kind", "profileRef", "requiredClaims", "qualifiedOwnerSetRoot", "profileCompositionRoot",
  ], "economicSafetyProfile");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "aloha.economic-safety-profile" || !Array.isArray(record.requiredClaims)) {
    throw new TypeError("economic safety profile kind/version/claims mismatch");
  }
  const normalized = sealSafetyProfileV1({
    profileRef: record.profileRef as Hash,
    requiredClaims: record.requiredClaims as unknown as readonly EconomicSafetyProfileRequiredClaimV1[],
    qualifiedOwnerSetRoot: record.qualifiedOwnerSetRoot as Hash,
  });
  if (normalized.profileCompositionRoot !== nonZeroHash(record.profileCompositionRoot, "safetyProfile.profileCompositionRoot")) {
    throw new TypeError("economic safety profile composition root mismatch");
  }
  return normalized;
}

export function assertSafetyProfileQualificationMembershipV1(
  profileValue: SafetyProfileV1,
  certificatesValue: readonly EconomicSafetyActionOwnerQualificationCertificateV1[],
): void {
  const profile = decodeSafetyProfileV1(profileValue);
  const certificateSet = sealEconomicSafetyActionOwnerQualificationSetV1(certificatesValue);
  if (profile.qualifiedOwnerSetRoot !== certificateSet.root) {
    throw new TypeError("economic safety profile qualified owner set root mismatch");
  }
  for (const claim of profile.requiredClaims) {
    const matches = certificateSet.certificates.filter(certificate => certificate.ownerRef === claim.ownerRef
      && certificate.qualificationLeafDigest === claim.qualificationLeafDigest
      && certificate.claimSchemaRefs.includes(claim.claimSchemaRef));
    if (matches.length !== 1) throw new TypeError("economic safety profile required claim is not an exact qualified owner member");
  }
  for (const certificate of certificateSet.certificates) {
    const claims = profile.requiredClaims.filter(claim => claim.ownerRef === certificate.ownerRef);
    if (claims.length !== certificate.claimSchemaRefs.length
      || claims.some((claim, index) => claim.claimSchemaRef !== certificate.claimSchemaRefs[index])) {
      throw new TypeError("economic safety profile claim-schema coverage does not equal the qualified owner set");
    }
  }
}

export function joinGeneratedEconomicSafetyProfileV1(
  registryValue: GeneratedEconomicSafetyActionOwnerRegistryV1,
  certificatesValue: readonly EconomicSafetyActionOwnerQualificationCertificateV1[],
  qualifiedOwnerSetRoot: Hash,
  profileValue: SafetyProfileV1,
  profileRoot: Hash,
): Readonly<{
  registry: GeneratedEconomicSafetyActionOwnerRegistryV1;
  certificates: readonly EconomicSafetyActionOwnerQualificationCertificateV1[];
  qualifiedOwnerSetRoot: Hash;
  profile: SafetyProfileV1;
  profileRoot: Hash;
}> {
  const registry = sealGeneratedEconomicSafetyActionOwnerRegistryV1(registryValue.entries);
  if (registry.actionOwnerRegistryRoot !== registryValue.actionOwnerRegistryRoot) {
    throw new TypeError("economic safety generated action-owner registry root mismatch");
  }
  const certificateSet = sealEconomicSafetyActionOwnerQualificationSetV1(certificatesValue);
  if (certificateSet.root !== nonZeroHash(qualifiedOwnerSetRoot, "economicSafety.qualifiedOwnerSetRoot")) {
    throw new TypeError("economic safety qualified action-owner set root mismatch");
  }
  if (registry.entries.length !== certificateSet.certificates.length) {
    throw new TypeError("economic safety action-owner proposal/qualification denominator mismatch");
  }
  for (const [index, proposal] of registry.entries.entries()) {
    const certificate = certificateSet.certificates[index];
    if (certificate === undefined
      || certificate.familyDefinitionHash !== proposal.familyDefinitionHash
      || certificate.ownerId !== proposal.ownerId
      || certificate.ownerRef !== proposal.ownerRef
      || certificate.proposedOwnerLeafDigest !== proposal.proposalLeafDigest
      || certificate.implementationHash !== proposal.implementationHash
      || certificate.schemaRef !== proposal.schemaRef
      || certificate.implementationClosureRoot !== proposal.implementationClosureRoot) {
      throw new TypeError(`economic safety action-owner proposal/qualification splice at entries[${index}]`);
    }
  }
  const profile = decodeSafetyProfileV1(profileValue);
  if (profile.profileCompositionRoot !== nonZeroHash(profileRoot, "economicSafety.profileRoot")) {
    throw new TypeError("economic safety profile root mismatch");
  }
  assertSafetyProfileQualificationMembershipV1(profile, certificateSet.certificates);
  return deepFreeze({
    registry,
    certificates: certificateSet.certificates,
    qualifiedOwnerSetRoot: certificateSet.root,
    profile,
    profileRoot: profile.profileCompositionRoot,
  });
}
