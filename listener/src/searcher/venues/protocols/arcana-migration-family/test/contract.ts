import assert from "node:assert/strict";
import test from "node:test";
import { plugin } from "../../../production-families/arcana-migration.production.js";
import { definedFamilyPluginContractSummary } from "../../../adapter-family-plugin.js";

test("arcana migration family definition is valid", () => {
  definedFamilyPluginContractSummary(plugin);
  assert.equal(plugin.manifest.familyId, "protocol:arcana-migration");
  assert.equal(plugin.manifest.domain, "protocol");
  assert.deepEqual([...plugin.manifest.ownedActionAdapterIds], ["arcana-migration"]);
  assert.deepEqual(plugin.actionAdapters.map((action) => action.id), ["arcana-migration"]);
  assert.deepEqual([...plugin.manifest.supportedLineages], ["arcana-migration:v1"]);
});
