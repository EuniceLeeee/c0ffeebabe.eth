/**
 * Background-warmer smoke test (T2 / between-block pool warm).
 *
 * Proves the mechanism: a proactive `warmHotPools` on a block seeds the route
 * pool's slots into the daemon cache, so a later same-block prepare that does
 * NOT trace route hops (revmPrewarmRouteHops=0) still gets a WARM first quote —
 * instead of the cold serial-fault that costs ~1.3s inside the TTL today.
 *
 * Control vs treatment, two isolated daemons, same block:
 *   - control:   prepare(no route prewarm) → first quote is COLD (faults)
 *   - treatment: warmHotPools → prepare(no route prewarm) → first quote is WARM
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
const AMOUNT_IN = 101859718286728000n;
const BOTVM = "0x4aF9495C4aC24c5CD3b0C90611550a1996415BCe";
const GSS_AMOUNT = 100000000000000000000n;

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

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const block = (await provider.getBlockNumber()) - 1;
  console.log(`[warm-smoke] block=${block}`);

  const coldClient = new RevmSimClient({ timeoutMs: 120_000 });
  const warmClient = new RevmSimClient({ timeoutMs: 120_000 });
  const coldBackend = new RevmLiveBackend(coldClient, BOTVM, DEFAULT_SEARCHER_OWNER, provider, [], rpcUrl);
  const warmBackend = new RevmLiveBackend(warmClient, BOTVM, DEFAULT_SEARCHER_OWNER, provider, [], rpcUrl);

  const impact: PoolImpact = {
    pool: POOL,
    tokenIn: WETH,
    tokenOut: CRV,
    amountIn: AMOUNT_IN,
    matchedAdapterId: "univ3-swap",
  };
  const event = { txHash: "0x0", blockNumber: block + 1, rawTx: "0x", from: ethers.ZeroAddress, nonce: 0, to: null, input: "0x", logs: [], minProfit: 1n };
  // No routeHops → prepare does NOT trace the reverse-direction quote, so the
  // GSS-direction first quote is only warm if the background warmer seeded it.
  const baseInput = {
    event: event as never,
    impact,
    path: "hash-only" as const,
    routeHops: [] as Array<{ adapterId: string; target: string; tokenIn: string; tokenOut: string }>,
  };
  const gss = { adapterId: "univ3-swap", target: POOL, tokenIn: CRV, tokenOut: WETH, amountIn: GSS_AMOUNT };

  // ── Control: no warm, prepare without route prewarm → first quote cold ──
  await coldBackend.prepareVictimState({ ...baseInput, baseBlock: block });
  let t = performance.now();
  const cold = await coldBackend.quote(gss);
  const coldMs = performance.now() - t;
  console.log(
    `[warm-smoke] CONTROL (no warm) first quote: ${coldMs.toFixed(0)}ms ` +
      `cache=${JSON.stringify(cold.cacheStats)} amountOut=${cold.amountOut}`,
  );
  coldClient.stop();

  // ── Treatment: warm the pool on the same block in a separate daemon, then prepare (no route
  //    prewarm) on the SAME block → first quote should be warm ──
  const warmBlock = block;
  t = performance.now();
  await warmBackend.warmHotPools(warmBlock, [gss]);
  const warmMs = performance.now() - t;
  console.log(`[warm-smoke] warmHotPools(1 pool): ${warmMs.toFixed(0)}ms`);

  await warmBackend.prepareVictimState({ ...baseInput, baseBlock: warmBlock });
  t = performance.now();
  const warm = await warmBackend.quote(gss);
  const warmQuoteMs = performance.now() - t;
  console.log(
    `[warm-smoke] TREATMENT (warmed) first quote: ${warmQuoteMs.toFixed(0)}ms ` +
      `cache=${JSON.stringify(warm.cacheStats)} amountOut=${warm.amountOut}`,
  );

  // The warmed first quote must hit warm state (no cold misses) and be fast,
  // and must produce the SAME amountOut as the cold path (warming is correctness
  // neutral — it only changes when state is fetched, not what it is).
  assert((warm.cacheStats?.coldMisses ?? 1) === 0, `warmed quote still cold-missed: ${JSON.stringify(warm.cacheStats)}`);
  assert(warm.amountOut === cold.amountOut, `warmed quote diverged: ${warm.amountOut} vs ${cold.amountOut}`);
  assert(warmQuoteMs < coldMs, `warmed quote (${warmQuoteMs.toFixed(0)}ms) not faster than cold (${coldMs.toFixed(0)}ms)`);

  console.log("[warm-smoke] PASS — background warm makes the first quote warm without route-hop prewarm");
  coldClient.stop();
  warmClient.stop();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
