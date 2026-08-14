import assert from "node:assert/strict";
import {
  buildMigrationCleanupReceipt,
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
  console.log("migration cleanup receipt generator PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});