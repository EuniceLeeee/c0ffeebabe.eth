import { ethers } from "ethers";
import {
  BlockScanWarmCoordinator,
  blockScanWarmPassBudgetMs,
  formatBlockScanWarmPlan,
} from "../blockscan-warm-coordinator.js";
import type { QuoteRequest } from "../live-state-backend.js";

function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

interface FakeLog {
  address: string;
  topics: string[];
}

class FakeProvider {
  logs: FakeLog[] = [];
  error: Error | null = null;

  async getLogs(): Promise<FakeLog[]> {
    if (this.error) throw this.error;
    return this.logs;
  }
}

const warmCache = {
  hasV2: () => true,
  hasV3Live: () => true,
  hasV4: () => true,
  hasCurve: () => true,
  curveKind: () => "plain" as const,
};
const warmUpdater = { hasStaticMetadata: () => true };

function coordinator(provider: FakeProvider, fullRewarmBlocks = 600): BlockScanWarmCoordinator {
  return new BlockScanWarmCoordinator(
    provider as unknown as ethers.JsonRpcProvider,
    warmCache,
    warmUpdater,
    fullRewarmBlocks,
  );
}

function v2Hop(target: string): QuoteRequest {
  return {
    adapterId: "univ2-swap",
    target,
    tokenIn: "0x0000000000000000000000000000000000000001",
    tokenOut: "0x0000000000000000000000000000000000000002",
    amountIn: 0n,
  };
}

async function main(): Promise<void> {
  const provider = new FakeProvider();
  const subject = coordinator(provider);
  const startup = await subject.plan(100, [], []);
  assert(startup.kind === "full" && startup.reason === "startup", "startup full warm");
  assert(
    blockScanWarmPassBudgetMs(startup, 11_000, 600_000) === 600_000,
    "full warm receives the bounded full-warm deadline",
  );
  subject.markV2V3WarmComplete(100, startup);

  const incremental = await subject.plan(101, [], []);
  assert(incremental.kind === "incremental", "next block incremental");
  assert(incremental.changed.logs === 0, "empty incremental logs");
  assert(
    blockScanWarmPassBudgetMs(incremental, 11_000, 600_000) === 11_000,
    "incremental warm retains the per-pass deadline",
  );
  subject.markV2V3WarmComplete(101, incremental);

  const reorg = await subject.plan(101, [], []);
  assert(reorg.kind === "full" && reorg.reason === "reorg", "same block reorg");
  console.log("[blockscan-warm-coordinator] startup/incremental/reorg: PASS");

  const intervalSubject = coordinator(new FakeProvider(), 2);
  const intervalStartup = await intervalSubject.plan(200, [], []);
  intervalSubject.markV2V3WarmComplete(200, intervalStartup);
  const interval = await intervalSubject.plan(202, [], []);
  assert(interval.kind === "full" && interval.reason === "interval", "full interval");

  const rangeSubject = coordinator(new FakeProvider());
  const rangeStartup = await rangeSubject.plan(300, [], []);
  rangeSubject.markV2V3WarmComplete(300, rangeStartup);
  const range = await rangeSubject.plan(333, [], []);
  assert(range.kind === "full" && range.reason === "range", "range fallback");
  console.log("[blockscan-warm-coordinator] interval/range: PASS");

  const failingProvider = new FakeProvider();
  const failingSubject = coordinator(failingProvider);
  const failingStartup = await failingSubject.plan(400, [], []);
  failingSubject.markV2V3WarmComplete(400, failingStartup);
  failingProvider.error = new Error("logs unavailable");
  const logsError = await failingSubject.plan(401, [], []);
  assert(logsError.kind === "full" && logsError.reason === "logs_error", "logs error fallback");
  assert(formatBlockScanWarmPlan(logsError).includes("logs unavailable"), "error formatting");
  console.log("[blockscan-warm-coordinator] logs error: PASS");

  const pool = "0x00000000000000000000000000000000000000a1";
  const changedProvider = new FakeProvider();
  const changedSubject = coordinator(changedProvider);
  const changedStartup = await changedSubject.plan(500, [], []);
  changedSubject.markV2V3WarmComplete(500, changedStartup);
  changedProvider.logs = [{ address: pool, topics: [ethers.id("Sync(uint112,uint112)")] }];
  const changed = await changedSubject.plan(501, [v2Hop(pool)], []);
  assert(changed.kind === "incremental", "changed pool incremental");
  assert(changed.changed.pools.has(pool.toLowerCase()), "changed pool captured");
  assert(changed.changed.hops.length === 1, "changed hop captured");
  console.log("[blockscan-warm-coordinator] changed-pool selection: PASS");

  console.log("blockscan-warm-coordinator PASS (4/4)");
}

await main();
