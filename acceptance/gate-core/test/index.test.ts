import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
} from "../../artifact-lineage-facts/src/reference-model.ts";
import {
  ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS,
  ARTIFACT_LINEAGE_MUTATION_IDS,
  ARTIFACT_LINEAGE_SIDECAR_MUTATION_IDS,
  ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
  ARTIFACT_LINEAGE_PREDICATE_SPEC,
} from "../../artifact-lineage-facts/src/runtime.ts";
import {
  ARTIFACT_LINEAGE_CASE_MATERIAL,
  evaluateArtifactLineageCase,
} from "../../artifact-lineage-facts/src/qualification.ts";
import {
  ARTIFACT_LINEAGE_PREDICATE_EVALUATOR,
} from "../src/predicates/artifact-lineage.ts";
import {
  computePredicateCompositionRootDigest,
  RELEASE_ROLE_COMPOSITION,
} from "../src/release-composition.ts";
import {
  PREDICATE_COMPOSITION_ROOT_DIGEST,
  RELEASE_PREDICATE_BINDINGS,
  resolvePredicateEvaluator,
} from "../src/generated/predicate-composition.ts";
import { RELEASE_ROLE_MANIFEST } from "../src/generated/release-role-manifest.ts";
import {
  type GateCoreAuthorityPinV1,
  type GateCoreInputV1,
} from "../src/index.ts";
import { evaluateGateCore } from "../src/generated/release-runtime.ts";
import { evaluateGateCoreForQualification } from "../src/qualification/internal.ts";
import * as releaseExports from "../src/generated/release-runtime.ts";

const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const CURRENT_PREDICATE_BINDING = RELEASE_PREDICATE_BINDINGS[0]!;

test("generic core and live predicate closure do not import qualification oracle code", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const coreSource = readFileSync(join(root, "src/index.ts"), "utf8");
  const portSource = readFileSync(join(root, "src/predicate-composition.ts"), "utf8");
  const liveAdapterSource = readFileSync(join(root, "src/predicates/artifact-lineage.ts"), "utf8");
  const releaseSource = readFileSync(join(root, "src/generated/release-runtime.ts"), "utf8");
  assert.doesNotMatch(coreSource, /release-composition|predicates\/artifact-lineage/);
  assert.doesNotMatch(portSource, /release-composition|predicates\/artifact-lineage/);
  assert.doesNotMatch(liveAdapterSource, /reference-model|CASE_MATERIAL|computeArtifactLineageCase/);
  assert.doesNotMatch(releaseSource, /qualification\/internal|reference-model|CASE_MATERIAL/);
});

test("package release surface has one runtime export and no internal subpath", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports?: unknown };
  assert.deepEqual(manifest.exports, { ".": "./src/generated/release-runtime.ts" });
  assert.deepEqual(Object.keys(releaseExports), ["evaluateGateCore"]);
  const authoritySource = readFileSync(join(root, "src/generated/release-authority.ts"), "utf8");
  assert.match(authoritySource, /RELEASE_AUTHORITY[^=]*= null/);
  assert.doesNotMatch(authoritySource, /ARTIFACT_LINEAGE|fixture|CASE_MATERIAL/);
});

function authority(): GateCoreAuthorityPinV1 {
  return {
    registry: {
      expectedRegistryRoot: hash("1"),
      expectedGovernanceTrustAnchorHash: hash("2"),
      expectedEpoch: "1",
    },
    externalQualification: {
      expectedTrustAnchorRoot: hash("2"),
      expectedIssuerKeySetRoot: hash("3"),
      expectedRegistryApprovalId: hash("4"),
      expectedReleaseAuthorityApprovalId: hash("5"),
      expectedQualificationAudienceHash: hash("6"),
      expectedReleaseRoleManifestRoot: hash("7"),
      expectedCandidateReleaseCommit: "0123456789012345678901234567890123456789",
    },
    predicate: ARTIFACT_LINEAGE_PREDICATE_SPEC,
    predicateProgramDescriptorDigest: ARTIFACT_LINEAGE_PREDICATE_PROGRAM_DESCRIPTOR_DIGEST,
    oracleProgramDescriptorDigest: ARTIFACT_LINEAGE_ORACLE_PROGRAM_DESCRIPTOR_DIGEST,
    predicateCompositionLeafDigest: CURRENT_PREDICATE_BINDING.compositionLeafDigest,
    predicateCompositionRootDigest: PREDICATE_COMPOSITION_ROOT_DIGEST,
    predicateImplementationClosureDigest: hash("3"),
    predicateImplementationExportDigest: CURRENT_PREDICATE_BINDING.predicateImplementationExportDigest,
    oracleImplementationClosureDigest: hash("6"),
    oracleImplementationExportDigest: CURRENT_PREDICATE_BINDING.oracleImplementationExportDigest,
    gateCoreImplementationClosureDigest: hash("4"),
    gateCoreRuntimeClosureDigest: hash("7"),
    verifierQualificationId: hash("5"),
    signedInvocationRoleId: "artifact-lineage-invocation-seal-observer",
    maxInvocationTtlUnixNs: "1000000000",
    expectedAudienceHash: hash("8"),
  };
}

function emptyInput(): GateCoreInputV1 {
  return {
    query: {} as never,
    snapshot: {} as never,
    registry: {} as never,
    registryFacts: {} as never,
    externalQualification: {} as never,
    verifierCertificate: {} as never,
    observerCertificates: [],
    artifactRefs: [],
    resolverPolicies: [],
    retentionLeases: [],
    artifactClaims: [],
    observations: [],
    sidecarObservations: [],
    signedInvocationSnapshot: {} as never,
    predicateFacts: [],
  };
}

test("public release is deterministically invalid until authority is qualified", () => {
  const result = evaluateGateCore(emptyInput());
  assert.equal(result.verdict, "invalid");
  assert.deepEqual(result.reasons, [{ code: "release-authority-unavailable", path: "$.releaseAuthority" }]);
});

test("public release ignores a second argument and remains unavailable", () => {
  const input = { ...emptyInput(), predicate: ARTIFACT_LINEAGE_PREDICATE_SPEC } as unknown as Record<string, unknown>;
  const first = evaluateGateCore(input);
  const second = (evaluateGateCore as unknown as (...args: unknown[]) => ReturnType<typeof evaluateGateCore>)(input, authority());
  assert.equal(evaluateGateCore.length, 1);
  assert.deepEqual(second, first);
  assert.equal(first.verdict, "invalid");
  assert.ok(first.reasons.some((reason) => reason.code === "release-authority-unavailable"));
});

test("qualification-only entry point keeps authority outside the input envelope", () => {
  const pin = authority();
  const input = emptyInput() as unknown as Record<string, unknown>;
  input.predicate = ARTIFACT_LINEAGE_PREDICATE_SPEC;
  const result = evaluateGateCoreForQualification(pin, input as never, {
    rootDigest: PREDICATE_COMPOSITION_ROOT_DIGEST,
    resolve: resolvePredicateEvaluator,
  }, "1");
  assert.equal(result.verdict, "invalid");
  assert.ok(result.reasons.some((reason) => reason.code === "schema-invalid" && reason.path === "$.input"));
});

test("composition root changes for a new leaf without changing the existing leaf", () => {
  const currentLeaf = CURRENT_PREDICATE_BINDING.compositionLeafDigest;
  const unrelatedLeaf = hash("9");
  assert.notEqual(
    computePredicateCompositionRootDigest([
      currentLeaf,
      unrelatedLeaf,
    ]),
    PREDICATE_COMPOSITION_ROOT_DIGEST,
  );
  assert.equal(resolvePredicateEvaluator(ARTIFACT_LINEAGE_PREDICATE_SPEC.predicateId)?.compositionLeafDigest, currentLeaf);
});

test("composition metadata is attached to the checked module export", () => {
  const entry = RELEASE_ROLE_COMPOSITION.predicateAdapters.find((candidate) => candidate.predicateId === ARTIFACT_LINEAGE_PREDICATE_EVALUATOR.predicateId);
  const generatedEntry = RELEASE_ROLE_MANIFEST.predicateAdapters.find((candidate) => candidate.predicateId === ARTIFACT_LINEAGE_PREDICATE_EVALUATOR.predicateId);
  assert.ok(entry);
  assert.ok(generatedEntry);
  assert.equal(generatedEntry.modulePath, entry.modulePath);
  assert.equal(generatedEntry.exportName, entry.exportName);
  assert.equal(resolvePredicateEvaluator(entry.predicateId)?.evaluator, ARTIFACT_LINEAGE_PREDICATE_EVALUATOR);
});

test("qualification corpus covers positive, fail, invalid, and every declared mutation", () => {
  const classifications = new Set<string>();
  const mutations = new Set<string>();
  for (const material of ARTIFACT_LINEAGE_CASE_MATERIAL) {
    const evaluated = evaluateArtifactLineageCase(material);
    classifications.add(material.classification);
    if (material.mutationId !== null) mutations.add(material.mutationId);
    // This is qualification evidence only. It is never passed to GateCore
    // and therefore cannot create production acceptance credit.
    assert.equal(evaluated.classificationMatchesOracle, true, material.caseId);
    assert.equal(evaluated.predicateMatchesOracle, true, material.caseId);
  }
  assert.deepEqual(classifications, new Set(["positive", "negative", "invalid"]));
  assert.deepEqual([...mutations].sort(), [...ARTIFACT_LINEAGE_MUTATION_IDS].sort());
  const splitPredicateMutationIds = [...new Set([
    ...ARTIFACT_LINEAGE_MUTATION_IDS,
    ...ARTIFACT_LINEAGE_SIDECAR_MUTATION_IDS,
    ...ARTIFACT_LINEAGE_INVOCATION_SEAL_MUTATION_IDS,
  ])].sort();
  assert.deepEqual([...ARTIFACT_LINEAGE_PREDICATE_SPEC.criticalMutationIds].sort(), splitPredicateMutationIds);
});
