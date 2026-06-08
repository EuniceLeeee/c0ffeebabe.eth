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
const provider = new ethers.JsonRpcProvider(rpcUrl);

const UNIV3_SWAP = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const UNIV2_SWAP = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const CURVE_TOKEN_EXCHANGE = ethers.id("TokenExchange(address,int128,uint256,int128,uint256)");

// Lending / borrow events
const AAVE_BORROW = ethers.id("Borrow(address,address,address,uint256,uint8,uint256,uint16)");
const AAVE_SUPPLY = ethers.id("Supply(address,address,address,uint256,uint16)");
const COMPOUND_SUPPLY = ethers.id("Supply(address,uint256)");

interface TopicScan {
  name: string;
  topic: string;
  protocol: "univ3" | "univ2" | "curve" | "aave" | "compound";
}

const SCANS: TopicScan[] = [
  { name: "UniV3 Swap", topic: UNIV3_SWAP, protocol: "univ3" },
  { name: "UniV2 Swap", topic: UNIV2_SWAP, protocol: "univ2" },
  { name: "Curve TokenExchange", topic: CURVE_TOKEN_EXCHANGE, protocol: "curve" },
  { name: "Aave Borrow", topic: AAVE_BORROW, protocol: "aave" },
  { name: "Aave Supply", topic: AAVE_SUPPLY, protocol: "aave" },
];

const BLOCKS_1H = 300;
const BATCH_SIZE = 50; // blocks per getLogs call to stay under RPC limits

interface PoolActivity {
  address: string;
  protocol: string;
  count: number;
}

async function scanTopic(
  scan: TopicScan,
  fromBlock: number,
  toBlock: number,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  for (let start = fromBlock; start <= toBlock; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, toBlock);
    try {
      const logs = await provider.send("eth_getLogs", [{
        fromBlock: "0x" + start.toString(16),
        toBlock: "0x" + end.toString(16),
        topics: [scan.topic],
      }]);
      for (const log of logs) {
        const addr = log.address.toLowerCase();
        counts.set(addr, (counts.get(addr) ?? 0) + 1);
      }
    } catch (err) {
      // Some batches may be too large; split further
      if (BATCH_SIZE > 10) {
        for (let s = start; s <= end; s += 10) {
          const e = Math.min(s + 9, end);
          try {
            const logs = await provider.send("eth_getLogs", [{
              fromBlock: "0x" + s.toString(16),
              toBlock: "0x" + e.toString(16),
              topics: [scan.topic],
            }]);
            for (const log of logs) {
              const addr = log.address.toLowerCase();
              counts.set(addr, (counts.get(addr) ?? 0) + 1);
            }
          } catch { /* skip */ }
        }
      }
    }
  }

  return counts;
}

async function main() {
  const latest = await provider.getBlockNumber();
  const from1h = latest - BLOCKS_1H;

  console.log(`[scan] latest block: ${latest}`);
  console.log(`[scan] scanning ${BLOCKS_1H} blocks (${from1h} → ${latest})\n`);

  const allPools = new Map<string, PoolActivity>();

  for (const scan of SCANS) {
    console.log(`[scan] ${scan.name}...`);
    const counts = await scanTopic(scan, from1h, latest);

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`  ${counts.size} unique pools, ${sorted.reduce((s, [, c]) => s + c, 0)} total events`);

    if (sorted.length > 0) {
      console.log(`  top 10:`);
      for (const [addr, count] of sorted.slice(0, 10)) {
        console.log(`    ${addr} ${count} events`);
      }
    }
    console.log();

    for (const [addr, count] of counts) {
      const existing = allPools.get(addr);
      if (!existing || existing.count < count) {
        allPools.set(addr, { address: addr, protocol: scan.protocol, count });
      }
    }
  }

  // Overall top pools
  const ranked = [...allPools.values()].sort((a, b) => b.count - a.count);
  console.log(`\n[scan] === TOP 30 ACTIVE POOLS (last 1h) ===`);
  console.log(`${"#".padStart(3)} ${"address".padEnd(44)} ${"protocol".padEnd(10)} events`);
  for (let i = 0; i < Math.min(30, ranked.length); i++) {
    const p = ranked[i];
    console.log(`${String(i + 1).padStart(3)} ${p.address.padEnd(44)} ${p.protocol.padEnd(10)} ${p.count}`);
  }
  console.log(`\n[scan] total unique pools: ${allPools.size}`);
}

main().catch((err) => {
  console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
