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
  createArtifactResolutionClaim,
  createObservedImmutableMirror,
  encodeArtifactBytes,
  recomputeArtifactResolutionClaimId,
  type ArtifactResolutionClaimV1,
} from "../../artifact-resolution/src/index.ts";
import { computeObserverSemanticConfigDigest } from "../src/index.ts";
import {
  QUALIFIED_FACT_SCHEMA_MANIFESTS,
  createAcquisitionProcessObservation,
  createAcceptanceQuery,
  createQualifiedFactSnapshot,
  createQualifiedObservation,
  createStoreEpochObservation,
  createTargetProcessObservation,
  createSignedObserverInvocationSnapshot,
  createUnsignedSignedObserverInvocationSnapshot,
  decodeAcquisitionProcessObservation,
  encodeAcquisitionProcessObservation,
  decodeAcceptanceQuery,
  decodeQualifiedFactSnapshot,
  decodeQualifiedObservation,
  decodeStoreEpochObservation,
  decodeTargetProcessObservation,
  decodeSignedObserverInvocationSnapshot,
  encodeStoreEpochObservation,
  encodeTargetProcessObservation,
  encodeAcceptanceQuery,
  encodeQualifiedFactSnapshot,
  encodeQualifiedObservation,
  encodeSignedObserverInvocationSnapshot,
  observerInvocationSigningBytes,
  recomputeSignedObserverInvocationSnapshotId,
  recomputeSignedObserverInvocationSnapshotPayloadHash,
  sealSignedObserverInvocationSnapshot,
  validateAcceptanceQueryAgainstSnapshot,
  validateQualifiedObservationLineage,
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
  const artifactClaims: ArtifactResolutionClaimV1[] = rawArtifactRefs.map((ref) =>
    createArtifactResolutionClaim({
      artifactRefId: ref.artifactRefId,
      resolverPolicyHash: ref.resolverPolicyHash,
      observedMirror: createObservedImmutableMirror({
        storeIdentityHash: ref.immutableMirrorLocator.storeIdentityHash,
        objectKey: ref.immutableMirrorLocator.objectKey,
        bytes: encodeArtifactBytes(new Uint8Array([0x72, 0x61, 0x77])),
        mediaType: ref.mediaType,
        schema: ref.schema,
      }),
      outcome: "content-observed",
    })
  );
  return {
    producer,
    receipt,
    rawArtifactRefs,
    observation,
    artifactClaims,
    acquisitionArtifact,
  };
}

function lineageContext(value: ReturnType<typeof fixture>) {
  return {
    productionReceipt: value.receipt,
    acquisitionArtifact: value.acquisitionArtifact,
    artifactClaims: value.artifactClaims,
  } as const;
}

test("executable qualified-fact schema hashes are stable-format golden values", () => {
  assert.equal(QUALIFIED_FACT_SCHEMA_MANIFESTS.observation.schemaHash, "0x1baaa76af41fb5522e82a5d6350fc9f1502c229bbad030d88e9babd860628b6b");
  assert.equal(QUALIFIED_FACT_SCHEMA_MANIFESTS.snapshot.schemaHash, "0x0306cf6254518303f582cd15c60f8157a3a117a1ee926f0003fb2203f78891d2");
  assert.equal(QUALIFIED_FACT_SCHEMA_MANIFESTS.acceptanceQuery.schemaHash, "0xf49824465db79bc5aadd1fb290d9074bf7a8c11a1b86e8aadb3e3e2f04fbbfa6");
});

test("process/store sidecars are independent typed, content-addressed observations", () => {
  const common = {
    schemaVersion: 1 as const,
    observerImplementationDigest: h("1"),
    observerQualificationId: h("2"),
    qualificationRegistryRoot: h("3"),
    anchorPolicyDigest: h("4"),
  };
  const acquisition = createAcquisitionProcessObservation({
    ...common,
    kind: "aloha.acquisition-process-observation",
    observationSchema: {
      id: QUALIFIED_FACT_SCHEMA_MANIFESTS.acquisitionProcessObservation.id,
      version: QUALIFIED_FACT_SCHEMA_MANIFESTS.acquisitionProcessObservation.version,
      schemaHash: QUALIFIED_FACT_SCHEMA_MANIFESTS.acquisitionProcessObservation.schemaHash,
    },
    roleId: "acquisition-observer-process",
    canonicalFacts: { receiptId: h("5"), processAnchorHash: h("6"), logRangeArtifactRefId: h("7"), rawBoundaryArtifactRefId: h("8") },
  });
  const target = createTargetProcessObservation({
    ...common,
    kind: "aloha.target-process-observation",
    observationSchema: {
      id: QUALIFIED_FACT_SCHEMA_MANIFESTS.targetProcessObservation.id,
      version: QUALIFIED_FACT_SCHEMA_MANIFESTS.targetProcessObservation.version,
      schemaHash: QUALIFIED_FACT_SCHEMA_MANIFESTS.targetProcessObservation.schemaHash,
    },
    roleId: "target-production-process",
    canonicalFacts: { receiptId: h("9"), processAnchorHash: h("a"), logRangeArtifactRefId: h("b"), rawBoundaryArtifactRefId: h("c") },
  });
  const store = createStoreEpochObservation({
    ...common,
    kind: "aloha.store-epoch-observation",
    observationSchema: {
      id: QUALIFIED_FACT_SCHEMA_MANIFESTS.storeEpochObservation.id,
      version: QUALIFIED_FACT_SCHEMA_MANIFESTS.storeEpochObservation.version,
      schemaHash: QUALIFIED_FACT_SCHEMA_MANIFESTS.storeEpochObservation.schemaHash,
    },
    roleId: "store-epoch-observation",
    canonicalFacts: { storeIdentityHash: h("d"), currentStoreEpoch: "11", rawArtifactRefId: h("e") },
  });
  assert.deepEqual(decodeAcquisitionProcessObservation(encodeAcquisitionProcessObservation(acquisition)), acquisition);
  assert.deepEqual(decodeTargetProcessObservation(encodeTargetProcessObservation(target)), target);
  assert.deepEqual(decodeStoreEpochObservation(encodeStoreEpochObservation(store)), store);

  assert.throws(() => decodeStoreEpochObservation({ ...store, canonicalFacts: { storeIdentityHash: h("d"), currentStoreEpoch: 11 } } as never));
  assert.throws(() => decodeStoreEpochObservation({ ...store, canonicalFacts: { ...store.canonicalFacts, currentStoreEpoch: "12" } } as never));
  assert.throws(() => decodeTargetProcessObservation({ ...target, kind: "aloha.acquisition-process-observation" } as never));
  assert.throws(() => decodeAcquisitionProcessObservation({
    ...acquisition,
    observationSchema: {
      id: QUALIFIED_FACT_SCHEMA_MANIFESTS.targetProcessObservation.id,
      version: QUALIFIED_FACT_SCHEMA_MANIFESTS.targetProcessObservation.version,
      schemaHash: QUALIFIED_FACT_SCHEMA_MANIFESTS.targetProcessObservation.schemaHash,
    },
  } as never));
});

test("binary decoders accept only exact native Uint8Array and never invoke hostile traps", () => {
  const fixtureValue = fixture();
  const encoded = encodeQualifiedObservation(fixtureValue.observation);
  assert.deepEqual(decodeQualifiedObservation(encoded), fixtureValue.observation);

  assert.throws(() => decodeQualifiedObservation(Buffer.from(encoded)));
  class DerivedBytes extends Uint8Array {}
  assert.throws(() => decodeQualifiedObservation(new DerivedBytes(encoded)));

  let proxyTrapHits = 0;
  const proxy = new Proxy(encoded, {
    get: () => {
      proxyTrapHits += 1;
      throw new Error("proxy trap must not run");
    },
    getOwnPropertyDescriptor: () => {
      proxyTrapHits += 1;
      throw new Error("proxy trap must not run");
    },
    getPrototypeOf: () => {
      proxyTrapHits += 1;
      throw new Error("proxy trap must not run");
    },
    ownKeys: () => {
      proxyTrapHits += 1;
      throw new Error("proxy trap must not run");
    },
  });
  assert.throws(() => decodeQualifiedObservation(proxy));
  assert.equal(proxyTrapHits, 0);

  let lengthGetterHits = 0;
  const shadowedLength = encoded.slice();
  Object.defineProperty(shadowedLength, "length", {
    configurable: true,
    get: () => {
      lengthGetterHits += 1;
      return encoded.length;
    },
  });
  assert.throws(() => decodeQualifiedObservation(shadowedLength));
  assert.equal(lengthGetterHits, 0);
});

test("observation lineage derives qualification requirements without granting authority", () => {
  const fixtureValue = fixture();
  const lineage = validateQualifiedObservationLineage(fixtureValue.observation, lineageContext(fixtureValue));
  assert.equal(lineage.observation.observationId, fixtureValue.observation.observationId);
  assert.equal(lineage.producerProcessAnchorHash, hashProcessAnchor(fixtureValue.producer));
  assert.deepEqual(lineage.observerRequirement, {
    observerQualificationId: h("1"),
    observerImplementationDigest: h("f"),
    qualificationRegistryRoot: h("2"),
    anchorPolicyDigest: h("3"),
    observationSchema: schema,
    requiredLocatorKinds: ["file-range"],
  });
  assert.deepEqual(lineage.artifactRequirements, fixtureValue.rawArtifactRefs.map((ref, index) => ({
    artifactRefId: ref.artifactRefId,
    artifactClaimId: fixtureValue.artifactClaims[index].claimId,
    resolverPolicyHash: ref.resolverPolicyHash,
    retentionLeaseReceiptId: ref.retentionLeaseReceiptId,
    storeIdentityHash: ref.immutableMirrorLocator.storeIdentityHash,
    objectKey: ref.immutableMirrorLocator.objectKey,
    contentSha256: ref.contentSha256,
    byteLength: ref.byteLength,
    mediaType: ref.mediaType,
    schema: ref.schema,
  })));
  assert.equal(Object.isFrozen(lineage), true);

  assert.throws(() => validateQualifiedObservationLineage(fixtureValue.observation, {
    ...lineageContext(fixtureValue),
    artifactClaims: fixtureValue.artifactClaims.slice(0, 1),
  }));
  assert.throws(() => validateQualifiedObservationLineage(fixtureValue.observation, {
    ...lineageContext(fixtureValue),
    artifactClaims: fixtureValue.artifactClaims.map((entry) => createArtifactResolutionClaim({
      artifactRefId: entry.artifactRefId,
      resolverPolicyHash: entry.resolverPolicyHash,
      observedMirror: null,
      outcome: "missing",
    })),
  }));
  assert.throws(() => validateQualifiedObservationLineage(fixtureValue.observation, {
    ...lineageContext(fixtureValue),
    currentQualification: { current: true },
  } as never));
  assert.throws(() => validateQualifiedObservationLineage(fixtureValue.observation, {
    ...lineageContext(fixtureValue),
    currentResolverQualification: { current: true },
  } as never));
});

test("receipt refs and process anchor cannot be spliced into a qualified observation", () => {
  const fixtureValue = fixture();
  const unrelated = artifactRef("8", 6);
  const spliced = createQualifiedObservation({
    ...observationDraft(fixtureValue.observation),
    rawArtifactRefs: [fixtureValue.rawArtifactRefs[0], unrelated].sort((a, b) => a.artifactRefId.localeCompare(b.artifactRefId)),
  });
  assert.throws(() => validateQualifiedObservationLineage(spliced, lineageContext(fixtureValue)));
  assert.throws(() => decodeQualifiedObservation({
    ...fixtureValue.observation,
    rawArtifactRefs: [...fixtureValue.rawArtifactRefs].reverse(),
  } as unknown as QualifiedObservationEnvelopeV1));
});

test("observation validation decodes every artifact claim instead of trusting typed fields", () => {
  const fixtureValue = fixture();
  const tampered = {
    ...fixtureValue.artifactClaims[0],
    artifactRefId: h("0"),
    claimId: h("0"),
  };
  assert.throws(() => validateQualifiedObservationLineage(fixtureValue.observation, {
    ...lineageContext(fixtureValue),
    artifactClaims: [
      { ...tampered, claimId: recomputeArtifactResolutionClaimId(tampered) },
      fixtureValue.artifactClaims[1],
    ],
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
  assert.throws(() => validateQualifiedObservationLineage(wrongObservation, {
    productionReceipt: wrongReceipt,
    acquisitionArtifact: wrongArtifact,
    artifactClaims: fixtureValue.artifactClaims,
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

test("signed observer invocation binds exact sorted artifact and receipt sets", () => {
  const draft = {
    schemaVersion: 1 as const,
    kind: "aloha.signed-observer-invocation-snapshot" as const,
    registryRoot: h("1"),
    registryEpoch: "7",
    observerQualificationId: h("2"),
    roleId: "chain-observer",
    keyId: h("3"),
    audienceHash: h("4"),
    invocationNonce: h("5"),
    issuedAtUnixNs: "100",
    expiresAtUnixNs: "200",
    acceptanceQueryId: h("6"),
    qualifiedFactSnapshotId: h("7"),
    semanticArtifactBindings: [
      { kind: "semantic-artifact" as const, objectId: h("8"), rawArtifactRefId: h("9"), canonicalBytesSha256: h("a"), byteLength: "10" },
    ],
    productionReceiptBindings: [
      { kind: "production-receipt" as const, objectId: h("b"), rawArtifactRefId: h("c"), canonicalBytesSha256: h("d"), byteLength: "11" },
    ],
    signatureAlgorithm: "ed25519" as const,
  };
  const unsigned = createUnsignedSignedObserverInvocationSnapshot(draft);
  const signatureHex = `0x${"11".repeat(64)}`;
  const signed = sealSignedObserverInvocationSnapshot(unsigned, signatureHex);
  assert.deepEqual(decodeSignedObserverInvocationSnapshot(encodeSignedObserverInvocationSnapshot(signed)), signed);
  assert.equal(recomputeSignedObserverInvocationSnapshotPayloadHash(signed), signed.payloadHash);
  assert.equal(recomputeSignedObserverInvocationSnapshotId(signed), signed.attestationId);
  const alteredUnsigned = createUnsignedSignedObserverInvocationSnapshot({ ...draft, registryRoot: h("f") });
  assert.notDeepEqual(observerInvocationSigningBytes(unsigned), observerInvocationSigningBytes(alteredUnsigned));
  assert.equal(createSignedObserverInvocationSnapshot(draft, signatureHex).attestationId, signed.attestationId);

  assert.throws(() => decodeSignedObserverInvocationSnapshot({ ...signed, signatureHex: signatureHex.toUpperCase() } as never));
  assert.throws(() => decodeSignedObserverInvocationSnapshot({ ...signed, invocationNonce: h("0") } as never));
  assert.throws(() => decodeSignedObserverInvocationSnapshot({ ...signed, productionReceiptSetRoot: h("f") } as never));
  for (const forbidden of ["publicKeyHex", "verdict", "checks", "expected"] as const) {
    assert.throws(() => decodeSignedObserverInvocationSnapshot({ ...signed, [forbidden]: h("f") } as never), forbidden);
  }
  assert.throws(() => decodeSignedObserverInvocationSnapshot({ ...signed, unexpected: true } as never));
  assert.throws(() => createUnsignedSignedObserverInvocationSnapshot({ ...draft, semanticArtifactBindings: [...draft.semanticArtifactBindings, draft.semanticArtifactBindings[0]] } as never));
  assert.throws(() => createUnsignedSignedObserverInvocationSnapshot({
    ...draft,
    productionReceiptBindings: [{ ...draft.productionReceiptBindings[0], rawArtifactRefId: draft.semanticArtifactBindings[0].rawArtifactRefId }],
  } as never));
  assert.throws(() => createUnsignedSignedObserverInvocationSnapshot({
    ...draft,
    semanticArtifactBindings: [{ ...draft.semanticArtifactBindings[0], byteLength: "0" }],
  } as never));
});
