import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";

/**
 * The production store deliberately depends on a small driver port.  The
 * first driver is Node's built-in `node:sqlite` DatabaseSync implementation;
 * no JavaScript map is used as a persistence substitute.
 */
export interface SqliteStatement {
  get(...parameters: readonly SqliteValue[]): unknown;
  all(...parameters: readonly SqliteValue[]): readonly unknown[];
  run(...parameters: readonly SqliteValue[]): {
    readonly changes?: number | bigint;
    readonly lastInsertRowid?: number | bigint;
  };
}

export type SqliteValue = string | number | bigint | Uint8Array | null;

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteDriver {
  open(filename: string): SqliteDatabase;
}

export class SQLiteDriverUnavailableError extends Error {
  readonly code = "sqlite-driver-unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "SQLiteDriverUnavailableError";
  }
}

/** Load the host's real SQLite driver, or fail with an explicit capability error. */
export function loadNodeSqliteDriver(): SqliteDriver {
  try {
    const require = createRequire(import.meta.url);
    const loaded = require("node:sqlite") as {
      readonly DatabaseSync?: new (filename: string) => SqliteDatabase;
    };
    if (typeof loaded.DatabaseSync !== "function") {
      throw new Error("node:sqlite does not expose DatabaseSync");
    }
    const DatabaseSync = loaded.DatabaseSync;
    return Object.freeze({
      open(filename: string): SqliteDatabase {
        return new DatabaseSync(filename);
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SQLiteDriverUnavailableError(
      `Aloha durable-store requires a real SQLite driver (node:sqlite unavailable: ${detail})`,
    );
  }
}

export class DurableStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DurableStoreError";
    this.code = code;
  }
}

export class WriterBusyError extends DurableStoreError {
  constructor(message = "another writer lease is active") {
    super("writer-busy", message);
    this.name = "WriterBusyError";
  }
}

export class WriterLeaseLostError extends DurableStoreError {
  constructor(message = "writer lease is missing or expired") {
    super("writer-lease-lost", message);
    this.name = "WriterLeaseLostError";
  }
}

export class CASConflictError extends DurableStoreError {
  readonly expectedRevision: string;
  readonly actualRevision: string;

  constructor(expectedRevision: string, actualRevision: string) {
    super(
      "cas-conflict",
      `durable root CAS conflict: expected revision ${expectedRevision}, actual ${actualRevision}`,
    );
    this.name = "CASConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class ImmutableContentConflictError extends DurableStoreError {
  readonly contentHash: Hash;

  constructor(contentHash: Hash) {
    super("immutable-content-conflict", `immutable content differs for ${contentHash}`);
    this.name = "ImmutableContentConflictError";
    this.contentHash = contentHash;
  }
}

export class CorruptDurableStoreError extends DurableStoreError {
  constructor(message: string) {
    super("corrupt-store", message);
    this.name = "CorruptDurableStoreError";
  }
}

export interface WriterLease {
  readonly owner: string;
  readonly token: string;
  readonly expiresAtMs: number;
}

export interface DurableRootRecord {
  readonly revision: string;
  readonly envelopeHash: Hash;
  readonly envelopeBytes: Uint8Array;
  readonly references: readonly Hash[];
}

export interface DurableContentRecord {
  readonly hash: Hash;
  readonly kind: string;
  readonly bytes: Uint8Array;
  readonly references: readonly Hash[];
}

export interface DurableStoreOptions {
  readonly driver?: SqliteDriver;
  /** Test-only fault hook. Throwing rolls back the current SQLite transaction. */
  readonly beforeCommit?: () => void;
  readonly leaseTtlMs?: number;
}

export interface DurableTransaction {
  putImmutable(
    kind: string,
    bytes: Uint8Array,
    references?: readonly Hash[],
  ): Hash;
  readContent(hash: Hash): DurableContentRecord | null;
  readRoot(): DurableRootRecord | null;
  compareAndSwapRoot(
    expectedRevision: string,
    envelopeBytes: Uint8Array,
    references?: readonly Hash[],
  ): DurableRootRecord;
  setIndex(namespace: string, key: string, contentHash: Hash | null): void;
  getIndex(namespace: string, key: string): Hash | null;
  deleteIndex(namespace: string, key: string): void;
}

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ROOT_ENVELOPE_KIND = "aloha/durable-root-envelope/v1";
const DEFAULT_LEASE_TTL_MS = 30_000;

function assertHash(value: unknown, context: string): Hash {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new CorruptDurableStoreError(`invalid hash at ${context}`);
  }
  return value as Hash;
}

function assertDecimal(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CorruptDurableStoreError(`invalid decimal at ${context}`);
  }
  return value;
}

function copyBytes(value: unknown, context: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new CorruptDurableStoreError(`SQLite blob is not bytes at ${context}`);
  }
  return new Uint8Array(value);
}

function normalizeReferences(references: readonly Hash[]): readonly Hash[] {
  const unique = new Set<string>();
  for (const reference of references) {
    assertHash(reference, "content reference");
    unique.add(reference);
  }
  return Object.freeze([...unique].sort().map((reference) => reference as Hash));
}

function encodeReferences(references: readonly Hash[]): string {
  return encodeCanonicalJson(normalizeReferences(references));
}

function decodeReferences(raw: unknown, context: string): readonly Hash[] {
  if (typeof raw !== "string") {
    throw new CorruptDurableStoreError(`content references are not text at ${context}`);
  }
  const decoded = decodeCanonicalJson(raw);
  if (!Array.isArray(decoded)) {
    throw new CorruptDurableStoreError(`content references are not an array at ${context}`);
  }
  return normalizeReferences(decoded.map((value) => assertHash(value, context)));
}

function statementNumber(value: unknown, context: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  throw new CorruptDurableStoreError(`invalid SQLite number at ${context}`);
}

function sqliteFailure(error: unknown, fallback: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/busy|locked/i.test(message)) return new WriterBusyError(message);
  return new DurableStoreError("sqlite-error", `${fallback}: ${message}`);
}

class SQLiteTransaction implements DurableTransaction {
  private readonly database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.database = database;
  }

  putImmutable(kind: string, bytes: Uint8Array, references: readonly Hash[] = []): Hash {
    return putImmutableRow(this.database, kind, bytes, references);
  }

  readContent(hash: Hash): DurableContentRecord | null {
    return readContentRow(this.database, hash);
  }

  readRoot(): DurableRootRecord | null {
    return readRootRow(this.database);
  }

  compareAndSwapRoot(
    expectedRevision: string,
    envelopeBytes: Uint8Array,
    references: readonly Hash[] = [],
  ): DurableRootRecord {
    return compareAndSwapRootRow(
      this.database,
      expectedRevision,
      envelopeBytes,
      references,
    );
  }

  setIndex(namespace: string, key: string, contentHash: Hash | null): void {
    if (contentHash === null) {
      this.deleteIndex(namespace, key);
      return;
    }
    assertHash(contentHash, "index content hash");
    this.database.prepare(
      `INSERT INTO durable_index(namespace, object_key, content_hash)
       VALUES (?, ?, ?)
       ON CONFLICT(namespace, object_key) DO UPDATE SET content_hash=excluded.content_hash`,
    ).run(namespace, key, contentHash);
  }

  getIndex(namespace: string, key: string): Hash | null {
    const row = this.database.prepare(
      "SELECT content_hash FROM durable_index WHERE namespace=? AND object_key=?",
    ).get(namespace, key) as { content_hash?: unknown } | undefined;
    if (!row) return null;
    return assertHash(row.content_hash, `index ${namespace}/${key}`);
  }

  deleteIndex(namespace: string, key: string): void {
    this.database.prepare(
      "DELETE FROM durable_index WHERE namespace=? AND object_key=?",
    ).run(namespace, key);
  }
}

function readContentRow(
  database: SqliteDatabase,
  hash: Hash,
): DurableContentRecord | null {
  assertHash(hash, "content hash");
  const row = database.prepare(
    "SELECT hash, kind, bytes, references_json FROM durable_content WHERE hash=?",
  ).get(hash) as {
    hash?: unknown;
    kind?: unknown;
    bytes?: unknown;
    references_json?: unknown;
  } | undefined;
  if (!row) return null;
  const storedHash = assertHash(row.hash, "durable_content.hash");
  const bytes = copyBytes(row.bytes, `content ${hash}`);
  if (sha256Hex(bytes) !== storedHash || storedHash !== hash) {
    throw new CorruptDurableStoreError(`content hash mismatch for ${hash}`);
  }
  if (typeof row.kind !== "string" || row.kind.length === 0) {
    throw new CorruptDurableStoreError(`content kind missing for ${hash}`);
  }
  return Object.freeze({
    hash: storedHash,
    kind: row.kind,
    bytes,
    references: decodeReferences(row.references_json, `content ${hash}`),
  });
}

function putImmutableRow(
  database: SqliteDatabase,
  kind: string,
  bytes: Uint8Array,
  references: readonly Hash[] = [],
): Hash {
  if (typeof kind !== "string" || kind.length === 0) {
    throw new TypeError("immutable content kind must be non-empty");
  }
  const copied = copyBytes(bytes, "putImmutable bytes");
  const hash = sha256Hex(copied);
  const encodedReferences = encodeReferences(references);
  const existing = database.prepare(
    "SELECT kind, bytes, references_json FROM durable_content WHERE hash=?",
  ).get(hash) as {
    kind?: unknown;
    bytes?: unknown;
    references_json?: unknown;
  } | undefined;
  if (existing) {
    const existingBytes = copyBytes(existing.bytes, `existing content ${hash}`);
    if (sha256Hex(existingBytes) !== hash ||
        existingBytes.length !== copied.length ||
        !existingBytes.every((value, index) => value === copied[index])) {
      throw new ImmutableContentConflictError(hash);
    }
    if (typeof existing.kind !== "string" || existing.kind.length === 0) {
      throw new CorruptDurableStoreError(`existing content kind missing for ${hash}`);
    }
    const existingReferences = decodeReferences(existing.references_json, `content ${hash}`);
    if (encodeCanonicalJson(existingReferences) !== encodedReferences) {
      throw new ImmutableContentConflictError(hash);
    }
    return hash;
  }
  database.prepare(
    `INSERT INTO durable_content(hash, kind, bytes, byte_length, references_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(hash, kind, copied, copied.byteLength, encodedReferences, Date.now());
  return hash;
}

function readRootRow(database: SqliteDatabase): DurableRootRecord | null {
  const row = database.prepare(
    "SELECT revision, envelope_hash FROM durable_root WHERE root_id=1",
  ).get() as { revision?: unknown; envelope_hash?: unknown } | undefined;
  if (!row) return null;
  const revision = assertDecimal(row.revision, "durable_root.revision");
  const envelopeHash = assertHash(row.envelope_hash, "durable_root.envelope_hash");
  const envelope = readContentRow(database, envelopeHash);
  if (!envelope) {
    throw new CorruptDurableStoreError(`root points at missing envelope ${envelopeHash}`);
  }
  if (envelope.kind !== ROOT_ENVELOPE_KIND) {
    throw new CorruptDurableStoreError(`root envelope kind mismatch for ${envelopeHash}`);
  }
  return Object.freeze({
    revision,
    envelopeHash,
    envelopeBytes: envelope.bytes,
    references: envelope.references,
  });
}

function compareAndSwapRootRow(
  database: SqliteDatabase,
  expectedRevision: string,
  envelopeBytes: Uint8Array,
  references: readonly Hash[],
): DurableRootRecord {
  const expected = assertDecimal(expectedRevision, "expected root revision");
  const current = readRootRow(database);
  const actual = current?.revision ?? "0";
  if (actual !== expected) throw new CASConflictError(expected, actual);
  const nextRevision = (BigInt(expected) + 1n).toString();
  const envelopeHash = putImmutableRow(
    database,
    ROOT_ENVELOPE_KIND,
    envelopeBytes,
    references,
  );
  if (current) {
    database.prepare(
      "UPDATE durable_root SET revision=?, envelope_hash=?, updated_at_ms=? WHERE root_id=1 AND revision=?",
    ).run(nextRevision, envelopeHash, Date.now(), expected);
  } else {
    database.prepare(
      "INSERT INTO durable_root(root_id, revision, envelope_hash, updated_at_ms) VALUES (1, ?, ?, ?)",
    ).run(nextRevision, envelopeHash, Date.now());
  }
  const updated = readRootRow(database);
  if (!updated || updated.revision !== nextRevision || updated.envelopeHash !== envelopeHash) {
    throw new CorruptDurableStoreError("root update was not atomically visible");
  }
  return updated;
}

function createSchema(database: SqliteDatabase): void {
  database.exec("PRAGMA journal_mode=WAL;");
  database.exec("PRAGMA foreign_keys=ON;");
  database.exec("PRAGMA synchronous=FULL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS durable_content (
      hash TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      bytes BLOB NOT NULL,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
      references_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS durable_root (
      root_id INTEGER PRIMARY KEY CHECK (root_id = 1),
      revision TEXT NOT NULL,
      envelope_hash TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS durable_index (
      namespace TEXT NOT NULL,
      object_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY(namespace, object_key)
    );
    CREATE TABLE IF NOT EXISTS durable_writer_lease (
      lease_id INTEGER PRIMARY KEY CHECK (lease_id = 1),
      owner TEXT NOT NULL,
      token TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
  `);
}

function reachableFrom(
  database: SqliteDatabase,
  roots: readonly Hash[],
): ReadonlySet<Hash> {
  const reachable = new Set<Hash>();
  const pending = [...roots];
  while (pending.length > 0) {
    const hash = pending.pop()!;
    if (reachable.has(hash)) continue;
    const record = readContentRow(database, hash);
    if (!record) throw new CorruptDurableStoreError(`live reference points at missing content ${hash}`);
    reachable.add(hash);
    pending.push(...record.references);
  }
  return reachable;
}

export class SQLiteDurableStore {
  readonly filename: string;
  private readonly database: SqliteDatabase;
  private readonly beforeCommit?: () => void;
  private readonly leaseTtlMs: number;
  private inTransaction = false;

  constructor(filename: string, options: DurableStoreOptions = {}) {
    this.filename = filename;
    this.beforeCommit = options.beforeCommit;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isInteger(this.leaseTtlMs) || this.leaseTtlMs < 1_000) {
      throw new RangeError("leaseTtlMs must be at least 1000ms");
    }
    const driver = options.driver ?? loadNodeSqliteDriver();
    try {
      this.database = driver.open(filename);
      createSchema(this.database);
    } catch (error) {
      if (error instanceof SQLiteDriverUnavailableError) throw error;
      throw sqliteFailure(error, `opening SQLite durable store ${filename}`);
    }
  }

  close(): void {
    this.database.close();
  }

  /** Exposed for integration tests and operational diagnostics. */
  pragma(name: "journal_mode" | "foreign_keys" | "synchronous"): string | number {
    const row = this.database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
    const value = Object.values(row)[0];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new CorruptDurableStoreError(`invalid PRAGMA ${name}`);
    }
    return value;
  }

  readContent(hash: Hash): DurableContentRecord | null {
    return readContentRow(this.database, hash);
  }

  readRoot(): DurableRootRecord | null {
    return readRootRow(this.database);
  }

  readIndex(namespace: string, key: string): Hash | null {
    const row = this.database.prepare(
      "SELECT content_hash FROM durable_index WHERE namespace=? AND object_key=?",
    ).get(namespace, key) as { content_hash?: unknown } | undefined;
    if (!row) return null;
    return assertHash(row.content_hash, `index ${namespace}/${key}`);
  }

  acquireWriterLease(owner: string, ttlMs = this.leaseTtlMs): WriterLease {
    if (this.inTransaction) throw new DurableStoreError("nested-transaction", "cannot acquire a writer lease during a transaction");
    if (typeof owner !== "string" || owner.length === 0) {
      throw new TypeError("writer owner must be non-empty");
    }
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000) {
      throw new RangeError("writer lease TTL must be at least 1000ms");
    }
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const row = this.database.prepare(
        "SELECT owner, token, expires_at_ms FROM durable_writer_lease WHERE lease_id=1",
      ).get() as {
        owner?: unknown;
        token?: unknown;
        expires_at_ms?: unknown;
      } | undefined;
      const now = Date.now();
      if (row && typeof row.owner === "string" && typeof row.token === "string") {
        const expiresAt = statementNumber(row.expires_at_ms, "writer lease expiry");
        if (expiresAt > now && row.owner !== owner) {
          this.database.exec("ROLLBACK");
          throw new WriterBusyError(`writer lease held by ${row.owner}`);
        }
        if (expiresAt > now && row.owner === owner) {
          this.database.prepare(
            "UPDATE durable_writer_lease SET expires_at_ms=? WHERE lease_id=1 AND token=?",
          ).run(now + ttlMs, row.token);
          this.database.exec("COMMIT");
          return Object.freeze({ owner, token: row.token, expiresAtMs: now + ttlMs });
        }
      }
      const token = randomUUID();
      const expiresAtMs = now + ttlMs;
      this.database.prepare(
        `INSERT INTO durable_writer_lease(lease_id, owner, token, expires_at_ms)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(lease_id) DO UPDATE SET owner=excluded.owner, token=excluded.token, expires_at_ms=excluded.expires_at_ms`,
      ).run(owner, token, expiresAtMs);
      this.database.exec("COMMIT");
      return Object.freeze({ owner, token, expiresAtMs });
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      if (error instanceof WriterBusyError) throw error;
      throw sqliteFailure(error, "acquiring durable writer lease");
    }
  }

  renewWriterLease(lease: WriterLease, ttlMs = this.leaseTtlMs): WriterLease {
    this.assertLeaseShape(lease);
    const now = Date.now();
    const result = this.database.prepare(
      `UPDATE durable_writer_lease SET expires_at_ms=?
       WHERE lease_id=1 AND owner=? AND token=? AND expires_at_ms>?`,
    ).run(now + ttlMs, lease.owner, lease.token, now);
    if (statementNumber(result.changes ?? 0, "lease renewal changes") !== 1) {
      throw new WriterLeaseLostError();
    }
    return Object.freeze({ owner: lease.owner, token: lease.token, expiresAtMs: now + ttlMs });
  }

  releaseWriterLease(lease: WriterLease): void {
    this.assertLeaseShape(lease);
    this.database.prepare(
      "DELETE FROM durable_writer_lease WHERE lease_id=1 AND owner=? AND token=?",
    ).run(lease.owner, lease.token);
  }

  putImmutableContent(
    kind: string,
    bytes: Uint8Array,
    references: readonly Hash[] = [],
    lease?: WriterLease,
  ): Hash {
    if (lease) return this.transaction(lease, (tx) => tx.putImmutable(kind, bytes, references));
    return this.withTemporaryLease((owned) =>
      this.transaction(owned, (tx) => tx.putImmutable(kind, bytes, references)));
  }

  compareAndSwapRoot(
    expectedRevision: string,
    envelopeBytes: Uint8Array,
    references: readonly Hash[] = [],
    lease?: WriterLease,
  ): DurableRootRecord {
    if (lease) {
      return this.transaction(lease, (tx) =>
        tx.compareAndSwapRoot(expectedRevision, envelopeBytes, references));
    }
    return this.withTemporaryLease((owned) =>
      this.transaction(owned, (tx) =>
        tx.compareAndSwapRoot(expectedRevision, envelopeBytes, references)));
  }

  transaction<T>(lease: WriterLease, callback: (tx: DurableTransaction) => T): T {
    this.assertLease(lease);
    if (this.inTransaction) throw new DurableStoreError("nested-transaction", "nested SQLite transaction");
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.inTransaction = true;
      this.assertLease(lease);
      const result = callback(new SQLiteTransaction(this.database));
      this.beforeCommit?.();
      this.database.exec("COMMIT");
      this.inTransaction = false;
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve primary failure */ }
      this.inTransaction = false;
      if (error instanceof DurableStoreError || error instanceof WriterLeaseLostError) throw error;
      throw sqliteFailure(error, "SQLite transaction failed");
    }
  }

  garbageCollect(lease?: WriterLease): readonly Hash[] {
    const run = (owned: WriterLease): readonly Hash[] => this.transaction(owned, (tx) => {
      const root = tx.readRoot();
      const indexRows = this.database.prepare(
        "SELECT content_hash FROM durable_index",
      ).all() as readonly { content_hash?: unknown }[];
      const rootHashes: Hash[] = [];
      if (root) rootHashes.push(root.envelopeHash);
      for (const row of indexRows) rootHashes.push(assertHash(row.content_hash, "durable index"));
      const reachable = reachableFrom(this.database, rootHashes);
      const rows = this.database.prepare("SELECT hash FROM durable_content").all() as readonly { hash?: unknown }[];
      const deleted: Hash[] = [];
      for (const row of rows) {
        const hash = assertHash(row.hash, "durable content listing");
        if (!reachable.has(hash)) {
          this.database.prepare("DELETE FROM durable_content WHERE hash=?").run(hash);
          deleted.push(hash);
        }
      }
      return Object.freeze(deleted);
    });
    if (lease) return run(lease);
    return this.withTemporaryLease(run);
  }

  contentHashes(): readonly Hash[] {
    const rows = this.database.prepare("SELECT hash FROM durable_content ORDER BY hash").all() as readonly { hash?: unknown }[];
    return Object.freeze(rows.map((row) => assertHash(row.hash, "durable content listing")));
  }

  private withTemporaryLease<T>(callback: (lease: WriterLease) => T): T {
    const owner = `durable-store/${randomUUID()}`;
    const lease = this.acquireWriterLease(owner);
    try {
      return callback(lease);
    } finally {
      this.releaseWriterLease(lease);
    }
  }

  private assertLeaseShape(lease: WriterLease): void {
    if (!lease || typeof lease.owner !== "string" || typeof lease.token !== "string") {
      throw new WriterLeaseLostError("invalid writer lease");
    }
  }

  private assertLease(lease: WriterLease): void {
    this.assertLeaseShape(lease);
    const row = this.database.prepare(
      "SELECT owner, token, expires_at_ms FROM durable_writer_lease WHERE lease_id=1",
    ).get() as {
      owner?: unknown;
      token?: unknown;
      expires_at_ms?: unknown;
    } | undefined;
    const now = Date.now();
    if (!row || row.owner !== lease.owner || row.token !== lease.token ||
        statementNumber(row.expires_at_ms, "writer lease expiry") <= now) {
      throw new WriterLeaseLostError();
    }
  }
}

export const SqliteDurableStore = SQLiteDurableStore;

export function createSqliteDurableStore(
  filename: string,
  options: DurableStoreOptions = {},
): SQLiteDurableStore {
  return new SQLiteDurableStore(filename, options);
}

/** A deterministic empty content root useful for initially empty envelopes. */
export function emptyContentHash(): Hash {
  return sha256Hex(new Uint8Array());
}

export const DURABLE_ROOT_ENVELOPE_KIND = ROOT_ENVELOPE_KIND;
