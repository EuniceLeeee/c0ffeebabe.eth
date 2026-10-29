import assert from "node:assert/strict";
import test from "node:test";
import { plugin } from "../../../production-families/mellow-queue.production.js";
import { definedFamilyPluginContractSummary } from "../../../adapter-family-plugin.js";

test("mellow queue family definition is valid", () => {
  definedFamilyPluginContractSummary(plugin);
  assert.equal(plugin.manifest.familyId, "protocol:mellow-queue");
  assert.equal(plugin.manifest.domain, "protocol");
  assert.deepEqual(
    [...plugin.manifest.ownedActionAdapterIds].sort(),
    ["mellow-deposit", "mellow-redeem"],
  );
  assert.deepEqual(
    plugin.actionAdapters.map((action) => action.id).sort(),
    ["mellow-deposit", "mellow-redeem"],
  );
  assert.deepEqual(
    [...plugin.manifest.edgeAdapterIds].sort(),
    ["mellow-deposit", "mellow-redeem"],
  );
  assert.deepEqual([...plugin.manifest.supportedLineages], ["mellow-queue:v1"]);
});
