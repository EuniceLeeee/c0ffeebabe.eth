import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  deepFreeze,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import type { AssetReferenceV1 } from "../../../packages/asset-ref/src/index.ts";

export interface EconomicValuationSourceV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

export interface EconomicValuationFactV1 {
  readonly kind: "aloha.economic-valuation-fact-v1";
  readonly ownerRef: Hash;
  readonly generationId: string;
  readonly source: EconomicValuationSourceV1;
  readonly assetRef: Hash;
  readonly numerator: string;
  readonly denominator: string;
  readonly ownerImplementationHash: Hash;
  readonly valuationOwnerRegistryRoot: Hash;
  readonly qualifiedValuationOwnerSetRoot: Hash;
  readonly qualificationLeafDigest: Hash;
  readonly currentSourceObservationRoot: Hash;
  readonly factRoot: Hash;
}

export interface EconomicValuationOwnerRuntimeDescriptorV1 {
  readonly ownerRef: Hash;
  readonly supportedAssetRefs: readonly Hash[];
  readonly implementationHash: Hash;
  readonly factSchemaRef: Hash;
  readonly implementationClosureRoot: Hash;
  readonly qualificationLeafDigest: Hash;
  readonly valuationOwnerRegistryRoot: Hash;
  readonly qualifiedValuationOwnerSetRoot: Hash;
}

/** Neutral plugin/runtime port. Concrete valuation owners must implement this
 * contract without importing the central economics evaluator. */
export interface EconomicValuationOwnerRuntimeBindingV1 extends EconomicValuationOwnerRuntimeDescriptorV1 {
  readonly observeCurrentSource: (input: Readonly<{
    generationId: string;
    source: EconomicValuationSourceV1;
    asset: AssetReferenceV1;
  }>) => Promise<EconomicValuationFactV1>;
}

export interface EconomicValuationOwnerDeclarationV1 {
  readonly ownerRef: Hash;
  readonly supportedAssetRefs: readonly Hash[];
  readonly modulePath: string;
  readonly exportName: string;
  readonly implementationHash: Hash;
  readonly factSchemaRef: Hash;
  /** Narrow source capabilities required by this owner. The generated runtime
   * supplies owner-issued ports; raw endpoints and fetch functions are never
   * part of this wire contract. */
  readonly sourceReadCapabilityRefs: readonly Hash[];
  readonly qualificationModulePath: string;
  readonly qualificationSpecExportName: string;
  readonly criticalMutationCorpusExportName: string;
  readonly independentOracleCasesExportName: string;
  readonly qualificationSpecDigest: Hash;
  readonly criticalMutationCorpusRoot: Hash;
  readonly independentOracleCaseRoot: Hash;
}

export interface QualifiedEconomicValuationOwnerEntryV1 extends EconomicValuationOwnerDeclarationV1 {
  readonly implementationClosureRoot: Hash;
  readonly qualificationSpecClosureRoot: Hash;
  readonly criticalMutationCorpusClosureRoot: Hash;
  readonly independentOracleClosureRoot: Hash;
  readonly qualificationLeafDigest: Hash;
}

export interface GeneratedEconomicValuationOwnerRegistryV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.generated-economic-valuation-owner-registry";
  readonly entries: readonly QualifiedEconomicValuationOwnerEntryV1[];
  readonly valuationOwnerRegistryRoot: Hash;
}

export interface EconomicValuationOwnerQualificationCertificateV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.economic-valuation-owner-qualification-certificate";
  readonly ownerRef: Hash;
  readonly supportedAssetRefs: readonly Hash[];
  readonly proposedOwnerLeafDigest: Hash;
  readonly implementationHash: Hash;
  readonly factSchemaRef: Hash;
  readonly implementationClosureRoot: Hash;
  readonly qualificationSpecDigest: Hash;
  readonly qualificationSpecClosureRoot: Hash;
  readonly criticalMutationCorpusRoot: Hash;
  readonly criticalMutationCorpusClosureRoot: Hash;
  readonly independentOracleCaseRoot: Hash;
  readonly independentOracleClosureRoot: Hash;
  readonly executedPositiveCaseRoot: Hash;
  readonly executedNegativeCaseRoot: Hash;
  readonly executedInvalidCaseRoot: Hash;
  readonly verifierImplementationDigest: Hash;
  readonly qualificationAuthorityApprovalId: Hash;
  readonly qualificationAuthorityApprovalPayloadHash: Hash;
  readonly certificateRoot: Hash;
}

export interface QualifiedEconomicValuationOwnerSetV1 {
  readonly registry: GeneratedEconomicValuationOwnerRegistryV1;
  readonly certificates: readonly EconomicValuationOwnerQualificationCertificateV1[];
  readonly qualifiedValuationOwnerSetRoot: Hash;
}

export function economicValuationOwnerQualificationSpecDigestV1(value: unknown): Hash {
  return hashDomain("aloha/economic-valuation-owner-qualification-spec/v1", value as CanonicalJson);
}

export function economicValuationOwnerCriticalMutationCorpusRootV1(value: unknown): Hash {
  return hashDomain("aloha/economic-valuation-owner-critical-mutation-corpus/v1", value as CanonicalJson);
}

export function economicValuationOwnerIndependentOracleCaseRootV1(value: unknown): Hash {
  return hashDomain("aloha/economic-valuation-owner-independent-oracle-cases/v1", value as CanonicalJson);
}

function modulePath(value: unknown, path: string): string {
  const normalized = assertNonEmptyString(value, path);
  if (
    normalized.startsWith("/")
    || normalized.startsWith(".")
    || normalized.includes("\\")
    || normalized.includes("..")
    || normalized.includes("?")
    || normalized.includes("#")
  ) throw new TypeError(`${path} must be a canonical repository module path`);
  return normalized;
}

function exportName(value: unknown, path: string): string {
  const normalized = assertNonEmptyString(value, path);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(normalized)) throw new TypeError(`${path} must be a JavaScript identifier`);
  return normalized;
}

function nonZeroHash(value: unknown, path: string): Hash {
  const hash = assertHash(value, path);
  if (hash === `0x${"0".repeat(64)}`) throw new TypeError(`${path} must be non-zero`);
  return hash;
}

function sortedUniqueHashes(value: unknown, path: string): readonly Hash[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const hashes = value.map((entry, index) => assertHash(entry, `${path}[${index}]`));
  for (let index = 1; index < hashes.length; index += 1) {
    if (hashes[index - 1]! >= hashes[index]!) throw new TypeError(`${path} must be strictly sorted and unique`);
  }
  return Object.freeze(hashes);
}

function nonEmptySortedUniqueHashes(value: unknown, path: string): readonly Hash[] {
  const hashes = sortedUniqueHashes(value, path);
  if (hashes.length === 0) throw new TypeError(`${path} must be non-empty`);
  return hashes;
}

export function normalizeEconomicValuationOwnerDeclarationV1(
  value: EconomicValuationOwnerDeclarationV1,
): EconomicValuationOwnerDeclarationV1 {
  assertExactKeys(value, [
    "ownerRef", "supportedAssetRefs", "modulePath", "exportName", "implementationHash", "factSchemaRef",
    "sourceReadCapabilityRefs", "qualificationModulePath", "qualificationSpecExportName",
    "criticalMutationCorpusExportName", "independentOracleCasesExportName",
    "qualificationSpecDigest", "criticalMutationCorpusRoot", "independentOracleCaseRoot",
  ], "economicValuationOwnerDeclaration");
  return deepFreeze({
    ownerRef: nonZeroHash(value.ownerRef, "economicValuationOwnerDeclaration.ownerRef"),
    supportedAssetRefs: nonEmptySortedUniqueHashes(value.supportedAssetRefs, "economicValuationOwnerDeclaration.supportedAssetRefs"),
    modulePath: modulePath(value.modulePath, "economicValuationOwnerDeclaration.modulePath"),
    exportName: exportName(value.exportName, "economicValuationOwnerDeclaration.exportName"),
    implementationHash: nonZeroHash(value.implementationHash, "economicValuationOwnerDeclaration.implementationHash"),
    factSchemaRef: nonZeroHash(value.factSchemaRef, "economicValuationOwnerDeclaration.factSchemaRef"),
    sourceReadCapabilityRefs: sortedUniqueHashes(value.sourceReadCapabilityRefs, "economicValuationOwnerDeclaration.sourceReadCapabilityRefs"),
    qualificationModulePath: modulePath(value.qualificationModulePath, "economicValuationOwnerDeclaration.qualificationModulePath"),
    qualificationSpecExportName: exportName(value.qualificationSpecExportName, "economicValuationOwnerDeclaration.qualificationSpecExportName"),
    criticalMutationCorpusExportName: exportName(value.criticalMutationCorpusExportName, "economicValuationOwnerDeclaration.criticalMutationCorpusExportName"),
    independentOracleCasesExportName: exportName(value.independentOracleCasesExportName, "economicValuationOwnerDeclaration.independentOracleCasesExportName"),
    qualificationSpecDigest: nonZeroHash(value.qualificationSpecDigest, "economicValuationOwnerDeclaration.qualificationSpecDigest"),
    criticalMutationCorpusRoot: nonZeroHash(value.criticalMutationCorpusRoot, "economicValuationOwnerDeclaration.criticalMutationCorpusRoot"),
    independentOracleCaseRoot: nonZeroHash(value.independentOracleCaseRoot, "economicValuationOwnerDeclaration.independentOracleCaseRoot"),
  });
}

function declarationFields(
  value: EconomicValuationOwnerDeclarationV1,
): EconomicValuationOwnerDeclarationV1 {
  return {
    ownerRef: value.ownerRef,
    supportedAssetRefs: value.supportedAssetRefs,
    modulePath: value.modulePath,
    exportName: value.exportName,
    implementationHash: value.implementationHash,
    factSchemaRef: value.factSchemaRef,
    sourceReadCapabilityRefs: value.sourceReadCapabilityRefs,
    qualificationModulePath: value.qualificationModulePath,
    qualificationSpecExportName: value.qualificationSpecExportName,
    criticalMutationCorpusExportName: value.criticalMutationCorpusExportName,
    independentOracleCasesExportName: value.independentOracleCasesExportName,
    qualificationSpecDigest: value.qualificationSpecDigest,
    criticalMutationCorpusRoot: value.criticalMutationCorpusRoot,
    independentOracleCaseRoot: value.independentOracleCaseRoot,
  };
}

export function economicValuationOwnerQualificationLeafDigestV1(
  value: Omit<QualifiedEconomicValuationOwnerEntryV1, "qualificationLeafDigest">,
): Hash {
  const declaration = normalizeEconomicValuationOwnerDeclarationV1(declarationFields(value));
  return hashDomain("aloha/economic-valuation-owner-qualification-leaf/v1", {
    ...declaration,
    implementationClosureRoot: nonZeroHash(value.implementationClosureRoot, "economicValuationOwner.implementationClosureRoot"),
    qualificationSpecClosureRoot: nonZeroHash(value.qualificationSpecClosureRoot, "economicValuationOwner.qualificationSpecClosureRoot"),
    criticalMutationCorpusClosureRoot: nonZeroHash(value.criticalMutationCorpusClosureRoot, "economicValuationOwner.criticalMutationCorpusClosureRoot"),
    independentOracleClosureRoot: nonZeroHash(value.independentOracleClosureRoot, "economicValuationOwner.independentOracleClosureRoot"),
  });
}

export function sealQualifiedEconomicValuationOwnerEntryV1(
  declarationValue: EconomicValuationOwnerDeclarationV1,
  implementationClosureRoot: Hash,
  qualificationClosures: Readonly<{
    qualificationSpecClosureRoot: Hash;
    criticalMutationCorpusClosureRoot: Hash;
    independentOracleClosureRoot: Hash;
  }>,
): QualifiedEconomicValuationOwnerEntryV1 {
  const declaration = normalizeEconomicValuationOwnerDeclarationV1(declarationFields(declarationValue));
  const base = Object.freeze({
    ...declaration,
    implementationClosureRoot: nonZeroHash(implementationClosureRoot, "economicValuationOwner.implementationClosureRoot"),
    qualificationSpecClosureRoot: nonZeroHash(qualificationClosures.qualificationSpecClosureRoot, "economicValuationOwner.qualificationSpecClosureRoot"),
    criticalMutationCorpusClosureRoot: nonZeroHash(qualificationClosures.criticalMutationCorpusClosureRoot, "economicValuationOwner.criticalMutationCorpusClosureRoot"),
    independentOracleClosureRoot: nonZeroHash(qualificationClosures.independentOracleClosureRoot, "economicValuationOwner.independentOracleClosureRoot"),
  });
  return deepFreeze({ ...base, qualificationLeafDigest: economicValuationOwnerQualificationLeafDigestV1(base) });
}

export function sealGeneratedEconomicValuationOwnerRegistryV1(
  values: readonly QualifiedEconomicValuationOwnerEntryV1[],
): GeneratedEconomicValuationOwnerRegistryV1 {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError("economic valuation owner registry must be non-empty");
  const entries = values.map((value, index) => {
    assertExactKeys(value, [
      "ownerRef", "supportedAssetRefs", "modulePath", "exportName", "implementationHash", "factSchemaRef",
      "sourceReadCapabilityRefs", "qualificationModulePath", "qualificationSpecExportName",
      "criticalMutationCorpusExportName", "independentOracleCasesExportName",
      "qualificationSpecDigest", "criticalMutationCorpusRoot", "independentOracleCaseRoot",
      "implementationClosureRoot", "qualificationSpecClosureRoot", "criticalMutationCorpusClosureRoot",
      "independentOracleClosureRoot", "qualificationLeafDigest",
    ], `economicValuationOwnerRegistry.entries[${index}]`);
    const normalized = sealQualifiedEconomicValuationOwnerEntryV1(
      value as unknown as EconomicValuationOwnerDeclarationV1,
      value.implementationClosureRoot as Hash,
      {
        qualificationSpecClosureRoot: value.qualificationSpecClosureRoot as Hash,
        criticalMutationCorpusClosureRoot: value.criticalMutationCorpusClosureRoot as Hash,
        independentOracleClosureRoot: value.independentOracleClosureRoot as Hash,
      },
    );
    if (value.qualificationLeafDigest !== normalized.qualificationLeafDigest) {
      throw new TypeError(`economic valuation owner qualification leaf mismatch at entries[${index}]`);
    }
    return normalized;
  });
  const leaves = new Set(entries.map(entry => entry.qualificationLeafDigest));
  if (leaves.size !== entries.length) throw new TypeError("economic valuation owner qualification leaves must be unique");
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]!.ownerRef >= entries[index]!.ownerRef) {
      throw new TypeError("economic valuation owner entries must be strictly sorted and unique by ownerRef");
    }
  }
  const frozenEntries = Object.freeze(entries);
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.generated-economic-valuation-owner-registry" as const,
    entries: frozenEntries,
    valuationOwnerRegistryRoot: hashDomain("aloha/economic-valuation-owner-registry/v1", frozenEntries),
  });
}

const CERTIFICATE_KEYS = Object.freeze([
  "schemaVersion", "kind", "ownerRef", "supportedAssetRefs", "proposedOwnerLeafDigest", "implementationHash", "factSchemaRef",
  "implementationClosureRoot", "qualificationSpecDigest", "qualificationSpecClosureRoot",
  "criticalMutationCorpusRoot", "criticalMutationCorpusClosureRoot", "independentOracleCaseRoot",
  "independentOracleClosureRoot", "executedPositiveCaseRoot", "executedNegativeCaseRoot",
  "executedInvalidCaseRoot", "verifierImplementationDigest", "qualificationAuthorityApprovalId",
  "qualificationAuthorityApprovalPayloadHash", "certificateRoot",
] as const);

function qualificationCertificateBody(
  value: Omit<EconomicValuationOwnerQualificationCertificateV1, "certificateRoot">,
) {
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.economic-valuation-owner-qualification-certificate" as const,
    ownerRef: nonZeroHash(value.ownerRef, "valuationQualification.ownerRef"),
    supportedAssetRefs: nonEmptySortedUniqueHashes(value.supportedAssetRefs, "valuationQualification.supportedAssetRefs"),
    proposedOwnerLeafDigest: nonZeroHash(value.proposedOwnerLeafDigest, "valuationQualification.proposedOwnerLeafDigest"),
    implementationHash: nonZeroHash(value.implementationHash, "valuationQualification.implementationHash"),
    factSchemaRef: nonZeroHash(value.factSchemaRef, "valuationQualification.factSchemaRef"),
    implementationClosureRoot: nonZeroHash(value.implementationClosureRoot, "valuationQualification.implementationClosureRoot"),
    qualificationSpecDigest: nonZeroHash(value.qualificationSpecDigest, "valuationQualification.qualificationSpecDigest"),
    qualificationSpecClosureRoot: nonZeroHash(value.qualificationSpecClosureRoot, "valuationQualification.qualificationSpecClosureRoot"),
    criticalMutationCorpusRoot: nonZeroHash(value.criticalMutationCorpusRoot, "valuationQualification.criticalMutationCorpusRoot"),
    criticalMutationCorpusClosureRoot: nonZeroHash(value.criticalMutationCorpusClosureRoot, "valuationQualification.criticalMutationCorpusClosureRoot"),
    independentOracleCaseRoot: nonZeroHash(value.independentOracleCaseRoot, "valuationQualification.independentOracleCaseRoot"),
    independentOracleClosureRoot: nonZeroHash(value.independentOracleClosureRoot, "valuationQualification.independentOracleClosureRoot"),
    executedPositiveCaseRoot: nonZeroHash(value.executedPositiveCaseRoot, "valuationQualification.executedPositiveCaseRoot"),
    executedNegativeCaseRoot: nonZeroHash(value.executedNegativeCaseRoot, "valuationQualification.executedNegativeCaseRoot"),
    executedInvalidCaseRoot: nonZeroHash(value.executedInvalidCaseRoot, "valuationQualification.executedInvalidCaseRoot"),
    verifierImplementationDigest: nonZeroHash(value.verifierImplementationDigest, "valuationQualification.verifierImplementationDigest"),
    qualificationAuthorityApprovalId: nonZeroHash(value.qualificationAuthorityApprovalId, "valuationQualification.qualificationAuthorityApprovalId"),
    qualificationAuthorityApprovalPayloadHash: nonZeroHash(value.qualificationAuthorityApprovalPayloadHash, "valuationQualification.qualificationAuthorityApprovalPayloadHash"),
  });
}

export function sealEconomicValuationOwnerQualificationCertificateV1(
  value: Omit<EconomicValuationOwnerQualificationCertificateV1, "certificateRoot">,
): EconomicValuationOwnerQualificationCertificateV1 {
  const body = qualificationCertificateBody(value);
  return deepFreeze({
    ...body,
    certificateRoot: hashDomain("aloha/economic-valuation-owner-qualification-certificate/v1", body),
  });
}

export function decodeEconomicValuationOwnerQualificationCertificateV1(
  value: unknown,
): EconomicValuationOwnerQualificationCertificateV1 {
  assertExactKeys(value, CERTIFICATE_KEYS, "economicValuationOwnerQualificationCertificate");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "aloha.economic-valuation-owner-qualification-certificate") {
    throw new TypeError("economic valuation owner qualification certificate kind/version mismatch");
  }
  const { certificateRoot: _certificateRoot, ...bodyValue } = record;
  const sealed = sealEconomicValuationOwnerQualificationCertificateV1(
    bodyValue as unknown as Omit<EconomicValuationOwnerQualificationCertificateV1, "certificateRoot">,
  );
  if (sealed.certificateRoot !== nonZeroHash(record.certificateRoot, "valuationQualification.certificateRoot")) {
    throw new TypeError("economic valuation owner qualification certificate root mismatch");
  }
  return sealed;
}

export function sealEconomicValuationOwnerQualificationCertificateSetV1(
  values: readonly EconomicValuationOwnerQualificationCertificateV1[],
): Readonly<{ certificates: readonly EconomicValuationOwnerQualificationCertificateV1[]; root: Hash }> {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError("economic valuation owner qualification certificate set must be non-empty");
  const certificates = values.map(decodeEconomicValuationOwnerQualificationCertificateV1);
  if (new Set(certificates.map(value => value.certificateRoot)).size !== certificates.length) {
    throw new TypeError("economic valuation owner qualification certificate roots must be unique");
  }
  for (let index = 1; index < certificates.length; index += 1) {
    if (certificates[index - 1]!.ownerRef >= certificates[index]!.ownerRef) {
      throw new TypeError("economic valuation owner qualification certificates must be strictly sorted and unique by ownerRef");
    }
  }
  const frozen = Object.freeze(certificates);
  return deepFreeze({
    certificates: frozen,
    root: hashDomain("aloha/qualified-economic-valuation-owner-set/v1", frozen),
  });
}

/** Exact release join between the generated proposal denominator and the
 * acceptance-issued executable qualification denominator. A certificate's
 * proposedOwnerLeafDigest binds the complete declaration and all compiler
 * closures, while the repeated identity fields make mismatches explicit. */
export function joinEconomicValuationOwnerQualificationSetV1(
  registryValue: GeneratedEconomicValuationOwnerRegistryV1,
  certificateValues: readonly EconomicValuationOwnerQualificationCertificateV1[],
  expectedQualifiedSetRoot: Hash,
): QualifiedEconomicValuationOwnerSetV1 {
  const registry = sealGeneratedEconomicValuationOwnerRegistryV1(registryValue.entries);
  if (registry.valuationOwnerRegistryRoot !== registryValue.valuationOwnerRegistryRoot) {
    throw new TypeError("economic valuation owner proposal registry root mismatch");
  }
  const certificateSet = sealEconomicValuationOwnerQualificationCertificateSetV1(certificateValues);
  if (certificateSet.root !== assertHash(expectedQualifiedSetRoot, "qualifiedValuationOwnerSetRoot")) {
    throw new TypeError("economic valuation owner qualified set root mismatch");
  }
  if (registry.entries.length !== certificateSet.certificates.length) {
    throw new TypeError("economic valuation owner proposal/certificate cardinality mismatch");
  }
  for (let index = 0; index < registry.entries.length; index += 1) {
    const proposal = registry.entries[index]!;
    const certificate = certificateSet.certificates[index]!;
    if (
      certificate.ownerRef !== proposal.ownerRef
      || certificate.supportedAssetRefs.length !== proposal.supportedAssetRefs.length
      || certificate.supportedAssetRefs.some((assetRef, assetIndex) => assetRef !== proposal.supportedAssetRefs[assetIndex])
      || certificate.proposedOwnerLeafDigest !== proposal.qualificationLeafDigest
      || certificate.implementationHash !== proposal.implementationHash
      || certificate.factSchemaRef !== proposal.factSchemaRef
      || certificate.implementationClosureRoot !== proposal.implementationClosureRoot
      || certificate.qualificationSpecDigest !== proposal.qualificationSpecDigest
      || certificate.qualificationSpecClosureRoot !== proposal.qualificationSpecClosureRoot
      || certificate.criticalMutationCorpusRoot !== proposal.criticalMutationCorpusRoot
      || certificate.criticalMutationCorpusClosureRoot !== proposal.criticalMutationCorpusClosureRoot
      || certificate.independentOracleCaseRoot !== proposal.independentOracleCaseRoot
      || certificate.independentOracleClosureRoot !== proposal.independentOracleClosureRoot
    ) throw new TypeError(`economic valuation owner qualification certificate does not exact-join proposal ${proposal.ownerRef}`);
  }
  return deepFreeze({
    registry,
    certificates: certificateSet.certificates,
    qualifiedValuationOwnerSetRoot: certificateSet.root,
  });
}
