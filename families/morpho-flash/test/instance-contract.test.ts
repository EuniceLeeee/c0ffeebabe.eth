import assert from "node:assert/strict";
import test from "node:test";
import { MORPHO_FLASH_INSTANCE_CONTRACT, MORPHO_FLASH_MANIFEST } from "../src/manifest.ts";
import { MORPHO_FLASH_DEFINITION } from "../src/family-definition.ts";

test("Morpho Funding declares optional instances backed by a singleton complete snapshot", () => {
  assert.equal(MORPHO_FLASH_MANIFEST.category, "funding");
  assert.equal(MORPHO_FLASH_INSTANCE_CONTRACT.zeroInstanceMeaning, "valid-only-with-complete-source-partition");
  assert.equal(MORPHO_FLASH_INSTANCE_CONTRACT.currentSourceAuthority, "singleton-complete-snapshot");
  assert.equal(MORPHO_FLASH_INSTANCE_CONTRACT.strictReleaseDenominator, "singleton-complete-snapshot");
  assert.ok(MORPHO_FLASH_DEFINITION.manifest.sourcePlans.some(item => item.completeness === "complete-snapshot"));
  assert.ok(MORPHO_FLASH_DEFINITION.acceptanceDeclarations.some(item => item.factContractId === "family.morpho-flash.optional-instance-partition"));
});
