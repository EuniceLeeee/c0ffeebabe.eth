import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FunctionFragment } from "ethers";
import { buildFamilyCapabilityShadowArtifact } from "../build-family-capability-manifest.js";
import { renderDeclarativeProductionEntry, syncDeclarativeProductionEntries } from "../build-declarative-production.js";
import { calculateReadyRuleDefinitions } from "../build-ready-rule-bindings.js";
import { normalizeSelectorFamilyDefinition } from "../venues/selector-family-definition.js";
import { definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { defineSelectorFamilyModule } from "../venues/selector-family-module.js";
import { generatedCapabilityManifestFromShadowArtifact } from "../venues/family-capability-shadow.js";

const signature = "function buildFixture(address input,address output,uint256 amount,address recipient) returns(uint256)";
const selector = FunctionFragment.from(signature).selector;
const simple = { selector, signature, domain: "protocol", parameters: ["tokenIn", "tokenOut", "amountIn", "recipient"].map((role, index) => ({ path: [index], role })), payment: { kind: "approval" } };

async function fixture(t: test.TestContext, document: unknown = simple) {
  const root = await mkdtemp(join(tmpdir(), "selector-v2-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const venues = join(root, "src/searcher/venues"), production = join(venues, "production-families");
  const definition = join(venues, `selector-native/selector-${selector.slice(2)}-family/selector-${selector.slice(2)}.json`);
  await mkdir(dirname(definition), { recursive: true }); await mkdir(production, { recursive: true });
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", resolveJsonModule: true }, include: ["src"] }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: {} }));
  // A small source-closure fixture. Actual issuance/activation is tested via
  // the real defineSelectorFamilyModule factory in selector-native-module.
  await writeFile(join(venues, "selector-family-module.ts"), "export function defineSelectorFamilyModule(definition: unknown) { return definition; }\n");
  await writeFile(definition, JSON.stringify(document));
  const entries = await syncDeclarativeProductionEntries({ rootDirectory: root, mode: "write" });
  const entry = [...entries.values()][0]!;
  return { root, venues, production, definition, entry };
}

test("v2 production generation binds one authored JSON and rejects old/foreign source contracts", async t => {
  const f = await fixture(t);
  assert.match(f.entry.source, /export const selectorFamilyModule = defineSelectorFamilyModule\(definition\)/);
  assert.doesNotMatch(f.entry.source, /export const (plugin|activation)|defineProtocolFamily|compileSelectorNative/);
  const artifact = await buildFamilyCapabilityShadowArtifact({ rootDirectory: f.root });
  assert.equal(artifact.complete, true); assert.deepEqual(artifact.issues, []); assert.deepEqual(artifact.legacy, []);
  assert.equal(artifact.exact.length, 11);
  const present = artifact.exact.filter(row => row.root.absence === null);
  assert(present.every(row => row.root.entryExport === "defineSelectorFamilyModule" && row.root.authoringIntegrity?.length === 1));
  generatedCapabilityManifestFromShadowArtifact({ artifact, strictFamilyIds: [f.entry.familyId as any] });
  for (const format of ["selector-native-execution/v1", "selector-native-funding/v1", "protocol-family/v1"])
    assert.throws(() => renderDeclarativeProductionEntry({ rootDirectory: f.root, definitionFile: f.definition, document: { ...simple, format } }), /retired Family JSON format/);
  await writeFile(f.entry.entryFile, f.entry.source.replace("defineSelectorFamilyModule(definition)", "defineSelectorFamilyModule({})"));
  await assert.rejects(buildFamilyCapabilityShadowArtifact({ rootDirectory: f.root }), /entry missing or stale/);
  await writeFile(f.entry.entryFile, f.entry.source);
  const foreign = join(f.production, "foreign.production.ts"); await writeFile(foreign, "export const plugin = {};\n");
  await assert.rejects(syncDeclarativeProductionEntries({ rootDirectory: f.root, mode: "write" }), /unregistered production entry/);
  await rm(foreign);
  const document = await readFile(f.definition, "utf8"), escaped = join(f.root, "outside.json");
  await writeFile(escaped, document); await rm(f.definition); await symlink(escaped, f.definition);
  await assert.rejects(syncDeclarativeProductionEntries({ rootDirectory: f.root, mode: "check" }), /regular files and directories/);
});

test("metadata changes only authored byte integrity; candidate capability and every Ready rule hash stay semantic", async t => {
  const f = await fixture(t), normalized: any = normalizeSelectorFamilyDefinition(simple);
  const module = defineSelectorFamilyModule(simple);
  const boundaries = { [f.entry.familyId]: definedFamilyPluginContractSummary(module.plugin).definitionBoundaryHash };
  const build = async () => {
    const artifact = await buildFamilyCapabilityShadowArtifact({ rootDirectory: f.root });
    assert.equal(artifact.complete, true, JSON.stringify(artifact.issues));
    const ready = await calculateReadyRuleDefinitions({ rootDirectory: f.root, artifact, definitionBoundaryHashes: boundaries });
    return { artifact, ready, semantic: artifact.exact.map(row => row.identity) };
  };
  const before = await build();
  const annotated = { ...normalized, meta: { identity: "an optional analysis label", explanation: ["free text"] },
    programs: normalized.programs.map((program: any) => ({ ...program, meta: { note: "program annotations" } })) };
  await writeFile(f.definition, JSON.stringify(annotated, null, 4) + "\n");
  const after = await build();
  assert.deepEqual(after.semantic, before.semantic);
  assert.deepEqual(after.ready, before.ready);
  assert.notEqual(after.artifact.artifactHash, before.artifact.artifactHash);
  const beforeIntegrity = before.artifact.exact.find(row => row.root.authoringIntegrity)!.root.authoringIntegrity;
  const afterIntegrity = after.artifact.exact.find(row => row.root.authoringIntegrity)!.root.authoringIntegrity;
  assert.notDeepEqual(afterIntegrity, beforeIntegrity);
  const corrupt = JSON.parse(JSON.stringify(after.artifact));
  corrupt.exact.find((row: any) => row.root.authoringIntegrity).root.authoringIntegrity[0].sha256 = "0".repeat(64);
  assert.throws(() => generatedCapabilityManifestFromShadowArtifact({ artifact: corrupt, strictFamilyIds: [f.entry.familyId as any] }), /hash is stale or invalid/);
  await writeFile(f.definition, JSON.stringify({ ...simple, payment: { kind: "none" } }));
  const executionChange = await build();
  assert.notDeepEqual(executionChange.semantic, before.semantic); assert.notDeepEqual(executionChange.ready, before.ready);
  // A metadata-shaped key in unrelated runtime data is still semantic.
  const unrelated = join(f.venues, "shared.json"); await writeFile(unrelated, JSON.stringify({ meta: "runtime-a" }));
  await writeFile(join(f.venues, "selector-family-module.ts"), 'import state from "./shared.json"; export function defineSelectorFamilyModule(definition: unknown) { return [definition,state.meta]; }\n');
  const sharedA = await build(); await writeFile(unrelated, JSON.stringify({ meta: "runtime-b" }));
  assert.notDeepEqual((await build()).semantic, sharedA.semantic);
});

test("funding metadata is isolated by the same capability and Ready normalization", async t => {
  const funding = JSON.parse(await readFile(new URL("../venues/selector-native/selector-5c38449e-family/selector-5c38449e.json", import.meta.url), "utf8"));
  const f = await fixture(t, funding), before = await buildFamilyCapabilityShadowArtifact({ rootDirectory: f.root });
  const boundary = definedFamilyPluginContractSummary(defineSelectorFamilyModule(funding).plugin).definitionBoundaryHash;
  const ready = await calculateReadyRuleDefinitions({ rootDirectory: f.root, artifact: before, definitionBoundaryHashes: { [f.entry.familyId]: boundary } });
  await writeFile(f.definition, JSON.stringify({ ...funding, meta: { identity: "renamed funding source", notes: "untrusted descriptive text" } }));
  const after = await buildFamilyCapabilityShadowArtifact({ rootDirectory: f.root });
  assert.deepEqual(after.exact.map(row => row.identity), before.exact.map(row => row.identity));
  assert.notEqual(after.artifactHash, before.artifactHash);
  assert.deepEqual(await calculateReadyRuleDefinitions({ rootDirectory: f.root, artifact: after, definitionBoundaryHashes: { [f.entry.familyId]: boundary } }), ready);
});
