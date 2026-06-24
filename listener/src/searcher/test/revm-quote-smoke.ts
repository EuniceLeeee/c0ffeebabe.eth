import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { DEFAULT_SEARCHER_OWNER } from "../../shared/executor/botvm-executor.js";
import { buildTokenGraph, type PoolEntry } from "../planner/token-graph.js";
import { quote as rpcQuote } from "../solver/quoter.js";
import { RevmSimClient } from "../revm-sim-client.js";
import { RevmLiveBackend } from "../live-backends/revm-live-backend.js";

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

const POOLS: PoolEntry[] = [
  { address: ADDR.UNISWAP_V3_USDC_WETH_100, adapter: "univ3" },
  { address: ADDR.CURVE_3POOL, adapter: "curve" },
  {
    address: ADDR.SKY_PSM_LITE,
    adapter: "psm",
    fixedTokenIn: ADDR.USDC,
    fixedTokenOut: ADDR.DAI,
    fixedSlotKind: "swap",
  },
];

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const block = await provider.getBlockNumber();
  const callAtBlock = {
    call: async (req: { to: string; data: string }) => provider.call({ ...req, blockTag: block }),
  };
  const graph = await buildTokenGraph(callAtBlock, POOLS);
  const client = new RevmSimClient({
    timeoutMs: Number(process.env.SEARCHER_REVM_TIMEOUT_MS ?? "60000"),
  });
  const executor = ethers.getAddress(process.env.BOTVM_ADDRESS ?? ADDR.ZERO);
  const owner = ethers.getAddress(process.env.BOTVM_OWNER ?? DEFAULT_SEARCHER_OWNER);
  const backend = new RevmLiveBackend(client, executor, owner, provider, graph, rpcUrl);
  await backend.prepareVictimState({
    event: {
      txHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      blockNumber: block,
      rawTx: "0x",
      from: ethers.ZeroAddress,
      nonce: 0,
      to: null,
      input: "0x",
      logs: [],
      minProfit: 0n,
    },
    impact: null,
    baseBlock: block,
    path: "mined",
  });

  const cases = [
    {
      name: "univ3-usdc-weth",
      adapterId: "univ3-swap",
      target: ADDR.UNISWAP_V3_USDC_WETH_100,
      tokenIn: ADDR.USDC,
      tokenOut: ADDR.WETH,
      amountIn: 1_000_000n,
    },
    {
      name: "curve-3pool-usdc-usdt",
      adapterId: "curve-exchange-plain",
      target: ADDR.CURVE_3POOL,
      tokenIn: ADDR.USDC,
      tokenOut: ADDR.USDT,
      amountIn: 1_000_000n,
    },
    {
      name: "psm-usdc-dai",
      adapterId: "psm",
      target: ADDR.SKY_PSM_LITE,
      tokenIn: ADDR.USDC,
      tokenOut: ADDR.DAI,
      amountIn: 1_000_000n,
    },
  ];

  let passed = 0;
  for (const c of cases) {
    const [rpcOut, revmCold] = await Promise.all([
      rpcQuote(
        c.adapterId,
        c.target,
        c.tokenIn,
        c.tokenOut,
        c.amountIn,
        callAtBlock as any,
      ),
      backend.quote(c),
    ]);
    const revmWarm = await backend.quote(c);
    const diff = rpcOut > revmCold.amountOut ? rpcOut - revmCold.amountOut : revmCold.amountOut - rpcOut;
    const warmDiff = revmCold.amountOut > revmWarm.amountOut
      ? revmCold.amountOut - revmWarm.amountOut
      : revmWarm.amountOut - revmCold.amountOut;
    const warmOk = warmDiff <= 1n && revmWarm.latencyMs <= Math.max(100, Math.floor(revmCold.latencyMs / 10));
    const ok = diff <= 1n && warmOk;
    if (ok) passed++;
    console.log(
      `[revm-quote] ${c.name} rpc=${rpcOut} revm=${revmCold.amountOut} ` +
        `diff=${diff} coldMs=${revmCold.latencyMs} warmMs=${revmWarm.latencyMs} ` +
        `warmDiff=${warmDiff} ` +
        `cache=${formatCacheStats(revmWarm.cacheStats)} ${ok ? "PASS" : "FAIL"}`,
    );
  }
  client.stop();
  if (passed !== cases.length) {
    throw new Error(`revm quote smoke failed: ${passed}/${cases.length}`);
  }
  console.log(`[revm-quote] PASS ${passed}/${cases.length}`);
}

function formatCacheStats(stats: { warmHits: number; coldMisses: number } | undefined): string {
  if (!stats) return "n/a";
  const total = stats.warmHits + stats.coldMisses;
  const ratio = total === 0 ? 100 : Math.floor((stats.warmHits * 10_000) / total);
  return `${stats.warmHits}/${total}(${ratio}bps)`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
