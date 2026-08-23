import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as ts from "typescript";
import {
  computeImplementationExportDigest,
  computePredicateCompositionLeafDigest,
  computePredicateCompositionRootDigest,
  computeProgramInputSetRoot,
  computeReleaseRoleManifestRootDigest,
  deriveReleaseClosureFacts,
  MUTATION_CORPUS,
  findImplementationClosureById,
  inspectSourceText,
  recomputeImplementationClosureDigest,
  runBoundaryGate,
  validateProductionReleaseClosure,
  validateProductionRuntimeClosures,
  validateQualifiedExecutorAuthoritySource,
  validateFamilyExecutionCompositionSource,
  validateRuntimeReleaseBootstrapSources,
  validateAndQueryImplementationClosureDigest,
  validateAttestationContractOwnershipSources,
  validateDependencyBoundaries,
  validateGateCorePackageExports,
  validateReleaseClosureFacts,
  validateReleaseRoleManifest,
  verifyMutationCorpus,
} from "../src/index.ts";
import type { BoundaryDiagnostic, GraphEdge, ImplementationCompilerInput, ReleaseRoleManifestV1, ReleaseClosureRefV1, TrackedFile } from "../src/index.ts";

function fixturePackageLock(name: string, extraPackages: Record<string, Record<string, unknown>> = {}): string {
  return `${JSON.stringify({
    name,
    lockfileVersion: 3,
    packages: {
      "": { name, devDependencies: { typescript: ts.version } },
      "node_modules/typescript": { version: ts.version },
      ...extraPackages,
    },
  })}\n`;
}

const sha256 = (bytes: Buffer): string => `0x${createHash("sha256").update(bytes).digest("hex")}`;

test("Attestation contract ownership rejects duplicate validators, authority shapes, and public shape assertions", () => {
  const publicPath = "packages/attestation/src/index.ts";
  const enginePath = "packages/attestation/src/internal/engine.ts";
  const baseline = new Map<string, string>([
    [publicPath, "export interface AttestationValidationAuthorityV1 { readonly authorityRoot: string; }\n"],
    [enginePath, "export function createAttestationServiceInternal(): object { return {}; }\n"],
  ]);
  const inspect = (sources: ReadonlyMap<string, string>): readonly BoundaryDiagnostic[] => {
    const diagnostics: BoundaryDiagnostic[] = [];
    validateAttestationContractOwnershipSources(sources, diagnostics);
    return diagnostics;
  };
  assert.deepEqual(inspect(baseline), []);

  const duplicateValidator = new Map(baseline);
  duplicateValidator.set(enginePath, `${baseline.get(enginePath)!}function validateCandidateFinalOutcome(): void {}\n`);
  assert.ok(inspect(duplicateValidator).some((item) => item.code === "attestation-engine-canonical-contract"));

  const duplicateAuthority = new Map(baseline);
  duplicateAuthority.set(enginePath, `${baseline.get(enginePath)!}interface AttestationValidationAuthorityV1 {}\n`);
  const duplicateAuthorityDiagnostics = inspect(duplicateAuthority);
  assert.ok(duplicateAuthorityDiagnostics.some((item) => item.code === "attestation-validation-authority-declaration-count"));
  assert.ok(duplicateAuthorityDiagnostics.some((item) => item.code === "attestation-engine-canonical-contract"));

  const shapeAssert = new Map(baseline);
  shapeAssert.set(publicPath, `${baseline.get(publicPath)!}export function assertAttestationValidationAuthority(value: unknown): unknown { return value; }\n`);
  assert.ok(inspect(shapeAssert).some((item) => item.code === "attestation-public-shape-authority-assert"));

  const engineExport = new Map(baseline);
  engineExport.set(enginePath, `${baseline.get(enginePath)!}export const validateSomethingElse = (value: unknown): unknown => value;\n`);
  assert.ok(inspect(engineExport).some((item) => item.code === "attestation-engine-public-contract-export"));
});

function canonicalFixture(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalFixture(item)}`).join(",")}}`;
}

test("GateCore package exports are one exact generated runtime root", () => {
  const packagePath = "acceptance/gate-core/package.json";
  const target = "./src/generated/release-runtime.ts";
  const diagnosticsFor = (exportsValue: unknown): readonly BoundaryDiagnostic[] => {
    const diagnostics: BoundaryDiagnostic[] = [];
    validateGateCorePackageExports(packagePath, { exports: exportsValue }, diagnostics);
    return diagnostics;
  };

  assert.deepEqual(diagnosticsFor({ ".": target }), []);
  const mutations: ReadonlyArray<[string, unknown]> = [
    ["exports omitted", undefined],
    ["string root", target],
    ["conditional root", { ".": { import: target, require: target } }],
    ["array root", { ".": [target] }],
    ["deep export", { ".": target, "./internal": target }],
    ["alternate target", { ".": "./src/other-runtime.ts" }],
  ];
  for (const [label, exportsValue] of mutations) {
    const diagnostics = diagnosticsFor(exportsValue);
    assert.deepEqual(diagnostics.map((item) => `${item.kind}:${item.code}`), ["fail:gate-core-package-exports"], label);
    assert.equal(diagnostics[0]?.path, packagePath, label);
  }
});

test("scheduler generated authority is exact-null and rejects a hand-injected issuer", () => {
  const valid = [
    'import type { QualifiedExecutorAuthorityIssuer } from "../index.ts";',
    "export const QUALIFIED_EXECUTOR_AUTHORITY: QualifiedExecutorAuthorityIssuer | null = null;",
  ].join("\n");
  const validDiagnostics: BoundaryDiagnostic[] = [];
  validateQualifiedExecutorAuthoritySource(valid, validDiagnostics);
  assert.deepEqual(validDiagnostics, []);

  const forged = valid.replace("= null", "= { open() { return {}; } }");
  const forgedDiagnostics: BoundaryDiagnostic[] = [];
  validateQualifiedExecutorAuthoritySource(forged, forgedDiagnostics);
  assert.ok(forgedDiagnostics.some((item) => item.code === "qualified-executor-authority-not-null"), JSON.stringify(forgedDiagnostics));

  const runtimeImported = [
    'import { createIssuer } from "../issuer.ts";',
    "export const QUALIFIED_EXECUTOR_AUTHORITY = null;",
  ].join("\n");
  const runtimeDiagnostics: BoundaryDiagnostic[] = [];
  validateQualifiedExecutorAuthoritySource(runtimeImported, runtimeDiagnostics);
  assert.ok(runtimeDiagnostics.some((item) => item.code === "qualified-executor-authority-runtime-import"), JSON.stringify(runtimeDiagnostics));

  const mutations = [
    {
      label: "removed type import",
      source: valid.split("\n").slice(1).join("\n"),
      code: "qualified-executor-authority-import-shape",
    },
    {
      label: "side-effect import",
      source: "import \"./side-effect.ts\";\n" + valid.split("\n").slice(1).join("\n"),
      code: "qualified-executor-authority-runtime-import",
    },
    {
      label: "extra const",
      source: `${valid}\nexport const EXTRA = 1;`,
      code: "qualified-executor-authority-extra-statement",
    },
    {
      label: "extra function",
      source: `${valid}\nexport function issuer() { return {}; }`,
      code: "qualified-executor-authority-extra-statement",
    },
    {
      label: "getter initializer",
      source: valid.replace("= null", "= { get open() { return {}; } }").replace("| null", "| null"),
      code: "qualified-executor-authority-not-null",
    },
    {
      label: "call initializer",
      source: valid.replace("= null", "= createIssuer()"),
      code: "qualified-executor-authority-not-null",
    },
  ];
  for (const mutation of mutations) {
    const mutationDiagnostics: BoundaryDiagnostic[] = [];
    validateQualifiedExecutorAuthoritySource(mutation.source, mutationDiagnostics);
    assert.ok(mutationDiagnostics.some((item) => item.code === mutation.code), `${mutation.label}: ${JSON.stringify(mutationDiagnostics)}`);
  }
});

test("compiler test fixtures may remain denominator facts but never enter release-runtime closure", () => {
  const releaseRuntime: ReleaseClosureRefV1 = {
    role: "release-runtime",
    entrypointId: "package-entrypoint:runtime",
    entrypoint: "acceptance/gate-core/src/generated/release-runtime.ts",
    modulePath: "acceptance/gate-core/src/generated/release-runtime.ts",
    exportName: "evaluateGateCore",
    predicateId: null,
    predicateSpecDigest: null,
    predicateProgramDescriptorDigest: null,
    oracleProgramDescriptorDigest: null,
    adapterVersion: null,
    oracleVersion: null,
    compositionLeafDigest: null,
    implementationExportDigest: null,
    closureDigest: `0x${"1".repeat(64)}`,
    programInputSetRoot: `0x${"2".repeat(64)}`,
  };
  const receipt = {
    implementationClosures: [{
      entrypointId: releaseRuntime.entrypointId,
      files: [
        { path: releaseRuntime.entrypoint, blobSha: "a".repeat(40), contentSha256: `0x${"a".repeat(64)}`, byteLength: 1 },
        { path: "packages/attestation/test/authority-fixture.ts", blobSha: "b".repeat(40), contentSha256: `0x${"b".repeat(64)}`, byteLength: 1 },
        { path: "packages/scheduler/test/fixtures/qualified-release.ts", blobSha: "c".repeat(40), contentSha256: `0x${"c".repeat(64)}`, byteLength: 1 },
      ],
    }],
  } as never;
  const diagnostics: BoundaryDiagnostic[] = [];
  validateProductionReleaseClosure(receipt, releaseRuntime, diagnostics);
  assert.deepEqual(diagnostics.map((item) => item.code), [
    "release-runtime-imports-test-fixture",
    "release-runtime-imports-test-fixture",
  ]);
  assert.ok(diagnostics.every((item) => item.kind === "fail"));

  const runtimeReceipt = {
    implementationClosures: [{
      entrypointId: "compiler-root:apps/searcher.ts",
      entrypoint: "apps/searcher.ts",
      files: [{ path: "apps/searcher.ts", blobSha: "d".repeat(40), contentSha256: `0x${"d".repeat(64)}`, byteLength: 1 }, { path: "packages/scheduler/test/fixtures/qualified-release.ts", blobSha: "e".repeat(40), contentSha256: `0x${"e".repeat(64)}`, byteLength: 1 }],
    }],
  } as never;
  const runtimeFiles: TrackedFile[] = [
    { path: "apps/searcher.ts", mode: "100644", blobSha: "d".repeat(40), contentSha256: `0x${"d".repeat(64)}`, byteLength: 1, language: "typescript", fileClass: "production-runtime" },
  ];
  const runtimeDiagnostics: BoundaryDiagnostic[] = [];
  validateProductionRuntimeClosures(runtimeReceipt, runtimeFiles, runtimeDiagnostics);
  assert.ok(runtimeDiagnostics.some((item) => item.code === "release-runtime-imports-test-fixture"), JSON.stringify(runtimeDiagnostics));
});

test("generated BOM binds resolver values to exact named evaluator imports", async () => {
  const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { RELEASE_ROLE_MANIFEST: manifest } = await import(new URL("../../../acceptance/gate-core/src/generated/release-role-manifest.ts", import.meta.url).href) as { readonly RELEASE_ROLE_MANIFEST: ReleaseRoleManifestV1 };
  const root = mkdtempSync(join(tmpdir(), "aloha-generated-bom-identity-"));
  try {
    const paths = [
      "acceptance/gate-core/src/index.ts",
      "acceptance/gate-core/src/release-composition.ts",
      "acceptance/gate-core/src/predicate-composition.ts",
      "acceptance/gate-core/src/predicates/artifact-lineage.ts",
      "acceptance/gate-core/src/generated/predicate-composition.ts",
      "acceptance/gate-core/src/generated/release-authority.ts",
      "acceptance/gate-core/src/generated/release-role-manifest.ts",
      "acceptance/gate-core/src/generated/release-runtime.ts",
      ...manifest.predicateAdapters.map((entry) => entry.oracleModulePath),
    ];
    const files: TrackedFile[] = [];
    for (const path of [...new Set(paths)]) {
      const source = readFileSync(join(sourceRoot, path));
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
      files.push({
        path,
        mode: "100644",
        blobSha: "0".repeat(40),
        contentSha256: sha256(source),
        byteLength: source.byteLength,
        language: "typescript",
        fileClass: path.includes("/generated/") ? "generated" : path.startsWith("acceptance/gate-core/") ? "acceptance-pure-core" : "acceptance-pure-core",
      });
    }
    const baseline = validateReleaseRoleManifest({ gitRoot: root, files, implementationClosures: [] }, manifest);
    assert.ok(!baseline.some((item) => item.code === "release-bom-generated-evaluator-identity"));
    const compositionPath = join(root, "acceptance/gate-core/src/generated/predicate-composition.ts");
    writeFileSync(compositionPath, readFileSync(compositionPath, "utf8").replace("evaluator: predicateEvaluator0", "evaluator: fakeEvaluator"));
    const mutated = validateReleaseRoleManifest({ gitRoot: root, files, implementationClosures: [] }, manifest);
    assert.ok(mutated.some((item) => item.code === "release-bom-generated-evaluator-identity"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default production boundary rejects deletion of the complete GateCore release tree", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-release-tree-deleted-"));
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    runGit("init", "-b", "codex/release-tree-deleted-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "release-tree-deleted-fixture", private: true, type: "module" }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("release-tree-deleted-fixture"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true }, include: ["src/**/*.ts"] }));
    writeFileSync(join(root, "src", "index.ts"), "export const value = 1;\n");
    runGit("add", ".");
    runGit("commit", "-m", "release tree deleted fixture");

    const receipt = runBoundaryGate({ gitRoot: root });
    assert.equal(receipt.verdict, "invalid");
    const codes = new Set(receipt.diagnostics.map((item) => item.code));
    assert.ok(codes.has("gate-core-package-required"), JSON.stringify(receipt.diagnostics));
    assert.ok(codes.has("release-generated-output-set"), JSON.stringify(receipt.diagnostics));
    assert.ok(codes.has("release-generation-ledger-missing"), JSON.stringify(receipt.diagnostics));
    assert.ok(codes.has("release-role-manifest-required"), JSON.stringify(receipt.diagnostics));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureHashDomain(domain: string, value: unknown): string {
  return `0x${createHash("sha256").update(domain).update("\0").update(canonicalFixture(value)).digest("hex")}`;
}

function writeGeneratedReleaseManifestFixture(root: string, manifest: ReleaseRoleManifestV1): void {
  const outputPath = "release-role-manifest.generated.json";
  const generatorPath = "acceptance/release-fixture-generator.ts";
  writeFileSync(join(root, outputPath), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(root, generatorPath), "export const releaseFixtureGenerator = 1;\n");
  const outputs = [
    "acceptance/gate-core/src/generated/release-authority.ts",
    "acceptance/gate-core/src/generated/predicate-composition.ts",
    "acceptance/gate-core/src/generated/release-runtime.ts",
    outputPath,
  ].sort();
  const generators = [generatorPath];
  writeFileSync(join(root, "generated-manifest.json"), `${JSON.stringify({
    generators,
    manifestHash: fixtureHashDomain("aloha/boundary/generated-manifest/v1", { path: "generated-manifest.json", outputs, generators }),
    outputs,
  }, null, 2)}\n`);
}

test("every loader mutation is checked independently against an exact diagnostic multiset", () => {
  const results = verifyMutationCorpus();
  assert.equal(results.length, MUTATION_CORPUS.length);
  assert.ok(results.every((result) => result.pass), JSON.stringify(results));
  for (const result of results) {
    assert.deepEqual(result.actual, result.expected, result.caseId);
  }
});

test("AST loader guard rejects aliases and accepts no guessed dynamic target", () => {
  const source = [
    "import { createRequire } from 'node:module';",
    "const req = createRequire(import.meta.url);",
    "const load = req;",
    "load('./safe.js' + suffix);",
    "new Worker('./worker.js' + suffix);",
  ].join("\n");
  const codes = inspectSourceText("fixture/aliases.ts", source).diagnostics.map((item) => item.code);
  assert.deepEqual(codes.sort(), ["ambiguous-loader-alias", "worker-nonliteral"]);
});

test("boundary receipt exposes source/build facts only and never claims runtime legacy=0", () => {
  const receipt = runBoundaryGate({ requirePushed: false });
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.candidate.gitRoot, repoRoot);
  assert.ok(receipt.denominator.files.length > 0);
  assert.ok(receipt.denominator.files.every((file) =>
    /^0x[0-9a-f]{64}$/.test(file.contentSha256)
    || receipt.diagnostics.some((item) => item.code === "tracked-file-missing" && item.path === file.path)
  ));
  assert.ok(receipt.compiler.configPaths.length > 0);
  assert.ok(receipt.compiler.externalDependencies.includes("node:crypto"));
  assert.match(receipt.denominator.scannedFileSetRoot, /^0x[0-9a-f]{64}$/);
  assert.match(receipt.denominator.manifestRoot, /^0x[0-9a-f]{64}$/);
  assert.match(receipt.compiler.configRoots, /^0x[0-9a-f]{64}$/);
  assert.match(receipt.compiler.compilerVersionRoot, /^0x[0-9a-f]{64}$/);
  assert.match(receipt.compiler.graphRoot, /^0x[0-9a-f]{64}$/);
  assert.equal(receipt.claims.runtimeLegacyZero, "not-asserted");
  assert.equal(receipt.claims.productionAuthority, "not-observed");
  assert.ok(receipt.implementationClosures.length > 0);
  assert.ok(receipt.implementationClosures.some((closure) => closure.kind === "compiler-root"));
  assert.ok(receipt.implementationClosures.some((closure) => closure.kind === "package-entrypoint"));
  for (const closure of receipt.implementationClosures) {
    assert.ok(!JSON.stringify(closure).includes(repoRoot));
    assert.match(closure.closureDigest, /^0x[0-9a-f]{64}$/);
    assert.match(closure.tsconfigRoot, /^0x[0-9a-f]{64}$/);
    assert.match(closure.optionsRoot, /^0x[0-9a-f]{64}$/);
    assert.match(closure.packageManifestRoot, /^0x[0-9a-f]{64}$/);
    assert.match(closure.externalDependencyRoot, /^0x[0-9a-f]{64}$/);
    assert.equal(computeProgramInputSetRoot(closure.programInputs), closure.programInputSetRoot);
    assert.ok(closure.programInputs.every((input) => !isAbsolute(input.logicalPath)));
    assert.ok(closure.files.every((file) => /^[0-9a-f]{40}$/.test(file.blobSha) && /^0x[0-9a-f]{64}$/.test(file.contentSha256) && file.byteLength >= 0));
  }
  const actualInputClosure = receipt.implementationClosures.find((closure) =>
    closure.programInputs.some((input) => input.kind === "typescript-lib") &&
    closure.programInputs.some((input) => input.kind === "typescript-compiler"));
  assert.ok(actualInputClosure);
  for (const closure of receipt.implementationClosures) {
    const usesNodeBuiltin = closure.edges.some((edge) => edge.specifier.startsWith("node:"));
    const runtimeInput = closure.programInputs.find((input) => input.kind === "node-runtime");
    assert.equal(Boolean(runtimeInput), usesNodeBuiltin, closure.entrypointId);
    if (runtimeInput) {
      assert.equal(runtimeInput.packageName, "node");
      assert.equal(runtimeInput.packageVersion, process.version);
      assert.equal(runtimeInput.contentSha256, sha256(readFileSync(process.execPath)));
    }
  }
  const typescriptRoot = dirname(dirname(ts.sys.getExecutingFilePath()));
  for (const kind of ["typescript-lib", "typescript-compiler"] as const) {
    const compilerInput: ImplementationCompilerInput | undefined = actualInputClosure.programInputs.find((candidate) => candidate.kind === kind);
    assert.ok(compilerInput?.packageRelativePath);
    const actualBytes: Buffer = readFileSync(join(typescriptRoot, compilerInput.packageRelativePath));
    assert.equal(compilerInput.contentSha256, sha256(actualBytes));
    const mutatedBytes = Buffer.concat([actualBytes, Buffer.from("\n")]);
    const mutatedInputs = actualInputClosure.programInputs.map((candidate) => candidate.logicalPath === compilerInput.logicalPath ? {
      ...candidate,
      contentSha256: sha256(mutatedBytes),
      compilerTextSha256: candidate.compilerTextSha256 === null ? null : sha256(mutatedBytes),
      byteLength: mutatedBytes.byteLength,
    } : candidate);
    const mutatedProgramInputSetRoot = computeProgramInputSetRoot(mutatedInputs);
    assert.notEqual(mutatedProgramInputSetRoot, actualInputClosure.programInputSetRoot);
    assert.notEqual(recomputeImplementationClosureDigest({
      ...actualInputClosure,
      programInputs: mutatedInputs,
      programInputSetRoot: mutatedProgramInputSetRoot,
    }), actualInputClosure.closureDigest);
  }
  assert.ok(receipt.diagnostics.every((item) => item.path.length > 0));
});

test("release roles are compiler closures and unrelated predicate leaves only move the role root", () => {
  const boundarySource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(boundarySource, /readonly\s+releaseRoleManifest\?\s*:/);
  const root = mkdtempSync(join(tmpdir(), "aloha-release-closures-"));
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const roles = {
    genericCoreEntrypointId: "compiler-root:tsconfig.json:acceptance/gate-core/src/index.ts",
    predicateAdapterEntrypointIds: ["compiler-root:tsconfig.json:acceptance/gate-core/src/predicates/one.ts"],
    qualificationOracleEntrypointId: "compiler-root:tsconfig.json:acceptance/artifact-lineage-facts/src/reference-model.ts",
    releaseRuntimeEntrypointId: "package-entrypoint:package.json:.:acceptance/gate-core/src/generated/release-runtime.ts:tsconfig.json",
  } as const;
  const predicateOnePath = "acceptance/gate-core/src/predicates/one.ts";
  const predicateOneExport = "PREDICATE_EVALUATOR";
  const oracleOnePath = "acceptance/artifact-lineage-facts/src/reference-model.ts";
  const oracleOneExport = "evaluateArtifactLineageOracle";
  const predicateOneSource = "export const PREDICATE_EVALUATOR = Object.freeze({ predicateId: 'fixture.predicate', predicateSpec: { specDigest: '0x" + "2".repeat(64) + "' }, evaluateLive() { return 'pass'; }, adapterVersion: 'fixture-adapter-v1', predicateProgramDescriptorDigest: '0x" + "3".repeat(64) + "', oracleProgramDescriptorDigest: '0x" + "4".repeat(64) + "' });\nexport const PREDICATE_EVALUATOR_ALTERNATE = PREDICATE_EVALUATOR;\n";
  const oracleOneSource = "import { oracleHelper } from './oracle-helper.ts'; export const ORACLE_PROGRAM_DESCRIPTOR_DIGEST = '0x" + "4".repeat(64) + "'; export const ORACLE_VERSION = 'fixture-oracle-v1'; export function evaluateArtifactLineageOracle(_claim: unknown, _observation: unknown, _facts: unknown): unknown { return oracleHelper; } export const evaluateArtifactLineageOracleAlternate = evaluateArtifactLineageOracle;\n";
  const predicateOneExportDigest = computeImplementationExportDigest(predicateOnePath, predicateOneExport, sha256(Buffer.from(predicateOneSource)));
  const oracleOneExportDigest = computeImplementationExportDigest(oracleOnePath, oracleOneExport, sha256(Buffer.from(oracleOneSource)));
  const leafOneInput = {
    modulePath: predicateOnePath,
    exportName: predicateOneExport,
    predicateId: "fixture.predicate",
    predicateSpecDigest: `0x${"2".repeat(64)}`,
    predicateProgramDescriptorDigest: `0x${"3".repeat(64)}`,
    oracleProgramDescriptorDigest: `0x${"4".repeat(64)}`,
    adapterVersion: "fixture-adapter-v1",
    oracleVersion: "fixture-oracle-v1",
    predicateImplementationExportDigest: predicateOneExportDigest,
    oracleImplementationExportDigest: oracleOneExportDigest,
    oracleModulePath: oracleOnePath,
    oracleExportName: oracleOneExport,
  };
  const leafOne = computePredicateCompositionLeafDigest(leafOneInput);
  const manifestBase = {
    schemaVersion: 1 as const,
    genericCore: { entrypointId: roles.genericCoreEntrypointId, modulePath: "acceptance/gate-core/src/index.ts", exportName: "evaluateGateCoreRuntime" },
    predicateAdapters: [{
      entrypointId: roles.predicateAdapterEntrypointIds[0]!,
      ...leafOneInput,
      compositionLeafDigest: leafOne,
      oracleEntrypointId: roles.qualificationOracleEntrypointId,
    }],
    releaseRuntime: { entrypointId: roles.releaseRuntimeEntrypointId, modulePath: "acceptance/gate-core/src/generated/release-runtime.ts", exportName: "evaluateGateCore" },
    predicateCompositionRootDigest: computePredicateCompositionRootDigest([leafOne]),
  };
  const manifest = { ...manifestBase, rootDigest: computeReleaseRoleManifestRootDigest(manifestBase) } satisfies ReleaseRoleManifestV1;
  try {
    runGit("init", "-b", "codex/release-closures-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "acceptance", "gate-core", "src", "predicates"), { recursive: true });
    mkdirSync(join(root, "acceptance", "gate-core", "src", "generated"), { recursive: true });
    mkdirSync(join(root, "acceptance", "artifact-lineage-facts", "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "release-closures-fixture", private: true, type: "module", exports: { ".": "./acceptance/gate-core/src/generated/release-runtime.ts" } }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("release-closures-fixture"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true },
      include: ["acceptance/**/*.ts"],
    }));
    writeFileSync(join(root, "acceptance", "gate-core", "src", "index.ts"), "export function createReleaseAuthorityUnavailableResult(): unknown { return null; } export function evaluateGateCoreRuntime(_authority: unknown, _input: unknown, _composition: unknown, _now: string): unknown { return null; }\n");
    writeFileSync(join(root, predicateOnePath), predicateOneSource);
    writeFileSync(join(root, "acceptance", "artifact-lineage-facts", "src", "oracle-helper.ts"), "export const oracleHelper = 1;\n");
    writeFileSync(join(root, oracleOnePath), oracleOneSource);
    writeFileSync(join(root, "acceptance", "gate-core", "src", "release-composition.ts"), "import { PREDICATE_EVALUATOR } from './predicates/one.ts';\nconst PREDICATE_ENTRY_ONE = Object.freeze({ predicateId: 'fixture.predicate', predicateSpecDigest: '0x" + "2".repeat(64) + "', predicateProgramDescriptorDigest: '0x" + "3".repeat(64) + "', oracleProgramDescriptorDigest: '0x" + "4".repeat(64) + "', adapterVersion: 'fixture-adapter-v1', oracleVersion: 'fixture-oracle-v1', compositionLeafDigest: '" + leafOne + "', modulePath: 'acceptance/gate-core/src/predicates/one.ts', exportName: 'PREDICATE_EVALUATOR', oracleModulePath: 'acceptance/artifact-lineage-facts/src/reference-model.ts', oracleExportName: 'evaluateArtifactLineageOracle' });\nexport const RELEASE_ROLE_COMPOSITION = Object.freeze({ schemaVersion: 1, genericCore: {}, releaseRuntime: {}, predicateAdapters: [PREDICATE_ENTRY_ONE] });\nexport const PREDICATE_COMPOSITION_ENTRIES = Object.freeze([PREDICATE_ENTRY_ONE]);\nexport const PREDICATE_COMPOSITION_ROOT_DIGEST = '" + manifest.predicateCompositionRootDigest + "';\nexport function resolvePredicateEvaluator(id: string): unknown { return id === 'fixture.predicate' ? PREDICATE_EVALUATOR : null; }\n");
    writeFileSync(join(root, "acceptance", "gate-core", "src", "generated", "release-authority.ts"), "export const RELEASE_AUTHORITY: unknown = null;\n");
    writeFileSync(join(root, "acceptance", "gate-core", "src", "generated", "predicate-composition.ts"), "export { PREDICATE_COMPOSITION_ROOT_DIGEST, resolvePredicateEvaluator } from '../release-composition.ts';\n");
    writeFileSync(join(root, "acceptance", "gate-core", "src", "generated", "release-runtime.ts"), "import { createReleaseAuthorityUnavailableResult, evaluateGateCoreRuntime } from '../index.ts'; import { PREDICATE_COMPOSITION_ROOT_DIGEST, resolvePredicateEvaluator } from './predicate-composition.ts'; import { RELEASE_AUTHORITY } from './release-authority.ts'; const RELEASE_COMPOSITION = Object.freeze({ rootDigest: PREDICATE_COMPOSITION_ROOT_DIGEST, resolve: resolvePredicateEvaluator }); export function evaluateGateCore(untrustedInput: unknown): unknown { if (RELEASE_AUTHORITY === null) return createReleaseAuthorityUnavailableResult(); const nowUnixNs = (BigInt(Date.now()) * 1_000_000n).toString(); return evaluateGateCoreRuntime(RELEASE_AUTHORITY, untrustedInput, RELEASE_COMPOSITION, nowUnixNs); }\n");
    writeGeneratedReleaseManifestFixture(root, manifest);
    runGit("add", ".");
    runGit("commit", "-m", "release closure fixture");
    const baseline = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(baseline.verdict, "invalid");
    assert.ok(baseline.diagnostics.some((item) => item.code === "generated-regeneration-contract-missing"));
    assert.ok(baseline.releaseClosures);
    assert.deepEqual(validateReleaseClosureFacts(baseline, baseline.releaseClosures), []);
    const callerSelected = deriveReleaseClosureFacts(baseline, roles as unknown as ReleaseRoleManifestV1);
    assert.equal(callerSelected.facts, null);
    assert.ok(callerSelected.diagnostics.some((item) => item.code === "release-role-manifest-required"));
    const baselineFacts = baseline.releaseClosures;
    const baselineOne = baselineFacts.predicateAdapters[0];
    assert.ok(baselineOne);

    for (const mutation of [
      { field: "exportName" as const, value: "PREDICATE_EVALUATOR_ALTERNATE", expected: "release-predicate-export-digest-mismatch" },
      { field: "oracleExportName" as const, value: "evaluateArtifactLineageOracleAlternate", expected: "release-oracle-export-digest-mismatch" },
    ]) {
      const { rootDigest: _rootDigest, ...withoutRoot } = manifest;
      const mutatedBase = {
        ...withoutRoot,
        predicateAdapters: manifest.predicateAdapters.map((entry) => ({ ...entry, [mutation.field]: mutation.value })),
      };
      const mutatedManifest = { ...mutatedBase, rootDigest: computeReleaseRoleManifestRootDigest(mutatedBase) };
      const mutationDiagnostics = validateReleaseRoleManifest({
        gitRoot: root,
        files: baseline.denominator.files,
        implementationClosures: baseline.implementationClosures,
      }, mutatedManifest);
      assert.ok(mutationDiagnostics.some((item) => item.code === mutation.expected), JSON.stringify(mutationDiagnostics));
      assert.ok(mutationDiagnostics.some((item) => item.code === "release-bom-leaf-mismatch"), JSON.stringify(mutationDiagnostics));
    }

    const baselineRuntimeSource = readFileSync(join(root, "acceptance", "gate-core", "src", "generated", "release-runtime.ts"), "utf8");
    writeFileSync(join(root, "acceptance", "gate-core", "src", "generated", "release-runtime.ts"), baselineRuntimeSource.replace(
      "if (RELEASE_AUTHORITY === null) return createReleaseAuthorityUnavailableResult(); const nowUnixNs = (BigInt(Date.now()) * 1_000_000n).toString(); return evaluateGateCoreRuntime(RELEASE_AUTHORITY, untrustedInput, RELEASE_COMPOSITION, nowUnixNs);",
      "return { verdict: 'pass' };",
    ));
    runGit("add", ".");
    runGit("commit", "-m", "reject fake public release result");
    const fakePass = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.ok(fakePass.diagnostics.some((item) => item.code === "release-runtime-public-wrapper" || item.code === "release-runtime-strict-call"));
    writeFileSync(join(root, "acceptance", "gate-core", "src", "generated", "release-runtime.ts"), baselineRuntimeSource);
    runGit("add", ".");
    runGit("commit", "-m", "restore strict public release wrapper");

    const authorityPath = join(root, "acceptance", "gate-core", "src", "generated", "release-authority.ts");
    const baselineAuthoritySource = readFileSync(authorityPath, "utf8");
    writeFileSync(authorityPath, baselineAuthoritySource.replace("= null", "= {}"));
    runGit("add", ".");
    runGit("commit", "-m", "reject non-null generated authority");
    const forgedAuthority = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.ok(forgedAuthority.diagnostics.some((item) => item.code === "release-authority-not-null"));
    writeFileSync(authorityPath, baselineAuthoritySource);
    runGit("add", ".");
    runGit("commit", "-m", "restore null generated authority");

    mkdirSync(join(root, "acceptance", "gate-core", "src", "predicates"), { recursive: true });
    const predicateTwoPath = "acceptance/gate-core/src/predicates/two.ts";
    const predicateTwoExport = "PREDICATE_TWO";
    const oracleTwoPath = "acceptance/artifact-lineage-facts/src/oracle-two.ts";
    const oracleTwoExport = "evaluateArtifactLineageOracleTwo";
    const predicateTwoSource = "export const PREDICATE_TWO = Object.freeze({ predicateId: 'fixture.predicate.two', predicateSpec: { specDigest: '0x" + "6".repeat(64) + "' }, evaluateLive() { return 'pass'; }, adapterVersion: 'fixture-adapter-v2', predicateProgramDescriptorDigest: '0x" + "7".repeat(64) + "', oracleProgramDescriptorDigest: '0x" + "8".repeat(64) + "' });\n";
    const oracleTwoSource = "export const ORACLE_PROGRAM_DESCRIPTOR_DIGEST = '0x" + "8".repeat(64) + "'; export const ORACLE_VERSION = 'fixture-oracle-v2'; export function evaluateArtifactLineageOracleTwo(_claim: unknown, _observation: unknown, _facts: unknown): unknown { return 2; }\n";
    const predicateTwoExportDigest = computeImplementationExportDigest(predicateTwoPath, predicateTwoExport, sha256(Buffer.from(predicateTwoSource)));
    const oracleTwoExportDigest = computeImplementationExportDigest(oracleTwoPath, oracleTwoExport, sha256(Buffer.from(oracleTwoSource)));
    const leafTwoInput = {
      modulePath: predicateTwoPath,
      exportName: predicateTwoExport,
      predicateId: "fixture.predicate.two",
      predicateSpecDigest: `0x${"6".repeat(64)}`,
      predicateProgramDescriptorDigest: `0x${"7".repeat(64)}`,
      oracleProgramDescriptorDigest: `0x${"8".repeat(64)}`,
      adapterVersion: "fixture-adapter-v2",
      oracleVersion: "fixture-oracle-v2",
      predicateImplementationExportDigest: predicateTwoExportDigest,
      oracleImplementationExportDigest: oracleTwoExportDigest,
      oracleModulePath: oracleTwoPath,
      oracleExportName: oracleTwoExport,
    };
    const leafTwo = computePredicateCompositionLeafDigest(leafTwoInput);
    writeFileSync(join(root, predicateTwoPath), predicateTwoSource);
    writeFileSync(join(root, oracleTwoPath), oracleTwoSource);
    const expandedRoot = computePredicateCompositionRootDigest([leafOne, leafTwo]);
    writeFileSync(join(root, "acceptance", "gate-core", "src", "release-composition.ts"), "import { PREDICATE_EVALUATOR } from './predicates/one.ts'; import { PREDICATE_TWO } from './predicates/two.ts';\nconst PREDICATE_ENTRY_ONE = Object.freeze({ predicateId: 'fixture.predicate', predicateSpecDigest: '0x" + "2".repeat(64) + "', predicateProgramDescriptorDigest: '0x" + "3".repeat(64) + "', oracleProgramDescriptorDigest: '0x" + "4".repeat(64) + "', adapterVersion: 'fixture-adapter-v1', oracleVersion: 'fixture-oracle-v1', compositionLeafDigest: '0x1111111111111111111111111111111111111111111111111111111111111111', modulePath: 'acceptance/gate-core/src/predicates/one.ts', exportName: 'PREDICATE_EVALUATOR', oracleModulePath: 'acceptance/artifact-lineage-facts/src/reference-model.ts', oracleExportName: 'evaluateArtifactLineageOracle' });\nconst PREDICATE_ENTRY_TWO = Object.freeze({ predicateId: 'fixture.predicate.two', predicateSpecDigest: '0x" + "6".repeat(64) + "', predicateProgramDescriptorDigest: '0x" + "7".repeat(64) + "', oracleProgramDescriptorDigest: '0x" + "8".repeat(64) + "', adapterVersion: 'fixture-adapter-v2', oracleVersion: 'fixture-oracle-v2', compositionLeafDigest: '0x5555555555555555555555555555555555555555555555555555555555555555', modulePath: 'acceptance/gate-core/src/predicates/two.ts', exportName: 'PREDICATE_TWO', oracleModulePath: 'acceptance/artifact-lineage-facts/src/oracle-two.ts', oracleExportName: 'evaluateArtifactLineageOracleTwo' });\nexport const RELEASE_ROLE_COMPOSITION = Object.freeze({ schemaVersion: 1, genericCore: {}, releaseRuntime: {}, predicateAdapters: [PREDICATE_ENTRY_ONE, PREDICATE_ENTRY_TWO] });\nexport const PREDICATE_COMPOSITION_ENTRIES = Object.freeze([PREDICATE_ENTRY_ONE, PREDICATE_ENTRY_TWO]);\nexport const PREDICATE_COMPOSITION_ROOT_DIGEST = '" + expandedRoot + "';\nexport function resolvePredicateEvaluator(id: string): unknown { return id === 'fixture.predicate' ? PREDICATE_EVALUATOR : id === 'fixture.predicate.two' ? PREDICATE_TWO : null; }\n");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true },
      include: ["acceptance/**/*.ts"],
    }));
    runGit("add", ".");
    runGit("commit", "-m", "add unrelated predicate leaf");
    const { rootDigest: _baselineManifestRoot, ...manifestWithoutRoot } = manifest;
    const expandedManifestBase = {
      ...manifestWithoutRoot,
      predicateAdapters: [
        ...manifest.predicateAdapters,
        { entrypointId: "compiler-root:tsconfig.json:acceptance/gate-core/src/predicates/two.ts", ...leafTwoInput, compositionLeafDigest: leafTwo, oracleEntrypointId: "compiler-root:tsconfig.json:acceptance/artifact-lineage-facts/src/oracle-two.ts" },
      ].sort((left, right) => left.predicateId.localeCompare(right.predicateId)),
      predicateCompositionRootDigest: expandedRoot,
    };
    const expandedManifest = { ...expandedManifestBase, rootDigest: computeReleaseRoleManifestRootDigest(expandedManifestBase) } satisfies ReleaseRoleManifestV1;
    writeGeneratedReleaseManifestFixture(root, expandedManifest);
    runGit("add", ".");
    runGit("commit", "-m", "regenerate expanded release roles");
    const expanded = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(expanded.verdict, "invalid");
    assert.ok(expanded.diagnostics.some((item) => item.code === "generated-regeneration-contract-missing"));
    assert.ok(expanded.releaseClosures);
    assert.equal(expanded.releaseClosures.genericCore.closureDigest, baselineFacts.genericCore.closureDigest);
    assert.equal(expanded.releaseClosures.qualificationOracles[0]?.closureDigest, baselineFacts.qualificationOracles[0]?.closureDigest);
    assert.equal(expanded.releaseClosures.predicateAdapters[0]?.closureDigest, baselineOne.closureDigest);
    assert.notEqual(expanded.releaseClosures.releaseRuntime.closureDigest, baselineFacts.releaseRuntime.closureDigest);
    assert.notEqual(expanded.releaseClosures.rootDigest, baselineFacts.rootDigest);
    const tampered = { ...baselineFacts, genericCore: { ...baselineFacts.genericCore, closureDigest: `0x${"0".repeat(64)}` } };
    assert.ok(validateReleaseClosureFacts(baseline, tampered).some((item) => item.code === "release-closure-fact-mismatch"));
    const genericClosure = baseline.implementationClosures.find((closure) => closure.entrypointId === baselineFacts.genericCore.entrypointId);
    assert.ok(genericClosure);
    const oracleHelper = baselineFacts.qualificationOracles[0]!.entrypoint.replace("reference-model.ts", "oracle-helper.ts");
    const genericWithOracleHelper = {
      ...genericClosure,
      files: [...genericClosure.files, { path: oracleHelper, blobSha: "a".repeat(40), contentSha256: `0x${"a".repeat(64)}`, byteLength: 1 }],
    };
    const genericWithOracleHelperDigest = recomputeImplementationClosureDigest(genericWithOracleHelper);
    const overlapReceipt = {
      ...baseline,
      implementationClosures: baseline.implementationClosures.map((closure) => closure.entrypointId === genericClosure.entrypointId
        ? { ...genericWithOracleHelper, closureDigest: genericWithOracleHelperDigest }
        : closure),
    };
    assert.ok(validateReleaseClosureFacts(overlapReceipt, baselineFacts).some((item) => item.code === "release-closure-role-overlap" && item.message.includes("oracle-helper.ts")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release BOM rejects duplicate IDs/leaves and cannot pin a heuristic runtime wrapper", () => {
  const leaf = `0x${"1".repeat(64)}`;
  const duplicateManifestBase = {
    schemaVersion: 1 as const,
    genericCore: { entrypointId: "core", modulePath: "acceptance/gate-core/src/index.ts", exportName: "evaluateGateCoreRuntime" },
    predicateAdapters: [
      { entrypointId: "predicate-a", modulePath: "acceptance/gate-core/src/predicates/a.ts", exportName: "A", predicateId: "same", predicateSpecDigest: `0x${"2".repeat(64)}`, predicateProgramDescriptorDigest: `0x${"4".repeat(64)}`, oracleProgramDescriptorDigest: `0x${"5".repeat(64)}`, adapterVersion: "adapter-a", oracleVersion: "oracle-a", compositionLeafDigest: leaf, predicateImplementationExportDigest: `0x${"8".repeat(64)}`, oracleImplementationExportDigest: `0x${"9".repeat(64)}`, oracleEntrypointId: "oracle-a", oracleModulePath: "qualification/a.ts", oracleExportName: "oracleA" },
      { entrypointId: "predicate-b", modulePath: "acceptance/gate-core/src/predicates/b.ts", exportName: "B", predicateId: "same", predicateSpecDigest: `0x${"3".repeat(64)}`, predicateProgramDescriptorDigest: `0x${"6".repeat(64)}`, oracleProgramDescriptorDigest: `0x${"7".repeat(64)}`, adapterVersion: "adapter-b", oracleVersion: "oracle-b", compositionLeafDigest: leaf, predicateImplementationExportDigest: `0x${"a".repeat(64)}`, oracleImplementationExportDigest: `0x${"b".repeat(64)}`, oracleEntrypointId: "oracle-b", oracleModulePath: "qualification/b.ts", oracleExportName: "oracleB" },
    ],
    releaseRuntime: { entrypointId: "runtime", modulePath: "acceptance/gate-core/src/not-release.ts", exportName: "evaluateGateCore" },
    predicateCompositionRootDigest: computePredicateCompositionRootDigest([leaf, leaf]),
  };
  const duplicateManifest = { ...duplicateManifestBase, rootDigest: computeReleaseRoleManifestRootDigest(duplicateManifestBase) } satisfies ReleaseRoleManifestV1;
  const diagnostics = validateReleaseRoleManifest({ gitRoot: tmpdir(), files: [], implementationClosures: [] }, duplicateManifest);
  const codes = diagnostics.map((item) => item.code);
  assert.ok(codes.includes("release-bom-predicate-id-duplicate"));
  assert.ok(codes.includes("release-bom-predicate-leaf-duplicate"));
  assert.ok(codes.includes("release-runtime-binding"));
  assert.ok(codes.includes("release-role-entrypoint-missing"));
});

test("assume-unchanged cannot splice compiler bytes away from the indexed denominator", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-boundary-"));
  const runGit = (...args: string[]) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    runGit("init", "-b", "codex/test");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "boundary-fixture",
      private: true,
      type: "module",
    }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("boundary-fixture"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
      },
      include: ["index.ts"],
    }));
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
    runGit("add", ".");
    runGit("commit", "-m", "fixture");
    assert.equal(runBoundaryGate({ gitRoot: root, requirePushed: false }).verdict, "pass");

    runGit("update-index", "--assume-unchanged", "index.ts");
    writeFileSync(join(root, "index.ts"), "export const value = 2;\n");
    const receipt = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(receipt.candidate.clean, true);
    assert.equal(receipt.verdict, "invalid");
    const codes = receipt.diagnostics.map((item) => item.code);
    assert.ok(codes.includes("noncanonical-index-flag"));
    assert.ok(codes.includes("worktree-index-content-mismatch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptance generated output is classified as generated and cannot evade its ledger or environment boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-acceptance-generated-"));
  const runGit = (...args: string[]) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    runGit("init", "-b", "codex/acceptance-generated-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "acceptance", "gate-core", "generated"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "acceptance-generated-fixture", private: true, type: "module" }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("acceptance-generated-fixture"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true },
      include: ["acceptance/**/*.ts"],
    }));
    writeFileSync(join(root, "acceptance", "gate-core", "generated", "predicate.ts"), "import fs from 'node:fs';\nexport const value = fs.readFileSync('/tmp/value');\n");
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "tools", "generate.ts"), "export const generate = 1;\n");
    const outputs = ["acceptance/gate-core/generated/predicate.ts"];
    const generators = ["tools/generate.ts"];
    writeFileSync(join(root, "generated-manifest.json"), `${JSON.stringify({
      generators,
      manifestHash: fixtureHashDomain("aloha/boundary/generated-manifest/v1", { path: "generated-manifest.json", outputs, generators }),
      outputs,
    })}\n`);
    runGit("add", ".");
    runGit("commit", "-m", "acceptance generated path fixture");

    const receipt = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(receipt.verdict, "invalid");
    assert.ok(receipt.diagnostics.some((item) => item.code === "governance-imports-external"));
    assert.ok(receipt.diagnostics.some((item) => item.code === "generated-regeneration-contract-missing"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dependency attacks cannot hide behind external edges or strategy/generated names", () => {
  const file = (path: string, fileClass: TrackedFile["fileClass"]): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass,
  });
  const files = [
    file("acceptance/core.ts", "acceptance-pure-core"),
    file("specs/frozen.ts", "central"),
    file("tools/reference-only/ref.ts", "reference-only"),
    file("strategies/arbitrage/index.ts", "strategy"),
    file("families/swap/index.ts", "family"),
    file("packages/core.ts", "central"),
    file("apps/searcher.ts", "production-runtime"),
    file("generated/runtime-composition.ts", "generated"),
    file("generated/family-catalog/index.ts", "generated"),
    file("acceptance/gate-core/src/generated/release-runtime.ts", "generated"),
    file("fixture/reference-input.ts", "reference-only"),
  ];
  const edges: GraphEdge[] = [
    { from: "acceptance/core.ts", to: "@external/lodash", specifier: "lodash" },
    { from: "specs/frozen.ts", to: "@external/node:fs", specifier: "node:fs" },
    { from: "tools/reference-only/ref.ts", to: "@external/foo", specifier: "foo" },
    { from: "tools/reference-only/ref.ts", to: "@external/node:fs", specifier: "node:fs" },
    { from: "apps/searcher.ts", to: "strategies/arbitrage/index.ts", specifier: "./strategy" },
    { from: "apps/searcher.ts", to: "generated/family-catalog/index.ts", specifier: "../generated/family-catalog" },
    { from: "apps/searcher.ts", to: "acceptance/gate-core/src/generated/release-runtime.ts", specifier: "@aloha/gate-core" },
    { from: "packages/core.ts", to: "generated/runtime-composition.ts", specifier: "./generated" },
    { from: "generated/runtime-composition.ts", to: "generated/family-catalog/index.ts", specifier: "../family-catalog" },
    { from: "fixture/reference-input.ts", to: "@external/foo", specifier: "foo" },
  ];
  const diagnostics: { code: string }[] = [];
  validateDependencyBoundaries(files, edges, diagnostics as never);
  assert.deepEqual(diagnostics.map((item) => item.code).sort(), [
    "central-imports-generated",
    "generated-consumer-boundary",
    "governance-imports-external",
    "governance-imports-external",
    "governance-imports-external",
    "runtime-imports-strategy",
  ]);
});

test("Strategy dependencies are neutral-only and default-deny runtime ownership", () => {
  const file = (path: string, fileClass: TrackedFile["fileClass"]): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass,
  });
  const files = [
    file("strategies/route-cycle/src/index.ts", "strategy"),
    file("packages/capability-contracts/src/index.ts", "central"),
    file("packages/canonical-codec/src/index.ts", "central"),
    file("packages/artifact-fingerprint/src/pure/index.ts", "central"),
    file("packages/family-sdk/runtime-refs/index.ts", "central"),
    file("packages/strategy-sdk/src/index.ts", "central"),
    file("specs/capability-index/src/index.ts", "central"),
    file("specs/release-intent/src/index.ts", "central"),
    file("packages/planner/src/index.ts", "central"),
    file("packages/state-runtime/src/index.ts", "central"),
    file("packages/solver/src/index.ts", "central"),
    file("specs/release-authority/src/index.ts", "central"),
    file("runtime/revm-workers/src/index.ts", "production-runtime"),
    file("tools/catalog-generator/src/index.ts", "authoring"),
    file("tools/reference-only/impl.ts", "reference-only"),
    file("families/swap/index.ts", "family"),
    file("acceptance/gate-core/src/index.ts", "acceptance-pure-core"),
  ];
  const edges: GraphEdge[] = [
    { from: "strategies/route-cycle/src/index.ts", to: "packages/capability-contracts/src/index.ts", specifier: "../../../packages/capability-contracts/src/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "packages/canonical-codec/src/index.ts", specifier: "../../../packages/canonical-codec/src/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "packages/artifact-fingerprint/src/pure/index.ts", specifier: "../../../packages/artifact-fingerprint/src/pure/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "packages/family-sdk/runtime-refs/index.ts", specifier: "../../../packages/family-sdk/runtime-refs/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "packages/strategy-sdk/src/index.ts", specifier: "../../../packages/strategy-sdk/src/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "specs/capability-index/src/index.ts", specifier: "../../../specs/capability-index/src/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "specs/release-intent/src/index.ts", specifier: "../../../specs/release-intent/src/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "packages/planner/src/index.ts", specifier: "../../../packages/planner/src/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "packages/state-runtime/src/index.ts", specifier: "../../../packages/state-runtime/src/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "packages/solver/src/index.ts", specifier: "../../../packages/solver/src/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "specs/release-authority/src/index.ts", specifier: "../../../specs/release-authority/src/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "runtime/revm-workers/src/index.ts", specifier: "../../../runtime/revm-workers/src/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "tools/catalog-generator/src/index.ts", specifier: "../../../tools/catalog-generator/src/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "tools/reference-only/impl.ts", specifier: "../../../tools/reference-only/impl.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "families/swap/index.ts", specifier: "../../../families/swap/index.ts" },
    { from: "strategies/route-cycle/src/index.ts", to: "acceptance/gate-core/src/index.ts", specifier: "../../../acceptance/gate-core/src/index.ts" },
  ];
  const diagnostics: { code: string }[] = [];
  validateDependencyBoundaries(files, edges, diagnostics as never);
  assert.deepEqual(diagnostics.map((item) => item.code).sort(), [
    "strategy-imports-family-or-acceptance",
    "strategy-imports-family-or-acceptance",
    "strategy-imports-forbidden-central",
    "strategy-imports-forbidden-central",
    "strategy-imports-forbidden-central",
    "strategy-imports-forbidden-central",
    "strategy-imports-noncontract",
    "strategy-imports-noncontract",
    "strategy-imports-runtime",
  ]);
});

test("Family and authority-constructor edges are default-deny and exact-owner only", () => {
  const file = (path: string, fileClass: TrackedFile["fileClass"]): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass,
  });
  const files = [
    file("families/swap/index.ts", "family"),
    file("runtime/revm-workers/src/lifecycle.ts", "production-runtime"),
    file("apps/searcher.ts", "production-runtime"),
    file("packages/ordinary.ts", "central"),
    file("packages/work-plane/src/index.ts", "central"),
    file("packages/work-plane/src/internal/family-execution-port.ts", "central"),
    file("packages/attestation/src/index.ts", "central"),
    file("packages/attestation/src/test-support.ts", "central"),
    file("packages/attestation/src/internal-authority.ts", "central"),
    file("packages/attestation/src/internal/engine.ts", "central"),
    file("packages/attestation/src/internal/composition-resolution.ts", "central"),
    file("packages/attestation/src/internal/composition.ts", "central"),
    file("packages/attestation/src/internal/validation-authority-state.ts", "central"),
    file("packages/attestation/src/internal/validation-authority-issuer.ts", "central"),
    file("packages/attestation/src/internal/validation-authority-verifier.ts", "central"),
    file("packages/checkpoint/src/index.ts", "central"),
    file("packages/durable-store/src/index.ts", "central"),
    file("packages/scheduler/src/index.ts", "central"),
    file("packages/checkpoint/src/candidate-partition.ts", "central"),
    file("packages/candidate-partition-runtime/src/internal/reader-state.ts", "central"),
    file("packages/candidate-partition-runtime/src/internal/reader-issuer.ts", "central"),
    file("packages/candidate-partition-runtime/src/internal/reader-consumer.ts", "central"),
    file("packages/future-authority/src/internal/qualified-authority.ts", "central"),
    file("packages/family-sdk/runtime-refs/index.ts", "central"),
    file("packages/capability-contracts/index.ts", "central"),
    file("packages/capability-contracts/src/internal/authority.ts", "central"),
    file("packages/canonical-codec/src/index.ts", "central"),
    file("packages/artifact-fingerprint/src/pure/index.ts", "central"),
    file("packages/artifact-fingerprint/src/index.ts", "central"),
    file("generated/not-runtime-composition.ts", "generated"),
  ];
  const edges: GraphEdge[] = [
    { from: "families/swap/index.ts", to: "runtime/revm-workers/src/lifecycle.ts", specifier: "../../runtime/revm-workers/src/lifecycle.ts" },
    { from: "families/swap/index.ts", to: "packages/future-authority/src/internal/qualified-authority.ts", specifier: "../../packages/future-authority/src/internal/qualified-authority.ts" },
    { from: "families/swap/index.ts", to: "packages/family-sdk/runtime-refs/index.ts", specifier: "../../packages/family-sdk/runtime-refs/index.ts" },
    { from: "families/swap/index.ts", to: "packages/capability-contracts/index.ts", specifier: "../../packages/capability-contracts/index.ts" },
    { from: "families/swap/index.ts", to: "packages/capability-contracts/src/internal/authority.ts", specifier: "../../packages/capability-contracts/src/internal/authority.ts" },
    { from: "families/swap/index.ts", to: "packages/canonical-codec/src/index.ts", specifier: "../../packages/canonical-codec/src/index.ts" },
    { from: "families/swap/index.ts", to: "packages/artifact-fingerprint/src/pure/index.ts", specifier: "../../packages/artifact-fingerprint/src/pure/index.ts" },
    { from: "families/swap/index.ts", to: "packages/artifact-fingerprint/src/index.ts", specifier: "../../packages/artifact-fingerprint/src/index.ts" },
    { from: "packages/ordinary.ts", to: "packages/future-authority/src/internal/qualified-authority.ts", specifier: "./future-authority/src/internal/qualified-authority.ts" },
    { from: "packages/ordinary.ts", to: "packages/checkpoint/src/index.ts", specifier: "./checkpoint/src/index.ts" },
    { from: "packages/work-plane/src/internal/family-execution-port.ts", to: "packages/work-plane/src/index.ts", specifier: "../index.ts" },
    { from: "packages/attestation/src/index.ts", to: "packages/attestation/src/internal-authority.ts", specifier: "./internal-authority.ts" },
    { from: "packages/attestation/src/internal/engine.ts", to: "packages/attestation/src/internal-authority.ts", specifier: "../internal-authority.ts" },
    { from: "packages/attestation/src/internal/composition-resolution.ts", to: "packages/attestation/src/internal-authority.ts", specifier: "../internal-authority.ts" },
    { from: "packages/attestation/src/internal/composition.ts", to: "packages/attestation/src/internal/engine.ts", specifier: "./engine.ts" },
    { from: "packages/attestation/src/internal/composition.ts", to: "packages/attestation/src/internal/composition-resolution.ts", specifier: "./composition-resolution.ts" },
    { from: "packages/attestation/src/internal/engine.ts", to: "packages/attestation/src/internal/validation-authority-issuer.ts", specifier: "./validation-authority-issuer.ts" },
    { from: "packages/attestation/src/internal/engine.ts", to: "packages/attestation/src/internal/validation-authority-state.ts", specifier: "./validation-authority-state.ts" },
    { from: "packages/attestation/src/internal/validation-authority-issuer.ts", to: "packages/attestation/src/internal/validation-authority-state.ts", specifier: "./validation-authority-state.ts" },
    { from: "packages/attestation/src/internal/validation-authority-verifier.ts", to: "packages/attestation/src/internal/validation-authority-state.ts", specifier: "./validation-authority-state.ts" },
    { from: "packages/checkpoint/src/index.ts", to: "packages/attestation/src/internal/validation-authority-verifier.ts", specifier: "../../attestation/src/internal/validation-authority-verifier.ts" },
    { from: "packages/checkpoint/src/index.ts", to: "packages/attestation/src/internal/validation-authority-issuer.ts", specifier: "../../attestation/src/internal/validation-authority-issuer.ts" },
    { from: "packages/checkpoint/src/candidate-partition.ts", to: "packages/candidate-partition-runtime/src/internal/reader-issuer.ts", specifier: "../../candidate-partition-runtime/src/internal/reader-issuer.ts" },
    { from: "packages/attestation/src/internal/engine.ts", to: "packages/candidate-partition-runtime/src/internal/reader-consumer.ts", specifier: "../../../candidate-partition-runtime/src/internal/reader-consumer.ts" },
    { from: "packages/ordinary.ts", to: "packages/candidate-partition-runtime/src/internal/reader-issuer.ts", specifier: "./candidate-partition-runtime/src/internal/reader-issuer.ts" },
    { from: "packages/attestation/src/test-support.ts", to: "packages/attestation/src/internal-authority.ts", specifier: "./internal-authority.ts" },
    { from: "packages/ordinary.ts", to: "packages/attestation/src/internal/engine.ts", specifier: "./attestation/src/internal/engine.ts" },
    { from: "apps/searcher.ts", to: "packages/attestation/src/internal-authority.ts", specifier: "../packages/attestation/src/internal-authority.ts" },
    { from: "apps/searcher.ts", to: "packages/attestation/src/index.ts", specifier: "../packages/attestation/src/index.ts" },
    { from: "apps/searcher.ts", to: "packages/attestation/src/internal/composition.ts", specifier: "../packages/attestation/src/internal/composition.ts" },
    { from: "generated/not-runtime-composition.ts", to: "packages/attestation/src/internal/composition.ts", specifier: "../packages/attestation/src/internal/composition.ts" },
    { from: "apps/searcher.ts", to: "packages/checkpoint/src/index.ts", specifier: "../packages/checkpoint/src/index.ts" },
    { from: "apps/searcher.ts", to: "packages/durable-store/src/index.ts", specifier: "../packages/durable-store/src/index.ts" },
    { from: "apps/searcher.ts", to: "packages/scheduler/src/index.ts", specifier: "../packages/scheduler/src/index.ts" },
  ];
  const diagnostics: BoundaryDiagnostic[] = [];
  validateDependencyBoundaries(files, edges, diagnostics);
  assert.deepEqual(diagnostics.map((item) => `${item.code}:${item.path}`).sort(), [
    "central-imports-authority-constructor:packages/attestation/src/test-support.ts",
    "central-imports-authority-constructor:packages/ordinary.ts",
    "central-imports-authority-constructor:packages/ordinary.ts",
    "central-imports-authority-constructor:packages/ordinary.ts",
    "central-imports-authority-constructor:packages/ordinary.ts",
    "central-imports-authority-constructor:packages/checkpoint/src/index.ts",
    "generated-imports-authority-constructor:generated/not-runtime-composition.ts",
    "family-imports-forbidden-central:families/swap/index.ts",
    "family-imports-forbidden-central:families/swap/index.ts",
    "family-imports-forbidden-central:families/swap/index.ts",
    "family-imports-runtime:families/swap/index.ts",
    "runtime-imports-authority-constructor:apps/searcher.ts",
    "runtime-imports-authority-constructor:apps/searcher.ts",
    "runtime-imports-authority-constructor:apps/searcher.ts",
    "runtime-imports-authority-constructor:apps/searcher.ts",
    "runtime-imports-authority-constructor:apps/searcher.ts",
  ].sort());
});

test("candidate partition authority edges bind exact named issuer and consumer imports", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-reader-authority-"));
  const checkpointPath = "packages/checkpoint/src/candidate-partition.ts";
  const issuerPath = "packages/candidate-partition-runtime/src/internal/reader-issuer.ts";
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: "central",
  });
  const edge: GraphEdge = {
    from: checkpointPath,
    to: issuerPath,
    specifier: "../../candidate-partition-runtime/src/internal/reader-issuer.ts",
  };
  mkdirSync(join(root, dirname(checkpointPath)), { recursive: true });
  try {
    const inspect = (source: string): readonly BoundaryDiagnostic[] => {
      writeFileSync(join(root, checkpointPath), source);
      const diagnostics: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries([file(checkpointPath), file(issuerPath)], [edge], diagnostics, root);
      return diagnostics;
    };
    assert.deepEqual(inspect(`import { issueCheckpointCandidatePartitionReader } from "${edge.specifier}";\n`), []);
    for (const source of [
      `import { assertIssuedCandidatePartitionReader } from "${edge.specifier}";\n`,
      `import { issueCheckpointCandidatePartitionReader as issue } from "${edge.specifier}";\n`,
      `import * as authority from "${edge.specifier}";\n`,
      `import { issueCheckpointCandidatePartitionReader, extra } from "${edge.specifier}";\n`,
    ]) {
      assert.ok(inspect(source).some(item => item.code === "authority-named-import-mismatch"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime release attestation composition binds exact owner and consumer imports", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-runtime-release-composition-"));
  const cases = [
    {
      ownerPath: "packages/runtime-release-authority/src/index.ts",
      authorityPath: "packages/runtime-release-authority/src/internal/state.ts",
      specifier: "./internal/state.ts",
      allowed: "registerRuntimeReleaseAuthority, stateForRuntimeReleaseCapability",
      forbidden: "assertIssuedRuntimeReleaseAuthorityState",
    },
    {
      ownerPath: "packages/runtime-release-authority/src/internal/authority-consumer.ts",
      authorityPath: "packages/runtime-release-authority/src/internal/state.ts",
      specifier: "./state.ts",
      allowed: "assertIssuedRuntimeReleaseAuthorityState",
      forbidden: "registerRuntimeReleaseAuthority",
    },
    {
      ownerPath: "packages/runtime-release-authority/src/internal/attestation-composition-consumer.ts",
      authorityPath: "packages/runtime-release-authority/src/internal/attestation-composition-owner.ts",
      specifier: "./attestation-composition-owner.ts",
      allowed: "readIssuedRuntimeReleaseAttestationComposition",
      forbidden: "issueRuntimeReleaseAttestationComposition",
    },
    {
      ownerPath: "packages/attestation/src/internal/composition-resolution.ts",
      authorityPath: "packages/runtime-release-authority/src/internal/attestation-composition-consumer.ts",
      specifier: "../../../runtime-release-authority/src/internal/attestation-composition-consumer.ts",
      allowed: "assertIssuedRuntimeReleaseAttestationComposition",
      forbidden: "readIssuedRuntimeReleaseAttestationComposition",
    },
    {
      ownerPath: "packages/runtime-release-authority/src/internal/attestation-proof-consumer.ts",
      authorityPath: "packages/runtime-release-authority/src/internal/attestation-proof-owner.ts",
      specifier: "./attestation-proof-owner.ts",
      allowed: "readIssuedRuntimeReleaseAttestationProof",
      forbidden: "issueRuntimeReleaseAttestationProofPort",
    },
  ] as const;
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: "central",
  });
  try {
    for (const value of cases) {
      const edge: GraphEdge = { from: value.ownerPath, to: value.authorityPath, specifier: value.specifier };
      mkdirSync(join(root, dirname(value.ownerPath)), { recursive: true });
      const inspect = (source: string): readonly BoundaryDiagnostic[] => {
        writeFileSync(join(root, value.ownerPath), source);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries([file(value.ownerPath), file(value.authorityPath)], [edge], diagnostics, root);
        return diagnostics;
      };
      assert.deepEqual(inspect(`import { ${value.allowed} } from "${value.specifier}";\n`), []);
      for (const source of [
        `import { ${value.forbidden} } from "${value.specifier}";\n`,
        `import { ${value.allowed.split(",")[0]} as authority } from "${value.specifier}";\n`,
        `import * as authority from "${value.specifier}";\n`,
        `import { ${value.allowed}, extra } from "${value.specifier}";\n`,
        `import type { ${value.allowed.split(",")[0]} } from "${value.specifier}";\n`,
      ]) {
        assert.ok(inspect(source).some(item => item.code === "authority-named-import-mismatch"));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sealed run authority edges bind exact named issuer and consumer imports", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-sealed-run-authority-"));
  const cases = [
    {
      ownerPath: "packages/checkpoint/src/sealed-run.ts",
      authorityPath: "packages/sealed-run-runtime/src/internal/reader-issuer.ts",
      specifier: "../../sealed-run-runtime/src/internal/reader-issuer.ts",
      allowed: "issueCheckpointSealedRunReader",
      forbidden: "assertCheckpointSealedRunReader",
    },
    {
      ownerPath: "packages/ready-generation/src/index.ts",
      authorityPath: "packages/sealed-run-runtime/src/internal/reader-consumer.ts",
      specifier: "../../sealed-run-runtime/src/internal/reader-consumer.ts",
      allowed: "assertCheckpointSealedRunReader",
      forbidden: "issueCheckpointSealedRunReader",
    },
  ] as const;
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: "central",
  });
  try {
    for (const value of cases) {
      const edge: GraphEdge = {
        from: value.ownerPath,
        to: value.authorityPath,
        specifier: value.specifier,
      };
      mkdirSync(join(root, dirname(value.ownerPath)), { recursive: true });
      const inspect = (source: string): readonly BoundaryDiagnostic[] => {
        writeFileSync(join(root, value.ownerPath), source);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries([file(value.ownerPath), file(value.authorityPath)], [edge], diagnostics, root);
        return diagnostics;
      };
      assert.deepEqual(inspect(`import { ${value.allowed} } from "${value.specifier}";\n`), []);
      for (const source of [
        `import { ${value.forbidden} } from "${value.specifier}";\n`,
        `import { ${value.allowed} as authority } from "${value.specifier}";\n`,
        `import * as authority from "${value.specifier}";\n`,
        `import { ${value.allowed}, extra } from "${value.specifier}";\n`,
      ]) {
        assert.ok(inspect(source).some(item => item.code === "authority-named-import-mismatch"));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduler/work-plane authority edges bind exact owner and consumer imports", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-scheduler-authority-"));
  const cases = [
    {
      ownerPath: "packages/scheduler/src/internal/authority-owner.ts",
      authorityPath: "packages/scheduler/src/internal/authority-state.ts",
      specifier: "./authority-state.ts",
      allowed: "registerQualifiedExecutorAuthorityIssuer",
      forbidden: "isQualifiedExecutorAuthorityIssuer",
    },
    {
      ownerPath: "packages/scheduler/src/internal/authority-consumer.ts",
      authorityPath: "packages/scheduler/src/internal/authority-state.ts",
      specifier: "./authority-state.ts",
      allowed: "isQualifiedExecutorAuthorityIssuer",
      forbidden: "registerQualifiedExecutorAuthorityIssuer",
    },
    {
      ownerPath: "packages/work-plane/src/internal/family-execution-port.ts",
      authorityPath: "packages/scheduler/src/internal/authority-consumer.ts",
      specifier: "../../../../packages/scheduler/src/internal/authority-consumer.ts",
      allowed: "assertIssuedQualifiedExecutorAuthorityIssuer",
      forbidden: "isQualifiedExecutorAuthorityIssuer",
    },
  ] as const;
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: "central",
  });
  try {
    for (const value of cases) {
      const edge: GraphEdge = {
        from: value.ownerPath,
        to: value.authorityPath,
        specifier: value.specifier,
      };
      mkdirSync(join(root, dirname(value.ownerPath)), { recursive: true });
      const inspect = (source: string): readonly BoundaryDiagnostic[] => {
        writeFileSync(join(root, value.ownerPath), source);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries([file(value.ownerPath), file(value.authorityPath)], [edge], diagnostics, root);
        return diagnostics;
      };
      assert.deepEqual(inspect(`import { ${value.allowed} } from "${value.specifier}";\n`), []);
      for (const source of [
        `import { ${value.forbidden} } from "${value.specifier}";\n`,
        `import { ${value.allowed} as authority } from "${value.specifier}";\n`,
        `import * as authority from "${value.specifier}";\n`,
        `import { ${value.allowed}, extra } from "${value.specifier}";\n`,
        `import type { ${value.allowed} } from "${value.specifier}";\n`,
      ]) {
        assert.ok(inspect(source).some(item => item.code === "authority-named-import-mismatch"));
      }
    }

    const directStateOwner = "packages/work-plane/src/internal/family-execution-port.ts";
    const directState = "packages/scheduler/src/internal/authority-state.ts";
    const directStateSpecifier = "../../../../packages/scheduler/src/internal/authority-state.ts";
    writeFileSync(join(root, directStateOwner), `import { registerQualifiedExecutorAuthorityIssuer } from "${directStateSpecifier}";\n`);
    const diagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(directStateOwner), file(directState)],
      [{ from: directStateOwner, to: directState, specifier: directStateSpecifier }],
      diagnostics,
      root,
    );
    assert.ok(diagnostics.some(item => item.code === "central-imports-authority-constructor"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("REVM imports only the exact lease projection and rejects full release authority", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-revm-narrow-port-"));
  const protocolPath = "runtime/revm-workers/src/protocol.ts";
  const specPath = "specs/release-authority/src/index.ts";
  const file = (path: string, fileClass: TrackedFile["fileClass"]): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass,
  });
  const specifier = "../../../specs/release-authority/src/index.ts";
  const edge: GraphEdge = { from: protocolPath, to: specPath, specifier };
  mkdirSync(join(root, dirname(protocolPath)), { recursive: true });
  try {
    const inspect = (source: string): readonly BoundaryDiagnostic[] => {
      writeFileSync(join(root, protocolPath), source);
      const diagnostics: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries([file(protocolPath, "production-runtime"), file(specPath, "central")], [edge], diagnostics, root);
      return diagnostics;
    };
    assert.deepEqual(inspect([
      "import {",
      "  decodeRuntimeReleaseExecutorLeaseV1,",
      "  type RuntimeReleaseExecutorLeaseV1,",
      `} from \"${specifier}\";`,
    ].join("\n")), []);
    const fullBinding = inspect(`import { decodeRuntimeReleaseBindingV1, type RuntimeReleaseBindingV1 } from \"${specifier}\";\n`);
    assert.ok(fullBinding.some((item) => item.code === "narrow-port-import-mismatch"), JSON.stringify(fullBinding));

    const otherRevmPath = "runtime/revm-workers/src/index.ts";
    const otherEdge: GraphEdge = { from: otherRevmPath, to: specPath, specifier };
    writeFileSync(join(root, otherRevmPath), `import type { RuntimeReleaseBindingV1 } from \"${specifier}\";\n`);
    const otherDiagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries([file(otherRevmPath, "production-runtime"), file(specPath, "central")], [otherEdge], otherDiagnostics, root);
    assert.ok(otherDiagnostics.some((item) => item.code === "revm-imports-full-release-binding"), JSON.stringify(otherDiagnostics));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner-issued guards and the private runtime-release join cannot be bypassed", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-private-authority-join-"));
  const readyPath = "packages/ready-generation/src/index.ts";
  const readyConsumerPath = "packages/runtime-release-authority/src/internal/ready-binding-consumer.ts";
  const readySpecifier = "../../runtime-release-authority/src/internal/ready-binding-consumer.ts";
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: "central",
  });
  mkdirSync(join(root, dirname(readyPath)), { recursive: true });
  try {
    writeFileSync(join(root, readyPath), `import { assertIssuedRuntimeReleaseReadyBindingPort } from \"${readySpecifier}\";\n`);
    const validDiagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(readyPath), file(readyConsumerPath)],
      [{ from: readyPath, to: readyConsumerPath, specifier: readySpecifier }],
      validDiagnostics,
      root,
    );
    assert.deepEqual(validDiagnostics, []);

    writeFileSync(join(root, readyPath), `import type { RuntimeReleaseReadyBindingPortV1 } from \"../../../specs/release-authority/src/index.ts\";\n`);
    const shapeDiagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(readyPath), file("specs/release-authority/src/index.ts")],
      [{ from: readyPath, to: "specs/release-authority/src/index.ts", specifier: "../../../specs/release-authority/src/index.ts" }],
      shapeDiagnostics,
      root,
    );
    assert.ok(shapeDiagnostics.some((item) => item.code === "ready-generation-imports-shape-only-release-port"), JSON.stringify(shapeDiagnostics));

    const missingGuard: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries([file(readyPath), file(readyConsumerPath)], [], missingGuard, root);
    assert.ok(missingGuard.some((item) => item.code === "authority-consumer-edge-missing"), JSON.stringify(missingGuard));

    const sources = new Map<string, string>([
      [
        "packages/runtime-release-authority/src/index.ts",
        [
          'export { buildRuntimeReleaseComposition } from "./internal/bootstrap.ts";',
          'export type { RuntimeReleaseCompositionServicesV1 } from "./internal/bootstrap.ts";',
        ].join("\n"),
      ],
      [
        "packages/runtime-release-authority/src/internal/bootstrap.ts",
        [
          "interface RuntimeReleaseCompositionServicesV1 {",
          "  readonly attestation: object; readonly checkpoint: object; readonly familyExecution: object; readonly ready: object; readonly release: object;",
          "}",
          "function composeRuntimeReleasePrivatePorts(): object { return {}; }",
          "function assertRuntimeReleasePrivatePortsCurrent(): void {}",
          "export function buildRuntimeReleaseComposition(): RuntimeReleaseCompositionServicesV1 {",
          "  composeRuntimeReleasePrivatePorts();",
          "  return Object.freeze({ attestation: {}, checkpoint: {}, familyExecution: {}, ready: {}, release: {} });",
          "}",
        ].join("\n"),
      ],
    ]);
    const bootstrapDiagnostics: BoundaryDiagnostic[] = [];
    validateRuntimeReleaseBootstrapSources(sources, bootstrapDiagnostics);
    assert.deepEqual(bootstrapDiagnostics, []);

    const leaked = new Map(sources);
    leaked.set("packages/runtime-release-authority/src/internal/bootstrap.ts", sources.get("packages/runtime-release-authority/src/internal/bootstrap.ts")!.replace(
      "return Object.freeze({ attestation: {}, checkpoint: {}, familyExecution: {}, ready: {}, release: {} });",
      "return Object.freeze({ authority, attestation: {}, checkpoint: {}, familyExecution: {}, ready: {}, release: {} });",
    ));
    const leakedDiagnostics: BoundaryDiagnostic[] = [];
    validateRuntimeReleaseBootstrapSources(leaked, leakedDiagnostics);
    assert.ok(leakedDiagnostics.some((item) => item.code === "runtime-release-bootstrap-leaks-private-port"), JSON.stringify(leakedDiagnostics));

    const exportedJoin = new Map(sources);
    exportedJoin.set("packages/runtime-release-authority/src/internal/bootstrap.ts", sources.get("packages/runtime-release-authority/src/internal/bootstrap.ts")!.replace(
      "function composeRuntimeReleasePrivatePorts",
      "export function composeRuntimeReleasePrivatePorts",
    ));
    const exportedJoinDiagnostics: BoundaryDiagnostic[] = [];
    validateRuntimeReleaseBootstrapSources(exportedJoin, exportedJoinDiagnostics);
    assert.ok(exportedJoinDiagnostics.some((item) => item.code === "runtime-release-bootstrap-private-join-export"), JSON.stringify(exportedJoinDiagnostics));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all candidate executor placeholders remain exact null and cannot execute fixtures", () => {
  const valid = [
    'import type { FamilyFrozenProgramExecutionPort } from "../index.ts";',
    "export const FAMILY_EXECUTION_PORT: FamilyFrozenProgramExecutionPort<unknown> | null = null;",
  ].join("\n");
  const diagnostics: BoundaryDiagnostic[] = [];
  validateFamilyExecutionCompositionSource(valid, diagnostics);
  assert.deepEqual(diagnostics, []);

  for (const source of [
    valid.replace("= null", "= { executeFrozenProgram: async () => ({}) }"),
    valid.replace("import type", "import").replace("= null", "= null"),
    `${valid}\nexport const FIXTURE_EXECUTOR = {};`,
  ]) {
    const mutationDiagnostics: BoundaryDiagnostic[] = [];
    validateFamilyExecutionCompositionSource(source, mutationDiagnostics);
    assert.ok(mutationDiagnostics.some((item) => item.code.startsWith("family-execution-composition-")), JSON.stringify(mutationDiagnostics));
  }
});

test("implementation closure contexts retain derived facts, never TypeScript Programs or AST caches", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const contextStart = source.indexOf("interface CompilerContext");
  const contextEnd = source.indexOf("interface SourceBuildGraphFacts", contextStart);
  assert.ok(contextStart >= 0 && contextEnd > contextStart);
  const contextSource = source.slice(contextStart, contextEnd);
  assert.doesNotMatch(contextSource, /ts\.Program|ts\.SourceFile|ProgramCache|SourceFileCache/);

  const builderStart = source.indexOf("function buildImplementationClosures(");
  const builderEnd = source.indexOf("/** Pure recomputation;", builderStart);
  assert.ok(builderStart >= 0 && builderEnd > builderStart);
  const builderSource = source.slice(builderStart, builderEnd);
  assert.doesNotMatch(builderSource, /entryProgramCache|entryProgramInputCache/);
  assert.doesNotMatch(builderSource, /Map\s*<\s*string\s*,\s*ts\.Program\s*>/);
  assert.doesNotMatch(builderSource, /Map\s*<\s*string\s*,\s*ts\.SourceFile\s*>/);
  assert.match(builderSource, /const program = ts\.createProgram/);
  assert.match(builderSource, /entryProgram = undefined/);
});

test("compiler-visible implementation closure digests are deterministic and mutation-sensitive", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-closure-"));
  const runGit = (...args: string[]) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const writeFixture = (path: string, source: string) => writeFileSync(join(root, path), source);
  const commit = (message: string) => {
    runGit("add", ".");
    runGit("commit", "-m", message);
  };
  const digest = () => {
    const receipt = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(receipt.verdict, "pass", JSON.stringify(receipt.diagnostics));
    const closure = receipt.implementationClosures.find((item) => item.entrypointId === "compiler-root:tsconfig.json:src/predicate.ts");
    assert.ok(closure);
    assert.equal(closure.programInputs.find((input) => input.kind === "typescript-compiler")?.lockRecordPath, "@toolchain/node_modules/typescript");
    assert.equal(recomputeImplementationClosureDigest(closure), closure.closureDigest);
    assert.equal(findImplementationClosureById(receipt, closure.entrypointId)?.entrypointId, closure.entrypointId);
    assert.equal(findImplementationClosureById(receipt, "src/predicate.ts"), null);
    assert.equal(validateAndQueryImplementationClosureDigest(receipt, closure.entrypointId), null);
    assert.equal(validateAndQueryImplementationClosureDigest(receipt, closure.entrypointId, { mode: "collector" }), closure.closureDigest);
    const tampered = {
      ...receipt,
      implementationClosures: receipt.implementationClosures.map((item) => item.entrypointId === closure.entrypointId ? { ...item, closureDigest: `0x${"0".repeat(64)}` } : item),
    };
    assert.equal(validateAndQueryImplementationClosureDigest(tampered, closure.entrypointId, { mode: "collector" }), null);
    return { receipt, value: closure.closureDigest };
  };
  try {
    runGit("init", "-b", "codex/closure-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "src", "internal"));
    writeFixture(".gitignore", "node_modules/\n");
    writeFixture("package.json", JSON.stringify({
      name: "closure-fixture",
      private: true,
      type: "module",
      exports: { ".": "./src/predicate.ts" },
    }));
    writeFixture("package-lock.json", fixturePackageLock("closure-fixture"));
    writeFixture("tsconfig.json", JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ["src/**/*.ts"],
      exclude: ["src/internal/**/*.ts"],
    }));
    writeFixture("src/predicate.ts", "import { codec } from './codec.ts';\nexport const predicate = codec;\n");
    writeFixture("src/codec.ts", "import { refinement } from './refinement.ts';\nexport interface CodecAugmentation {}\nexport const codec = refinement;\n");
    writeFixture("src/refinement.ts", "/// <reference lib=\"es2021.weakref\" />\nexport const refinement = 'v1';\n");
    writeFixture("src/global.d.ts", "declare global { var closureGlobal: string; }\nexport {};\n");
    writeFixture("src/global-script.d.ts", "interface ClosureGlobalScript { marker: 'before'; }\n");
    writeFixture("src/umd-global.d.ts", "export as namespace ClosureUmd;\nexport declare const marker: 'before';\n");
    writeFixture("src/global-effect-bridge.ts", "import './internal/indirect-global.ts';\nexport {};\n");
    writeFixture("src/internal/indirect-global.ts", "declare global { interface IndirectGlobalEffect { marker: 'before'; } }\nexport {};\n");
    writeFixture("src/augmentation.ts", "import './codec.ts';\ndeclare module './codec.ts' { interface CodecAugmentation { marker: 'before'; } }\n");
    writeFixture("src/augmentation-no-import.ts", "export {};\ndeclare module './codec.ts' { interface CodecNoImportAugmentation { marker: 'before'; } }\n");
    writeFixture("src/augmentation-chain.ts", "import './augmentation.ts';\ndeclare module './augmentation.ts' { interface ChainedAugmentation { marker: 'before'; } }\n");
    writeFixture("src/unrelated-target.ts", "export interface UnrelatedAugmentation {}\n");
    writeFixture("src/unrelated-augmentation.ts", "import './unrelated-target.ts';\ndeclare module './unrelated-target.ts' { interface UnrelatedAugmentation { marker: 'before'; } }\n");
    writeFixture("src/other.ts", "export const other = 'other';\n");
    writeFixture("src/unrelated.ts", "export const unrelated = 'before';\n");
    commit("fixture");

    const baseline = digest();
    const baselineAgain = digest();
    assert.equal(baselineAgain.value, baseline.value);
    assert.deepEqual(baselineAgain.receipt, baseline.receipt);
    const baselineClosure = baseline.receipt.implementationClosures.find((item) => item.entrypointId === "compiler-root:tsconfig.json:src/predicate.ts");
    assert.ok(baselineClosure);
    const baselineFiles = new Set(baselineClosure.files.map((file) => file.path));
    assert.deepEqual(
      [...baselineFiles].sort(),
      baselineClosure.programInputs
        .filter((input) => input.kind === "tracked" && input.logicalPath.startsWith("repo/"))
        .map((input) => input.logicalPath.slice("repo/".length))
        .sort(),
    );
    assert.ok(baselineFiles.has("src/augmentation.ts"));
    assert.ok(baselineFiles.has("src/augmentation-no-import.ts"));
    assert.ok(baselineFiles.has("src/augmentation-chain.ts"));
    assert.ok(!baselineFiles.has("src/unrelated.ts"));
    assert.ok(!baselineFiles.has("src/unrelated-augmentation.ts"));
    for (const edge of baselineClosure.edges) {
      assert.ok(baselineFiles.has(edge.from));
      assert.ok(edge.to.startsWith("@external/") || baselineFiles.has(edge.to));
    }
    assert.ok(baseline.receipt.graph.edges.some((edge) => edge.from === "src/augmentation-no-import.ts" && edge.to === "src/codec.ts" && edge.specifier === "./codec.ts"));
    assert.ok(baselineClosure.edges.some((edge) => edge.from === "src/augmentation-no-import.ts" && edge.to === "src/codec.ts" && edge.specifier === "./codec.ts"));
    assert.equal(findImplementationClosureById(baseline.receipt, "src/predicate.ts"), null);
    const predicateBefore = baseline.value;
    writeFixture("src/predicate.ts", "import { codec } from './codec.ts';\nexport const predicate = codec + '!';\n");
    commit("predicate mutation");
    assert.notEqual(digest().value, predicateBefore);

    const codecBefore = digest().value;
    writeFixture("src/codec.ts", "import { refinement } from './refinement.ts';\nexport interface CodecAugmentation {}\nexport const codec = refinement + '!';\n");
    commit("codec mutation");
    assert.notEqual(digest().value, codecBefore);

    const refinementBefore = digest().value;
    writeFixture("src/refinement.ts", "/// <reference lib=\"es2021.weakref\" />\nexport const refinement = 'v2';\n");
    commit("refinement mutation");
    assert.notEqual(digest().value, refinementBefore);

    const libReferenceBefore = digest().value;
    writeFixture("src/refinement.ts", "/// <reference lib=\"es2021.intl\" />\nexport const refinement = 'v2';\n");
    commit("lib reference mutation");
    const libReferenceReceipt = digest();
    assert.notEqual(libReferenceReceipt.value, libReferenceBefore);
    assert.ok(libReferenceReceipt.receipt.implementationClosures
      .find((item) => item.entrypointId === "compiler-root:tsconfig.json:src/predicate.ts")?.edges
      .some((edge) => edge.specifier === '/// <reference lib="es2021.intl">'));

    const globalBefore = digest().value;
    writeFixture("src/global.d.ts", "declare global { var closureGlobal: number; }\nexport {};\n");
    commit("ambient declaration mutation");
    assert.notEqual(digest().value, globalBefore);

    const globalScriptBefore = digest().value;
    writeFixture("src/global-script.d.ts", "interface ClosureGlobalScript { marker: 'after'; }\n");
    commit("global script mutation");
    assert.notEqual(digest().value, globalScriptBefore);

    const umdGlobalBefore = digest().value;
    writeFixture("src/umd-global.d.ts", "export as namespace ClosureUmd;\nexport declare const marker: 'after';\n");
    commit("UMD global mutation");
    assert.notEqual(digest().value, umdGlobalBefore);

    const indirectGlobalBefore = digest().value;
    writeFixture("src/internal/indirect-global.ts", "declare global { interface IndirectGlobalEffect { marker: 'after'; } }\nexport {};\n");
    commit("transitive global effect mutation");
    assert.notEqual(digest().value, indirectGlobalBefore);

    const augmentationBefore = digest().value;
    writeFixture("src/augmentation.ts", "import './codec.ts';\ndeclare module './codec.ts' { interface CodecAugmentation { marker: 'after'; } }\n");
    commit("module augmentation mutation");
    assert.notEqual(digest().value, augmentationBefore);

    const chainedAugmentationBefore = digest().value;
    writeFixture("src/augmentation-chain.ts", "import './augmentation.ts';\ndeclare module './augmentation.ts' { interface ChainedAugmentation { marker: 'after'; } }\n");
    commit("chained module augmentation mutation");
    assert.notEqual(digest().value, chainedAugmentationBefore);

    const unrelatedAugmentationBefore = digest().value;
    writeFixture("src/unrelated-augmentation.ts", "import './unrelated-target.ts';\ndeclare module './unrelated-target.ts' { interface UnrelatedAugmentation { marker: 'after'; } }\n");
    commit("unrelated module augmentation mutation");
    assert.equal(digest().value, unrelatedAugmentationBefore);

    const edgeBefore = digest().value;
    writeFixture("src/predicate.ts", "import { other } from './other.ts';\nexport const predicate = other;\n");
    commit("import edge mutation");
    const edgeReceipt = digest().receipt;
    assert.notEqual(edgeReceipt.implementationClosures.find((item) => item.entrypointId === "compiler-root:tsconfig.json:src/predicate.ts")?.closureDigest, edgeBefore);

    const optionBefore = digest().value;
    writeFixture("tsconfig.json", JSON.stringify({
      compilerOptions: {
        target: "ES2021",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ["src/**/*.ts"],
      exclude: ["src/internal/**/*.ts"],
    }));
    commit("compiler option mutation");
    assert.notEqual(digest().value, optionBefore);

    const unconsumedPackageBefore = digest().value;
    const unconsumedRoot = join(root, "node_modules", "unconsumed-package");
    mkdirSync(unconsumedRoot, { recursive: true });
    writeFileSync(join(unconsumedRoot, "package.json"), JSON.stringify({ name: "unconsumed-package", version: "1.0.0", type: "module" }));
    writeFileSync(join(unconsumedRoot, "index.js"), "export const unconsumed = true;\n");
    writeFixture("package-lock.json", fixturePackageLock("closure-fixture", { "node_modules/unconsumed-package": { version: "1.0.0" } }));
    commit("installed but unconsumed package mutation");
    assert.equal(digest().value, unconsumedPackageBefore);

    const manifestBefore = digest().value;
    writeFixture("package.json", JSON.stringify({
      name: "closure-fixture",
      version: "2.0.0",
      private: true,
      type: "module",
      exports: { ".": "./src/predicate.ts" },
    }));
    commit("manifest mutation");
    assert.notEqual(digest().value, manifestBefore);

    const unrelatedBefore = digest();
    const unrelatedClosureBefore = unrelatedBefore.receipt.implementationClosures.find((item) => item.entrypointId === "compiler-root:tsconfig.json:src/predicate.ts");
    assert.ok(unrelatedClosureBefore);
    writeFixture("src/unrelated.ts", "export const unrelated = 'after';\n");
    commit("unrelated mutation");
    const unrelatedAfter = digest();
    const unrelatedClosureAfter = unrelatedAfter.receipt.implementationClosures.find((item) => item.entrypointId === "compiler-root:tsconfig.json:src/predicate.ts");
    assert.deepEqual(unrelatedClosureAfter, unrelatedClosureBefore);

    writeFixture("src/augmentation.ts", "export {};\ndeclare module './missing-augmentation.ts' { interface MissingAugmentation {} }\n");
    commit("unresolved module augmentation");
    const invalidAugmentation = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(invalidAugmentation.verdict, "invalid");
    assert.ok(invalidAugmentation.diagnostics.some((item) => item.code === "module-augmentation-target-unresolved"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignored installed ambient declarations are exact compiler inputs and lock mismatch fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-installed-input-"));
  const ambientStore = mkdtempSync(join(tmpdir(), "aloha-installed-input-store-"));
  const runGit = (...args: string[]) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ambientRoot = join(root, "node_modules", "container", "node_modules", "@types", "example");
  const ambientPath = join(ambientRoot, "index.d.ts");
  const closure = () => {
    const receipt = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(receipt.verdict, "pass", JSON.stringify(receipt.diagnostics));
    const value = receipt.implementationClosures.find((item) => item.entrypointId === "compiler-root:tsconfig.json:src/index.ts");
    assert.ok(value);
    const input = value.programInputs.find((item) => item.logicalPath === "npm/@types/example@1.0.0/index.d.ts");
    assert.ok(input);
    assert.equal(input.lockRecordPath, "node_modules/container/node_modules/@types/example");
    return { receipt, value, input };
  };
  try {
    runGit("init", "-b", "codex/installed-input-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "src"));
    mkdirSync(dirname(ambientRoot), { recursive: true });
    symlinkSync(ambientStore, ambientRoot, "dir");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "installed-input-fixture",
      private: true,
      type: "module",
      devDependencies: { "@types/example": "1.0.0", typescript: ts.version },
    }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("installed-input-fixture", {
      "node_modules/@types/example": { version: "9.9.9", dev: true },
      "node_modules/container/node_modules/@types/example": { version: "1.0.0", dev: true },
    }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        preserveSymlinks: true,
        types: ["example"],
        typeRoots: ["./node_modules/container/node_modules/@types"],
      },
      include: ["src/**/*.ts"],
    }));
    writeFileSync(join(root, "src", "index.ts"), "export const value = ExternalFlag.Value;\n");
    writeFileSync(join(ambientRoot, "package.json"), JSON.stringify({ name: "@types/example", version: "1.0.0", types: "index.d.ts" }));
    writeFileSync(ambientPath, "declare const enum ExternalFlag { Value = 1 }\n");
    runGit("add", ".");
    runGit("commit", "-m", "installed input fixture");

    const baseline = closure();
    const lockHash = baseline.receipt.denominator.files.find((file) => file.path === "package-lock.json")?.contentSha256;
    writeFileSync(ambientPath, "declare const enum ExternalFlag { Value = 2 }\n");
    assert.equal(runGit("status", "--porcelain=v1"), "");
    const changed = closure();
    assert.equal(changed.receipt.denominator.files.find((file) => file.path === "package-lock.json")?.contentSha256, lockHash);
    assert.equal(changed.value.externalDependencyRoot, baseline.value.externalDependencyRoot);
    assert.notEqual(changed.input.contentSha256, baseline.input.contentSha256);
    assert.notEqual(changed.value.programInputSetRoot, baseline.value.programInputSetRoot);
    assert.notEqual(changed.value.closureDigest, baseline.value.closureDigest);

    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("installed-input-fixture", {
      "node_modules/@types/example": { version: "9.9.9", dev: true },
      "node_modules/container/node_modules/@types/example": { version: "1.0.0", dev: true, integrity: "sha512-related-owner-change" },
    }));
    runGit("add", "package-lock.json");
    runGit("commit", "-m", "related ambient owner lock mutation");
    const lockChanged = closure();
    assert.notEqual(lockChanged.input.lockRecordHash, changed.input.lockRecordHash);
    assert.notEqual(lockChanged.value.externalDependencyRoot, changed.value.externalDependencyRoot);
    assert.notEqual(lockChanged.value.closureDigest, changed.value.closureDigest);

    writeFileSync(join(ambientRoot, "package.json"), JSON.stringify({ name: "@types/example", version: "2.0.0", types: "index.d.ts" }));
    assert.equal(runGit("status", "--porcelain=v1"), "");
    const invalid = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(invalid.verdict, "invalid");
    assert.ok(invalid.diagnostics.some((item) => item.code === "external-compiler-input-lock-mismatch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ambientStore, { recursive: true, force: true });
  }
});

test("external edges bind their exact lock owner even when the package contributes no compiler source", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-external-edge-"));
  const runGit = (...args: string[]) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runtimeRoot = join(root, "node_modules", "external-runtime");
  const commit = (message: string) => {
    runGit("add", ".");
    runGit("commit", "-m", message);
  };
  const closure = () => {
    const receipt = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(receipt.verdict, "pass", JSON.stringify(receipt.diagnostics));
    const value = receipt.implementationClosures.find((item) => item.entrypointId === "compiler-root:tsconfig.json:src/index.ts");
    assert.ok(value);
    assert.ok(!value.programInputs.some((input) => input.packageName === "external-runtime"));
    return value;
  };
  try {
    runGit("init", "-b", "codex/external-edge-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "src"));
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "external-edge-fixture",
      private: true,
      type: "module",
      dependencies: { "external-runtime": "1.0.0" },
      devDependencies: { typescript: ts.version },
    }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("external-edge-fixture", {
      "node_modules/external-runtime": { version: "1.0.0", integrity: "sha512-before" },
    }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
      },
      include: ["src/**/*.ts"],
    }));
    writeFileSync(join(root, "src", "index.ts"), "import { value } from 'external-runtime';\nexport const observed = value;\n");
    writeFileSync(join(root, "src", "external-runtime.d.ts"), "declare module 'external-runtime' { export const value: number; }\n");
    writeFileSync(join(runtimeRoot, "package.json"), JSON.stringify({ name: "external-runtime", version: "1.0.0", type: "module", main: "./index.js" }));
    writeFileSync(join(runtimeRoot, "index.js"), "export const value = 1;\n");
    commit("external edge fixture");

    const baseline = closure();
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("external-edge-fixture", {
      "node_modules/external-runtime": { version: "1.0.0", integrity: "sha512-after" },
    }));
    commit("external owner lock mutation");
    const changed = closure();
    assert.notEqual(changed.externalDependencyRoot, baseline.externalDependencyRoot);
    assert.notEqual(changed.closureDigest, baseline.closureDigest);

    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("external-edge-fixture"));
    commit("remove external owner lock");
    const invalid = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(invalid.verdict, "invalid");
    assert.ok(invalid.diagnostics.some((item) => item.code === "external-edge-owner-unproven"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unresolved compiler-visible edges cannot receive a closure observation", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-unresolved-"));
  const runGit = (...args: string[]) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    runGit("init", "-b", "codex/unresolved-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "unresolved-fixture", private: true, type: "module" }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("unresolved-fixture"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true },
      include: ["src/**/*.ts"],
    }));
    writeFileSync(join(root, "src/predicate.ts"), "import './missing.ts';\nexport const predicate = 1;\n");
    runGit("add", ".");
    runGit("commit", "-m", "unresolved fixture");
    const receipt = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(receipt.verdict, "invalid");
    assert.ok(receipt.diagnostics.some((item) => item.code === "unresolved-module"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extends config chains are tracked, hashed, and project references fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-config-chain-"));
  const runGit = (...args: string[]) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const writeFixture = (path: string, source: string) => writeFileSync(join(root, path), source);
  const commit = (message: string) => {
    runGit("add", ".");
    runGit("commit", "-m", message);
  };
  try {
    runGit("init", "-b", "codex/config-chain-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "src"));
    writeFixture("package.json", JSON.stringify({ name: "config-chain-fixture", private: true, type: "module", exports: { ".": "./src/index.ts" } }));
    writeFixture("package-lock.json", fixturePackageLock("config-chain-fixture"));
    writeFixture("base.json", JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
    }));
    writeFixture("tsconfig.json", JSON.stringify({ extends: "./base.json", include: ["src/**/*.ts"] }));
    writeFixture("src/index.ts", "export const value = 1;\n");
    commit("config chain fixture");

    const baseline = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(baseline.verdict, "pass", JSON.stringify(baseline.diagnostics));
    const closure = baseline.implementationClosures.find((item) => item.entrypointId === "compiler-root:tsconfig.json:src/index.ts");
    assert.ok(closure);
    assert.deepEqual(closure.configChain.files.map((file) => file.path), ["base.json", "tsconfig.json"]);
    assert.deepEqual(closure.configChain.edges, [{ from: "tsconfig.json", to: "base.json", specifier: "./base.json" }]);
    assert.match(closure.tsconfigRoot, /^0x[0-9a-f]{64}$/);
    const before = closure.closureDigest;

    writeFixture("base.json", JSON.stringify({
      compilerOptions: {
        target: "ES2021",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
    }));
    commit("base config mutation");
    const changed = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(changed.verdict, "pass", JSON.stringify(changed.diagnostics));
    assert.notEqual(changed.implementationClosures.find((item) => item.entrypointId === "compiler-root:tsconfig.json:src/index.ts")?.closureDigest, before);

    const denominatorOptions = ["noLib", "skipLibCheck", "skipDefaultLibCheck"] as const;
    for (const option of denominatorOptions) {
      writeFixture("base.json", JSON.stringify({
        compilerOptions: {
          target: "ES2021",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          [option]: true,
        },
      }));
      commit(`disabled compiler denominator ${option}`);
      const disabled = runBoundaryGate({ gitRoot: root, requirePushed: false });
      assert.equal(disabled.verdict, "invalid");
      assert.ok(disabled.diagnostics.some((item) => item.code === "compiler-denominator-disabled" && item.message.includes(`${option}=true`)), JSON.stringify(disabled.diagnostics));
    }
    writeFixture("base.json", JSON.stringify({
      compilerOptions: {
        target: "ES2021",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
    }));
    commit("restore complete compiler denominator");

    writeFixture("tsconfig.json", JSON.stringify({ extends: "./base.json", references: [{ path: "./other.json" }], include: ["src/**/*.ts"] }));
    commit("unsupported project reference");
    const invalid = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(invalid.verdict, "invalid");
    assert.ok(invalid.diagnostics.some((item) => item.code === "project-references-unsupported"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler roots and Program sources cannot escape the exact repository denominator", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-compiler-root-"));
  const outside = join(dirname(root), `${root.slice(root.lastIndexOf("/") + 1)}-outside.ts`);
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    runGit("init", "-b", "codex/compiler-root-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "compiler-root-fixture", private: true, type: "module" }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("compiler-root-fixture"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true }, include: ["src/**/*.ts", "../*outside.ts"] }));
    writeFileSync(outside, "export const outside = 1;\n");
    writeFileSync(join(root, "src", "untracked.ts"), "export const untracked = 1;\n");
    symlinkSync(outside, join(root, "src", "escape.ts"));
    writeFileSync(join(root, "src", "index.ts"), "import { escape } from './escape.ts'; import { untracked } from './untracked.ts'; export { escape, untracked };\n");
    runGit("add", "package.json", "package-lock.json", "tsconfig.json", "src/index.ts");
    runGit("commit", "-m", "compiler root fixture");
    const receipt = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(receipt.verdict, "invalid");
    const codes = new Set(receipt.diagnostics.map((item) => item.code));
    assert.ok(codes.has("compiler-root-outside-root"), JSON.stringify(receipt.diagnostics));
    assert.ok(codes.has("compiler-source-symlink"), JSON.stringify(receipt.diagnostics));
    assert.ok(codes.has("compiler-source-not-tracked"), JSON.stringify(receipt.diagnostics));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("compiler graph follows NodeNext usage mode and ImportTypeNode edges", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-nodenext-graph-"));
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    runGit("init", "-b", "codex/nodenext-graph-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "packages"), { recursive: true });
    mkdirSync(join(root, "families", "foo"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "nodenext-graph-fixture",
      private: true,
      type: "module",
      exports: { ".": { import: "./families/foo/index.ts", require: "./packages/cjs.ts" } },
    }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("nodenext-graph-fixture"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true }, include: ["packages/**/*.ts", "families/**/*.ts"] }));
    writeFileSync(join(root, "families", "foo", "index.ts"), "export interface FamilyValue { value: number } export const familyValue: FamilyValue = { value: 1 };\n");
    writeFileSync(join(root, "packages", "cjs.ts"), "export const familyValue = { value: 2 };\n");
    writeFileSync(join(root, "packages", "core.ts"), "/** @type {import('../families/foo/index.ts').FamilyValue} */\nimport { familyValue } from 'nodenext-graph-fixture'; type FamilyValue = import('../families/foo/index.ts').FamilyValue; export const value: FamilyValue = familyValue;\n");
    writeFileSync(join(root, "packages", "jsdoc.ts"), "/** @type {import('../families/foo/index.ts').FamilyValue} */\nconst jsdocValue = { value: 3 }; export { jsdocValue };\n");
    runGit("add", ".");
    runGit("commit", "-m", "NodeNext graph fixture");
    const receipt = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(receipt.verdict, "fail", JSON.stringify(receipt.diagnostics));
    assert.ok(receipt.graph.edges.some((edge) => edge.from === "packages/core.ts" && edge.to === "families/foo/index.ts" && edge.specifier === "nodenext-graph-fixture" && edge.resolutionMode === "import"), JSON.stringify(receipt.graph.edges));
    assert.ok(receipt.graph.edges.some((edge) => edge.from === "packages/core.ts" && edge.to === "families/foo/index.ts" && edge.specifier === "../families/foo/index.ts"), JSON.stringify(receipt.graph.edges));
    assert.ok(receipt.graph.edges.some((edge) => edge.from === "packages/jsdoc.ts" && edge.to === "families/foo/index.ts" && edge.specifier === "../families/foo/index.ts"), JSON.stringify(receipt.graph.edges));
    assert.ok(receipt.diagnostics.some((item) => item.code === "central-imports-family" && item.path === "packages/core.ts"), JSON.stringify(receipt.diagnostics));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("triple-slash type references use the type resolver and bind the @types owner", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-type-reference-"));
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const typePackage = join(root, "node_modules", "@types", "foo");
  const runtimePackage = join(root, "node_modules", "foo");
  const closure = () => {
    const receipt = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(receipt.verdict, "pass", JSON.stringify(receipt.diagnostics));
    const value = receipt.implementationClosures.find((item) => item.entrypointId === "compiler-root:tsconfig.json:packages/core.ts");
    assert.ok(value);
    return { receipt, value };
  };
  try {
    runGit("init", "-b", "codex/type-reference-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "packages"), { recursive: true });
    mkdirSync(typePackage, { recursive: true });
    mkdirSync(runtimePackage, { recursive: true });
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "type-reference-fixture", private: true, type: "module" }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("type-reference-fixture", {
      "node_modules/@types/foo": { version: "1.0.0", dev: true },
      "node_modules/foo": { version: "1.0.0", dev: true },
    }));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, typeRoots: ["./node_modules/@types"] }, include: ["packages/**/*.ts"] }));
    writeFileSync(join(typePackage, "package.json"), JSON.stringify({ name: "@types/foo", version: "1.0.0", types: "index.d.ts" }));
    writeFileSync(join(typePackage, "index.d.ts"), "declare const TypePackageValue: number;\n");
    writeFileSync(join(runtimePackage, "package.json"), JSON.stringify({ name: "foo", version: "1.0.0", types: "index.d.ts" }));
    writeFileSync(join(runtimePackage, "index.d.ts"), "declare const RuntimePackageValue: string;\n");
    writeFileSync(join(root, "packages", "core.ts"), "/// <reference types=\"foo\" />\nexport const value: number = TypePackageValue;\n");
    runGit("add", ".");
    runGit("commit", "-m", "type reference fixture");
    const baseline = closure();
    const graphEdge = baseline.receipt.graph.edges.find((edge) => edge.from === "packages/core.ts" && edge.specifier === "/// <reference types=\"foo\">" );
    assert.equal(graphEdge?.to, "@external/foo");
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("type-reference-fixture", {
      "node_modules/@types/foo": { version: "1.0.0", dev: true },
      "node_modules/foo": { version: "2.0.0", dev: true, integrity: "sha512-runtime-only" },
    }));
    runGit("add", "package-lock.json");
    runGit("commit", "-m", "unrelated runtime owner mutation");
    assert.equal(closure().value.closureDigest, baseline.value.closureDigest);
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("type-reference-fixture", {
      "node_modules/@types/foo": { version: "1.0.0", dev: true, integrity: "sha512-type-owner" },
      "node_modules/foo": { version: "2.0.0", dev: true, integrity: "sha512-runtime-only" },
    }));
    runGit("add", "package-lock.json");
    runGit("commit", "-m", "type owner mutation");
    assert.notEqual(closure().value.closureDigest, baseline.value.closureDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pushed evidence rejects a local branch masquerading as an upstream remote", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-local-upstream-"));
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    runGit("init", "-b", "codex/local-upstream-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "local-upstream-fixture", private: true, type: "module" }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("local-upstream-fixture"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true }, include: ["index.ts"] }));
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
    runGit("add", ".");
    runGit("commit", "-m", "local upstream fixture");
    runGit("branch", "local-base");
    runGit("branch", "--set-upstream-to=local-base");
    const receipt = runBoundaryGate({ gitRoot: root, requirePushed: true });
    assert.equal(receipt.candidate.pushed, false);
    assert.equal(receipt.verdict, "invalid");
    assert.ok(receipt.diagnostics.some((item) => item.code === "upstream-not-remote-tracking"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime workers are production runtime and undeclared source roots fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-runtime-role-"));
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    runGit("init", "-b", "codex/runtime-role-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "packages"), { recursive: true });
    mkdirSync(join(root, "runtime", "revm-workers"), { recursive: true });
    mkdirSync(join(root, "mystery"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "runtime-role-fixture", private: true, type: "module" }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("runtime-role-fixture"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true }, include: ["packages/**/*.ts", "runtime/**/*.ts", "mystery/**/*.ts"] }));
    writeFileSync(join(root, "runtime", "revm-workers", "worker.ts"), "export const worker = 1;\n");
    writeFileSync(join(root, "mystery", "unknown.ts"), "export const unknown = 1;\n");
    writeFileSync(join(root, "packages", "core.ts"), "import { worker } from '../runtime/revm-workers/worker.ts'; export const value = worker;\n");
    runGit("add", ".");
    runGit("commit", "-m", "runtime role fixture");
    const receipt = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(receipt.verdict, "invalid");
    assert.ok(receipt.diagnostics.some((item) => item.code === "central-imports-runtime"), JSON.stringify(receipt.diagnostics));
    assert.ok(receipt.diagnostics.some((item) => item.code === "unknown-source-root" && item.path === "mystery/unknown.ts"), JSON.stringify(receipt.diagnostics));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
