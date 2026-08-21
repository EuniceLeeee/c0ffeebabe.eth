import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkGeneratedReleaseRoleManifest,
  computeImplementationExportDigest,
  computePredicateCompositionLeafDigest,
  generateReleaseRoleManifest,
  parseLedger,
  verifyReleaseRoleManifestLedger,
  writeGeneratedReleaseRoleManifest,
} from "../src/index.ts";

const hash = (digit: string): string => `0x${digit.repeat(64)}`;

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function hashDomain(domain: string, value: unknown): string {
  return `0x${createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex")}`;
}

function contentSha256(value: string | Buffer): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function fixture(root: string): void {
  mkdirSync(join(root, "acceptance", "gate-core", "src", "generated"), { recursive: true });
  mkdirSync(join(root, "acceptance", "oracle", "src"), { recursive: true });
  mkdirSync(join(root, "tools", "release-role-manifest", "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module" }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true } }));
  writeFileSync(join(root, "acceptance", "gate-core", "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true } }));
  writeFileSync(join(root, "acceptance", "gate-core", "package.json"), JSON.stringify({ name: "@fixture/gate-core", exports: { ".": "./src/generated/release-runtime.ts" } }));
  writeFileSync(join(root, "acceptance", "gate-core", "src", "core.mjs"), "export const CORE = 1;\n");
  writeFileSync(join(root, "acceptance", "gate-core", "src", "adapter-helper.mjs"), "export const ADAPTER_VERSION = 'adapter-v1';\n");
  writeFileSync(join(root, "acceptance", "gate-core", "src", "adapter-one.mjs"), `import { ADAPTER_VERSION } from './adapter-helper.mjs';
const ADAPTER = Object.freeze({ predicateId: 'fixture.one', predicateSpec: { specDigest: '${hash("2")}' }, predicateProgramDescriptorDigest: '${hash("6")}', oracleProgramDescriptorDigest: '${hash("7")}', adapterVersion: ADAPTER_VERSION, evaluateLive() { return 'pass'; } });
export const ADAPTER_ONE = ADAPTER;
export const ADAPTER_ONE_ALT = ADAPTER;\n`);
  writeFileSync(join(root, "acceptance", "oracle", "src", "one.mjs"), `export const ORACLE_PROGRAM_DESCRIPTOR_DIGEST = '${hash("7")}'; export const ORACLE_VERSION = 'oracle-v1'; export function oracleOne() { return 'oracle'; } export const oracleOneAlt = oracleOne;\n`);
  writeFileSync(join(root, "tools", "release-role-manifest", "src", "index.ts"), "export const generator = 1;\n");
  writeFileSync(join(root, "tools", "release-role-manifest", "src", "cli.ts"), "import { generator } from './index.ts'; export const cli = generator;\n");
  writeFileSync(join(root, "acceptance", "gate-core", "src", "release-composition.ts"), `import { ADAPTER_ONE } from './adapter-one.mjs';
export const RELEASE_ROLE_COMPOSITION = Object.freeze({
  schemaVersion: 1,
  genericCore: { modulePath: 'acceptance/gate-core/src/core.mjs', exportName: 'CORE' },
  releaseRuntime: { modulePath: 'acceptance/gate-core/src/generated/release-runtime.ts', exportName: 'evaluateGateCore' },
  predicateAdapters: [{
    predicateId: 'fixture.one',
    predicateSpecDigest: '${hash("2")}',
    predicateProgramDescriptorDigest: '${hash("6")}',
    oracleProgramDescriptorDigest: '${hash("7")}',
    adapterVersion: 'adapter-v1',
    oracleVersion: 'oracle-v1',
    modulePath: 'acceptance/gate-core/src/adapter-one.mjs',
    exportName: 'ADAPTER_ONE',
    oracleModulePath: 'acceptance/oracle/src/one.mjs',
    oracleExportName: 'oracleOne'
  }]
});
export function resolvePredicateEvaluator(predicateId) {
  return predicateId === 'fixture.one' ? ADAPTER_ONE : null;
}
`);
}

function options(root: string) {
  return { repositoryRoot: root } as const;
}

const PRODUCTION_COMPOSITION_PATH = "acceptance/gate-core/src/release-composition.ts";
const PRODUCTION_OUTPUT_PATH = "acceptance/gate-core/src/generated/release-role-manifest.ts";
const PRODUCTION_LEDGER_PATH = "acceptance/gate-core/src/release-role-manifest.ledger.json";

test("generator API rejects redirected production paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-release-role-fixed-api-"));
  try {
    fixture(root);
    const redirected = {
      repositoryRoot: root,
      compositionPath: "other/composition.ts",
      outputPath: "other/manifest.ts",
      ledgerPath: "other/ledger.json",
    } as never;
    await assert.rejects(() => generateReleaseRoleManifest(redirected), /paths cannot be redirected/);
    assert.deepEqual(await checkGeneratedReleaseRoleManifest(redirected), [
      "generation-failed:release-role-manifest options are fixed to repositoryRoot; production composition, three generated outputs, one fixed authority output, and ledger paths cannot be redirected",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production generation owns the exact three generated outputs and one fixed authority placeholder", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = await generateReleaseRoleManifest({ repositoryRoot: root });
  assert.deepEqual(result.generatedOutputs.map((output) => output.path).sort(), [
    "acceptance/gate-core/src/generated/predicate-composition.ts",
    "acceptance/gate-core/src/generated/release-role-manifest.ts",
    "acceptance/gate-core/src/generated/release-runtime.ts",
  ]);
  assert.deepEqual(result.fixedOutputs.map((output) => output.path), ["acceptance/gate-core/src/generated/release-authority.ts"]);
  const authority = result.fixedOutputs.find((output) => output.path.endsWith("/release-authority.ts"));
  assert.ok(authority);
  assert.match(authority.text, /generated by tools\/release-role-manifest/);
  assert.match(authority.text, /RELEASE_AUTHORITY[^=]*= null/);
  const composition = result.generatedOutputs.find((output) => output.path.endsWith("/predicate-composition.ts"));
  assert.ok(composition);
  assert.match(composition.text, /predicateImplementationExportDigest:/);
  assert.match(composition.text, /oracleImplementationExportDigest:/);
  assert.match(composition.text, /RELEASE_PREDICATE_BINDINGS\.map\(\(binding\) => \[binding\.predicateId, binding\] as const\)/);
  assert.match(composition.text, /return PREDICATE_EVALUATORS\.get\(predicateId\) \?\? null/);
});

test("generator binds real module exports, compiler entrypoint IDs, and content ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-release-role-generator-"));
  try {
    fixture(root);
    const config = options(root);
    const compositionPath = join(root, PRODUCTION_COMPOSITION_PATH);
    const originalComposition = readFileSync(compositionPath, "utf8");
    const result = await generateReleaseRoleManifest(config);
    assert.equal(result.manifest.genericCore.entrypointId, "compiler-root:acceptance/gate-core/tsconfig.json:acceptance/gate-core/src/core.mjs");
    assert.equal(result.manifest.releaseRuntime.entrypointId, "package-entrypoint:acceptance/gate-core/package.json:.:acceptance/gate-core/src/generated/release-runtime.ts:acceptance/gate-core/tsconfig.json");
    assert.equal(result.manifest.predicateAdapters[0]?.entrypointId, "compiler-root:acceptance/gate-core/tsconfig.json:acceptance/gate-core/src/adapter-one.mjs");
    assert.equal(result.manifest.predicateAdapters[0]?.oracleEntrypointId, "compiler-root:tsconfig.json:acceptance/oracle/src/one.mjs");
    writeGeneratedReleaseRoleManifest(result, config);
    assert.deepEqual(verifyReleaseRoleManifestLedger(root, result.ledger), []);
    assert.equal(readFileSync(join(root, PRODUCTION_OUTPUT_PATH), "utf8"), result.outputText);
    assert.equal(JSON.parse(readFileSync(join(root, PRODUCTION_LEDGER_PATH), "utf8")).ledgerHash, result.ledger.ledgerHash);

    const baselinePredicate = result.manifest.predicateAdapters[0]!;
    const baselinePredicateExportDigest = computeImplementationExportDigest(root, {
      modulePath: "acceptance/gate-core/src/adapter-one.mjs",
      exportName: "ADAPTER_ONE",
    });
    assert.equal(baselinePredicate.predicateImplementationExportDigest, baselinePredicateExportDigest);
    assert.equal(baselinePredicateExportDigest, hashDomain("aloha/implementation-export/v1", {
      modulePath: "acceptance/gate-core/src/adapter-one.mjs",
      exportName: "ADAPTER_ONE",
      moduleContentSha256: contentSha256(readFileSync(join(root, "acceptance", "gate-core", "src", "adapter-one.mjs"))),
    }));
    assert.equal(baselinePredicate.compositionLeafDigest, computePredicateCompositionLeafDigest({
      predicateId: baselinePredicate.predicateId,
      predicateSpecDigest: baselinePredicate.predicateSpecDigest,
      predicateProgramDescriptorDigest: baselinePredicate.predicateProgramDescriptorDigest,
      oracleProgramDescriptorDigest: baselinePredicate.oracleProgramDescriptorDigest,
      adapterVersion: baselinePredicate.adapterVersion,
      oracleVersion: baselinePredicate.oracleVersion,
      modulePath: baselinePredicate.modulePath,
      exportName: baselinePredicate.exportName,
      oracleModulePath: baselinePredicate.oracleModulePath,
      oracleExportName: baselinePredicate.oracleExportName,
      predicateImplementationExportDigest: baselinePredicate.predicateImplementationExportDigest,
      oracleImplementationExportDigest: baselinePredicate.oracleImplementationExportDigest,
    }));

    writeFileSync(compositionPath, originalComposition.replace("exportName: 'ADAPTER_ONE'", "exportName: 'ADAPTER_ONE_ALT'"));
    const alternatePredicate = await generateReleaseRoleManifest(config);
    assert.notEqual(alternatePredicate.manifest.predicateAdapters[0]?.predicateImplementationExportDigest, baselinePredicate.predicateImplementationExportDigest);
    assert.notEqual(alternatePredicate.manifest.predicateAdapters[0]?.compositionLeafDigest, baselinePredicate.compositionLeafDigest);
    assert.ok((await checkGeneratedReleaseRoleManifest(config)).some((error) => error.startsWith("generated-content:")));
    writeFileSync(compositionPath, originalComposition);

    writeFileSync(compositionPath, originalComposition.replace("oracleExportName: 'oracleOne'", "oracleExportName: 'oracleOneAlt'"));
    const alternateOracle = await generateReleaseRoleManifest(config);
    assert.notEqual(alternateOracle.manifest.predicateAdapters[0]?.oracleImplementationExportDigest, baselinePredicate.oracleImplementationExportDigest);
    assert.notEqual(alternateOracle.manifest.predicateAdapters[0]?.compositionLeafDigest, baselinePredicate.compositionLeafDigest);
    assert.ok((await checkGeneratedReleaseRoleManifest(config)).some((error) => error.startsWith("generated-content:")));
    writeFileSync(compositionPath, originalComposition);

    writeFileSync(join(root, "acceptance", "gate-core", "src", "adapter-one.mjs"), "export const ADAPTER_ONE = Object.freeze({ predicateId: 'fixture.one', compositionLeafDigest: '0x" + "3".repeat(64) + "' });\n");
    assert.ok(verifyReleaseRoleManifestLedger(root, result.ledger).some((entry) => entry.startsWith("input-content:acceptance/gate-core/src/adapter-one.mjs")));
    writeFileSync(join(root, PRODUCTION_OUTPUT_PATH), `${result.outputText}\n// stale edit\n`);
    assert.ok(verifyReleaseRoleManifestLedger(root, result.ledger).some((entry) => entry.startsWith("output-content:")));

    const forgedLedger = parseLedger(JSON.parse(result.ledgerText));
    const forged = { ...forgedLedger, ledgerHash: hash("f") as `0x${string}` };
    assert.ok(verifyReleaseRoleManifestLedger(root, forged).some((entry) => entry === "ledger-hash"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact check rejects stale generated bytes without writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-release-role-check-"));
  try {
    fixture(root);
    const config = options(root);
    const result = await generateReleaseRoleManifest(config);
    writeGeneratedReleaseRoleManifest(result, config);
    assert.deepEqual(await checkGeneratedReleaseRoleManifest(config), []);

    const jointlyForgedOutput = `${result.outputText}\n// jointly forged output and ledger\n`;
    writeFileSync(join(root, PRODUCTION_OUTPUT_PATH), jointlyForgedOutput);
    const jointlyForgedLedger = JSON.parse(result.ledgerText) as Record<string, unknown>;
    const forgedOutputs = jointlyForgedLedger.outputs as Array<Record<string, unknown>>;
    const forgedRecord = forgedOutputs.find((entry) => entry.path === PRODUCTION_OUTPUT_PATH);
    assert.ok(forgedRecord);
    forgedRecord.contentSha256 = contentSha256(jointlyForgedOutput);
    forgedRecord.byteLength = Buffer.byteLength(jointlyForgedOutput);
    const { ledgerHash: _ledgerHash, ...forgedWithoutHash } = jointlyForgedLedger;
    jointlyForgedLedger.ledgerHash = hashDomain("aloha/release-role-manifest-ledger/v1", forgedWithoutHash);
    writeFileSync(join(root, PRODUCTION_LEDGER_PATH), `${JSON.stringify(jointlyForgedLedger, null, 2)}\n`);
    const jointlyForgedErrors = await checkGeneratedReleaseRoleManifest(config);
    assert.ok(jointlyForgedErrors.includes(`generated-content:${PRODUCTION_OUTPUT_PATH}`));
    assert.ok(jointlyForgedErrors.includes("ledger-content"));

    writeGeneratedReleaseRoleManifest(result, config);
    writeFileSync(join(root, PRODUCTION_OUTPUT_PATH), `${result.outputText}\n// stale\n`);
    const errors = await checkGeneratedReleaseRoleManifest(config);
    assert.ok(errors.includes("generated-content:acceptance/gate-core/src/generated/release-role-manifest.ts"));
    assert.match(readFileSync(join(root, PRODUCTION_OUTPUT_PATH), "utf8"), /stale/);
    writeFileSync(join(root, "acceptance", "gate-core", "src", "generated", "release-authority.ts"), "export const RELEASE_AUTHORITY = {} as unknown;\n");
    assert.ok((await checkGeneratedReleaseRoleManifest(config)).some((error) => error.includes("release-authority.ts")));
    writeGeneratedReleaseRoleManifest(result, config);
    writeFileSync(join(root, "acceptance", "oracle", "src", "one.mjs"), `${readFileSync(join(root, "acceptance", "oracle", "src", "one.mjs"), "utf8")}\n// oracle mutation\n`);
    assert.ok((await checkGeneratedReleaseRoleManifest(config)).includes("ledger-content"));
    writeFileSync(join(root, "acceptance", "gate-core", "src", "adapter-helper.mjs"), "export const ADAPTER_VERSION = 'adapter-v2';\n");
    assert.ok((await checkGeneratedReleaseRoleManifest(config)).includes("ledger-content"));
    writeFileSync(join(root, "acceptance", "gate-core", "src", "adapter-helper.mjs"), "export const ADAPTER_VERSION = 'adapter-v1';\n");
    writeFileSync(join(root, "tools", "release-role-manifest", "src", "index.ts"), "export const generator = 2;\n");
    assert.ok((await checkGeneratedReleaseRoleManifest(config)).includes("ledger-content"));
    writeFileSync(join(root, PRODUCTION_LEDGER_PATH), "{}\n");
    assert.ok((await checkGeneratedReleaseRoleManifest(config)).includes("ledger-missing-or-invalid"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generator rejects duplicate or non-static predicate bindings without executing candidate modules", async () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-release-role-invalid-"));
  try {
    fixture(root);
    const config = options(root);
    const compositionPath = join(root, PRODUCTION_COMPOSITION_PATH);
    const source = readFileSync(compositionPath, "utf8");
    writeFileSync(compositionPath, source.replace("predicateId: 'fixture.one'", "compositionLeafDigest: '" + hash("1") + "', predicateId: 'fixture.one'"));
    await assert.rejects(() => generateReleaseRoleManifest(config), /non-exact keys/);
    writeFileSync(compositionPath, source);
    writeFileSync(compositionPath, source.replace("  }]\n});", "  }, { ...{} }]\n});"));
    await assert.rejects(() => generateReleaseRoleManifest(config), /non-static/);
    writeFileSync(compositionPath, source.replace("  }]\n});", "  }, { predicateId: 'fixture.one', predicateSpecDigest: '" + hash("2") + "', predicateProgramDescriptorDigest: '" + hash("6") + "', oracleProgramDescriptorDigest: '" + hash("7") + "', adapterVersion: 'adapter-v1', oracleVersion: 'oracle-v1', modulePath: 'acceptance/gate-core/src/adapter-one.mjs', exportName: 'ADAPTER_ONE', oracleModulePath: 'acceptance/oracle/src/one.mjs', oracleExportName: 'oracleOne' }]\n});"));
    await assert.rejects(() => generateReleaseRoleManifest(config), /duplicate predicateId/);
    writeFileSync(compositionPath, source.replace("predicateSpecDigest: '" + hash("2") + "'", "predicateSpecDigest: '" + hash("4") + "'"));
    const changedBinding = await generateReleaseRoleManifest(config);
    assert.equal(changedBinding.manifest.predicateAdapters[0]?.predicateSpecDigest, hash("4"));
    writeFileSync(compositionPath, source);
    writeFileSync(join(root, "acceptance", "oracle", "src", "late.mjs"), "export const late = 1;\n");
    writeFileSync(join(root, "acceptance", "oracle", "src", "one.mjs"), `export const side = import('./late.mjs'); export const ORACLE_PROGRAM_DESCRIPTOR_DIGEST = '${hash("7")}'; export const ORACLE_VERSION = 'oracle-v1'; export function oracleOne() { return 'oracle'; }\n`);
    await assert.rejects(() => generateReleaseRoleManifest(config), /dynamic import/);
    writeFileSync(compositionPath, source.replace("export const RELEASE_ROLE_COMPOSITION", "export let RELEASE_ROLE_COMPOSITION"));
    await assert.rejects(() => generateReleaseRoleManifest(config), /export const/);
    writeFileSync(compositionPath, source.replace("export const RELEASE_ROLE_COMPOSITION", "export var RELEASE_ROLE_COMPOSITION"));
    await assert.rejects(() => generateReleaseRoleManifest(config), /export const/);
    writeFileSync(compositionPath, `${source}\nexport const RELEASE_ROLE_COMPOSITION = null;\n`);
    await assert.rejects(() => generateReleaseRoleManifest(config), /exactly one/);
    writeFileSync(compositionPath, `${source}\nRELEASE_ROLE_COMPOSITION = RELEASE_ROLE_COMPOSITION;\n`);
    await assert.rejects(() => generateReleaseRoleManifest(config), /reassigned/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generator compiler closure rejects dynamic loaders and records transitive helpers", async () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-release-role-compiler-closure-"));
  try {
    fixture(root);
    const config = options(root);
    const generatorIndexPath = join(root, "tools", "release-role-manifest", "src", "index.ts");
    const generatorCliPath = join(root, "tools", "release-role-manifest", "src", "cli.ts");
    writeFileSync(join(root, "tools", "release-role-manifest", "src", "helper.ts"), "export const helper = 1;\n");
    writeFileSync(generatorIndexPath, "import { helper } from './helper.ts'; export const generator = helper;\n");
    const result = await generateReleaseRoleManifest(config);
    assert.ok(result.ledger.generatorFiles.some((entry) => entry.path === "tools/release-role-manifest/src/helper.ts"));
    writeGeneratedReleaseRoleManifest(result, config);
    assert.deepEqual(await checkGeneratedReleaseRoleManifest(config), []);
    writeFileSync(join(root, "tools", "release-role-manifest", "src", "helper.ts"), "export const helper = 2;\n");
    assert.ok((await checkGeneratedReleaseRoleManifest(config)).includes("ledger-content"));
    writeFileSync(join(root, "tools", "release-role-manifest", "src", "late.ts"), "export const late = 1;\n");
    writeFileSync(generatorCliPath, "void import('./late.ts');\n");
    await assert.rejects(() => generateReleaseRoleManifest(config), /dynamic import/);
    writeFileSync(generatorCliPath, "declare function require(name: string): unknown; const late = require('./late.ts'); void late;\n");
    await assert.rejects(() => generateReleaseRoleManifest(config), /compiler closure omitted static require/);
    writeFileSync(generatorCliPath, "declare function require(name: string): unknown; const late = require('./' + 'late.ts'); void late;\n");
    await assert.rejects(() => generateReleaseRoleManifest(config), /dynamic require/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unrelated predicate changes only its leaf and aggregate roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-release-role-isolation-"));
  try {
    fixture(root);
    const config = options(root);
    const baseline = await generateReleaseRoleManifest(config);
    writeFileSync(join(root, "acceptance", "gate-core", "src", "adapter-two.mjs"), `export const ADAPTER_TWO = Object.freeze({ predicateId: 'fixture.two', predicateSpec: { specDigest: '${hash("6")}' }, predicateProgramDescriptorDigest: '${hash("8")}', oracleProgramDescriptorDigest: '${hash("9")}', adapterVersion: 'adapter-v2', evaluateLive() { return 'pass'; } });\n`);
    writeFileSync(join(root, "acceptance", "oracle", "src", "two.mjs"), `export const ORACLE_PROGRAM_DESCRIPTOR_DIGEST = '${hash("9")}'; export const ORACLE_VERSION = 'oracle-v2'; export function oracleTwo() { return 'oracle'; }\n`);
    const original = readFileSync(join(root, PRODUCTION_COMPOSITION_PATH), "utf8");
    const updated = original.replace("import { ADAPTER_ONE } from './adapter-one.mjs';", "import { ADAPTER_ONE } from './adapter-one.mjs';\nimport { ADAPTER_TWO } from './adapter-two.mjs';").replace("return predicateId === 'fixture.one' ? ADAPTER_ONE : null;", "return predicateId === 'fixture.one' ? ADAPTER_ONE : predicateId === 'fixture.two' ? ADAPTER_TWO : null;").replace("  }]\n});", `  }, {
    predicateId: 'fixture.two',
    predicateSpecDigest: '${hash("6")}',
    predicateProgramDescriptorDigest: '${hash("8")}',
    oracleProgramDescriptorDigest: '${hash("9")}',
    adapterVersion: 'adapter-v2',
    oracleVersion: 'oracle-v2',
    modulePath: 'acceptance/gate-core/src/adapter-two.mjs',
    exportName: 'ADAPTER_TWO',
    oracleModulePath: 'acceptance/oracle/src/two.mjs',
    oracleExportName: 'oracleTwo'
  }]\n});`);
    writeFileSync(join(root, PRODUCTION_COMPOSITION_PATH), updated);
    const expanded = await generateReleaseRoleManifest(config);
    assert.equal(expanded.manifest.predicateAdapters[0]?.predicateId, "fixture.one");
    assert.equal(expanded.manifest.predicateAdapters[0]?.compositionLeafDigest, baseline.manifest.predicateAdapters[0]?.compositionLeafDigest);
    assert.equal(expanded.manifest.genericCore.entrypointId, baseline.manifest.genericCore.entrypointId);
    assert.notEqual(expanded.manifest.rootDigest, baseline.manifest.rootDigest);
    assert.notEqual(expanded.manifest.predicateCompositionRootDigest, baseline.manifest.predicateCompositionRootDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
