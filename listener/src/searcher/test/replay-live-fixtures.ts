import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import type { LiveFixtureReport } from "../live-fixture-recorder.js";
import { RevmSimClient } from "../revm-sim-client.js";
import { DEFAULT_SEARCHER_OWNER } from "../../shared/executor/botvm-executor.js";

function loadEnv(): void {
  const envPath = resolve("..", ".env");
  let text = "";
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

function readReports(dir: string): LiveFixtureReport[] {
  const reportDir = resolve(dir, "reports");
  if (!existsSync(reportDir)) return [];
  return readdirSync(reportDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(resolve(reportDir, name), "utf8")) as LiveFixtureReport);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main(): Promise<void> {
  loadEnv();
  const backend = process.env.SEARCHER_LIVE_BACKEND ?? "rpc";
  const dir = process.env.SEARCHER_LIVE_FIXTURE_DIR ?? resolve("searcher", "live-fixtures");
  const reports = readReports(dir);

  console.log(`[replay-live-fixtures] dir=${dir}`);
  console.log(`[replay-live-fixtures] backend=${backend}`);
  console.log(`[replay-live-fixtures] reports=${reports.length}`);

  if (reports.length === 0) {
    throw new Error(
      "no reports found; run live with SEARCHER_RECORD_LIVE_FIXTURES=1 before replay",
    );
  }

  const byState = new Map<string, number>();
  const totals: number[] = [];
  const preSolver: number[] = [];
  for (const r of reports) {
    byState.set(r.finalState, (byState.get(r.finalState) ?? 0) + 1);
    totals.push(r.stageMs.total ?? 0);
    preSolver.push((r.stageMs.fork ?? 0) + (r.stageMs.match ?? 0) + (r.stageMs.prep ?? 0) + (r.stageMs.detect ?? 0) + (r.stageMs.plan ?? 0));
  }

  for (const [state, count] of [...byState.entries()].sort()) {
    console.log(`[replay-live-fixtures] finalState ${state}: ${count}`);
  }
  console.log(
    `[replay-live-fixtures] totalMs p50=${percentile(totals, 50).toFixed(0)} ` +
      `p95=${percentile(totals, 95).toFixed(0)} max=${Math.max(...totals).toFixed(0)}`,
  );
  console.log(
    `[replay-live-fixtures] preSolverMs p50=${percentile(preSolver, 50).toFixed(0)} ` +
      `p95=${percentile(preSolver, 95).toFixed(0)} max=${Math.max(...preSolver).toFixed(0)}`,
  );

  if (backend === "revm" || backend === "hybrid") {
    const runnable = reports.filter((r) => r.calldata && r.profitToken);
    console.log(`[replay-live-fixtures] revm runnable=${runnable.length}`);
    if (runnable.length === 0) {
      throw new Error("no reports with calldata/profitToken; cannot verify revm equivalence");
    }

    const botvm = process.env.BOTVM_ADDRESS;
    if (!botvm) throw new Error("BOTVM_ADDRESS required for revm replay");
    const owner = deriveOwner();
    const client = new RevmSimClient({ timeoutMs: Number(process.env.SEARCHER_REVM_TIMEOUT_MS ?? "60000") });

    let equivalent = 0;
    for (const report of runnable) {
      const result = await client.simulate({
        blockNumber: report.blockNumber,
        executor: ethers.getAddress(botvm),
        owner,
        calldata: report.calldata!,
        profitToken: report.profitToken!,
      });
      const expected = report.netProfit ? BigInt(report.netProfit) : null;
      const actual = BigInt(result.profit);
      const ok = expected === null
        ? result.success === (report.finalState === "would-submit")
        : withinOneWei(actual, expected);
      if (ok) equivalent++;
      console.log(
        `[replay-live-fixtures] ${report.txHash.slice(0, 10)} ` +
          `state=${report.finalState} block=${report.blockNumber} ` +
          `rpcProfit=${report.netProfit ?? "n/a"} revmProfit=${result.profit} ` +
          `success=${result.success} latencyMs=${result.latencyMs} ` +
          `missing=${result.missingStateKeys.length}` +
          `${result.revertReason ? ` revert=${result.revertReason.slice(0, 120)}` : ""}`,
      );
    }
    console.log(`[replay-live-fixtures] revm equivalent=${equivalent}/${runnable.length}`);
    if (equivalent !== runnable.length) {
      throw new Error(`revm equivalence failed: ${equivalent}/${runnable.length}`);
    }
  }
}

function deriveOwner(): string {
  const key = process.env.PRIVATE_KEY ?? process.env.OWNER_PRIVATE_KEY;
  if (key) return new ethers.Wallet(key).address;
  return ethers.getAddress(process.env.BOTVM_OWNER ?? DEFAULT_SEARCHER_OWNER);
}

function withinOneWei(actual: bigint, expected: bigint): boolean {
  const diff = actual > expected ? actual - expected : expected - actual;
  return diff <= 1n;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
