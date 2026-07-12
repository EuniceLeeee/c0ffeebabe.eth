import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchEthUsd, priceArb } from "../pnl/arb-profit.js";
import { classifyTxShape, type RawLog } from "../pnl/tx-shape.js";
import { lower, TOPICS } from "../registry/protocols.js";
import { hexToBigInt, RpcClient, toQuantity } from "../rpc/client.js";
import { parseArgs, writeText } from "../util.js";
import { strategyKindFromTxShape, type StrategyKind } from "../../../listener/src/searcher/strategy-taxonomy.js";
import {
  classifyWinnerTxStyle,
  extractOtherVenues,
  extractTouchedVenues,
  isNonComparableWinnerStyle,
  loadGraphMembership,
  type GraphMembership,
  type OtherVenue,
  type TouchedVenue,
  type WinnerStyle,
} from "./bundle-postmortem.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_POOLS_DIR = resolve(REPO_ROOT, "listener/searcher/pools");
const DEFAULT_GRAPH_PATH = resolve(DEFAULT_POOLS_DIR, "runtime-graph-pools.json");
// Coverage/learning stage: a pool a competitor PROFITABLY arbed is itself the arb-relevance signal,
// so admit everything above a noise floor (filters valuation artifacts / failed-arb dust), not a
// "be picky" floor. Raise this once past the coverage phase.
const DEFAULT_MIN_PROFIT_USD = 0.1;
const DEFAULT_MAX_BLOCKS = 1000;
type TxShape = "atomic_state_arb" | "backrun" | "unknown";
export type CensusVenue = TouchedVenue | OtherVenue;

const TX_SHAPE_SWAP_TOPICS = [
  TOPICS.univ2Swap,
  TOPICS.univ3Swap,
  TOPICS.univ4Swap,
  TOPICS.curveTokenExchange,
  TOPICS.curveTokenExchangeUnderlying,
  TOPICS.balancerV2Swap,
].map(lower);

const USAGE = `Usage: npm run census-report -- --watch <addr[,addr]> --from-block <n> --to-block <n> --rpc <url> [--graph <runtime-graph-pools.json>] [--min-profit-usd <n=0.1>] [--max-blocks <n=1000>] [--out <report.json>]`;

interface BlockWindow {
  from: number;
  to: number;
}

export interface CensusPerTx {
  hash: string;
  from: string;
  realizedUsd: number | null;
  touchedVenues: CensusVenue[];
  txIndex?: number;
  receiptLogs?: RawLog[];
  sameBlockSwapLogs?: RawLog[];
  winner_style?: WinnerStyle;
  winner_moved_price_beyond_prestate?: boolean;
  unpriced_token_in_flow?: string[];
}

export interface AnalyzedCompetitor {
  hash: string;
  from: string;
  realized_profit_usd: number;
  touchedVenues: CensusVenue[];
  tx_shape: TxShape;
  strategy_kind: StrategyKind | "unknown";
  winner_style: WinnerStyle;
  non_comparable_winner?: boolean;
  winner_moved_price_beyond_prestate?: boolean;
  unpriced_token_in_flow?: string[];
}

export interface MatchedCompetitor {
  hash: string;
  from: string;
  realized_profit_usd: number | null;
  winner_style: WinnerStyle | "unknown";
  non_comparable_winner?: boolean;
  all_venues_in_graph: boolean;
}

export interface CensusReport {
  command: "census-report";
  verdict: {
    route_gap_decisive: boolean;
  };
  /** EVERY watch-matched take, unfiltered. analyzed_competitors below is the ROUTE-GAP subset
   *  (out-of-graph venue + above min-profit) — consumers doing per-block "why didn't we win"
   *  joins (census-gap) must read THIS list: an all-in-graph take is exactly the case where we
   *  could have competed, and the loss-focused filter would silently hide it. */
  matched_competitors: MatchedCompetitor[];
  analyzed_competitors: AnalyzedCompetitor[];
  summary: {
    window: BlockWindow;
    watch: string[];
    matched_txs: number;
    qualifying_txs: number;
    skipped_below_profit: number;
    distinct_out_of_graph: {
      univ2: number;
      univ3: number;
      univ4: number;
      other: number;
    };
    net_realized_usd: number;
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || Object.keys(args).length === 0) usage();

  const watch = parseWatch(stringArg(args, "watch"));
  const fromBlock = integerArg(args, "from-block");
  const toBlock = integerArg(args, "to-block");
  const rpcUrl = stringArg(args, "rpc");
  const minProfitUsd = numberArg(args, "min-profit-usd", DEFAULT_MIN_PROFIT_USD);
  const maxBlocks = integerArg(args, "max-blocks", DEFAULT_MAX_BLOCKS);
  const outPath = args.out ? resolveCliPath(String(args.out)) : "";
  const graphPath = args.graph ? resolveCliPath(String(args.graph)) : DEFAULT_GRAPH_PATH;
  validateWindow({ from: fromBlock, to: toBlock }, maxBlocks);

  const graph = loadGraphMembership(graphPath);
  if (graph.status !== "loaded") {
    throw new Error(`Graph membership unavailable at ${graph.path}; pass --graph with a readable runtime-graph-pools.json`);
  }

  const rpc = new RpcClient(rpcUrl);
  const ethUsd = await fetchEthUsd(rpc);
  const watchSet = new Set(watch);
  const perTx: CensusPerTx[] = [];

  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber++) {
    const block = await rpc.getBlockByNumber(blockNumber, true);
    const baseFeePerGas = block?.baseFeePerGas != null ? hexToBigInt(block.baseFeePerGas) : 0n;
    const coinbase = lower(String(block?.miner ?? ""));
    const txs: any[] = Array.isArray(block?.transactions) ? block.transactions : [];
    const matches = txs.filter((tx) => txMatchesWatch(tx, watchSet));
    const sameBlockSwapLogs = matches.length > 0
      ? await fetchSameBlockSwapLogs(rpc, blockNumber, txs)
      : [];

    for (const tx of matches) {
      const hash = lower(String(tx?.hash ?? ""));
      if (!hash) continue;
      const receipt = await rpc.getReceipt(hash);
      if (!receipt || receipt.status !== "0x1") continue;
      const profit = await priceArb(rpc, hash, tx, receipt, ethUsd, {
        entityActors: [tx?.to, tx?.from].filter((actor): actor is string => typeof actor === "string" && actor.length > 0),
        allowTrace: true,
        coinbase,
        baseFeePerGas,
      });
      const winnerStyle = await classifyWinnerTxStyle({
        rpc,
        txHash: hash,
        tx,
        receipt,
        profit,
        transactionIndex: Number(hexToBigInt(receipt?.transactionIndex ?? tx?.transactionIndex)),
        blockNumber,
        prestateBlock: Math.max(blockNumber - 1, 0),
      });
      perTx.push({
        hash,
        from: lower(String(tx?.from ?? receipt?.from ?? "")),
        realizedUsd: profit.realizedProfitUsd,
        touchedVenues: [
          ...extractTouchedVenues(receipt, graph),
          ...extractOtherVenues(receipt, graph),
        ],
        txIndex: Number(hexToBigInt(receipt?.transactionIndex ?? tx?.transactionIndex)),
        receiptLogs: receipt?.logs,
        sameBlockSwapLogs,
        winner_style: winnerStyle.winner_style,
        winner_moved_price_beyond_prestate: winnerStyle.winner_moved_price_beyond_prestate,
        unpriced_token_in_flow: winnerStyle.unpriced_token_in_flow,
      });
    }
  }

  const report = buildCensusReport(perTx, minProfitUsd, { from: fromBlock, to: toBlock }, watch);
  const json = `${JSON.stringify(report, jsonReplacer, 2)}\n`;
  process.stdout.write(json);
  if (outPath) await writeText(outPath, json);
  console.error(renderHumanSummary(report, graph, minProfitUsd));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export function buildCensusReport(
  perTx: CensusPerTx[],
  minProfitUsd: number,
  window: BlockWindow,
  watch: string[],
): CensusReport {
  const analyzed: AnalyzedCompetitor[] = [];
  const distinct = {
    univ2: new Set<string>(),
    univ3: new Set<string>(),
    univ4: new Set<string>(),
    other: new Set<string>(),
  };
  let skippedBelowProfit = 0;

  for (const tx of perTx) {
    const realized = tx.realizedUsd;
    if (realized === null || realized < minProfitUsd) {
      skippedBelowProfit++;
      continue;
    }
    if (!tx.touchedVenues.some((venue) => venue.in_graph === false)) continue;
    const winnerStyle = tx.winner_style ?? "unknown";
    const nonComparable = isNonComparableWinnerStyle(winnerStyle);
    // Keep the competitor visible, but do not feed non-comparable missing venues to route-gap closure.
    const coverageTouchedVenues = nonComparable
      ? tx.touchedVenues.filter((venue) => venue.in_graph !== false)
      : tx.touchedVenues;
    const txShape = classifyCensusTxShape(tx);

    analyzed.push({
      hash: lower(tx.hash),
      from: lower(tx.from),
      realized_profit_usd: realized,
      touchedVenues: coverageTouchedVenues,
      tx_shape: txShape,
      strategy_kind: strategyKindFromTxShape(txShape),
      winner_style: winnerStyle,
      non_comparable_winner: nonComparable ? true : undefined,
      winner_moved_price_beyond_prestate: tx.winner_moved_price_beyond_prestate,
      unpriced_token_in_flow: tx.unpriced_token_in_flow,
    });
    if (nonComparable) continue;
    for (const venue of tx.touchedVenues) {
      if (venue.in_graph !== false) continue;
      if (isUniVenueProtocol(venue.protocol)) {
        distinct[venue.protocol].add(lower(venue.id));
      } else {
        distinct.other.add(`${lower(venue.protocol)}:${lower(venue.id)}`);
      }
    }
  }

  return {
    command: "census-report",
    verdict: {
      route_gap_decisive: analyzed.some((tx) => !tx.non_comparable_winner),
    },
    matched_competitors: perTx.map((tx) => ({
      hash: tx.hash,
      from: tx.from,
      realized_profit_usd: tx.realizedUsd,
      winner_style: tx.winner_style ?? "unknown",
      non_comparable_winner: tx.winner_style ? (isNonComparableWinnerStyle(tx.winner_style) || undefined) : undefined,
      all_venues_in_graph: !tx.touchedVenues.some((venue) => venue.in_graph === false),
    })),
    analyzed_competitors: analyzed,
    summary: {
      window,
      watch: watch.map(lower),
      matched_txs: perTx.length,
      qualifying_txs: analyzed.filter((tx) => !tx.non_comparable_winner).length,
      skipped_below_profit: skippedBelowProfit,
      distinct_out_of_graph: {
        univ2: distinct.univ2.size,
        univ3: distinct.univ3.size,
        univ4: distinct.univ4.size,
        other: distinct.other.size,
      },
      net_realized_usd: analyzed.reduce((sum, tx) => tx.non_comparable_winner ? sum : sum + tx.realized_profit_usd, 0),
    },
  };
}

export async function fetchSameBlockSwapLogs(
  rpc: Pick<RpcClient, "getLogs">,
  blockNumber: number,
  transactions: any[],
): Promise<RawLog[]> {
  const txToByHash = new Map<string, string | null>();
  for (const tx of transactions) {
    const hash = lower(String(tx?.hash ?? ""));
    if (!hash) continue;
    txToByHash.set(hash, typeof tx?.to === "string" ? lower(tx.to) : null);
  }

  const logs = await rpc.getLogs({
    fromBlock: toQuantity(blockNumber),
    toBlock: toQuantity(blockNumber),
    topics: [TX_SHAPE_SWAP_TOPICS],
  });
  return logs.map((log) => ({
    address: lower(String(log?.address ?? "")),
    topics: Array.isArray(log?.topics) ? log.topics.map((topic: unknown) => lower(String(topic))) : [],
    data: String(log?.data ?? "0x"),
    logIndex: Number(hexToBigInt(log?.logIndex)),
    transactionIndex: Number(hexToBigInt(log?.transactionIndex)),
    transactionHash: lower(String(log?.transactionHash ?? "")),
    txTo: txToByHash.get(lower(String(log?.transactionHash ?? ""))) ?? null,
  }));
}

function isUniVenueProtocol(protocol: string): protocol is TouchedVenue["protocol"] {
  return protocol === "univ2" || protocol === "univ3" || protocol === "univ4";
}

function classifyCensusTxShape(tx: CensusPerTx): TxShape {
  if (
    typeof tx.txIndex !== "number"
    || !Array.isArray(tx.receiptLogs)
    || !Array.isArray(tx.sameBlockSwapLogs)
  ) {
    return "unknown";
  }
  return classifyTxShape({
    receiptLogs: tx.receiptLogs,
    txIndex: tx.txIndex,
    sameBlockSwapLogs: tx.sameBlockSwapLogs,
  }).shape;
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

function numberArg(args: Record<string, string | boolean>, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") usage();
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) usage();
  return parsed;
}

function parseWatch(value: string): string[] {
  const watch = value.split(",").map((item) => lower(item.trim())).filter(Boolean);
  if (watch.length === 0 || watch.some((address) => !isAddress(address))) usage();
  return watch;
}

function validateWindow(window: BlockWindow, maxBlocks: number): void {
  if (window.from < 0 || window.to < 0 || window.from > window.to || maxBlocks < 1) usage();
  const span = window.to - window.from + 1;
  if (span > maxBlocks) {
    throw new Error(`Refusing to census-scan ${span} blocks; pass a <=${maxBlocks} block range or raise --max-blocks`);
  }
}

function txMatchesWatch(tx: any, watchSet: Set<string>): boolean {
  const from = lower(String(tx?.from ?? ""));
  const to = lower(String(tx?.to ?? ""));
  return watchSet.has(from) || watchSet.has(to);
}

function resolveCliPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function renderHumanSummary(report: CensusReport, graph: GraphMembership, minProfitUsd: number): string {
  const { summary } = report;
  return [
    "[analysis/census-report]",
    `blocks=${summary.window.from}-${summary.window.to}`,
    `watch=${summary.watch.length}`,
    `graph_entries=${graph.entries}`,
    `min_profit_usd=${minProfitUsd}`,
    `matched=${summary.matched_txs}`,
    `qualifying=${summary.qualifying_txs}`,
    `route_gap_decisive=${String(report.verdict.route_gap_decisive)}`,
    `net_realized_usd=${summary.net_realized_usd.toFixed(2)}`,
  ].join(" ");
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Set ? [...value] : typeof value === "bigint" ? value.toString() : value;
}
