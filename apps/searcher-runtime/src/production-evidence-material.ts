import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertPlainObject,
  decodeCanonicalBytes,
  deepFreeze,
  encodeCanonicalBytes,
  hashCanonicalPartition,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import type {
  DurableContentRecord,
  DurableTransaction,
  SQLiteDurableStore,
} from "../../../packages/durable-store/src/index.ts";

export type SearcherProductionEvidenceMaterialKindV1 =
  | "route-accounting-entries"
  | "candidate-terminal-observations";

export interface SearcherProductionEvidenceMaterialManifestV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.searcher-production-evidence-material-manifest-v1";
  readonly materialKind: SearcherProductionEvidenceMaterialKindV1;
  readonly bindingRoot: Hash;
  readonly entryCount: string;
  readonly chunkCount: string;
  readonly firstChunkHash: Hash | null;
  readonly entrySequenceRoot: Hash;
}

interface SearcherProductionEvidenceMaterialChunkV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.searcher-production-evidence-material-chunk-v1";
  readonly entries: readonly CanonicalJson[];
  readonly nextChunkHash: Hash | null;
}

const MATERIAL_CHUNK_KIND = "aloha/searcher-production-evidence-material-chunk/v1";
const MATERIAL_INDEX_NAMESPACE = "searcher-production-evidence-material/v1";
const MATERIAL_INITIAL_CHUNK_ITEMS = 128;

function nonZeroHash(value: unknown, path: string): Hash {
  const hash = assertHash(value, path);
  if (hash === `0x${"0".repeat(64)}`) throw new TypeError(`${path} must be non-zero`);
  return hash;
}

function safeDecimalCount(value: string, path: string): number {
  const count = BigInt(value);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError(`${path} exceeds the safe material bound`);
  return Number(count);
}

export function searcherProductionEvidenceOrderedRootV1(
  domain: string,
  values: readonly Hash[],
): Hash {
  return hashCanonicalPartition(domain, values, 128);
}

function materialEntrySequenceRoot(
  materialKind: SearcherProductionEvidenceMaterialKindV1,
  roots: readonly Hash[],
): Hash {
  return searcherProductionEvidenceOrderedRootV1(
    `aloha/searcher-production-evidence-material/${materialKind}/entries/v1`,
    roots,
  );
}

function makeChunk(input: {
  readonly entries: readonly CanonicalJson[];
  readonly nextChunkHash: Hash | null;
}): Readonly<{ readonly chunk: SearcherProductionEvidenceMaterialChunkV1; readonly bytes: Uint8Array }> {
  const chunk = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.searcher-production-evidence-material-chunk-v1" as const,
    entries: Object.freeze([...input.entries]),
    nextChunkHash: input.nextChunkHash,
  });
  return Object.freeze({ chunk, bytes: encodeCanonicalBytes(chunk) });
}

/** Persist a complete high-cardinality preimage as immutable linked chunks.
 * The returned manifest is bounded and can safely be embedded in one append
 * event. Unreachable chunks left by a process crash are not authority. */
function persistSearcherProductionEvidenceMaterialWithWriterV1(
  writer: Pick<DurableTransaction, "putImmutable" | "readContent" | "getIndex" | "setIndex">,
  input: Readonly<{
    readonly materialKind: SearcherProductionEvidenceMaterialKindV1;
    readonly bindingRoot: Hash;
    readonly entries: readonly CanonicalJson[];
    readonly entryRoots: readonly Hash[];
  }>,
): SearcherProductionEvidenceMaterialManifestV1 {
  const bindingRoot = nonZeroHash(input.bindingRoot, "productionEvidenceMaterial.bindingRoot");
  if (input.entries.length !== input.entryRoots.length) throw new TypeError("production evidence material entry/root count mismatch");
  const entryRoots = input.entryRoots.map((root, index) => nonZeroHash(root, `productionEvidenceMaterial.entryRoots[${index}]`));
  const groups: Array<readonly CanonicalJson[]> = [];
  for (let first = 0; first < input.entries.length; first += MATERIAL_INITIAL_CHUNK_ITEMS) {
    groups.push(Object.freeze(input.entries.slice(first, first + MATERIAL_INITIAL_CHUNK_ITEMS)));
  }
  for (;;) {
    const hashes = new Array<Hash>(groups.length);
    let nextChunkHash: Hash | null = null;
    let failedIndex = -1;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index]!;
      try {
        const encoded = makeChunk({
          entries: group,
          nextChunkHash,
        });
        const hash: Hash = writer.putImmutable(
          MATERIAL_CHUNK_KIND,
          encoded.bytes,
          nextChunkHash === null ? [] : [nextChunkHash],
        );
        const persisted = writer.readContent(hash);
        if (persisted === null || persisted.kind !== MATERIAL_CHUNK_KIND
          || Buffer.compare(Buffer.from(persisted.bytes), Buffer.from(encoded.bytes)) !== 0) {
          throw new TypeError("production evidence material durable content mismatch");
        }
        hashes[index] = hash;
        nextChunkHash = hash;
      } catch (error) {
        if (group.length <= 1) throw error;
        failedIndex = index;
        break;
      }
    }
    if (failedIndex === -1) {
      const manifest = deepFreeze({
        schemaVersion: 1 as const,
        kind: "aloha.searcher-production-evidence-material-manifest-v1" as const,
        materialKind: input.materialKind,
        bindingRoot,
        entryCount: String(input.entries.length),
        chunkCount: String(hashes.length),
        firstChunkHash: hashes[0] ?? null,
        entrySequenceRoot: materialEntrySequenceRoot(input.materialKind, entryRoots),
      });
      const firstChunkHash = hashes[0] ?? null;
      const existing = writer.getIndex(MATERIAL_INDEX_NAMESPACE, bindingRoot);
      if (existing !== null && existing !== firstChunkHash) {
        throw new TypeError("production evidence material binding is already sealed to different content");
      }
      if (existing === null && firstChunkHash !== null) {
        writer.setIndex(MATERIAL_INDEX_NAMESPACE, bindingRoot, firstChunkHash);
      }
      return manifest;
    }
    const failed = groups[failedIndex]!;
    const middle = Math.ceil(failed.length / 2);
    groups.splice(failedIndex, 1,
      Object.freeze(failed.slice(0, middle)),
      Object.freeze(failed.slice(middle)),
    );
  }
}

export function persistSearcherProductionEvidenceMaterialV1(
  store: SQLiteDurableStore,
  input: Readonly<{
    readonly materialKind: SearcherProductionEvidenceMaterialKindV1;
    readonly bindingRoot: Hash;
    readonly entries: readonly CanonicalJson[];
    readonly entryRoots: readonly Hash[];
  }>,
): SearcherProductionEvidenceMaterialManifestV1 {
  const lease = store.acquireWriterLease("production-evidence-material");
  try {
    return store.transaction(lease, tx => persistSearcherProductionEvidenceMaterialWithWriterV1(tx, input));
  } finally {
    store.releaseWriterLease(lease);
  }
}

function exactManifest(value: unknown, path: string): SearcherProductionEvidenceMaterialManifestV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "schemaVersion", "kind", "materialKind", "bindingRoot", "entryCount", "chunkCount",
    "firstChunkHash", "entrySequenceRoot",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "aloha.searcher-production-evidence-material-manifest-v1") throw new TypeError(`${path} schema/kind mismatch`);
  if (record.materialKind !== "route-accounting-entries" && record.materialKind !== "candidate-terminal-observations") throw new TypeError(`${path}.materialKind is invalid`);
  const materialKind = record.materialKind as SearcherProductionEvidenceMaterialKindV1;
  const manifest: SearcherProductionEvidenceMaterialManifestV1 = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.searcher-production-evidence-material-manifest-v1" as const,
    materialKind,
    bindingRoot: nonZeroHash(record.bindingRoot, `${path}.bindingRoot`),
    entryCount: assertDecimalString(record.entryCount, `${path}.entryCount`),
    chunkCount: assertDecimalString(record.chunkCount, `${path}.chunkCount`),
    firstChunkHash: record.firstChunkHash === null ? null : nonZeroHash(record.firstChunkHash, `${path}.firstChunkHash`),
    entrySequenceRoot: nonZeroHash(record.entrySequenceRoot, `${path}.entrySequenceRoot`),
  });
  if ((manifest.entryCount === "0") !== (manifest.chunkCount === "0")
    || (manifest.chunkCount === "0") !== (manifest.firstChunkHash === null)) {
    throw new TypeError(`${path} identity/count mismatch`);
  }
  return manifest;
}

function exactChunk(value: unknown, path: string): SearcherProductionEvidenceMaterialChunkV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, [
    "schemaVersion", "kind", "entries", "nextChunkHash",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== "aloha.searcher-production-evidence-material-chunk-v1") throw new TypeError(`${path} schema/kind mismatch`);
  if (!Array.isArray(record.entries) || record.entries.length === 0) throw new TypeError(`${path} entries are invalid`);
  const chunk: SearcherProductionEvidenceMaterialChunkV1 = deepFreeze({
    schemaVersion: 1 as const,
    kind: "aloha.searcher-production-evidence-material-chunk-v1" as const,
    entries: Object.freeze([...record.entries]) as readonly CanonicalJson[],
    nextChunkHash: record.nextChunkHash === null ? null : nonZeroHash(record.nextChunkHash, `${path}.nextChunkHash`),
  });
  return chunk;
}

export function readSearcherProductionEvidenceMaterialV1<T>(
  store: Pick<SQLiteDurableStore, "readContent" | "readIndex">,
  rawManifest: unknown,
  input: Readonly<{
    readonly materialKind: SearcherProductionEvidenceMaterialKindV1;
    readonly bindingRoot: Hash;
    readonly decodeEntry: (value: unknown, ordinal: number) => T;
    readonly entryRoot: (value: T, ordinal: number) => Hash;
  }>,
): Readonly<{ readonly manifest: SearcherProductionEvidenceMaterialManifestV1; readonly entries: readonly T[] }> {
  const manifest = exactManifest(rawManifest, "productionEvidenceMaterial.manifest");
  if (manifest.materialKind !== input.materialKind || manifest.bindingRoot !== input.bindingRoot) throw new TypeError("production evidence material manifest binding mismatch");
  if (store.readIndex(MATERIAL_INDEX_NAMESPACE, manifest.bindingRoot) !== manifest.firstChunkHash) {
    throw new TypeError("production evidence material durable index mismatch");
  }
  const entries: T[] = [];
  const entryRoots: Hash[] = [];
  const chunkHashes: Hash[] = [];
  let hash = manifest.firstChunkHash;
  const expectedEntryCount = safeDecimalCount(manifest.entryCount, "productionEvidenceMaterial.manifest.entryCount");
  const expectedChunkCount = safeDecimalCount(manifest.chunkCount, "productionEvidenceMaterial.manifest.chunkCount");
  while (hash !== null) {
    if (chunkHashes.includes(hash)) throw new TypeError("production evidence material chunk chain contains a duplicate/cycle");
    if (chunkHashes.length >= expectedChunkCount) throw new TypeError("production evidence material chunk chain exceeds manifest count");
    const content: DurableContentRecord | null = store.readContent(hash);
    if (content === null || content.hash !== hash || content.kind !== MATERIAL_CHUNK_KIND) throw new TypeError("production evidence material chunk is missing");
    const chunk = exactChunk(decodeCanonicalBytes(content.bytes), `productionEvidenceMaterial.chunks[${chunkHashes.length}]`);
    if (content.references.length !== (chunk.nextChunkHash === null ? 0 : 1)
      || (chunk.nextChunkHash !== null && content.references[0] !== chunk.nextChunkHash)) {
      throw new TypeError("production evidence material chunk order/binding mismatch");
    }
    for (let index = 0; index < chunk.entries.length; index += 1) {
      const ordinal = entries.length;
      const entry = input.decodeEntry(chunk.entries[index], ordinal);
      const root = input.entryRoot(entry, ordinal);
      entries.push(entry);
      entryRoots.push(root);
    }
    chunkHashes.push(hash);
    hash = chunk.nextChunkHash;
  }
  if (entries.length !== expectedEntryCount || chunkHashes.length !== expectedChunkCount
    || manifest.entrySequenceRoot !== materialEntrySequenceRoot(manifest.materialKind, entryRoots)) {
    throw new TypeError("production evidence material closure mismatch");
  }
  return Object.freeze({ manifest, entries: Object.freeze(entries) });
}
