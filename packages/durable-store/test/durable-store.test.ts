import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CASConflictError,
  WriterBusyError,
  WriterLeaseLostError,
  createSqliteDurableStore,
  loadNodeSqliteDriver,
} from "../src/index.ts";
import { encodeCanonicalBytes } from "../../canonical-codec/src/index.ts";

function tempDatabase(): { readonly filename: string; readonly cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "aloha-durable-"));
  return {
    filename: join(directory, "store.sqlite"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function rewriteTableSql(filename: string, table: string, rewrite: (sql: string) => string): void {
  const raw = loadNodeSqliteDriver().open(filename);
  try {
    const row = raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table) as { sql?: unknown } | undefined;
    if (typeof row?.sql !== "string") throw new Error(`missing SQL for ${table}`);
    const backup = `${table}_constraint_backup`;
    const quotedTable = `"${table.replaceAll('"', '""')}"`;
    const quotedBackup = `"${backup.replaceAll('"', '""')}"`;
    raw.exec(`ALTER TABLE ${quotedTable} RENAME TO ${quotedBackup}`);
    raw.exec(rewrite(row.sql));
    raw.exec(`DROP TABLE ${quotedBackup}`);
  } finally {
    raw.close();
  }
}

test("SQLite integration is a real WAL file store and survives close/reopen", () => {
  const database = tempDatabase();
  const first = createSqliteDurableStore(database.filename);
  assert.equal(String(first.pragma("journal_mode")).toLowerCase(), "wal");
  assert.equal(Number(first.pragma("foreign_keys")), 1);
  assert.equal(Number(first.pragma("synchronous")), 2);
  const child = first.putImmutableContent("test/child", encodeCanonicalBytes({ value: "persisted" }));
  const root = first.compareAndSwapRoot(
    "0",
    encodeCanonicalBytes({ revision: "1", root: child }),
    [child],
  );
  assert.equal(root.revision, "1");
  first.close();

  const reopened = createSqliteDurableStore(database.filename);
  assert.deepEqual(reopened.readContent(child)?.bytes, encodeCanonicalBytes({ value: "persisted" }));
  assert.equal(reopened.readRoot()?.revision, "1");
  reopened.close();
  database.cleanup();
});

test("root CAS rejects stale revision and physical envelope identity binds references", () => {
  const database = tempDatabase();
  const store = createSqliteDurableStore(database.filename);
  const child = store.putImmutableContent("test/child", new Uint8Array([1, 2, 3]));
  store.compareAndSwapRoot("0", new Uint8Array([4]), [child]);
  assert.throws(
    () => store.compareAndSwapRoot("0", new Uint8Array([5]), [child]),
    (error: unknown) => error instanceof CASConflictError,
  );
  const referenced = store.putImmutableContent("test/other-kind", new Uint8Array([7, 8, 9]), [child]);
  const detached = store.putImmutableContent("test/other-kind", new Uint8Array([7, 8, 9]), []);
  assert.notEqual(referenced, detached);
  assert.deepEqual(store.readContent(referenced)?.references, [child]);
  assert.deepEqual(store.readContent(detached)?.references, []);
  assert.equal(store.putImmutableContent("test/other-kind", new Uint8Array([7, 8, 9]), [child]), referenced);
  store.close();
  database.cleanup();
});

test("content kind is part of the physical envelope and missing references never commit", () => {
  const database = tempDatabase();
  const store = createSqliteDurableStore(database.filename);
  const bytes = new Uint8Array([7, 8, 9]);
  const first = store.putImmutableContent("test/kind-a", bytes);
  const second = store.putImmutableContent("test/kind-b", bytes);
  assert.notEqual(first, second);
  assert.equal(store.readContent(first)?.payloadHash, store.readContent(second)?.payloadHash);
  const missing = `0x${"f".repeat(64)}` as `0x${string}`;
  assert.throws(() => store.putImmutableContent("test/dangling", new Uint8Array([1]), [missing]), /missing content/);
  assert.throws(() => store.compareAndSwapRoot("0", new Uint8Array([2]), [missing]), /missing content/);
  assert.equal(store.readRoot(), null);
  store.close();
  database.cleanup();
});

test("a stored kind or reference mutation is detected by the physical envelope hash", () => {
  const database = tempDatabase();
  const store = createSqliteDurableStore(database.filename);
  const child = store.putImmutableContent("test/child", new Uint8Array([1]));
  const parent = store.putImmutableContent("test/parent", new Uint8Array([2]), [child]);
  store.close();

  const raw = loadNodeSqliteDriver().open(database.filename);
  raw.prepare("UPDATE durable_content SET references_json=? WHERE hash=?").run("[]", parent);
  raw.close();

  const reopened = createSqliteDurableStore(database.filename);
  assert.throws(() => reopened.readContent(parent), /envelope hash mismatch/);
  reopened.close();
  database.cleanup();
});

test("production constructor rejects in-memory SQLite and same-owner lease sharing", () => {
  assert.throws(() => createSqliteDurableStore(":memory:"), /persistent SQLite filename/);
  const database = tempDatabase();
  const first = createSqliteDurableStore(database.filename);
  const second = createSqliteDurableStore(database.filename);
  const lease = first.acquireWriterLease("same-owner");
  assert.throws(() => second.acquireWriterLease("same-owner"), WriterBusyError);
  first.releaseWriterLease(lease);
  first.close();
  second.close();
  database.cleanup();
});

test("a persisted store role must be explicitly rebound before any authority read", () => {
  const database = tempDatabase();
  const first = createSqliteDurableStore(database.filename);
  first.bindStoreRole("checkpoint");
  first.close();
  const unbound = createSqliteDurableStore(database.filename);
  assert.throws(() => unbound.readRoot(), /role checkpoint was not explicitly bound/);
  assert.throws(() => unbound.bindStoreRole("canonical-journal"), /store-role-mismatch|bound to checkpoint/);
  unbound.bindStoreRole("checkpoint");
  assert.equal(unbound.readRoot(), null);
  unbound.close();
  database.cleanup();
});

test("deleting the persisted role marker fails closed for an open and reopened store", () => {
  const database = tempDatabase();
  const first = createSqliteDurableStore(database.filename);
  first.bindStoreRole("checkpoint");
  const raw = loadNodeSqliteDriver().open(database.filename);
  raw.prepare("DELETE FROM durable_store_identity WHERE identity_id=1").run();
  raw.close();
  assert.throws(() => first.readRoot(), /role marker is missing/);
  first.close();

  const reopened = createSqliteDurableStore(database.filename);
  assert.throws(() => reopened.readRoot(), /role marker is missing/);
  assert.throws(() => reopened.bindStoreRole("checkpoint"), /role marker is missing/);
  reopened.close();
  database.cleanup();
});

test("mutating the persisted role fails closed before and after reopen", () => {
  const database = tempDatabase();
  const first = createSqliteDurableStore(database.filename);
  first.bindStoreRole("checkpoint");
  const raw = loadNodeSqliteDriver().open(database.filename);
  raw.prepare("UPDATE durable_store_identity SET store_role=? WHERE identity_id=1").run("canonical-journal");
  raw.close();
  assert.throws(() => first.readRoot(), /role binding digest mismatch/);
  first.close();

  const reopened = createSqliteDurableStore(database.filename);
  assert.throws(() => reopened.bindStoreRole("checkpoint"), /role binding digest mismatch/);
  assert.throws(() => reopened.readRoot(), /role binding digest mismatch/);
  reopened.close();
  database.cleanup();
});

test("a copied identity row cannot bind a different schema instance", () => {
  const source = tempDatabase();
  const target = tempDatabase();
  const sourceStore = createSqliteDurableStore(source.filename);
  sourceStore.bindStoreRole("checkpoint");
  sourceStore.close();
  const sourceRaw = loadNodeSqliteDriver().open(source.filename);
  const role = sourceRaw.prepare("SELECT store_role FROM durable_store_identity WHERE identity_id=1").get() as { store_role?: unknown };
  sourceRaw.close();

  const targetStore = createSqliteDurableStore(target.filename);
  const targetRaw = loadNodeSqliteDriver().open(target.filename);
  targetRaw.prepare("INSERT INTO durable_store_identity(identity_id, store_role) VALUES (1, ?)").run(String(role.store_role));
  targetRaw.close();
  assert.throws(() => targetStore.bindStoreRole("checkpoint"), /role binding digest mismatch/);
  assert.throws(() => targetStore.readRoot(), /role binding digest mismatch/);
  targetStore.close();
  source.cleanup();
  target.cleanup();
});

test("schema contract rejects version or structure mutation but ignores unrelated future tables", () => {
  const database = tempDatabase();
  const first = createSqliteDurableStore(database.filename);
  first.bindStoreRole("checkpoint");
  first.close();

  const extension = loadNodeSqliteDriver().open(database.filename);
  extension.exec("CREATE TABLE future_extension (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  extension.close();
  const extensionAccepted = createSqliteDurableStore(database.filename);
  extensionAccepted.bindStoreRole("checkpoint");
  assert.equal(extensionAccepted.readRoot(), null);
  extensionAccepted.close();

  const digestMutation = loadNodeSqliteDriver().open(database.filename);
  digestMutation.prepare("UPDATE durable_schema_contract SET schema_digest=? WHERE contract_id=1").run(`0x${"f".repeat(64)}`);
  digestMutation.close();
  assert.throws(() => createSqliteDurableStore(database.filename), /schema version contract mismatch/);
  database.cleanup();

  const structure = tempDatabase();
  const initial = createSqliteDurableStore(structure.filename);
  initial.close();
  const changed = loadNodeSqliteDriver().open(structure.filename);
  changed.exec("ALTER TABLE durable_content RENAME COLUMN payload_hash TO legacy_payload_hash");
  changed.close();
  assert.throws(() => createSqliteDurableStore(structure.filename), /schema digest mismatch/);
  structure.cleanup();
});

test("schema contract binds table constraints even when columns and indexes are unchanged", () => {
  const deletedCheck = tempDatabase();
  const initialDeletedCheck = createSqliteDurableStore(deletedCheck.filename);
  initialDeletedCheck.close();
  rewriteTableSql(deletedCheck.filename, "durable_store_identity", sql => {
    const rewritten = sql.replace("CHECK (identity_id = 1)", "");
    assert.notEqual(rewritten, sql);
    return rewritten;
  });
  assert.throws(() => createSqliteDurableStore(deletedCheck.filename), /schema digest mismatch/);
  deletedCheck.cleanup();

  const modifiedCheck = tempDatabase();
  const initialModifiedCheck = createSqliteDurableStore(modifiedCheck.filename);
  initialModifiedCheck.close();
  rewriteTableSql(modifiedCheck.filename, "durable_content", sql => {
    const rewritten = sql.replace("CHECK (byte_length >= 0)", "CHECK (byte_length > 0)");
    assert.notEqual(rewritten, sql);
    return rewritten;
  });
  assert.throws(() => createSqliteDurableStore(modifiedCheck.filename), /schema digest mismatch/);
  modifiedCheck.cleanup();
});

test("single writer lease excludes a competing SQLite connection", () => {
  const database = tempDatabase();
  const first = createSqliteDurableStore(database.filename);
  const second = createSqliteDurableStore(database.filename);
  const lease = first.acquireWriterLease("writer-a");
  assert.throws(
    () => second.acquireWriterLease("writer-b"),
    (error: unknown) => error instanceof WriterBusyError,
  );
  first.releaseWriterLease(lease);
  const secondLease = second.acquireWriterLease("writer-b");
  second.releaseWriterLease(secondLease);
  first.close();
  second.close();
  database.cleanup();
});

test("a fault before commit leaves no partially visible content or root", () => {
  const database = tempDatabase();
  let fail = true;
  const store = createSqliteDurableStore(database.filename, {
    beforeCommit: () => {
      if (fail) {
        fail = false;
        throw new Error("simulated process crash before commit");
      }
    },
  });
  assert.throws(() => {
    store.compareAndSwapRoot("0", encodeCanonicalBytes({ revision: "1" }));
  });
  assert.equal(store.readRoot(), null);
  assert.deepEqual(store.contentHashes(), []);
  const child = store.putImmutableContent("test/live", new Uint8Array([9]));
  store.compareAndSwapRoot("0", encodeCanonicalBytes({ revision: "1", root: child }), [child]);
  assert.equal(store.readContent(child)?.bytes[0], 9);
  store.close();
  database.cleanup();
});

test("the writer lease is rechecked after the final hook and immediately before COMMIT", () => {
  const database = tempDatabase();
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  const store = createSqliteDurableStore(database.filename, {
    leaseTtlMs: 1_000,
    beforeCommit: () => { now += 1_001; },
  });
  try {
    const lease = store.acquireWriterLease("expiring-writer");
    assert.throws(
      () => store.transaction(lease, tx => {
        tx.putImmutable("test/uncommitted", new Uint8Array([1]));
      }),
      (error: unknown) => error instanceof WriterLeaseLostError,
    );
    assert.deepEqual(store.contentHashes(), []);
  } finally {
    Date.now = originalNow;
    store.close();
    database.cleanup();
  }
});

test("a killed writer process leaves the last committed root and content closure intact", () => {
  const database = tempDatabase();
  const initial = createSqliteDurableStore(database.filename);
  const live = initial.putImmutableContent("test/live-before-crash", new Uint8Array([1]));
  initial.compareAndSwapRoot("0", encodeCanonicalBytes({ revision: "1", live }), [live]);
  const committedHashes = initial.contentHashes();
  initial.close();

  const childSource = String.raw`
    import { createSqliteDurableStore } from "./packages/durable-store/src/index.ts";
    import { encodeCanonicalBytes } from "./packages/canonical-codec/src/index.ts";
    const filename = process.argv[1];
    const store = createSqliteDurableStore(filename, {
      beforeCommit() { process.kill(process.pid, "SIGKILL"); },
    });
    store.compareAndSwapRoot("1", encodeCanonicalBytes({ revision: "2", crash: true }));
  `;
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", childSource, database.filename],
    { cwd: new URL("../../..", import.meta.url), encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(child.signal, "SIGKILL", child.stderr || child.stdout);

  const reopened = createSqliteDurableStore(database.filename);
  assert.equal(reopened.readRoot()?.revision, "1");
  assert.deepEqual(reopened.readContent(live)?.bytes, new Uint8Array([1]));
  assert.deepEqual(reopened.contentHashes(), committedHashes);
  reopened.close();
  database.cleanup();
});

test("GC preserves root-reachable content and deletes unreachable content", () => {
  const database = tempDatabase();
  const store = createSqliteDurableStore(database.filename);
  const liveChild = store.putImmutableContent("test/live", new Uint8Array([1]));
  const orphan = store.putImmutableContent("test/orphan", new Uint8Array([2]));
  store.compareAndSwapRoot("0", new Uint8Array([3]), [liveChild]);
  const deleted = store.garbageCollect();
  assert.ok(deleted.includes(orphan));
  assert.equal(store.readContent(liveChild)?.bytes[0], 1);
  assert.equal(store.readContent(orphan), null);
  store.close();
  database.cleanup();
});
