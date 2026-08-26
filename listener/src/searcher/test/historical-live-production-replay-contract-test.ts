import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  HISTORICAL_LIVE_PRODUCTION_ENTRY,
  assertTargetBlindReplayEnvironment,
  forwardedProductionEnvironment,
  historicalCheckpointEvidence,
  historicalPoolUniverseEvidence,
  runBoundedHistoricalPrepare,
} from "./historical-live-production-replay-contract.js";
import {
  forkBotVmInstallationEnabled,
} from "../../shared/executor/botvm-executor.js";
import {
  prepareBlockScanExecutionWorkerFork,
  type BlockScanExecutionWorker,
} from "../blockscan-runtime-loop.js";
import type { StartupCheckpointEnvelope } from
  "../universe-rebuild-checkpoint.js";
import {
  BLIND_PRODUCTION_RAW_PROFILE,
  blindProductionControlFailureRecord,
  validateBlindProductionControlFailureRecord,
  type BlindProductionPrepareControl,
} from "../blind-production-audit.js";

const HASH = `0x${"1".repeat(64)}`;
const listenerRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

assert.throws(
  () => assertTargetBlindReplayEnvironment({ AB_EXPECTED_ROUTE: "[]" }),
  /target-specific environment AB_EXPECTED_ROUTE/,
);

const prepareAttempts: number[] = [];
const prepareControl: BlindProductionPrepareControl = {
  type: "prepare",
  profile: BLIND_PRODUCTION_RAW_PROFILE,
  attemptNonce: "ab".repeat(32),
  base: { number: 20, hash: HASH, stateRoot: HASH },
};
const controlFailure = blindProductionControlFailureRecord(
  prepareControl,
  new Error("transient"),
);
assert.equal(
  validateBlindProductionControlFailureRecord(
    controlFailure,
    prepareControl,
  ).attemptNonce,
  prepareControl.attemptNonce,
);
assert.throws(
  () => validateBlindProductionControlFailureRecord(controlFailure, {
    ...prepareControl,
    attemptNonce: "cd".repeat(32),
  }),
  /control failure mismatch/,
);
assert.equal(
  await runBoundedHistoricalPrepare({
    maxAttempts: 3,
    async attempt(attemptNumber) {
      prepareAttempts.push(attemptNumber);
      return attemptNumber === 1
        ? { status: "failed", message: "transient" }
        : { status: "ready", value: "ready" };
    },
  }),
  "ready",
);
assert.deepEqual(prepareAttempts, [1, 2]);
await assert.rejects(
  runBoundedHistoricalPrepare({
    maxAttempts: 2,
    async attempt() {
      return { status: "failed", message: "still unavailable" };
    },
  }),
  /failed after 2 attempts: still unavailable/,
);
assert.throws(
  () => assertTargetBlindReplayEnvironment({ SEARCHER_TARGET_POOL: "0x1" }),
  /target-specific environment SEARCHER_TARGET_POOL/,
);
assert.doesNotThrow(() => assertTargetBlindReplayEnvironment({
  npm_config_target_arch: "arm64",
  SYSTEM_TARGET: "host-only",
}));
const forwarded = forwardedProductionEnvironment({
  PATH: process.env.PATH,
  NODE_OPTIONS: "--require=/tmp/inject.js",
  BLIND_PREFIX_THROUGH_INDEX: "105",
  SEARCHER_BLOCKSCAN_MAX_CANDIDATES: "100",
  SEARCHER_BLOCKSCAN_MIN_SPREAD_BPS: "10",
  SEARCHER_BLIND_PREPARE_BUDGET_MS: "999999",
  SEARCHER_BLIND_USE_INCUMBENT_READY: "1",
  SEARCHER_FORCE_INCLUDE_POOLIDS_PATH: "/future.json",
});
assert.equal(forwarded.SEARCHER_BLOCKSCAN_MAX_CANDIDATES, "100");
assert.equal(forwarded.SEARCHER_BLOCKSCAN_MIN_SPREAD_BPS, "10");
assert.equal(forwarded.SEARCHER_BLIND_PREPARE_BUDGET_MS, undefined);
assert.equal(forwarded.SEARCHER_BLIND_USE_INCUMBENT_READY, undefined);
assert.equal(forwarded.SEARCHER_FORCE_INCLUDE_POOLIDS_PATH, undefined);
assert.equal(forwarded.BLIND_PREFIX_THROUGH_INDEX, undefined);
assert.equal(forwarded.NODE_OPTIONS, undefined);

assert.equal(forkBotVmInstallationEnabled(false, undefined), false);
assert.equal(forkBotVmInstallationEnabled(true, undefined), false);
assert.equal(forkBotVmInstallationEnabled(true, "1"), true);
assert.throws(
  () => forkBotVmInstallationEnabled(false, "1"),
  /replay-only/,
);

const forkOrder: string[] = [];
const worker = {
  state: {
    provider: {},
    async forkAt() {
      forkOrder.push("fork");
    },
    stop() {
      forkOrder.push("stop");
    },
  },
  solver: {},
  simulator: {},
  async prepareFork() {
    forkOrder.push("prepare");
  },
} as unknown as BlockScanExecutionWorker;
await prepareBlockScanExecutionWorkerFork({
  worker,
  sourceBlock: 20,
  sourceBlockHash: HASH,
  deadlineAtMs: Date.now() + 10_000,
  signal: new AbortController().signal,
  async readBlockHash() {
    forkOrder.push("hash");
    return HASH;
  },
});
assert.deepEqual(forkOrder, ["fork", "hash", "prepare"]);

const checkpoint = checkpointFixture(20);
const evidence = historicalCheckpointEvidence(checkpoint, 20);
assert.equal(evidence.readyCutoff, 20);
assert.equal(evidence.verifiedMemos, 1);
assert.throws(
  () => historicalCheckpointEvidence(checkpointFixture(21), 20),
  /look-ahead ready\.cutoff=21 base=20/,
);
const futureMemo = checkpointFixture(20);
(futureMemo.verifiedMemos.candidate as {
  validity: { proofSource: { number: number; hash: string } };
}).validity.proofSource.number = 21;
assert.throws(
  () => historicalCheckpointEvidence(futureMemo, 20),
  /look-ahead verifiedMemo/,
);
assert.throws(
  () => historicalCheckpointEvidence({
    ...checkpoint,
    inProgressRun: {} as StartupCheckpointEnvelope["inProgressRun"],
  }, 20),
  /in-progress run/,
);

const work = mkdtempSync(join(tmpdir(), "historical-live-contract-"));
try {
  const universePath = join(work, "universe.json");
  const universe = JSON.stringify({
    schemaVersion: 2,
    fromBlock: 10,
    toBlock: 20,
    registry: { sourceFingerprints: [] },
    pools: [],
  });
  writeFileSync(universePath, universe);
  const contentSha256 = createHash("sha256").update(universe).digest("hex");
  writeFileSync(`${universePath}.manifest.json`, JSON.stringify({
    schemaVersion: 1,
    profile: "pool-universe-build-manifest-v1",
    chainId: 1,
    source: { number: 20, hash: HASH, stateRoot: HASH },
    inputs: { fromBlock: 10, toBlock: 20 },
    output: { contentSha256, pools: 0 },
    registry: { sourceFingerprints: [] },
  }));
  assert.equal(historicalPoolUniverseEvidence(universePath, 20).toBlock, 20);
  assert.throws(
    () => historicalPoolUniverseEvidence(universePath, 19),
    /toBlock <= base/,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

const replaySource = readFileSync(
  resolve(listenerRoot, "src/searcher/test/historical-live-production-replay.mjs"),
  "utf8",
);
assert.match(replaySource, /HISTORICAL_LIVE_PRODUCTION_ENTRY/);
assert.match(
  replaySource,
  /BLIND_PRODUCTION_READY_PREFIX,\s*blindProductionAuditHash,/,
);
assert.match(
  replaySource,
  /SEARCHER_BLIND_USE_INCUMBENT_READY:\s*"1"/,
);
assert.match(
  replaySource,
  /SEARCHER_BLIND_PREPARE_BUDGET_MS:\s*String\(prepareBudgetMs\)/,
);
assert.doesNotMatch(replaySource, /SEARCHER_BLOCKSCAN_MAX_HOPS:\s*"6"/);
const negativeBase = spawnSync(
  process.execPath,
  [resolve(
    listenerRoot,
    "src/searcher/test/historical-live-production-replay.mjs",
  )],
  {
    cwd: listenerRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      BLIND_BASE_NUMBER: "-1",
      BLIND_SOURCE_NUMBER: "0",
      BLIND_RUN_DIR: resolve(tmpdir(), "historical-live-negative-base"),
      BLIND_PRODUCTION_COMMIT: "0".repeat(40),
    },
  },
);
assert.equal(negativeBase.status, 1);
assert.match(
  `${negativeBase.stdout}\n${negativeBase.stderr}`,
  /invalid historical live production replay environment/,
);
const invoked = spawnSync(
  process.execPath,
  ["--import", "tsx", HISTORICAL_LIVE_PRODUCTION_ENTRY],
  {
    cwd: listenerRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      SEARCHER_TEST_DISABLE_DOTENV: "1",
      SEARCHER_LIVE_RPC_URL: "http://127.0.0.1:1",
    },
  },
);
assert.equal(invoked.status, 1);
assert.match(
  `${invoked.stdout}\n${invoked.stderr}`,
  /PRIVATE_KEY or OWNER_PRIVATE_KEY required/,
  "the replay entry must remain the real production main",
);
const incumbentOutsideReplay = spawnSync(
  process.execPath,
  ["--import", "tsx", HISTORICAL_LIVE_PRODUCTION_ENTRY],
  {
    cwd: listenerRoot,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      SEARCHER_TEST_DISABLE_DOTENV: "1",
      SEARCHER_BLIND_USE_INCUMBENT_READY: "1",
    },
  },
);
assert.equal(incumbentOutsideReplay.status, 1);
assert.match(
  `${incumbentOutsideReplay.stdout}\n${incumbentOutsideReplay.stderr}`,
  /SEARCHER_BLIND_USE_INCUMBENT_READY=1 is replay-only/,
);

console.log("historical-live-production-replay-contract PASS");

function checkpointFixture(cutoffNumber: number): StartupCheckpointEnvelope {
  const source = Object.freeze({
    number: cutoffNumber,
    hash: HASH,
    generation: 1,
  });
  return {
    revision: 1,
    verifiedMemos: {
      candidate: {
        familyCandidateKey: "candidate",
        familyInstanceKey: "instance",
        familyId: "family",
        candidateKey: "candidate",
        instanceKey: "instance",
        candidateFingerprint: "a".repeat(64),
        familyDefinitionHash: "b".repeat(64),
        validity: {
          policy: "immutable-code",
          authorityFingerprint: "c".repeat(64),
          proofSource: { number: cutoffNumber, hash: HASH },
        },
        verifiedIdentity: {},
        compiledDescriptor: {},
        staticProjection: {},
        evidenceFingerprint: "d".repeat(64),
        candidateSnapshot: {},
        memoFingerprint: "e".repeat(64),
      },
    },
    inProgressRun: null,
    retryableAttemptsByCandidateKey: {},
    readyGeneration: {
      generation: 1,
      cutoff: source,
      universeRange: { fromBlock: Math.max(0, cutoffNumber - 10), toBlock: cutoffNumber },
      universeHash: "a".repeat(64),
      catalogHash: "b".repeat(64),
      activeInstanceKeys: ["instance"],
      publicationSetHash: "c".repeat(64),
      candidateAccounting: {
        total: 1,
        verified: 1,
        terminalRejected: 0,
        retryable: 0,
        remainingUnaccounted: 0,
      },
      observedThrough: { number: cutoffNumber, hash: HASH },
      appliedThrough: { number: cutoffNumber, hash: HASH },
      sourceCoverage: [],
      graphSnapshot: {},
      graphHash: "d".repeat(64),
      catalogSnapshot: {},
    },
    checkpointFingerprint: "f".repeat(64),
  };
}
