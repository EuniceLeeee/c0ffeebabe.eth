import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { aggregateVenueCandidates } from "../discovery/venue-aggregate.js";
import { extractVenueCandidates, type VenueCandidate, type VenueScanInput } from "../discovery/venue-evidence.js";
import { RpcClient, toQuantity } from "../rpc/client.js";
import { parseArgs, resolveRpcUrl, writeText } from "../util.js";

const DEFAULT_MAX_BLOCKS = 20_000;
const USAGE = `Usage: npm run venue-discovery-window -- --watch <addr[,addr]> --from-block <n> --to-block <n> [--rpc <loopback-url>] [--max-blocks <n=20000>] [--out <venues.json>]
RPC defaults to READONLY_RPC_URL, MAINNET_RPC_URL, then SEARCHER_LIVE_RPC_URL; remote credentials must not be passed in argv.`;

interface BlockWindow {
  from: number;
  to: number;
}

interface RpcReceipt {
  transactionHash?: string;
  logs?: VenueScanInput["receiptLogs"];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || Object.keys(args).length === 0) usage();

  const watch = parseWatch(stringArg(args, "watch"));
  const fromBlock = integerArg(args, "from-block");
  const toBlock = integerArg(args, "to-block");
  const maxBlocks = integerArg(args, "max-blocks", DEFAULT_MAX_BLOCKS);
  const rpcUrl = resolveRpcUrl(args);
  if (!rpcUrl) usage();
  const outPath = args.out ? resolveCliPath(String(args.out)) : "";
  validateWindow({ from: fromBlock, to: toBlock }, maxBlocks);

  const rpc = new RpcClient(rpcUrl);
  const watchSet = new Set(watch);
  const perTxCandidates: VenueCandidate[][] = [];
  let watchedTxs = 0;

  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber++) {
    const [block, rawReceipts] = await Promise.all([
      rpc.getBlockByNumber(blockNumber, true),
      rpc.call<unknown[]>("eth_getBlockReceipts", [toQuantity(blockNumber)]),
    ]);
    if (!block) throw new Error(`block ${blockNumber} not found`);

    const receipts = receiptMap(rawReceipts);
    const txs: any[] = Array.isArray(block.transactions) ? block.transactions : [];
    for (const tx of txs) {
      const from = lowerAddress(tx?.from);
      if (!watchSet.has(from)) continue;
      const txHash = lowerAddress(tx?.hash);
      if (!txHash) continue;

      watchedTxs++;
      const receipt = receipts.get(txHash);
      if (!receipt) throw new Error(`receipt for watched tx ${txHash} not found in block ${blockNumber}`);
      const input: VenueScanInput = {
        txHash,
        from,
        to: typeof tx?.to === "string" ? tx.to : undefined,
        receiptLogs: Array.isArray(receipt.logs) ? receipt.logs : [],
      };
      perTxCandidates.push(extractVenueCandidates(input));
    }
  }

  const aggregated = aggregateVenueCandidates(perTxCandidates);
  const json = `${JSON.stringify(aggregated, null, 2)}\n`;
  process.stdout.write(json);
  if (outPath) await writeText(outPath, json);
  console.error(renderHumanSummary({
    blocksScanned: toBlock - fromBlock + 1,
    watchedTxs,
    distinctCandidates: aggregated.length,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

function receiptMap(rawReceipts: unknown[]): Map<string, RpcReceipt> {
  if (!Array.isArray(rawReceipts)) throw new Error("eth_getBlockReceipts returned a non-array result");
  const byHash = new Map<string, RpcReceipt>();
  for (const receipt of rawReceipts) {
    if (!receipt || typeof receipt !== "object") continue;
    const typed = receipt as RpcReceipt;
    const hash = lowerAddress(typed.transactionHash);
    if (hash) byHash.set(hash, typed);
  }
  return byHash;
}

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

function stringArg(args: Record<string, string | boolean>, key: string): string {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  usage();
}

function integerArg(args: Record<string, string | boolean>, key: string, fallback?: number): number {
  const value = args[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") usage();
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) usage();
  return parsed;
}

function parseWatch(value: string): string[] {
  const watch = value.split(",").map((item) => lowerAddress(item.trim())).filter(Boolean);
  if (watch.length === 0 || watch.some((address) => !isAddress(address))) usage();
  return watch;
}

function validateWindow(window: BlockWindow, maxBlocks: number): void {
  if (window.from < 0 || window.to < 0 || window.from > window.to || maxBlocks < 1) usage();
  const span = window.to - window.from + 1;
  if (span > maxBlocks) {
    throw new Error(`Refusing to venue-scan ${span} blocks; pass a <=${maxBlocks} block range or raise --max-blocks`);
  }
}

function renderHumanSummary(summary: {
  blocksScanned: number;
  watchedTxs: number;
  distinctCandidates: number;
}): string {
  return [
    "[analysis/venue-discovery-window]",
    `blocks_scanned=${summary.blocksScanned}`,
    `watched_txs=${summary.watchedTxs}`,
    `distinct_candidates=${summary.distinctCandidates}`,
  ].join(" ");
}

function resolveCliPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function lowerAddress(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}
