import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UniverseRebuildCheckpointStore } from "../universe-rebuild-checkpoint.js";

const SOURCE = Object.freeze({
  number: 25_750_000,
  hash: "0x" + "a1".repeat(32),
  generation: 1,
});

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "universe-rebuild-stale-"));
  try {
    const path = join(dir, "checkpoint.json");
    const store = new UniverseRebuildCheckpointStore({ path });
    await store.beginOrResumeRun({
      expectedRevision: 0,
      runId: "run-stale",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: "u",
      candidateSetHash: "c",
      candidateCount: 1,
      observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    });
    // Simulate a killed writer: a lock file naming a dead PID. The next
    // CAS must reclaim it (kill -9 leaves the lock behind; the run must
    // not fail forever).
    await writeFile(path + ".lock", "999999999\n", { mode: 0o600 });
    const after = await store.casMergeRunOutcomes("run-stale", Object.freeze([
      Object.freeze({
        status: "retryable",
        familyCandidateKey: "stale:0",
        familyId: "univ2-standard",
        candidateSnapshot: Object.freeze({ address: "0x" + "11".repeat(20) }),
        stage: "identity",
        failureCode: "rpc",
        reasonCode: "rpc",
        attemptCount: 1,
        lastAttemptAt: "2026-08-17T00:00:00.000Z",
      }),
    ]));
    assert.equal(
      after.inProgressRun?.outcomesByCandidateKey["stale:0"]?.status,
      "retryable",
      "a dead holder's stale lock must be reclaimed",
    );
    // A live holder still fails closed.
    await writeFile(path + ".lock", String(process.pid) + "\n", { mode: 0o600 });
    await assert.rejects(
      () => store.casMergeRunOutcomes("run-stale", Object.freeze([
        Object.freeze({
          status: "verified",
          familyCandidateKey: "stale:1",
          familyInstanceKey: "inst:1",
          memoFingerprint: "memo:1",
        }),
      ])),
      /CAS lock is held/,
      "a live holder's lock must fail closed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("universe rebuild stale-lock PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
