/**
 * AC-3b.1 — Anvil simulator pool: instance isolation + latency probe.
 *
 * Verifies (pass/fail):
 *   - acquire() returns distinct instances
 *   - snapshot/setBalance on one instance does NOT affect another (isolation)
 *   - revert restores the mutated instance
 *
 * Measures (informational — answers "are we stuck on timeliness?"):
 *   - pool startup (spawn N anvils)
 *   - forkAll latency (per-hint cost: fresh fork state)
 *   - one full send+mine (the heavy per-simulate floor on Anvil)
 *   - K cold reads serial (1 instance) vs concurrent (across pool)
 *
 * Local fork only. No private key, no bundle submission.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ethers } from "ethers";
import { AnvilSimulatorPool } from "../../shared/state/anvil-pool.js";
import { ADDR } from "../../shared/constants/addresses.js";

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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function ms(t: number): string {
  return `${(performance.now() - t).toFixed(0)}ms`;
}

function addrFromIndex(i: number): string {
  return ethers.getAddress("0x" + (BigInt(i) + 1n).toString(16).padStart(40, "0"));
}

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");

  const size = Number(process.env.SEARCHER_SIM_POOL_SIZE ?? "3");
  const pool = new AnvilSimulatorPool(rpcUrl, size, 8600);

  let tStart = performance.now();
  await pool.start();
  const startupMs = performance.now() - tStart;
  console.log(`[pool] started ${size} anvil instances in ${startupMs.toFixed(0)}ms`);

  try {
    const latest = await new ethers.JsonRpcProvider(rpcUrl).getBlockNumber();
    let t = performance.now();
    await pool.forkAll(latest);
    console.log(`[pool] forkAll(${latest}) across ${size} instances: ${ms(t)} (per-hint fresh-state cost)`);

    // ── AC-3b.1 isolation ──
    const a = await pool.acquire();
    const b = await pool.acquire();
    assert(a !== b, "acquire returned the same instance twice");

    const marker = addrFromIndex(0xdead);
    const oneEth = "0xDE0B6B3A7640000"; // 1e18
    const snap = await a.snapshot();
    await a.provider.send("anvil_setBalance", [marker, oneEth]);
    const balA = await a.provider.getBalance(marker);
    const balB = await b.provider.getBalance(marker);
    assert(balA === 10n ** 18n, `instance A balance not set, got ${balA}`);
    assert(balB !== 10n ** 18n, "isolation broken: instance B saw instance A's write");
    await a.revert(snap);
    const balA2 = await a.provider.getBalance(marker);
    assert(balA2 !== 10n ** 18n, "revert did not restore instance A");
    pool.release(a);
    pool.release(b);
    console.log("[pool] AC-3b.1 isolation (distinct + independent snapshot/revert): PASS");

    // ── one full send+mine: the heavy per-simulate floor ──
    try {
      const inst = await pool.acquire();
      const sender = addrFromIndex(0xbeef);
      await inst.provider.send("anvil_setBalance", [sender, "0x56BC75E2D63100000"]); // 100 ETH
      await inst.provider.send("anvil_impersonateAccount", [sender]);
      t = performance.now();
      await inst.send({ from: sender, to: sender, data: "0x" });
      console.log(`[pool] one send+mine (heavy simulate floor): ${ms(t)}`);
      await inst.provider.send("anvil_stopImpersonatingAccount", [sender]);
      pool.release(inst);
    } catch (err) {
      console.log(`[pool] send+mine probe skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── K cold reads: serial (1 instance) vs concurrent (across pool) ──
    const K = size * 2;
    const one = pool.all[0];
    t = performance.now();
    for (let i = 0; i < K; i++) await one.getTokenBalance(ADDR.USDC, addrFromIndex(1000 + i));
    const serialMs = performance.now() - t;

    t = performance.now();
    await pool.mapConcurrent(
      Array.from({ length: K }, (_, i) => i),
      (i, inst) => inst.getTokenBalance(ADDR.USDC, addrFromIndex(2000 + i)),
    );
    const concMs = performance.now() - t;

    console.log(
      `[pool] ${K} cold reads — serial(1): ${serialMs.toFixed(0)}ms | concurrent(${size}): ${concMs.toFixed(0)}ms ` +
        `(speedup ${(serialMs / Math.max(1, concMs)).toFixed(1)}x)`,
    );

    console.log("anvil-pool PASS");
  } finally {
    pool.stop();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
