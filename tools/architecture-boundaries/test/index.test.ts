import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  MUTATION_CORPUS,
  inspectSourceText,
  runBoundaryGate,
  validateDependencyBoundaries,
  validateGeneratedManifestFacts,
  verifyMutationCorpus,
} from "../src/index.ts";
import type { GraphEdge, TrackedFile } from "../src/index.ts";

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
  assert.ok(receipt.compiler.configPaths.length > 0);
  assert.ok(receipt.compiler.externalDependencies.includes("node:crypto"));
  assert.match(receipt.denominator.scannedFileSetRoot, /^0x[0-9a-f]{64}$/);
  assert.match(receipt.denominator.manifestRoot, /^0x[0-9a-f]{64}$/);
  assert.match(receipt.compiler.configRoots, /^0x[0-9a-f]{64}$/);
  assert.match(receipt.compiler.compilerVersionRoot, /^0x[0-9a-f]{64}$/);
  assert.match(receipt.compiler.graphRoot, /^0x[0-9a-f]{64}$/);
  assert.equal(receipt.claims.runtimeLegacyZero, "not-asserted");
  assert.equal(receipt.claims.productionAuthority, "not-observed");
  assert.ok(receipt.diagnostics.every((item) => item.path.length > 0));
});

test("generated output mutations cannot omit the hash or generator closure", () => {
  const generated = {
    path: "generated/out.ts",
    mode: "100644",
    blobSha: "a".repeat(40),
    byteLength: 1,
    language: "typescript" as const,
    fileClass: "generated" as const,
  };
  const generator = {
    path: "tools/generate.ts",
    mode: "100644",
    blobSha: "b".repeat(40),
    byteLength: 1,
    language: "typescript" as const,
    fileClass: "authoring" as const,
  };
  const empty = validateGeneratedManifestFacts("generated-manifest.json", { outputs: [generated.path], generators: [] }, [generated.path], [generated, generator]);
  assert.deepEqual(empty.diagnostics.map((item) => item.code).sort(), ["generated-manifest-hash", "generated-manifest-keys", "generator-closure-missing"]);
  const missingHash = validateGeneratedManifestFacts("generated-manifest.json", { outputs: [generated.path], generators: [generator.path] }, [generated.path], [generated, generator]);
  assert.deepEqual(missingHash.diagnostics.map((item) => item.code).sort(), ["generated-manifest-hash", "generated-manifest-keys"]);
  const unsorted = validateGeneratedManifestFacts("generated-manifest.json", { outputs: ["generated/z.ts", generated.path], generators: [generator.path], manifestHash: "0x0", extra: true }, [generated.path, "generated/z.ts"], [generated, generator]);
  assert.ok(unsorted.diagnostics.some((item) => item.code === "generated-manifest-keys"));
  assert.ok(unsorted.diagnostics.some((item) => item.code === "generated-output-set-mismatch"));
});

test("dependency attacks cannot hide behind external edges or strategy/generated names", () => {
  const file = (path: string, fileClass: TrackedFile["fileClass"]): TrackedFile => ({
    path,
    mode: "100644",
    blobSha: "a".repeat(40),
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
    file("fixture/reference-input.ts", "reference-only"),
  ];
  const edges: GraphEdge[] = [
    { from: "acceptance/core.ts", to: "@external/lodash", specifier: "lodash" },
    { from: "specs/frozen.ts", to: "@external/node:fs", specifier: "node:fs" },
    { from: "tools/reference-only/ref.ts", to: "@external/foo", specifier: "foo" },
    { from: "tools/reference-only/ref.ts", to: "@external/node:fs", specifier: "node:fs" },
    { from: "apps/searcher.ts", to: "strategies/arbitrage/index.ts", specifier: "./strategy" },
    { from: "apps/searcher.ts", to: "generated/family-catalog/index.ts", specifier: "../generated/family-catalog" },
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
