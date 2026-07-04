import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import {
  appendForceIncludeRouters,
  DEFAULT_FORCE_INCLUDE_ROUTERS_PATH,
} from "./force-include.js";
import { buildMempoolToAddressFilter } from "./main.js";

export interface BlockData {
  number: number;
  txs: { to: string | null; from: string }[];
  receipts: { to: string | null; logs: { address: string; topics: string[] }[] }[];
}

export interface DiscoverRoutersOptions {
  fromBlock: number;
  toBlock: number;
  allowlist: Set<string>;
  minTxs?: number;
  minPools?: number;
  minCallers?: number;
  maxAdd?: number;
  fetchBlock: (n: number) => Promise<BlockData>;
  forceIncludePath?: string;
  append?: boolean;
}

export interface RouterCandidate {
  address: string;
  txs: number;
  pools: number;
  callers: number;
}

export interface DiscoverRoutersResult {
  candidates: RouterCandidate[];
  qualified: RouterCandidate[];
  added: string[];
}

const V2_SWAP_TOPIC0 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3_SWAP_TOPIC0 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V4_SWAP_TOPIC0 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const SWAP_TOPIC0S = new Set([V2_SWAP_TOPIC0, V3_SWAP_TOPIC0, V4_SWAP_TOPIC0]);

interface MutableStats {
  address: string;
  txs: number;
  pools: Set<string>;
  swaps: number;
}

interface CliArgs {
  rpcUrl: string;
  blocks: number;
  minTxs: number;
  minPools: number;
  minCallers: number;
  maxAdd: number;
  forceIncludePath?: string;
  dryRun: boolean;
  outPath?: string;
}

const DISCOVER_USAGE =
  "usage: npm run discover-routers -- [--rpc <url>] [--blocks <n>] " +
  "[--min-txs <n>] [--min-pools <n>] [--min-callers <n>] [--max-add <n>] " +
  "[--force-include <path>] [--dry-run] [--out <report.json>]";

export async function discoverRouters(
  opts: DiscoverRoutersOptions,
): Promise<DiscoverRoutersResult> {
  if (opts.toBlock < opts.fromBlock) {
    throw new Error(`toBlock ${opts.toBlock} is before fromBlock ${opts.fromBlock}`);
  }

  const minTxs = opts.minTxs ?? 20;
  const minPools = opts.minPools ?? 5;
  const minCallers = opts.minCallers ?? 8;
  const maxAdd = opts.maxAdd ?? 40;
  const allowlist = new Set([...opts.allowlist].map((addr) => addr.toLowerCase()));
  const statsByTo = new Map<string, MutableStats>();
  const callersByTo = new Map<string, Set<string>>();

  for (let blockNumber = opts.fromBlock; blockNumber <= opts.toBlock; blockNumber++) {
    const block = await opts.fetchBlock(blockNumber);
    const txsByIndex = block.txs.map((tx) => {
      const to = normalizeAddress(tx.to);
      if (!to) return null;
      const key = to.toLowerCase();
      if (allowlist.has(key)) return null;

      const from = normalizeAddress(tx.from);
      if (from) getSet(callersByTo, key).add(from.toLowerCase());
      return { to, key };
    });

    for (let i = 0; i < block.receipts.length; i++) {
      const receipt = block.receipts[i];
      const txTo = txsByIndex[i];
      const to = normalizeAddress(receipt.to) ?? txTo?.to ?? null;
      if (!to) continue;

      const key = to.toLowerCase();
      if (allowlist.has(key)) continue;

      const swapLogs = receipt.logs.filter((log) => isSwapLog(log));
      if (swapLogs.length === 0) continue;

      const stats = getStats(statsByTo, to);
      stats.txs++;
      stats.swaps += swapLogs.length;
      for (const log of swapLogs) {
        const pool = normalizeAddress(log.address);
        if (pool) stats.pools.add(pool.toLowerCase());
      }
    }
  }

  const candidates = [...statsByTo.entries()]
    .map(([key, stats]) => ({
      address: stats.address,
      txs: stats.txs,
      pools: stats.pools.size,
      callers: callersByTo.get(key)?.size ?? 0,
    }))
    .sort(compareCandidates);

  const qualified = candidates
    .filter((candidate) =>
      candidate.txs >= minTxs &&
      candidate.pools >= minPools &&
      candidate.callers >= minCallers,
    )
    .slice(0, Math.max(0, maxAdd));

  let added: string[] = [];
  if (opts.append !== false && qualified.length > 0) {
    added = appendForceIncludeRouters(
      qualified.map((candidate) => candidate.address),
      opts.forceIncludePath,
    ).added;
  }

  return { candidates, qualified, added };
}

function isSwapLog(log: { topics: string[] }): boolean {
  const topic0 = log.topics[0];
  return typeof topic0 === "string" && SWAP_TOPIC0S.has(topic0.toLowerCase());
}

function getStats(statsByTo: Map<string, MutableStats>, address: string): MutableStats {
  const checksummed = ethers.getAddress(address);
  const key = checksummed.toLowerCase();
  const existing = statsByTo.get(key);
  if (existing) return existing;
  const stats = { address: checksummed, txs: 0, pools: new Set<string>(), swaps: 0 };
  statsByTo.set(key, stats);
  return stats;
}

function getSet(map: Map<string, Set<string>>, key: string): Set<string> {
  const existing = map.get(key);
  if (existing) return existing;
  const set = new Set<string>();
  map.set(key, set);
  return set;
}

function compareCandidates(a: RouterCandidate, b: RouterCandidate): number {
  return (
    b.txs - a.txs ||
    b.pools - a.pools ||
    b.callers - a.callers ||
    a.address.localeCompare(b.address)
  );
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

async function fetchBlockFromRpc(
  provider: ethers.JsonRpcProvider,
  n: number,
): Promise<BlockData> {
  const [block, rawReceipts] = await Promise.all([
    provider.getBlock(n, true),
    provider.send("eth_getBlockReceipts", [ethers.toQuantity(n)]),
  ]);
  if (!block) throw new Error(`block ${n} not found`);

  return {
    number: n,
    txs: block.prefetchedTransactions.map((tx) => ({ to: tx.to, from: tx.from })),
    receipts: parseRpcReceipts(rawReceipts),
  };
}

function parseRpcReceipts(value: unknown): BlockData["receipts"] {
  if (!Array.isArray(value)) throw new Error("eth_getBlockReceipts returned a non-array value");
  return value.map((receipt) => {
    if (!isRecord(receipt)) return { to: null, logs: [] };
    const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
    return {
      to: typeof receipt.to === "string" ? receipt.to : null,
      logs: logs.map((log) => {
        if (!isRecord(log)) return { address: "", topics: [] };
        return {
          address: typeof log.address === "string" ? log.address : "",
          topics: Array.isArray(log.topics)
            ? log.topics.filter((topic): topic is string => typeof topic === "string")
            : [],
        };
      }),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(args: string[]): CliArgs {
  let rpcUrl = process.env.MAINNET_RPC_URL ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";
  let blocks = 600;
  let minTxs = 20;
  let minPools = 5;
  let minCallers = 8;
  let maxAdd = 40;
  let forceIncludePath: string | undefined;
  let dryRun = false;
  let outPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--rpc") {
      rpcUrl = takeValue(args, ++i, "--rpc");
    } else if (arg === "--blocks") {
      blocks = parsePositiveInt(takeValue(args, ++i, "--blocks"), "--blocks");
    } else if (arg === "--min-txs") {
      minTxs = parseNonNegativeInt(takeValue(args, ++i, "--min-txs"), "--min-txs");
    } else if (arg === "--min-pools") {
      minPools = parseNonNegativeInt(takeValue(args, ++i, "--min-pools"), "--min-pools");
    } else if (arg === "--min-callers") {
      minCallers = parseNonNegativeInt(takeValue(args, ++i, "--min-callers"), "--min-callers");
    } else if (arg === "--max-add") {
      maxAdd = parseNonNegativeInt(takeValue(args, ++i, "--max-add"), "--max-add");
    } else if (arg === "--force-include") {
      forceIncludePath = takeValue(args, ++i, "--force-include");
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--out") {
      outPath = takeValue(args, ++i, "--out");
    } else if (arg === "--help" || arg === "-h") {
      console.log(DISCOVER_USAGE);
      process.exit(0);
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }

  return {
    rpcUrl,
    blocks,
    minTxs,
    minPools,
    minCallers,
    maxAdd,
    forceIncludePath,
    dryRun,
    outPath,
  };
}

function takeValue(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = new ethers.JsonRpcProvider(args.rpcUrl);
  const latest = await provider.getBlockNumber();
  const toBlock = latest;
  const fromBlock = Math.max(0, latest - args.blocks + 1);
  const forceIncludePath = args.forceIncludePath ?? DEFAULT_FORCE_INCLUDE_ROUTERS_PATH;
  const allowlist = new Set(
    buildMempoolToAddressFilter([], forceIncludePath).map((addr) => addr.toLowerCase()),
  );

  const result = await discoverRouters({
    fromBlock,
    toBlock,
    allowlist,
    minTxs: args.minTxs,
    minPools: args.minPools,
    minCallers: args.minCallers,
    maxAdd: args.maxAdd,
    fetchBlock: (n) => fetchBlockFromRpc(provider, n),
    forceIncludePath,
    append: !args.dryRun,
  });

  const added = new Set(result.added.map((addr) => addr.toLowerCase()));
  const printed = args.dryRun
    ? result.qualified
    : result.qualified.filter((candidate) => added.has(candidate.address.toLowerCase()));
  for (const candidate of printed) {
    const prefix = args.dryRun ? "would-add" : "added";
    console.log(
      `[discover-routers] ${prefix} ${candidate.address} ` +
        `txs=${candidate.txs} pools=${candidate.pools} callers=${candidate.callers}`,
    );
  }
  console.log(
    `[discover-routers] scanned ${fromBlock}-${toBlock} candidates=${result.candidates.length} ` +
      `qualified=${result.qualified.length} added=${result.added.length}` +
      (args.dryRun ? " dryRun=true" : ""),
  );

  if (args.outPath) {
    const report = {
      fromBlock,
      toBlock,
      dryRun: args.dryRun,
      minTxs: args.minTxs,
      minPools: args.minPools,
      minCallers: args.minCallers,
      maxAdd: args.maxAdd,
      result,
    };
    mkdirSync(dirname(args.outPath), { recursive: true });
    writeFileSync(args.outPath, JSON.stringify(report, null, 2) + "\n");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[discover-routers] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    console.error(DISCOVER_USAGE);
    process.exit(1);
  });
}
