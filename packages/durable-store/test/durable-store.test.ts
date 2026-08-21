import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CASConflictError,
  ImmutableContentConflictError,
  WriterBusyError,
  createSqliteDurableStore,
} from "../src/index.ts";
import { encodeCanonicalBytes } from "../../canonical-codec/src/index.ts";

function tempDatabase(): { readonly filename: string; readonly cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "aloha-durable-"));
  return {
    filename: join(directory, "store.sqlite"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
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

test("root CAS rejects stale revision and immutable content references cannot mutate", () => {
  const database = tempDatabase();
  const store = createSqliteDurableStore(database.filename);
  const child = store.putImmutableContent("test/child", new Uint8Array([1, 2, 3]));
  store.compareAndSwapRoot("0", new Uint8Array([4]), [child]);
  assert.throws(
    () => store.compareAndSwapRoot("0", new Uint8Array([5]), [child]),
    (error: unknown) => error instanceof CASConflictError,
  );
  store.putImmutableContent("test/other-kind", new Uint8Array([7, 8, 9]), [child]);
  assert.throws(
    () => store.putImmutableContent("test/other-kind", new Uint8Array([7, 8, 9]), []),
    (error: unknown) => error instanceof ImmutableContentConflictError,
  );
  store.close();
  database.cleanup();
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
