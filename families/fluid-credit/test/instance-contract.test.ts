import assert from "node:assert/strict";
import test from "node:test";
import { FLUID_CREDIT_INSTANCE_CONTRACT, FLUID_CREDIT_MANIFEST } from "../src/manifest.ts";
import { FLUID_CREDIT_DEFINITION } from "../src/family-definition.ts";

test("Fluid Credit declares optional instances and a fail-closed zero-instance contract", () => {
  assert.equal(FLUID_CREDIT_MANIFEST.category, "credit");
  assert.equal(FLUID_CREDIT_INSTANCE_CONTRACT.instanceRequirement, "optional");
  assert.equal(FLUID_CREDIT_INSTANCE_CONTRACT.strictReleaseDenominator, "factory-complete-snapshot");
  assert.ok(FLUID_CREDIT_DEFINITION.acceptanceDeclarations.some(item => item.factContractId === "family.fluid-credit.optional-instance-partition"));
});
