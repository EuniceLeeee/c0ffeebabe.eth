import assert from "node:assert/strict";
import test from "node:test";
import { BALANCER_FLASH_INSTANCE_CONTRACT, BALANCER_FLASH_MANIFEST } from "../src/manifest.ts";
import { BALANCER_FLASH_DEFINITION } from "../src/family-definition.ts";

test("Balancer Funding declares optional instances backed by a singleton complete snapshot", () => {
  assert.equal(BALANCER_FLASH_MANIFEST.category, "funding");
  assert.equal(BALANCER_FLASH_INSTANCE_CONTRACT.instanceRequirement, "optional");
  assert.equal(BALANCER_FLASH_INSTANCE_CONTRACT.currentSourceAuthority, "singleton-complete-snapshot");
  assert.equal(BALANCER_FLASH_INSTANCE_CONTRACT.strictReleaseDenominator, "singleton-complete-snapshot");
  assert.ok(BALANCER_FLASH_DEFINITION.manifest.sourcePlans.some(item => item.completeness === "complete-snapshot"));
  assert.ok(BALANCER_FLASH_DEFINITION.acceptanceDeclarations.some(item => item.factContractId === "family.balancer-flash.optional-instance-partition"));
});
