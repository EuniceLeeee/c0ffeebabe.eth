import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { candidateFinalOutcomeHash } from "../../../specs/candidate-final-outcome/src/index.ts";

const ROOT_KIND = "aloha/durable-root-envelope/v1";
const RUN_KIND = "aloha/in-progress-run/v2";
const PARTITION_MANIFEST_KIND = "aloha/checkpoint-partition-manifest/v1";
const PARTITION_PAGE_KIND = "aloha/checkpoint-partition-page/v1";
const CANDIDATE_KIND = "aloha/candidate-record/v2";
const OUTCOME_KIND = "aloha/candidate-final-outcome/v1";
const PARTIAL_KIND = "aloha/attestation-partial-outcome/v1";
const CONTENT_DOMAIN = "aloha/durable-content-envelope/v1";

const ROOT_FIELDS = ["revision", "verifiedMemoRoot", "inProgressRunId", "stagedReadyStorageHash", "latestMemoSeedReceiptHash", "memoSeedSequence", "memoSeedLineageRoot", "latestProbeReceiptHash", "probeReceiptSequence", "probeReceiptLineageRoot", "readyGenerationId", "readyGenerationRecordHash", "schemaHash"] as const;
const RUN_FIELDS = ["runId", "parentGenerationId", "checkpointRevision", "candidatePartitionRevision", "cutoff", "recentObservationRoot", "recentObservationStorageHash", "definitionCatalogRoot", "sourceCoverageRoot", "sourceCoverageStorageHash", "sourceExecutionSetRoot", "sourceExecutionSetStorageHash", "sourcePlanEvidenceStorageHash", "nominationClosureRoot", "nominationClosureStorageHash", "candidatePartitionRoot", "candidatePartitionStorageHash", "candidatePartitionProofStorageHash", "candidateRecordCount", "outcomePartitionRoot", "outcomePartitionStorageHash", "partialOutcomePartitionStorageHash", "attestationPartitionStorageHash", "verifiedMemoSetRoot", "verifiedMemoSetStorageHash", "accounting"] as const;

interface ReadonlyStatement {
  get(...parameters: readonly (string | number | bigint | Uint8Array | null)[]): unknown;
}

interface ReadonlyDatabase {
  exec(sql: string): void;
  prepare(sql: string): ReadonlyStatement;
  close(): void;
}

interface RawContentV1 {
  readonly hash: Hash;
  readonly payloadHash: Hash;
  readonly kind: string;
  readonly bytes: Uint8Array;
  readonly references: readonly Hash[];
}

export interface RawCheckpointRestartSnapshotObservationV1 {
  readonly checkpointStore: Readonly<{ readonly path: string; readonly device: string; readonly inode: string }>;
  readonly checkpointRevision: string;
  readonly checkpointRootEnvelopeHash: Hash;
  readonly runEnvelopeStorageHash: Hash;
  readonly runId: string;
  readonly cutoff: Readonly<{ readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash }>;
  readonly candidatePartitionRoot: Hash;
  readonly outcomePartitionRoot: Hash;
  readonly candidates: readonly Readonly<Record<string, unknown>>[];
  readonly partials: readonly Readonly<Record<string, unknown>>[];
  readonly outcomes: readonly Readonly<Record<string, unknown>>[];
  readonly outcomeHashes: readonly Hash[];
  readonly probeEvidence: Readonly<Record<string, unknown>> | null;
  readonly rawContentRoot: Hash;
  readonly rawContents: readonly RawContentV1[];
}

function same(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function physicalReferences(values: readonly Hash[]): readonly Hash[] {
  return Object.freeze([...new Set(values)].sort());
}

function absolutePhysicalFile(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || !existsSync(value)) {
    throw new TypeError("checkpoint restart database path is not an absolute existing file");
  }
  const physical = realpathSync(value);
  if (!lstatSync(physical).isFile()) throw new TypeError("checkpoint restart database path is not a regular file");
  return physical;
}

function openReadonly(path: string): ReadonlyDatabase {
  return new DatabaseSync(path, { readOnly: true }) as unknown as ReadonlyDatabase;
}

function exactReferences(value: unknown, path: string): readonly Hash[] {
  const decoded = typeof value === "string" ? decodeCanonicalJson(value) : value;
  if (!Array.isArray(decoded)) throw new TypeError(`${path} must be an array`);
  const refs = decoded.map((entry, index) => assertHash(entry, `${path}[${index}]`));
  for (let index = 1; index < refs.length; index += 1) if (refs[index - 1]! >= refs[index]!) throw new TypeError(`${path} is not sorted unique`);
  return Object.freeze(refs);
}

function contentReader(database: ReadonlyDatabase) {
  const observed = new Map<Hash, RawContentV1>();
  const read = (hashValue: unknown): RawContentV1 => {
    const hash = assertHash(hashValue, "checkpointContent.hash");
    const cached = observed.get(hash);
    if (cached) return cached;
    const raw = database.prepare(
      "SELECT hash, payload_hash, kind, bytes, byte_length, references_json FROM durable_content WHERE hash=?",
    ).get(hash);
    assertPlainObject(raw, `checkpointContent[${hash}]`);
    assertExactKeys(raw, ["hash", "payload_hash", "kind", "bytes", "byte_length", "references_json"], `checkpointContent[${hash}]`);
    const row = raw as Record<string, unknown>;
    if (!(row.bytes instanceof Uint8Array)) throw new TypeError(`checkpoint content ${hash} bytes are not concrete`);
    const bytes = Uint8Array.from(row.bytes);
    const payloadHash = assertHash(row.payload_hash, `checkpointContent[${hash}].payload_hash`);
    if (payloadHash !== sha256Hex(bytes)) throw new TypeError(`checkpoint content ${hash} payload hash mismatch`);
    const byteLength = typeof row.byte_length === "number" ? row.byte_length : Number(row.byte_length);
    if (!Number.isSafeInteger(byteLength) || byteLength !== bytes.byteLength) throw new TypeError(`checkpoint content ${hash} byte length mismatch`);
    const kind = assertNonEmptyString(row.kind, `checkpointContent[${hash}].kind`);
    const references = exactReferences(row.references_json, `checkpointContent[${hash}].references`);
    const observedHash = assertHash(row.hash, `checkpointContent[${hash}].hash`);
    const expected = hashDomain(CONTENT_DOMAIN, { kind, payloadHash, references });
    if (observedHash !== hash || expected !== hash) throw new TypeError(`checkpoint content ${hash} envelope hash mismatch`);
    const value = Object.freeze({ hash, payloadHash, kind, bytes, references });
    observed.set(hash, value);
    return value;
  };
  return Object.freeze({ read, observed });
}

function exactCutoff(value: unknown, path: string) {
  assertPlainObject(value, path);
  assertExactKeys(value, ["chainId", "number", "hash", "stateRoot"], path);
  const raw = value as Record<string, unknown>;
  return Object.freeze({
    chainId: assertNonEmptyString(raw.chainId, `${path}.chainId`),
    number: assertDecimalString(raw.number, `${path}.number`),
    hash: assertHash(raw.hash, `${path}.hash`),
    stateRoot: assertHash(raw.stateRoot, `${path}.stateRoot`),
  });
}

function exactCheckpointStore(value: unknown, physicalPath: string) {
  assertPlainObject(value, "checkpointRestartSnapshot.checkpointStore");
  assertExactKeys(value, ["path", "device", "inode"], "checkpointRestartSnapshot.checkpointStore");
  const store = value as Record<string, unknown>;
  const declaredPath = assertNonEmptyString(store.path, "checkpointRestartSnapshot.checkpointStore.path");
  const device = assertDecimalString(store.device, "checkpointRestartSnapshot.checkpointStore.device");
  const inode = assertDecimalString(store.inode, "checkpointRestartSnapshot.checkpointStore.inode");
  const before = statSync(physicalPath, { bigint: true });
  const after = statSync(physicalPath, { bigint: true });
  if (declaredPath !== physicalPath || device !== String(after.dev) || inode !== String(after.ino)
    || before.dev !== after.dev || before.ino !== after.ino) {
    throw new TypeError("checkpoint restart physical SQLite identity mismatch");
  }
  return Object.freeze({ path: declaredPath, device, inode });
}

function partition(
  read: (hash: Hash) => RawContentV1,
  manifestHash: Hash,
  runId: string,
  kind: "candidate" | "outcome" | "partial-outcome",
): readonly Readonly<Record<string, unknown>>[] {
  const manifestRecord = read(manifestHash);
  if (manifestRecord.kind !== PARTITION_MANIFEST_KIND) throw new TypeError(`${kind} partition manifest kind mismatch`);
  const decoded = decodeCanonicalJson(manifestRecord.bytes);
  assertPlainObject(decoded, `${kind}Manifest`);
  assertExactKeys(decoded, ["runId", "partitionKind", "count", "pageStorageHashes"], `${kind}Manifest`);
  const manifest = decoded as Record<string, unknown>;
  if (manifest.runId !== runId || manifest.partitionKind !== kind || !Array.isArray(manifest.pageStorageHashes)) {
    throw new TypeError(`${kind} partition manifest binding mismatch`);
  }
  const pageHashes = manifest.pageStorageHashes.map((value, index) => assertHash(value, `${kind}Manifest.pageStorageHashes[${index}]`));
  if (!same(manifestRecord.references, physicalReferences(pageHashes))) throw new TypeError(`${kind} partition manifest physical references mismatch`);
  const values: Readonly<Record<string, unknown>>[] = [];
  const keys: string[] = [];
  for (const [pageIndex, pageHash] of pageHashes.entries()) {
    const pageRecord = read(pageHash);
    if (pageRecord.kind !== PARTITION_PAGE_KIND) throw new TypeError(`${kind} partition page kind mismatch`);
    const pageDecoded = decodeCanonicalJson(pageRecord.bytes);
    assertPlainObject(pageDecoded, `${kind}Page`);
    assertExactKeys(pageDecoded, ["runId", "partitionKind", "pageIndex", "entries"], `${kind}Page`);
    const page = pageDecoded as Record<string, unknown>;
    if (page.runId !== runId || page.partitionKind !== kind || page.pageIndex !== String(pageIndex) || !Array.isArray(page.entries)) {
      throw new TypeError(`${kind} partition page binding mismatch`);
    }
    const storageHashes: Hash[] = [];
    for (const [entryIndex, entryValue] of page.entries.entries()) {
      assertPlainObject(entryValue, `${kind}Page.entries[${entryIndex}]`);
      assertExactKeys(entryValue, ["key", "storageHash"], `${kind}Page.entries[${entryIndex}]`);
      const entry = entryValue as Record<string, unknown>;
      const key = assertNonEmptyString(entry.key, `${kind}Page.entries[${entryIndex}].key`);
      const storageHash = assertHash(entry.storageHash, `${kind}Page.entries[${entryIndex}].storageHash`);
      const content = read(storageHash);
      const expectedKind = kind === "candidate" ? CANDIDATE_KIND : kind === "outcome" ? OUTCOME_KIND : PARTIAL_KIND;
      if (content.kind !== expectedKind) throw new TypeError(`${kind} partition value kind mismatch`);
      const value = decodeCanonicalJson(content.bytes);
      assertPlainObject(value, `${kind}PartitionValue`);
      const candidateKey = (value as Record<string, unknown>).familyCandidateKey;
      if (candidateKey !== key) throw new TypeError(`${kind} partition physical key mismatch`);
      keys.push(key);
      storageHashes.push(storageHash);
      values.push(Object.freeze(value as Record<string, unknown>));
    }
    if (!same(pageRecord.references, physicalReferences(storageHashes))) throw new TypeError(`${kind} partition page physical references mismatch`);
  }
  if (assertDecimalString(manifest.count, `${kind}Manifest.count`) !== String(values.length)) throw new TypeError(`${kind} partition count mismatch`);
  for (let index = 1; index < keys.length; index += 1) if (keys[index - 1]! >= keys[index]!) throw new TypeError(`${kind} partition keys are not sorted unique`);
  return Object.freeze(values);
}

/**
 * Independently joins one owner-emitted restart snapshot to immutable raw
 * checkpoint rows.  No CheckpointStore instance, runtime capability, or
 * producer verdict is accepted by this observer.
 */
export function observeCheckpointRuntimeRestartSnapshotV1(
  databasePath: string,
  snapshotValue: unknown,
): RawCheckpointRestartSnapshotObservationV1 {
  assertPlainObject(snapshotValue, "checkpointRestartSnapshot");
  assertExactKeys(snapshotValue, [
    "checkpointStore", "checkpointRevision", "checkpointRootEnvelopeHash", "runEnvelopeStorageHash", "runId", "cutoff",
    "candidatePartitionRoot", "outcomePartitionRoot", "candidates", "partials", "outcomes", "probeEvidence",
  ], "checkpointRestartSnapshot");
  const snapshot = snapshotValue as Record<string, unknown>;
  const physicalDatabasePath = absolutePhysicalFile(databasePath);
  const checkpointStore = exactCheckpointStore(snapshot.checkpointStore, physicalDatabasePath);
  const checkpointRevision = assertDecimalString(snapshot.checkpointRevision, "checkpointRestartSnapshot.checkpointRevision");
  const checkpointRootEnvelopeHash = assertHash(snapshot.checkpointRootEnvelopeHash, "checkpointRestartSnapshot.checkpointRootEnvelopeHash");
  const runEnvelopeStorageHash = assertHash(snapshot.runEnvelopeStorageHash, "checkpointRestartSnapshot.runEnvelopeStorageHash");
  const runId = assertNonEmptyString(snapshot.runId, "checkpointRestartSnapshot.runId");
  const cutoff = exactCutoff(snapshot.cutoff, "checkpointRestartSnapshot.cutoff");
  const database = openReadonly(physicalDatabasePath);
  let transaction = false;
  try {
    database.exec("PRAGMA query_only=ON");
    database.exec("BEGIN");
    transaction = true;
    const reader = contentReader(database);
    const rootRecord = reader.read(checkpointRootEnvelopeHash);
    if (rootRecord.kind !== ROOT_KIND) throw new TypeError("checkpoint restart root envelope kind mismatch");
    const rootDecoded = decodeCanonicalJson(rootRecord.bytes);
    assertPlainObject(rootDecoded, "checkpointRestartRoot");
    assertExactKeys(rootDecoded, ROOT_FIELDS, "checkpointRestartRoot");
    const root = rootDecoded as Record<string, unknown>;
    if (root.revision !== checkpointRevision || root.inProgressRunId !== runId || !rootRecord.references.includes(runEnvelopeStorageHash)) {
      throw new TypeError("checkpoint restart root/run binding mismatch");
    }
    const runRecord = reader.read(runEnvelopeStorageHash);
    if (runRecord.kind !== RUN_KIND) throw new TypeError("checkpoint restart run envelope kind mismatch");
    const runDecoded = decodeCanonicalJson(runRecord.bytes);
    assertPlainObject(runDecoded, "checkpointRestartRun");
    assertExactKeys(runDecoded, RUN_FIELDS, "checkpointRestartRun");
    const run = runDecoded as Record<string, unknown>;
    if (run.runId !== runId || run.checkpointRevision !== checkpointRevision || !same(run.cutoff, cutoff)) {
      throw new TypeError("checkpoint restart run identity mismatch");
    }
    const candidatePartitionRoot = assertHash(run.candidatePartitionRoot, "checkpointRestartRun.candidatePartitionRoot");
    const outcomePartitionRoot = assertHash(run.outcomePartitionRoot, "checkpointRestartRun.outcomePartitionRoot");
    if (snapshot.candidatePartitionRoot !== candidatePartitionRoot || snapshot.outcomePartitionRoot !== outcomePartitionRoot) {
      throw new TypeError("checkpoint restart snapshot partition root mismatch");
    }
    const candidateManifest = assertHash(run.candidatePartitionStorageHash, "checkpointRestartRun.candidatePartitionStorageHash");
    const outcomeManifest = assertHash(run.outcomePartitionStorageHash, "checkpointRestartRun.outcomePartitionStorageHash");
    const partialManifest = run.partialOutcomePartitionStorageHash === null
      ? null
      : assertHash(run.partialOutcomePartitionStorageHash, "checkpointRestartRun.partialOutcomePartitionStorageHash");
    const candidates = partition(reader.read, candidateManifest, runId, "candidate");
    const outcomes = partition(reader.read, outcomeManifest, runId, "outcome");
    const partials = partialManifest === null ? Object.freeze([]) : partition(reader.read, partialManifest, runId, "partial-outcome");
    if (!Array.isArray(snapshot.candidates) || !same(snapshot.candidates, candidates)
      || !Array.isArray(snapshot.outcomes) || !same(snapshot.outcomes, outcomes)
      || !Array.isArray(snapshot.partials) || !same(snapshot.partials, partials)) {
      throw new TypeError("checkpoint restart snapshot is not the raw durable partition");
    }
    const recomputedOutcomeRoot = hashDomain("aloha/checkpoint-outcome-partition/v1", {
      runId,
      outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", outcomes),
    });
    if (recomputedOutcomeRoot !== outcomePartitionRoot) throw new TypeError("checkpoint restart outcome partition semantic root mismatch");
    let probeEvidence: Readonly<Record<string, unknown>> | null = null;
    if (snapshot.probeEvidence !== null) {
      assertPlainObject(snapshot.probeEvidence, "checkpointRestartSnapshot.probeEvidence");
      probeEvidence = Object.freeze(snapshot.probeEvidence as Record<string, unknown>);
      const probeHash = assertHash(root.latestProbeReceiptHash, "checkpointRestartRoot.latestProbeReceiptHash");
      const probeRecord = reader.read(probeHash);
      const probeEnvelope = decodeCanonicalJson(probeRecord.bytes);
      assertPlainObject(probeEnvelope, "checkpointRestartProbeEnvelope");
      if (!same((probeEnvelope as Record<string, unknown>).receipt, probeEvidence.receipt)) {
        throw new TypeError("checkpoint restart probe evidence is not the raw receipt");
      }
    } else if (root.latestProbeReceiptHash !== null) {
      throw new TypeError("checkpoint restart snapshot omitted root-reachable probe evidence");
    }
    database.exec("ROLLBACK");
    transaction = false;
    const rawContents = Object.freeze([...reader.observed.values()].sort((left, right) => left.hash.localeCompare(right.hash)));
    return Object.freeze({
      checkpointStore,
      checkpointRevision,
      checkpointRootEnvelopeHash,
      runEnvelopeStorageHash,
      runId,
      cutoff,
      candidatePartitionRoot,
      outcomePartitionRoot,
      candidates,
      partials,
      outcomes,
      outcomeHashes: Object.freeze(outcomes.map(value => candidateFinalOutcomeHash(value as never)).sort()),
      probeEvidence,
      rawContentRoot: hashDomain("aloha/raw-checkpoint-restart-content-root/v1", rawContents.map(value => ({
        hash: value.hash,
        payloadHash: value.payloadHash,
        kind: value.kind,
        references: value.references,
      }))),
      rawContents,
    });
  } finally {
    if (transaction) {
      try { database.exec("ROLLBACK"); } catch { /* preserve the primary observation error */ }
    }
    database.close();
  }
}
