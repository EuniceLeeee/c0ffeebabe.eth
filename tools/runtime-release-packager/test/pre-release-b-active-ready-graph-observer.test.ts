import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetPortBindingV1 } from "../../../packages/asset-ref/src/index.ts";
import {
  decodeInstanceCatalogV1,
  encodeInstanceCatalogV1,
  sealInstanceCatalog,
  sealInstancePublication,
  type InstanceCatalogPublicationChunkRefV1,
} from "../../../packages/catalog/src/index.ts";
import {
  buildPersistedGraph,
  decodePersistedGraphV1,
  encodePersistedGraphV1,
  type PersistedGraphEdgeChunkRefV1,
} from "../../../packages/graph/src/index.ts";
import { exactLinkedChunkReader } from "../src/internal/pre-release-b-active-ready-graph-owner.ts";

const h = (value: string): Hash => hashDomain("test/pre-release-b-active-ready-graph/v1", value);
const cutoff = Object.freeze({
  chainId: "1",
  number: "100",
  hash: h("cutoff-block"),
  stateRoot: h("cutoff-state-root"),
});

interface TestContentV1 {
  readonly hash: Hash;
  readonly payloadHash: Hash;
  readonly kind: string;
  readonly bytes: Uint8Array;
  readonly references: readonly Hash[];
}

function contentRecord(kind: string, bytes: Uint8Array, references: readonly Hash[] = []): TestContentV1 {
  const payloadHash = sha256Hex(bytes);
  return Object.freeze({
    hash: hashDomain("aloha/durable-content-envelope/v1", { kind, payloadHash, references }),
    payloadHash,
    kind,
    bytes,
    references: Object.freeze([...references]),
  });
}

function physicalLinkedClosure(
  manifestBytes: Uint8Array,
  chunks: readonly Readonly<{ readonly bytes: Uint8Array }>[],
  manifestKind: string,
  chunkKind: string,
): Readonly<{
  manifest: TestContentV1;
  records: ReadonlyMap<Hash, TestContentV1>;
  chunkStorageHashes: readonly Hash[];
}> {
  const records = new Map<Hash, TestContentV1>();
  const chunkStorageHashes = chunks.map(({ bytes }) => {
    const record = contentRecord(chunkKind, bytes);
    records.set(record.hash, record);
    return record.hash;
  });
  const manifest = contentRecord(manifestKind, manifestBytes, [...chunkStorageHashes].sort());
  records.set(manifest.hash, manifest);
  return Object.freeze({ manifest, records, chunkStorageHashes: Object.freeze(chunkStorageHashes) });
}

function readFrom(records: ReadonlyMap<Hash, TestContentV1>): (hash: Hash) => TestContentV1 {
  return hash => {
    const record = records.get(hash);
    if (record === undefined) throw new TypeError("missing durable content fixture");
    return record;
  };
}

function publication(index: number) {
  const familyId = `ready-family-${String(index).padStart(3, "0")}`;
  const instanceKey = `ready-instance-${String(index).padStart(3, "0")}`;
  const identityMemo = { kind: "ready-multichunk-test", familyId, instanceKey };
  const input = erc20AssetPortBindingV1("1", "0x1111111111111111111111111111111111111111");
  const output = erc20AssetPortBindingV1("1", "0x2222222222222222222222222222222222222222");
  return sealInstancePublication({
    familyId,
    familyDefinitionHash: h(`${familyId}:definition`),
    familyCandidateKey: h(`${familyId}:candidate`),
    instanceKey,
    cutoff,
    identityMemo,
    identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo),
    descriptorHash: h(`${familyId}:descriptor`),
    staticProjectionMemoHash: h(`${familyId}:memo`),
    requestedArtifactDependencyRoot: h(`${familyId}:dependencies`),
    validityDependencyRoot: h(`${familyId}:validity`),
    transitions: [Object.freeze({
      inputAssetPorts: [Object.freeze({ ...input, portRef: h(`${familyId}:input-port`), ordinal: "0" })],
      outputAssetPorts: [Object.freeze({ ...output, portRef: h(`${familyId}:output-port`), ordinal: "0" })],
      opaqueTransitionRef: h(`${familyId}:transition`),
      constraintRefs: Object.freeze([]),
      staticProjectionHash: h(`${familyId}:projection`),
    })],
    evidenceRoot: h(`${familyId}:evidence`),
  });
}

test("root-owned Ready reader reopens exact real multi-chunk catalog and Graph closures", () => {
  const catalog = sealInstanceCatalog(cutoff, Array.from({ length: 257 }, (_, index) => publication(index)));
  const encodedCatalog = encodeInstanceCatalogV1(catalog);
  const graph = buildPersistedGraph(catalog);
  const encodedGraph = encodePersistedGraphV1(graph);
  assert.ok(encodedCatalog.chunks.length >= 3);
  assert.ok(encodedGraph.chunks.length >= 3);

  const catalogClosure = physicalLinkedClosure(
    encodedCatalog.manifestBytes,
    encodedCatalog.chunks,
    "aloha/instance-catalog-manifest/v1",
    "aloha/instance-catalog-publication-chunk/v1",
  );
  const catalogReader = exactLinkedChunkReader<InstanceCatalogPublicationChunkRefV1>(
    catalogClosure.manifest,
    readFrom(catalogClosure.records),
    "aloha/instance-catalog-publication-chunk/v1",
    "test Ready instance catalog",
  );
  const reopenedCatalog = decodeInstanceCatalogV1(encodedCatalog.manifestBytes, catalogReader.readChunk);
  catalogReader.assertComplete();
  assert.equal(reopenedCatalog.publications.length, 257);
  assert.equal(reopenedCatalog.instanceCatalogRoot, catalog.instanceCatalogRoot);

  const graphClosure = physicalLinkedClosure(
    encodedGraph.manifestBytes,
    encodedGraph.chunks,
    "aloha/persisted-graph-manifest/v1",
    "aloha/persisted-graph-edge-chunk/v1",
  );
  const graphReader = exactLinkedChunkReader<PersistedGraphEdgeChunkRefV1>(
    graphClosure.manifest,
    readFrom(graphClosure.records),
    "aloha/persisted-graph-edge-chunk/v1",
    "test Ready persisted Graph",
  );
  const reopenedGraph = decodePersistedGraphV1(encodedGraph.manifestBytes, graphReader.readChunk, reopenedCatalog);
  graphReader.assertComplete();
  assert.equal(reopenedGraph.edges.length, 257);
  assert.equal(reopenedGraph.graphRoot, graph.graphRoot);

  const missingMiddleManifest = contentRecord(
    catalogClosure.manifest.kind,
    catalogClosure.manifest.bytes,
    catalogClosure.manifest.references.filter(hash => hash !== catalogClosure.chunkStorageHashes[1]),
  );
  const missingMiddleReader = exactLinkedChunkReader<InstanceCatalogPublicationChunkRefV1>(
    missingMiddleManifest,
    readFrom(catalogClosure.records),
    "aloha/instance-catalog-publication-chunk/v1",
    "test Ready instance catalog",
  );
  assert.throws(
    () => decodeInstanceCatalogV1(encodedCatalog.manifestBytes, missingMiddleReader.readChunk),
    /linked chunk is not referenced/,
  );

  const extraCatalog = sealInstanceCatalog(cutoff, [publication(999)]);
  const extraGraphChunk = encodePersistedGraphV1(buildPersistedGraph(extraCatalog)).chunks[0]!;
  const extraRecord = contentRecord("aloha/persisted-graph-edge-chunk/v1", extraGraphChunk.bytes);
  const graphRecordsWithExtra = new Map(graphClosure.records).set(extraRecord.hash, extraRecord);
  const extraPhysicalManifest = contentRecord(
    graphClosure.manifest.kind,
    graphClosure.manifest.bytes,
    [...graphClosure.manifest.references, extraRecord.hash].sort(),
  );
  const extraPhysicalReader = exactLinkedChunkReader<PersistedGraphEdgeChunkRefV1>(
    extraPhysicalManifest,
    readFrom(graphRecordsWithExtra),
    "aloha/persisted-graph-edge-chunk/v1",
    "test Ready persisted Graph",
  );
  decodePersistedGraphV1(encodedGraph.manifestBytes, extraPhysicalReader.readChunk, reopenedCatalog);
  assert.throws(extraPhysicalReader.assertComplete, /physical chunk closure is not exact/);

  const firstGraphChunk = decodeCanonicalBytes(encodedGraph.chunks[0]!.bytes) as Record<string, unknown>;
  const skipMiddleBytes = encodeCanonicalBytes({
    ...firstGraphChunk,
    nextEdgeChunkRef: encodedGraph.chunks[2]!.ref,
  });
  const graphManifest = decodeCanonicalBytes(encodedGraph.manifestBytes) as Record<string, unknown>;
  const skipMiddleManifestBytes = encodeCanonicalBytes({
    ...graphManifest,
    firstEdgeChunkRef: { contentSha256: sha256Hex(skipMiddleBytes) },
  });
  const skipMiddleClosure = physicalLinkedClosure(
    skipMiddleManifestBytes,
    [{ bytes: skipMiddleBytes }, ...encodedGraph.chunks.slice(1)],
    "aloha/persisted-graph-manifest/v1",
    "aloha/persisted-graph-edge-chunk/v1",
  );
  const skipMiddleReader = exactLinkedChunkReader<PersistedGraphEdgeChunkRefV1>(
    skipMiddleClosure.manifest,
    readFrom(skipMiddleClosure.records),
    "aloha/persisted-graph-edge-chunk/v1",
    "test Ready persisted Graph",
  );
  assert.throws(
    () => decodePersistedGraphV1(skipMiddleManifestBytes, skipMiddleReader.readChunk, reopenedCatalog),
    /edge chunk binding mismatch/,
  );

  const duplicatePhysicalManifest = contentRecord(
    catalogClosure.manifest.kind,
    catalogClosure.manifest.bytes,
    [...catalogClosure.manifest.references, catalogClosure.manifest.references[0]!],
  );
  assert.throws(
    () => exactLinkedChunkReader(
      duplicatePhysicalManifest,
      readFrom(catalogClosure.records),
      "aloha/instance-catalog-publication-chunk/v1",
      "test Ready instance catalog",
    ),
    /duplicate physical references/,
  );
});

test("active Ready manifest consumes all and only exact durable chunks", () => {
  const bytesA = Uint8Array.from([1, 2, 3]);
  const bytesB = Uint8Array.from([4, 5, 6]);
  const storageA = h("storage-a");
  const storageB = h("storage-b");
  const content = new Map<Hash, Readonly<{
    hash: Hash;
    payloadHash: Hash;
    kind: string;
    bytes: Uint8Array;
    references: readonly Hash[];
  }>>([
    [storageA, Object.freeze({ hash: storageA, payloadHash: sha256Hex(bytesA), kind: "chunk-kind", bytes: bytesA, references: Object.freeze([]) })],
    [storageB, Object.freeze({ hash: storageB, payloadHash: sha256Hex(bytesB), kind: "chunk-kind", bytes: bytesB, references: Object.freeze([]) })],
  ]);
  const manifest = (references: readonly Hash[]) => Object.freeze({
    hash: h("manifest"),
    payloadHash: h("manifest-payload"),
    kind: "manifest-kind",
    bytes: new Uint8Array(),
    references: Object.freeze(references),
  });
  const read = (hash: Hash) => {
    const record = content.get(hash);
    if (record === undefined) throw new TypeError("missing durable chunk");
    return record;
  };

  const exact = exactLinkedChunkReader<{ readonly contentSha256: Hash }>(
    manifest([storageA]), read, "chunk-kind", "fixture",
  );
  assert.deepEqual(exact.readChunk({ contentSha256: sha256Hex(bytesA) }), bytesA);
  assert.doesNotThrow(exact.assertComplete);

  const missing = exactLinkedChunkReader<{ readonly contentSha256: Hash }>(
    manifest([storageA]), read, "chunk-kind", "fixture",
  );
  assert.throws(() => missing.readChunk({ contentSha256: h("missing-content") }), /not referenced/);

  const truncated = exactLinkedChunkReader<{ readonly contentSha256: Hash }>(
    manifest([storageA]), read, "chunk-kind", "fixture",
  );
  assert.throws(() => truncated.readChunk({ contentSha256: sha256Hex(Uint8Array.from([1, 2])) }), /not referenced/);

  const reused = exactLinkedChunkReader<{ readonly contentSha256: Hash }>(
    manifest([storageA]), read, "chunk-kind", "fixture",
  );
  reused.readChunk({ contentSha256: sha256Hex(bytesA) });
  assert.throws(() => reused.readChunk({ contentSha256: sha256Hex(bytesA) }), /reused/);

  const extra = exactLinkedChunkReader<{ readonly contentSha256: Hash }>(
    manifest([storageA, storageB].sort()), read, "chunk-kind", "fixture",
  );
  extra.readChunk({ contentSha256: sha256Hex(bytesA) });
  assert.throws(extra.assertComplete, /closure is not exact/);

  assert.throws(() => exactLinkedChunkReader(
    manifest([storageA]), read, "foreign-kind", "fixture",
  ), /chunk kind/);

  const catalogManifest = encodeCanonicalBytes(Object.freeze({
    schemaVersion: 1,
    kind: "aloha.instance-catalog-manifest-v1",
    cutoff: Object.freeze({ chainId: "1", number: "1", hash: h("cutoff"), stateRoot: h("state-root") }),
    instanceCount: "2",
    publicationSequenceRoot: h("publication-sequence"),
    publicationChunkCount: "2",
    firstPublicationChunkRef: Object.freeze({ contentSha256: sha256Hex(bytesA) }),
    instanceCatalogRoot: h("instance-catalog"),
  }));
  assert.throws(
    () => decodeInstanceCatalogV1(catalogManifest, () => bytesB),
    /chunk content mismatch/,
  );
});

test("descriptor-bound SQLite reads cannot be redirected by atomic path replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "aloha-ready-graph-fd-"));
  const expectedPath = join(root, "frozen-b.sqlite");
  const replacementPath = join(root, "replacement.sqlite");
  const create = (path: string, marker: string): void => {
    const database = new DatabaseSync(path);
    try {
      database.exec("CREATE TABLE marker(value TEXT NOT NULL)");
      database.prepare("INSERT INTO marker(value) VALUES (?)").run(marker);
    } finally {
      database.close();
    }
  };
  create(expectedPath, "published-a");
  create(replacementPath, "foreign-b");
  const descriptor = openSync(expectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    renameSync(replacementPath, expectedPath);
    const bound = new DatabaseSync(`/dev/fd/${descriptor}`, { readOnly: true });
    const redirected = new DatabaseSync(expectedPath, { readOnly: true });
    try {
      assert.equal((bound.prepare("SELECT value FROM marker").get() as Record<string, unknown>).value, "published-a");
      assert.equal((redirected.prepare("SELECT value FROM marker").get() as Record<string, unknown>).value, "foreign-b");
    } finally {
      bound.close();
      redirected.close();
    }
    const source = readFileSync(
      join(import.meta.dirname, "../src/internal/pre-release-b-active-ready-graph-owner.ts"),
      "utf8",
    );
    assert.match(source, /openPublishedRootSnapshot\(publication, expectedPath\)/);
    assert.match(source, /new DatabaseSync\(`\/dev\/fd\/\$\{snapshotFd\}`/);
    assert.ok((source.match(/assertPublishedDescriptor\(snapshotFd, publication, expectedPath\)/g) ?? []).length >= 1);
    assert.match(source, /pathAfter\.dev !== after\.dev \|\| pathAfter\.ino !== after\.ino/);
    assert.match(source, /aloha\/instance-catalog-manifest\/v1/);
    assert.match(source, /decodeInstanceCatalogV1\(catalogRecord\.bytes, catalogChunks\.readChunk\)/);
    assert.match(source, /aloha\/persisted-graph-manifest\/v1/);
    assert.match(source, /decodePersistedGraphV1\(graphRecord\.bytes, graphChunks\.readChunk, catalog\)/);
    assert.doesNotMatch(source, /const INSTANCE_CATALOG_KIND = "aloha\/instance-catalog\/v1"/);
    assert.doesNotMatch(source, /const GRAPH_KIND = "aloha\/persisted-graph\/v1"/);
  } finally {
    closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  }
});
