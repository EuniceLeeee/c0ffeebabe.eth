import {
  arraySchema,
  decodeCanonicalJson,
  decimalStringSchema,
  defineSchema,
  defineSchemaManifest,
  deepFreeze,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  enumSchema,
  hashDomain,
  hashSchema,
  nonEmptyStringSchema,
  nullableSchema,
  objectSchema,
  semVerSchema,
  type CanonicalJsonObject,
  type CodecSchema,
  type Hash,
  type Infer,
} from "../../../packages/canonical-codec/src/index.ts";
import { CORE_SCHEMA_MANIFESTS, type SchemaRef } from "../../core-envelope/src/index.ts";
import { QUALIFIED_FACT_SCHEMA_MANIFESTS } from "../../qualified-facts/src/index.ts";

export type { Hash, SchemaRef };
export type QualificationCodecInput = string | Uint8Array | object;

const schemaRefSchema = CORE_SCHEMA_MANIFESTS.schemaRef.schema;
const locatorKindSchema = enumSchema([
  "file-range",
  "checkpoint-record",
  "chain-object",
  "content-object",
  "json-pointer",
] as const);

const mutationIdArraySchema = arraySchema(nonEmptyStringSchema);
const hashArraySchema = arraySchema(hashSchema);
const stringArraySchema = arraySchema(nonEmptyStringSchema);

/** Exact lower-case hex strings used for non-hash cryptographic material. */
function fixedHexSchema(byteLength: number, kind: string): CodecSchema<string> {
  const pattern = new RegExp(`^0x[0-9a-f]{${byteLength * 2}}$`);
  return defineSchema({ kind, byteLength }, (value, path = "$") => {
    if (typeof value !== "string" || !pattern.test(value)) {
      throw new TypeError(`expected lowercase ${byteLength}-byte 0x hex at ${path}`);
    }
    return value;
  });
}

const observerPublicKeyHexSchema = fixedHexSchema(32, "ed25519-public-key-hex");

const observerRolePayloadSchema = objectSchema({
  roleId: nonEmptyStringSchema,
  observationSchema: schemaRefSchema,
  anchorPolicyDigest: hashSchema,
  observerQualificationSpecDigest: hashSchema,
  requiredCriticalMutationIds: mutationIdArraySchema,
  minimumIndependentOracleCases: decimalStringSchema,
});

const observerRoleSchema = observerRolePayloadSchema;

const predicatePayloadSchema = objectSchema({
  predicateId: nonEmptyStringSchema,
  version: semVerSchema,
  claimSchemaRefs: arraySchema(schemaRefSchema),
  observationSchemaRefs: arraySchema(schemaRefSchema),
  requiredObserverRoles: arraySchema(observerRoleSchema),
  observerRoleSetHash: hashSchema,
  passRuleDigest: hashSchema,
  failRuleDigest: hashSchema,
  invalidRuleDigest: hashSchema,
  anchorPolicyDigest: hashSchema,
  tolerancePolicyDigest: hashSchema,
  forbiddenProducerSelectors: stringArraySchema,
  criticalMutationIds: mutationIdArraySchema,
  criticalMutationSetHash: hashSchema,
  independentOracleKinds: stringArraySchema,
  verifierQualificationSpecDigest: hashSchema,
});

const predicateSchema = objectSchema({
  ...predicatePayloadFields(),
  specDigest: hashSchema,
});

function predicatePayloadFields() {
  return {
    predicateId: nonEmptyStringSchema,
    version: semVerSchema,
    claimSchemaRefs: arraySchema(schemaRefSchema),
    observationSchemaRefs: arraySchema(schemaRefSchema),
    requiredObserverRoles: arraySchema(observerRoleSchema),
    observerRoleSetHash: hashSchema,
    passRuleDigest: hashSchema,
    failRuleDigest: hashSchema,
    invalidRuleDigest: hashSchema,
    anchorPolicyDigest: hashSchema,
    tolerancePolicyDigest: hashSchema,
    forbiddenProducerSelectors: stringArraySchema,
    criticalMutationIds: mutationIdArraySchema,
    criticalMutationSetHash: hashSchema,
    independentOracleKinds: stringArraySchema,
    verifierQualificationSpecDigest: hashSchema,
  } as const;
}

const registryPayloadSchema = objectSchema({
  schemaVersion: enumSchema([1] as const),
  kind: enumSchema(["aloha.qualification-registry"] as const),
  epoch: decimalStringSchema,
  trustedIssuerSetRoot: hashSchema,
  certificateSetRoot: hashSchema,
  revokedCertificateIdsRoot: hashSchema,
  observerKeySetRoot: hashSchema,
  revokedObserverKeyIdsRoot: hashSchema,
  previousRegistryRoot: nullableSchema(hashSchema),
  governanceTrustAnchorHash: hashSchema,
});

const registrySchema = objectSchema({
  ...registryPayloadFields(),
  registryId: hashSchema,
  payloadHash: hashSchema,
});

function registryPayloadFields() {
  return {
    schemaVersion: enumSchema([1] as const),
    kind: enumSchema(["aloha.qualification-registry"] as const),
    epoch: decimalStringSchema,
    trustedIssuerSetRoot: hashSchema,
    certificateSetRoot: hashSchema,
    revokedCertificateIdsRoot: hashSchema,
    observerKeySetRoot: hashSchema,
    revokedObserverKeyIdsRoot: hashSchema,
    previousRegistryRoot: nullableSchema(hashSchema),
    governanceTrustAnchorHash: hashSchema,
  } as const;
}

const observerSigningKeyPayloadSchema = objectSchema({
  schemaVersion: enumSchema([1] as const),
  kind: enumSchema(["aloha.observer-signing-key"] as const),
  observerQualificationId: hashSchema,
  roleId: nonEmptyStringSchema,
  algorithm: enumSchema(["ed25519"] as const),
  publicKeyHex: observerPublicKeyHexSchema,
  validFromRegistryEpoch: decimalStringSchema,
  validThroughRegistryEpoch: decimalStringSchema,
  audienceHash: hashSchema,
});

const observerSigningKeySchema = objectSchema({
  ...observerSigningKeyPayloadFields(),
  keyId: hashSchema,
});

function observerSigningKeyPayloadFields() {
  return {
    schemaVersion: enumSchema([1] as const),
    kind: enumSchema(["aloha.observer-signing-key"] as const),
    observerQualificationId: hashSchema,
    roleId: nonEmptyStringSchema,
    algorithm: enumSchema(["ed25519"] as const),
    publicKeyHex: observerPublicKeyHexSchema,
    validFromRegistryEpoch: decimalStringSchema,
    validThroughRegistryEpoch: decimalStringSchema,
    audienceHash: hashSchema,
  } as const;
}

const observerCertificatePayloadSchema = objectSchema({
  schemaVersion: enumSchema([1] as const),
  kind: enumSchema(["aloha.observer-qualification"] as const),
  qualificationSpecDigest: hashSchema,
  observerImplementationDigest: hashSchema,
  observedSchemaIds: arraySchema(schemaRefSchema),
  qualifiedLocatorKinds: arraySchema(locatorKindSchema),
  anchorValidationMethodDigest: hashSchema,
  positiveCaseRoot: hashSchema,
  negativeCaseRoot: hashSchema,
  invalidCaseRoot: hashSchema,
  declaredCriticalMutationIds: mutationIdArraySchema,
  rejectedOrInvalidMutationIds: mutationIdArraySchema,
  independentOracleCaseRoot: hashSchema,
  independentOracleCaseCount: decimalStringSchema,
  issuerId: nonEmptyStringSchema,
  issuedAtRegistryEpoch: decimalStringSchema,
  verdict: enumSchema(["qualified", "not-qualified"] as const),
});

const observerCertificateSchema = objectSchema({
  ...observerCertificatePayloadFields(),
  certificateId: hashSchema,
  payloadHash: hashSchema,
});

function observerCertificatePayloadFields() {
  return {
    schemaVersion: enumSchema([1] as const),
    kind: enumSchema(["aloha.observer-qualification"] as const),
    qualificationSpecDigest: hashSchema,
    observerImplementationDigest: hashSchema,
    observedSchemaIds: arraySchema(schemaRefSchema),
    qualifiedLocatorKinds: arraySchema(locatorKindSchema),
    anchorValidationMethodDigest: hashSchema,
    positiveCaseRoot: hashSchema,
    negativeCaseRoot: hashSchema,
    invalidCaseRoot: hashSchema,
    declaredCriticalMutationIds: mutationIdArraySchema,
    rejectedOrInvalidMutationIds: mutationIdArraySchema,
    independentOracleCaseRoot: hashSchema,
    independentOracleCaseCount: decimalStringSchema,
    issuerId: nonEmptyStringSchema,
    issuedAtRegistryEpoch: decimalStringSchema,
    verdict: enumSchema(["qualified", "not-qualified"] as const),
  } as const;
}

const verifierRoleSchema = objectSchema({
  roleId: nonEmptyStringSchema,
  observationSchema: schemaRefSchema,
  anchorPolicyDigest: hashSchema,
  observerQualificationSpecDigest: hashSchema,
  requiredCriticalMutationIds: mutationIdArraySchema,
  minimumIndependentOracleCases: decimalStringSchema,
  observerQualificationId: hashSchema,
});

const verifierCertificatePayloadSchema = objectSchema({
  schemaVersion: enumSchema([1] as const),
  kind: enumSchema(["aloha.verifier-qualification"] as const),
  qualificationSpecDigest: hashSchema,
  predicateSpecDigest: hashSchema,
  predicateImplementationDigest: hashSchema,
  predicateImplementationExportDigest: hashSchema,
  predicateProgramDescriptorDigest: hashSchema,
  oracleProgramDescriptorDigest: hashSchema,
  oracleImplementationClosureDigest: hashSchema,
  oracleImplementationExportDigest: hashSchema,
  predicateCompositionLeafDigest: hashSchema,
  gateCoreImplementationClosureDigest: hashSchema,
  observerQualificationIds: hashArraySchema,
  requiredObserverRoles: arraySchema(verifierRoleSchema),
  caseSetRoot: hashSchema,
  declaredCriticalMutationIds: mutationIdArraySchema,
  rejectedOrInvalidMutationIds: mutationIdArraySchema,
  independentOracleCaseRoot: hashSchema,
  independentOracleCaseCount: decimalStringSchema,
  oldReferenceCaseCount: decimalStringSchema,
  counterexampleRoot: hashSchema,
  issuerId: nonEmptyStringSchema,
  issuedAtRegistryEpoch: decimalStringSchema,
  verdict: enumSchema(["qualified", "not-qualified"] as const),
});

const verifierCertificateSchema = objectSchema({
  ...verifierCertificatePayloadFields(),
  certificateId: hashSchema,
  payloadHash: hashSchema,
});

function verifierCertificatePayloadFields() {
  return {
    schemaVersion: enumSchema([1] as const),
    kind: enumSchema(["aloha.verifier-qualification"] as const),
    qualificationSpecDigest: hashSchema,
    predicateSpecDigest: hashSchema,
    predicateImplementationDigest: hashSchema,
    predicateImplementationExportDigest: hashSchema,
    predicateProgramDescriptorDigest: hashSchema,
    oracleProgramDescriptorDigest: hashSchema,
    oracleImplementationClosureDigest: hashSchema,
    oracleImplementationExportDigest: hashSchema,
    predicateCompositionLeafDigest: hashSchema,
    gateCoreImplementationClosureDigest: hashSchema,
    observerQualificationIds: hashArraySchema,
    requiredObserverRoles: arraySchema(verifierRoleSchema),
    caseSetRoot: hashSchema,
    declaredCriticalMutationIds: mutationIdArraySchema,
    rejectedOrInvalidMutationIds: mutationIdArraySchema,
    independentOracleCaseRoot: hashSchema,
    independentOracleCaseCount: decimalStringSchema,
    oldReferenceCaseCount: decimalStringSchema,
    counterexampleRoot: hashSchema,
    issuerId: nonEmptyStringSchema,
    issuedAtRegistryEpoch: decimalStringSchema,
    verdict: enumSchema(["qualified", "not-qualified"] as const),
  } as const;
}

const membershipInputPayloadSchema = objectSchema({
  registryRoot: hashSchema,
  registryEpoch: decimalStringSchema,
  certificateKind: enumSchema(["observer", "verifier"] as const),
  certificateId: hashSchema,
  certificatePayloadHash: hashSchema,
  issuerId: nonEmptyStringSchema,
  trustedIssuerIds: stringArraySchema,
  certificateMemberships: arraySchema(objectSchema({
    certificateKind: enumSchema(["observer", "verifier"] as const),
    certificateId: hashSchema,
    certificatePayloadHash: hashSchema,
    issuerId: nonEmptyStringSchema,
  })),
  revokedCertificateIds: hashArraySchema,
  observerSigningKeys: arraySchema(observerSigningKeySchema),
  revokedObserverKeyIds: hashArraySchema,
});

const membershipInputSchema = objectSchema({
  ...membershipInputPayloadFields(),
  inputId: hashSchema,
  payloadHash: hashSchema,
});

function membershipInputPayloadFields() {
  return {
    registryRoot: hashSchema,
    registryEpoch: decimalStringSchema,
    certificateKind: enumSchema(["observer", "verifier"] as const),
    certificateId: hashSchema,
    certificatePayloadHash: hashSchema,
    issuerId: nonEmptyStringSchema,
    trustedIssuerIds: stringArraySchema,
    certificateMemberships: arraySchema(objectSchema({
      certificateKind: enumSchema(["observer", "verifier"] as const),
      certificateId: hashSchema,
      certificatePayloadHash: hashSchema,
      issuerId: nonEmptyStringSchema,
    })),
    revokedCertificateIds: hashArraySchema,
    observerSigningKeys: arraySchema(observerSigningKeySchema),
    revokedObserverKeyIds: hashArraySchema,
  } as const;
}

const membershipResultPayloadSchema = objectSchema({
  inputId: hashSchema,
  registryRoot: hashSchema,
  registryEpoch: decimalStringSchema,
  certificateKind: enumSchema(["observer", "verifier"] as const),
  certificateId: hashSchema,
  certificatePayloadHash: hashSchema,
  issuerId: nonEmptyStringSchema,
  status: enumSchema(["member", "missing", "revoked", "untrusted-issuer", "payload-mismatch", "stale-registry"] as const),
});

const membershipResultSchema = objectSchema({
  ...membershipResultPayloadFields(),
  resultId: hashSchema,
  payloadHash: hashSchema,
});

function membershipResultPayloadFields() {
  return {
    inputId: hashSchema,
    registryRoot: hashSchema,
    registryEpoch: decimalStringSchema,
    certificateKind: enumSchema(["observer", "verifier"] as const),
    certificateId: hashSchema,
    certificatePayloadHash: hashSchema,
    issuerId: nonEmptyStringSchema,
    status: enumSchema(["member", "missing", "revoked", "untrusted-issuer", "payload-mismatch", "stale-registry"] as const),
  } as const;
}

export type ObserverRoleSpecV1 = Infer<typeof observerRoleSchema>;
export type PredicateSpecV1 = Infer<typeof predicateSchema>;
export type QualificationRegistrySnapshotV1 = Infer<typeof registrySchema>;
export type ObserverSigningKeyV1 = Infer<typeof observerSigningKeySchema>;
export type ObserverQualificationCertificateV1 = Infer<typeof observerCertificateSchema>;
export type VerifierQualificationCertificateV1 = Infer<typeof verifierCertificateSchema>;
export type CurrentRegistryMembershipInputV1 = Infer<typeof membershipInputSchema>;
export type CurrentRegistryMembershipResultV1 = Infer<typeof membershipResultSchema>;
export type VerifierRoleV1 = Infer<typeof verifierRoleSchema>;
export type MembershipCertificateKind = "observer" | "verifier";
export type CertificateMembershipMaterialV1 = Infer<typeof membershipInputPayloadSchema>["certificateMemberships"][number];
export type ObserverSigningKeyMembershipMaterialV1 = Infer<typeof membershipInputPayloadSchema>["observerSigningKeys"][number];

function parseInput(value: QualificationCodecInput): unknown {
  if (typeof value === "string") return decodeCanonicalJson(value);
  if (ArrayBuffer.isView(value)) return decodeCanonicalJson(value as Uint8Array);
  return value;
}

function strictSorted(values: readonly string[], path: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) throw new TypeError(`values must be strictly sorted at ${path}[${index}]`);
  }
}

function strictSortedBy<T>(values: readonly T[], key: (value: T) => string, path: string): void {
  strictSorted(values.map(key), path);
}

function strictSortedSchemaRefs(values: readonly SchemaRef[], path: string): void {
  strictSortedBy(values, (value) => encodeCanonicalJson(value), path);
}

function positiveDecimal(value: string, path: string, allowZero = true): void {
  const parsed = BigInt(value);
  if (parsed < 0n || (!allowZero && parsed === 0n)) throw new TypeError(`invalid non-negative decimal at ${path}`);
}

function payloadWithout<T extends object>(value: T, fields: readonly string[]): CanonicalJsonObject {
  const output: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of fields) delete output[field];
  return output as CanonicalJsonObject;
}

function payloadHash(kind: string, value: object): Hash {
  return hashDomain(`${kind}/payload/v1`, payloadWithout(value, ["payloadHash", "certificateId", "registryId", "inputId", "resultId", "specDigest"]));
}

function objectId(kind: string, payload: Hash): Hash {
  return hashDomain(`${kind}/id/v1`, payload);
}

function roleSetHash(roles: readonly ObserverRoleSpecV1[]): Hash {
  return hashDomain("aloha/observer-role-set/v1", roles);
}

export const COMMON_ENVELOPE_ROLE_CONTRACT_VERSION = "1.0.0" as const;

export const COMMON_ENVELOPE_ACQUISITION_MUTATION_IDS = Object.freeze([
  "acquisition-process-anchor",
  "acquisition-raw-range-splice",
  "sidecar-duplicate-orphan-omission",
  "sidecar-facts-hash",
  "sidecar-id",
  "sidecar-observer-implementation",
  "sidecar-schema-role-swap",
  "sidecar-wrong-observer-certificate",
].sort());

export const COMMON_ENVELOPE_TARGET_MUTATION_IDS = Object.freeze([
  "sidecar-duplicate-orphan-omission",
  "sidecar-facts-hash",
  "sidecar-id",
  "sidecar-observer-implementation",
  "sidecar-schema-role-swap",
  "sidecar-wrong-observer-certificate",
  "target-process-anchor",
  "target-raw-range-splice",
].sort());

export const COMMON_ENVELOPE_STORE_MUTATION_IDS = Object.freeze([
  "sidecar-duplicate-orphan-omission",
  "sidecar-facts-hash",
  "sidecar-id",
  "sidecar-observer-implementation",
  "sidecar-schema-role-swap",
  "sidecar-wrong-observer-certificate",
  "store-epoch",
  "store-identity",
  "store-raw-ref-splice",
].sort());

export const COMMON_ENVELOPE_INVOCATION_MUTATION_IDS = Object.freeze([
  "invocation-binding-duplicate",
  "invocation-binding-extra",
  "invocation-binding-forged-object",
  "invocation-binding-hash",
  "invocation-binding-length",
  "invocation-binding-mirror-hash",
  "invocation-binding-mirror-media",
  "invocation-binding-mirror-schema",
  "invocation-binding-object-id",
  "invocation-binding-raw-partition-overlap",
  "invocation-binding-raw-ref",
  "invocation-binding-receipt-boundary-overlap",
  "invocation-binding-reorder",
  "invocation-binding-subject-input-overlap",
  "invocation-binding-subset",
  "invocation-binding-unsigned-derived-object",
  "invocation-expiry-boundary",
  "invocation-key-audience",
  "invocation-key-expired",
  "invocation-key-locator-capability",
  "invocation-key-revoked",
  "invocation-key-role",
  "invocation-key-unregistered",
  "invocation-ordinary-observer-role",
  "invocation-query",
  "invocation-signature-byte",
  "invocation-signature-missing",
  "invocation-signature-payload",
  "invocation-signature-random",
  "invocation-snapshot",
].sort());

export const COMMON_ENVELOPE_CRITICAL_MUTATION_IDS = Object.freeze([
  ...new Set([
    ...COMMON_ENVELOPE_ACQUISITION_MUTATION_IDS,
    ...COMMON_ENVELOPE_TARGET_MUTATION_IDS,
    ...COMMON_ENVELOPE_STORE_MUTATION_IDS,
    ...COMMON_ENVELOPE_INVOCATION_MUTATION_IDS,
  ]),
].sort());

function schemaRefOf(manifest: { readonly id: string; readonly version: string; readonly schemaHash: Hash }): SchemaRef {
  return Object.freeze({ id: manifest.id, version: manifest.version, schemaHash: manifest.schemaHash });
}

function commonEnvelopeRole(
  roleId: string,
  observationSchema: SchemaRef,
  requiredCriticalMutationIds: readonly string[],
): ObserverRoleSpecV1 {
  return createObserverRoleSpec({
    roleId,
    observationSchema,
    anchorPolicyDigest: hashDomain("aloha/common-envelope-role/anchor-policy/v1", {
      contractVersion: COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
      roleId,
      observationSchema,
    }),
    observerQualificationSpecDigest: hashDomain("aloha/common-envelope-role/qualification-spec/v1", {
      contractVersion: COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
      roleId,
      observationSchema,
      requiredCriticalMutationIds,
    }),
    requiredCriticalMutationIds,
    minimumIndependentOracleCases: "1",
  });
}

export interface CommonEnvelopeRoleContractV1 {
  readonly version: typeof COMMON_ENVELOPE_ROLE_CONTRACT_VERSION;
  readonly predicateId: string;
  readonly signedInvocationRoleId: string;
  readonly requiredObserverRoles: readonly ObserverRoleSpecV1[];
  readonly observationSchemaRefs: readonly SchemaRef[];
  readonly criticalMutationIds: readonly string[];
}

/** Predicate-independent envelope mechanics. The predicate id is used only to
 * derive its dedicated invocation-seal role; there is no predicate catalog or
 * predicate-specific branch in this contract. */
export function createCommonEnvelopeRoleContractV1(predicateId: string): CommonEnvelopeRoleContractV1 {
  if (typeof predicateId !== "string" || predicateId.length === 0) throw new TypeError("common envelope predicateId is required");
  const signedInvocationRoleId = `${predicateId}.signed-invocation-seal`;
  const roles = [
    commonEnvelopeRole(
      "acquisition-observer-process",
      schemaRefOf(QUALIFIED_FACT_SCHEMA_MANIFESTS.acquisitionProcessObservation),
      COMMON_ENVELOPE_ACQUISITION_MUTATION_IDS,
    ),
    commonEnvelopeRole(
      signedInvocationRoleId,
      schemaRefOf(QUALIFIED_FACT_SCHEMA_MANIFESTS.signedObserverInvocationSnapshot),
      COMMON_ENVELOPE_INVOCATION_MUTATION_IDS,
    ),
    commonEnvelopeRole(
      "store-epoch-observation",
      schemaRefOf(QUALIFIED_FACT_SCHEMA_MANIFESTS.storeEpochObservation),
      COMMON_ENVELOPE_STORE_MUTATION_IDS,
    ),
    commonEnvelopeRole(
      "target-production-process",
      schemaRefOf(QUALIFIED_FACT_SCHEMA_MANIFESTS.targetProcessObservation),
      COMMON_ENVELOPE_TARGET_MUTATION_IDS,
    ),
  ].sort((left, right) => left.roleId.localeCompare(right.roleId));
  return deepFreeze({
    version: COMMON_ENVELOPE_ROLE_CONTRACT_VERSION,
    predicateId,
    signedInvocationRoleId,
    requiredObserverRoles: roles,
    observationSchemaRefs: roles.map((role) => role.observationSchema)
      .sort((left, right) => encodeCanonicalJson(left).localeCompare(encodeCanonicalJson(right))),
    criticalMutationIds: [...COMMON_ENVELOPE_CRITICAL_MUTATION_IDS],
  });
}

type PredicateSpecPayloadV1 = Omit<PredicateSpecV1, "specDigest">;
export type CommonEnvelopePredicateSpecInputV1 = Omit<
  PredicateSpecPayloadV1,
  "observerRoleSetHash" | "criticalMutationSetHash"
>;

/** Compose the shared envelope denominator with one predicate's ordinary
 * roles. Derived role/mutation hashes cannot be supplied by the caller. */
export function createCommonEnvelopePredicateSpecV1(
  input: CommonEnvelopePredicateSpecInputV1,
): PredicateSpecV1 {
  const contract = createCommonEnvelopeRoleContractV1(input.predicateId);
  const commonRoleIds = new Set(contract.requiredObserverRoles.map((role) => role.roleId));
  const commonSchemas = new Set(contract.observationSchemaRefs.map((schema) => encodeCanonicalJson(schema)));
  for (const role of input.requiredObserverRoles) {
    if (commonRoleIds.has(role.roleId) || commonSchemas.has(encodeCanonicalJson(role.observationSchema))) {
      throw new TypeError(`ordinary observer role collides with common envelope contract: ${role.roleId}`);
    }
  }
  const requiredObserverRoles = [...contract.requiredObserverRoles, ...input.requiredObserverRoles]
    .sort((left, right) => left.roleId.localeCompare(right.roleId));
  const observationSchemaRefs = [...new Map(
    [...contract.observationSchemaRefs, ...input.observationSchemaRefs]
      .map((schema) => [encodeCanonicalJson(schema), schema] as const),
  ).values()].sort((left, right) => encodeCanonicalJson(left).localeCompare(encodeCanonicalJson(right)));
  const criticalMutationIds = [...new Set([...contract.criticalMutationIds, ...input.criticalMutationIds])].sort();
  return createPredicateSpec({
    ...input,
    observationSchemaRefs,
    requiredObserverRoles,
    observerRoleSetHash: roleSetHash(requiredObserverRoles),
    criticalMutationIds,
    criticalMutationSetHash: mutationSetHash(criticalMutationIds),
  });
}

export function assertPredicateCommonEnvelopeRoleContractV1(
  predicate: PredicateSpecV1,
): CommonEnvelopeRoleContractV1 {
  const contract = createCommonEnvelopeRoleContractV1(predicate.predicateId);
  for (const expected of contract.requiredObserverRoles) {
    const byRole = predicate.requiredObserverRoles.filter((role) => role.roleId === expected.roleId);
    const bySchema = predicate.requiredObserverRoles.filter((role) => encodeCanonicalJson(role.observationSchema) === encodeCanonicalJson(expected.observationSchema));
    if (byRole.length !== 1 || bySchema.length !== 1 || encodeCanonicalJson(byRole[0]) !== encodeCanonicalJson(expected)) {
      throw new TypeError(`predicate common envelope role mismatch: ${expected.roleId}`);
    }
  }
  for (const schema of contract.observationSchemaRefs) {
    if (predicate.observationSchemaRefs.filter((candidate) => encodeCanonicalJson(candidate) === encodeCanonicalJson(schema)).length !== 1) {
      throw new TypeError(`predicate common envelope observation schema mismatch: ${schema.id}`);
    }
  }
  for (const mutationId of contract.criticalMutationIds) {
    if (!predicate.criticalMutationIds.includes(mutationId)) throw new TypeError(`predicate common envelope mutation missing: ${mutationId}`);
  }
  return contract;
}

function mutationSetHash(ids: readonly string[]): Hash {
  return hashDomain("aloha/critical-mutation-set/v1", ids);
}

export function hashObserverSigningKeySetRoot(keyIds: readonly Hash[]): Hash {
  const decoded = hashArraySchema.decode(keyIds, "observerKeySetRoot.keyIds");
  strictSorted(decoded, "observerKeySetRoot.keyIds");
  return hashDomain("aloha/observer-signing-key-set/v1", decoded);
}

export function hashRevokedObserverKeyIdsRoot(keyIds: readonly Hash[]): Hash {
  const decoded = hashArraySchema.decode(keyIds, "revokedObserverKeyIdsRoot.keyIds");
  strictSorted(decoded, "revokedObserverKeyIdsRoot.keyIds");
  return hashDomain("aloha/revoked-observer-key-set/v1", decoded);
}

function checkRole(value: ObserverRoleSpecV1, path: string): ObserverRoleSpecV1 {
  strictSorted(value.requiredCriticalMutationIds, `${path}.requiredCriticalMutationIds`);
  positiveDecimal(value.minimumIndependentOracleCases, `${path}.minimumIndependentOracleCases`, false);
  return deepFreeze(value);
}

function checkPredicate(value: PredicateSpecV1, path: string): PredicateSpecV1 {
  strictSortedSchemaRefs(value.claimSchemaRefs, `${path}.claimSchemaRefs`);
  strictSortedSchemaRefs(value.observationSchemaRefs, `${path}.observationSchemaRefs`);
  strictSortedBy(value.requiredObserverRoles, (role) => role.roleId, `${path}.requiredObserverRoles`);
  strictSorted(value.forbiddenProducerSelectors, `${path}.forbiddenProducerSelectors`);
  strictSorted(value.criticalMutationIds, `${path}.criticalMutationIds`);
  strictSorted(value.independentOracleKinds, `${path}.independentOracleKinds`);
  if (value.independentOracleKinds.length === 0) throw new TypeError(`independentOracleKinds must not be empty at ${path}`);
  const zero = ("0x" + "0".repeat(64)) as Hash;
  if ([value.passRuleDigest, value.failRuleDigest, value.invalidRuleDigest, value.anchorPolicyDigest, value.tolerancePolicyDigest, value.verifierQualificationSpecDigest].includes(zero)) throw new TypeError(`predicate rule digests must be non-zero at ${path}`);
  const declaredObservationSchemas = new Set(value.observationSchemaRefs.map((schema) => encodeCanonicalJson(schema)));
  for (const role of value.requiredObserverRoles) {
    if (!declaredObservationSchemas.has(encodeCanonicalJson(role.observationSchema))) {
      throw new TypeError(`required observer role schema is not declared at ${path}.requiredObserverRoles.${role.roleId}`);
    }
  }
  for (const [index, role] of value.requiredObserverRoles.entries()) checkRole(role, `${path}.requiredObserverRoles[${index}]`);
  if (value.observerRoleSetHash !== roleSetHash(value.requiredObserverRoles)) throw new TypeError(`observerRoleSetHash mismatch at ${path}`);
  if (value.criticalMutationSetHash !== mutationSetHash(value.criticalMutationIds)) throw new TypeError(`criticalMutationSetHash mismatch at ${path}`);
  const expected = hashDomain("aloha/predicate-spec/v1", payloadWithout(value, ["specDigest"]));
  if (value.specDigest !== expected) throw new TypeError(`predicate specDigest mismatch at ${path}`);
  return deepFreeze(value);
}

function checkRegistry(value: QualificationRegistrySnapshotV1, path: string): QualificationRegistrySnapshotV1 {
  positiveDecimal(value.epoch, `${path}.epoch`);
  const zero = "0x" + "0".repeat(64);
  if (value.trustedIssuerSetRoot === zero || value.certificateSetRoot === zero || value.revokedCertificateIdsRoot === zero || value.observerKeySetRoot === zero || value.revokedObserverKeyIdsRoot === zero || value.governanceTrustAnchorHash === zero) throw new TypeError(`registry roots and governance trust anchor must be non-zero at ${path}`);
  const expectedPayload = payloadHash("aloha/qualification-registry", value);
  if (value.payloadHash !== expectedPayload) throw new TypeError(`registry payloadHash mismatch at ${path}`);
  if (value.registryId !== objectId("aloha/qualification-registry", expectedPayload)) throw new TypeError(`registryId mismatch at ${path}`);
  return deepFreeze(value);
}

function checkObserverSigningKey(value: ObserverSigningKeyV1, path: string): ObserverSigningKeyV1 {
  positiveDecimal(value.validFromRegistryEpoch, `${path}.validFromRegistryEpoch`);
  positiveDecimal(value.validThroughRegistryEpoch, `${path}.validThroughRegistryEpoch`);
  if (BigInt(value.validFromRegistryEpoch) > BigInt(value.validThroughRegistryEpoch)) {
    throw new TypeError(`observer signing key validity interval is inverted at ${path}`);
  }
  if (value.audienceHash === ("0x" + "0".repeat(64))) throw new TypeError(`observer signing key audienceHash must be non-zero at ${path}`);
  const expected = hashDomain("aloha/observer-signing-key/v1", payloadWithout(value, ["keyId"]));
  if (value.keyId !== expected) throw new TypeError(`observer signing key keyId mismatch at ${path}`);
  return deepFreeze(value);
}

function checkObserverCertificate(value: ObserverQualificationCertificateV1, path: string): ObserverQualificationCertificateV1 {
  strictSortedSchemaRefs(value.observedSchemaIds, `${path}.observedSchemaIds`);
  strictSorted(value.qualifiedLocatorKinds, `${path}.qualifiedLocatorKinds`);
  strictSorted(value.declaredCriticalMutationIds, `${path}.declaredCriticalMutationIds`);
  strictSorted(value.rejectedOrInvalidMutationIds, `${path}.rejectedOrInvalidMutationIds`);
  positiveDecimal(value.independentOracleCaseCount, `${path}.independentOracleCaseCount`, false);
  positiveDecimal(value.issuedAtRegistryEpoch, `${path}.issuedAtRegistryEpoch`);
  if (encodeCanonicalJson(value.declaredCriticalMutationIds) !== encodeCanonicalJson(value.rejectedOrInvalidMutationIds)) throw new TypeError(`declared/rejected mutation sets differ at ${path}`);
  const expectedPayload = payloadHash("aloha/observer-qualification", value);
  if (value.payloadHash !== expectedPayload) throw new TypeError(`observer payloadHash mismatch at ${path}`);
  if (value.certificateId !== objectId("aloha/observer-qualification", expectedPayload)) throw new TypeError(`observer certificateId mismatch at ${path}`);
  return deepFreeze(value);
}

function checkVerifierCertificate(value: VerifierQualificationCertificateV1, path: string): VerifierQualificationCertificateV1 {
  strictSorted(value.observerQualificationIds, `${path}.observerQualificationIds`);
  strictSortedBy(value.requiredObserverRoles, (role) => role.roleId, `${path}.requiredObserverRoles`);
  strictSorted(value.declaredCriticalMutationIds, `${path}.declaredCriticalMutationIds`);
  strictSorted(value.rejectedOrInvalidMutationIds, `${path}.rejectedOrInvalidMutationIds`);
  positiveDecimal(value.independentOracleCaseCount, `${path}.independentOracleCaseCount`, false);
  positiveDecimal(value.oldReferenceCaseCount, `${path}.oldReferenceCaseCount`);
  positiveDecimal(value.issuedAtRegistryEpoch, `${path}.issuedAtRegistryEpoch`);
  const zero = "0x" + "0".repeat(64);
  if (
    value.predicateImplementationDigest === zero ||
    value.predicateImplementationExportDigest === zero ||
    value.predicateProgramDescriptorDigest === zero ||
    value.oracleProgramDescriptorDigest === zero ||
    value.oracleImplementationClosureDigest === zero ||
    value.oracleImplementationExportDigest === zero ||
    value.predicateCompositionLeafDigest === zero ||
    value.gateCoreImplementationClosureDigest === zero
  ) {
    throw new TypeError(`verifier implementation and program digests must be non-zero at ${path}`);
  }
  for (const role of value.requiredObserverRoles) checkRole(role, `${path}.requiredObserverRoles.${role.roleId}`);
  if (encodeCanonicalJson(value.declaredCriticalMutationIds) !== encodeCanonicalJson(value.rejectedOrInvalidMutationIds)) throw new TypeError(`declared/rejected mutation sets differ at ${path}`);
  const expectedPayload = payloadHash("aloha/verifier-qualification", value);
  if (value.payloadHash !== expectedPayload) throw new TypeError(`verifier payloadHash mismatch at ${path}`);
  if (value.certificateId !== objectId("aloha/verifier-qualification", expectedPayload)) throw new TypeError(`verifier certificateId mismatch at ${path}`);
  return deepFreeze(value);
}

function checkMembershipInput(value: CurrentRegistryMembershipInputV1, path: string): CurrentRegistryMembershipInputV1 {
  positiveDecimal(value.registryEpoch, `${path}.registryEpoch`);
  strictSorted(value.trustedIssuerIds, `${path}.trustedIssuerIds`);
  strictSorted(value.revokedCertificateIds, `${path}.revokedCertificateIds`);
  strictSortedBy(value.certificateMemberships, (entry) => entry.certificateId, `${path}.certificateMemberships`);
  strictSortedBy(value.observerSigningKeys, (entry) => entry.keyId, `${path}.observerSigningKeys`);
  strictSorted(value.revokedObserverKeyIds, `${path}.revokedObserverKeyIds`);
  if (new Set(value.certificateMemberships.map((entry) => entry.certificateId)).size !== value.certificateMemberships.length) throw new TypeError(`duplicate certificate membership at ${path}`);
  if (new Set(value.observerSigningKeys.map((entry) => entry.keyId)).size !== value.observerSigningKeys.length) throw new TypeError(`duplicate observer signing key at ${path}`);
  if (new Set(value.revokedObserverKeyIds).size !== value.revokedObserverKeyIds.length) throw new TypeError(`duplicate revoked observer signing key at ${path}`);
  for (const [index, key] of value.observerSigningKeys.entries()) checkObserverSigningKey(key, `${path}.observerSigningKeys[${index}]`);
  const expectedPayload = payloadHash("aloha/current-registry-membership-input", value);
  if (value.payloadHash !== expectedPayload) throw new TypeError(`membership input payloadHash mismatch at ${path}`);
  if (value.inputId !== objectId("aloha/current-registry-membership-input", expectedPayload)) throw new TypeError(`membership inputId mismatch at ${path}`);
  return deepFreeze(value);
}

function checkMembershipResult(value: CurrentRegistryMembershipResultV1, path: string): CurrentRegistryMembershipResultV1 {
  positiveDecimal(value.registryEpoch, `${path}.registryEpoch`);
  const expectedPayload = payloadHash("aloha/current-registry-membership-result", value);
  if (value.payloadHash !== expectedPayload) throw new TypeError(`membership result payloadHash mismatch at ${path}`);
  if (value.resultId !== objectId("aloha/current-registry-membership-result", expectedPayload)) throw new TypeError(`membership resultId mismatch at ${path}`);
  return deepFreeze(value);
}

function custom<T>(structural: CodecSchema<T>, kind: string, check: (value: T, path: string) => T): CodecSchema<T> {
  return defineSchema({ kind, fields: structural.descriptor }, (value, path = "$") => check(structural.decode(value, path), path));
}

export const QUALIFICATION_SCHEMAS = Object.freeze({
  observerRole: custom(observerRoleSchema, "aloha.observer-role-spec", checkRole),
  predicate: custom(predicateSchema, "aloha.predicate-spec", checkPredicate),
  registry: custom(registrySchema, "aloha.qualification-registry", checkRegistry),
  observerSigningKey: custom(observerSigningKeySchema, "aloha.observer-signing-key", checkObserverSigningKey),
  observerCertificate: custom(observerCertificateSchema, "aloha.observer-qualification", checkObserverCertificate),
  verifierCertificate: custom(verifierCertificateSchema, "aloha.verifier-qualification", checkVerifierCertificate),
  membershipInput: custom(membershipInputSchema, "aloha.current-registry-membership-input", checkMembershipInput),
  membershipResult: custom(membershipResultSchema, "aloha.current-registry-membership-result", checkMembershipResult),
});

export const QUALIFICATION_SCHEMA_MANIFESTS = Object.freeze({
  observerRole: defineSchemaManifest("aloha.observer-role-spec", "1.0.0", QUALIFICATION_SCHEMAS.observerRole),
  predicate: defineSchemaManifest("aloha.predicate-spec", "1.0.0", QUALIFICATION_SCHEMAS.predicate),
  registry: defineSchemaManifest("aloha.qualification-registry", "1.0.0", QUALIFICATION_SCHEMAS.registry),
  observerSigningKey: defineSchemaManifest("aloha.observer-signing-key", "1.0.0", QUALIFICATION_SCHEMAS.observerSigningKey),
  observerCertificate: defineSchemaManifest("aloha.observer-qualification", "1.0.0", QUALIFICATION_SCHEMAS.observerCertificate),
  verifierCertificate: defineSchemaManifest("aloha.verifier-qualification", "1.0.0", QUALIFICATION_SCHEMAS.verifierCertificate),
  membershipInput: defineSchemaManifest("aloha.current-registry-membership-input", "1.0.0", QUALIFICATION_SCHEMAS.membershipInput),
  membershipResult: defineSchemaManifest("aloha.current-registry-membership-result", "1.0.0", QUALIFICATION_SCHEMAS.membershipResult),
});

export function decodeObserverRole(value: QualificationCodecInput): ObserverRoleSpecV1 { return QUALIFICATION_SCHEMAS.observerRole.decode(parseInput(value)); }
export function decodePredicate(value: QualificationCodecInput): PredicateSpecV1 { return QUALIFICATION_SCHEMAS.predicate.decode(parseInput(value)); }
export function decodeQualificationRegistry(value: QualificationCodecInput): QualificationRegistrySnapshotV1 { return QUALIFICATION_SCHEMAS.registry.decode(parseInput(value)); }
export function decodeObserverSigningKey(value: QualificationCodecInput): ObserverSigningKeyV1 { return QUALIFICATION_SCHEMAS.observerSigningKey.decode(parseInput(value)); }
export function decodeObserverCertificate(value: QualificationCodecInput): ObserverQualificationCertificateV1 { return QUALIFICATION_SCHEMAS.observerCertificate.decode(parseInput(value)); }
export function decodeVerifierCertificate(value: QualificationCodecInput): VerifierQualificationCertificateV1 { return QUALIFICATION_SCHEMAS.verifierCertificate.decode(parseInput(value)); }
export function decodeMembershipInput(value: QualificationCodecInput): CurrentRegistryMembershipInputV1 { return QUALIFICATION_SCHEMAS.membershipInput.decode(parseInput(value)); }
export function decodeMembershipResult(value: QualificationCodecInput): CurrentRegistryMembershipResultV1 { return QUALIFICATION_SCHEMAS.membershipResult.decode(parseInput(value)); }

export function encodeObserverRole(value: ObserverRoleSpecV1): Uint8Array { return encodeCanonicalBytes(QUALIFICATION_SCHEMAS.observerRole.decode(value)); }
export function encodePredicate(value: PredicateSpecV1): Uint8Array { return encodeCanonicalBytes(QUALIFICATION_SCHEMAS.predicate.decode(value)); }
export function encodeQualificationRegistry(value: QualificationRegistrySnapshotV1): Uint8Array { return encodeCanonicalBytes(QUALIFICATION_SCHEMAS.registry.decode(value)); }
export function encodeObserverSigningKey(value: ObserverSigningKeyV1): Uint8Array { return encodeCanonicalBytes(QUALIFICATION_SCHEMAS.observerSigningKey.decode(value)); }
export function encodeObserverCertificate(value: ObserverQualificationCertificateV1): Uint8Array { return encodeCanonicalBytes(QUALIFICATION_SCHEMAS.observerCertificate.decode(value)); }
export function encodeVerifierCertificate(value: VerifierQualificationCertificateV1): Uint8Array { return encodeCanonicalBytes(QUALIFICATION_SCHEMAS.verifierCertificate.decode(value)); }
export function encodeMembershipInput(value: CurrentRegistryMembershipInputV1): Uint8Array { return encodeCanonicalBytes(QUALIFICATION_SCHEMAS.membershipInput.decode(value)); }
export function encodeMembershipResult(value: CurrentRegistryMembershipResultV1): Uint8Array { return encodeCanonicalBytes(QUALIFICATION_SCHEMAS.membershipResult.decode(value)); }

export function createObserverRoleSpec(input: ObserverRoleSpecV1): ObserverRoleSpecV1 {
  const payload = observerRolePayloadSchema.decode(input);
  return checkRole(payload, "$" );
}

export function createPredicateSpec(input: Omit<PredicateSpecV1, "specDigest">): PredicateSpecV1 {
  const payload = predicatePayloadSchema.decode(input);
  const specDigest = hashDomain("aloha/predicate-spec/v1", payload);
  return checkPredicate(predicateSchema.decode({ ...payload, specDigest }), "$" );
}

export function createQualificationRegistry(input: Omit<QualificationRegistrySnapshotV1, "registryId" | "payloadHash">): QualificationRegistrySnapshotV1 {
  const payload = registryPayloadSchema.decode(input);
  const payloadHashValue = payloadHash("aloha/qualification-registry", payload);
  return checkRegistry(registrySchema.decode({ ...payload, registryId: objectId("aloha/qualification-registry", payloadHashValue), payloadHash: payloadHashValue }), "$" );
}

export function createObserverSigningKey(input: Omit<ObserverSigningKeyV1, "keyId">): ObserverSigningKeyV1 {
  const payload = observerSigningKeyPayloadSchema.decode(input);
  const keyId = hashDomain("aloha/observer-signing-key/v1", payload);
  return checkObserverSigningKey(observerSigningKeySchema.decode({ ...payload, keyId }), "$" );
}

export function createObserverQualificationCertificate(input: Omit<ObserverQualificationCertificateV1, "certificateId" | "payloadHash">): ObserverQualificationCertificateV1 {
  const payload = observerCertificatePayloadSchema.decode(input);
  const payloadHashValue = payloadHash("aloha/observer-qualification", payload);
  return checkObserverCertificate(observerCertificateSchema.decode({ ...payload, certificateId: objectId("aloha/observer-qualification", payloadHashValue), payloadHash: payloadHashValue }), "$" );
}

export function createVerifierQualificationCertificate(input: Omit<VerifierQualificationCertificateV1, "certificateId" | "payloadHash">): VerifierQualificationCertificateV1 {
  const payload = verifierCertificatePayloadSchema.decode(input);
  const payloadHashValue = payloadHash("aloha/verifier-qualification", payload);
  return checkVerifierCertificate(verifierCertificateSchema.decode({ ...payload, certificateId: objectId("aloha/verifier-qualification", payloadHashValue), payloadHash: payloadHashValue }), "$" );
}

export function createMembershipInput(input: Omit<CurrentRegistryMembershipInputV1, "inputId" | "payloadHash">): CurrentRegistryMembershipInputV1 {
  const payload = membershipInputPayloadSchema.decode(input);
  const payloadHashValue = payloadHash("aloha/current-registry-membership-input", payload);
  return checkMembershipInput(membershipInputSchema.decode({ ...payload, inputId: objectId("aloha/current-registry-membership-input", payloadHashValue), payloadHash: payloadHashValue }), "$" );
}

export function createMembershipResult(input: Omit<CurrentRegistryMembershipResultV1, "resultId" | "payloadHash">): CurrentRegistryMembershipResultV1 {
  const payload = membershipResultPayloadSchema.decode(input);
  const payloadHashValue = payloadHash("aloha/current-registry-membership-result", payload);
  return checkMembershipResult(membershipResultSchema.decode({ ...payload, resultId: objectId("aloha/current-registry-membership-result", payloadHashValue), payloadHash: payloadHashValue }), "$" );
}

export function hashPredicateSpec(value: PredicateSpecV1): Hash { return hashDomain("aloha/predicate-spec/v1", payloadWithout(decodePredicate(value), ["specDigest"])); }
export function hashRegistryPayload(value: QualificationRegistrySnapshotV1): Hash { return payloadHash("aloha/qualification-registry", decodeQualificationRegistry(value)); }
export function recomputeObserverSigningKeyId(value: ObserverSigningKeyV1): Hash {
  return hashDomain("aloha/observer-signing-key/v1", payloadWithout(decodeObserverSigningKey(value), ["keyId"]));
}
export function hashObserverCertificatePayload(value: ObserverQualificationCertificateV1): Hash { return payloadHash("aloha/observer-qualification", decodeObserverCertificate(value)); }
export function hashVerifierCertificatePayload(value: VerifierQualificationCertificateV1): Hash { return payloadHash("aloha/verifier-qualification", decodeVerifierCertificate(value)); }

export * from "./external-v2.ts";
