import assert from "node:assert/strict";
import {
  buildMigrationCleanupReceipt,
  productionImportClosure,
  scanLegacySymbols,
  sourceClosureHash,
} from "../migration-cleanup-receipt.js";

async function main(): Promise<void> {
  const receipt = buildMigrationCleanupReceipt({
    baselineDsCommit: "a".repeat(40),
    preCleanupTargetCommit: "b".repeat(40),
    cleanupCommit: "c".repeat(40),
    batchParityReceiptHashes: [],
    finalFamilyResultMatrixHash: "d".repeat(64),
    nonPassFamilyIds: [],
    cutoverEvidenceRef: "ref",
    activeCatalogHash: "e".repeat(64),
    unifiedSchedulerCoverageHash: "f".repeat(64),
    finalSimulationReservedCapacityReceiptHash: "g".repeat(64),
    staleGenerationFenceReceiptHash: "h".repeat(64),
    perInstanceFailureIsolationReceiptHash: "i".repeat(64),
    poolTopologySpikeReceiptHashes: [],
    cleanColdSemanticHash: "j".repeat(64),
    cleanWarmSemanticHash: "k".repeat(64),
    representativeSixStepReceiptHashes: [],
    systemicLiveCutoverReceiptHashes: [],
    rollbackArtifactRef: "rollback-ref",
  });
  assert.equal(receipt.schemaVersion, "migration-cleanup-receipt-v1");
  // Machine-derived from the actual production-registry source (F8: the
  // strict-catalog registry projection is the sole production authority).
  assert.equal(
    receipt.productionCatalogKind,
    "strict-catalog-registry-projection-v1",
  );
  assert.equal(receipt.productionRuntimeSourceScan, false);
  assert.equal(receipt.oldCacheAccepted, false);
  assert.equal(receipt.oldFlagsAccepted, false);
  assert(Array.isArray(receipt.traceWindowAbsentFamilyIds));
  assert.equal(receipt.traceWindowAbsentFamilyIds.length, 3);
  assert.match(String(receipt.sourceClosureHash), /^[0-9a-f]{64}$/);
  // The structural scan is deterministic: re-running yields the same hash.
  assert.equal(String(receipt.sourceClosureHash), sourceClosureHash());
  // Verdict is honest: it reflects the actual legacy symbols in the closure.
  const legacy = scanLegacySymbols();
  assert.equal(legacy.size >= 0, true);
  // F8: the legacy family-wide schema APIs are gone, but the remaining
  // legacy runtime call sites are still present in the central closure and
  // keep the receipt verdict honest-fail until F9 removes them.
  assert.equal(legacy.size, 6);
  // Transitive import-closure proof (§0.1): every relative import from
  // main.ts resolves; the report is deterministic.
  const closure = productionImportClosure();
  assert.equal(closure.rootFile, "listener/src/searcher/main.ts");
  assert(closure.fileCount > 100);
  assert.equal(closure.unresolvedImports.length, 0);
  assert.match(String(closure.closureHash), /^[0-9a-f]{64}$/);
  assert.equal(closure.closureHash, productionImportClosure().closureHash);
  // F8: the strict projection removed the legacy authority list, but the
  // remaining legacy runtime call sites (solver quote/plan build, revm
  // prepared quote, victim overlay, credit sizing, pending evidence) still
  // execute against the fail-closed projection. The verdict must stay fail
  // until F9 migrates or removes every one of these call sites (§18.3).
  assert.equal(closure.legacySymbolHitsPresent, true);
  assert(closure.legacySymbolHits.some(
    (hit) => hit.symbol === "legacy quoteExact call-site",
  ));
  assert.equal(closure.centralFamilyLiteralBranchesPresent, false);
  assert.equal(receipt.importClosureLegacySymbolsPresent, true);
  assert.equal(receipt.importClosureFileCount, closure.fileCount);
  assert.equal(receipt.importClosureHash, closure.closureHash);
  assert.equal(receipt.verdict, "fail");
  console.log("migration cleanup receipt generator PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});