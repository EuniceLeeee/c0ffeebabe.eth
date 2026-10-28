import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttestationCheckpointWriter,
  UniverseRebuildCheckpointStore,
  canonicalJson,
  durableVerifiedMemoFingerprint,
  type DurableVerifiedMemo,
  type LegacyDurableVerifiedMemo,
  type DurableSourceReceipt,
  type ReadyUniverseGeneration,
  type RunOutcome,
} from "../universe-rebuild-checkpoint.js";
import {
  hashReadyCatalogSnapshot,
  hashReadyGraphSnapshot,
  hashReadyPublicationSet,
} from "../universe-rebuild-runner.js";

const SOURCE = Object.freeze({
  number: 25_750_000,
  hash: "0x" + "a1".repeat(32),
  generation: 1,
});
const READY_GRAPH = Object.freeze({ edges: Object.freeze([]) });
const READY_CATALOG = Object.freeze({ instances: Object.freeze([]) });

function sourceReceipts(
  fromBlock = SOURCE.number - 14_399,
): readonly DurableSourceReceipt[] {
  return Object.freeze([Object.freeze({
    sourceKey: "1".repeat(64),
    sourceKind: "startup-candidate-union" as const,
    providerIdentity: "fixture",
    queryFingerprint: "2".repeat(64),
    fromBlock,
    toBlock: SOURCE.number,
    cutoffNumber: SOURCE.number,
    cutoffHash: SOURCE.hash,
    coverageKeys: Object.freeze(["univ2|startup-universe"]),
    completedChunks: Object.freeze([Object.freeze({
      fromBlock,
      toBlock: SOURCE.number,
      resultCount: 2,
      resultHash: "3".repeat(64),
    })]),
    observationSetHash: "4".repeat(64),
    observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    appliedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    retryableCount: 0 as const,
    status: "complete" as const,
  })]);
}

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
    candidateSnapshot: Object.freeze({ id: key }),
    memoFingerprint: fp,
  });
}

function terminalFor(key: string): RunOutcome {
  return Object.freeze({
    status: "terminal-rejected",
    familyCandidateKey: key,
    reasonCode: "identity_rejected:fixture",
    familyDefinitionHash: "fdh",
    requestFingerprint: "request",
    trustedResultsFingerprint: "results",
    authorityFingerprint: "auth",
    candidateFingerprint: "cf-" + key,
    cutoff: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
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
      candidatesByKey: Object.freeze({ a: Object.freeze({ id: "a" }), b: Object.freeze({ id: "b" }) }),
      observedThrough: Object.freeze({
        number: SOURCE.number,
        hash: SOURCE.hash,
      }),
      sourceReceipts: sourceReceipts(),
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
      candidatesByKey: Object.freeze({ a: Object.freeze({ id: "a" }), b: Object.freeze({ id: "b" }) }),
      observedThrough: Object.freeze({
        number: SOURCE.number,
        hash: SOURCE.hash,
      }),
      sourceReceipts: sourceReceipts(),
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
        candidatesByKey: Object.freeze({ a: Object.freeze({ id: "a" }), b: Object.freeze({ id: "b" }) }),
        observedThrough: Object.freeze({
          number: SOURCE.number,
          hash: SOURCE.hash,
        }),
        sourceReceipts: sourceReceipts(),
      }),
      /different fixed input/,
      "same runId must not attach a different cutoff/candidate partition",
    );

    // reconcileFixedRunPlan: discovery plan change reconciles the SAME run's
    // partition/receipts; runId/cutoff/fromBlock/observedThrough are immutable.
    // Self-contained store so discovery-plan reconciliation is isolated.
    const recStore = new UniverseRebuildCheckpointStore({
      path: join(dir, "reconcile.json"),
    });
    await recStore.beginOrResumeRun({
      expectedRevision: 0,
      runId: "run-1",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: "u1",
      candidateSetHash: "c1",
      candidateCount: 2,
      candidatesByKey: Object.freeze({
        a: Object.freeze({ id: "a" }),
        b: Object.freeze({ id: "b" }),
      }),
      observedThrough: Object.freeze({
        number: SOURCE.number,
        hash: SOURCE.hash,
      }),
      sourceReceipts: sourceReceipts(),
    });
    const reconciles = await recStore.reconcileFixedRunPlan({
      expectedRevision: 2,
      runId: "run-1",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: "u-reconciled",
      candidateSetHash: "c-reconciled",
      candidateCount: 3,
      candidatesByKey: Object.freeze({
        a: Object.freeze({ id: "a" }),
        b: Object.freeze({ id: "b" }),
        d: Object.freeze({ id: "d" }),
      }),
      observedThrough: Object.freeze({
        number: SOURCE.number,
        hash: SOURCE.hash,
      }),
      sourceReceipts: sourceReceipts(),
    });
    assert.equal(reconciles.revision, 3);
    assert.equal(reconciles.inProgressRun?.runId, "run-1");
    assert.equal(reconciles.inProgressRun?.cutoff?.number, SOURCE.number);
    assert.equal(reconciles.inProgressRun?.fromBlock, SOURCE.number - 14_399);
    assert.equal(reconciles.inProgressRun?.candidateCount, 3);
    assert.equal(reconciles.inProgressRun?.candidateSetHash, "c-reconciled");
    // A different cutoff / fromBlock / runId is refused: the fixed range is
    // the run's identity.
    await assert.rejects(
      () => recStore.reconcileFixedRunPlan({
        expectedRevision: reconciles.revision,
        runId: "run-1",
        cutoff: Object.freeze({
          number: SOURCE.number + 1,
          hash: SOURCE.hash,
          generation: 1,
        }),
        fromBlock: SOURCE.number - 14_399,
        universeHash: "u2",
        candidateSetHash: "c2",
        candidateCount: 1,
        candidatesByKey: Object.freeze({ a: Object.freeze({ id: "a" }) }),
        observedThrough: Object.freeze({
          number: SOURCE.number,
          hash: SOURCE.hash,
        }),
        sourceReceipts: sourceReceipts(),
      }),
      /cannot change the fixed run range/,
      "reconcile must not move the cutoff",
    );
    await assert.rejects(
      () => recStore.reconcileFixedRunPlan({
        expectedRevision: reconciles.revision,
        runId: "run-1",
        cutoff: SOURCE,
        fromBlock: SOURCE.number - 14_398,
        universeHash: "u2",
        candidateSetHash: "c2",
        candidateCount: 1,
        candidatesByKey: Object.freeze({ a: Object.freeze({ id: "a" }) }),
        observedThrough: Object.freeze({
          number: SOURCE.number,
          hash: SOURCE.hash,
        }),
        sourceReceipts: sourceReceipts(SOURCE.number - 14_398),
      }),
      /cannot change the fixed run range/,
      "reconcile must not move fromBlock",
    );
    await assert.rejects(
      () => recStore.reconcileFixedRunPlan({
        expectedRevision: reconciles.revision,
        runId: "run-other",
        cutoff: SOURCE,
        fromBlock: SOURCE.number - 14_399,
        universeHash: "u2",
        candidateSetHash: "c2",
        candidateCount: 1,
        candidatesByKey: Object.freeze({ a: Object.freeze({ id: "a" }) }),
        observedThrough: Object.freeze({
          number: SOURCE.number,
          hash: SOURCE.hash,
        }),
        sourceReceipts: sourceReceipts(),
      }),
      /reconcile run id mismatch/,
      "reconcile must refuse a different runId",
    );
    // Reconcile drops outcomes for candidates absent from the new partition.
    const recWithOutcomes = await recStore.casMergeAttestationWrites(
      "run-1",
      Object.freeze([
        Object.freeze({
          outcome: Object.freeze({
            status: "verified",
            familyCandidateKey: "b",
            familyInstanceKey: "inst-b",
            memoFingerprint: "fp-b",
          }) as RunOutcome,
          memo: memoFor("b"),
        }),
        Object.freeze({
          outcome: Object.freeze({
            status: "terminal-rejected",
            familyCandidateKey: "x",
            reasonCode: "identity_rejected:fixture",
            familyDefinitionHash: "fdh",
            requestFingerprint: "req",
            trustedResultsFingerprint: "res",
            authorityFingerprint: "auth",
            candidateFingerprint: "cf",
            cutoff: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
          }) as RunOutcome,
        }),
      ]),
    );
    assert.equal(
      recWithOutcomes.inProgressRun?.outcomesByCandidateKey["b"]?.status,
      "verified",
    );
    assert.equal(
      recWithOutcomes.inProgressRun?.outcomesByCandidateKey["x"]?.status,
      "terminal-rejected",
    );
    const rec2 = await recStore.reconcileFixedRunPlan({
      expectedRevision: recWithOutcomes.revision,
      runId: "run-1",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: "u-reconciled-2",
      candidateSetHash: "c-reconciled-2",
      candidateCount: 2,
      candidatesByKey: Object.freeze({
        a: Object.freeze({ id: "a" }),
        b: Object.freeze({ id: "b" }),
      }),
      observedThrough: Object.freeze({
        number: SOURCE.number,
        hash: SOURCE.hash,
      }),
      sourceReceipts: sourceReceipts(),
    });
    assert.equal(
      rec2.inProgressRun?.outcomesByCandidateKey["b"]?.status,
      "verified",
      "outcomes bound to the new partition are kept",
    );
    assert.equal(
      rec2.inProgressRun?.outcomesByCandidateKey["x"],
      undefined,
      "outcomes for dropped candidates are not verification authority",
    );
    // Reconcile keeps verified memos (the reuse table is never cleared).
    const withRecMemo = await recStore.casUpsertMemo(memoFor("a"));
    const rec3 = await recStore.reconcileFixedRunPlan({
      expectedRevision: withRecMemo.revision,
      runId: "run-1",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: "u-reconciled-3",
      candidateSetHash: "c-reconciled-3",
      candidateCount: 2,
      candidatesByKey: Object.freeze({
        a: Object.freeze({ id: "a" }),
        b: Object.freeze({ id: "b" }),
      }),
      observedThrough: Object.freeze({
        number: SOURCE.number,
        hash: SOURCE.hash,
      }),
      sourceReceipts: sourceReceipts(),
    });
    assert.notEqual(
      rec3.verifiedMemos["a"],
      undefined,
      "verifiedMemos survive reconcile",
    );
    assert.equal(rec3.verifiedMemos["a"]?.memoFingerprint, "fp-a");

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
        candidatesByKey: Object.freeze({ a: Object.freeze({ id: "a" }), b: Object.freeze({ id: "b" }) }),
        observedThrough: Object.freeze({
          number: SOURCE.number,
          hash: SOURCE.hash,
        }),
        sourceReceipts: sourceReceipts(),
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
    assert.match(
      await readFile(path + ".attestation-journal", "utf8"),
      /"version":1/,
      "attestation batches persist as an fsynced delta instead of rewriting the base",
    );
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).revision,
      2,
      "an attestation delta must not rewrite the large base checkpoint",
    );
    // A fresh process reads top-level fields incrementally and replays the
    // journal. Seven-byte chunks split field names, escapes and values.
    const tinyChunkStore = new UniverseRebuildCheckpointStore({
      path,
      readChunkBytes: 7,
    });
    const loaded = await tinyChunkStore.load();
    assert.equal(loaded?.revision, merged.revision);
    assert.equal(loaded?.inProgressRun?.outcomesByCandidateKey["a"]?.status, "verified");
    // A killed append can leave one unterminated suffix. It is uncommitted,
    // so recovery ignores it; the next non-journal CAS compacts only the
    // fingerprint-verified complete records.
    await appendFile(path + ".attestation-journal", "{\"version\":");
    assert.equal(
      (await new UniverseRebuildCheckpointStore({
        path,
        readChunkBytes: 5,
      }).load())?.revision,
      merged.revision,
    );

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
    await assert.rejects(
      () => readFile(path + ".attestation-journal", "utf8"),
      (error: unknown) => (error as { code?: string }).code === "ENOENT",
      "a non-attestation CAS must compact and remove the included journal",
    );

    // Memo upsert.
    const withMemo = await store.casUpsertMemo(memoFor("a"));
    const readyGeneration = Object.freeze({
      generation: 1,
      cutoff: SOURCE,
      universeRange: Object.freeze({
        fromBlock: SOURCE.number - 14_399,
        toBlock: SOURCE.number,
      }),
      universeHash: "u1",
      catalogHash: hashReadyCatalogSnapshot(READY_CATALOG),
      activeInstanceKeys: Object.freeze(["inst-a", "inst-b"]),
      publicationSetHash: hashReadyPublicationSet(READY_CATALOG),
      candidateAccounting: Object.freeze({
        total: 2,
        verified: 2,
        terminalRejected: 0,
        retryable: 0,
        remainingUnaccounted: 0 as const,
      }),
      observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
      appliedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
      sourceCoverage: Object.freeze([Object.freeze({ familyId: "univ2", sourceId: "startup-universe", completeThroughBlock: SOURCE.number, completeThroughHash: SOURCE.hash })]),
      graphSnapshot: READY_GRAPH,
      graphHash: hashReadyGraphSnapshot(READY_GRAPH),
      catalogSnapshot: READY_CATALOG,
    }) as ReadyUniverseGeneration;

    const partialReceipt = sourceReceipts()[0]!;
    const partialStore = new UniverseRebuildCheckpointStore({
      path: join(dir, "partial-source.json"),
    });
    await assert.rejects(
      () => partialStore.beginOrResumeRun({
        expectedRevision: 0,
        runId: "run-1",
        cutoff: SOURCE,
        fromBlock: SOURCE.number - 14_399,
        universeHash: "partial",
        candidateSetHash: "partial",
        candidateCount: 0,
        candidatesByKey: Object.freeze({}),
        observedThrough: Object.freeze({
          number: SOURCE.number,
          hash: SOURCE.hash,
        }),
        sourceReceipts: Object.freeze([Object.freeze({
          ...partialReceipt,
          completedChunks: Object.freeze([Object.freeze({
            ...partialReceipt.completedChunks[0]!,
            toBlock: SOURCE.number - 1,
          })]),
        })]),
      }),
      /do not cover exact range/,
      "a partial source query cannot create an in-progress run",
    );
    const currentRevision = withMemo.revision;

    // Ready commit with a stale revision fails closed.
    await assert.rejects(
      () => store.casCommitReadyGeneration({
        expectedRevision: 1,
        runId: "run-1",
        ready: readyGeneration,
      }),
      /CAS conflict/,
    );
    await assert.rejects(
      () => store.casCommitReadyGeneration({
        expectedRevision: currentRevision,
        runId: "run-1",
        ready: Object.freeze({
          ...readyGeneration,
          publicationSetHash: "tampered",
        }),
      }),
      /not bound to completed run/,
      "Graph/catalog/publication roots must be checked inside the ready CAS",
    );
    const ready = await store.casCommitReadyGeneration({
      expectedRevision: currentRevision,
      runId: "run-1",
      ready: readyGeneration,
    });
    assert.equal(
      ready.inProgressRun,
      null,
      "a fully accounted run must clear after atomic ready promotion",
    );
    assert.equal(
      Object.keys(ready.retryableAttemptsByCandidateKey).length,
      0,
    );
    assert.equal(ready.readyGeneration?.generation, 1);
    assert.equal(ready.verifiedMemos["a"]?.familyInstanceKey, "inst-a");
    // Reload after ready: fingerprint still verifies.
    assert.equal((await store.load())?.readyGeneration?.generation, 1);

    // A deployed pre-queue envelope keeps its legacy fingerprint on disk.
    // Loading normalizes an empty queue; the next CAS rewrites the new sealed
    // shape without requiring a checkpoint reset.
    const legacyPath = join(dir, "legacy-envelope.json");
    const legacyProjection = Object.freeze({
      revision: 2,
      verifiedMemos: Object.freeze({}),
      inProgressRun: null,
      readyGeneration: null,
    });
    const legacyFingerprint = createHash("sha256")
      .update(canonicalJson(legacyProjection))
      .digest("hex");
    await writeFile(
      legacyPath,
      JSON.stringify({
        ...legacyProjection,
        checkpointFingerprint: legacyFingerprint,
      }) + "\n",
      { mode: 0o600 },
    );
    const legacyStore = new UniverseRebuildCheckpointStore({ path: legacyPath });
    assert.deepEqual(
      (await legacyStore.load())?.retryableAttemptsByCandidateKey,
      {},
    );
    await legacyStore.casUpsertMemo(memoFor("legacy"));
    assert.match(
      await readFile(legacyPath, "utf8"),
      /"retryableAttemptsByCandidateKey":\{\}/,
    );

    // Deployed pre-snapshot memos upgrade atomically. The old fingerprint is
    // verified first; the new fingerprint includes candidateSnapshot.
    const memoMigrationPath = join(dir, "legacy-memo.json");
    const currentMemo = memoFor("migrate");
    const {
      candidateSnapshot: _candidateSnapshot,
      memoFingerprint: _memoFingerprint,
      ...legacyMemoFields
    } = currentMemo;
    const legacyMemoUnsigned = Object.freeze({
      ...legacyMemoFields,
      memoFingerprint: "",
    }) as LegacyDurableVerifiedMemo;
    const legacyMemo = Object.freeze({
      ...legacyMemoUnsigned,
      memoFingerprint: durableVerifiedMemoFingerprint(legacyMemoUnsigned),
    });
    const memoMigrationProjection = Object.freeze({
      revision: 1,
      verifiedMemos: Object.freeze({ migrate: legacyMemo }),
      inProgressRun: Object.freeze({
        runId: "memo-migration-run",
        cutoff: SOURCE,
        fromBlock: SOURCE.number - 14_399,
        universeHash: "memo-migration-universe",
        candidateSetHash: "memo-migration-candidates",
        candidateCount: 1,
        candidatesByKey: Object.freeze({
          migrate: Object.freeze({ id: "migrate" }),
        }),
        observedThrough: Object.freeze({
          number: SOURCE.number,
          hash: SOURCE.hash,
        }),
        sourceReceipts: sourceReceipts(),
        appliedThrough: null,
        outcomesByCandidateKey: Object.freeze({
          migrate: Object.freeze({
            status: "verified" as const,
            familyCandidateKey: "migrate",
            familyInstanceKey: legacyMemo.familyInstanceKey,
            memoFingerprint: legacyMemo.memoFingerprint,
          }),
        }),
      }),
      retryableAttemptsByCandidateKey: Object.freeze({}),
      readyGeneration: null,
    });
    await writeFile(memoMigrationPath, JSON.stringify({
      ...memoMigrationProjection,
      checkpointFingerprint: createHash("sha256")
        .update(canonicalJson(memoMigrationProjection))
        .digest("hex"),
    }) + "\n");
    const memoMigrationStore = new UniverseRebuildCheckpointStore({
      path: memoMigrationPath,
    });
    const upgradedUnsigned = Object.freeze({
      ...legacyMemo,
      candidateSnapshot: Object.freeze({ id: "migrate" }),
      memoFingerprint: "",
    }) as DurableVerifiedMemo;
    const upgradedMemo = Object.freeze({
      ...upgradedUnsigned,
      memoFingerprint: durableVerifiedMemoFingerprint(upgradedUnsigned),
    });
    const upgradedEnvelope = await memoMigrationStore
      .casUpgradeLegacyVerifiedMemos({
        expectedRevision: 1,
        upgrades: Object.freeze({ migrate: upgradedMemo }),
      });
    assert.deepEqual(
      upgradedEnvelope.verifiedMemos.migrate?.candidateSnapshot,
      { id: "migrate" },
    );
    assert.notEqual(
      upgradedEnvelope.verifiedMemos.migrate?.memoFingerprint,
      legacyMemo.memoFingerprint,
    );
    assert.equal(
      upgradedEnvelope.inProgressRun?.outcomesByCandidateKey.migrate
        ?.status === "verified"
        ? upgradedEnvelope.inProgressRun.outcomesByCandidateKey.migrate
          .memoFingerprint
        : null,
      upgradedMemo.memoFingerprint,
      "memo and incumbent verified outcome fingerprints upgrade in one CAS",
    );

    const preReceiptPath = join(dir, "pre-receipt-run.json");
    const preReceiptProjection = Object.freeze({
      revision: 1,
      verifiedMemos: Object.freeze({}),
      inProgressRun: Object.freeze({
        runId: "old-run",
        cutoff: SOURCE,
        fromBlock: SOURCE.number - 14_399,
        universeHash: "old",
        candidateSetHash: "old",
        candidateCount: 0,
        candidatesByKey: Object.freeze({}),
        observedThrough: Object.freeze({
          number: SOURCE.number,
          hash: SOURCE.hash,
        }),
        appliedThrough: null,
        outcomesByCandidateKey: Object.freeze({}),
      }),
      retryableAttemptsByCandidateKey: Object.freeze({}),
      readyGeneration: null,
    });
    await writeFile(preReceiptPath, JSON.stringify({
      ...preReceiptProjection,
      checkpointFingerprint: createHash("sha256")
        .update(canonicalJson(preReceiptProjection))
        .digest("hex"),
    }) + "\n");
    await assert.rejects(
      () => new UniverseRebuildCheckpointStore({ path: preReceiptPath }).load(),
      /in-progress run source receipts are absent/,
      "pre-receipt fixed runs are no longer migrated or trusted",
    );

    // Every path that makes a candidate terminal revokes its retained memo in
    // the same CAS, including the independent retry queue.
    const terminalStore = new UniverseRebuildCheckpointStore({
      path: join(dir, "terminal-memo.json"),
    });
    await terminalStore.beginOrResumeRun({
      expectedRevision: 0,
      runId: "terminal-run",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: "terminal",
      candidateSetHash: "terminal",
      candidateCount: 1,
      candidatesByKey: Object.freeze({ t: Object.freeze({ id: "t" }) }),
      observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
      sourceReceipts: sourceReceipts(),
    });
    await terminalStore.casMergeAttestationWrites(
      "terminal-run",
      Object.freeze([Object.freeze({
        outcome: Object.freeze({
          status: "verified",
          familyCandidateKey: "t",
          familyInstanceKey: "inst-t",
          memoFingerprint: "fp-t",
        }),
        memo: memoFor("t"),
      })]),
    );
    const batchTerminal = await terminalStore.casMergeRunOutcomes(
      "terminal-run",
      Object.freeze([terminalFor("t")]),
    );
    assert.equal(batchTerminal.verifiedMemos.t, undefined);

    const runProbeStore = new UniverseRebuildCheckpointStore({
      path: join(dir, "run-probe-terminal-memo.json"),
    });
    await runProbeStore.beginOrResumeRun({
      expectedRevision: 0,
      runId: "probe-run",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: "probe",
      candidateSetHash: "probe",
      candidateCount: 1,
      candidatesByKey: Object.freeze({ r: Object.freeze({ id: "r" }) }),
      observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
      sourceReceipts: sourceReceipts(),
    });
    await runProbeStore.casUpsertMemo(memoFor("r"));
    await runProbeStore.casMergeRunOutcomes("probe-run", Object.freeze([
      Object.freeze({
        status: "retryable",
        familyCandidateKey: "r",
        familyId: "univ2",
        candidateSnapshot: Object.freeze({ id: "r" }),
        stage: "identity",
        failureCode: "rpc",
        reasonCode: "rpc",
        attemptCount: 1,
        lastAttemptAt: "2026-08-24T00:00:00.000Z",
      }),
    ]));
    const runProbeTerminal = await runProbeStore.casReplaceRunOutcome({
      runId: "probe-run",
      familyCandidateKey: "r",
      expectedAttemptCount: 1,
      nextOutcome: terminalFor("r"),
    });
    assert.equal(runProbeTerminal.verifiedMemos.r, undefined);

    const queuedPath = join(dir, "queued-terminal-memo.json");
    const queuedProjection = Object.freeze({
      revision: 1,
      verifiedMemos: Object.freeze({ q: memoFor("q") }),
      inProgressRun: null,
      retryableAttemptsByCandidateKey: Object.freeze({
        q: Object.freeze({
          status: "retryable" as const,
          familyCandidateKey: "q",
          familyId: "univ2",
          candidateSnapshot: Object.freeze({ id: "q" }),
          stage: "identity" as const,
          failureCode: "rpc" as const,
          reasonCode: "rpc",
          attemptCount: 1,
          lastAttemptAt: "2026-08-24T00:00:00.000Z",
          runId: "queued-run",
          cutoff: SOURCE,
        }),
      }),
      readyGeneration: null,
    });
    await writeFile(queuedPath, JSON.stringify({
      ...queuedProjection,
      checkpointFingerprint: createHash("sha256")
        .update(canonicalJson(queuedProjection))
        .digest("hex"),
    }) + "\n");
    const queuedTerminal = await new UniverseRebuildCheckpointStore({
      path: queuedPath,
    }).casReplaceQueuedRetryable({
      runId: "queued-run",
      familyCandidateKey: "q",
      expectedAttemptCount: 1,
      nextOutcome: terminalFor("q"),
    });
    assert.equal(queuedTerminal.verifiedMemos.q, undefined);
    assert.equal(queuedTerminal.retryableAttemptsByCandidateKey.q, undefined);

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

    const corruptJournalPath = join(dir, "corrupt-journal.json");
    const corruptJournalStore = new UniverseRebuildCheckpointStore({
      path: corruptJournalPath,
    });
    await corruptJournalStore.beginOrResumeRun({
      expectedRevision: 0,
      runId: "journal-run",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: "journal",
      candidateSetHash: "journal",
      candidateCount: 1,
      candidatesByKey: Object.freeze({ j: Object.freeze({ id: "j" }) }),
      observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
      sourceReceipts: sourceReceipts(),
    });
    await corruptJournalStore.casMergeRunOutcomes(
      "journal-run",
      Object.freeze([terminalFor("j")]),
    );
    const journalPath = corruptJournalPath + ".attestation-journal";
    await writeFile(
      journalPath,
      (await readFile(journalPath, "utf8")).replace(
        /"reasonCode":"identity_rejected:fixture"/,
        '"reasonCode":"tampered"',
      ),
    );
    await assert.rejects(
      () => new UniverseRebuildCheckpointStore({
        path: corruptJournalPath,
      }).load(),
      /journal fingerprint mismatch/,
      "a complete tampered delta must fail closed",
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
      candidatesByKey: Object.freeze(Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [
          "k" + index,
          Object.freeze({ id: "k" + index }),
        ]),
      )),
      observedThrough: Object.freeze({
        number: SOURCE.number,
        hash: SOURCE.hash,
      }),
      sourceReceipts: sourceReceipts(),
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
    let afterBatch = await writerStore.load();
    const batchDeadline = Date.now() + 5_000;
    while (
      Object.keys(afterBatch?.inProgressRun?.outcomesByCandidateKey ?? {})
        .length < 25 &&
      Date.now() < batchDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      afterBatch = await writerStore.load();
    }
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
