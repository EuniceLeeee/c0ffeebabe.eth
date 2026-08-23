import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashDomain,
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
  readonly payloadHash: Hash;
  readonly kind: string;
  readonly bytes: Uint8Array;
  readonly references: readonly Hash[];
}

export interface DurableStoreOptions {
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
  listIndex(namespace: string): readonly { readonly key: string; readonly contentHash: Hash }[];
  listIndexNamespaces(): readonly string[];
  addBeforeCommitGuard(guard: () => void): void;
}

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const ROOT_ENVELOPE_KIND = "aloha/durable-root-envelope/v1";
export const DURABLE_CONTENT_ENVELOPE_HASH_DOMAIN = "aloha/durable-content-envelope/v1";
const DURABLE_SCHEMA_VERSION = "2";
const DURABLE_SCHEMA_CONTRACT_KIND = "aloha/durable-sqlite-schema/v1";
const DURABLE_SCHEMA_CONTRACT_TABLE = "durable_schema_contract";
const DURABLE_SCHEMA_CONTRACT_FIELDS = [
  "contract_id",
  "schema_version",
  "schema_digest",
  "instance_nonce",
  "role_binding_hash",
] as const;
const DURABLE_TABLE_NAMES = [
  "durable_content",
  "durable_root",
  "durable_index",
  "durable_writer_lease",
  "durable_store_identity",
  DURABLE_SCHEMA_CONTRACT_TABLE,
] as const;
const DEFAULT_LEASE_TTL_MS = 30_000;

type SchemaColumn = Readonly<{
  name: string;
  type: string;
  notNull: number;
  primaryKey: number;
  defaultValue: string | null;
}>;

type SchemaIndex = Readonly<{
  unique: number;
  origin: string;
  partial: number;
  columns: readonly string[];
}>;

type SchemaTable = Readonly<{
  name: string;
  sql: string;
  columns: readonly SchemaColumn[];
  indexes: readonly SchemaIndex[];
}>;

type SchemaContract = Readonly<{
  schemaVersion: string;
  schemaDigest: Hash;
  instanceNonce: string;
  roleBindingHash: Hash | null;
}>;

const DURABLE_SCHEMA_CREATE_SQL = Object.freeze({
  durable_content: `
      CREATE TABLE durable_content (
        hash TEXT PRIMARY KEY NOT NULL,
        payload_hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        bytes BLOB NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        references_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );`,
  durable_root: `
      CREATE TABLE durable_root (
        root_id INTEGER PRIMARY KEY CHECK (root_id = 1),
        revision TEXT NOT NULL,
        envelope_hash TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );`,
  durable_index: `
      CREATE TABLE durable_index (
        namespace TEXT NOT NULL,
        object_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY(namespace, object_key)
      );`,
  durable_writer_lease: `
      CREATE TABLE durable_writer_lease (
        lease_id INTEGER PRIMARY KEY CHECK (lease_id = 1),
        owner TEXT NOT NULL,
        token TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );`,
  durable_store_identity: `
      CREATE TABLE durable_store_identity (
        identity_id INTEGER PRIMARY KEY CHECK (identity_id = 1),
        store_role TEXT NOT NULL
      );`,
  durable_schema_contract: `
      CREATE TABLE durable_schema_contract (
        contract_id INTEGER PRIMARY KEY CHECK (contract_id = 1),
        schema_version TEXT NOT NULL,
        schema_digest TEXT NOT NULL,
        instance_nonce TEXT NOT NULL,
        role_binding_hash TEXT
      );`,
  });

function normalizeSchemaSql(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CorruptDurableStoreError(`durable schema SQL is missing at ${context}`);
  }
  return value.trim().replace(/\s+/g, " ").replace(/;$/, "").trim();
}

const EXPECTED_SCHEMA_DESCRIPTOR: readonly SchemaTable[] = Object.freeze([
  {
    name: "durable_content",
    sql: normalizeSchemaSql(DURABLE_SCHEMA_CREATE_SQL.durable_content, "expected durable_content"),
    columns: Object.freeze([
      { name: "hash", type: "TEXT", notNull: 1, primaryKey: 1, defaultValue: null },
      { name: "payload_hash", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
      { name: "kind", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
      { name: "bytes", type: "BLOB", notNull: 1, primaryKey: 0, defaultValue: null },
      { name: "byte_length", type: "INTEGER", notNull: 1, primaryKey: 0, defaultValue: null },
      { name: "references_json", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
      { name: "created_at_ms", type: "INTEGER", notNull: 1, primaryKey: 0, defaultValue: null },
    ]),
    indexes: Object.freeze([{ unique: 1, origin: "pk", partial: 0, columns: Object.freeze(["hash"]) }]),
  },
  {
    name: "durable_root",
    sql: normalizeSchemaSql(DURABLE_SCHEMA_CREATE_SQL.durable_root, "expected durable_root"),
    columns: Object.freeze([
      { name: "root_id", type: "INTEGER", notNull: 0, primaryKey: 1, defaultValue: null },
      { name: "revision", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
      { name: "envelope_hash", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
      { name: "updated_at_ms", type: "INTEGER", notNull: 1, primaryKey: 0, defaultValue: null },
    ]),
    indexes: Object.freeze([]),
  },
  {
    name: "durable_index",
    sql: normalizeSchemaSql(DURABLE_SCHEMA_CREATE_SQL.durable_index, "expected durable_index"),
    columns: Object.freeze([
      { name: "namespace", type: "TEXT", notNull: 1, primaryKey: 1, defaultValue: null },
      { name: "object_key", type: "TEXT", notNull: 1, primaryKey: 2, defaultValue: null },
      { name: "content_hash", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
    ]),
    indexes: Object.freeze([{ unique: 1, origin: "pk", partial: 0, columns: Object.freeze(["namespace", "object_key"]) }]),
  },
  {
    name: "durable_writer_lease",
    sql: normalizeSchemaSql(DURABLE_SCHEMA_CREATE_SQL.durable_writer_lease, "expected durable_writer_lease"),
    columns: Object.freeze([
      { name: "lease_id", type: "INTEGER", notNull: 0, primaryKey: 1, defaultValue: null },
      { name: "owner", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
      { name: "token", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
      { name: "expires_at_ms", type: "INTEGER", notNull: 1, primaryKey: 0, defaultValue: null },
    ]),
    indexes: Object.freeze([]),
  },
  {
    name: "durable_store_identity",
    sql: normalizeSchemaSql(DURABLE_SCHEMA_CREATE_SQL.durable_store_identity, "expected durable_store_identity"),
    columns: Object.freeze([
      { name: "identity_id", type: "INTEGER", notNull: 0, primaryKey: 1, defaultValue: null },
      { name: "store_role", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
    ]),
    indexes: Object.freeze([]),
  },
  {
    name: DURABLE_SCHEMA_CONTRACT_TABLE,
    sql: normalizeSchemaSql(DURABLE_SCHEMA_CREATE_SQL.durable_schema_contract, "expected durable_schema_contract"),
    columns: Object.freeze([
      { name: "contract_id", type: "INTEGER", notNull: 0, primaryKey: 1, defaultValue: null },
      { name: "schema_version", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
      { name: "schema_digest", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
      { name: "instance_nonce", type: "TEXT", notNull: 1, primaryKey: 0, defaultValue: null },
      { name: "role_binding_hash", type: "TEXT", notNull: 0, primaryKey: 0, defaultValue: null },
    ]),
    indexes: Object.freeze([]),
  },
]);

const DURABLE_SCHEMA_DIGEST = hashDomain(
  DURABLE_SCHEMA_CONTRACT_KIND,
  EXPECTED_SCHEMA_DESCRIPTOR,
);
const ROLE_BINDING_HASH_DOMAIN = "aloha/durable-store-role-binding/v1";

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

function assertNonEmptyText(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CorruptDurableStoreError(`invalid text at ${context}`);
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function schemaDescriptor(database: SqliteDatabase): readonly SchemaTable[] {
  const tableRows = database.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as readonly { name?: unknown; sql?: unknown }[];
  const tableSql = new Map<string, unknown>();
  for (const [index, row] of tableRows.entries()) {
    const name = assertNonEmptyText(row.name, `sqlite table ${index}`);
    tableSql.set(name, row.sql);
  }
  const tableNames = new Set(tableSql.keys());
  return Object.freeze(EXPECTED_SCHEMA_DESCRIPTOR.map(expected => {
    if (!tableNames.has(expected.name)) {
      throw new CorruptDurableStoreError(`durable schema table is missing: ${expected.name}`);
    }
    const sql = normalizeSchemaSql(tableSql.get(expected.name), `sqlite table ${expected.name}.sql`);
    const table = quoteIdentifier(expected.name);
    const columnRows = database.prepare(`PRAGMA table_info(${table})`).all() as readonly {
      cid?: unknown;
      name?: unknown;
      type?: unknown;
      notnull?: unknown;
      dflt_value?: unknown;
      pk?: unknown;
    }[];
    const columns = Object.freeze(columnRows.map((row, index) => {
      const cid = statementNumber(row.cid, `${expected.name}.column[${index}].cid`);
      if (cid !== index) throw new CorruptDurableStoreError(`durable schema column order mismatch at ${expected.name}`);
      const defaultValue = row.dflt_value === null || row.dflt_value === undefined
        ? null
        : assertNonEmptyText(row.dflt_value, `${expected.name}.column[${index}].default`);
      return Object.freeze({
        name: assertNonEmptyText(row.name, `${expected.name}.column[${index}].name`),
        type: assertNonEmptyText(row.type, `${expected.name}.column[${index}].type`),
        notNull: statementNumber(row.notnull, `${expected.name}.column[${index}].notnull`),
        primaryKey: statementNumber(row.pk, `${expected.name}.column[${index}].pk`),
        defaultValue,
      });
    }));
    const indexRows = database.prepare(`PRAGMA index_list(${table})`).all() as readonly {
      name?: unknown;
      unique?: unknown;
      origin?: unknown;
      partial?: unknown;
    }[];
    const indexes = Object.freeze(indexRows.map((row, index) => {
      const indexName = assertNonEmptyText(row.name, `${expected.name}.index[${index}].name`);
      const indexInfoRows = database.prepare(`PRAGMA index_info(${quoteIdentifier(indexName)})`).all() as readonly {
        seqno?: unknown;
        name?: unknown;
      }[];
      const columns = Object.freeze(indexInfoRows.map((info, columnIndex) => {
        const seqno = statementNumber(info.seqno, `${expected.name}.${indexName}.column[${columnIndex}].seqno`);
        if (seqno !== columnIndex) throw new CorruptDurableStoreError(`durable schema index order mismatch at ${expected.name}`);
        return assertNonEmptyText(info.name, `${expected.name}.${indexName}.column[${columnIndex}]`);
      }));
      return Object.freeze({
        unique: statementNumber(row.unique, `${expected.name}.index[${index}].unique`),
        origin: assertNonEmptyText(row.origin, `${expected.name}.index[${index}].origin`),
        partial: statementNumber(row.partial, `${expected.name}.index[${index}].partial`),
        columns,
      });
    }).sort((left, right) => encodeCanonicalJson(left).localeCompare(encodeCanonicalJson(right))));
    return Object.freeze({ name: expected.name, sql, columns, indexes });
  }));
}

function assertSchemaDescriptor(database: SqliteDatabase): void {
  const actual = schemaDescriptor(database);
  const actualDigest = hashDomain(DURABLE_SCHEMA_CONTRACT_KIND, actual);
  if (actualDigest !== DURABLE_SCHEMA_DIGEST) {
    throw new CorruptDurableStoreError(
      `durable SQLite schema digest mismatch: expected ${DURABLE_SCHEMA_DIGEST}, actual ${actualDigest}`,
    );
  }
}

function readSchemaContract(database: SqliteDatabase): SchemaContract {
  assertSchemaDescriptor(database);
  const rows = database.prepare(
    `SELECT ${DURABLE_SCHEMA_CONTRACT_FIELDS.join(", ")} FROM ${DURABLE_SCHEMA_CONTRACT_TABLE}`,
  ).all() as readonly {
    contract_id?: unknown;
    schema_version?: unknown;
    schema_digest?: unknown;
    instance_nonce?: unknown;
    role_binding_hash?: unknown;
  }[];
  if (rows.length !== 1 || statementNumber(rows[0]?.contract_id, "durable schema contract.contract_id") !== 1) {
    throw new CorruptDurableStoreError("durable schema contract must contain exactly one row");
  }
  const row = rows[0]!;
  const schemaVersion = assertNonEmptyText(row.schema_version, "durable schema contract.schema_version");
  const schemaDigest = assertHash(row.schema_digest, "durable schema contract.schema_digest");
  const instanceNonce = assertNonEmptyText(row.instance_nonce, "durable schema contract.instance_nonce");
  const roleBindingHash = row.role_binding_hash === null || row.role_binding_hash === undefined
    ? null
    : assertHash(row.role_binding_hash, "durable schema contract.role_binding_hash");
  if (schemaVersion !== DURABLE_SCHEMA_VERSION || schemaDigest !== DURABLE_SCHEMA_DIGEST) {
    throw new CorruptDurableStoreError("durable schema version contract mismatch");
  }
  return Object.freeze({ schemaVersion, schemaDigest, instanceNonce, roleBindingHash });
}

function readIdentityRows(database: SqliteDatabase): readonly { readonly identityId: number; readonly role: string }[] {
  const rows = database.prepare(
    "SELECT identity_id, store_role FROM durable_store_identity ORDER BY identity_id",
  ).all() as readonly { identity_id?: unknown; store_role?: unknown }[];
  return Object.freeze(rows.map((row, index) => ({
    identityId: statementNumber(row.identity_id, `durable store identity[${index}].identity_id`),
    role: assertNonEmptyText(row.store_role, `durable store identity[${index}].store_role`),
  })));
}

function roleBindingHash(role: string, contract: SchemaContract): Hash {
  return hashDomain(ROLE_BINDING_HASH_DOMAIN, {
    role,
    schemaVersion: contract.schemaVersion,
    schemaDigest: contract.schemaDigest,
    instanceNonce: contract.instanceNonce,
  });
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

function contentEnvelopeHash(
  kind: string,
  payloadHash: Hash,
  references: readonly Hash[],
): Hash {
  return hashDomain(DURABLE_CONTENT_ENVELOPE_HASH_DOMAIN, {
    kind,
    payloadHash,
    references: normalizeReferences(references),
  });
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
  private readonly roleGuard: () => void;
  private readonly beforeCommitGuards: Array<() => void> = [];

  constructor(database: SqliteDatabase, roleGuard: () => void) {
    this.database = database;
    this.roleGuard = roleGuard;
  }

  putImmutable(kind: string, bytes: Uint8Array, references: readonly Hash[] = []): Hash {
    this.roleGuard();
    return putImmutableRow(this.database, kind, bytes, references);
  }

  readContent(hash: Hash): DurableContentRecord | null {
    this.roleGuard();
    return readContentRow(this.database, hash);
  }

  readRoot(): DurableRootRecord | null {
    this.roleGuard();
    return readRootRow(this.database);
  }

  compareAndSwapRoot(
    expectedRevision: string,
    envelopeBytes: Uint8Array,
    references: readonly Hash[] = [],
  ): DurableRootRecord {
    this.roleGuard();
    return compareAndSwapRootRow(
      this.database,
      expectedRevision,
      envelopeBytes,
      references,
    );
  }

  setIndex(namespace: string, key: string, contentHash: Hash | null): void {
    this.roleGuard();
    if (contentHash === null) {
      this.deleteIndex(namespace, key);
      return;
    }
    assertHash(contentHash, "index content hash");
    if (!readContentRow(this.database, contentHash)) {
      throw new CorruptDurableStoreError(`index target is missing content ${contentHash}`);
    }
    this.database.prepare(
      `INSERT INTO durable_index(namespace, object_key, content_hash)
       VALUES (?, ?, ?)
       ON CONFLICT(namespace, object_key) DO UPDATE SET content_hash=excluded.content_hash`,
    ).run(namespace, key, contentHash);
  }

  getIndex(namespace: string, key: string): Hash | null {
    this.roleGuard();
    const row = this.database.prepare(
      "SELECT content_hash FROM durable_index WHERE namespace=? AND object_key=?",
    ).get(namespace, key) as { content_hash?: unknown } | undefined;
    if (!row) return null;
    return assertHash(row.content_hash, `index ${namespace}/${key}`);
  }

  deleteIndex(namespace: string, key: string): void {
    this.roleGuard();
    this.database.prepare(
      "DELETE FROM durable_index WHERE namespace=? AND object_key=?",
    ).run(namespace, key);
  }

  listIndex(namespace: string): readonly { readonly key: string; readonly contentHash: Hash }[] {
    this.roleGuard();
    const rows = this.database.prepare(
      "SELECT object_key, content_hash FROM durable_index WHERE namespace=? ORDER BY object_key",
    ).all(namespace) as readonly { object_key?: unknown; content_hash?: unknown }[];
    return Object.freeze(rows.map((row, index) => {
      if (typeof row.object_key !== "string" || row.object_key.length === 0) {
        throw new CorruptDurableStoreError(`invalid index key at ${namespace}[${index}]`);
      }
      return Object.freeze({
        key: row.object_key,
        contentHash: assertHash(row.content_hash, `index ${namespace}/${row.object_key}`),
      });
    }));
  }

  listIndexNamespaces(): readonly string[] {
    this.roleGuard();
    const rows = this.database.prepare(
      "SELECT DISTINCT namespace FROM durable_index ORDER BY namespace",
    ).all() as readonly { namespace?: unknown }[];
    return Object.freeze(rows.map((row, index) => {
      if (typeof row.namespace !== "string" || row.namespace.length === 0) {
        throw new CorruptDurableStoreError(`invalid index namespace at ${index}`);
      }
      return row.namespace;
    }));
  }

  addBeforeCommitGuard(guard: () => void): void {
    this.roleGuard();
    if (typeof guard !== "function") throw new TypeError("before-commit guard must be a function");
    this.beforeCommitGuards.push(guard);
  }

  runBeforeCommitGuards(): void {
    for (const guard of this.beforeCommitGuards) guard();
  }
}

function readContentRow(
  database: SqliteDatabase,
  hash: Hash,
): DurableContentRecord | null {
  assertHash(hash, "content hash");
  const row = database.prepare(
    "SELECT hash, payload_hash, kind, bytes, references_json FROM durable_content WHERE hash=?",
  ).get(hash) as {
    hash?: unknown;
    payload_hash?: unknown;
    kind?: unknown;
    bytes?: unknown;
    references_json?: unknown;
  } | undefined;
  if (!row) return null;
  const storedHash = assertHash(row.hash, "durable_content.hash");
  const payloadHash = assertHash(row.payload_hash, "durable_content.payload_hash");
  const bytes = copyBytes(row.bytes, `content ${hash}`);
  if (sha256Hex(bytes) !== payloadHash) {
    throw new CorruptDurableStoreError(`content payload hash mismatch for ${hash}`);
  }
  if (typeof row.kind !== "string" || row.kind.length === 0) {
    throw new CorruptDurableStoreError(`content kind missing for ${hash}`);
  }
  const references = decodeReferences(row.references_json, `content ${hash}`);
  if (contentEnvelopeHash(row.kind, payloadHash, references) !== storedHash || storedHash !== hash) {
    throw new CorruptDurableStoreError(`content envelope hash mismatch for ${hash}`);
  }
  return Object.freeze({
    hash: storedHash,
    payloadHash,
    kind: row.kind,
    bytes,
    references,
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
  const payloadHash = sha256Hex(copied);
  const normalizedReferences = normalizeReferences(references);
  const hash = contentEnvelopeHash(kind, payloadHash, normalizedReferences);
  const encodedReferences = encodeReferences(normalizedReferences);
  for (const reference of normalizedReferences) {
    if (!readContentRow(database, reference)) {
      throw new CorruptDurableStoreError(`immutable content references missing content ${reference}`);
    }
  }
  const existing = database.prepare(
    "SELECT payload_hash, kind, bytes, references_json FROM durable_content WHERE hash=?",
  ).get(hash) as {
    payload_hash?: unknown;
    kind?: unknown;
    bytes?: unknown;
    references_json?: unknown;
  } | undefined;
  if (existing) {
    const existingBytes = copyBytes(existing.bytes, `existing content ${hash}`);
    if (assertHash(existing.payload_hash, `existing content ${hash} payload hash`) !== payloadHash ||
        sha256Hex(existingBytes) !== payloadHash ||
        existingBytes.length !== copied.length ||
        !existingBytes.every((value, index) => value === copied[index])) {
      throw new ImmutableContentConflictError(hash);
    }
    if (typeof existing.kind !== "string" || existing.kind.length === 0) {
      throw new CorruptDurableStoreError(`existing content kind missing for ${hash}`);
    }
    if (existing.kind !== kind) throw new ImmutableContentConflictError(hash);
    const existingReferences = decodeReferences(existing.references_json, `content ${hash}`);
    if (encodeCanonicalJson(existingReferences) !== encodedReferences) {
      throw new ImmutableContentConflictError(hash);
    }
    return hash;
  }
  database.prepare(
    `INSERT INTO durable_content(hash, payload_hash, kind, bytes, byte_length, references_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(hash, payloadHash, kind, copied, copied.byteLength, encodedReferences, Date.now());
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
  const journal = database.prepare("PRAGMA journal_mode").get() as Record<string, unknown>;
  const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
  const synchronous = database.prepare("PRAGMA synchronous").get() as Record<string, unknown>;
  if (String(Object.values(journal)[0]).toLowerCase() !== "wal") {
    throw new DurableStoreError("sqlite-durability-unavailable", "SQLite WAL mode is not active");
  }
  if (Number(Object.values(foreignKeys)[0]) !== 1) {
    throw new DurableStoreError("sqlite-durability-unavailable", "SQLite foreign keys are not active");
  }
  if (Number(Object.values(synchronous)[0]) !== 2) {
    throw new DurableStoreError("sqlite-durability-unavailable", "SQLite synchronous=FULL is not active");
  }
  const tableList = DURABLE_TABLE_NAMES.map(name => `'${name}'`).join(", ");
  const existingOwnedTables = database.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${tableList}) ORDER BY name`,
  ).all() as readonly { name?: unknown }[];
  if (existingOwnedTables.length === 0) {
    database.exec(Object.values(DURABLE_SCHEMA_CREATE_SQL).join("\n"));
    assertSchemaDescriptor(database);
    database.prepare(
      `INSERT INTO ${DURABLE_SCHEMA_CONTRACT_TABLE}(contract_id, schema_version, schema_digest, instance_nonce, role_binding_hash)
       VALUES (1, ?, ?, ?, NULL)`,
    ).run(DURABLE_SCHEMA_VERSION, DURABLE_SCHEMA_DIGEST, randomUUID());
    return;
  }
  readSchemaContract(database);
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
  private boundRole: string | null = null;

  constructor(filename: string, options: DurableStoreOptions = {}) {
    if (
      typeof filename !== "string"
      || filename.length === 0
      || filename === ":memory:"
      || /[?&]mode=memory(?:&|$)/.test(filename)
    ) {
      throw new DurableStoreError("non-durable-filename", "durable-store requires a persistent SQLite filename");
    }
    this.filename = filename;
    this.beforeCommit = options.beforeCommit;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isInteger(this.leaseTtlMs) || this.leaseTtlMs < 1_000) {
      throw new RangeError("leaseTtlMs must be at least 1000ms");
    }
    const driver = loadNodeSqliteDriver();
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

  bindStoreRole(role: string): void {
    if (typeof role !== "string" || !/^[a-z][a-z0-9-]*$/.test(role)) {
      throw new TypeError("durable store role is invalid");
    }
    if (this.boundRole !== null && this.boundRole !== role) {
      throw new DurableStoreError(
        "store-role-mismatch",
        `durable store is already bound to ${this.boundRole}, not ${role}`,
      );
    }
    const initialContract = readSchemaContract(this.database);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const contract = readSchemaContract(this.database);
      const identities = readIdentityRows(this.database);
      if (identities.length > 1 || (identities.length === 1 && identities[0]!.identityId !== 1)) {
        throw new CorruptDurableStoreError("durable store identity must contain exactly one id=1 row");
      }
      if (identities.length === 0) {
        if (contract.roleBindingHash !== null || this.boundRole !== null) {
          throw new DurableStoreError("store-role-mismatch", "durable store role marker is missing");
        }
        const binding = roleBindingHash(role, contract);
        this.database.prepare(
          "INSERT INTO durable_store_identity(identity_id, store_role) VALUES (1, ?)",
        ).run(role);
        const result = this.database.prepare(
          `UPDATE ${DURABLE_SCHEMA_CONTRACT_TABLE} SET role_binding_hash=? WHERE contract_id=1 AND role_binding_hash IS NULL`,
        ).run(binding);
        if (statementNumber(result.changes ?? 0, "durable schema role binding update") !== 1) {
          throw new DurableStoreError("store-role-mismatch", "durable store role binding raced");
        }
      } else {
        const persistedRole = identities[0]!.role;
        if (contract.roleBindingHash === null || roleBindingHash(persistedRole, contract) !== contract.roleBindingHash) {
          throw new CorruptDurableStoreError("durable store role binding digest mismatch");
        }
        if (persistedRole !== role) {
          throw new DurableStoreError(
            "store-role-mismatch",
            `durable store is bound to ${persistedRole}, not ${role}`,
          );
        }
      }
      this.database.exec("COMMIT");
      this.boundRole = role;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve primary failure */ }
      if (error instanceof DurableStoreError) throw error;
      throw sqliteFailure(error, "binding durable store role");
    }
    if (initialContract.schemaDigest !== DURABLE_SCHEMA_DIGEST) {
      throw new CorruptDurableStoreError("durable schema contract changed during role binding");
    }
  }

  private assertRoleAccess(): void {
    const contract = readSchemaContract(this.database);
    const identities = readIdentityRows(this.database);
    if (identities.length === 0) {
      if (contract.roleBindingHash !== null || this.boundRole !== null) {
        throw new DurableStoreError("store-role-mismatch", "durable store role marker is missing");
      }
      return;
    }
    if (identities.length !== 1 || identities[0]!.identityId !== 1) {
      throw new CorruptDurableStoreError("durable store identity must contain exactly one id=1 row");
    }
    const persistedRole = identities[0]!.role;
    if (contract.roleBindingHash === null || roleBindingHash(persistedRole, contract) !== contract.roleBindingHash) {
      throw new CorruptDurableStoreError("durable store role binding digest mismatch");
    }
    if (this.boundRole === null || this.boundRole !== persistedRole) {
      throw new DurableStoreError(
        "store-role-mismatch",
        this.boundRole === null
          ? `durable store role ${persistedRole} was not explicitly bound`
          : `durable store role changed from ${this.boundRole} to ${persistedRole}`,
      );
    }
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
    this.assertRoleAccess();
    return readContentRow(this.database, hash);
  }

  readRoot(): DurableRootRecord | null {
    this.assertRoleAccess();
    return readRootRow(this.database);
  }

  readIndex(namespace: string, key: string): Hash | null {
    this.assertRoleAccess();
    const row = this.database.prepare(
      "SELECT content_hash FROM durable_index WHERE namespace=? AND object_key=?",
    ).get(namespace, key) as { content_hash?: unknown } | undefined;
    if (!row) return null;
    return assertHash(row.content_hash, `index ${namespace}/${key}`);
  }

  listIndex(namespace: string): readonly { readonly key: string; readonly contentHash: Hash }[] {
    this.assertRoleAccess();
    return new SQLiteTransaction(this.database, () => this.assertRoleAccess()).listIndex(namespace);
  }

  listIndexNamespaces(): readonly string[] {
    this.assertRoleAccess();
    return new SQLiteTransaction(this.database, () => this.assertRoleAccess()).listIndexNamespaces();
  }

  acquireWriterLease(owner: string, ttlMs = this.leaseTtlMs): WriterLease {
    this.assertRoleAccess();
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
        if (expiresAt > now) {
          this.database.exec("ROLLBACK");
          throw new WriterBusyError(`writer lease held by ${row.owner}`);
        }
      }
      const token = randomUUID();
      const expiresAtMs = now + ttlMs;
      this.database.prepare(
        `INSERT INTO durable_writer_lease(lease_id, owner, token, expires_at_ms)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(lease_id) DO UPDATE SET owner=excluded.owner, token=excluded.token, expires_at_ms=excluded.expires_at_ms`,
      ).run(owner, token, expiresAtMs);
      this.assertRoleAccess();
      this.database.exec("COMMIT");
      return Object.freeze({ owner, token, expiresAtMs });
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      if (error instanceof WriterBusyError) throw error;
      throw sqliteFailure(error, "acquiring durable writer lease");
    }
  }

  renewWriterLease(lease: WriterLease, ttlMs = this.leaseTtlMs): WriterLease {
    this.assertRoleAccess();
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
    this.assertRoleAccess();
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
    this.assertRoleAccess();
    this.assertLease(lease);
    if (this.inTransaction) throw new DurableStoreError("nested-transaction", "nested SQLite transaction");
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.inTransaction = true;
      this.assertLease(lease);
      const transaction = new SQLiteTransaction(this.database, () => this.assertRoleAccess());
      const result = callback(transaction);
      this.beforeCommit?.();
      transaction.runBeforeCommitGuards();
      // The fault hook models work performed after the callback. Recheck the
      // issuer-owned lease at the last synchronous point before COMMIT so a
      // lease that expired while work was in flight cannot authorize the CAS.
      this.assertLease(lease);
      this.assertRoleAccess();
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
    this.assertRoleAccess();
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

export const DURABLE_ROOT_ENVELOPE_KIND = ROOT_ENVELOPE_KIND;
