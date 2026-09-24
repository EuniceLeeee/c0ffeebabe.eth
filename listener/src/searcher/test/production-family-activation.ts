import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertFamilyActivationEnvironment, defineFamilyActivation } from "../venues/production-families/activation.js";
import { capabilityManifestHash } from "../venues/family-capability-catalog.js";
import { createFamilyCapabilityShadowArtifact, type FamilyCapabilityShadowArtifact } from "../venues/family-capability-shadow.js";

interface Snapshot {
  activations: { familyId: string; sourceFile: string; envKey: string; defaultEnabled: boolean; enabled: boolean }[];
  active: string[];
  disabled: string[];
  actionsByFamily: Record<string, string[]>;
  catalog: string[];
  actions: string[];
  registry: string[];
  manifestFamilies: string[];
  manifestHash: string;
  artifactHash: string;
}

if (process.argv.includes("--snapshot")) {
  const composition = await import("../venues/production-family-composition.js");
  await import("../../adapters/index.js");
  const { listAll } = await import("../../adapters/registry.js");
  const load = composition.PRODUCTION_STRICT_SHADOW_FAMILY_LOAD;
  const artifact = JSON.parse(readFileSync(new URL("../generated/family-capability-shadow.generated.json", import.meta.url), "utf8")) as FamilyCapabilityShadowArtifact;
  const manifest = composition.PRODUCTION_STRICT_SHADOW_GENERATED_CAPABILITY_MANIFEST;
  assert.equal(manifest.manifestHash, capabilityManifestHash(manifest.entries));
  if (process.argv.includes("--artifact-negatives")) {
    const first = load.plugins[0]!;
    const disabledLoad = { ...load, plugins: load.plugins.slice(1), disabledPlugins: [
      { ...first, activation: defineFamilyActivation({ enabled: false, envKey: first.activation.envKey! }, {}) },
    ] };
    const good = composition.composeProductionFamilyActivation({ load: disabledLoad, artifact });
    assert.equal(good.catalog.listAll().length, load.plugins.length - 1);
    assert.equal(good.fullGeneratedManifest.entries.length, artifact.exact.length);
    assert(good.generatedManifest.entries.every(entry => entry.familyId !== first.familyId));
    // Rebuild hashes after dropping data: the failure must be coverage, not only a stale hash.
    for (const exact of [artifact.exact.filter(record => record.identity.familyId !== first.familyId),
      artifact.exact.filter(record => !(record.identity.familyId === first.familyId && record.identity.capability === "identity"))]) {
      const incomplete = createFamilyCapabilityShadowArtifact({ exact, legacy: [], issues: [] });
      assert.throws(() => composition.composeProductionFamilyActivation({ load: disabledLoad, artifact: incomplete }),
        /missing exact capabilities/, "disabled Family still requires all artifact capabilities");
    }
    assert.throws(() => composition.composeProductionFamilyActivation({ load: { ...load, plugins: load.plugins.slice(1) }, artifact }),
      /unselected exact Family/, "an omitted module is not a declared disable");
    assert.throws(() => composition.composeProductionFamilyActivation({ load: disabledLoad,
      artifact: { ...artifact, artifactHash: "0".repeat(64) } }), /hash is stale or invalid/);
    assert.throws(() => composition.composeProductionFamilyActivation({ load: disabledLoad,
      artifact: { ...artifact, complete: false } }), /complete capability artifact/);
    assert.throws(() => composition.composeProductionFamilyActivation({ load: disabledLoad,
      artifact: { ...artifact, legacy: [{}] } }), /legacy=0/);
    assert.throws(() => composition.composeProductionFamilyActivation({ load: disabledLoad,
      artifact: { ...artifact, issues: [{}] } }), /issues=0/);
    assert.throws(() => composition.composeProductionFamilyActivation({ load: { ...disabledLoad,
      disabledPlugins: [{ ...disabledLoad.disabledPlugins[0]!, definitionBoundaryHash: "0".repeat(64) }] }, artifact }),
      /definition boundary hash/, "disabled modules still undergo full catalog validation");
  }
  console.log(JSON.stringify({
    activations: composition.PRODUCTION_FAMILY_ACTIVATIONS,
    active: load.plugins.map(entry => entry.familyId),
    disabled: load.disabledPlugins.map(entry => entry.familyId),
    actionsByFamily: Object.fromEntries([...load.plugins, ...load.disabledPlugins]
      .map(entry => [entry.familyId, entry.actionAdapters.map(action => action.id)])),
    catalog: composition.PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.listAll().map(entry => entry.plugin.manifest.familyId),
    actions: composition.PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS.map(action => action.id),
    registry: listAll().map(action => action.id),
    manifestFamilies: [...new Set(manifest.entries.map(entry => entry.familyId))],
    manifestHash: manifest.manifestHash,
    artifactHash: artifact.artifactHash,
  }));
} else {
  const envKey = "SEARCHER_FAMILY_ACTIVATION_TEST_ENABLED";
  for (const defaultEnabled of [false, true]) {
    for (const value of [undefined, "0", "1"]) {
      const activation = defineFamilyActivation({ enabled: defaultEnabled, envKey }, { [envKey]: value });
      assert.deepEqual(activation, { enabled: value === undefined ? defaultEnabled : value === "1", defaultEnabled, envKey });
      assert(Object.isFrozen(activation));
      assert.doesNotThrow(() => assertFamilyActivationEnvironment([activation], { [envKey]: value }));
    }
  }
  for (const value of ["", "true", "false", "2", " 1", "0 ", "on", "off"]) {
    assert.throws(() => defineFamilyActivation({ enabled: true, envKey }, { [envKey]: value }), /exactly 0 or 1/);
  }
  assert.throws(() => defineFamilyActivation({ enabled: "true" as never, envKey }, {}), /boolean default/);
  assert.throws(() => defineFamilyActivation({ enabled: true, envKey: "UNSCOPED" }, {}), /SEARCHER_FAMILY/);
  const initiallyOn = defineFamilyActivation({ enabled: true, envKey }, {});
  const initiallyOff = defineFamilyActivation({ enabled: true, envKey }, { [envKey]: "0" });
  assert.throws(() => assertFamilyActivationEnvironment([initiallyOn], { [envKey]: "0" }),
    /plugin activation fixed at startup; set env before starting or edit plugin default/);
  assert.throws(() => assertFamilyActivationEnvironment([initiallyOff], {}),
    /plugin activation fixed at startup/, "unsetting an override must not silently change startup policy");
  assert.throws(() => assertFamilyActivationEnvironment([initiallyOn], { [envKey]: "false" }),
    /must be exactly 0 or 1/, "late environment values are validated as strictly as initial ones");
  assert.doesNotThrow(() => assertFamilyActivationEnvironment([initiallyOn], { [envKey]: "1" }));
  assert.doesNotThrow(() => assertFamilyActivationEnvironment([initiallyOff], { [envKey]: "0" }));
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SEARCHER_FAMILY_")));
  const run = (environment: Record<string, string>, extra: string[] = []) => spawnSync(process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--snapshot", ...extra],
    { env: { ...cleanEnv, ...environment }, encoding: "utf8", timeout: 30_000 });
  const snapshot = (environment: Record<string, string> = {}, extra: string[] = []): Snapshot => {
    const result = run(environment, extra);
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return JSON.parse(result.stdout) as Snapshot;
  };
  const defaults = snapshot();
  assert(defaults.activations.every(entry => entry.enabled === entry.defaultEnabled),
    "each entry owns its default; tests must not require every default to be enabled");
  assert.deepEqual([...defaults.active].sort(), defaults.activations.filter(entry => entry.defaultEnabled)
    .map(entry => entry.familyId).sort());
  assert.deepEqual([...defaults.disabled].sort(), defaults.activations.filter(entry => !entry.defaultEnabled)
    .map(entry => entry.familyId).sort());
  const allEnabled = Object.fromEntries(defaults.activations.map(entry => [entry.envKey, "1"]));
  const baseline = snapshot(allEnabled, ["--artifact-negatives"]);
  assert(baseline.activations.length > 0);
  assert(baseline.activations.every(entry => entry.enabled));
  assert.deepEqual(baseline.disabled, []);
  assert.deepEqual([...baseline.catalog].sort(), [...baseline.active].sort());
  assert.deepEqual([...baseline.registry].sort(), [...baseline.actions].sort());
  for (const activation of baseline.activations) {
    const disabled = snapshot({ ...allEnabled, [activation.envKey]: "0" });
    assert.deepEqual(disabled.disabled, [activation.familyId]);
    for (const ids of [disabled.active, disabled.catalog, disabled.manifestFamilies]) {
      assert(!ids.includes(activation.familyId));
      assert.equal(ids.length, baseline.active.length - 1);
    }
    for (const actionId of baseline.actionsByFamily[activation.familyId]!) {
      assert(!disabled.actions.includes(actionId));
      assert(!disabled.registry.includes(actionId));
    }
    assert.deepEqual([...disabled.registry].sort(), [...disabled.actions].sort());
    assert.equal(disabled.artifactHash, baseline.artifactHash, "activation never changes capability artifact semantics");
    assert.notEqual(disabled.manifestHash, baseline.manifestHash);
  }
  const restored = snapshot(allEnabled);
  assert.deepEqual(restored, baseline, "re-enabling restores the full catalog/action/manifest set");
  const none = snapshot(Object.fromEntries(baseline.activations.map(entry => [entry.envKey, "0"])));
  assert.deepEqual(none.active, []);
  assert.deepEqual(none.catalog, []);
  assert.deepEqual(none.manifestFamilies, []);
  assert.equal(none.disabled.length, baseline.active.length);
  const invalid = run({ [baseline.activations[0]!.envKey]: "false" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /must be exactly 0 or 1/);
  console.log(`production-family-activation PASS (${baseline.active.length} independent entry switches; registry closure; full artifact fail-closed)`);
}
