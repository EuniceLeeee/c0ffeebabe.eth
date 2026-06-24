/**
 * T2 verification: cold/warm timing of the revm overlay `prepare` path.
 *
 * Mirrors the live hash-only flow exactly — RevmLiveBackend.prepareVictimState
 * with a victim overlay (deal + approve + UniV3 swap) plus routeHops prewarm —
 * against the real CRV/WETH pool at the CURRENT latest block, so the daemon's
 * per-block cache is guaranteed cold on the first prepare (the live worst case
 * that measured 21-22.5s overlay before T2).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ethers } from "ethers";
import { DEFAULT_SEARCHER_OWNER } from "../../shared/executor/botvm-executor.js";
import type { PoolImpact } from "../detector/pool-impact.js";
import { RevmLiveBackend } from "../live-backends/revm-live-backend.js";
import { RevmSimClient } from "../revm-sim-client.js";

const POOL = "0x919Fa96e88d67499339577Fa202345436bcDaf79"; // CRV/WETH 0.3%
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const CRV = "0xD533a949740bb3306d119CC777fa900bA034cd52";
const AMOUNT_IN = 101859718286728000n; // observed live hint amountIn
const BOTVM = "0x4aF9495C4aC24c5CD3b0C90611550a1996415BCe";

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
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const latest = await provider.getBlockNumber();
  console.log(`[prepare-timing] block=${latest}`);

  const client = new RevmSimClient({ timeoutMs: 120_000 });
  const backend = new RevmLiveBackend(client, BOTVM, DEFAULT_SEARCHER_OWNER, provider, [], rpcUrl);

  const impact: PoolImpact = {
    pool: POOL,
    tokenIn: WETH,
    tokenOut: CRV,
    amountIn: AMOUNT_IN,
    matchedAdapterId: "univ3-swap",
  };
  const event = { txHash: "0x0", blockNumber: latest + 1, rawTx: "0x", from: ethers.ZeroAddress, nonce: 0, to: null, input: "0x", logs: [], minProfit: 1n };
  const input = {
    event: event as never,
    impact,
    baseBlock: latest,
    path: "hash-only" as const,
    // The arb quotes the reverse direction (CRV -> WETH) during GSS.
    routeHops: [
      { adapterId: "univ3-swap", target: POOL, tokenIn: CRV, tokenOut: WETH },
      { adapterId: "univ3-swap", target: POOL, tokenIn: WETH, tokenOut: CRV },
    ],
  };

  let t = performance.now();
  await backend.prepareVictimState(input);
  console.log(`[prepare-timing] COLD prepare (fresh daemon, nothing cached): ${(performance.now() - t).toFixed(0)}ms`);

  t = performance.now();
  const q1 = await backend.quote({ adapterId: "univ3-swap", target: POOL, tokenIn: CRV, tokenOut: WETH, amountIn: 100000000000000000000n });
  console.log(`[prepare-timing] first GSS-direction quote: ${(performance.now() - t).toFixed(0)}ms amountOut=${q1.amountOut} cache=${JSON.stringify(q1.cacheStats)}`);

  t = performance.now();
  const q2 = await backend.quote({ adapterId: "univ3-swap", target: POOL, tokenIn: CRV, tokenOut: WETH, amountIn: 200000000000000000000n });
  console.log(`[prepare-timing] second quote: ${(performance.now() - t).toFixed(0)}ms amountOut=${q2.amountOut} cache=${JSON.stringify(q2.cacheStats)}`);

  // Live steady state: each subsequent hint lands on a NEW block (per-block
  // storage cache dropped) but the SAME daemon (contract code + HTTP connection
  // persist cross-block). This is the case the live p95 target is about.
  const samples: number[] = [];
  for (let i = 1; i <= 6; i++) {
    t = performance.now();
    await backend.prepareVictimState({ ...input, baseBlock: latest - i });
    const ms = performance.now() - t;
    samples.push(ms);
    console.log(`[prepare-timing] NEW-BLOCK prepare #${i} (code+conn warm, storage cold): ${ms.toFixed(0)}ms`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  console.log(`[prepare-timing] NEW-BLOCK p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms min=${sorted[0].toFixed(0)}ms max=${sorted[sorted.length - 1].toFixed(0)}ms`);

  client.stop();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
