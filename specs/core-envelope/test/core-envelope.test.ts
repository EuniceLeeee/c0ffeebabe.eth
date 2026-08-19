import assert from "node:assert/strict";
import test from "node:test";
import {
  createProductionReceipt,
  createReadOnlyArtifactRef,
  createSemanticArtifact,
  CORE_SCHEMA_MANIFESTS,
  decodeProductionReceipt,
  decodeReadOnlyArtifactRef,
  decodeSchemaRef,
  encodeProductionReceipt,
  encodeReadOnlyArtifactRef,
  encodeSchemaRef,
  hashProcessAnchor,
  recomputeProductionReceiptId,
  recomputeReadOnlyArtifactLocatorId,
  recomputeSemanticArtifactId,
  type ProcessAnchorV1,
  type ReadOnlyArtifactRefV1,
  type Hash,
} from "../src/index.ts";

const h = ("0x" + "1".repeat(64)) as Hash;
const h2 = ("0x" + "2".repeat(64)) as Hash;

function mirror(contentSha256 = h) {
  return {
    kind: "content-object" as const,
    storeIdentityHash: h,
    objectKey: contentSha256,
  };
}

function artifactRef(
  locator: ReadOnlyArtifactRefV1["locator"],
  contentSha256 = h,
): ReadOnlyArtifactRefV1 {
  return createReadOnlyArtifactRef({
    locator,
    immutableMirrorLocator: mirror(contentSha256),
    contentSha256,
    byteLength: "3",
    mediaType: "application/octet-stream",
    schema: null,
    resolverPolicyHash: h,
    retentionLeaseReceiptId: h2,
  });
}

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

test("SchemaRef and locator codecs are exact and domain addressed", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(CORE_SCHEMA_MANIFESTS).map(([name, manifest]) => [name, manifest.schemaHash]),
    ),
    {
      schemaRef: "0x1c97c993aec14200eb6c79e46d593735423019dc085a7d2f449a52d7f8384ff1",
      sourceAnchor: "0xbb361817a9d51aae0bcb4e5dcfa199f976abfdd1e31fc584473bfe7bc00d055a",
      processAnchor: "0xb4f12523e1bc0e7af5c082a39c276063bfcc0bb2e0010c244155b3157d9019ad",
      readOnlyArtifactLocator: "0x68a65ca127666403e4fdce75b81d6df6744ca8aa2e96f9357925b9b3eddfaa6c",
      readOnlyArtifactRef: "0x498ec4be648439a19cf2bfb4ad377cf48fe664df8d0cad42c4900108e3e5f63e",
      semanticArtifact: "0x3564af07df05c9d1e34b18f53d91a29c785a3654e471b039613ed670a453ffa6",
      productionReceipt: "0x04be6d62c723c1fe49412ecdd1e706f22c18cd2ce393d57890dc65de1fd85f7d",
    },
  );
  assert.equal(Object.isFrozen(CORE_SCHEMA_MANIFESTS), true);
  const schema = { id: "aloha.test", version: "1.2.3", schemaHash: h } as const;
  const bytes = encodeSchemaRef(schema);
  assert.equal(new TextDecoder().decode(bytes), '{"id":"aloha.test","schemaHash":"' + h + '","version":"1.2.3"}');
  assert.deepEqual(decodeSchemaRef(bytes), schema);

  const locator = {
    kind: "file-range" as const,
    systemId: "system",
    bootIdHash: h,
    device: "1",
    inode: "2",
    startInclusive: "0",
    endExclusive: "3",
  };
  const locatorId = recomputeReadOnlyArtifactLocatorId(locator);
  assert.match(locatorId, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(decodeReadOnlyArtifactRef(encodeReadOnlyArtifactRef(artifactRef(locator))).locator, locator);
});

test("locator union discriminators do not invoke accessors or proxy traps", () => {
  let getterHits = 0;
  const getterLocator: Record<string, unknown> = {};
  Object.defineProperty(getterLocator, "kind", {
    enumerable: true,
    get: () => {
      getterHits += 1;
      return "content-object";
    },
  });
  assert.throws(() => CORE_SCHEMA_MANIFESTS.readOnlyArtifactLocator.schema.decode(getterLocator));
  assert.equal(getterHits, 0);

  let proxyHits = 0;
  const proxyLocator = new Proxy({ kind: "content-object" }, {
    get: () => {
      proxyHits += 1;
      return "content-object";
    },
    ownKeys: () => {
      proxyHits += 1;
      return ["kind"];
    },
  });
  assert.throws(() => CORE_SCHEMA_MANIFESTS.readOnlyArtifactLocator.schema.decode(proxyLocator));
  assert.equal(proxyHits, 0);
});

test("unknown core fields, duplicate keys, and identity mutations fail closed", () => {
  assert.throws(() => decodeSchemaRef({ id: "x", version: "1.0.0", schemaHash: h, extra: true } as never));
  assert.throws(() => decodeSchemaRef('{"id":"x","id":"y","schemaHash":"' + h + '","version":"1.0.0"}'));

  const locator = {
    kind: "checkpoint-record" as const,
    storeIdentityHash: h,
    namespaceHash: h,
    keyHash: h,
    revision: "1",
    recordHash: h2,
  };
  const artifact = artifactRef(locator);
  const mutated = { ...artifact, contentSha256: h2 };
  assert.notEqual(recomputeProductionReceiptId, undefined);
  assert.throws(() => decodeReadOnlyArtifactRef(mutated));
  assert.throws(() => CORE_SCHEMA_MANIFESTS.readOnlyArtifactRef.schema.decode(mutated));
});

test("artifact refs bind mirror content and file-range byte length", () => {
  const fileLocator = {
    kind: "file-range" as const,
    systemId: "system",
    bootIdHash: h,
    device: "1",
    inode: "2",
    startInclusive: "10",
    endExclusive: "13",
  };
  assert.doesNotThrow(() => artifactRef(fileLocator));
  assert.throws(() =>
    createReadOnlyArtifactRef({
      locator: { ...fileLocator, endExclusive: "14" },
      immutableMirrorLocator: mirror(h),
      contentSha256: h,
      byteLength: "3",
      mediaType: "application/octet-stream",
      schema: null,
      resolverPolicyHash: h,
      retentionLeaseReceiptId: h2,
    }),
  );
  assert.throws(() =>
    createReadOnlyArtifactRef({
      locator: fileLocator,
      immutableMirrorLocator: mirror(h2),
      contentSha256: h,
      byteLength: "3",
      mediaType: "application/octet-stream",
      schema: null,
      resolverPolicyHash: h,
      retentionLeaseReceiptId: h2,
    }),
  );
});

test("semantic artifacts and production receipts recompute IDs over all semantic fields", () => {
  const input = artifactRef({
    kind: "chain-object",
    chainId: "1",
    blockNumber: "2",
    blockHash: h,
    objectKind: "receipt",
    objectKeyHash: h2,
  });
  const semantic = createSemanticArtifact({
    schema: { id: "stage", version: "1.0.0", schemaHash: h },
    inputArtifactIds: [input.artifactRefId],
    dependencyClosureRoot: h,
    canonicalPayloadHash: h2,
  });
  assert.equal(recomputeSemanticArtifactId(semantic), semantic.artifactId);
  assert.doesNotThrow(() => CORE_SCHEMA_MANIFESTS.semanticArtifact.schema.decode(semantic));
  assert.throws(() => CORE_SCHEMA_MANIFESTS.semanticArtifact.schema.decode({ ...semantic, canonicalPayloadHash: h }));
  assert.notEqual(
    recomputeSemanticArtifactId({ ...semantic, canonicalPayloadHash: h }),
    semantic.artifactId,
  );

  const log = artifactRef({
    kind: "file-range",
    systemId: producer.systemId,
    bootIdHash: producer.bootIdHash,
    device: "1",
    inode: "2",
    startInclusive: "0",
    endExclusive: "3",
  });
  const boundary = artifactRef({
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
  assert.throws(() => createProductionReceipt({
    ...receipt,
    logRangeArtifactRef: artifactRef({
      kind: "file-range",
      systemId: "different-system",
      bootIdHash: producer.bootIdHash,
      device: "1",
      inode: "2",
      startInclusive: "0",
      endExclusive: "3",
    }),
  }));
  assert.throws(() => createProductionReceipt({
    ...receipt,
    logRangeArtifactRef: artifactRef({
      kind: "content-object",
      storeIdentityHash: h,
      objectKey: h,
    }),
  }));
  assert.doesNotThrow(() => CORE_SCHEMA_MANIFESTS.productionReceipt.schema.decode(receipt));
  assert.throws(() => CORE_SCHEMA_MANIFESTS.productionReceipt.schema.decode({ ...receipt, artifactId: h2 }));
  assert.equal(recomputeProductionReceiptId(receipt), receipt.receiptId);
  assert.equal(hashProcessAnchor(producer).length, 66);
  assert.equal(decodeProductionReceipt(encodeProductionReceipt(receipt)).receiptId, receipt.receiptId);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.producer), true);
  assert.throws(() => {
    (receipt as { artifactId: string }).artifactId = h2;
  });
});
