import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  UniverseRebuildCheckpointStore,
  type DurableSourceReceipt,
  type DurableVerifiedMemo,
  type ReadyUniverseGeneration,
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

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "universe-rebuild-cli-"));
  try {
    const checkpoint = join(dir, "checkpoint.json");
    const store = new UniverseRebuildCheckpointStore({ path: checkpoint });
    const fromBlock = SOURCE.number - 14_399;
    const receipts = Object.freeze([Object.freeze({
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
        resultCount: 3,
        resultHash: "3".repeat(64),
      })]),
      observationSetHash: "4".repeat(64),
      observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
      appliedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
      retryableCount: 0 as const,
      status: "complete" as const,
    })]) satisfies readonly DurableSourceReceipt[];
    await store.beginOrResumeRun({
      expectedRevision: 0,
      runId: "run-1",
      cutoff: SOURCE,
      fromBlock,
      universeHash: "u1",
      candidateSetHash: "c1",
      candidateCount: 3,
      candidatesByKey: Object.freeze({
        "cand:a": Object.freeze({ address: "0x" + "11".repeat(20) }),
        "cand:b": Object.freeze({ address: "0x" + "22".repeat(20) }),
        "cand:c": Object.freeze({ address: "0x" + "33".repeat(20) }),
      }),
      observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
      sourceReceipts: receipts,
    });
    const withReceipts = await store.casMergeRunOutcomes(
      "run-1",
      Object.freeze(["a", "b", "c"].map((suffix, index) => Object.freeze({
        status: "retryable" as const,
        familyCandidateKey: `cand:${suffix}`,
        familyId: "univ2",
        candidateSnapshot: Object.freeze({
          address: "0x" + String(index + 1).repeat(40),
        }),
        stage: "identity" as const,
        failureCode: "rpc",
        reasonCode: "factory-child-reverse-binding:rpc",
        attemptCount: 1,
        lastAttemptAt: "2026-08-17T00:00:00.000Z",
      }))),
    );
    const graphSnapshot = Object.freeze({ edges: Object.freeze([]) });
    const catalogSnapshot = Object.freeze({ instances: Object.freeze([]) });
    await store.casCommitReadyGeneration({
      expectedRevision: withReceipts.revision,
      runId: "run-1",
      ready: Object.freeze({
        generation: 1,
        cutoff: SOURCE,
        universeRange: Object.freeze({ fromBlock, toBlock: SOURCE.number }),
        universeHash: "u1",
        catalogHash: hashReadyCatalogSnapshot(catalogSnapshot),
        activeInstanceKeys: Object.freeze([]),
        publicationSetHash: hashReadyPublicationSet(catalogSnapshot),
        candidateAccounting: Object.freeze({
          total: 3,
          verified: 0,
          terminalRejected: 0,
          retryable: 3,
          remainingUnaccounted: 0 as const,
        }),
        observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
        appliedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
        sourceCoverage: Object.freeze([Object.freeze({
          familyId: "univ2",
          sourceId: "startup-universe",
          completeThroughBlock: SOURCE.number,
          completeThroughHash: SOURCE.hash,
        })]),
        graphSnapshot,
        graphHash: hashReadyGraphSnapshot(graphSnapshot),
        catalogSnapshot,
      }) as ReadyUniverseGeneration,
    });
    assert.equal((await store.load())?.inProgressRun, null);
    assert.equal(
      (await store.load())?.retryableAttemptsByCandidateKey["cand:a"]?.status,
      "retryable",
    );

    // Mock wiring module: fixes the retryable key on probe.
    const wiring = join(dir, "wiring.mjs");
    await writeFile(wiring, [
      "import { createHash } from 'node:crypto';",
      "const digest = (s) => createHash('sha256').update(s).digest('hex');",
      "export function createProbeWiring() {",
      "  return Object.freeze({",
      "    attestFamilyInstanceOnce: async (input) => {",
      "      if (input.candidate.address === '0x' + '2'.repeat(40)) throw new Error('isolated transport failure');",
      "      return Object.freeze({",
      "      status: 'verified',",
      "      result: Object.freeze({ identity: 'a' }),",
      "      });",
      "    },",
      "    sealDurableVerifiedMemo: (input) => Object.freeze({",
      "      familyCandidateKey: input.familyCandidateKey,",
      "      familyInstanceKey: 'inst:' + input.familyCandidateKey,",
      "      familyId: 'univ2',",
      "      candidateKey: 'a',",
      "      instanceKey: 'inst:' + input.familyCandidateKey,",
      "      candidateFingerprint: 'cf',",
      "      familyDefinitionHash: 'fdh',",
      "      validity: Object.freeze({ policy: 'immutable-code', authorityFingerprint: 'auth', proofSource: Object.freeze({ number: input.proofSource.number, hash: input.proofSource.hash }) }),",
      "      verifiedIdentity: Object.freeze({}),",
      "      compiledDescriptor: Object.freeze({}),",
      "      staticProjection: Object.freeze({}),",
      "      evidenceFingerprint: 'ef',",
      "      memoFingerprint: digest('memo:' + input.familyCandidateKey),",
      "    }),",
      "    assertCanonicalHead: async () => undefined,",
      "    decodeCandidateSnapshot: (snapshot) => snapshot,",
      "  });",
      "}",
      "",
    ].join("\n"));
    const out = execFileSync(
      "node",
      ["--import", "tsx", "src/searcher/universe-rebuild-probe-cli.ts",
        "--checkpoint", checkpoint, "--run-id", "run-1",
        "--family-candidate-key", "cand:a"],
      {
        cwd: process.cwd(),
        env: { ...process.env, SEARCHER_UNIVERSE_REBUILD_WIRING_PATH: wiring },
        encoding: "utf8",
      },
    );
    assert.match(out, /cand:a -> verified/, out);
    const after = await store.load();
    assert.equal(
      after?.retryableAttemptsByCandidateKey["cand:a"],
      undefined,
      "probe success removes the independent queued retryable",
    );
    assert.equal(
      after?.verifiedMemos["cand:a"]?.familyInstanceKey,
      "inst:cand:a",
      "probe success must persist the verified memo",
    );

    // One target transport exception is isolated: the worker continues to
    // the next key, persists its outcome, and reports the batch error only
    // after every selected target has had a chance to run.
    const isolated = spawnSync(
      "node",
      ["--import", "tsx", "src/searcher/universe-rebuild-probe-cli.ts",
        "--checkpoint", checkpoint, "--run-id", "run-1",
        "--failure-code", "rpc", "--limit", "2"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SEARCHER_UNIVERSE_REBUILD_WIRING_PATH: wiring,
          SEARCHER_PROBE_CONCURRENCY: "1",
        },
        encoding: "utf8",
      },
    );
    assert.equal(isolated.status, 1, isolated.stderr);
    assert.match(isolated.stderr, /cand:b -> error reason=isolated transport failure/);
    assert.match(isolated.stderr, /1 target probe\(s\) failed before producing an outcome/);
    assert.match(isolated.stdout, /cand:c -> verified/, isolated.stdout);
    const afterIsolation = await store.load();
    assert.equal(
      afterIsolation?.retryableAttemptsByCandidateKey["cand:b"]?.status,
      "retryable",
      "an exception leaves the original target safely queued",
    );
    assert.equal(
      afterIsolation?.retryableAttemptsByCandidateKey["cand:c"],
      undefined,
      "a later target still commits after an earlier transport exception",
    );
    assert.equal(
      afterIsolation?.verifiedMemos["cand:c"]?.familyInstanceKey,
      "inst:cand:c",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("universe rebuild probe CLI PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
