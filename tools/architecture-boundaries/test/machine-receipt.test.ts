import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  computeProgramInputSetRoot,
  createBoundaryMachineReceiptV1,
  writeBoundaryMachineReceiptV1,
} from "../src/index.ts";
import type { BoundaryReceipt, ImplementationClosure } from "../src/index.ts";

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function domainRoot(domain: string, value: unknown): string {
  return `0x${createHash("sha256").update(domain).update("\0").update(canonical(value)).digest("hex")}`;
}

const root = (marker: string): string => `0x${marker.repeat(64)}`;

function closure(index: number): ImplementationClosure {
  return {
    entrypoint: `src/high-cardinality-${index}.ts`,
    entrypointId: `compiler-root:tsconfig.json:src/high-cardinality-${index}.ts`,
    kind: "compiler-root",
    packageName: null,
    packageManifestPath: null,
    configPath: "tsconfig.json",
    tsconfigRoot: root("1"),
    configChain: { rootPath: "tsconfig.json", files: [], edges: [] },
    optionsRoot: root("2"),
    programInputs: [{
      kind: "tracked",
      logicalPath: `repo/src/high-cardinality-${index}.ts`,
      blobSha: "a".repeat(40),
      packageName: null,
      packageVersion: null,
      packageRelativePath: null,
      packageManifestSha256: null,
      lockRecordPath: null,
      lockRecordHash: null,
      contentSha256: root("3"),
      compilerTextSha256: root("3"),
      byteLength: index,
    }],
    programInputSetRoot: root("4"),
    typescriptVersion: "5.9.3",
    packageManifestRoot: root("5"),
    externalDependencyRoot: root("6"),
    files: [],
    edges: [],
    closureDigest: domainRoot("fixture/closure", index),
  };
}

function receipt(closureCount: number): BoundaryReceipt {
  const implementationClosures = Array.from({ length: closureCount }, (_, index) => closure(index));
  return {
    schemaVersion: 1,
    gate: "aloha.machine-enforced-boundary",
    verdict: "pass",
    candidate: {
      gitRoot: "/fixture",
      branch: "codex/fixture",
      headSha: "a".repeat(40),
      upstreamSha: "a".repeat(40),
      remoteRef: "refs/heads/codex/fixture",
      remoteSha: "a".repeat(40),
      clean: true,
      pushed: true,
    },
    denominator: { scannedFileSetRoot: root("7"), manifestRoot: root("8"), files: [] },
    compiler: {
      typescriptVersion: "5.9.3",
      compilerVersionRoot: root("9"),
      configPaths: ["tsconfig.json"],
      configRoots: root("a"),
      graphRoot: root("b"),
      packageManifestRoot: root("c"),
      externalDependencyRoot: root("d"),
      languageBuildRoot: root("e"),
      externalDependencies: [],
      workspaceNames: [],
    },
    languageBuild: { rust: null, solidity: null, rootDigest: root("e") },
    graph: { nodes: [], edges: [] },
    implementationClosures,
    catalogVerification: null,
    releaseRoleManifest: null,
    releaseClosures: null,
    diagnostics: [],
    mutationCorpus: { root: root("f"), cases: [] },
    claims: {
      sourceBuildClosure: "observed",
      runtimeLegacyZero: "not-asserted",
      productionAuthority: "not-observed",
    },
  };
}

test("bounded machine receipt preserves the gate verdict and load-bearing roots", () => {
  const full = receipt(2);
  const projected = createBoundaryMachineReceiptV1(full);
  assert.equal(projected.verdict, full.verdict);
  assert.equal(projected.roots.scannedFileSetRoot, full.denominator.scannedFileSetRoot);
  assert.equal(projected.roots.boundaryManifestRoot, full.denominator.manifestRoot);
  assert.equal(projected.roots.compilerGraphRoot, full.compiler.graphRoot);
  assert.equal(projected.roots.languageBuildRoot, full.languageBuild.rootDigest);
  assert.equal(projected.roots.mutationCorpusRoot, full.mutationCorpus.root);
  assert.equal(projected.roots.implementationClosureSetRoot, domainRoot(
    "aloha/boundary/implementation-closure-set/v1",
    full.implementationClosures.map(({ entrypointId, closureDigest }) => ({ entrypointId, closureDigest })),
  ));
  assert.equal(projected.roots.diagnosticSetRoot, domainRoot(
    "aloha/boundary/diagnostic-set/v1",
    full.diagnostics,
  ));
  const { rootDigest, ...base } = projected;
  assert.equal(rootDigest, domainRoot("aloha/boundary/machine-receipt/v1", base));

  const changedBase = receipt(2);
  const changed: BoundaryReceipt = {
    ...changedBase,
    implementationClosures: changedBase.implementationClosures.map((item, index) => index === 1
      ? { ...item, closureDigest: root("0") }
      : item),
  };
  const changedProjection = createBoundaryMachineReceiptV1(changed);
  assert.notEqual(changedProjection.roots.implementationClosureSetRoot, projected.roots.implementationClosureSetRoot);
  assert.notEqual(changedProjection.rootDigest, projected.rootDigest);

  const expandedProjection = createBoundaryMachineReceiptV1(receipt(3));
  assert.equal(expandedProjection.counts.implementationClosures, 3);
  assert.equal(expandedProjection.counts.implementationCompilerInputs, 3);
  assert.notEqual(expandedProjection.roots.implementationClosureSetRoot, projected.roots.implementationClosureSetRoot);

  const failed: BoundaryReceipt = {
    ...full,
    verdict: "fail",
    diagnostics: [{
      kind: "fail",
      code: "fixture-mutation",
      path: "src/high-cardinality-0.ts",
      message: "fixture diagnostic",
      offset: 0,
    }],
  };
  const failedProjection = createBoundaryMachineReceiptV1(failed);
  assert.equal(failedProjection.counts.diagnostics, 1);
  assert.notEqual(failedProjection.roots.diagnosticSetRoot, projected.roots.diagnosticSetRoot);
  assert.notEqual(failedProjection.rootDigest, projected.rootDigest);
});

test("streaming domain hashing is exact-equivalent to the prior canonical encoding", () => {
  const inputs = [closure(1).programInputs[0]!, closure(0).programInputs[0]!];
  assert.equal(computeProgramInputSetRoot(inputs), domainRoot(
    "aloha/boundary/program-input-set/v2",
    [...inputs].sort((left, right) => `${left.kind}|${left.logicalPath}`.localeCompare(`${right.kind}|${right.logicalPath}`)),
  ));
});

test("machine output stays bounded when the complete closure fact tree is high cardinality", () => {
  const full = receipt(20_000);
  const chunks: string[] = [];
  writeBoundaryMachineReceiptV1(full, (chunk) => chunks.push(chunk));
  const output = chunks.join("");
  const parsed = JSON.parse(output) as ReturnType<typeof createBoundaryMachineReceiptV1>;

  assert.ok(output.length < 4 * 1024, `machine receipt expanded to ${output.length} bytes`);
  assert.equal(parsed.counts.implementationClosures, 20_000);
  assert.equal(parsed.counts.implementationCompilerInputs, 20_000);
  assert.equal(parsed.verdict, full.verdict);
  assert.equal(parsed.roots.boundaryManifestRoot, full.denominator.manifestRoot);
  assert.doesNotMatch(output, /high-cardinality-19999/);
});

test("Boundary CLI emits the bounded projection instead of the expanded receipt", () => {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(source, /writeBoundaryMachineReceiptV1\(receipt/);
  assert.doesNotMatch(source, /writeReceipt\(receipt/);
  assert.doesNotMatch(source, /output\s*\+=/);
});
