import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeRuntimeBoundaryProjectionV1,
  runtimeBoundaryProjectionRootV1,
  type RuntimeBoundaryProjectionPayloadV1,
  type RuntimeBoundaryReleaseClosureRefV1,
} from "../src/runtime-boundary-projection.ts";

const h = (value: string): Hash => hashDomain("test/runtime-boundary-projection/v1", value);
const commit = "a".repeat(40);

function ref(role: RuntimeBoundaryReleaseClosureRefV1["role"]): RuntimeBoundaryReleaseClosureRefV1 {
  return Object.freeze({
    role,
    entrypointId: "entry#main",
    entrypoint: "src/entry.ts",
    modulePath: "src/entry.ts",
    exportName: "run",
    predicateId: ["predicate-adapter", "qualification-oracle", "material-provider"].includes(role) ? "predicate" : null,
    predicateSpecDigest: null,
    predicateProgramDescriptorDigest: null,
    oracleProgramDescriptorDigest: null,
    adapterVersion: null,
    oracleVersion: null,
    compositionLeafDigest: null,
    commonEnvelopeRoleContractVersion: null,
    materialProviderContractDigest: null,
    implementationExportDigest: null,
    closureDigest: h("closure"),
    programInputSetRoot: h("inputs"),
  });
}

function payload(): RuntimeBoundaryProjectionPayloadV1 {
  const releaseClosures = Object.freeze({
    schemaVersion: 1 as const,
    genericCore: ref("generic-core"),
    qualifiedRunner: ref("qualified-runner"),
    predicateAdapters: Object.freeze([ref("predicate-adapter")]),
    qualificationOracles: Object.freeze([ref("qualification-oracle")]),
    materialProviders: Object.freeze([ref("material-provider")]),
    releaseRuntime: ref("release-runtime"),
    predicateCompositionRootDigest: h("composition"),
    commonEnvelopeRoleContractVersion: "v1",
    roleManifestRootDigest: h("roles"),
    rootDigest: h("release-closures"),
  });
  const languageBuild = Object.freeze({ rust: null, solidity: null, rootDigest: h("language") });
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.runtime-boundary-projection" as const,
    candidate: Object.freeze({
      candidateReleaseCommit: commit,
      branch: "codex/runtime-boundary",
      upstreamRef: "refs/remotes/origin/codex/runtime-boundary",
      remoteRef: "refs/heads/codex/runtime-boundary",
      headSha: commit,
      upstreamSha: commit,
      remoteSha: commit,
      pushed: true,
      scannedFileSetRoot: h("files"),
      boundaryManifestRoot: h("manifest"),
      compilerVersionRoot: h("compiler"),
      compilerConfigRoot: h("config"),
      compilerGraphRoot: h("graph"),
      packageManifestRoot: h("packages"),
      externalDependencyRoot: h("external"),
      languageBuildRoot: languageBuild.rootDigest,
      releaseRoleManifestRoot: releaseClosures.roleManifestRootDigest,
      releaseClosureRoot: releaseClosures.rootDigest,
    }),
    implementationClosures: Object.freeze([Object.freeze({
      entrypoint: "src/entry.ts",
      entrypointId: "entry#main",
      kind: "compiler-root" as const,
      packageName: null,
      packageManifestPath: null,
      configPath: "tsconfig.json",
      tsconfigRoot: h("tsconfig"),
      optionsRoot: h("options"),
      programInputSetRoot: h("inputs"),
      closureDigest: h("closure"),
    })]),
    selectedFiles: Object.freeze([
      Object.freeze({ path: "src/entry.ts", mode: "100644", blobSha: "b".repeat(40), contentSha256: h("entry"), byteLength: 10, language: "typescript" as const, fileClass: "production-runtime" as const }),
      Object.freeze({ path: "tsconfig.json", mode: "100644", blobSha: "c".repeat(40), contentSha256: h("tsconfig-file"), byteLength: 20, language: "metadata" as const, fileClass: "metadata" as const }),
    ]),
    selectedEdges: Object.freeze([Object.freeze({ from: "src/entry.ts", to: "tsconfig.json", specifier: "../tsconfig.json" })]),
    languageBuild,
    releaseClosures,
  });
}

function seal(value: RuntimeBoundaryProjectionPayloadV1) {
  return Object.freeze({ ...value, projectionRoot: runtimeBoundaryProjectionRootV1(value) });
}

test("runtime Boundary projection accepts exact roots without a producer verdict", () => {
  const decoded = decodeRuntimeBoundaryProjectionV1(seal(payload()));
  assert.equal(decoded.candidate.candidateReleaseCommit, commit);
  assert.equal(decoded.projectionRoot, runtimeBoundaryProjectionRootV1(payload()));
  assert.ok(!("verdict" in decoded));
});

test("runtime Boundary projection rejects wrong role, closure digest, and outside edge mutations", () => {
  const base = payload();
  const mutate = (value: RuntimeBoundaryProjectionPayloadV1) => () => decodeRuntimeBoundaryProjectionV1(seal(value));
  assert.throws(mutate({ ...base, releaseClosures: { ...base.releaseClosures, genericCore: { ...base.releaseClosures.genericCore, role: "release-runtime" } } }), /roles are invalid/);
  assert.throws(mutate({ ...base, releaseClosures: { ...base.releaseClosures, qualifiedRunner: { ...base.releaseClosures.qualifiedRunner, closureDigest: h("wrong") } } }), /does not match selected closure/);
  assert.throws(mutate({ ...base, selectedEdges: [{ from: "src/entry.ts", to: "outside.ts", specifier: "./outside.ts" }] }), /outside selected files/);
});
