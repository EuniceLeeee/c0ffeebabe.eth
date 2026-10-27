import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderDeclarativeProductionEntry, syncDeclarativeProductionEntries } from "../build-declarative-production.js";
import { buildFamilyCapabilityShadowArtifact } from "../build-family-capability-manifest.js";
import definition from "../venues/protocols/erc4626-family/erc4626.json";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const definitionFile = resolve(root, "src/searcher/venues/protocols/erc4626-family/erc4626.json");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

test("ERC4626 production registration is reproducible from its JSON, with direct semantic roots", async () => {
  const rendered = renderDeclarativeProductionEntry({ rootDirectory: root, definitionFile, document: definition });
  assert.equal(await readFile(rendered.entryFile, "utf8"), rendered.source);
  assert.match(rendered.source, /export const plugin = defineProtocolFamily\(\{/);
  for (const slot of ["manifest", "capture", "discovery", "identity", "instance", "routes", "pricing", "exact", "execution", "protocol"])
    assert(rendered.source.includes(`${slot}: binding_${slot},`));
  const reordered = Object.fromEntries(Object.entries(definition).reverse());
  assert.equal(renderDeclarativeProductionEntry({ rootDirectory: root, definitionFile, document: reordered }).source, rendered.source);
});

test("production JSON rejects incomplete, executable, unknown and escaped declarations", () => {
  const mutations: Array<(doc: any) => void> = [
    d => { delete d.exact; }, d => { d.production.domain = "unknown"; }, d => { d.production.domain = ["protocol"]; },
    d => { d.production.activation.enabled = "true"; }, d => { d.production.activation.envKey = "OTHER"; },
    d => { d.production.activation.unchecked = true; }, d => { d.unknown = {}; },
    d => { d.pricing.binding.export = "pricing; process.exit()"; },
    d => { d.pricing.binding.module = "../../../../../../outside.js"; },
    d => { d.exact.binding.module = "https://example.com/code.js"; },
    d => { d.exact.binding.extra = 1; }, d => { d.identity.unknown = {}; }, d => { d.pricing.definition = {}; },
    d => { d.funding = { binding: d.exact.binding }; }, d => { d.actionAdapters = {}; },
  ];
  for (const mutate of mutations) {
    const doc = clone(definition); mutate(doc);
    assert.throws(() => renderDeclarativeProductionEntry({ rootDirectory: root, definitionFile, document: doc }));
  }
});

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "declarative-production-"));
  const familyDirectory = resolve(directory, "src/searcher/venues/protocols/fixture-family");
  const productionDirectory = resolve(directory, "src/searcher/venues/production-families");
  async function put(file: string, content: string) {
    const target = resolve(directory, file); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
  }
  await mkdir(familyDirectory, { recursive: true }); await mkdir(productionDirectory, { recursive: true });
  await put("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "Node16", moduleResolution: "Node16", strict: true }, include: ["src"] }));
  await put("package-lock.json", JSON.stringify({ packages: {} }));
  await put("src/searcher/venues/adapter-family-plugin.ts", "export const defineProtocolFamily = <T>(value:T):T => value;\n");
  await put("src/searcher/venues/production-families/activation.ts", "export const defineFamilyActivation = <T>(value:T):T => value;\n");
  await put("src/searcher/build-declarative-production.ts", "export const compilerRevision = 1;\n");
  const doc: any = clone(definition); doc.scope.family = "protocol:fixture";
  for (const [slot, block] of Object.entries(doc) as [string, any][]) {
    if (!block?.binding) continue;
    block.binding = { module: `./${slot}.js`, export: slot };
    await put(`src/searcher/venues/protocols/fixture-family/${slot}.ts`,
      slot === "manifest" ? 'export const manifest = { familyId: "protocol:fixture", domain: "protocol" } as const;\n' :
      `export const ${slot} = { value: 1 };\n`);
  }
  doc.actionAdapters = [{ module: "./action.js", export: "action" }];
  await put("src/searcher/venues/protocols/fixture-family/action.ts", 'export const action = { id: "fixture-action" };\n');
  const jsonPath = resolve(familyDirectory, "fixture.json"), entryPath = resolve(productionDirectory, "fixture.production.ts");
  const save = async () => writeFile(jsonPath, JSON.stringify(doc));
  await save();
  const sync = (mode: "write" | "check") => syncDeclarativeProductionEntries({ rootDirectory: directory, mode });
  const build = () => buildFamilyCapabilityShadowArtifact({ rootDirectory: directory });
  return { directory, familyDirectory, productionDirectory, doc, jsonPath, entryPath, save, put, sync, build };
}

test("generation is idempotent; stale and orphaned entries fail checks without overwriting handwritten code", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.sync("check"), /missing or stale/);
    await f.sync("write"); const initial = await readFile(f.entryPath, "utf8"), before = (await stat(f.entryPath)).mtimeMs;
    await f.sync("write"); await f.sync("check"); assert.equal((await stat(f.entryPath)).mtimeMs, before);
    f.doc.production.activation.enabled = false; await f.save();
    await assert.rejects(f.sync("check"), /stale/); assert.equal(await readFile(f.entryPath, "utf8"), initial);
    await f.sync("write"); assert.match(await readFile(f.entryPath, "utf8"), /"enabled":false/);
    await rm(f.jsonPath); await assert.rejects(f.sync("check"), /orphaned/);
    await f.save(); await writeFile(f.entryPath, "// handwritten\n");
    await assert.rejects(f.sync("write"), /handwritten/);
    assert.equal(await readFile(f.entryPath, "utf8"), "// handwritten\n");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("duplicate families, missing modules and symlink bindings cannot produce admission entries", async () => {
  const f = await fixture();
  try {
    await f.sync("write");
    const duplicate = resolve(f.directory, "src/searcher/venues/other-family/other.json");
    const duplicateDoc = clone(f.doc);
    for (const block of Object.values(duplicateDoc) as any[]) if (block?.binding) block.binding.module = block.binding.module.replace("./", "../protocols/fixture-family/");
    for (const action of duplicateDoc.actionAdapters) action.module = action.module.replace("./", "../protocols/fixture-family/");
    await mkdir(dirname(duplicate), { recursive: true }); await writeFile(duplicate, JSON.stringify(duplicateDoc));
    await assert.rejects(f.sync("write"), /duplicate/); await rm(dirname(duplicate), { recursive: true });
    const exact = resolve(f.familyDirectory, "exact.ts"); await rm(exact);
    await assert.rejects(f.sync("write"), /ENOENT/);
    await symlink(resolve(f.familyDirectory, "pricing.ts"), exact);
    await assert.rejects(f.sync("write"), /regular file/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("generated bindings retain strict export validation and JSON/manifest identity agreement", async () => {
  const f = await fixture();
  try {
    await f.sync("write"); const good = await f.build(); assert.equal(good.complete, true, JSON.stringify(good.issues));
    f.doc.exact.binding.export = "missingExport"; await f.save(); await f.sync("write");
    assert.equal((await f.build()).complete, false);
    f.doc.exact.binding.export = "exact"; f.doc.scope.family = "protocol:wrong"; await f.save(); await f.sync("write");
    const wrongId = await f.build(); assert.equal(wrongId.complete, false);
    assert(wrongId.issues.some(issue => issue.message.includes("disagrees")));
    f.doc.scope.family = "protocol:fixture"; await f.save();
    await f.put("src/searcher/venues/protocols/fixture-family/manifest.ts", 'export const manifest = { familyId: "protocol:fixture", domain: "swap" } as const;\n');
    assert.equal((await f.build()).complete, false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("capability identities include JSON and compiler without merging Exact with other capabilities", async () => {
  const f = await fixture();
  try {
    await f.sync("write"); const base = await f.build(); assert(base.complete, JSON.stringify(base.issues));
    const compare = (before: typeof base, after: typeof base, changed: (cap: string, present: boolean) => boolean) => {
      assert(after.complete, JSON.stringify(after.issues));
      for (const row of after.exact) {
        const previous = before.exact.find(x => x.identity.capability === row.identity.capability)!;
        const different = previous.identity.contentHash !== row.identity.contentHash;
        assert.equal(different, changed(row.identity.capability, row.root.absence === null), row.identity.capability);
        if (row.root.absence !== null) assert.deepEqual(row.root.additionalSourceFiles, []);
      }
    };
    for (const row of base.exact.filter(x => x.root.absence === null)) {
      assert(row.identity.semanticDependencies.includes("src/searcher/venues/protocols/fixture-family/fixture.json"));
      assert(row.identity.semanticDependencies.includes("src/searcher/build-declarative-production.ts"));
    }
    await f.put("src/searcher/venues/protocols/fixture-family/exact.ts", "export const exact = { value: 2 };\n");
    const exactChange = await f.build(); compare(base, exactChange, cap => cap === "exact");
    f.doc.production.activation.enabled = false; await f.save();
    await assert.rejects(f.build(), /stale/); // Direct API must also reject stale generated glue.
    await f.sync("write"); const jsonChange = await f.build(); compare(exactChange, jsonChange, (_cap, present) => present);
    await f.put("src/searcher/build-declarative-production.ts", "export const compilerRevision = 2;\n");
    compare(jsonChange, await f.build(), (_cap, present) => present);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
