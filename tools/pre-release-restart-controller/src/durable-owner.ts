import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { backup, DatabaseSync } from "node:sqlite";
import {
  CANONICAL_LIMITS,
  assertDecimalString,
  assertExactKeys,
  assertGitSha40,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { candidateFinalOutcomeHash } from "../../../specs/candidate-final-outcome/src/index.ts";
import { decodeProcessAnchor, hashProcessAnchor, type ProcessAnchorV1 } from "../../../specs/core-envelope/src/index.ts";
import {
  PRE_RELEASE_RESTART_CONTROLLER_LAYOUT_V1 as LAYOUT,
  PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1,
  type PreReleaseControllerCheckpointFactV1,
  type PreReleaseControllerDirectorySnapshotV1,
  type PreReleaseControllerEventFactV1,
  type PreReleaseControllerPhysicalFileSnapshotV1,
  type PreReleaseControllerTerminalFactV1,
} from "./spec.ts";
import { readStableOwnedPhysicalFileV1 } from "./stable-owned-file.ts";

const CONTENT_DOMAIN = "aloha/durable-content-envelope/v1";
const ROOT_KIND = "aloha/durable-root-envelope/v1";
const RUN_KIND = "aloha/in-progress-run/v2";
const PARTITION_MANIFEST_KIND = "aloha/checkpoint-partition-manifest/v1";
const PARTITION_PAGE_KIND = "aloha/checkpoint-partition-page/v1";
const CANDIDATE_KIND = "aloha/candidate-record/v2";
const OUTCOME_KIND = "aloha/candidate-final-outcome/v1";
const PARTIAL_KIND = "aloha/attestation-partial-outcome/v1";
const RESTART_TERMINAL_NAMESPACE_PREFIX = "pre-release-restart-terminal-v1:";
const RESTART_TERMINAL_DOMAIN = "aloha/pre-release-restart-terminal/v1";
const PROCESS_NAMESPACE_PREFIX = "runtime-acceptance-process-v1:";
const PROCESS_EVENT_DOMAIN = "aloha/runtime-acceptance-process-event/v1";
const ROOT_FIELDS = ["revision", "verifiedMemoRoot", "inProgressRunId", "stagedReadyStorageHash", "latestMemoSeedReceiptHash", "memoSeedSequence", "memoSeedLineageRoot", "latestProbeReceiptHash", "probeReceiptSequence", "probeReceiptLineageRoot", "readyGenerationId", "readyGenerationRecordHash", "schemaHash"] as const;
const RUN_FIELDS = ["runId", "parentGenerationId", "checkpointRevision", "candidatePartitionRevision", "cutoff", "recentObservationRoot", "recentObservationStorageHash", "definitionCatalogRoot", "sourceCoverageRoot", "sourceCoverageStorageHash", "sourceExecutionSetRoot", "sourceExecutionSetStorageHash", "sourcePlanEvidenceStorageHash", "nominationClosureRoot", "nominationClosureStorageHash", "candidatePartitionRoot", "candidatePartitionStorageHash", "candidatePartitionProofStorageHash", "candidateRecordCount", "outcomePartitionRoot", "outcomePartitionStorageHash", "partialOutcomePartitionStorageHash", "attestationPartitionStorageHash", "verifiedMemoSetRoot", "verifiedMemoSetStorageHash", "accounting"] as const;

interface ReadonlyStatement {
  get(...parameters: readonly (string | number | bigint | Uint8Array | null)[]): unknown;
  all(...parameters: readonly (string | number | bigint | Uint8Array | null)[]): readonly unknown[];
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

interface ObservedRuntimeAcceptanceProcessEventV1 extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: 1;
  readonly kind: "aloha.runtime-process-ready" | "aloha.runtime-sigterm-observed" | "aloha.runtime-sigterm-drained";
  readonly sequence: string;
  readonly release: Readonly<{ readonly bindingId: Hash; readonly releaseProvenanceHash: Hash; readonly candidateReleaseCommit: string }>;
  readonly processAnchorHash: Hash;
  readonly eventId: Hash;
}

function same(left: unknown, right: unknown): boolean {
  return encodeCanonicalJson(left) === encodeCanonicalJson(right);
}

function openReadonly(path: string): ReadonlyDatabase {
  if (typeof DatabaseSync !== "function") throw new TypeError("node:sqlite does not expose DatabaseSync");
  const before = statSync(path, { bigint: true });
  const database = new DatabaseSync(path, { readOnly: true }) as unknown as ReadonlyDatabase;
  try {
    const databaseList = database.prepare("PRAGMA database_list").all() as readonly Record<string, unknown>[];
    const after = statSync(path, { bigint: true });
    if (databaseList.length !== 1 || databaseList[0]?.name !== "main" || databaseList[0]?.file !== path
      || before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid || before.mode !== after.mode) {
      throw new TypeError("pre-release controller durable database changed across read-only open");
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function exactPhysicalPath(path: string, expected: string): Readonly<{ readonly path: string; readonly device: string; readonly inode: string }> {
  if (path !== expected || !existsSync(path) || realpathSync(path) !== path || !lstatSync(path).isFile()) throw new TypeError(`durable path is not the fixed physical file: ${expected}`);
  const before = statSync(path, { bigint: true });
  const after = statSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino) throw new TypeError(`durable file identity changed: ${path}`);
  return Object.freeze({ path, device: String(after.dev), inode: String(after.ino) });
}

function exactRefs(value: unknown, path: string): readonly Hash[] {
  const decoded = typeof value === "string" ? decodeCanonicalJson(value) : value;
  if (!Array.isArray(decoded)) throw new TypeError(`${path} must be an array`);
  const refs = decoded.map((item, index) => assertHash(item, `${path}[${index}]`));
  for (let index = 1; index < refs.length; index += 1) if (refs[index - 1]! >= refs[index]!) throw new TypeError(`${path} must be strictly sorted and unique`);
  return Object.freeze(refs);
}

function contentReader(database: ReadonlyDatabase) {
  const observed = new Map<Hash, RawContentV1>();
  const read = (hashValue: unknown): RawContentV1 => {
    const hash = assertHash(hashValue, "preReleaseController.content.hash");
    const cached = observed.get(hash);
    if (cached !== undefined) return cached;
    const raw = database.prepare("SELECT hash, payload_hash, kind, bytes, byte_length, references_json FROM durable_content WHERE hash=?").get(hash);
    assertPlainObject(raw, `preReleaseController.content[${hash}]`);
    assertExactKeys(raw, ["hash", "payload_hash", "kind", "bytes", "byte_length", "references_json"], `preReleaseController.content[${hash}]`);
    const row = raw as Record<string, unknown>;
    if (!(row.bytes instanceof Uint8Array)) throw new TypeError("durable content bytes are not concrete");
    const bytes = Uint8Array.from(row.bytes);
    const payloadHash = assertHash(row.payload_hash, "preReleaseController.content.payloadHash");
    const kind = assertNonEmptyString(row.kind, "preReleaseController.content.kind");
    const references = exactRefs(row.references_json, "preReleaseController.content.references");
    const byteLength = typeof row.byte_length === "number" ? row.byte_length : Number(row.byte_length);
    if (!Number.isSafeInteger(byteLength) || byteLength !== bytes.byteLength || payloadHash !== sha256Hex(bytes)) throw new TypeError("durable content payload identity mismatch");
    if (row.hash !== hash || hashDomain(CONTENT_DOMAIN, { kind, payloadHash, references }) !== hash) throw new TypeError("durable content envelope identity mismatch");
    const output = Object.freeze({ hash, payloadHash, kind, bytes, references });
    observed.set(hash, output);
    return output;
  };
  return Object.freeze({ read, observed });
}

function partition(
  read: (hash: Hash) => RawContentV1,
  manifestHash: Hash,
  runId: string,
  kind: "candidate" | "outcome" | "partial-outcome",
): readonly Readonly<Record<string, unknown>>[] {
  const manifestRecord = read(manifestHash);
  if (manifestRecord.kind !== PARTITION_MANIFEST_KIND) throw new TypeError(`${kind} manifest kind mismatch`);
  const decoded = decodeCanonicalJson(manifestRecord.bytes);
  assertPlainObject(decoded, `${kind}Manifest`);
  assertExactKeys(decoded, ["runId", "partitionKind", "count", "pageStorageHashes"], `${kind}Manifest`);
  const manifest = decoded as Record<string, unknown>;
  if (manifest.runId !== runId || manifest.partitionKind !== kind || !Array.isArray(manifest.pageStorageHashes)) throw new TypeError(`${kind} manifest binding mismatch`);
  const pageHashes = manifest.pageStorageHashes.map((item, index) => assertHash(item, `${kind}Manifest.pageStorageHashes[${index}]`));
  if (!same(manifestRecord.references, [...new Set(pageHashes)].sort())) throw new TypeError(`${kind} manifest reference closure mismatch`);
  const values: Readonly<Record<string, unknown>>[] = [];
  const keys: string[] = [];
  for (const [pageIndex, pageHash] of pageHashes.entries()) {
    const pageRecord = read(pageHash);
    if (pageRecord.kind !== PARTITION_PAGE_KIND) throw new TypeError(`${kind} page kind mismatch`);
    const pageDecoded = decodeCanonicalJson(pageRecord.bytes);
    assertPlainObject(pageDecoded, `${kind}Page`);
    assertExactKeys(pageDecoded, ["runId", "partitionKind", "pageIndex", "entries"], `${kind}Page`);
    const page = pageDecoded as Record<string, unknown>;
    if (page.runId !== runId || page.partitionKind !== kind || page.pageIndex !== String(pageIndex) || !Array.isArray(page.entries)) throw new TypeError(`${kind} page binding mismatch`);
    const storageHashes: Hash[] = [];
    for (const [entryIndex, entryValue] of page.entries.entries()) {
      assertPlainObject(entryValue, `${kind}Page.entries[${entryIndex}]`);
      assertExactKeys(entryValue, ["key", "storageHash"], `${kind}Page.entries[${entryIndex}]`);
      const entry = entryValue as Record<string, unknown>;
      const key = assertNonEmptyString(entry.key, `${kind}Page.entries[${entryIndex}].key`);
      const storageHash = assertHash(entry.storageHash, `${kind}Page.entries[${entryIndex}].storageHash`);
      const content = read(storageHash);
      const expectedKind = kind === "candidate" ? CANDIDATE_KIND : kind === "outcome" ? OUTCOME_KIND : PARTIAL_KIND;
      if (content.kind !== expectedKind) throw new TypeError(`${kind} partition entry kind mismatch`);
      const value = decodeCanonicalJson(content.bytes);
      assertPlainObject(value, `${kind}PartitionValue`);
      if ((value as Record<string, unknown>).familyCandidateKey !== key) throw new TypeError(`${kind} physical key mismatch`);
      keys.push(key);
      storageHashes.push(storageHash);
      values.push(Object.freeze(value as Record<string, unknown>));
    }
    if (!same(pageRecord.references, [...new Set(storageHashes)].sort())) throw new TypeError(`${kind} page reference closure mismatch`);
  }
  if (assertDecimalString(manifest.count, `${kind}Manifest.count`) !== String(values.length)) throw new TypeError(`${kind} partition count mismatch`);
  for (let index = 1; index < keys.length; index += 1) if (keys[index - 1]! >= keys[index]!) throw new TypeError(`${kind} partition keys are not sorted unique`);
  return Object.freeze(values);
}

interface CurrentCheckpointObservationV1 {
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
  readonly rawContentRoot: Hash;
}

function currentSnapshotClaim(databasePath: string = LAYOUT.checkpointDatabasePath): CurrentCheckpointObservationV1 {
  const anchor = exactPhysicalPath(databasePath, databasePath);
  const database = openReadonly(anchor.path);
  let transaction = false;
  try {
    database.exec("PRAGMA query_only=ON");
    database.exec("BEGIN");
    transaction = true;
    const roles = database.prepare("SELECT store_role FROM durable_store_identity").all() as readonly Record<string, unknown>[];
    if (roles.length !== 1 || roles[0]?.store_role !== "checkpoint") throw new TypeError("checkpoint durable store role mismatch");
    const roots = database.prepare("SELECT revision, envelope_hash FROM durable_root WHERE root_id=1").all() as readonly Record<string, unknown>[];
    if (roots.length !== 1) throw new TypeError("checkpoint must have exactly one durable root");
    const revision = assertDecimalString(roots[0]!.revision, "checkpointRoot.revision");
    const rootHash = assertHash(roots[0]!.envelope_hash, "checkpointRoot.envelopeHash");
    const reader = contentReader(database);
    const rootRecord = reader.read(rootHash);
    if (rootRecord.kind !== ROOT_KIND) throw new TypeError("checkpoint root content kind mismatch");
    const rootDecoded = decodeCanonicalJson(rootRecord.bytes);
    assertPlainObject(rootDecoded, "checkpointRoot");
    assertExactKeys(rootDecoded, ROOT_FIELDS, "checkpointRoot");
    const root = rootDecoded as Record<string, unknown>;
    const runId = assertNonEmptyString(root.inProgressRunId, "checkpointRoot.inProgressRunId");
    if (root.revision !== revision) throw new TypeError("checkpoint root row/revision mismatch");
    const runCandidates = rootRecord.references.map(reference => reader.read(reference)).filter(record => record.kind === RUN_KIND).filter(record => {
      const value = decodeCanonicalJson(record.bytes);
      return typeof value === "object" && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).runId === runId;
    });
    if (runCandidates.length !== 1) throw new TypeError("checkpoint root does not reach exactly one active run");
    const runRecord = runCandidates[0]!;
    const runDecoded = decodeCanonicalJson(runRecord.bytes);
    assertPlainObject(runDecoded, "checkpointRun");
    assertExactKeys(runDecoded, RUN_FIELDS, "checkpointRun");
    const run = runDecoded as Record<string, unknown>;
    if (run.runId !== runId || run.checkpointRevision !== revision) throw new TypeError("checkpoint active run identity mismatch");
    const candidateManifest = assertHash(run.candidatePartitionStorageHash, "checkpointRun.candidatePartitionStorageHash");
    const outcomeManifest = assertHash(run.outcomePartitionStorageHash, "checkpointRun.outcomePartitionStorageHash");
    const partialManifest = run.partialOutcomePartitionStorageHash === null ? null : assertHash(run.partialOutcomePartitionStorageHash, "checkpointRun.partialOutcomePartitionStorageHash");
    const candidates = partition(reader.read, candidateManifest, runId, "candidate");
    const outcomes = partition(reader.read, outcomeManifest, runId, "outcome");
    const partials = partialManifest === null ? Object.freeze([]) : partition(reader.read, partialManifest, runId, "partial-outcome");
    const cutoff = run.cutoff;
    assertPlainObject(cutoff, "checkpointRun.cutoff");
    assertExactKeys(cutoff, ["chainId", "number", "hash", "stateRoot"], "checkpointRun.cutoff");
    const exactCutoff = Object.freeze({
      chainId: assertNonEmptyString((cutoff as Record<string, unknown>).chainId, "checkpointRun.cutoff.chainId"),
      number: assertDecimalString((cutoff as Record<string, unknown>).number, "checkpointRun.cutoff.number"),
      hash: assertHash((cutoff as Record<string, unknown>).hash, "checkpointRun.cutoff.hash"),
      stateRoot: assertHash((cutoff as Record<string, unknown>).stateRoot, "checkpointRun.cutoff.stateRoot"),
    });
    if (root.latestProbeReceiptHash !== null) reader.read(assertHash(root.latestProbeReceiptHash, "checkpointRoot.latestProbeReceiptHash"));
    const outcomePartitionRoot = assertHash(run.outcomePartitionRoot, "checkpointRun.outcomePartitionRoot");
    const recomputedOutcomeRoot = hashDomain("aloha/checkpoint-outcome-partition/v1", {
      runId,
      outcomesRoot: hashCanonicalPartition("aloha/candidate-outcomes/v1", outcomes),
    });
    if (recomputedOutcomeRoot !== outcomePartitionRoot) throw new TypeError("checkpoint outcome partition semantic root mismatch");
    const outcomeHashes = Object.freeze(outcomes.map(outcome => candidateFinalOutcomeHash(outcome as never)).sort());
    const rawContents = Object.freeze([...reader.observed.values()].sort((left, right) => left.hash.localeCompare(right.hash)));
    const claim = Object.freeze({
      checkpointStore: anchor,
      checkpointRevision: revision,
      checkpointRootEnvelopeHash: rootHash,
      runEnvelopeStorageHash: runRecord.hash,
      runId,
      cutoff: exactCutoff,
      candidatePartitionRoot: assertHash(run.candidatePartitionRoot, "checkpointRun.candidatePartitionRoot"),
      outcomePartitionRoot,
      candidates,
      partials,
      outcomes,
      outcomeHashes,
      rawContentRoot: hashDomain("aloha/raw-checkpoint-restart-content-root/v1", rawContents.map(value => ({
        hash: value.hash,
        payloadHash: value.payloadHash,
        kind: value.kind,
        references: value.references,
      }))),
    });
    database.exec("ROLLBACK");
    transaction = false;
    return claim;
  } finally {
    if (transaction) try { database.exec("ROLLBACK"); } catch { /* preserve observation error */ }
    database.close();
  }
}

export function observeCurrentCheckpointFactV1(databasePath: string = LAYOUT.checkpointDatabasePath): PreReleaseControllerCheckpointFactV1 {
  const observed = currentSnapshotClaim(databasePath);
  if (observed.candidates.length === 0 || observed.outcomes.length === 0 || observed.partials.length !== 0 || observed.outcomeHashes.length === 0) throw new TypeError("pre-release checkpoint is not a root-reachable non-empty terminal outcome partition");
  const candidateKeys = new Set(observed.candidates.map(candidate => candidate.familyCandidateKey));
  if (candidateKeys.size !== observed.candidates.length) throw new TypeError("checkpoint candidates are not unique");
  for (const outcome of observed.outcomes) if (!candidateKeys.has(outcome.familyCandidateKey)) throw new TypeError("checkpoint outcome is not bound to a root-reachable candidate");
  const recomputedHashes = observed.outcomes.map(value => candidateFinalOutcomeHash(value as never)).sort();
  if (!same(recomputedHashes, observed.outcomeHashes)) throw new TypeError("checkpoint outcome hash recomputation mismatch");
  return Object.freeze({
    path: LAYOUT.checkpointDatabasePath,
    device: observed.checkpointStore.device,
    inode: observed.checkpointStore.inode,
    checkpointRevision: observed.checkpointRevision,
    checkpointRootEnvelopeHash: observed.checkpointRootEnvelopeHash,
    runEnvelopeStorageHash: observed.runEnvelopeStorageHash,
    runId: observed.runId,
    cutoff: observed.cutoff,
    candidatePartitionRoot: observed.candidatePartitionRoot,
    outcomePartitionRoot: observed.outcomePartitionRoot,
    candidateCount: String(observed.candidates.length),
    partialCount: String(observed.partials.length),
    outcomeCount: String(observed.outcomes.length),
    outcomeHashes: observed.outcomeHashes,
    candidateKeys: Object.freeze(observed.candidates.map(candidate => assertHash(candidate.familyCandidateKey, "checkpointCandidate.familyCandidateKey")).sort()),
    outcomes: Object.freeze(observed.outcomes.map(outcome => Object.freeze(outcome))),
    rawContentRoot: observed.rawContentRoot,
  });
}

function readProcessDurableStateV1(databasePath: string = LAYOUT.processEvidenceDatabasePath): Readonly<{
  readonly events: readonly ObservedRuntimeAcceptanceProcessEventV1[];
  readonly restartTerminalCount: number;
}> {
  const physical = exactPhysicalPath(databasePath, databasePath);
  const database = openReadonly(physical.path);
  let transaction = false;
  try {
    database.exec("PRAGMA query_only=ON");
    database.exec("BEGIN");
    transaction = true;
    const roles = database.prepare("SELECT store_role FROM durable_store_identity").all() as readonly Record<string, unknown>[];
    if (roles.length !== 1 || roles[0]?.store_role !== "searcher-production-evidence") throw new TypeError("pre-release process evidence durable store role mismatch");
    const rows = database.prepare(`
      SELECT namespace, sequence, event_id, content_sha256, bytes, byte_length, offset_start, offset_end
      FROM durable_append_log
      WHERE namespace LIKE ?
      ORDER BY namespace, length(sequence), sequence
    `).all(`${PROCESS_NAMESPACE_PREFIX}%`) as readonly Record<string, unknown>[];
    const events: ObservedRuntimeAcceptanceProcessEventV1[] = [];
    let namespace: string | null = null;
    let nextOffset = 0n;
    for (const [index, row] of rows.entries()) {
      assertExactKeys(row, ["namespace", "sequence", "event_id", "content_sha256", "bytes", "byte_length", "offset_start", "offset_end"], `preReleaseProcessRow[${index}]`);
      if (typeof row.namespace !== "string" || !row.namespace.startsWith(PROCESS_NAMESPACE_PREFIX) || !(row.bytes instanceof Uint8Array)) throw new TypeError("pre-release process row is malformed");
      namespace ??= row.namespace;
      if (row.namespace !== namespace) throw new TypeError("pre-release process evidence contains multiple release namespaces");
      const sequence = assertDecimalString(row.sequence, `preReleaseProcessRow[${index}].sequence`);
      const byteLength = assertDecimalString(row.byte_length, `preReleaseProcessRow[${index}].byteLength`);
      const offsetStart = assertDecimalString(row.offset_start, `preReleaseProcessRow[${index}].offsetStart`);
      const offsetEnd = assertDecimalString(row.offset_end, `preReleaseProcessRow[${index}].offsetEnd`);
      const bytes = Uint8Array.from(row.bytes);
      if (sequence !== String(index) || BigInt(offsetStart) !== nextOffset || BigInt(offsetEnd) !== nextOffset + BigInt(bytes.byteLength)
        || byteLength !== String(bytes.byteLength) || row.content_sha256 !== sha256Hex(bytes)) throw new TypeError("pre-release process append row continuity/content mismatch");
      const decoded = decodeCanonicalJson(bytes);
      assertPlainObject(decoded, `preReleaseProcessEvent[${index}]`);
      const event = decoded as unknown as ObservedRuntimeAcceptanceProcessEventV1;
      const common = ["schemaVersion", "kind", "sequence", "release", "processAnchorHash", "eventId"];
      const fields = event.kind === "aloha.runtime-process-ready"
        ? [...common, "runtimeAnchor", "staticArtifacts", "strategy", "checkpointRoot", "checkpointStore", "stage12", "checkpointProbeEvidence", "processAnchor", "logStart"]
        : event.kind === "aloha.runtime-sigterm-observed"
          ? [...common, "processReadyEventId", "checkpointRootBefore", "checkpointRestartBefore", "outcomePartitionRootBefore", "outcomeHashesBefore"]
          : event.kind === "aloha.runtime-sigterm-drained"
            ? [...common, "sigtermObservedEventId", "checkpointRootAfter", "checkpointRestartAfter", "outcomePartitionRootAfter", "outcomeHashesAfter", "flushedOutcomeHashes", "logWindow"]
            : [];
      if (fields.length === 0) throw new TypeError("pre-release process event kind is invalid");
      assertExactKeys(event, fields, `preReleaseProcessEvent[${index}]`);
      if (event.schemaVersion !== 1 || event.sequence !== sequence) throw new TypeError("pre-release process event header mismatch");
      assertPlainObject(event.release, `preReleaseProcessEvent[${index}].release`);
      assertExactKeys(event.release, ["bindingId", "releaseProvenanceHash", "candidateReleaseCommit"], `preReleaseProcessEvent[${index}].release`);
      assertHash(event.release.bindingId, `preReleaseProcessEvent[${index}].release.bindingId`);
      assertHash(event.release.releaseProvenanceHash, `preReleaseProcessEvent[${index}].release.releaseProvenanceHash`);
      assertGitSha40(event.release.candidateReleaseCommit, `preReleaseProcessEvent[${index}].release.candidateReleaseCommit`);
      if (namespace !== `${PROCESS_NAMESPACE_PREFIX}${event.release.releaseProvenanceHash.slice(2)}`) throw new TypeError("pre-release process namespace/release mismatch");
      const { eventId: _eventId, ...payload } = event;
      if (assertHash(event.eventId, `preReleaseProcessEvent[${index}].eventId`) !== row.event_id
        || event.eventId !== hashDomain(PROCESS_EVENT_DOMAIN, payload as never)) throw new TypeError("pre-release process event identity mismatch");
      assertHash(event.processAnchorHash, `preReleaseProcessEvent[${index}].processAnchorHash`);
      if (event.kind === "aloha.runtime-process-ready") {
        const anchor = decodeProcessAnchor(event.processAnchor as object);
        if (hashProcessAnchor(anchor) !== event.processAnchorHash) throw new TypeError("pre-release process-ready anchor hash mismatch");
      } else if (event.kind === "aloha.runtime-sigterm-observed") {
        assertHash(event.processReadyEventId, "preReleaseObserved.processReadyEventId");
        exactSortedHashes(event.outcomeHashesBefore, "preReleaseObserved.outcomeHashesBefore", true);
      } else {
        assertHash(event.sigtermObservedEventId, "preReleaseDrained.sigtermObservedEventId");
        exactSortedHashes(event.outcomeHashesAfter, "preReleaseDrained.outcomeHashesAfter", true);
        exactSortedHashes(event.flushedOutcomeHashes, "preReleaseDrained.flushedOutcomeHashes", true);
      }
      events.push(Object.freeze(event));
      nextOffset = BigInt(offsetEnd);
    }
    const restartTerminals = database.prepare(`
      SELECT namespace
      FROM durable_append_log
      WHERE namespace LIKE ?
    `).all(`${RESTART_TERMINAL_NAMESPACE_PREFIX}%`) as readonly Record<string, unknown>[];
    database.exec("ROLLBACK");
    transaction = false;
    return Object.freeze({ events: Object.freeze(events), restartTerminalCount: restartTerminals.length });
  } finally {
    if (transaction) try { database.exec("ROLLBACK"); } catch { /* preserve observation error */ }
    database.close();
  }
}

function eventFact(event: ObservedRuntimeAcceptanceProcessEventV1): PreReleaseControllerEventFactV1 {
  return Object.freeze({
    sequence: event.sequence,
    kind: event.kind,
    eventId: event.eventId,
    contentSha256: sha256Hex(encodeCanonicalBytes(event)),
    processAnchorHash: event.processAnchorHash,
    predecessorEventId: event.kind === "aloha.runtime-process-ready"
      ? null
      : event.kind === "aloha.runtime-sigterm-observed"
        ? assertHash(event.processReadyEventId, "runtimeObserved.processReadyEventId")
        : assertHash(event.sigtermObservedEventId, "runtimeDrained.sigtermObservedEventId"),
  });
}

export interface PreReleaseProcessPreFactsV1 {
  readonly release: Readonly<{ readonly bindingId: Hash; readonly releaseProvenanceHash: Hash; readonly candidateReleaseCommit: string }>;
  readonly readyEvent: ObservedRuntimeAcceptanceProcessEventV1;
  readonly ready: PreReleaseControllerEventFactV1;
  readonly processAnchor: ProcessAnchorV1;
  readonly runtimeAnchor: Readonly<Record<string, unknown>>;
  readonly targetSystemdUnitSha256: Hash;
}

export function assertPreReleaseProcessPreDenominatorV1(eventKinds: readonly string[], restartTerminalCount: number): void {
  if (eventKinds.length !== 1 || eventKinds[0] !== "aloha.runtime-process-ready") throw new TypeError("pre-release A must have exactly one valid ready event and no drain before controller signal");
  if (!Number.isSafeInteger(restartTerminalCount) || restartTerminalCount !== 0) throw new TypeError("pre-release A must have no durable restart terminal before controller signal");
}

export function observePreReleaseProcessPreFactsV1(): PreReleaseProcessPreFactsV1 {
  const { events, restartTerminalCount } = readProcessDurableStateV1();
  assertPreReleaseProcessPreDenominatorV1(events.map(event => event.kind), restartTerminalCount);
  const ready = events[0]!;
  assertPlainObject(ready.processAnchor, "preReleaseReady.processAnchor");
  assertPlainObject(ready.runtimeAnchor, "preReleaseReady.runtimeAnchor");
  assertPlainObject(ready.staticArtifacts, "preReleaseReady.staticArtifacts");
  const artifacts = ready.staticArtifacts as Readonly<Record<string, unknown>>;
  assertPlainObject(artifacts.systemdUnit, "preReleaseReady.staticArtifacts.systemdUnit");
  const systemdUnit = artifacts.systemdUnit as Readonly<Record<string, unknown>>;
  return Object.freeze({
    release: ready.release,
    readyEvent: ready,
    ready: eventFact(ready),
    processAnchor: decodeProcessAnchor(ready.processAnchor as object),
    runtimeAnchor: ready.runtimeAnchor as Readonly<Record<string, unknown>>,
    targetSystemdUnitSha256: assertHash(systemdUnit.contentSha256, "preReleaseReady.staticArtifacts.systemdUnit.contentSha256"),
  });
}

function exactSortedHashes(value: unknown, path: string, nonEmpty = false): readonly Hash[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) throw new TypeError(`${path} must be a non-empty hash array`);
  const output = value.map((item, index) => assertHash(item, `${path}[${index}]`));
  for (let index = 1; index < output.length; index += 1) if (output[index - 1]! >= output[index]!) throw new TypeError(`${path} must be strictly sorted and unique`);
  return Object.freeze(output);
}

function readTerminalFact(events: readonly ObservedRuntimeAcceptanceProcessEventV1[], databasePath: string = LAYOUT.processEvidenceDatabasePath): PreReleaseControllerTerminalFactV1 {
  const physical = exactPhysicalPath(databasePath, databasePath);
  const database = openReadonly(physical.path);
  try {
    database.exec("PRAGMA query_only=ON");
    const rows = database.prepare("SELECT namespace, sequence, event_id, content_sha256, bytes, byte_length FROM durable_append_log WHERE namespace LIKE ?").all(`${RESTART_TERMINAL_NAMESPACE_PREFIX}%`) as readonly Record<string, unknown>[];
    if (rows.length !== 1) throw new TypeError("pre-release controller requires exactly one durable restart terminal");
    const row = rows[0]!;
    assertExactKeys(row, ["namespace", "sequence", "event_id", "content_sha256", "bytes", "byte_length"], "preReleaseRestartTerminalRow");
    if (row.sequence !== "0" || !(row.bytes instanceof Uint8Array)) throw new TypeError("pre-release restart terminal row is malformed");
    const bytes = Uint8Array.from(row.bytes);
    if (String(row.byte_length) !== String(bytes.byteLength) || row.content_sha256 !== sha256Hex(bytes)) throw new TypeError("pre-release restart terminal row content identity mismatch");
    const terminal = decodeCanonicalJson(bytes);
    assertPlainObject(terminal, "preReleaseRestartTerminal");
    const value = terminal as Record<string, unknown>;
    const terminalId = assertHash(value.terminalId, "preReleaseRestartTerminal.terminalId");
    const { terminalId: _terminalId, ...payload } = value;
    if (value.schemaVersion !== 1 || value.kind !== "aloha.pre-release-restart-terminal" || value.sequence !== "0"
      || terminalId !== row.event_id || terminalId !== hashDomain(RESTART_TERMINAL_DOMAIN, payload)) throw new TypeError("pre-release restart terminal identity mismatch");
    const [ready, observed, drained] = events;
    if (value.processReadyEventId !== ready?.eventId || value.sigtermObservedEventId !== observed?.eventId || value.sigtermDrainedEventId !== drained?.eventId) throw new TypeError("pre-release restart terminal event lineage mismatch");
    return Object.freeze({
      terminalId,
      contentSha256: sha256Hex(bytes),
      authorizationId: assertHash(value.authorizationId, "preReleaseRestartTerminal.authorizationId"),
      authorizationClaimId: assertHash(value.authorizationClaimId, "preReleaseRestartTerminal.authorizationClaimId"),
      stagingArtifactSetRoot: assertHash(value.stagingArtifactSetRoot, "preReleaseRestartTerminal.stagingArtifactSetRoot"),
      stagingManifestRoot: assertHash(value.stagingManifestRoot, "preReleaseRestartTerminal.stagingManifestRoot"),
      controllerBoundaryEvidenceRoot: assertHash(value.controllerBoundaryEvidenceRoot, "preReleaseRestartTerminal.controllerBoundaryEvidenceRoot"),
      processReadyEventId: assertHash(value.processReadyEventId, "preReleaseRestartTerminal.processReadyEventId"),
      sigtermObservedEventId: assertHash(value.sigtermObservedEventId, "preReleaseRestartTerminal.sigtermObservedEventId"),
      sigtermDrainedEventId: assertHash(value.sigtermDrainedEventId, "preReleaseRestartTerminal.sigtermDrainedEventId"),
      checkpointRootEnvelopeHash: assertHash(value.checkpointRootEnvelopeHash, "preReleaseRestartTerminal.checkpointRootEnvelopeHash"),
      candidatePartitionRoot: assertHash(value.candidatePartitionRoot, "preReleaseRestartTerminal.candidatePartitionRoot"),
      outcomePartitionRoot: assertHash(value.outcomePartitionRoot, "preReleaseRestartTerminal.outcomePartitionRoot"),
      flushedOutcomeHashes: exactSortedHashes(value.flushedOutcomeHashes, "preReleaseRestartTerminal.flushedOutcomeHashes", true),
    });
  } finally {
    database.close();
  }
}

export interface PreReleaseProcessPostFactsV1 {
  readonly ready: PreReleaseControllerEventFactV1;
  readonly observed: PreReleaseControllerEventFactV1;
  readonly drained: PreReleaseControllerEventFactV1;
  readonly terminal: PreReleaseControllerTerminalFactV1;
  readonly checkpoint: PreReleaseControllerCheckpointFactV1;
}

export function observePreReleaseProcessPostFactsV1(
  pre: PreReleaseProcessPreFactsV1,
  databasePaths: Readonly<{
    readonly processEvidence: string;
    readonly checkpoint: string;
  }> = Object.freeze({
    processEvidence: LAYOUT.processEvidenceDatabasePath,
    checkpoint: LAYOUT.checkpointDatabasePath,
  }),
): PreReleaseProcessPostFactsV1 {
  const { events } = readProcessDurableStateV1(databasePaths.processEvidence);
  if (events.length !== 3) throw new TypeError("pre-release A drain requires exactly ready, observed, drained durable events");
  const [ready, observed, drained] = events;
  if (ready?.kind !== "aloha.runtime-process-ready" || observed?.kind !== "aloha.runtime-sigterm-observed" || drained?.kind !== "aloha.runtime-sigterm-drained"
    || !same(ready, pre.readyEvent) || observed.processReadyEventId !== ready.eventId || drained.sigtermObservedEventId !== observed.eventId
    || ready.processAnchorHash !== observed.processAnchorHash || ready.processAnchorHash !== drained.processAnchorHash
    || !same(ready.release, observed.release) || !same(ready.release, drained.release)) throw new TypeError("pre-release A ready to observed to drained lineage mismatch");
  const checkpoint = observeCurrentCheckpointFactV1(databasePaths.checkpoint);
  const observedSnapshot = observed.checkpointRestartBefore as Readonly<Record<string, unknown>>;
  const drainedSnapshot = drained.checkpointRestartAfter as Readonly<Record<string, unknown>>;
  if (observedSnapshot === null || typeof observedSnapshot !== "object" || drainedSnapshot === null || typeof drainedSnapshot !== "object") throw new TypeError("pre-release A drain snapshots are missing");
  if (checkpoint.checkpointRootEnvelopeHash !== drainedSnapshot.checkpointRootEnvelopeHash
    || checkpoint.runEnvelopeStorageHash !== drainedSnapshot.runEnvelopeStorageHash
    || checkpoint.runId !== drainedSnapshot.runId
    || checkpoint.candidatePartitionRoot !== drainedSnapshot.candidatePartitionRoot
    || checkpoint.outcomePartitionRoot !== drainedSnapshot.outcomePartitionRoot
    || !same(checkpoint.outcomeHashes, drained.outcomeHashesAfter)
    || !same(checkpoint.outcomeHashes, drained.flushedOutcomeHashes)) throw new TypeError("pre-release A drained checkpoint is not the current exact durable partition");
  const terminal = readTerminalFact(events, databasePaths.processEvidence);
  if (terminal.checkpointRootEnvelopeHash !== checkpoint.checkpointRootEnvelopeHash
    || terminal.candidatePartitionRoot !== checkpoint.candidatePartitionRoot
    || terminal.outcomePartitionRoot !== checkpoint.outcomePartitionRoot
    || !same(terminal.flushedOutcomeHashes, checkpoint.outcomeHashes)) throw new TypeError("pre-release restart terminal is not bound to the post-drain checkpoint");
  return Object.freeze({ ready: eventFact(ready), observed: eventFact(observed), drained: eventFact(drained), terminal, checkpoint });
}

export interface PreReleaseControllerDatabaseSnapshotPublicationV1 {
  readonly sourcePath: string;
  readonly snapshotPath: string;
  readonly contentSha256: Hash;
  readonly byteLength: string;
  readonly device: string;
  readonly inode: string;
  readonly uid: "0";
  readonly gid: "0";
  readonly mode: "384";
  readonly fileFsynced: true;
  readonly directoryFsynced: true;
}

interface SnapshotPolicyV1<Uid extends string, Gid extends string, Mode extends string> {
  readonly directory: string;
  readonly uid: number;
  readonly gid: number;
  readonly directoryMode: number;
  readonly fileMode: number;
  readonly uidText: Uid;
  readonly gidText: Gid;
  readonly modeText: Mode;
  readonly requireEffectiveUid: boolean;
}

const ROOT_SNAPSHOT_POLICY = Object.freeze({
  directory: LAYOUT.controllerDirectory,
  uid: 0,
  gid: 0,
  directoryMode: 0o700,
  fileMode: 0o600,
  uidText: "0" as const,
  gidText: "0" as const,
  modeText: "384" as const,
  requireEffectiveUid: true,
});

const ROOT_DIRECTORY_SNAPSHOT_POLICY = Object.freeze({
  directory: LAYOUT.controllerDirectory,
  uid: 0,
  gid: 0,
  directoryMode: 0o700,
  fileMode: 0o400,
  uidText: "0" as const,
  gidText: "0" as const,
  directoryModeText: "448" as const,
  fileModeText: "256" as const,
  requireEffectiveUid: true,
  requireLinuxDescriptorAnchor: true,
});

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  if (separator <= 0) throw new TypeError("pre-release durable snapshot path has no absolute parent");
  return path.slice(0, separator);
}

interface DirectorySnapshotPolicyV1<Uid extends string, Gid extends string, DirectoryMode extends string, FileMode extends string> {
  readonly directory: string;
  readonly uid: number;
  readonly gid: number;
  readonly directoryMode: number;
  readonly fileMode: number;
  readonly uidText: Uid;
  readonly gidText: Gid;
  readonly directoryModeText: DirectoryMode;
  readonly fileModeText: FileMode;
  readonly requireEffectiveUid: boolean;
  readonly requireLinuxDescriptorAnchor: boolean;
}

interface StableFlatSourceDescriptorV1 {
  readonly descriptor: number;
  readonly before: BigIntStats;
}

function readExactDescriptorBytes(descriptor: number, byteLength: bigint, label: string): Uint8Array {
  if (byteLength < 0n || byteLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} byte length cannot be allocated exactly`);
  }
  const bytes = new Uint8Array(Number(byteLength));
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (count === 0) throw new TypeError(`${label} was truncated during read`);
    offset += count;
  }
  return bytes;
}

function openStableFlatSourceEntry(
  sourceDirectoryAnchor: string,
  name: string,
  expectedByteLength: bigint | null,
  maximumByteLength: bigint | null,
): StableFlatSourceDescriptorV1 {
  const path = `${sourceDirectoryAnchor}/${name}`;
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o022n) !== 0n) {
      throw new TypeError(`pre-release durable directory source entry is not immutable: ${name}`);
    }
    if ((expectedByteLength !== null && before.size !== expectedByteLength)
      || (maximumByteLength !== null && before.size > maximumByteLength)) {
      throw new TypeError(`pre-release durable directory source entry exceeds its byte policy: ${name}`);
    }
    return Object.freeze({ descriptor, before });
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function readStableFlatSourceDescriptor(
  source: StableFlatSourceDescriptorV1,
  name: string,
): Readonly<{ readonly bytes: Uint8Array; readonly device: bigint; readonly inode: bigint }> {
  const bytes = readExactDescriptorBytes(
    source.descriptor,
    source.before.size,
    `pre-release durable directory source entry ${name}`,
  );
  const after = fstatSync(source.descriptor, { bigint: true });
  if (source.before.dev !== after.dev || source.before.ino !== after.ino || source.before.size !== after.size
    || source.before.mtimeNs !== after.mtimeNs || source.before.ctimeNs !== after.ctimeNs
    || after.size !== BigInt(bytes.byteLength)) {
    throw new TypeError(`pre-release durable directory source entry changed: ${name}`);
  }
  return Object.freeze({ bytes, device: after.dev, inode: after.ino });
}

function stableFlatSourceEntry(
  sourceDirectoryAnchor: string,
  name: string,
  expectedByteLength: bigint | null = null,
  maximumByteLength: bigint | null = null,
): Readonly<{
  readonly bytes: Uint8Array;
  readonly device: bigint;
  readonly inode: bigint;
}> {
  const source = openStableFlatSourceEntry(sourceDirectoryAnchor, name, expectedByteLength, maximumByteLength);
  try {
    return readStableFlatSourceDescriptor(source, name);
  } finally {
    closeSync(source.descriptor);
  }
}

function snapshotEntryName(kind: "observer-content" | "terminal-locator-index" | "six-step-boundaries", name: string): void {
  const valid = kind === "observer-content"
    ? name === ".aloha-observer-store-identity-v1" || /^[0-9a-f]{64}$/.test(name)
    : kind === "terminal-locator-index"
      ? /^[0-9a-f]{64}\.json$/.test(name)
      : /^[0-9a-f]{64}\.v8$/.test(name);
  if (!valid) throw new TypeError(`pre-release ${kind} source contains an unexpected entry: ${name}`);
}

function publishDirectorySnapshot<Uid extends string, Gid extends string, DirectoryMode extends string, FileMode extends string>(
  kind: "observer-content" | "terminal-locator-index" | "six-step-boundaries",
  sourceDirectory: string,
  snapshotDirectory: string,
  policy: DirectorySnapshotPolicyV1<Uid, Gid, DirectoryMode, FileMode>,
  expectedEntryCount: number | null,
  selectedNames: readonly string[] | null = null,
  afterSixStepPreflightForTest: (() => void) | null = null,
): Readonly<{
  readonly snapshotKind: "observer-content" | "terminal-locator-index" | "six-step-boundaries";
  readonly sourceDirectory: string;
  readonly snapshotDirectory: string;
  readonly observerStoreIdentityHash: Hash | null;
  readonly entries: readonly Readonly<{
    readonly name: string;
    readonly contentSha256: Hash;
    readonly byteLength: string;
    readonly device: string;
    readonly inode: string;
    readonly uid: Uid;
    readonly gid: Gid;
    readonly mode: FileMode;
    readonly fileFsynced: true;
  }>[];
  readonly entrySetRoot: Hash;
  readonly directoryDevice: string;
  readonly directoryInode: string;
  readonly uid: Uid;
  readonly gid: Gid;
  readonly mode: DirectoryMode;
  readonly directoryFsynced: true;
}> {
  if (policy.requireEffectiveUid && (typeof process.geteuid !== "function" || process.geteuid() !== policy.uid)) {
    throw new TypeError("pre-release durable directory snapshot requires the fixed effective uid");
  }
  if (sourceDirectory !== realpathSync(sourceDirectory) || !lstatSync(sourceDirectory).isDirectory()) {
    throw new TypeError(`pre-release ${kind} source directory is not physical`);
  }
  if (parentDirectory(snapshotDirectory) !== policy.directory || existsSync(snapshotDirectory)) {
    throw new TypeError(`pre-release ${kind} snapshot destination is not fresh and fixed`);
  }
  if (policy.requireLinuxDescriptorAnchor && process.platform !== "linux") {
    throw new TypeError(`pre-release ${kind} production snapshot requires a Linux directory-descriptor anchor`);
  }
  const temporaryDirectory = `${snapshotDirectory}.tmp.${process.pid}`;
  if (existsSync(temporaryDirectory)) throw new TypeError(`pre-release ${kind} snapshot temporary directory already exists`);
  const sourceDescriptor = openSync(
    sourceDirectory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  const sixStepBoundarySources = new Map<string, StableFlatSourceDescriptorV1>();
  const createdNames: string[] = [];
  try {
    const sourceBefore = fstatSync(sourceDescriptor, { bigint: true });
    const sourcePathBefore = statSync(sourceDirectory, { bigint: true });
    if (!sourceBefore.isDirectory() || (sourceBefore.mode & 0o022n) !== 0n
      || sourceBefore.dev !== sourcePathBefore.dev || sourceBefore.ino !== sourcePathBefore.ino) {
      throw new TypeError(`pre-release ${kind} source directory is mutable or changed before descriptor anchoring`);
    }
    const sourceDirectoryAnchor = process.platform === "linux"
      ? `/proc/self/fd/${sourceDescriptor}`
      : sourceDirectory;
    if (kind === "six-step-boundaries" && selectedNames === null) {
      throw new TypeError("pre-release Six-Step boundary snapshot requires terminal-index selected names");
    }
    const names = selectedNames === null
      ? readdirSync(sourceDirectoryAnchor).sort()
      : [...selectedNames];
    if ((names.length === 0 && !(kind === "six-step-boundaries" && selectedNames !== null))
      || (expectedEntryCount !== null && names.length !== expectedEntryCount)) {
      throw new TypeError(`pre-release ${kind} source denominator is not exact and non-empty`);
    }
    if (selectedNames !== null && kind !== "six-step-boundaries") {
      throw new TypeError("pre-release selected directory snapshot is restricted to Six-Step boundaries");
    }
    if (selectedNames !== null && names.some((name, index) => index > 0 && names[index - 1]! >= name)) {
      throw new TypeError("pre-release selected Six-Step boundary names are not strict-sorted and unique");
    }
    for (const name of names) snapshotEntryName(kind, name);
    if (kind === "six-step-boundaries") {
      const limits = PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1;
      if (names.length > limits.maxEntries) {
        throw new TypeError("pre-release six-step-boundaries source entry count exceeds policy");
      }
      let totalBytes = 0n;
      for (const name of names) {
        const source = openStableFlatSourceEntry(
          sourceDirectoryAnchor,
          name,
          null,
          BigInt(limits.maxEntryBytes),
        );
        sixStepBoundarySources.set(name, source);
        totalBytes += source.before.size;
        if (totalBytes > BigInt(limits.maxTotalBytes)) {
          throw new TypeError("pre-release six-step-boundaries source aggregate exceeds policy");
        }
      }
      afterSixStepPreflightForTest?.();
    }
    if (kind === "observer-content" && !names.includes(".aloha-observer-store-identity-v1")) {
      throw new TypeError("pre-release observer-content source lacks its store identity marker");
    }
    mkdirSync(temporaryDirectory, { mode: policy.directoryMode });
    let observerStoreIdentityHash: Hash | null = null;
    const entries = names.map(name => {
      const retainedSource = sixStepBoundarySources.get(name);
      const source = retainedSource === undefined
        ? stableFlatSourceEntry(
          sourceDirectoryAnchor,
          name,
          null,
          kind === "terminal-locator-index" ? BigInt(CANONICAL_LIMITS.maxBytes) : null,
        )
        : readStableFlatSourceDescriptor(retainedSource, name);
      const sourceSha256 = sha256Hex(source.bytes);
      if (kind === "observer-content") {
        if (/^[0-9a-f]{64}$/.test(name) && name !== sourceSha256.slice(2)) {
          throw new TypeError("pre-release observer-content object name does not equal its content hash");
        }
        if (name === ".aloha-observer-store-identity-v1"
          && !/^0x[0-9a-f]{64}\n$/.test(Buffer.from(source.bytes).toString("utf8"))) {
          throw new TypeError("pre-release observer-content store identity marker is invalid");
        }
        if (name === ".aloha-observer-store-identity-v1") {
          observerStoreIdentityHash = assertHash(
            Buffer.from(source.bytes).toString("utf8").slice(0, -1),
            "pre-release observer-content store identity marker",
          );
        }
      }
      const destination = `${temporaryDirectory}/${name}`;
      const descriptor = openSync(destination, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, policy.fileMode);
      try {
        fchownSync(descriptor, policy.uid, policy.gid);
        fchmodSync(descriptor, policy.fileMode);
        let offset = 0;
        while (offset < source.bytes.byteLength) {
          const written = writeSync(descriptor, source.bytes, offset, source.bytes.byteLength - offset, null);
          if (written <= 0) throw new TypeError(`pre-release ${kind} snapshot short write`);
          offset += written;
        }
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      createdNames.push(name);
      const published = statSync(destination, { bigint: true });
      const bytes = new Uint8Array(readFileSync(destination));
      const afterRead = statSync(destination, { bigint: true });
      if (!published.isFile() || published.dev !== afterRead.dev || published.ino !== afterRead.ino
        || published.size !== afterRead.size || published.mtimeNs !== afterRead.mtimeNs
        || published.ctimeNs !== afterRead.ctimeNs || afterRead.size !== BigInt(bytes.byteLength)
        || afterRead.uid !== BigInt(policy.uid) || afterRead.gid !== BigInt(policy.gid)
        || (afterRead.mode & 0o777n) !== BigInt(policy.fileMode)
        || sha256Hex(bytes) !== sourceSha256) {
        throw new TypeError(`pre-release ${kind} snapshot entry changed before publication`);
      }
      return Object.freeze({
        name,
        contentSha256: sha256Hex(bytes),
        byteLength: String(bytes.byteLength),
        device: String(afterRead.dev),
        inode: String(afterRead.ino),
        uid: policy.uidText,
        gid: policy.gidText,
        mode: policy.fileModeText,
        fileFsynced: true as const,
      });
    });
    const sourceAfter = fstatSync(sourceDescriptor, { bigint: true });
    const sourcePathAfter = statSync(sourceDirectory, { bigint: true });
    if (sourceBefore.dev !== sourceAfter.dev || sourceBefore.ino !== sourceAfter.ino
      || sourceBefore.mtimeNs !== sourceAfter.mtimeNs || sourceBefore.ctimeNs !== sourceAfter.ctimeNs
      || sourceAfter.dev !== sourcePathAfter.dev || sourceAfter.ino !== sourcePathAfter.ino
      || (selectedNames === null && readdirSync(sourceDirectoryAnchor).sort().join("\0") !== names.join("\0"))) {
      throw new TypeError(`pre-release ${kind} source directory changed during snapshot`);
    }
    const temporaryDescriptor = openSync(temporaryDirectory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      fchownSync(temporaryDescriptor, policy.uid, policy.gid);
      fchmodSync(temporaryDescriptor, policy.directoryMode);
      fsyncSync(temporaryDescriptor);
    } finally {
      closeSync(temporaryDescriptor);
    }
    renameSync(temporaryDirectory, snapshotDirectory);
    const parentDescriptor = openSync(policy.directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try { fsyncSync(parentDescriptor); } finally { closeSync(parentDescriptor); }
    const directory = statSync(snapshotDirectory, { bigint: true });
    if (!directory.isDirectory() || directory.uid !== BigInt(policy.uid) || directory.gid !== BigInt(policy.gid)
      || (directory.mode & 0o777n) !== BigInt(policy.directoryMode)) {
      throw new TypeError(`pre-release ${kind} snapshot directory identity mismatch`);
    }
    if (kind === "observer-content" && observerStoreIdentityHash === null) {
      throw new TypeError("pre-release observer-content snapshot lost its store identity marker");
    }
    const entrySetRoot = hashDomain("aloha/pre-release-directory-snapshot-entry-set/v1", {
      snapshotKind: kind,
      observerStoreIdentityHash,
      entries: entries.map(entry => ({ name: entry.name, contentSha256: entry.contentSha256, byteLength: entry.byteLength })),
    });
    return Object.freeze({
      snapshotKind: kind,
      sourceDirectory,
      snapshotDirectory,
      observerStoreIdentityHash,
      entries: Object.freeze(entries),
      entrySetRoot,
      directoryDevice: String(directory.dev),
      directoryInode: String(directory.ino),
      uid: policy.uidText,
      gid: policy.gidText,
      mode: policy.directoryModeText,
      directoryFsynced: true as const,
    });
  } catch (error) {
    if (existsSync(temporaryDirectory)) {
      for (const name of createdNames) {
        try { unlinkSync(`${temporaryDirectory}/${name}`); } catch { /* preserve snapshot error */ }
      }
      try { rmdirSync(temporaryDirectory); } catch { /* preserve snapshot error */ }
    }
    throw error;
  } finally {
    for (const source of sixStepBoundarySources.values()) closeSync(source.descriptor);
    closeSync(sourceDescriptor);
  }
}

const SIX_STEP_BOUNDARY_KEY_SEQUENCE_DOMAIN = "aloha/production-terminal-phase-six-step-boundary-key-sequence/v1";

function exactSelectedSixStepBoundaryNames(
  bytes: Uint8Array,
  indexName: string,
): readonly string[] {
  const value = decodeCanonicalJson(bytes);
  assertPlainObject(value, "terminalLocatorIndex");
  assertExactKeys(value, [
    "schemaVersion", "kind", "finalDurableWindowId", "locatorRoot", "locatorContentSha256",
    "locatorArtifactRefId", "locatorArtifact", "manifestRoot", "manifestContentSha256", "manifestArtifact",
    "fullFamilyProjectionArtifact", "fullFamilyTerminalBindingArtifact", "fullGraphCoarseSweepArtifact",
    "fullFamilyBundleArtifact", "fullFamilyLocatorArtifact", "sixStepTerminalBindingArtifact",
    "sixStepPredicateArtifacts", "sixStepPredicateArtifactPointerRoot", "sixStepBoundaryKeys",
    "sixStepBoundaryKeyRoot", "selectedProcessArtifact", "indexRoot",
  ], "terminalLocatorIndex");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.production-terminal-phase-locator-index-v1") {
    throw new TypeError("pre-release terminal locator index kind/version mismatch");
  }
  const finalDurableWindowId = assertHash(value.finalDurableWindowId, "terminalLocatorIndex.finalDurableWindowId");
  if (`${finalDurableWindowId.slice(2)}.json` !== indexName) {
    throw new TypeError("pre-release terminal locator index name/final-window mismatch");
  }
  if (!Array.isArray(value.sixStepBoundaryKeys)
    || value.sixStepBoundaryKeys.length > PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxEntries
    || Object.keys(value.sixStepBoundaryKeys).length !== value.sixStepBoundaryKeys.length) {
    throw new TypeError("pre-release terminal locator index Six-Step boundary keys are not a bounded dense array");
  }
  let previous: Hash | null = null;
  const keys = Object.freeze(value.sixStepBoundaryKeys.map((item, index) => {
    const key = assertHash(item, `terminalLocatorIndex.sixStepBoundaryKeys[${index}]`);
    if (previous !== null && previous >= key) {
      throw new TypeError("pre-release terminal locator index Six-Step boundary keys are not strict-sorted and unique");
    }
    previous = key;
    return key;
  }));
  if (keys.length !== 0 && (keys.length < 8 || (keys.length - 4) % 2 !== 0)) {
    throw new TypeError("pre-release terminal locator index Six-Step boundary key denominator is not exact 2L+4");
  }
  const expectedRoot = hashCanonicalPartition(SIX_STEP_BOUNDARY_KEY_SEQUENCE_DOMAIN, keys, 16);
  if (assertHash(value.sixStepBoundaryKeyRoot, "terminalLocatorIndex.sixStepBoundaryKeyRoot") !== expectedRoot) {
    throw new TypeError("pre-release terminal locator index Six-Step boundary key root mismatch");
  }
  const { indexRoot: rawIndexRoot, ...payload } = value;
  if (assertHash(rawIndexRoot, "terminalLocatorIndex.indexRoot")
    !== hashDomain("aloha/production-terminal-phase-locator-index/v1", payload as never)) {
    throw new TypeError("pre-release terminal locator index root mismatch");
  }
  return Object.freeze(keys.map(key => `${key.slice(2)}.v8`));
}

function singlePriorTerminalLocatorEntry<Uid extends string, Gid extends string, DirectoryMode extends string, FileMode extends string>(
  directory: string,
  policy: DirectorySnapshotPolicyV1<Uid, Gid, DirectoryMode, FileMode>,
): Readonly<{ readonly name: string; readonly contentSha256: Hash; readonly byteLength: string }> {
  if (directory !== realpathSync(directory) || !lstatSync(directory).isDirectory()) {
    throw new TypeError("pre-release A terminal locator snapshot is not physical");
  }
  const descriptor = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isDirectory() || before.uid !== BigInt(policy.uid) || before.gid !== BigInt(policy.gid)
      || (before.mode & 0o777n) !== BigInt(policy.directoryMode)) {
      throw new TypeError("pre-release A terminal locator snapshot is not fixed-owner");
    }
    const anchor = process.platform === "linux" ? `/proc/self/fd/${descriptor}` : directory;
    const names = readdirSync(anchor);
    if (names.length !== 1) throw new TypeError("pre-release A terminal locator snapshot denominator is not exactly one");
    snapshotEntryName("terminal-locator-index", names[0]!);
    const entry = stableFlatSourceEntry(anchor, names[0]!, null, BigInt(CANONICAL_LIMITS.maxBytes));
    const entryPath = `${anchor}/${names[0]!}`;
    const entryMetadata = statSync(entryPath, { bigint: true });
    if (entryMetadata.dev !== entry.device || entryMetadata.ino !== entry.inode
      || entryMetadata.uid !== BigInt(policy.uid) || entryMetadata.gid !== BigInt(policy.gid)
      || (entryMetadata.mode & 0o777n) !== BigInt(policy.fileMode)) {
      throw new TypeError("pre-release A terminal locator snapshot index is not fixed-owner and bounded");
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new TypeError("pre-release A terminal locator snapshot changed during selection");
    }
    return Object.freeze({
      name: names[0]!,
      contentSha256: sha256Hex(entry.bytes),
      byteLength: String(entry.bytes.byteLength),
    });
  } finally {
    closeSync(descriptor);
  }
}

function selectedSixStepBoundaryNames<Uid extends string, Gid extends string, DirectoryMode extends string, FileMode extends string>(
  terminalLocators: PreReleaseControllerDirectorySnapshotV1,
  priorTerminalLocatorSnapshotDirectory: string | null,
  policy: DirectorySnapshotPolicyV1<Uid, Gid, DirectoryMode, FileMode>,
): readonly string[] {
  const expectedCount = priorTerminalLocatorSnapshotDirectory === null ? 1 : 2;
  if (terminalLocators.snapshotKind !== "terminal-locator-index"
    || terminalLocators.entries.length !== expectedCount) {
    throw new TypeError(`pre-release terminal locator snapshot denominator is not exactly ${expectedCount}`);
  }
  const priorEntry = priorTerminalLocatorSnapshotDirectory === null
    ? null
    : singlePriorTerminalLocatorEntry(priorTerminalLocatorSnapshotDirectory, policy);
  const selectedEntries = priorEntry === null
    ? terminalLocators.entries
    : terminalLocators.entries.filter(entry => entry.name !== priorEntry.name);
  if (selectedEntries.length !== 1
    || (priorEntry !== null && !terminalLocators.entries.some(entry => entry.name === priorEntry.name))) {
    throw new TypeError("pre-release B terminal locator snapshot does not have one exact successor index");
  }
  if (priorEntry !== null) {
    const carriedPredecessor = terminalLocators.entries.find(entry => entry.name === priorEntry.name)!;
    if (carriedPredecessor.contentSha256 !== priorEntry.contentSha256
      || carriedPredecessor.byteLength !== priorEntry.byteLength) {
      throw new TypeError("pre-release B terminal locator predecessor content does not equal the fixed A snapshot");
    }
  }
  const selected = selectedEntries[0]!;
  const descriptor = openSync(
    terminalLocators.snapshotDirectory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const directoryBefore = fstatSync(descriptor, { bigint: true });
    if (String(directoryBefore.dev) !== terminalLocators.directoryDevice
      || String(directoryBefore.ino) !== terminalLocators.directoryInode) {
      throw new TypeError("pre-release terminal locator snapshot directory identity changed");
    }
    const anchor = process.platform === "linux" ? `/proc/self/fd/${descriptor}` : terminalLocators.snapshotDirectory;
    const currentNames = readdirSync(anchor).sort();
    if (currentNames.length !== terminalLocators.entries.length
      || currentNames.some((name, index) => name !== terminalLocators.entries[index]?.name)) {
      throw new TypeError("pre-release terminal locator snapshot denominator changed before selected index read");
    }
    const expectedByteLength = BigInt(assertDecimalString(selected.byteLength, "terminalLocatorIndex.byteLength"));
    const source = stableFlatSourceEntry(
      anchor,
      selected.name,
      expectedByteLength,
      BigInt(CANONICAL_LIMITS.maxBytes),
    );
    if (String(source.device) !== selected.device || String(source.inode) !== selected.inode
      || sha256Hex(source.bytes) !== selected.contentSha256) {
      throw new TypeError("pre-release selected terminal locator index identity changed");
    }
    const directoryAfter = fstatSync(descriptor, { bigint: true });
    if (directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino
      || directoryBefore.mtimeNs !== directoryAfter.mtimeNs || directoryBefore.ctimeNs !== directoryAfter.ctimeNs) {
      throw new TypeError("pre-release terminal locator snapshot changed during selected index read");
    }
    return exactSelectedSixStepBoundaryNames(source.bytes, selected.name);
  } finally {
    closeSync(descriptor);
  }
}

function stableBoundedPhysicalDescriptor(
  descriptor: number,
  maximumByteLength: bigint,
  label: string,
) {
  const before = fstatSync(descriptor, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size > maximumByteLength) {
    throw new TypeError(`${label} identity or byte length is invalid`);
  }
  const bytes = readExactDescriptorBytes(descriptor, before.size, label);
  const after = fstatSync(descriptor, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs || after.size !== BigInt(bytes.byteLength)) {
    throw new TypeError(`${label} changed during read`);
  }
  return Object.freeze({ bytes, stat: after });
}

function publishPhysicalFileSnapshot(
  sourcePath: string,
  snapshotPath: string,
  maximumByteLength: bigint,
): PreReleaseControllerPhysicalFileSnapshotV1 {
  if (typeof process.geteuid !== "function" || process.geteuid() !== 0) {
    throw new TypeError("pre-release physical-file snapshot requires root");
  }
  if (parentDirectory(snapshotPath) !== LAYOUT.controllerDirectory || existsSync(snapshotPath)) {
    throw new TypeError("pre-release physical-file snapshot destination is not fresh and fixed");
  }
  if (realpathSync(sourcePath) !== sourcePath || !lstatSync(sourcePath).isFile()) {
    throw new TypeError("pre-release physical-file snapshot source is not physical");
  }
  const sourceDescriptor = openSync(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const temporaryPath = `${snapshotPath}.tmp.${process.pid}`;
  let destinationDescriptor: number | null = null;
  try {
    const source = stableBoundedPhysicalDescriptor(
      sourceDescriptor,
      maximumByteLength,
      "pre-release physical-file snapshot source",
    );
    const { bytes } = source;
    destinationDescriptor = openSync(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o400,
    );
    fchownSync(destinationDescriptor, 0, 0);
    fchmodSync(destinationDescriptor, 0o400);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(destinationDescriptor, bytes, offset, bytes.byteLength - offset, null);
      if (written <= 0) throw new TypeError("pre-release physical-file snapshot short write");
      offset += written;
    }
    fsyncSync(destinationDescriptor);
    closeSync(destinationDescriptor);
    destinationDescriptor = null;
    linkSync(temporaryPath, snapshotPath);
    unlinkSync(temporaryPath);
    const parentDescriptor = openSync(LAYOUT.controllerDirectory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try { fsyncSync(parentDescriptor); } finally { closeSync(parentDescriptor); }
    const snapshot = readStableOwnedPhysicalFileV1(snapshotPath, Object.freeze({
      uid: 0n,
      gid: 0n,
      mode: 0o400n,
      maximumByteLength,
    }));
    const snapshotBytes = snapshot.bytes;
    const snapshotAfter = snapshot.stat;
    if (sha256Hex(snapshotBytes) !== sha256Hex(bytes)) {
      throw new TypeError("pre-release physical-file snapshot changed before publication");
    }
    return Object.freeze({
      sourcePath,
      sourceDevice: String(source.stat.dev),
      sourceInode: String(source.stat.ino),
      snapshotPath,
      contentSha256: sha256Hex(snapshotBytes),
      byteLength: String(snapshotBytes.byteLength),
      device: String(snapshotAfter.dev),
      inode: String(snapshotAfter.ino),
      uid: "0" as const,
      gid: "0" as const,
      mode: "256" as const,
      fileFsynced: true as const,
      directoryFsynced: true as const,
    });
  } finally {
    closeSync(sourceDescriptor);
    if (destinationDescriptor !== null) closeSync(destinationDescriptor);
    try { if (existsSync(temporaryPath)) unlinkSync(temporaryPath); } catch { /* preserve snapshot error */ }
  }
}

async function publishDatabaseSnapshot<Uid extends string, Gid extends string, Mode extends string>(
  sourcePath: string,
  snapshotPath: string,
  policy: SnapshotPolicyV1<Uid, Gid, Mode>,
): Promise<Omit<PreReleaseControllerDatabaseSnapshotPublicationV1, "uid" | "gid" | "mode"> & Readonly<{ readonly uid: Uid; readonly gid: Gid; readonly mode: Mode }>> {
  if (policy.requireEffectiveUid && (typeof process.geteuid !== "function" || process.geteuid() !== policy.uid)) throw new TypeError("pre-release durable snapshot requires the fixed effective uid");
  if (existsSync(snapshotPath)) throw new TypeError(`pre-release durable snapshot already exists: ${snapshotPath}`);
  const directory = policy.directory;
  if (parentDirectory(snapshotPath) !== directory) throw new TypeError("pre-release durable snapshot is outside its fixed directory");
  if (realpathSync(directory) !== directory) throw new TypeError("pre-release durable snapshot directory is not canonical");
  const directoryBefore = statSync(directory, { bigint: true });
  if (!directoryBefore.isDirectory() || directoryBefore.uid !== BigInt(policy.uid) || directoryBefore.gid !== BigInt(policy.gid)
    || (directoryBefore.mode & 0o777n) !== BigInt(policy.directoryMode)) throw new TypeError("pre-release durable snapshot directory owner/mode mismatch");
  exactPhysicalPath(sourcePath, sourcePath);
  const sourceBefore = statSync(sourcePath, { bigint: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const temporaryPath = `${snapshotPath}.tmp.${process.pid}`;
  let ownsTemporaryPath = false;
  try {
    const databaseList = source.prepare("PRAGMA database_list").all() as readonly Record<string, unknown>[];
    const sourceAfter = statSync(sourcePath, { bigint: true });
    if (databaseList.length !== 1 || databaseList[0]?.name !== "main" || databaseList[0]?.file !== sourcePath
      || sourceBefore.dev !== sourceAfter.dev || sourceBefore.ino !== sourceAfter.ino
      || sourceBefore.uid !== sourceAfter.uid || sourceBefore.gid !== sourceAfter.gid || sourceBefore.mode !== sourceAfter.mode) {
      throw new TypeError("pre-release durable source changed across snapshot open");
    }
    if (existsSync(temporaryPath)) throw new TypeError("pre-release durable snapshot temporary path already exists");
    ownsTemporaryPath = true;
    await backup(source, temporaryPath);
  } catch (error) {
    if (ownsTemporaryPath) {
      try { if (existsSync(temporaryPath)) unlinkSync(temporaryPath); } catch { /* preserve backup error */ }
    }
    throw error;
  } finally {
    source.close();
  }
  try {
    const descriptor = openSync(temporaryPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      fchownSync(descriptor, policy.uid, policy.gid);
      fchmodSync(descriptor, policy.fileMode);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const verification = new DatabaseSync(temporaryPath, { readOnly: true });
    try {
      const integrity = verification.prepare("PRAGMA integrity_check").all() as readonly Record<string, unknown>[];
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new TypeError("pre-release durable snapshot integrity check failed");
    } finally {
      verification.close();
    }
    const beforeRead = statSync(temporaryPath, { bigint: true });
    const bytes = new Uint8Array(readFileSync(temporaryPath));
    const afterRead = statSync(temporaryPath, { bigint: true });
    if (beforeRead.dev !== afterRead.dev || beforeRead.ino !== afterRead.ino || beforeRead.size !== afterRead.size
      || beforeRead.mtimeNs !== afterRead.mtimeNs || beforeRead.ctimeNs !== afterRead.ctimeNs
      || afterRead.uid !== BigInt(policy.uid) || afterRead.gid !== BigInt(policy.gid) || (afterRead.mode & 0o777n) !== BigInt(policy.fileMode)
      || afterRead.size !== BigInt(bytes.byteLength)) throw new TypeError("pre-release durable snapshot changed before publication");
    linkSync(temporaryPath, snapshotPath);
    unlinkSync(temporaryPath);
    const directoryDescriptor = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    const published = statSync(snapshotPath, { bigint: true });
    const publishedBytes = new Uint8Array(readFileSync(snapshotPath));
    const publishedAfterRead = statSync(snapshotPath, { bigint: true });
    const directoryAfter = statSync(directory, { bigint: true });
    if (published.dev !== afterRead.dev || published.ino !== afterRead.ino
      || published.dev !== publishedAfterRead.dev || published.ino !== publishedAfterRead.ino
      || published.size !== publishedAfterRead.size || published.mtimeNs !== publishedAfterRead.mtimeNs
      || published.ctimeNs !== publishedAfterRead.ctimeNs || published.size !== BigInt(publishedBytes.byteLength)
      || sha256Hex(publishedBytes) !== sha256Hex(bytes)
      || directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino
      || directoryAfter.uid !== BigInt(policy.uid) || directoryAfter.gid !== BigInt(policy.gid) || (directoryAfter.mode & 0o777n) !== BigInt(policy.directoryMode)) {
      throw new TypeError("pre-release durable snapshot publication identity changed");
    }
    return Object.freeze({
      sourcePath,
      snapshotPath,
      contentSha256: sha256Hex(bytes),
      byteLength: String(bytes.byteLength),
      device: String(published.dev),
      inode: String(published.ino),
      uid: policy.uidText,
      gid: policy.gidText,
      mode: policy.modeText,
      fileFsynced: true as const,
      directoryFsynced: true as const,
    });
  } catch (error) {
    try { if (existsSync(temporaryPath)) unlinkSync(temporaryPath); } catch { /* preserve snapshot error */ }
    throw error;
  }
}

/** Test-closure exerciser for the same backup/no-clobber/fsync implementation.
 * Production callers cannot select paths or ownership and use only the fixed
 * root wrappers below. */
export function readBoundedPhysicalFileForTestV1(
  path: string,
  maximumByteLength: number,
): Uint8Array {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return stableBoundedPhysicalDescriptor(
      descriptor,
      BigInt(maximumByteLength),
      "test physical file",
    ).bytes;
  } finally {
    closeSync(descriptor);
  }
}

export async function snapshotSqliteDatabaseForTestV1(
  sourcePath: string,
  snapshotPath: string,
  directory: string,
): Promise<Readonly<Record<string, unknown>>> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new TypeError("snapshot test closure requires POSIX ownership");
  return publishDatabaseSnapshot(sourcePath, snapshotPath, Object.freeze({
    directory,
    uid,
    gid,
    directoryMode: 0o700,
    fileMode: 0o600,
    uidText: String(uid),
    gidText: String(gid),
    modeText: "384",
    requireEffectiveUid: false,
  }));
}

/** Test-closure exerciser for the exact flat-directory copy/no-clobber/fsync
 * implementation. Production callers cannot select paths or ownership. */
export function snapshotFlatDirectoryForTestV1(
  kind: "observer-content" | "terminal-locator-index",
  sourceDirectory: string,
  snapshotDirectory: string,
  directory: string,
  terminalLocatorExpectedEntryCount = 1,
): Readonly<Record<string, unknown>> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new TypeError("snapshot test closure requires POSIX ownership");
  return publishDirectorySnapshot(kind, sourceDirectory, snapshotDirectory, Object.freeze({
    directory,
    uid,
    gid,
    directoryMode: 0o700,
    fileMode: 0o400,
    uidText: String(uid),
    gidText: String(gid),
    directoryModeText: "448",
    fileModeText: "256",
    requireEffectiveUid: false,
    requireLinuxDescriptorAnchor: false,
  }), kind === "terminal-locator-index" ? terminalLocatorExpectedEntryCount : null);
}

/** Test-closure exerciser for the production selector. Boundary names are
 * always decoded from the selected terminal index; the caller cannot supply
 * a boundary-name list. */
export function snapshotSelectedSixStepBoundariesForTestV1(
  sourceDirectory: string,
  snapshotDirectory: string,
  directory: string,
  terminalLocators: PreReleaseControllerDirectorySnapshotV1,
  priorTerminalLocatorSnapshotDirectory: string | null = null,
  afterPreflightForTest: (() => void) | null = null,
): Readonly<Record<string, unknown>> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new TypeError("snapshot test closure requires POSIX ownership");
  const policy = Object.freeze({
    directory,
    uid,
    gid,
    directoryMode: 0o700,
    fileMode: 0o400,
    uidText: String(uid),
    gidText: String(gid),
    directoryModeText: "448" as const,
    fileModeText: "256" as const,
    requireEffectiveUid: false,
    requireLinuxDescriptorAnchor: false,
  });
  const names = selectedSixStepBoundaryNames(terminalLocators, priorTerminalLocatorSnapshotDirectory, policy);
  return publishDirectorySnapshot(
    "six-step-boundaries",
    sourceDirectory,
    snapshotDirectory,
    policy,
    names.length,
    names,
    afterPreflightForTest,
  );
}

export async function publishPreReleaseADurableSnapshotsV1(): Promise<Readonly<{
  readonly processEvidence: PreReleaseControllerDatabaseSnapshotPublicationV1;
  readonly checkpoint: PreReleaseControllerDatabaseSnapshotPublicationV1;
  readonly observerContent: PreReleaseControllerDirectorySnapshotV1;
  readonly terminalLocators: PreReleaseControllerDirectorySnapshotV1;
  readonly sixStepEvidenceLog: PreReleaseControllerPhysicalFileSnapshotV1;
  readonly sixStepBoundaries: PreReleaseControllerDirectorySnapshotV1;
  readonly snapshotRoot: Hash;
}>> {
  const processEvidence = await publishDatabaseSnapshot(LAYOUT.processEvidenceDatabasePath, LAYOUT.processEvidenceSnapshotPath, ROOT_SNAPSHOT_POLICY);
  const checkpoint = await publishDatabaseSnapshot(LAYOUT.checkpointDatabasePath, LAYOUT.checkpointSnapshotPath, ROOT_SNAPSHOT_POLICY);
  const observerContent = publishDirectorySnapshot(
    "observer-content",
    LAYOUT.observerContentDirectory,
    LAYOUT.observerContentSnapshotDirectory,
    ROOT_DIRECTORY_SNAPSHOT_POLICY,
    null,
  ) as PreReleaseControllerDirectorySnapshotV1;
  const terminalLocators = publishDirectorySnapshot(
    "terminal-locator-index",
    LAYOUT.terminalLocatorDirectory,
    LAYOUT.terminalLocatorSnapshotDirectory,
    ROOT_DIRECTORY_SNAPSHOT_POLICY,
    1,
  ) as PreReleaseControllerDirectorySnapshotV1;
  const sixStepEvidenceLog = publishPhysicalFileSnapshot(
    LAYOUT.sixStepEvidenceLogPath,
    LAYOUT.sixStepEvidenceLogSnapshotPath,
    BigInt(PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxLedgerBytes),
  );
  const selectedBoundaryNames = selectedSixStepBoundaryNames(terminalLocators, null, ROOT_DIRECTORY_SNAPSHOT_POLICY);
  const sixStepBoundaries = publishDirectorySnapshot(
    "six-step-boundaries",
    LAYOUT.sixStepBoundaryDirectory,
    LAYOUT.sixStepBoundarySnapshotDirectory,
    ROOT_DIRECTORY_SNAPSHOT_POLICY,
    selectedBoundaryNames.length,
    selectedBoundaryNames,
  ) as PreReleaseControllerDirectorySnapshotV1;
  const payload = Object.freeze({ processEvidence, checkpoint, observerContent, terminalLocators, sixStepEvidenceLog, sixStepBoundaries });
  return Object.freeze({ ...payload, snapshotRoot: hashDomain("aloha/pre-release-a-durable-snapshots/v1", payload as never) });
}

export async function publishPreReleaseBDurableSnapshotsV1(): Promise<Readonly<{
  readonly processEvidence: PreReleaseControllerDatabaseSnapshotPublicationV1;
  readonly checkpoint: PreReleaseControllerDatabaseSnapshotPublicationV1;
  readonly observerContent: PreReleaseControllerDirectorySnapshotV1;
  readonly terminalLocators: PreReleaseControllerDirectorySnapshotV1;
  readonly sixStepEvidenceLog: PreReleaseControllerPhysicalFileSnapshotV1;
  readonly sixStepBoundaries: PreReleaseControllerDirectorySnapshotV1;
  readonly snapshotRoot: Hash;
}>> {
  const processEvidence = await publishDatabaseSnapshot(LAYOUT.processEvidenceDatabasePath, LAYOUT.bProcessEvidenceSnapshotPath, ROOT_SNAPSHOT_POLICY);
  const checkpoint = await publishDatabaseSnapshot(LAYOUT.checkpointDatabasePath, LAYOUT.bCheckpointSnapshotPath, ROOT_SNAPSHOT_POLICY);
  const observerContent = publishDirectorySnapshot(
    "observer-content",
    LAYOUT.observerContentDirectory,
    LAYOUT.bObserverContentSnapshotDirectory,
    ROOT_DIRECTORY_SNAPSHOT_POLICY,
    null,
  ) as PreReleaseControllerDirectorySnapshotV1;
  const terminalLocators = publishDirectorySnapshot(
    "terminal-locator-index",
    LAYOUT.terminalLocatorDirectory,
    LAYOUT.bTerminalLocatorSnapshotDirectory,
    ROOT_DIRECTORY_SNAPSHOT_POLICY,
    2,
  ) as PreReleaseControllerDirectorySnapshotV1;
  const sixStepEvidenceLog = publishPhysicalFileSnapshot(
    LAYOUT.sixStepEvidenceLogPath,
    LAYOUT.bSixStepEvidenceLogSnapshotPath,
    BigInt(PRE_RELEASE_SIX_STEP_BOUNDARY_SNAPSHOT_LIMITS_V1.maxLedgerBytes),
  );
  const selectedBoundaryNames = selectedSixStepBoundaryNames(
    terminalLocators,
    LAYOUT.terminalLocatorSnapshotDirectory,
    ROOT_DIRECTORY_SNAPSHOT_POLICY,
  );
  const sixStepBoundaries = publishDirectorySnapshot(
    "six-step-boundaries",
    LAYOUT.sixStepBoundaryDirectory,
    LAYOUT.bSixStepBoundarySnapshotDirectory,
    ROOT_DIRECTORY_SNAPSHOT_POLICY,
    selectedBoundaryNames.length,
    selectedBoundaryNames,
  ) as PreReleaseControllerDirectorySnapshotV1;
  const payload = Object.freeze({ processEvidence, checkpoint, observerContent, terminalLocators, sixStepEvidenceLog, sixStepBoundaries });
  return Object.freeze({ ...payload, snapshotRoot: hashDomain("aloha/pre-release-b-durable-snapshots/v1", payload as never) });
}

export interface PreReleaseBReadyFactsV1 {
  readonly readyEvent: ObservedRuntimeAcceptanceProcessEventV1;
  readonly ready: PreReleaseControllerEventFactV1;
  readonly processAnchor: ProcessAnchorV1;
  readonly runtimeAnchor: Readonly<Record<string, unknown>>;
  readonly checkpoint: PreReleaseControllerCheckpointFactV1;
}

export function observePreReleaseBReadyFactsV1(
  predecessor: Readonly<{
    readonly releaseProvenanceHash: Hash;
    readonly candidateReleaseCommit: string;
    readonly runtimeBindingId: Hash;
    readonly processReadyEventId: Hash;
    readonly sigtermObservedEventId: Hash;
    readonly sigtermDrainedEventId: Hash;
    readonly predecessorProcessAnchorHash: Hash;
    readonly checkpointRootEnvelopeHash: Hash;
    readonly candidatePartitionRoot: Hash;
    readonly outcomePartitionRoot: Hash;
    readonly outcomeHashes: readonly Hash[];
  }>,
  databasePaths: Readonly<{ readonly processEvidence: string; readonly checkpoint: string }> = Object.freeze({
    processEvidence: LAYOUT.processEvidenceDatabasePath,
    checkpoint: LAYOUT.checkpointDatabasePath,
  }),
): PreReleaseBReadyFactsV1 {
  const { events, restartTerminalCount } = readProcessDurableStateV1(databasePaths.processEvidence);
  if (events.length !== 4 || restartTerminalCount !== 1) throw new TypeError("pre-release B requires exact A triplet, one terminal, and one B ready event");
  const [aReady, observed, drained, bReady] = events;
  if (aReady?.kind !== "aloha.runtime-process-ready" || observed?.kind !== "aloha.runtime-sigterm-observed"
    || drained?.kind !== "aloha.runtime-sigterm-drained" || bReady?.kind !== "aloha.runtime-process-ready"
    || aReady.eventId !== predecessor.processReadyEventId || observed.eventId !== predecessor.sigtermObservedEventId
    || drained.eventId !== predecessor.sigtermDrainedEventId || aReady.processAnchorHash !== predecessor.predecessorProcessAnchorHash
    || bReady.processAnchorHash === predecessor.predecessorProcessAnchorHash
    || observed.processReadyEventId !== aReady.eventId || drained.sigtermObservedEventId !== observed.eventId
    || bReady.release.releaseProvenanceHash !== predecessor.releaseProvenanceHash
    || bReady.release.bindingId !== predecessor.runtimeBindingId
    || bReady.release.candidateReleaseCommit !== predecessor.candidateReleaseCommit) {
    throw new TypeError("pre-release B ready lineage does not exact-join the stopped A predecessor");
  }
  assertPlainObject(bReady.processAnchor, "preReleaseBReady.processAnchor");
  assertPlainObject(bReady.runtimeAnchor, "preReleaseBReady.runtimeAnchor");
  const processAnchor = decodeProcessAnchor(bReady.processAnchor as object);
  if (hashProcessAnchor(processAnchor) !== bReady.processAnchorHash) throw new TypeError("pre-release B embedded process anchor hash mismatch");
  const checkpoint = observeCurrentCheckpointFactV1(databasePaths.checkpoint);
  if (checkpoint.checkpointRootEnvelopeHash !== predecessor.checkpointRootEnvelopeHash
    || checkpoint.candidatePartitionRoot !== predecessor.candidatePartitionRoot
    || checkpoint.outcomePartitionRoot !== predecessor.outcomePartitionRoot
    || !same(checkpoint.outcomeHashes, predecessor.outcomeHashes)) {
    throw new TypeError("pre-release B checkpoint does not recover the exact A terminal partition");
  }
  return Object.freeze({
    readyEvent: bReady,
    ready: eventFact(bReady),
    processAnchor,
    runtimeAnchor: bReady.runtimeAnchor as Readonly<Record<string, unknown>>,
    checkpoint,
  });
}
