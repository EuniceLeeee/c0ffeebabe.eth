import assert from "node:assert/strict";
import test from "node:test";
import { plugin } from "../../../production-families/ondo-usdy.production.js";
import { definedFamilyPluginContractSummary } from "../../../adapter-family-plugin.js";
test("ondo usdy family definition is valid", () => {
  definedFamilyPluginContractSummary(plugin);
  assert.equal(plugin.manifest.familyId, "protocol:ondo-usdy-instant-redeem");
  assert.deepEqual([...plugin.manifest.ownedActionAdapterIds], ["ondo-usdy-redeem"]);
  assert.deepEqual(plugin.actionAdapters.map((a) => a.id), ["ondo-usdy-redeem"]);
});
