import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  UniverseRebuildCheckpointStore,
  type DurableVerifiedMemo,
} from "../universe-rebuild-checkpoint.js";

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
    await store.beginOrResumeRun({
      expectedRevision: 0,
      runId: "run-1",
      cutoff: SOURCE,
      fromBlock: SOURCE.number - 14_399,
      universeHash: "u1",
      candidateSetHash: "c1",
      candidateCount: 1,
      observedThrough: Object.freeze({ number: SOURCE.number, hash: SOURCE.hash }),
    });
    await store.casMergeRunOutcomes("run-1", Object.freeze([Object.freeze({
      status: "retryable",
      familyCandidateKey: "cand:a",
      familyId: "univ2",
      candidateSnapshot: Object.freeze({ address: "0x" + "11".repeat(20) }),
      stage: "identity",
      failureCode: "rpc",
      reasonCode: "factory-child-reverse-binding:rpc",
      attemptCount: 1,
      lastAttemptAt: "2026-08-17T00:00:00.000Z",
    })]));

    // Mock wiring module: fixes the retryable key on probe.
    const wiring = join(dir, "wiring.mjs");
    await writeFile(wiring, [
      "import { createHash } from 'node:crypto';",
      "const digest = (s) => createHash('sha256').update(s).digest('hex');",
      "export function createProbeWiring() {",
      "  return Object.freeze({",
      "    attestFamilyInstanceOnce: async (input) => Object.freeze({",
      "      status: 'verified',",
      "      result: Object.freeze({ identity: 'a' }),",
      "    }),",
      "    sealDurableVerifiedMemo: (input) => Object.freeze({",
      "      familyCandidateKey: input.familyCandidateKey,",
      "      familyInstanceKey: 'inst:a',",
      "      familyId: 'univ2',",
      "      candidateKey: 'a',",
      "      instanceKey: 'inst:a',",
      "      candidateFingerprint: 'cf',",
      "      familyDefinitionHash: 'fdh',",
      "      validity: Object.freeze({ policy: 'immutable-code', authorityFingerprint: 'auth', proofSource: Object.freeze({ number: input.proofSource.number, hash: input.proofSource.hash }) }),",
      "      verifiedIdentity: Object.freeze({}),",
      "      compiledDescriptor: Object.freeze({}),",
      "      staticProjection: Object.freeze({}),",
      "      evidenceFingerprint: 'ef',",
      "      memoFingerprint: digest('memo:a'),",
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
      after?.inProgressRun?.outcomesByCandidateKey["cand:a"]?.status,
      "verified",
    );
    assert.equal(
      after?.verifiedMemos["cand:a"]?.familyInstanceKey,
      "inst:a",
      "probe success must persist the verified memo",
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
