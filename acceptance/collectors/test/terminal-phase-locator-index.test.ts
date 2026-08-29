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
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { nativeAssetReferenceV1 } from "../../../packages/asset-ref/src/index.ts";
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
  assertProductionTerminalPhaseDurableDiscoveryV1,
  ProductionTerminalPhaseLocatorIndexV1,
  decodeProductionTerminalPhaseManifestV1,
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

const h = (value: string): Hash => hashDomain("test/terminal-phase-locator-index/v1", value);

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
  const graphRoot = hashDomain("aloha/persisted-graph/v1", {
    cutoff: readyCutoff,
    instanceCatalogRoot,
    edges: [edge],
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
    terminalKind: "unsigned-dry-run" as const,
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
  const sixStep = Object.freeze({
    status: "missing" as const,
    observationRoot: h("six-step-observation"),
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

function physicalSixStepLedgerBytes(
  artifacts: readonly Pick<ObservedContentArtifactV1, "bytes" | "ref">[],
): Uint8Array {
  const ranged = artifacts.flatMap(artifact => artifact.ref.locator.kind === "file-range"
    ? [Object.freeze({ artifact, locator: artifact.ref.locator })]
    : []);
  const byteLength = ranged.reduce((maximum, { locator }) => {
    const end = BigInt(locator.endExclusive);
    if (end > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError("test Six-Step ledger range is too large");
    return Math.max(maximum, Number(end));
  }, 0);
  const bytes = Buffer.alloc(byteLength);
  const occupied = new Uint8Array(byteLength);
  for (const { artifact, locator } of ranged) {
    const start = Number(BigInt(locator.startInclusive));
    const end = Number(BigInt(locator.endExclusive));
    assert.equal(end - start, artifact.bytes.byteLength, "physical ledger range length must match its artifact");
    for (let offset = 0; offset < artifact.bytes.byteLength; offset += 1) {
      const position = start + offset;
      if (occupied[position] === 1) {
        assert.equal(bytes[position], artifact.bytes[offset], "physical ledger ranges must not conflict");
      } else {
        bytes[position] = artifact.bytes[offset]!;
        occupied[position] = 1;
      }
    }
  }
  return new Uint8Array(bytes);
}

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
    await locatorIndex.publish({ manifest: terminalManifest, manifestArtifact, locator, locatorArtifact, selectedProcessArtifact: null, ...childArtifacts });

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
    const currentSource = Object.freeze({
      chainId: "1",
      number: "100",
      hash: h("selected-head"),
      stateRoot: h("selected-state-root"),
    });
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
      runtimeBindingId: h("runtime-binding"),
      candidateReleaseCommit: "a".repeat(40),
      releaseProvenanceHash: h("release-provenance"),
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
    const terminalPayload = Object.freeze({
      schemaVersion: 1 as const,
      kind: "aloha.runtime-release-six-step-terminal-binding-v1" as const,
      runtimeBindingId: h("runtime-binding"),
      candidateReleaseCommit: "a".repeat(40),
      releaseProvenanceHash: h("release-provenance"),
      economicEvaluatorAuthorityRoot: h("economic-evaluator-authority"),
      economicEvaluatorImplementationHash: h("economic-evaluator-implementation"),
      economicEvaluatorBindingObservation,
      definitionCatalogRoot: h("definition-catalog"),
      strategyCompositionRoot: h("strategy-composition"),
      searchTerminalHash: h("search-terminal"),
      terminalLineageHash: h("terminal-lineage"),
      traceRoot: h("trace"),
      correlationId: h("correlation"),
      generationId: "generation-1",
      readyRecordHash: h("ready-record"),
      graphRoot: h("graph"),
      currentSource,
      planningProblemHash: h("planning-problem"),
      routeCandidateId: h("route-candidate"),
      programHash: h("program"),
      finalSimulationReceiptHash: h("final-simulation"),
      trace: Object.freeze({ traceRoot: h("trace") }),
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
      bindingId: terminalBinding.runtimeBindingId,
      releaseProvenanceHash: terminalBinding.releaseProvenanceHash,
      candidateReleaseCommit: terminalBinding.candidateReleaseCommit,
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
    const stage12Facts = Object.freeze({ kind: "test-stage12" });
    const stage12Root = hashDomain("aloha/searcher-production-evidence-stage12/v1", stage12Facts);
    const runtimeFacts = Object.freeze({ kind: "test-runtime-facts" });
    const producerSchedulerJoin = Object.freeze({
      correlationId: terminalBinding.correlationId,
      generationId: terminalBinding.generationId,
      source: currentSource,
      programHash: terminalBinding.programHash,
      finalSimulationReceiptHash: terminalBinding.finalSimulationReceiptHash,
      unsignedDryRunCandidateId: h("unsigned-dry-run-candidate"),
      unsignedDryRunLineageHash: h("unsigned-dry-run-lineage"),
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
      sixStepLineageRoot: hashDomain("aloha/searcher-production-evidence-six-step-lineage/v1", {
        stage12Root,
        stage36Root: terminalBinding.traceRoot,
      }),
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
    const finalDurableWindowId = h("observed-final-window");
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
    });
    const pipeline = Object.freeze({
      lease: Object.freeze({ binding: Object.freeze({
        generationId: terminalBinding.generationId,
        readyRecordHash: terminalBinding.readyRecordHash,
        generationRefreshPolicyHash: h("refresh-policy"),
        cutoff: Object.freeze({ chainId: "1", number: "99", hash: h("cutoff"), stateRoot: h("cutoff-state") }),
        definitionCatalogRoot: terminalBinding.definitionCatalogRoot,
        instanceCatalogRoot: h("instances"),
        graphRoot: terminalBinding.graphRoot,
      }) }),
      currentSource: Object.freeze({ sessionId: h("source-session"), source: currentSource }),
      correlationId: terminalBinding.correlationId,
      routeCandidateId: terminalBinding.routeCandidateId,
      orderedEdgeIds: Object.freeze([h("edge")]),
      callerId: "terminal-locator-test",
    });
    const route = Object.freeze({
      routeHash: h("route"),
      routeBindingHash: h("route-binding"),
      legs: Object.freeze([Object.freeze({ edgeId: h("edge"), ownerRef: h("owner") })]),
    });
    const timing = Object.freeze({ startedMonotonicNs: "1000", finishedMonotonicNs: "2000" });
    const stage3 = await tail.emitPlanner({ pipeline, route, coarse: {}, planned: {}, timing } as never);
    const stage4 = await tail.emitExact({ parent: stage3, pipeline, route, exact: {}, timing } as never);
    const program = Object.freeze({
      kind: "execution-program",
      generationId: terminalBinding.generationId,
      source: currentSource,
      routeHash: route.routeHash,
      programBytes: "0xfixture",
      payloadHash: h("program-payload"),
      issuerRef: h("program-issuer"),
      obligationRoot: h("obligation-root"),
      programHash: terminalBinding.programHash,
    });
    const executionOwnerFacts = Object.freeze({
      callerMode: "delegate-call",
      preCalls: Object.freeze([]),
      observationPairs: Object.freeze([]),
      actionOwners: Object.freeze([]),
      obligationRoot: program.obligationRoot,
      declaredObligations: Object.freeze([]),
    });
    const executionOwnerEvidence = Object.freeze({
      schemaVersion: 1,
      kind: "aloha.execution-program-six-step-evidence-v1",
      correlationId: pipeline.correlationId,
      generationId: terminalBinding.generationId,
      source: currentSource,
      routeHash: route.routeHash,
      exactHash: h("exact"),
      programHash: program.programHash,
      facts: executionOwnerFacts,
      evidenceRoot: h("execution-owner-evidence"),
    });
    const simulation = Object.freeze({
      kind: "final-simulation-passed",
      generationId: terminalBinding.generationId,
      source: currentSource,
      programHash: program.programHash,
      simulation: Object.freeze({ kind: "fixture-simulation" }),
      effectsHash: h("effects"),
      receiptHash: terminalBinding.finalSimulationReceiptHash,
    });
    const finalOwnerEvidence = Object.freeze({
      schemaVersion: 1,
      kind: "aloha.final-simulation-six-step-evidence-v1",
      correlationId: pipeline.correlationId,
      generationId: terminalBinding.generationId,
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
    const stage5 = await tail.emitExecutionProgram({ parent: stage4, pipeline, route, program, ownerEvidence: executionOwnerEvidence, timing } as never);
    const stage6 = await tail.emitFinalSimulation({ parent: stage5, pipeline, route, program, simulation, ownerEvidence: finalOwnerEvidence, economicSafety, timing } as never);
    const stage12 = tail.readStage12Parents(stage3);
    const stage1Artifacts = stage12.stage1.map(readProductionSixStepArtifactMaterialV1)
      .sort((left, right) => left.eventArtifact.ref.artifactRefId.localeCompare(right.eventArtifact.ref.artifactRefId));
    const stage2Artifacts = stage12.stage2.map(readProductionSixStepArtifactMaterialV1)
      .sort((left, right) => left.eventArtifact.ref.artifactRefId.localeCompare(right.eventArtifact.ref.artifactRefId));
    const stageArtifacts = Object.freeze([
      ...stage1Artifacts,
      ...stage2Artifacts,
      readProductionSixStepArtifactMaterialV1(stage3),
      readProductionSixStepArtifactMaterialV1(stage4),
      readProductionSixStepArtifactMaterialV1(stage5),
      readProductionSixStepArtifactMaterialV1(stage6),
    ]);
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
    await locatorIndex.publish({
      ...publishInput,
      sixStepPredicateArtifacts,
    });
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
    const physicalLedgerBytes = physicalSixStepLedgerBytes(sixStepPredicateArtifacts);
    const sweep = fullGraphSweepFixture(terminalManifest.finalDurableWindowId);
    const graphEdge = sweep.entries[0]!.edge;
    const graphTransitions = derivePlannerCompatibleReadyGraphTransitionsV1([graphEdge]);
    const indexFileName = `${terminalManifest.finalDurableWindowId.slice(2)}.json`;
    const publishedIndexBytes = new Uint8Array(readFileSync(join(indexDirectory, indexFileName)));
    const publishedIndex = decodeCanonicalBytes(publishedIndexBytes) as Readonly<Record<string, unknown>>;
    const publishedIndexRoot = publishedIndex.indexRoot as Hash;
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
      registerProductionTerminalPhaseSnapshotTrustCapabilityV1(trust, {
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
          cutoff: sweep.binding.readyCutoff,
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
      assert.equal(control.sixStepPhysicalStatus, "observed", `${snapshot.label} control snapshot must replay`);
      assert.equal(control.sixStepArtifactMaterials.length, stageArtifacts.length);
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
