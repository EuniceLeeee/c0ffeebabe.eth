import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import {
  hashRuntimeCandidateDeltaPartition,
  hashRuntimeCandidateOutcomePartition,
  hashRuntimeFactRefRoot,
  hashRuntimeGraphViewLeaseObservations,
  evaluateLegacyAuthorityZeroAggregate,
  evaluateLegacyShapedAuthorityZero,
  evaluateRuntimeRestartPredicate,
  evaluateSourceRepositoryProductionClosureZero,
  deriveLegacyAuthorityClosureReceipt,
  sealLegacyAuthorityClosureFacts,
  sealLegacyAuthorityZeroAggregateFacts,
  sealLegacyClosureFact,
  sealLegacyClosureRawArtifact,
  sealLegacyClosureRawDenominator,
  sealLegacyClosureRawEdge,
  sealLegacyClosureRawEntrypoint,
  sealRuntimeFactRef,
  LEGACY_CLOSURE_ROOT_ROLES,
  type LegacyAuthorityClosureFactsV1,
  type RuntimeCandidateDeltaPartitionV1,
  type RuntimeCandidateOutcomeV1,
  type RuntimeFactRefV1,
  type RuntimeRestartFactsV1,
} from "../src/runtime.ts";
import {
  evaluateLegacyAuthorityZeroReferenceModel,
  evaluateLegacyQualificationPairReferenceModel,
  evaluateLegacyShapedAuthorityReferenceModel,
  evaluateRuntimeRestartReferenceModel,
  evaluateSourceRepositoryProductionClosureReferenceModel,
} from "../src/reference-model.ts";
import {
  LEGACY_SHAPED_AUTHORITY_ZERO_CRITICAL_MUTATION_IDS,
  LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC_DIGEST,
  RUNTIME_RESTART_CRITICAL_MUTATION_IDS,
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_CRITICAL_MUTATION_IDS,
  SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC_DIGEST,
} from "../src/spec.ts";
import {
  runLegacyShapedAuthorityZeroMutationRegistry,
  runRuntimeRestartMutationRegistry,
  runSourceRepositoryProductionClosureZeroMutationRegistry,
} from "../src/mutations.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;
const sha = (digit: string): string => digit.repeat(40);

function locator(digit: string) {
  return {
    kind: "content-object" as const,
    storeIdentityHash: h("a"),
    objectKey: h(digit),
  };
}

function factRef(digit: string): RuntimeFactRefV1 {
  return sealRuntimeFactRef({
    artifactRefId: h(digit),
    contentSha256: h(digit),
    byteLength: "1",
    schema: { id: "aloha.test.runtime-fact", version: "1.0.0", schemaHash: h("b") },
    locator: locator(digit),
  });
}

function namedFactRef(name: string): RuntimeFactRefV1 {
  const identity = hashDomain("aloha/test/runtime-acceptance/fact-ref/v1", name);
  return sealRuntimeFactRef({
    artifactRefId: hashDomain("aloha/test/runtime-acceptance/artifact-ref/v1", name),
    contentSha256: hashDomain("aloha/test/runtime-acceptance/content/v1", name),
    byteLength: "1",
    schema: { id: "aloha.test.runtime-fact", version: "1.0.0", schemaHash: h("b") },
    locator: { kind: "content-object", storeIdentityHash: h("a"), objectKey: identity },
  });
}

function processAnchor(pid: string, ticks: string) {
  return {
    systemId: "test-host",
    commitSha: sha("a"),
    executableHash: h("c"),
    deploymentManifestHash: h("d"),
    serviceIdentityHash: h("e"),
    pid,
    processStartTicks: ticks,
    bootIdHash: h("f"),
  };
}

function outcome(
  key: string,
  dependency: string,
  result: RuntimeCandidateOutcomeV1["outcome"],
  resultDigit: string,
  ref: RuntimeFactRefV1,
): RuntimeCandidateOutcomeV1 {
  return {
    candidateKey: h(key),
    runCandidateKey: h(key),
    dependencyClosureRoot: h(dependency),
    outcomeHash: h(resultDigit),
    outcome: result,
    factRefId: ref.factId,
  };
}

function partition(items: readonly RuntimeCandidateOutcomeV1[]) {
  const sorted = [...items].sort((left, right) => left.runCandidateKey.localeCompare(right.runCandidateKey));
  return {
    count: String(sorted.length),
    root: hashRuntimeCandidateOutcomePartition(sorted),
    items: sorted,
  };
}

function delta(
  change: RuntimeCandidateDeltaPartitionV1["change"],
  items: RuntimeCandidateDeltaPartitionV1["items"],
): RuntimeCandidateDeltaPartitionV1 {
  const sorted = [...items].sort((left, right) => left.runCandidateKey.localeCompare(right.runCandidateKey));
  return { change, count: String(sorted.length), root: hashRuntimeCandidateDeltaPartition(change, sorted), items: sorted };
}

function runtimeFacts(): RuntimeRestartFactsV1 {
  const refs = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(factRef);
  const ref = (index: number): RuntimeFactRefV1 => refs[index % refs.length]!;
  const beforeAnchor = processAnchor("100", "10");
  const afterAnchor = processAnchor("200", "20");
  const source = { chainId: "1", number: "100", hash: h("1"), stateRoot: h("2") };
  const before = {
    runtimeCommitSha: sha("a"),
    processAnchorHash: hashDomain("aloha/process-anchor/v1", beforeAnchor),
    processAnchor: beforeAnchor,
    systemdUnit: "aloha-searcher.service",
    systemdExecStartHash: h("3"),
    executableHash: h("c"),
    logAnchor: { systemId: "test-host", bootIdHash: h("f"), device: "1", inode: "10", startInclusive: "1", endExclusive: "100", contentSha256: h("4") },
    sourceAnchor: source,
    releaseIntentRoot: h("5"),
    definitionCatalogRoot: h("6"),
    sourceCoverageRoot: h("d"),
    strategyCatalogRoot: h("7"),
    instanceCatalogRoot: h("8"),
    graphRoot: h("9"),
    readyRecordHash: h("a"),
    generationId: "generation-1",
    factRefId: ref(0).factId,
  };
  const after = {
    ...before,
    processAnchorHash: hashDomain("aloha/process-anchor/v1", afterAnchor),
    processAnchor: afterAnchor,
    logAnchor: { ...before.logAnchor, inode: "11", contentSha256: h("a") },
    factRefId: ref(1).factId,
  };
  const previous = partition([
    outcome("1", "1", "verified", "1", ref(2)),
    outcome("2", "2", "rejected", "2", ref(3)),
    outcome("4", "4", "verified", "4", ref(4)),
  ]);
  const current = partition([
    outcome("1", "1", "verified", "1", ref(2)),
    outcome("3", "3", "verified", "3", ref(5)),
    outcome("4", "5", "retryable", "5", ref(6)),
    outcome("5", "6", "retryable", "6", ref(7)),
  ]);
  const difference = {
    previousCandidates: previous,
    currentCandidates: current,
    memoReused: delta("memo-reused", [{ candidateKey: h("1"), runCandidateKey: h("1"), previousDependencyClosureRoot: h("1"), currentDependencyClosureRoot: h("1"), previousOutcomeHash: h("1"), currentOutcomeHash: h("1"), factRefId: ref(2).factId }]),
    newCandidates: delta("new", [{ candidateKey: h("3"), runCandidateKey: h("3"), previousDependencyClosureRoot: null, currentDependencyClosureRoot: h("3"), previousOutcomeHash: null, currentOutcomeHash: h("3"), factRefId: ref(5).factId }]),
    invalidatedDependencyClosure: delta("invalidated-dependency", [{ candidateKey: h("4"), runCandidateKey: h("4"), previousDependencyClosureRoot: h("4"), currentDependencyClosureRoot: h("5"), previousOutcomeHash: h("4"), currentOutcomeHash: h("5"), factRefId: ref(6).factId }]),
    retryable: delta("retryable", [{ candidateKey: h("5"), runCandidateKey: h("5"), previousDependencyClosureRoot: null, currentDependencyClosureRoot: h("6"), previousOutcomeHash: null, currentOutcomeHash: h("6"), factRefId: ref(7).factId }]),
    rejectionNotReused: delta("rejection-not-reused", [{ candidateKey: h("2"), runCandidateKey: h("2"), previousDependencyClosureRoot: h("2"), currentDependencyClosureRoot: null, previousOutcomeHash: h("2"), currentOutcomeHash: null, factRefId: ref(3).factId }]),
    unchangedOldInstanceAttestations: delta("unchanged-old-instance-attestation", []),
    factRefId: ref(8).factId,
  };
  const probeBefore = partition([outcome("1", "1", "verified", "1", ref(2)), outcome("3", "3", "verified", "3", ref(5))]);
  const probeAfter = partition([outcome("1", "1", "verified", "8", ref(2)), outcome("3", "3", "verified", "3", ref(5))]);
  const singleTargetProbe = {
    targetRunCandidateKey: h("1"),
    beforeOutcomes: probeBefore,
    afterOutcomes: probeAfter,
    changedRunCandidateKeys: { count: "1", root: hashDomain("aloha/runtime-acceptance/hash-partition/v1", [h("1")]), items: [h("1")] },
    targetBeforeOutcomeHash: h("1"),
    targetAfterOutcomeHash: h("8"),
    factRefId: ref(0).factId,
  };
  const durable = partition([outcome("1", "1", "verified", "1", ref(2))]);
  const sigtermRecovery = {
    observedSignal: "SIGTERM" as const,
    signalProcessAnchorHash: before.processAnchorHash,
    flushedOutcomes: durable,
    afterRestartOutcomes: durable,
    durableOutcomeRoot: durable.root,
    factRefId: ref(1).factId,
  };
  const graphViewLeaseObservations = [{
    eventType: "head-coverage" as const,
    eventId: h("c"),
    processAnchorHash: after.processAnchorHash,
    pid: after.processAnchor.pid,
    processStartTicks: after.processAnchor.processStartTicks,
    generationId: after.generationId,
    graphRoot: after.graphRoot,
    readyRecordHash: after.readyRecordHash,
    sourceCoverageRoot: after.sourceCoverageRoot,
    headHash: h("e"),
  }];
  const graphReuse = {
    mode: "direct-reuse" as const,
    beforeGraphRoot: before.graphRoot,
    afterGraphRoot: after.graphRoot,
    beforeReadyRecordHash: before.readyRecordHash,
    afterReadyRecordHash: after.readyRecordHash,
    graphViewLeaseObservations,
    graphViewLeaseRoot: hashRuntimeGraphViewLeaseObservations(graphViewLeaseObservations),
    factRefId: ref(2).factId,
  };
  return {
    schemaVersion: 1,
    kind: "aloha.runtime-restart-facts",
    before,
    after,
    graphReuse,
    difference,
    singleTargetProbe,
    sigtermRecovery,
    factRefs: refs,
    factRefsRoot: hashRuntimeFactRefRoot(refs),
  };
}

/** Data-only contract specimen; it is not production/live observer evidence. */
function legacyEvidence(
  predicateSpecDigests: readonly [Hash, Hash] = [
    SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC_DIGEST,
    LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC_DIGEST,
  ],
  qualificationCertificateIds: readonly [Hash, Hash] = [h("f"), h("1")],
): LegacyAuthorityClosureFactsV1 {
  const artifactRefs: RuntimeFactRefV1[] = [];
  const artifact = (name: string, logicalKey: string) => {
    const ref = namedFactRef(name);
    artifactRefs.push(ref);
    return sealLegacyClosureRawArtifact({
      logicalKey,
      contentSha256: ref.contentSha256,
      byteLength: ref.byteLength,
      factRefId: ref.factId,
      locatorId: ref.locatorId,
      locator: ref.locator,
    });
  };
  const boundary = artifact("boundary", "candidate/neutral/boundary/commit");
  const binding = artifact("binding", "external/strict-authority/runtime-release-binding/binding.json");
  const approval = artifact("approval", "external/strict-authority/release-authority-approval/approval.json");
  const manifest = artifact("manifest", "external/neutral/deployment-manifest/manifest.json");
  const bundle = artifact("bundle", "external/neutral/runtime-bundle/bundle.mjs");
  const composition = artifact("composition", "external/neutral/deployment-composition/composition.mjs");
  const sourceConfig = artifact("source-config", "external/neutral/deployment-source/source.json");
  const runtimePolicy = artifact("runtime-policy", "external/neutral/runtime-policy/policy.json");
  const executorState = artifact("executor-state", "external/neutral/executor-state/executor.json");
  const releaseIntent = artifact("release-intent", "external/neutral/release-intent/release.json");
  const candidateProof = artifact("candidate-proof", "external/neutral/candidate-proof-verifier/proof.json");
  const releaseEnvironment = artifact("release-environment", "external/neutral/release-environment/release.env");
  const unit = artifact("unit", "external/neutral/systemd-unit/aloha.service");
  const database = artifact("database", "external/neutral/runtime-sqlite/runtime.sqlite");
  const ready = artifact("ready", "external/neutral/runtime-event/aloha.runtime-process-ready-event");
  const main = artifact("main", "external/neutral/main-executable/node");
  const child = artifact("child", "external/neutral/child-executable/revm-worker");
  const loaded = artifact("loaded", "external/neutral/loaded-object/libc.so");
  const log = artifact("log", "external/neutral/runtime-log-window/runtime.log");
  const artifacts = [boundary, binding, approval, manifest, bundle, composition, sourceConfig, runtimePolicy, executorState, releaseIntent, candidateProof, releaseEnvironment, unit, database, ready, main, child, loaded, log];
  const edge = (relation: Parameters<typeof sealLegacyClosureRawEdge>[0]["relation"], source: typeof boundary, target: typeof boundary) => sealLegacyClosureRawEdge({
    relation,
    sourceArtifactId: source.artifactId,
    targetArtifactId: target.artifactId,
    targetLogicalKey: target.logicalKey,
    locatorId: source.locatorId,
    locator: source.locator,
  });
  const edges = [
    edge("binds", boundary, binding),
    edge("binds", binding, approval),
    edge("binds", approval, manifest),
    edge("binds", manifest, bundle),
    edge("binds", manifest, composition),
    edge("binds", manifest, sourceConfig),
    edge("binds", manifest, runtimePolicy),
    edge("binds", manifest, executorState),
    edge("binds", manifest, releaseIntent),
    edge("binds", manifest, candidateProof),
    edge("binds", manifest, releaseEnvironment),
    edge("deploys", manifest, unit),
    edge("executes", unit, main),
    edge("emits", database, ready),
    edge("binds", ready, main),
    edge("binds", ready, bundle),
    edge("emits", ready, log),
    edge("spawns", main, child),
    edge("loads", main, loaded),
    edge("loads", child, loaded),
  ];
  const entrypoint = sealLegacyClosureRawEntrypoint({
    entrypointKind: "consumer",
    logicalKey: ready.logicalKey,
    artifactId: ready.artifactId,
    locatorId: ready.locatorId,
    locator: ready.locator,
  });
  const closureRefs = LEGACY_CLOSURE_ROOT_ROLES.map((role) => namedFactRef(`closure:${role}`));
  const closures = LEGACY_CLOSURE_ROOT_ROLES.map((role, index) => {
    const complete = role === "consumer-object-lineage" || role === "production-entrypoint-denominator";
    return sealLegacyClosureFact({
      role,
      entrypointIds: complete ? [entrypoint.entrypointId] : [],
      artifactIds: complete ? artifacts.map((item) => item.artifactId) : [boundary.artifactId],
      edgeIds: complete ? edges.map((item) => item.edgeId) : [],
      factRefId: closureRefs[index]!.factId,
    });
  });
  const denominator = sealLegacyClosureRawDenominator({ artifacts, edges, entrypoints: [entrypoint], closures });
  const receipt = deriveLegacyAuthorityClosureReceipt(predicateSpecDigests, qualificationCertificateIds, denominator);
  return sealLegacyAuthorityClosureFacts(receipt, [...artifactRefs, ...closureRefs], denominator);
}

function legacyQualificationBindings(
  sourceSpec = SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC_DIGEST,
  shapedSpec = LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC_DIGEST,
  sourceCertificate = h("f"),
  shapedCertificate = h("1"),
) {
  return Object.freeze([
    Object.freeze({ predicateId: "aloha.source-repository-production-closure-zero", predicateSpecDigest: sourceSpec, verifierQualificationId: sourceCertificate }),
    Object.freeze({ predicateId: "aloha.legacy-shaped-authority-zero", predicateSpecDigest: shapedSpec, verifierQualificationId: shapedCertificate }),
  ]);
}

test("restart facts are content-addressed and independent model agrees", () => {
  const facts = runtimeFacts();
  const live = evaluateRuntimeRestartPredicate(facts);
  const oracle = evaluateRuntimeRestartReferenceModel(facts);
  assert.equal(live.verdict, "pass");
  assert.equal(oracle.verdict, "pass");
});

test("every restart critical mutation is rejected or invalid", () => {
  const facts = runtimeFacts();
  const runs = runRuntimeRestartMutationRegistry(facts);
  assert.deepEqual(runs.map((run) => run.id), [...RUNTIME_RESTART_CRITICAL_MUTATION_IDS]);
  for (const run of runs) {
    const live = evaluateRuntimeRestartPredicate(run.mutated);
    const oracle = evaluateRuntimeRestartReferenceModel(run.mutated);
    assert.notEqual(live.verdict, "pass", run.id);
    assert.equal(live.verdict, oracle.verdict, run.id);
  }
});

test("two legacy-zero predicates qualify independently and aggregate only by AND", () => {
  const evidence = legacyEvidence();
  const aggregate = sealLegacyAuthorityZeroAggregateFacts(evidence);
  assert.equal(evaluateSourceRepositoryProductionClosureZero(evidence).verdict, "pass");
  assert.equal(evaluateLegacyShapedAuthorityZero(evidence).verdict, "pass");
  assert.equal(evaluateLegacyAuthorityZeroAggregate(aggregate).verdict, "pass");
  assert.equal(evaluateLegacyAuthorityZeroReferenceModel(aggregate).verdict, "pass");
  assert.equal(evaluateSourceRepositoryProductionClosureReferenceModel(evidence).verdict, "pass");
  assert.equal(evaluateLegacyShapedAuthorityReferenceModel(evidence).verdict, "pass");
  assert.equal(evaluateSourceRepositoryProductionClosureZero(evidence.receipt).verdict, "invalid");
  assert.equal(evaluateLegacyShapedAuthorityZero(evidence.receipt).verdict, "invalid");
  assert.equal(SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_CRITICAL_MUTATION_IDS.length, 21);
  assert.equal(LEGACY_SHAPED_AUTHORITY_ZERO_CRITICAL_MUTATION_IDS.length, 22);
});

test("qualification reference model exact-binds the current ordered closure pair", () => {
  const evidence = legacyEvidence();
  assert.equal(evaluateLegacyQualificationPairReferenceModel(evidence, legacyQualificationBindings()).verdict, "pass");
  assert.equal(evaluateLegacyQualificationPairReferenceModel(
    legacyEvidence([
      LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC_DIGEST,
      SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC_DIGEST,
    ]),
    legacyQualificationBindings(),
  ).verdict, "invalid");
  assert.equal(evaluateLegacyQualificationPairReferenceModel(
    legacyEvidence([h("d"), h("e")]),
    legacyQualificationBindings(),
  ).verdict, "invalid");
  assert.equal(evaluateLegacyQualificationPairReferenceModel(
    legacyEvidence(undefined, [h("2"), h("3")]),
    legacyQualificationBindings(),
  ).verdict, "invalid");
  assert.equal(evaluateLegacyQualificationPairReferenceModel(
    evidence,
    legacyQualificationBindings(
      LEGACY_SHAPED_AUTHORITY_ZERO_PREDICATE_SPEC_DIGEST,
      SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_PREDICATE_SPEC_DIGEST,
      h("1"),
      h("f"),
    ),
  ).verdict, "invalid");
});

test("legacy mutation registries are exact and independent", () => {
  const evidence = legacyEvidence();
  const sourceRuns = runSourceRepositoryProductionClosureZeroMutationRegistry(evidence);
  const shapedRuns = runLegacyShapedAuthorityZeroMutationRegistry(evidence);
  assert.deepEqual(sourceRuns.map((run) => run.id), [...SOURCE_REPOSITORY_PRODUCTION_CLOSURE_ZERO_CRITICAL_MUTATION_IDS]);
  assert.deepEqual(shapedRuns.map((run) => run.id), [...LEGACY_SHAPED_AUTHORITY_ZERO_CRITICAL_MUTATION_IDS]);
  for (const run of sourceRuns) {
    const live = evaluateSourceRepositoryProductionClosureZero(run.mutated);
    const oracle = evaluateSourceRepositoryProductionClosureReferenceModel(run.mutated);
    assert.notEqual(live.verdict, "pass", run.id);
    assert.equal(live.verdict, oracle.verdict, run.id);
  }
  for (const run of shapedRuns) {
    const live = evaluateLegacyShapedAuthorityZero(run.mutated);
    const oracle = evaluateLegacyShapedAuthorityReferenceModel(run.mutated);
    assert.notEqual(live.verdict, "pass", run.id);
    assert.equal(live.verdict, oracle.verdict, run.id);
  }
});

test("unresolved refs are invalid while observed authority refs fail", () => {
  const evidence = legacyEvidence();
  const unresolved = runSourceRepositoryProductionClosureZeroMutationRegistry(evidence).find((run) => run.id === "unresolved-entrypoint-ref")!;
  assert.equal(evaluateSourceRepositoryProductionClosureZero(unresolved.mutated).verdict, "invalid");
  const old = runSourceRepositoryProductionClosureZeroMutationRegistry(evidence).find((run) => run.id === "old-repository-load-bearing-ref")!;
  assert.equal(evaluateSourceRepositoryProductionClosureZero(old.mutated).verdict, "fail");
  const shaped = runLegacyShapedAuthorityZeroMutationRegistry(evidence).find((run) => run.id === "forbidden-authority-ref")!;
  assert.equal(evaluateLegacyShapedAuthorityZero(shaped.mutated).verdict, "fail");
});

test("legacy closure evidence cross-checks every raw language/runtime root", () => {
  const evidence = legacyEvidence();
  assert.equal(evaluateSourceRepositoryProductionClosureZero(evidence).verdict, "pass");
  for (const id of ["release-intent-root", "entrypoint-denominator", "ts-js-ast-closure-root", "generated-package-alias-root", "worker-child-dynamic-entrypoint-root", "rust-binary-closure-root", "solidity-deployment-abi-root", "deploy-systemd-exec-root", "executable-loaded-object-root", "consumer-object-lineage-root", "runtime-log-window-root"] as const) {
    const mutation = runSourceRepositoryProductionClosureZeroMutationRegistry(evidence).find((run) => run.id === id)!;
    const forged = mutation.mutated as { readonly receipt: LegacyAuthorityClosureFactsV1["receipt"] };
    assert.notEqual(forged.receipt.receiptId, evidence.receipt.receiptId, `${id}: receiptId must be self-consistently recomputed`);
    assert.equal(evaluateSourceRepositoryProductionClosureZero(mutation.mutated).verdict, "invalid", id);
  }
});

test("self-consistent consumer lineage rewrites remain invalid", () => {
  const evidence = legacyEvidence();
  const ids = [
    "consumer-lineage-edge-deletion",
    "consumer-lineage-endpoint-replacement",
    "consumer-lineage-direction-splice",
    "consumer-lineage-orphan-endpoint",
  ];
  for (const id of ids) {
    const mutated = runSourceRepositoryProductionClosureZeroMutationRegistry(evidence).find((run) => run.id === id)!.mutated as LegacyAuthorityClosureFactsV1;
    assert.notEqual(mutated.denominator.denominatorId, evidence.denominator.denominatorId, `${id}: denominator must be recomputed`);
    assert.notEqual(mutated.receipt.receiptId, evidence.receipt.receiptId, `${id}: receipt must be recomputed`);
    assert.notEqual(mutated.evidenceId, evidence.evidenceId, `${id}: evidence must be recomputed`);
    assert.equal(evaluateSourceRepositoryProductionClosureZero(mutated).verdict, "invalid", id);
    assert.equal(evaluateSourceRepositoryProductionClosureReferenceModel(mutated).verdict, "invalid", id);
  }
});

test("raw denominator is exact-keyed, host-path-free, and mandatory", () => {
  const evidence = legacyEvidence();
  assert.equal(evaluateSourceRepositoryProductionClosureZero({ ...evidence, denominator: undefined }).verdict, "invalid");
  assert.equal(evaluateSourceRepositoryProductionClosureZero({ ...evidence, extra: true }).verdict, "invalid");
  const artifact = evidence.denominator.artifacts[0]!;
  assert.equal(evaluateSourceRepositoryProductionClosureZero({ ...evidence, denominator: { ...evidence.denominator, artifacts: [{ ...artifact, logicalKey: "/private/tmp/forbidden.ts" }] } }).verdict, "invalid");
});
