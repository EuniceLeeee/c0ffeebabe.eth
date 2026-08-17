import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttestationCheckpointWriter,
  UniverseRebuildCheckpointStore,
  type DurableVerifiedMemo,
  type ReadyUniverseGeneration,
  type RunOutcome,
} from "../universe-rebuild-checkpoint.js";

const SOURCE = Object.freeze({
  number: 25_750_000,
  hash: "0x" + "a1".repeat(32),
  generation: 1,
});

function memoFor(key: string): DurableVerifiedMemo {
  const fp = "fp-" + key;
  return Object.freeze({
    familyCandidateKey: key,
    familyInstanceKey: "inst-" + key,
    familyId: "univ2",
    candidateKey: key,
    instanceKey: "inst-" + key,
    candidateFingerprint: "cf-" + key,
    familyDefinitionHash: "fdh",
    validity: Object.freeze({
      policy: "immutable-code",
      authorityFingerprint: "auth",
      proofSource: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    }),
    verifiedIdentity: Object.freeze({ kind: "identity", key }),
    compiledDescriptor: Object.freeze({ kind: "descriptor", key }),
    staticProjection: Object.freeze({ kind: "projection", key }),
    evidenceFingerprint: "ef-" + key,
    memoFingerprint: fp,
  });
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "universe-rebuild-ckpt-"));
  const path = join(dir, "checkpoint.json");
  try {
    const store = new UniverseRebuildCheckpointStore({ path });
    assert.equal(await store.load(), null, "fresh store has no envelope");

    // beginOrResumeRun creates the fixed-cutoff run.
    const begun = await store.beginOrResumeRun({
      expectedRevision: 0,
      runId: "run-1",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: "u1",
      candidateSetHash: "c1",
      candidateCount: 2,
      observedThrough: Object.freeze({
        number: SOURCE.number,
        hash: SOURCE.hash,
      }),
    });
    assert.equal(begun.revision, 2);
    assert.equal(begun.inProgressRun?.runId, "run-1");
    // Resuming the same run id is a no-op (same revision).
    const resumed = await store.beginOrResumeRun({
      expectedRevision: 2,
      runId: "run-1",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: "u1",
      candidateSetHash: "c1",
      candidateCount: 2,
      observedThrough: Object.freeze({
        number: SOURCE.number,
        hash: SOURCE.hash,
      }),
    });
    assert.equal(resumed.revision, 2, "resume of the same run must not bump");
    await assert.rejects(
      () => store.beginOrResumeRun({
        expectedRevision: 2,
        runId: "run-1",
        cutoff: SOURCE,
        fromBlock: SOURCE.number - 14_399,
        universeHash: "u-drifted",
        candidateSetHash: "c-drifted",
        candidateCount: 2,
        observedThrough: Object.freeze({
          number: SOURCE.number,
          hash: SOURCE.hash,
        }),
      }),
      /different fixed input/,
      "same runId must not attach a different cutoff/candidate partition",
    );
    // A different run id while one is in progress fails closed.
    await assert.rejects(
      () => store.beginOrResumeRun({
        expectedRevision: 2,
        runId: "run-2",
        cutoff: SOURCE,
        fromBlock: SOURCE.number - 14_399,
        universeHash: "u1",
        candidateSetHash: "c1",
        candidateCount: 2,
        observedThrough: Object.freeze({
          number: SOURCE.number,
          hash: SOURCE.hash,
        }),
      }),
      /another run is in progress/,
    );
    await assert.rejects(
      () => store.casMergeRunOutcomes("run-1", Object.freeze([
        Object.freeze({
          status: "verified",
          familyCandidateKey: "orphan",
          familyInstanceKey: "inst-orphan",
          memoFingerprint: "fp-orphan",
        }) as RunOutcome,
      ])),
      /verified outcome has no memo/,
      "a verified cursor/outcome must never lead its durable memo",
    );

    // Merge outcomes; verified + retryable land per candidate key.
    const merged = await store.casMergeAttestationWrites("run-1", Object.freeze([
      Object.freeze({ outcome: Object.freeze({
        status: "verified",
        familyCandidateKey: "a",
        familyInstanceKey: "inst-a",
        memoFingerprint: "fp-a",
      }) as RunOutcome, memo: memoFor("a") }),
      Object.freeze({ outcome: Object.freeze({
        status: "retryable",
        familyCandidateKey: "b",
        familyId: "univ2",
        candidateSnapshot: Object.freeze({ addr: "0xbb" }),
        evidenceRef: Object.freeze({
          blockNumber: SOURCE.number,
          blockHash: SOURCE.hash,
          txHash: "0x" + "c1".repeat(32),
          logIndex: 3,
        }),
        stage: "identity",
        failureCode: "rpc",
        reasonCode: "factory-child-reverse-binding:rpc",
        attemptCount: 1,
        lastAttemptAt: "2026-08-17T00:00:00.000Z",
      }) as RunOutcome }),
    ]));
    assert.equal(merged.inProgressRun?.outcomesByCandidateKey["a"]?.status, "verified");
    assert.equal(
      (merged.inProgressRun?.outcomesByCandidateKey["b"] as { attemptCount: number }).attemptCount,
      1,
    );
    // Reload verifies the fingerprint (round-trip intact).
    const loaded = await store.load();
    assert.equal(loaded?.revision, merged.revision);
    assert.equal(loaded?.inProgressRun?.outcomesByCandidateKey["a"]?.status, "verified");

    // Probe CAS guard: wrong attempt count fails closed.
    await assert.rejects(
      () => store.casReplaceRunOutcome({
        runId: "run-1",
        familyCandidateKey: "b",
        expectedAttemptCount: 2,
        nextOutcome: Object.freeze({
          status: "retryable",
          familyCandidateKey: "b",
          familyId: "univ2",
          candidateSnapshot: Object.freeze({ addr: "0xbb" }),
          stage: "identity",
          failureCode: "rpc",
          reasonCode: "rpc",
          attemptCount: 2,
          lastAttemptAt: "2026-08-17T00:00:01.000Z",
        }) as RunOutcome,
      }),
      /probe CAS conflict/,
    );
    const replaced = await store.casReplaceRunOutcome({
      runId: "run-1",
      familyCandidateKey: "b",
      expectedAttemptCount: 1,
      nextOutcome: Object.freeze({
        status: "verified",
        familyCandidateKey: "b",
        familyInstanceKey: "inst-b",
        memoFingerprint: "fp-b",
      }) as RunOutcome,
      memo: memoFor("b"),
    });
    assert.equal(replaced.inProgressRun?.outcomesByCandidateKey["b"]?.status, "verified");

    // Memo upsert.
    const withMemo = await store.casUpsertMemo(memoFor("a"));
    const currentRevision = withMemo.revision;

    // Ready commit with a stale revision fails closed.
    await assert.rejects(
      () => store.casCommitReadyGeneration({
        expectedRevision: 1,
        runId: "run-1",
        ready: Object.freeze({
          generation: 1,
          cutoff: SOURCE,
          universeHash: "u1",
          catalogHash: "cat",
          activeInstanceKeys: Object.freeze(["inst-a", "inst-b"]),
          publicationSetHash: "ps",
          observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
          appliedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
          sourceCoverage: Object.freeze([]),
          graphSnapshot: Object.freeze({ edges: Object.freeze([]) }),
          graphHash: "g1",
          catalogSnapshot: Object.freeze({ instances: Object.freeze([]) }),
        }) as ReadyUniverseGeneration,
      }),
      /CAS conflict/,
    );
    const ready = await store.casCommitReadyGeneration({
      expectedRevision: currentRevision,
      runId: "run-1",
      ready: Object.freeze({
        generation: 1,
        cutoff: SOURCE,
        universeHash: "u1",
        catalogHash: "cat",
        activeInstanceKeys: Object.freeze(["inst-a", "inst-b"]),
        publicationSetHash: "ps",
        observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
        appliedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
        sourceCoverage: Object.freeze([]),
        graphSnapshot: Object.freeze({ edges: Object.freeze([]) }),
        graphHash: "g1",
        catalogSnapshot: Object.freeze({ instances: Object.freeze([]) }),
      }) as ReadyUniverseGeneration,
    });
    assert.equal(ready.inProgressRun, null);
    assert.equal(ready.readyGeneration?.generation, 1);
    assert.equal(ready.verifiedMemos["a"]?.familyInstanceKey, "inst-a");
    // Reload after ready: fingerprint still verifies.
    assert.equal((await store.load())?.readyGeneration?.generation, 1);

    // Corruption fails closed.
    const corruptPath = join(dir, "corrupt.json");
    const corruptStore = new UniverseRebuildCheckpointStore({ path: corruptPath });
    await writeFile(corruptPath, "{not-json\n", { mode: 0o600 });
    await assert.rejects(
      () => corruptStore.load(),
      /not valid JSON/,
    );
    await writeFile(
      corruptPath,
      "{\"revision\":2,\"verifiedMemos\":{},\"inProgressRun\":null,\"readyGeneration\":null,\"checkpointFingerprint\":\"" +
        "0".repeat(64) + "\"}\n",
      { mode: 0o600 },
    );
    await assert.rejects(
      () => corruptStore.load(),
      /fingerprint mismatch/,
    );

    // Writer batching: 25 outcomes flush automatically on the batch boundary.
    const writerPath = join(dir, "writer.json");
    const writerStore = new UniverseRebuildCheckpointStore({ path: writerPath });
    await writerStore.beginOrResumeRun({
      expectedRevision: 0,
      runId: "run-w",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: "u1",
      candidateSetHash: "c1",
      candidateCount: 30,
      observedThrough: Object.freeze({
        number: SOURCE.number,
        hash: SOURCE.hash,
      }),
    });
    const writer = new AttestationCheckpointWriter({
      store: writerStore,
      runId: "run-w",
      maxIntervalMs: 60_000,
    });
    for (let i = 0; i < 25; i++) {
      writer.record(Object.freeze({
        status: "verified",
        familyCandidateKey: "k" + i,
        familyInstanceKey: "inst-k" + i,
        memoFingerprint: "fp-k" + i,
      }) as RunOutcome, memoFor("k" + i));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterBatch = await writerStore.load();
    assert.equal(
      Object.keys(afterBatch?.inProgressRun?.outcomesByCandidateKey ?? {}).length,
      25,
      "batch boundary must flush 25 outcomes",
    );
    writer.record(Object.freeze({
      status: "verified",
      familyCandidateKey: "k25",
      familyInstanceKey: "inst-k25",
      memoFingerprint: "fp-k25",
    }) as RunOutcome, memoFor("k25"));
    await writer.flush();
    const afterFlush = await writerStore.load();
    assert.equal(
      Object.keys(afterFlush?.inProgressRun?.outcomesByCandidateKey ?? {}).length,
      26,
      "explicit flush must persist pending outcomes",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("universe rebuild checkpoint PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
