import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import {
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type CanonicalJsonObject,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { nativeAssetReferenceV1 } from "../../../packages/asset-ref/src/index.ts";
import {
  createSignedReleaseRuntimeAuthorityDescriptorV1,
  projectRuntimeAuthorityDescriptorV1,
} from "../../../packages/runtime-authority/src/index.ts";
import {
  encodeNativeFullFamilyAuditBodyV1,
  nativeFullFamilyAuditSequenceRootV1,
} from "../../../packages/search-pipeline/src/index.ts";
import {
  encodeFullGraphCoarseSweepV1,
  fullGraphTransitionSequenceRootV1,
  sealFullGraphCoarseSweepV1,
} from "../../../packages/full-graph-coarse-sweep/src/index.ts";
import { economicSafetyObjectivePolicyRootV1 } from "../../../packages/economics-safety/src/index.ts";
import {
  createArtifactResolutionClaim,
  createResolverPolicy,
} from "../../../specs/artifact-resolution/src/index.ts";
import { createReadOnlyArtifactRef } from "../../../specs/core-envelope/src/index.ts";
import {
  ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
  assertSafetyProfileQualificationMembershipV1,
  decodeSafetyProfileV1,
  sealEconomicSafetyActionOwnerProposalV1,
  sealEconomicSafetyActionOwnerQualificationCertificateV1,
  sealEconomicSafetyActionOwnerQualificationSetV1,
  sealSafetyProfileV1,
} from "../../../specs/economic-safety-profile/src/index.ts";
import { ContentAddressedObserverSinkV1 } from "../src/content-addressed-sink.ts";
import type {
  ProductionTerminalPhaseLocatorV1,
  ProductionTerminalPhaseManifestV1,
} from "../src/production-terminal-phase-port.ts";
import {
  assertProductionSixStepSnapshotAppendSequencesV1,
  assertProductionSixStepSelectedDagV1,
  assertProductionSixStepLineageRootV1,
  assertProductionTerminalPhaseDurableDiscoveryV1,
  exactProductionGraphLeaseBindingV1,
  exactRootOwnedSelectedReadyEdges,
  exactStage2PersistedGraphEdgeV1,
  ProductionTerminalPhaseLocatorIndexV1,
  decodeProductionTerminalPhaseLocatorIndexV1,
  decodeProductionTerminalPhaseManifestV1,
  readProductionSixStepSnapshotBoundaryMaterialsV1,
} from "../src/terminal-phase-locator-index.ts";
import type { ObservedContentArtifactV1 } from "../src/content-addressed-sink.ts";
import {
  decodeProductionTerminalPhaseFullFamilyProjectionV1,
  type ProductionTerminalPhaseFullFamilyProjectionV1,
} from "../src/terminal-phase-full-family-projection.ts";
import {
  derivePlannerCompatibleReadyGraphTransitionsV1,
  registerProductionTerminalPhaseSnapshotTrustCapabilityV1,
  type ProductionTerminalPhaseSnapshotTrustCapabilityV1,
  type ProductionTerminalPhaseSnapshotTrustStateV1,
} from "../src/internal/terminal-phase-snapshot-trust-state.ts";
import {
  readProductionSixStepArtifactMaterialV1,
  type ProcessAnchorV1,
  type ProductionSixStepArtifactMaterialV1,
} from "../../../packages/evidence-emitter/src/index.ts";
import { createProductionSixStepTailFixture } from "../../../packages/search-pipeline/test/production-six-step-fixture.ts";
import { readPredicateDomainMaterialCapabilityV1 } from "../../gate-core/src/internal/predicate-domain-material-state.ts";
import { registerProductionPredicateMaterialSourceStateV1 } from "../src/internal/predicate-material-source-owner.ts";
import { SIX_STEP_MATERIAL_PROVIDER } from "../src/material-providers/six-step.ts";
import {
  createRawTerminalSelectionObservationV1,
  createTerminalSelectionFactV1,
  evaluateTerminalSelectionPredicate,
  terminalSelectionProcessAnchorRoot,
  terminalSelectionRuntimeAnchorRoot,
  TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS,
} from "../../terminal-selection-facts/src/runtime.ts";
import { evaluateTerminalSelectionReferenceModel } from "../../terminal-selection-facts/src/reference-model.ts";
import { TERMINAL_SELECTION_INVOCATION_SEAL_ROLE } from "../../terminal-selection-facts/src/spec.ts";
import { buildFullFamilyQualificationCorpus } from "../../full-family-facts/test/qualification-fixture.ts";
import { decodeFullFamilyPersistedGraphEdge } from "../../../specs/full-family-facts/src/index.ts";
import { decodeSixStepStageFacts } from "../../../specs/evidence/src/six-step.ts";

const h = (value: string): Hash => hashDomain("test/terminal-phase-locator-index/v1", value);
const routeOwnerRef = (familyDefinitionHash: Hash, routeBindingHash: Hash): Hash =>
  hashDomain("aloha/search-runtime-route-owner/v1", { familyDefinitionHash, routeBindingHash });
const acceptanceRouteBindingHash = (
  routeLegs: readonly Readonly<{ readonly edgeId: Hash; readonly ownerRef: Hash }>[],
): Hash => hashDomain("aloha/route-binding/v1", {
  legs: routeLegs.map(({ edgeId, ownerRef }) => ({ edgeId, ownerRef })),
});

test("terminal collector independently freezes the public route-binding domain", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/terminal-phase-locator-index.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /\bcomputeRouteBindingHash\b|\brouteBindingHash\s+as\s+/);
  assert.doesNotMatch(
    source,
    /import\s*\{[^}]*\brouteBindingHash\b[^}]*\}\s*from\s*["'][^"']*search-pipeline[^"']*["']/s,
  );
  assert.match(source, /hashDomain\("aloha\/route-binding\/v1",\s*\{/);

  const legs = Object.freeze([
    Object.freeze({ edgeId: h("independent-route-edge-a"), ownerRef: h("independent-route-owner-a") }),
    Object.freeze({ edgeId: h("independent-route-edge-b"), ownerRef: h("independent-route-owner-b") }),
  ]);
  const brokenProductionHelperResult = hashDomain("aloha/route-binding/v1", {
    legs: [...legs].reverse(),
  });
  assert.notEqual(acceptanceRouteBindingHash(legs), brokenProductionHelperResult);
});

test("production Graph lease binding decoder requires the exact current 12-field wire", () => {
  const binding = Object.freeze({
    generationId: "generation-1",
    readyRecordHash: h("ready"),
    generationRefreshPolicyHash: h("refresh-policy"),
    cutoff: Object.freeze({ chainId: "1", number: "99", hash: h("cutoff"), stateRoot: h("state-root") }),
    definitionCatalogRoot: h("definitions"),
    instanceCatalogRoot: h("instances"),
    graphRoot: h("graph"),
    runtimeAuthority: projectRuntimeAuthorityDescriptorV1(createSignedReleaseRuntimeAuthorityDescriptorV1({
      authorityClass: "signed-release",
      runtimeBindingId: h("runtime-binding"),
      releaseProvenanceHash: h("release"),
      implementationCommit: "a".repeat(40),
    })),
    releaseProvenanceHash: h("release"),
    candidatePartitionProofStorageHash: h("candidate-proof-storage"),
    nominationClosureRoot: h("nomination-closure"),
    nominationClosureStorageHash: h("nomination-storage"),
  });
  assert.deepEqual(exactProductionGraphLeaseBindingV1(binding), binding);
  for (const field of [
    "generationRefreshPolicyHash",
    "candidatePartitionProofStorageHash",
    "nominationClosureRoot",
    "nominationClosureStorageHash",
    "runtimeAuthority",
  ] as const) {
    const missing = { ...binding } as Record<string, unknown>;
    delete missing[field];
    assert.throws(() => exactProductionGraphLeaseBindingV1(missing), /missing field/);
  }
  assert.throws(
    () => exactProductionGraphLeaseBindingV1({
      ...binding,
      runtimeAuthority: { ...binding.runtimeAuthority, authorityClass: "advisory-observation" },
    }),
    /must be signed-release/,
  );
  assert.throws(() => exactProductionGraphLeaseBindingV1({ ...binding, legacyField: h("legacy") }), /unknown field/);
});

test("Stage 2 exact edge join covers fields outside the selected-leg projection", () => {
  const assetIdentity = Object.freeze({ kind: "native", chainId: "1", address: null });
  const inputAssetPorts = Object.freeze([Object.freeze({
    assetIdentity,
    assetRef: hashDomain("aloha/asset-ref/v1", assetIdentity),
    portRef: h("edge-input-port"),
    ordinal: "0",
  })]);
  const outputAssetPorts = Object.freeze([Object.freeze({
    assetIdentity,
    assetRef: hashDomain("aloha/asset-ref/v1", assetIdentity),
    portRef: h("edge-output-port"),
    ordinal: "0",
  })]);
  const payload = Object.freeze({
    inputAssetPorts,
    outputAssetPorts,
    opaqueTransitionRef: h("edge-transition"),
    constraintRefs: Object.freeze([h("edge-constraint")]),
    owningFamilyId: "fixture-family",
    owningFamilyDefinitionHash: h("edge-family-definition"),
    owningInstanceKey: "fixture-instance",
    instancePublicationHash: h("edge-publication"),
    staticProjectionHash: h("edge-static-projection"),
    projectionHash: h("edge-projection"),
    rehydrationRef: Object.freeze({
      familyDefinitionHash: h("edge-family-definition"),
      instanceKey: "fixture-instance",
      instancePublicationHash: h("edge-publication"),
      staticProjectionMemoHash: h("edge-static-memo"),
      requestedArtifactDependencyRoot: h("edge-dependencies"),
    }),
  });
  const edge = Object.freeze({ edgeId: hashDomain("aloha/persisted-graph-edge/v1", payload), ...payload });
  assert.deepEqual(exactStage2PersistedGraphEdgeV1(edge, edge, edge), edge);
  const changedPayload = Object.freeze({ ...payload, constraintRefs: Object.freeze([h("spliced-constraint")]) });
  const changedEdge = Object.freeze({
    edgeId: hashDomain("aloha/persisted-graph-edge/v1", changedPayload),
    ...changedPayload,
  });
  assert.throws(() => exactStage2PersistedGraphEdgeV1(changedEdge, changedEdge, edge), /exact root-owned active Ready Graph edge/);
});

test("terminal-phase Full-Family projection decodes only transition-denominator advisory facts", () => {
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.production-terminal-phase-full-family-projection-v1" as const,
    status: "missing" as const,
    finalDurableWindowId: h("transition-projection-window"),
    readyRecordHash: h("transition-projection-ready"),
    auditRoot: h("transition-projection-audit"),
    fullGraphCoarseSweepRoot: h("transition-projection-sweep"),
    producerTerminalBindingRoot: h("transition-projection-terminal"),
    laneTerminalSetRoot: h("transition-projection-lanes"),
    bundleContentSha256: null,
    locatorContentSha256: null,
    missing: Object.freeze([Object.freeze({
      code: "graph-transition-audit-denominator-incomplete" as const,
      subjectRoot: h("transition-projection-subject"),
    })]),
  });
  const projection = Object.freeze({
    ...payload,
    observationRoot: hashDomain("aloha/production-terminal-phase-full-family-projection/v1", payload),
  });
  assert.deepEqual(decodeProductionTerminalPhaseFullFamilyProjectionV1(projection), projection);
  assert.throws(() => decodeProductionTerminalPhaseFullFamilyProjectionV1({
    ...projection,
    missing: [{ code: "graph-edge-audit-denominator-incomplete", subjectRoot: h("legacy-edge-subject") }],
  }), /code is invalid/);
});

test("qualification bundle uses canonical v2 graph root and rejects legacy v1 recomputation", async () => {
  const corpus = await buildFullFamilyQualificationCorpus();
  const artifactBytesByRef = new Map(corpus.artifacts.map(artifact => [
    artifact.artifactRefId,
    artifact.bytes,
  ] as const));
  const projectedEdges = corpus.bundle.families.flatMap(family =>
    family.projectedEdges.items.map(item => {
      const bytes = artifactBytesByRef.get(item.evidenceArtifactRefId);
      assert.ok(bytes, `missing projected edge artifact ${item.evidenceArtifactRefId}`);
      return decodeFullFamilyPersistedGraphEdge(decodeCanonicalBytes(bytes));
    })
  ).sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  const legacyGraphRoot = hashDomain("aloha/persisted-graph/v1", {
    cutoff: corpus.bundle.runtime.readyCutoff,
    instanceCatalogRoot: corpus.bundle.runtime.instanceCatalogRoot,
    edges: projectedEdges,
  });
  const producerCurrentGraphRoot = hashDomain("aloha/persisted-graph/v2", {
    cutoff: corpus.bundle.runtime.readyCutoff,
    instanceCatalogRoot: corpus.bundle.runtime.instanceCatalogRoot,
    edgeCount: String(projectedEdges.length),
    edgeSequenceRoot: hashCanonicalPartition(
      "aloha/persisted-graph-edge-sequence/v1",
      projectedEdges.map(edge => edge.edgeId),
      128,
    ),
  });
  const comparison = Object.freeze({
    producer: Object.freeze({
      edgeCount: corpus.bundle.runtime.edgeCount,
      graphRoot: corpus.bundle.runtime.graphRoot,
    }),
    terminalExpected: Object.freeze({
      edgeCount: String(projectedEdges.length),
      graphRoot: producerCurrentGraphRoot,
    }),
    legacyGraphRoot,
  });

  assert.equal(comparison.producer.edgeCount, comparison.terminalExpected.edgeCount, JSON.stringify(comparison));
  assert.equal(comparison.producer.graphRoot, comparison.terminalExpected.graphRoot, JSON.stringify(comparison));
  assert.notEqual(comparison.producer.graphRoot, comparison.legacyGraphRoot, JSON.stringify(comparison));
});

function fullFamilyAuditFixture(finalDurableWindowId: Hash) {
  const sweep = fullGraphSweepFixture(finalDurableWindowId);
  const bindingPayload = Object.freeze({
    correlationId: h(`correlation:${finalDurableWindowId}`),
    sourceSessionId: sweep.binding.currentSourceSessionId,
    generationId: sweep.binding.generationId,
    readyRecordHash: sweep.binding.readyRecordHash,
    readyCutoff: sweep.binding.readyCutoff,
    graphRoot: sweep.binding.graphRoot,
    releaseProvenanceHash: sweep.binding.releaseProvenanceHash,
    actualCurrentSource: sweep.binding.actualCurrentSource,
    planningProblemHash: h(`planning:${finalDurableWindowId}`),
    plannerEnumerationRoot: h(`enumeration:${finalDurableWindowId}`),
  });
  const binding = Object.freeze({
    ...bindingPayload,
    bindingRoot: hashDomain("aloha/native-full-family-audit-binding/v1", bindingPayload),
  });
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.native-full-family-audit-v1" as const,
    binding,
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
    denominatorRoot: nativeFullFamilyAuditSequenceRootV1("denominator", []),
    observedReceiptRoot: nativeFullFamilyAuditSequenceRootV1("observed-receipts", []),
    missingLegRoot: nativeFullFamilyAuditSequenceRootV1("missing-legs", []),
    projectedEdgeDenominatorRoot: nativeFullFamilyAuditSequenceRootV1("projected-edge-denominator", []),
    missingProjectedEdgeRoot: nativeFullFamilyAuditSequenceRootV1("missing-projected-edges", []),
    actionDenominatorRoot: nativeFullFamilyAuditSequenceRootV1("action-denominator", []),
    actionObservedRoot: nativeFullFamilyAuditSequenceRootV1("action-observed", []),
    coarseRoutes: Object.freeze([]),
    projectedEdges: Object.freeze([]),
    actionLineage: Object.freeze([]),
  });
  return encodeNativeFullFamilyAuditBodyV1(payload).audit;
}

function missingProjection(
  finalDurableWindowId: Hash,
  fullGraphCoarseSweepRoot = fullGraphSweepFixture(finalDurableWindowId).sweepRoot,
): ProductionTerminalPhaseFullFamilyProjectionV1 {
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.production-terminal-phase-full-family-projection-v1" as const,
    status: "missing" as const,
    finalDurableWindowId,
    readyRecordHash: h(`ready:${finalDurableWindowId}`),
    auditRoot: fullFamilyAuditFixture(finalDurableWindowId).auditRoot,
    fullGraphCoarseSweepRoot,
    producerTerminalBindingRoot: h(`producer:${finalDurableWindowId}`),
    laneTerminalSetRoot: h(`lanes:${finalDurableWindowId}`),
    bundleContentSha256: null,
    locatorContentSha256: null,
    missing: Object.freeze([Object.freeze({
      code: "coarse-family-artifact-unavailable" as const,
      subjectRoot: fullGraphCoarseSweepRoot,
    })]),
  });
  return Object.freeze({
    ...payload,
    observationRoot: hashDomain(
      "aloha/production-terminal-phase-full-family-projection/v1",
      payload as unknown as CanonicalJson,
    ),
  });
}

function fullGraphSweepFixture(finalDurableWindowId: Hash) {
  const assetIdentity = Object.freeze({ chainId: "1", kind: "native" as const, address: null });
  const assetPort = (label: string, ordinal: string) => Object.freeze({
    assetIdentity,
    assetRef: hashDomain("aloha/asset-ref/v1", assetIdentity),
    portRef: h(`port:${label}:${finalDurableWindowId}`),
    ordinal,
  });
  const edgePayload = Object.freeze({
    inputAssetPorts: Object.freeze([assetPort("input", "0")]),
    outputAssetPorts: Object.freeze([assetPort("output", "0")]),
    opaqueTransitionRef: h(`transition:${finalDurableWindowId}`),
    constraintRefs: Object.freeze([]),
    owningFamilyId: "univ2",
    owningFamilyDefinitionHash: h(`family-definition:${finalDurableWindowId}`),
    owningInstanceKey: `instance:${finalDurableWindowId}`,
    instancePublicationHash: h(`instance-publication:${finalDurableWindowId}`),
    staticProjectionHash: h(`static-projection:${finalDurableWindowId}`),
    projectionHash: h(`projection:${finalDurableWindowId}`),
    rehydrationRef: Object.freeze({
      familyDefinitionHash: h(`family-definition:${finalDurableWindowId}`),
      instanceKey: `instance:${finalDurableWindowId}`,
      instancePublicationHash: h(`instance-publication:${finalDurableWindowId}`),
      staticProjectionMemoHash: h(`static-projection-memo:${finalDurableWindowId}`),
      requestedArtifactDependencyRoot: h(`artifact-dependency:${finalDurableWindowId}`),
    }),
  });
  const edge = Object.freeze({ edgeId: hashDomain("aloha/persisted-graph-edge/v1", edgePayload), ...edgePayload });
  const readyCutoff = Object.freeze({ chainId: "1", number: "100", hash: h("ready-head"), stateRoot: h("ready-state") });
  const instanceCatalogRoot = h(`instance-catalog:${finalDurableWindowId}`);
  const graphRoot = hashDomain("aloha/persisted-graph/v2", {
    cutoff: readyCutoff,
    instanceCatalogRoot,
    edgeCount: "1",
    edgeSequenceRoot: hashCanonicalPartition(
      "aloha/persisted-graph-edge-sequence/v1",
      [edge.edgeId],
      128,
    ),
  });
  const bindingPayload = Object.freeze({
    runtimeBindingId: h(`runtime-binding:${finalDurableWindowId}`),
    releaseProvenanceHash: h(`release-provenance:${finalDurableWindowId}`),
    candidateReleaseCommit: "a".repeat(40),
    releaseMembershipRoot: h(`release-membership:${finalDurableWindowId}`),
    definitionCatalogRoot: h(`definition-catalog:${finalDurableWindowId}`),
    familyCompositionRoot: h(`family-composition:${finalDurableWindowId}`),
    generationId: `generation:${finalDurableWindowId}`,
    readyRecordHash: h(`ready:${finalDurableWindowId}`),
    graphRoot,
    readyCutoff,
    recentObservationRange: Object.freeze({ from: "51", to: "100", blockCount: "50" as const }),
    currentSourceSessionId: h(`source-session:${finalDurableWindowId}`),
    actualCurrentSource: Object.freeze({ chainId: "1", number: "100", hash: h("current-head"), stateRoot: h("current-state") }),
    amountSeedHash: h(`amount-seed:${finalDurableWindowId}`),
    executionContextHash: h(`execution-context:${finalDurableWindowId}`),
    objectiveRef: h(`objective:${finalDurableWindowId}`),
  });
  const binding = Object.freeze({
    ...bindingPayload,
    bindingRoot: hashDomain("aloha/full-graph-coarse-sweep-binding/v1", bindingPayload as unknown as CanonicalJson),
  });
  const transitionPayload = Object.freeze({
    edgeId: edge.edgeId,
    transitionRef: edge.opaqueTransitionRef,
    inputAssetRef: edge.inputAssetPorts[0]!.assetRef,
    inputPortRef: edge.inputAssetPorts[0]!.portRef,
    outputAssetRef: edge.outputAssetPorts[0]!.assetRef,
    outputPortRef: edge.outputAssetPorts[0]!.portRef,
    owningFamilyId: edge.owningFamilyId,
  });
  const transitionId = hashDomain("aloha/full-graph-coarse-transition/v1", transitionPayload);
  const entryPayload = Object.freeze({
    bindingRoot: binding.bindingRoot,
    ordinal: "0",
    transitionId,
    edge,
    inputAssetRef: transitionPayload.inputAssetRef,
    inputPortRef: transitionPayload.inputPortRef,
    outputAssetRef: transitionPayload.outputAssetRef,
    outputPortRef: transitionPayload.outputPortRef,
    status: "missing" as const,
    missingReason: "coarse-owner-missing" as const,
    receipt: null,
    familyObservation: null,
  });
  const entry = Object.freeze({
    ...entryPayload,
    entryRoot: hashDomain("aloha/full-graph-coarse-sweep-entry/v1", entryPayload as unknown as CanonicalJson),
  });
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.full-graph-coarse-sweep-v1" as const,
    binding,
    expectedTransitionCount: "1",
    expectedTransitionIds: Object.freeze([transitionId]),
    expectedTransitionRoot: fullGraphTransitionSequenceRootV1("expected", [transitionId]),
    observedTransitionCount: "0",
    observedTransitionIds: Object.freeze([]),
    observedTransitionRoot: fullGraphTransitionSequenceRootV1("observed", []),
    missingTransitionCount: "1",
    missingTransitionIds: Object.freeze([transitionId]),
    missingTransitionRoot: fullGraphTransitionSequenceRootV1("missing", [transitionId]),
    familyTransitionCounts: Object.freeze([Object.freeze({
      familyId: edge.owningFamilyId,
      expectedTransitionCount: "1",
      observedTransitionCount: "0",
      missingTransitionCount: "1",
    })]),
    entries: Object.freeze([entry]),
  });
  return sealFullGraphCoarseSweepV1(payload);
}

function fullFamilyTerminalBindingFixture(projection: ProductionTerminalPhaseFullFamilyProjectionV1) {
  const sweep = fullGraphSweepFixture(projection.finalDurableWindowId);
  const audit = fullFamilyAuditFixture(projection.finalDurableWindowId);
  const { auditRoot: _auditRoot, ...auditBody } = audit;
  const nativeAuditManifest = encodeNativeFullFamilyAuditBodyV1(auditBody).manifest;
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.runtime-release-full-family-terminal-binding-v1" as const,
    runtimeBindingId: sweep.binding.runtimeBindingId,
    candidateReleaseCommit: sweep.binding.candidateReleaseCommit,
    releaseProvenanceHash: sweep.binding.releaseProvenanceHash,
    finalDurableWindowId: projection.finalDurableWindowId,
    producerTerminalId: h(`terminal:${projection.finalDurableWindowId}`),
    producerHeadFactsRoot: h(`head-facts:${projection.finalDurableWindowId}`),
    producerTerminalBindingRoot: projection.producerTerminalBindingRoot,
    laneTerminalSetRoot: projection.laneTerminalSetRoot,
    searchTerminalHash: h(`search-terminal:${projection.finalDurableWindowId}`),
    terminalKind: "dry-run" as const,
    terminalLineageHash: h(`terminal-lineage:${projection.finalDurableWindowId}`),
    readyRecordHash: projection.readyRecordHash,
    generationId: sweep.binding.generationId,
    graphRoot: sweep.binding.graphRoot,
    generatedRuntime: Object.freeze({
      releaseIntentRoot: h(`release-intent:${projection.finalDurableWindowId}`),
      definitionCatalogRoot: sweep.binding.definitionCatalogRoot,
      runtimeDescriptorRoot: h(`runtime-descriptor:${projection.finalDurableWindowId}`),
      families: Object.freeze([Object.freeze({
        familyId: "alpha-family",
        familyDefinitionHash: h(`family-definition:${projection.finalDurableWindowId}`),
        sourcePlanRoot: h(`source-plan-root:${projection.finalDurableWindowId}`),
        sourcePlanRefs: Object.freeze([]),
      })]),
    }),
    readyCutoff: sweep.binding.readyCutoff,
    actualCurrentSource: sweep.binding.actualCurrentSource,
    nativeAuditManifest,
  });
  return Object.freeze({
    ...payload,
    bindingRoot: hashDomain(
      "aloha/runtime-release-full-family-terminal-binding/v1",
      payload as unknown as CanonicalJson,
    ),
  });
}

function manifest(
  finalDurableWindowId: Hash,
  projectionArtifact?: Pick<ObservedContentArtifactV1, "contentSha256" | "ref">,
): ProductionTerminalPhaseManifestV1 {
  const anchors = Object.freeze({
    releaseAnchorRoot: h("release-anchor"),
    runtimeAnchorRoot: h("runtime-anchor"),
    runtimeArtifactRoot: h("runtime-artifact"),
    processAnchorRoot: h("process-anchor"),
  });
  const fullGraphCoarseSweepRoot = fullGraphSweepFixture(finalDurableWindowId).sweepRoot;
  const projection = missingProjection(finalDurableWindowId, fullGraphCoarseSweepRoot);
  const fullFamily = Object.freeze({
    projectionArtifactRefId: projectionArtifact?.ref.artifactRefId ?? h(`projection-ref:${finalDurableWindowId}`),
    projectionContentSha256: projectionArtifact?.contentSha256 ?? h(`projection-content:${finalDurableWindowId}`),
  });
  const nonObservedSixStep = Object.freeze({
    status: "missing" as const,
    windowSelectionRoot: h("window-selection"),
    selectionPolicyDigest: h("selection-policy"),
    eligibleSuccessCount: "0",
    eligibleSuccessRoot: h("eligible-successes"),
    selectedIndex: null,
    selectedProducerTerminalId: null,
    reason: "no-successful-dry-run",
    joinedProcessEvidenceRoot: null,
    performanceAppendRecordId: null,
    producerTerminalAppendRecordId: null,
    predicateArtifactCount: "0",
    predicateArtifactRoot: hashDomain("aloha/production-six-step-predicate-artifact-closure/v1", []),
    eventArtifactRefIds: Object.freeze([]),
  });
  const sixStep = Object.freeze({
    ...nonObservedSixStep,
    observationRoot: hashDomain("aloha/production-six-step-observation/v1", {
      kind: "aloha.production-six-step-observation-missing-v1",
      status: nonObservedSixStep.status,
      reason: nonObservedSixStep.reason,
      finalDurableWindowId,
      windowSelectionRoot: nonObservedSixStep.windowSelectionRoot,
      selectionPolicyDigest: nonObservedSixStep.selectionPolicyDigest,
      eligibleSuccessCount: nonObservedSixStep.eligibleSuccessCount,
      eligibleSuccessRoot: nonObservedSixStep.eligibleSuccessRoot,
      selectedIndex: nonObservedSixStep.selectedIndex,
      selectedProducerTerminalId: nonObservedSixStep.selectedProducerTerminalId,
      observedArtifacts: [],
    }),
  });
  const terminalPhaseInvocationRoot = hashDomain("aloha/production-terminal-phase-invocation/v1", {
    finalDurableWindowId,
    fullGraphCoarseSweepRoot,
    fullFamilyObservationRoot: projection.observationRoot,
    sixStepObservationRoot: sixStep.observationRoot,
    ...anchors,
  });
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.production-terminal-phase-manifest-v1" as const,
    finalDurableWindowId,
    windowId: h(`window:${finalDurableWindowId}`),
    ...anchors,
    fullGraphCoarseSweepRoot,
    terminalPhaseInvocationRoot,
    fullFamily,
    sixStep,
  });
  return Object.freeze({
    ...payload,
    manifestRoot: hashDomain("aloha/production-terminal-phase-manifest/v1", payload as unknown as CanonicalJson),
  });
}

function replaceSixStep(
  source: ProductionTerminalPhaseManifestV1,
  sixStep: ProductionTerminalPhaseManifestV1["sixStep"],
): ProductionTerminalPhaseManifestV1 {
  const terminalPhaseInvocationRoot = hashDomain("aloha/production-terminal-phase-invocation/v1", {
    finalDurableWindowId: source.finalDurableWindowId,
    fullGraphCoarseSweepRoot: source.fullGraphCoarseSweepRoot,
    fullFamilyObservationRoot: missingProjection(
      source.finalDurableWindowId,
      source.fullGraphCoarseSweepRoot,
    ).observationRoot,
    sixStepObservationRoot: sixStep.observationRoot,
    releaseAnchorRoot: source.releaseAnchorRoot,
    runtimeAnchorRoot: source.runtimeAnchorRoot,
    runtimeArtifactRoot: source.runtimeArtifactRoot,
    processAnchorRoot: source.processAnchorRoot,
  });
  const { manifestRoot: _priorManifestRoot, terminalPhaseInvocationRoot: _priorInvocationRoot, ...prior } = source;
  const payload = Object.freeze({ ...prior, terminalPhaseInvocationRoot, sixStep });
  return Object.freeze({
    ...payload,
    manifestRoot: hashDomain("aloha/production-terminal-phase-manifest/v1", payload as unknown as CanonicalJson),
  });
}

function sink(directory: string): ContentAddressedObserverSinkV1 {
  return new ContentAddressedObserverSinkV1({
    directory,
    storeIdentityHash: h("store"),
    resolverPolicy: createResolverPolicy({
      schemaVersion: 1,
      kind: "aloha.artifact-resolver-policy",
      allowedLocatorKind: "content-object",
      digestAlgorithm: "sha256",
      maxByteLength: "10000000",
      requireExactLengthMediaAndSchema: true,
      minimumRemainingStoreEpochs: "0",
      failureOutcome: "invalid",
    }),
    lease: {
      validFromStoreEpoch: "1",
      validThroughStoreEpoch: "2",
      issuerId: "terminal-phase-locator-test",
      issuerQualificationId: h("qualification"),
      qualificationRegistryRoot: h("registry"),
    },
  });
}

const schema = (role: string) => Object.freeze({
  id: `aloha.test.${role}`,
  version: "1.0.0",
  schemaHash: h(`schema:${role}`),
});

function writePhysicalSixStepBoundaries(
  directory: string,
  materials: readonly ProductionSixStepArtifactMaterialV1[],
) {
  mkdirSync(directory, { recursive: true });
  const entries = materials.map(material => {
    const name = `${material.boundaryKey.slice(2)}.v8`;
    const path = join(directory, name);
    const bytes = new Uint8Array(serialize(material));
    writeFileSync(path, bytes);
    const metadata = statSync(path, { bigint: true });
    return Object.freeze({
      name,
      path,
      bytes,
      contentSha256: sha256Hex(bytes),
      byteLength: String(bytes.byteLength),
      device: String(metadata.dev),
      inode: String(metadata.ino),
      fsynced: true as const,
    });
  }).sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze(entries);
}

async function writeMissingProjection(
  ownedSink: ContentAddressedObserverSinkV1,
  finalDurableWindowId: Hash,
): Promise<ObservedContentArtifactV1> {
  return ownedSink.write({
    bytes: encodeCanonicalBytes(missingProjection(finalDurableWindowId)),
    mediaType: "application/json",
    schema: schema("full-family-projection"),
  });
}

async function writeFullFamilyProjectionSources(
  ownedSink: ContentAddressedObserverSinkV1,
  finalDurableWindowId: Hash,
) {
  const projection = missingProjection(finalDurableWindowId);
  const fullFamilyTerminalBindingArtifact = await ownedSink.write({
    bytes: encodeCanonicalBytes(fullFamilyTerminalBindingFixture(projection)),
    mediaType: "application/json",
    schema: schema("full-family-terminal-binding"),
  });
  const fullGraphCoarseSweepArtifact = await ownedSink.write({
    bytes: encodeFullGraphCoarseSweepV1(fullGraphSweepFixture(finalDurableWindowId)).manifestBytes,
    mediaType: "application/json",
    schema: schema("full-graph-coarse-sweep"),
  });
  return Object.freeze({
    fullFamilyTerminalBindingArtifact,
    fullGraphCoarseSweepArtifact,
    fullFamilyPredicateArtifacts: Object.freeze([]),
  });
}

test("raw terminal window authority does not cross processes and selection/anchor fields remain exact", async () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-terminal-locator-"));
  const storeDirectory = join(root, "objects");
  const indexDirectory = join(root, "index");
  try {
    const ownedSink = sink(storeDirectory);
    const locatorIndex = new ProductionTerminalPhaseLocatorIndexV1({ directory: indexDirectory, sink: ownedSink });
    const finalDurableWindowId = h("final-window");
    const fullFamilyProjectionArtifact = await writeMissingProjection(ownedSink, finalDurableWindowId);
    const fullFamilyProjectionSources = await writeFullFamilyProjectionSources(ownedSink, finalDurableWindowId);
    const terminalManifest = manifest(finalDurableWindowId, fullFamilyProjectionArtifact);
    const manifestArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(terminalManifest),
      mediaType: "application/json",
      schema: schema("terminal-manifest"),
    });
    const locatorPayload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.production-terminal-phase-locator-v1" as const,
      finalDurableWindowId: terminalManifest.finalDurableWindowId,
      terminalPhaseInvocationRoot: terminalManifest.terminalPhaseInvocationRoot,
      manifestRoot: terminalManifest.manifestRoot,
      manifestArtifactRefId: manifestArtifact.ref.artifactRefId,
      manifestContentSha256: manifestArtifact.contentSha256,
    });
    const locator: ProductionTerminalPhaseLocatorV1 = Object.freeze({
      ...locatorPayload,
      locatorRoot: hashDomain("aloha/production-terminal-phase-locator/v1", locatorPayload),
    });
    const locatorArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(locator),
      mediaType: "application/json",
      schema: schema("terminal-locator"),
    });
    const childArtifacts = {
      fullFamilyProjectionArtifact,
      ...fullFamilyProjectionSources,
      fullFamilyBundleArtifact: null,
      fullFamilyLocatorArtifact: null,
      sixStepTerminalBindingArtifact: null,
      sixStepPredicateArtifacts: Object.freeze([]),
      sixStepArtifactMaterials: Object.freeze([]),
      generatedRuntimeMetadata: null,
    } as const;
    const foreignPolicySink = new ContentAddressedObserverSinkV1({
      directory: storeDirectory,
      storeIdentityHash: h("store"),
      resolverPolicy: createResolverPolicy({
        schemaVersion: 1,
        kind: "aloha.artifact-resolver-policy",
        allowedLocatorKind: "content-object",
        digestAlgorithm: "sha256",
        maxByteLength: "9999999",
        requireExactLengthMediaAndSchema: true,
        minimumRemainingStoreEpochs: "0",
        failureOutcome: "invalid",
      }),
      lease: {
        validFromStoreEpoch: "1",
        validThroughStoreEpoch: "2",
        issuerId: "terminal-phase-locator-test",
        issuerQualificationId: h("qualification"),
        qualificationRegistryRoot: h("registry"),
      },
    });
    const foreignPolicyManifestArtifact = await foreignPolicySink.write({
      bytes: encodeCanonicalBytes(terminalManifest),
      mediaType: "application/json",
      schema: schema("terminal-manifest"),
    });
    await assert.rejects(
      locatorIndex.publish({
        manifest: terminalManifest,
        manifestArtifact: foreignPolicyManifestArtifact,
        locator,
        locatorArtifact,
        selectedProcessArtifact: null,
        ...childArtifacts,
      }),
      /resolver policy|bytes\/ref\/claim\/lease\/mirror mismatch/,
    );
    const splicedManifestArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(manifest(h("spliced-artifact-window"))),
      mediaType: "application/json",
      schema: schema("terminal-manifest"),
    });
    const splicedArtifactLocatorPayload = Object.freeze({
      ...locatorPayload,
      manifestArtifactRefId: splicedManifestArtifact.ref.artifactRefId,
      manifestContentSha256: splicedManifestArtifact.contentSha256,
    });
    const splicedArtifactLocator: ProductionTerminalPhaseLocatorV1 = Object.freeze({
      ...splicedArtifactLocatorPayload,
      locatorRoot: hashDomain("aloha/production-terminal-phase-locator/v1", splicedArtifactLocatorPayload),
    });
    const splicedArtifactLocatorArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(splicedArtifactLocator),
      mediaType: "application/json",
      schema: schema("terminal-locator"),
    });
    await assert.rejects(
      locatorIndex.publish({
        manifest: terminalManifest,
        manifestArtifact: splicedManifestArtifact,
        locator: splicedArtifactLocator,
        locatorArtifact: splicedArtifactLocatorArtifact,
        selectedProcessArtifact: null,
        ...childArtifacts,
      }),
      /manifest bytes\/ref mismatch/,
    );
    await assert.rejects(
      locatorIndex.publish({
        manifest: terminalManifest,
        manifestArtifact,
        locator,
        locatorArtifact: splicedArtifactLocatorArtifact,
        selectedProcessArtifact: null,
        ...childArtifacts,
      }),
      /locator bytes\/ref mismatch/,
    );
    const rerootedNonObservedManifest = replaceSixStep(terminalManifest, Object.freeze({
      ...terminalManifest.sixStep,
      observationRoot: h("rerooted-non-observed-six-step"),
    }));
    const rerootedNonObservedManifestArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(rerootedNonObservedManifest),
      mediaType: "application/json",
      schema: schema("rerooted-non-observed-manifest"),
    });
    const rerootedNonObservedLocatorPayload = Object.freeze({
      ...locatorPayload,
      terminalPhaseInvocationRoot: rerootedNonObservedManifest.terminalPhaseInvocationRoot,
      manifestRoot: rerootedNonObservedManifest.manifestRoot,
      manifestArtifactRefId: rerootedNonObservedManifestArtifact.ref.artifactRefId,
      manifestContentSha256: rerootedNonObservedManifestArtifact.contentSha256,
    });
    const rerootedNonObservedLocator = Object.freeze({
      ...rerootedNonObservedLocatorPayload,
      locatorRoot: hashDomain("aloha/production-terminal-phase-locator/v1", rerootedNonObservedLocatorPayload),
    });
    const rerootedNonObservedLocatorArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(rerootedNonObservedLocator),
      mediaType: "application/json",
      schema: schema("rerooted-non-observed-locator"),
    });
    await assert.rejects(locatorIndex.publish({
      manifest: rerootedNonObservedManifest,
      manifestArtifact: rerootedNonObservedManifestArtifact,
      locator: rerootedNonObservedLocator,
      locatorArtifact: rerootedNonObservedLocatorArtifact,
      selectedProcessArtifact: null,
      ...childArtifacts,
    }), /non-observed Six-Step observation root mismatch/);
    const nonObservedIndex = await locatorIndex.publish({ manifest: terminalManifest, manifestArtifact, locator, locatorArtifact, selectedProcessArtifact: null, ...childArtifacts });
    assert.deepEqual(nonObservedIndex.sixStepBoundaryKeys, []);
    assert.equal(
      nonObservedIndex.sixStepBoundaryKeyRoot,
      hashCanonicalPartition(
        "aloha/production-terminal-phase-six-step-boundary-key-sequence/v1",
        [],
        16,
      ),
    );

    const child = spawnSync(process.execPath, [
      "--experimental-strip-types",
      fileURLToPath(new URL("./terminal-phase-restart-reader.fixture.ts", import.meta.url)),
      storeDirectory,
      indexDirectory,
      terminalManifest.finalDurableWindowId,
      h("store"),
    ], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr);
    const restarted = JSON.parse(child.stdout) as Readonly<Record<string, unknown>>;
    assert.notEqual(restarted.pid, process.pid);
    assert.deepEqual(restarted, {
      pid: restarted.pid,
      rawWindowRejected: true,
    });

    const { selectionPolicyDigest: _omitted, ...withoutPolicy } = terminalManifest.sixStep;
    assert.throws(
      () => decodeProductionTerminalPhaseManifestV1({ ...terminalManifest, sixStep: withoutPolicy }),
      /exact|keys|missing field/i,
    );
    for (const mutation of [
      { ...terminalManifest.sixStep, eligibleSuccessCount: "1" },
      { ...terminalManifest.sixStep, eligibleSuccessRoot: h("spliced-success-root") },
      { ...terminalManifest.sixStep, selectedIndex: "0" },
      { ...terminalManifest.sixStep, selectedProducerTerminalId: h("spliced-terminal") },
      { ...terminalManifest.sixStep, windowSelectionRoot: h("spliced-selection-root") },
      { ...terminalManifest.sixStep, verdict: "pass" },
    ]) {
      assert.throws(
        () => decodeProductionTerminalPhaseManifestV1({ ...terminalManifest, sixStep: mutation }),
        /exact|unknown field|inconsistent|manifestRoot mismatch/i,
      );
    }
    assert.throws(
      () => decodeProductionTerminalPhaseManifestV1(replaceSixStep(terminalManifest, Object.freeze({
        ...terminalManifest.sixStep,
        status: "observed",
        eligibleSuccessCount: "1",
        selectedIndex: "0",
        selectedProducerTerminalId: h("selected-without-join"),
        reason: null,
      }))),
      /selection fields are inconsistent/,
    );
    assert.throws(
      () => decodeProductionTerminalPhaseManifestV1(replaceSixStep(terminalManifest, Object.freeze({
        ...terminalManifest.sixStep,
        reason: "unknown-missing-reason",
      }))),
      /selection fields are inconsistent/,
    );
    const { projectionArtifactRefId: _projectionRef, ...incompleteProjectionBinding } = terminalManifest.fullFamily;
    assert.throws(
      () => decodeProductionTerminalPhaseManifestV1({ ...terminalManifest, fullFamily: incompleteProjectionBinding }),
      /exact|keys|missing field/i,
    );
    assert.throws(
      () => decodeProductionTerminalPhaseManifestV1({ ...terminalManifest, processAnchorRoot: h("spliced-process-anchor") }),
      /manifestRoot mismatch/i,
    );
    const selectedButTerminalMissing = replaceSixStep(terminalManifest, Object.freeze({
      ...terminalManifest.sixStep,
      eligibleSuccessCount: "1",
      eligibleSuccessRoot: h("selected-success-root"),
      selectedIndex: "0",
      selectedProducerTerminalId: h("selected-terminal"),
      reason: "terminal-binding-missing",
    }));
    assert.deepEqual(
      decodeProductionTerminalPhaseManifestV1(selectedButTerminalMissing),
      selectedButTerminalMissing,
      "typed missing must preserve an already frozen nonzero selection",
    );

    const foreignManifest = manifest(h("foreign-window"));
    const foreignProjectionArtifact = await writeMissingProjection(ownedSink, foreignManifest.finalDurableWindowId);
    const foreignProjectionSources = await writeFullFamilyProjectionSources(ownedSink, foreignManifest.finalDurableWindowId);
    const foreignManifestArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(foreignManifest),
      mediaType: "application/json",
      schema: schema("foreign-terminal-manifest"),
    });
    const splicedLocatorPayload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.production-terminal-phase-locator-v1" as const,
      finalDurableWindowId: foreignManifest.finalDurableWindowId,
      terminalPhaseInvocationRoot: foreignManifest.terminalPhaseInvocationRoot,
      manifestRoot: terminalManifest.manifestRoot,
      manifestArtifactRefId: foreignManifestArtifact.ref.artifactRefId,
      manifestContentSha256: foreignManifestArtifact.contentSha256,
    });
    const splicedLocator = Object.freeze({
      ...splicedLocatorPayload,
      locatorRoot: hashDomain("aloha/production-terminal-phase-locator/v1", splicedLocatorPayload),
    });
    const splicedLocatorArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(splicedLocator),
      mediaType: "application/json",
      schema: schema("spliced-terminal-locator"),
    });
    const splicedIndexPayload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.production-terminal-phase-locator-index-v1" as const,
      finalDurableWindowId: foreignManifest.finalDurableWindowId,
      locatorRoot: splicedLocator.locatorRoot,
      locatorContentSha256: splicedLocatorArtifact.contentSha256,
      locatorArtifactRefId: splicedLocatorArtifact.ref.artifactRefId,
      locatorArtifact: Object.freeze({
        contentSha256: splicedLocatorArtifact.contentSha256,
        ref: splicedLocatorArtifact.ref,
        claim: splicedLocatorArtifact.claim,
        lease: splicedLocatorArtifact.lease,
      }),
      manifestRoot: splicedLocator.manifestRoot,
      manifestContentSha256: splicedLocator.manifestContentSha256,
      manifestArtifact: Object.freeze({
        contentSha256: foreignManifestArtifact.contentSha256,
        ref: foreignManifestArtifact.ref,
        claim: foreignManifestArtifact.claim,
        lease: foreignManifestArtifact.lease,
      }),
      fullFamilyProjectionArtifact: Object.freeze({
        contentSha256: foreignProjectionArtifact.contentSha256,
        ref: foreignProjectionArtifact.ref,
        claim: foreignProjectionArtifact.claim,
        lease: foreignProjectionArtifact.lease,
      }),
      fullFamilyTerminalBindingArtifact: Object.freeze({
        contentSha256: foreignProjectionSources.fullFamilyTerminalBindingArtifact.contentSha256,
        ref: foreignProjectionSources.fullFamilyTerminalBindingArtifact.ref,
        claim: foreignProjectionSources.fullFamilyTerminalBindingArtifact.claim,
        lease: foreignProjectionSources.fullFamilyTerminalBindingArtifact.lease,
      }),
      fullGraphCoarseSweepArtifact: Object.freeze({
        contentSha256: foreignProjectionSources.fullGraphCoarseSweepArtifact.contentSha256,
        ref: foreignProjectionSources.fullGraphCoarseSweepArtifact.ref,
        claim: foreignProjectionSources.fullGraphCoarseSweepArtifact.claim,
        lease: foreignProjectionSources.fullGraphCoarseSweepArtifact.lease,
      }),
      fullFamilyPredicateArtifacts: Object.freeze([]),
      fullFamilyBundleArtifact: null,
      fullFamilyLocatorArtifact: null,
      sixStepTerminalBindingArtifact: null,
      sixStepPredicateArtifacts: Object.freeze([]),
      sixStepPredicateArtifactPointerRoot: hashCanonicalPartition(
        "aloha/production-terminal-phase-six-step-artifact-pointer-sequence/v1",
        [],
        64,
      ),
      selectedProcessArtifact: null,
    });
    writeFileSync(join(indexDirectory, `${foreignManifest.finalDurableWindowId.slice(2)}.json`), encodeCanonicalBytes({
      ...splicedIndexPayload,
      indexRoot: hashDomain("aloha/production-terminal-phase-locator-index/v1", splicedIndexPayload),
    }));
    await assert.rejects(locatorIndex.read(foreignManifest.finalDurableWindowId), /not authorized/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected process artifact remains exact in the publishing process and missing durable bytes fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-terminal-process-locator-"));
  const storeDirectory = join(root, "objects");
  const indexDirectory = join(root, "index");
  try {
    const ownedSink = sink(storeDirectory);
    const locatorIndex = new ProductionTerminalPhaseLocatorIndexV1({ directory: indexDirectory, sink: ownedSink });
    const finalDurableWindowId = h("observed-final-window");
    const observedSweep = fullGraphSweepFixture(finalDurableWindowId);
    const currentSource = observedSweep.binding.actualCurrentSource;
    const objectiveTemplates = Object.freeze([Object.freeze({
      objectiveRef: h("objective"),
      profitAsset: nativeAssetReferenceV1("1"),
      profitAccount: "0x0000000000000000000000000000000000000001",
      minNetGain: "1",
      maxGas: "1000000",
      maxValueAtRisk: "1000000000000000000",
      priorityFeePerGas: "1",
      bidCostNative: "0",
      valuationOwnerRef: h("valuation-owner"),
    })]);
    const actionOwnerProposal = sealEconomicSafetyActionOwnerProposalV1({
      familyDefinitionHash: h("action-owner-family-definition"),
      ownerId: "terminal-phase-locator-action-owner",
      ownerRef: h("action-owner"),
      implementationHash: h("action-owner-implementation"),
      schemaRef: h("action-owner-schema"),
      implementationClosureRoot: h("action-owner-closure"),
    });
    const actionOwnerQualification = sealEconomicSafetyActionOwnerQualificationCertificateV1({
      schemaVersion: 1,
      kind: "aloha.economic-safety-action-owner-qualification-certificate",
      familyDefinitionHash: actionOwnerProposal.familyDefinitionHash,
      ownerId: actionOwnerProposal.ownerId,
      ownerRef: actionOwnerProposal.ownerRef,
      proposedOwnerLeafDigest: actionOwnerProposal.proposalLeafDigest,
      implementationHash: actionOwnerProposal.implementationHash,
      schemaRef: actionOwnerProposal.schemaRef,
      implementationClosureRoot: actionOwnerProposal.implementationClosureRoot,
      claimSchemaRefs: Object.freeze([actionOwnerProposal.schemaRef]),
      verifierProgramDigest: h("action-owner-verifier-program"),
      qualificationSpecDigest: h("action-owner-qualification-spec"),
      criticalMutationCorpusRoot: h("action-owner-critical-mutations"),
      independentOracleCaseRoot: h("action-owner-independent-oracle"),
      executedPositiveCaseRoot: h("action-owner-positive-cases"),
      executedNegativeCaseRoot: h("action-owner-negative-cases"),
      executedInvalidCaseRoot: h("action-owner-invalid-cases"),
      qualificationAuthorityApprovalId: h("action-owner-qualification-approval"),
      qualificationAuthorityApprovalPayloadHash: h("action-owner-qualification-approval-payload"),
    });
    const actionOwnerQualificationSet = sealEconomicSafetyActionOwnerQualificationSetV1([actionOwnerQualification]);
    const actionOwners = Object.freeze([Object.freeze({
      familyDefinitionHash: actionOwnerQualification.familyDefinitionHash,
      ownerId: actionOwnerQualification.ownerId,
      ownerRef: actionOwnerQualification.ownerRef,
      implementationHash: actionOwnerQualification.implementationHash,
      schemaRef: actionOwnerQualification.schemaRef,
      implementationClosureRoot: actionOwnerQualification.implementationClosureRoot,
      claimSchemaRefs: actionOwnerQualification.claimSchemaRefs,
      qualificationLeafDigest: actionOwnerQualification.qualificationLeafDigest,
      verifierHash: h("action-owner-verifier"),
    })]);
    const valuationOwners = Object.freeze([Object.freeze({
      ownerRef: h("valuation-owner"),
      supportedAssetRefs: Object.freeze([objectiveTemplates[0]!.profitAsset.assetRef]),
      implementationHash: h("valuation-owner-implementation"),
      factSchemaRef: h("valuation-owner-fact-schema"),
      implementationClosureRoot: h("valuation-owner-closure"),
      qualificationLeafDigest: h("valuation-owner-leaf"),
      valuationOwnerRegistryRoot: h("valuation-owner-registry"),
      qualifiedValuationOwnerSetRoot: h("valuation-owner-set"),
    })]);
    const executorQualification = Object.freeze({
      executorKind: "revm",
      engineBuildFingerprint: h("executor-engine"),
      executableFingerprint: h("executor-executable"),
      qualifiedExecutorRegistryRoot: h("executor-registry"),
      selectedExecutorLeafHash: h("executor-leaf"),
      releaseRoleManifestRoot: h("executor-role-manifest"),
    });
    const safetyProfile = sealSafetyProfileV1({
      profileRef: h("economic-safety-profile"),
      qualifiedOwnerSetRoot: actionOwnerQualificationSet.root,
      requiredClaims: Object.freeze([Object.freeze({
        claimSchemaRef: actionOwnerQualification.schemaRef,
        ownerRef: actionOwners[0].ownerRef,
        qualificationLeafDigest: actionOwnerQualification.qualificationLeafDigest,
        revmObservationSchemaRef: ECONOMIC_SAFETY_REVM_OBSERVATION_SCHEMA_REF_V1,
      })]),
    });
    assertSafetyProfileQualificationMembershipV1(safetyProfile, actionOwnerQualificationSet.certificates);
    assert.throws(() => decodeSafetyProfileV1(undefined), /economicSafetyProfile|economic safety profile/);
    const splicedSafetyProfile = sealSafetyProfileV1({
      profileRef: safetyProfile.profileRef,
      qualifiedOwnerSetRoot: safetyProfile.qualifiedOwnerSetRoot,
      requiredClaims: Object.freeze([Object.freeze({
        ...safetyProfile.requiredClaims[0],
        qualificationLeafDigest: h("spliced-action-owner-qualification-leaf"),
      })]),
    });
    assert.throws(
      () => assertSafetyProfileQualificationMembershipV1(splicedSafetyProfile, actionOwnerQualificationSet.certificates),
      /not an exact qualified owner member/,
    );
    const policyRoot = economicSafetyObjectivePolicyRootV1(
      objectiveTemplates,
      actionOwners,
      valuationOwners,
      executorQualification,
      safetyProfile,
    );
    assert.notEqual(policyRoot, economicSafetyObjectivePolicyRootV1(
      objectiveTemplates,
      actionOwners,
      valuationOwners,
      executorQualification,
      splicedSafetyProfile,
    ), "a SafetyProfile splice must invalidate an unchanged policy root");
    const economicEvaluatorBindingPayload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.six-step-economic-evaluator-binding-observation-v1" as const,
      runtimeBindingId: observedSweep.binding.runtimeBindingId,
      candidateReleaseCommit: observedSweep.binding.candidateReleaseCommit,
      releaseProvenanceHash: observedSweep.binding.releaseProvenanceHash,
      authorityRoot: h("economic-evaluator-authority"),
      implementationHash: h("economic-evaluator-implementation"),
      policyRoot,
      evaluatorExportIdentityHash: h("economic-evaluator-export"),
      objectiveTemplates,
      actionOwners,
      valuationOwners,
      executorQualification,
      safetyProfile,
    });
    const economicEvaluatorBindingObservation = Object.freeze({
      ...economicEvaluatorBindingPayload,
      observationRoot: hashDomain("aloha/six-step-economic-evaluator-binding-observation/v1", economicEvaluatorBindingPayload),
    });
    const selectedReadyEdges = Object.freeze([0, 1].map(index => {
      const baseEdge = observedSweep.entries[0]!.edge;
      const { edgeId: _baseEdgeId, ...basePayload } = baseEdge;
      const owningFamilyDefinitionHash = h(`family-${index}`);
      const owningInstanceKey = h(`owner-${index}`);
      const instancePublicationHash = h(`instance-publication:${index}`);
      const payload = Object.freeze({
        ...basePayload,
        inputAssetPorts: index === 0 ? baseEdge.inputAssetPorts : baseEdge.outputAssetPorts,
        outputAssetPorts: index === 0 ? baseEdge.outputAssetPorts : baseEdge.inputAssetPorts,
        opaqueTransitionRef: h(`selected-transition:${index}`),
        owningFamilyId: `fixture-family-${index}`,
        owningFamilyDefinitionHash,
        owningInstanceKey,
        instancePublicationHash,
        staticProjectionHash: h(`static-projection:${index}`),
        projectionHash: h(`projection:${index}`),
        rehydrationRef: Object.freeze({
          ...baseEdge.rehydrationRef,
          familyDefinitionHash: owningFamilyDefinitionHash,
          instanceKey: owningInstanceKey,
          instancePublicationHash,
        }),
      });
      return Object.freeze({ edgeId: hashDomain("aloha/persisted-graph-edge/v1", payload), ...payload });
    }));
    const selectedGraphLegs = Object.freeze(selectedReadyEdges.map(edge => Object.freeze({
      edgeId: edge.edgeId,
      owningFamilyId: edge.owningFamilyId,
      owningFamilyDefinitionHash: edge.owningFamilyDefinitionHash,
      owningInstanceKey: edge.owningInstanceKey,
      instancePublicationHash: edge.instancePublicationHash,
      staticProjectionHash: edge.staticProjectionHash,
      projectionHash: edge.projectionHash,
    })));
    const stage12Binding = Object.freeze({
      readyRecordHash: observedSweep.binding.readyRecordHash,
      generationId: observedSweep.binding.generationId,
      cutoff: Object.freeze({ chainId: "1", number: "99", hash: h("cutoff"), stateRoot: h("cutoff-state") }),
      definitionCatalogRoot: observedSweep.binding.definitionCatalogRoot,
      sourceCoverageRoot: h("source-coverage"),
      candidatePartitionRoot: h("candidate-partition"),
      exactOutcomePartitionRoot: h("exact-outcome-partition"),
      verifiedMemoSetRoot: h("verified-memo-set"),
      instanceCatalogRoot: h("instances"),
      graphRoot: observedSweep.binding.graphRoot,
      releaseProvenanceHash: observedSweep.binding.releaseProvenanceHash,
      promotionRevision: "1",
    });
    const resolvedBindingFact = Object.freeze({
      generationId: stage12Binding.generationId,
      readyRecordHash: stage12Binding.readyRecordHash,
      generationRefreshPolicyHash: h("refresh-policy"),
      cutoff: stage12Binding.cutoff,
      definitionCatalogRoot: stage12Binding.definitionCatalogRoot,
      instanceCatalogRoot: stage12Binding.instanceCatalogRoot,
      graphRoot: stage12Binding.graphRoot,
      runtimeAuthority: projectRuntimeAuthorityDescriptorV1(createSignedReleaseRuntimeAuthorityDescriptorV1({
        authorityClass: "signed-release",
        runtimeBindingId: h("root-owned-runtime-binding"),
        releaseProvenanceHash: stage12Binding.releaseProvenanceHash,
        implementationCommit: "a".repeat(40),
      })),
      releaseProvenanceHash: stage12Binding.releaseProvenanceHash,
      candidatePartitionProofStorageHash: h("candidate-partition-proof-storage"),
      nominationClosureRoot: h("nomination-closure"),
      nominationClosureStorageHash: h("nomination-closure-storage"),
    });
    const activeReadyGraphFact = Object.freeze({
      readyRecordHash: stage12Binding.readyRecordHash,
      generationId: stage12Binding.generationId,
      cutoff: stage12Binding.cutoff,
      definitionCatalogRoot: stage12Binding.definitionCatalogRoot,
      sourceCoverageRoot: stage12Binding.sourceCoverageRoot,
      candidatePartitionRoot: stage12Binding.candidatePartitionRoot,
      exactOutcomePartitionRoot: stage12Binding.exactOutcomePartitionRoot,
      verifiedMemoSetRoot: stage12Binding.verifiedMemoSetRoot,
      promotionRevision: stage12Binding.promotionRevision,
      instanceCatalogRoot: stage12Binding.instanceCatalogRoot,
      graphRoot: stage12Binding.graphRoot,
      releaseProvenanceHash: stage12Binding.releaseProvenanceHash,
      generationRefreshPolicyHash: resolvedBindingFact.generationRefreshPolicyHash,
      candidatePartitionProofStorageHash: resolvedBindingFact.candidatePartitionProofStorageHash,
      nominationClosureRoot: resolvedBindingFact.nominationClosureRoot,
      nominationClosureStorageHash: resolvedBindingFact.nominationClosureStorageHash,
      orderedEdges: selectedGraphLegs,
    });
    assert.deepEqual(
      exactRootOwnedSelectedReadyEdges(
        activeReadyGraphFact as never,
        stage12Binding,
        resolvedBindingFact,
        selectedGraphLegs,
        stage12Binding.definitionCatalogRoot,
      ).map(edge => edge.edgeId),
      selectedGraphLegs.map(leg => leg.edgeId),
    );
    for (const [field, value] of [
      ["definitionCatalogRoot", h("spliced-definition-catalog")],
      ["sourceCoverageRoot", h("spliced-source-coverage")],
      ["candidatePartitionRoot", h("spliced-candidate-partition")],
      ["exactOutcomePartitionRoot", h("spliced-exact-outcome-partition")],
      ["verifiedMemoSetRoot", h("spliced-verified-memo-set")],
      ["promotionRevision", "2"],
      ["instanceCatalogRoot", h("spliced-instance-catalog")],
    ] as const) {
      assert.throws(() => exactRootOwnedSelectedReadyEdges(
        activeReadyGraphFact as never,
        Object.freeze({ ...stage12Binding, [field]: value }),
        resolvedBindingFact,
        selectedGraphLegs,
        stage12Binding.definitionCatalogRoot,
      ), /root-owned Ready binding mismatch/);
    }
    for (const field of [
      "generationRefreshPolicyHash",
      "candidatePartitionProofStorageHash",
      "nominationClosureRoot",
      "nominationClosureStorageHash",
    ] as const) {
      assert.throws(() => exactRootOwnedSelectedReadyEdges(
        activeReadyGraphFact as never,
        stage12Binding,
        Object.freeze({ ...resolvedBindingFact, [field]: h(`spliced-${field}`) }),
        selectedGraphLegs,
        stage12Binding.definitionCatalogRoot,
      ), /root-owned Ready binding mismatch/);
    }
    assert.throws(() => exactRootOwnedSelectedReadyEdges(
      activeReadyGraphFact as never,
      stage12Binding,
      resolvedBindingFact,
      selectedGraphLegs,
      h("spliced-generated-definition-catalog"),
    ), /root-owned Ready binding mismatch/);
    assert.throws(() => exactRootOwnedSelectedReadyEdges(
      activeReadyGraphFact as never,
      stage12Binding,
      resolvedBindingFact,
      Object.freeze(selectedGraphLegs.map((leg, index) => index === 0
        ? Object.freeze({ ...leg, projectionHash: h("spliced-selected-projection") })
        : leg)),
      stage12Binding.definitionCatalogRoot,
    ), /not an exact active Ready Graph member/);
    const terminalCorrelationId = h("correlation");
    const strategyCompositionRoot = h("strategy-composition");
    const objectiveRef = h("objective");
    const entryAssetRef = selectedReadyEdges[0]!.inputAssetPorts[0]!.assetRef;
    const intermediateAssetRef = selectedReadyEdges[0]!.outputAssetPorts[0]!.assetRef;
    const planningProblemPayload = Object.freeze({
      kind: "closed-loop" as const,
      objectiveRef,
      entryAssetRef,
      returnAssetRef: entryAssetRef,
      minLegs: "2",
      maxLegs: "2",
      candidateLimit: "16",
      edgeReuse: "forbid" as const,
      requiredAnchorEdgeIds: Object.freeze([]),
      constraintSchemaRefs: Object.freeze([]),
      strategyId: "fixture-strategy",
      strategyDefinitionHash: h("strategy-definition"),
      strategyCatalogLeafDigest: h("strategy-leaf"),
      definitionCatalogRoot: stage12Binding.definitionCatalogRoot,
      generationId: stage12Binding.generationId,
      graphRoot: stage12Binding.graphRoot,
      triggerRef: h("trigger"),
      lane: "blockscan" as const,
      triggerCorrelationId: terminalCorrelationId,
      triggerHeadHash: stage12Binding.cutoff.hash,
      requiredCapabilityPredicates: Object.freeze([]),
      strategyCompositionRoot,
      strategyIssuerClosureRoot: h("strategy-issuer-closure"),
      releaseProvenanceHash: stage12Binding.releaseProvenanceHash,
      readyRecordHash: stage12Binding.readyRecordHash,
    });
    const planningProblem = Object.freeze({
      ...planningProblemPayload,
      problemHash: hashDomain("aloha/strategy-planning-problem/v1", planningProblemPayload),
    });
    const candidateLegs = Object.freeze(selectedReadyEdges.map((edge, index) => Object.freeze({
      edgeId: edge.edgeId,
      transitionRef: edge.opaqueTransitionRef,
      inputAssetRef: index === 0 ? entryAssetRef : intermediateAssetRef,
      inputPortRef: edge.inputAssetPorts[0]!.portRef,
      outputAssetRef: index === 0 ? intermediateAssetRef : entryAssetRef,
      outputPortRef: edge.outputAssetPorts[0]!.portRef,
    })));
    const candidateIdentityPayload = Object.freeze({
      planningProblemHash: planningProblem.problemHash,
      objectiveRef,
      entryAssetRef,
      returnAssetRef: entryAssetRef,
      legs: candidateLegs,
    });
    const routeCandidate = Object.freeze({
      candidateId: hashDomain("aloha/planner-route-candidate/v1", candidateIdentityPayload),
      planningProblemHash: planningProblem.problemHash,
      legs: candidateLegs,
      loopIntent: Object.freeze({
        kind: "closed-loop" as const,
        entryAssetRef,
        returnAssetRef: entryAssetRef,
        objectiveRef,
        constraintSchemaRefs: Object.freeze([]),
        legs: Object.freeze(candidateLegs.map(leg => Object.freeze({
          fromAssetRef: leg.inputAssetRef,
          toAssetRef: leg.outputAssetRef,
          selectionRef: hashDomain("aloha/planner-route-selection/v1", leg),
          requiredCapabilityPredicates: Object.freeze([]),
        }))),
      }),
      orderKey: hashDomain("aloha/planner-route-order/v1", candidateIdentityPayload),
    });
    const familyRouteBindingHashes = Object.freeze(selectedGraphLegs.map((_, index) => h(`family-route-binding:${index}`)));
    const terminalIdentity = Object.freeze({
      runtimeBindingId: observedSweep.binding.runtimeBindingId,
      candidateReleaseCommit: observedSweep.binding.candidateReleaseCommit,
      releaseProvenanceHash: observedSweep.binding.releaseProvenanceHash,
      economicEvaluatorAuthorityRoot: h("economic-evaluator-authority"),
      economicEvaluatorImplementationHash: h("economic-evaluator-implementation"),
      economicEvaluatorBindingObservation,
      definitionCatalogRoot: observedSweep.binding.definitionCatalogRoot,
      strategyCompositionRoot,
      searchTerminalHash: h("search-terminal"),
      terminalLineageHash: h("terminal-lineage"),
      correlationId: terminalCorrelationId,
      generationId: observedSweep.binding.generationId,
      readyRecordHash: observedSweep.binding.readyRecordHash,
      graphRoot: observedSweep.binding.graphRoot,
      currentSource,
      planningProblemHash: planningProblem.problemHash,
      routeCandidateId: routeCandidate.candidateId,
      programHash: h("program"),
      finalSimulationReceiptHash: h("final-simulation"),
    });
    const append = (label: string, namespace: string) => Object.freeze({
      namespace,
      sequence: "1",
      eventId: h(`${label}:event`),
      contentSha256: h(`${label}:content`),
      byteLength: "1",
      offsetStart: "0",
      offsetEnd: "1",
      fsynced: true as const,
    });
    const durableAppend = append("performance", "searcher-production-evidence/performance/v1");
    const producerTerminalDurableAppend = append("producer", "searcher-production-evidence/producer-terminals/v1");
    const appendId = (value: ReturnType<typeof append>) => hashDomain(
      "aloha/searcher-production-six-step-durable-append/v1",
      value,
    );
    const runtimeAnchor = Object.freeze({
      kind: "aloha.searcher-runtime-anchor-v1" as const,
      manifestHash: h("runtime-manifest"),
      manifestArtifactSha256: h("runtime-manifest-artifact"),
      bindingId: terminalIdentity.runtimeBindingId,
      releaseProvenanceHash: terminalIdentity.releaseProvenanceHash,
      candidateReleaseCommit: terminalIdentity.candidateReleaseCommit,
      runtimeArtifactRoot: h("runtime-artifact-root"),
      implementationClosureDigest: h("implementation-closure"),
      entrypointSha256: h("entrypoint"),
      nodeExecutableSha256: h("node"),
      bundleModulePath: "/opt/aloha/runtime.mjs",
      bundleModuleSha256: h("bundle"),
      serviceName: "aloha-test-searcher",
      systemdUnit: "aloha-test-searcher.service",
      bootId: "test-boot",
      invocationId: "test-invocation",
      logDevice: "1",
      logInode: "2",
      pid: "42",
      processStartTicks: "100",
      dryRun: true as const,
    });
    const fullFamilyProjectionArtifact = await writeMissingProjection(ownedSink, finalDurableWindowId);
    const fullFamilyProjectionSources = await writeFullFamilyProjectionSources(ownedSink, finalDurableWindowId);
    const base = manifest(finalDurableWindowId, fullFamilyProjectionArtifact);
    const sixStepProcess: ProcessAnchorV1 = Object.freeze({
      systemId: `${runtimeAnchor.serviceName}/${runtimeAnchor.systemdUnit}`,
      commitSha: runtimeAnchor.candidateReleaseCommit,
      executableHash: runtimeAnchor.entrypointSha256,
      deploymentManifestHash: runtimeAnchor.manifestHash,
      serviceIdentityHash: h("six-step-service"),
      pid: runtimeAnchor.pid,
      processStartTicks: runtimeAnchor.processStartTicks,
      bootIdHash: hashDomain("aloha/searcher-runtime-boot-id/v1", runtimeAnchor.bootId),
    });
    const tail = createProductionSixStepTailFixture([], {
      sink: ownedSink,
      process: sixStepProcess,
      fileRangeStride: 1_000_000,
      stage12: Object.freeze({ binding: stage12Binding, selectedGraphLegs, readyEdges: selectedReadyEdges }),
    });
    const pipeline = Object.freeze({
      lease: Object.freeze({ binding: resolvedBindingFact }),
      currentSource: Object.freeze({ sessionId: h("source-session"), source: currentSource }),
      correlationId: terminalIdentity.correlationId,
      routeCandidateId: terminalIdentity.routeCandidateId,
      orderedEdgeIds: Object.freeze(selectedGraphLegs.map(leg => leg.edgeId)),
      callerId: "terminal-locator-test",
    });
    const routeLegs = Object.freeze(selectedGraphLegs.map(leg => Object.freeze({
      edgeId: leg.edgeId,
      ownerRef: routeOwnerRef(
        leg.owningFamilyDefinitionHash,
        familyRouteBindingHashes[selectedGraphLegs.indexOf(leg)]!,
      ),
    })));
    const route = Object.freeze({
      routeHash: hashDomain("aloha/search-runtime-route/v1", {
        candidateId: routeCandidate.candidateId,
        legs: candidateLegs.map((leg, index) => Object.freeze({
          ...leg,
          routeBindingHash: familyRouteBindingHashes[index]!,
        })),
      }),
      routeBindingHash: acceptanceRouteBindingHash(routeLegs),
      legs: routeLegs,
    });
    const timing = Object.freeze({ startedMonotonicNs: "1000", finishedMonotonicNs: "2000" });
    const program = Object.freeze({
      kind: "execution-program",
      generationId: terminalIdentity.generationId,
      source: currentSource,
      routeHash: route.routeHash,
      programBytes: "0xfixture",
      payloadHash: h("program-payload"),
      issuerRef: h("program-issuer"),
      obligationRoot: h("obligation-root"),
      programHash: terminalIdentity.programHash,
    });
    const executionOwnerFacts = Object.freeze({
      callerMode: "delegate-call",
      preCalls: Object.freeze([]),
      observationPairs: Object.freeze([]),
      actionOwners: Object.freeze(selectedGraphLegs.map((leg, index) => Object.freeze({
        familyDefinitionHash: leg.owningFamilyDefinitionHash,
        routeBindingHash: familyRouteBindingHashes[index]!,
      }))),
      obligationRoot: program.obligationRoot,
      declaredObligations: Object.freeze([]),
    });
    const executionOwnerEvidence = Object.freeze({
      schemaVersion: 1,
      kind: "aloha.execution-program-six-step-evidence-v1",
      correlationId: pipeline.correlationId,
      generationId: terminalIdentity.generationId,
      source: currentSource,
      routeHash: route.routeHash,
      exactHash: h("exact"),
      programHash: program.programHash,
      facts: executionOwnerFacts,
      evidenceRoot: h("execution-owner-evidence"),
    });
    const simulation = Object.freeze({
      kind: "final-simulation-passed",
      generationId: terminalIdentity.generationId,
      source: currentSource,
      programHash: program.programHash,
      simulation: Object.freeze({ kind: "fixture-simulation" }),
      effectsHash: h("effects"),
      receiptHash: terminalIdentity.finalSimulationReceiptHash,
    });
    const finalOwnerEvidence = Object.freeze({
      schemaVersion: 1,
      kind: "aloha.final-simulation-six-step-evidence-v1",
      correlationId: pipeline.correlationId,
      generationId: terminalIdentity.generationId,
      source: currentSource,
      programHash: program.programHash,
      finalSimulationReceiptHash: simulation.receiptHash,
      facts: Object.freeze({ effectsHash: simulation.effectsHash }),
      evidenceRoot: h("final-owner-evidence"),
    });
    const economicSafety = Object.freeze({
      economic: Object.freeze({ verdict: "positive-net-ev" }),
      safety: Object.freeze({
        repaymentProofRoot: h("repayment-proof"),
        repayment: "satisfied",
        standingPositionProofRoot: h("standing-position-proof"),
        standingPosition: "satisfied",
      }),
    });
    const emitSixStepChain = async (emissionTail: typeof tail) => {
      const stage3 = await emissionTail.emitPlanner({ pipeline, route, coarse: {}, planned: {}, timing } as never);
      const stage4 = await emissionTail.emitExact({ parent: stage3, pipeline, route, exact: {}, timing } as never);
      const stage5 = await emissionTail.emitExecutionProgram({
        parent: stage4,
        pipeline,
        route,
        program,
        ownerEvidence: executionOwnerEvidence,
        timing,
      } as never);
      const stage6 = await emissionTail.emitFinalSimulation({
        parent: stage5,
        pipeline,
        route,
        program,
        simulation,
        ownerEvidence: finalOwnerEvidence,
        economicSafety,
        timing,
      } as never);
      return Object.freeze({ stage3, stage4, stage5, stage6 });
    };
    const { stage3, stage4, stage5, stage6 } = await emitSixStepChain(tail);
    const stage12 = tail.readStage12Parents(stage3);
    const selectedStage1Artifacts = stage12.stage1.map(readProductionSixStepArtifactMaterialV1);
    const selectedStage2Artifacts = stage12.stage2.map(readProductionSixStepArtifactMaterialV1);
    const stage1Artifacts = [...selectedStage1Artifacts]
      .sort((left, right) => left.eventArtifact.ref.artifactRefId.localeCompare(right.eventArtifact.ref.artifactRefId));
    const stage2Artifacts = [...selectedStage2Artifacts]
      .sort((left, right) => left.eventArtifact.ref.artifactRefId.localeCompare(right.eventArtifact.ref.artifactRefId));
    const stageArtifacts = Object.freeze([
      ...stage1Artifacts,
      ...stage2Artifacts,
      readProductionSixStepArtifactMaterialV1(stage3),
      readProductionSixStepArtifactMaterialV1(stage4),
      readProductionSixStepArtifactMaterialV1(stage5),
      readProductionSixStepArtifactMaterialV1(stage6),
    ]);
    const resolvedBinding = resolvedBindingFact;
    const resolvedTracePayload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.resolved-route-six-step-trace-v1" as const,
      binding: resolvedBinding,
      routeCandidateId: pipeline.routeCandidateId,
      orderedEdgeIds: pipeline.orderedEdgeIds,
      routeBinding: Object.freeze({
        routeHash: route.routeHash,
        routeBindingHash: route.routeBindingHash,
        legs: route.legs.map(leg => Object.freeze({ edgeId: leg.edgeId, ownerRef: leg.ownerRef })),
      }),
      strategy: Object.freeze({}),
      objective: Object.freeze({}),
      source: currentSource,
      correlationId: pipeline.correlationId,
      coarse: Object.freeze({}),
      planner: Object.freeze({}),
      exact: Object.freeze({}),
      executionProgram: program,
      executionProgramOwnerEvidence: executionOwnerEvidence,
      finalSimulation: simulation,
      finalSimulationOwnerEvidence: finalOwnerEvidence,
      economicSafety,
      dryRun: Object.freeze({}),
      timings: Object.freeze({ planner: timing, exact: timing, executionProgram: timing, finalSimulation: timing }),
      productionArtifactSetRoots: Object.freeze(stageArtifacts.slice(-4).map(value => value.artifactSetRoot)),
    });
    const resolvedTrace = Object.freeze({
      ...resolvedTracePayload,
      traceRoot: hashDomain("aloha/resolved-route-six-step-trace/v1", resolvedTracePayload),
    });
    const tracePayload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.search-terminal-six-step-trace-v1" as const,
      strategyCompositionRoot,
      planningProblem,
      planningProblemHash: planningProblem.problemHash,
      routeCandidate,
      selectedGraphLegs,
      admission: Object.freeze({
        topK: "1",
        boundedUnrankedBudget: "1",
        admissionPolicyHash: h("admission-policy"),
        enumerationRoot: h("enumeration"),
        accountingRoot: h("accounting"),
      }),
      resolved: resolvedTrace,
    });
    const trace = Object.freeze({
      ...tracePayload,
      traceRoot: hashDomain("aloha/search-terminal-six-step-trace/v1", tracePayload),
    });
    const terminalPayload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.runtime-release-six-step-terminal-binding-v1" as const,
      ...terminalIdentity,
      traceRoot: trace.traceRoot,
      trace,
    });
    const terminalBinding = Object.freeze({
      ...terminalPayload,
      bindingRoot: hashDomain("aloha/runtime-release-six-step-terminal-binding/v1", terminalPayload as unknown as CanonicalJson),
    });
    const terminalBindingArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(terminalBinding),
      mediaType: "application/json",
      schema: schema("selected-terminal-binding"),
    });
    const sequenceLedgerPath = join(root, "sequence-evidence.jsonl");
    const metadataLine = encodeCanonicalBytes({ kind: "fixture-metadata" });
    const precedingEventLine = stageArtifacts[0]!.eventArtifact.bytes;
    const selectedEventLine = stageArtifacts[1]!.eventArtifact.bytes;
    const selectedEventStart = metadataLine.byteLength + 1 + precedingEventLine.byteLength + 1;
    const sequenceLedgerBytes = new Uint8Array(Buffer.concat([
      Buffer.from(metadataLine), Buffer.from("\n"),
      Buffer.from(precedingEventLine), Buffer.from("\n"),
      Buffer.from(selectedEventLine), Buffer.from("\n"),
    ]));
    writeFileSync(sequenceLedgerPath, sequenceLedgerBytes);
    const sequenceLedgerStat = statSync(sequenceLedgerPath, { bigint: true });
    const selectedEventLocator = stageArtifacts[1]!.eventArtifact.ref.locator;
    if (selectedEventLocator.kind !== "file-range") throw new TypeError("selected event fixture locator");
    const sequenceMaterial = Object.freeze({
      ...stageArtifacts[1]!,
      eventArtifact: Object.freeze({
        ...stageArtifacts[1]!.eventArtifact,
        ref: Object.freeze({
          ...stageArtifacts[1]!.eventArtifact.ref,
          locator: Object.freeze({
            ...selectedEventLocator,
            startInclusive: String(selectedEventStart),
            endExclusive: String(selectedEventStart + selectedEventLine.byteLength),
          }),
        }),
      }),
      append: Object.freeze({
        ...stageArtifacts[1]!.append,
        sequence: "1",
        offsetStart: String(selectedEventStart),
        offsetEnd: String(selectedEventStart + selectedEventLine.byteLength),
      }),
    }) as unknown as ProductionSixStepArtifactMaterialV1;
    const sequenceLedger = Object.freeze({
      sourceDevice: selectedEventLocator.device,
      sourceInode: selectedEventLocator.inode,
      snapshotPath: sequenceLedgerPath,
      snapshotDevice: String(sequenceLedgerStat.dev),
      snapshotInode: String(sequenceLedgerStat.ino),
      contentSha256: sha256Hex(sequenceLedgerBytes),
      byteLength: String(sequenceLedgerBytes.byteLength),
      fsynced: true as const,
    });
    assert.deepEqual(
      sequenceLedgerBytes.slice(selectedEventStart, selectedEventStart + selectedEventLine.byteLength),
      selectedEventLine,
    );
    assert.equal(
      (decodeCanonicalBytes(selectedEventLine) as Readonly<Record<string, unknown>>).kind,
      "aloha.fact-evidence-event",
    );
    assert.equal(sequenceMaterial.eventArtifact.ref.locator.kind, "file-range");
    if (sequenceMaterial.eventArtifact.ref.locator.kind === "file-range") {
      assert.equal(sequenceMaterial.eventArtifact.ref.locator.startInclusive, String(selectedEventStart));
    }
    assert.doesNotThrow(() => assertProductionSixStepSnapshotAppendSequencesV1(
      sequenceLedger,
      Object.freeze([sequenceMaterial]),
    ));
    assert.throws(() => assertProductionSixStepSnapshotAppendSequencesV1(
      sequenceLedger,
      Object.freeze([Object.freeze({
        ...sequenceMaterial,
        append: Object.freeze({ ...sequenceMaterial.append, sequence: "101" }),
      })]),
    ), /append sequence is not ledger-derived/);
    const stage3Material = readProductionSixStepArtifactMaterialV1(stage3);
    const selectedStage2Facts = selectedStage2Artifacts.map(value => decodeSixStepStageFacts(value.event.facts));
    const stage12Facts = Object.freeze({
      binding: stage12Binding,
      selectedParents: Object.freeze(selectedGraphLegs.map((leg, index) => Object.freeze({
        edgeId: leg.edgeId,
        selectedLegRoot: hashDomain("aloha/searcher-production-evidence-selected-graph-leg/v1", leg),
        stage1EventId: selectedStage1Artifacts[index]!.event.eventId,
        stage1ArtifactSetRoot: selectedStage1Artifacts[index]!.artifactSetRoot,
        stage2EventId: selectedStage2Artifacts[index]!.event.eventId,
        stage2ArtifactSetRoot: selectedStage2Artifacts[index]!.artifactSetRoot,
        instancePublicationRoot: selectedStage2Facts[index]!.stageId === "edge_ready_generation"
          ? selectedStage2Facts[index]!.instancePublication.contentRoot
          : h("invalid-stage2-publication"),
        edgeContentRoot: selectedStage2Facts[index]!.stageId === "edge_ready_generation"
          ? selectedStage2Facts[index]!.edge.contentRoot
          : h("invalid-stage2-edge"),
      }))),
      stage3EventId: stage3Material.event.eventId,
      stage3ArtifactSetRoot: stage3Material.artifactSetRoot,
    });
    const dagEvents = Object.freeze(stageArtifacts.map(value => value.event));
    const dagInput = Object.freeze({ events: dagEvents, selectedParents: stage12Facts.selectedParents });
    assert.doesNotThrow(() => assertProductionSixStepSelectedDagV1(dagInput));
    const replaceDagEvent = (position: number, event: typeof dagEvents[number]) => Object.freeze(
      dagEvents.map((value, index) => index === position ? event : value),
    );
    const firstStage2Position = selectedGraphLegs.length;
    const firstStage2 = dagEvents[firstStage2Position]!;
    const wrongStage1 = selectedStage1Artifacts.find(value => value.event.eventId !== firstStage2.parentEventIds[0])!;
    assert.throws(() => assertProductionSixStepSelectedDagV1({
      ...dagInput,
      events: replaceDagEvent(firstStage2Position, Object.freeze({
        ...firstStage2,
        parentEventIds: Object.freeze([wrongStage1.event.eventId]),
        parentOutputHashes: Object.freeze([wrongStage1.event.outputHash]),
      })),
    }), /Stage 2 parent/);
    const stage3Position = selectedGraphLegs.length * 2;
    const exactStage3Event = dagEvents[stage3Position]!;
    assert.throws(() => assertProductionSixStepSelectedDagV1({
      ...dagInput,
      events: replaceDagEvent(stage3Position, Object.freeze({
        ...exactStage3Event,
        parentEventIds: Object.freeze([...exactStage3Event.parentEventIds].reverse()),
        parentOutputHashes: Object.freeze([...exactStage3Event.parentOutputHashes].reverse()),
      })),
    }), /Stage 3 ordered parents/);
    const stage4Position = stage3Position + 1;
    const exactStage4Event = dagEvents[stage4Position]!;
    assert.throws(() => assertProductionSixStepSelectedDagV1({
      ...dagInput,
      events: replaceDagEvent(stage4Position, Object.freeze({
        ...exactStage4Event,
        parentEventIds: Object.freeze([h("spliced-stage4-parent")]),
      })),
    }), /Stage 4 parent/);
    assert.throws(() => assertProductionSixStepSelectedDagV1({
      ...dagInput,
      events: replaceDagEvent(stage4Position, Object.freeze({
        ...exactStage4Event,
        parentOutputHashes: Object.freeze([h("spliced-stage4-parent-output")]),
      })),
    }), /Stage 4 parent/);
    const stage12Root = hashDomain("aloha/searcher-production-evidence-stage12/v1", stage12Facts);
    const sixStepLineageRoot = hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", {
      stage12Root,
      stage36Root: terminalBinding.traceRoot,
    });
    assert.doesNotThrow(() => assertProductionSixStepLineageRootV1(
      sixStepLineageRoot,
      stage12Root,
      terminalBinding.traceRoot,
    ));
    assert.throws(() => assertProductionSixStepLineageRootV1(
      h("self-consistent-process-claimed-lineage-splice"),
      stage12Root,
      terminalBinding.traceRoot,
    ), /claimed lineage root mismatch/);
    const runtimeFacts = Object.freeze({ kind: "test-runtime-facts" });
    const producerSchedulerJoin = Object.freeze({
      correlationId: terminalBinding.correlationId,
      generationId: terminalBinding.generationId,
      source: currentSource,
      programHash: terminalBinding.programHash,
      finalSimulationReceiptHash: terminalBinding.finalSimulationReceiptHash,
      dryRunCandidateId: h("dry-run-candidate"),
      dryRunLineageHash: h("dry-run-lineage"),
    });
    const processPayload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.searcher-production-six-step-process-evidence-v1" as const,
      runtimeBindingId: terminalBinding.runtimeBindingId,
      candidateReleaseCommit: terminalBinding.candidateReleaseCommit,
      releaseProvenanceHash: terminalBinding.releaseProvenanceHash,
      terminalBindingRoot: terminalBinding.bindingRoot,
      traceRoot: terminalBinding.traceRoot,
      correlationId: terminalBinding.correlationId,
      generationId: terminalBinding.generationId,
      readyRecordHash: terminalBinding.readyRecordHash,
      graphRoot: terminalBinding.graphRoot,
      currentSource,
      programHash: terminalBinding.programHash,
      finalSimulationReceiptHash: terminalBinding.finalSimulationReceiptHash,
      stage12: stage12Facts,
      stage12Root,
      sixStepLineageRoot,
      runtimeFacts,
      runtimeFactsRoot: hashDomain("aloha/searcher-production-six-step-runtime-facts/v1", runtimeFacts),
      producerSchedulerJoin,
      producerSchedulerJoinRoot: hashDomain("aloha/searcher-production-six-step-producer-scheduler-join/v1", producerSchedulerJoin),
      runtimeAnchor,
      runtimeAnchorRoot: hashDomain("aloha/searcher-production-six-step-runtime-anchor/v1", runtimeAnchor),
      serving: Object.freeze({
        generationId: terminalBinding.generationId,
        graphRoot: terminalBinding.graphRoot,
        readyRecordHash: terminalBinding.readyRecordHash,
        sourceCoverageRoot: h("source-coverage"),
      }),
      canonicalHead: Object.freeze({ ...currentSource, parentHash: h("selected-parent") }),
      admissionId: h("admission"),
      producerTerminalId: h("selected-process-terminal"),
      producerTerminalBindingRoot: h("producer-terminal-binding"),
      durableAppend,
      durableAppendRecordId: appendId(durableAppend),
      producerTerminalDurableAppend,
      producerTerminalDurableAppendRecordId: appendId(producerTerminalDurableAppend),
    });
    const processEvidence = Object.freeze({
      ...processPayload,
      evidenceRoot: hashDomain("aloha/searcher-production-six-step-process-evidence/v1", processPayload),
    });
    const processArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(processEvidence),
      mediaType: "application/json",
      schema: schema("selected-process"),
    });
    const sixStepPredicateArtifacts = Object.freeze([...new Map(stageArtifacts.flatMap(stage => [
      stage.eventArtifact, stage.semanticArtifactRef, stage.productionReceiptRef, ...stage.inputArtifacts,
    ]).map(artifact => [artifact.ref.artifactRefId, Object.freeze({
      contentSha256: artifact.ref.contentSha256,
      bytes: artifact.bytes,
      ref: artifact.ref,
      claim: artifact.claim,
      lease: artifact.lease,
    })] as const)).values()].sort((left, right) => left.ref.artifactRefId.localeCompare(right.ref.artifactRefId)));
    const predicateArtifactRoot = hashDomain("aloha/production-six-step-predicate-artifact-closure/v1", sixStepPredicateArtifacts.map(artifact => ({
      artifactRefId: artifact.ref.artifactRefId,
      contentSha256: artifact.contentSha256,
      claimId: artifact.claim.claimId,
      leaseReceiptId: artifact.lease.receiptId,
    })));
    const eventArtifactRefIds = Object.freeze(stageArtifacts.map(stage => stage.eventArtifact.ref.artifactRefId));
    const terminalSelectionPolicyDigest = hashDomain(
      "aloha/searcher-production-six-step-window-selection-policy/v1",
      Object.freeze({
        denominator: "active-exact-100-performance-window",
        eligibility: "complete-successful-dry-run",
        order: Object.freeze(["ordinal", "lane:blockscan-before-backrun", "candidate-stable-key", "producer-terminal-id"]),
        selection: "first",
      }),
    );
    const observedSixStepPayload = Object.freeze({
      kind: "aloha.production-six-step-observation-v1" as const,
      status: "observed" as const,
      runtimeBindingId: terminalBinding.runtimeBindingId,
      candidateReleaseCommit: terminalBinding.candidateReleaseCommit,
      releaseProvenanceHash: terminalBinding.releaseProvenanceHash,
      finalDurableWindowId: base.finalDurableWindowId,
      windowSelectionRoot: h("observed-selection"),
      selectionPolicyDigest: terminalSelectionPolicyDigest,
      eligibleSuccessCount: "1",
      eligibleSuccessRoot: h("observed-eligible"),
      selectedIndex: "0" as const,
      selectedProducerTerminalId: processEvidence.producerTerminalId,
      terminalBindingRoot: terminalBinding.bindingRoot,
      joinedProcessEvidenceRoot: processEvidence.evidenceRoot,
      durableAppendRecordId: processEvidence.durableAppendRecordId,
      producerTerminalDurableAppendRecordId: processEvidence.producerTerminalDurableAppendRecordId,
      traceRoot: terminalBinding.traceRoot,
      stage12Root: processEvidence.stage12Root,
      sixStepLineageRoot: processEvidence.sixStepLineageRoot,
      runtimeAnchorRoot: processEvidence.runtimeAnchorRoot,
      runtimeFactsRoot: processEvidence.runtimeFactsRoot,
      programHash: terminalBinding.programHash,
      finalSimulationReceiptHash: terminalBinding.finalSimulationReceiptHash,
      observedArtifacts: Object.freeze([
        Object.freeze({
          role: "runtime-release-terminal-binding" as const,
          artifactRefId: terminalBindingArtifact.ref.artifactRefId,
          contentSha256: terminalBindingArtifact.contentSha256,
          claimId: terminalBindingArtifact.claim.claimId,
          leaseReceiptId: terminalBindingArtifact.lease.receiptId,
        }),
        Object.freeze({
          role: "joined-process-evidence" as const,
          artifactRefId: processArtifact.ref.artifactRefId,
          contentSha256: processArtifact.contentSha256,
          claimId: processArtifact.claim.claimId,
          leaseReceiptId: processArtifact.lease.receiptId,
        }),
      ]),
      stageArtifactSetRoots: stageArtifacts.map(stage => stage.artifactSetRoot),
    });
    const terminalManifest = replaceSixStep(base, Object.freeze({
      status: "observed" as const,
      observationRoot: hashDomain("aloha/production-six-step-observation/v1", observedSixStepPayload as unknown as CanonicalJson),
      windowSelectionRoot: observedSixStepPayload.windowSelectionRoot,
      selectionPolicyDigest: observedSixStepPayload.selectionPolicyDigest,
      eligibleSuccessCount: "1",
      eligibleSuccessRoot: observedSixStepPayload.eligibleSuccessRoot,
      selectedIndex: "0" as const,
      selectedProducerTerminalId: processEvidence.producerTerminalId,
      reason: null,
      joinedProcessEvidenceRoot: processEvidence.evidenceRoot,
      performanceAppendRecordId: processEvidence.durableAppendRecordId,
      producerTerminalAppendRecordId: processEvidence.producerTerminalDurableAppendRecordId,
      predicateArtifactCount: String(sixStepPredicateArtifacts.length),
      predicateArtifactRoot,
      eventArtifactRefIds,
    }));
    const manifestArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(terminalManifest),
      mediaType: "application/json",
      schema: schema("observed-terminal-manifest"),
    });
    const locatorPayload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.production-terminal-phase-locator-v1" as const,
      finalDurableWindowId: terminalManifest.finalDurableWindowId,
      terminalPhaseInvocationRoot: terminalManifest.terminalPhaseInvocationRoot,
      manifestRoot: terminalManifest.manifestRoot,
      manifestArtifactRefId: manifestArtifact.ref.artifactRefId,
      manifestContentSha256: manifestArtifact.contentSha256,
    });
    const locator: ProductionTerminalPhaseLocatorV1 = Object.freeze({
      ...locatorPayload,
      locatorRoot: hashDomain("aloha/production-terminal-phase-locator/v1", locatorPayload),
    });
    const locatorArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(locator),
      mediaType: "application/json",
      schema: schema("observed-terminal-locator"),
    });
    const publishInput = Object.freeze({
      manifest: terminalManifest,
      manifestArtifact,
      locator,
      locatorArtifact,
      fullFamilyProjectionArtifact,
      ...fullFamilyProjectionSources,
      selectedProcessArtifact: processArtifact,
      fullFamilyBundleArtifact: null,
      fullFamilyLocatorArtifact: null,
      sixStepTerminalBindingArtifact: terminalBindingArtifact,
      sixStepArtifactMaterials: stageArtifacts,
      generatedRuntimeMetadata: null,
    });
    const artifactsForStages = (materials: readonly ProductionSixStepArtifactMaterialV1[]) => Object.freeze([
      ...new Map(materials.flatMap(stage => [
        stage.eventArtifact,
        stage.semanticArtifactRef,
        stage.productionReceiptRef,
        ...stage.inputArtifacts,
      ]).map(artifact => [artifact.ref.artifactRefId, Object.freeze({
        contentSha256: artifact.ref.contentSha256,
        bytes: artifact.bytes,
        ref: artifact.ref,
        claim: artifact.claim,
        lease: artifact.lease,
      })] as const)).values(),
    ].sort((left, right) => left.ref.artifactRefId.localeCompare(right.ref.artifactRefId)));
    const assertRawOnlyRerootRejected = async (
      label: string,
      targetStageId: "current_source_exact" | "execution_program" | "final_simulation",
      transform: (payload: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
      expected: RegExp,
    ) => {
      const mutatedTail = createProductionSixStepTailFixture([], {
        sink: ownedSink,
        process: sixStepProcess,
        fileRangeStride: 1_000_000,
        stage12: Object.freeze({ binding: stage12Binding, selectedGraphLegs, readyEdges: selectedReadyEdges }),
        rawBoundaryPayloadTransform: (stageId, payload) => stageId === targetStageId
          ? transform(payload) as CanonicalJsonObject
          : payload,
      });
      const mutatedTailStages = await emitSixStepChain(mutatedTail);
      const mutatedStage12 = mutatedTail.readStage12Parents(mutatedTailStages.stage3);
      const mutatedSelectedStage1 = mutatedStage12.stage1.map(readProductionSixStepArtifactMaterialV1);
      const mutatedSelectedStage2 = mutatedStage12.stage2.map(readProductionSixStepArtifactMaterialV1);
      const mutatedMaterials = Object.freeze([
        ...[...mutatedSelectedStage1]
          .sort((left, right) => left.eventArtifact.ref.artifactRefId.localeCompare(right.eventArtifact.ref.artifactRefId)),
        ...[...mutatedSelectedStage2]
          .sort((left, right) => left.eventArtifact.ref.artifactRefId.localeCompare(right.eventArtifact.ref.artifactRefId)),
        readProductionSixStepArtifactMaterialV1(mutatedTailStages.stage3),
        readProductionSixStepArtifactMaterialV1(mutatedTailStages.stage4),
        readProductionSixStepArtifactMaterialV1(mutatedTailStages.stage5),
        readProductionSixStepArtifactMaterialV1(mutatedTailStages.stage6),
      ]);
      const baselineTarget = stageArtifacts.find(material => material.event.stage.id === targetStageId)!;
      const mutatedTarget = mutatedMaterials.find(material => material.event.stage.id === targetStageId)!;
      assert.notDeepEqual(mutatedTarget.inputArtifacts[0]!.bytes, baselineTarget.inputArtifacts[0]!.bytes);
      assert.deepEqual(
        mutatedTarget.witnessArtifacts.map(artifact => artifact.ref.contentSha256),
        baselineTarget.witnessArtifacts.map(artifact => artifact.ref.contentSha256),
      );
      assert.deepEqual(mutatedTarget.event.facts, baselineTarget.event.facts);
      assert.notEqual(mutatedTarget.event.eventId, baselineTarget.event.eventId);
      assert.notEqual(mutatedTarget.artifactSetRoot, baselineTarget.artifactSetRoot);

      const mutatedStage2Facts = mutatedSelectedStage2.map(value => decodeSixStepStageFacts(value.event.facts));
      const rerootedStage12Facts = Object.freeze({
        binding: stage12Binding,
        selectedParents: Object.freeze(selectedGraphLegs.map((leg, index) => Object.freeze({
          edgeId: leg.edgeId,
          selectedLegRoot: hashDomain("aloha/searcher-production-evidence-selected-graph-leg/v1", leg),
          stage1EventId: mutatedSelectedStage1[index]!.event.eventId,
          stage1ArtifactSetRoot: mutatedSelectedStage1[index]!.artifactSetRoot,
          stage2EventId: mutatedSelectedStage2[index]!.event.eventId,
          stage2ArtifactSetRoot: mutatedSelectedStage2[index]!.artifactSetRoot,
          instancePublicationRoot: mutatedStage2Facts[index]!.stageId === "edge_ready_generation"
            ? mutatedStage2Facts[index]!.instancePublication.contentRoot
            : h(`${label}-invalid-stage2-publication`),
          edgeContentRoot: mutatedStage2Facts[index]!.stageId === "edge_ready_generation"
            ? mutatedStage2Facts[index]!.edge.contentRoot
            : h(`${label}-invalid-stage2-edge`),
        }))),
        stage3EventId: mutatedMaterials[mutatedSelectedStage1.length + mutatedSelectedStage2.length]!.event.eventId,
        stage3ArtifactSetRoot: mutatedMaterials[mutatedSelectedStage1.length + mutatedSelectedStage2.length]!.artifactSetRoot,
      });
      const rerootedStage12Root = hashDomain("aloha/searcher-production-evidence-stage12/v1", rerootedStage12Facts);
      const rerootedResolvedPayload = Object.freeze({
        ...resolvedTracePayload,
        productionArtifactSetRoots: mutatedMaterials.slice(-4).map(material => material.artifactSetRoot),
      });
      const rerootedResolved = Object.freeze({
        ...rerootedResolvedPayload,
        traceRoot: hashDomain("aloha/resolved-route-six-step-trace/v1", rerootedResolvedPayload),
      });
      const rerootedTracePayload = Object.freeze({ ...tracePayload, resolved: rerootedResolved });
      const rerootedTrace = Object.freeze({
        ...rerootedTracePayload,
        traceRoot: hashDomain("aloha/search-terminal-six-step-trace/v1", rerootedTracePayload),
      });
      const rerootedTerminalPayload = Object.freeze({
        ...terminalPayload,
        traceRoot: rerootedTrace.traceRoot,
        trace: rerootedTrace,
      });
      const rerootedTerminal = Object.freeze({
        ...rerootedTerminalPayload,
        bindingRoot: hashDomain("aloha/runtime-release-six-step-terminal-binding/v1", rerootedTerminalPayload),
      });
      const rerootedTerminalArtifact = await ownedSink.write({
        bytes: encodeCanonicalBytes(rerootedTerminal),
        mediaType: "application/json",
        schema: schema(`${label}-terminal`),
      });
      const rerootedLineageRoot = hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", {
        stage12Root: rerootedStage12Root,
        stage36Root: rerootedTrace.traceRoot,
      });
      const rerootedProcessPayload = Object.freeze({
        ...processPayload,
        terminalBindingRoot: rerootedTerminal.bindingRoot,
        traceRoot: rerootedTrace.traceRoot,
        stage12: rerootedStage12Facts,
        stage12Root: rerootedStage12Root,
        sixStepLineageRoot: rerootedLineageRoot,
      });
      const rerootedProcess = Object.freeze({
        ...rerootedProcessPayload,
        evidenceRoot: hashDomain("aloha/searcher-production-six-step-process-evidence/v1", rerootedProcessPayload),
      });
      const rerootedProcessArtifact = await ownedSink.write({
        bytes: encodeCanonicalBytes(rerootedProcess),
        mediaType: "application/json",
        schema: schema(`${label}-process`),
      });
      const mutatedPredicateArtifacts = artifactsForStages(mutatedMaterials);
      const mutatedPredicateArtifactRoot = hashDomain(
        "aloha/production-six-step-predicate-artifact-closure/v1",
        mutatedPredicateArtifacts.map(artifact => ({
          artifactRefId: artifact.ref.artifactRefId,
          contentSha256: artifact.contentSha256,
          claimId: artifact.claim.claimId,
          leaseReceiptId: artifact.lease.receiptId,
        })),
      );
      const mutatedObservedPayload = Object.freeze({
        ...observedSixStepPayload,
        terminalBindingRoot: rerootedTerminal.bindingRoot,
        joinedProcessEvidenceRoot: rerootedProcess.evidenceRoot,
        traceRoot: rerootedTrace.traceRoot,
        stage12Root: rerootedStage12Root,
        sixStepLineageRoot: rerootedLineageRoot,
        observedArtifacts: Object.freeze([
          Object.freeze({
            role: "runtime-release-terminal-binding" as const,
            artifactRefId: rerootedTerminalArtifact.ref.artifactRefId,
            contentSha256: rerootedTerminalArtifact.contentSha256,
            claimId: rerootedTerminalArtifact.claim.claimId,
            leaseReceiptId: rerootedTerminalArtifact.lease.receiptId,
          }),
          Object.freeze({
            role: "joined-process-evidence" as const,
            artifactRefId: rerootedProcessArtifact.ref.artifactRefId,
            contentSha256: rerootedProcessArtifact.contentSha256,
            claimId: rerootedProcessArtifact.claim.claimId,
            leaseReceiptId: rerootedProcessArtifact.lease.receiptId,
          }),
        ]),
        stageArtifactSetRoots: mutatedMaterials.map(material => material.artifactSetRoot),
      });
      const mutatedManifest = replaceSixStep(base, Object.freeze({
        ...terminalManifest.sixStep,
        observationRoot: hashDomain(
          "aloha/production-six-step-observation/v1",
          mutatedObservedPayload as unknown as CanonicalJson,
        ),
        joinedProcessEvidenceRoot: rerootedProcess.evidenceRoot,
        predicateArtifactCount: String(mutatedPredicateArtifacts.length),
        predicateArtifactRoot: mutatedPredicateArtifactRoot,
        eventArtifactRefIds: mutatedMaterials.map(material => material.eventArtifact.ref.artifactRefId),
      }));
      const mutatedManifestArtifact = await ownedSink.write({
        bytes: encodeCanonicalBytes(mutatedManifest),
        mediaType: "application/json",
        schema: schema(`${label}-manifest`),
      });
      const mutatedLocatorPayload = Object.freeze({
        ...locatorPayload,
        terminalPhaseInvocationRoot: mutatedManifest.terminalPhaseInvocationRoot,
        manifestRoot: mutatedManifest.manifestRoot,
        manifestArtifactRefId: mutatedManifestArtifact.ref.artifactRefId,
        manifestContentSha256: mutatedManifestArtifact.contentSha256,
      });
      const mutatedLocator = Object.freeze({
        ...mutatedLocatorPayload,
        locatorRoot: hashDomain("aloha/production-terminal-phase-locator/v1", mutatedLocatorPayload),
      });
      const mutatedLocatorArtifact = await ownedSink.write({
        bytes: encodeCanonicalBytes(mutatedLocator),
        mediaType: "application/json",
        schema: schema(`${label}-locator`),
      });
      await assert.rejects(locatorIndex.publish({
        ...publishInput,
        manifest: mutatedManifest,
        manifestArtifact: mutatedManifestArtifact,
        locator: mutatedLocator,
        locatorArtifact: mutatedLocatorArtifact,
        selectedProcessArtifact: rerootedProcessArtifact,
        sixStepTerminalBindingArtifact: rerootedTerminalArtifact,
        sixStepPredicateArtifacts: mutatedPredicateArtifacts,
        sixStepArtifactMaterials: mutatedMaterials,
      }), expected);
    };
    await assertRawOnlyRerootRejected(
      "stage4-raw-only",
      "current_source_exact",
      payload => Object.freeze({ ...payload, exact: Object.freeze({ rawOnlyMutation: h("stage4-raw-only") }) }),
      /Stage 4 raw boundary\/terminal trace mismatch/,
    );
    await assertRawOnlyRerootRejected(
      "stage5-raw-only",
      "execution_program",
      payload => Object.freeze({ ...payload, callerMode: "call" }),
      /Stage 5 raw boundary\/terminal trace mismatch/,
    );
    await assertRawOnlyRerootRejected(
      "stage6-raw-only",
      "final_simulation",
      payload => Object.freeze({
        ...payload,
        economicSafety: Object.freeze({
          ...payload.economicSafety as Readonly<Record<string, unknown>>,
          economic: Object.freeze({ verdict: "raw-only-mutated" }),
        }),
      }),
      /Stage 6 raw boundary\/terminal trace mismatch/,
    );
    const splicedResolvedTracePayload = Object.freeze({
      ...resolvedTracePayload,
      routeBinding: Object.freeze({
        ...resolvedTracePayload.routeBinding,
        routeBindingHash: h("spliced-route-binding"),
      }),
    });
    const splicedResolvedTrace = Object.freeze({
      ...splicedResolvedTracePayload,
      traceRoot: hashDomain("aloha/resolved-route-six-step-trace/v1", splicedResolvedTracePayload),
    });
    const splicedTailTracePayload = Object.freeze({ ...tracePayload, resolved: splicedResolvedTrace });
    const splicedTailTrace = Object.freeze({
      ...splicedTailTracePayload,
      traceRoot: hashDomain("aloha/search-terminal-six-step-trace/v1", splicedTailTracePayload),
    });
    const splicedTailTerminalPayload = Object.freeze({
      ...terminalPayload,
      traceRoot: splicedTailTrace.traceRoot,
      trace: splicedTailTrace,
    });
    const splicedTailTerminal = Object.freeze({
      ...splicedTailTerminalPayload,
      bindingRoot: hashDomain("aloha/runtime-release-six-step-terminal-binding/v1", splicedTailTerminalPayload),
    });
    const splicedTailTerminalArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(splicedTailTerminal),
      mediaType: "application/json",
      schema: schema("spliced-tail-terminal-binding"),
    });
    const splicedTailProcessPayload = Object.freeze({
      ...processPayload,
      terminalBindingRoot: splicedTailTerminal.bindingRoot,
      traceRoot: splicedTailTrace.traceRoot,
      sixStepLineageRoot: hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", {
        stage12Root: processPayload.stage12Root,
        stage36Root: splicedTailTrace.traceRoot,
      }),
    });
    const splicedTailProcess = Object.freeze({
      ...splicedTailProcessPayload,
      evidenceRoot: hashDomain("aloha/searcher-production-six-step-process-evidence/v1", splicedTailProcessPayload),
    });
    const splicedTailProcessArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(splicedTailProcess),
      mediaType: "application/json",
      schema: schema("spliced-tail-process"),
    });
    const splicedTailObservedPayload = Object.freeze({
      ...observedSixStepPayload,
      terminalBindingRoot: splicedTailTerminal.bindingRoot,
      joinedProcessEvidenceRoot: splicedTailProcess.evidenceRoot,
      traceRoot: splicedTailTrace.traceRoot,
      sixStepLineageRoot: splicedTailProcess.sixStepLineageRoot,
      observedArtifacts: Object.freeze([
        Object.freeze({
          role: "runtime-release-terminal-binding" as const,
          artifactRefId: splicedTailTerminalArtifact.ref.artifactRefId,
          contentSha256: splicedTailTerminalArtifact.contentSha256,
          claimId: splicedTailTerminalArtifact.claim.claimId,
          leaseReceiptId: splicedTailTerminalArtifact.lease.receiptId,
        }),
        Object.freeze({
          role: "joined-process-evidence" as const,
          artifactRefId: splicedTailProcessArtifact.ref.artifactRefId,
          contentSha256: splicedTailProcessArtifact.contentSha256,
          claimId: splicedTailProcessArtifact.claim.claimId,
          leaseReceiptId: splicedTailProcessArtifact.lease.receiptId,
        }),
      ]),
    });
    const splicedTailManifest = replaceSixStep(base, Object.freeze({
      ...terminalManifest.sixStep,
      joinedProcessEvidenceRoot: splicedTailProcess.evidenceRoot,
      observationRoot: hashDomain("aloha/production-six-step-observation/v1", splicedTailObservedPayload),
    }));
    const splicedTailManifestArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(splicedTailManifest),
      mediaType: "application/json",
      schema: schema("spliced-tail-manifest"),
    });
    const splicedTailLocatorPayload = Object.freeze({
      ...locatorPayload,
      terminalPhaseInvocationRoot: splicedTailManifest.terminalPhaseInvocationRoot,
      manifestRoot: splicedTailManifest.manifestRoot,
      manifestArtifactRefId: splicedTailManifestArtifact.ref.artifactRefId,
      manifestContentSha256: splicedTailManifestArtifact.contentSha256,
    });
    const splicedTailLocator = Object.freeze({
      ...splicedTailLocatorPayload,
      locatorRoot: hashDomain("aloha/production-terminal-phase-locator/v1", splicedTailLocatorPayload),
    });
    const splicedTailLocatorArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(splicedTailLocator),
      mediaType: "application/json",
      schema: schema("spliced-tail-locator"),
    });
    await assert.rejects(locatorIndex.publish({
      ...publishInput,
      manifest: splicedTailManifest,
      manifestArtifact: splicedTailManifestArtifact,
      locator: splicedTailLocator,
      locatorArtifact: splicedTailLocatorArtifact,
      selectedProcessArtifact: splicedTailProcessArtifact,
      sixStepTerminalBindingArtifact: splicedTailTerminalArtifact,
      sixStepPredicateArtifacts,
    }), /route binding hash mismatch/);
    const rerootedTerminalPayload = Object.freeze({
      ...terminalPayload,
      runtimeBindingId: h("rerooted-six-step-runtime-binding"),
    });
    const rerootedTerminalBinding = Object.freeze({
      ...rerootedTerminalPayload,
      bindingRoot: hashDomain(
        "aloha/runtime-release-six-step-terminal-binding/v1",
        rerootedTerminalPayload as unknown as CanonicalJson,
      ),
    });
    const rerootedTerminalBindingArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(rerootedTerminalBinding),
      mediaType: "application/json",
      schema: schema("rerooted-selected-terminal-binding"),
    });
    await assert.rejects(locatorIndex.publish({
      ...publishInput,
      sixStepTerminalBindingArtifact: rerootedTerminalBindingArtifact,
      sixStepPredicateArtifacts,
    }), /Full-Family\/Six-Step terminal runtime splice/);
    await assert.rejects(
      locatorIndex.publish({
        ...publishInput,
        sixStepPredicateArtifacts: sixStepPredicateArtifacts.filter(artifact => artifact.ref.artifactRefId !== eventArtifactRefIds.at(-1)),
      }),
      /denominator|missing/,
    );
    const firstEvent = sixStepPredicateArtifacts.find(artifact => artifact.ref.artifactRefId === eventArtifactRefIds[0])!;
    assert.equal(firstEvent.ref.locator.kind, "file-range");
    if (firstEvent.ref.locator.kind !== "file-range" || firstEvent.claim.observedMirror === null) throw new TypeError("event fixture locator");
    const brokenRef = createReadOnlyArtifactRef({
      locator: Object.freeze({
        ...firstEvent.ref.locator,
        endExclusive: (BigInt(firstEvent.ref.locator.endExclusive) - 1n).toString(),
      }),
      immutableMirrorLocator: firstEvent.ref.immutableMirrorLocator,
      contentSha256: firstEvent.contentSha256,
      byteLength: (BigInt(firstEvent.ref.byteLength) - 1n).toString(),
      mediaType: firstEvent.ref.mediaType,
      schema: firstEvent.ref.schema,
      resolverPolicyHash: firstEvent.ref.resolverPolicyHash,
      retentionLeaseReceiptId: firstEvent.ref.retentionLeaseReceiptId,
    });
    const brokenClaim = createArtifactResolutionClaim({
      artifactRefId: brokenRef.artifactRefId,
      resolverPolicyHash: brokenRef.resolverPolicyHash,
      observedMirror: firstEvent.claim.observedMirror,
      outcome: "content-observed",
    });
    const brokenAppendArtifacts = Object.freeze(sixStepPredicateArtifacts.map(artifact => artifact === firstEvent
      ? Object.freeze({ ...artifact, ref: brokenRef, claim: brokenClaim })
      : artifact).sort((left, right) => left.ref.artifactRefId.localeCompare(right.ref.artifactRefId)));
    await assert.rejects(
      locatorIndex.publish({ ...publishInput, sixStepPredicateArtifacts: brokenAppendArtifacts }),
      /bytes\/ref\/claim\/lease\/mirror mismatch/,
    );
    await assert.rejects(locatorIndex.publish({
      ...publishInput,
      sixStepPredicateArtifacts,
      sixStepArtifactMaterials: Object.freeze(stageArtifacts.map((material, index) => index === 0
        ? Object.freeze({ ...material, boundaryKey: h("caller-spliced-boundary-key") })
        : material)),
    }), /boundary key mismatch/);
    const splicedRuntimeAnchor = Object.freeze({ ...runtimeAnchor, pid: "43" });
    const splicedProcessPayload = Object.freeze({
      ...processPayload,
      runtimeAnchor: splicedRuntimeAnchor,
      runtimeAnchorRoot: hashDomain("aloha/searcher-production-six-step-runtime-anchor/v1", splicedRuntimeAnchor),
    });
    const splicedProcessEvidence = Object.freeze({
      ...splicedProcessPayload,
      evidenceRoot: hashDomain("aloha/searcher-production-six-step-process-evidence/v1", splicedProcessPayload),
    });
    const splicedProcessArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(splicedProcessEvidence),
      mediaType: "application/json",
      schema: schema("spliced-selected-process"),
    });
    const splicedObservedPayload = Object.freeze({
      ...observedSixStepPayload,
      joinedProcessEvidenceRoot: splicedProcessEvidence.evidenceRoot,
      runtimeAnchorRoot: splicedProcessEvidence.runtimeAnchorRoot,
      observedArtifacts: Object.freeze([
        observedSixStepPayload.observedArtifacts[0]!,
        Object.freeze({
          role: "joined-process-evidence" as const,
          artifactRefId: splicedProcessArtifact.ref.artifactRefId,
          contentSha256: splicedProcessArtifact.contentSha256,
          claimId: splicedProcessArtifact.claim.claimId,
          leaseReceiptId: splicedProcessArtifact.lease.receiptId,
        }),
      ]),
    });
    const splicedManifest = replaceSixStep(base, Object.freeze({
      ...terminalManifest.sixStep,
      observationRoot: hashDomain("aloha/production-six-step-observation/v1", splicedObservedPayload as unknown as CanonicalJson),
      joinedProcessEvidenceRoot: splicedProcessEvidence.evidenceRoot,
    }));
    const splicedManifestArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(splicedManifest), mediaType: "application/json", schema: schema("spliced-process-manifest"),
    });
    const splicedLocatorPayload = Object.freeze({
      ...locatorPayload,
      terminalPhaseInvocationRoot: splicedManifest.terminalPhaseInvocationRoot,
      manifestRoot: splicedManifest.manifestRoot,
      manifestArtifactRefId: splicedManifestArtifact.ref.artifactRefId,
      manifestContentSha256: splicedManifestArtifact.contentSha256,
    });
    const splicedLocator = Object.freeze({
      ...splicedLocatorPayload,
      locatorRoot: hashDomain("aloha/production-terminal-phase-locator/v1", splicedLocatorPayload),
    });
    const splicedLocatorArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(splicedLocator), mediaType: "application/json", schema: schema("spliced-process-locator"),
    });
    await assert.rejects(locatorIndex.publish({
      ...publishInput,
      manifest: splicedManifest,
      manifestArtifact: splicedManifestArtifact,
      locator: splicedLocator,
      locatorArtifact: splicedLocatorArtifact,
      selectedProcessArtifact: splicedProcessArtifact,
      sixStepPredicateArtifacts,
    }), /crosses its producer process/);
    const rerootedStage12 = Object.freeze({
      ...stage12Facts,
      selectedParents: Object.freeze(stage12Facts.selectedParents.map((parent, index) => index === 0
        ? Object.freeze({ ...parent, stage1EventId: h("rerooted-stage1-event") })
        : parent)),
    });
    const rerootedStage12Root = hashDomain("aloha/searcher-production-evidence-stage12/v1", rerootedStage12);
    const rerootedStage12ProcessPayload = Object.freeze({
      ...processPayload,
      stage12: rerootedStage12,
      stage12Root: rerootedStage12Root,
      sixStepLineageRoot: hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", {
        stage12Root: rerootedStage12Root,
        stage36Root: terminalBinding.traceRoot,
      }),
    });
    const rerootedStage12Process = Object.freeze({
      ...rerootedStage12ProcessPayload,
      evidenceRoot: hashDomain(
        "aloha/searcher-production-six-step-process-evidence/v1",
        rerootedStage12ProcessPayload,
      ),
    });
    const rerootedStage12ProcessArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(rerootedStage12Process),
      mediaType: "application/json",
      schema: schema("rerooted-stage12-process"),
    });
    const rerootedStage12ObservedPayload = Object.freeze({
      ...observedSixStepPayload,
      joinedProcessEvidenceRoot: rerootedStage12Process.evidenceRoot,
      stage12Root: rerootedStage12Root,
      sixStepLineageRoot: rerootedStage12Process.sixStepLineageRoot,
      observedArtifacts: Object.freeze([
        observedSixStepPayload.observedArtifacts[0]!,
        Object.freeze({
          role: "joined-process-evidence" as const,
          artifactRefId: rerootedStage12ProcessArtifact.ref.artifactRefId,
          contentSha256: rerootedStage12ProcessArtifact.contentSha256,
          claimId: rerootedStage12ProcessArtifact.claim.claimId,
          leaseReceiptId: rerootedStage12ProcessArtifact.lease.receiptId,
        }),
      ]),
    });
    const rerootedStage12Manifest = replaceSixStep(base, Object.freeze({
      ...terminalManifest.sixStep,
      observationRoot: hashDomain(
        "aloha/production-six-step-observation/v1",
        rerootedStage12ObservedPayload as unknown as CanonicalJson,
      ),
      joinedProcessEvidenceRoot: rerootedStage12Process.evidenceRoot,
    }));
    const rerootedStage12ManifestArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(rerootedStage12Manifest),
      mediaType: "application/json",
      schema: schema("rerooted-stage12-manifest"),
    });
    const rerootedStage12LocatorPayload = Object.freeze({
      ...locatorPayload,
      terminalPhaseInvocationRoot: rerootedStage12Manifest.terminalPhaseInvocationRoot,
      manifestRoot: rerootedStage12Manifest.manifestRoot,
      manifestArtifactRefId: rerootedStage12ManifestArtifact.ref.artifactRefId,
      manifestContentSha256: rerootedStage12ManifestArtifact.contentSha256,
    });
    const rerootedStage12Locator = Object.freeze({
      ...rerootedStage12LocatorPayload,
      locatorRoot: hashDomain("aloha/production-terminal-phase-locator/v1", rerootedStage12LocatorPayload),
    });
    const rerootedStage12LocatorArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(rerootedStage12Locator),
      mediaType: "application/json",
      schema: schema("rerooted-stage12-locator"),
    });
    await assert.rejects(locatorIndex.publish({
      ...publishInput,
      manifest: rerootedStage12Manifest,
      manifestArtifact: rerootedStage12ManifestArtifact,
      locator: rerootedStage12Locator,
      locatorArtifact: rerootedStage12LocatorArtifact,
      selectedProcessArtifact: rerootedStage12ProcessArtifact,
      sixStepPredicateArtifacts,
    }), /DAG selected Stage 1\/2 denominator|selected event denominator|selected-parent splice/);
    const unrelatedBoundaryMaterials: ProductionSixStepArtifactMaterialV1[] = [];
    for (let index = 0; index < 8; index += 1) {
      const unrelatedPipeline = Object.freeze({
        ...pipeline,
        correlationId: h(`unrelated-boundary-correlation:${index}`),
        routeCandidateId: h(`unrelated-boundary-route-candidate:${index}`),
        orderedEdgeIds: Object.freeze(route.legs.map((_, legIndex) =>
          h(`unrelated-boundary-edge:${index}:${legIndex}`))),
      });
      const unrelatedRoute = Object.freeze({
        ...route,
        routeHash: h(`unrelated-boundary-route:${index}`),
        routeBindingHash: h(`unrelated-boundary-route-binding:${index}`),
        legs: Object.freeze(route.legs.map((_, legIndex) => Object.freeze({
          edgeId: unrelatedPipeline.orderedEdgeIds[legIndex]!,
          ownerRef: `unrelated-owner-${index}-${legIndex}`,
        }))),
      });
      const unrelatedStage3 = await tail.emitPlanner({
        pipeline: unrelatedPipeline,
        route: unrelatedRoute,
        coarse: {},
        planned: {},
        timing,
      } as never);
      const unrelatedStage12 = tail.readStage12Parents(unrelatedStage3);
      unrelatedBoundaryMaterials.push(
        ...unrelatedStage12.stage1.map(readProductionSixStepArtifactMaterialV1),
        ...unrelatedStage12.stage2.map(readProductionSixStepArtifactMaterialV1),
        readProductionSixStepArtifactMaterialV1(unrelatedStage3),
      );
    }
    assert.equal(unrelatedBoundaryMaterials.length, 40);
    const selectedPublication = await locatorIndex.publish({
      ...publishInput,
      sixStepPredicateArtifacts,
      sixStepArtifactMaterials: Object.freeze([
        ...stageArtifacts,
        ...unrelatedBoundaryMaterials,
      ]),
    });
    const selectedBoundaryKeys = Object.freeze(stageArtifacts.map(material => material.boundaryKey).sort());
    assert.equal(selectedPublication.sixStepBoundaryKeys.length, 8, "two selected legs require exactly 2L+4 boundaries");
    assert.deepEqual(selectedPublication.sixStepBoundaryKeys, selectedBoundaryKeys);
    assert.equal(
      selectedPublication.sixStepBoundaryKeyRoot,
      hashCanonicalPartition(
        "aloha/production-terminal-phase-six-step-boundary-key-sequence/v1",
        selectedBoundaryKeys,
        16,
      ),
    );
    const oldProjection = decodeProductionTerminalPhaseFullFamilyProjectionV1(
      decodeCanonicalBytes(fullFamilyProjectionArtifact.bytes),
    );
    const { observationRoot: _oldProjectionRoot, ...oldProjectionCore } = oldProjection;
    const acceptanceProjectionCore = Object.freeze({
      ...oldProjectionCore,
      finalDurableWindowId: terminalManifest.finalDurableWindowId,
      readyRecordHash: processEvidence.readyRecordHash,
      fullGraphCoarseSweepRoot: terminalManifest.fullGraphCoarseSweepRoot,
      producerTerminalBindingRoot: processEvidence.producerTerminalBindingRoot,
    });
    const acceptanceProjection = Object.freeze({
      ...acceptanceProjectionCore,
      observationRoot: hashDomain("aloha/production-terminal-phase-full-family-projection/v1", acceptanceProjectionCore as unknown as CanonicalJson),
    });
    const acceptanceProjectionArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(acceptanceProjection),
      mediaType: "application/json",
      schema: TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.fullFamilyProjection,
    });
    const acceptanceProcessArtifact = await ownedSink.write({
      bytes: processArtifact.bytes,
      mediaType: "application/json",
      schema: TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.processEvidence,
    });
    const releaseAnchorRoot = hashDomain("aloha/production-terminal-phase-release-anchor/v1", {
      bindingId: processEvidence.runtimeBindingId,
      releaseProvenanceHash: processEvidence.releaseProvenanceHash,
      candidateReleaseCommit: processEvidence.candidateReleaseCommit,
    });
    const rewiredManifestBase = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.production-terminal-phase-manifest-v1" as const,
      finalDurableWindowId: terminalManifest.finalDurableWindowId,
      windowId: terminalManifest.windowId,
      releaseAnchorRoot,
      runtimeAnchorRoot: terminalSelectionRuntimeAnchorRoot(processEvidence),
      runtimeArtifactRoot: processEvidence.runtimeAnchor.runtimeArtifactRoot,
      processAnchorRoot: terminalSelectionProcessAnchorRoot(processEvidence),
      fullGraphCoarseSweepRoot: acceptanceProjection.fullGraphCoarseSweepRoot,
      fullFamily: Object.freeze({
        projectionArtifactRefId: acceptanceProjectionArtifact.ref.artifactRefId,
        projectionContentSha256: acceptanceProjectionArtifact.contentSha256,
      }),
      sixStep: terminalManifest.sixStep,
    });
    const rewiredManifestCore = Object.freeze({
      ...rewiredManifestBase,
      terminalPhaseInvocationRoot: hashDomain("aloha/production-terminal-phase-invocation/v1", {
        finalDurableWindowId: rewiredManifestBase.finalDurableWindowId,
        fullGraphCoarseSweepRoot: rewiredManifestBase.fullGraphCoarseSweepRoot,
        fullFamilyObservationRoot: acceptanceProjection.observationRoot,
        sixStepObservationRoot: rewiredManifestBase.sixStep.observationRoot,
        releaseAnchorRoot: rewiredManifestBase.releaseAnchorRoot,
        runtimeAnchorRoot: rewiredManifestBase.runtimeAnchorRoot,
        runtimeArtifactRoot: rewiredManifestBase.runtimeArtifactRoot,
        processAnchorRoot: rewiredManifestBase.processAnchorRoot,
      }),
    });
    const acceptanceManifest = Object.freeze({
      ...rewiredManifestCore,
      manifestRoot: hashDomain("aloha/production-terminal-phase-manifest/v1", rewiredManifestCore as unknown as CanonicalJson),
    });
    const acceptanceManifestArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(acceptanceManifest),
      mediaType: "application/json",
      schema: TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.terminalManifest,
    });
    const rawSelection = createRawTerminalSelectionObservationV1({
      databaseSha256Before: h("selected-terminal-database"),
      databaseSha256After: h("selected-terminal-database"),
      storageSetRootBefore: h("selected-terminal-storage"),
      storageSetRootAfter: h("selected-terminal-storage"),
      sqliteSchemaRoot: h("selected-terminal-sqlite-schema"),
      rawRowRoot: h("selected-terminal-raw-rows"),
      eventRoot: h("selected-terminal-events"),
      terminalPhaseRowCount: "0",
      terminalPhaseRowRoot: hashDomain("aloha/raw-production-terminal-phase-row-root/v1", []),
      release: Object.freeze({
        bindingId: processEvidence.runtimeBindingId,
        releaseProvenanceHash: processEvidence.releaseProvenanceHash,
        candidateReleaseCommit: processEvidence.candidateReleaseCommit,
      }),
      serving: processEvidence.serving,
      selection: Object.freeze({
        finalDurableWindowId: acceptanceManifest.finalDurableWindowId,
        selectionPolicyDigest: acceptanceManifest.sixStep.selectionPolicyDigest!,
        eligibleSuccessCount: acceptanceManifest.sixStep.eligibleSuccessCount!,
        eligibleSuccessRoot: acceptanceManifest.sixStep.eligibleSuccessRoot!,
        selectedIndex: "0" as const,
        selectedProducerTerminalId: processEvidence.producerTerminalId,
        selectedPerformanceEventId: processEvidence.durableAppend.eventId,
        selectedProducerTerminalEventId: processEvidence.producerTerminalDurableAppend.eventId,
        selectionRoot: acceptanceManifest.sixStep.windowSelectionRoot!,
      }),
    });
    const rawSelectionArtifact = await ownedSink.write({
      bytes: encodeCanonicalBytes(rawSelection),
      mediaType: "application/json",
      schema: TERMINAL_SELECTION_ARTIFACT_SCHEMA_REFS.rawSelection,
    });
    const terminalFact = createTerminalSelectionFactV1({
      rawSelectionArtifactRefId: rawSelectionArtifact.ref.artifactRefId,
      terminalManifestArtifactRefId: acceptanceManifestArtifact.ref.artifactRefId,
      fullFamilyProjectionArtifactRefId: acceptanceProjectionArtifact.ref.artifactRefId,
      processEvidenceArtifactRefId: acceptanceProcessArtifact.ref.artifactRefId,
      sixStepPredicateArtifactRefIds: sixStepPredicateArtifacts.map(value => value.ref.artifactRefId),
    });
    const terminalArtifacts = Object.freeze([
      rawSelectionArtifact,
      acceptanceManifestArtifact,
      acceptanceProjectionArtifact,
      acceptanceProcessArtifact,
      ...sixStepPredicateArtifacts,
    ]);
    const terminalFacts = Object.freeze({
      facts: Object.freeze([terminalFact]),
      refs: Object.freeze(terminalArtifacts.map(value => value.ref)),
      claims: Object.freeze(terminalArtifacts.map(value => value.claim)),
      policies: Object.freeze([ownedSink.resolverPolicy]),
      leases: Object.freeze(terminalArtifacts.map(value => value.lease)),
      observations: Object.freeze([Object.freeze({
        observationId: "selected-real-six-step-terminal",
        rawArtifactRefs: Object.freeze(terminalArtifacts.map(value => value.ref)),
        observedClaimIds: Object.freeze(terminalArtifacts.map(value => value.claim.claimId)),
      })]),
      trustedObserverInvocation: Object.freeze({
        keyId: h("selected-terminal-observer-key"),
        observerQualificationId: h("selected-terminal-observer-qualification"),
        roleId: TERMINAL_SELECTION_INVOCATION_SEAL_ROLE.roleId,
        authenticatedArtifactRefIds: Object.freeze(terminalArtifacts.map(value => value.ref.artifactRefId).sort()),
        candidateReleaseCommit: processEvidence.candidateReleaseCommit,
      }),
    });
    const predicateVerdict = evaluateTerminalSelectionPredicate(terminalFacts);
    const referenceVerdict = evaluateTerminalSelectionReferenceModel(terminalFacts);
    assert.equal(predicateVerdict.verdict, "pass", JSON.stringify(predicateVerdict.reasons));
    assert.equal(referenceVerdict.verdict, "pass", JSON.stringify(referenceVerdict.reasons));
    // The generic Six-Step unit fixture does not model the production owner's
    // newline-delimited append ledger.  Keep its snapshot explicitly invalid;
    // production JSONL semantics are exercised by the fixed integration path.
    const physicalLedgerBytes = new Uint8Array(Buffer.from("{}\n"));
    const sweep = fullGraphSweepFixture(terminalManifest.finalDurableWindowId);
    const graphEdge = sweep.entries[0]!.edge;
    const graphTransitions = derivePlannerCompatibleReadyGraphTransitionsV1([graphEdge]);
    const indexFileName = `${terminalManifest.finalDurableWindowId.slice(2)}.json`;
    const publishedIndexBytes = new Uint8Array(readFileSync(join(indexDirectory, indexFileName)));
    const publishedIndex = decodeCanonicalBytes(publishedIndexBytes) as Readonly<Record<string, unknown>>;
    const publishedIndexRoot = publishedIndex.indexRoot as Hash;
    const compactPointers = publishedIndex.sixStepPredicateArtifacts as readonly Readonly<Record<string, unknown>>[];
    assert.equal(compactPointers.length, sixStepPredicateArtifacts.length);
    assert.ok(encodeCanonicalBytes(compactPointers as unknown as CanonicalJson).byteLength < 524_288);
    for (const pointer of compactPointers) {
      assert.deepEqual(Object.keys(pointer).sort(), ["claimId", "contentSha256", "leaseReceiptId", "ref"]);
      assert.equal(Object.prototype.hasOwnProperty.call(pointer, "claim"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(pointer, "lease"), false);
    }
    assert.equal(
      publishedIndex.sixStepPredicateArtifactPointerRoot,
      hashCanonicalPartition(
        "aloha/production-terminal-phase-six-step-artifact-pointer-sequence/v1",
        compactPointers,
        64,
      ),
    );
    const compactBoundaryKeys = publishedIndex.sixStepBoundaryKeys as readonly Hash[];
    assert.deepEqual(compactBoundaryKeys, selectedBoundaryKeys);
    assert.equal(
      publishedIndex.sixStepBoundaryKeyRoot,
      hashCanonicalPartition(
        "aloha/production-terminal-phase-six-step-boundary-key-sequence/v1",
        compactBoundaryKeys,
        16,
      ),
    );
    const indexPath = join(indexDirectory, indexFileName);
    const rehashIndex = (value: Readonly<Record<string, unknown>>) => {
      const { indexRoot: _indexRoot, ...payload } = value;
      return Object.freeze({
        ...payload,
        indexRoot: hashDomain("aloha/production-terminal-phase-locator-index/v1", payload as CanonicalJson),
      });
    };
    const withPointers = (pointers: readonly unknown[]) => rehashIndex(Object.freeze({
      ...publishedIndex,
      sixStepPredicateArtifacts: Object.freeze(pointers),
      sixStepPredicateArtifactPointerRoot: hashCanonicalPartition(
        "aloha/production-terminal-phase-six-step-artifact-pointer-sequence/v1",
        pointers,
        64,
      ),
    }));
    const withBoundaryKeys = (keys: readonly Hash[]) => rehashIndex(Object.freeze({
      ...publishedIndex,
      sixStepBoundaryKeys: Object.freeze(keys),
      sixStepBoundaryKeyRoot: hashCanonicalPartition(
        "aloha/production-terminal-phase-six-step-boundary-key-sequence/v1",
        keys,
        16,
      ),
    }));
    assert.throws(
      () => decodeProductionTerminalPhaseLocatorIndexV1(withBoundaryKeys(compactBoundaryKeys.slice(0, -1))),
      /exact 2L\+4 selected closure/,
    );
    assert.throws(
      () => decodeProductionTerminalPhaseLocatorIndexV1(withBoundaryKeys([...compactBoundaryKeys].reverse())),
      /strictly sorted and unique/,
    );
    const duplicateBoundaryKeys = [...compactBoundaryKeys];
    duplicateBoundaryKeys[1] = duplicateBoundaryKeys[0]!;
    assert.throws(
      () => decodeProductionTerminalPhaseLocatorIndexV1(withBoundaryKeys(duplicateBoundaryKeys)),
      /strictly sorted and unique/,
    );
    assert.throws(
      () => decodeProductionTerminalPhaseLocatorIndexV1(rehashIndex(Object.freeze({
        ...publishedIndex,
        sixStepBoundaryKeyRoot: h("mutated-selected-boundary-key-root"),
      }))),
      /boundary key root mismatch/,
    );
    const rejectsTamperedIndex = async (tampered: Readonly<Record<string, unknown>>, pattern: RegExp) => {
      const tamperedBytes = encodeCanonicalBytes(tampered as CanonicalJson);
      assert.equal(tamperedBytes.byteLength, publishedIndexBytes.byteLength, "semantic index tamper must preserve physical length");
      try {
        writeFileSync(indexPath, tamperedBytes);
        await assert.rejects(locatorIndex.read(terminalManifest.finalDurableWindowId), pattern);
      } finally {
        writeFileSync(indexPath, publishedIndexBytes);
      }
    };
    await rejectsTamperedIndex(withPointers([...compactPointers].reverse()), /exact-sorted/);
    const equalLengthPair = compactPointers.flatMap((pointer, index) => compactPointers
      .slice(index + 1)
      .map((candidate, offset) => Object.freeze({ pointer, left: index, right: index + offset + 1, candidate })))
      .find(({ pointer, candidate }) => encodeCanonicalBytes(pointer as unknown as CanonicalJson).byteLength
        === encodeCanonicalBytes(candidate as unknown as CanonicalJson).byteLength);
    assert.ok(equalLengthPair, "fixture must contain equal-length compact pointers");
    const duplicatePointers = [...compactPointers];
    duplicatePointers[equalLengthPair.right] = equalLengthPair.pointer;
    await rejectsTamperedIndex(withPointers(duplicatePointers), /exact-sorted/);
    try {
      writeFileSync(indexPath, encodeCanonicalBytes(withPointers(
        Array.from({ length: 320 }, () => compactPointers[0]),
      ) as unknown as CanonicalJson));
      await assert.rejects(
        locatorIndex.read(terminalManifest.finalDurableWindowId),
        /physical file/,
      );
    } finally {
      writeFileSync(indexPath, publishedIndexBytes);
    }
    await rejectsTamperedIndex(rehashIndex(Object.freeze({
      ...publishedIndex,
      sixStepPredicateArtifactPointerRoot: h("spliced-pointer-root"),
    })), /pointer root mismatch/);
    const selectedBoundaryDirectory = join(root, "selected-boundary-closure");
    const selectedBoundaryEntries = writePhysicalSixStepBoundaries(selectedBoundaryDirectory, stageArtifacts);
    const selectedBoundaryEntrySetRoot = hashDomain("aloha/pre-release-directory-snapshot-entry-set/v1", {
      snapshotKind: "six-step-boundaries",
      observerStoreIdentityHash: null,
      entries: selectedBoundaryEntries.map(entry => ({
        name: entry.name,
        contentSha256: entry.contentSha256,
        byteLength: entry.byteLength,
      })),
    });
    const selectedBoundaryTrust = Object.freeze({
      sixStepBoundaryDirectory: selectedBoundaryDirectory,
      sixStepBoundaryEntrySetRoot: selectedBoundaryEntrySetRoot,
      sixStepBoundaryFiles: selectedBoundaryEntries.map(entry => Object.freeze({
        name: entry.name,
        contentSha256: entry.contentSha256,
        byteLength: entry.byteLength,
        device: entry.device,
        inode: entry.inode,
        fsynced: true as const,
      })),
    }) as unknown as ProductionTerminalPhaseSnapshotTrustStateV1;
    assert.deepEqual(
      readProductionSixStepSnapshotBoundaryMaterialsV1(selectedBoundaryTrust, compactBoundaryKeys)
        .map(material => material.boundaryKey),
      compactBoundaryKeys,
    );
    const replacementBoundaryKeys = Object.freeze([
      compactBoundaryKeys[0]!,
      h("replacement-selected-boundary-key"),
      ...compactBoundaryKeys.slice(2),
    ].sort());
    assert.equal(new Set(replacementBoundaryKeys).size, 8);
    assert.throws(
      () => readProductionSixStepSnapshotBoundaryMaterialsV1(selectedBoundaryTrust, replacementBoundaryKeys),
      /snapshot denominator changed/,
    );
    assert.throws(
      () => readProductionSixStepSnapshotBoundaryMaterialsV1(
        selectedBoundaryTrust,
        compactBoundaryKeys.slice(0, -1),
      ),
      /exact 2L\+4 selected closure/,
    );
    assert.throws(
      () => readProductionSixStepSnapshotBoundaryMaterialsV1(Object.freeze({
        ...selectedBoundaryTrust,
        sixStepBoundaryEntrySetRoot: h("rerooted-selected-boundary-snapshot"),
      }) as ProductionTerminalPhaseSnapshotTrustStateV1, compactBoundaryKeys),
      /snapshot root mismatch/,
    );
    const createPhysicalSnapshotCase = (label: string) => {
      const caseRoot = join(root, `physical-${label}`);
      const caseStoreDirectory = join(caseRoot, "objects");
      const caseIndexDirectory = join(caseRoot, "index");
      const ledgerPath = join(caseRoot, "six-step-evidence", "evidence.jsonl");
      const boundaryDirectory = join(caseRoot, "six-step-evidence", "boundaries");
      cpSync(storeDirectory, caseStoreDirectory, { recursive: true });
      cpSync(indexDirectory, caseIndexDirectory, { recursive: true });
      chmodSync(caseStoreDirectory, 0o700);
      chmodSync(caseIndexDirectory, 0o700);
      mkdirSync(join(caseRoot, "six-step-evidence"), { recursive: true });
      writeFileSync(ledgerPath, physicalLedgerBytes);
      const ledgerMetadata = statSync(ledgerPath, { bigint: true });
      const boundaryEntries = writePhysicalSixStepBoundaries(boundaryDirectory, stageArtifacts);
      const boundaryEntrySetRoot = hashDomain("aloha/pre-release-directory-snapshot-entry-set/v1", {
        snapshotKind: "six-step-boundaries",
        observerStoreIdentityHash: null,
        entries: boundaryEntries.map(entry => ({
          name: entry.name,
          contentSha256: entry.contentSha256,
          byteLength: entry.byteLength,
        })),
      });
      const caseSink = sink(caseStoreDirectory);
      const caseIndex = new ProductionTerminalPhaseLocatorIndexV1({ directory: caseIndexDirectory, sink: caseSink });
      const trust = Object.freeze(Object.create(null)) as ProductionTerminalPhaseSnapshotTrustCapabilityV1;
      const trustInput = Object.freeze({
        snapshotRoot: h(`snapshot:${label}`),
        observerContentDirectory: caseStoreDirectory,
        observerContentEntrySetRoot: h(`observer-entry-set:${label}`),
        terminalLocatorDirectory: caseIndexDirectory,
        terminalLocatorEntrySetRoot: h(`locator-entry-set:${label}`),
        sixStepSourceLedger: Object.freeze({
          sourceDevice: "1",
          sourceInode: "2",
          snapshotPath: ledgerPath,
          snapshotDevice: String(ledgerMetadata.dev),
          snapshotInode: String(ledgerMetadata.ino),
          contentSha256: sha256Hex(physicalLedgerBytes),
          byteLength: String(physicalLedgerBytes.byteLength),
          fsynced: true as const,
        }),
        sixStepBoundaryDirectory: boundaryDirectory,
        sixStepBoundaryEntrySetRoot: boundaryEntrySetRoot,
        sixStepBoundaryFiles: boundaryEntries.map(entry => Object.freeze({
          name: entry.name,
          contentSha256: entry.contentSha256,
          byteLength: entry.byteLength,
          device: entry.device,
          inode: entry.inode,
          fsynced: true as const,
        })),
        finalDurableWindowId: terminalManifest.finalDurableWindowId,
        indexFileName,
        indexContentSha256: sha256Hex(publishedIndexBytes),
        indexByteLength: String(publishedIndexBytes.byteLength),
        indexRoot: publishedIndexRoot,
        observerStoreIdentityHash: h("store"),
        runtimeBindingId: sweep.binding.runtimeBindingId,
        candidateReleaseCommit: sweep.binding.candidateReleaseCommit,
        releaseProvenanceHash: sweep.binding.releaseProvenanceHash,
        activeReadyGraph: Object.freeze({
          checkpointRootEnvelopeHash: h(`checkpoint-envelope:${label}`),
          checkpointRevision: "1",
          readyClosureStorageHash: h(`ready-closure-storage:${label}`),
          readyRecordHash: sweep.binding.readyRecordHash,
          generationId: sweep.binding.generationId,
          releaseProvenanceHash: sweep.binding.releaseProvenanceHash,
          generationRefreshPolicyHash: resolvedBindingFact.generationRefreshPolicyHash,
          cutoff: sweep.binding.readyCutoff,
          definitionCatalogRoot: stage12Binding.definitionCatalogRoot,
          sourceCoverageRoot: stage12Binding.sourceCoverageRoot,
          candidatePartitionRoot: stage12Binding.candidatePartitionRoot,
          exactOutcomePartitionRoot: stage12Binding.exactOutcomePartitionRoot,
          verifiedMemoSetRoot: stage12Binding.verifiedMemoSetRoot,
          promotionRevision: stage12Binding.promotionRevision,
          candidatePartitionProofStorageHash: resolvedBindingFact.candidatePartitionProofStorageHash,
          nominationClosureRoot: resolvedBindingFact.nominationClosureRoot,
          nominationClosureStorageHash: resolvedBindingFact.nominationClosureStorageHash,
          instanceCatalogRoot: h(`instance-catalog:${terminalManifest.finalDurableWindowId}`),
          instanceCatalogStorageHash: h(`instance-catalog-storage:${label}`),
          graphStorageHash: h(`graph-storage:${label}`),
          graphRoot: sweep.binding.graphRoot,
          edgeCount: "1",
          orderedEdgeIds: Object.freeze([graphEdge.edgeId]),
          orderedEdges: Object.freeze([graphEdge]),
          expectedTransitionCount: "1",
          expectedTransitionRoot: sweep.expectedTransitionRoot,
          orderedTransitions: graphTransitions,
          familyEdgeCounts: Object.freeze([Object.freeze({ familyId: graphEdge.owningFamilyId, edgeCount: "1" })]),
          familyTransitionCounts: Object.freeze([Object.freeze({ familyId: graphEdge.owningFamilyId, transitionCount: "1" })]),
        }),
        generatedRuntimeMetadata: Object.freeze({
          releaseIntentRoot: h(`release-intent:${label}`),
          definitionCatalogRoot: sweep.binding.definitionCatalogRoot,
          descriptorRoot: h(`runtime-descriptor:${label}`),
          families: Object.freeze([Object.freeze({
            familyId: graphEdge.owningFamilyId,
            familyDefinitionHash: graphEdge.owningFamilyDefinitionHash,
            sourcePlanRoot: h(`source-plan-root:${label}`),
            sourcePlanRefs: Object.freeze([Object.freeze({
              ownerRef: h(`source-owner:${label}`),
              sourcePlanRef: h(`source-plan:${label}`),
              familyDefinitionHash: graphEdge.owningFamilyDefinitionHash,
              completeness: "point-lookup" as const,
              historyStartBlock: null,
            })]),
          })]),
        }),
      });
      if (label === "ledger-deleted") {
        const boundaryFile = (index: number, byteLength: string) => Object.freeze({
          name: `${(index + 1).toString(16).padStart(64, "0")}.v8`,
          contentSha256: h(`boundary-limit:${index}:${byteLength}`),
          byteLength,
          device: "1",
          inode: String(index + 1),
          fsynced: true as const,
        });
        const rejectsTrustFiles = (files: readonly ReturnType<typeof boundaryFile>[], pattern: RegExp) => {
          const capability = Object.freeze(Object.create(null)) as ProductionTerminalPhaseSnapshotTrustCapabilityV1;
          assert.throws(
            () => registerProductionTerminalPhaseSnapshotTrustCapabilityV1(capability, {
              ...trustInput,
              sixStepBoundaryFiles: files,
            }),
            pattern,
          );
        };
        rejectsTrustFiles(
          Object.freeze(Array.from({ length: 37 }, (_, index) => boundaryFile(index, "1"))),
          /physical denominator is incomplete/,
        );
        rejectsTrustFiles(
          Object.freeze([boundaryFile(0, String(64 * 1024 * 1024 + 1))]),
          /boundary file exceeds byte policy/,
        );
        rejectsTrustFiles(
          Object.freeze([
            ...Array.from({ length: 8 }, (_, index) => boundaryFile(index, String(64 * 1024 * 1024))),
            boundaryFile(8, "1"),
          ]),
          /boundary aggregate exceeds byte policy/,
        );
      }
      registerProductionTerminalPhaseSnapshotTrustCapabilityV1(trust, trustInput);
      return Object.freeze({
        label,
        caseSink,
        caseIndex,
        trust,
        ledgerPath,
        ledgerByteLength: physicalLedgerBytes.byteLength,
        boundaryEntries,
      });
    };
    const physicalSnapshots = [
      createPhysicalSnapshotCase("ledger-deleted"),
      createPhysicalSnapshotCase("ledger-truncated"),
      createPhysicalSnapshotCase("boundary-deleted"),
      createPhysicalSnapshotCase("boundary-changed"),
    ] as const;
    for (const snapshot of physicalSnapshots) {
      const control = await snapshot.caseIndex.readSnapshot(snapshot.trust);
      assert.equal(control.sixStepPhysicalStatus, "invalid", `${snapshot.label} generic ledger must fail production JSONL replay`);
      assert.match(control.sixStepPhysicalReason ?? "", /source locator|source-ledger/);
      assert.deepEqual(control.sixStepArtifactMaterials, []);
    }
    unlinkSync(physicalSnapshots[0].ledgerPath);
    truncateSync(physicalSnapshots[1].ledgerPath, physicalSnapshots[1].ledgerByteLength - 1);
    unlinkSync(physicalSnapshots[2].boundaryEntries[0]!.path);
    const changedBoundary = physicalSnapshots[3].boundaryEntries[0]!;
    const changedBoundaryBytes = Buffer.from(changedBoundary.bytes);
    changedBoundaryBytes[0] = changedBoundaryBytes[0]! ^ 0xff;
    writeFileSync(changedBoundary.path, changedBoundaryBytes);
    for (const snapshot of physicalSnapshots) {
      const advisoryDiscovery = await snapshot.caseIndex.readSnapshot(snapshot.trust);
      assert.equal(advisoryDiscovery.fullFamilyProjection.status, "missing", "physical Six-Step loss must retain Full-Family material");
      assert.equal(advisoryDiscovery.sixStepPhysicalStatus, "invalid");
      assert.ok(advisoryDiscovery.sixStepPhysicalReason);
      assert.deepEqual(advisoryDiscovery.sixStepEventFacts, []);
      assert.deepEqual(advisoryDiscovery.sixStepArtifactMaterials, []);
      const advisorySource = registerProductionPredicateMaterialSourceStateV1({
        sink: snapshot.caseSink,
        readArtifactLineageStageOne: null,
        readArtifactLineageStageTwoAuthority: null,
        readArtifactLineageStageTwoGit: null,
        readFullFamilyObservation: null,
        observePerformance: null,
        readDurableTerminalDiscovery: () => advisoryDiscovery,
        observeTerminalSelection: null,
        readRuntimeRestartBoundary: null,
        readSourceRepositoryClosureBoundary: null,
        readLegacyAuthorityClosureBoundary: null,
      });
      const advisory = readPredicateDomainMaterialCapabilityV1(
        await SIX_STEP_MATERIAL_PROVIDER.provide(advisorySource),
      );
      assert.equal(advisory.status, "invalid");
      assert.equal(advisory.code, "owner-material-invalid");
    }
    assert.equal(existsSync(physicalSnapshots[0].ledgerPath), false, "snapshot replay must not recreate a deleted ledger");
    assert.equal(
      statSync(physicalSnapshots[1].ledgerPath).size,
      physicalSnapshots[1].ledgerByteLength - 1,
      "snapshot replay must not refill a truncated ledger",
    );
    assert.equal(existsSync(physicalSnapshots[2].boundaryEntries[0]!.path), false, "snapshot replay must not recreate a deleted boundary");
    assert.deepEqual(
      readFileSync(changedBoundary.path),
      changedBoundaryBytes,
      "snapshot replay must not replace changed boundary bytes",
    );
    const childArgs = [
      "--experimental-strip-types",
      fileURLToPath(new URL("./terminal-phase-restart-reader.fixture.ts", import.meta.url)),
      storeDirectory,
      indexDirectory,
      terminalManifest.finalDurableWindowId,
      h("store"),
    ];
    const child = spawnSync(process.execPath, childArgs, { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr);
    const restarted = JSON.parse(child.stdout) as Readonly<Record<string, unknown>>;
    assert.equal(restarted.rawWindowRejected, true);

    const discovered = await locatorIndex.read(terminalManifest.finalDurableWindowId);
    const observerContentDirectoryStat = statSync(storeDirectory, { bigint: true });
    assert.equal(discovered.observerContentDirectory, realpathSync(storeDirectory));
    assert.equal(discovered.observerContentDirectoryDevice, observerContentDirectoryStat.dev.toString());
    assert.equal(discovered.observerContentDirectoryInode, observerContentDirectoryStat.ino.toString());
    assert.equal(discovered.observerStoreIdentityHash, h("store"));
    assert.equal(discovered.selectedProcessArtifact?.ref.artifactRefId, processArtifact.ref.artifactRefId);
    assert.equal(discovered.selectedProcessArtifact?.contentSha256, processArtifact.contentSha256);
    assert.equal(discovered.fullFamilyProjectionArtifact.ref.artifactRefId, fullFamilyProjectionArtifact.ref.artifactRefId);
    assert.equal(discovered.fullFamilyBundleArtifact, null);
    assert.equal(discovered.fullFamilyLocatorArtifact, null);
    assert.equal(discovered.sixStepTerminalBindingArtifact?.ref.artifactRefId, terminalBindingArtifact.ref.artifactRefId);
    assert.equal(discovered.sixStepEventFacts.length, stageArtifacts.length);
    assert.equal(discovered.sixStepPredicateArtifacts.length, sixStepPredicateArtifacts.length);
    const materialSource = registerProductionPredicateMaterialSourceStateV1({
      sink: ownedSink,
      readArtifactLineageStageOne: null,
      readArtifactLineageStageTwoAuthority: null,
      readArtifactLineageStageTwoGit: null,
      readFullFamilyObservation: null,
      observePerformance: null,
      readDurableTerminalDiscovery: () => discovered,
      observeTerminalSelection: null,
      readRuntimeRestartBoundary: null,
      readSourceRepositoryClosureBoundary: null,
      readLegacyAuthorityClosureBoundary: null,
    });
    const sixStepMaterial = readPredicateDomainMaterialCapabilityV1(
      await SIX_STEP_MATERIAL_PROVIDER.provide(materialSource),
    );
    assert.equal(sixStepMaterial.status, "available");
    if (sixStepMaterial.status === "available") {
      assert.deepEqual(sixStepMaterial.predicateFacts.slice(0, -1), discovered.sixStepEventFacts);
      const bindingObservation = sixStepMaterial.predicateFacts.at(-1) as Readonly<Record<string, unknown>>;
      assert.deepEqual(bindingObservation, {
        ...economicEvaluatorBindingObservation,
      });
    }
    rmSync(join(storeDirectory, processArtifact.contentSha256.slice(2)));
    await assert.rejects(locatorIndex.read(terminalManifest.finalDurableWindowId));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
