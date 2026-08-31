import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Hex, type Hash } from "../../canonical-codec/src/index.ts";
import {
  AppendEventConflictError,
  AppendSequenceConflictError,
  WriterBusyError,
  WriterLeaseLostError,
  createSqliteDurableStore,
  loadNodeSqliteDriver,
  readDurableAppendCapabilityV1,
  type DurableAppendRequest,
  type SqliteDatabase,
} from "../src/index.ts";

test("append capability exposes only the exact fsynced stored row", () => {
  const database = tempDatabase();
  const store = createSqliteDurableStore(database.filename);
  const append = request("evidence/v1", "0", new Uint8Array([1, 2, 3]));
  const capability = store.appendFsyncMonotonicCapability(append);
  const record = readDurableAppendCapabilityV1(capability);
  assert.equal(record.eventId, append.eventId);
  assert.equal(record.contentSha256, append.contentSha256);
  assert.deepEqual([...record.bytes], [1, 2, 3]);
  assert.equal(record.fsynced, true);
  assert.deepEqual(Reflect.ownKeys(capability), []);
  assert.throws(() => readDurableAppendCapabilityV1({ ...capability }), /not owner-issued/);
  store.close();
  database.cleanup();
});

function tempDatabase(): { readonly filename: string; readonly cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "aloha-append-log-"));
  return {
    filename: join(directory, "store.sqlite"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function request(
  namespace: string,
  sequence: string,
  bytes: Uint8Array,
  eventName = `${namespace}/${sequence}`,
): DurableAppendRequest {
  return Object.freeze({
    namespace,
    sequence,
    eventId: sha256Hex(new TextEncoder().encode(eventName)),
    contentSha256: sha256Hex(bytes),
    bytes,
  });
}

function mutateAppendRows(filename: string, mutation: (raw: SqliteDatabase) => void): void {
  const raw = loadNodeSqliteDriver().open(filename);
  try {
    raw.exec("DROP TRIGGER durable_append_log_no_update");
    mutation(raw);
    raw.exec(`
      CREATE TRIGGER durable_append_log_no_update
      BEFORE UPDATE ON durable_append_log
      BEGIN
        SELECT RAISE(ABORT, 'durable append-log is append-only');
      END;
    `);
  } finally {
    raw.close();
  }
}

test("durable append-log returns exact FULL-sync receipts and continues after reopen", () => {
  const database = tempDatabase();
  const first = createSqliteDurableStore(database.filename);
  first.bindStoreRole("event-log");
  const firstBytes = new Uint8Array([1, 2, 3]);
  const firstRequest = request("evidence/v1", "0", firstBytes);
  const firstReceipt = first.appendFsyncMonotonic(firstRequest);
  assert.deepEqual(firstReceipt, {
    namespace: "evidence/v1",
    sequence: "0",
    eventId: firstRequest.eventId,
    contentSha256: firstRequest.contentSha256,
    byteLength: "3",
    offsetStart: "0",
    offsetEnd: "3",
    fsynced: true,
  });
  firstBytes[0] = 255;

  const secondRequest = request("evidence/v1", "1", new Uint8Array([4, 5]));
  assert.deepEqual(first.appendFsyncMonotonic(secondRequest), {
    namespace: "evidence/v1",
    sequence: "1",
    eventId: secondRequest.eventId,
    contentSha256: secondRequest.contentSha256,
    byteLength: "2",
    offsetStart: "3",
    offsetEnd: "5",
    fsynced: true,
  });
  const other = request("performance/v1", "0", new Uint8Array([9]));
  assert.equal(first.appendFsyncMonotonic(other).offsetStart, "0");
  assert.deepEqual(first.readAppendLog("evidence/v1").map((row) => row.bytes), [
    new Uint8Array([1, 2, 3]),
    new Uint8Array([4, 5]),
  ]);

  const raw = loadNodeSqliteDriver().open(database.filename);
  assert.equal(
    (raw.prepare("SELECT schema_version FROM durable_schema_contract WHERE contract_id=1").get() as { schema_version: string }).schema_version,
    "2",
  );
  assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='durable_append_log'").get());
  assert.throws(
    () => raw.prepare("UPDATE durable_append_log SET offset_end='99' WHERE namespace='evidence/v1' AND sequence='0'").run(),
    /append-only/,
  );
  assert.throws(
    () => raw.prepare("DELETE FROM durable_append_log WHERE namespace='evidence/v1' AND sequence='1'").run(),
    /append-only/,
  );
  raw.close();
  first.close();

  const reopened = createSqliteDurableStore(database.filename);
  reopened.bindStoreRole("event-log");
  const third = request("evidence/v1", "2", new Uint8Array([6, 7, 8, 9]));
  const thirdReceipt = reopened.appendFsyncMonotonic(third);
  assert.equal(thirdReceipt.offsetStart, "5");
  assert.equal(thirdReceipt.offsetEnd, "9");
  assert.equal(thirdReceipt.fsynced, true);
  assert.deepEqual(reopened.readAppendLog("evidence/v1").map((row) => row.sequence), ["0", "1", "2"]);
  reopened.close();
  database.cleanup();
});

test("duplicate, gap, reorder, duplicate event, and content mismatch never advance sequence", () => {
  const database = tempDatabase();
  const store = createSqliteDurableStore(database.filename);
  const zero = request("evidence/v1", "0", new Uint8Array([1]));
  store.appendFsyncMonotonic(zero);
  assert.throws(
    () => store.appendFsyncMonotonic(zero),
    (error: unknown) => error instanceof AppendSequenceConflictError,
  );
  assert.throws(
    () => store.appendFsyncMonotonic(request("evidence/v1", "2", new Uint8Array([2]))),
    (error: unknown) => error instanceof AppendSequenceConflictError,
  );
  assert.throws(
    () => store.appendFsyncMonotonic(request("evidence/v1", "0", new Uint8Array([3]), "reordered")),
    (error: unknown) => error instanceof AppendSequenceConflictError,
  );
  const duplicateEvent = {
    ...request("evidence/v1", "1", new Uint8Array([4])),
    eventId: zero.eventId,
  };
  assert.throws(
    () => store.appendFsyncMonotonic(duplicateEvent),
    (error: unknown) => error instanceof AppendEventConflictError,
  );
  const mismatch = request("evidence/v1", "1", new Uint8Array([5]));
  assert.throws(
    () => store.appendFsyncMonotonic({ ...mismatch, contentSha256: zero.contentSha256 }),
    /does not match exact bytes/,
  );
  const one = request("evidence/v1", "1", new Uint8Array([6]));
  assert.equal(store.appendFsyncMonotonic(one).sequence, "1");
  assert.deepEqual(store.readAppendLog("evidence/v1").map((row) => row.sequence), ["0", "1"]);
  store.close();
  database.cleanup();
});

test("a failed FULL-sync transaction rolls back the row and leaves sequence zero available", () => {
  const database = tempDatabase();
  let fail = true;
  const store = createSqliteDurableStore(database.filename, {
    beforeCommit: () => {
      if (fail) {
        fail = false;
        throw new Error("simulated failure before commit");
      }
    },
  });
  const zero = request("evidence/v1", "0", new Uint8Array([1, 2]));
  assert.throws(() => store.appendFsyncMonotonic(zero), /simulated failure before commit/);
  assert.deepEqual(store.readAppendLog("evidence/v1"), []);
  assert.equal(store.appendFsyncMonotonic(zero).sequence, "0");
  store.close();
  database.cleanup();
});

test("append hot path reuses the verified tail and refreshes only after an external commit", () => {
  const database = tempDatabase();
  let fullValidations = 0;
  let fullSchemaValidations = 0;
  const first = createSqliteDurableStore(database.filename, {
    onFullAppendLogValidation: () => { fullValidations += 1; },
    onFullSchemaValidation: () => { fullSchemaValidations += 1; },
  });
  assert.equal(fullValidations, 1, "open validates the complete append log once");
  assert.equal(fullSchemaValidations, 1, "open validates schema and role once");
  first.bindStoreRole("event-log");
  assert.equal(fullSchemaValidations, 2, "role binding explicitly refreshes the validated state");

  for (let sequence = 0; sequence < 64; sequence += 1) {
    first.appendFsyncMonotonicCapability(request(
      "evidence/v1",
      String(sequence),
      new Uint8Array([sequence]),
    ));
  }
  assert.equal(fullValidations, 1, "local append growth must not trigger full-log validation");
  assert.equal(fullSchemaValidations, 2, "local append growth must not repeat full schema validation");

  const second = createSqliteDurableStore(database.filename);
  second.bindStoreRole("event-log");
  second.appendFsyncMonotonic(request("evidence/v1", "64", new Uint8Array([64])));
  first.appendFsyncMonotonic(request("evidence/v1", "65", new Uint8Array([65])));
  assert.equal(fullValidations, 2, "an external commit refreshes the complete verified prefix exactly once");
  assert.equal(fullSchemaValidations, 3, "an external commit refreshes schema and role exactly once");

  second.close();
  first.close();
  database.cleanup();
});

test("an open store detects externally corrupted append bytes before using its cached tail", () => {
  const database = tempDatabase();
  const store = createSqliteDurableStore(database.filename);
  store.appendFsyncMonotonic(request("evidence/v1", "0", new Uint8Array([1, 2])));
  mutateAppendRows(database.filename, (raw) => {
    raw.prepare("UPDATE durable_append_log SET bytes=? WHERE namespace='evidence/v1' AND sequence='0'")
      .run(new Uint8Array([8, 8]));
  });
  assert.throws(
    () => store.appendFsyncMonotonic(request("evidence/v1", "1", new Uint8Array([3]))),
    /content hash mismatch/,
  );
  store.close();
  database.cleanup();
});

test("capability validation consumes an external commit and rejects a corrupted old prefix", () => {
  const database = tempDatabase();
  let corruptAfterCommit = false;
  let fullValidations = 0;
  const store = createSqliteDurableStore(database.filename, {
    onFullAppendLogValidation: () => { fullValidations += 1; },
    beforeAppendCapabilityValidation: () => {
      if (!corruptAfterCommit) return;
      corruptAfterCommit = false;
      mutateAppendRows(database.filename, (raw) => {
        raw.prepare("UPDATE durable_append_log SET bytes=? WHERE namespace='evidence/v1' AND sequence='0'")
          .run(new Uint8Array([9, 9]));
      });
    },
  });
  store.appendFsyncMonotonic(request("evidence/v1", "0", new Uint8Array([1, 2])));
  corruptAfterCommit = true;
  assert.throws(
    () => store.appendFsyncMonotonicCapability(
      request("evidence/v1", "1", new Uint8Array([3])),
    ),
    /content hash mismatch/,
  );
  assert.equal(fullValidations, 2, "capability validation must revalidate the externally changed prefix");
  store.close();
  database.cleanup();
});

test("append-log checks the writer lease and bound role on every append", () => {
  const database = tempDatabase();
  const first = createSqliteDurableStore(database.filename);
  const second = createSqliteDurableStore(database.filename);
  first.bindStoreRole("event-log");
  second.bindStoreRole("event-log");
  const lease = first.acquireWriterLease("writer-a");
  assert.throws(
    () => second.appendFsyncMonotonic(request("evidence/v1", "0", new Uint8Array([1]))),
    (error: unknown) => error instanceof WriterBusyError,
  );
  first.releaseWriterLease(lease);
  assert.throws(
    () => first.appendFsyncMonotonic(request("evidence/v1", "0", new Uint8Array([1])), lease),
    (error: unknown) => error instanceof WriterLeaseLostError,
  );

  const raw = loadNodeSqliteDriver().open(database.filename);
  raw.prepare("UPDATE durable_store_identity SET store_role='other-role' WHERE identity_id=1").run();
  raw.close();
  assert.throws(
    () => first.appendFsyncMonotonic(request("evidence/v1", "0", new Uint8Array([1]))),
    /role binding digest mismatch/,
  );
  first.close();
  second.close();
  database.cleanup();
});

test("schema contract, sequence rows, offsets, and content mutation fail closed on reopen", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly mutate: (filename: string) => void;
    readonly diagnostic: RegExp;
  }[] = [
    {
      name: "extension schema contract",
      mutate(filename) {
        const raw = loadNodeSqliteDriver().open(filename);
        raw.prepare("UPDATE durable_append_log_schema_contract SET schema_digest=? WHERE contract_id=1")
          .run(`0x${"f".repeat(64)}` as Hash);
        raw.close();
      },
      diagnostic: /append-log schema version or core binding mismatch/,
    },
    {
      name: "sequence row",
      mutate(filename) {
        mutateAppendRows(filename, (raw) => {
          raw.prepare("UPDATE durable_append_log SET sequence='2' WHERE namespace='evidence/v1' AND sequence='1'").run();
        });
      },
      diagnostic: /sequence gap or reorder/,
    },
    {
      name: "cumulative offset",
      mutate(filename) {
        mutateAppendRows(filename, (raw) => {
          raw.prepare("UPDATE durable_append_log SET offset_start='1' WHERE namespace='evidence/v1' AND sequence='0'").run();
        });
      },
      diagnostic: /cumulative offset mismatch/,
    },
    {
      name: "exact content bytes",
      mutate(filename) {
        mutateAppendRows(filename, (raw) => {
          raw.prepare("UPDATE durable_append_log SET bytes=? WHERE namespace='evidence/v1' AND sequence='0'")
            .run(new Uint8Array([8, 8]));
        });
      },
      diagnostic: /content hash mismatch/,
    },
    {
      name: "extension table structure",
      mutate(filename) {
        const raw = loadNodeSqliteDriver().open(filename);
        raw.exec("ALTER TABLE durable_append_log RENAME COLUMN offset_end TO changed_offset_end");
        raw.close();
      },
      diagnostic: /append-log SQLite schema digest mismatch/,
    },
    {
      name: "unexpected owned trigger",
      mutate(filename) {
        const raw = loadNodeSqliteDriver().open(filename);
        raw.exec(`
          CREATE TRIGGER durable_append_log_unqualified_side_effect
          BEFORE INSERT ON durable_append_log
          BEGIN
            SELECT 1;
          END;
        `);
        raw.close();
      },
      diagnostic: /append-log SQLite schema digest mismatch/,
    },
    {
      name: "missing extension is not migrated",
      mutate(filename) {
        const raw = loadNodeSqliteDriver().open(filename);
        raw.exec("DROP TRIGGER durable_append_log_no_update");
        raw.exec("DROP TRIGGER durable_append_log_no_delete");
        raw.exec("DROP TABLE durable_append_log");
        raw.exec("DROP TABLE durable_append_log_schema_contract");
        raw.close();
      },
      diagnostic: /append-log schema is missing from an existing strict-only store/,
    },
  ];

  for (const mutation of cases) {
    await t.test(mutation.name, () => {
      const database = tempDatabase();
      const store = createSqliteDurableStore(database.filename);
      store.appendFsyncMonotonic(request("evidence/v1", "0", new Uint8Array([1, 2])));
      store.appendFsyncMonotonic(request("evidence/v1", "1", new Uint8Array([3])));
      store.close();
      mutation.mutate(database.filename);
      assert.throws(() => createSqliteDurableStore(database.filename), mutation.diagnostic);
      database.cleanup();
    });
  }
});
