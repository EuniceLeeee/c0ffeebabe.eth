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
// Preserve the v1 contract independently of the migrated production Family.
const legacyDefinition: any = {
  version: 1, scope: { family: "protocol:fixture" },
  production: { domain: "protocol", activation: { enabled: true, envKey: "SEARCHER_FAMILY_FIXTURE_ENABLED" } },
  ...Object.fromEntries(["manifest", "capture", "discovery", "identity", "instance", "routes", "pricing", "exact", "execution", "protocol"]
    .map(slot => [slot, { binding: { module: `./${slot}.js`, export: slot } }])),
  actionAdapters: [{ module: "./action.js", export: "action" }],
};

test("ERC4626 production registration is reproducible from its JSON", async () => {
  const rendered = renderDeclarativeProductionEntry({ rootDirectory: root, definitionFile, document: definition });
  assert.equal(await readFile(rendered.entryFile, "utf8"), rendered.source);
  if (rendered.format === "protocol-json-v2") {
    assert.match(rendered.source, /defineProtocolFamily\(compileDeclarativeProtocol<FamilyTypes>\(definition, \[child0, child1\]\)\)/);
    assert.doesNotMatch(rendered.source, /\bas binding_[A-Za-z0-9_]+\b|from ["'][^"'\n]*family\/[^"'\n]+\.js["']/);
    assert.equal(rendered.childFiles.length, 2);
  } else {
    assert.match(rendered.source, /export const plugin = defineProtocolFamily\(\{/);
    for (const slot of ["manifest", "capture", "discovery", "identity", "instance", "routes", "pricing", "exact", "execution", "protocol"])
      assert(rendered.source.includes(`${slot}: binding_${slot},`));
  }
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
    const doc = clone(legacyDefinition); mutate(doc);
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
  const doc: any = clone(legacyDefinition); doc.scope.family = "protocol:fixture";
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

async function protocolFixture() {
  const f = await fixture();
  const doc = {
    version: 2, scope: { family: "protocol:fixture" },
    production: { domain: "protocol", activation: { enabled: true, envKey: "SEARCHER_FAMILY_FIXTURE_ENABLED" } },
    manifest: { familyId: "protocol:fixture", domain: "protocol", ownedActionAdapterIds: ["fixture-convert"],
      requiredInfraActionAdapterIds: ["erc20-approve"], supportedLineages: ["fixture:standard", "fixture:child"] },
    discovery: { definition: {} }, identity: { definition: {}, memoReuse: "recheck-identity", key: "$identity.subject" },
    instance: {}, routes: {}, pricing: {}, protocol: {},
    standard: { id: "standard", lineageId: "fixture:standard", abi: {}, constants: {}, expressions: {},
      pricing: {}, exact: {}, readPrograms: {}, execution: {} },
    actionAdapters: [{ descriptor: { adapterId: "fixture-convert", edgeKind: "protocol", action: "convert" }, traces: [] }],
    variantFiles: ["./child.json"],
  };
  for (const key of Object.keys(f.doc)) delete f.doc[key];
  Object.assign(f.doc, doc);
  await f.save();
  const childPath = resolve(f.familyDirectory, "child.json");
  const child: any = { version: 1, id: "child", lineageId: "fixture:child", abi: {}, constants: { allowance: "0" },
    expressions: {}, admission: { version: 1,
      ...Object.fromEntries(["match", "surface", "dependencies", "active"].map(name => [name, { reads: [] }])) },
    models: { surface: { fields: [], output: { binding: "$evidence.binding" } } },
    requestSets: { surface: [] }, readPrograms: { quote: { requests: [], result: "$missing" } } };
  const saveChild = () => writeFile(childPath, JSON.stringify(child));
  await saveChild();
  await f.put("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "Node16", moduleResolution: "Node16",
    strict: true, resolveJsonModule: true, esModuleInterop: true }, include: ["src"] }));
  await f.put("src/searcher/venues/declarative-protocol.ts", "import { operation } from './fixture-operation.js';\nexport function compileDeclarativeProtocol(root: unknown, children: unknown[]) { return { root, children, operation }; }\n");
  await f.put("src/searcher/venues/fixture-operation.ts", "export const operation = 1;\n");
  return { ...f, child, childPath, saveChild };
}

test("v2 emits only shared compiler and static JSON imports; child data and transitive common code enter every present capability hash", async () => {
  const f = await protocolFixture();
  try {
    const entries = await f.sync("write"), entry = entries.get(f.entryPath)!;
    assert.equal(entry.format, "protocol-json-v2");
    assert.deepEqual(entry.childFiles, [f.childPath]);
    assert.deepEqual(entry.ownedActionAdapterIds, ["fixture-convert"]);
    assert.match(entry.source, /compileDeclarativeProtocol\(definition, \[child0\]\)/);
    assert.doesNotMatch(entry.source, /\bas binding_[A-Za-z0-9_]+\b|from ["'][^"'\n]*family\/[^"'\n]+\.js["']/);
    const base = await f.build(); assert(base.complete, JSON.stringify(base.issues));
    for (const row of base.exact.filter(row => row.root.absence === null)) {
      assert.equal(row.root.entryExport, "compileDeclarativeProtocol");
      // The compiler is the hashed entry, not a second dependency artifact.
      assert.equal(row.root.entrySourceFile, "src/searcher/venues/declarative-protocol.ts");
      for (const file of ["src/searcher/venues/protocols/fixture-family/child.json",
        "src/searcher/venues/protocols/fixture-family/fixture.json",
        "src/searcher/venues/fixture-operation.ts", "src/searcher/build-declarative-production.ts"])
        assert(row.identity.semanticDependencies.includes(file), `${row.identity.capability}:${file}`);
      assert(!row.identity.semanticDependencies.some(file => /fixture-family\/(?:exact|execution|identity)\.ts$/.test(file)));
    }
    const compare = (before: typeof base, after: typeof base) => {
      assert(after.complete, JSON.stringify(after.issues));
      for (const row of after.exact) {
        const previous = before.exact.find(x => x.identity.capability === row.identity.capability)!;
        assert.equal(previous.identity.contentHash !== row.identity.contentHash, row.root.absence === null, row.identity.capability);
      }
      assert.equal(after.exact.find(row => row.identity.capability === "victim")?.root.absence, "declared-absent");
    };
    f.child.constants.allowance = "1"; await f.saveChild();
    const changedChild = await f.build(); compare(base, changedChild);
    await f.put("src/searcher/venues/fixture-operation.ts", "export const operation = 2;\n");
    const changedDependency = await f.build(); compare(changedChild, changedDependency);
    await f.put("src/searcher/venues/declarative-protocol.ts", "import { operation } from './fixture-operation.js';\nexport function compileDeclarativeProtocol(root: unknown, children: unknown[]) { return { root, children, operation, revision: 2 }; }\n");
    compare(changedDependency, await f.build());
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("authored variants accept admission/models/read results, preserve binding data and reject code or mixed formats", async () => {
  const f = await protocolFixture();
  try {
    await f.sync("write");
    const baseline = clone(f.child);
    for (const mutate of [
      (d: any) => { d.identity = {}; },
      (d: any) => { d.programs = {}; },
      (d: any) => { d.admission.version = 2; },
      (d: any) => { delete d.admission.surface; },
      (d: any) => { d.admission.surface.reads = {}; },
      (d: any) => { d.admission.surface.requests = []; },
      (d: any) => { delete d.models; },
      (d: any) => { d.requestSets.surface = {}; },
      (d: any) => { delete d.readPrograms.quote.result; },
      (d: any) => { d.readPrograms.quote.decode = []; },
      (d: any) => { d.models.surface.output.binding = { module: "./hidden.js" }; },
      (d: any) => { d.models.surface.output.binding = { export: "hidden" }; },
      (d: any) => { d.models.surface.output.binding = { handler: "hidden" }; },
    ]) {
      const changed = clone(baseline); mutate(changed);
      await writeFile(f.childPath, JSON.stringify(changed));
      await assert.rejects(f.sync("check"));
    }
    await writeFile(f.childPath, JSON.stringify(baseline));
    await f.sync("check");
    // The pre-normalization expanded format remains valid for older v2 users.
    const expanded = clone(baseline);
    delete expanded.admission; delete expanded.models; delete expanded.requestSets;
    expanded.identity = { select: [], stages: {}, decide: [] };
    expanded.readPrograms = { quote: { requests: [], decode: [] } };
    await writeFile(f.childPath, JSON.stringify(expanded));
    await f.sync("check");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("v2 checks identity, action IDs and complete static child declarations before generation", async () => {
  const f = await protocolFixture();
  try {
    const mutations: Array<(doc: any) => void> = [
      d => { d.manifest.familyId = "protocol:other"; }, d => { d.manifest.domain = "swap"; },
      d => { d.production.domain = "swap"; }, d => { d.actionAdapters[0].descriptor.adapterId = "wrong-action"; },
      d => { d.actionAdapters.push(d.actionAdapters[0]); }, d => { d.standard.lineageId = "missing"; },
      d => { delete d.standard.execution; }, d => { delete d.identity.definition; },
      d => { d.standard.exact = { binding: { module: "./old.js", export: "old" } }; },
      d => { d.variantFiles = ["../outside.json"]; }, d => { d.variantFiles = ["https://example.com/child.json"]; },
      d => { d.variantFiles = ["./fixture.json"]; }, d => { d.variantFiles = ["./child.json", "./child.json"]; },
      d => { d.variantFiles = []; }, d => { d.protocol.oracleVictim = {}; },
    ];
    for (const mutate of mutations) {
      const doc = clone(f.doc); mutate(doc);
      assert.throws(() => renderDeclarativeProductionEntry({ rootDirectory: f.directory, definitionFile: f.jsonPath, document: doc }));
    }
    await f.sync("write");
    const original = await readFile(f.entryPath, "utf8");
    f.child.variantFiles = ["./fixture.json"]; await f.saveChild();
    await assert.rejects(f.sync("write"), /nested or cyclic/);
    assert.equal(await readFile(f.entryPath, "utf8"), original);
    delete f.child.variantFiles; f.child.lineageId = "fixture:standard"; await f.saveChild();
    await assert.rejects(f.sync("write"), /variant identity\/lineage/);
    f.child.lineageId = "fixture:child"; await f.saveChild();
    await rm(f.childPath); await assert.rejects(f.sync("write"), /ENOENT/);
    await symlink(f.jsonPath, f.childPath); await assert.rejects(f.sync("write"), /regular file/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("v2 cannot bypass the strict constructor, shared export validation or generated-source equality", async () => {
  const f = await protocolFixture();
  try {
    await f.sync("write"); const source = await readFile(f.entryPath, "utf8");
    await writeFile(f.entryPath, source.replace("compileDeclarativeProtocol(definition, [child0])", "definition as any"));
    await assert.rejects(f.build(), /stale/);
    await f.sync("write");
    await f.put("src/searcher/venues/declarative-protocol.ts", "export function otherCompiler(root: unknown) { return root; }\n");
    const result = await f.build(); assert.equal(result.complete, false);
    assert(result.issues.some(issue => issue.message.includes("resolvable framework export")));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
