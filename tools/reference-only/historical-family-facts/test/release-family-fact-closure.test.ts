import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  auditReleaseFamilyHistoricalFactsV1,
  RELEASE_FAMILY_HISTORICAL_LOCATORS_V1,
} from "../src/release-family-fact-closure.ts";

const store = "/Users/eunice/.cache/aloha/historical-family-facts";
const hasReleaseSpecimens = RELEASE_FAMILY_HISTORICAL_LOCATORS_V1.every((item) =>
  existsSync(`${store}/manifests/${item.manifestRoot.slice(2)}.json`)
);

test("four release Family locators bind immutable historical facts to current generated search aliases without claiming calibration", { skip: !hasReleaseSpecimens }, () => {
  const report = auditReleaseFamilyHistoricalFactsV1(store);
  assert.equal(report.advisoryOnly, true);
  assert.equal(report.networkAcquisitionUsed, false);
  assert.equal(report.authorityClaim, "none");
  assert.equal(report.qualificationClaim, "none");
  assert.deepEqual(report.rows.map((row) => row.familyId), [
    "curve-underlying",
    "dodo-v2",
    "fluid-dex",
    "univ2-standard",
  ]);
  assert.deepEqual(report.rows.map((row) => row.status), ["partial", "partial", "partial", "partial"]);
  for (const row of report.rows) {
    assert.equal(row.immutableBundleObserved, true);
    assert.equal(row.historicalObservation.status, "observed");
    assert.ok(row.historicalObservation.selectorEvidenceRoots.length > 0);
    assert.ok(row.generatedSearchBinding !== null);
    assert.equal(row.executionPrefixManifestRoots.length, 0);
    assert.equal(row.currentSourceManifestRoots.length, 0);
    assert.equal(row.candidateGeneratedManifestRoots.length, 0);
    assert.deepEqual(row.factContract, {
      historicalOracle: "observed",
      currentGeneratedBinding: "observed",
      currentSourceReplay: "missing",
      executionPrefix: "missing",
      candidateGeneratedExecution: "missing",
      currentGeneratedEffectObservation: "missing",
      effectsEquality: "missing",
    });
    assert.ok(row.exactGaps.includes("reverse-verified-pool-identity"));
    assert.ok(row.exactGaps.includes("historical-execution-prefix"));
    assert.ok(row.exactGaps.includes("generated-adapter-current-source-transcript"));
    assert.ok(row.exactGaps.includes("generated-adapter-same-case-run"));
    assert.ok(row.exactGaps.includes("revm-historical-effects"));
    assert.ok(row.exactGaps.includes("effects-equality-comparison"));
    assert.notEqual(row.status, "pass");
  }
});

test("the old-implementation UniV2 locator is accepted only after immutable CAS confirmation and remains callback-partial", { skip: !hasReleaseSpecimens }, () => {
  const row = auditReleaseFamilyHistoricalFactsV1(store).rows.find((item) => item.familyId === "univ2-standard")!;
  assert.equal(row.locator.locatorOrigin, "old-impl-read-only-seed-confirmed-by-immutable-cas");
  assert.equal(row.locator.txHash, "0x0ffa9acf81b5631ac91d1c141adbbe884ad0bdd991143bd13cd10eacc2fc8454");
  assert.equal(row.historicalObservation.historicalCaseIds.length, 3);
  assert.deepEqual(row.historicalObservation.observedDirections, ["one-for-zero", "zero-for-one"]);
  assert.deepEqual(row.historicalObservation.observedSettlementModes, ["callback"]);
  assert.deepEqual(row.historicalObservation.currentShapeComparisonStatuses, ["unresolved", "unresolved", "unresolved"]);
  assert.deepEqual(row.historicalObservation.currentShapeComparisonReasonCodes, ["variant-not-covered"]);
  assert.ok(row.exactGaps.includes("callback-variant-current-action-coverage"));
  assert.equal(row.status, "partial");
});
