import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { ReadyFullFamilyEvidenceSnapshotV1 } from "../../../packages/checkpoint/src/ready-full-family-evidence.ts";
import { readCheckpointReadyFullFamilyEvidence } from "../../../packages/checkpoint/src/ready-full-family-evidence-consumer.ts";
import type { NativeFullFamilyAuditV1 } from "../../../packages/search-pipeline/src/index.ts";
import type { RuntimeReleaseFullFamilyTerminalBindingV1 } from "../../../packages/runtime-release-authority/src/full-family-terminal-consumer.ts";
import { readRuntimeReleaseFullGraphCoarseSweepManifestV1 } from "../../../packages/runtime-release-authority/src/full-graph-coarse-sweep-consumer.ts";
import {
  fullGraphTransitionSequenceRootV1,
  sealFullGraphCoarseSweepV1,
  type FullGraphCoarseSweepV1,
} from "../../../packages/full-graph-coarse-sweep/src/index.ts";
import {
  qualifiedCoarseProjectionReceiptRootV1,
  sealCoarseEdgeProjectionV1,
} from "../../../packages/coarse-economics/src/index.ts";
import type {
  FullFamilyCandidateProofVerifierBindingV1,
} from "../../../specs/full-family-facts/src/index.ts";
import type { FullFamilyReleaseArtifactObservationV1 } from "../src/full-family-release-artifacts.ts";
import {
  readProductionRuntimeReleaseFullFamilyTerminalBinding,
  validateProductionFullFamilyBindings,
} from "../src/full-family-observer.ts";
import {
  assertActiveReadyGraphCoarseSweepDenominatorV1,
  derivePlannerCompatibleReadyGraphTransitionsV1,
} from "../src/internal/terminal-phase-snapshot-trust-state.ts";

const h = (value: string): Hash => hashDomain("test/production-full-family-observer/v1", value);
const cutoff = Object.freeze({ chainId: "1", number: "49", hash: h("block:49"), stateRoot: h("state:49") });

function fullGraphSweep(
  snapshot: ReadyFullFamilyEvidenceSnapshotV1,
  terminal: RuntimeReleaseFullFamilyTerminalBindingV1,
  entries: FullGraphCoarseSweepV1["entries"] = Object.freeze([]),
): FullGraphCoarseSweepV1 {
  const bindingBody = Object.freeze({
    runtimeBindingId: terminal.runtimeBindingId,
    releaseProvenanceHash: terminal.releaseProvenanceHash,
    candidateReleaseCommit: terminal.candidateReleaseCommit,
    releaseMembershipRoot: h("release-membership"),
    definitionCatalogRoot: snapshot.ready.definitionCatalogRoot,
    familyCompositionRoot: h("family-composition"),
    generationId: snapshot.ready.generationId,
    readyRecordHash: snapshot.ready.readyRecordHash,
    graphRoot: snapshot.ready.graphRoot,
    readyCutoff: snapshot.ready.cutoff as FullGraphCoarseSweepV1["binding"]["readyCutoff"],
    recentObservationRange: Object.freeze({
      from: snapshot.ready.recentObservationRange.from,
      to: snapshot.ready.recentObservationRange.to,
      blockCount: "50" as const,
    }),
    currentSourceSessionId: h("sweep-source-session"),
    actualCurrentSource: terminal.actualCurrentSource as FullGraphCoarseSweepV1["binding"]["actualCurrentSource"],
    amountSeedHash: h("amount-seed"),
    objectiveRef: h("sweep-objective"),
  });
  const binding = Object.freeze({
    ...bindingBody,
    bindingRoot: hashDomain("aloha/full-graph-coarse-sweep-binding/v1", bindingBody),
  });
  const boundEntries = entries.map((entry, ordinal) => {
    const body = Object.freeze({ ...entry, bindingRoot: binding.bindingRoot, ordinal: String(ordinal) });
    const { entryRoot: _entryRoot, ...entryBody } = body;
    return Object.freeze({
      ...entryBody,
      entryRoot: hashDomain("aloha/full-graph-coarse-sweep-entry/v1", entryBody),
    });
  });
  const observed = boundEntries.filter(entry => entry.status === "observed");
  const missing = boundEntries.filter(entry => entry.status === "missing");
  const expectedTransitionIds = boundEntries.map(entry => entry.transitionId);
  const observedTransitionIds = observed.map(entry => entry.transitionId);
  const missingTransitionIds = missing.map(entry => entry.transitionId);
  const familyCounts = new Map<string, { expected: number; observed: number; missing: number }>();
  for (const entry of boundEntries) {
    const counts = familyCounts.get(entry.edge.owningFamilyId) ?? { expected: 0, observed: 0, missing: 0 };
    counts.expected += 1;
    if (entry.status === "observed") counts.observed += 1;
    else counts.missing += 1;
    familyCounts.set(entry.edge.owningFamilyId, counts);
  }
  const body = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.full-graph-coarse-sweep-v1" as const,
    binding,
    expectedTransitionCount: String(boundEntries.length),
    expectedTransitionIds: Object.freeze(expectedTransitionIds),
    expectedTransitionRoot: fullGraphTransitionSequenceRootV1("expected", expectedTransitionIds),
    observedTransitionCount: String(observed.length),
    observedTransitionIds: Object.freeze(observedTransitionIds),
    observedTransitionRoot: fullGraphTransitionSequenceRootV1("observed", observedTransitionIds),
    missingTransitionCount: String(missing.length),
    missingTransitionIds: Object.freeze(missingTransitionIds),
    missingTransitionRoot: fullGraphTransitionSequenceRootV1("missing", missingTransitionIds),
    familyTransitionCounts: Object.freeze([...familyCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([familyId, counts]) => Object.freeze({
        familyId,
        expectedTransitionCount: String(counts.expected),
        observedTransitionCount: String(counts.observed),
        missingTransitionCount: String(counts.missing),
      }))),
    entries: Object.freeze(boundEntries),
  });
  return sealFullGraphCoarseSweepV1(body);
}

function graphEdge(suffix: string, familyDefinitionHash: Hash, familyId = "alpha-family", portCount = 1) {
  const inputIdentity = Object.freeze({
    chainId: "1",
    kind: "erc20" as const,
    address: "0x1111111111111111111111111111111111111111",
  });
  const outputIdentity = Object.freeze({
    chainId: "1",
    kind: "erc20" as const,
    address: "0x2222222222222222222222222222222222222222",
  });
  const instanceKey = `instance-${suffix}`;
  const instancePublicationHash = h(`publication-${suffix}`);
  const payload = Object.freeze({
    inputAssetPorts: Object.freeze(Array.from({ length: portCount }, (_, index) => Object.freeze({
      assetIdentity: inputIdentity,
      assetRef: hashDomain("aloha/asset-ref/v1", inputIdentity),
      portRef: h(`input-port-${suffix}-${index}`),
      ordinal: String(index),
    }))),
    outputAssetPorts: Object.freeze(Array.from({ length: portCount }, (_, index) => Object.freeze({
      assetIdentity: outputIdentity,
      assetRef: hashDomain("aloha/asset-ref/v1", outputIdentity),
      portRef: h(`output-port-${suffix}-${index}`),
      ordinal: String(index),
    }))),
    opaqueTransitionRef: h(`transition-${suffix}`),
    constraintRefs: Object.freeze([]),
    owningFamilyId: familyId,
    owningFamilyDefinitionHash: familyDefinitionHash,
    owningInstanceKey: instanceKey,
    instancePublicationHash,
    staticProjectionHash: h(`static-projection-${suffix}`),
    projectionHash: h(`projection-${suffix}`),
    rehydrationRef: Object.freeze({
      familyDefinitionHash,
      instanceKey,
      instancePublicationHash,
      staticProjectionMemoHash: h(`static-memo-${suffix}`),
      requestedArtifactDependencyRoot: h(`artifact-dependency-${suffix}`),
    }),
  });
  return Object.freeze({
    edgeId: hashDomain("aloha/persisted-graph-edge/v1", payload),
    ...payload,
  });
}

function missingTransitionEntries(
  edges: readonly ReturnType<typeof graphEdge>[],
): readonly FullGraphCoarseSweepV1["entries"][number][] {
  const edgesById = new Map(edges.map(edge => [edge.edgeId, edge]));
  return derivePlannerCompatibleReadyGraphTransitionsV1(edges).map((transition, ordinal) => Object.freeze({
    bindingRoot: h("rebound-by-helper"),
    ordinal: String(ordinal),
    transitionId: transition.transitionId,
    edge: edgesById.get(transition.edgeId)!,
    inputAssetRef: transition.inputAssetRef,
    inputPortRef: transition.inputPortRef,
    outputAssetRef: transition.outputAssetRef,
    outputPortRef: transition.outputPortRef,
    status: "missing" as const,
    missingReason: "coarse-owner-missing" as const,
    receipt: null,
    familyObservation: null,
    entryRoot: h("recomputed-by-helper"),
  }));
}

function observedUnavailableTransitionEntry(
  sweep: FullGraphCoarseSweepV1,
  entry: FullGraphCoarseSweepV1["entries"][number],
): FullGraphCoarseSweepV1["entries"][number] {
  const routeBindingHash = h(`route-binding:${entry.transitionId}`);
  const amountHash = h(`amount:${entry.transitionId}`);
  const bindingBody = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.coarse-edge-sweep-binding-v1" as const,
    familyId: entry.edge.owningFamilyId,
    familyDefinitionHash: entry.edge.owningFamilyDefinitionHash,
    edgeId: entry.edge.edgeId,
    transitionRef: entry.edge.opaqueTransitionRef,
    inputAssetRef: entry.inputAssetRef,
    inputPortRef: entry.inputPortRef,
    outputAssetRef: entry.outputAssetRef,
    outputPortRef: entry.outputPortRef,
    routeBindingHash,
    routeOwnerRef: h(`route-owner:${entry.transitionId}`),
    generationId: sweep.binding.generationId,
    readyRecordHash: sweep.binding.readyRecordHash,
    graphRoot: sweep.binding.graphRoot,
    readyCutoff: sweep.binding.readyCutoff,
    source: sweep.binding.actualCurrentSource,
    objectiveRef: sweep.binding.objectiveRef,
    releaseProvenanceHash: sweep.binding.releaseProvenanceHash,
  });
  const binding = Object.freeze({
    ...bindingBody,
    bindingRoot: hashDomain("aloha/coarse-edge-sweep-binding/v1", bindingBody),
  });
  const ownerDescriptor = Object.freeze({
    ownerRef: h(`coarse-owner:${entry.transitionId}`),
    capabilityId: "test/coarse-owner",
    capabilityVersion: "1",
    schemaRef: h(`coarse-schema:${entry.transitionId}`),
    interpreterHash: h(`coarse-interpreter:${entry.transitionId}`),
    implementationHash: h(`coarse-implementation:${entry.transitionId}`),
    boundVerifierHash: h(`coarse-verifier:${entry.transitionId}`),
  });
  const projection = sealCoarseEdgeProjectionV1({
    edgeId: entry.edge.edgeId,
    transitionRef: entry.edge.opaqueTransitionRef,
    routeBindingHash,
    generationId: sweep.binding.generationId,
    graphRoot: sweep.binding.graphRoot,
    source: sweep.binding.actualCurrentSource,
    objectiveRef: sweep.binding.objectiveRef,
    ownerRef: ownerDescriptor.ownerRef,
    capabilityDigest: h(`coarse-capability:${entry.transitionId}`),
    dependencyRoot: h(`coarse-dependency:${entry.transitionId}`),
    stateFactsRoot: h(`state-facts:${entry.transitionId}`),
    sampleInput: Object.freeze({ assetRef: entry.inputAssetRef, amount: "1" }),
    estimatedOutput: null,
    conservativeOutputUpperBound: null,
    inputCapacityUpperBound: null,
    status: "unavailable",
    reasonCode: "test-unavailable",
  });
  const receiptBody = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.qualified-coarse-projection-receipt-v1" as const,
    releaseMembershipRoot: sweep.binding.releaseMembershipRoot,
    releaseProvenanceHash: sweep.binding.releaseProvenanceHash,
    ownerQualificationLeafDigest: hashDomain("aloha/coarse-owner-qualification-leaf/v1", ownerDescriptor),
    ownerDescriptor,
    projection,
    boundVerification: null,
  });
  const receipt = Object.freeze({
    ...receiptBody,
    receiptRoot: qualifiedCoarseProjectionReceiptRootV1(receiptBody),
  });
  const observationBody = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.family-runtime-coarse-edge-sweep-observation-v1" as const,
    familyId: entry.edge.owningFamilyId,
    familyDefinitionHash: entry.edge.owningFamilyDefinitionHash,
    releaseMembershipRoot: sweep.binding.releaseMembershipRoot,
    binding,
    routeHandleBindingHash: routeBindingHash,
    amountHash,
    projectionId: projection.projectionId,
    stateOutcome: Object.freeze({ kind: "unavailable", stage: "state", reasonCode: "test-unavailable" }),
    coarseOutcome: null,
  });
  const familyObservation = Object.freeze({
    ...observationBody,
    observationRoot: hashDomain("aloha/family-runtime-coarse-edge-sweep-observation/v1", observationBody),
  });
  return Object.freeze({
    ...entry,
    status: "observed",
    missingReason: null,
    receipt,
    familyObservation: familyObservation as never,
  });
}

function fixture(): Readonly<{
  snapshot: ReadyFullFamilyEvidenceSnapshotV1;
  audit: NativeFullFamilyAuditV1;
  release: FullFamilyReleaseArtifactObservationV1;
  verifier: FullFamilyCandidateProofVerifierBindingV1;
  terminalBinding: RuntimeReleaseFullFamilyTerminalBindingV1;
  sweep: FullGraphCoarseSweepV1;
}> {
  const definitionCatalogRoot = h("definition-catalog");
  const releaseProvenanceHash = h("release-provenance");
  const proofKeyId = h("proof-key");
  const ready = {
    generationId: h("generation"),
    parentGenerationId: null,
    generationRefreshPolicyHash: h("refresh-policy"),
    cutoff,
    recentObservationRange: { from: "0", to: "49" },
    definitionCatalogRoot,
    sourceCoverageRoot: h("source-coverage"),
    candidatePartitionRoot: h("candidate-partition"),
    nominationClosureRoot: h("nomination-closure"),
    nominationClosureStorageHash: h("nomination-storage"),
    candidatePartitionProofStorageHash: h("candidate-proof-storage"),
    releaseProvenanceHash,
    exactOutcomePartitionRoot: h("outcome-partition"),
    verifiedMemoSetRoot: h("memo-set"),
    instanceCatalogRoot: h("instance-catalog"),
    graphRoot: h("graph"),
    edgeCount: "0",
    instanceCount: "0",
    promotionFreshness: {} as never,
    promotionRevision: "1",
    promotedAtMonotonicNs: "1",
    readyRecordHash: h("ready-record"),
  } as const;
  const binding = Object.freeze({
    readyRecordHash: ready.readyRecordHash,
    generationId: ready.generationId,
    cutoff,
    definitionCatalogRoot,
    sourceCoverageRoot: ready.sourceCoverageRoot,
    candidatePartitionRoot: ready.candidatePartitionRoot,
    exactOutcomePartitionRoot: ready.exactOutcomePartitionRoot,
    verifiedMemoSetRoot: ready.verifiedMemoSetRoot,
    instanceCatalogRoot: ready.instanceCatalogRoot,
    graphRoot: ready.graphRoot,
    releaseProvenanceHash,
    promotionRevision: ready.promotionRevision,
  });
  const familyDefinitionHash = h("family-definition");
  const sourcePlanRef = Object.freeze({
    ownerRef: h("source-owner"),
    sourcePlanRef: h("source-plan"),
    familyDefinitionHash,
    completeness: "complete-snapshot" as const,
    historyStartBlock: null,
  });
  const nominationFamily = Object.freeze({
    familyId: "alpha-family",
    familyDefinitionHash,
    familyCandidateKeys: Object.freeze([]),
    candidateSetRoot: hashDomain("aloha/nomination-family-candidates/v1", []),
    candidateCount: "0",
  });
  const nominationClosure = {
    cutoff,
    root: ready.nominationClosureRoot,
    sourceCoverageRoot: ready.sourceCoverageRoot,
    candidatePartitionRoot: ready.candidatePartitionRoot,
    families: Object.freeze([nominationFamily]),
  } as unknown as ReadyFullFamilyEvidenceSnapshotV1["nominationClosure"];
  const candidatePartitionProof = {
    candidatePartitionRoot: ready.candidatePartitionRoot,
    nominationClosureRoot: ready.nominationClosureRoot,
    releaseProvenanceHash,
    issuerKeyId: proofKeyId,
    signerKeyId: proofKeyId,
  } as unknown as ReadyFullFamilyEvidenceSnapshotV1["stage12"]["candidatePartitionProof"];
  const snapshot = {
    ready,
    stage12: {
      binding,
      runId: "run-1",
      candidates: Object.freeze([]),
      outcomes: Object.freeze([]),
      candidatePartitionProof,
      sourceCoverage: {} as never,
      verifiedInstances: Object.freeze([]),
      instanceCatalog: { publications: Object.freeze([]), instanceCount: "0", instanceCatalogRoot: ready.instanceCatalogRoot, cutoff },
      graph: { edges: Object.freeze([]), edgeCount: "0", graphRoot: ready.graphRoot, instanceCatalogRoot: ready.instanceCatalogRoot, cutoff },
      promotionLineage: {} as never,
    },
    nominationClosure,
    sourceExecutionSet: { executions: Object.freeze([]) } as never,
    sourcePlanEvidenceReceipts: Object.freeze([]),
    rawEvidenceLocatorContents: Object.freeze([]),
    sourceCoverageStorageHash: h("source-coverage-storage"),
    sourceExecutionSetStorageHash: h("source-execution-storage"),
    sourcePlanEvidenceStorageHash: h("source-evidence-storage"),
    nominationClosureStorageHash: ready.nominationClosureStorageHash,
    candidatePartitionStorageHash: h("candidate-storage"),
    candidatePartitionProofStorageHash: ready.candidatePartitionProofStorageHash,
  } as unknown as ReadyFullFamilyEvidenceSnapshotV1;
  const bindingBody = Object.freeze({
    correlationId: h("correlation"),
    sourceSessionId: h("source-session"),
    generationId: ready.generationId,
    readyRecordHash: ready.readyRecordHash,
    readyCutoff: cutoff,
    graphRoot: ready.graphRoot,
    releaseProvenanceHash,
    actualCurrentSource: cutoff,
    planningProblemHash: h("planning-problem"),
    plannerEnumerationRoot: h("enumeration"),
  });
  const auditBinding = Object.freeze({
    ...bindingBody,
    bindingRoot: hashDomain("aloha/native-full-family-audit-binding/v1", bindingBody),
  });
  const auditBody = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.native-full-family-audit-v1" as const,
    binding: auditBinding,
    expectedCandidateCount: "0",
    expectedLegCount: "0",
    observedReceiptCount: "0",
    missingLegKeys: Object.freeze([]),
    expectedProjectedEdgeCount: "0",
    observedProjectedEdgeCount: "0",
    missingProjectedEdgeIds: Object.freeze([]),
    expectedActionLineageCount: "0",
    observedActionLineageCount: "0",
    missingActionCandidateIds: Object.freeze([]),
    denominatorRoot: hashDomain("aloha/native-full-family-audit-denominator/v1", []),
    observedReceiptRoot: hashDomain("aloha/native-full-family-audit-observed-receipts/v1", []),
    missingLegRoot: hashDomain("aloha/native-full-family-audit-missing-legs/v1", []),
    projectedEdgeDenominatorRoot: hashDomain("aloha/native-full-family-audit-projected-edge-denominator/v1", []),
    missingProjectedEdgeRoot: hashDomain("aloha/native-full-family-audit-missing-projected-edges/v1", []),
    actionDenominatorRoot: hashDomain("aloha/native-full-family-audit-action-denominator/v1", []),
    actionObservedRoot: hashDomain("aloha/native-full-family-audit-action-observed/v1", []),
    coarseRoutes: Object.freeze([]),
    projectedEdges: Object.freeze([]),
    actionLineage: Object.freeze([]),
  });
  const audit = Object.freeze({
    ...auditBody,
    auditRoot: hashDomain("aloha/native-full-family-audit/v1", auditBody),
  });
  const release = Object.freeze({
    sourceContentSha256: Object.freeze({
      releaseIntent: h("release-source"),
      familyCatalog: h("family-source"),
      runtimeComposition: h("runtime-source"),
      strategyCatalog: Object.freeze({ kind: "observed" as const, contentSha256: h("strategy-source") }),
    }),
    releaseIntentRoot: h("release-intent"),
    familyDefinitionCatalogRoot: h("family-catalog-root"),
    runtimeDescriptorRoot: h("runtime-descriptor"),
    globalDefinitionCatalogRoot: Object.freeze({
      kind: "complete" as const,
      definitionCatalogRoot,
      familyDefinitionCatalogRoot: h("family-catalog-root"),
      strategyDefinitionCatalogRoot: h("strategy-catalog-root"),
    }),
    families: Object.freeze([Object.freeze({
      familyId: "alpha-family",
      manifestRoot: h("manifest"),
      publicEntry: Object.freeze({ modulePath: "families/alpha-family/src/public.ts", exportName: "ALPHA_FAMILY" }),
      familyDefinitionHash,
      definitionCatalogLeafDigest: h("family-leaf"),
      capabilityCatalogRoot: h("capability-root"),
      lifecycleOwnerRefs: {} as never,
      capabilityOwnerRefs: Object.freeze([]),
      actionOwnerRefs: Object.freeze([]),
      sourcePlanRoot: h("source-plan-root"),
      sourcePlanRefs: Object.freeze([sourcePlanRef]),
    })]),
  });
  const verifier = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.full-family-candidate-proof-verifier-binding" as const,
    runtimeBindingId: h("runtime-binding"),
    releaseProvenanceHash,
    releaseAuthorityRoot: h("release-authority"),
    candidateReleaseCommit: "1".repeat(40),
    proofKeyId,
    proofPublicKeyHex: `0x${"11".repeat(32)}` as `0x${string}`,
  });
  const terminalBindingBody = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.runtime-release-full-family-terminal-binding-v1" as const,
    runtimeBindingId: verifier.runtimeBindingId,
    candidateReleaseCommit: verifier.candidateReleaseCommit,
    releaseProvenanceHash,
    finalDurableWindowId: h("final-durable-window"),
    producerTerminalId: h("producer-terminal"),
    producerHeadFactsRoot: h("producer-head-facts"),
    producerTerminalBindingRoot: h("producer-terminal-binding"),
    laneTerminalSetRoot: h("lane-terminal-set"),
    searchTerminalHash: h("search-terminal"),
    terminalKind: "route-set-terminal" as const,
    terminalLineageHash: h("terminal-lineage"),
    nativeAuditRoot: audit.auditRoot,
    readyRecordHash: ready.readyRecordHash,
    generationId: ready.generationId,
    graphRoot: ready.graphRoot,
    generatedRuntime: Object.freeze({
      releaseIntentRoot: release.releaseIntentRoot,
      definitionCatalogRoot,
      runtimeDescriptorRoot: release.runtimeDescriptorRoot,
      families: Object.freeze(release.families.map(family => Object.freeze({
        familyId: family.familyId,
        familyDefinitionHash: family.familyDefinitionHash,
        sourcePlanRoot: family.sourcePlanRoot,
        sourcePlanRefs: family.sourcePlanRefs,
      }))),
    }),
    readyCutoff: ready.cutoff,
    actualCurrentSource: audit.binding.actualCurrentSource,
    audit,
  });
  const terminalBinding = Object.freeze({
    ...terminalBindingBody,
    bindingRoot: hashDomain("aloha/runtime-release-full-family-terminal-binding/v1", terminalBindingBody),
  });
  return Object.freeze({ snapshot, audit, release, verifier, terminalBinding, sweep: fullGraphSweep(snapshot, terminalBinding) });
}

function auditWithBinding(
  value: NativeFullFamilyAuditV1,
  bindingChanges: Partial<NativeFullFamilyAuditV1["binding"]>,
): NativeFullFamilyAuditV1 {
  const { bindingRoot: _oldBindingRoot, ...oldBinding } = value.binding;
  const bindingBody = Object.freeze({ ...oldBinding, ...bindingChanges });
  const binding = Object.freeze({
    ...bindingBody,
    bindingRoot: hashDomain("aloha/native-full-family-audit-binding/v1", bindingBody),
  });
  const { auditRoot: _oldAuditRoot, binding: _oldBinding, ...oldAudit } = value;
  const auditBody = Object.freeze({ ...oldAudit, binding });
  return Object.freeze({
    ...auditBody,
    auditRoot: hashDomain("aloha/native-full-family-audit/v1", auditBody),
  });
}

function terminalBindingForAudit(
  value: RuntimeReleaseFullFamilyTerminalBindingV1,
  audit: NativeFullFamilyAuditV1,
): RuntimeReleaseFullFamilyTerminalBindingV1 {
  const body = Object.freeze({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    runtimeBindingId: value.runtimeBindingId,
    candidateReleaseCommit: value.candidateReleaseCommit,
    releaseProvenanceHash: value.releaseProvenanceHash,
    finalDurableWindowId: value.finalDurableWindowId,
    producerTerminalId: value.producerTerminalId,
    producerHeadFactsRoot: value.producerHeadFactsRoot,
    producerTerminalBindingRoot: value.producerTerminalBindingRoot,
    laneTerminalSetRoot: value.laneTerminalSetRoot,
    searchTerminalHash: value.searchTerminalHash,
    terminalKind: value.terminalKind,
    terminalLineageHash: value.terminalLineageHash,
    nativeAuditRoot: audit.auditRoot,
    readyRecordHash: value.readyRecordHash,
    generationId: value.generationId,
    graphRoot: value.graphRoot,
    generatedRuntime: value.generatedRuntime,
    readyCutoff: value.readyCutoff,
    actualCurrentSource: audit.binding.actualCurrentSource,
    audit,
  });
  return Object.freeze({
    ...body,
    bindingRoot: hashDomain("aloha/runtime-release-full-family-terminal-binding/v1", body),
  });
}

test("owner consumer edges reject structural reader and native-audit clones", () => {
  assert.throws(
    () => readCheckpointReadyFullFamilyEvidence(Object.freeze({ read() {} }) as never, Object.freeze(Object.create(null)) as never),
    /not checkpoint-issued/,
  );
  assert.throws(
    () => readProductionRuntimeReleaseFullFamilyTerminalBinding(Object.freeze(Object.create(null))),
    /not issued|invalid/,
  );
  assert.throws(
    () => readRuntimeReleaseFullGraphCoarseSweepManifestV1(Object.freeze(Object.create(null))),
    /not issued|invalid/,
  );
});

test("authenticated-fact invariant analysis returns explicit schema lineage gaps without a verdict", () => {
  const value = fixture();
  const missing = validateProductionFullFamilyBindings(value.snapshot, value.audit, value.release, value.verifier, value.terminalBinding, value.sweep);
  assert.deepEqual(missing.map(item => item.code), []);
  assert.equal((missing as unknown as { verdict?: unknown }).verdict, undefined);
});

test("50-block range, missing Strategy/global root, and ready/audit splices fail closed", () => {
  const value = fixture();
  const wrongRangeSnapshot = {
    ...value.snapshot,
    ready: { ...value.snapshot.ready, recentObservationRange: { from: "1", to: "49" } },
  };
  assert.throws(() => validateProductionFullFamilyBindings(
    wrongRangeSnapshot,
    value.audit,
    value.release,
    value.verifier,
    value.terminalBinding,
    fullGraphSweep(wrongRangeSnapshot, value.terminalBinding),
  ), /exact 50-block window|cutoff-49/);
  assert.throws(() => validateProductionFullFamilyBindings(
    value.snapshot,
    value.audit,
    { ...value.release, globalDefinitionCatalogRoot: { kind: "missing", reason: "strategy-catalog-source-not-supplied", familyDefinitionCatalogRoot: h("family"), runtimeDeclaredDefinitionCatalogRoot: h("runtime") } },
    value.verifier,
    value.terminalBinding,
    value.sweep,
  ), /Strategy catalog/);
  assert.throws(() => validateProductionFullFamilyBindings(
    value.snapshot,
    auditWithBinding(value.audit, { readyRecordHash: h("other-ready") }),
    value.release,
    value.verifier,
    value.terminalBinding,
    value.sweep,
  ), /audit\/ready splice/);
});

test("candidate/outcome, candidate-proof, and release/ready splices fail closed", () => {
  const value = fixture();
  assert.throws(() => validateProductionFullFamilyBindings(
    { ...value.snapshot, stage12: { ...value.snapshot.stage12, outcomes: [{} as never] } },
    value.audit,
    value.release,
    value.verifier,
    value.terminalBinding,
    value.sweep,
  ), /candidate\/outcome denominator splice/);
  assert.throws(() => validateProductionFullFamilyBindings(
    { ...value.snapshot, stage12: { ...value.snapshot.stage12, candidatePartitionProof: { ...value.snapshot.stage12.candidatePartitionProof, candidatePartitionRoot: h("foreign-partition") } } },
    value.audit,
    value.release,
    value.verifier,
    value.terminalBinding,
    value.sweep,
  ), /candidate\/nomination\/ready splice/);
  assert.throws(() => validateProductionFullFamilyBindings(
    value.snapshot,
    value.audit,
    { ...value.release, globalDefinitionCatalogRoot: {
      kind: "complete",
      definitionCatalogRoot: h("foreign-definition"),
      familyDefinitionCatalogRoot: value.release.familyDefinitionCatalogRoot,
      strategyDefinitionCatalogRoot: h("strategy-catalog-root"),
    } },
    value.verifier,
    value.terminalBinding,
    value.sweep,
  ), /global definition root splice/);
});

test("full-Graph sweep is the denominator and missing coarse owner facts remain typed", () => {
  const value = fixture();
  const edge = graphEdge("one", value.release.families[0]!.familyDefinitionHash, "alpha-family", 2);
  const snapshot = {
    ...value.snapshot,
    stage12: {
      ...value.snapshot.stage12,
      instanceCatalog: { ...value.snapshot.stage12.instanceCatalog, publications: [{} as never] },
      graph: { ...value.snapshot.stage12.graph, edges: [edge as never], edgeCount: "1" },
    },
  };
  const audit = auditWithBinding(value.audit, {
    actualCurrentSource: { ...cutoff, number: "50", hash: h("block:50"), stateRoot: h("state:50") },
  });
  const terminalBinding = terminalBindingForAudit(value.terminalBinding, audit);
  const missingEntries = missingTransitionEntries([edge]);
  const sweep = fullGraphSweep(snapshot, terminalBinding, missingEntries);
  assert.equal(sweep.expectedTransitionCount, "4");
  assert.equal(sweep.missingTransitionCount, "4");
  assert.equal(new Set(sweep.expectedTransitionIds).size, 4);
  const missing = validateProductionFullFamilyBindings(
    snapshot,
    audit,
    value.release,
    value.verifier,
    terminalBinding,
    sweep,
  );
  assert.deepEqual(new Set(missing.map(item => item.code)), new Set([
    "coarse-family-artifact-unavailable",
  ]));

  const oneObserved = observedUnavailableTransitionEntry(sweep, sweep.entries[0]!);
  const partiallyMissingSweep = fullGraphSweep(
    snapshot,
    terminalBinding,
    Object.freeze([oneObserved, ...sweep.entries.slice(1)]),
  );
  assert.equal(partiallyMissingSweep.expectedTransitionCount, "4");
  assert.equal(partiallyMissingSweep.observedTransitionCount, "1");
  assert.equal(partiallyMissingSweep.missingTransitionCount, "3");
  assert.deepEqual(partiallyMissingSweep.familyTransitionCounts, [{
    familyId: "alpha-family",
    expectedTransitionCount: "4",
    observedTransitionCount: "1",
    missingTransitionCount: "3",
  }]);
  const partialMissing = validateProductionFullFamilyBindings(
    snapshot,
    audit,
    value.release,
    value.verifier,
    terminalBinding,
    partiallyMissingSweep,
  );
  assert.deepEqual(partialMissing.map(item => item.code), ["coarse-family-artifact-unavailable"]);
  assert.equal(partialMissing.some(item => item.code === "graph-transition-audit-denominator-incomplete"), false);
  for (const changed of [
    { ...partiallyMissingSweep, observedTransitionIds: [] },
    { ...partiallyMissingSweep, missingTransitionRoot: h("foreign-missing-transition-root") },
    { ...partiallyMissingSweep, familyTransitionCounts: [{
      familyId: "alpha-family",
      expectedTransitionCount: "4",
      observedTransitionCount: "1",
      missingTransitionCount: "2",
    }] },
  ]) {
    assert.throws(
      () => validateProductionFullFamilyBindings(
        snapshot,
        audit,
        value.release,
        value.verifier,
        terminalBinding,
        changed,
      ),
      /count\/root mismatch/,
    );
  }
  const readyTransitions = derivePlannerCompatibleReadyGraphTransitionsV1([edge]);
  const activeReadyGraph = Object.freeze({
    readyRecordHash: partiallyMissingSweep.binding.readyRecordHash,
    generationId: partiallyMissingSweep.binding.generationId,
    graphRoot: partiallyMissingSweep.binding.graphRoot,
    cutoff: partiallyMissingSweep.binding.readyCutoff,
    expectedTransitionCount: "4",
    expectedTransitionRoot: fullGraphTransitionSequenceRootV1(
      "expected",
      readyTransitions.map(transition => transition.transitionId),
    ),
    orderedTransitions: readyTransitions,
    familyTransitionCounts: Object.freeze([Object.freeze({ familyId: "alpha-family", transitionCount: "4" })]),
  });
  const trustJoinSweep = Object.freeze({
    ...partiallyMissingSweep,
    readyRecordHash: partiallyMissingSweep.binding.readyRecordHash,
    generationId: partiallyMissingSweep.binding.generationId,
    graphRoot: partiallyMissingSweep.binding.graphRoot,
    readyCutoff: partiallyMissingSweep.binding.readyCutoff,
    familyTransitionCounts: partiallyMissingSweep.familyTransitionCounts.map(({ familyId, expectedTransitionCount }) =>
      Object.freeze({ familyId, expectedTransitionCount })),
  });
  assert.doesNotThrow(() => assertActiveReadyGraphCoarseSweepDenominatorV1(activeReadyGraph, trustJoinSweep));
  for (const changed of [
    { ...trustJoinSweep, expectedTransitionCount: "1" },
    { ...trustJoinSweep, expectedTransitionRoot: h("foreign-transition-root") },
    { ...trustJoinSweep, graphRoot: h("foreign-graph-root") },
    { ...trustJoinSweep, familyTransitionCounts: [{ familyId: "alpha-family", expectedTransitionCount: "1" }] },
  ]) {
    assert.throws(
      () => assertActiveReadyGraphCoarseSweepDenominatorV1(activeReadyGraph, changed),
      /root-owned Ready Graph\/coarse transition denominator splice/,
    );
  }

  const omitted = fullGraphSweep(snapshot, terminalBinding);
  assert.equal(validateProductionFullFamilyBindings(
    snapshot,
    audit,
    value.release,
    value.verifier,
    terminalBinding,
    omitted,
  ).some(item => item.code === "graph-transition-audit-denominator-incomplete"), true);

  assert.throws(() => validateProductionFullFamilyBindings(
    snapshot,
    audit,
    value.release,
    value.verifier,
    terminalBinding,
    { ...sweep, observedTransitionCount: "1" },
  ), /count\/root mismatch/);
  assert.throws(() => validateProductionFullFamilyBindings(
    snapshot,
    audit,
    value.release,
    value.verifier,
    terminalBinding,
    { ...sweep, binding: { ...sweep.binding, actualCurrentSource: cutoff } },
  ), /binding root mismatch/);

  const crossSourceSweep = fullGraphSweep(snapshot, value.terminalBinding, missingEntries);
  assert.throws(() => validateProductionFullFamilyBindings(
    snapshot,
    audit,
    value.release,
    value.verifier,
    terminalBinding,
    crossSourceSweep,
  ), /sweep\/release\/ready\/source splice/);

  const foreignGraphSnapshot = {
    ...snapshot,
    ready: { ...snapshot.ready, graphRoot: h("foreign-graph") },
  };
  const crossGraphSweep = fullGraphSweep(foreignGraphSnapshot, terminalBinding, missingEntries);
  assert.throws(() => validateProductionFullFamilyBindings(
    snapshot,
    audit,
    value.release,
    value.verifier,
    terminalBinding,
    crossGraphSweep,
  ), /sweep\/release\/ready\/source splice/);
});

test("full-Graph sweep rejects a self-consistent reordered transition denominator", () => {
  const value = fixture();
  const first = graphEdge("a", value.release.families[0]!.familyDefinitionHash);
  const second = graphEdge("b", value.release.families[0]!.familyDefinitionHash);
  const snapshot = {
    ...value.snapshot,
    stage12: {
      ...value.snapshot.stage12,
      graph: { ...value.snapshot.stage12.graph, edges: [first as never, second as never], edgeCount: "2" },
    },
  };
  const reversedEntries = [...missingTransitionEntries([first, second])].reverse();
  assert.throws(() => fullGraphSweep(
    snapshot,
    value.terminalBinding,
    Object.freeze(reversedEntries),
  ), /entry identity\/status closure mismatch/);
});

test("full-Graph sweep cannot replace the active Ready Graph with a self-consistent changed subset", () => {
  const value = fixture();
  const edges = ["a", "b", "c", "d"].map(label => graphEdge(
    label,
    value.release.families[0]!.familyDefinitionHash,
  ));
  const snapshot = {
    ...value.snapshot,
    stage12: {
      ...value.snapshot.stage12,
      graph: { ...value.snapshot.stage12.graph, edges: edges as never, edgeCount: String(edges.length) },
    },
  };
  const changedSubset = fullGraphSweep(snapshot, value.terminalBinding, Object.freeze([]));
  const missing = validateProductionFullFamilyBindings(
    snapshot,
    value.audit,
    value.release,
    value.verifier,
    value.terminalBinding,
    changedSubset,
  );
  assert.equal(missing.some(item => item.code === "graph-transition-audit-denominator-incomplete"), true);
});

test("an unrelated Family adds only its transition denominator leaf", () => {
  const value = fixture();
  const alpha = graphEdge("alpha-local", value.release.families[0]!.familyDefinitionHash, "alpha-family", 1);
  const beta = graphEdge("beta-unrelated", h("beta-family-definition"), "beta-family", 2);
  const snapshotWith = (edges: readonly ReturnType<typeof graphEdge>[]) => ({
    ...value.snapshot,
    stage12: {
      ...value.snapshot.stage12,
      graph: { ...value.snapshot.stage12.graph, edges: edges as never, edgeCount: String(edges.length) },
    },
  });
  const alphaSnapshot = snapshotWith([alpha]);
  const alphaSweep = fullGraphSweep(
    alphaSnapshot,
    value.terminalBinding,
    missingTransitionEntries([alpha]),
  );
  const expandedSnapshot = snapshotWith([alpha, beta]);
  const expandedSweep = fullGraphSweep(
    expandedSnapshot,
    value.terminalBinding,
    missingTransitionEntries([alpha, beta]),
  );
  const alphaLeaf = alphaSweep.familyTransitionCounts.find(item => item.familyId === "alpha-family");
  assert.deepEqual(
    expandedSweep.familyTransitionCounts.find(item => item.familyId === "alpha-family"),
    alphaLeaf,
  );
  assert.deepEqual(expandedSweep.familyTransitionCounts.find(item => item.familyId === "beta-family"), {
    familyId: "beta-family",
    expectedTransitionCount: "4",
    observedTransitionCount: "0",
    missingTransitionCount: "4",
  });
  assert.deepEqual(
    expandedSweep.expectedTransitionIds.filter(id => alphaSweep.expectedTransitionIds.includes(id)),
    alphaSweep.expectedTransitionIds,
  );
  assert.equal(expandedSweep.expectedTransitionCount, "5");
  assert.deepEqual(
    validateProductionFullFamilyBindings(
      expandedSnapshot,
      value.audit,
      value.release,
      value.verifier,
      value.terminalBinding,
      expandedSweep,
    ).map(item => item.code),
    ["coarse-family-artifact-unavailable"],
  );
});
