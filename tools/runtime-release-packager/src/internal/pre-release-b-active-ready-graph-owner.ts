import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  validateInstanceCatalog,
  type InstanceCatalogV1,
} from "../../../../packages/catalog/src/index.ts";
import { fullGraphTransitionSequenceRootV1 } from "../../../../packages/full-graph-coarse-sweep/src/index.ts";
import {
  buildPersistedGraph,
  type PersistedGraphV1,
} from "../../../../packages/graph/src/index.ts";
import { CHECKPOINT_SCHEMA_AUTHORITY } from "../../../../packages/checkpoint/src/index.ts";
import {
  derivePlannerCompatibleReadyGraphTransitionsV1,
  type ProductionActiveReadyGraphSnapshotV1,
} from "../../../../acceptance/collectors/src/internal/terminal-phase-snapshot-trust-state.ts";
import type {
  PreReleaseControllerDatabaseSnapshotPublicationV1,
} from "../../../pre-release-restart-controller/src/durable-owner.ts";

const CONTENT_DOMAIN = "aloha/durable-content-envelope/v1";
const ROOT_KIND = "aloha/durable-root-envelope/v1";
const READY_CLOSURE_KIND = "aloha/ready-closure/v1";
const INSTANCE_CATALOG_KIND = "aloha/instance-catalog/v1";
const GRAPH_KIND = "aloha/persisted-graph/v1";

interface RawContentV1 {
  readonly hash: Hash;
  readonly payloadHash: Hash;
  readonly kind: string;
  readonly bytes: Uint8Array;
  readonly references: readonly Hash[];
}

function exactRefs(value: unknown, path: string): readonly Hash[] {
  const decoded = typeof value === "string" ? decodeCanonicalJson(value) : value;
  if (!Array.isArray(decoded)) throw new TypeError(`${path} must be an array`);
  const refs = decoded.map((item, index) => assertHash(item, `${path}[${index}]`));
  for (let index = 1; index < refs.length; index += 1) {
    if (refs[index - 1]! >= refs[index]!) throw new TypeError(`${path} must be strictly sorted and unique`);
  }
  return Object.freeze(refs);
}

function same(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function readDescriptorBytes(fd: number, byteLength: bigint): Uint8Array {
  const length = Number(byteLength);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError("frozen pre-release B active Ready Graph snapshot is too large");
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
    if (count === 0) throw new TypeError("frozen pre-release B active Ready Graph snapshot was truncated");
    offset += count;
  }
  return bytes;
}

function assertFixedRootSnapshotPath(
  publication: PreReleaseControllerDatabaseSnapshotPublicationV1,
  expectedPath: string,
): void {
  try {
    if (typeof process.geteuid !== "function" || process.geteuid() !== 0
      || publication.snapshotPath !== expectedPath
      || realpathSync(expectedPath) !== expectedPath || !lstatSync(expectedPath).isFile()) {
      throw new TypeError("mismatch");
    }
  } catch {
    throw new TypeError("frozen pre-release B active Ready Graph source is not the fixed root-owned snapshot");
  }
}

function assertPublishedDescriptor(
  fd: number,
  publication: PreReleaseControllerDatabaseSnapshotPublicationV1,
  expectedPath: string,
): void {
  assertFixedRootSnapshotPath(publication, expectedPath);
  const before = fstatSync(fd, { bigint: true });
  const pathBefore = statSync(expectedPath, { bigint: true });
  const bytes = readDescriptorBytes(fd, before.size);
  const after = fstatSync(fd, { bigint: true });
  const pathAfter = statSync(expectedPath, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino
    || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino
    || after.uid !== 0n || after.gid !== 0n || (after.mode & 0o777n) !== 0o600n
    || publication.device !== String(after.dev) || publication.inode !== String(after.ino)
    || publication.byteLength !== String(bytes.byteLength) || publication.contentSha256 !== sha256Hex(bytes)
    || publication.uid !== "0" || publication.gid !== "0" || publication.mode !== "384"
    || publication.fileFsynced !== true || publication.directoryFsynced !== true) {
    throw new TypeError("frozen pre-release B active Ready Graph snapshot publication mismatch");
  }
}

function openPublishedRootSnapshot(
  publication: PreReleaseControllerDatabaseSnapshotPublicationV1,
  expectedPath: string,
): number {
  assertFixedRootSnapshotPath(publication, expectedPath);
  const fd = openSync(expectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertPublishedDescriptor(fd, publication, expectedPath);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Root-owned reader for the active Ready Graph. It never derives the Graph
 * denominator from acceptance artifacts or from the coarse sweep itself. */
export function observeFrozenPreReleaseBActiveReadyGraphV1(
  publication: PreReleaseControllerDatabaseSnapshotPublicationV1,
  expectedPath: string,
): ProductionActiveReadyGraphSnapshotV1 {
  const snapshotFd = openPublishedRootSnapshot(publication, expectedPath);
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(`/dev/fd/${snapshotFd}`, { readOnly: true });
  } catch (error) {
    closeSync(snapshotFd);
    throw error;
  }
  let transaction = false;
  try {
    database.exec("PRAGMA query_only=ON");
    const integrity = database.prepare("PRAGMA integrity_check").all() as readonly Record<string, unknown>[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new TypeError("frozen pre-release B active Ready Graph SQLite integrity check failed");
    }
    database.exec("BEGIN");
    transaction = true;
    const roles = database.prepare("SELECT store_role FROM durable_store_identity").all() as readonly Record<string, unknown>[];
    if (roles.length !== 1 || roles[0]?.store_role !== "checkpoint") {
      throw new TypeError("frozen pre-release B active Ready Graph store role mismatch");
    }
    const roots = database.prepare("SELECT revision, envelope_hash FROM durable_root WHERE root_id=1").all() as readonly Record<string, unknown>[];
    if (roots.length !== 1) throw new TypeError("frozen pre-release B active Ready Graph has no unique checkpoint root");
    const checkpointRevision = assertDecimalString(roots[0]!.revision, "activeReadyGraph.checkpointRevision");
    const checkpointRootEnvelopeHash = assertHash(roots[0]!.envelope_hash, "activeReadyGraph.checkpointRootEnvelopeHash");
    const cached = new Map<Hash, RawContentV1>();
    const readContent = (hashValue: unknown): RawContentV1 => {
      const hash = assertHash(hashValue, "activeReadyGraph.content.hash");
      const prior = cached.get(hash);
      if (prior !== undefined) return prior;
      const raw = database.prepare(
        "SELECT hash, payload_hash, kind, bytes, byte_length, references_json FROM durable_content WHERE hash=?",
      ).get(hash);
      assertPlainObject(raw, `activeReadyGraph.content[${hash}]`);
      assertExactKeys(raw, ["hash", "payload_hash", "kind", "bytes", "byte_length", "references_json"], `activeReadyGraph.content[${hash}]`);
      const row = raw as Record<string, unknown>;
      if (!(row.bytes instanceof Uint8Array)) throw new TypeError("active Ready Graph durable content bytes are not concrete");
      const bytes = Uint8Array.from(row.bytes);
      const payloadHash = assertHash(row.payload_hash, "activeReadyGraph.content.payloadHash");
      const kind = assertNonEmptyString(row.kind, "activeReadyGraph.content.kind");
      const references = exactRefs(row.references_json, "activeReadyGraph.content.references");
      const byteLength = typeof row.byte_length === "number" ? row.byte_length : Number(row.byte_length);
      if (row.hash !== hash || !Number.isSafeInteger(byteLength) || byteLength !== bytes.byteLength
        || payloadHash !== sha256Hex(bytes)
        || hashDomain(CONTENT_DOMAIN, { kind, payloadHash, references }) !== hash) {
        throw new TypeError("active Ready Graph durable content identity mismatch");
      }
      const content = Object.freeze({ hash, payloadHash, kind, bytes, references });
      cached.set(hash, content);
      return content;
    };
    const rootRecord = readContent(checkpointRootEnvelopeHash);
    if (rootRecord.kind !== ROOT_KIND) throw new TypeError("active Ready Graph checkpoint root content kind mismatch");
    const root = CHECKPOINT_SCHEMA_AUTHORITY.decodeRoot(rootRecord.bytes);
    if (root.revision !== checkpointRevision || root.readyGenerationId === null || root.readyGenerationRecordHash === null) {
      throw new TypeError("frozen pre-release B checkpoint has no exact active Ready pointer");
    }
    const matchingClosures = rootRecord.references.flatMap(reference => {
      const content = readContent(reference);
      if (content.kind !== READY_CLOSURE_KIND) return [];
      const closure = CHECKPOINT_SCHEMA_AUTHORITY.decodeReadyClosure(content.bytes);
      return closure.ready.readyRecordHash === root.readyGenerationRecordHash
        ? [Object.freeze({ storageHash: content.hash, content, closure })]
        : [];
    });
    if (matchingClosures.length !== 1) {
      throw new TypeError("active Ready closure is not uniquely root-reachable");
    }
    const selected = matchingClosures[0]!;
    const closure = selected.closure;
    const expectedClosureReferences = [
      closure.sourceCoverageStorageHash,
      closure.sourceExecutionSetStorageHash,
      closure.sourcePlanEvidenceStorageHash,
      closure.nominationClosureStorageHash,
      closure.candidatePartitionStorageHash,
      closure.outcomePartitionStorageHash,
      closure.attestationPartitionStorageHash,
      closure.candidatePartitionCommitmentStorageHash,
      closure.candidatePartitionProofStorageHash,
      closure.verifiedMemoSetStorageHash,
      closure.instanceCatalogStorageHash,
      closure.graphStorageHash,
    ].sort();
    if (!same(selected.content.references, expectedClosureReferences)
      || closure.ready.generationId !== root.readyGenerationId
      || closure.ready.readyRecordHash !== root.readyGenerationRecordHash) {
      throw new TypeError("active Ready closure pointer/reference mismatch");
    }
    const catalogRecord = readContent(closure.instanceCatalogStorageHash);
    const graphRecord = readContent(closure.graphStorageHash);
    if (catalogRecord.kind !== INSTANCE_CATALOG_KIND || catalogRecord.references.length !== 0
      || graphRecord.kind !== GRAPH_KIND || graphRecord.references.length !== 0) {
      throw new TypeError("active Ready catalog/Graph physical closure mismatch");
    }
    const catalog = decodeCanonicalJson(catalogRecord.bytes) as unknown as InstanceCatalogV1;
    validateInstanceCatalog(catalog);
    const graph = decodeCanonicalJson(graphRecord.bytes) as unknown as PersistedGraphV1;
    const rebuilt = buildPersistedGraph(catalog);
    if (!same(graph, rebuilt)
      || graph.graphRoot !== closure.ready.graphRoot
      || graph.edgeCount !== closure.ready.edgeCount
      || graph.instanceCatalogRoot !== closure.ready.instanceCatalogRoot
      || !same(graph.cutoff, closure.ready.cutoff)
      || graph.edgeCount !== String(graph.edges.length)
      || graph.edges.length === 0) {
      throw new TypeError("active Ready Graph bytes are not the root-reachable catalog projection");
    }
    const familyCounts = new Map<string, number>();
    for (const edge of graph.edges) {
      familyCounts.set(edge.owningFamilyId, (familyCounts.get(edge.owningFamilyId) ?? 0) + 1);
    }
    const orderedTransitions = derivePlannerCompatibleReadyGraphTransitionsV1(graph.edges);
    const transitionFamilyCounts = new Map<string, number>();
    for (const transition of orderedTransitions) {
      transitionFamilyCounts.set(
        transition.owningFamilyId,
        (transitionFamilyCounts.get(transition.owningFamilyId) ?? 0) + 1,
      );
    }
    const output = Object.freeze({
      checkpointRootEnvelopeHash,
      checkpointRevision,
      readyClosureStorageHash: selected.storageHash,
      readyRecordHash: closure.ready.readyRecordHash,
      generationId: closure.ready.generationId,
      releaseProvenanceHash: closure.ready.releaseProvenanceHash,
      cutoff: graph.cutoff,
      instanceCatalogRoot: graph.instanceCatalogRoot,
      instanceCatalogStorageHash: closure.instanceCatalogStorageHash,
      graphStorageHash: closure.graphStorageHash,
      graphRoot: graph.graphRoot,
      edgeCount: graph.edgeCount,
      orderedEdgeIds: Object.freeze(graph.edges.map(edge => edge.edgeId)),
      orderedEdges: graph.edges,
      expectedTransitionCount: String(orderedTransitions.length),
      expectedTransitionRoot: fullGraphTransitionSequenceRootV1(
        "expected",
        orderedTransitions.map(transition => transition.transitionId),
      ),
      orderedTransitions,
      familyEdgeCounts: Object.freeze([...familyCounts.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([familyId, count]) => Object.freeze({ familyId, edgeCount: String(count) }))),
      familyTransitionCounts: Object.freeze([...transitionFamilyCounts.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([familyId, count]) => Object.freeze({ familyId, transitionCount: String(count) }))),
    });
    database.exec("ROLLBACK");
    transaction = false;
    return output;
  } finally {
    if (transaction) try { database.exec("ROLLBACK"); } catch { /* preserve observation error */ }
    database.close();
    try {
      assertPublishedDescriptor(snapshotFd, publication, expectedPath);
    } finally {
      closeSync(snapshotFd);
    }
  }
}
