import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { renderDeclarativeProductionEntry, syncDeclarativeProductionEntries } from "../build-declarative-production.js";
import definition from "../venues/selector-native/selector-ba087652-family/selector-ba087652.json";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const definitionFile = resolve(root, "src/searcher/venues/selector-native/selector-ba087652-family/selector-ba087652.json");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("selector production is one standalone v2 JSON and one public module issuer", async () => {
  const rendered = renderDeclarativeProductionEntry({ rootDirectory: root, definitionFile, document: definition });
  assert.equal(await readFile(rendered.entryFile, "utf8"), rendered.source);
  assert.equal(rendered.format, "selector-family/v2");
  assert.match(rendered.familyId, /^execution:0xba087652:abi-[0-9a-f]{64}$/);
  assert.deepEqual(rendered.childFiles, []);
  assert.deepEqual(rendered.ownedActionAdapterIds, [`${rendered.familyId}:call`]);
  assert.match(rendered.source, /export const selectorFamilyModule = defineSelectorFamilyModule\(definition\);/);
  assert.doesNotMatch(rendered.source, /export const (?:plugin|activation|productionFamilyModule)\b|defineProtocolFamily|compileSelectorNativeExecutionFamily/);
  assert.doesNotMatch(rendered.source, /protocols\/|bindingPlugin|compileDeclarative|FamilyTypes|child[0-9]/);
  assert.equal(renderDeclarativeProductionEntry({ rootDirectory: root, definitionFile,
    document: Object.fromEntries(Object.entries(definition).reverse()) }).source, rendered.source);
  const implicitV2 = clone(definition) as any; delete implicitV2.format;
  assert.equal(renderDeclarativeProductionEntry({ rootDirectory: root, definitionFile, document: implicitV2 }).source, rendered.source);
});

test("the active authoring boundary rejects retired schemas and injected implementation fields", () => {
  for (const document of [
    { version: 2, format: "protocol-json-v2", variantFiles: [] },
    { format: "selector-native-execution/v1", selector: definition.selector },
    { format: "selector-native-funding/v1", selector: definition.selector },
    { format: "selector-execution-declaration-v1", selector: definition.selector },
    { format: "selector-execution-family-v1", selector: definition.selector, entries: [] },
  ]) assert.throws(() => renderDeclarativeProductionEntry({ rootDirectory: root, definitionFile, document }), /retired Family JSON format/);
  assert.throws(() => renderDeclarativeProductionEntry({ rootDirectory: root, definitionFile,
    document: { version: 1, scope: { family: "protocol:old" } } }));
  for (const mutate of [
    (d: any) => { d.selector = "0x00000000"; },
    (d: any) => { d.domain = "credit"; },
    (d: any) => { d.bindingPlugin = { source: "./old.ts" }; },
    (d: any) => { d.activation.enabled = "yes"; },
    (d: any) => { d.activation.envKey = "OTHER"; },
    (d: any) => { d.activation.hidden = true; },
  ]) {
    const raw = clone(definition); mutate(raw);
    assert.throws(() => renderDeclarativeProductionEntry({ rootDirectory: root, definitionFile, document: raw }));
  }
  assert.throws(() => renderDeclarativeProductionEntry({ rootDirectory: root,
    definitionFile: resolve(root, "../outside.json"), document: definition }), /escapes/);
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(resolve(tmpdir(), "selector-production-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, "src/searcher/venues/selector-native/selector-ba087652-family/selector-ba087652.json");
  const production = resolve(directory, "src/searcher/venues/production-families");
  await mkdir(dirname(path), { recursive: true });
  await mkdir(production, { recursive: true });
  await writeFile(path, JSON.stringify(definition));
  await writeFile(resolve(directory, "src/searcher/venues/selector-family-module.ts"), "export const issuer = 1;\n");
  return { directory, path, production, options: { rootDirectory: directory } };
}

test("native generation is reproducible and check mode rejects stale content", async t => {
  const f = await fixture(t);
  const entries = await syncDeclarativeProductionEntries({ ...f.options, mode: "write" });
  assert.equal(entries.size, 1);
  await syncDeclarativeProductionEntries({ ...f.options, mode: "check" });
  const entry = [...entries.values()][0]!;
  await writeFile(entry.entryFile, entry.source.replace("defineSelectorFamilyModule(definition);", "defineSelectorFamilyModule({});"));
  await assert.rejects(syncDeclarativeProductionEntries({ ...f.options, mode: "check" }), /stale/);
  await syncDeclarativeProductionEntries({ ...f.options, mode: "write" });
  assert.equal(await readFile(entry.entryFile, "utf8"), entry.source);
});

test("unregistered or handwritten old entries are rejected instead of enabled", async t => {
  const f = await fixture(t);
  await writeFile(resolve(f.production, "old.production.ts"), "export const plugin = {};\n");
  await assert.rejects(syncDeclarativeProductionEntries({ ...f.options, mode: "write" }), /retired\/unregistered/);
  await rm(resolve(f.production, "old.production.ts"));
  await writeFile(resolve(f.production, "selector-ba087652.production.ts"), "export const plugin = {};\n");
  await assert.rejects(syncDeclarativeProductionEntries({ ...f.options, mode: "write" }), /retired production source/);
});

test("definition symlinks and missing compiler sources fail before production writes", async t => {
  const f = await fixture(t);
  await rm(f.path);
  await symlink(definitionFile, f.path);
  await assert.rejects(syncDeclarativeProductionEntries({ ...f.options, mode: "write" }), /regular files/);
  await rm(f.path); await writeFile(f.path, JSON.stringify(definition));
  await rm(resolve(f.directory, "src/searcher/venues/selector-family-module.ts"));
  await assert.rejects(syncDeclarativeProductionEntries({ ...f.options, mode: "write" }));
});
