import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  assertDecimalString,
  assertExactKeys,
  assertGitSha40,
  assertHash,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { decodeProcessAnchor, hashProcessAnchor, type ProcessAnchorV1 } from "../../../specs/core-envelope/src/index.ts";

const ZERO_HASH = `0x${"0".repeat(64)}` as Hash;
const NAMESPACE_PREFIX = "runtime-acceptance-process-v1:";
const EVENT_DOMAIN = "aloha/runtime-acceptance-process-event/v1";

interface ReadonlySqliteStatement {
  all(...parameters: readonly (string | number | bigint | Uint8Array | null)[]): readonly unknown[];
}

interface ReadonlySqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): ReadonlySqliteStatement;
  close(): void;
}

interface StorageSetV1 {
  readonly mainSha256: Hash;
  readonly root: Hash;
}

export interface RuntimeAcceptanceReleaseIdentityV1 {
  readonly bindingId: Hash;
  readonly releaseProvenanceHash: Hash;
  readonly candidateReleaseCommit: string;
}

export interface ObservedRuntimeAcceptanceProcessEventV1 extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: 1;
  readonly kind: "aloha.runtime-process-ready" | "aloha.runtime-sigterm-observed" | "aloha.runtime-sigterm-drained";
  readonly sequence: string;
  readonly release: RuntimeAcceptanceReleaseIdentityV1;
  readonly processAnchorHash: Hash;
  readonly eventId: Hash;
}

export interface RawRuntimeAcceptanceObservationV1 {
  readonly kind: "aloha.raw-runtime-acceptance-observation-v1";
  readonly status: "raw-complete" | "incomplete" | "invalid";
  readonly reasons: readonly string[];
  readonly databaseSha256Before: Hash;
  readonly databaseSha256After: Hash;
  readonly storageSetRootBefore: Hash;
  readonly storageSetRootAfter: Hash;
  readonly sqliteSchemaRoot: Hash;
  readonly rawRowRoot: Hash;
  readonly eventRoot: Hash;
  readonly events: readonly ObservedRuntimeAcceptanceProcessEventV1[];
  readonly processLogs: readonly ObservedRuntimeProcessLogV1[];
}

export interface ObservedRuntimeProcessLogV1 {
  readonly processReadyEventId: Hash;
  readonly processAnchorHash: Hash;
  readonly logAnchor: Readonly<{
    readonly systemId: string;
    readonly bootIdHash: Hash;
    readonly device: string;
    readonly inode: string;
    readonly startInclusive: string;
    readonly endExclusive: string;
    readonly contentSha256: Hash;
  }>;
}

interface RuntimeAppendRowV1 {
  readonly namespace: string;
  readonly sequence: string;
  readonly eventId: Hash;
  readonly contentSha256: Hash;
  readonly bytes: Uint8Array;
  readonly byteLength: string;
  readonly offsetStart: string;
  readonly offsetEnd: string;
}

function openReadonly(filename: string): ReadonlySqliteDatabase {
  return new DatabaseSync(filename, { readOnly: true }) as unknown as ReadonlySqliteDatabase;
}

function storageSet(path: string): StorageSetV1 {
  const files = [
    { role: "main", path, required: true },
    { role: "wal", path: `${path}-wal`, required: false },
  ].flatMap(file => {
    if (!existsSync(file.path)) {
      if (file.required) throw new TypeError("runtime acceptance SQLite main file is missing");
      return [];
    }
    const bytes = readFileSync(file.path);
    return [{ role: file.role, byteLength: String(bytes.byteLength), sha256: sha256Hex(bytes) }];
  });
  const main = files.find(file => file.role === "main");
  if (main === undefined) throw new TypeError("runtime acceptance SQLite main file is missing");
  return Object.freeze({
    mainSha256: main.sha256,
    root: hashDomain("aloha/raw-runtime-acceptance-sqlite-storage-set/v1", files),
  });
}

function normalizedSql(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/;$/, "").trim();
}

const EXPECTED_SCHEMA_OBJECTS = new Map<string, string>([
  ["table\0durable_append_log", normalizedSql(`
    CREATE TABLE durable_append_log (
      namespace TEXT NOT NULL CHECK (length(namespace) > 0),
      sequence TEXT NOT NULL CHECK (sequence = '0' OR (length(sequence) > 0 AND sequence NOT LIKE '0%' AND sequence NOT GLOB '*[^0-9]*')),
      event_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      bytes BLOB NOT NULL,
      byte_length TEXT NOT NULL CHECK (byte_length = '0' OR (length(byte_length) > 0 AND byte_length NOT LIKE '0%' AND byte_length NOT GLOB '*[^0-9]*')),
      offset_start TEXT NOT NULL CHECK (offset_start = '0' OR (length(offset_start) > 0 AND offset_start NOT LIKE '0%' AND offset_start NOT GLOB '*[^0-9]*')),
      offset_end TEXT NOT NULL CHECK (offset_end = '0' OR (length(offset_end) > 0 AND offset_end NOT LIKE '0%' AND offset_end NOT GLOB '*[^0-9]*')),
      PRIMARY KEY(namespace, sequence),
      UNIQUE(namespace, event_id)
    )
  `)],
  ["table\0durable_append_log_schema_contract", normalizedSql(`
    CREATE TABLE durable_append_log_schema_contract (
      contract_id INTEGER PRIMARY KEY CHECK (contract_id = 1),
      schema_version TEXT NOT NULL,
      schema_digest TEXT NOT NULL,
      core_schema_digest TEXT NOT NULL,
      core_instance_nonce TEXT NOT NULL
    )
  `)],
  ["trigger\0durable_append_log_no_update", normalizedSql(`
    CREATE TRIGGER durable_append_log_no_update
    BEFORE UPDATE ON durable_append_log
    BEGIN
      SELECT RAISE(ABORT, 'durable append-log is append-only');
    END
  `)],
  ["trigger\0durable_append_log_no_delete", normalizedSql(`
    CREATE TRIGGER durable_append_log_no_delete
    BEFORE DELETE ON durable_append_log
    BEGIN
      SELECT RAISE(ABORT, 'durable append-log is append-only');
    END
  `)],
]);

function observeSchema(database: ReadonlySqliteDatabase): Hash {
  const integrity = database.prepare("PRAGMA integrity_check").all() as readonly { integrity_check?: unknown }[];
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new TypeError("runtime acceptance SQLite integrity check failed");
  const rows = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name IN ('durable_append_log', 'durable_append_log_schema_contract', 'durable_append_log_no_update', 'durable_append_log_no_delete')
       OR (type='trigger' AND tbl_name='durable_append_log')
    ORDER BY type, name
  `).all() as readonly Record<string, unknown>[];
  if (rows.length !== EXPECTED_SCHEMA_OBJECTS.size) throw new TypeError("runtime acceptance append-log object set mismatch");
  const objects = rows.map((row, index) => {
    assertExactKeys(row, ["type", "name", "tbl_name", "sql"], `runtimeAcceptanceSchema[${index}]`);
    if (typeof row.type !== "string" || typeof row.name !== "string" || typeof row.tbl_name !== "string" || typeof row.sql !== "string") {
      throw new TypeError("runtime acceptance append-log schema row is malformed");
    }
    const sql = normalizedSql(row.sql);
    if (EXPECTED_SCHEMA_OBJECTS.get(`${row.type}\0${row.name}`) !== sql) throw new TypeError(`runtime acceptance append-log schema mismatch at ${row.name}`);
    return { type: row.type, name: row.name, table: row.tbl_name, sql };
  });
  const appendContracts = database.prepare("SELECT contract_id, schema_version, schema_digest, core_schema_digest, core_instance_nonce FROM durable_append_log_schema_contract").all() as readonly Record<string, unknown>[];
  const coreContracts = database.prepare("SELECT contract_id, schema_version, schema_digest, instance_nonce FROM durable_schema_contract").all() as readonly Record<string, unknown>[];
  if (appendContracts.length !== 1 || coreContracts.length !== 1) throw new TypeError("runtime acceptance schema contract cardinality mismatch");
  const appendContract = appendContracts[0]!;
  const coreContract = coreContracts[0]!;
  assertExactKeys(appendContract, ["contract_id", "schema_version", "schema_digest", "core_schema_digest", "core_instance_nonce"], "runtimeAcceptanceAppendContract");
  assertExactKeys(coreContract, ["contract_id", "schema_version", "schema_digest", "instance_nonce"], "runtimeAcceptanceCoreContract");
  if (appendContract.contract_id !== 1 || appendContract.schema_version !== "1" || coreContract.contract_id !== 1 || coreContract.schema_version !== "2") {
    throw new TypeError("runtime acceptance schema contract identity mismatch");
  }
  const appendDigest = assertHash(appendContract.schema_digest, "runtimeAcceptanceAppendContract.schema_digest");
  const coreDigest = assertHash(coreContract.schema_digest, "runtimeAcceptanceCoreContract.schema_digest");
  const coreNonce = assertNonEmptyString(coreContract.instance_nonce, "runtimeAcceptanceCoreContract.instance_nonce");
  if (appendContract.core_schema_digest !== coreDigest || appendContract.core_instance_nonce !== coreNonce) {
    throw new TypeError("runtime acceptance append/core schema contract join mismatch");
  }
  return hashDomain("aloha/raw-runtime-acceptance-sqlite-schema/v1", { objects, appendDigest, coreDigest, coreNonce });
}

function exactRelease(value: unknown, path: string): RuntimeAcceptanceReleaseIdentityV1 {
  assertPlainObject(value, path);
  assertExactKeys(value, ["bindingId", "releaseProvenanceHash", "candidateReleaseCommit"], path);
  const record = value as Record<string, unknown>;
  return Object.freeze({
    bindingId: assertHash(record.bindingId, `${path}.bindingId`),
    releaseProvenanceHash: assertHash(record.releaseProvenanceHash, `${path}.releaseProvenanceHash`),
    candidateReleaseCommit: assertGitSha40(record.candidateReleaseCommit, `${path}.candidateReleaseCommit`),
  });
}

function sortedHashes(value: unknown, path: string): readonly Hash[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const output = value.map((item, index) => assertHash(item, `${path}[${index}]`));
  for (let index = 1; index < output.length; index += 1) if (output[index - 1]! >= output[index]!) throw new TypeError(`${path} must be strictly sorted`);
  return Object.freeze(output);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  const leftBytes = encodeCanonicalBytes(left);
  const rightBytes = encodeCanonicalBytes(right);
  return leftBytes.byteLength === rightBytes.byteLength
    && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function exactLogStart(value: unknown, path: string): Readonly<{
  readonly device: string;
  readonly inode: string;
  readonly startInclusive: string;
  readonly path: string;
  readonly systemId: string;
}> {
  assertPlainObject(value, path);
  assertExactKeys(value, ["device", "inode", "startInclusive", "path", "systemId"], path);
  const record = value as Record<string, unknown>;
  const declaredPath = assertNonEmptyString(record.path, `${path}.path`);
  if (!declaredPath.startsWith("/")) throw new TypeError(`${path}.path must be absolute`);
  return Object.freeze({
    device: assertDecimalString(record.device, `${path}.device`),
    inode: assertDecimalString(record.inode, `${path}.inode`),
    startInclusive: assertDecimalString(record.startInclusive, `${path}.startInclusive`),
    path: declaredPath,
    systemId: assertNonEmptyString(record.systemId, `${path}.systemId`),
  });
}

function exactLogWindow(value: unknown, path: string): Readonly<{
  readonly systemId: string;
  readonly bootIdHash: Hash;
  readonly device: string;
  readonly inode: string;
  readonly startInclusive: string;
  readonly endExclusive: string;
  readonly contentSha256: Hash;
}> {
  assertPlainObject(value, path);
  assertExactKeys(value, ["systemId", "bootIdHash", "device", "inode", "startInclusive", "endExclusive", "contentSha256"], path);
  const record = value as Record<string, unknown>;
  const startInclusive = assertDecimalString(record.startInclusive, `${path}.startInclusive`);
  const endExclusive = assertDecimalString(record.endExclusive, `${path}.endExclusive`);
  if (BigInt(endExclusive) <= BigInt(startInclusive)) throw new TypeError(`${path} is empty`);
  return Object.freeze({
    systemId: assertNonEmptyString(record.systemId, `${path}.systemId`),
    bootIdHash: assertHash(record.bootIdHash, `${path}.bootIdHash`),
    device: assertDecimalString(record.device, `${path}.device`),
    inode: assertDecimalString(record.inode, `${path}.inode`),
    startInclusive,
    endExclusive,
    contentSha256: assertHash(record.contentSha256, `${path}.contentSha256`),
  });
}

function logMarker(event: ObservedRuntimeAcceptanceProcessEventV1): string {
  return `${encodeCanonicalJson({
    schemaVersion: 1,
    kind: "aloha.runtime-process-log-marker",
    eventKind: event.kind,
    eventId: event.eventId,
    processAnchorHash: event.processAnchorHash,
    releaseProvenanceHash: event.release.releaseProvenanceHash,
    sequence: event.sequence,
  })}\n`;
}

function withoutEventId(value: ObservedRuntimeAcceptanceProcessEventV1): Readonly<Record<string, unknown>> {
  const { eventId: _eventId, ...payload } = value;
  return payload;
}

function exactEvent(bytes: Uint8Array, row: RuntimeAppendRowV1): ObservedRuntimeAcceptanceProcessEventV1 {
  const value = decodeCanonicalJson(bytes);
  assertPlainObject(value, "runtimeAcceptanceEvent");
  const record = value as unknown as ObservedRuntimeAcceptanceProcessEventV1;
  const common = ["schemaVersion", "kind", "sequence", "release", "processAnchorHash", "eventId"];
  const fields = record.kind === "aloha.runtime-process-ready"
    ? [...common, "runtimeAnchor", "staticArtifacts", "strategy", "checkpointRoot", "checkpointStore", "stage12", "checkpointProbeEvidence", "processAnchor", "logStart"]
    : record.kind === "aloha.runtime-sigterm-observed"
      ? [...common, "processReadyEventId", "checkpointRootBefore", "checkpointRestartBefore", "outcomePartitionRootBefore", "outcomeHashesBefore"]
      : record.kind === "aloha.runtime-sigterm-drained"
        ? [...common, "sigtermObservedEventId", "checkpointRootAfter", "checkpointRestartAfter", "outcomePartitionRootAfter", "outcomeHashesAfter", "flushedOutcomeHashes", "logWindow"]
        : [];
  if (fields.length === 0) throw new TypeError("runtime acceptance event kind is invalid");
  assertExactKeys(record, fields, "runtimeAcceptanceEvent");
  if (record.schemaVersion !== 1 || assertDecimalString(record.sequence, "runtimeAcceptanceEvent.sequence") !== row.sequence) throw new TypeError("runtime acceptance event sequence mismatch");
  const release = exactRelease(record.release, "runtimeAcceptanceEvent.release");
  if (row.namespace !== `${NAMESPACE_PREFIX}${release.releaseProvenanceHash.slice(2)}`) throw new TypeError("runtime acceptance release namespace mismatch");
  assertHash(record.processAnchorHash, "runtimeAcceptanceEvent.processAnchorHash");
  if (record.kind === "aloha.runtime-process-ready") {
    assertPlainObject(record.runtimeAnchor, "runtimeAcceptanceEvent.runtimeAnchor");
    const processAnchor = decodeProcessAnchor(record.processAnchor as object);
    if (record.processAnchorHash !== hashProcessAnchor(processAnchor as ProcessAnchorV1)) throw new TypeError("runtime acceptance process anchor mismatch");
    const logStart = exactLogStart(record.logStart, "runtimeAcceptanceEvent.logStart");
    if (logStart.systemId !== processAnchor.systemId) throw new TypeError("runtime acceptance log start host mismatch");
    assertPlainObject(record.staticArtifacts, "runtimeAcceptanceEvent.staticArtifacts");
    assertPlainObject(record.strategy, "runtimeAcceptanceEvent.strategy");
    assertPlainObject(record.checkpointRoot, "runtimeAcceptanceEvent.checkpointRoot");
    assertPlainObject(record.checkpointStore, "runtimeAcceptanceEvent.checkpointStore");
    assertPlainObject(record.stage12, "runtimeAcceptanceEvent.stage12");
    if (record.checkpointProbeEvidence !== null) assertPlainObject(record.checkpointProbeEvidence, "runtimeAcceptanceEvent.checkpointProbeEvidence");
  } else if (record.kind === "aloha.runtime-sigterm-observed") {
    assertHash(record.processReadyEventId, "runtimeAcceptanceEvent.processReadyEventId");
    assertHash(record.outcomePartitionRootBefore, "runtimeAcceptanceEvent.outcomePartitionRootBefore");
    sortedHashes(record.outcomeHashesBefore, "runtimeAcceptanceEvent.outcomeHashesBefore");
    assertPlainObject(record.checkpointRootBefore, "runtimeAcceptanceEvent.checkpointRootBefore");
    assertPlainObject(record.checkpointRestartBefore, "runtimeAcceptanceEvent.checkpointRestartBefore");
  } else {
    assertHash(record.sigtermObservedEventId, "runtimeAcceptanceEvent.sigtermObservedEventId");
    assertHash(record.outcomePartitionRootAfter, "runtimeAcceptanceEvent.outcomePartitionRootAfter");
    sortedHashes(record.outcomeHashesAfter, "runtimeAcceptanceEvent.outcomeHashesAfter");
    sortedHashes(record.flushedOutcomeHashes, "runtimeAcceptanceEvent.flushedOutcomeHashes");
    assertPlainObject(record.checkpointRootAfter, "runtimeAcceptanceEvent.checkpointRootAfter");
    assertPlainObject(record.checkpointRestartAfter, "runtimeAcceptanceEvent.checkpointRestartAfter");
    if (record.logWindow !== null) exactLogWindow(record.logWindow, "runtimeAcceptanceEvent.logWindow");
  }
  const observedId = assertHash(record.eventId, "runtimeAcceptanceEvent.eventId");
  if (observedId !== row.eventId || observedId !== hashDomain(EVENT_DOMAIN, withoutEventId(record) as never)) throw new TypeError("runtime acceptance event id mismatch");
  return Object.freeze(record);
}

function readRows(database: ReadonlySqliteDatabase): readonly RuntimeAppendRowV1[] {
  const rows = database.prepare(`
    SELECT namespace, sequence, event_id, content_sha256, bytes, byte_length, offset_start, offset_end
    FROM durable_append_log
    WHERE namespace LIKE ?
    ORDER BY namespace, length(sequence), sequence
  `).all(`${NAMESPACE_PREFIX}%`) as readonly Record<string, unknown>[];
  const output: RuntimeAppendRowV1[] = [];
  const nextByNamespace = new Map<string, { sequence: bigint; offset: bigint }>();
  for (const [index, row] of rows.entries()) {
    assertExactKeys(row, ["namespace", "sequence", "event_id", "content_sha256", "bytes", "byte_length", "offset_start", "offset_end"], `runtimeAcceptanceRow[${index}]`);
    if (typeof row.namespace !== "string" || !row.namespace.startsWith(NAMESPACE_PREFIX)) throw new TypeError("runtime acceptance namespace mismatch");
    const sequence = assertDecimalString(row.sequence, `runtimeAcceptanceRow[${index}].sequence`);
    const byteLength = assertDecimalString(row.byte_length, `runtimeAcceptanceRow[${index}].byte_length`);
    const offsetStart = assertDecimalString(row.offset_start, `runtimeAcceptanceRow[${index}].offset_start`);
    const offsetEnd = assertDecimalString(row.offset_end, `runtimeAcceptanceRow[${index}].offset_end`);
    if (!(row.bytes instanceof Uint8Array)) throw new TypeError("runtime acceptance row bytes are not concrete");
    const bytes = Uint8Array.from(row.bytes);
    const state = nextByNamespace.get(row.namespace) ?? { sequence: 0n, offset: 0n };
    if (BigInt(sequence) !== state.sequence || BigInt(offsetStart) !== state.offset || BigInt(offsetEnd) !== state.offset + BigInt(bytes.byteLength) || BigInt(byteLength) !== BigInt(bytes.byteLength)) {
      throw new TypeError("runtime acceptance append sequence or byte range is truncated");
    }
    const contentSha256 = assertHash(row.content_sha256, `runtimeAcceptanceRow[${index}].content_sha256`);
    if (sha256Hex(bytes) !== contentSha256) throw new TypeError("runtime acceptance row content hash mismatch");
    output.push(Object.freeze({
      namespace: row.namespace,
      sequence,
      eventId: assertHash(row.event_id, `runtimeAcceptanceRow[${index}].event_id`),
      contentSha256,
      bytes,
      byteLength,
      offsetStart,
      offsetEnd,
    }));
    nextByNamespace.set(row.namespace, { sequence: state.sequence + 1n, offset: BigInt(offsetEnd) });
  }
  return Object.freeze(output);
}

function lineage(events: readonly ObservedRuntimeAcceptanceProcessEventV1[]): readonly string[] {
  if (events.length === 0) return Object.freeze(["runtime-process-events-missing"]);
  const groups = new Map<Hash, ObservedRuntimeAcceptanceProcessEventV1[]>();
  for (const event of events) {
    const group = groups.get(event.release.releaseProvenanceHash);
    if (group) group.push(event);
    else groups.set(event.release.releaseProvenanceHash, [event]);
  }
  const groupReasons = [...groups.values()].map(group => {
    const reasons: string[] = [];
    const release = group[0]!.release;
    let ready: ObservedRuntimeAcceptanceProcessEventV1 | null = null;
    let observed: ObservedRuntimeAcceptanceProcessEventV1 | null = null;
    let readyCount = 0;
    for (const event of group) {
      if (!sameCanonical(event.release, release)) throw new TypeError("runtime acceptance release identity changed within namespace");
      if (event.kind === "aloha.runtime-process-ready") {
        ready = event;
        observed = null;
        readyCount += 1;
      } else if (event.kind === "aloha.runtime-sigterm-observed") {
        if (ready === null || event.processReadyEventId !== ready.eventId || event.processAnchorHash !== ready.processAnchorHash) throw new TypeError("runtime SIGTERM observation is not joined to process-ready");
        observed = event;
      } else {
        if (ready === null || observed === null || event.sigtermObservedEventId !== observed.eventId || event.processAnchorHash !== ready.processAnchorHash) throw new TypeError("runtime SIGTERM drain is not joined to observed signal");
        const after = event.outcomeHashesAfter as readonly Hash[];
        const flushed = event.flushedOutcomeHashes as readonly Hash[];
        if (flushed.some(hash => !after.includes(hash))) throw new TypeError("runtime SIGTERM flushed outcome is absent after drain");
        if (event.logWindow !== null) {
          const start = exactLogStart(ready.logStart, "runtimeReady.logStart");
          const window = exactLogWindow(event.logWindow, "runtimeDrain.logWindow");
          const processAnchor = decodeProcessAnchor(ready.processAnchor as object);
          if (window.systemId !== processAnchor.systemId || window.bootIdHash !== processAnchor.bootIdHash
            || window.device !== start.device || window.inode !== start.inode || window.startInclusive !== start.startInclusive) {
            throw new TypeError("runtime SIGTERM log window anchor mismatch");
          }
          const physicalPath = realpathSync(start.path);
          if (!lstatSync(physicalPath).isFile()) throw new TypeError("runtime SIGTERM log window path is not a regular file");
          const before = statSync(physicalPath, { bigint: true });
          const bytes = new Uint8Array(readFileSync(physicalPath));
          const afterStat = statSync(physicalPath, { bigint: true });
          const startOffset = BigInt(window.startInclusive);
          const endOffset = BigInt(window.endExclusive);
          if (before.dev !== afterStat.dev || before.ino !== afterStat.ino || before.size !== afterStat.size
            || String(afterStat.dev) !== window.device || String(afterStat.ino) !== window.inode
            || endOffset > afterStat.size || endOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new TypeError("runtime SIGTERM log window changed during observation");
          }
          const range = bytes.slice(Number(startOffset), Number(endOffset));
          if (sha256Hex(range) !== window.contentSha256) throw new TypeError("runtime SIGTERM log window content mismatch");
          const text = Buffer.from(range).toString("utf8");
          if (!text.includes(logMarker(ready)) || !text.includes(logMarker(observed))) {
            throw new TypeError("runtime SIGTERM log window does not bind ready and observed events");
          }
        }
        observed = null;
      }
    }
    if (readyCount < 2) reasons.push("runtime-restart-second-process-ready-missing");
    if (!group.some(event => event.kind === "aloha.runtime-sigterm-observed")) reasons.push("runtime-sigterm-observation-missing");
    const drains = group.filter(event => event.kind === "aloha.runtime-sigterm-drained");
    if (drains.length === 0) reasons.push("runtime-sigterm-drain-missing");
    else {
      if (!drains.some(event => (event.flushedOutcomeHashes as readonly Hash[]).length > 0)) reasons.push("runtime-sigterm-non-empty-flush-missing");
      if (!drains.some(event => event.logWindow !== null)) reasons.push("runtime-sigterm-log-window-missing");
    }
    return reasons;
  });
  const complete = groupReasons.find(reasons => reasons.length === 0);
  if (complete !== undefined) return Object.freeze([]);
  return Object.freeze([...new Set(groupReasons.flat())].sort());
}

function observeProcessLogs(events: readonly ObservedRuntimeAcceptanceProcessEventV1[]): readonly ObservedRuntimeProcessLogV1[] {
  const observedByReady = new Map<Hash, ObservedRuntimeAcceptanceProcessEventV1>();
  const drainedByObserved = new Map<Hash, ObservedRuntimeAcceptanceProcessEventV1>();
  for (const event of events) {
    if (event.kind === "aloha.runtime-sigterm-observed") observedByReady.set(event.processReadyEventId as Hash, event);
    if (event.kind === "aloha.runtime-sigterm-drained") drainedByObserved.set(event.sigtermObservedEventId as Hash, event);
  }
  return Object.freeze(events.flatMap(event => {
    if (event.kind !== "aloha.runtime-process-ready") return [];
    const start = exactLogStart(event.logStart, "runtimeReady.logStart");
    const processAnchor = decodeProcessAnchor(event.processAnchor as object);
    const observed = observedByReady.get(event.eventId);
    const drained = observed === undefined ? undefined : drainedByObserved.get(observed.eventId);
    const physicalPath = realpathSync(start.path);
    if (!lstatSync(physicalPath).isFile()) throw new TypeError("runtime process log path is not a regular file");
    const before = statSync(physicalPath, { bigint: true });
    const bytes = new Uint8Array(readFileSync(physicalPath));
    const after = statSync(physicalPath, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || String(after.dev) !== start.device || String(after.ino) !== start.inode) {
      throw new TypeError("runtime process log changed during observation");
    }
    const declared = drained?.logWindow === null || drained === undefined
      ? null
      : exactLogWindow(drained.logWindow, "runtimeDrain.logWindow");
    const endOffset = declared === null ? after.size : BigInt(declared.endExclusive);
    const startOffset = BigInt(start.startInclusive);
    if (startOffset >= endOffset || endOffset > after.size || endOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TypeError("runtime process log range is empty or unavailable");
    }
    const range = bytes.slice(Number(startOffset), Number(endOffset));
    const logAnchor = Object.freeze({
      systemId: processAnchor.systemId,
      bootIdHash: processAnchor.bootIdHash,
      device: start.device,
      inode: start.inode,
      startInclusive: start.startInclusive,
      endExclusive: String(endOffset),
      contentSha256: sha256Hex(range),
    });
    if (declared !== null && !sameCanonical(logAnchor, declared)) throw new TypeError("runtime process log does not match drained anchor");
    const text = Buffer.from(range).toString("utf8");
    if (!text.includes(logMarker(event))) throw new TypeError("runtime process log does not bind process-ready event");
    if (observed !== undefined && drained !== undefined && !text.includes(logMarker(observed))) {
      throw new TypeError("runtime process log does not bind observed SIGTERM event");
    }
    return [Object.freeze({ processReadyEventId: event.eventId, processAnchorHash: event.processAnchorHash, logAnchor })];
  }));
}

export function observeRuntimeAcceptanceProcessDatabaseV1(databasePath: string): RawRuntimeAcceptanceObservationV1 {
  if (typeof databasePath !== "string" || !databasePath.startsWith("/") || !existsSync(databasePath)) {
    throw new TypeError("runtime acceptance database path is not a canonical regular file");
  }
  const physicalDatabasePath = realpathSync(databasePath);
  if (!lstatSync(physicalDatabasePath).isFile()) throw new TypeError("runtime acceptance database path is not a canonical regular file");
  let before = storageSet(physicalDatabasePath);
  let after = before;
  let database: ReadonlySqliteDatabase | null = null;
  let transaction = false;
  try {
    database = openReadonly(physicalDatabasePath);
    database.exec("PRAGMA query_only=ON");
    database.exec("BEGIN");
    transaction = true;
    const sqliteSchemaRoot = observeSchema(database);
    before = storageSet(physicalDatabasePath);
    const rows = readRows(database);
    const events = Object.freeze(rows.map(row => exactEvent(row.bytes, row)));
    const reasons = lineage(events);
    const processLogs = observeProcessLogs(events);
    database.exec("ROLLBACK");
    transaction = false;
    after = storageSet(physicalDatabasePath);
    if (before.root !== after.root) throw new TypeError("runtime acceptance SQLite changed during observation");
    database.close();
    database = null;
    return Object.freeze({
      kind: "aloha.raw-runtime-acceptance-observation-v1" as const,
      status: reasons.length === 0 ? "raw-complete" as const : "incomplete" as const,
      reasons,
      databaseSha256Before: before.mainSha256,
      databaseSha256After: after.mainSha256,
      storageSetRootBefore: before.root,
      storageSetRootAfter: after.root,
      sqliteSchemaRoot,
      rawRowRoot: hashDomain("aloha/raw-runtime-acceptance-row-root/v1", rows.map(row => ({
        namespace: row.namespace,
        sequence: row.sequence,
        eventId: row.eventId,
        contentSha256: row.contentSha256,
        byteLength: row.byteLength,
        offsetStart: row.offsetStart,
        offsetEnd: row.offsetEnd,
      }))),
      eventRoot: hashDomain("aloha/raw-runtime-acceptance-event-root/v1", events.map(event => event.eventId)),
      events,
      processLogs,
    });
  } catch (error) {
    try { if (transaction) database?.exec("ROLLBACK"); } catch { /* preserve observer error */ }
    try { after = storageSet(physicalDatabasePath); } catch { after = before; }
    try { database?.close(); } catch { /* preserve observer error */ }
    return Object.freeze({
      kind: "aloha.raw-runtime-acceptance-observation-v1" as const,
      status: "invalid" as const,
      reasons: Object.freeze([error instanceof Error ? error.message : "runtime-acceptance-observer-failed"]),
      databaseSha256Before: before.mainSha256,
      databaseSha256After: after.mainSha256,
      storageSetRootBefore: before.root,
      storageSetRootAfter: after.root,
      sqliteSchemaRoot: ZERO_HASH,
      rawRowRoot: ZERO_HASH,
      eventRoot: ZERO_HASH,
      events: Object.freeze([]),
      processLogs: Object.freeze([]),
    });
  }
}
