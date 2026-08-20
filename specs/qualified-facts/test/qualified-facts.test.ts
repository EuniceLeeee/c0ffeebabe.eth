import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductionReceipt,
  createReadOnlyArtifactRef,
  createSemanticArtifact,
  hashProcessAnchor,
  type Hash,
} from "../../core-envelope/src/index.ts";
import {
  createArtifactResolutionResult,
  recomputeArtifactResolutionResultId,
  type ArtifactResolutionResultV1,
} from "../../artifact-resolution/src/index.ts";
import { computeObserverSemanticConfigDigest } from "../src/index.ts";
import {
  QUALIFIED_FACT_SCHEMA_MANIFESTS,
  createAcceptanceQuery,
  createQualifiedFactSnapshot,
  createQualifiedObservation,
  decodeAcceptanceQuery,
  decodeQualifiedFactSnapshot,
  decodeQualifiedObservation,
  encodeAcceptanceQuery,
  encodeQualifiedFactSnapshot,
  encodeQualifiedObservation,
  validateAcceptanceQueryAgainstSnapshot,
  validateQualifiedObservation,
  type AcceptanceQueryV1,
  type QualifiedFactSnapshotV1,
  type QualifiedObservationEnvelopeV1,
} from "../src/index.ts";
import { hashDomain, sha256Hex } from "../../../packages/canonical-codec/src/index.ts";

const h = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;
const storeHash = h("1");
const schema = { id: "fact.schema", version: "1.0.0", schemaHash: h("2") } as const;
const bytes = new TextEncoder().encode("raw");

function observationDraft(value: QualifiedObservationEnvelopeV1) {
  const { observationId: _observationId, payloadHash: _payloadHash, canonicalFactsHash: _canonicalFactsHash, ...draft } = value;
  return draft;
}

function snapshotDraft(value: QualifiedFactSnapshotV1) {
  const {
    snapshotId: _snapshotId,
    payloadHash: _payloadHash,
    claimSetRoot: _claimSetRoot,
    observationSetRoot: _observationSetRoot,
    rawArtifactSetRoot: _rawArtifactSetRoot,
    ...draft
  } = value;
  return draft;
}

function queryDraft(value: AcceptanceQueryV1) {
  const { queryId: _queryId, payloadHash: _payloadHash, ...draft } = value;
  return draft;
}

function artifactRef(digit: string, offset: number) {
  const contentSha256 = sha256Hex(bytes);
  return createReadOnlyArtifactRef({
    locator: {
      kind: "file-range",
      systemId: "observer-system",
      bootIdHash: h("3"),
      device: "1",
      inode: String(offset + 10),
      startInclusive: String(offset),
      endExclusive: String(offset + bytes.byteLength),
    },
    immutableMirrorLocator: { kind: "content-object", storeIdentityHash: storeHash, objectKey: contentSha256 },
    contentSha256,
    byteLength: String(bytes.byteLength),
    mediaType: "application/octet-stream",
    schema: null,
    resolverPolicyHash: h("4"),
    retentionLeaseReceiptId: h("5"),
  });
}

function fixture() {
  const logRef = artifactRef("6", 0);
  const boundaryRef = artifactRef("7", 3);
  const producer = {
    systemId: "observer-system",
    commitSha: "1".repeat(40),
    executableHash: h("8"),
    deploymentManifestHash: h("9"),
    serviceIdentityHash: h("a"),
    pid: "10",
    processStartTicks: "11",
    bootIdHash: h("3"),
  } as const;
  const rawArtifactRefs = [logRef, boundaryRef].sort((left, right) => left.artifactRefId.localeCompare(right.artifactRefId));
  const canonicalFacts = { amount: "1", token: "0xabc" };
  const canonicalFactsHash = hashDomain("aloha/qualified-observation/canonical-facts/v1", canonicalFacts);
  const observerFields = {
    observerImplementationDigest: h("f"),
    observerQualificationId: h("1"),
    qualificationRegistryRoot: h("2"),
    anchorPolicyDigest: h("3"),
    observationSchema: schema,
  } as const;
  const acquisitionArtifact = createSemanticArtifact({
    schema,
    inputArtifactIds: rawArtifactRefs.map((ref) => ref.artifactRefId),
    dependencyClosureRoot: h("a"),
    canonicalPayloadHash: canonicalFactsHash,
  });
  const receipt = createProductionReceipt({
    artifactId: acquisitionArtifact.artifactId,
    producer,
    logRangeArtifactRef: logRef,
    sourceAnchorHash: h("c"),
    startedMonotonicNs: "10",
    finishedMonotonicNs: "20",
    durationUs: "10",
    rawBoundaryArtifactRef: boundaryRef,
    semanticConfigDigest: computeObserverSemanticConfigDigest(observerFields),
    resourceMetricsHash: h("e"),
  });
  const observation = createQualifiedObservation({
    schemaVersion: 1,
    kind: "aloha.qualified-observation",
    ...observerFields,
    observedClaimIds: [h("4")],
    rawArtifactRefs,
    acquisitionProductionReceiptId: receipt.receiptId,
    canonicalFacts,
  });
  const resolutions: ArtifactResolutionResultV1[] = rawArtifactRefs.map((ref) => createArtifactResolutionResult({
    artifactRefId: ref.artifactRefId,
    resolverPolicyHash: ref.resolverPolicyHash,
    resolverImplementationDigest: h("5"),
    resolverQualificationId: h("6"),
    qualificationRegistryRoot: h("2"),
    resolvedAtStoreEpoch: "7",
    bytes: "0x726177",
    observedContentSha256: ref.contentSha256,
    observedByteLength: ref.byteLength,
    outcome: "resolved",
  }));
  return {
    producer,
    receipt,
    rawArtifactRefs,
    observation,
    resolutions,
    acquisitionArtifact,
    currentQualification: {
      observerQualificationId: h("1"),
      observerImplementationDigest: h("f"),
      qualificationRegistryRoot: h("2"),
      anchorPolicyDigest: h("3"),
      observedSchemaIds: [schema],
      qualifiedLocatorKinds: ["file-range"] as const,
      current: true,
    },
  };
}

test("executable qualified-fact schema hashes are stable-format golden values", () => {
  assert.equal(QUALIFIED_FACT_SCHEMA_MANIFESTS.observation.schemaHash, "0x1baaa76af41fb5522e82a5d6350fc9f1502c229bbad030d88e9babd860628b6b");
  assert.equal(QUALIFIED_FACT_SCHEMA_MANIFESTS.snapshot.schemaHash, "0x0306cf6254518303f582cd15c60f8157a3a117a1ee926f0003fb2203f78891d2");
  assert.equal(QUALIFIED_FACT_SCHEMA_MANIFESTS.acceptanceQuery.schemaHash, "0xf49824465db79bc5aadd1fb290d9074bf7a8c11a1b86e8aadb3e3e2f04fbbfa6");
});

test("observation requires current qualification, receipt and every resolved raw ref", () => {
  const fixtureValue = fixture();
  assert.equal(
    validateQualifiedObservation(fixtureValue.observation, {
      currentQualification: fixtureValue.currentQualification,
      productionReceipt: fixtureValue.receipt,
      acquisitionArtifact: fixtureValue.acquisitionArtifact,
      resolutions: fixtureValue.resolutions,
      currentResolverQualification: { resolverPolicyHash: fixtureValue.rawArtifactRefs[0].resolverPolicyHash, resolverImplementationDigest: h("5"), resolverQualificationId: h("6"), qualificationRegistryRoot: h("2"), current: true },
      expectedProcessAnchorHash: hashProcessAnchor(fixtureValue.producer),
    }).observationId,
    fixtureValue.observation.observationId,
  );
  assert.throws(() => validateQualifiedObservation(fixtureValue.observation, {
    currentQualification: fixtureValue.currentQualification,
    productionReceipt: fixtureValue.receipt,
    acquisitionArtifact: fixtureValue.acquisitionArtifact,
    resolutions: fixtureValue.resolutions,
    currentResolverQualification: { resolverPolicyHash: h("0"), resolverImplementationDigest: h("5"), resolverQualificationId: h("6"), qualificationRegistryRoot: h("2"), current: true },
    expectedProcessAnchorHash: hashProcessAnchor(fixtureValue.producer),
  }));
  assert.throws(() => validateQualifiedObservation(fixtureValue.observation, {
    currentQualification: fixtureValue.currentQualification,
    productionReceipt: fixtureValue.receipt,
    acquisitionArtifact: fixtureValue.acquisitionArtifact,
    resolutions: fixtureValue.resolutions,
    currentResolverQualification: { resolverPolicyHash: fixtureValue.rawArtifactRefs[0].resolverPolicyHash, resolverImplementationDigest: h("0"), resolverQualificationId: h("6"), qualificationRegistryRoot: h("2"), current: true },
    expectedProcessAnchorHash: hashProcessAnchor(fixtureValue.producer),
  }));
  assert.throws(() => validateQualifiedObservation(fixtureValue.observation, {
    currentQualification: null,
    productionReceipt: fixtureValue.receipt,
    acquisitionArtifact: fixtureValue.acquisitionArtifact,
    resolutions: fixtureValue.resolutions,
    currentResolverQualification: { resolverPolicyHash: fixtureValue.rawArtifactRefs[0].resolverPolicyHash, resolverImplementationDigest: h("5"), resolverQualificationId: h("6"), qualificationRegistryRoot: h("2"), current: true },
    expectedProcessAnchorHash: hashProcessAnchor(fixtureValue.producer),
  }));
  assert.throws(() => validateQualifiedObservation(fixtureValue.observation, {
    currentQualification: { ...fixtureValue.currentQualification, observedSchemaIds: [] },
    productionReceipt: fixtureValue.receipt,
    acquisitionArtifact: fixtureValue.acquisitionArtifact,
    resolutions: fixtureValue.resolutions,
    currentResolverQualification: { resolverPolicyHash: fixtureValue.rawArtifactRefs[0].resolverPolicyHash, resolverImplementationDigest: h("5"), resolverQualificationId: h("6"), qualificationRegistryRoot: h("2"), current: true },
    expectedProcessAnchorHash: hashProcessAnchor(fixtureValue.producer),
  }));
  assert.throws(() => validateQualifiedObservation(fixtureValue.observation, {
    currentQualification: { ...fixtureValue.currentQualification, qualifiedLocatorKinds: [] },
    productionReceipt: fixtureValue.receipt,
    acquisitionArtifact: fixtureValue.acquisitionArtifact,
    resolutions: fixtureValue.resolutions,
    currentResolverQualification: { resolverPolicyHash: fixtureValue.rawArtifactRefs[0].resolverPolicyHash, resolverImplementationDigest: h("5"), resolverQualificationId: h("6"), qualificationRegistryRoot: h("2"), current: true },
    expectedProcessAnchorHash: hashProcessAnchor(fixtureValue.producer),
  }));
  assert.throws(() => validateQualifiedObservation(fixtureValue.observation, {
    currentQualification: fixtureValue.currentQualification,
    productionReceipt: fixtureValue.receipt,
    acquisitionArtifact: fixtureValue.acquisitionArtifact,
    resolutions: fixtureValue.resolutions.slice(0, 1),
    currentResolverQualification: { resolverPolicyHash: fixtureValue.rawArtifactRefs[0].resolverPolicyHash, resolverImplementationDigest: h("5"), resolverQualificationId: h("6"), qualificationRegistryRoot: h("2"), current: true },
    expectedProcessAnchorHash: hashProcessAnchor(fixtureValue.producer),
  }));
  assert.throws(() => validateQualifiedObservation(fixtureValue.observation, {
    currentQualification: fixtureValue.currentQualification,
    productionReceipt: fixtureValue.receipt,
    acquisitionArtifact: fixtureValue.acquisitionArtifact,
    resolutions: fixtureValue.resolutions.map((entry) => ({ ...entry, outcome: "missing" as const })),
    currentResolverQualification: { resolverPolicyHash: fixtureValue.rawArtifactRefs[0].resolverPolicyHash, resolverImplementationDigest: h("5"), resolverQualificationId: h("6"), qualificationRegistryRoot: h("2"), current: true },
    expectedProcessAnchorHash: hashProcessAnchor(fixtureValue.producer),
  }));
});

test("receipt refs and process anchor cannot be spliced into a qualified observation", () => {
  const fixtureValue = fixture();
  const unrelated = artifactRef("8", 6);
  const spliced = createQualifiedObservation({
    ...observationDraft(fixtureValue.observation),
    rawArtifactRefs: [fixtureValue.rawArtifactRefs[0], unrelated].sort((a, b) => a.artifactRefId.localeCompare(b.artifactRefId)),
  });
  assert.throws(() => validateQualifiedObservation(spliced, {
    currentQualification: fixtureValue.currentQualification,
    productionReceipt: fixtureValue.receipt,
    acquisitionArtifact: fixtureValue.acquisitionArtifact,
    resolutions: fixtureValue.resolutions,
    currentResolverQualification: { resolverPolicyHash: fixtureValue.rawArtifactRefs[0].resolverPolicyHash, resolverImplementationDigest: h("5"), resolverQualificationId: h("6"), qualificationRegistryRoot: h("2"), current: true },
    expectedProcessAnchorHash: hashProcessAnchor(fixtureValue.producer),
  }));
  assert.throws(() => decodeQualifiedObservation({
    ...fixtureValue.observation,
    rawArtifactRefs: [...fixtureValue.rawArtifactRefs].reverse(),
  } as unknown as QualifiedObservationEnvelopeV1));
  assert.throws(() => validateQualifiedObservation(fixtureValue.observation, {
    currentQualification: fixtureValue.currentQualification,
    productionReceipt: fixtureValue.receipt,
    acquisitionArtifact: fixtureValue.acquisitionArtifact,
    resolutions: fixtureValue.resolutions,
    currentResolverQualification: { resolverPolicyHash: fixtureValue.rawArtifactRefs[0].resolverPolicyHash, resolverImplementationDigest: h("5"), resolverQualificationId: h("6"), qualificationRegistryRoot: h("2"), current: true },
    expectedProcessAnchorHash: h("0"),
  }));
});

test("observation validation decodes every resolution instead of trusting typed fields", () => {
  const fixtureValue = fixture();
  const tampered = {
    ...fixtureValue.resolutions[0],
    bytes: "0x00",
    resultId: h("0"),
  };
  assert.throws(() => validateQualifiedObservation(fixtureValue.observation, {
    currentQualification: fixtureValue.currentQualification,
    productionReceipt: fixtureValue.receipt,
    acquisitionArtifact: fixtureValue.acquisitionArtifact,
    resolutions: [
      { ...tampered, resultId: recomputeArtifactResolutionResultId(tampered) },
      fixtureValue.resolutions[1],
    ],
    currentResolverQualification: { resolverPolicyHash: fixtureValue.rawArtifactRefs[0].resolverPolicyHash, resolverImplementationDigest: h("5"), resolverQualificationId: h("6"), qualificationRegistryRoot: h("2"), current: true },
    expectedProcessAnchorHash: hashProcessAnchor(fixtureValue.producer),
  }));
});

test("acquisition receipt cannot be reused with a different semantic artifact closure", () => {
  const fixtureValue = fixture();
  const wrongArtifact = createSemanticArtifact({
    schema: fixtureValue.acquisitionArtifact.schema,
    dependencyClosureRoot: fixtureValue.acquisitionArtifact.dependencyClosureRoot,
    canonicalPayloadHash: fixtureValue.acquisitionArtifact.canonicalPayloadHash,
    inputArtifactIds: [h("0")],
  });
  const wrongReceipt = createProductionReceipt({
    producer: fixtureValue.receipt.producer,
    logRangeArtifactRef: fixtureValue.receipt.logRangeArtifactRef,
    sourceAnchorHash: fixtureValue.receipt.sourceAnchorHash,
    startedMonotonicNs: fixtureValue.receipt.startedMonotonicNs,
    finishedMonotonicNs: fixtureValue.receipt.finishedMonotonicNs,
    durationUs: fixtureValue.receipt.durationUs,
    rawBoundaryArtifactRef: fixtureValue.receipt.rawBoundaryArtifactRef,
    semanticConfigDigest: fixtureValue.receipt.semanticConfigDigest,
    resourceMetricsHash: fixtureValue.receipt.resourceMetricsHash,
    artifactId: wrongArtifact.artifactId,
  });
  const wrongObservation = createQualifiedObservation({
    ...observationDraft(fixtureValue.observation),
    acquisitionProductionReceiptId: wrongReceipt.receiptId,
  });
  assert.throws(() => validateQualifiedObservation(wrongObservation, {
    currentQualification: fixtureValue.currentQualification,
    productionReceipt: wrongReceipt,
    acquisitionArtifact: wrongArtifact,
    resolutions: fixtureValue.resolutions,
    currentResolverQualification: { resolverPolicyHash: fixtureValue.rawArtifactRefs[0].resolverPolicyHash, resolverImplementationDigest: h("5"), resolverQualificationId: h("6"), qualificationRegistryRoot: h("2"), current: true },
    expectedProcessAnchorHash: hashProcessAnchor(fixtureValue.producer),
  }));
});

test("snapshot roots recompute from ordered IDs and query binds registry, subject, snapshot and anchor", () => {
  const fixtureValue = fixture();
  const snapshot = createQualifiedFactSnapshot({
    schemaVersion: 1,
    kind: "aloha.qualified-fact-snapshot",
    qualificationRegistryRoot: fixtureValue.observation.qualificationRegistryRoot,
    orderedClaimIds: fixtureValue.observation.observedClaimIds,
    orderedObservationIds: [fixtureValue.observation.observationId],
    orderedRawArtifactRefIds: fixtureValue.rawArtifactRefs.map((ref) => ref.artifactRefId),
  });
  const query = createAcceptanceQuery({
    schemaVersion: 1,
    kind: "aloha.acceptance-query",
    predicateSpecDigest: h("a"),
    qualificationRegistryRoot: snapshot.qualificationRegistryRoot,
    subjectArtifactRoot: h("b"),
    qualifiedFactSnapshotId: snapshot.snapshotId,
    processAnchorHash: hashProcessAnchor(fixtureValue.producer),
    correlationId: null,
  });
  assert.equal(validateAcceptanceQueryAgainstSnapshot(query, snapshot, fixtureValue.producer).queryId, query.queryId);
  const wrongRegistry = createAcceptanceQuery({ ...queryDraft(query), qualificationRegistryRoot: h("c") });
  assert.throws(() => validateAcceptanceQueryAgainstSnapshot(wrongRegistry, snapshot, fixtureValue.producer));
  assert.throws(() => createAcceptanceQuery({ ...queryDraft(query), correlationId: "" }));
  assert.throws(() => createQualifiedFactSnapshot({
    ...snapshotDraft(snapshot),
    orderedClaimIds: [...snapshot.orderedClaimIds, snapshot.orderedClaimIds[0]],
  }));
});

test("synthetic objects never contain verdict authority", () => {
  const { observation } = fixture();
  assert.equal(Object.prototype.hasOwnProperty.call(observation, "verdict"), false);
});

test("create functions reject accessors and unknown fields before reading draft values", () => {
  const fixtureValue = fixture();
  let observationGetterReads = 0;
  const observationDraftValue = { ...observationDraft(fixtureValue.observation) } as Record<string, unknown>;
  Object.defineProperty(observationDraftValue, "canonicalFacts", {
    enumerable: true,
    get() {
      observationGetterReads += 1;
      return fixtureValue.observation.canonicalFacts;
    },
  });
  assert.throws(() => createQualifiedObservation(observationDraftValue as never), /data property/);
  assert.equal(observationGetterReads, 0);

  const snapshot = createQualifiedFactSnapshot({
    schemaVersion: 1,
    kind: "aloha.qualified-fact-snapshot",
    qualificationRegistryRoot: fixtureValue.observation.qualificationRegistryRoot,
    orderedClaimIds: fixtureValue.observation.observedClaimIds,
    orderedObservationIds: [fixtureValue.observation.observationId],
    orderedRawArtifactRefIds: fixtureValue.rawArtifactRefs.map((ref) => ref.artifactRefId),
  });
  assert.throws(() => createQualifiedFactSnapshot({ ...snapshotDraft(snapshot), unexpected: true } as never), /unknown draft field/);

  const query = createAcceptanceQuery({
    schemaVersion: 1,
    kind: "aloha.acceptance-query",
    predicateSpecDigest: h("a"),
    qualificationRegistryRoot: snapshot.qualificationRegistryRoot,
    subjectArtifactRoot: h("b"),
    qualifiedFactSnapshotId: snapshot.snapshotId,
    processAnchorHash: hashProcessAnchor(fixtureValue.producer),
    correlationId: null,
  });
  let queryGetterReads = 0;
  const queryDraftValue = { ...queryDraft(query) } as Record<string, unknown>;
  Object.defineProperty(queryDraftValue, "predicateSpecDigest", {
    enumerable: true,
    get() {
      queryGetterReads += 1;
      return h("a");
    },
  });
  assert.throws(() => createAcceptanceQuery(queryDraftValue as never), /data property/);
  assert.equal(queryGetterReads, 0);
  assert.throws(() => createAcceptanceQuery({ ...queryDraft(query), unexpected: true } as never), /unknown draft field/);
  assert.throws(() => createQualifiedObservation(fixtureValue.observation as never), /unknown draft field/);
  assert.throws(() => createQualifiedFactSnapshot(snapshot as never), /unknown draft field/);
  assert.throws(() => createAcceptanceQuery(query as never), /unknown draft field/);
});

test("qualified-fact objects round-trip through canonical bytes exactly", () => {
  const fixtureValue = fixture();
  const observation = fixtureValue.observation;
  const snapshot = createQualifiedFactSnapshot({
    schemaVersion: 1,
    kind: "aloha.qualified-fact-snapshot",
    qualificationRegistryRoot: observation.qualificationRegistryRoot,
    orderedClaimIds: observation.observedClaimIds,
    orderedObservationIds: [observation.observationId],
    orderedRawArtifactRefIds: fixtureValue.rawArtifactRefs.map((ref) => ref.artifactRefId),
  });
  const query = createAcceptanceQuery({
    schemaVersion: 1,
    kind: "aloha.acceptance-query",
    predicateSpecDigest: h("a"),
    qualificationRegistryRoot: snapshot.qualificationRegistryRoot,
    subjectArtifactRoot: h("b"),
    qualifiedFactSnapshotId: snapshot.snapshotId,
    processAnchorHash: hashProcessAnchor(fixtureValue.producer),
    correlationId: "correlation-1",
  });
  assert.deepEqual(decodeQualifiedObservation(encodeQualifiedObservation(observation)), observation);
  assert.deepEqual(decodeQualifiedFactSnapshot(encodeQualifiedFactSnapshot(snapshot)), snapshot);
  assert.deepEqual(decodeAcceptanceQuery(encodeAcceptanceQuery(query)), query);
});
