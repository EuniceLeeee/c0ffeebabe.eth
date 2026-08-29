import {
  currentCatalogCapabilityProposalSpecs,
  currentCatalogCompilerEntrypointSpecs,
  currentCatalogInput,
  readCurrentCatalogInput,
} from "./current-release.ts";
import {
  generateCatalogWithImpact,
  verifyCatalogLedger,
} from "./index.ts";
import {
  observeCurrentCatalogCompilerAuthority,
  assertCatalogCompilerAuthorityExact,
} from "./compiler-authority.ts";
import {
  CATALOG_SEMANTIC_GENERATOR_ENTRYPOINT,
  catalogCandidateDenominatorRoot,
  catalogCompilerFactsRoot,
  catalogIndexDenominatorRoot,
  createCatalogGenerationVerificationReceiptV1,
  type CatalogGenerationVerificationReceiptV1,
} from "./verification-receipt.ts";
import type { Hash } from "../../../packages/canonical-codec/src/index.ts";

/**
 * Re-run the independently bound compiler observer and exact semantic
 * regeneration.  This function only emits a typed source/build observation;
 * it cannot issue a qualification or production verdict.
 */
export function verifyCurrentCatalogGeneration(
  repositoryRoot: string,
): CatalogGenerationVerificationReceiptV1 {
  const observed = observeCurrentCatalogCompilerAuthority(repositoryRoot);
  const persisted = readCurrentCatalogInput(repositoryRoot);
  assertCatalogCompilerAuthorityExact(persisted, observed);
  const input = currentCatalogInput(repositoryRoot);
  const artifacts = generateCatalogWithImpact(input, persisted.priorCatalogImpact);
  const errors = verifyCatalogLedger(repositoryRoot, artifacts);
  if (errors.length > 0) throw new TypeError(`catalog semantic regeneration is not exact: ${errors.join(",")}`);
  const observedGeneratorLeaf = observed.compilerClosures.find(value =>
    value.modulePath === CATALOG_SEMANTIC_GENERATOR_ENTRYPOINT.modulePath
    && value.exportName === CATALOG_SEMANTIC_GENERATOR_ENTRYPOINT.exportName
  );
  if (observedGeneratorLeaf === undefined) throw new TypeError("catalog semantic generator observation is missing");
  if (artifacts.ledger.generatorRecords.length !== 1) throw new TypeError("catalog semantic ledger must contain one generator record");
  return createCatalogGenerationVerificationReceiptV1({
    candidateDenominatorRoot: catalogCandidateDenominatorRoot({
      scannedFileSetRoot: observed.scannedFileSetRoot as Hash,
      compilerGraphRoot: observed.compilerGraphRoot as Hash,
    }),
    indexDenominatorRoot: catalogIndexDenominatorRoot({
      compilerEntrypoints: currentCatalogCompilerEntrypointSpecs(),
      capabilityProposals: currentCatalogCapabilityProposalSpecs(),
    }),
    scannedFileSetRoot: observed.scannedFileSetRoot as Hash,
    compilerGraphRoot: observed.compilerGraphRoot as Hash,
    observedCompilerFactsRoot: catalogCompilerFactsRoot(observed.compilerClosures),
    persistedCompilerFactsRoot: catalogCompilerFactsRoot(persisted.compilerClosures),
    observedProposedCapabilitySetRoot: observed.proposedCapabilitySet.root,
    persistedProposedCapabilitySetRoot: persisted.proposedCapabilitySet.root,
    observerImplementation: observed.observerImplementation,
    verifierImplementation: observed.verifierImplementation,
    observedGeneratorLeaf,
    ledgerGeneratorRecord: artifacts.ledger.generatorRecords[0]!,
    semanticLedgerHash: artifacts.ledger.ledgerHash,
    semanticOutputRoot: artifacts.outputRoot,
    impactSnapshotRoot: artifacts.impactSnapshot.snapshotRoot,
    impactReceiptRoot: artifacts.impactReceipt.receiptRoot,
  });
}
