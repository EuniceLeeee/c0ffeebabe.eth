/**
 * Fork-reuse latency proof (Stage 3b #1 lever).
 *
 * Shows that re-forking per hint (`forkAt` = anvil_reset) is seconds, while
 * resetting a reused fork via revert+snapshot is milliseconds. This is the
 * cheapest timeliness win — it does NOT change any profit number, only the
 * per-hint setup cost. Local fork only; no key; no submission.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ethers } from "ethers";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";

function loadEnv(): void {
  let text = "";
  try {
    text = readFileSync(resolve("..", ".env"), "utf8");
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

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");

  const state = new AnvilStateBackend(rpcUrl, "http://127.0.0.1:8610", 8610);
  await state.start();

  try {
    const latest = await new ethers.JsonRpcProvider(rpcUrl).getBlockNumber();

    let t = performance.now();
    await state.forkAt(latest);
    const coldFork = performance.now() - t;

    // Production helper: refreshFork = forkAt + baseline snapshot (infrequent).
    t = performance.now();
    await state.refreshFork(latest);
    const refresh = performance.now() - t;
    if (!state.hasBaseline()) throw new Error("FAIL: refreshFork did not set a baseline");

    // Production helper: resetToBaseline (the per-hint path).
    const resets: number[] = [];
    for (let i = 0; i < 5; i++) {
      const marker = "0x000000000000000000000000000000000000dEaD";
      await state.provider.send("anvil_setBalance", [marker, "0xDE0B6B3A7640000"]);
      t = performance.now();
      await state.resetToBaseline();
      resets.push(performance.now() - t);
      const bal = await state.provider.getBalance(marker);
      if (bal === 10n ** 18n) throw new Error("FAIL: resetToBaseline did not undo the mutation");
    }
    const avgReset = resets.reduce((s, v) => s + v, 0) / resets.length;

    console.log(`[fork-reuse] forkAt cold:             ${coldFork.toFixed(0)}ms`);
    console.log(`[fork-reuse] refreshFork (infreq):    ${refresh.toFixed(0)}ms  <- only every N blocks`);
    console.log(`[fork-reuse] resetToBaseline (/hint): ${avgReset.toFixed(1)}ms  <- fork-reuse per-hint cost`);
    console.log(`[fork-reuse] speedup vs re-fork:      ${(coldFork / Math.max(0.1, avgReset)).toFixed(0)}x`);
    console.log("fork-reuse PASS (helpers verified: baseline set, mutation undone)");
  } finally {
    state.stop();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
