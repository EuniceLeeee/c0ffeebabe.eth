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
  collectCatalogCompilerBoundaryProjection,
  classifyBoundaryPathV1,
  computeImplementationExportDigest,
  computePredicateCompositionLeafDigest,
  computePredicateCompositionRootDigest,
  computeProgramInputSetRoot,
  computeReleaseRoleManifestRootDigest,
  assertQualifiedRunnerApprovalJoinsBoundaryReceiptV1,
  deriveReleaseClosureFacts,
  MUTATION_CORPUS,
  findImplementationClosureById,
  inspectSourceText,
  issueQualifiedPreReleaseControllerBoundaryEvidenceV1,
  projectCatalogProposedCapabilitySet,
  queryFixedFinalPreReleaseCliClosureV1,
  queryFixedSearcherReleaseRuntimeClosureV1,
  queryImplementationClosureObservation,
  recomputeImplementationClosureDigest,
  runBoundaryGate,
  validateArtifactLineageStageOneSources,
  validatePreReleaseOwnerHostSources,
  validatePreReleaseControllerCompilerMetafileEdgesV1,
  validatePreReleaseProductionBoundarySources,
  validateProductionReleaseClosure,
  validateProductionRuntimeClosures,
  validateQualifiedExecutorAuthoritySource,
  validateFamilyExecutionCompositionSource,
  validateFinalPreReleaseCliSourceV1,
  validateRuntimeReleaseBootstrapSources,
  validateSearcherRuntimeDeploymentStartupSources,
  validateAndQueryImplementationClosureDigest,
  validateAttestationContractOwnershipSources,
  validateCatalogGeneratedTree,
  validateGeneratedTree,
  validateCatalogGenerationVerificationReceipt,
  validateDependencyBoundaries,
  validateGateCorePackageExports,
  validateReleaseClosureFacts,
  validateReleaseRoleManifest,
  verifyMutationCorpus,
} from "../src/index.ts";
import type { BoundaryDiagnostic, GraphEdge, ImplementationClosure, ImplementationCompilerInput, ReleaseRoleManifestV1, ReleaseClosureRefV1, TrackedFile } from "../src/index.ts";
import {
  CATALOG_COMPILER_OBSERVER_ENTRYPOINT,
  CATALOG_GENERATION_VERIFIER_ENTRYPOINT,
  CATALOG_SEMANTIC_GENERATOR_ENTRYPOINT,
  catalogCandidateDenominatorRoot,
  createCatalogGenerationVerificationReceiptV1,
} from "../../catalog-generator/src/verification-receipt.ts";

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

test("qualified controller evidence rejects structural Boundary receipts before build or filesystem access", () => {
  let reads = 0;
  const forged = Object.freeze(Object.defineProperty({}, "candidate", {
    enumerable: true,
    get() { reads += 1; throw new Error("must not read caller-authored receipt"); },
  }));
  assert.throws(
    () => issueQualifiedPreReleaseControllerBoundaryEvidenceV1(
      forged as never,
      "/must/not/be/read",
    ),
    /process-issued pushed Boundary pass/,
  );
  assert.equal(reads, 0);
});

test("final pre-release CLI exact source binds one pushed Boundary receipt to one final runner call", () => {
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const path = "tools/runtime-release-packager/src/final-pre-release-cli.ts";
  const source = readFileSync(join(repositoryRoot, path), "utf8");
  const baseline: BoundaryDiagnostic[] = [];
  validateFinalPreReleaseCliSourceV1(source, baseline);
  assert.deepEqual(baseline, []);

  const mutations = [
    source.replace("const receipt = runBoundaryGate({ requirePushed: true });\n", ""),
    source.replace("requirePushed: true", "requirePushed: false"),
    source.replace("runFinalPreReleaseV1(receipt)", "runFinalPreReleaseV1({ ...receipt })"),
    source.replace("runFinalPreReleaseV1(receipt)", "runAlternateFinalPreReleaseV1(receipt)"),
    source.replace(
      "const receipt = runBoundaryGate({ requirePushed: true });",
      "const receipt = runBoundaryGate({ requirePushed: true });\nrunBoundaryGate({ requirePushed: true });",
    ),
    source.replace(
      'import { runFinalPreReleaseV1 } from "./final-pre-release-runner.ts";',
      'const { runFinalPreReleaseV1 } = await import("./final-pre-release-runner.ts");',
    ),
  ];
  for (const mutation of mutations) {
    const diagnostics: BoundaryDiagnostic[] = [];
    validateFinalPreReleaseCliSourceV1(mutation, diagnostics);
    assert.ok(diagnostics.some(item => item.code === "final-pre-release-cli-sequence"));
  }
});

test("fixed final pre-release bin closure rejects alternate identity, source inputs, edges, and duplicates", () => {
  const cli = "tools/runtime-release-packager/src/final-pre-release-cli.ts";
  const runner = "tools/runtime-release-packager/src/final-pre-release-runner.ts";
  const boundary = "tools/architecture-boundaries/src/index.ts";
  const closureFile = (path: string, marker: string) => ({
    path,
    blobSha: marker.repeat(40),
    contentSha256: `0x${marker.repeat(64)}`,
    byteLength: marker.charCodeAt(0),
  });
  const files = [closureFile(cli, "a"), closureFile(runner, "b"), closureFile(boundary, "c")];
  const fixed: ImplementationClosure = {
    entrypoint: cli,
    entrypointId: "package-entrypoint:tools/runtime-release-packager/package.json:#bin:aloha-final-pre-release:tools/runtime-release-packager/src/final-pre-release-cli.ts:tools/runtime-release-packager/tsconfig.json",
    kind: "package-entrypoint",
    packageName: "@aloha/runtime-release-packager",
    packageManifestPath: "tools/runtime-release-packager/package.json",
    configPath: "tools/runtime-release-packager/tsconfig.json",
    tsconfigRoot: `0x${"d".repeat(64)}`,
    configChain: { rootPath: "tools/runtime-release-packager/tsconfig.json", files: [], edges: [] },
    optionsRoot: `0x${"e".repeat(64)}`,
    programInputs: files.map(file => ({
      kind: "tracked" as const,
      logicalPath: `repo/${file.path}`,
      blobSha: file.blobSha,
      packageName: null,
      packageVersion: null,
      packageRelativePath: null,
      packageManifestSha256: null,
      lockRecordPath: null,
      lockRecordHash: null,
      contentSha256: file.contentSha256,
      compilerTextSha256: file.contentSha256,
      byteLength: file.byteLength,
    })),
    programInputSetRoot: `0x${"f".repeat(64)}`,
    typescriptVersion: ts.version,
    packageManifestRoot: `0x${"1".repeat(64)}`,
    externalDependencyRoot: `0x${"2".repeat(64)}`,
    files,
    edges: [
      { from: cli, to: boundary, specifier: "../../architecture-boundaries/src/index.ts" },
      { from: cli, to: runner, specifier: "./final-pre-release-runner.ts" },
      { from: runner, to: boundary, specifier: "../../architecture-boundaries/src/index.ts" },
    ],
    closureDigest: `0x${"3".repeat(64)}`,
  };
  assert.equal(queryFixedFinalPreReleaseCliClosureV1({ implementationClosures: [fixed] }), fixed);
  const reject = (mutation: ImplementationClosure) =>
    assert.equal(queryFixedFinalPreReleaseCliClosureV1({ implementationClosures: [mutation] }), null);
  reject({ ...fixed, packageName: "@aloha/alternate-packager" });
  reject({ ...fixed, packageManifestPath: "tools/alternate/package.json" });
  reject({ ...fixed, entrypoint: "tools/runtime-release-packager/src/alternate-cli.ts" });
  reject({ ...fixed, configPath: "tools/runtime-release-packager/alternate-tsconfig.json" });
  reject({ ...fixed, entrypointId: fixed.entrypointId.replace("#bin:aloha-final-pre-release", "#bin:alternate") });
  reject({ ...fixed, edges: fixed.edges.slice(1) });
  reject({ ...fixed, edges: fixed.edges.map(edge => edge.from === cli && edge.to === runner ? { ...edge, specifier: "./alternate-runner.ts" } : edge) });
  reject({ ...fixed, programInputs: fixed.programInputs.map((input, index) => index === 1 ? { ...input, contentSha256: `0x${"0".repeat(64)}` } : input) });
  assert.equal(queryFixedFinalPreReleaseCliClosureV1({ implementationClosures: [fixed, { ...fixed }] }), null);
});

test("controller compiler closure exact-joins esbuild metafile internal imports bidirectionally", () => {
  const entry = "tools/pre-release-restart-controller/src/cli.ts";
  const owner = "tools/pre-release-restart-controller/src/owner.ts";
  const sources = new Map([
    [entry, 'import { run } from "./owner.ts"; run();\n'],
    [owner, "export function run() {}\n"],
  ]);
  const edge = { from: entry, to: owner, specifier: "./owner.ts" };
  assert.doesNotThrow(() => validatePreReleaseControllerCompilerMetafileEdgesV1(
    { edges: [edge] },
    [entry, owner],
    sources,
    [edge],
  ));
  assert.throws(() => validatePreReleaseControllerCompilerMetafileEdgesV1(
    { edges: [edge] },
    [entry, owner],
    sources,
    [],
  ), /do not exact-join/);
  assert.throws(() => validatePreReleaseControllerCompilerMetafileEdgesV1(
    { edges: [] },
    [entry, owner],
    sources,
    [edge],
  ), /do not exact-join/);
  assert.throws(() => validatePreReleaseControllerCompilerMetafileEdgesV1(
    { edges: [edge] },
    [entry, owner],
    sources,
    [edge, { from: owner, to: entry, specifier: "./cli.ts" }],
  ), /do not exact-join/);
  assert.throws(() => validatePreReleaseControllerCompilerMetafileEdgesV1(
    { edges: [edge] },
    [entry, owner, owner],
    sources,
    [edge],
  ), /duplicate path/);
});

test("catalog boundary exact-joins typed verification facts and never trusts a CLI marker", () => {
  const h = (value: string): `0x${string}` => sha256(Buffer.from(value)) as `0x${string}`;
  const scannedFileSetRoot = h("scanned");
  const compilerGraphRoot = h("compiler-graph");
  const fact = (
    entrypoint: { readonly modulePath: string; readonly exportName: string },
    suffix: string,
  ) => ({
    modulePath: entrypoint.modulePath,
    exportName: entrypoint.exportName,
    entrypointId: `compiler-root:fixture:${entrypoint.modulePath}#${entrypoint.exportName}`,
    closureDigest: h(`${suffix}:closure`),
    programInputSetRoot: h(`${suffix}:inputs`),
  });
  const observerImplementation = fact(CATALOG_COMPILER_OBSERVER_ENTRYPOINT, "observer");
  const verifierImplementation = fact(CATALOG_GENERATION_VERIFIER_ENTRYPOINT, "verifier");
  const observedGeneratorLeaf = fact(CATALOG_SEMANTIC_GENERATOR_ENTRYPOINT, "generator");
  const compilerFactsRoot = h("compiler-facts");
  const proposedCapabilitySetRoot = h("proposed-capabilities");
  const base = {
    candidateDenominatorRoot: catalogCandidateDenominatorRoot({ scannedFileSetRoot, compilerGraphRoot }),
    indexDenominatorRoot: h("index-denominator"),
    scannedFileSetRoot,
    compilerGraphRoot,
    observedCompilerFactsRoot: compilerFactsRoot,
    persistedCompilerFactsRoot: compilerFactsRoot,
    observedProposedCapabilitySetRoot: proposedCapabilitySetRoot,
    persistedProposedCapabilitySetRoot: proposedCapabilitySetRoot,
    observerImplementation,
    verifierImplementation,
    observedGeneratorLeaf,
    ledgerGeneratorRecord: {
      logicalPath: `${observedGeneratorLeaf.modulePath}#${observedGeneratorLeaf.exportName}`,
      contentSha256: observedGeneratorLeaf.closureDigest,
      byteLength: 0,
      sourceKind: "tracked" as const,
    },
    semanticLedgerHash: h("semantic-ledger"),
    semanticOutputRoot: h("semantic-output"),
    impactSnapshotRoot: h("impact-snapshot"),
    impactReceiptRoot: h("impact-receipt"),
  };
  const expected = createCatalogGenerationVerificationReceiptV1(base);
  const validDiagnostics: BoundaryDiagnostic[] = [];
  validateCatalogGenerationVerificationReceipt(expected, expected, validDiagnostics);
  assert.deepEqual(validDiagnostics, []);

  const invalid = (actual: unknown): void => {
    const diagnostics: BoundaryDiagnostic[] = [];
    validateCatalogGenerationVerificationReceipt(actual, expected, diagnostics);
    assert.deepEqual(diagnostics.map(value => value.code), ["catalog-generation-verification-receipt"]);
  };
  invalid("catalog-generator: exact");
  const replacementScannedRoot = h("replacement-scanned");
  invalid(createCatalogGenerationVerificationReceiptV1({
    ...base,
    scannedFileSetRoot: replacementScannedRoot,
    candidateDenominatorRoot: catalogCandidateDenominatorRoot({
      scannedFileSetRoot: replacementScannedRoot,
      compilerGraphRoot,
    }),
  }));
  const replacementCompilerGraphRoot = h("replacement-compiler-graph");
  invalid(createCatalogGenerationVerificationReceiptV1({
    ...base,
    compilerGraphRoot: replacementCompilerGraphRoot,
    candidateDenominatorRoot: catalogCandidateDenominatorRoot({
      scannedFileSetRoot,
      compilerGraphRoot: replacementCompilerGraphRoot,
    }),
  }));
  invalid(createCatalogGenerationVerificationReceiptV1({
    ...base,
    indexDenominatorRoot: h("replacement-index-denominator"),
  }));
  invalid(createCatalogGenerationVerificationReceiptV1({
    ...base,
    impactSnapshotRoot: h("replacement-impact-snapshot"),
  }));
  invalid(createCatalogGenerationVerificationReceiptV1({
    ...base,
    impactReceiptRoot: h("replacement-impact-receipt"),
  }));
  const replacementCompilerFactsRoot = h("replacement-compiler-facts");
  invalid(createCatalogGenerationVerificationReceiptV1({
    ...base,
    observedCompilerFactsRoot: replacementCompilerFactsRoot,
    persistedCompilerFactsRoot: replacementCompilerFactsRoot,
  }));
  const replacementProposalRoot = h("replacement-proposed-capabilities");
  invalid(createCatalogGenerationVerificationReceiptV1({
    ...base,
    observedProposedCapabilitySetRoot: replacementProposalRoot,
    persistedProposedCapabilitySetRoot: replacementProposalRoot,
  }));
  invalid(createCatalogGenerationVerificationReceiptV1({
    ...base,
    observerImplementation: { ...observerImplementation, closureDigest: h("replacement-observer") },
  }));
  invalid(createCatalogGenerationVerificationReceiptV1({
    ...base,
    verifierImplementation: { ...verifierImplementation, closureDigest: h("replacement-verifier") },
  }));
  const replacementGeneratorLeaf = { ...observedGeneratorLeaf, closureDigest: h("replacement-generator") };
  invalid(createCatalogGenerationVerificationReceiptV1({
    ...base,
    observedGeneratorLeaf: replacementGeneratorLeaf,
    ledgerGeneratorRecord: {
      ...base.ledgerGeneratorRecord,
      contentSha256: replacementGeneratorLeaf.closureDigest,
    },
  }));
  invalid(createCatalogGenerationVerificationReceiptV1({
    ...base,
    observedCompilerFactsRoot: replacementCompilerFactsRoot,
    persistedCompilerFactsRoot: replacementCompilerFactsRoot,
    observedProposedCapabilitySetRoot: replacementProposalRoot,
    persistedProposedCapabilitySetRoot: replacementProposalRoot,
    observedGeneratorLeaf: replacementGeneratorLeaf,
    ledgerGeneratorRecord: {
      ...base.ledgerGeneratorRecord,
      contentSha256: replacementGeneratorLeaf.closureDigest,
    },
    semanticLedgerHash: h("jointly-forged-ledger"),
    semanticOutputRoot: h("jointly-forged-output"),
  }));
  assert.throws(() => createCatalogGenerationVerificationReceiptV1({
    ...base,
    ledgerGeneratorRecord: { ...base.ledgerGeneratorRecord, contentSha256: h("wrong-generator-record") },
  }), /generator leaf does not match/);
});

test("catalog generated ownership includes safety profile in the exact ledger-backed output envelope", () => {
  const file = (path: string, fileClass = classifyBoundaryPathV1(path).fileClass): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: classifyBoundaryPathV1(path).language,
    fileClass,
  });
  const outputs = [
    "generated/catalog-impact.receipt.json",
    "generated/catalog-impact.snapshot.json",
    "generated/family-catalog/index.ts",
    "generated/runtime-composition/index.ts",
    "generated/safety-profile/index.ts",
    "generated/strategy-catalog/index.ts",
    "generated/valuation-owner-registry/index.ts",
  ];
  const fixed = [
    ...outputs.map(path => file(path)),
    file("generated/catalog-generation.ledger.json"),
    file("tools/catalog-generator/src/cli.ts"),
  ];
  const baseline: BoundaryDiagnostic[] = [];
  validateCatalogGeneratedTree("/unused", fixed, baseline);
  assert.deepEqual(baseline, []);

  const missingSafetyProfile: BoundaryDiagnostic[] = [];
  validateCatalogGeneratedTree(
    "/unused",
    fixed.filter(value => value.path !== "generated/safety-profile/index.ts"),
    missingSafetyProfile,
  );
  assert.ok(missingSafetyProfile.some(value => value.code === "catalog-generated-output-set"));
});

test("reference-lock generator owns only the four fixed generated authority artifacts", () => {
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: classifyBoundaryPathV1(path).language,
    fileClass: classifyBoundaryPathV1(path).fileClass,
  });
  const artifacts = [
    "generated/authority/authority-manifest.json",
    "generated/authority/reference-lock.json",
    "generated/authority/reuse-ledger.yaml",
    "generated/authority/reuse-receipts.json",
  ];
  const owners = [
    "tools/reference-lock-integrity/src/index.ts",
    "specs/reuse-ledger/src/index.ts",
    "tools/reference-lock-integrity/package.json",
    "tools/reference-lock-integrity/src/cli.ts",
  ];
  const inspect = (paths: readonly string[]): readonly BoundaryDiagnostic[] => {
    const diagnostics: BoundaryDiagnostic[] = [];
    validateGeneratedTree("/unused", paths.map(file), false, diagnostics);
    return diagnostics;
  };

  assert.deepEqual(inspect([...artifacts, ...owners]), []);
  assert.ok(inspect([...artifacts, ...owners, "generated/authority/forged.json"])
    .some((item) => item.code === "generated-regeneration-contract-missing"
      && item.path === "generated/authority/forged.json"));
  assert.ok(inspect([...artifacts, ...owners.slice(1)])
    .some((item) => item.code === "generated-regeneration-contract-missing"));
});

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
    commonEnvelopeRoleContractVersion: null,
    materialProviderContractDigest: null,
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
  const { RELEASE_ROLE_MANIFEST: generatedManifest } = await import(new URL("../../../acceptance/gate-core/src/generated/release-role-manifest.ts", import.meta.url).href) as {
    readonly RELEASE_ROLE_MANIFEST: Omit<ReleaseRoleManifestV1, "qualifiedRunner"> & Partial<Pick<ReleaseRoleManifestV1, "qualifiedRunner">>;
  };
  // The shared WIP may not have regenerated the manifest after adding the
  // qualified-runner role.  This source-shape fixture needs only a complete
  // manifest value; release-root/closure diagnostics remain intentionally
  // outside its focused assertions.
  const manifest: ReleaseRoleManifestV1 = {
    ...generatedManifest,
    qualifiedRunner: generatedManifest.qualifiedRunner ?? {
      entrypointId: "fixture:qualified-release-runner",
      modulePath: "tools/runtime-release-packager/src/internal/qualified-release-runner-owner.ts",
      exportName: "observeQualifiedReleaseAcceptanceAdvisoryV1",
      implementationExportDigest: `0x${"f".repeat(64)}`,
    },
  };
  for (const entry of manifest.predicateAdapters) {
    const {
      entrypointId: _entrypointId,
      oracleEntrypointId: _oracleEntrypointId,
      materialProviderEntrypointId: _materialProviderEntrypointId,
      compositionLeafDigest: _compositionLeafDigest,
      ...leafInput
    } = entry;
    assert.equal(
      computePredicateCompositionLeafDigest(leafInput),
      entry.compositionLeafDigest,
      `${entry.predicateId} generated composition leaf must match the independent Boundary derivation`,
    );
  }
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
      ...manifest.predicateAdapters.map((entry) => entry.materialProviderModulePath),
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
    assert.ok(!baseline.some((item) => item.code.startsWith("release-bom-generated-material-provider")), JSON.stringify(baseline));
    const compositionPath = join(root, "acceptance/gate-core/src/generated/predicate-composition.ts");
    const compositionSource = readFileSync(compositionPath, "utf8");

    writeFileSync(compositionPath, compositionSource.replace("evaluator: predicateEvaluator0", "evaluator: fakeEvaluator"));
    const fakeEvaluator = validateReleaseRoleManifest({ gitRoot: root, files, implementationClosures: [] }, manifest);
    assert.ok(fakeEvaluator.some((item) => item.code === "release-bom-generated-evaluator-identity"));

    writeFileSync(compositionPath, compositionSource.replace(
      manifest.predicateAdapters[0]!.predicateSpecDigest,
      `0x${"0".repeat(64)}`,
    ));
    const frozenMetadataMutation = validateReleaseRoleManifest({ gitRoot: root, files, implementationClosures: [] }, manifest);
    assert.ok(frozenMetadataMutation.some((item) => item.code === "release-bom-generated-evaluator-identity"));
    assert.ok(!frozenMetadataMutation.some((item) => item.code === "release-bom-generated-material-provider-identity"));

    writeFileSync(compositionPath, compositionSource.replace("materialProvider: materialProvider0", "materialProvider: materialProvider1"));
    const providerIdentityMutation = validateReleaseRoleManifest({ gitRoot: root, files, implementationClosures: [] }, manifest);
    assert.ok(providerIdentityMutation.some((item) => item.code === "release-bom-generated-material-provider-identity"));
    assert.ok(!providerIdentityMutation.some((item) => item.code === "release-bom-generated-evaluator-identity"));

    writeFileSync(compositionPath, compositionSource.replace("as materialProvider0", "as forgedMaterialProvider0"));
    const providerImportMutation = validateReleaseRoleManifest({ gitRoot: root, files, implementationClosures: [] }, manifest);
    assert.ok(providerImportMutation.some((item) => item.code === "release-bom-generated-material-provider-import-mismatch"));
    assert.ok(providerImportMutation.some((item) => item.code === "release-bom-generated-material-provider-import-set"));

    const providerImportLine = compositionSource.split("\n").find((line) => line.includes(" as materialProvider0 "));
    assert.ok(providerImportLine);
    writeFileSync(compositionPath, `${providerImportLine.replace(" as materialProvider0 ", " as extraMaterialProvider ")}\n${compositionSource}`);
    const extraProviderImport = validateReleaseRoleManifest({ gitRoot: root, files, implementationClosures: [] }, manifest);
    assert.ok(extraProviderImport.some((item) => item.code === "release-bom-generated-material-provider-import-set"));

    writeFileSync(compositionPath, compositionSource.replace(
      manifest.predicateAdapters[0]!.materialProviderContractDigest,
      `0x${"0".repeat(64)}`,
    ));
    const providerMetadataMutation = validateReleaseRoleManifest({ gitRoot: root, files, implementationClosures: [] }, manifest);
    assert.ok(providerMetadataMutation.some((item) => item.code === "release-bom-generated-material-provider-identity"));
    assert.ok(!providerMetadataMutation.some((item) => item.code === "release-bom-generated-evaluator-identity"));

    writeFileSync(compositionPath, compositionSource.replace(
      "[binding.predicateId, binding] as const",
      "[binding.predicateId, RELEASE_PREDICATE_BINDINGS[0]!] as const",
    ));
    const importAMapB = validateReleaseRoleManifest({ gitRoot: root, files, implementationClosures: [] }, manifest);
    assert.ok(importAMapB.some((item) => item.code === "release-bom-generated-map-binding"));

    writeFileSync(compositionPath, compositionSource.replace(
      "return PREDICATE_EVALUATORS.get(predicateId) ?? null;",
      "return RELEASE_PREDICATE_BINDINGS.find((binding) => binding.predicateId === predicateId) ?? null;",
    ));
    const alternateResolver = validateReleaseRoleManifest({ gitRoot: root, files, implementationClosures: [] }, manifest);
    assert.ok(alternateResolver.some((item) => item.code === "release-bom-generated-resolver-binding"));

    writeFileSync(compositionPath, compositionSource);
    const releaseCompositionPath = join(root, "acceptance/gate-core/src/release-composition.ts");
    writeFileSync(releaseCompositionPath, `import { UNLISTED } from "./predicates/unlisted.ts";\n${readFileSync(releaseCompositionPath, "utf8")}\nvoid UNLISTED;\n`);
    const unlistedConcreteImport = validateReleaseRoleManifest({ gitRoot: root, files, implementationClosures: [] }, manifest);
    assert.ok(unlistedConcreteImport.some((item) => item.code === "release-composition-imports-concrete-adapter"));
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

test("deployment bundle loading is allowed only at the exact absolute-path shell", () => {
  const source = [
    "import { pathToFileURL } from 'node:url';",
    "async function load(path: string) { return import(pathToFileURL(path).href); }",
  ].join("\n");
  const allowed = inspectSourceText("apps/searcher-runtime/src/cli.ts", source, {
    allowExternalDeploymentBundleLoader: true,
  });
  assert.equal(allowed.diagnostics.some((item) => item.code === "dynamic-import-nonliteral"), false);
  const wrongPath = inspectSourceText("apps/other/src/cli.ts", source, {
    allowExternalDeploymentBundleLoader: true,
  });
  assert.ok(wrongPath.diagnostics.some((item) => item.code === "dynamic-import-nonliteral"));
  const wrongShape = inspectSourceText("apps/searcher-runtime/src/cli.ts", [
    "import { pathToFileURL } from 'node:url';",
    "async function load(path: string) { return import(pathToFileURL(path + suffix).href); }",
  ].join("\n"), { allowExternalDeploymentBundleLoader: true });
  assert.ok(wrongShape.diagnostics.some((item) => item.code === "dynamic-import-nonliteral"));
});

test("deployment snapshot loading permits only the two exact hash-fenced data URL evaluators", () => {
  for (const expected of [
    {
      functionName: "loadVerifiedDeploymentBundleModuleV1",
      bytes: "bundleModuleBytes",
      hash: "manifest.searcherRuntimeBundleModuleSha256",
    },
    {
      functionName: "loadVerifiedDeploymentCompositionSnapshotV1",
      bytes: "bytes",
      hash: "manifest.deploymentCompositionModuleSha256",
    },
  ] as const) {
    const source = [
      `async function ${expected.functionName}() {`,
      `  const ${expected.bytes} = new Uint8Array();`,
      "  const manifest = { searcherRuntimeBundleModuleSha256: '0x00', deploymentCompositionModuleSha256: '0x00' };",
      `  if (sha256Hex(${expected.bytes}) !== ${expected.hash}) throw new TypeError('hash mismatch');`,
      `  return import(\`data:text/javascript;base64,\${Buffer.from(${expected.bytes}).toString("base64")}#\${${expected.hash}.slice(2)}\`);`,
      "}",
    ].join("\n");
    const baseline = inspectSourceText("apps/searcher-runtime/src/deployment.ts", source);
    assert.equal(baseline.diagnostics.some(item => item.code === "dynamic-import-nonliteral"), false);
    for (const mutation of [
      source.replace(`sha256Hex(${expected.bytes})`, "sha256Hex(otherBytes)"),
      source.replace(`${expected.hash}.slice(2)`, `${expected.hash}.slice(1)`),
      source.replace(expected.functionName, "loadUnownedSnapshot"),
    ]) {
      assert.ok(inspectSourceText("apps/searcher-runtime/src/deployment.ts", mutation).diagnostics
        .some(item => item.code === "dynamic-import-nonliteral"));
    }
  }
});

test("boundary receipt exposes source/build facts only and never claims runtime legacy=0", () => {
  const receipt = runBoundaryGate({ requirePushed: false });
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.candidate.gitRoot, repoRoot);
  assert.equal(receipt.candidate.remoteRef, null);
  assert.equal(receipt.candidate.remoteSha, null);
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
  const fixedRuntime = queryFixedSearcherReleaseRuntimeClosureV1(receipt);
  assert.ok(fixedRuntime);
  assert.equal(fixedRuntime.entrypoint, "apps/searcher-runtime/src/release-runtime.ts");
  assert.equal(fixedRuntime.packageName, "@aloha/searcher-runtime");
  const unrelatedRuntime = receipt.implementationClosures.find(closure =>
    closure.closureDigest !== fixedRuntime.closureDigest);
  assert.ok(unrelatedRuntime);
  assert.equal(queryFixedSearcherReleaseRuntimeClosureV1({ implementationClosures: [unrelatedRuntime] }), null);
  assert.equal(queryFixedSearcherReleaseRuntimeClosureV1({
    implementationClosures: [unrelatedRuntime, fixedRuntime],
  })?.closureDigest, fixedRuntime.closureDigest);
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
    qualifiedRunnerEntrypointId: "compiler-root:tsconfig.json:tools/runtime-release-packager/src/internal/qualified-release-runner-owner.ts",
    predicateAdapterEntrypointIds: ["compiler-root:tsconfig.json:acceptance/gate-core/src/predicates/one.ts"],
    qualificationOracleEntrypointId: "compiler-root:tsconfig.json:acceptance/artifact-lineage-facts/src/reference-model.ts",
    materialProviderEntrypointId: "compiler-root:tsconfig.json:acceptance/collectors/src/material-providers/one.ts",
    releaseRuntimeEntrypointId: "package-entrypoint:package.json:.:acceptance/gate-core/src/generated/release-runtime.ts:tsconfig.json",
  } as const;
  const predicateOnePath = "acceptance/gate-core/src/predicates/one.ts";
  const predicateOneExport = "PREDICATE_EVALUATOR";
  const oracleOnePath = "acceptance/artifact-lineage-facts/src/reference-model.ts";
  const oracleOneExport = "evaluateArtifactLineageOracle";
  const predicateOneSource = "export const PREDICATE_EVALUATOR = Object.freeze({ predicateId: 'fixture.predicate', predicateSpec: { specDigest: '0x" + "2".repeat(64) + "' }, evaluateLive() { return 'pass'; }, adapterVersion: 'fixture-adapter-v1', predicateProgramDescriptorDigest: '0x" + "3".repeat(64) + "', oracleProgramDescriptorDigest: '0x" + "4".repeat(64) + "' });\nexport const PREDICATE_EVALUATOR_ALTERNATE = PREDICATE_EVALUATOR;\n";
  const oracleOneSource = "import { oracleHelper } from './oracle-helper.ts'; export const ORACLE_PROGRAM_DESCRIPTOR_DIGEST = '0x" + "4".repeat(64) + "'; export const ORACLE_VERSION = 'fixture-oracle-v1'; export function evaluateArtifactLineageOracle(_claim: unknown, _observation: unknown, _facts: unknown): unknown { return oracleHelper; } export const evaluateArtifactLineageOracleAlternate = evaluateArtifactLineageOracle;\n";
  const qualifiedRunnerPath = "tools/runtime-release-packager/src/internal/qualified-release-runner-owner.ts";
  const qualifiedRunnerExport = "observeQualifiedReleaseAcceptanceAdvisoryV1";
  const qualifiedRunnerSource = "/// <reference path=\"./qualified-release-runtime-entry.ts\" />\nimport { evaluateGateCore } from '../../../../acceptance/gate-core/src/generated/release-runtime.ts'; export function observeQualifiedReleaseAcceptanceAdvisoryV1(value: unknown): unknown { return evaluateGateCore(value); } export function runFakeQualifiedReleaseAcceptanceV1(value: unknown): unknown { return value; }\n";
  const qualifiedRunnerRuntimeEntryPath = "tools/runtime-release-packager/src/internal/qualified-release-runtime-entry.ts";
  const qualifiedRunnerHostPath = "tools/runtime-release-packager/src/internal/fresh-qualified-runner-host-owner.ts";
  const materialBridgePath = "acceptance/collectors/src/internal/predicate-material-source-bridge-issuer.ts";
  const materialOwnerPath = "acceptance/collectors/src/internal/predicate-material-source-owner.ts";
  const qualifiedRunnerExportDigest = computeImplementationExportDigest(qualifiedRunnerPath, qualifiedRunnerExport, sha256(Buffer.from(qualifiedRunnerSource)));
  const materialProviderOnePath = "acceptance/collectors/src/material-providers/one.ts";
  const materialProviderOneExport = "MATERIAL_PROVIDER";
  const materialProviderOneSource = "export const MATERIAL_PROVIDER = Object.freeze({ predicateId: 'fixture.predicate', providerContractVersion: '1.0.0', providerContractDigest: '0x" + "a".repeat(64) + "' }); export const MATERIAL_PROVIDER_ALTERNATE = MATERIAL_PROVIDER;\n";
  const materialProviderOneExportDigest = computeImplementationExportDigest(materialProviderOnePath, materialProviderOneExport, sha256(Buffer.from(materialProviderOneSource)));
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
    commonEnvelopeRoleContractVersion: "1.0.0",
    materialProviderModulePath: materialProviderOnePath,
    materialProviderExportName: materialProviderOneExport,
    materialProviderContractDigest: `0x${"a".repeat(64)}`,
    materialProviderImplementationExportDigest: materialProviderOneExportDigest,
  };
  const leafOne = computePredicateCompositionLeafDigest(leafOneInput);
  const manifestBase = {
    schemaVersion: 1 as const,
    commonEnvelopeRoleContractVersion: "1.0.0",
    genericCore: { entrypointId: roles.genericCoreEntrypointId, modulePath: "acceptance/gate-core/src/index.ts", exportName: "evaluateGateCoreRuntime" },
    qualifiedRunner: { entrypointId: roles.qualifiedRunnerEntrypointId, modulePath: qualifiedRunnerPath, exportName: qualifiedRunnerExport, implementationExportDigest: qualifiedRunnerExportDigest },
    predicateAdapters: [{
      entrypointId: roles.predicateAdapterEntrypointIds[0]!,
      ...leafOneInput,
      compositionLeafDigest: leafOne,
      oracleEntrypointId: roles.qualificationOracleEntrypointId,
      materialProviderEntrypointId: roles.materialProviderEntrypointId,
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
    mkdirSync(join(root, "acceptance", "collectors", "src", "material-providers"), { recursive: true });
    mkdirSync(join(root, "tools", "runtime-release-packager", "src", "internal"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "release-closures-fixture", private: true, type: "module", exports: { ".": "./acceptance/gate-core/src/generated/release-runtime.ts" } }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("release-closures-fixture"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true },
      include: ["acceptance/**/*.ts", "tools/**/*.ts"],
    }));
    writeFileSync(join(root, "acceptance", "gate-core", "src", "index.ts"), "export function createReleaseAuthorityUnavailableResult(): unknown { return null; } export function evaluateGateCoreRuntime(_authority: unknown, _input: unknown, _composition: unknown, _now: string): unknown { return null; }\n");
    writeFileSync(join(root, predicateOnePath), predicateOneSource);
    writeFileSync(join(root, "acceptance", "artifact-lineage-facts", "src", "oracle-helper.ts"), "export const oracleHelper = 1;\n");
    writeFileSync(join(root, oracleOnePath), oracleOneSource);
    writeFileSync(join(root, qualifiedRunnerPath), qualifiedRunnerSource);
    writeFileSync(join(root, qualifiedRunnerRuntimeEntryPath), "import '../../../../acceptance/collectors/src/internal/predicate-material-source-bridge-issuer.ts'; import './fresh-qualified-runner-host-owner.ts'; export const FRESH_RUNTIME_ENTRY = true;\n");
    writeFileSync(join(root, qualifiedRunnerHostPath), "import '../../../../acceptance/collectors/src/internal/predicate-material-source-owner.ts'; export const FRESH_RUNNER_HOST = true;\n");
    mkdirSync(join(root, "acceptance", "collectors", "src", "internal"), { recursive: true });
    writeFileSync(join(root, materialBridgePath), "import './predicate-material-source-owner.ts'; export const MATERIAL_SOURCE_BRIDGE = true;\n");
    writeFileSync(join(root, materialOwnerPath), "export const MATERIAL_SOURCE_OWNER = true;\n");
    writeFileSync(join(root, materialProviderOnePath), materialProviderOneSource);
    writeFileSync(join(root, "acceptance", "gate-core", "src", "release-composition.ts"), "import { PREDICATE_EVALUATOR } from './predicates/one.ts';\nconst PREDICATE_ENTRY_ONE = Object.freeze({ predicateId: 'fixture.predicate', predicateSpecDigest: '0x" + "2".repeat(64) + "', predicateProgramDescriptorDigest: '0x" + "3".repeat(64) + "', oracleProgramDescriptorDigest: '0x" + "4".repeat(64) + "', adapterVersion: 'fixture-adapter-v1', oracleVersion: 'fixture-oracle-v1', compositionLeafDigest: '" + leafOne + "', modulePath: 'acceptance/gate-core/src/predicates/one.ts', exportName: 'PREDICATE_EVALUATOR', oracleModulePath: 'acceptance/artifact-lineage-facts/src/reference-model.ts', oracleExportName: 'evaluateArtifactLineageOracle' });\nexport const RELEASE_ROLE_COMPOSITION = Object.freeze({ schemaVersion: 1, genericCore: {}, releaseRuntime: {}, predicateAdapters: [PREDICATE_ENTRY_ONE] });\nexport const PREDICATE_COMPOSITION_ENTRIES = Object.freeze([PREDICATE_ENTRY_ONE]);\nexport const PREDICATE_COMPOSITION_ROOT_DIGEST = '" + manifest.predicateCompositionRootDigest + "';\nexport function resolvePredicateEvaluator(id: string): unknown { return id === 'fixture.predicate' ? PREDICATE_EVALUATOR : null; }\n");
    writeFileSync(join(root, "acceptance", "gate-core", "src", "generated", "release-authority.ts"), "export const RELEASE_AUTHORITY: unknown = null;\n");
    writeFileSync(join(root, "acceptance", "gate-core", "src", "generated", "predicate-composition.ts"), "import { MATERIAL_PROVIDER } from '../../../collectors/src/material-providers/one.ts'; void MATERIAL_PROVIDER; export { PREDICATE_COMPOSITION_ROOT_DIGEST, resolvePredicateEvaluator } from '../release-composition.ts';\n");
    writeFileSync(join(root, "acceptance", "gate-core", "src", "generated", "release-runtime.ts"), "import { createReleaseAuthorityUnavailableResult } from '../index.ts'; import { PREDICATE_COMPOSITION_ROOT_DIGEST, resolvePredicateEvaluator } from './predicate-composition.ts'; void PREDICATE_COMPOSITION_ROOT_DIGEST; void resolvePredicateEvaluator; export function evaluateGateCore(_untrustedInput: unknown): unknown { return createReleaseAuthorityUnavailableResult(); }\n");
    writeGeneratedReleaseManifestFixture(root, manifest);
    runGit("add", ".");
    runGit("commit", "-m", "release closure fixture");
    const baseline = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(baseline.verdict, "invalid");
    assert.ok(baseline.diagnostics.some((item) => item.code === "generated-regeneration-contract-missing"));
    assert.ok(baseline.releaseClosures, JSON.stringify(baseline.diagnostics));
    assert.deepEqual(validateReleaseClosureFacts(baseline, baseline.releaseClosures), []);
    const callerSelected = deriveReleaseClosureFacts(baseline, roles as unknown as ReleaseRoleManifestV1);
    assert.equal(callerSelected.facts, null);
    assert.ok(callerSelected.diagnostics.some((item) => item.code === "release-role-manifest-required"));
    const baselineFacts = baseline.releaseClosures;
    assert.ok(baseline.candidate.headSha);
    const runnerApproval = {
      candidateReleaseCommit: baseline.candidate.headSha,
      releaseRoleManifestRoot: manifest.rootDigest,
      qualifiedRunnerImplementationClosureDigest: baselineFacts.qualifiedRunner.closureDigest,
      qualifiedRunnerImplementationExportDigest: baselineFacts.qualifiedRunner.implementationExportDigest!,
    };
    assert.throws(
      () => assertQualifiedRunnerApprovalJoinsBoundaryReceiptV1(baseline, runnerApproval as never, []),
      /was not issued as a successful production observation/,
    );
    for (const mutation of [
      { ...runnerApproval, qualifiedRunnerImplementationClosureDigest: `0x${"0".repeat(64)}` },
      { ...runnerApproval, qualifiedRunnerImplementationExportDigest: `0x${"0".repeat(64)}` },
      { ...runnerApproval, candidateReleaseCommit: "0".repeat(40) },
    ]) {
      assert.throws(() => assertQualifiedRunnerApprovalJoinsBoundaryReceiptV1(baseline, mutation as never, []), /was not issued as a successful production observation/);
    }
    assert.throws(() => assertQualifiedRunnerApprovalJoinsBoundaryReceiptV1({ ...baseline }, runnerApproval as never, []), /was not issued as a successful production observation/);
    const baselineOne = baselineFacts.predicateAdapters[0];
    assert.ok(baselineOne);

    const sharedRootLeafInput = {
      ...leafOneInput,
      exportName: "PREDICATE_EVALUATOR_ALTERNATE",
      predicateId: "fixture.predicate.shared-root",
      predicateSpecDigest: `0x${"6".repeat(64)}`,
      predicateProgramDescriptorDigest: `0x${"7".repeat(64)}`,
      oracleProgramDescriptorDigest: `0x${"8".repeat(64)}`,
      adapterVersion: "fixture-adapter-shared-root",
      oracleVersion: "fixture-oracle-shared-root",
      predicateImplementationExportDigest: computeImplementationExportDigest(
        predicateOnePath,
        "PREDICATE_EVALUATOR_ALTERNATE",
        sha256(Buffer.from(predicateOneSource)),
      ),
      oracleExportName: "evaluateArtifactLineageOracleAlternate",
      oracleImplementationExportDigest: computeImplementationExportDigest(
        oracleOnePath,
        "evaluateArtifactLineageOracleAlternate",
        sha256(Buffer.from(oracleOneSource)),
      ),
      materialProviderExportName: "MATERIAL_PROVIDER_ALTERNATE",
      materialProviderContractDigest: `0x${"b".repeat(64)}`,
      materialProviderImplementationExportDigest: computeImplementationExportDigest(
        materialProviderOnePath,
        "MATERIAL_PROVIDER_ALTERNATE",
        sha256(Buffer.from(materialProviderOneSource)),
      ),
    };
    const sharedRootLeaf = computePredicateCompositionLeafDigest(sharedRootLeafInput);
    const { rootDigest: _sharedRootManifestRoot, ...sharedRootManifestWithoutRoot } = manifest;
    const sharedRootManifestBase = {
      ...sharedRootManifestWithoutRoot,
      predicateAdapters: [
        ...manifest.predicateAdapters,
        {
          entrypointId: roles.predicateAdapterEntrypointIds[0]!,
          ...sharedRootLeafInput,
          compositionLeafDigest: sharedRootLeaf,
          oracleEntrypointId: roles.qualificationOracleEntrypointId,
          materialProviderEntrypointId: roles.materialProviderEntrypointId,
        },
      ],
      predicateCompositionRootDigest: computePredicateCompositionRootDigest([leafOne, sharedRootLeaf]),
    };
    const sharedRootManifest = {
      ...sharedRootManifestBase,
      rootDigest: computeReleaseRoleManifestRootDigest(sharedRootManifestBase),
    } satisfies ReleaseRoleManifestV1;
    const sharedRootDerivation = deriveReleaseClosureFacts(baseline, sharedRootManifest);
    assert.ok(sharedRootDerivation.facts, JSON.stringify(sharedRootDerivation.diagnostics));
    assert.equal(sharedRootDerivation.facts.predicateAdapters.length, 2);
    assert.equal(sharedRootDerivation.facts.qualificationOracles.length, 2);
    assert.notEqual(
      sharedRootDerivation.facts.predicateAdapters[0]!.implementationExportDigest,
      sharedRootDerivation.facts.predicateAdapters[1]!.implementationExportDigest,
    );

    for (const mutation of [
      { field: "exportName" as const, value: "PREDICATE_EVALUATOR_ALTERNATE", expected: "release-export-digest-mismatch" },
      { field: "oracleExportName" as const, value: "evaluateArtifactLineageOracleAlternate", expected: "release-export-digest-mismatch" },
    ]) {
      const { rootDigest: _rootDigest, ...withoutRoot } = manifest;
      const mutatedBase = {
        ...withoutRoot,
        predicateAdapters: manifest.predicateAdapters.map((entry) => ({ ...entry, [mutation.field]: mutation.value })),
      };
      const mutatedManifest = { ...mutatedBase, rootDigest: computeReleaseRoleManifestRootDigest(mutatedBase) };
      const mutationDiagnostics = deriveReleaseClosureFacts(baseline, mutatedManifest).diagnostics;
      assert.ok(mutationDiagnostics.some((item) => item.code === mutation.expected), JSON.stringify(mutationDiagnostics));
      assert.ok(mutationDiagnostics.some((item) => item.code === "release-bom-leaf-mismatch"), JSON.stringify(mutationDiagnostics));
    }

    for (const mutation of [
      { value: { ...manifest.qualifiedRunner, exportName: "runFakeQualifiedReleaseAcceptanceV1" }, expected: "release-export-digest-mismatch" },
      { value: { ...manifest.qualifiedRunner, implementationExportDigest: `0x${"0".repeat(64)}` }, expected: "release-export-digest-mismatch" },
      { value: { ...manifest.qualifiedRunner, entrypointId: "compiler-root:tsconfig.json:tools/runtime-release-packager/src/internal/stale-runner.ts" }, expected: "release-role-entrypoint-missing" },
    ]) {
      const { rootDigest: _rootDigest, ...withoutRoot } = manifest;
      const mutatedBase = { ...withoutRoot, qualifiedRunner: mutation.value };
      const mutatedManifest = { ...mutatedBase, rootDigest: computeReleaseRoleManifestRootDigest(mutatedBase) };
      const mutationDiagnostics = deriveReleaseClosureFacts(baseline, mutatedManifest).diagnostics;
      assert.ok(mutationDiagnostics.some((item) => item.code === mutation.expected), JSON.stringify(mutationDiagnostics));
    }

    const staleProviderBase = {
      ...manifestBase,
      predicateAdapters: manifest.predicateAdapters.map((entry) => ({
        ...entry,
        materialProviderExportName: "MATERIAL_PROVIDER_ALTERNATE",
      })),
    };
    const staleProviderManifest = { ...staleProviderBase, rootDigest: computeReleaseRoleManifestRootDigest(staleProviderBase) };
    const staleProviderDiagnostics = deriveReleaseClosureFacts(baseline, staleProviderManifest).diagnostics;
    assert.ok(staleProviderDiagnostics.some((item) => item.code === "release-export-digest-mismatch"), JSON.stringify(staleProviderDiagnostics));
    assert.ok(staleProviderDiagnostics.some((item) => item.code === "release-bom-leaf-mismatch"), JSON.stringify(staleProviderDiagnostics));

    const mutatedRunnerSource = `${qualifiedRunnerSource}export const RUNNER_SOURCE_MUTATION = true;\n`;
    writeFileSync(join(root, qualifiedRunnerPath), mutatedRunnerSource);
    const mutatedRunnerManifestBase = {
      ...manifestBase,
      qualifiedRunner: {
        ...manifest.qualifiedRunner,
        implementationExportDigest: computeImplementationExportDigest(qualifiedRunnerPath, qualifiedRunnerExport, sha256(Buffer.from(mutatedRunnerSource))),
      },
    };
    writeGeneratedReleaseManifestFixture(root, { ...mutatedRunnerManifestBase, rootDigest: computeReleaseRoleManifestRootDigest(mutatedRunnerManifestBase) });
    runGit("add", ".");
    runGit("commit", "-m", "mutate qualified runner source");
    const mutatedRunner = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.ok(mutatedRunner.releaseClosures, JSON.stringify(mutatedRunner.diagnostics));
    assert.notEqual(mutatedRunner.releaseClosures.qualifiedRunner.closureDigest, baselineFacts.qualifiedRunner.closureDigest);
    assert.notEqual(mutatedRunner.releaseClosures.rootDigest, baselineFacts.rootDigest);
    writeFileSync(join(root, qualifiedRunnerPath), qualifiedRunnerSource);
    writeGeneratedReleaseManifestFixture(root, manifest);
    runGit("add", ".");
    runGit("commit", "-m", "restore qualified runner source");

    const runnerWithoutRuntimeReference = qualifiedRunnerSource.replace(
      "/// <reference path=\"./qualified-release-runtime-entry.ts\" />\n",
      "",
    );
    writeFileSync(join(root, qualifiedRunnerPath), runnerWithoutRuntimeReference);
    const missingRuntimeReferenceManifestBase = {
      ...manifestBase,
      qualifiedRunner: {
        ...manifest.qualifiedRunner,
        implementationExportDigest: computeImplementationExportDigest(
          qualifiedRunnerPath,
          qualifiedRunnerExport,
          sha256(Buffer.from(runnerWithoutRuntimeReference)),
        ),
      },
    };
    writeGeneratedReleaseManifestFixture(root, {
      ...missingRuntimeReferenceManifestBase,
      rootDigest: computeReleaseRoleManifestRootDigest(missingRuntimeReferenceManifestBase),
    });
    runGit("add", ".");
    runGit("commit", "-m", "reject qualified runner without runtime entry binding");
    const missingRuntimeReference = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.ok(missingRuntimeReference.diagnostics.some((item) => item.code === "release-qualified-runner-closure-input-missing"), JSON.stringify(missingRuntimeReference.diagnostics));
    assert.ok(missingRuntimeReference.diagnostics.some((item) => item.code === "release-qualified-runner-runtime-reference-missing"), JSON.stringify(missingRuntimeReference.diagnostics));
    writeFileSync(join(root, qualifiedRunnerPath), qualifiedRunnerSource);
    writeGeneratedReleaseManifestFixture(root, manifest);
    runGit("add", ".");
    runGit("commit", "-m", "restore qualified runner runtime entry binding");

    const baselineRuntimeSource = readFileSync(join(root, "acceptance", "gate-core", "src", "generated", "release-runtime.ts"), "utf8");
    writeFileSync(join(root, "acceptance", "gate-core", "src", "generated", "release-runtime.ts"), baselineRuntimeSource.replace(
      "return createReleaseAuthorityUnavailableResult();",
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
    const materialProviderTwoPath = "acceptance/collectors/src/material-providers/two.ts";
    const materialProviderTwoExport = "MATERIAL_PROVIDER_TWO";
    const materialProviderTwoSource = "export const MATERIAL_PROVIDER_TWO = Object.freeze({ predicateId: 'fixture.predicate.two', providerContractVersion: '1.0.0', providerContractDigest: '0x" + "b".repeat(64) + "' });\n";
    const predicateTwoExportDigest = computeImplementationExportDigest(predicateTwoPath, predicateTwoExport, sha256(Buffer.from(predicateTwoSource)));
    const oracleTwoExportDigest = computeImplementationExportDigest(oracleTwoPath, oracleTwoExport, sha256(Buffer.from(oracleTwoSource)));
    const materialProviderTwoExportDigest = computeImplementationExportDigest(materialProviderTwoPath, materialProviderTwoExport, sha256(Buffer.from(materialProviderTwoSource)));
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
      commonEnvelopeRoleContractVersion: "1.0.0",
      materialProviderModulePath: materialProviderTwoPath,
      materialProviderExportName: materialProviderTwoExport,
      materialProviderContractDigest: `0x${"b".repeat(64)}`,
      materialProviderImplementationExportDigest: materialProviderTwoExportDigest,
    };
    const leafTwo = computePredicateCompositionLeafDigest(leafTwoInput);
    writeFileSync(join(root, predicateTwoPath), predicateTwoSource);
    writeFileSync(join(root, oracleTwoPath), oracleTwoSource);
    writeFileSync(join(root, materialProviderTwoPath), materialProviderTwoSource);
    writeFileSync(join(root, "acceptance", "gate-core", "src", "generated", "predicate-composition.ts"), "import { MATERIAL_PROVIDER } from '../../../collectors/src/material-providers/one.ts'; import { MATERIAL_PROVIDER_TWO } from '../../../collectors/src/material-providers/two.ts'; void MATERIAL_PROVIDER; void MATERIAL_PROVIDER_TWO; export { PREDICATE_COMPOSITION_ROOT_DIGEST, resolvePredicateEvaluator } from '../release-composition.ts';\n");
    const expandedRoot = computePredicateCompositionRootDigest([leafOne, leafTwo]);
    writeFileSync(join(root, "acceptance", "gate-core", "src", "release-composition.ts"), "import { PREDICATE_EVALUATOR } from './predicates/one.ts'; import { PREDICATE_TWO } from './predicates/two.ts';\nconst PREDICATE_ENTRY_ONE = Object.freeze({ predicateId: 'fixture.predicate', predicateSpecDigest: '0x" + "2".repeat(64) + "', predicateProgramDescriptorDigest: '0x" + "3".repeat(64) + "', oracleProgramDescriptorDigest: '0x" + "4".repeat(64) + "', adapterVersion: 'fixture-adapter-v1', oracleVersion: 'fixture-oracle-v1', compositionLeafDigest: '0x1111111111111111111111111111111111111111111111111111111111111111', modulePath: 'acceptance/gate-core/src/predicates/one.ts', exportName: 'PREDICATE_EVALUATOR', oracleModulePath: 'acceptance/artifact-lineage-facts/src/reference-model.ts', oracleExportName: 'evaluateArtifactLineageOracle' });\nconst PREDICATE_ENTRY_TWO = Object.freeze({ predicateId: 'fixture.predicate.two', predicateSpecDigest: '0x" + "6".repeat(64) + "', predicateProgramDescriptorDigest: '0x" + "7".repeat(64) + "', oracleProgramDescriptorDigest: '0x" + "8".repeat(64) + "', adapterVersion: 'fixture-adapter-v2', oracleVersion: 'fixture-oracle-v2', compositionLeafDigest: '0x5555555555555555555555555555555555555555555555555555555555555555', modulePath: 'acceptance/gate-core/src/predicates/two.ts', exportName: 'PREDICATE_TWO', oracleModulePath: 'acceptance/artifact-lineage-facts/src/oracle-two.ts', oracleExportName: 'evaluateArtifactLineageOracleTwo' });\nexport const RELEASE_ROLE_COMPOSITION = Object.freeze({ schemaVersion: 1, genericCore: {}, releaseRuntime: {}, predicateAdapters: [PREDICATE_ENTRY_ONE, PREDICATE_ENTRY_TWO] });\nexport const PREDICATE_COMPOSITION_ENTRIES = Object.freeze([PREDICATE_ENTRY_ONE, PREDICATE_ENTRY_TWO]);\nexport const PREDICATE_COMPOSITION_ROOT_DIGEST = '" + expandedRoot + "';\nexport function resolvePredicateEvaluator(id: string): unknown { return id === 'fixture.predicate' ? PREDICATE_EVALUATOR : id === 'fixture.predicate.two' ? PREDICATE_TWO : null; }\n");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true },
      include: ["acceptance/**/*.ts", "tools/**/*.ts"],
    }));
    runGit("add", ".");
    runGit("commit", "-m", "add unrelated predicate leaf");
    const { rootDigest: _baselineManifestRoot, ...manifestWithoutRoot } = manifest;
    const expandedManifestBase = {
      ...manifestWithoutRoot,
      predicateAdapters: [
        ...manifest.predicateAdapters,
        { entrypointId: "compiler-root:tsconfig.json:acceptance/gate-core/src/predicates/two.ts", ...leafTwoInput, compositionLeafDigest: leafTwo, oracleEntrypointId: "compiler-root:tsconfig.json:acceptance/artifact-lineage-facts/src/oracle-two.ts", materialProviderEntrypointId: "compiler-root:tsconfig.json:acceptance/collectors/src/material-providers/two.ts" },
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
    commonEnvelopeRoleContractVersion: "1.0.0",
    genericCore: { entrypointId: "core", modulePath: "acceptance/gate-core/src/index.ts", exportName: "evaluateGateCoreRuntime" },
    qualifiedRunner: { entrypointId: "runner", modulePath: "tools/runtime-release-packager/src/internal/qualified-release-runner-owner.ts", exportName: "observeQualifiedReleaseAcceptanceAdvisoryV1", implementationExportDigest: `0x${"c".repeat(64)}` },
    predicateAdapters: [
      { entrypointId: "predicate-a", modulePath: "acceptance/gate-core/src/predicates/a.ts", exportName: "A", predicateId: "same", predicateSpecDigest: `0x${"2".repeat(64)}`, predicateProgramDescriptorDigest: `0x${"4".repeat(64)}`, oracleProgramDescriptorDigest: `0x${"5".repeat(64)}`, adapterVersion: "adapter-a", oracleVersion: "oracle-a", compositionLeafDigest: leaf, predicateImplementationExportDigest: `0x${"8".repeat(64)}`, oracleImplementationExportDigest: `0x${"9".repeat(64)}`, oracleEntrypointId: "oracle-a", oracleModulePath: "qualification/a.ts", oracleExportName: "oracleA", commonEnvelopeRoleContractVersion: "1.0.0", materialProviderContractDigest: `0x${"c".repeat(64)}`, materialProviderImplementationExportDigest: `0x${"d".repeat(64)}`, materialProviderEntrypointId: "provider-a", materialProviderModulePath: "acceptance/collectors/src/material-providers/a.ts", materialProviderExportName: "providerA" },
      { entrypointId: "predicate-b", modulePath: "acceptance/gate-core/src/predicates/b.ts", exportName: "B", predicateId: "same", predicateSpecDigest: `0x${"3".repeat(64)}`, predicateProgramDescriptorDigest: `0x${"6".repeat(64)}`, oracleProgramDescriptorDigest: `0x${"7".repeat(64)}`, adapterVersion: "adapter-b", oracleVersion: "oracle-b", compositionLeafDigest: leaf, predicateImplementationExportDigest: `0x${"a".repeat(64)}`, oracleImplementationExportDigest: `0x${"b".repeat(64)}`, oracleEntrypointId: "oracle-b", oracleModulePath: "qualification/b.ts", oracleExportName: "oracleB", commonEnvelopeRoleContractVersion: "1.0.0", materialProviderContractDigest: `0x${"e".repeat(64)}`, materialProviderImplementationExportDigest: `0x${"f".repeat(64)}`, materialProviderEntrypointId: "provider-b", materialProviderModulePath: "acceptance/collectors/src/material-providers/b.ts", materialProviderExportName: "providerB" },
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

test("only six exact neutral Fact Contracts may be shared across release roles", () => {
  const file = (path: string, fileClass: TrackedFile["fileClass"] = "acceptance-pure-core"): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass,
  });
  const shared = [
    "acceptance/artifact-lineage-facts/src/oracle-descriptor.ts",
    "acceptance/artifact-lineage-facts/src/schema.ts",
    "acceptance/full-family-facts/src/schema.ts",
    "acceptance/performance-facts/src/schema.ts",
    "acceptance/runtime-acceptance-facts/src/spec.ts",
    "acceptance/terminal-selection-facts/src/schema.ts",
  ];
  const neutralSpec = "specs/qualification/src/index.ts";
  const canonicalCodec = "packages/canonical-codec/src/index.ts";
  const forbidden = [
    "acceptance/gate-core/src/predicates/artifact-lineage.ts",
    "acceptance/performance-facts/src/runtime.ts",
    "acceptance/terminal-selection-facts/src/reference-model.ts",
    "specs/candidate-partition-authority/src/internal/issuer-state.ts",
    "@external/node:fs",
    "acceptance/artifact-lineage-facts/src/schema-helper.ts",
  ];
  const files = [
    ...shared.map(path => file(path)),
    file(neutralSpec, "central"),
    file(canonicalCodec, "central"),
    ...forbidden
      .filter(path => !path.startsWith("@external/"))
      .map(path => file(path, path.includes("reference-model") ? "reference-only" : "acceptance-pure-core")),
  ];
  const allowedDiagnostics: BoundaryDiagnostic[] = [];
  validateDependencyBoundaries(files, shared.flatMap(from => [
    { from, to: neutralSpec, specifier: "../../../specs/qualification/src/index.ts" },
    { from, to: canonicalCodec, specifier: "../../../packages/canonical-codec/src/index.ts" },
  ]), allowedDiagnostics);
  assert.ok(!allowedDiagnostics.some(item => item.code === "release-shared-fact-contract-import"));

  const forbiddenDiagnostics: BoundaryDiagnostic[] = [];
  validateDependencyBoundaries(files, shared.map((from, index) => ({
    from,
    to: forbidden[index]!,
    specifier: ["./predicate.ts", "./runtime.ts", "./reference-model.ts", "../../../specs/candidate-partition-authority/src/internal/issuer-state.ts", "node:fs", "./schema-helper.ts"][index]!,
  })), forbiddenDiagnostics);
  assert.equal(
    forbiddenDiagnostics.filter(item => item.code === "release-shared-fact-contract-import").length,
    shared.length,
  );
});

test("Family asset identity and generated/runtime witness edges stay exact and default-deny", () => {
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
    file("families/demo/src/public.ts", "family"),
    file("packages/asset-ref/src/index.ts", "central"),
    file("packages/asset-ref/src/internal/owner.ts", "central"),
    file("tools/historical-family-current-evaluation/src/candidate-generated-search-adapter.ts", "authoring"),
    file("tools/historical-family-current-evaluation/src/other.ts", "authoring"),
    file("generated/runtime-composition/index.ts", "generated"),
    file("packages/runtime-release-authority/src/internal/economic-safety-owner.ts", "central"),
    file("packages/other/src/index.ts", "central"),
    file("generated/safety-profile/index.ts", "generated"),
    file("apps/searcher-runtime/src/runtime-acceptance-evidence.ts", "production-runtime"),
    file("apps/searcher-runtime/src/other.ts", "production-runtime"),
    file("tools/runtime-release-packager/src/pre-release-staging-contract.ts", "authoring"),
    file("packages/runtime-release-authority/src/internal/bootstrap.ts", "central"),
    file("runtime/revm-workers/src/index.ts", "production-runtime"),
  ];
  const edges: GraphEdge[] = [
    { from: "families/demo/src/public.ts", to: "packages/asset-ref/src/index.ts", specifier: "../../../packages/asset-ref/src/index.ts" },
    { from: "families/demo/src/public.ts", to: "packages/asset-ref/src/internal/owner.ts", specifier: "../../../packages/asset-ref/src/internal/owner.ts" },
    { from: "tools/historical-family-current-evaluation/src/candidate-generated-search-adapter.ts", to: "generated/runtime-composition/index.ts", specifier: "../../../generated/runtime-composition/index.ts" },
    { from: "tools/historical-family-current-evaluation/src/other.ts", to: "generated/runtime-composition/index.ts", specifier: "../../../generated/runtime-composition/index.ts" },
    { from: "packages/runtime-release-authority/src/internal/economic-safety-owner.ts", to: "generated/safety-profile/index.ts", specifier: "../../../../generated/safety-profile/index.ts" },
    { from: "packages/other/src/index.ts", to: "generated/safety-profile/index.ts", specifier: "../../../generated/safety-profile/index.ts" },
    { from: "apps/searcher-runtime/src/runtime-acceptance-evidence.ts", to: "tools/runtime-release-packager/src/pre-release-staging-contract.ts", specifier: "../../../tools/runtime-release-packager/src/pre-release-staging-contract.ts" },
    { from: "apps/searcher-runtime/src/other.ts", to: "tools/runtime-release-packager/src/pre-release-staging-contract.ts", specifier: "../../../tools/runtime-release-packager/src/pre-release-staging-contract.ts" },
    { from: "packages/runtime-release-authority/src/internal/bootstrap.ts", to: "runtime/revm-workers/src/index.ts", specifier: "../../../../runtime/revm-workers/src/index.ts" },
    { from: "packages/other/src/index.ts", to: "runtime/revm-workers/src/index.ts", specifier: "../../../runtime/revm-workers/src/index.ts" },
  ];
  const diagnostics: BoundaryDiagnostic[] = [];
  validateDependencyBoundaries(files, edges, diagnostics);
  assert.equal(diagnostics.filter(item => item.path === "families/demo/src/public.ts" && item.code === "family-imports-forbidden-central").length, 1);
  assert.ok(diagnostics.some(item => item.path === "tools/historical-family-current-evaluation/src/other.ts" && item.code === "generated-consumer-boundary"));
  assert.ok(diagnostics.some(item => item.path === "packages/other/src/index.ts" && item.code === "central-imports-generated"));
  assert.ok(diagnostics.some(item => item.path === "apps/searcher-runtime/src/other.ts" && item.code === "runtime-imports-authoring"));
  assert.ok(diagnostics.some(item => item.path === "packages/other/src/index.ts" && item.code === "central-imports-runtime"));
  assert.ok(!diagnostics.some(item => item.path === "tools/historical-family-current-evaluation/src/candidate-generated-search-adapter.ts"));
  assert.ok(!diagnostics.some(item => item.path === "packages/runtime-release-authority/src/internal/economic-safety-owner.ts"));
  assert.ok(!diagnostics.some(item => item.path === "apps/searcher-runtime/src/runtime-acceptance-evidence.ts"));
  assert.ok(!diagnostics.some(item => item.path === "packages/runtime-release-authority/src/internal/bootstrap.ts" && item.code === "central-imports-runtime"));
});

test("exact current-evaluation generated reader rejects an extra generated export", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-current-evaluation-generated-boundary-"));
  const from = "tools/historical-family-current-evaluation/src/candidate-generated-search-adapter.ts";
  const to = "generated/runtime-composition/index.ts";
  try {
    mkdirSync(join(root, dirname(from)), { recursive: true });
    writeFileSync(join(root, from), [
      'import { createReleaseFamilyRuntimeComposition, createReleaseStrategyRuntimeComposition } from "../../../generated/runtime-composition/index.ts";',
      "void createReleaseFamilyRuntimeComposition;",
      "void createReleaseStrategyRuntimeComposition;",
      "",
    ].join("\n"));
    const tracked = (path: string, fileClass: TrackedFile["fileClass"]): TrackedFile => ({
      path,
      mode: "100644",
      blobSha: "a".repeat(40),
      contentSha256: `0x${"a".repeat(64)}`,
      byteLength: 1,
      language: "typescript",
      fileClass,
    });
    const diagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [tracked(from, "authoring"), tracked(to, "generated")],
      [{ from, to, specifier: "../../../generated/runtime-composition/index.ts" }],
      diagnostics,
      root,
    );
    assert.ok(diagnostics.some(item => item.code === "narrow-port-import-mismatch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-release fact log consumes only the exact public root-owned Ready Graph observer", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-ready-graph-observer-boundary-"));
  const factLogPath = "tools/pre-release-fact-log/src/index.ts";
  const observerPath = "tools/runtime-release-packager/src/pre-release-b-active-ready-graph-observer.ts";
  const ownerPath = "tools/runtime-release-packager/src/internal/pre-release-b-active-ready-graph-owner.ts";
  const otherPath = "tools/other-reader/src/index.ts";
  const specifier = "../../runtime-release-packager/src/pre-release-b-active-ready-graph-observer.ts";
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: "authoring",
  });
  const files = [file(factLogPath), file(observerPath), file(ownerPath), file(otherPath)];
  const publicEdge: GraphEdge = { from: factLogPath, to: observerPath, specifier };
  const inspect = (source: string, edges: readonly GraphEdge[]): readonly BoundaryDiagnostic[] => {
    mkdirSync(join(root, dirname(factLogPath)), { recursive: true });
    writeFileSync(join(root, factLogPath), source);
    const diagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(files, edges, diagnostics, root);
    return diagnostics;
  };
  try {
    const exact = [
      `import { assertActiveReadyGraphCoarseSweepDenominatorV1, observeFrozenPreReleaseBActiveReadyGraphV1 } from "${specifier}";`,
      `import type { ProductionActiveReadyGraphSnapshotV1 } from "${specifier}";`,
    ].join("\n");
    assert.deepEqual(inspect(exact, [publicEdge]), []);
    assert.ok(inspect(`${exact}\nimport { extra } from "${specifier}";`, [publicEdge])
      .some(item => item.code === "narrow-port-import-mismatch"));
    assert.ok(inspect(exact, [{ from: otherPath, to: observerPath, specifier }])
      .some(item => item.code === "pre-release-ready-graph-observer-consumer"));
    assert.ok(inspect(exact, [
      publicEdge,
      { from: factLogPath, to: ownerPath, specifier: "../../runtime-release-packager/src/internal/pre-release-b-active-ready-graph-owner.ts" },
    ]).some(item => item.code === "pre-release-ready-graph-owner-cross-tool"));
    assert.ok(inspect("export {};", [])
      .some(item => item.code === "pre-release-ready-graph-observer-edge-missing"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final pre-release owns the exact opaque terminal physical FactLog path", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-terminal-physical-boundary-"));
  const factLogPath = "tools/pre-release-fact-log/src/index.ts";
  const physicalPath = "tools/runtime-release-packager/src/pre-release-b-terminal-physical-observation.ts";
  const runnerPath = "tools/runtime-release-packager/src/final-pre-release-runner.ts";
  const otherPath = "tools/other-reader/src/index.ts";
  const physicalSpecifier = "../../runtime-release-packager/src/pre-release-b-terminal-physical-observation.ts";
  const factLogSpecifier = "../../pre-release-fact-log/src/index.ts";
  const file = (path: string): TrackedFile => ({
    path, mode: "100644", blobSha: "a".repeat(40), contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1, language: "typescript", fileClass: "authoring",
  });
  const files = [file(factLogPath), file(physicalPath), file(runnerPath), file(otherPath)];
  const physicalEdge: GraphEdge = { from: factLogPath, to: physicalPath, specifier: physicalSpecifier };
  const runnerEdge: GraphEdge = { from: runnerPath, to: factLogPath, specifier: factLogSpecifier };
  const exactFactLog = [
    `import { readPreReleaseBTerminalPhysicalObservationV1 } from "${physicalSpecifier}";`,
    `import type { PreReleaseBTerminalPhysicalObservationCapabilityV1, PreReleaseBTerminalPhysicalObservationV1 } from "${physicalSpecifier}";`,
  ].join("\n");
  const exactRunner = `import { encodePreReleaseFactLogJsonlV1, readPreReleaseFactLogV1 } from "${factLogSpecifier}";`;
  const inspect = (factLogSource: string, runnerSource: string, edges: readonly GraphEdge[]): readonly BoundaryDiagnostic[] => {
    for (const [path, source] of [[factLogPath, factLogSource], [runnerPath, runnerSource]] as const) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    const diagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(files, edges, diagnostics, root);
    return diagnostics;
  };
  try {
    assert.deepEqual(inspect(exactFactLog, exactRunner, [physicalEdge, runnerEdge]), []);
    assert.ok(inspect(`${exactFactLog}\nimport { extra } from "${physicalSpecifier}";`, exactRunner, [physicalEdge, runnerEdge])
      .some(item => item.code === "narrow-port-import-mismatch"));
    assert.ok(inspect(exactFactLog, exactRunner, [
      physicalEdge,
      runnerEdge,
      { from: otherPath, to: physicalPath, specifier: "../runtime-release-packager/src/pre-release-b-terminal-physical-observation.ts" },
    ]).some(item => item.code === "pre-release-terminal-physical-observer-consumer"));
    const missing = inspect("export {};", "export {};", []);
    assert.ok(missing.some(item => item.code === "pre-release-terminal-physical-observer-edge-missing"));
    assert.ok(missing.some(item => item.code === "final-pre-release-fact-log-edge-missing"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal physical registrar and reader remain private to their exact owners", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-terminal-physical-state-boundary-"));
  const statePath = "tools/runtime-release-packager/src/internal/pre-release-b-terminal-physical-observation-state.ts";
  const ownerPath = "tools/runtime-release-packager/src/internal/pre-release-b-terminal-snapshot-owner.ts";
  const observerPath = "tools/runtime-release-packager/src/pre-release-b-terminal-physical-observation.ts";
  const otherPath = "tools/runtime-release-packager/src/internal/foreign-terminal-owner.ts";
  const ownerSpecifier = "./pre-release-b-terminal-physical-observation-state.ts";
  const observerSpecifier = "./internal/pre-release-b-terminal-physical-observation-state.ts";
  const file = (path: string): TrackedFile => ({
    path, mode: "100644", blobSha: "a".repeat(40), contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1, language: "typescript", fileClass: "authoring",
  });
  const files = [file(statePath), file(ownerPath), file(observerPath), file(otherPath)];
  const ownerEdge: GraphEdge = { from: ownerPath, to: statePath, specifier: ownerSpecifier };
  const observerEdge: GraphEdge = { from: observerPath, to: statePath, specifier: observerSpecifier };
  const exactOwner = `import { registerPreReleaseBTerminalPhysicalObservationV1 } from "${ownerSpecifier}";`;
  const exactObserver = `import { readRegisteredPreReleaseBTerminalPhysicalObservationV1 } from "${observerSpecifier}";`;
  const inspect = (
    ownerSource: string,
    observerSource: string,
    otherSource: string,
    edges: readonly GraphEdge[],
  ): readonly BoundaryDiagnostic[] => {
    for (const [path, source] of [
      [ownerPath, ownerSource], [observerPath, observerSource], [otherPath, otherSource],
    ] as const) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    const diagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(files, edges, diagnostics, root);
    return diagnostics;
  };
  try {
    assert.deepEqual(inspect(exactOwner, exactObserver, "export {};", [ownerEdge, observerEdge]), []);
    assert.ok(inspect(
      `import { registerPreReleaseBTerminalPhysicalObservationV1, readRegisteredPreReleaseBTerminalPhysicalObservationV1 } from "${ownerSpecifier}";`,
      exactObserver,
      "export {};",
      [ownerEdge, observerEdge],
    ).some(item => item.code === "authority-named-import-mismatch"));
    assert.ok(inspect(
      exactOwner,
      exactObserver,
      `import { registerPreReleaseBTerminalPhysicalObservationV1 } from "${ownerSpecifier}";`,
      [ownerEdge, observerEdge, { from: otherPath, to: statePath, specifier: ownerSpecifier }],
    ).some(item => item.code === "pre-release-terminal-physical-state-owner"));
    assert.ok(inspect(
      exactOwner,
      exactObserver,
      `void import("${ownerSpecifier}");`,
      [ownerEdge, observerEdge, { from: otherPath, to: statePath, specifier: ownerSpecifier }],
    ).some(item => item.code === "pre-release-terminal-physical-state-owner"));
    const missing = inspect("export {};", exactObserver, "export {};", [observerEdge]);
    assert.ok(missing.some(item => item.code === "authority-consumer-edge-missing"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qualified release runner owns the only CommonEnvelope issuer and generated runtime seam", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-qualified-release-runner-"));
  const runnerPath = "tools/runtime-release-packager/src/internal/qualified-release-runner-owner.ts";
  const issuerPath = "acceptance/gate-core/src/internal/common-envelope-authority-issuer.ts";
  const materialStatePath = "acceptance/gate-core/src/internal/material-provider-state.ts";
  const runtimePath = "acceptance/gate-core/src/generated/release-runtime.ts";
  const issuerSpecifier = "../../../../acceptance/gate-core/src/internal/common-envelope-authority-issuer.ts";
  const materialStateSpecifier = "../../../../acceptance/gate-core/src/internal/material-provider-state.ts";
  const runtimeSpecifier = "../../../../acceptance/gate-core/src/generated/release-runtime.ts";
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
    file(runnerPath, "authoring"),
    file(issuerPath, "acceptance-pure-core"),
    file(materialStatePath, "acceptance-pure-core"),
    file(runtimePath, "generated"),
  ];
  const issuerEdge: GraphEdge = { from: runnerPath, to: issuerPath, specifier: issuerSpecifier };
  const issuerStateEdge: GraphEdge = { from: issuerPath, to: materialStatePath, specifier: "./material-provider-state.ts" };
  const materialStateEdge: GraphEdge = { from: runnerPath, to: materialStatePath, specifier: materialStateSpecifier };
  const runtimeEdge: GraphEdge = { from: runnerPath, to: runtimePath, specifier: runtimeSpecifier };
  mkdirSync(join(root, dirname(runnerPath)), { recursive: true });
  mkdirSync(join(root, dirname(issuerPath)), { recursive: true });
  writeFileSync(
    join(root, issuerPath),
    'import { registerCommonEnvelopeAuthorityPortV1 } from "./material-provider-state.ts";\n',
  );
  const exact = [
    `import { issueCommonEnvelopeAuthorityPortV1 } from "${issuerSpecifier}";`,
    `import type { CommonEnvelopeAssemblyStateV1 } from "${materialStateSpecifier}";`,
    `import { assembleReleaseGateInvocations, evaluateAssembledReleaseGateInvocations } from "${runtimeSpecifier}";`,
  ].join("\n");
  const inspect = (
    source: string,
    edges: readonly GraphEdge[] = [issuerEdge, issuerStateEdge, materialStateEdge, runtimeEdge],
    selectedFiles: readonly TrackedFile[] = files,
  ): readonly BoundaryDiagnostic[] => {
    writeFileSync(join(root, runnerPath), source);
    const diagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(selectedFiles, edges, diagnostics, root);
    return diagnostics;
  };
  try {
    assert.deepEqual(inspect(exact), []);
    assert.ok(inspect(exact, [issuerEdge]).some(item => item.code === "authority-consumer-edge-missing"));
    for (const [label, source] of [
      ["literal dynamic import", `void import("${issuerSpecifier}");`],
      ["namespace import", `import * as materialProviderState from "${issuerSpecifier}";`],
      ["aliased named import", `import { issueCommonEnvelopeAuthorityPortV1 as issueEnvelope } from "${issuerSpecifier}";`],
      ["require", `const materialProviderState = require("${issuerSpecifier}");`],
    ] as const) {
      assert.ok(
        inspect(source).some(item => item.code === "authority-named-import-mismatch"),
        `${label} must not replace the exact owner static named import`,
      );
    }
    assert.ok(inspect(
      exact.replace("evaluateAssembledReleaseGateInvocations", "evaluateAssembledReleaseGateInvocations, extra"),
    ).some(item => item.code === "authority-named-import-mismatch"));
    assert.ok(inspect(
      exact.replace(
        `import type { CommonEnvelopeAssemblyStateV1 } from "${materialStateSpecifier}";`,
        `import { assertCommonEnvelopeAuthorityPortV1 } from "${materialStateSpecifier}";`,
      ),
    ).some(item => item.code === "authority-named-import-mismatch"));
    const alternateMaterialStateSpecifier = `${materialStateSpecifier}?alternate`;
    assert.ok(inspect(
      exact.replace(materialStateSpecifier, alternateMaterialStateSpecifier),
      [issuerEdge, issuerStateEdge, { ...materialStateEdge, specifier: alternateMaterialStateSpecifier }, runtimeEdge],
    ).some(item => item.code === "authority-module-specifier-mismatch"));
    const alternateRuntimeSpecifier = `${runtimeSpecifier}?alternate`;
    assert.ok(inspect(
      exact.replace(runtimeSpecifier, alternateRuntimeSpecifier),
      [issuerEdge, issuerStateEdge, materialStateEdge, { ...runtimeEdge, specifier: alternateRuntimeSpecifier }],
    ).some(item => item.code === "authority-module-specifier-mismatch"));

    const wrongPath = "tools/other/src/issuer.ts";
    mkdirSync(join(root, dirname(wrongPath)), { recursive: true });
    writeFileSync(join(root, wrongPath), `import { issueCommonEnvelopeAuthorityPortV1 } from "${issuerSpecifier}";\n`);
    const wrongDiagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(wrongPath, "authoring"), file(issuerPath, "acceptance-pure-core")],
      [{ from: wrongPath, to: issuerPath, specifier: issuerSpecifier }],
      wrongDiagnostics,
      root,
    );
    assert.ok(wrongDiagnostics.some(item => item.code === "gate-core-authority-owner"));

    for (const [label, source] of [
      ["literal dynamic import", `void import("${issuerSpecifier}");`],
      ["namespace import", `import * as materialProviderState from "${issuerSpecifier}";`],
    ] as const) {
      writeFileSync(join(root, wrongPath), source);
      const bypassDiagnostics: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries(
        [file(wrongPath, "authoring"), file(issuerPath, "acceptance-pure-core")],
        [{ from: wrongPath, to: issuerPath, specifier: issuerSpecifier }],
        bypassDiagnostics,
        root,
      );
      assert.ok(
        bypassDiagnostics.some(item => item.code === "gate-core-authority-owner"),
        `${label} must not bypass the exact CommonEnvelope issuer owner`,
      );
    }

    const centralImposterPath = "packages/other-runtime/src/index.ts";
    mkdirSync(join(root, dirname(centralImposterPath)), { recursive: true });
    writeFileSync(join(root, centralImposterPath), `import { issueCommonEnvelopeAuthorityPortV1 } from "${issuerSpecifier}";\n`);
    const centralImposterDiagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(centralImposterPath, "central"), file(issuerPath, "acceptance-pure-core")],
      [{ from: centralImposterPath, to: issuerPath, specifier: issuerSpecifier }],
      centralImposterDiagnostics,
      root,
    );
    assert.ok(centralImposterDiagnostics.some(item => item.code === "central-imports-authority-constructor"));
    assert.ok(centralImposterDiagnostics.some(item => item.code === "gate-core-authority-owner"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("predicate material provider owns the exact reader edge and the assembler cannot reach state", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-predicate-material-owner-"));
  const sharedPath = "acceptance/collectors/src/material-providers/shared.ts";
  const issuerPath = "acceptance/gate-core/src/internal/predicate-domain-material-issuer.ts";
  const statePath = "acceptance/gate-core/src/internal/predicate-domain-material-state.ts";
  const assemblerPath = "acceptance/gate-core/src/release-material-assembler.ts";
  const issuerSpecifier = "../../../gate-core/src/internal/predicate-domain-material-issuer.ts";
  const stateFromShared = "../../../gate-core/src/internal/predicate-domain-material-state.ts";
  const stateFromIssuer = "./predicate-domain-material-state.ts";
  const stateFromAssembler = "./internal/predicate-domain-material-state.ts";
  const file = (path: string, fileClass: TrackedFile["fileClass"]): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass,
  });
  for (const path of [sharedPath, issuerPath, assemblerPath]) mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, sharedPath), `import { issuePredicateDomainMaterialCapabilityV1, readIssuedPredicateDomainMaterialCapabilityV1 } from "${issuerSpecifier}";\n`);
  writeFileSync(join(root, issuerPath), `import { readPredicateDomainMaterialCapabilityV1, registerPredicateDomainMaterialCapabilityV1 } from "${stateFromIssuer}";\n`);
  writeFileSync(join(root, assemblerPath), "export const assemble = true;\n");
  const files = [
    file(sharedPath, "acceptance-collector"),
    file(issuerPath, "acceptance-pure-core"),
    file(statePath, "acceptance-pure-core"),
    file(assemblerPath, "acceptance-pure-core"),
  ];
  const edges: GraphEdge[] = [
    { from: sharedPath, to: issuerPath, specifier: issuerSpecifier },
    { from: issuerPath, to: statePath, specifier: stateFromIssuer },
  ];
  try {
    const baseline: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(files, edges, baseline, root);
    assert.deepEqual(baseline, []);

    writeFileSync(join(root, assemblerPath), `import { readPredicateDomainMaterialCapabilityV1 } from "${stateFromAssembler}";\n`);
    const assemblerIntrusion: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      files,
      [...edges, { from: assemblerPath, to: statePath, specifier: stateFromAssembler }],
      assemblerIntrusion,
      root,
    );
    assert.ok(assemblerIntrusion.some(item => item.code === "gate-core-authority-owner"));

    writeFileSync(join(root, sharedPath), `import { issuePredicateDomainMaterialCapabilityV1, readIssuedPredicateDomainMaterialCapabilityV1 } from "${issuerSpecifier}";\nimport type { PredicateDomainMaterialV1 } from "${stateFromShared}";\n`);
    const readerIntrusion: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      files,
      [...edges, { from: sharedPath, to: statePath, specifier: stateFromShared }],
      readerIntrusion,
      root,
    );
    assert.ok(readerIntrusion.some(item => item.code === "gate-core-authority-owner"));

    const wrongPath = "tools/other/src/predicate-material.ts";
    mkdirSync(join(root, dirname(wrongPath)), { recursive: true });
    writeFileSync(join(root, wrongPath), `void import("${issuerSpecifier}");\n`);
    const wrong: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(wrongPath, "authoring"), file(issuerPath, "acceptance-pure-core")],
      [{ from: wrongPath, to: issuerPath, specifier: issuerSpecifier }],
      wrong,
      root,
    );
    assert.ok(wrong.some(item => item.code === "gate-core-authority-owner"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact authority constructor rows reject expanded or alternate runtime access", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-exact-authority-row-"));
  const ownerPath = "packages/coarse-economics/src/internal/owner.ts";
  const statePath = "packages/coarse-economics/src/internal/state.ts";
  const siblingPath = "packages/coarse-economics/src/internal/sibling.ts";
  const specifier = "./state.ts";
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: "central",
  });
  const edge: GraphEdge = { from: ownerPath, to: statePath, specifier };
  const validate = (source: string): BoundaryDiagnostic[] => {
    writeFileSync(join(root, ownerPath), source);
    const diagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries([file(ownerPath), file(statePath)], [edge], diagnostics, root);
    return diagnostics;
  };
  try {
    mkdirSync(join(root, dirname(ownerPath)), { recursive: true });
    writeFileSync(join(root, statePath), "export const registerCoarseProjectionServiceV1 = 1;\n");

    assert.deepEqual(validate(`import { registerCoarseProjectionServiceV1 } from "${specifier}";\n`), []);
    assert.deepEqual(validate(`import { registerCoarseProjectionServiceV1 } from "${specifier}";\nimport type { ShadowAuthorityV1 } from "${specifier}";\n`), []);

    for (const mutated of [
      `import { issueShadowAuthorityV1, registerCoarseProjectionServiceV1 } from "${specifier}";\n`,
      `import * as authorityState from "${specifier}";\n`,
      `import authorityState from "${specifier}";\n`,
      `import "${specifier}";\n`,
    ]) {
      assert.ok(validate(mutated).some(item => item.code === "authority-named-import-mismatch"));
    }

    writeFileSync(join(root, siblingPath), `import { registerCoarseProjectionServiceV1 } from "${specifier}";\n`);
    const siblingDiagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(siblingPath), file(statePath)],
      [{ from: siblingPath, to: statePath, specifier }],
      siblingDiagnostics,
      root,
    );
    assert.ok(siblingDiagnostics.some(item => item.code === "central-imports-authority-constructor"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("predicate material physical and fresh-runner bridges are exact owner-only seams", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-predicate-material-bridge-"));
  const physicalPath = "acceptance/collectors/src/production-predicate-material-source.ts";
  const physicalIssuerPath = "acceptance/collectors/src/internal/predicate-material-source-issuer.ts";
  const statePath = "acceptance/collectors/src/internal/predicate-material-source-owner.ts";
  const bridgeIssuerPath = "acceptance/collectors/src/internal/predicate-material-source-bridge-issuer.ts";
  const runnerEntryPath = "tools/runtime-release-packager/src/internal/qualified-release-runtime-entry.ts";
  const hostPath = "tools/runtime-release-packager/src/internal/fresh-qualified-runner-host-owner.ts";
  const physicalIssuerSpecifier = "./internal/predicate-material-source-issuer.ts";
  const stateFromPhysicalIssuer = "./predicate-material-source-owner.ts";
  const stateFromBridgeIssuer = "./predicate-material-source-owner.ts";
  const bridgeFromRunner = "../../../../acceptance/collectors/src/internal/predicate-material-source-bridge-issuer.ts";
  const stateFromHost = "../../../../acceptance/collectors/src/internal/predicate-material-source-owner.ts";
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
    file(physicalPath, "acceptance-collector"),
    file(physicalIssuerPath, "acceptance-collector"),
    file(statePath, "acceptance-collector"),
    file(bridgeIssuerPath, "acceptance-collector"),
    file(runnerEntryPath, "authoring"),
    file(hostPath, "authoring"),
  ];
  for (const path of [physicalPath, physicalIssuerPath, bridgeIssuerPath, runnerEntryPath, hostPath]) {
    mkdirSync(join(root, dirname(path)), { recursive: true });
  }
  writeFileSync(join(root, physicalPath), `import { issueProductionPredicateMaterialSourcePortV1 } from "${physicalIssuerSpecifier}";\n`);
  writeFileSync(join(root, physicalIssuerPath), `import { registerProductionPredicateMaterialSourceStateV1 } from "${stateFromPhysicalIssuer}";\n`);
  writeFileSync(join(root, bridgeIssuerPath), `import { registerProductionPredicateMaterialSourceStateV1 } from "${stateFromBridgeIssuer}";\n`);
  writeFileSync(join(root, runnerEntryPath), `import { issueBridgedPredicateMaterialSourcePortV1 } from "${bridgeFromRunner}";\n`);
  writeFileSync(join(root, hostPath), `import { readProductionPredicateMaterialSourceStateV1 } from "${stateFromHost}";\n`);
  const edges: GraphEdge[] = [
    { from: physicalPath, to: physicalIssuerPath, specifier: physicalIssuerSpecifier },
    { from: physicalIssuerPath, to: statePath, specifier: stateFromPhysicalIssuer },
    { from: bridgeIssuerPath, to: statePath, specifier: stateFromBridgeIssuer },
    { from: runnerEntryPath, to: bridgeIssuerPath, specifier: bridgeFromRunner },
    { from: hostPath, to: statePath, specifier: stateFromHost },
  ];
  try {
    const baseline: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(files, edges, baseline, root);
    assert.deepEqual(baseline, []);

    writeFileSync(join(root, runnerEntryPath), `import { issueBridgedPredicateMaterialSourcePortV1, extra } from "${bridgeFromRunner}";\n`);
    const extraImport: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(files, edges, extraImport, root);
    assert.ok(extraImport.some(item => item.code === "authority-named-import-mismatch"));

    const alternateSpecifier = `${bridgeFromRunner}?alternate`;
    writeFileSync(join(root, runnerEntryPath), `import { issueBridgedPredicateMaterialSourcePortV1 } from "${alternateSpecifier}";\n`);
    const alternate: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      files,
      edges.map(edge => edge.from === runnerEntryPath ? { ...edge, specifier: alternateSpecifier } : edge),
      alternate,
      root,
    );
    assert.ok(alternate.some(item => item.code === "authority-module-specifier-mismatch"));

    const imposterPath = "tools/other/src/predicate-material-bridge.ts";
    mkdirSync(join(root, dirname(imposterPath)), { recursive: true });
    writeFileSync(join(root, imposterPath), `import { issueBridgedPredicateMaterialSourcePortV1 } from "${bridgeFromRunner}";\n`);
    const imposter: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(imposterPath, "authoring"), file(bridgeIssuerPath, "acceptance-collector")],
      [{ from: imposterPath, to: bridgeIssuerPath, specifier: bridgeFromRunner }],
      imposter,
      root,
    );
    assert.ok(imposter.some(item => item.code === "predicate-material-source-authority-owner"));

    const missing: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(files, edges.filter(edge => edge.from !== hostPath), missing, root);
    assert.ok(missing.some(item => item.code === "authority-consumer-edge-missing"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-release advisory-only observation and Stage 2 denominator reject authority mutations", () => {
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const workflowPath = "tools/runtime-release-packager/src/production-workflow.ts";
  const publicPath = "tools/runtime-release-packager/src/pre-release-staging.ts";
  const stagingOwnerPath = "tools/runtime-release-packager/src/internal/pre-release-staging-owner.ts";
  const receiptStatePath = "tools/runtime-release-packager/src/internal/pre-release-runtime-receipt-state.ts";
  const schemaPath = "tools/runtime-release-packager/src/internal/pre-release-staging-schema.ts";
  const packagerRootPath = "tools/runtime-release-packager/src/index.ts";
  const deploymentPackagePath = "tools/runtime-release-packager/src/deployment-package.ts";
  const stageOneStatePath = "acceptance/collectors/src/internal/artifact-lineage-stage-one-state.ts";
  const stageTwoOwnerPath = "acceptance/collectors/src/internal/artifact-lineage-stage-two-git-owner.ts";
  const materialSourcePath = "acceptance/collectors/src/production-predicate-material-source.ts";
  const required = [
    workflowPath, publicPath, stagingOwnerPath, receiptStatePath, schemaPath,
    packagerRootPath, deploymentPackagePath,
    stageOneStatePath,
    stageTwoOwnerPath,
    materialSourcePath,
  ] as const;
  const baseline = new Map(required.map(path => [path, readFileSync(join(repositoryRoot, path), "utf8")]));
  const baselineDiagnostics: BoundaryDiagnostic[] = [];
  validatePreReleaseProductionBoundarySources(baseline, baselineDiagnostics);
  assert.deepEqual(baselineDiagnostics, []);

  const secondRegister = new Map(baseline);
  secondRegister.set(receiptStatePath, `${baseline.get(receiptStatePath)!}\nfunction secondRegister(value: object) { receipts.set(value, {} as never); }\n`);
  const secondRegisterDiagnostics: BoundaryDiagnostic[] = [];
  validatePreReleaseProductionBoundarySources(secondRegister, secondRegisterDiagnostics);
  assert.ok(secondRegisterDiagnostics.some(item => item.code === "pre-release-receipt-state-owner"));

  const secondReader = new Map(baseline);
  secondReader.set(receiptStatePath, `${baseline.get(receiptStatePath)!}\nexport function readSecondReceiptAuthorityV1(value: object) { return receipts.get(value); }\n`);
  const secondReaderDiagnostics: BoundaryDiagnostic[] = [];
  validatePreReleaseProductionBoundarySources(secondReader, secondReaderDiagnostics);
  assert.ok(secondReaderDiagnostics.some(item => item.code === "pre-release-receipt-state-export"));
  assert.ok(secondReaderDiagnostics.some(item => item.code === "pre-release-receipt-state-owner"));

  const rawAdvisoryFields = new Map(baseline);
  rawAdvisoryFields.set(workflowPath, baseline.get(workflowPath)!.replace(
    "capability: PreReleaseAdvisoryMaterialCapabilityV1,\n): Promise<ProductionReleaseAcceptanceAdvisoryReportV1>",
    "capability: PreReleaseAdvisoryMaterialCapabilityV1,\n  rawAuthority: object,\n): Promise<ProductionReleaseAcceptanceAdvisoryReportV1>",
  ));
  const rawAdvisoryDiagnostics: BoundaryDiagnostic[] = [];
  validatePreReleaseProductionBoundarySources(rawAdvisoryFields, rawAdvisoryDiagnostics);
  assert.ok(rawAdvisoryDiagnostics.some(item => item.code === "production-advisory-capability-only"));

  const runnerExecution = new Map(baseline);
  runnerExecution.set(workflowPath, baseline.get(workflowPath)!.replace(
    "observeQualifiedReleaseAcceptanceAdvisoryV1(material.qualifiedReleaseRunner, source)",
    "executeQualifiedReleaseAcceptance(material.qualifiedReleaseRunner, source)",
  ));
  const runnerExecutionDiagnostics: BoundaryDiagnostic[] = [];
  validatePreReleaseProductionBoundarySources(runnerExecution, runnerExecutionDiagnostics);
  assert.ok(runnerExecutionDiagnostics.some(item => item.code === "production-advisory-observer-only"));

  const preparedFromAdvisory = new Map(baseline);
  preparedFromAdvisory.set(workflowPath, baseline.get(workflowPath)!.replace(
    "prepareQualifiedReleaseAcceptanceForExternalOwnerV1(\n    material.qualifiedReleaseRunner,\n    source,\n  )",
    "observeQualifiedReleaseAcceptanceAdvisoryV1(material.qualifiedReleaseRunner, source)",
  ));
  const preparedFromAdvisoryDiagnostics: BoundaryDiagnostic[] = [];
  validatePreReleaseProductionBoundarySources(preparedFromAdvisory, preparedFromAdvisoryDiagnostics);
  assert.ok(preparedFromAdvisoryDiagnostics.some(item => item.code === "production-release-preparation-owner"));

  const bypassedPreparation = new Map(baseline);
  bypassedPreparation.set(workflowPath, baseline.get(workflowPath)!.replace(
    "await prepareProductionReleaseAcceptanceForExternalOwnerV1(capability)",
    "capability",
  ));
  const bypassedPreparationDiagnostics: BoundaryDiagnostic[] = [];
  validatePreReleaseProductionBoundarySources(bypassedPreparation, bypassedPreparationDiagnostics);
  assert.ok(bypassedPreparationDiagnostics.some(item => item.code === "production-release-preparation-owner"));

  const oldDatabasePath = new Map(baseline);
  oldDatabasePath.set(schemaPath, baseline.get(schemaPath)!.replace(
    'checkpointDatabasePath: "/var/lib/aloha/pre-release/runtime/checkpoint.sqlite",',
    'checkpointDatabasePath: "/var/lib/aloha/pre-release/checkpoint.sqlite",',
  ));
  const oldDatabasePathDiagnostics: BoundaryDiagnostic[] = [];
  validatePreReleaseProductionBoundarySources(oldDatabasePath, oldDatabasePathDiagnostics);
  assert.ok(oldDatabasePathDiagnostics.some(item => item.code === "pre-release-fixed-runtime-paths"));

  const packageAuthoring = new Map(baseline);
  packageAuthoring.set(packagerRootPath, `${baseline.get(packagerRootPath)!}\nexport function prepareReleasePackageV1() {}\n`);
  const packageAuthoringDiagnostics: BoundaryDiagnostic[] = [];
  validatePreReleaseProductionBoundarySources(packageAuthoring, packageAuthoringDiagnostics);
  assert.ok(packageAuthoringDiagnostics.some(item => item.code === "production-advisory-authoring-forbidden"));

  const stageTwoOwnerLeak = new Map(baseline);
  stageTwoOwnerLeak.set(stageTwoOwnerPath, `${baseline.get(stageTwoOwnerPath)!}\nexport const rawStageTwoAuthority = observeArtifactLineageStageTwoGitEvidenceV1;\n`);
  const stageTwoOwnerLeakDiagnostics: BoundaryDiagnostic[] = [];
  validatePreReleaseProductionBoundarySources(stageTwoOwnerLeak, stageTwoOwnerLeakDiagnostics);
  assert.ok(stageTwoOwnerLeakDiagnostics.some(item => item.code === "artifact-lineage-stage-two-owner-export"));

  const shortenedStageTwo = new Map(baseline);
  shortenedStageTwo.set(stageTwoOwnerPath, baseline.get(stageTwoOwnerPath)!.replace(
    '  "acceptance/gate-core/src/generated/release-authority.ts",\n',
    "",
  ));
  const shortenedStageTwoDiagnostics: BoundaryDiagnostic[] = [];
  validatePreReleaseProductionBoundarySources(shortenedStageTwo, shortenedStageTwoDiagnostics);
  assert.ok(shortenedStageTwoDiagnostics.some(item => item.code === "artifact-lineage-stage-two-denominator"));

  for (const [from, to] of [
    ['GIT_NO_LAZY_FETCH: "1"', 'GIT_NO_LAZY_FETCH: "0"'],
    ['GIT_ALLOW_PROTOCOL: ""', 'GIT_ALLOW_PROTOCOL: "https"'],
    ['protocol.allow=never', 'protocol.allow=https'],
    ['core.sshCommand=/bin/false', 'core.sshCommand=ssh'],
    ['GIT_ASKPASS: "/bin/false"', 'GIT_ASKPASS: "/usr/bin/true"'],
    ['SSH_ASKPASS: "/bin/false"', 'SSH_ASKPASS: "/usr/bin/true"'],
    ['GIT_TERMINAL_PROMPT: "0"', 'GIT_TERMINAL_PROMPT: "1"'],
  ] as const) {
    const mutation = new Map(baseline);
    mutation.set(stageTwoOwnerPath, baseline.get(stageTwoOwnerPath)!.replace(from, to));
    const diagnostics: BoundaryDiagnostic[] = [];
    validatePreReleaseProductionBoundarySources(mutation, diagnostics);
    assert.ok(diagnostics.some(item => item.code === "artifact-lineage-git-local-only"), `${from} mutation escaped`);
  }
});

test("split production runtime and pre-release owner reject cross-phase, snapshot and legacy mutations", () => {
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const preLauncherPath = "tools/runtime-release-packager/assets/pre-release-owner.mjs";
  const productionLauncherPath = "tools/runtime-release-packager/assets/production-launcher.mjs";
  const builderPath = "tools/runtime-release-packager/src/internal/runtime-bundle-builder.ts";
  const releaseRuntimePath = "apps/searcher-runtime/src/release-runtime.ts";
  const stagingOwnerPath = "tools/runtime-release-packager/src/internal/pre-release-staging-owner.ts";
  const runnerStatePath = "tools/runtime-release-packager/src/internal/qualified-release-public-runner-state.ts";
  const performancePolicyPath = "packages/runtime-release-authority/src/internal/performance-policy-owner.ts";
  const runnerState = [
    "installVerifiedQualifiedReleaseRunnerWireV1",
    "observeQualifiedReleaseAcceptanceAdvisoryV1",
    "prepareQualifiedReleaseAcceptanceForExternalOwnerV1",
    "readAuthorizedQualifiedReleaseRunnerWireV1",
    "readPublicQualifiedReleaseRunnerStateV1",
    "readQualifiedReleaseLineageObservationV1",
    "readVerifiedAuthorizedQualifiedRunnerWireLineageV1",
    "registerPublicQualifiedReleaseRunnerV1",
    "verifyAuthorizedQualifiedReleaseRunnerWireV1",
  ].map(name => `export function ${name}() {}`).join("\n");
  const baseline = new Map<string, string>([
    [preLauncherPath, readFileSync(join(repositoryRoot, preLauncherPath), "utf8")],
    [productionLauncherPath, readFileSync(join(repositoryRoot, productionLauncherPath), "utf8")],
    [builderPath, readFileSync(join(repositoryRoot, builderPath), "utf8")],
    [releaseRuntimePath, readFileSync(join(repositoryRoot, releaseRuntimePath), "utf8")],
    [stagingOwnerPath, "export interface IssuePreReleaseLaunchInputV1 { readonly artifacts: { readonly deploymentBundleBytes: Uint8Array } }\n"],
    [runnerStatePath, runnerState],
    [performancePolicyPath, "export function issuePreReleaseRuntimeReleasePerformancePolicyPortV1() {}\n"],
  ]);
  const inspect = (sources: ReadonlyMap<string, string>): readonly BoundaryDiagnostic[] => {
    const diagnostics: BoundaryDiagnostic[] = [];
    validatePreReleaseOwnerHostSources(sources, diagnostics);
    return diagnostics;
  };
  assert.deepEqual(inspect(baseline), []);

  const mutate = (path: string, from: string, to: string): readonly BoundaryDiagnostic[] => {
    const sources = new Map(baseline);
    const source = sources.get(path)!;
    assert.ok(source.includes(from), `missing mutation source in ${path}: ${from}`);
    sources.set(path, source.replace(from, to));
    return inspect(sources);
  };
  for (const diagnostics of [
    mutate(preLauncherPath, "const capability = module.issuePreReleaseStartupCapabilityV1(startupSnapshot);", "const capability = module.issueInstalledProductionStartupCapabilityV1(startupSnapshot);"),
    mutate(preLauncherPath, "const session = await module.startReleaseRuntimeSessionV1(capability);", "const selectedExport = \"startReleaseRuntimeSessionV1\";\n  const session = await module[selectedExport](capability);"),
    mutate(productionLauncherPath, "await service.done;", "try { await service.done; } catch { await module.startReleaseRuntimeSessionV1(module.issuePreReleaseStartupCapabilityV1(snapshot)); }"),
    mutate(productionLauncherPath, "const runtime = snapshot.artifacts[\"deployment-bundle.mjs\"];", "const runtime = regularSnapshot(\"/etc/aloha/alternate-bundle.mjs\", \"alternate\");"),
    mutate(preLauncherPath, "const runtime = round.snapshots[\"deployment-bundle.mjs\"];", "const runtime = regularSnapshot(\"/var/lib/aloha/pre-release/artifacts/alternate.mjs\", \"alternate\");"),
    mutate(preLauncherPath, "const session = await module.startReleaseRuntimeSessionV1(capability);", "await import(`data:text/javascript;base64,AA==#second`);\n  const session = await module.startReleaseRuntimeSessionV1(capability);"),
    mutate(preLauncherPath, "const capability = module.issuePreReleaseStartupCapabilityV1(startupSnapshot);", "const capability = module.issuePreReleaseStartupCapabilityV1(preverifyRound());"),
    mutate(preLauncherPath, 'const ROOT = "/var/lib/aloha/pre-release";', 'const ROOT = "/etc/aloha";'),
  ]) assert.ok(diagnostics.some(item => item.code === "pre-release-launcher-phase-body"));

  assert.ok(mutate(
    releaseRuntimePath,
    "export function startReleaseRuntimeSessionV1(",
    "export function fourthRuntimeExportV1(): void {}\nexport function startReleaseRuntimeSessionV1(",
  ).some(item => item.code === "pre-release-runtime-export-surface"));
  assert.ok(mutate(
    stagingOwnerPath,
    "readonly deploymentBundleBytes: Uint8Array",
    "readonly deploymentBundleBytes: Uint8Array; readonly qualifiedReleaseRunnerInputBytes: Uint8Array",
  ).some(item => item.code === "pre-release-owner-legacy-completion"));
  assert.ok(mutate(
    stagingOwnerPath,
    "export interface IssuePreReleaseLaunchInputV1",
    "export function completePreReleaseRuntimeLaunchV1() {}\nexport interface IssuePreReleaseLaunchInputV1",
  ).some(item => item.code === "pre-release-owner-legacy-completion"));
  assert.ok(mutate(
    runnerStatePath,
    "export function observeQualifiedReleaseAcceptanceAdvisoryV1() {}",
    "export function observeQualifiedReleaseAcceptanceAdvisoryV1() {} export function secondRunnerIssuer() {}",
  ).some(item => item.code === "pre-release-runner-state-export"));
  assert.ok(mutate(
    builderPath,
    '"startReleaseRuntimeSessionV1",',
    '"startReleaseRuntimeSessionV1", "fourthRuntimeExportV1",',
  ).some(item => item.code === "pre-release-runtime-export-surface"));
});

test("pre-release advisory authority modules admit only exact named importers", () => {
  const cases = [
    {
      from: "tools/runtime-release-packager/src/internal/pre-release-staging-owner.ts",
      to: "tools/runtime-release-packager/src/assembled-release-acceptance.ts",
      specifier: "../assembled-release-acceptance.ts",
      named: ["installQualifiedReleaseAcceptanceRunnerV1", "readAuthorizedQualifiedReleaseRunnerWireV1", "readQualifiedReleaseLineageObservationV1"],
    },
    {
      from: "tools/runtime-release-packager/src/assembled-release-acceptance.ts",
      to: "tools/runtime-release-packager/src/internal/qualified-release-public-runner-state.ts",
      specifier: "./internal/qualified-release-public-runner-state.ts",
      named: ["observeQualifiedReleaseAcceptanceAdvisoryV1", "readAuthorizedQualifiedReleaseRunnerWireV1", "readQualifiedReleaseLineageObservationV1", "registerPublicQualifiedReleaseRunnerV1"],
    },
    {
      from: "tools/runtime-release-packager/src/final-pre-release-runner.ts",
      to: "tools/runtime-release-packager/src/internal/pre-release-authorization-ledger.ts",
      specifier: "./internal/pre-release-authorization-ledger.ts",
      named: ["claimFixedPreReleaseAuthorizationV1", "readFixedPreReleaseAuthorizationClaimV1"],
    },
    {
      from: "tools/runtime-release-packager/src/final-pre-release-runner.ts",
      to: "apps/searcher-runtime/src/runtime-acceptance-evidence.ts",
      specifier: "../../../apps/searcher-runtime/src/runtime-acceptance-evidence.ts",
      named: ["sealPreReleaseRestartTerminalV1"],
    },
    {
      from: "apps/searcher-runtime/src/runtime-acceptance-evidence.ts",
      to: "tools/runtime-release-packager/src/internal/pre-release-authorization-ledger.ts",
      specifier: "../../../tools/runtime-release-packager/src/internal/pre-release-authorization-ledger.ts",
      named: ["readFixedPreReleaseAuthorizationClaimV1"],
    },
    {
      from: "tools/runtime-release-packager/src/final-pre-release-runner.ts",
      to: "tools/runtime-release-packager/src/internal/pre-release-b-qualification-state.ts",
      specifier: "./internal/pre-release-b-qualification-state.ts",
      named: ["issueFrozenPreReleaseBQualificationCapabilityV1"],
    },
    {
      from: "tools/runtime-release-packager/src/final-pre-release-runner.ts",
      to: "tools/runtime-release-packager/src/internal/pre-release-staging-owner.ts",
      specifier: "./internal/pre-release-staging-owner.ts",
      named: ["importFrozenPreReleaseBRuntimeV1", "issueImportedFrozenPreReleaseBAdvisoryMaterialV1", "readImportedFrozenPreReleaseBTerminalPhysicalObservationV1"],
    },
    {
      from: "tools/runtime-release-packager/src/internal/pre-release-staging-owner.ts",
      to: "tools/runtime-release-packager/src/internal/pre-release-b-qualification-state.ts",
      specifier: "./pre-release-b-qualification-state.ts",
      named: ["readFrozenPreReleaseBQualificationCapabilityV1"],
    },
    {
      from: "acceptance/collectors/src/production-runtime-boundary-observers.ts",
      to: "tools/runtime-release-packager/src/pre-release-staging.ts",
      specifier: "../../../tools/runtime-release-packager/src/pre-release-staging.ts",
      named: ["readPreReleaseAdvisoryMaterialCapabilityV1"],
    },
    {
      from: "tools/runtime-release-packager/src/internal/pre-release-b-terminal-snapshot-owner.ts",
      to: "tools/runtime-release-packager/src/internal/pre-release-b-qualification-state.ts",
      specifier: "./pre-release-b-qualification-state.ts",
      named: ["readFrozenPreReleaseBQualificationCapabilityV1"],
    },
    {
      from: "tools/runtime-release-packager/src/internal/pre-release-staging-owner.ts",
      to: "tools/runtime-release-packager/src/internal/pre-release-runtime-receipt-state.ts",
      specifier: "./pre-release-runtime-receipt-state.ts",
      named: ["issuePreReleaseAdvisoryMaterialCapabilityV1"],
    },
    {
      from: "tools/runtime-release-packager/src/internal/pre-release-b-terminal-snapshot-owner.ts",
      to: "packages/runtime-release-authority/src/internal/observer-store-owner.ts",
      specifier: "../../../../packages/runtime-release-authority/src/internal/observer-store-owner.ts",
      named: ["runtimeReleaseObserverStoreIdentityV1"],
    },
  ] as const;
  const root = mkdtempSync(join(tmpdir(), "aloha-pre-release-host-imports-"));
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: path.startsWith("apps/") ? "production-runtime" : path.startsWith("packages/") ? "central" : "authoring",
  });
  try {
    for (const value of cases) {
      mkdirSync(join(root, dirname(value.from)), { recursive: true });
      mkdirSync(join(root, dirname(value.to)), { recursive: true });
      writeFileSync(join(root, value.to), `export const target = true;\n`);
      const inspect = (source: string, edge: GraphEdge | null = { from: value.from, to: value.to, specifier: value.specifier }) => {
        writeFileSync(join(root, value.from), source);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries(
          [file(value.from), file(value.to)],
          edge === null ? [] : [edge],
          diagnostics,
          root,
        );
        return diagnostics;
      };
      const exact = `import { ${value.named.join(", ")} } from "${value.specifier}";\n`;
      assert.deepEqual(inspect(exact), []);
      assert.ok(inspect("export {};\n", null).some(item => item.code === "authority-consumer-edge-missing"));
      assert.ok(inspect(`import { ${value.named.slice(0, -1).join(", ")} } from "${value.specifier}";\n`)
        .some(item => item.code === "authority-named-import-mismatch"));
      assert.ok(inspect(`import * as owner from "${value.specifier}";\n`).some(item => item.code === "authority-named-import-mismatch"));
      assert.ok(inspect(`import { ${value.named[0]} as alias } from "${value.specifier}";\n`).some(item => item.code === "authority-named-import-mismatch"));
      const aliasedLast = value.named.map((name, index) => index === value.named.length - 1 ? `${name} as alias` : name);
      assert.ok(inspect(`import { ${aliasedLast.join(", ")} } from "${value.specifier}";\n`)
        .some(item => item.code === "authority-named-import-mismatch"));
      assert.ok(inspect(`import { ${value.named.join(", ")}, extra } from "${value.specifier}";\n`).some(item => item.code === "authority-named-import-mismatch"));
      assert.ok(inspect(`export { ${value.named[0]} } from "${value.specifier}";\n`).some(item => item.code === "authority-named-import-mismatch"));
      assert.ok(inspect(`void import("${value.specifier}");\n`).some(item => item.code === "authority-named-import-mismatch"));
      const alternate = `${value.specifier}?alternate`;
      assert.ok(inspect(
        exact.replace(value.specifier, alternate),
        { from: value.from, to: value.to, specifier: alternate },
      ).some(item => item.code === "authority-module-specifier-mismatch"));

      const intruder = "tools/other/src/pre-release-host-intruder.ts";
      mkdirSync(join(root, dirname(intruder)), { recursive: true });
      writeFileSync(join(root, intruder), `import { ${value.named[0]} } from "${value.specifier}";\n`);
      const intruderDiagnostics: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries(
        [file(intruder), file(value.to)],
        [{ from: intruder, to: value.to, specifier: value.specifier }],
        intruderDiagnostics,
        root,
      );
      assert.ok(intruderDiagnostics.some(item => item.code === "pre-release-authority-reader-owner"
        || item.code === "production-release-advisory-authority-owner"
        || item.code === "qualified-release-runner-authority-owner"
        || item.code === "central-imports-authority-constructor"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-release receipt, Stage 2, and release-binding readers have exact consumers", () => {
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const workflow = "tools/runtime-release-packager/src/production-workflow.ts";
  const publicReceipt = "tools/runtime-release-packager/src/pre-release-staging.ts";
  const stagingOwner = "tools/runtime-release-packager/src/internal/pre-release-staging-owner.ts";
  const receiptState = "tools/runtime-release-packager/src/internal/pre-release-runtime-receipt-state.ts";
  const schema = "tools/runtime-release-packager/src/internal/pre-release-staging-schema.ts";
  const closureObserver = "acceptance/collectors/src/production-closure-observer.ts";
  const stageOneState = "acceptance/collectors/src/internal/artifact-lineage-stage-one-state.ts";
  const stageTwoOwner = "acceptance/collectors/src/internal/artifact-lineage-stage-two-git-owner.ts";
  const materialSource = "acceptance/collectors/src/production-predicate-material-source.ts";
  const performanceOwner = "acceptance/collectors/src/internal/performance-material-observer-owner.ts";
  const terminalOwner = "acceptance/collectors/src/internal/terminal-selection-material-owner.ts";
  const restartOwner = "acceptance/collectors/src/internal/runtime-boundary-material-owner.ts";
  const finalRunner = "tools/runtime-release-packager/src/final-pre-release-runner.ts";
  const authorizationLedger = "tools/runtime-release-packager/src/internal/pre-release-authorization-ledger.ts";
  const runtimeAcceptanceEvidence = "apps/searcher-runtime/src/runtime-acceptance-evidence.ts";
  const bQualificationState = "tools/runtime-release-packager/src/internal/pre-release-b-qualification-state.ts";
  const runtimeBoundaryObservers = "acceptance/collectors/src/production-runtime-boundary-observers.ts";
  const externalReleaseOwner = "tools/runtime-release-packager/src/external-release-owner.ts";
  const terminalSnapshotOwner = "tools/runtime-release-packager/src/internal/pre-release-b-terminal-snapshot-owner.ts";
  const paths = [
    workflow, publicReceipt, stagingOwner, receiptState, schema, closureObserver, stageOneState,
    stageTwoOwner, materialSource, performanceOwner, terminalOwner, restartOwner,
    finalRunner, authorizationLedger, runtimeAcceptanceEvidence, bQualificationState,
    runtimeBoundaryObservers, externalReleaseOwner, terminalSnapshotOwner,
  ] as const;
  const classify = (path: string): TrackedFile["fileClass"] =>
    path.startsWith("acceptance/") ? "acceptance-collector" : "authoring";
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: readFileSync(join(repositoryRoot, path)).byteLength,
    language: "typescript",
    fileClass: classify(path),
  });
  const rows: readonly (readonly [string, string, string])[] = [
    [workflow, receiptState, "./internal/pre-release-runtime-receipt-state.ts"],
    [publicReceipt, receiptState, "./internal/pre-release-runtime-receipt-state.ts"],
    [workflow, publicReceipt, "./pre-release-staging.ts"],
    [workflow, runtimeBoundaryObservers, "../../../acceptance/collectors/src/production-runtime-boundary-observers.ts"],
    [runtimeBoundaryObservers, restartOwner, "./internal/runtime-boundary-material-owner.ts"],
    [closureObserver, publicReceipt, "../../../tools/runtime-release-packager/src/pre-release-staging.ts"],
    [runtimeBoundaryObservers, publicReceipt, "../../../tools/runtime-release-packager/src/pre-release-staging.ts"],
    [stagingOwner, schema, "./pre-release-staging-schema.ts"],
    [workflow, schema, "./internal/pre-release-staging-schema.ts"],
    [authorizationLedger, schema, "./pre-release-staging-schema.ts"],
    [finalRunner, schema, "./internal/pre-release-staging-schema.ts"],
    [runtimeAcceptanceEvidence, schema, "../../../tools/runtime-release-packager/src/internal/pre-release-staging-schema.ts"],
    [closureObserver, schema, "../../../tools/runtime-release-packager/src/internal/pre-release-staging-schema.ts"],
    [externalReleaseOwner, schema, "./internal/pre-release-staging-schema.ts"],
    [materialSource, stageTwoOwner, "./internal/artifact-lineage-stage-two-git-owner.ts"],
    [materialSource, stageOneState, "./internal/artifact-lineage-stage-one-state.ts"],
    [materialSource, performanceOwner, "./internal/performance-material-observer-owner.ts"],
    [materialSource, terminalOwner, "./internal/terminal-selection-material-owner.ts"],
    [materialSource, restartOwner, "./internal/runtime-boundary-material-owner.ts"],
    [workflow, performanceOwner, "../../../acceptance/collectors/src/internal/performance-material-observer-owner.ts"],
    [workflow, terminalOwner, "../../../acceptance/collectors/src/internal/terminal-selection-material-owner.ts"],
    [workflow, restartOwner, "../../../acceptance/collectors/src/internal/runtime-boundary-material-owner.ts"],
    [finalRunner, authorizationLedger, "./internal/pre-release-authorization-ledger.ts"],
    [finalRunner, runtimeAcceptanceEvidence, "../../../apps/searcher-runtime/src/runtime-acceptance-evidence.ts"],
    [runtimeAcceptanceEvidence, authorizationLedger, "../../../tools/runtime-release-packager/src/internal/pre-release-authorization-ledger.ts"],
    [finalRunner, bQualificationState, "./internal/pre-release-b-qualification-state.ts"],
    [terminalSnapshotOwner, bQualificationState, "./pre-release-b-qualification-state.ts"],
    [finalRunner, stagingOwner, "./internal/pre-release-staging-owner.ts"],
    [stagingOwner, bQualificationState, "./pre-release-b-qualification-state.ts"],
    [stagingOwner, receiptState, "./pre-release-runtime-receipt-state.ts"],
  ];
  const baselineDiagnostics: BoundaryDiagnostic[] = [];
  validateDependencyBoundaries(
    paths.map(file),
    rows.map(([from, to, specifier]) => ({ from, to, specifier })),
    baselineDiagnostics,
    repositoryRoot,
  );
  assert.deepEqual(baselineDiagnostics, []);

  const schemaMutationRoot = mkdtempSync(join(tmpdir(), "aloha-external-release-schema-import-"));
  try {
    for (const path of [externalReleaseOwner, schema]) {
      mkdirSync(join(schemaMutationRoot, dirname(path)), { recursive: true });
      writeFileSync(join(schemaMutationRoot, path), readFileSync(join(repositoryRoot, path)));
    }
    const externalSource = readFileSync(join(schemaMutationRoot, externalReleaseOwner), "utf8");
    writeFileSync(
      join(schemaMutationRoot, externalReleaseOwner),
      externalSource.replace("  hashPreReleaseStagingArtifactSetV1,\n", ""),
    );
    const schemaMutationDiagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [externalReleaseOwner, schema].map((path) => ({
        ...file(path),
        byteLength: readFileSync(join(schemaMutationRoot, path)).byteLength,
      })),
      [{ from: externalReleaseOwner, to: schema, specifier: "./internal/pre-release-staging-schema.ts" }],
      schemaMutationDiagnostics,
      schemaMutationRoot,
    );
    assert.ok(schemaMutationDiagnostics.some(item => item.code === "pre-release-schema-consumer"));
  } finally {
    rmSync(schemaMutationRoot, { recursive: true, force: true });
  }

  const mutation = (
    target: string,
    specifier: string,
    importedName: string,
  ): readonly BoundaryDiagnostic[] => {
    const root = mkdtempSync(join(tmpdir(), "aloha-pre-release-reader-leak-"));
    const intruder = "tools/other/src/second-reader.ts";
    try {
      mkdirSync(join(root, dirname(intruder)), { recursive: true });
      mkdirSync(join(root, dirname(target)), { recursive: true });
      writeFileSync(join(root, intruder), `import { ${importedName} } from "${specifier}";\n`);
      writeFileSync(join(root, target), "export const target = true;\n");
      const diagnostics: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries(
        [
          {
            path: intruder, mode: "100644", blobSha: "a".repeat(40),
            contentSha256: `0x${"a".repeat(64)}`, byteLength: 1,
            language: "typescript", fileClass: "authoring",
          },
          {
            path: target, mode: "100644", blobSha: "a".repeat(40),
            contentSha256: `0x${"a".repeat(64)}`, byteLength: 1,
            language: "typescript", fileClass: classify(target),
          },
        ],
        [{ from: intruder, to: target, specifier }],
        diagnostics,
        root,
      );
      return diagnostics;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  for (const [target, specifier, name] of [
    [receiptState, "../../runtime-release-packager/src/internal/pre-release-runtime-receipt-state.ts", "readPreReleaseAdvisoryMaterialV1"],
    [publicReceipt, "../../runtime-release-packager/src/pre-release-staging.ts", "readPreReleaseAdvisoryMaterialCapabilityV1"],
    [stageTwoOwner, "../../../acceptance/collectors/src/internal/artifact-lineage-stage-two-git-owner.ts", "observeArtifactLineageStageTwoGitEvidenceV1"],
    [stageOneState, "../../../acceptance/collectors/src/internal/artifact-lineage-stage-one-state.ts", "readArtifactLineageStageTwoAuthorityV1"],
    [performanceOwner, "../../../acceptance/collectors/src/internal/performance-material-observer-owner.ts", "readProductionPerformanceMaterialObserverReleaseBindingV1"],
    [performanceOwner, "../../../acceptance/collectors/src/internal/performance-material-observer-owner.ts", "readObservedProductionPerformanceDeploymentMaterialV1"],
    [terminalOwner, "../../../acceptance/collectors/src/internal/terminal-selection-material-owner.ts", "readProductionTerminalSelectionObserverReleaseBindingV1"],
    [restartOwner, "../../../acceptance/collectors/src/internal/runtime-boundary-material-owner.ts", "readProductionRuntimeRestartMaterialObserverReleaseBindingV1"],
    [authorizationLedger, "../../runtime-release-packager/src/internal/pre-release-authorization-ledger.ts", "claimFixedPreReleaseAuthorizationV1"],
    [authorizationLedger, "../../runtime-release-packager/src/internal/pre-release-authorization-ledger.ts", "readFixedPreReleaseAuthorizationClaimV1"],
    [runtimeAcceptanceEvidence, "../../../apps/searcher-runtime/src/runtime-acceptance-evidence.ts", "sealPreReleaseRestartTerminalV1"],
    [bQualificationState, "../../runtime-release-packager/src/internal/pre-release-b-qualification-state.ts", "issueFrozenPreReleaseBQualificationCapabilityV1"],
    [bQualificationState, "../../runtime-release-packager/src/internal/pre-release-b-qualification-state.ts", "readFrozenPreReleaseBQualificationCapabilityV1"],
    [stagingOwner, "../../runtime-release-packager/src/internal/pre-release-staging-owner.ts", "importFrozenPreReleaseBRuntimeV1"],
    [stagingOwner, "../../runtime-release-packager/src/internal/pre-release-staging-owner.ts", "readImportedFrozenPreReleaseBRuntimeV1"],
    [stagingOwner, "../../runtime-release-packager/src/internal/pre-release-staging-owner.ts", "readImportedFrozenPreReleaseBTerminalPhysicalObservationV1"],
    [schema, "../../runtime-release-packager/src/internal/pre-release-staging-schema.ts", "PRE_RELEASE_SYSTEMD_UNIT_V1"],
  ] as const) {
    assert.ok(mutation(target, specifier, name).some(item => item.code === "pre-release-authority-reader-owner"));
  }
});

test("verified deployment starters are private to their two owners and no shared registrar exists", () => {
  const deploymentPath = "apps/searcher-runtime/src/deployment.ts";
  const productionPath = "apps/searcher-runtime/src/release-runtime-owner.ts";
  const baselineSources = new Map<string, string>([
    [deploymentPath, "async function startLocalVerifiedDeploymentRuntimeBundleV1() {}\n"],
    [productionPath, "async function startInstalledVerifiedDeploymentRuntimeBundleV1() {}\n"],
    ["apps/searcher-runtime/src/index.ts", "export const publicRuntime = true;\n"],
    ["apps/searcher-runtime/src/cli.ts", "export const cli = true;\n"],
  ]);
  const baseline: BoundaryDiagnostic[] = [];
  validateSearcherRuntimeDeploymentStartupSources(baselineSources, baseline);
  assert.deepEqual(baseline, []);

  const exported = new Map(baselineSources);
  exported.set(deploymentPath, "export async function startLocalVerifiedDeploymentRuntimeBundleV1() {}\n");
  const exportedDiagnostics: BoundaryDiagnostic[] = [];
  validateSearcherRuntimeDeploymentStartupSources(exported, exportedDiagnostics);
  assert.ok(exportedDiagnostics.some(item => item.code === "deployment-private-starter-export"));

  const leaked = new Map(baselineSources);
  leaked.set("apps/searcher-runtime/src/index.ts", "export { startInstalledVerifiedDeploymentRuntimeBundleV1 } from './release-runtime-owner.ts';\n");
  const leakedDiagnostics: BoundaryDiagnostic[] = [];
  validateSearcherRuntimeDeploymentStartupSources(leaked, leakedDiagnostics);
  assert.ok(leakedDiagnostics.some(item => item.code === "deployment-private-starter-leak"));

  const registrar = new Map(baselineSources);
  registrar.set(
    "apps/searcher-runtime/src/internal/deployment-start-owner.ts",
    "export function registerVerifiedDeploymentRuntimeStartV1() {}\n",
  );
  const registrarDiagnostics: BoundaryDiagnostic[] = [];
  validateSearcherRuntimeDeploymentStartupSources(registrar, registrarDiagnostics);
  assert.ok(registrarDiagnostics.some(item => item.code === "deployment-shared-start-owner"));
  assert.ok(registrarDiagnostics.some(item => item.code === "deployment-shared-start-authority"));
});

test("artifact-lineage Stage 1 has one release-owned observer/store authority chain", () => {
  const publicPath = "acceptance/collectors/src/production-artifact-lineage-observer.ts";
  const ownerPath = "acceptance/collectors/src/internal/artifact-lineage-stage-one-owner.ts";
  const statePath = "acceptance/collectors/src/internal/artifact-lineage-stage-one-state.ts";
  const storePath = "acceptance/collectors/src/internal/release-owned-observer-store.ts";
  const publicExports = [
    "  assertIssuedProductionArtifactLineageStageOneObserverPortV1,",
    "  readArtifactLineageStageOneCapabilityV1,",
    "  type ArtifactLineageStageOneCapabilityV1,",
    "  type ArtifactLineageStageOneObservationV1,",
    "  type ProductionArtifactLineageStageOneObserverPortV1,",
  ];
  const baseline = new Map<string, string>([
    [publicPath, [
      "export {",
      ...publicExports,
      "} from './internal/artifact-lineage-stage-one-state.ts';",
    ].join("\n")],
    ["acceptance/collectors/src/index.ts", [
      "export {",
      ...publicExports,
      "} from './production-artifact-lineage-observer.ts';",
    ].join("\n")],
    [ownerPath, [
      "async function runGit(repositoryRoot: string, args: readonly string[], maxOutputBytes: number) {",
      "  return new Uint8Array(execFileSync('/usr/bin/git', [",
      "    '--no-replace-objects',",
      "    '-c', 'core.excludesFile=/dev/null',",
      "    '-c', 'core.fsmonitor=false',",
      "    '-c', 'core.hooksPath=/dev/null',",
      "    '-c', 'credential.helper=',",
      "    '-c', 'core.sshCommand=/bin/false',",
      "    '-c', 'protocol.allow=never',",
      "    '-c', 'protocol.ext.allow=never',",
      "    '-c', 'protocol.file.allow=never',",
      "    '-c', `safe.directory=${repositoryRoot}`,",
      "    '-C', repositoryRoot,",
      "    ...args,",
      "  ], {",
      "    encoding: null,",
      "    env: {",
      "      GIT_CONFIG_GLOBAL: '/dev/null',",
      "      GIT_CONFIG_NOSYSTEM: '1',",
      "      GIT_ALLOW_PROTOCOL: '',",
      "      GIT_ASKPASS: '/bin/false',",
      "      GIT_NO_LAZY_FETCH: '1',",
      "      GIT_OPTIONAL_LOCKS: '0',",
      "      GIT_TERMINAL_PROMPT: '0',",
      "      LANG: 'C',",
      "      LC_ALL: 'C',",
      "      PATH: '/usr/bin:/bin',",
      "      SSH_ASKPASS: '/bin/false',",
      "    },",
      "    maxBuffer: maxOutputBytes,",
      "    stdio: ['ignore', 'pipe', 'pipe'],",
      "  }));",
      "}",
      "const RELEASE_DENOMINATOR_PATHS = Object.freeze([",
      "  'acceptance/gate-core/src/generated/predicate-composition.ts',",
      "  'acceptance/gate-core/src/generated/release-role-manifest.ts',",
      "  'acceptance/gate-core/src/generated/release-runtime.ts',",
      "  'acceptance/gate-core/src/generated/release-authority.ts',",
      "  'acceptance/gate-core/src/release-role-manifest.ledger.json',",
      "] as const);",
      "interface ProductionArtifactLineageStageOneOwnerInputV1 {",
      "  readonly repositoryRoot: string;",
      "  readonly store: ReleaseOwnedObserverStoreCapabilityV1;",
      "  readonly assertCurrent: () => void;",
      "}",
      "async function readExactCommitFile(repositoryRoot: string, candidateReleaseCommit: string, path: string, maxOutputBytes: number) {",
      "  const tree = await runGit(repositoryRoot, ['ls-tree', '-z', candidateReleaseCommit, '--', path], 4096);",
      "  const match = [tree, tree, 'blob'];",
      "  const bytes = await runGit(repositoryRoot, ['cat-file', 'blob', match[2]], maxOutputBytes);",
      "  return { path, bytes };",
      "}",
      "async function observeExactReleaseDenominator(repositoryRoot: string, store: object, assertCurrent: () => void) {",
      "  const candidateReleaseCommit = 'a'; const maxOutputBytes = 1; const files = [];",
      "  for (const path of RELEASE_DENOMINATOR_PATHS) {",
      "    const file = await readExactCommitFile(repositoryRoot, candidateReleaseCommit, path, maxOutputBytes);",
      "    files.push(file);",
      "  }",
      "  return registerArtifactLineageStageOneCapabilityV1(store, assertCurrent, {});",
      "}",
      "export function issueProductionArtifactLineageStageOneObserverPortV1(input: ProductionArtifactLineageStageOneOwnerInputV1) { return input; }",
    ].join("\n")],
    [statePath, [
      "export type ArtifactLineageStageOneCapabilityV1 = object;",
      "export interface ArtifactLineageStageOneObservationV1 {}",
      "export interface ProductionArtifactLineageStageOneObserverPortV1 {}",
      "const observations = new WeakMap<object, object>();",
      "const issuedPorts = new WeakMap<object, object>();",
      "export function registerArtifactLineageStageOneCapabilityV1(store: object, assertCurrent: () => void, observation: object) { const value = {}; observations.set(value, { store, assertCurrent, observation }); return value; }",
      "export function registerArtifactLineageStageOneObserverPortV1(store: object, assertCurrent: () => void, observe: () => Promise<object>) { let result: Promise<object> | null = null; const value = { async observe() { assertCurrent(); result ??= observe(); const capability = await result; assertCurrent(); return capability; } }; issuedPorts.set(value, store); return value; }",
      "export function readArtifactLineageStageTwoAuthorityV1(port: object, store: object) { assertArtifactLineageStageOneObserverStoreV1(port, store); const state: any = issuedPorts.get(port)!; state.assertCurrent(); const authority = readReleaseOwnedObserverStoreV1(store).authority; return authority; }",
      "export function assertIssuedProductionArtifactLineageStageOneObserverPortV1(value: object) { return issuedPorts.has(value); }",
      "export function assertArtifactLineageStageOneObserverStoreV1(value: object, store: object) { return issuedPorts.get(value) === store; }",
      "export async function readArtifactLineageStageOneCapabilityV1(value: object) { const state = observations.get(value) as any; state.assertCurrent(); const sink = state.store.sink; for (const artifact of state.observation.artifacts) { await sink.readContent(artifact.contentSha256); } state.assertCurrent(); return state.observation; }",
    ].join("\n")],
    [storePath, [
      "export type ReleaseOwnedObserverStoreCapabilityV1 = object;",
      "const stores = new WeakMap<object, object>();",
      "export function issueReleaseOwnedObserverStoreV1(input: object) { const directoryValue = '/tmp/store'; const observedStoreEpoch = '1'; const authority = {}; const storeAuthorityRoot = hashDomain('aloha/release-owned-observer-store-authority/v1', { ...authority, directory: directoryValue, observedStoreEpoch }); const sink = new ContentAddressedObserverSinkV1({ directory: directoryValue, storeIdentityHash: storeAuthorityRoot }); const value = {}; stores.set(value, { input, sink }); return value; }",
      "export function readReleaseOwnedObserverStoreV1(value: object) { return stores.get(value); }",
    ].join("\n")],
  ]);
  const baselineDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(baseline, baselineDiagnostics);
  assert.deepEqual(baselineDiagnostics, []);

  for (const [from, to] of [
    ["GIT_NO_LAZY_FETCH: '1'", "GIT_NO_LAZY_FETCH: '0'"],
    ["GIT_ALLOW_PROTOCOL: ''", "GIT_ALLOW_PROTOCOL: 'https'"],
    ["protocol.allow=never", "protocol.allow=https"],
    ["core.sshCommand=/bin/false", "core.sshCommand=ssh"],
    ["GIT_ASKPASS: '/bin/false'", "GIT_ASKPASS: '/usr/bin/true'"],
    ["SSH_ASKPASS: '/bin/false'", "SSH_ASKPASS: '/usr/bin/true'"],
    ["GIT_TERMINAL_PROMPT: '0'", "GIT_TERMINAL_PROMPT: '1'"],
  ] as const) {
    const mutation = new Map(baseline);
    mutation.set(ownerPath, baseline.get(ownerPath)!.replace(from, to));
    const diagnostics: BoundaryDiagnostic[] = [];
    validateArtifactLineageStageOneSources(mutation, diagnostics);
    assert.ok(diagnostics.some(item => item.code === "artifact-lineage-git-local-only"), `${from} mutation escaped`);
  }

  const rawIssuer = new Map(baseline);
  rawIssuer.set(ownerPath, `${baseline.get(ownerPath)!}\nexport function issueArtifactLineageStageOneCapabilityV1(value: unknown) { return value; }\n`);
  const rawDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(rawIssuer, rawDiagnostics);
  assert.ok(rawDiagnostics.some(item => item.code === "artifact-lineage-stage-one-raw-issuer"));

  const widened = new Map(baseline);
  widened.set(ownerPath, baseline.get(ownerPath)!.replace(
    "  readonly store: ReleaseOwnedObserverStoreCapabilityV1;",
    "  readonly store: ReleaseOwnedObserverStoreCapabilityV1;\n  readonly files: readonly string[];",
  ));
  const widenedDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(widened, widenedDiagnostics);
  assert.ok(widenedDiagnostics.some(item => item.code === "artifact-lineage-stage-one-caller-material"));

  for (const property of ["candidateReleaseCommit", "observedStoreEpoch"] as const) {
    const callerAuthority = new Map(baseline);
    callerAuthority.set(ownerPath, baseline.get(ownerPath)!.replace(
      "  readonly store: ReleaseOwnedObserverStoreCapabilityV1;",
      `  readonly store: ReleaseOwnedObserverStoreCapabilityV1;\n  readonly ${property}: string;`,
    ));
    const callerAuthorityDiagnostics: BoundaryDiagnostic[] = [];
    validateArtifactLineageStageOneSources(callerAuthority, callerAuthorityDiagnostics);
    assert.ok(callerAuthorityDiagnostics.some(item => item.code === "artifact-lineage-stage-one-caller-material"));
  }

  const ownerAlias = new Map(baseline);
  ownerAlias.set(ownerPath, `${baseline.get(ownerPath)!}\nexport const mint = issueProductionArtifactLineageStageOneObserverPortV1;\n`);
  const ownerAliasDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(ownerAlias, ownerAliasDiagnostics);
  assert.ok(ownerAliasDiagnostics.some(item => item.code === "artifact-lineage-stage-one-owner-export"));

  const publicAlias = new Map(baseline);
  publicAlias.set(publicPath, baseline.get(publicPath)!.replace(
    "  assertIssuedProductionArtifactLineageStageOneObserverPortV1,",
    "  assertIssuedProductionArtifactLineageStageOneObserverPortV1 as mint,",
  ));
  const publicAliasDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(publicAlias, publicAliasDiagnostics);
  assert.ok(publicAliasDiagnostics.some(item => item.code === "artifact-lineage-stage-one-public-surface"));

  const secondStateWriter = new Map(baseline);
  secondStateWriter.set(statePath, `${baseline.get(statePath)!}\nfunction mint(value: object) { observations.set(value, {}); }\n`);
  const secondStateWriterDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(secondStateWriter, secondStateWriterDiagnostics);
  assert.ok(secondStateWriterDiagnostics.some(item => item.code === "artifact-lineage-stage-one-state-writer"));

  const secondStoreWriter = new Map(baseline);
  secondStoreWriter.set(storePath, `${baseline.get(storePath)!}\nfunction mint(value: object) { stores.set(value, {}); }\n`);
  const secondStoreWriterDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(secondStoreWriter, secondStoreWriterDiagnostics);
  assert.ok(secondStoreWriterDiagnostics.some(item => item.code === "artifact-lineage-stage-one-store-writer"));

  const shortenedDenominator = new Map(baseline);
  shortenedDenominator.set(ownerPath, baseline.get(ownerPath)!.replace(
    "  'acceptance/gate-core/src/generated/release-authority.ts',\n",
    "",
  ));
  const shortenedDenominatorDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(shortenedDenominator, shortenedDenominatorDiagnostics);
  assert.ok(shortenedDenominatorDiagnostics.some(item => item.code === "artifact-lineage-stage-one-denominator"));

  const truncatedIteration = new Map(baseline);
  truncatedIteration.set(ownerPath, baseline.get(ownerPath)!.replace(
    "for (const path of RELEASE_DENOMINATOR_PATHS)",
    "for (const path of RELEASE_DENOMINATOR_PATHS.slice(0, 1))",
  ));
  const truncatedIterationDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(truncatedIteration, truncatedIterationDiagnostics);
  assert.ok(truncatedIterationDiagnostics.some(item => item.code === "artifact-lineage-stage-one-semantics"));

  const headRead = new Map(baseline);
  headRead.set(ownerPath, baseline.get(ownerPath)!.replace(
    "['ls-tree', '-z', candidateReleaseCommit, '--', path]",
    "['ls-tree', '-z', 'HEAD', '--', path]",
  ));
  const headReadDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(headRead, headReadDiagnostics);
  assert.ok(headReadDiagnostics.some(item => item.code === "artifact-lineage-stage-one-semantics"));

  const staleRead = new Map(baseline);
  staleRead.set(statePath, baseline.get(statePath)!.replace(
    "state.assertCurrent(); return state.observation;",
    "return state.observation;",
  ));
  const staleReadDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(staleRead, staleReadDiagnostics);
  assert.ok(staleReadDiagnostics.some(item => item.code === "artifact-lineage-stage-one-semantics"));

  const noReadback = new Map(baseline);
  noReadback.set(statePath, baseline.get(statePath)!.replace(
    "await sink.readContent(artifact.contentSha256);",
    "void artifact.contentSha256;",
  ));
  const noReadbackDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(noReadback, noReadbackDiagnostics);
  assert.ok(noReadbackDiagnostics.some(item => item.code === "artifact-lineage-stage-one-semantics"));

  const internalBarrel = new Map(baseline);
  internalBarrel.set("acceptance/collectors/src/index.ts", `${baseline.get("acceptance/collectors/src/index.ts")!}\nexport { issueProductionArtifactLineageStageOneObserverPortV1 } from './internal/artifact-lineage-stage-one-owner.ts';\n`);
  const internalBarrelDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(internalBarrel, internalBarrelDiagnostics);
  assert.ok(internalBarrelDiagnostics.some(item => item.code === "artifact-lineage-stage-one-internal-barrel"));
});

test("current artifact-lineage Stage 1 imports match the frozen exact owner manifest", () => {
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const runtimeOwner = "tools/runtime-release-packager/src/internal/root-predicate-material-source-owner.ts";
  const owner = "acceptance/collectors/src/internal/artifact-lineage-stage-one-owner.ts";
  const state = "acceptance/collectors/src/internal/artifact-lineage-stage-one-state.ts";
  const store = "acceptance/collectors/src/internal/release-owned-observer-store.ts";
  const sink = "acceptance/collectors/src/content-addressed-sink.ts";
  const publicFacade = "acceptance/collectors/src/production-artifact-lineage-observer.ts";
  const materialSource = "acceptance/collectors/src/production-predicate-material-source.ts";
  const runtimeObservers = "acceptance/collectors/src/production-runtime-boundary-observers.ts";
  const rows = [
    [runtimeOwner, owner, "../../../../acceptance/collectors/src/internal/artifact-lineage-stage-one-owner.ts"],
    [runtimeOwner, materialSource, "../../../../acceptance/collectors/src/production-predicate-material-source.ts"],
    [owner, state, "./artifact-lineage-stage-one-state.ts"],
    [owner, store, "./release-owned-observer-store.ts"],
    [state, store, "./release-owned-observer-store.ts"],
    [store, sink, "../content-addressed-sink.ts"],
    [materialSource, publicFacade, "./production-artifact-lineage-observer.ts"],
    [materialSource, state, "./internal/artifact-lineage-stage-one-state.ts"],
    [materialSource, store, "./internal/release-owned-observer-store.ts"],
    [runtimeObservers, store, "./internal/release-owned-observer-store.ts"],
    [publicFacade, state, "./internal/artifact-lineage-stage-one-state.ts"],
  ] as const;
  const paths = [...new Set(rows.flatMap(([from, to]) => [from, to]))];
  const sourceDiagnostics: BoundaryDiagnostic[] = [];
  validateArtifactLineageStageOneSources(new Map([
    publicFacade,
    owner,
    state,
    store,
    "acceptance/collectors/src/index.ts",
  ].map(path => [path, readFileSync(join(repositoryRoot, path), "utf8")])), sourceDiagnostics);
  assert.deepEqual(sourceDiagnostics, []);
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: readFileSync(join(repositoryRoot, path)).byteLength,
    language: "typescript",
    fileClass: path === runtimeOwner
      ? "authoring"
      : path.startsWith("packages/")
        ? "central"
        : "acceptance-collector",
  });
  const diagnostics: BoundaryDiagnostic[] = [];
  validateDependencyBoundaries(
    paths.map(file),
    rows.map(([from, to, specifier]) => ({ from, to, specifier })),
    diagnostics,
    repositoryRoot,
  );
  assert.deepEqual(diagnostics, []);

  const intruder = "acceptance/collectors/src/six-step-observer.ts";
  const intrusionRoot = mkdtempSync(join(tmpdir(), "aloha-artifact-lineage-intrusion-"));
  try {
    mkdirSync(join(intrusionRoot, dirname(intruder)), { recursive: true });
    writeFileSync(
      join(intrusionRoot, intruder),
      `import { readArtifactLineageStageTwoAuthorityV1 } from "./internal/artifact-lineage-stage-one-state.ts";\n`,
    );
    const intrusionDiagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(intruder), file(state)],
      [{
        from: intruder,
        to: state,
        specifier: "./internal/artifact-lineage-stage-one-state.ts",
      }],
      intrusionDiagnostics,
      intrusionRoot,
    );
    assert.ok(intrusionDiagnostics.some(item => item.code === "collector-imports-authority-constructor"));
  } finally {
    rmSync(intrusionRoot, { recursive: true, force: true });
  }
});

test("current predicate material source authority imports match the frozen exact manifest", () => {
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const statePath = "acceptance/collectors/src/internal/predicate-material-source-owner.ts";
  const physicalIssuerPath = "acceptance/collectors/src/internal/predicate-material-source-issuer.ts";
  const bridgeIssuerPath = "acceptance/collectors/src/internal/predicate-material-source-bridge-issuer.ts";
  const rows = [
    ["acceptance/collectors/src/production-predicate-material-source.ts", physicalIssuerPath, "./internal/predicate-material-source-issuer.ts"],
    ["acceptance/collectors/src/predicate-material-source.ts", statePath, "./internal/predicate-material-source-owner.ts"],
    [physicalIssuerPath, statePath, "./predicate-material-source-owner.ts"],
    [bridgeIssuerPath, statePath, "./predicate-material-source-owner.ts"],
    ["tools/runtime-release-packager/src/internal/fresh-qualified-runner-host-owner.ts", statePath, "../../../../acceptance/collectors/src/internal/predicate-material-source-owner.ts"],
    ["tools/runtime-release-packager/src/internal/qualified-release-runtime-entry.ts", bridgeIssuerPath, "../../../../acceptance/collectors/src/internal/predicate-material-source-bridge-issuer.ts"],
    ["acceptance/collectors/src/material-providers/shared.ts", statePath, "../internal/predicate-material-source-owner.ts"],
    ["acceptance/collectors/src/material-providers/runtime-boundaries.ts", statePath, "../internal/predicate-material-source-owner.ts"],
    ["acceptance/collectors/src/material-providers/terminal-selection.ts", statePath, "../internal/predicate-material-source-owner.ts"],
    ["acceptance/collectors/src/material-providers/artifact-lineage.ts", statePath, "../internal/predicate-material-source-owner.ts"],
    ["acceptance/collectors/src/material-providers/performance.ts", statePath, "../internal/predicate-material-source-owner.ts"],
    ["acceptance/collectors/src/material-providers/six-step.ts", statePath, "../internal/predicate-material-source-owner.ts"],
    ["acceptance/collectors/src/material-providers/full-family.ts", statePath, "../internal/predicate-material-source-owner.ts"],
  ] as const;
  const paths = [...new Set(rows.flatMap(([from, to]) => [from, to]))];
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: readFileSync(join(repositoryRoot, path)).byteLength,
    language: "typescript",
    fileClass: path.startsWith("tools/") ? "authoring" : "acceptance-collector",
  });
  const diagnostics: BoundaryDiagnostic[] = [];
  validateDependencyBoundaries(
    paths.map(file),
    rows.map(([from, to, specifier]) => ({ from, to, specifier })),
    diagnostics,
    repositoryRoot,
  );
  assert.deepEqual(diagnostics, []);
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

test("valuation owners are plugins composed only by the generated valuation registry", () => {
  const file = (path: string): TrackedFile => {
    const classified = classifyBoundaryPathV1(path);
    return {
      path,
      mode: "100644",
      blobSha: "a".repeat(40),
      contentSha256: `0x${"a".repeat(64)}`,
      byteLength: 1,
      language: classified.language,
      fileClass: classified.fileClass,
    };
  };
  const runtimeOwner = "packages/runtime-release-authority/src/internal/economic-safety-owner.ts";
  const generatedRegistry = "generated/valuation-owner-registry/index.ts";
  const ownerRuntime = "valuation-owners/native-equivalent/src/runtime.ts";
  const ownerQualification = "valuation-owners/native-equivalent/src/qualification.ts";
  const centralContract = "packages/economics-safety/src/evaluator.ts";
  const canonicalCodec = "packages/canonical-codec/src/index.ts";
  const valuationSpec = "specs/economic-valuation-owner/src/index.ts";
  const files = [
    runtimeOwner, generatedRegistry, ownerRuntime, ownerQualification,
    centralContract, canonicalCodec, valuationSpec,
  ].map(file);
  assert.equal(classifyBoundaryPathV1(ownerRuntime).fileClass, "valuation-owner");
  assert.equal(classifyBoundaryPathV1(generatedRegistry).fileClass, "generated");

  const allowed: GraphEdge[] = [
    { from: runtimeOwner, to: generatedRegistry, specifier: "../../../../generated/valuation-owner-registry/index.ts" },
    { from: generatedRegistry, to: ownerRuntime, specifier: "../../valuation-owners/native-equivalent/src/runtime.ts" },
    { from: ownerRuntime, to: canonicalCodec, specifier: "../../../packages/canonical-codec/src/index.ts" },
    { from: ownerRuntime, to: valuationSpec, specifier: "../../../specs/economic-valuation-owner/src/index.ts" },
  ];
  const allowedDiagnostics: BoundaryDiagnostic[] = [];
  validateDependencyBoundaries(files, allowed, allowedDiagnostics);
  assert.deepEqual(allowedDiagnostics, []);

  const forbiddenFiles = [
    ...files,
    file("packages/ordinary/src/index.ts"),
    file("apps/searcher-runtime/src/index.ts"),
    file("generated/ordinary/index.ts"),
    file("valuation-owners/foreign/src/runtime.ts"),
  ];
  const forbidden: GraphEdge[] = [
    { from: "packages/ordinary/src/index.ts", to: ownerRuntime, specifier: "../../../valuation-owners/native-equivalent/src/runtime.ts" },
    { from: "apps/searcher-runtime/src/index.ts", to: ownerRuntime, specifier: "../../../valuation-owners/native-equivalent/src/runtime.ts" },
    { from: "generated/ordinary/index.ts", to: ownerRuntime, specifier: "../../valuation-owners/native-equivalent/src/runtime.ts" },
    { from: generatedRegistry, to: ownerQualification, specifier: "../../valuation-owners/native-equivalent/src/qualification.ts" },
    { from: ownerRuntime, to: centralContract, specifier: "../../../packages/economics-safety/src/evaluator.ts" },
    { from: ownerRuntime, to: "packages/ordinary/src/index.ts", specifier: "../../../packages/ordinary/src/index.ts" },
    { from: ownerRuntime, to: "valuation-owners/foreign/src/runtime.ts", specifier: "../../foreign/src/runtime.ts" },
  ];
  const diagnostics: BoundaryDiagnostic[] = [];
  validateDependencyBoundaries(forbiddenFiles, forbidden, diagnostics);
  const codes = new Set(diagnostics.map(item => item.code));
  for (const expected of [
    "central-imports-valuation-owner",
    "runtime-imports-valuation-owner",
    "generated-imports-valuation-owner-internal",
    "valuation-owner-imports-forbidden-central",
    "valuation-owner-imports-valuation-owner",
  ]) assert.ok(codes.has(expected), `missing ${expected}`);
});

test("six-step valuation oracle composition is authored acceptance composition, not an unowned generated tree", () => {
  const file = (path: string): TrackedFile => {
    const classified = classifyBoundaryPathV1(path);
    return {
      path,
      mode: "100644",
      blobSha: "a".repeat(40),
      contentSha256: `0x${"a".repeat(64)}`,
      byteLength: 1,
      language: classified.language,
      fileClass: classified.fileClass,
    };
  };
  const predicate = "acceptance/six-step-facts/src/predicate.ts";
  const qualification = "acceptance/six-step-facts/src/qualification.ts";
  const referenceModel = "acceptance/six-step-facts/src/reference-model.ts";
  const predicateComposition = "acceptance/six-step-facts/src/composition/valuation-oracle-composition.ts";
  const referenceComposition = "acceptance/six-step-facts/src/composition/reference-valuation-oracle-composition.ts";
  const manifest = "acceptance/six-step-facts/src/composition/valuation-oracle-manifest.ts";
  const predicateLeaf = "acceptance/six-step-facts/src/valuation-oracles/native-equivalent.ts";
  const referenceLeaf = "acceptance/six-step-facts/src/reference-valuation-oracles/native-equivalent.ts";
  const predicateContract = "acceptance/six-step-facts/src/valuation-oracle.ts";
  const referenceContract = "acceptance/six-step-facts/src/reference-valuation-oracle.ts";
  const files = [
    predicate,
    qualification,
    referenceModel,
    predicateComposition,
    referenceComposition,
    manifest,
    predicateLeaf,
    referenceLeaf,
    predicateContract,
    referenceContract,
  ].map(file);
  for (const path of [predicateComposition, referenceComposition, manifest]) {
    assert.equal(classifyBoundaryPathV1(path).fileClass, "acceptance-pure-core");
  }
  assert.equal(
    classifyBoundaryPathV1("acceptance/six-step-facts/src/generated/valuation-oracle-manifest.ts").fileClass,
    "generated",
  );
  const edges: GraphEdge[] = [
    { from: predicate, to: predicateComposition, specifier: "./composition/valuation-oracle-composition.ts" },
    { from: qualification, to: manifest, specifier: "./composition/valuation-oracle-manifest.ts" },
    { from: referenceModel, to: referenceComposition, specifier: "./composition/reference-valuation-oracle-composition.ts" },
    { from: predicateComposition, to: predicateLeaf, specifier: "../valuation-oracles/native-equivalent.ts" },
    { from: predicateComposition, to: predicateContract, specifier: "../valuation-oracle.ts" },
    { from: referenceComposition, to: referenceLeaf, specifier: "../reference-valuation-oracles/native-equivalent.ts" },
    { from: referenceComposition, to: referenceContract, specifier: "../reference-valuation-oracle.ts" },
    { from: manifest, to: predicateLeaf, specifier: "../valuation-oracles/native-equivalent.ts" },
    { from: manifest, to: referenceLeaf, specifier: "../reference-valuation-oracles/native-equivalent.ts" },
  ];
  const diagnostics: BoundaryDiagnostic[] = [];
  validateDependencyBoundaries(files, edges, diagnostics);
  assert.deepEqual(diagnostics, []);
});

test("request-program and interpreter authority state crosses only exact owner-consumer edges", () => {
  const file = (path: string): TrackedFile => {
    const classified = classifyBoundaryPathV1(path);
    return {
      path, mode: "100644", blobSha: "a".repeat(40), contentSha256: `0x${"a".repeat(64)}`,
      byteLength: 1, language: classified.language, fileClass: classified.fileClass,
    };
  };
  const files = [
    file("packages/request-program/src/index.ts"),
    file("packages/request-program/src/internal/issuer-state.ts"),
    file("packages/request-program/src/internal/issuer-owner.ts"),
    file("packages/capability-interpreters/src/index.ts"),
    file("packages/capability-interpreters/src/internal/registry-state.ts"),
    file("packages/capability-interpreters/src/internal/registry-owner.ts"),
    file("packages/ordinary/src/index.ts"),
  ];
  const allowed: GraphEdge[] = [
    { from: "packages/request-program/src/index.ts", to: "packages/request-program/src/internal/issuer-state.ts", specifier: "./internal/issuer-state.ts" },
    { from: "packages/request-program/src/internal/issuer-owner.ts", to: "packages/request-program/src/internal/issuer-state.ts", specifier: "./issuer-state.ts" },
    { from: "packages/capability-interpreters/src/index.ts", to: "packages/capability-interpreters/src/internal/registry-state.ts", specifier: "./internal/registry-state.ts" },
    { from: "packages/capability-interpreters/src/internal/registry-owner.ts", to: "packages/capability-interpreters/src/internal/registry-state.ts", specifier: "./registry-state.ts" },
  ];
  const allowedDiagnostics: BoundaryDiagnostic[] = [];
  validateDependencyBoundaries(files, allowed, allowedDiagnostics);
  assert.deepEqual(allowedDiagnostics, []);
  const forbiddenDiagnostics: BoundaryDiagnostic[] = [];
  validateDependencyBoundaries(files, [{ from: "packages/ordinary/src/index.ts", to: "packages/request-program/src/internal/issuer-state.ts", specifier: "../request-program/src/internal/issuer-state.ts" }], forbiddenDiagnostics);
  assert.equal(forbiddenDiagnostics.some(item => item.code === "central-imports-authority-constructor"), true);
});

test("catalog impact and nomination reuse capabilities cross only exact owner-consumer edges", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-catalog-reuse-owner-"));
  const cases = [
    {
      ownerPath: "tools/catalog-generator/src/current-impact-analysis-owner.ts",
      statePath: "tools/catalog-generator/src/internal/current-impact-analysis-state.ts",
      specifier: "./internal/current-impact-analysis-state.ts",
      name: "registerCurrentCatalogImpactAnalysisCapabilityV1",
    },
    {
      ownerPath: "tools/runtime-release-packager/src/nomination-qualification-reuse.ts",
      statePath: "tools/catalog-generator/src/internal/current-impact-analysis-state.ts",
      specifier: "../../catalog-generator/src/internal/current-impact-analysis-state.ts",
      name: "readCurrentCatalogImpactAnalysisCapabilityV1",
    },
    {
      ownerPath: "tools/runtime-release-packager/src/nomination-qualification-reuse.ts",
      statePath: "tools/runtime-release-packager/src/internal/nomination-qualification-reuse-owner-state.ts",
      specifier: "./internal/nomination-qualification-reuse-owner-state.ts",
      name: "readNominationQualificationReuseOwnerCompositionV1",
    },
    {
      ownerPath: "tools/runtime-release-packager/src/nomination-qualification-reuse-owner.ts",
      statePath: "tools/runtime-release-packager/src/internal/nomination-qualification-reuse-owner-state.ts",
      specifier: "./internal/nomination-qualification-reuse-owner-state.ts",
      name: "readNominationQualificationReuseOwnerCompositionV1, registerNominationQualificationReuseOwnerCompositionV1",
    },
    {
      ownerPath: "tools/runtime-release-packager/src/nomination-qualification-reuse-owner.ts",
      statePath: "tools/runtime-release-packager/src/internal/pre-release-runtime-receipt-state.ts",
      specifier: "./internal/pre-release-runtime-receipt-state.ts",
      name: "readPreReleaseAdvisoryMaterialV1",
    },
    {
      ownerPath: "tools/runtime-release-packager/src/nomination-qualification-reuse-owner.ts",
      statePath: "tools/runtime-release-packager/src/internal/qualified-release-public-runner-state.ts",
      specifier: "./internal/qualified-release-public-runner-state.ts",
      name: "readAuthorizedQualifiedReleaseRunnerWireV1",
    },
  ] as const;
  const file = (path: string): TrackedFile => ({
    path, mode: "100644", blobSha: "a".repeat(40), contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1, language: "typescript", fileClass: "central",
  });
  try {
    for (const value of cases) {
      mkdirSync(join(root, dirname(value.ownerPath)), { recursive: true });
      const edge: GraphEdge = { from: value.ownerPath, to: value.statePath, specifier: value.specifier };
      const inspect = (source: string, edges: readonly GraphEdge[] = [edge]): readonly BoundaryDiagnostic[] => {
        writeFileSync(join(root, value.ownerPath), source);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries([file(value.ownerPath), file(value.statePath)], edges, diagnostics, root);
        return diagnostics;
      };
      const exact = `import { ${value.name} } from "${value.specifier}";\n`;
      assert.deepEqual(inspect(exact), []);
      assert.ok(inspect(exact, []).some(item => item.code === "authority-consumer-edge-missing"));
      assert.ok(inspect(
        exact.replace(value.specifier, `${value.specifier}?alternate`),
        [{ ...edge, specifier: `${value.specifier}?alternate` }],
      ).some(item => item.code === "authority-module-specifier-mismatch"));
      const normalizedDeepImport = value.specifier.replace("/internal/", "/internal/../internal/");
      assert.ok(inspect(
        exact.replace(value.specifier, normalizedDeepImport),
        [{ ...edge, specifier: normalizedDeepImport }],
      ).some(item => item.code === "authority-module-specifier-mismatch"));
      assert.ok(inspect(`import * as state from "${value.specifier}";\n`).some(item => item.code === "authority-named-import-mismatch"));

      const wrongImporter = "tools/ordinary/src/index.ts";
      mkdirSync(join(root, dirname(wrongImporter)), { recursive: true });
      writeFileSync(join(root, wrongImporter), exact);
      const diagnostics: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries(
        [file(wrongImporter), file(value.statePath)],
        [{ ...edge, from: wrongImporter }],
        diagnostics,
        root,
      );
      assert.equal(classifyBoundaryPathV1(wrongImporter).fileClass, "authoring");
      const wrongImporterCode = value.statePath.endsWith("current-impact-analysis-state.ts")
        || value.statePath.endsWith("nomination-qualification-reuse-owner-state.ts")
        ? "catalog-nomination-reuse-authority-owner"
        : "pre-release-authority-reader-owner";
      assert.ok(diagnostics.some(item => item.code === wrongImporterCode));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      assert.deepEqual(inspect(
        `import { ${value.allowed} } from "${value.specifier}";\n` +
        `import type { ${value.forbidden} } from "${value.specifier}";\n`,
      ), []);
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

test("runtime-release full-family terminal evidence uses only the exact owner and consumer edges", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-full-family-terminal-owner-"));
  const cases = [
    {
      importerPath: "packages/runtime-release-authority/src/internal/bootstrap.ts",
      targetPath: "packages/runtime-release-authority/src/internal/full-family-terminal-owner.ts",
      specifier: "./full-family-terminal-owner.ts",
      allowed: "issueRuntimeReleaseFullFamilyTerminalBindingServiceV1",
    },
    {
      importerPath: "packages/runtime-release-authority/src/full-family-terminal-consumer.ts",
      targetPath: "packages/runtime-release-authority/src/internal/full-family-terminal-owner.ts",
      specifier: "./internal/full-family-terminal-owner.ts",
      allowed: "assertIssuedRuntimeReleaseFullFamilyTerminalBindingServiceV1, readRuntimeReleaseFullFamilyTerminalBindingCapabilityV1, readRuntimeReleaseNativeFullFamilyAuditCapabilityV1, readRuntimeReleaseNativeFullFamilyAuditChunkBytesCapabilityV1",
    },
    {
      importerPath: "packages/runtime-release-authority/src/internal/full-family-terminal-owner.ts",
      targetPath: "packages/runtime-release-authority/src/internal/state.ts",
      specifier: "./state.ts",
      allowed: "assertActiveRuntimeReleaseAuthorityState",
    },
    {
      importerPath: "packages/runtime-release-authority/src/internal/full-family-terminal-owner.ts",
      targetPath: "packages/search-pipeline/src/index.ts",
      specifier: "../../../../packages/search-pipeline/src/index.ts",
      allowed: "readIssuedNativeFullFamilyAuditChunkBytesV1, readIssuedNativeFullFamilyAuditManifestV1, readIssuedNativeFullFamilyAuditV1, readIssuedSearchTerminalCapabilityV1, readIssuedSearchTerminalNativeFullFamilyAuditCapabilityV1, searchTerminalEvidenceHashV2",
    },
    {
      importerPath: "acceptance/collectors/src/full-family-observer.ts",
      targetPath: "packages/runtime-release-authority/src/full-family-terminal-consumer.ts",
      specifier: "../../../packages/runtime-release-authority/src/full-family-terminal-consumer.ts",
      allowed: "readRuntimeReleaseFullFamilyTerminalBindingV1, readRuntimeReleaseNativeFullFamilyAuditChunkV1, readRuntimeReleaseNativeFullFamilyAuditV1",
    },
    {
      importerPath: "acceptance/collectors/src/full-family-observer.ts",
      targetPath: "packages/checkpoint/src/ready-full-family-evidence-consumer.ts",
      specifier: "../../../packages/checkpoint/src/ready-full-family-evidence-consumer.ts",
      allowed: "readCheckpointReadyFullFamilyEvidence",
    },
  ] as const;
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: path.startsWith("acceptance/collectors/") ? "acceptance-collector" : "central",
  });
  try {
    for (const value of cases) {
      mkdirSync(join(root, dirname(value.importerPath)), { recursive: true });
      const edge: GraphEdge = { from: value.importerPath, to: value.targetPath, specifier: value.specifier };
      const inspect = (source: string, edges: readonly GraphEdge[] = [edge]) => {
        writeFileSync(join(root, value.importerPath), source);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries([file(value.importerPath), file(value.targetPath)], edges, diagnostics, root);
        return diagnostics;
      };
      const exact = `import { ${value.allowed} } from "${value.specifier}";\n`;
      assert.deepEqual(inspect(exact), []);
      assert.ok(inspect("export {};\n", []).some(item => item.code === "authority-consumer-edge-missing"));
      assert.ok(inspect(`import { extra } from "${value.specifier}";\n`).some(item => item.code === "authority-named-import-mismatch"));
      const alternate = `${value.specifier}?alternate`;
      assert.ok(inspect(exact.replace(value.specifier, alternate), [{ ...edge, specifier: alternate }])
        .some(item => item.code === "authority-module-specifier-mismatch"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal-phase authority composition exact-binds every importer, module and runtime export", () => {
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "aloha-terminal-phase-authority-"));
  const cases = [
    ["packages/terminal-phase-observation-port/src/index.ts", "packages/terminal-phase-observation-port/src/internal/owner.ts", "./internal/owner.ts", ["assertIssuedProductionTerminalPhaseObservationPortV1"]],
    ["acceptance/collectors/src/production-terminal-phase-port.ts", "packages/terminal-phase-observation-port/src/internal/owner.ts", "../../../packages/terminal-phase-observation-port/src/internal/owner.ts", ["issueProductionTerminalPhaseObservationPortV1", "readProductionTerminalPhaseObservationResultV1"]],
    ["acceptance/collectors/src/production-terminal-phase-port.ts", "packages/final-durable-window/src/index.ts", "../../../packages/final-durable-window/src/index.ts", ["readFinalDurableWindowBindingV1"]],
    ["acceptance/collectors/src/production-terminal-phase-port.ts", "packages/runtime-release-authority/src/full-graph-coarse-sweep-consumer.ts", "../../../packages/runtime-release-authority/src/full-graph-coarse-sweep-consumer.ts", ["readRuntimeReleaseFullGraphCoarseSweepManifestV1"]],
    ["acceptance/collectors/src/production-terminal-phase-port.ts", "acceptance/collectors/src/production-full-family-port.ts", "./production-full-family-port.ts", ["readProductionFullFamilyCollectorResultV1"]],
    ["acceptance/collectors/src/production-terminal-phase-port.ts", "acceptance/collectors/src/production-six-step-port.ts", "./production-six-step-port.ts", ["readProductionSixStepCollectorResultV1"]],
    ["acceptance/collectors/src/six-step-observer.ts", "packages/runtime-release-authority/src/six-step-terminal-consumer.ts", "../../../packages/runtime-release-authority/src/six-step-terminal-consumer.ts", ["readRuntimeReleaseSixStepTerminalArtifactsV1", "readRuntimeReleaseSixStepTerminalBindingV1"]],
    ["acceptance/collectors/src/six-step-observer.ts", "packages/evidence-emitter/src/index.ts", "../../../packages/evidence-emitter/src/index.ts", ["readProductionSixStepArtifactMaterialV1"]],
    ["acceptance/collectors/src/terminal-phase-locator-index.ts", "packages/evidence-emitter/src/index.ts", "../../../packages/evidence-emitter/src/index.ts", ["decodeProductionSixStepArtifactMaterialV1"]],
    ["acceptance/collectors/src/six-step-observer.ts", "packages/six-step-process-evidence/src/index.ts", "../../../packages/six-step-process-evidence/src/index.ts", ["readSearcherProductionSixStepProcessEvidenceV1", "readSearcherProductionSixStepWindowSelectionV1"]],
    ["packages/six-step-process-evidence/src/index.ts", "packages/six-step-process-evidence/src/internal/complete-append-owner.ts", "./internal/complete-append-owner.ts", ["readSearcherProductionSixStepCompleteAppendMaterialV1"]],
    ["packages/six-step-process-evidence/src/index.ts", "packages/six-step-process-evidence/src/internal/window-selection-owner.ts", "./internal/window-selection-owner.ts", ["SIX_STEP_WINDOW_SELECTION_POLICY_DIGEST", "readSearcherProductionSixStepWindowSelectionCapabilityV1"]],
    ["packages/six-step-process-evidence/src/internal/window-selection-owner.ts", "packages/final-durable-window/src/index.ts", "../../../final-durable-window/src/index.ts", ["readFinalDurableWindowBindingV1"]],
    ["packages/six-step-process-evidence/src/internal/window-selection-owner.ts", "packages/six-step-process-evidence/src/internal/complete-append-owner.ts", "./complete-append-owner.ts", ["readSearcherProductionSixStepCompleteAppendMaterialV1"]],
    ["apps/searcher-runtime/src/production-evidence.ts", "packages/six-step-process-evidence/src/internal/complete-append-owner.ts", "../../../packages/six-step-process-evidence/src/internal/complete-append-owner.ts", ["issueSearcherProductionSixStepCompleteAppendCapabilityV1", "issueSearcherProductionSixStepPerformanceAppendCapabilityV1", "readSearcherProductionSixStepCompleteAppendMaterialV1"]],
    ["apps/searcher-runtime/src/production-evidence.ts", "packages/six-step-process-evidence/src/internal/window-selection-owner.ts", "../../../packages/six-step-process-evidence/src/internal/window-selection-owner.ts", ["issueSearcherProductionSixStepWindowSelectionV1"]],
    ["apps/searcher-runtime/src/production-evidence.ts", "packages/final-durable-window/src/index.ts", "../../../packages/final-durable-window/src/index.ts", ["decodeTerminalPhaseInvalidFactV1", "readFinalDurableWindowBindingV1"]],
    ["apps/searcher-runtime/src/production-evidence.ts", "packages/final-durable-window/src/internal/owner.ts", "../../../packages/final-durable-window/src/internal/owner.ts", ["createTerminalPhaseHeadObservationV1", "createTerminalPhaseInvalidFactV1", "issueFinalDurableWindowCapabilityV1"]],
    ["apps/searcher-runtime/src/internal/application-owner.ts", "packages/runtime-release-authority/src/full-family-terminal-consumer.ts", "../../../../packages/runtime-release-authority/src/full-family-terminal-consumer.ts", ["assertIssuedRuntimeReleaseFullFamilyTerminalBindingServiceV1"]],
    ["apps/searcher-runtime/src/internal/application-owner.ts", "packages/runtime-release-authority/src/six-step-terminal-consumer.ts", "../../../../packages/runtime-release-authority/src/six-step-terminal-consumer.ts", ["assertIssuedRuntimeReleaseSixStepTerminalBindingServiceV1"]],
    ["apps/searcher-runtime/src/internal/application-owner.ts", "packages/full-family-observation-port/src/index.ts", "../../../../packages/full-family-observation-port/src/index.ts", ["assertIssuedProductionFullFamilyObservationPortV1"]],
    ["apps/searcher-runtime/src/internal/application-owner.ts", "packages/six-step-observation-port/src/index.ts", "../../../../packages/six-step-observation-port/src/index.ts", ["assertIssuedProductionSixStepObservationPortV1"]],
    ["apps/searcher-runtime/src/internal/application-owner.ts", "packages/terminal-phase-observation-port/src/index.ts", "../../../../packages/terminal-phase-observation-port/src/index.ts", ["assertIssuedProductionTerminalPhaseObservationPortV1"]],
    ["apps/searcher-runtime/src/internal/application-owner.ts", "packages/six-step-process-evidence/src/index.ts", "../../../../packages/six-step-process-evidence/src/index.ts", ["readSearcherProductionSixStepCompleteAppendSearchTerminalV1", "readSearcherProductionSixStepWindowSelectionV1"]],
    ["apps/searcher-runtime/src/internal/application-owner.ts", "packages/six-step-process-evidence/src/internal/owner.ts", "../../../../packages/six-step-process-evidence/src/internal/owner.ts", ["issueSearcherProductionSixStepProcessEvidenceV1"]],
    ["apps/searcher-runtime/src/internal/application-owner.ts", "packages/startup-runtime/src/index.ts", "../../../../packages/startup-runtime/src/index.ts", ["assertIssuedStartupRuntime", "readStartupFullFamilyEvidenceBinding"]],
    ["packages/runtime-release-authority/src/internal/bootstrap.ts", "packages/runtime-release-authority/src/internal/six-step-terminal-owner.ts", "./six-step-terminal-owner.ts", ["issueRuntimeReleaseSixStepTerminalBindingServiceV1"]],
    ["packages/runtime-release-authority/src/internal/bootstrap.ts", "packages/runtime-release-authority/src/internal/six-step-production-owner.ts", "./six-step-production-owner.ts", ["issueRuntimeReleaseSixStepProductionV1"]],
    ["packages/runtime-release-authority/src/internal/six-step-production-owner.ts", "packages/evidence-emitter/src/internal/six-step-production-owner.ts", "../../../evidence-emitter/src/internal/six-step-production-owner.ts", ["ProductionSixStepArtifactOwnerV1", "issueProductionSixStepArtifactStoreV1"]],
    ["packages/runtime-release-authority/src/internal/six-step-production-owner.ts", "packages/evidence-emitter/src/index.ts", "../../../evidence-emitter/src/index.ts", ["productionSixStepBoundaryKeyV1", "readProductionSixStepArtifactMaterialV1", "readProductionSixStepWitnessV1"]],
    ["packages/runtime-release-authority/src/internal/six-step-production-owner.ts", "packages/checkpoint/src/index.ts", "../../../checkpoint/src/index.ts", []],
    ["packages/runtime-release-authority/src/internal/six-step-production-owner.ts", "packages/checkpoint/src/internal/six-step-artifact-port-owner.ts", "../../../checkpoint/src/internal/six-step-artifact-port-owner.ts", ["issueCheckpointSixStepArtifactPortV1"]],
    ["packages/runtime-release-authority/src/internal/six-step-production-owner.ts", "packages/search-pipeline/src/index.ts", "../../../search-pipeline/src/index.ts", []],
    ["packages/runtime-release-authority/src/internal/six-step-production-owner.ts", "packages/search-pipeline/src/internal/six-step-tail-port-owner.ts", "../../../search-pipeline/src/internal/six-step-tail-port-owner.ts", ["issueProductionSixStepTailEmissionPortV1"]],
    ["packages/runtime-release-authority/src/internal/six-step-production-owner.ts", "packages/startup-runtime/src/internal/six-step-route-parent-owner.ts", "../../../startup-runtime/src/internal/six-step-route-parent-owner.ts", ["issueStartupSixStepRouteParentInvocationV1", "readStartupSixStepRouteParentInvocationMaterialV1"]],
    ["packages/runtime-release-authority/src/six-step-production-consumer.ts", "packages/runtime-release-authority/src/internal/six-step-production-owner.ts", "./internal/six-step-production-owner.ts", ["readRuntimeReleaseSixStepTailEmissionPortV1"]],
    ["packages/runtime-release-authority/src/six-step-production-consumer.ts", "packages/runtime-release-authority/src/internal/strategy-runtime-owner.ts", "./internal/strategy-runtime-owner.ts", ["assertIssuedRuntimeReleaseStrategyRuntimeService"]],
    ["packages/runtime-release-authority/src/six-step-terminal-consumer.ts", "packages/runtime-release-authority/src/internal/six-step-terminal-owner.ts", "./internal/six-step-terminal-owner.ts", ["assertIssuedRuntimeReleaseSixStepTerminalBindingServiceV1", "readRuntimeReleaseSixStepTerminalArtifactCapabilitiesV1", "readRuntimeReleaseSixStepTerminalBindingCapabilityV1"]],
    ["packages/runtime-release-authority/src/internal/six-step-terminal-owner.ts", "packages/runtime-release-authority/src/internal/state.ts", "./state.ts", ["assertActiveRuntimeReleaseAuthorityState"]],
    ["packages/runtime-release-authority/src/internal/six-step-terminal-owner.ts", "packages/search-pipeline/src/index.ts", "../../../../packages/search-pipeline/src/index.ts", ["readIssuedSearchTerminalCapabilityV1", "readIssuedSearchTerminalSixStepArtifactCapabilitiesV1", "readIssuedSearchTerminalSixStepTraceV1", "searchTerminalEvidenceHashV2"]],
    ["packages/runtime-release-authority/src/internal/six-step-terminal-owner.ts", "packages/runtime-release-authority/src/internal/strategy-runtime-owner.ts", "./strategy-runtime-owner.ts", ["assertIssuedRuntimeReleaseStrategyRuntimeService"]],
  ] as const;
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: path.startsWith("acceptance/") ? "acceptance-collector" : "central",
  });
  const source = (names: readonly string[], specifier: string) => names.length === 0
    ? `import type { OpaqueAuthorityType } from "${specifier}";\n`
    : `import { ${names.join(", ")} } from "${specifier}";\n`;
  try {
    for (const [from, to, specifier, names] of cases) {
      const edge: GraphEdge = { from, to, specifier };
      const actualDiagnostics: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries([file(from), file(to)], [edge], actualDiagnostics, repositoryRoot);
      assert.deepEqual(actualDiagnostics, [], `${from} must retain its exact current authority import`);

      mkdirSync(join(root, dirname(from)), { recursive: true });
      const inspect = (text: string, candidate: GraphEdge = edge, candidateEdges: readonly GraphEdge[] = [candidate]) => {
        writeFileSync(join(root, from), text);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries([file(from), file(to)], candidateEdges, diagnostics, root);
        return diagnostics;
      };
      assert.deepEqual(inspect(source(names, specifier)), []);
      assert.ok(inspect(source([...names, "unregisteredAuthorityExport"], specifier))
        .some(item => item.code === "authority-named-import-mismatch"));
      const alternate = `${specifier}?alternate`;
      assert.ok(inspect(source(names, alternate), { ...edge, specifier: alternate })
        .some(item => item.code === "authority-module-specifier-mismatch"));
      assert.ok(inspect("export {};\n", edge, [])
        .some(item => item.code === "authority-consumer-edge-missing"));
    }

    for (const [from, to, specifier, names] of cases.filter(([, target]) => target.includes("/src/internal/"))) {
      const sibling = from.replace(/\.ts$/, "-broad-sibling.ts");
      mkdirSync(join(root, dirname(sibling)), { recursive: true });
      writeFileSync(join(root, sibling), source(names, specifier));
      const diagnostics: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries(
        [file(sibling), file(to)],
        [{ from: sibling, to, specifier }],
        diagnostics,
        root,
      );
      assert.ok(diagnostics.some(item => item.code === "central-imports-authority-constructor"
        || item.code === "collector-imports-authority-constructor"), `${sibling} must not inherit ${from}'s owner edge`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("full-Graph coarse sweep crosses only the exact owner-issued capability edges", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-full-graph-coarse-sweep-owner-"));
  const cases = [
    {
      importerPath: "packages/family-composition/src/index.ts",
      targetPath: "packages/coarse-economics/src/internal/full-graph-sweep-owner.ts",
      specifier: "../../coarse-economics/src/internal/full-graph-sweep-owner.ts",
      allowed: "readIssuedCoarseEdgeSweepBindingV1",
    },
    {
      importerPath: "packages/full-graph-coarse-sweep/src/internal/sweep-owner.ts",
      targetPath: "packages/coarse-economics/src/internal/full-graph-sweep-owner.ts",
      specifier: "../../../coarse-economics/src/internal/full-graph-sweep-owner.ts",
      allowed: "issueCoarseEdgeSweepBindingV1",
    },
    {
      importerPath: "packages/full-graph-coarse-sweep/src/internal/invocation-owner.ts",
      targetPath: "packages/full-graph-coarse-sweep/src/internal/source-read-owner.ts",
      specifier: "./source-read-owner.ts",
      allowed: "consumeFullGraphCoarseSweepSourceReadCapabilityV1, readFullGraphCoarseSweepSourceReadCapabilityV1",
    },
    {
      importerPath: "apps/searcher-runtime/src/internal/reth-source.ts",
      targetPath: "packages/full-graph-coarse-sweep/src/internal/source-read-owner.ts",
      specifier: "../../../../packages/full-graph-coarse-sweep/src/internal/source-read-owner.ts",
      allowed: "issueFullGraphCoarseSweepSourceReadCapabilityV1",
    },
    {
      importerPath: "apps/searcher-runtime/src/internal/application-owner.ts",
      targetPath: "packages/full-graph-coarse-sweep/src/internal/invocation-owner.ts",
      specifier: "../../../../packages/full-graph-coarse-sweep/src/internal/invocation-owner.ts",
      allowed: "issueFullGraphCoarseSweepInvocationCapabilityV1",
    },
    {
      importerPath: "packages/runtime-release-authority/src/internal/full-graph-coarse-sweep-owner.ts",
      targetPath: "packages/full-graph-coarse-sweep/src/internal/sweep-owner.ts",
      specifier: "../../../full-graph-coarse-sweep/src/internal/sweep-owner.ts",
      allowed: "issueFullGraphCoarseSweepCapabilityV1, readIssuedFullGraphCoarseSweepEntryChunkV1, readIssuedFullGraphCoarseSweepManifestV1",
    },
    {
      importerPath: "packages/runtime-release-authority/src/full-graph-coarse-sweep-consumer.ts",
      targetPath: "packages/runtime-release-authority/src/internal/full-graph-coarse-sweep-owner.ts",
      specifier: "./internal/full-graph-coarse-sweep-owner.ts",
      allowed: "assertIssuedRuntimeReleaseFullGraphCoarseSweepServiceV1, readRuntimeReleaseFullGraphCoarseSweepEntryChunkCapabilityV1, readRuntimeReleaseFullGraphCoarseSweepManifestCapabilityV1",
    },
    {
      importerPath: "packages/runtime-release-authority/src/internal/bootstrap.ts",
      targetPath: "packages/runtime-release-authority/src/internal/full-graph-coarse-sweep-owner.ts",
      specifier: "./full-graph-coarse-sweep-owner.ts",
      allowed: "issueRuntimeReleaseFullGraphCoarseSweepServiceV1",
    },
    {
      importerPath: "packages/runtime-release-authority/src/internal/full-graph-coarse-sweep-owner.ts",
      targetPath: "packages/runtime-release-authority/src/internal/state.ts",
      specifier: "./state.ts",
      allowed: "assertActiveRuntimeReleaseAuthorityState",
    },
    {
      importerPath: "apps/searcher-runtime/src/internal/application-owner.ts",
      targetPath: "packages/runtime-release-authority/src/full-graph-coarse-sweep-consumer.ts",
      specifier: "../../../../packages/runtime-release-authority/src/full-graph-coarse-sweep-consumer.ts",
      allowed: "assertIssuedRuntimeReleaseFullGraphCoarseSweepServiceV1",
    },
  ] as const;
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: path.startsWith("apps/") ? "production-runtime" : "central",
  });
  try {
    for (const value of cases) {
      mkdirSync(join(root, dirname(value.importerPath)), { recursive: true });
      const edge: GraphEdge = { from: value.importerPath, to: value.targetPath, specifier: value.specifier };
      const inspect = (source: string, edges: readonly GraphEdge[] = [edge]) => {
        writeFileSync(join(root, value.importerPath), source);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries([file(value.importerPath), file(value.targetPath)], edges, diagnostics, root);
        return diagnostics;
      };
      const exact = `import { ${value.allowed} } from "${value.specifier}";\n`;
      assert.deepEqual(inspect(exact), []);
      assert.ok(inspect("export {};\n", []).some(item => item.code === "authority-consumer-edge-missing"));
      assert.ok(inspect(`import { extra } from "${value.specifier}";\n`).some(item => item.code === "authority-named-import-mismatch"));
      const alternate = `${value.specifier}?alternate`;
      assert.ok(inspect(exact.replace(value.specifier, alternate), [{ ...edge, specifier: alternate }])
        .some(item => item.code === "authority-module-specifier-mismatch"));
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

    const workPlaneCallerCases = [
      {
        ownerPath: "packages/work-plane/src/index.ts",
        authorityPath: "packages/work-plane/src/internal/caller-authority-state.ts",
        specifier: "./internal/caller-authority-state.ts",
        allowed: ["readWorkPlaneCallerCapability", "workPlaneCallerIntentBindingHash"],
        forbidden: "registerWorkPlaneCallerCapability",
      },
      {
        ownerPath: "packages/work-plane/src/internal/caller-authority-owner.ts",
        authorityPath: "packages/work-plane/src/internal/caller-authority-state.ts",
        specifier: "./caller-authority-state.ts",
        allowed: ["registerWorkPlaneCallerCapability", "workPlaneCallerIntentBindingHash"],
        forbidden: "readWorkPlaneCallerCapability",
      },
      {
        ownerPath: "packages/work-plane/src/internal/caller-authority-owner.ts",
        authorityPath: "packages/scheduler/src/internal/shared-runtime-owner.ts",
        specifier: "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts",
        allowed: ["readQualifiedSharedSchedulerRuntimePort"],
        forbidden: "issueQualifiedSharedSchedulerRuntimePort",
      },
    ] as const;
    for (const value of workPlaneCallerCases) {
      const edge: GraphEdge = {
        from: value.ownerPath,
        to: value.authorityPath,
        specifier: value.specifier,
      };
      mkdirSync(join(root, dirname(value.ownerPath)), { recursive: true });
      const inspect = (source: string, checkedEdge: GraphEdge = edge): readonly BoundaryDiagnostic[] => {
        writeFileSync(join(root, value.ownerPath), source);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries([file(value.ownerPath), file(value.authorityPath)], [checkedEdge], diagnostics, root);
        return diagnostics;
      };
      assert.deepEqual(inspect(`import { ${value.allowed.join(", ")} } from "${value.specifier}";\n`), []);
      for (const source of [
        `import { ${value.forbidden} } from "${value.specifier}";\n`,
        `import * as authority from "${value.specifier}";\n`,
        `import { ${value.allowed.join(", ")}, extra } from "${value.specifier}";\n`,
      ]) {
        assert.ok(
          inspect(source).some(item => item.code === "authority-named-import-mismatch"),
          `${value.ownerPath} accepted non-exact caller authority import: ${source}`,
        );
      }
      const alternate = `${value.specifier}?alternate`;
      assert.ok(inspect(
        `import { ${value.allowed.join(", ")} } from "${alternate}";\n`,
        { ...edge, specifier: alternate },
      ).some(item => item.code === "authority-module-specifier-mismatch"));
    }

    const callerOwnerImposter = "packages/other-runtime/src/index.ts";
    const callerOwnerPath = "packages/work-plane/src/internal/caller-authority-owner.ts";
    const callerOwnerSpecifier = "../../work-plane/src/internal/caller-authority-owner.ts";
    mkdirSync(join(root, dirname(callerOwnerImposter)), { recursive: true });
    writeFileSync(join(root, callerOwnerImposter), `import { issueWorkPlaneCallerCapability } from "${callerOwnerSpecifier}";\n`);
    const callerOwnerDiagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(callerOwnerImposter), file(callerOwnerPath)],
      [{ from: callerOwnerImposter, to: callerOwnerPath, specifier: callerOwnerSpecifier }],
      callerOwnerDiagnostics,
      root,
    );
    assert.ok(callerOwnerDiagnostics.some(item => item.code === "central-imports-authority-constructor"));

    const callerFixturePath = "packages/work-plane/test/fixtures/caller-authority.ts";
    const callerFixtureSpecifier = "../../work-plane/test/fixtures/caller-authority.ts";
    writeFileSync(join(root, callerOwnerImposter), `import { issueTestWorkPlaneCallerCapability } from "${callerFixtureSpecifier}";\n`);
    const callerFixtureDiagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(callerOwnerImposter), file(callerFixturePath)],
      [{ from: callerOwnerImposter, to: callerFixturePath, specifier: callerFixtureSpecifier }],
      callerFixtureDiagnostics,
      root,
    );
    assert.ok(callerFixtureDiagnostics.some(item => item.code === "production-imports-test-fixture"));

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

test("source and shared-scheduler owner graph binds exact required consumer edges", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-source-owner-graph-"));
  const cases = [
    {
      ownerPath: "packages/runtime-release-authority/src/internal/bootstrap.ts",
      authorityPath: "packages/scheduler/src/internal/shared-runtime-owner.ts",
      specifier: "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts",
      allowed: "readQualifiedSharedSchedulerRuntimePort",
      forbidden: "issueQualifiedSharedSchedulerRuntimePort",
    },
    {
      ownerPath: "packages/runtime-release-authority/src/internal/bootstrap.ts",
      authorityPath: "packages/runtime-release-authority/src/internal/discovery-source-authority-owner.ts",
      specifier: "./discovery-source-authority-owner.ts",
      allowed: "readRuntimeReleaseQualifiedDiscoverySourcePort",
      forbidden: "issueRuntimeReleaseQualifiedDiscoverySourcePort",
    },
    {
      ownerPath: "packages/runtime-release-authority/src/internal/discovery-owner.ts",
      authorityPath: "packages/runtime-release-authority/src/internal/discovery-source-authority-owner.ts",
      specifier: "./discovery-source-authority-owner.ts",
      allowed: "assertRuntimeReleaseQualifiedDiscoverySourceState",
      forbidden: "issueRuntimeReleaseQualifiedDiscoverySourcePort",
    },
    {
      ownerPath: "packages/runtime-release-authority/src/internal/discovery-source-authority-owner.ts",
      authorityPath: "packages/runtime-release-authority/src/internal/state.ts",
      specifier: "./state.ts",
      allowed: "assertActiveRuntimeReleaseAuthorityState",
      forbidden: "registerRuntimeReleaseAuthority",
    },
    {
      ownerPath: "packages/work-plane/src/internal/family-execution-port.ts",
      authorityPath: "packages/scheduler/src/internal/shared-runtime-owner.ts",
      specifier: "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts",
      allowed: "readQualifiedSharedSchedulerRuntimePort",
      forbidden: "issueQualifiedSharedSchedulerRuntimePort",
    },
    {
      ownerPath: "packages/scheduler/src/internal/shared-runtime-owner.ts",
      authorityPath: "packages/scheduler/src/internal/authority-consumer.ts",
      specifier: "./authority-consumer.ts",
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
      const inspect = (source: string, edges: readonly GraphEdge[] = [edge]): readonly BoundaryDiagnostic[] => {
        writeFileSync(join(root, value.ownerPath), source);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries([file(value.ownerPath), file(value.authorityPath)], edges, diagnostics, root);
        return diagnostics;
      };
      const exact = `import { ${value.allowed} } from "${value.specifier}";\n`;
      assert.deepEqual(inspect(exact), []);
      assert.ok(inspect(exact, []).some(item => item.code === "authority-consumer-edge-missing"));
      const alternateSpecifier = `${value.specifier}?alternate`;
      assert.ok(inspect(
        `import { ${value.allowed} } from "${alternateSpecifier}";\n`,
        [{ ...edge, specifier: alternateSpecifier }],
      ).some(item => item.code === "authority-module-specifier-mismatch"));
      for (const source of [
        `import { ${value.forbidden} } from "${value.specifier}";\n`,
        `import { ${value.allowed} as owner } from "${value.specifier}";\n`,
        `import * as owner from "${value.specifier}";\n`,
        `import { ${value.allowed}, extra } from "${value.specifier}";\n`,
      ]) {
        assert.ok(inspect(source).some(item => item.code === "authority-named-import-mismatch"));
      }

      const wrongImporter = "packages/ordinary/src/index.ts";
      mkdirSync(join(root, dirname(wrongImporter)), { recursive: true });
      writeFileSync(join(root, wrongImporter), exact);
      const diagnostics: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries(
        [file(wrongImporter), file(value.authorityPath)],
        [{ ...edge, from: wrongImporter }],
        diagnostics,
        root,
      );
      assert.ok(diagnostics.some(item => item.code === "central-imports-authority-constructor"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("search pipeline crosses the coarse owner boundary through one exact import surface", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-coarse-search-owner-"));
  const routePath = "packages/search-pipeline/src/route-pipeline.ts";
  const ownerPath = "packages/coarse-economics/src/internal/search-owner.ts";
  const specifier = "../../coarse-economics/src/internal/search-owner.ts";
  const expectedNames = ["issueCoarseEnumerationBindingV1", "issueCoarseRouteBindingV1"] as const;
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: "central",
  });
  mkdirSync(join(root, dirname(routePath)), { recursive: true });
  const inspect = (source: string, edges: readonly GraphEdge[]): readonly BoundaryDiagnostic[] => {
    writeFileSync(join(root, routePath), source);
    const diagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries([file(routePath), file(ownerPath)], edges, diagnostics, root);
    return diagnostics;
  };
  const exactSource = `import { ${expectedNames.join(", ")} } from "${specifier}";\n`;
  const exactEdge: GraphEdge = { from: routePath, to: ownerPath, specifier };
  try {
    assert.deepEqual(inspect(exactSource, [exactEdge]), []);
    assert.ok(inspect("export {};\n", []).some(item => item.code === "authority-consumer-edge-missing"));

    const alternateSpecifier = `${specifier}?alternate`;
    assert.ok(inspect(
      exactSource.replace(specifier, alternateSpecifier),
      [{ ...exactEdge, specifier: alternateSpecifier }],
    ).some(item => item.code === "authority-module-specifier-mismatch"));

    for (const source of [
      `import { ${expectedNames[0]} } from "${specifier}";\n`,
      `import { ${expectedNames.join(", ")}, extra } from "${specifier}";\n`,
      `import { ${expectedNames[0]} as issue, ${expectedNames[1]} } from "${specifier}";\n`,
      `import * as coarseOwner from "${specifier}";\n`,
      `import coarseOwner, { ${expectedNames.join(", ")} } from "${specifier}";\n`,
    ]) {
      assert.ok(inspect(source, [exactEdge]).some(item => item.code === "authority-named-import-mismatch"));
    }

    const splitExactSource = [
      `import { ${expectedNames[0]} } from "${specifier}";`,
      `import { ${expectedNames[1]} } from "${specifier}";`,
    ].join("\n");
    assert.deepEqual(inspect(splitExactSource, [exactEdge]), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Strategy composition runtime authority has only its two exact owner seams", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-strategy-composition-owner-"));
  const authorityPath = "packages/strategy-composition/src/internal/runtime-composition-authority.ts";
  const cases = [
    {
      importerPath: "packages/strategy-composition/src/index.ts",
      specifier: "./internal/runtime-composition-authority.ts",
      name: "readGeneratedStrategyRuntimeCompositionCapability",
    },
    {
      importerPath: "packages/strategy-composition/src/internal/generated-runtime-composition.ts",
      specifier: "./runtime-composition-authority.ts",
      name: "issueGeneratedStrategyRuntimeCompositionCapability",
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
      mkdirSync(join(root, dirname(value.importerPath)), { recursive: true });
      const exactEdge: GraphEdge = {
        from: value.importerPath,
        to: authorityPath,
        specifier: value.specifier,
      };
      const inspect = (source: string, edges: readonly GraphEdge[]): readonly BoundaryDiagnostic[] => {
        writeFileSync(join(root, value.importerPath), source);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries([file(value.importerPath), file(authorityPath)], edges, diagnostics, root);
        return diagnostics;
      };
      const exactSource = `import { ${value.name} } from "${value.specifier}";\n`;
      assert.deepEqual(inspect(exactSource, [exactEdge]), []);
      assert.ok(inspect("export {};\n", []).some(item => item.code === "authority-consumer-edge-missing"));

      const alternateSpecifier = `${value.specifier}?alternate`;
      assert.ok(inspect(
        exactSource.replace(value.specifier, alternateSpecifier),
        [{ ...exactEdge, specifier: alternateSpecifier }],
      ).some(item => item.code === "authority-module-specifier-mismatch"));

      for (const source of [
        `import { ${value.name} as authority } from "${value.specifier}";\n`,
        `import * as authority from "${value.specifier}";\n`,
        `import authority, { ${value.name} } from "${value.specifier}";\n`,
        `import { ${value.name}, extra } from "${value.specifier}";\n`,
      ]) {
        assert.ok(inspect(source, [exactEdge]).some(item => item.code === "authority-named-import-mismatch"));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime-release strategy owner is the sole exact planning-trigger issuer", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-release-strategy-trigger-owner-"));
  const importerPath = "packages/runtime-release-authority/src/internal/strategy-runtime-owner.ts";
  const ownerPath = "packages/strategy-composition/src/internal/trigger-owner.ts";
  const specifier = "../../../../packages/strategy-composition/src/internal/trigger-owner.ts";
  const name = "issueStrategyPlanningTriggerCapabilityV1";
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: "central",
  });
  mkdirSync(join(root, dirname(importerPath)), { recursive: true });
  const exactEdge: GraphEdge = { from: importerPath, to: ownerPath, specifier };
  const inspect = (source: string, edges: readonly GraphEdge[]): readonly BoundaryDiagnostic[] => {
    writeFileSync(join(root, importerPath), source);
    const diagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries([file(importerPath), file(ownerPath)], edges, diagnostics, root);
    return diagnostics;
  };
  const exactSource = `import { ${name} } from "${specifier}";\n`;
  try {
    assert.deepEqual(inspect(exactSource, [exactEdge]), []);
    assert.ok(inspect("export {};\n", []).some(item => item.code === "authority-consumer-edge-missing"));

    const alternateSpecifier = `${specifier}?alternate`;
    assert.ok(inspect(
      exactSource.replace(specifier, alternateSpecifier),
      [{ ...exactEdge, specifier: alternateSpecifier }],
    ).some(item => item.code === "authority-module-specifier-mismatch"));

    for (const source of [
      `import { ${name} as issueTrigger } from "${specifier}";\n`,
      `import * as triggerOwner from "${specifier}";\n`,
      `import triggerOwner, { ${name} } from "${specifier}";\n`,
      `import { ${name}, extra } from "${specifier}";\n`,
    ]) {
      assert.ok(inspect(source, [exactEdge]).some(item => item.code === "authority-named-import-mismatch"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coarse-attempt evidence crosses only the three exact owner/state edges", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-coarse-attempt-evidence-owner-"));
  const cases = [
    {
      from: "packages/search-pipeline/src/route-pipeline.ts",
      to: "packages/search-pipeline/src/internal/coarse-attempt-evidence-state.ts",
      specifier: "./internal/coarse-attempt-evidence-state.ts",
      name: "routeCoarseAttemptEvidenceReaderV1",
    },
    {
      from: "packages/search-pipeline/src/internal/coarse-attempt-evidence-owner.ts",
      to: "packages/search-pipeline/src/internal/coarse-attempt-evidence-state.ts",
      specifier: "./coarse-attempt-evidence-state.ts",
      name: "registerRouteCoarseAttemptEvidenceAuthorityV1",
    },
    {
      from: "packages/search-runtime-core/src/index.ts",
      to: "packages/search-pipeline/src/internal/coarse-attempt-evidence-owner.ts",
      specifier: "../../search-pipeline/src/internal/coarse-attempt-evidence-owner.ts",
      name: "createRouteCoarseAttemptEvidenceOwnerV1",
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
  const inspect = (
    item: (typeof cases)[number],
    source: string,
    edge: GraphEdge | null = { from: item.from, to: item.to, specifier: item.specifier },
  ): readonly BoundaryDiagnostic[] => {
    mkdirSync(join(root, dirname(item.from)), { recursive: true });
    writeFileSync(join(root, item.from), source);
    const diagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(item.from), file(item.to)],
      edge === null ? [] : [edge],
      diagnostics,
      root,
    );
    return diagnostics;
  };
  try {
    for (const item of cases) {
      const exact = `import { ${item.name} } from "${item.specifier}";\n`;
      assert.deepEqual(inspect(item, exact), []);
      assert.ok(inspect(item, "export {};\n", null).some(diagnostic => diagnostic.code === "authority-consumer-edge-missing"));
      assert.ok(inspect(
        item,
        exact.replace(item.specifier, `${item.specifier}?alternate`),
        { from: item.from, to: item.to, specifier: `${item.specifier}?alternate` },
      ).some(diagnostic => diagnostic.code === "authority-module-specifier-mismatch"));
      assert.ok(inspect(
        item,
        `import { ${item.name} as alternate } from "${item.specifier}";\n`,
      ).some(diagnostic => diagnostic.code === "authority-named-import-mismatch"));
      assert.ok(inspect(
        item,
        `import { ${item.name}, extra } from "${item.specifier}";\n`,
      ).some(diagnostic => diagnostic.code === "authority-named-import-mismatch"));
    }

    const imposter = "packages/other-runtime/src/index.ts";
    const owner = cases[2]!;
    mkdirSync(join(root, dirname(imposter)), { recursive: true });
    writeFileSync(join(root, imposter), `import { ${owner.name} } from "${owner.specifier}";\n`);
    const diagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(imposter), file(owner.to)],
      [{ from: imposter, to: owner.to, specifier: owner.specifier }],
      diagnostics,
      root,
    );
    assert.ok(diagnostics.some(diagnostic => diagnostic.code === "central-imports-authority-constructor"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mixed scheduler public roots distinguish neutral runtime imports from authority constructors", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-mixed-scheduler-root-"));
  const ownerPath = "packages/state-runtime/src/index.ts";
  const schedulerPath = "packages/scheduler/src/index.ts";
  const specifier = "../../../scheduler/src/index.ts";
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
    mkdirSync(join(root, dirname(ownerPath)), { recursive: true });
    const inspect = (source: string): readonly BoundaryDiagnostic[] => {
      writeFileSync(join(root, ownerPath), source);
      const diagnostics: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries([file(ownerPath), file(schedulerPath)], [{ from: ownerPath, to: schedulerPath, specifier }], diagnostics, root);
      return diagnostics;
    };
    assert.deepEqual(inspect(`import { WorkScheduler, monotonicNow, type CallerAuthority } from "${specifier}";\n`), []);
    assert.deepEqual(inspect(`import type { QualifiedExecutorAuthorityIssuer } from "${specifier}";\n`), []);
    assert.ok(inspect(`import { createQualifiedExecutorRegistry } from "${specifier}";\n`).some((item) => item.code === "central-imports-authority-constructor"));
    assert.ok(inspect(`import * as scheduler from "${specifier}";\n`).some((item) => item.code === "central-imports-authority-constructor"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("current runtime authority consumers exact-bind value and type projections", () => {
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "aloha-current-authority-consumers-"));
  const cases = [
    ["acceptance/collectors/src/full-family-observer.ts", "acceptance/collectors/src/internal/terminal-phase-snapshot-trust-state.ts", "./internal/terminal-phase-snapshot-trust-state.ts"],
    ["acceptance/collectors/src/material-providers/runtime-boundaries.ts", "acceptance/collectors/src/internal/runtime-boundary-material-owner.ts", "../internal/runtime-boundary-material-owner.ts"],
    ["acceptance/collectors/src/production-predicate-material-source.ts", "acceptance/collectors/src/internal/performance-material-observer-owner.ts", "./internal/performance-material-observer-owner.ts"],
    ["acceptance/collectors/src/production-predicate-material-source.ts", "acceptance/collectors/src/internal/runtime-boundary-material-owner.ts", "./internal/runtime-boundary-material-owner.ts"],
    ["acceptance/collectors/src/production-predicate-material-source.ts", "acceptance/collectors/src/internal/terminal-selection-material-owner.ts", "./internal/terminal-selection-material-owner.ts"],
    ["acceptance/collectors/src/terminal-phase-locator-index.ts", "acceptance/collectors/src/internal/terminal-phase-snapshot-trust-state.ts", "./internal/terminal-phase-snapshot-trust-state.ts"],
    ["apps/searcher-runtime/src/deployment.ts", "apps/searcher-runtime/src/internal/application-owner.ts", "./internal/application-owner.ts"],
    ["apps/searcher-runtime/src/deployment.ts", "packages/runtime-release-authority/src/internal/deployment-runtime-owner.ts", "../../../packages/runtime-release-authority/src/internal/deployment-runtime-owner.ts"],
    ["apps/searcher-runtime/src/index.ts", "apps/searcher-runtime/src/internal/reth-source.ts", "./internal/reth-source.ts"],
    ["apps/searcher-runtime/src/internal/application-owner.ts", "apps/searcher-runtime/src/internal/reth-source.ts", "./reth-source.ts"],
    ["packages/checkpoint/src/index.ts", "packages/checkpoint/src/internal/six-step-artifact-port-owner.ts", "./internal/six-step-artifact-port-owner.ts"],
    ["packages/coarse-economics/src/index.ts", "packages/coarse-economics/src/internal/state.ts", "./internal/state.ts"],
    ["packages/coarse-economics/src/internal/owner.ts", "packages/coarse-economics/src/internal/qualification-owner.ts", "./qualification-owner.ts"],
    ["packages/economics-safety/src/index.ts", "packages/economics-safety/src/internal/state.ts", "./internal/state.ts"],
    ["packages/final-durable-window/src/index.ts", "packages/final-durable-window/src/internal/owner.ts", "./internal/owner.ts"],
    ["packages/producer/src/internal/owners.ts", "packages/producer/src/internal/source-brand.ts", "./source-brand.ts"],
    ["packages/runtime-release-authority/src/internal/candidate-partition-proof-owner.ts", "packages/runtime-release-authority/src/internal/nomination-qualification-owner.ts", "./nomination-qualification-owner.ts"],
    ["packages/runtime-release-authority/src/internal/deployment-composition-owner.ts", "packages/scheduler/src/internal/authority-consumer.ts", "../../../../packages/scheduler/src/internal/authority-consumer.ts"],
    ["packages/runtime-release-authority/src/internal/deployment-composition-owner.ts", "packages/scheduler/src/internal/shared-runtime-owner.ts", "../../../../packages/scheduler/src/internal/shared-runtime-owner.ts"],
    ["packages/runtime-release-authority/src/internal/deployment-composition-owner.ts", "runtime/revm-workers/src/internal/authority.ts", "../../../../runtime/revm-workers/src/internal/authority.ts"],
    ["packages/runtime-release-authority/src/internal/economic-safety-owner.ts", "packages/family-composition/src/internal/generated-runtime-composition.ts", "../../../family-composition/src/internal/generated-runtime-composition.ts"],
    ["packages/runtime-release-authority/src/internal/economic-safety-owner.ts", "packages/runtime-release-authority/src/internal/state.ts", "./state.ts"],
    ["packages/runtime-release-authority/src/internal/full-family-terminal-owner.ts", "packages/family-composition/src/internal/generated-runtime-composition.ts", "../../../family-composition/src/internal/generated-runtime-composition.ts"],
    ["packages/runtime-release-authority/src/internal/nomination-qualification-owner.ts", "packages/family-composition/src/internal/generated-runtime-composition.ts", "../../../../packages/family-composition/src/internal/generated-runtime-composition.ts"],
    ["packages/runtime-release-authority/src/internal/nomination-qualification-owner.ts", "packages/runtime-release-authority/src/internal/state.ts", "./state.ts"],
    ["packages/runtime-release-authority/src/internal/observer-store-owner.ts", "packages/runtime-release-authority/src/internal/state.ts", "./state.ts"],
    ["packages/runtime-release-authority/src/internal/performance-deployment-owner.ts", "packages/runtime-release-authority/src/internal/state.ts", "./state.ts"],
    ["packages/runtime-release-authority/src/internal/performance-policy-owner.ts", "packages/runtime-release-authority/src/internal/discovery-source-authority-owner.ts", "./discovery-source-authority-owner.ts"],
    ["packages/runtime-release-authority/src/internal/performance-policy-owner.ts", "packages/runtime-release-authority/src/internal/performance-deployment-owner.ts", "./performance-deployment-owner.ts"],
    ["packages/runtime-release-authority/src/internal/performance-policy-owner.ts", "packages/runtime-release-authority/src/internal/state.ts", "./state.ts"],
    ["packages/runtime-release-authority/src/internal/performance-runtime-owner.ts", "packages/runtime-release-authority/src/internal/performance-policy-owner.ts", "./performance-policy-owner.ts"],
    ["packages/runtime-release-authority/src/internal/six-step-terminal-owner.ts", "packages/runtime-release-authority/src/internal/economic-safety-owner.ts", "./economic-safety-owner.ts"],
    ["packages/search-pipeline/src/index.ts", "packages/search-pipeline/src/internal/six-step-tail-port-owner.ts", "./internal/six-step-tail-port-owner.ts"],
    ["packages/search-pipeline/src/route-pipeline.ts", "packages/search-pipeline/src/internal/scheduler-resource-join.ts", "./internal/scheduler-resource-join.ts"],
  ] as const;
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: path.startsWith("acceptance/collectors/")
      ? "acceptance-collector"
      : path.startsWith("apps/") || path.startsWith("runtime/")
        ? "production-runtime"
        : "central",
  });
  try {
    for (const [from, to, specifier] of cases) {
      const edge: GraphEdge = { from, to, specifier };
      const source = readFileSync(join(repositoryRoot, from), "utf8");
      const actual: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries([file(from), file(to)], [edge], actual, repositoryRoot);
      assert.deepEqual(actual, [], `${from} must retain its exact owner-issued projection from ${to}`);

      mkdirSync(join(root, dirname(from)), { recursive: true });
      const inspect = (text: string, candidate: GraphEdge = edge) => {
        writeFileSync(join(root, from), text);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries([file(from), file(to)], [candidate], diagnostics, root);
        return diagnostics;
      };
      assert.ok(inspect(`${source}\nimport { unregisteredAuthorityValue } from "${specifier}";\n`)
        .some(item => item.code === "narrow-port-import-mismatch"));
      assert.ok(inspect(`${source}\nimport type { UnregisteredAuthorityType } from "${specifier}";\n`)
        .some(item => item.code === "narrow-port-import-mismatch"));
      const alternate = `${specifier}?alternate`;
      assert.ok(inspect(source.replaceAll(specifier, alternate), { ...edge, specifier: alternate })
        .some(item => item.code === "authority-module-specifier-mismatch"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production advisory owner ignores type-only contracts but rejects runtime access", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-production-advisory-type-only-"));
  const from = "packages/runtime-release-authority/src/internal/six-step-production-owner.ts";
  const to = "packages/runtime-release-authority/src/internal/observer-store-owner.ts";
  const specifier = "./observer-store-owner.ts";
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
    mkdirSync(join(root, dirname(from)), { recursive: true });
    const inspect = (source: string): readonly BoundaryDiagnostic[] => {
      writeFileSync(join(root, from), source);
      const diagnostics: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries([file(from), file(to)], [{ from, to, specifier }], diagnostics, root);
      return diagnostics;
    };
    assert.deepEqual(inspect(`import type { RuntimeReleaseObserverSinkV1 } from "${specifier}";\n`), []);
    assert.ok(inspect(`import { RuntimeReleaseObserverSinkV1 } from "${specifier}";\n`)
      .some(item => item.code === "production-release-advisory-authority-owner"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("searcher production evidence consumes Strategy evidence through the public consumer seam", () => {
  const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const evidencePath = "apps/searcher-runtime/src/production-evidence.ts";
  const consumerPath = "packages/runtime-release-authority/src/strategy-runtime-consumer.ts";
  const internalPath = "packages/runtime-release-authority/src/internal/strategy-runtime-owner.ts";
  const publicSpecifier = "../../../packages/runtime-release-authority/src/strategy-runtime-consumer.ts";
  const internalSpecifier = "../../../packages/runtime-release-authority/src/internal/strategy-runtime-owner.ts";
  const evidenceSource = readFileSync(join(repositoryRoot, evidencePath), "utf8");
  const consumerSource = readFileSync(join(repositoryRoot, consumerPath), "utf8");
  assert.ok(evidenceSource.includes(publicSpecifier));
  assert.ok(!evidenceSource.includes(internalSpecifier));
  assert.match(consumerSource, /RuntimeReleaseStrategyEvidenceExpectationV1/);

  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: path.startsWith("apps/") ? "production-runtime" : "central",
  });
  const allowed: BoundaryDiagnostic[] = [];
  validateDependencyBoundaries(
    [file(evidencePath), file(consumerPath)],
    [{ from: evidencePath, to: consumerPath, specifier: publicSpecifier }],
    allowed,
    repositoryRoot,
  );
  assert.deepEqual(allowed, []);

  const root = mkdtempSync(join(tmpdir(), "aloha-strategy-evidence-consumer-"));
  try {
    mkdirSync(join(root, dirname(evidencePath)), { recursive: true });
    writeFileSync(join(root, evidencePath), `import { assertIssuedRuntimeReleaseStrategyRuntimeService, type RuntimeReleaseStrategyEvidenceExpectationV1 } from "${internalSpecifier}";\n`);
    const forbidden: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(
      [file(evidencePath), file(internalPath)],
      [{ from: evidencePath, to: internalPath, specifier: internalSpecifier }],
      forbidden,
      root,
    );
    assert.ok(forbidden.some(item => item.code === "runtime-imports-authority-constructor"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Attestation checkpoint and proof seams bind exact runtime imports", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-attestation-load-bearing-seams-"));
  const cases = [
    {
      from: "packages/checkpoint/src/index.ts",
      to: "packages/attestation/src/internal/validation-authority-verifier.ts",
      specifier: "../../attestation/src/internal/validation-authority-verifier.ts",
      names: ["assertAttestationValidationAuthority"],
      extra: "issueShadowValidationAuthority",
    },
    {
      from: "packages/checkpoint/src/index.ts",
      to: "packages/attestation/src/internal/validation-authority-rehydrator.ts",
      specifier: "../../attestation/src/internal/validation-authority-rehydrator.ts",
      names: [
        "rehydrateIdentityResumeCapabilityForCheckpoint",
        "rehydrateOutcomeResumeCapabilityForCheckpoint",
        "rehydrateVerifiedMemoReuseCapabilityForCheckpoint",
      ],
      extra: "rehydrateShadowCapabilityForCheckpoint",
    },
    {
      from: "packages/attestation/src/index.ts",
      to: "packages/attestation/src/internal/identity-proof.ts",
      specifier: "./internal/identity-proof.ts",
      names: ["validateIdentityIssuerProof"],
      extra: "issueIdentityIssuerProof",
    },
    {
      from: "packages/attestation/src/index.ts",
      to: "packages/attestation/src/internal/outcome-proof.ts",
      specifier: "./internal/outcome-proof.ts",
      names: ["validateOutcomeIssuerProof"],
      extra: "issueOutcomeIssuerProof",
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
    for (const item of cases) {
      mkdirSync(join(root, dirname(item.from)), { recursive: true });
      mkdirSync(join(root, dirname(item.to)), { recursive: true });
      writeFileSync(join(root, item.to), "export {};\n");
      const edge: GraphEdge = { from: item.from, to: item.to, specifier: item.specifier };
      const inspect = (source: string, value: GraphEdge = edge): readonly BoundaryDiagnostic[] => {
        writeFileSync(join(root, item.from), source);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries([file(item.from), file(item.to)], [value], diagnostics, root);
        return diagnostics;
      };
      const exact = `import { ${item.names.join(", ")} } from "${item.specifier}";\n`;
      assert.deepEqual(inspect(exact), []);
      assert.ok(inspect(
        `import { ${[...item.names, item.extra].join(", ")} } from "${item.specifier}";\n`,
      ).some(diagnostic => diagnostic.code === "authority-named-import-mismatch"));
      assert.ok(inspect(
        exact.replace(item.specifier, `${item.specifier}?alternate`),
        { ...edge, specifier: `${item.specifier}?alternate` },
      ).some(diagnostic => diagnostic.code === "authority-module-specifier-mismatch"));
    }
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

test("process resource observer has one exact read-only edge into REVM worker facts", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-process-resource-edge-"));
  const observerPath = "packages/process-resource-observer/src/index.ts";
  const workerPath = "runtime/revm-workers/src/internal/resource-observation.ts";
  const specifier = "../../../runtime/revm-workers/src/internal/resource-observation.ts";
  const file = (path: string, fileClass: TrackedFile["fileClass"]): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass,
  });
  const edge: GraphEdge = { from: observerPath, to: workerPath, specifier };
  mkdirSync(join(root, dirname(observerPath)), { recursive: true });
  try {
    const inspect = (source: string, fromPath = observerPath): readonly BoundaryDiagnostic[] => {
      mkdirSync(join(root, dirname(fromPath)), { recursive: true });
      writeFileSync(join(root, fromPath), source);
      const diagnostics: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries(
        [file(fromPath, "central"), file(workerPath, "production-runtime")],
        [{ ...edge, from: fromPath }],
        diagnostics,
        root,
      );
      return diagnostics;
    };
    const exact = [
      "import {",
      "  captureRevmWorkerResourceObservation,",
      "  readRevmWorkerResourceObservation,",
      "  type RevmWorkerResourceObservationFactV1,",
      "  type RevmWorkerResourceObservationPortV1,",
      `} from "${specifier}";`,
    ].join("\n");
    assert.deepEqual(inspect(exact), []);
    assert.ok(inspect(`import * as workerFacts from "${specifier}";\n`).some((item) => item.code === "authority-named-import-mismatch" || item.code === "narrow-port-import-mismatch"));
    assert.ok(inspect(exact.replace("type RevmWorkerResourceObservationFactV1", "RevmWorkerResourceObservationFactV1")).some((item) => item.code === "narrow-port-import-mismatch"));
    assert.ok(inspect(exact, "packages/ordinary-resource-reader.ts").some((item) => item.code === "central-imports-runtime"));
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

test("startup Stage 1/2 evidence crosses only the exact checkpoint reader consumer", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-stage12-reader-authority-"));
  const ownerPath = "packages/startup-runtime/src/internal/runtime-owner.ts";
  const consumerPath = "packages/checkpoint/src/internal/ready-stage12-evidence-consumer.ts";
  const specifier = "../../../checkpoint/src/internal/ready-stage12-evidence-consumer.ts";
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: "central",
  });
  mkdirSync(join(root, dirname(ownerPath)), { recursive: true });
  try {
    const inspect = (source: string, edges: readonly GraphEdge[]): readonly BoundaryDiagnostic[] => {
      writeFileSync(join(root, ownerPath), source);
      const diagnostics: BoundaryDiagnostic[] = [];
      validateDependencyBoundaries([file(ownerPath), file(consumerPath)], edges, diagnostics, root);
      return diagnostics;
    };
    const edge: GraphEdge = { from: ownerPath, to: consumerPath, specifier };
    assert.deepEqual(
      inspect(`import { assertCheckpointReadyStage12EvidenceReader } from "${specifier}";\n`, [edge]),
      [],
    );
    assert.ok(inspect(
      `import { assertCheckpointReadyStage12EvidenceReader as assertReader } from "${specifier}";\n`,
      [edge],
    ).some(item => item.code === "authority-named-import-mismatch"));
    assert.ok(inspect("export const structuralReader = {};\n", []).some(
      item => item.code === "authority-consumer-edge-missing",
    ));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native startup state machine admits only exact adapter named imports", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-native-startup-boundary-"));
  const targetPath = "packages/startup-runtime/src/internal/native-startup.ts";
  const signedPath = "packages/startup-runtime/src/internal/signed-release-native-startup-owner.ts";
  const unrelatedPath = "packages/startup-runtime/src/internal/unrelated-central.ts";
  const specifier = "./native-startup.ts";
  const runtimeExport = "runNativeStartupStateMachineForExactAdapter";
  const file = (path: string): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
    contentSha256: `0x${"a".repeat(64)}`,
    byteLength: 1,
    language: "typescript",
    fileClass: "central",
  });
  mkdirSync(join(root, dirname(signedPath)), { recursive: true });
  const inspect = (
    fromPath: string,
    source: string,
    edges: readonly GraphEdge[],
    files: readonly TrackedFile[] = [file(fromPath), file(targetPath)],
  ): readonly BoundaryDiagnostic[] => {
    mkdirSync(join(root, dirname(fromPath)), { recursive: true });
    writeFileSync(join(root, fromPath), source);
    const diagnostics: BoundaryDiagnostic[] = [];
    validateDependencyBoundaries(files, edges, diagnostics, root);
    return diagnostics;
  };
  const signedEdge: GraphEdge = { from: signedPath, to: targetPath, specifier };
  try {
    assert.deepEqual(inspect(
      signedPath,
      `import { ${runtimeExport}, type NativeStartupRuntimeV1 } from "${specifier}";\n`,
      [signedEdge],
    ), []);

    assert.ok(inspect(signedPath, "export {};\n", []).some(
      item => item.code === "authority-consumer-edge-missing",
    ));
    assert.ok(inspect(
      signedPath,
      `import { nativeStartupAuthoritiesEqual } from "${specifier}";\n`,
      [signedEdge],
    ).some(item => item.code === "authority-named-import-mismatch"));
    assert.ok(inspect(
      signedPath,
      `import { ${runtimeExport} as renamed } from "${specifier}";\n`,
      [signedEdge],
    ).some(item => item.code === "authority-named-import-mismatch"));

    const unrelatedEdge: GraphEdge = { from: unrelatedPath, to: targetPath, specifier };
    assert.ok(inspect(
      unrelatedPath,
      `import { ${runtimeExport} } from "${specifier}";\n`,
      [unrelatedEdge],
    ).some(item => item.code === "central-imports-authority-constructor"));

    assert.deepEqual(inspect(
      unrelatedPath,
      `import type { NativeStartupRuntimeV1 } from "${specifier}";\n`,
      [unrelatedEdge],
    ), []);

    // The future advisory adapter is reserved but absent, so it is not yet a
    // required edge in the current production denominator.
    assert.equal(inspect(
      signedPath,
      `import { ${runtimeExport} } from "${specifier}";\n`,
      [signedEdge],
    ).some(item => item.code === "authority-consumer-edge-missing"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native startup production adapter retains each exact owner edge", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-native-startup-owner-edges-"));
  const cases = [
    {
      from: "packages/startup-runtime/src/index.ts",
      to: "packages/startup-runtime/src/internal/signed-release-native-startup-owner.ts",
      specifier: "./internal/signed-release-native-startup-owner.ts",
      names: ["startSignedReleaseNativeStartupRuntime"],
    },
    {
      from: "packages/startup-runtime/src/internal/signed-release-native-startup-owner.ts",
      to: "packages/startup-runtime/src/internal/ready-owner.ts",
      specifier: "./ready-owner.ts",
      names: ["assertIssuedStartupReadyPort", "startupReadyPromotionPort"],
    },
    {
      from: "packages/startup-runtime/src/internal/signed-release-native-startup-owner.ts",
      to: "packages/startup-runtime/src/internal/six-step-route-parent-owner.ts",
      specifier: "./six-step-route-parent-owner.ts",
      names: ["issueStartupSixStepRouteParentCapabilityV1"],
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
    for (const item of cases) {
      mkdirSync(join(root, dirname(item.from)), { recursive: true });
      const edge: GraphEdge = { from: item.from, to: item.to, specifier: item.specifier };
      const inspect = (source: string, edges: readonly GraphEdge[]): readonly BoundaryDiagnostic[] => {
        writeFileSync(join(root, item.from), source);
        const diagnostics: BoundaryDiagnostic[] = [];
        validateDependencyBoundaries([file(item.from), file(item.to)], edges, diagnostics, root);
        return diagnostics;
      };
      const exact = `import { ${item.names.join(", ")} } from "${item.specifier}";\n`;
      assert.deepEqual(inspect(exact, [edge]), []);
      assert.ok(inspect(
        `import { ${[...item.names, "unregisteredNativeStartupAuthority"].join(", ")} } from "${item.specifier}";\n`,
        [edge],
      ).some(diagnostic => diagnostic.code === "authority-named-import-mismatch"));
      assert.ok(inspect("export {};\n", []).some(
        diagnostic => diagnostic.code === "authority-consumer-edge-missing",
      ));
    }
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

test("implementation closure contexts and isolated roots retain no compiler AST cache", () => {
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
  assert.match(builderSource, /createIsolatedProgram\(context\.options, entryRootNames\)/);
  assert.match(builderSource, /entryProgram = undefined/);

  const factoryStart = source.indexOf("function createIsolatedProgram(");
  assert.ok(factoryStart >= 0 && factoryStart < builderStart);
  const factorySource = source.slice(factoryStart, builderStart);
  assert.match(factorySource, /ts\.createProgram\(\{ rootNames: \[\.\.\.rootNames\], options, host \}\)/);
  assert.doesNotMatch(factorySource, /Map\s*<\s*string\s*,\s*ts\.Program\s*>/);
  assert.doesNotMatch(factorySource, /Map\s*<\s*string\s*,\s*ts\.SourceFile\s*>/);
  assert.doesNotMatch(factorySource, /getSourceFile\s*=/);
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
    const forgedPushed = {
      ...receipt,
      candidate: {
        ...receipt.candidate,
        clean: true,
        pushed: true,
        remoteRef: "refs/heads/codex/closure-fixture",
        remoteSha: receipt.candidate.headSha,
        upstreamSha: receipt.candidate.headSha,
      },
    };
    assert.equal(validateAndQueryImplementationClosureDigest(forgedPushed, closure.entrypointId), null);
    assert.equal(queryImplementationClosureObservation(forgedPushed, closure.entrypointId), null);
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
    const compilerObservationRoot = fixtureHashDomain("aloha/boundary/compiler-observation-equivalence/v1", {
      diagnostics: baseline.receipt.diagnostics,
      compilerGraphRoot: baseline.receipt.compiler.graphRoot,
      graph: baseline.receipt.graph,
      implementationClosures: baseline.receipt.implementationClosures,
      releaseClosures: baseline.receipt.releaseClosures,
    });
    // Exact post-AST-cache-removal and logical lock-owner observation
    // baseline. This binds the optimized implementation to the same complete
    // compiler facts while normalizing a physical package-store path to the
    // tracked package-lock owner.
    assert.equal(compilerObservationRoot, "0x239596afc32c30f7c23783d6877ac8472d79ad1453803e36275f97682760af4e");
    const baselineClosure = baseline.receipt.implementationClosures.find((item) => item.entrypointId === "compiler-root:tsconfig.json:src/predicate.ts");
    assert.ok(baselineClosure);
    const narrowProjection = collectCatalogCompilerBoundaryProjection({ gitRoot: root, modulePaths: ["src/predicate.ts"] });
    assert.deepEqual(
      narrowProjection.implementationClosures,
      baseline.receipt.implementationClosures.filter((item) => item.entrypoint === "src/predicate.ts"),
    );
    const proposalFor = (receipt: typeof baseline.receipt) => projectCatalogProposedCapabilitySet(receipt, [{
      capabilityId: "family.fixture.exact",
      version: "1.0.0",
      schemaHash: sha256(Buffer.from("fixture-capability-schema")) as `0x${string}`,
      interpreterHash: sha256(Buffer.from("fixture-capability-interpreter")) as `0x${string}`,
      modulePath: "src/predicate.ts",
      exportName: "predicate",
      entrypointId: "compiler-root:tsconfig.json:src/predicate.ts",
    }]);
    const baselineProposal = proposalFor(baseline.receipt);
    assert.deepEqual(proposalFor(baselineAgain.receipt), baselineProposal);
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
    const predicateMutation = digest();
    assert.notEqual(predicateMutation.value, predicateBefore);
    assert.notEqual(proposalFor(predicateMutation.receipt).root, baselineProposal.root);
    assert.throws(() => projectCatalogProposedCapabilitySet(baseline.receipt, [{
      capabilityId: "family.fixture.exact",
      version: "1.0.0",
      schemaHash: sha256(Buffer.from("fixture-capability-schema")) as `0x${string}`,
      interpreterHash: sha256(Buffer.from("fixture-capability-interpreter")) as `0x${string}`,
      modulePath: "src/other.ts",
      exportName: "predicate",
      entrypointId: "compiler-root:tsconfig.json:src/predicate.ts",
    }]), /path mismatch/);

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
    const optionMutation = digest();
    assert.notEqual(optionMutation.value, optionBefore);

    // The default library set is part of the isolated compiler input
    // denominator, not an ambient process detail.  Switching from the
    // target-selected default bundle to an explicit lib set must change both
    // the input root and the closure digest; a stale release/catalog binding
    // therefore cannot remain self-consistent after this mutation.
    const defaultLibBefore = optionMutation;
    writeFixture("tsconfig.json", JSON.stringify({
      compilerOptions: {
        target: "ES2021",
        lib: ["ES2021"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ["src/**/*.ts"],
      exclude: ["src/internal/**/*.ts"],
    }));
    commit("default library input mutation");
    const defaultLibAfter = digest();
    const defaultLibBeforeClosure = defaultLibBefore.receipt.implementationClosures
      .find((item) => item.entrypointId === "compiler-root:tsconfig.json:src/predicate.ts");
    const defaultLibAfterClosure = defaultLibAfter.receipt.implementationClosures
      .find((item) => item.entrypointId === "compiler-root:tsconfig.json:src/predicate.ts");
    assert.ok(defaultLibBeforeClosure);
    assert.ok(defaultLibAfterClosure);
    assert.notEqual(defaultLibAfter.value, defaultLibBefore.value);
    assert.notEqual(defaultLibAfterClosure.programInputSetRoot, defaultLibBeforeClosure.programInputSetRoot);
    assert.notDeepEqual(
      defaultLibAfterClosure.programInputs.filter((input) => input.kind === "typescript-lib"),
      defaultLibBeforeClosure.programInputs.filter((input) => input.kind === "typescript-lib"),
    );

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

    rmSync(join(root, "src/codec.ts"));
    commit("delete compiler source mutation");
    const deletedSource = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(deletedSource.verdict, "invalid", JSON.stringify(deletedSource.diagnostics));
    assert.ok(deletedSource.diagnostics.some((item) => item.code === "unresolved-module" || item.code === "typescript-build-diagnostic"), JSON.stringify(deletedSource.diagnostics));

    writeFixture("src/augmentation.ts", "export {};\ndeclare module './missing-augmentation.ts' { interface MissingAugmentation {} }\n");
    commit("unresolved module augmentation");
    const invalidAugmentation = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(invalidAugmentation.verdict, "invalid");
    assert.ok(invalidAugmentation.diagnostics.some((item) => item.code === "module-augmentation-target-unresolved"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog projection keeps declared contracts/generated roots in the exact denominator", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-catalog-roots-"));
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
    runGit("init", "-b", "codex/catalog-root-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "contracts"));
    mkdirSync(join(root, "generated"));
    writeFixture(".gitignore", "node_modules/\n");
    writeFixture("package.json", JSON.stringify({ name: "catalog-root-fixture", private: true, type: "module" }));
    writeFixture("package-lock.json", fixturePackageLock("catalog-root-fixture"));
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
    }));
    writeFixture("generated/tsconfig.json", JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ["**/*.ts"],
    }));
    writeFixture("src/predicate.ts", "export const predicate = 'v1';\n");
    writeFixture("generated/catalog.ts", "export const generatedCatalog = 'before';\n");
    writeFixture("contracts/foundry.toml", "[profile.default]\nsrc = 'src'\n");
    commit("declared source roots");

    const before = collectCatalogCompilerBoundaryProjection({ gitRoot: root, modulePaths: ["src/predicate.ts"] });
    assert.equal(before.diagnostics.some((item) => item.code === "unknown-source-root" || item.code === "source-not-in-tsconfig"), false);
    writeFixture("generated/catalog.ts", "export const generatedCatalog = 'after';\n");
    commit("generated denominator mutation");
    const after = collectCatalogCompilerBoundaryProjection({ gitRoot: root, modulePaths: ["src/predicate.ts"] });
    assert.notEqual(after.scannedFileSetRoot, before.scannedFileSetRoot);
    assert.deepEqual(after.implementationClosures, before.implementationClosures);

    mkdirSync(join(root, "mystery"));
    writeFixture("mystery/foundry.toml", "[profile.default]\n");
    commit("unknown source root mutation");
    assert.throws(
      () => collectCatalogCompilerBoundaryProjection({ gitRoot: root, modulePaths: ["src/predicate.ts"] }),
      /unknown-source-root:mystery\/foundry\.toml/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog compiler projection defers only unrelated pre-generation imports", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-catalog-bootstrap-fixture-"));
  const runGit = (...args: string[]) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const writeFixture = (path: string, source: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };
  const commit = (message: string) => {
    runGit("add", ".");
    runGit("commit", "-m", message);
  };
  try {
    runGit("init", "-b", "codex/catalog-bootstrap-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    writeFixture(".gitignore", "node_modules/\n");
    writeFixture("package.json", JSON.stringify({ name: "catalog-bootstrap-fixture", private: true, type: "module" }));
    writeFixture("package-lock.json", fixturePackageLock("catalog-bootstrap-fixture"));
    writeFixture("tsconfig.json", JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ["src/**/*.ts", "generated/**/*.ts"],
    }));
    writeFixture("src/selected.ts", "export const selected = 'catalog-input';\n");
    writeFixture("src/unrelated-runtime.ts", "import { generated } from '../generated/safety-profile/index.ts';\nexport const runtime = generated;\n");
    commit("missing unrelated generated output");

    const projection = collectCatalogCompilerBoundaryProjection({
      gitRoot: root,
      modulePaths: ["src/selected.ts"],
    });
    assert.ok(projection.implementationClosures.some((item) => item.entrypoint === "src/selected.ts"));
    assert.equal(projection.diagnostics.some((item) => item.code === "unresolved-module"), false);
    assert.ok(projection.diagnostics.some((item) =>
      item.kind === "fail"
      && item.code === "typescript-build-diagnostic"
      && item.path === "src/unrelated-runtime.ts"
      && item.message.includes("Cannot find module '../generated/safety-profile/index.ts'")));

    writeFixture("src/unrelated-ordinary.ts", "import { missing } from './ordinary-missing.ts';\nexport const unrelated = missing;\n");
    commit("missing unrelated ordinary dependency");
    assert.throws(
      () => collectCatalogCompilerBoundaryProjection({ gitRoot: root, modulePaths: ["src/selected.ts"] }),
      /unresolved-module:src\/unrelated-ordinary\.ts/,
    );

    writeFixture("src/ordinary-missing.ts", "export const missing = 'present';\n");
    writeFixture("src/selected-helper.ts", "import { generated } from '../generated/family-catalog/index.ts';\nexport const selectedHelper = generated;\n");
    writeFixture("src/selected.ts", "import { selectedHelper } from './selected-helper.ts';\nexport const selected = selectedHelper;\n");
    commit("missing selected catalog dependency");
    assert.throws(
      () => collectCatalogCompilerBoundaryProjection({ gitRoot: root, modulePaths: ["src/selected.ts"] }),
      /unresolved-module:src\/selected-helper\.ts/,
    );

    writeFixture("src/selected.ts", "export const selected = 'catalog-input';\n");
    writeFixture("src/selected-helper.ts", "export const selectedHelper = 'detached';\n");
    writeFixture("generated/family-catalog/index.ts", "import { missing } from './missing-internal.ts';\nexport const generated = missing;\n");
    commit("present catalog output with missing internal dependency");
    assert.throws(
      () => collectCatalogCompilerBoundaryProjection({ gitRoot: root, modulePaths: ["src/selected.ts"] }),
      /unresolved-module:generated\/family-catalog\/index\.ts/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog projection covers valuation-owner roots and non-test qualification helpers", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-valuation-owner-roots-"));
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
    runGit("init", "-b", "codex/valuation-owner-root-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "valuation-owners", "native-equivalent", "src"), { recursive: true });
    mkdirSync(join(root, "specs", "release-authority", "src"), { recursive: true });
    mkdirSync(join(root, "specs", "release-authority", "test"), { recursive: true });
    writeFixture(".gitignore", "node_modules/\n");
    writeFixture("package.json", JSON.stringify({ name: "valuation-owner-root-fixture", private: true, type: "module" }));
    writeFixture("package-lock.json", fixturePackageLock("valuation-owner-root-fixture"));
    const compilerOptions = {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
    };
    writeFixture("valuation-owners/native-equivalent/tsconfig.json", JSON.stringify({
      compilerOptions,
      include: ["src/**/*.ts"],
    }));
    writeFixture("specs/release-authority/tsconfig.json", JSON.stringify({
      compilerOptions,
      include: ["src/**/*.ts", "test/**/*.ts"],
    }));
    writeFixture("valuation-owners/native-equivalent/src/runtime.ts", "export const valuationOwner = 'native-equivalent';\n");
    writeFixture("specs/release-authority/src/index.ts", "export const releaseAuthoritySpec = 'v1';\n");
    writeFixture("specs/release-authority/test/valuation-owner-qualification-fixture.ts", "export const qualificationFixture = 'exact';\n");
    commit("compiler-owned valuation owner and qualification helper");

    const projection = collectCatalogCompilerBoundaryProjection({
      gitRoot: root,
      modulePaths: ["valuation-owners/native-equivalent/src/runtime.ts"],
    });
    assert.equal(projection.diagnostics.some((item) => item.code === "unknown-source-root" || item.code === "source-not-in-tsconfig"), false);
    assert.ok(projection.implementationClosures.some((item) =>
      item.entrypointId === "compiler-root:valuation-owners/native-equivalent/tsconfig.json:valuation-owners/native-equivalent/src/runtime.ts"));

    writeFixture("valuation-owners/native-equivalent/src/unclassified.asset", "not an admitted source or metadata format\n");
    commit("add unclassified valuation-owner source");
    assert.throws(
      () => collectCatalogCompilerBoundaryProjection({
        gitRoot: root,
        modulePaths: ["valuation-owners/native-equivalent/src/runtime.ts"],
      }),
      /unclassified-source-file:valuation-owners\/native-equivalent\/src\/unclassified\.asset/,
    );
    rmSync(join(root, "valuation-owners/native-equivalent/src/unclassified.asset"));
    commit("remove unclassified valuation-owner source");

    writeFixture("specs/release-authority/tsconfig.json", JSON.stringify({
      compilerOptions,
      include: ["src/**/*.ts", "test/**/*.test.ts"],
    }));
    commit("exclude non-test-suffixed qualification helper");
    assert.throws(
      () => collectCatalogCompilerBoundaryProjection({
        gitRoot: root,
        modulePaths: ["valuation-owners/native-equivalent/src/runtime.ts"],
      }),
      /source-not-in-tsconfig:specs\/release-authority\/test\/valuation-owner-qualification-fixture\.ts/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native runtime assets remain compiler-owned and omission fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-native-runtime-assets-"));
  const packageRoot = "tools/runtime-release-packager";
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
    runGit("init", "-b", "codex/native-runtime-assets-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, packageRoot, "src"), { recursive: true });
    mkdirSync(join(root, packageRoot, "assets"));
    writeFixture(".gitignore", "node_modules/\n");
    writeFixture("package.json", JSON.stringify({ name: "native-runtime-assets-fixture", private: true, type: "module" }));
    writeFixture("package-lock.json", fixturePackageLock("native-runtime-assets-fixture"));
    writeFixture(`${packageRoot}/package.json`, JSON.stringify({ name: "@fixture/runtime-release-packager", private: true, type: "module" }));
    writeFixture(`${packageRoot}/tsconfig.json`, JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        allowJs: true,
      },
      include: ["src/**/*.ts", "assets/**/*.mjs"],
    }));
    writeFixture(`${packageRoot}/src/index.ts`, "export const owner = 'runtime-assets';\n");
    writeFixture(`${packageRoot}/assets/pre-release-owner.mjs`, "export const preReleaseOwner = 'exact';\n");
    writeFixture(`${packageRoot}/assets/production-launcher.mjs`, "export const productionLauncher = 'exact';\n");
    commit("compiler-owned native runtime assets");

    const paths = [
      `${packageRoot}/assets/pre-release-owner.mjs`,
      `${packageRoot}/assets/production-launcher.mjs`,
    ] as const;
    const projection = collectCatalogCompilerBoundaryProjection({ gitRoot: root, modulePaths: paths });
    for (const path of paths) {
      const closure = projection.implementationClosures.find(item => item.entrypoint === path);
      assert.ok(closure, `missing native runtime asset closure: ${path}`);
      assert.equal(closure.kind, "compiler-root");
      assert.deepEqual(closure.files.map(file => file.path), [path]);
    }

    writeFixture(`${packageRoot}/tsconfig.json`, JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        allowJs: true,
      },
      include: ["src/**/*.ts"],
    }));
    commit("omit native runtime assets");
    assert.throws(
      () => collectCatalogCompilerBoundaryProjection({ gitRoot: root, modulePaths: paths }),
      /source-not-in-tsconfig:tools\/runtime-release-packager\/assets\/(?:pre-release-owner|production-launcher)\.mjs/,
    );
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

test("pnpm physical-store declarations bind the logical package-lock owner", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-pnpm-owner-"));
  const runGit = (...args: string[]) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logicalPackageRoot = join(root, "node_modules", "external-types");
  const physicalPackageRoot = join(
    root,
    "node_modules",
    ".pnpm",
    "external-types@1.0.0",
    "node_modules",
    "external-types",
  );
  try {
    runGit("init", "-b", "codex/pnpm-owner-fixture");
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    mkdirSync(join(root, "src"));
    mkdirSync(physicalPackageRoot, { recursive: true });
    symlinkSync(physicalPackageRoot, logicalPackageRoot, "dir");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "pnpm-owner-fixture",
      private: true,
      type: "module",
      dependencies: { "external-types": "1.0.0" },
      devDependencies: { typescript: ts.version },
    }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("pnpm-owner-fixture", {
      "node_modules/external-types": { version: "1.0.0", integrity: "sha512-external-types" },
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
    writeFileSync(join(root, "src", "index.ts"), "import { value } from 'external-types';\nexport const observed = value;\n");
    writeFileSync(join(physicalPackageRoot, "package.json"), JSON.stringify({
      name: "external-types",
      version: "1.0.0",
      type: "module",
      types: "./index.d.ts",
      main: "./index.js",
    }));
    writeFileSync(join(physicalPackageRoot, "index.d.ts"), "export declare const value: number;\n");
    writeFileSync(join(physicalPackageRoot, "index.js"), "export const value = 1;\n");
    runGit("add", ".");
    runGit("commit", "-m", "pnpm physical owner fixture");

    const receipt = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(receipt.verdict, "pass", JSON.stringify(receipt.diagnostics));
    const closure = receipt.implementationClosures.find(item =>
      item.entrypointId === "compiler-root:tsconfig.json:src/index.ts");
    assert.ok(closure);
    const input = closure.programInputs.find(item =>
      item.logicalPath === "npm/external-types@1.0.0/index.d.ts");
    assert.ok(input);
    assert.equal(input.lockRecordPath, "node_modules/external-types");

    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("pnpm-owner-fixture", {
      "node_modules/external-types": { version: "1.0.0", integrity: "sha512-external-types" },
      "node_modules/container/node_modules/external-types": { version: "1.0.0", integrity: "sha512-ambiguous-owner" },
    }));
    runGit("add", "package-lock.json");
    runGit("commit", "-m", "make logical owner ambiguous");
    const ambiguous = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(ambiguous.verdict, "invalid");
    assert.ok(ambiguous.diagnostics.some(item =>
      item.code === "external-compiler-input-owner-unproven"
      || item.code === "external-edge-owner-unproven"));

    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("pnpm-owner-fixture", {
      "node_modules/external-types": { version: "2.0.0", integrity: "sha512-wrong-version" },
    }));
    runGit("add", "package-lock.json");
    runGit("commit", "-m", "mismatch logical owner");
    const invalid = runBoundaryGate({ gitRoot: root, requirePushed: false });
    assert.equal(invalid.verdict, "invalid");
    assert.ok(invalid.diagnostics.some(item =>
      item.code === "external-compiler-input-owner-unproven"
      || item.code === "external-edge-owner-unproven"));
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

test("a local remote-tracking ref alone cannot receive pushed authority", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-fake-remote-tracking-"));
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const branch = "codex/fake-remote-tracking-fixture";
  try {
    runGit("init", "-b", branch);
    runGit("config", "user.email", "boundary@example.invalid");
    runGit("config", "user.name", "Boundary Test");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake-remote-tracking-fixture", private: true, type: "module" }));
    writeFileSync(join(root, "package-lock.json"), fixturePackageLock("fake-remote-tracking-fixture"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true }, include: ["index.ts"] }));
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
    runGit("add", ".");
    runGit("commit", "-m", "fake remote tracking fixture");
    runGit("remote", "add", "origin", ".");
    runGit("update-ref", `refs/remotes/origin/${branch}`, "HEAD");
    runGit("branch", "--set-upstream-to", `origin/${branch}`);
    writeFileSync(join(root, "untracked"), "local tracking refs are not remote evidence\n");
    const receipt = runBoundaryGate({ gitRoot: root, requirePushed: true });
    assert.equal(receipt.candidate.upstreamSha, receipt.candidate.headSha);
    assert.equal(receipt.candidate.remoteRef, null);
    assert.equal(receipt.candidate.remoteSha, null);
    assert.equal(receipt.candidate.pushed, false);
    assert.equal(receipt.verdict, "invalid");
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
