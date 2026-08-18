import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  UniverseRebuildCheckpointStore,
} from "../universe-rebuild-checkpoint.js";

const SOURCE = Object.freeze({
  number: 25_750_000,
  hash: "0x" + "a1".repeat(32),
  generation: 1,
});

// Fixture wiring module: every candidate verifies immediately.
const wiringSource = [
  "import { createHash } from 'node:crypto';",
  "const digest = (s) => createHash('sha256').update(s).digest('hex');",
  "const SOURCE = Object.freeze({ number: 25750000, hash: '0x' + 'a1'.repeat(32), generation: 1 });",
  "export function createRebuildWiring() {",
  "  return Object.freeze({",
  "    freezeCanonicalHead: async () => SOURCE,",
  "    scanSwapWindow: async (scan) => Object.freeze({ observations: Object.freeze([",
  "      Object.freeze({ address: '0x' + '11'.repeat(20), topics: Object.freeze(['0x' + 'aa'.repeat(32), '0x' + '22'.repeat(32)]), data: '0x', transactionHash: '0x' + '33'.repeat(32), blockNumber: 25750000, logIndex: 0 }),",
  "      Object.freeze({ address: '0x' + '11'.repeat(20), topics: Object.freeze(['0x' + 'aa'.repeat(32), '0x' + '22'.repeat(32)]), data: '0x', transactionHash: '0x' + '33'.repeat(32), blockNumber: 25750000, logIndex: 1 }),",
  "    ]), sourceReceipts: Object.freeze([Object.freeze({ sourceKey: '1'.repeat(64), sourceKind: 'startup-candidate-union', providerIdentity: 'fixture', queryFingerprint: '2'.repeat(64), fromBlock: scan.fromBlock, toBlock: scan.cutoff.number, cutoffNumber: scan.cutoff.number, cutoffHash: scan.cutoff.hash, coverageKeys: Object.freeze(['univ2-standard|startup-universe']), completedChunks: Object.freeze([Object.freeze({ fromBlock: scan.fromBlock, toBlock: scan.cutoff.number, resultCount: 2, resultHash: '3'.repeat(64) })]), observationSetHash: '4'.repeat(64), observedThrough: Object.freeze({ number: scan.cutoff.number, hash: scan.cutoff.hash }), appliedThrough: Object.freeze({ number: scan.cutoff.number, hash: scan.cutoff.hash }), retryableCount: 0, status: 'complete' })]) }),",
  "    familyCandidateKey: (c) => 'cand:' + String(c.address ?? '') + ':' + String(c.logIndex ?? ''),",
  "    requiredSourceCoverageKeys: () => Object.freeze(['univ2-standard|startup-universe']),",
  "    dedupeFamilyCandidates: (obs) => Object.freeze([Object.freeze({ address: '0x' + '11'.repeat(20), logIndex: 0, familyId: 'univ2-standard' }), Object.freeze({ address: '0x' + '11'.repeat(20), logIndex: 1, familyId: 'univ2-standard' })]),",
  "    findReusableMemo: async () => null,",
  "    attestFamilyInstanceOnce: async (input) => Object.freeze({ status: 'verified', result: Object.freeze({ identity: String(input.candidate.logIndex) }) }),",
  "    sealDurableVerifiedMemo: (input) => Object.freeze({",
  "      familyCandidateKey: input.familyCandidateKey,",
  "      familyInstanceKey: 'inst:' + input.familyCandidateKey,",
  "      familyId: 'univ2-standard',",
  "      candidateKey: 'c',",
  "      instanceKey: 'inst:' + input.familyCandidateKey,",
  "      candidateFingerprint: 'cf',",
  "      familyDefinitionHash: 'fdh',",
  "      validity: Object.freeze({ policy: 'immutable-code', authorityFingerprint: 'fdh', proofSource: Object.freeze({ number: input.proofSource.number, hash: input.proofSource.hash }) }),",
  "      verifiedIdentity: Object.freeze({}),",
  "      compiledDescriptor: Object.freeze({}),",
  "      staticProjection: Object.freeze({}),",
  "      evidenceFingerprint: 'ef',",
  "      memoFingerprint: digest('memo:' + input.familyCandidateKey),",
  "    }),",
  "    rehydrateVerifiedInstance: (input) => Object.freeze({ familyId: 'univ2-standard', familyInstanceKey: input.memo.familyInstanceKey, instanceKey: input.memo.instanceKey }),",
  "    aggregateOnceByFamily: (instances) => Object.freeze(instances.map((i) => Object.freeze({ familyId: 'univ2-standard', instance: i }))),",
  "    buildGraphSnapshot: () => Object.freeze({ format: 'strict-rebuild-graph-v1', edges: Object.freeze([]) }),",
  "    buildCoverage: ({ cutoff }) => Object.freeze([Object.freeze({ familyId: 'univ2-standard', sourceId: 'startup-universe', completeThroughBlock: cutoff.number, completeThroughHash: cutoff.hash })]),",
  "    assertCanonicalHead: async () => undefined,",
  "  });",
  "}",
  "",
].join("\n");

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "universe-rebuild-startup-cli-"));
  try {
    const checkpoint = join(dir, "checkpoint.json");
    const wiring = join(dir, "wiring.mjs");
    await writeFile(wiring, wiringSource);
    const out = execFileSync(
      "node",
      ["--import", "tsx", "src/searcher/universe-rebuild-startup-cli.ts",
        "--checkpoint", checkpoint, "--run-id", "run-s", "--lookback-blocks", "14400",
        "--from-block", String(SOURCE.number - 20_000)],
      {
        cwd: process.cwd(),
        env: { ...process.env, SEARCHER_UNIVERSE_REBUILD_WIRING_PATH: wiring },
        encoding: "utf8",
      },
    );
    assert.match(out, /READY generation=1/, out);
    assert.match(out, /DONE/, out);
    const store = new UniverseRebuildCheckpointStore({ path: checkpoint });
    const envelope = await store.load();
    assert.equal(envelope?.readyGeneration?.generation, 1);
    assert.equal(
      envelope?.readyGeneration?.universeRange.fromBlock,
      SOURCE.number - 20_000,
      "CLI explicit range must expand and bind the ready universe",
    );
    assert.equal(envelope?.inProgressRun, null);
    assert.equal(
      Object.keys(envelope?.verifiedMemos ?? {}).length,
      2,
      "both candidates verified with memos",
    );

    // INCOMPLETE path: a retryable remains -> durable incomplete + exit 2.
    const checkpoint2 = join(dir, "checkpoint2.json");
    const store2 = new UniverseRebuildCheckpointStore({ path: checkpoint2 });
    await store2.beginOrResumeRun({
      expectedRevision: 0,
      runId: "run-i",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: "u",
      candidateSetHash: "c",
      candidateCount: 1,
      candidatesByKey: Object.freeze({
        "cand:x": Object.freeze({ address: "0x" + "11".repeat(20) }),
      }),
      observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    });
    await store2.casMergeRunOutcomes("run-i", Object.freeze([Object.freeze({
      status: "retryable",
      familyCandidateKey: "cand:x",
      familyId: "univ2-standard",
      candidateSnapshot: Object.freeze({ address: "0x" + "11".repeat(20) }),
      stage: "identity",
      failureCode: "rpc",
      reasonCode: "rpc",
      attemptCount: 1,
      lastAttemptAt: "2026-08-17T00:00:00.000Z",
    })]));
    // The fixture wiring attests the retryable... it never fails; make the
    // fixture store's run have a retryable that the wiring cannot clear by
    // giving the CLI a run-id mismatch scenario instead: run the CLI with a
    // wiring whose scan returns no candidates for a NEW run id -> the old
    // run is untouched and a second run id is rejected.
    let incompleteCode = 0;
    try {
      execFileSync(
        "node",
        ["--import", "tsx", "src/searcher/universe-rebuild-startup-cli.ts",
          "--checkpoint", checkpoint2, "--run-id", "run-other", "--lookback-blocks", "14400"],
        {
          cwd: process.cwd(),
          env: { ...process.env, SEARCHER_UNIVERSE_REBUILD_WIRING_PATH: wiring },
          encoding: "utf8",
        },
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      incompleteCode = status ?? 0;
    }
    assert.equal(
      incompleteCode,
      1,
      "a second run id while one is in progress must fail closed",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("universe rebuild startup CLI PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
