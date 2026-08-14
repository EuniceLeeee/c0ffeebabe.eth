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
  // Machine-derived from the actual production-registry source.
  assert.equal(
    receipt.productionCatalogKind,
    "frozen-legacy-route-authority-v1",
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
  // Central-path legacy scan is clean: all manual schema revisions and the
  // legacy family-wide schema APIs are gone from the central closure.
  assert.equal(legacy.size, 0);
  // Transitive import-closure proof (§0.1): every relative import from
  // main.ts resolves; the report is deterministic.
  const closure = productionImportClosure();
  assert.equal(closure.rootFile, "listener/src/searcher/main.ts");
  assert(closure.fileCount > 100);
  assert.equal(closure.unresolvedImports.length, 0);
  assert.match(String(closure.closureHash), /^[0-9a-f]{64}$/);
  assert.equal(closure.closureHash, productionImportClosure().closureHash);
  // Central authority is still the frozen legacy route baseline, so the
  // closure honestly reports the remaining migration item: the legacy
  // production registry list. The verdict must be fail until it is removed
  // (§18.3). The blind T1 baseline vocabulary has moved into the sealed
  // generated artifact, so the closure has no literal per-family branches.
  assert.equal(closure.legacySymbolHitsPresent, true);
  assert(closure.legacySymbolHits.some(
    (hit) => hit.symbol === "LEGACY_PRODUCTION_ADAPTER_FAMILIES",
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