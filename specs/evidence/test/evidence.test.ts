import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductionReceipt,
  createReadOnlyArtifactRef,
  createSemanticArtifact,
  type ProcessAnchorV1,
  type ProductionReceiptV1,
  type ReadOnlyArtifactRefV1,
} from "../../core-envelope/src/index.ts";
import {
  createEvidenceEvent,
  decodeEvidenceEvent,
  encodeEvidenceEvent,
  EVIDENCE_SCHEMA_MANIFESTS,
  recomputeEvidenceEventId,
  type EvidenceEventV1,
  type EvidenceEventDraft,
  type Hash,
} from "../src/index.ts";
import { assertEvidenceEventMatchesReceipt } from "../src/index.ts";

const h = ("0x" + "1".repeat(64)) as Hash;
const h2 = ("0x" + "2".repeat(64)) as Hash;

const producer: ProcessAnchorV1 = {
  systemId: "system",
  commitSha: "a".repeat(40),
  executableHash: h,
  deploymentManifestHash: h,
  serviceIdentityHash: h2,
  pid: "42",
  processStartTicks: "100",
  bootIdHash: h,
};

let lastReceipt: ProductionReceiptV1 | null = null;

function ref(
  locator: ReadOnlyArtifactRefV1["locator"],
  contentSha256: typeof h | typeof h2,
): ReadOnlyArtifactRefV1 {
  return createReadOnlyArtifactRef({
    locator,
    immutableMirrorLocator: {
      kind: "content-object",
      storeIdentityHash: h,
      objectKey: contentSha256,
    },
    contentSha256,
    byteLength: "3",
    mediaType: "application/octet-stream",
    schema: null,
    resolverPolicyHash: h,
    retentionLeaseReceiptId: h2,
  });
}

function fixture(
  outcome: EvidenceEventDraft["outcome"] = "verified",
  instanceKey: string | null = "instance",
): EvidenceEventV1 {
  const input = ref({
    kind: "chain-object",
    chainId: "1",
    blockNumber: "2",
    blockHash: h,
    objectKind: "receipt",
    objectKeyHash: h2,
  }, h);
  const semantic = createSemanticArtifact({
    schema: { id: "stage", version: "1.0.0", schemaHash: h },
    inputArtifactIds: [input.artifactRefId],
    dependencyClosureRoot: h,
    canonicalPayloadHash: h2,
  });
  const log = ref({
    kind: "file-range",
    systemId: "system",
    bootIdHash: h,
    device: "1",
    inode: "2",
    startInclusive: "0",
    endExclusive: "3",
  }, h);
  const boundary = ref({
    kind: "checkpoint-record",
    storeIdentityHash: h,
    namespaceHash: h,
    keyHash: h2,
    revision: "1",
    recordHash: h2,
  }, h2);
  const receipt = createProductionReceipt({
    artifactId: semantic.artifactId,
    producer,
    logRangeArtifactRef: log,
    sourceAnchorHash: h,
    startedMonotonicNs: "1000",
    finishedMonotonicNs: "2000",
    durationUs: "1",
    rawBoundaryArtifactRef: boundary,
    semanticConfigDigest: h,
    resourceMetricsHash: h2,
  });
  lastReceipt = receipt;
  const schema = { id: "x", version: "1.0.0", schemaHash: h };
  return createEvidenceEvent({
    schemaVersion: 1,
    kind: "aloha.fact-evidence-event",
    source: {
      systemId: "system",
      emitterKind: "native",
      emitterCodeHash: h,
      rawBoundaryArtifactRef: boundary,
    },
    runtime: {
      commitSha: producer.commitSha,
      executableHash: producer.executableHash,
      deploymentManifestHash: producer.deploymentManifestHash,
      serviceIdentityHash: producer.serviceIdentityHash,
      pid: producer.pid,
      processStartTicks: producer.processStartTicks,
      bootIdHash: producer.bootIdHash,
      logRangeArtifactRefId: log.artifactRefId,
    },
    artifactLineage: {
      inputArtifactIds: [input.artifactRefId],
      outputArtifactId: semantic.artifactId,
      productionReceiptId: receipt.receiptId,
    },
    scope: {
      kind: "builder-run",
      builderRunId: "builder",
      producerSessionId: null,
      generationId: null,
      generationRefreshPolicyHash: h,
    },
    correlationId: "correlation",
    runSequence: "0",
    cutoff: { number: "1", hash: h, stateRoot: h2 },
    definitionCatalogRoot: h,
    strategyCatalogRoot: null,
    instanceCatalogRoot: null,
    graphRoot: null,
    familyId: "family",
    candidateKey: "candidate",
    familyDefinitionHash: h,
    capabilities: [
      { capabilityId: "capability", version: "1.0.0", schemaHash: h, interpreterHash: h2 },
    ],
    instanceKey,
    stage: { ordinal: 1, id: "universe_instance", version: 1 },
    parentEventIds: [],
    parentOutputHashes: [],
    inputSchema: schema,
    inputs: { source: "chain" },
    factSchema: schema,
    facts: { observed: true },
    outcome,
    reasonCode: outcome === "verified" ? null : "transport-error",
    latency: { startedMonotonicNs: "1000", finishedMonotonicNs: "2000", durationUs: "1" },
    extensions: [],
  });
}

test("evidence event exact bytes, descriptor hash, and deep freeze", () => {
  assert.equal(
    EVIDENCE_SCHEMA_MANIFESTS.event.schemaHash,
    "0xf00c390090fcab1c6494b64bea7532e0ab2c3fa4918796db49cb88935ff2e135",
  );
  const event = fixture();
  const bytes = encodeEvidenceEvent(event);
  assert.deepEqual(decodeEvidenceEvent(bytes), event);
  assert.deepEqual(encodeEvidenceEvent(decodeEvidenceEvent(bytes)), bytes);

  let binaryProxyHits = 0;
  const binaryProxy = new Proxy(bytes, {
    get: () => {
      binaryProxyHits += 1;
      return undefined;
    },
    getOwnPropertyDescriptor: () => {
      binaryProxyHits += 1;
      return undefined;
    },
    getPrototypeOf: () => {
      binaryProxyHits += 1;
      return Uint8Array.prototype;
    },
    ownKeys: () => {
      binaryProxyHits += 1;
      return [];
    },
  });
  assert.throws(() => decodeEvidenceEvent(binaryProxy));
  assert.equal(binaryProxyHits, 0);

  assert.equal(Object.isFrozen(event), true);
  assert.equal(Object.isFrozen(event.source), true);
  assert.equal(Object.isFrozen(event.facts), true);
  assert.doesNotThrow(() => EVIDENCE_SCHEMA_MANIFESTS.event.schema.decode(event));
  assert.throws(() => EVIDENCE_SCHEMA_MANIFESTS.event.schema.decode({ ...event, outputHash: h2 }));
  assert.throws(() => {
    (event as { correlationId: string }).correlationId = "changed";
  });
  assert.doesNotThrow(() => assertEvidenceEventMatchesReceipt(event, lastReceipt!));
  assert.throws(() => assertEvidenceEventMatchesReceipt({
    ...event,
    source: { ...event.source, systemId: "different-system" },
  }, lastReceipt!));
});

test("event scope discriminator does not invoke an accessor", () => {
  const event = fixture();
  let getterHits = 0;
  const scope = { ...event.scope } as Record<string, unknown>;
  Object.defineProperty(scope, "kind", {
    enumerable: true,
    get: () => {
      getterHits += 1;
      return "builder-run";
    },
  });
  assert.throws(() => EVIDENCE_SCHEMA_MANIFESTS.event.schema.decode({ ...event, scope }));
  assert.equal(getterHits, 0);
});

test("stage outcome and identity rules are fail-closed", () => {
  assert.doesNotThrow(() => fixture("verified", "instance"));
  assert.doesNotThrow(() => fixture("retryable", null));
  assert.doesNotThrow(() => fixture("retryable", "known-instance"));
  assert.throws(() => fixture("verified", null));
  assert.throws(() => fixture("success", "instance"));
  assert.throws(() => fixture("simulation_reverted", null));

  const reversedLatency = fixture();
  assert.throws(() => createEvidenceEvent({
    ...reversedLatency,
    latency: { ...reversedLatency.latency, startedMonotonicNs: "3000", finishedMonotonicNs: "2000" },
  }));

  const stageThreeWithoutStrategyRoot = fixture("verified", "instance");
  assert.throws(() => createEvidenceEvent({
    ...stageThreeWithoutStrategyRoot,
    scope: {
      kind: "producer-session",
      builderRunId: "builder",
      producerSessionId: "session",
      generationId: "generation",
      generationRefreshPolicyHash: h,
    },
    strategyCatalogRoot: null,
    instanceCatalogRoot: h,
    graphRoot: h,
    stage: { ordinal: 3, id: "planner_consumption", version: 1 },
    parentEventIds: [h],
    parentOutputHashes: [h],
    outcome: "success",
    reasonCode: null,
  }));
});

test("unknown fields, duplicate JSON keys, stable reason codes, and ID mutations fail", () => {
  const event = fixture();
  assert.throws(() => decodeEvidenceEvent({ ...event, unknownCoreField: true } as never));
  assert.throws(() => decodeEvidenceEvent(
    '{"eventId":"' + h + '","eventId":"' + h2 + '"}',
  ));
  assert.throws(() => decodeEvidenceEvent({ ...event, reasonCode: "free-form prose" } as never));

  const changed = { ...event, latency: { ...event.latency, durationUs: "2" } };
  assert.notEqual(recomputeEvidenceEventId(changed), event.eventId);
  assert.throws(() => decodeEvidenceEvent(changed));
  assert.throws(() => decodeEvidenceEvent({ ...event, inputHash: h2 }));
  assert.throws(() => decodeEvidenceEvent({
    ...event,
    latency: { ...event.latency, startedMonotonicNs: "3", finishedMonotonicNs: "2" },
  }));
});
