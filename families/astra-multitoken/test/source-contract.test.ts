import assert from "node:assert/strict";
import test from "node:test";
import { ASTRA_MANIFEST, ASTRA_SOURCE_CONTRACT } from "../src/manifest.ts";
import { ASTRA_DEFINITION } from "../src/family-definition.ts";

test("Astra keeps recent evidence nomination-only and binds strict release to complete Change history", () => {
  assert.equal(ASTRA_MANIFEST.category, "protocol");
  assert.equal(ASTRA_SOURCE_CONTRACT.recentBehaviorWindowBlocks, 50);
  assert.equal(ASTRA_SOURCE_CONTRACT.recentBehaviorContributesOmissionAuthority, false);
  assert.equal(ASTRA_SOURCE_CONTRACT.strictReleaseDenominator, "complete-change-event-history-plus-reverse-identity");
  assert.ok(ASTRA_DEFINITION.manifest.sourcePlans.some(plan => plan.completeness === "contiguous-history" && plan.historyStartBlock === "0"));
  assert.ok(ASTRA_DEFINITION.acceptanceDeclarations.some(item => item.factContractId === "family.astra-multitoken.source-completeness"));
});
