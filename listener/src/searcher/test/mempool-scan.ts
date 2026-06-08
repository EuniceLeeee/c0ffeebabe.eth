import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";

function loadEnv(): void {
  const envPath = resolve("..", ".env");
  let text = "";
  try { text = readFileSync(envPath, "utf8"); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

loadEnv();
const rpcUrl = process.env.MAINNET_RPC_URL;
if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");

const SWAP_SELECTORS: Record<string, string> = {
  "0x3df02124": "curve.exchange",
  "0xddc1f59d": "curve.exchange+recv",
  "0x04e45aaf": "uniV3.exactInputSingle",
  "0xb858183f": "uniV3.exactInput",
  "0x414bf389": "uniV3Router.exactInputSingle",
  "0xc04b8d59": "uniV3Router.exactInput",
  "0x472b43f3": "uniV3R02.swapExact",
  "0x38ed1739": "uniV2.swapExactTFT",
  "0x7ff36ab5": "uniV2.swapExactETHFT",
  "0x18cbafe5": "uniV2.swapExactTFETH",
  "0x3593564c": "universalRouter.execute",
  "0x24856bc3": "universalRouter.execute2",
  "0x2c0198ee": "paraswap.megaSwap",
  "0x54e3f31b": "paraswap.multiSwap",
  "0x12aa3caf": "1inch.swap",
  "0x0502b1c5": "1inch.unoswapTo",
  "0xe449022e": "1inch.uniswapV3Swap",
  "0x36c78516": "1inch.swap2",
  "0x5ae401dc": "uniV3R02.multicall",
};

const wsUrl = rpcUrl.replace("https://", "wss://");
console.log(`[mempool] connecting ws...`);

let total = 0;
let swaps = 0;
let fetched = 0;
let fetchFailed = 0;
const selectorCounts = new Map<string, number>();
const startTime = Date.now();
const DURATION = 30_000;

async function run() {
  const provider = new ethers.WebSocketProvider(wsUrl);
  
  await provider.send("eth_subscribe", ["newPendingTransactions"]);
  
  provider.on("pending", async (txHash: string) => {
    total++;
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx) { fetchFailed++; return; }
      fetched++;
      if (!tx.data || tx.data.length < 10) return;
      
      const sel = tx.data.slice(0, 10).toLowerCase();
      const name = SWAP_SELECTORS[sel];
      if (!name) return;
      
      swaps++;
      selectorCounts.set(name, (selectorCounts.get(name) ?? 0) + 1);
      
      if (swaps <= 15) {
        console.log(
          `[mempool] SWAP: ${name} to=${tx.to?.slice(0, 12)}...`
        );
      }
    } catch { fetchFailed++; }
    
    if (Date.now() - startTime > DURATION) {
      printSummary();
      provider.destroy();
      process.exit(0);
    }
  });
  
  setTimeout(() => {
    printSummary();
    provider.destroy();
    process.exit(0);
  }, DURATION + 3000);
}

function printSummary() {
  console.log(`\n[mempool] === 30s summary ===`);
  console.log(`[mempool] pending hashes seen: ${total}`);
  console.log(`[mempool] fetched tx details: ${fetched}`);
  console.log(`[mempool] fetch failed (private/dropped): ${fetchFailed}`);
  console.log(`[mempool] swaps detected: ${swaps} (${(swaps / 30).toFixed(1)}/s)`);
  console.log(`[mempool] fetch rate: ${((fetched / total) * 100).toFixed(1)}%`);
  const sorted = [...selectorCounts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    console.log(`[mempool] swap breakdown:`);
    for (const [name, count] of sorted) {
      console.log(`  ${name}: ${count}`);
    }
  }
}

run().catch((err) => {
  console.error(`[mempool] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
