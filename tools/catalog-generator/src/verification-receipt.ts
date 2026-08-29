import {
  assertHash,
  assertNonEmptyString,
  decodeExactObject,
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeCatalogCompilerClosureFacts,
  sealCatalogCompilerClosureFacts,
  type CatalogCompilerClosureFactV1,
} from "../../../specs/catalog-compiler/src/index.ts";

export const CATALOG_COMPILER_OBSERVER_ENTRYPOINT = Object.freeze({
  modulePath: "tools/catalog-generator/src/compiler-authority.ts",
  exportName: "observeCurrentCatalogCompilerAuthority",
});

export const CATALOG_GENERATION_VERIFIER_ENTRYPOINT = Object.freeze({
  modulePath: "tools/catalog-generator/src/verification-owner.ts",
  exportName: "verifyCurrentCatalogGeneration",
});

export const CATALOG_SEMANTIC_GENERATOR_ENTRYPOINT = Object.freeze({
  modulePath: "tools/catalog-generator/src/index.ts",
  exportName: "generateCatalogWithImpact",
});

export interface CatalogVerificationImplementationFactV1 extends CatalogCompilerClosureFactV1 {}

export interface CatalogGeneratorRecordV1 {
  readonly logicalPath: string;
  readonly contentSha256: Hash;
  readonly byteLength: number;
  readonly sourceKind: "tracked" | "typescript-lib" | "external";
}

/**
 * A typed source/build observation.  It intentionally carries no verdict,
 * issuer, signature, or qualification claim: external release governance may
 * pin its implementation binding/root, but candidate code cannot qualify
 * itself by constructing this receipt.
 */
export interface CatalogGenerationVerificationReceiptV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.catalog-generation-verification";
  readonly candidateDenominatorRoot: Hash;
  readonly indexDenominatorRoot: Hash;
  readonly scannedFileSetRoot: Hash;
  readonly compilerGraphRoot: Hash;
  readonly observedCompilerFactsRoot: Hash;
  readonly persistedCompilerFactsRoot: Hash;
  readonly observedProposedCapabilitySetRoot: Hash;
  readonly persistedProposedCapabilitySetRoot: Hash;
  readonly observerImplementation: CatalogVerificationImplementationFactV1;
  readonly verifierImplementation: CatalogVerificationImplementationFactV1;
  readonly verificationImplementationBindingRoot: Hash;
  readonly observedGeneratorLeaf: CatalogCompilerClosureFactV1;
  readonly ledgerGeneratorRecord: CatalogGeneratorRecordV1;
  readonly semanticLedgerHash: Hash;
  readonly semanticOutputRoot: Hash;
  readonly impactSnapshotRoot: Hash;
  readonly impactReceiptRoot: Hash;
  readonly receiptRoot: Hash;
}

function exactImplementationFact(value: unknown, path: string): CatalogVerificationImplementationFactV1 {
  const facts = decodeCatalogCompilerClosureFacts([value], path);
  return facts[0]!;
}

function exactGeneratorRecord(value: unknown, path: string): CatalogGeneratorRecordV1 {
  return decodeExactObject(value, {
    logicalPath: (item, itemPath) => assertNonEmptyString(item, itemPath),
    contentSha256: (item, itemPath) => assertHash(item, itemPath),
    byteLength: (item, itemPath) => {
      if (item !== 0) throw new TypeError(`catalog generator record byteLength must be zero at ${itemPath}`);
      return 0 as const;
    },
    sourceKind: (item, itemPath) => {
      if (item !== "tracked") throw new TypeError(`catalog generator record must be tracked at ${itemPath}`);
      return "tracked" as const;
    },
  }, path);
}

export function catalogCompilerFactsRoot(
  value: readonly CatalogCompilerClosureFactV1[],
): Hash {
  return hashDomain(
    "aloha/catalog-verification/compiler-facts/v1",
    sealCatalogCompilerClosureFacts(value),
  );
}

export function catalogCandidateDenominatorRoot(input: {
  readonly scannedFileSetRoot: Hash;
  readonly compilerGraphRoot: Hash;
}): Hash {
  return hashDomain("aloha/catalog-verification/candidate-denominator/v1", {
    scannedFileSetRoot: assertHash(input.scannedFileSetRoot, "candidate.scannedFileSetRoot"),
    compilerGraphRoot: assertHash(input.compilerGraphRoot, "candidate.compilerGraphRoot"),
  });
}

export function catalogIndexDenominatorRoot(input: {
  readonly compilerEntrypoints: readonly unknown[];
  readonly capabilityProposals: readonly unknown[];
}): Hash {
  return hashDomain("aloha/catalog-verification/index-denominator/v1", {
    compilerEntrypoints: input.compilerEntrypoints,
    capabilityProposals: input.capabilityProposals,
  });
}

export function catalogVerificationImplementationBindingRoot(input: {
  readonly observerImplementation: CatalogVerificationImplementationFactV1;
  readonly verifierImplementation: CatalogVerificationImplementationFactV1;
}): Hash {
  return hashDomain("aloha/catalog-verification/implementation-binding/v1", {
    observerImplementation: exactImplementationFact(input.observerImplementation, "observerImplementation"),
    verifierImplementation: exactImplementationFact(input.verifierImplementation, "verifierImplementation"),
  });
}

function receiptRoot(
  value: Omit<CatalogGenerationVerificationReceiptV1, "receiptRoot">,
): Hash {
  return hashDomain("aloha/catalog-generation-verification-receipt/v1", value);
}

export function createCatalogGenerationVerificationReceiptV1(
  input: Omit<CatalogGenerationVerificationReceiptV1, "schemaVersion" | "kind" | "verificationImplementationBindingRoot" | "receiptRoot">,
): CatalogGenerationVerificationReceiptV1 {
  const observerImplementation = exactImplementationFact(input.observerImplementation, "observerImplementation");
  const verifierImplementation = exactImplementationFact(input.verifierImplementation, "verifierImplementation");
  const observedGeneratorLeaf = exactImplementationFact(input.observedGeneratorLeaf, "observedGeneratorLeaf");
  const ledgerGeneratorRecord = exactGeneratorRecord(input.ledgerGeneratorRecord, "ledgerGeneratorRecord");
  if (
    observedGeneratorLeaf.modulePath !== CATALOG_SEMANTIC_GENERATOR_ENTRYPOINT.modulePath
    || observedGeneratorLeaf.exportName !== CATALOG_SEMANTIC_GENERATOR_ENTRYPOINT.exportName
  ) throw new TypeError("catalog verification generator leaf is not the semantic generator");
  if (
    ledgerGeneratorRecord.logicalPath !== `${observedGeneratorLeaf.modulePath}#${observedGeneratorLeaf.exportName}`
    || ledgerGeneratorRecord.contentSha256 !== observedGeneratorLeaf.closureDigest
  ) throw new TypeError("catalog verification generator leaf does not match the semantic ledger generator record");
  const base = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.catalog-generation-verification" as const,
    candidateDenominatorRoot: assertHash(input.candidateDenominatorRoot, "candidateDenominatorRoot"),
    indexDenominatorRoot: assertHash(input.indexDenominatorRoot, "indexDenominatorRoot"),
    scannedFileSetRoot: assertHash(input.scannedFileSetRoot, "scannedFileSetRoot"),
    compilerGraphRoot: assertHash(input.compilerGraphRoot, "compilerGraphRoot"),
    observedCompilerFactsRoot: assertHash(input.observedCompilerFactsRoot, "observedCompilerFactsRoot"),
    persistedCompilerFactsRoot: assertHash(input.persistedCompilerFactsRoot, "persistedCompilerFactsRoot"),
    observedProposedCapabilitySetRoot: assertHash(input.observedProposedCapabilitySetRoot, "observedProposedCapabilitySetRoot"),
    persistedProposedCapabilitySetRoot: assertHash(input.persistedProposedCapabilitySetRoot, "persistedProposedCapabilitySetRoot"),
    observerImplementation,
    verifierImplementation,
    verificationImplementationBindingRoot: catalogVerificationImplementationBindingRoot({ observerImplementation, verifierImplementation }),
    observedGeneratorLeaf,
    ledgerGeneratorRecord,
    semanticLedgerHash: assertHash(input.semanticLedgerHash, "semanticLedgerHash"),
    semanticOutputRoot: assertHash(input.semanticOutputRoot, "semanticOutputRoot"),
    impactSnapshotRoot: assertHash(input.impactSnapshotRoot, "impactSnapshotRoot"),
    impactReceiptRoot: assertHash(input.impactReceiptRoot, "impactReceiptRoot"),
  });
  if (base.candidateDenominatorRoot !== catalogCandidateDenominatorRoot(base)) {
    throw new TypeError("catalog verification candidate denominator root mismatch");
  }
  if (base.observedCompilerFactsRoot !== base.persistedCompilerFactsRoot) {
    throw new TypeError("catalog verification compiler facts do not exact-join");
  }
  if (base.observedProposedCapabilitySetRoot !== base.persistedProposedCapabilitySetRoot) {
    throw new TypeError("catalog verification proposed capability roots do not exact-join");
  }
  return Object.freeze({ ...base, receiptRoot: receiptRoot(base) });
}

export function decodeCatalogGenerationVerificationReceiptV1(
  value: unknown,
): CatalogGenerationVerificationReceiptV1 {
  const decoded = decodeExactObject(value, {
    schemaVersion: (item, path) => {
      if (item !== 1) throw new TypeError(`catalog verification schemaVersion must be 1 at ${path}`);
      return 1 as const;
    },
    kind: (item, path) => {
      if (item !== "aloha.catalog-generation-verification") throw new TypeError(`catalog verification kind mismatch at ${path}`);
      return "aloha.catalog-generation-verification" as const;
    },
    candidateDenominatorRoot: (item, path) => assertHash(item, path),
    indexDenominatorRoot: (item, path) => assertHash(item, path),
    scannedFileSetRoot: (item, path) => assertHash(item, path),
    compilerGraphRoot: (item, path) => assertHash(item, path),
    observedCompilerFactsRoot: (item, path) => assertHash(item, path),
    persistedCompilerFactsRoot: (item, path) => assertHash(item, path),
    observedProposedCapabilitySetRoot: (item, path) => assertHash(item, path),
    persistedProposedCapabilitySetRoot: (item, path) => assertHash(item, path),
    observerImplementation: (item, path) => exactImplementationFact(item, path),
    verifierImplementation: (item, path) => exactImplementationFact(item, path),
    verificationImplementationBindingRoot: (item, path) => assertHash(item, path),
    observedGeneratorLeaf: (item, path) => exactImplementationFact(item, path),
    ledgerGeneratorRecord: (item, path) => exactGeneratorRecord(item, path),
    semanticLedgerHash: (item, path) => assertHash(item, path),
    semanticOutputRoot: (item, path) => assertHash(item, path),
    impactSnapshotRoot: (item, path) => assertHash(item, path),
    impactReceiptRoot: (item, path) => assertHash(item, path),
    receiptRoot: (item, path) => assertHash(item, path),
  }, "catalogGenerationVerificationReceipt");
  const expected = createCatalogGenerationVerificationReceiptV1(decoded);
  if (encodeCanonicalJson(decoded) !== encodeCanonicalJson(expected)) {
    throw new TypeError("catalog generation verification receipt does not exact-join its typed facts");
  }
  return expected;
}

export function assertCatalogGenerationVerificationReceiptExact(
  actual: unknown,
  expected: CatalogGenerationVerificationReceiptV1,
): CatalogGenerationVerificationReceiptV1 {
  const decoded = decodeCatalogGenerationVerificationReceiptV1(actual);
  if (encodeCanonicalJson(decoded) !== encodeCanonicalJson(decodeCatalogGenerationVerificationReceiptV1(expected))) {
    throw new TypeError("catalog generation verification receipt does not match independently recomputed facts");
  }
  return decoded;
}
