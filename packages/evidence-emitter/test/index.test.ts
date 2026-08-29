import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductionReceipt,
  createReadOnlyArtifactRef,
  createSemanticArtifact,
  type ProcessAnchorV1,
  type ReadOnlyArtifactRefV1,
} from "../../../specs/core-envelope/src/index.ts";
import {
  createArtifactResolutionClaim,
  createRetentionLeaseReceipt,
  encodeArtifactBytes,
} from "../../../specs/artifact-resolution/src/index.ts";
import {
  encodeSixStepWitnessContent,
  SIX_STEP_SCHEMA_MANIFESTS,
} from "../../../specs/evidence/src/six-step.ts";
import {
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  encodeContentAddressedEvent,
  EvidenceWriteFailedError,
  ProductionEvidenceEmitterV1,
  type EvidenceAppendPortV1,
  type EvidenceBoundaryObjectV1,
} from "../src/index.ts";
import {
  ProductionSixStepArtifactOwnerV1,
  issueProductionSixStepArtifactStoreV1,
  type ProductionSixStepArtifactSealInputV1,
  type ProductionSixStepArtifactStoreV1,
} from "../src/internal/six-step-production-owner.ts";

const h = (digit: string): Hash => (`0x${digit.repeat(64)}`) as Hash;
const producer: ProcessAnchorV1 = {
  systemId: "aloha-test",
  commitSha: "a".repeat(40),
  executableHash: h("1"),
  deploymentManifestHash: h("2"),
  serviceIdentityHash: h("3"),
  pid: "11",
  processStartTicks: "100",
  bootIdHash: h("4"),
};
const cutoff = {
  number: "100",
  hash: h("5"),
  stateRoot: h("6"),
};

function ref(
  locator: ReadOnlyArtifactRefV1["locator"],
  contentSha256: Hash,
): ReadOnlyArtifactRefV1 {
  return createReadOnlyArtifactRef({
    locator,
    immutableMirrorLocator: {
      kind: "content-object",
      storeIdentityHash: h("7"),
      objectKey: contentSha256,
    },
    contentSha256,
    byteLength: "3",
    mediaType: "application/octet-stream",
    schema: null,
    resolverPolicyHash: h("8"),
    retentionLeaseReceiptId: h("9"),
  });
}

function boundary(overrides: Partial<EvidenceBoundaryObjectV1> = {}): EvidenceBoundaryObjectV1 {
  const input = ref({
    kind: "chain-object",
    chainId: "1",
    blockNumber: "100",
    blockHash: cutoff.hash,
    objectKind: "receipt",
    objectKeyHash: h("a"),
  }, h("1"));
  const factSchema = { id: "aloha.test.stage-facts", version: "1.0.0", schemaHash: h("b") } as const;
  const facts = { observedRoot: h("c") } as const;
  const outcome = "verified" as const;
  const reasonCode = null;
  const outputHash = hashDomain("aloha/stage-output/v1", {
    stageId: "universe_instance",
    factSchema,
    facts,
    outcome,
    reasonCode,
  });
  const semantic = createSemanticArtifact({
    schema: { id: "aloha.semantic.stage", version: "1.0.0", schemaHash: h("d") },
    inputArtifactIds: [input.artifactRefId],
    dependencyClosureRoot: h("e"),
    canonicalPayloadHash: outputHash,
  });
  const log = ref({
    kind: "file-range",
    systemId: producer.systemId,
    bootIdHash: producer.bootIdHash,
    device: "1",
    inode: "2",
    startInclusive: "0",
    endExclusive: "3",
  }, h("2"));
  const raw = ref({
    kind: "checkpoint-record",
    storeIdentityHash: h("7"),
    namespaceHash: h("3"),
    keyHash: h("4"),
    revision: "1",
    recordHash: h("5"),
  }, h("3"));
  const receipt = createProductionReceipt({
    artifactId: semantic.artifactId,
    producer,
    logRangeArtifactRef: log,
    sourceAnchorHash: h("6"),
    startedMonotonicNs: "1000",
    finishedMonotonicNs: "2000",
    durationUs: "1",
    rawBoundaryArtifactRef: raw,
    semanticConfigDigest: h("7"),
    resourceMetricsHash: h("8"),
  });
  return {
    semanticArtifact: semantic,
    productionReceipt: receipt,
    scope: {
      kind: "builder-run",
      builderRunId: "run",
      producerSessionId: null,
      generationId: null,
      generationRefreshPolicyHash: h("9"),
    },
    correlationId: "correlation",
    runSequence: "0",
    cutoff,
    definitionCatalogRoot: h("a"),
    strategyCatalogRoot: null,
    instanceCatalogRoot: null,
    graphRoot: null,
    familyId: "family",
    candidateKey: "candidate",
    familyDefinitionHash: h("b"),
    capabilities: [{ capabilityId: "cap", version: "1.0.0", schemaHash: h("c"), interpreterHash: h("d") }],
    instanceKey: "instance",
    stage: { ordinal: 1, id: "universe_instance", version: 1 },
    inputSchema: { id: "aloha.input", version: "1.0.0", schemaHash: h("e") },
    inputs: { inputRoot: h("f") },
    factSchema,
    facts,
    outcome,
    reasonCode,
    parentEvents: [],
    extensions: [],
    ...overrides,
  };
}

class MemoryAppend implements EvidenceAppendPortV1 {
  readonly requests: Array<{ sequence: string; eventId: Hash; contentSha256: Hash; bytes: Uint8Array }> = [];
  fail = false;

  async appendFsyncMonotonic(request: { sequence: string; eventId: Hash; contentSha256: Hash; bytes: Uint8Array }) {
    if (this.fail) throw new Error("disk unavailable");
    const last = this.requests.at(-1);
    const expected = last === undefined ? 0n : BigInt(last.sequence) + 1n;
    if (BigInt(request.sequence) !== expected) throw new Error("non-monotonic request");
    this.requests.push(request);
    return {
      sequence: request.sequence,
      eventId: request.eventId,
      contentSha256: request.contentSha256,
      byteLength: String(request.bytes.byteLength),
      offsetStart: String(this.requests.length === 1 ? 0 : this.requests.slice(0, -1).reduce((sum, item) => sum + item.bytes.byteLength, 0)),
      offsetEnd: String(this.requests.reduce((sum, item) => sum + item.bytes.byteLength, 0)),
      fsynced: true as const,
    };
  }
}

test("emitter derives exact event bytes from existing semantic and receipt objects", async () => {
  const append = new MemoryAppend();
  const emitter = new ProductionEvidenceEmitterV1({ append, emitterKind: "native", emitterCodeHash: h("f") });
  const emission = await emitter.emit(boundary());
  assert.equal(append.requests.length, 1);
  assert.equal(emission.event.eventId, append.requests[0]!.eventId);
  assert.equal(emission.contentSha256, sha256Hex(emission.bytes));
  assert.deepEqual(encodeContentAddressedEvent(emission.event).bytes, emission.bytes);
  assert.equal(emission.append.sequence, "0");
  assert.equal(emitter.lastCommittedSequence, "0");
});

test("append is serialized and sequence remains monotonic under concurrent callers", async () => {
  const append = new MemoryAppend();
  const emitter = new ProductionEvidenceEmitterV1({ append, emitterKind: "native", emitterCodeHash: h("f") });
  const [first, second] = await Promise.all([emitter.emit(boundary()), emitter.emit(boundary({ runSequence: "1" }))]);
  assert.deepEqual(append.requests.map((request) => request.sequence), ["0", "1"]);
  assert.equal(first.append.sequence, "0");
  assert.equal(second.append.sequence, "1");
});

test("failed fsync is a hard failure and does not advance the durable sequence", async () => {
  const append = new MemoryAppend();
  const emitter = new ProductionEvidenceEmitterV1({ append, emitterKind: "native", emitterCodeHash: h("f") });
  append.fail = true;
  await assert.rejects(emitter.emit(boundary()), EvidenceWriteFailedError);
  assert.equal(append.requests.length, 0);
  assert.equal(emitter.lastCommittedSequence, "-1");
  append.fail = false;
  const emission = await emitter.emit(boundary());
  assert.equal(emission.append.sequence, "0");
});

test("producer verdict, expected success and checks fields are rejected before append", async () => {
  const append = new MemoryAppend();
  const emitter = new ProductionEvidenceEmitterV1({ append, emitterKind: "native", emitterCodeHash: h("f") });
  const forged = { ...boundary(), facts: { observedRoot: h("c"), expectedSuccess: true } } as never;
  await assert.rejects(emitter.emit(forged));
  assert.equal(append.requests.length, 0);
});

test("semantic artifact and receipt cannot be spliced", async () => {
  const append = new MemoryAppend();
  const emitter = new ProductionEvidenceEmitterV1({ append, emitterKind: "native", emitterCodeHash: h("f") });
  const original = boundary();
  const replacementSemantic = createSemanticArtifact({
    schema: original.semanticArtifact.schema,
    inputArtifactIds: original.semanticArtifact.inputArtifactIds,
    dependencyClosureRoot: h("1"),
    canonicalPayloadHash: original.semanticArtifact.canonicalPayloadHash,
  });
  const forged = { ...original, productionReceipt: createProductionReceipt({
    artifactId: replacementSemantic.artifactId,
    producer,
    logRangeArtifactRef: original.productionReceipt.logRangeArtifactRef,
    sourceAnchorHash: original.productionReceipt.sourceAnchorHash,
    startedMonotonicNs: original.productionReceipt.startedMonotonicNs,
    finishedMonotonicNs: original.productionReceipt.finishedMonotonicNs,
    durationUs: original.productionReceipt.durationUs,
    rawBoundaryArtifactRef: original.productionReceipt.rawBoundaryArtifactRef,
    semanticConfigDigest: original.productionReceipt.semanticConfigDigest,
    resourceMetricsHash: original.productionReceipt.resourceMetricsHash,
  }) };
  await assert.rejects(emitter.emit(forged));
  assert.equal(append.requests.length, 0);
});

class SixStepArtifactStoreFixture implements ProductionSixStepArtifactStoreV1 {
  readonly mutation: "none" | "byte" | "length";
  constructor(mutation: "none" | "byte" | "length") { this.mutation = mutation; }

  async seal(input: ProductionSixStepArtifactSealInputV1) {
    const source = Uint8Array.from(input.bytes);
    let payloadIndex = -1;
    for (let index = 0; index <= source.length - 16; index += 1) {
      if (source.subarray(index, index + 16).every(value => value === 0x78)) {
        payloadIndex = index;
        break;
      }
    }
    if (payloadIndex < 0) throw new TypeError("large payload marker is missing");
    const bytes = this.mutation === "byte"
      ? Uint8Array.from(source, (value, index) => index === payloadIndex ? value ^ 1 : value)
      : this.mutation === "length"
        ? (() => {
          const shortened = new Uint8Array(source.length - 1);
          shortened.set(source.subarray(0, payloadIndex));
          shortened.set(source.subarray(payloadIndex + 1), payloadIndex);
          return shortened;
        })()
        : source;
    const contentSha256 = sha256Hex(bytes);
    const storeIdentityHash = h("7");
    const lease = createRetentionLeaseReceipt({
      storeIdentityHash,
      objectKey: contentSha256,
      contentSha256,
      validFromStoreEpoch: "0",
      validThroughStoreEpoch: "1",
      issuerId: "six-step-byte-test",
      issuerQualificationId: h("8"),
      qualificationRegistryRoot: h("9"),
    });
    const immutableMirrorLocator = Object.freeze({
      kind: "content-object" as const,
      storeIdentityHash,
      objectKey: contentSha256,
    });
    const artifactRef = createReadOnlyArtifactRef({
      locator: input.locator,
      immutableMirrorLocator,
      contentSha256,
      byteLength: String(bytes.byteLength),
      mediaType: input.mediaType,
      schema: input.schema,
      resolverPolicyHash: h("a"),
      retentionLeaseReceiptId: lease.receiptId,
    });
    const claim = createArtifactResolutionClaim({
      artifactRefId: artifactRef.artifactRefId,
      resolverPolicyHash: artifactRef.resolverPolicyHash,
      observedMirror: {
        storeIdentityHash,
        objectKey: contentSha256,
        bytes: encodeArtifactBytes(bytes),
        contentSha256,
        byteLength: String(bytes.byteLength),
        mediaType: input.mediaType,
        schema: input.schema,
      },
      outcome: "content-observed",
    });
    return Object.freeze({ bytes, ref: artifactRef, claim, lease });
  }

  async loadBoundary() { return null; }
  async persistBoundary() {}
}

function sixStepArtifactOwner(mutation: "none" | "byte" | "length") {
  return new ProductionSixStepArtifactOwnerV1({
    process: producer,
    emitterCodeHash: h("f"),
    evidenceLog: Object.freeze({ device: "1", inode: "2" }),
    append: new MemoryAppend(),
    store: issueProductionSixStepArtifactStoreV1(new SixStepArtifactStoreFixture(mutation)),
  });
}

test("Six-Step artifact byte equality supports the full 500KB policy denominator", async () => {
  const bytes = encodeSixStepWitnessContent({
    schemaVersion: 1,
    kind: "aloha.six-step-evidence-witness",
    stageId: "final_simulation",
    role: "large-physical-fact",
    payload: { fact: "x".repeat(20_000) },
  });
  assert.ok(bytes.byteLength > 16_384);
  const input = Object.freeze({
    artifactKey: sha256Hex(bytes),
    bytes,
    locator: Object.freeze({ kind: "content-object" as const, storeIdentityHash: h("7"), objectKey: sha256Hex(bytes) }),
    mediaType: "application/json",
    schema: Object.freeze({
      id: SIX_STEP_SCHEMA_MANIFESTS.witnessContent.id,
      version: SIX_STEP_SCHEMA_MANIFESTS.witnessContent.version,
      schemaHash: SIX_STEP_SCHEMA_MANIFESTS.witnessContent.schemaHash,
    }),
  });
  await assert.doesNotReject(sixStepArtifactOwner("none").sealArtifact(input));
  await assert.rejects(sixStepArtifactOwner("byte").sealArtifact(input), /non-exact artifact/);
  await assert.rejects(sixStepArtifactOwner("length").sealArtifact(input), /non-exact artifact/);
});
