import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { UniverseRebuildCheckpointStore, type RunOutcome } from "../universe-rebuild-checkpoint.js";
import { loadCheckpointStatusSnapshot } from "../universe-rebuild-status-snapshot.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "status-snapshot-test-"));
  const path = join(directory, "checkpoint.json");
  const store = new UniverseRebuildCheckpointStore({ path });
  const cutoff = { number: 100, hash: "0x" + "a1".repeat(32), generation: 1 };
  await store.beginOrResumeRun({ expectedRevision: 0, runId: "test", cutoff,
    fromBlock: 100, universeHash: "u", candidateSetHash: "c", candidateCount: 2,
    candidatesByKey: { a: { id: "a" }, b: { id: "b" } }, observedThrough: cutoff,
    sourceReceipts: [{ sourceKey: "1".repeat(64), sourceKind: "startup-candidate-union",
      providerIdentity: "test", queryFingerprint: "2".repeat(64), fromBlock: 100, toBlock: 100,
      cutoffNumber: 100, cutoffHash: cutoff.hash, coverageKeys: ["test|startup-universe"],
      completedChunks: [{ fromBlock: 100, toBlock: 100, resultCount: 2, resultHash: "3".repeat(64) }],
      observationSetHash: "4".repeat(64), observedThrough: cutoff, appliedThrough: cutoff,
      retryableCount: 0, status: "complete" }],
  });
  const outcome = (key: string): RunOutcome => ({ status: "retryable", familyCandidateKey: key,
    familyId: "test", candidateSnapshot: { id: key }, stage: "identity", failureCode: "rpc",
    reasonCode: "temporary", attemptCount: 1, lastAttemptAt: "2026-10-19T00:00:00Z" });
  return { directory, path, store, outcome, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("status of an absent path does not create a source directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "status-absent-test-"));
  try {
    const parent = join(directory, "not-created");
    assert.equal(await loadCheckpointStatusSnapshot(join(parent, "checkpoint.json")), null);
    await assert.rejects(stat(parent), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("status works while the original writer lock is held and never changes it", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.path);
    const lock = f.path + ".lock";
    await writeFile(lock, String(process.pid) + "\n", { flag: "wx" });
    const lockBefore = await stat(lock, { bigint: true });
    await assert.rejects(new UniverseRebuildCheckpointStore({ path: f.path, lockWaitTimeoutMs: 20 }).load(),
      /CAS lock is held/, "old status read contends with the active writer");
    const current = await loadCheckpointStatusSnapshot(f.path);
    assert.equal(current?.inProgressRun?.runId, "test");
    assert.deepEqual(await readFile(f.path), before);
    assert.equal((await stat(lock, { bigint: true })).mtimeNs, lockBefore.mtimeNs);
    assert.equal((await stat(lock, { bigint: true })).ino, lockBefore.ino);
    assert.equal(await readFile(lock, "utf8"), String(process.pid) + "\n");
    await rm(lock);
    await f.store.casMergeRunOutcomes("test", [f.outcome("a")]);
    assert.equal((await loadCheckpointStatusSnapshot(f.path))?.inProgressRun?.outcomesByCandidateKey.a?.status, "retryable");
  } finally { await f.cleanup(); }
});

test("committed journal outcomes are included but a torn final record is not repaired", async () => {
  const f = await fixture();
  try {
    const written = await f.store.casMergeRunOutcomes("test", [f.outcome("a"), f.outcome("b")]);
    const journal = f.path + ".attestation-journal";
    await appendFile(journal, '{"partial":');
    const before = await readFile(journal);
    const current = await loadCheckpointStatusSnapshot(f.path);
    assert.equal(current?.checkpointFingerprint, written.checkpointFingerprint);
    assert.equal(Object.keys(current!.inProgressRun!.outcomesByCandidateKey).length, 2);
    assert.deepEqual(await readFile(journal), before);
  } finally { await f.cleanup(); }
});

test("corrupt base and corrupt committed journal still fail closed and clean snapshots", async t => {
  const f = await fixture();
  const makeDirectory = fs.mkdtemp, snapshots: string[] = [];
  try {
    t.mock.method(fs, "mkdtemp", async (prefix: string) => {
      const path = await makeDirectory(prefix); snapshots.push(path); return path;
    });
    syncBuiltinESMExports();
    const valid = await readFile(f.path, "utf8");
    await writeFile(f.path, valid.replace('"revision":2', '"revision":999'));
    await assert.rejects(loadCheckpointStatusSnapshot(f.path), /fingerprint/);
    await writeFile(f.path, valid);
    await appendFile(f.path + ".attestation-journal", '{"invalid":true}\n');
    await assert.rejects(loadCheckpointStatusSnapshot(f.path));
    assert.equal(await readFile(f.path, "utf8"), valid);
    assert.equal(await readFile(f.path + ".attestation-journal", "utf8"), '{"invalid":true}\n');
    assert.equal(snapshots.length, 6);
    for (const path of snapshots) await assert.rejects(stat(path), { code: "ENOENT" });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.cleanup(); }
});

test("compaction between base and journal copies retries the whole snapshot", async t => {
  const f = await fixture();
  const copy = fs.copyFile;
  let baseCopies = 0;
  try {
    await f.store.casMergeRunOutcomes("test", [f.outcome("a")]);
    t.mock.method(fs, "copyFile", async (...args: Parameters<typeof copy>) => {
      await copy(...args);
      if (args[0] === f.path && ++baseCopies === 1) {
        await f.store.casReplaceRunOutcome({ runId: "test", familyCandidateKey: "a", expectedAttemptCount: 1,
          nextOutcome: { ...f.outcome("a"), attemptCount: 2 } as RunOutcome });
        await f.store.casMergeRunOutcomes("test", [f.outcome("b")]);
      }
    });
    syncBuiltinESMExports();
    const current = await loadCheckpointStatusSnapshot(f.path);
    assert.equal(baseCopies, 2, "do not accept an old base after its journal has been compacted away");
    const outcome = current!.inProgressRun!.outcomesByCandidateKey.a!;
    assert(outcome.status === "retryable");
    assert.equal(outcome.attemptCount, 2);
    assert.equal(current!.inProgressRun!.outcomesByCandidateKey.b!.status, "retryable");
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); await f.cleanup();
  }
});

test("concurrent journal append is a valid observed prefix without locking the source", async t => {
  const f = await fixture();
  const copy = fs.copyFile;
  try {
    await f.store.casMergeRunOutcomes("test", [f.outcome("a")]);
    t.mock.method(fs, "copyFile", async (...args: Parameters<typeof copy>) => {
      await copy(...args);
      if (args[0] === f.path) await f.store.casMergeRunOutcomes("test", [f.outcome("b")]);
    });
    syncBuiltinESMExports();
    const current = await loadCheckpointStatusSnapshot(f.path);
    assert.deepEqual(Object.keys(current!.inProgressRun!.outcomesByCandidateKey).sort(), ["a", "b"]);
    await assert.rejects(stat(f.path + ".lock"), { code: "ENOENT" });
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); await f.cleanup();
  }
});

test("continuous compaction exhausts bounded retries rather than returning a stale snapshot", async t => {
  const f = await fixture();
  const copy = fs.copyFile, makeDirectory = fs.mkdtemp, snapshots: string[] = [];
  let attemptCount = 1, baseCopies = 0;
  try {
    await f.store.casMergeRunOutcomes("test", [f.outcome("a")]);
    t.mock.method(fs, "mkdtemp", async (prefix: string) => {
      const path = await makeDirectory(prefix); snapshots.push(path); return path;
    });
    t.mock.method(fs, "copyFile", async (...args: Parameters<typeof copy>) => {
      await copy(...args);
      if (args[0] === f.path) {
        baseCopies++;
        await f.store.casReplaceRunOutcome({ runId: "test", familyCandidateKey: "a",
          expectedAttemptCount: attemptCount++, nextOutcome: { ...f.outcome("a"), attemptCount } as RunOutcome });
      }
    });
    syncBuiltinESMExports();
    await assert.rejects(loadCheckpointStatusSnapshot(f.path), /changed during status snapshot/);
    assert.equal(baseCopies, 3);
    await assert.rejects(stat(f.path + ".lock"), { code: "ENOENT" });
    assert.equal(snapshots.length, 3);
    for (const path of snapshots) await assert.rejects(stat(path), { code: "ENOENT" });
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); await f.cleanup();
  }
});

test("a new compacted base with its old journal remains valid, including torn-tail repair", async () => {
  const f = await fixture();
  try {
    await f.store.casMergeRunOutcomes("test", [f.outcome("a")]);
    const journal = f.path + ".attestation-journal", oldJournal = await readFile(journal);
    const compacted = await f.store.casReplaceRunOutcome({ runId: "test", familyCandidateKey: "a", expectedAttemptCount: 1,
      nextOutcome: { ...f.outcome("a"), attemptCount: 2 } as RunOutcome });
    await writeFile(journal, oldJournal);
    assert.equal((await loadCheckpointStatusSnapshot(f.path))?.checkpointFingerprint, compacted.checkpointFingerprint);
    await appendFile(journal, '{"torn":');
    const repaired = await f.store.casMergeRunOutcomes("test", [f.outcome("b")]);
    assert.equal((await loadCheckpointStatusSnapshot(f.path))?.checkpointFingerprint, repaired.checkpointFingerprint);
  } finally { await f.cleanup(); }
});

test("slow private validation cannot hold the source writer lock", async t => {
  const f = await fixture(), open = fs.open;
  let release!: () => void, entered!: () => void, snapshotDirectory = "";
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let pending: ReturnType<typeof loadCheckpointStatusSnapshot> | undefined;
  try {
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
      const path = String(args[0]);
      if (path.includes("mev-checkpoint-status-") && path.endsWith(".attestation-journal")) {
        snapshotDirectory = dirname(path); entered(); await barrier;
      }
      return open(...args);
    });
    syncBuiltinESMExports();
    pending = loadCheckpointStatusSnapshot(f.path);
    await started;
    await assert.rejects(stat(f.path + ".lock"), { code: "ENOENT" });
    await new Promise(resolve => setTimeout(resolve, 40));
    const writer = new UniverseRebuildCheckpointStore({ path: f.path, lockWaitTimeoutMs: 20 });
    const written = await writer.casMergeRunOutcomes("test", [f.outcome("a")]);
    assert.equal(written.inProgressRun!.outcomesByCandidateKey.a!.status, "retryable");
    release(); await pending;
    await assert.rejects(stat(snapshotDirectory), { code: "ENOENT" });
  } finally {
    release(); if (pending) await pending;
    t.mock.restoreAll(); syncBuiltinESMExports(); await f.cleanup();
  }
});

test("mixed bytes from a journal tail repair are rejected and retried with an unchanged base", async t => {
  const f = await fixture(), copy = fs.copyFile;
  let journalCopies = 0;
  try {
    await f.store.casMergeRunOutcomes("test", [f.outcome("a")]);
    const journal = f.path + ".attestation-journal", base = await readFile(f.path);
    await appendFile(journal, '{"torn":');
    t.mock.method(fs, "copyFile", async (...args: Parameters<typeof copy>) => {
      await copy(...args);
      if (args[0] === journal && ++journalCopies === 1) {
        await f.store.casMergeRunOutcomes("test", [f.outcome("b")]);
        // Model a copy spanning the tail truncation/rewrite: an old tail joined
        // to a later newline is complete but cannot pass journal validation.
        await appendFile(args[1], '"mixed-bytes"}\n');
      }
    });
    syncBuiltinESMExports();
    const current = await loadCheckpointStatusSnapshot(f.path);
    assert.equal(journalCopies, 2, "a complete corrupt record cannot be accepted as a prefix");
    assert.deepEqual(Object.keys(current!.inProgressRun!.outcomesByCandidateKey).sort(), ["a", "b"]);
    assert.deepEqual(await readFile(f.path), base, "base stayed unchanged during the journal repair");
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports(); await f.cleanup();
  }
});
