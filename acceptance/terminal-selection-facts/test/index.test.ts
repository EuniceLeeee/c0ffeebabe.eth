import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createArtifactResolutionClaim,
  createResolverPolicy,
  createRetentionLeaseReceipt,
  decodeArtifactBytes,
  encodeArtifactBytes,
} from "../../../specs/artifact-resolution/src/index.ts";
import { createReadOnlyArtifactRef } from "../../../specs/core-envelope/src/index.ts";
import { decodeEvidenceEvent, EVIDENCE_SCHEMA_MANIFESTS } from "../../../specs/evidence/src/index.ts";
import {
  createRawTerminalSelectionObservationV1,
  createTerminalSelectionFactV1,
  createTerminalSelectionMissingFactV1,
  decodeRawTerminalSelectionObservationV1,
  decodeTerminalSelectionManifestV1,
  decodeTerminalSelectionProcessEvidenceV1,
  evaluateTerminalSelectionPredicate,
  terminalSelectionProcessAnchorRoot,
  terminalSelectionRuntimeAnchorRoot,
  TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS,
  type RawTerminalSelectionObservationV1,
  type TerminalSelectionFullFamilyProjectionV1,
  type TerminalSelectionManifestV1,
  type TerminalSelectionProcessEvidenceV1,
  type TerminalSelectionRuntimeFactsV1,
} from "../src/runtime.ts";
import { TERMINAL_SELECTION_INVOCATION_SEAL_ROLE } from "../src/spec.ts";
import { evaluateTerminalSelectionReferenceModel } from "../src/reference-model.ts";
import {
  assertQualifiedTerminalSelectionCertificate,
  qualifyTerminalSelectionCorpus,
  TERMINAL_SELECTION_CRITICAL_MUTATION_IDS,
  TERMINAL_SELECTION_MUTATION_REGISTRY,
  TERMINAL_SELECTION_MUTATION_REGISTRY_DIGEST,
  TERMINAL_SELECTION_PREDICATE_SPEC,
  validateTerminalSelectionMutationCorpus,
  type TerminalSelectionMutationMutatorV1,
  type TerminalSelectionQualificationCertificateV1,
  type TerminalSelectionQualificationFixtureV1,
} from "../src/qualification.ts";
import { decodeProductionTerminalPhaseManifestV1 } from "../../collectors/src/terminal-phase-locator-index.ts";
import { decodeProductionTerminalPhaseFullFamilyProjectionV1 } from "../../collectors/src/terminal-phase-full-family-projection.ts";

const commit = "1234567890abcdef1234567890abcdef12345678";
const h = (value: string): Hash => hashDomain("test/terminal-selection/v1", value);
const selectionPolicyDigest = hashDomain(
  "aloha/searcher-production-six-step-window-selection-policy/v1",
  Object.freeze({
    denominator: "active-exact-100-performance-window",
    eligibility: "complete-successful-dry-run",
    order: Object.freeze(["ordinal", "lane:blockscan-before-backrun", "candidate-stable-key", "producer-terminal-id"]),
    selection: "first",
  }),
);

const policy = createResolverPolicy({
  schemaVersion: 1,
  kind: "aloha.artifact-resolver-policy",
  allowedLocatorKind: "content-object",
  digestAlgorithm: "sha256",
  maxByteLength: "1048576",
  requireExactLengthMediaAndSchema: true,
  minimumRemainingStoreEpochs: "0",
  failureOutcome: "invalid",
});

function append(namespace: string, label: string) {
  return Object.freeze({
    namespace,
    sequence: "1",
    eventId: h(`${label}-event`),
    contentSha256: h(`${label}-content`),
    byteLength: "100",
    offsetStart: "0",
    offsetEnd: "100",
    fsynced: true as const,
  });
}

function appendId(value: TerminalSelectionProcessEvidenceV1["durableAppend"]): Hash {
  return hashDomain("aloha/searcher-production-six-step-durable-append/v1", value);
}

function processEvidence(): TerminalSelectionProcessEvidenceV1 {
  const runtimeAnchor = Object.freeze({
    kind: "aloha.searcher-runtime-anchor-v1" as const,
    manifestHash: h("manifest-hash"),
    manifestArtifactSha256: h("manifest-sha"),
    bindingId: h("binding"),
    releaseProvenanceHash: h("release"),
    candidateReleaseCommit: commit,
    runtimeArtifactRoot: h("runtime-artifacts"),
    implementationClosureDigest: h("implementation"),
    entrypointSha256: h("entrypoint"),
    nodeExecutableSha256: h("node"),
    bundleModulePath: "/opt/aloha/runtime.mjs",
    bundleModuleSha256: h("bundle"),
    serviceName: "aloha",
    systemdUnit: "aloha.service",
    bootId: "boot",
    invocationId: "invocation",
    logDevice: "1",
    logInode: "2",
    pid: "3",
    processStartTicks: "4",
    dryRun: true as const,
  });
  const durableAppend = append("searcher-production-evidence/performance/v1", "performance");
  const producerTerminalDurableAppend = append("searcher-production-evidence/producer-terminals/v1", "producer");
  const stage12 = Object.freeze({ root: h("stage12-body") });
  const runtimeFacts = Object.freeze({ root: h("runtime-facts-body") });
  const producerSchedulerJoin = Object.freeze({
    correlationId: h("correlation"),
    generationId: "generation-1",
    source: Object.freeze({ chainId: "1", number: "100", hash: h("head"), stateRoot: h("state") }),
    programHash: h("program"),
    finalSimulationReceiptHash: h("final-sim"),
    dryRunCandidateId: h("dry-run-candidate"),
    dryRunLineageHash: h("dry-run-lineage"),
  });
  const stage12Root = hashDomain("aloha/searcher-production-evidence-stage12/v1", stage12 as unknown as CanonicalJson);
  const traceRoot = h("trace");
  const core = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.searcher-production-six-step-process-evidence-v1" as const,
    runtimeBindingId: runtimeAnchor.bindingId,
    candidateReleaseCommit: commit,
    releaseProvenanceHash: runtimeAnchor.releaseProvenanceHash,
    terminalBindingRoot: h("terminal-binding"),
    traceRoot,
    correlationId: h("correlation"),
    generationId: "generation-1",
    readyRecordHash: h("ready"),
    graphRoot: h("graph"),
    currentSource: Object.freeze({ chainId: "1", number: "100", hash: h("head"), stateRoot: h("state") }),
    programHash: h("program"),
    finalSimulationReceiptHash: h("final-sim"),
    stage12,
    stage12Root,
    sixStepLineageRoot: hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", {
      stage12Root,
      stage36Root: traceRoot,
    }),
    runtimeFacts,
    runtimeFactsRoot: hashDomain("aloha/searcher-production-six-step-runtime-facts/v1", runtimeFacts as unknown as CanonicalJson),
    producerSchedulerJoin,
    producerSchedulerJoinRoot: hashDomain("aloha/searcher-production-six-step-producer-scheduler-join/v1", producerSchedulerJoin as unknown as CanonicalJson),
    runtimeAnchor,
    runtimeAnchorRoot: hashDomain("aloha/searcher-production-six-step-runtime-anchor/v1", runtimeAnchor as unknown as CanonicalJson),
    serving: Object.freeze({ generationId: "generation-1", graphRoot: h("graph"), readyRecordHash: h("ready"), sourceCoverageRoot: h("coverage") }),
    canonicalHead: Object.freeze({ chainId: "1", number: "100", hash: h("head"), parentHash: h("parent"), stateRoot: h("state") }),
    admissionId: h("admission"),
    producerTerminalId: h("producer-terminal"),
    producerTerminalBindingRoot: h("producer-terminal-binding"),
    durableAppend,
    durableAppendRecordId: appendId(durableAppend),
    producerTerminalDurableAppend,
    producerTerminalDurableAppendRecordId: appendId(producerTerminalDurableAppend),
  });
  return Object.freeze({
    ...core,
    evidenceRoot: hashDomain("aloha/searcher-production-six-step-process-evidence/v1", core as unknown as CanonicalJson),
  });
}

function fullFamilyProjection(process: TerminalSelectionProcessEvidenceV1): TerminalSelectionFullFamilyProjectionV1 {
  const core = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.production-terminal-phase-full-family-projection-v1" as const,
    status: "observed" as const,
    finalDurableWindowId: h("final-window"),
    readyRecordHash: process.readyRecordHash,
    auditRoot: h("full-family-audit"),
    fullGraphCoarseSweepRoot: h("sweep"),
    producerTerminalBindingRoot: process.producerTerminalBindingRoot,
    laneTerminalSetRoot: h("lane-terminal-set"),
    bundleContentSha256: h("family-bundle"),
    locatorContentSha256: h("family-locator"),
    missing: Object.freeze([]),
  });
  return Object.freeze({
    ...core,
    observationRoot: hashDomain("aloha/production-terminal-phase-full-family-projection/v1", core as unknown as CanonicalJson),
  });
}

function terminalManifest(
  process: TerminalSelectionProcessEvidenceV1,
  selection: RawTerminalSelectionObservationV1["selection"],
  projectionArtifact: ReturnType<typeof artifact>,
  projection: TerminalSelectionFullFamilyProjectionV1,
  predicateArtifacts: readonly ReturnType<typeof artifact>[],
): TerminalSelectionManifestV1 {
  const fullFamily = Object.freeze({
    projectionArtifactRefId: projectionArtifact.ref.artifactRefId,
    projectionContentSha256: projectionArtifact.ref.contentSha256,
  });
  const predicateArtifactRoot = hashDomain("aloha/production-six-step-predicate-artifact-closure/v1", predicateArtifacts.map(value => ({
    artifactRefId: value.ref.artifactRefId,
    contentSha256: value.ref.contentSha256,
    claimId: value.claim.claimId,
    leaseReceiptId: value.lease.receiptId,
  })));
  const sixStep = selection.selectedIndex === null
    ? Object.freeze({
        status: "missing" as const,
        observationRoot: h("six-step-observation-missing"),
        windowSelectionRoot: selection.selectionRoot,
        selectionPolicyDigest: selection.selectionPolicyDigest,
        eligibleSuccessCount: "0" as const,
        eligibleSuccessRoot: selection.eligibleSuccessRoot,
        selectedIndex: null,
        selectedProducerTerminalId: null,
        reason: "no-successful-dry-run" as const,
        joinedProcessEvidenceRoot: null,
        performanceAppendRecordId: null,
        producerTerminalAppendRecordId: null,
        predicateArtifactCount: "0",
        predicateArtifactRoot,
        eventArtifactRefIds: Object.freeze([]),
      })
    : Object.freeze({
        status: "observed" as const,
        observationRoot: h("six-step-observation"),
        windowSelectionRoot: selection.selectionRoot,
        selectionPolicyDigest: selection.selectionPolicyDigest,
        eligibleSuccessCount: selection.eligibleSuccessCount,
        eligibleSuccessRoot: selection.eligibleSuccessRoot,
        selectedIndex: "0" as const,
        selectedProducerTerminalId: selection.selectedProducerTerminalId,
        reason: null,
        joinedProcessEvidenceRoot: process.evidenceRoot,
        performanceAppendRecordId: process.durableAppendRecordId,
        producerTerminalAppendRecordId: process.producerTerminalDurableAppendRecordId,
        predicateArtifactCount: String(predicateArtifacts.length),
        predicateArtifactRoot,
        eventArtifactRefIds: Object.freeze(predicateArtifacts.map(value => value.ref.artifactRefId).sort()),
      });
  const core = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.production-terminal-phase-manifest-v1" as const,
    finalDurableWindowId: selection.finalDurableWindowId,
    windowId: h("window"),
    releaseAnchorRoot: hashDomain("aloha/production-terminal-phase-release-anchor/v1", {
      bindingId: process.runtimeBindingId,
      releaseProvenanceHash: process.releaseProvenanceHash,
      candidateReleaseCommit: process.candidateReleaseCommit,
    }),
    runtimeAnchorRoot: terminalSelectionRuntimeAnchorRoot(process),
    runtimeArtifactRoot: process.runtimeAnchor.runtimeArtifactRoot,
    processAnchorRoot: terminalSelectionProcessAnchorRoot(process),
    fullGraphCoarseSweepRoot: projection.fullGraphCoarseSweepRoot,
    terminalPhaseInvocationRoot: h("placeholder"),
    fullFamily,
    sixStep,
  });
  const terminalPhaseInvocationRoot = hashDomain("aloha/production-terminal-phase-invocation/v1", {
    finalDurableWindowId: core.finalDurableWindowId,
    fullGraphCoarseSweepRoot: core.fullGraphCoarseSweepRoot,
    fullFamilyObservationRoot: projection.observationRoot,
    sixStepObservationRoot: sixStep.observationRoot,
    releaseAnchorRoot: core.releaseAnchorRoot,
    runtimeAnchorRoot: core.runtimeAnchorRoot,
    runtimeArtifactRoot: core.runtimeArtifactRoot,
    processAnchorRoot: core.processAnchorRoot,
  });
  const payload = Object.freeze({ ...core, terminalPhaseInvocationRoot });
  return Object.freeze({
    ...payload,
    manifestRoot: hashDomain("aloha/production-terminal-phase-manifest/v1", payload as unknown as CanonicalJson),
  });
}

function sixStepEventArtifactValue(label = "only") {
  const rawBoundaryArtifactRef = artifact(
    encodeCanonicalBytes({ kind: "terminal-test-raw-boundary" }),
    TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.rawSelection,
    `six-step-event-raw-boundary-${label}`,
  ).ref;
  const capability = Object.freeze({
    capabilityId: "terminal-test-capability",
    version: "1.0.0",
    schemaHash: h("event-capability-schema"),
    interpreterHash: h("event-capability-interpreter"),
  });
  const inputSchema = Object.freeze({ id: "terminal-test-input", version: "1.0.0", schemaHash: h("event-input-schema") });
  const factSchema = Object.freeze({ id: "terminal-test-fact", version: "1.0.0", schemaHash: h("event-fact-schema") });
  const inputs = Object.freeze({ inputRoot: h("event-input") });
  const facts = Object.freeze({ factRoot: h("event-fact") });
  const core = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.fact-evidence-event" as const,
    source: Object.freeze({ systemId: "aloha/aloha.service", emitterKind: "native" as const, emitterCodeHash: h("event-emitter"), rawBoundaryArtifactRef }),
    runtime: Object.freeze({ commitSha: commit, executableHash: h("event-executable"), deploymentManifestHash: h("event-deployment"), serviceIdentityHash: h("event-service"), pid: "3", processStartTicks: "4", bootIdHash: h("event-boot"), logRangeArtifactRefId: h("event-log-ref") }),
    artifactLineage: Object.freeze({ inputArtifactIds: Object.freeze([h("event-input-artifact")]), outputArtifactId: h("event-output-artifact"), productionReceiptId: h("event-receipt") }),
    scope: Object.freeze({ kind: "producer-session" as const, builderRunId: "builder-run", producerSessionId: "producer-session", generationId: "generation-1", generationRefreshPolicyHash: h("event-refresh") }),
    correlationId: `terminal-test-correlation-${label}`,
    runSequence: "6",
    cutoff: Object.freeze({ number: "100", hash: h("event-cutoff"), stateRoot: h("event-cutoff-state") }),
    definitionCatalogRoot: h("event-definition-catalog"),
    strategyCatalogRoot: h("event-strategy-catalog"),
    instanceCatalogRoot: h("event-instance-catalog"),
    graphRoot: h("event-graph"),
    familyId: "terminal-test-family",
    candidateKey: `terminal-test-candidate-${label}`,
    familyDefinitionHash: h("event-family-definition"),
    capabilities: Object.freeze([capability]),
    capabilitySetHash: hashDomain("aloha/capability-set/v1", [capability]),
    instanceKey: "terminal-test-instance",
    stage: Object.freeze({ ordinal: 6 as const, id: "final_simulation" as const, version: 1 as const }),
    parentEventIds: Object.freeze([h("event-parent")]),
    parentOutputHashes: Object.freeze([h("event-parent-output")]),
    inputSchema,
    inputs,
    inputHash: hashDomain("aloha/stage-input/v1", { stageId: "final_simulation", inputSchema, inputs }),
    factSchema,
    facts,
    outputHash: hashDomain("aloha/stage-output/v1", { stageId: "final_simulation", factSchema, facts, outcome: "success", reasonCode: null }),
    outcome: "success" as const,
    reasonCode: null,
    latency: Object.freeze({ startedMonotonicNs: "1000", finishedMonotonicNs: "2000", durationUs: "1000" }),
    extensions: Object.freeze([]),
  });
  return decodeEvidenceEvent(Object.freeze({
    ...core,
    eventId: hashDomain("aloha/evidence-event/v1", core as unknown as CanonicalJson),
  }));
}

function rawSelection(selected: boolean): RawTerminalSelectionObservationV1 {
  const selection = selected
    ? Object.freeze({
        finalDurableWindowId: h("final-window"),
        selectionPolicyDigest,
        eligibleSuccessCount: "1",
        eligibleSuccessRoot: h("eligible-successes"),
        selectedIndex: "0" as const,
        selectedProducerTerminalId: h("producer-terminal"),
        selectedPerformanceEventId: h("performance-event"),
        selectedProducerTerminalEventId: h("producer-event"),
        selectionRoot: h("selection"),
      })
    : Object.freeze({
        finalDurableWindowId: h("final-window"),
        selectionPolicyDigest,
        eligibleSuccessCount: "0" as const,
        eligibleSuccessRoot: h("no-eligible-successes"),
        selectedIndex: null,
        selectedProducerTerminalId: null,
        selectedPerformanceEventId: null,
        selectedProducerTerminalEventId: null,
        selectionRoot: h("missing-selection"),
      });
  return createRawTerminalSelectionObservationV1({
    databaseSha256Before: h("database"),
    databaseSha256After: h("database"),
    storageSetRootBefore: h("storage"),
    storageSetRootAfter: h("storage"),
    sqliteSchemaRoot: h("sqlite-schema"),
    rawRowRoot: h("raw-rows"),
    eventRoot: h("events"),
    terminalPhaseRowCount: "0",
    terminalPhaseRowRoot: hashDomain("aloha/raw-production-terminal-phase-row-root/v1", []),
    release: Object.freeze({ bindingId: h("binding"), releaseProvenanceHash: h("release"), candidateReleaseCommit: commit }),
    serving: Object.freeze({ generationId: "generation-1", graphRoot: h("graph"), readyRecordHash: h("ready"), sourceCoverageRoot: h("coverage") }),
    selection,
  });
}

function artifact(bytes: Uint8Array, schema: Readonly<{ id: string; version: string; schemaHash: Hash }>, label: string) {
  const contentSha256 = sha256Hex(bytes);
  const storeIdentityHash = h(`store-${label}`);
  const lease = createRetentionLeaseReceipt({
    storeIdentityHash,
    objectKey: contentSha256,
    contentSha256,
    validFromStoreEpoch: "1",
    validThroughStoreEpoch: "10",
    issuerId: "terminal-selection-test-observer",
    issuerQualificationId: h("observer-qualification"),
    qualificationRegistryRoot: h("qualification-registry"),
  });
  const ref = createReadOnlyArtifactRef({
    locator: { kind: "content-object", storeIdentityHash, objectKey: contentSha256 },
    immutableMirrorLocator: { kind: "content-object", storeIdentityHash, objectKey: contentSha256 },
    contentSha256,
    byteLength: bytes.byteLength.toString(),
    mediaType: "application/json",
    schema,
    resolverPolicyHash: policy.policyHash,
    retentionLeaseReceiptId: lease.receiptId,
  });
  const claim = createArtifactResolutionClaim({
    artifactRefId: ref.artifactRefId,
    resolverPolicyHash: policy.policyHash,
    observedMirror: {
      storeIdentityHash,
      objectKey: contentSha256,
      bytes: encodeArtifactBytes(bytes),
      contentSha256,
      byteLength: bytes.byteLength.toString(),
      mediaType: "application/json",
      schema,
    },
    outcome: "content-observed",
  });
  return Object.freeze({ ref, claim, lease });
}

function fixture(selected = true, eventLabels: readonly string[] = ["only"]): TerminalSelectionRuntimeFactsV1 {
  const process = processEvidence();
  const raw = rawSelection(selected);
  const projection = fullFamilyProjection(process);
  const projectionArtifact = artifact(encodeCanonicalBytes(projection), TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.fullFamilyProjection, "full-family-projection");
  const predicateArtifacts = selected ? eventLabels.map(label => artifact(
    encodeCanonicalBytes(sixStepEventArtifactValue(label)),
    Object.freeze({
      id: EVIDENCE_SCHEMA_MANIFESTS.event.id,
      version: EVIDENCE_SCHEMA_MANIFESTS.event.version,
      schemaHash: EVIDENCE_SCHEMA_MANIFESTS.event.schemaHash,
    }),
    `six-step-event-${label}`,
  )).sort((left, right) => left.ref.artifactRefId.localeCompare(right.ref.artifactRefId)) : [];
  const manifest = terminalManifest(process, raw.selection, projectionArtifact, projection, predicateArtifacts);
  const rawArtifact = artifact(encodeCanonicalBytes(raw), TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.rawSelection, "raw");
  const manifestArtifact = artifact(encodeCanonicalBytes(manifest), TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.terminalManifest, "manifest");
  const processArtifact = selected
    ? artifact(encodeCanonicalBytes(process), TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.processEvidence, "process")
    : null;
  const artifacts = processArtifact === null
    ? [rawArtifact, manifestArtifact, projectionArtifact]
    : [rawArtifact, manifestArtifact, projectionArtifact, processArtifact, ...predicateArtifacts];
  const fact = processArtifact === null
    ? createTerminalSelectionMissingFactV1({ rawSelectionArtifactRefId: rawArtifact.ref.artifactRefId, terminalManifestArtifactRefId: manifestArtifact.ref.artifactRefId, fullFamilyProjectionArtifactRefId: projectionArtifact.ref.artifactRefId })
    : createTerminalSelectionFactV1({ rawSelectionArtifactRefId: rawArtifact.ref.artifactRefId, terminalManifestArtifactRefId: manifestArtifact.ref.artifactRefId, fullFamilyProjectionArtifactRefId: projectionArtifact.ref.artifactRefId, processEvidenceArtifactRefId: processArtifact.ref.artifactRefId, sixStepPredicateArtifactRefIds: predicateArtifacts.map(value => value.ref.artifactRefId) });
  return Object.freeze({
    facts: Object.freeze([fact]),
    refs: Object.freeze(artifacts.map(value => value.ref)),
    claims: Object.freeze(artifacts.map(value => value.claim)),
    policies: Object.freeze([policy]),
    leases: Object.freeze(artifacts.map(value => value.lease)),
    observations: Object.freeze([Object.freeze({
      observationId: "terminal-selection-test-observation",
      rawArtifactRefs: Object.freeze(artifacts.map(value => value.ref)),
      observedClaimIds: Object.freeze(artifacts.map(value => value.claim.claimId)),
    })]),
    trustedObserverInvocation: Object.freeze({
      keyId: h("observer-key"),
      observerQualificationId: h("observer-qualification"),
      roleId: TERMINAL_SELECTION_INVOCATION_SEAL_ROLE.roleId,
      authenticatedArtifactRefIds: Object.freeze(artifacts.map(value => value.ref.artifactRefId).sort()),
      candidateReleaseCommit: commit,
    }),
  });
}

function verdicts(value: TerminalSelectionRuntimeFactsV1) {
  return [evaluateTerminalSelectionPredicate(value).verdict, evaluateTerminalSelectionReferenceModel(value).verdict];
}

function qualificationFixture(value: TerminalSelectionRuntimeFactsV1): TerminalSelectionQualificationFixtureV1 {
  return Object.freeze({
    runtime: value,
    reference: structuredClone(value),
  });
}

function rewriteManifest(
  base: TerminalSelectionRuntimeFactsV1,
  mutate: (core: Record<string, unknown>) => Record<string, unknown>,
  label: string,
): TerminalSelectionRuntimeFactsV1 {
  const manifest = JSON.parse(Buffer.from(decodeArtifactBytes(base.claims[1]!.observedMirror!.bytes)).toString("utf8")) as Record<string, unknown>;
  const { manifestRoot: _root, ...oldCore } = manifest;
  const core = mutate(oldCore);
  const rewritten = { ...core, manifestRoot: hashDomain("aloha/production-terminal-phase-manifest/v1", core as unknown as CanonicalJson) };
  const replacement = artifact(encodeCanonicalBytes(rewritten), TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.terminalManifest, label);
  const refs = [base.refs[0]!, replacement.ref, ...base.refs.slice(2)];
  const claims = [base.claims[0]!, replacement.claim, ...base.claims.slice(2)];
  const leases = [base.leases[0]!, replacement.lease, ...base.leases.slice(2)];
  const fact = createTerminalSelectionFactV1({
    rawSelectionArtifactRefId: refs[0]!.artifactRefId,
    terminalManifestArtifactRefId: refs[1]!.artifactRefId,
    fullFamilyProjectionArtifactRefId: refs[2]!.artifactRefId,
    processEvidenceArtifactRefId: refs[3]!.artifactRefId,
    sixStepPredicateArtifactRefIds: refs.slice(4).map(value => value.artifactRefId),
  });
  return Object.freeze({
    ...base,
    facts: Object.freeze([fact]), refs: Object.freeze(refs), claims: Object.freeze(claims), leases: Object.freeze(leases),
    observations: Object.freeze([{ observationId: label, rawArtifactRefs: Object.freeze(refs), observedClaimIds: Object.freeze(claims.map(value => value.claimId)) }]),
    trustedObserverInvocation: Object.freeze({ ...base.trustedObserverInvocation!, authenticatedArtifactRefIds: Object.freeze(refs.map(value => value.artifactRefId).sort()) }),
  });
}

test("raw SQLite, durable terminal manifest and selected process refs pass only as one exact lineage", () => {
  const value = fixture();
  assert.deepEqual(verdicts(value), ["pass", "pass"], JSON.stringify(evaluateTerminalSelectionPredicate(value).reasons));
});

test("terminal qualification executes every declared mutation against predicate and independent Oracle", () => {
  const certificate = qualifyTerminalSelectionCorpus(qualificationFixture(fixture()));
  assert.equal(certificate.verdict, "qualified");
  assertQualifiedTerminalSelectionCertificate(certificate);
  assert.equal(certificate.predicateSpecDigest, TERMINAL_SELECTION_PREDICATE_SPEC.specDigest);
  assert.deepEqual(certificate.declaredCriticalMutationIds, [...TERMINAL_SELECTION_CRITICAL_MUTATION_IDS].sort());
  assert.deepEqual(certificate.rejectedOrInvalidMutationIds, [...TERMINAL_SELECTION_CRITICAL_MUTATION_IDS].sort());
  assert.equal(certificate.independentOracleCaseCount, String(TERMINAL_SELECTION_CRITICAL_MUTATION_IDS.length + 1));
});

test("terminal qualification rejects missing, duplicate, no-op and verdict-shaped mutators", () => {
  const base = qualificationFixture(fixture());
  const first = TERMINAL_SELECTION_MUTATION_REGISTRY[0]!;
  const noOp: TerminalSelectionMutationMutatorV1 = Object.freeze({
    mutationId: first.mutationId,
    implementationDigest: first.implementationDigest,
    apply: (value: TerminalSelectionQualificationFixtureV1) => value,
  });
  const forged: TerminalSelectionMutationMutatorV1 = Object.freeze({
    mutationId: first.mutationId,
    implementationDigest: first.implementationDigest,
    apply: first.apply,
    expectedVerdict: "invalid",
  } as unknown as TerminalSelectionMutationMutatorV1);
  for (const mutators of [
    TERMINAL_SELECTION_MUTATION_REGISTRY.slice(1),
    [...TERMINAL_SELECTION_MUTATION_REGISTRY, first],
    [noOp, ...TERMINAL_SELECTION_MUTATION_REGISTRY.slice(1)],
    [forged, ...TERMINAL_SELECTION_MUTATION_REGISTRY.slice(1)],
  ]) {
    assert.equal(validateTerminalSelectionMutationCorpus(base, mutators), false);
  }
});

test("terminal qualification certificate binds full cases, fixed registry, counts and its payload identity", () => {
  const certificate = qualifyTerminalSelectionCorpus(qualificationFixture(fixture()));
  assert.equal(certificate.mutationRegistryDigest, TERMINAL_SELECTION_MUTATION_REGISTRY_DIGEST);
  for (const mutated of [
    { ...certificate, certificateId: h("forged-certificate-id") },
    { ...certificate, mutationRegistryDigest: h("forged-registry") },
    { ...certificate, independentOracleCaseCount: "1" },
    { ...certificate, independentOracleCaseRoot: h("forged-oracle-root") },
    { ...certificate, positiveEvidenceRoot: h("forged-positive-evidence") },
    { ...certificate, mutationCases: certificate.mutationCases.slice(1) },
  ]) {
    assert.throws(() => assertQualifiedTerminalSelectionCertificate(mutated), /terminal-selection/);
  }
});

function resignTerminalQualificationCertificate(
  certificate: TerminalSelectionQualificationCertificateV1,
  positiveCase: TerminalSelectionQualificationCertificateV1["positiveCase"],
  mutationCases: TerminalSelectionQualificationCertificateV1["mutationCases"],
  positiveEvidenceRoot: Hash = positiveCase.evidenceRoot,
): TerminalSelectionQualificationCertificateV1 {
  const caseRoot = (domain: string, values: readonly TerminalSelectionQualificationCertificateV1["positiveCase"][]) => hashDomain(
    domain,
    values.slice().sort((left, right) => left.caseId.localeCompare(right.caseId)).map(value => encodeCanonicalJson(value)),
  );
  const positiveCaseRoot = caseRoot("aloha/terminal-selection/qualification/positive-cases/v1", [positiveCase]);
  const mutationCaseRoot = caseRoot("aloha/terminal-selection/qualification/mutation-cases/v1", mutationCases);
  const independentOracleCaseRoot = hashDomain("aloha/terminal-selection/qualification/independent-oracle-cases/v1", {
    positiveCaseRoot,
    mutationCaseRoot,
  });
  const payload = {
    predicateSpecDigest: certificate.predicateSpecDigest,
    predicateProgramDescriptorDigest: certificate.predicateProgramDescriptorDigest,
    oracleProgramDescriptorDigest: certificate.oracleProgramDescriptorDigest,
    mutationRegistryDigest: certificate.mutationRegistryDigest,
    qualificationSpecDigest: certificate.qualificationSpecDigest,
    positiveEvidenceRoot,
    positiveCaseRoot,
    mutationCaseRoot,
    declaredCriticalMutationIds: certificate.declaredCriticalMutationIds,
    rejectedOrInvalidMutationIds: certificate.rejectedOrInvalidMutationIds,
    independentOracleCaseRoot,
    independentOracleCaseCount: certificate.independentOracleCaseCount,
    positiveCase,
    mutationCases,
    verdict: certificate.verdict,
  };
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.terminal-selection-verifier-qualification",
    certificateId: hashDomain("aloha/terminal-selection/verifier-qualification/v1", payload),
    ...payload,
  });
}

test("coherently rerooted malformed nested qualification cases remain invalid", () => {
  const certificate = qualifyTerminalSelectionCorpus(qualificationFixture(fixture()));
  const positiveWithExtra = { ...certificate.positiveCase, attackerField: "forbidden" } as unknown as typeof certificate.positiveCase;
  const nonHashPositive = { ...certificate.positiveCase, evidenceRoot: "not-a-hash" as Hash };
  const forgedMutationCases = certificate.mutationCases.map((value, index) => index === 0
    ? { ...value, runtimeVerdict: "forged", referenceVerdict: "forged" } as unknown as typeof value
    : value);
  for (const mutated of [
    resignTerminalQualificationCertificate(certificate, positiveWithExtra, certificate.mutationCases),
    resignTerminalQualificationCertificate(certificate, nonHashPositive, certificate.mutationCases, "not-a-hash" as Hash),
    resignTerminalQualificationCertificate(certificate, certificate.positiveCase, forgedMutationCases),
  ]) assert.throws(() => assertQualifiedTerminalSelectionCertificate(mutated), /terminal-selection|hash/i);
});

test("a different passing positive corpus necessarily produces a different authority-pinnable certificate", () => {
  const base = qualificationFixture(fixture());
  const alternateObservationId = "terminal-selection-alternate-positive-observation";
  const alternate = Object.freeze({
    runtime: Object.freeze({
      ...base.runtime,
      observations: base.runtime.observations.map(value => Object.freeze({ ...value, observationId: alternateObservationId })),
    }),
    reference: Object.freeze({
      ...base.reference,
      observations: base.reference.observations.map(value => Object.freeze({ ...value, observationId: alternateObservationId })),
    }),
  });
  const first = qualifyTerminalSelectionCorpus(base);
  const second = qualifyTerminalSelectionCorpus(alternate);
  assert.equal(first.verdict, "qualified");
  assert.equal(second.verdict, "qualified");
  assert.notEqual(first.positiveEvidenceRoot, second.positiveEvidenceRoot);
  assert.notEqual(first.positiveCaseRoot, second.positiveCaseRoot);
  assert.notEqual(first.certificateId, second.certificateId);
});

test("named semantic mutations rebuild the outer content-addressed artifact closure", () => {
  const base = qualificationFixture(fixture());
  const physicalMismatchMutations = new Set([
    "artifact-mirror-splice",
    "missing-independent-observation",
    "cross-observation-denominator-splice",
    "producer-verdict-injection",
    "artifact-ref-splice",
  ]);
  for (const mutator of TERMINAL_SELECTION_MUTATION_REGISTRY) {
    if (physicalMismatchMutations.has(mutator.mutationId)) continue;
    const mutated = mutator.apply(structuredClone(base));
    for (const envelope of [mutated.runtime, mutated.reference]) {
      for (const [index, ref] of envelope.refs.entries()) {
        const claim = envelope.claims[index]!;
        const lease = envelope.leases[index]!;
        assert.equal(claim.artifactRefId, ref.artifactRefId, mutator.mutationId);
        assert.equal(claim.observedMirror!.contentSha256, ref.contentSha256, mutator.mutationId);
        assert.equal(sha256Hex(decodeArtifactBytes(claim.observedMirror!.bytes)), ref.contentSha256, mutator.mutationId);
        assert.equal(lease.receiptId, ref.retentionLeaseReceiptId, mutator.mutationId);
      }
    }
    assert.notEqual(evaluateTerminalSelectionPredicate(mutated.runtime).verdict, "pass", mutator.mutationId);
    assert.notEqual(evaluateTerminalSelectionReferenceModel(mutated.reference).verdict, "pass", mutator.mutationId);
  }
});

test("terminal selection consumes the durable producer manifest/projection wire and exact structural schema refs", () => {
  const value = fixture();
  const manifestBytes = decodeArtifactBytes(value.claims[1]!.observedMirror!.bytes);
  const projectionBytes = decodeArtifactBytes(value.claims[2]!.observedMirror!.bytes);
  assert.doesNotThrow(() => decodeProductionTerminalPhaseManifestV1(JSON.parse(Buffer.from(manifestBytes).toString("utf8"))));
  assert.doesNotThrow(() => decodeProductionTerminalPhaseFullFamilyProjectionV1(JSON.parse(Buffer.from(projectionBytes).toString("utf8"))));
  assert.deepEqual(value.refs[1]!.schema, TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.terminalManifest);
  assert.deepEqual(value.refs[2]!.schema, TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.fullFamilyProjection);
});

test("projection and complete Six-Step artifact closure are authenticated denominators", () => {
  const base = fixture();
  const withoutProjection = {
    ...base,
    refs: base.refs.filter((_, index) => index !== 2),
    claims: base.claims.filter((_, index) => index !== 2),
    leases: base.leases.filter((_, index) => index !== 2),
  };
  assert.deepEqual(verdicts(withoutProjection), ["invalid", "invalid"]);
  const withoutClosure = {
    ...base,
    refs: base.refs.slice(0, 4),
    claims: base.claims.slice(0, 4),
    leases: base.leases.slice(0, 4),
  };
  assert.deepEqual(verdicts(withoutClosure), ["invalid", "invalid"]);
});

test("event artifact refs are the exact canonical ordered event-schema closure", () => {
  const base = fixture(true, ["first", "second"]);
  assert.deepEqual(verdicts(base), ["pass", "pass"]);
  const manifest = JSON.parse(Buffer.from(decodeArtifactBytes(base.claims[1]!.observedMirror!.bytes)).toString("utf8")) as Record<string, unknown>;
  const sixStep = manifest.sixStep as Record<string, unknown>;
  const refs = sixStep.eventArtifactRefIds as string[];
  assert.equal(refs.length, 2);
  for (const [label, eventArtifactRefIds] of [
    ["deleted", refs.slice(0, 1)],
    ["duplicated", [refs[0]!, refs[0]!]],
    ["extra", [...refs, h("event-extra")]],
    ["reordered", [...refs].reverse()],
  ] as const) {
    const mutated = rewriteManifest(base, core => ({
      ...core,
      sixStep: { ...(core.sixStep as Record<string, unknown>), eventArtifactRefIds },
    }), `event-refs-${label}`);
    assert.deepEqual(verdicts(mutated), ["invalid", "invalid"], label);
  }
});

test("artifact joins cannot be assembled across multiple partial observations", () => {
  const base = fixture();
  const midpoint = Math.floor(base.refs.length / 2);
  const observations = [
    { observationId: "left", rawArtifactRefs: base.refs.slice(0, midpoint), observedClaimIds: base.claims.slice(0, midpoint).map(value => value.claimId) },
    { observationId: "right", rawArtifactRefs: base.refs.slice(midpoint), observedClaimIds: base.claims.slice(midpoint).map(value => value.claimId) },
  ];
  assert.deepEqual(verdicts({ ...base, observations }), ["invalid", "invalid"]);
});

test("release anchor and Six-Step predicate closure cannot be coherently re-rooted in the manifest alone", () => {
  const releaseSplice = rewriteManifest(fixture(), core => ({ ...core, releaseAnchorRoot: h("foreign-release-anchor") }), "release-anchor-splice");
  assert.deepEqual(verdicts(releaseSplice), ["invalid", "invalid"]);
  const closureSplice = rewriteManifest(fixture(), core => ({
    ...core,
    sixStep: { ...(core.sixStep as Record<string, unknown>), predicateArtifactRoot: h("foreign-predicate-closure") },
  }), "predicate-closure-splice");
  assert.deepEqual(verdicts(closureSplice), ["invalid", "invalid"]);
});

test("mirror media type and schema must equal the authenticated artifact ref", () => {
  const base = fixture();
  const original = base.claims[2]!;
  const replacement = createArtifactResolutionClaim({
    artifactRefId: original.artifactRefId,
    resolverPolicyHash: original.resolverPolicyHash,
    observedMirror: { ...original.observedMirror!, mediaType: "application/octet-stream" },
    outcome: "content-observed",
  });
  const claims = base.claims.map((claim, index) => index === 2 ? replacement : claim);
  const observations = [{
    observationId: "mirror-media-splice",
    rawArtifactRefs: base.refs,
    observedClaimIds: claims.map(value => value.claimId),
  }];
  assert.deepEqual(verdicts({ ...base, claims, observations }), ["invalid", "invalid"]);
});

test("raw serving source coverage must join the selected process serving identity", () => {
  const base = fixture();
  const process = JSON.parse(Buffer.from(decodeArtifactBytes(base.claims[3]!.observedMirror!.bytes)).toString("utf8")) as TerminalSelectionProcessEvidenceV1;
  const { evidenceRoot: _evidenceRoot, ...oldProcessCore } = process;
  const processCore = Object.freeze({
    ...oldProcessCore,
    serving: Object.freeze({ ...oldProcessCore.serving, sourceCoverageRoot: h("foreign-source-coverage") }),
  });
  const rewrittenProcess = Object.freeze({
    ...processCore,
    evidenceRoot: hashDomain("aloha/searcher-production-six-step-process-evidence/v1", processCore as unknown as CanonicalJson),
  });
  const processArtifact = artifact(encodeCanonicalBytes(rewrittenProcess), TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.processEvidence, "source-coverage-process");
  const manifest = JSON.parse(Buffer.from(decodeArtifactBytes(base.claims[1]!.observedMirror!.bytes)).toString("utf8")) as TerminalSelectionManifestV1;
  const { manifestRoot: _manifestRoot, ...oldManifestCore } = manifest;
  const manifestCore = Object.freeze({
    ...oldManifestCore,
    sixStep: Object.freeze({ ...oldManifestCore.sixStep, joinedProcessEvidenceRoot: rewrittenProcess.evidenceRoot }),
  });
  const rewrittenManifest = Object.freeze({ ...manifestCore, manifestRoot: hashDomain("aloha/production-terminal-phase-manifest/v1", manifestCore as unknown as CanonicalJson) });
  const manifestArtifact = artifact(encodeCanonicalBytes(rewrittenManifest), TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.terminalManifest, "source-coverage-manifest");
  const refs = [base.refs[0]!, manifestArtifact.ref, base.refs[2]!, processArtifact.ref, ...base.refs.slice(4)];
  const claims = [base.claims[0]!, manifestArtifact.claim, base.claims[2]!, processArtifact.claim, ...base.claims.slice(4)];
  const leases = [base.leases[0]!, manifestArtifact.lease, base.leases[2]!, processArtifact.lease, ...base.leases.slice(4)];
  const fact = createTerminalSelectionFactV1({
    rawSelectionArtifactRefId: refs[0]!.artifactRefId,
    terminalManifestArtifactRefId: refs[1]!.artifactRefId,
    fullFamilyProjectionArtifactRefId: refs[2]!.artifactRefId,
    processEvidenceArtifactRefId: refs[3]!.artifactRefId,
    sixStepPredicateArtifactRefIds: refs.slice(4).map(value => value.artifactRefId),
  });
  const observations = [{ observationId: "source-coverage", rawArtifactRefs: refs, observedClaimIds: claims.map(value => value.claimId) }];
  const trustedObserverInvocation = { ...base.trustedObserverInvocation!, authenticatedArtifactRefIds: refs.map(value => value.artifactRefId).sort() };
  assert.deepEqual(verdicts({ ...base, facts: [fact], refs, claims, leases, observations, trustedObserverInvocation }), ["invalid", "invalid"]);
});

test("final-segment serving cannot replace an earlier selected event serving after generation rotation", () => {
  const base = fixture();
  const raw = JSON.parse(Buffer.from(decodeArtifactBytes(base.claims[0]!.observedMirror!.bytes)).toString("utf8")) as RawTerminalSelectionObservationV1;
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    sourceKind: _sourceKind,
    observationRoot: _observationRoot,
    ...rawInput
  } = raw;
  const replacementRaw = createRawTerminalSelectionObservationV1({
    ...rawInput,
    serving: Object.freeze({
      generationId: "generation-2",
      graphRoot: h("generation-2-graph"),
      readyRecordHash: h("generation-2-ready"),
      sourceCoverageRoot: h("generation-2-coverage"),
    }),
  });
  const replacement = artifact(
    encodeCanonicalBytes(replacementRaw),
    TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.rawSelection,
    "final-segment-serving-splice",
  );
  const refs = [replacement.ref, ...base.refs.slice(1)];
  const claims = [replacement.claim, ...base.claims.slice(1)];
  const leases = [replacement.lease, ...base.leases.slice(1)];
  const fact = createTerminalSelectionFactV1({
    rawSelectionArtifactRefId: replacement.ref.artifactRefId,
    terminalManifestArtifactRefId: refs[1]!.artifactRefId,
    fullFamilyProjectionArtifactRefId: refs[2]!.artifactRefId,
    processEvidenceArtifactRefId: refs[3]!.artifactRefId,
    sixStepPredicateArtifactRefIds: refs.slice(4).map(value => value.artifactRefId),
  });
  assert.deepEqual(verdicts({
    ...base,
    facts: [fact],
    refs,
    claims,
    leases,
    observations: [{
      observationId: "final-segment-serving-splice",
      rawArtifactRefs: refs,
      observedClaimIds: claims.map(value => value.claimId),
    }],
    trustedObserverInvocation: {
      ...base.trustedObserverInvocation!,
      authenticatedArtifactRefIds: refs.map(value => value.artifactRefId).sort(),
    },
  }), ["invalid", "invalid"]);
});

test("reference model implementation closure contains no terminal production executable decoder", () => {
  const source = readFileSync(new URL("../src/reference-model.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "decodeReadOnlyArtifactRef", "from \"./schema.ts\"", "from \"./spec.ts\"",
    "decodeRawTerminalSelectionObservationV1", "decodeTerminalSelectionManifestV1",
    "decodeTerminalSelectionProcessEvidenceV1",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.doesNotMatch(source, /\bprocess\s*(?:\.|\[)|\b(?:const|let|var)\s+process\b/);
});

test("an exact no-successful-dry-run terminal is a factual failure, not a fabricated pass", () => {
  assert.deepEqual(verdicts(fixture(false)), ["fail", "fail"]);
});

test("missing observer authentication and producer verdict injection are invalid", () => {
  const base = fixture();
  assert.deepEqual(verdicts({ ...base, observations: [] }), ["invalid", "invalid"]);
  assert.deepEqual(verdicts({
    ...base,
    facts: [{ ...(base.facts[0] as object), producerVerdict: "pass" }],
  }), ["invalid", "invalid"]);
  assert.deepEqual(verdicts({
    ...base,
    trustedObserverInvocation: {
      ...base.trustedObserverInvocation!,
      authenticatedArtifactRefIds: [h("replacement-signed-subject")],
    },
  }), ["invalid", "invalid"]);
});

test("the independent reference oracle rejects the retired single-string artifact byte shape", () => {
  const base = fixture();
  const hostile = {
    ...base,
    claims: base.claims.map((claim, index) => index === 0 && claim.observedMirror !== null
      ? { ...claim, observedMirror: { ...claim.observedMirror, bytes: "0x00" as never } }
      : claim),
  };
  assert.doesNotThrow(() => evaluateTerminalSelectionReferenceModel(hostile));
  assert.equal(evaluateTerminalSelectionReferenceModel(hostile).verdict, "invalid");
});

test("a nested producer verdict remains invalid after raw artifact and invocation refs are re-rooted", () => {
  const base = fixture();
  const rawValue = JSON.parse(
    Buffer.from(decodeArtifactBytes(base.claims[0]!.observedMirror!.bytes)).toString("utf8"),
  ) as RawTerminalSelectionObservationV1;
  const { observationRoot: _oldRoot, ...rawCore } = rawValue;
  const attackedCore = {
    ...rawCore,
    release: { ...rawCore.release, producerVerdict: "pass" },
  };
  const attackedRaw = {
    ...attackedCore,
    observationRoot: hashDomain(
      "aloha/raw-terminal-selection-observation/v1",
      attackedCore as unknown as CanonicalJson,
    ),
  };
  const rawArtifact = artifact(
    encodeCanonicalBytes(attackedRaw),
    TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.rawSelection,
    "nested-producer-verdict",
  );
  const refs = [rawArtifact.ref, ...base.refs.slice(1)];
  const claims = [rawArtifact.claim, ...base.claims.slice(1)];
  const leases = [rawArtifact.lease, ...base.leases.slice(1)];
  const fact = createTerminalSelectionFactV1({
    rawSelectionArtifactRefId: rawArtifact.ref.artifactRefId,
    terminalManifestArtifactRefId: refs[1]!.artifactRefId,
    fullFamilyProjectionArtifactRefId: refs[2]!.artifactRefId,
    processEvidenceArtifactRefId: refs[3]!.artifactRefId,
    sixStepPredicateArtifactRefIds: refs.slice(4).map(value => value.artifactRefId),
  });
  assert.deepEqual(verdicts({
    ...base,
    facts: [fact],
    refs,
    claims,
    leases,
    observations: [{
      observationId: "nested-producer-verdict",
      rawArtifactRefs: refs,
      observedClaimIds: claims.map(value => value.claimId),
    }],
    trustedObserverInvocation: {
      ...base.trustedObserverInvocation!,
      authenticatedArtifactRefIds: refs.map(value => value.artifactRefId).sort(),
    },
  }), ["invalid", "invalid"]);
});

test("a raw snapshot fence splice remains invalid even when its content address is rebuilt", () => {
  const base = fixture();
  const rawClaim = base.claims[0]!;
  const raw = JSON.parse(Buffer.from(decodeArtifactBytes(rawClaim.observedMirror!.bytes)).toString("utf8")) as RawTerminalSelectionObservationV1;
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    sourceKind: _sourceKind,
    observationRoot: _observationRoot,
    ...rawInput
  } = raw;
  const replacementRaw = createRawTerminalSelectionObservationV1({
    ...rawInput,
    databaseSha256After: h("foreign-database"),
  });
  const replacement = artifact(encodeCanonicalBytes(replacementRaw), TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.rawSelection, "raw-replacement");
  const oldRef = base.refs[0]!;
  const facts = createTerminalSelectionFactV1({
    rawSelectionArtifactRefId: replacement.ref.artifactRefId,
    terminalManifestArtifactRefId: base.refs[1]!.artifactRefId,
    fullFamilyProjectionArtifactRefId: base.refs[2]!.artifactRefId,
    processEvidenceArtifactRefId: base.refs[3]!.artifactRefId,
    sixStepPredicateArtifactRefIds: base.refs.slice(4).map(value => value.artifactRefId),
  });
  const refs = [replacement.ref, ...base.refs.slice(1)];
  const claims = [replacement.claim, ...base.claims.slice(1)];
  const leases = [replacement.lease, ...base.leases.slice(1)];
  const mutated = {
    ...base,
    facts: [facts],
    refs,
    claims,
    leases,
    observations: [{ observationId: "replacement", rawArtifactRefs: refs, observedClaimIds: claims.map(value => value.claimId) }],
    trustedObserverInvocation: base.trustedObserverInvocation,
  };
  assert.notEqual(oldRef.artifactRefId, replacement.ref.artifactRefId);
  assert.deepEqual(verdicts(mutated), ["invalid", "invalid"]);
});

test("a durable terminal-phase invalid row makes selection acceptance invalid", () => {
  const base = fixture();
  const rawClaim = base.claims[0]!;
  const raw = JSON.parse(Buffer.from(decodeArtifactBytes(rawClaim.observedMirror!.bytes)).toString("utf8")) as RawTerminalSelectionObservationV1;
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    sourceKind: _sourceKind,
    observationRoot: _observationRoot,
    ...rawInput
  } = raw;
  const replacementRaw = createRawTerminalSelectionObservationV1({
    ...rawInput,
    terminalPhaseRowCount: "1",
    terminalPhaseRowRoot: h("terminal-phase-invalid-row"),
  });
  const replacement = artifact(encodeCanonicalBytes(replacementRaw), TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.rawSelection, "raw-terminal-invalid");
  const facts = createTerminalSelectionFactV1({
    rawSelectionArtifactRefId: replacement.ref.artifactRefId,
    terminalManifestArtifactRefId: base.refs[1]!.artifactRefId,
    fullFamilyProjectionArtifactRefId: base.refs[2]!.artifactRefId,
    processEvidenceArtifactRefId: base.refs[3]!.artifactRefId,
    sixStepPredicateArtifactRefIds: base.refs.slice(4).map(value => value.artifactRefId),
  });
  const refs = [replacement.ref, ...base.refs.slice(1)];
  const claims = [replacement.claim, ...base.claims.slice(1)];
  const leases = [replacement.lease, ...base.leases.slice(1)];
  assert.deepEqual(verdicts({
    ...base,
    facts: [facts],
    refs,
    claims,
    leases,
    observations: [{ observationId: "terminal-invalid", rawArtifactRefs: refs, observedClaimIds: claims.map(value => value.claimId) }],
  }), ["invalid", "invalid"]);
});

test("selected success count must remain a canonical positive decimal even when both artifacts are re-rooted", () => {
  for (const eligibleSuccessCount of ["0", "01", "not-a-decimal"]) {
    const base = fixture();
    const rawValue = JSON.parse(Buffer.from(decodeArtifactBytes(base.claims[0]!.observedMirror!.bytes)).toString("utf8")) as RawTerminalSelectionObservationV1;
    const manifestValue = JSON.parse(Buffer.from(decodeArtifactBytes(base.claims[1]!.observedMirror!.bytes)).toString("utf8")) as ReturnType<typeof terminalManifest>;
    const { observationRoot: _rawRoot, ...rawCore } = rawValue;
    const rewrittenRawCore = {
      ...rawCore,
      selection: { ...rawCore.selection, eligibleSuccessCount },
    };
    const rewrittenRaw = {
      ...rewrittenRawCore,
      observationRoot: hashDomain("aloha/raw-terminal-selection-observation/v1", rewrittenRawCore as unknown as CanonicalJson),
    };
    const { manifestRoot: _manifestRoot, ...manifestCore } = manifestValue;
    const rewrittenManifestCore = {
      ...manifestCore,
      sixStep: { ...manifestCore.sixStep, eligibleSuccessCount },
    };
    const rewrittenManifest = {
      ...rewrittenManifestCore,
      manifestRoot: hashDomain("aloha/production-terminal-phase-manifest/v1", rewrittenManifestCore as unknown as CanonicalJson),
    };
    const rawArtifact = artifact(encodeCanonicalBytes(rewrittenRaw), TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.rawSelection, `raw-count-${eligibleSuccessCount}`);
    const manifestArtifact = artifact(encodeCanonicalBytes(rewrittenManifest), TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.terminalManifest, `manifest-count-${eligibleSuccessCount}`);
    const projectionRef = base.refs[2]!;
    const processRef = base.refs[3]!;
    const predicateRefs = base.refs.slice(4);
    const facts = createTerminalSelectionFactV1({
      rawSelectionArtifactRefId: rawArtifact.ref.artifactRefId,
      terminalManifestArtifactRefId: manifestArtifact.ref.artifactRefId,
      fullFamilyProjectionArtifactRefId: projectionRef.artifactRefId,
      processEvidenceArtifactRefId: processRef.artifactRefId,
      sixStepPredicateArtifactRefIds: predicateRefs.map(value => value.artifactRefId),
    });
    const refs = [rawArtifact.ref, manifestArtifact.ref, projectionRef, processRef, ...predicateRefs];
    const claims = [rawArtifact.claim, manifestArtifact.claim, ...base.claims.slice(2)];
    const leases = [rawArtifact.lease, manifestArtifact.lease, ...base.leases.slice(2)];
    assert.deepEqual(verdicts({
      ...base,
      facts: [facts],
      refs,
      claims,
      leases,
      observations: [{ observationId: `count-${eligibleSuccessCount}`, rawArtifactRefs: refs, observedClaimIds: claims.map(value => value.claimId) }],
    }), ["invalid", "invalid"], eligibleSuccessCount);
  }
});

test("terminal production decimals reject values beyond the 128-digit canonical bound", () => {
  const value = fixture();
  const tooWide = "1".repeat(129);
  const raw = JSON.parse(Buffer.from(decodeArtifactBytes(value.claims[0]!.observedMirror!.bytes)).toString("utf8")) as Record<string, unknown>;
  const manifest = JSON.parse(Buffer.from(decodeArtifactBytes(value.claims[1]!.observedMirror!.bytes)).toString("utf8")) as Record<string, unknown>;
  const process = JSON.parse(Buffer.from(decodeArtifactBytes(value.claims[3]!.observedMirror!.bytes)).toString("utf8")) as Record<string, unknown>;
  assert.throws(() => decodeRawTerminalSelectionObservationV1({ ...raw, terminalPhaseRowCount: tooWide }));
  assert.throws(() => decodeTerminalSelectionManifestV1({
    ...manifest,
    sixStep: { ...(manifest.sixStep as Record<string, unknown>), eligibleSuccessCount: tooWide },
  }));
  assert.throws(() => decodeTerminalSelectionManifestV1({
    ...manifest,
    sixStep: { ...(manifest.sixStep as Record<string, unknown>), predicateArtifactCount: tooWide },
  }));
  for (const field of ["sequence", "byteLength", "offsetStart", "offsetEnd"] as const) {
    assert.throws(() => decodeTerminalSelectionProcessEvidenceV1({
      ...process,
      durableAppend: { ...(process.durableAppend as Record<string, unknown>), [field]: tooWide },
    }), field);
  }
  for (const field of ["logDevice", "logInode", "pid", "processStartTicks"] as const) {
    assert.throws(() => decodeTerminalSelectionProcessEvidenceV1({
      ...process,
      runtimeAnchor: { ...(process.runtimeAnchor as Record<string, unknown>), [field]: tooWide },
    }), field);
  }
});

test("a coherently re-rooted manifest/process append splice cannot replace the raw-selected event", () => {
  const base = fixture();
  const rawRef = base.refs[0]!;
  const rawClaim = base.claims[0]!;
  const rawLease = base.leases[0]!;
  const processValue = JSON.parse(
    Buffer.from(decodeArtifactBytes(base.claims[3]!.observedMirror!.bytes)).toString("utf8"),
  ) as TerminalSelectionProcessEvidenceV1;
  const projectionValue = JSON.parse(
    Buffer.from(decodeArtifactBytes(base.claims[2]!.observedMirror!.bytes)).toString("utf8"),
  ) as TerminalSelectionFullFamilyProjectionV1;
  const manifestValue = JSON.parse(
    Buffer.from(decodeArtifactBytes(base.claims[1]!.observedMirror!.bytes)).toString("utf8"),
  ) as ReturnType<typeof terminalManifest>;
  const replacementAppend = Object.freeze({
    ...processValue.durableAppend,
    eventId: h("spliced-performance-event"),
  });
  const { evidenceRoot: _oldEvidenceRoot, ...processCore } = processValue;
  const rewrittenProcessCore = Object.freeze({
    ...processCore,
    durableAppend: replacementAppend,
    durableAppendRecordId: appendId(replacementAppend),
  });
  const rewrittenProcess = Object.freeze({
    ...rewrittenProcessCore,
    evidenceRoot: hashDomain(
      "aloha/searcher-production-six-step-process-evidence/v1",
      rewrittenProcessCore as unknown as CanonicalJson,
    ),
  });
  const { manifestRoot: _oldManifestRoot, ...manifestCore } = manifestValue;
  const rewrittenManifestCoreWithoutInvocation = Object.freeze({
    ...manifestCore,
    processAnchorRoot: terminalSelectionProcessAnchorRoot(rewrittenProcess),
    sixStep: Object.freeze({
      ...manifestCore.sixStep,
      joinedProcessEvidenceRoot: rewrittenProcess.evidenceRoot,
      performanceAppendRecordId: rewrittenProcess.durableAppendRecordId,
    }),
  });
  const rewrittenInvocationRoot = hashDomain("aloha/production-terminal-phase-invocation/v1", {
    finalDurableWindowId: rewrittenManifestCoreWithoutInvocation.finalDurableWindowId,
    fullGraphCoarseSweepRoot: rewrittenManifestCoreWithoutInvocation.fullGraphCoarseSweepRoot,
    fullFamilyObservationRoot: projectionValue.observationRoot,
    sixStepObservationRoot: rewrittenManifestCoreWithoutInvocation.sixStep.observationRoot,
    releaseAnchorRoot: rewrittenManifestCoreWithoutInvocation.releaseAnchorRoot,
    runtimeAnchorRoot: rewrittenManifestCoreWithoutInvocation.runtimeAnchorRoot,
    runtimeArtifactRoot: rewrittenManifestCoreWithoutInvocation.runtimeArtifactRoot,
    processAnchorRoot: rewrittenManifestCoreWithoutInvocation.processAnchorRoot,
  });
  const rewrittenManifestCore = Object.freeze({
    ...rewrittenManifestCoreWithoutInvocation,
    terminalPhaseInvocationRoot: rewrittenInvocationRoot,
  });
  const rewrittenManifest = Object.freeze({
    ...rewrittenManifestCore,
    manifestRoot: hashDomain(
      "aloha/production-terminal-phase-manifest/v1",
      rewrittenManifestCore as unknown as CanonicalJson,
    ),
  });
  const manifestArtifact = artifact(
    encodeCanonicalBytes(rewrittenManifest),
    TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.terminalManifest,
    "spliced-manifest",
  );
  const processArtifact = artifact(
    encodeCanonicalBytes(rewrittenProcess),
    TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.processEvidence,
    "spliced-process",
  );
  const facts = createTerminalSelectionFactV1({
    rawSelectionArtifactRefId: rawRef.artifactRefId,
    terminalManifestArtifactRefId: manifestArtifact.ref.artifactRefId,
    fullFamilyProjectionArtifactRefId: base.refs[2]!.artifactRefId,
    processEvidenceArtifactRefId: processArtifact.ref.artifactRefId,
    sixStepPredicateArtifactRefIds: base.refs.slice(4).map(value => value.artifactRefId),
  });
  const refs = [rawRef, manifestArtifact.ref, base.refs[2]!, processArtifact.ref, ...base.refs.slice(4)];
  const claims = [rawClaim, manifestArtifact.claim, base.claims[2]!, processArtifact.claim, ...base.claims.slice(4)];
  const leases = [rawLease, manifestArtifact.lease, base.leases[2]!, processArtifact.lease, ...base.leases.slice(4)];
  assert.deepEqual(verdicts({
    ...base,
    facts: [facts],
    refs,
    claims,
    leases,
    observations: [{
      observationId: "append-splice",
      rawArtifactRefs: refs,
      observedClaimIds: claims.map(value => value.claimId),
    }],
    trustedObserverInvocation: {
      ...base.trustedObserverInvocation!,
      authenticatedArtifactRefIds: refs.map(value => value.artifactRefId).sort(),
    },
  }), ["invalid", "invalid"]);
});
