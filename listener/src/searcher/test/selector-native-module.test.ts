import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FunctionFragment } from "ethers";
import { definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { assertSelectorFamilyModule, defineSelectorFamilyModule } from "../venues/selector-family-module.js";
import { normalizeSelectorFamilyDefinition, selectorFamilySemanticHash } from "../venues/selector-family-definition.js";
import { loadStrictProductionFamilyPlugins } from "../venues/production-families/loader.js";

function definition(name = "convertNative", enabled = true) {
  const signature = `function ${name}(address input,address output,uint256 amount,address receiver) returns(uint256)`;
  return { selector: FunctionFragment.from(signature).selector, signature, domain: "protocol",
    parameters: ["tokenIn", "tokenOut", "amountIn", "recipient"].map((role, index) => ({ path: [index], role })),
    payment: { kind: "approval" }, activation: { enabled, envKey: `SEARCHER_FAMILY_MODULE_${name.toUpperCase()}_ENABLED` } };
}

test("the public module accepts only v2 JSON and seals normalized semantic data", () => {
  const raw = definition(), module = defineSelectorFamilyModule(raw);
  assertSelectorFamilyModule(module); assert.equal(module.contract, "selector-family/v2");
  assert.equal(module.semanticDefinitionHash, selectorFamilySemanticHash(raw));
  assert.equal(module.plugin.manifest.domain, "protocol");
  const annotated = defineSelectorFamilyModule({ ...raw, meta: { identity: "optional protocol name" },
    parameters: raw.parameters, payment: raw.payment });
  assert.equal(module.semanticDefinitionHash, annotated.semanticDefinitionHash);
  assert.deepEqual(definedFamilyPluginContractSummary(module.plugin), definedFamilyPluginContractSummary(annotated.plugin));
  assert(!Object.hasOwn(module.definition, "meta"));
  assert(Object.isFrozen(module) && Object.isFrozen(module.definition));
  assert.throws(() => assertSelectorFamilyModule({ ...module }), /issued by defineSelectorFamilyModule/);
  for (const format of ["selector-native-execution/v1", "selector-native-funding/v1", "protocol-json/v1"])
    assert.throws(() => defineSelectorFamilyModule({ ...raw, format }), /retired Family JSON format/);
  assert.throws(() => defineSelectorFamilyModule(module.plugin), /lossless JSON data/);
  let invoked = false;
  assert.throws(() => defineSelectorFamilyModule({ ...raw, get format() { invoked = true; return "selector-family/v2"; } }), /module data property/);
  assert.equal(invoked, false, "authoring validation must not execute accessors before domain dispatch");
  assert.deepEqual(normalizeSelectorFamilyDefinition(raw), normalizeSelectorFamilyDefinition({ ...raw, format: "selector-family/v2" }));
});

test("production loading preserves activation, duplication and infra ownership while rejecting old TS exports", async t => {
  const directory = await mkdtemp(join(tmpdir(), "selector-v2-loader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([writeFile(join(directory, "a.production.ts"), ""), writeFile(join(directory, "b.production.ts"), "")]);
  const first = defineSelectorFamilyModule(definition("convertNativeA"));
  const second = defineSelectorFamilyModule(definition("convertNativeB"));
  const load = (a: unknown = first, b: unknown = second, extra: Record<string, unknown> = {}) => loadStrictProductionFamilyPlugins({
    sourceDirectory: directory, importEntry: async file => ({ selectorFamilyModule: file.startsWith("a") ? a : b }), ...extra,
  });
  const loaded = await load();
  assert.deepEqual(loaded.issues, []); assert.equal(loaded.plugins.length, 2); assert.deepEqual(loaded.modules, []);
  assert(loaded.plugins.every(item => item.semanticDefinitionHash === (item.sourceFile.startsWith("a") ? first : second).semanticDefinitionHash));
  const disabled = await load(first, defineSelectorFamilyModule(definition("convertNativeB", false)));
  assert.deepEqual(disabled.issues, []); assert.equal(disabled.plugins.length, 1); assert.equal(disabled.disabledPlugins.length, 1);
  assert.equal(disabled.disabledPlugins[0]!.definitionBoundaryHash, loaded.plugins[1]!.definitionBoundaryHash);
  assert.notEqual(disabled.scanSha256, loaded.scanSha256);
  const duplicate = await load(first, first);
  assert.equal(duplicate.issues.length, 1); assert.equal(duplicate.issues[0]!.code, "family_registration_conflict");
  const infra = await load(first, second, { sharedInfraActionAdapterIds: [first.plugin.actionAdapters[0]!.id] });
  assert.equal(infra.issues.length, 1); assert.equal(infra.issues[0]!.code, "family_registration_conflict");
  assert.deepEqual((await load(first, second, { sharedInfraActionAdapterIds: ["independent-shared-infra"] })).issues, []);
  for (const namespace of [{ plugin: first.plugin }, { productionFamilyModule: first },
    { selectorFamilyModule: first, plugin: first.plugin }, { selectorFamilyModule: { ...first } },
    { selectorFamilyModule: first, activation: first.activation }]) {
    const rejected = await loadStrictProductionFamilyPlugins({ sourceDirectory: directory, importEntry: async () => namespace });
    assert.equal(rejected.plugins.length + rejected.disabledPlugins.length, 0);
    assert(rejected.issues.every(issue => issue.code === "invalid_module_contract"));
  }
  const timeout = await loadStrictProductionFamilyPlugins({ sourceDirectory: directory, importTimeoutMs: 5,
    importEntry: () => new Promise(() => {}) });
  assert(timeout.issues.every(issue => issue.code === "module_import_timeout"));
});
