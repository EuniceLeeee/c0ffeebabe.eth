import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { decodeTransfer } from "../decode/erc20.js";
import { deriveEdgeKindsFromLogs } from "../learning/edge-kinds.js";
import type { LearningCase, PrimaryGap } from "../learning/learning-case.js";
import {
  builderPaymentWeiFromPrestate,
  fetchEthUsd,
  priceArb,
} from "../pnl/arb-profit.js";
import { ADDR, lower, TOPICS } from "../registry/protocols.js";
import { hexToBigInt, RpcClient, toQuantity } from "../rpc/client.js";
import type { TokenDelta } from "../types.js";
import { parseArgs, uniq, writeText } from "../util.js";
import type { EdgeKind } from "../../../listener/src/searcher/strategy-taxonomy.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_POOLS_DIR = resolve(REPO_ROOT, "listener/searcher/pools");
const DEFAULT_GRAPH_PATH = resolve(DEFAULT_POOLS_DIR, "runtime-graph-pools.json");
const UNIV4_POOL_MANAGER = lower(ADDR.UNIV4_POOL_MANAGER);
const TOPIC_UNIV4_SWAP = lower(TOPICS.univ4Swap);
const TOPIC_UNIV3_SWAP = lower(TOPICS.univ3Swap);
const TOPIC_UNIV2_SWAP = lower((TOPICS as Record<string, string>).univ2Swap ?? "");
const TOPIC_TRANSFER = lower(TOPICS.transfer);
const V3_SLOT0_SELECTOR = "0x3850c7bd";
const V3_SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);
const FRAX = "0x853d955acef822db058eb8505911ed77f175b99e";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
const INVENTORY_PRICED_TOKENS = new Set([
  lower(ADDR.WETH),
  lower(ADDR.USDC),
  lower(ADDR.USDT),
  lower(ADDR.DAI),
  FRAX,
  WBTC,
]);
const UNPRICED_DUST_RAW = 1000n; // observed residuals were exactly -1 raw unit

export type WinnerStyle =
  | "atomic_loop"
  | "one_leg_inventory"
  | "inventory_vault_rebalance"
  | "sandwich"
  | "unknown";
export type TickDirection = "down" | "up";

// Atomicity / inventory-rebalance detector (ref decision-log F-009). A flash-wrapped inventory
// rebalance through private vault-wrapper contracts (e.g. 0x9be73297: steakUSDC/steakUSDT) presents
// a CLEAN executor intra-tx net (+profit only) and a closed-loop flash flow, so it otherwise
// misclassifies as atomic_loop and pollutes atomic-arb competitor analysis. It is NOT ours: it needs
// pre-held vault-share inventory (~$2.9M) and leaves a residual position in helper contracts.
//
// Layer 1 (operator directive — flag by FUNCTION/selector, NOT by contract, because the SAME
// contract's deposit/redeem are legit protocol-arb calls): a hardcoded set of ERC4626 vault-share
// rebalance selectors observed as the inventory legs of 0x9be73297. To avoid over-flagging a plain
// atomic ERC4626 arb (which also calls deposit/redeem but round-trips to ~zero net shares), the
// selector hit is corroborated by Layer 2.
//
// Layer 2 (robust general signal): per-tx ERC4626/vault-share NET mint/burn imbalance from the
// receipt — sum Transfer to/from 0x0 per share token; a nonzero net for any token ⇒ a residual
// standing position ⇒ inventory/non-atomic. This catches the class generally (not just the hardcoded
// selector) and is what makes the selector hit safe. A bot-cluster before/after-block balance check
// is a documented future upgrade (F-009). Pure receipt computation — no extra RPC.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
// deposit(uint256,address) 0x6e553f65 and redeem(uint256,address,address) 0xba087652 — the two
// vault-wrapper legs of the 0x9be73297 inventory rebalance (bundler 0xb8280955 / mediator 0x4825eff2).
const INVENTORY_REBALANCE_SELECTORS = new Set(["0x6e553f65", "0xba087652"]);
// A share-token net that is dust (rounding) does NOT mark a residual position; observed rebalance
// residuals were ~2.9e23 raw. Keep the threshold well above ERC4626 rounding (a few wei-shares).
const SHARE_IMBALANCE_DUST_RAW = 1000n;
type RealizedProfitUsd = number | null | string;

type Json = Record<string, any>;

interface JsonlLoad {
  events: Json[];
  parsed: number;
  skipped: number;
}

interface MatchResult {
  event: Json;
  mode: "tx" | "opportunity";
  query: string;
}

export interface SourceQuery {
  address: string;
  origin: "opportunity_seen" | "triggering_receipt";
  venue?: string;
  id?: string;
}

export interface TouchedVenue {
  protocol: "univ2" | "univ3" | "univ4";
  id: string;
  emitter: string;
  in_graph: boolean | null;
}

export interface GraphMembership {
  status: "loaded" | "unavailable";
  path: string;
  entries: number;
  members: Set<string>;
}

export interface CandidateTx {
  hash: string;
  transactionIndex: number;
  backrun_positioned: boolean;
  matched_source_addresses: string[];
}

export interface CompetitorReport extends CandidateTx {
  from: string;
  to: string | null;
  status: string | null;
  gasUsed: string;
  effectiveGasPrice: string;
  priorityTipWei: string;
  coinbaseTransferWei: string | null;
  builderPaymentWei: string;
  builderPaymentEth: number | null;
  builderPaymentUsd: number | null;
  realizedProfitUsd: RealizedProfitUsd;
  profitConfidence: string;
  nativeTraceUsed: boolean;
  tracePrestateUsed: boolean;
  traceError: string | null;
  v4Swaps: number;
  v4PoolIds: string[];
  touchedVenues: TouchedVenue[];
  edgeKinds: EdgeKind[];
  winner_style: WinnerStyle;
  winner_moved_price_beyond_prestate: boolean;
  unpriced_token_in_flow: string[];
}

interface BuilderReach {
  status: "reached_via_flashbots_buildernet" | "sent_directly" | "verify_manually";
  builder: string;
  miner: string;
  builders_sent: string[];
  note: string;
}

interface Verdict {
  status: "pending_swap_never_landed" | "no_competing_tx_found" | "priced";
  winner: string | null;
  winnerPaymentWei: string | null;
  outbid: boolean | null;
  route_gap_decisive: boolean | null;
  winner_style?: WinnerStyle;
  non_comparable_winner?: boolean;
  note?: string;
  one_shot: string;
  builder_reach?: BuilderReach;
}

export interface PostmortemReport {
  command: "bundle-postmortem";
  events: Json;
  matched_by: Json;
  bundle_submitted: Json;
  triggering_swap: Json;
  block?: Json;
  landed_in_targeted_block?: boolean;
  source_queries?: SourceQuery[];
  graph?: Json;
  competing_candidates?: CandidateTx[];
  analyzed_competitors?: CompetitorReport[];
  verdict: Verdict;
  learning_case?: LearningCase;
}

export interface WinnerStyleInput {
  pricedDeltas: TokenDelta[];
  unpricedDeltas: TokenDelta[];
  nativeWeiPositive: boolean;
  nativeWeiNegative: boolean;
  unpricedInTokensWithoutCounterTransfer: string[];
  winner_moved_price_beyond_prestate: boolean;
  sandwich_detected: boolean;
  // Atomicity detector (F-009). Both optional so existing callers/fixtures are unchanged.
  inventory_rebalance_selector_hit?: boolean;
  share_imbalance_tokens?: string[];
}

type WinnerStyleClassifierInput = Omit<WinnerStyleInput, "nativeWeiPositive" | "nativeWeiNegative"> & {
  nativeWeiPositive?: boolean;
  nativeWeiNegative?: boolean;
};

export interface WinnerStyleTxInput {
  rpc: RpcClient;
  txHash: string;
  tx: Record<string, any> | null;
  receipt: Record<string, any> | null;
  profit: {
    pricedDeltas: TokenDelta[];
    unpricedDeltas: TokenDelta[];
    beneficiary: string;
    ethDeltaEth: number;
    nativeTraceUsed: boolean;
  };
  transactionIndex: number;
  blockNumber: number;
  prestateBlock: number;
}

export interface WinnerStyleAnalysis {
  winner_style: WinnerStyle;
  winner_moved_price_beyond_prestate: boolean;
  unpriced_token_in_flow: string[];
}

const USAGE = `Usage: npm run bundle-postmortem -- --events <jsonl> (--tx <hash-or-prefix> | --opportunity <id>) --rpc <url> [--graph <runtime-graph-pools.json>] [--out <report.json>]`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || Object.keys(args).length === 0) usage();

  const eventsPath = stringArg(args, "events");
  const txQuery = stringArg(args, "tx", false);
  const opportunityQuery = stringArg(args, "opportunity", false);
  const rpcUrl = stringArg(args, "rpc");
  const graphPath = args.graph ? resolveCliPath(String(args.graph)) : DEFAULT_GRAPH_PATH;
  const outPath = args.out ? resolveCliPath(String(args.out)) : "";

  if (!eventsPath || !rpcUrl || Boolean(txQuery) === Boolean(opportunityQuery)) usage();

  const loaded = await readJsonlSkippingBad(resolveCliPath(eventsPath));
  const match = findBundleSubmitted(loaded.events, txQuery, opportunityQuery);
  const event = match.event;
  const rpc = new RpcClient(rpcUrl);
  const triggeringHash = requireString(event.victim_hash, "bundle_submitted.victim_hash");
  const ownTxHash = requireString(event.tx_hash, "bundle_submitted.tx_hash");

  const triggeringReceipt = await rpc.getReceipt(triggeringHash);
  if (!triggeringReceipt) {
    const report = {
      command: "bundle-postmortem",
      events: { path: resolveCliPath(eventsPath), parsed: loaded.parsed, skipped_unparsable: loaded.skipped },
      matched_by: { mode: match.mode, query: match.query },
      bundle_submitted: event,
      triggering_swap: { hash: triggeringHash, receipt: null },
      verdict: pendingVerdict(),
    } satisfies PostmortemReport;
    const reportWithLearningCase = {
      ...report,
      learning_case: learningCaseFromPostmortem(report),
    };
    console.log(renderPendingSummary(reportWithLearningCase));
    if (outPath) await writeJson(outPath, reportWithLearningCase);
    return;
  }

  const landingBlockNumber = quantityToNumber(triggeringReceipt.blockNumber);
  const triggeringIndex = quantityToNumber(triggeringReceipt.transactionIndex);
  const block = await rpc.getBlockByNumber(landingBlockNumber, false);
  const baseFeePerGas = block?.baseFeePerGas != null ? hexToBigInt(block.baseFeePerGas) : 0n;
  const blockInfo = {
    number: landingBlockNumber,
    miner: lower(block?.miner ?? ""),
    extraData: String(block?.extraData ?? ""),
    builder: decodeExtraData(block?.extraData),
    baseFeePerGas: baseFeePerGas.toString(),
    timestamp: quantityToNumber(block?.timestamp),
  };
  const sourceQueries = sourceQueriesForBundle(loaded.events, event, triggeringReceipt);
  const graph = loadGraphMembership(graphPath);
  const prestateBlock = prestateBlockForEvent(event, landingBlockNumber);
  const candidates = await findCompetingCandidates(
    rpc,
    sourceQueries,
    landingBlockNumber,
    triggeringIndex,
    [triggeringHash, ownTxHash],
  );
  const selected = selectCandidatesForPricing(candidates);
  const ethUsd = selected.length > 0 ? await fetchEthUsd(rpc) : null;
  const competitors: CompetitorReport[] = [];

  for (const candidate of selected) {
    competitors.push(
      await analyzeCompetitor(
        rpc,
        candidate,
        ethUsd ?? 0,
        blockInfo.miner,
        baseFeePerGas,
        graph,
        prestateBlock,
      ),
    );
  }

  const builderReach = assessBuilderReach(blockInfo.builder, blockInfo.miner, event.builders_sent);
  const verdict = buildVerdict(event, competitors, builderReach);
  const report = {
    command: "bundle-postmortem",
    events: { path: resolveCliPath(eventsPath), parsed: loaded.parsed, skipped_unparsable: loaded.skipped },
    matched_by: { mode: match.mode, query: match.query },
    bundle_submitted: event,
    triggering_swap: {
      hash: triggeringHash,
      block: landingBlockNumber,
      transactionIndex: triggeringIndex,
      status: String(triggeringReceipt.status ?? ""),
    },
    block: blockInfo,
    landed_in_targeted_block: landingBlockNumber === Number(event.submission_target_block),
    source_queries: sourceQueries,
    graph: {
      status: graph.status,
      path: graph.path,
      entries: graph.entries,
    },
    competing_candidates: candidates,
    analyzed_competitors: competitors,
    verdict,
  } satisfies PostmortemReport;
  const reportWithLearningCase = {
    ...report,
    learning_case: learningCaseFromPostmortem(report),
  };

  console.log(renderSummary(reportWithLearningCase));
  if (outPath) await writeJson(outPath, reportWithLearningCase);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

function usage(): never {
  console.error(USAGE);
  process.exit(1);
}

function stringArg(args: Record<string, string | boolean>, key: string, required = true): string {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (required) usage();
  return "";
}

function resolveCliPath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

async function readJsonlSkippingBad(path: string): Promise<JsonlLoad> {
  const text = await readFile(path, "utf8");
  const events: Json[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      skipped++;
    }
  }
  return { events, parsed: events.length, skipped };
}

function findBundleSubmitted(events: Json[], txQuery: string, opportunityQuery: string): MatchResult {
  const bundles = events.filter((event) => event?.type === "bundle_submitted");
  if (txQuery) {
    const prefix = normalizeHashPrefix(txQuery);
    const matches = bundles.filter((event) => lower(String(event.tx_hash ?? "")).startsWith(prefix));
    if (matches.length === 1) return { event: matches[0], mode: "tx", query: txQuery };
    if (matches.length > 1) {
      throw new Error(`Ambiguous --tx ${txQuery}; matches:\n${formatNearMisses(matches, txQuery, "tx_hash")}`);
    }
    throw new Error(`No bundle_submitted matched --tx ${txQuery}. Near misses:\n${formatNearMisses(bundles, txQuery, "tx_hash")}`);
  }

  const needle = lower(opportunityQuery);
  const matches = bundles.filter((event) => lower(String(event.opportunity_id ?? "")) === needle);
  if (matches.length === 1) return { event: matches[0], mode: "opportunity", query: opportunityQuery };
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous --opportunity ${opportunityQuery}; matches:\n${formatNearMisses(matches, opportunityQuery, "opportunity_id")}`,
    );
  }
  throw new Error(
    `No bundle_submitted matched --opportunity ${opportunityQuery}. Near misses:\n${formatNearMisses(bundles, opportunityQuery, "opportunity_id")}`,
  );
}

function normalizeHashPrefix(value: string): string {
  const trimmed = lower(value.trim());
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function formatNearMisses(events: Json[], query: string, field: "tx_hash" | "opportunity_id"): string {
  const needle = lower(query);
  const ranked = [...events]
    .filter((event) => event[field])
    .sort((a, b) => commonPrefixLength(lower(String(b[field])), needle) - commonPrefixLength(lower(String(a[field])), needle))
    .slice(0, 5);
  if (ranked.length === 0) return "  (no bundle_submitted events with that field)";
  return ranked
    .map((event) => `  ${field}=${event[field]} opportunity_id=${event.opportunity_id ?? "unknown"} target=${event.submission_target_block ?? event.target_block ?? "unknown"}`)
    .join("\n");
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`Missing ${label}`);
}

function quantityToNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "string") return 0;
  return Number(hexToBigInt(value));
}

function sourceQueriesForBundle(events: Json[], bundle: Json, triggeringReceipt: Json): SourceQuery[] {
  const fromSeen = sourceQueriesFromOpportunity(events, String(bundle.opportunity_id ?? ""));
  if (fromSeen.length > 0) return fromSeen;
  return sourceQueriesFromReceipt(triggeringReceipt);
}

function sourceQueriesFromOpportunity(events: Json[], opportunityId: string): SourceQuery[] {
  if (!opportunityId) return [];
  const out: SourceQuery[] = [];
  for (const event of events) {
    if (event?.type !== "opportunity_seen") continue;
    if (lower(String(event.opportunity_id ?? "")) !== lower(opportunityId)) continue;
    const pool = lower(String(event.pool ?? ""));
    if (isAddress(pool)) out.push({ address: pool, origin: "opportunity_seen", venue: "pool", id: pool });
    else if (isBytes32(pool)) {
      out.push({ address: UNIV4_POOL_MANAGER, origin: "opportunity_seen", venue: "univ4", id: pool });
    }
  }
  return dedupeSourceQueries(out);
}

function sourceQueriesFromReceipt(receipt: Json): SourceQuery[] {
  const out: SourceQuery[] = [];
  for (const venue of extractTouchedVenues(receipt, null)) {
    if (venue.protocol === "univ4") {
      out.push({ address: UNIV4_POOL_MANAGER, origin: "triggering_receipt", venue: "univ4", id: venue.id });
    } else {
      out.push({ address: venue.emitter, origin: "triggering_receipt", venue: venue.protocol, id: venue.id });
    }
  }
  return dedupeSourceQueries(out);
}

function dedupeSourceQueries(items: SourceQuery[]): SourceQuery[] {
  const byAddress = new Map<string, SourceQuery>();
  for (const item of items) {
    const address = lower(item.address);
    if (!isAddress(address)) continue;
    const existing = byAddress.get(address);
    if (!existing) byAddress.set(address, { ...item, address });
    else if (!existing.id && item.id) byAddress.set(address, { ...existing, id: item.id });
  }
  return [...byAddress.values()];
}

async function findCompetingCandidates(
  rpc: RpcClient,
  sourceQueries: SourceQuery[],
  blockNumber: number,
  triggeringIndex: number,
  excludeHashes: string[],
): Promise<CandidateTx[]> {
  const exclude = new Set(excludeHashes.map(lower));
  const byHash = new Map<string, CandidateTx>();
  for (const source of sourceQueries) {
    const logs = await rpc.getLogs({
      address: source.address,
      fromBlock: toQuantity(blockNumber),
      toBlock: toQuantity(blockNumber),
    });
    for (const log of logs) {
      const hash = lower(String(log.transactionHash ?? ""));
      if (!hash || exclude.has(hash)) continue;
      const index = quantityToNumber(log.transactionIndex);
      const existing = byHash.get(hash);
      if (existing) {
        existing.matched_source_addresses = uniq([...existing.matched_source_addresses, source.address]);
        existing.transactionIndex = Math.min(existing.transactionIndex, index);
        existing.backrun_positioned = existing.transactionIndex > triggeringIndex;
      } else {
        byHash.set(hash, {
          hash,
          transactionIndex: index,
          backrun_positioned: index > triggeringIndex,
          matched_source_addresses: [source.address],
        });
      }
    }
  }
  return [...byHash.values()].sort((a, b) => a.transactionIndex - b.transactionIndex);
}

function selectCandidatesForPricing(candidates: CandidateTx[]): CandidateTx[] {
  const afterTrigger = candidates.filter((candidate) => candidate.backrun_positioned);
  const selected = afterTrigger.length > 0 ? afterTrigger : candidates;
  return selected.slice(0, 5);
}

async function analyzeCompetitor(
  rpc: RpcClient,
  candidate: CandidateTx,
  ethUsd: number,
  coinbase: string,
  baseFeePerGas: bigint,
  graph: GraphMembership,
  prestateBlock: number,
): Promise<CompetitorReport> {
  const [tx, receipt] = await Promise.all([
    rpc.getTransaction(candidate.hash),
    rpc.getReceipt(candidate.hash),
  ]);
  const profit = await priceArb(rpc, candidate.hash, tx, receipt, ethUsd, {
    entityActors: [tx?.to, tx?.from].filter((actor): actor is string => typeof actor === "string" && actor.length > 0),
    allowTrace: true,
    coinbase,
    baseFeePerGas,
  });
  const payment = await computeBuilderPaymentWei(rpc, candidate.hash, receipt, baseFeePerGas, coinbase);
  const blockNumber = quantityToNumber(receipt?.blockNumber);
  const winnerStyleAnalysis = await classifyWinnerTxStyle({
    rpc,
    txHash: candidate.hash,
    tx,
    receipt,
    profit,
    transactionIndex: candidate.transactionIndex,
    blockNumber,
    prestateBlock,
  });
  return {
    ...candidate,
    from: lower(tx?.from ?? receipt?.from ?? ""),
    to: tx?.to ? lower(tx.to) : null,
    status: receipt?.status ? String(receipt.status) : null,
    gasUsed: hexToBigInt(receipt?.gasUsed).toString(),
    effectiveGasPrice: hexToBigInt(receipt?.effectiveGasPrice).toString(),
    priorityTipWei: payment.priorityTipWei.toString(),
    coinbaseTransferWei: payment.coinbaseTransferWei === null ? null : payment.coinbaseTransferWei.toString(),
    builderPaymentWei: payment.builderPaymentWei.toString(),
    builderPaymentEth: profit.builderPaymentEth,
    builderPaymentUsd: profit.builderPaymentUsd,
    realizedProfitUsd: realizedProfitUsdForReport(profit.realizedProfitUsd, profit.unpricedDeltas),
    profitConfidence: profit.profitConfidence,
    nativeTraceUsed: profit.nativeTraceUsed,
    tracePrestateUsed: payment.traceUsed,
    traceError: payment.traceError,
    v4Swaps: profit.v4Swaps.length,
    v4PoolIds: profit.v4PoolIds,
    touchedVenues: extractTouchedVenues(receipt, graph),
    edgeKinds: deriveEdgeKindsFromLogs(receipt?.logs),
    winner_style: winnerStyleAnalysis.winner_style,
    winner_moved_price_beyond_prestate: winnerStyleAnalysis.winner_moved_price_beyond_prestate,
    unpriced_token_in_flow: winnerStyleAnalysis.unpriced_token_in_flow,
  };
}

async function computeBuilderPaymentWei(
  rpc: RpcClient,
  txHash: string,
  receipt: Json,
  baseFeePerGas: bigint,
  coinbase: string,
): Promise<{
  priorityTipWei: bigint;
  coinbaseTransferWei: bigint | null;
  builderPaymentWei: bigint;
  traceUsed: boolean;
  traceError: string | null;
}> {
  const gasUsed = hexToBigInt(receipt?.gasUsed);
  const effectiveGasPrice = hexToBigInt(receipt?.effectiveGasPrice);
  const priorityFee = effectiveGasPrice > baseFeePerGas ? effectiveGasPrice - baseFeePerGas : 0n;
  const priorityTipWei = gasUsed * priorityFee;
  try {
    const trace = await rpc.tracePrestate(txHash);
    const pre = normalizeStateMap(trace?.pre ?? {});
    const post = normalizeStateMap(trace?.post ?? {});
    const coinbaseTransferWei = builderPaymentWeiFromPrestate(pre, post, coinbase);
    return {
      priorityTipWei,
      coinbaseTransferWei,
      builderPaymentWei: priorityTipWei + coinbaseTransferWei,
      traceUsed: true,
      traceError: null,
    };
  } catch (err) {
    return {
      priorityTipWei,
      coinbaseTransferWei: null,
      builderPaymentWei: priorityTipWei,
      traceUsed: false,
      traceError: (err as Error).message,
    };
  }
}

function normalizeStateMap(state: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [address, value] of Object.entries(state)) out[lower(address)] = value;
  return out;
}

export function extractTouchedVenues(receipt: Json, graph: GraphMembership | null): TouchedVenue[] {
  const out: TouchedVenue[] = [];
  for (const log of receipt?.logs ?? []) {
    const emitter = lower(String(log?.address ?? ""));
    const topic0 = lower(String(log?.topics?.[0] ?? ""));
    if (emitter === UNIV4_POOL_MANAGER && topic0 === TOPIC_UNIV4_SWAP) {
      const poolId = lower(String(log?.topics?.[1] ?? ""));
      if (isBytes32(poolId)) out.push(venue("univ4", poolId, emitter, graph));
    } else if (topic0 === TOPIC_UNIV3_SWAP && isAddress(emitter)) {
      out.push(venue("univ3", emitter, emitter, graph));
    } else if (TOPIC_UNIV2_SWAP && topic0 === TOPIC_UNIV2_SWAP && isAddress(emitter)) {
      out.push(venue("univ2", emitter, emitter, graph));
    }
  }
  const seen = new Set<string>();
  return out.filter((item) => {
    const key = `${item.protocol}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function venue(
  protocol: TouchedVenue["protocol"],
  id: string,
  emitter: string,
  graph: GraphMembership | null,
): TouchedVenue {
  return {
    protocol,
    id,
    emitter,
    in_graph: graph?.status === "loaded" ? graph.members.has(lower(id)) : null,
  };
}

export function loadGraphMembership(path: string): GraphMembership {
  if (!existsSync(path)) return { status: "unavailable", path, entries: 0, members: new Set() };
  try {
    const text = readFileSyncText(path);
    const members = new Set<string>();
    collectGraphMembers(JSON.parse(text), members);
    // v4 pools are stored in runtime-graph-pools.json by PoolManager ADDRESS only (no poolId),
    // so a poolId membership check against the runtime graph is a systematic FALSE-NEGATIVE for
    // ALL v4 pools (it would report every v4 pool — including ones we already index — as not in
    // graph). The v4 poolIds live in the sibling active-pools.json (the loaded universe); union
    // them in so v4 in_graph is correct. Mirrors live-loss readActiveV4PoolIds.
    addActivePoolsV4PoolIds(path, members);
    return { status: "loaded", path, entries: members.size, members };
  } catch {
    return { status: "unavailable", path, entries: 0, members: new Set() };
  }
}

// Union the v4 poolIds from the sibling active-pools.json into graph membership. Only bytes32
// poolIds are added (v4-only field); v2/v3 in_graph stays authoritative against runtime-graph.
function addActivePoolsV4PoolIds(graphPath: string, members: Set<string>): void {
  const activePoolsPath = resolve(dirname(graphPath), "active-pools.json");
  if (!existsSync(activePoolsPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(activePoolsPath, "utf8")) as unknown;
    const pools = Array.isArray(parsed)
      ? parsed
      : ((parsed as { pools?: unknown[] })?.pools ?? []);
    for (const pool of pools) {
      const poolId = lower(String((pool as { poolId?: unknown })?.poolId ?? ""));
      if (isBytes32(poolId)) members.add(poolId);
    }
  } catch {
    // active-pools missing/corrupt → leave v4 as runtime-graph-only (prior behavior).
  }
}

function readFileSyncText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function collectGraphMembers(value: unknown, members: Set<string>): void {
  if (typeof value === "string") {
    addGraphMembersFromString(value, members);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectGraphMembers(item, members);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      addGraphMembersFromString(key, members);
      collectGraphMembers(item, members);
    }
  }
}

function addGraphMembersFromString(value: string, members: Set<string>): void {
  for (const match of value.matchAll(/0x[a-fA-F0-9]{64}|0x[a-fA-F0-9]{40}/g)) {
    members.add(lower(match[0]));
  }
}

function prestateBlockForEvent(event: Json, landingBlockNumber: number): number {
  const target = Number(event.submission_target_block ?? event.target_block ?? landingBlockNumber);
  if (Number.isFinite(target) && target > 0) return target - 1;
  return Math.max(landingBlockNumber - 1, 0);
}

export function winnerMovedPriceBeyondPrestate(
  preVictimTick: number,
  winnerPostTick: number,
  direction: TickDirection = "down",
): boolean {
  return direction === "down"
    ? winnerPostTick < preVictimTick
    : winnerPostTick > preVictimTick;
}

export function classifyWinnerStyle(input: WinnerStyleClassifierInput): WinnerStyle {
  // Atomicity check FIRST: a vault-share inventory rebalance (F-009) otherwise reads as atomic_loop
  // because the executor's intra-tx net is clean. Two layers, either is sufficient to flag:
  //  - Layer 2 (robust): a residual share-token mint/burn imbalance in the receipt (general signal).
  //  - Layer 1 (operator first cut): a hardcoded ERC4626 rebalance selector. Trusted alone ONLY when
  //    the winner is NOT a comparable atomic loop; a plain atomic ERC4626 arb also calls
  //    deposit/redeem but round-trips to ~zero net shares (no imbalance) and returns to a priced
  //    token (an atomic loop), so the selector never fires against it.
  const shareImbalance = (input.share_imbalance_tokens?.length ?? 0) > 0;
  const selectorInventory = Boolean(input.inventory_rebalance_selector_hit)
    && !hasAtomicLoopFlow(input.pricedDeltas, input.unpricedDeltas, input.nativeWeiPositive ?? false);
  if (shareImbalance || selectorInventory) return "inventory_vault_rebalance";
  if (input.winner_moved_price_beyond_prestate) return "one_leg_inventory";
  if (input.sandwich_detected) return "sandwich";
  if (hasOneLegInventoryFlow(
    input.pricedDeltas,
    input.unpricedDeltas,
    input.unpricedInTokensWithoutCounterTransfer,
    input.nativeWeiNegative ?? false,
  )) {
    return "one_leg_inventory";
  }
  if (hasAtomicLoopFlow(
    input.pricedDeltas,
    input.unpricedDeltas,
    input.nativeWeiPositive ?? false,
  )) return "atomic_loop";
  return "unknown";
}

export async function classifyWinnerTxStyle(input: WinnerStyleTxInput): Promise<WinnerStyleAnalysis> {
  const beneficiaries = competitorBeneficiaries(input.tx, input.receipt, input.profit.beneficiary);
  const nativeWeiPositive = input.profit.nativeTraceUsed && input.profit.ethDeltaEth > 0;
  const nativeWeiNegative = input.profit.nativeTraceUsed && input.profit.ethDeltaEth < 0;
  const unpricedTokenInFlow = unpricedTokenInFlowTokens(input.profit.unpricedDeltas);
  const unpricedInTokensWithoutCounterTransfer = await unpricedInTokensWithoutCounterTransfers(
    input.rpc,
    input.blockNumber,
    input.transactionIndex,
    beneficiaries,
    input.profit.unpricedDeltas,
  );
  const winnerMovedPriceBeyondPrestate = await detectWinnerMovedPriceBeyondPrestate(
    input.rpc,
    input.receipt,
    input.prestateBlock,
  );
  const flowOneLeg = hasOneLegInventoryFlow(
    input.profit.pricedDeltas,
    input.profit.unpricedDeltas,
    unpricedInTokensWithoutCounterTransfer,
    nativeWeiNegative,
  );
  const sandwichDetected = !winnerMovedPriceBeyondPrestate && !flowOneLeg
    ? await detectSandwichPattern(
      input.rpc,
      input.receipt,
      {
        hash: lower(input.txHash),
        transactionIndex: input.transactionIndex,
        backrun_positioned: false,
        matched_source_addresses: [],
      },
      beneficiaries,
      input.blockNumber,
    )
    : false;
  // Atomicity / inventory-rebalance detector (F-009). Layer 2 first (pure receipt, no RPC).
  const shareImbalanceTokens = shareTokenImbalanceTokens(input.receipt);
  // Layer 1 (hardcoded selectors) needs the inner calls (top-level input is a private entrypoint),
  // so it reads a callTracer trace — but only when Layer 2 is silent, to avoid the extra RPC on the
  // common case. Graceful degrade: if the trace is unavailable the imbalance layer still catches it.
  const inventoryRebalanceSelectorHit = shareImbalanceTokens.length > 0
    ? true
    : await inventoryRebalanceSelectorPresent(input.rpc, input.txHash);
  return {
    winner_style: classifyWinnerStyle({
      pricedDeltas: input.profit.pricedDeltas,
      unpricedDeltas: input.profit.unpricedDeltas,
      unpricedInTokensWithoutCounterTransfer,
      winner_moved_price_beyond_prestate: winnerMovedPriceBeyondPrestate,
      sandwich_detected: sandwichDetected,
      nativeWeiPositive,
      nativeWeiNegative,
      inventory_rebalance_selector_hit: inventoryRebalanceSelectorHit,
      share_imbalance_tokens: shareImbalanceTokens,
    }),
    winner_moved_price_beyond_prestate: winnerMovedPriceBeyondPrestate,
    unpriced_token_in_flow: unpricedTokenInFlow,
  };
}

// Layer 2 (F-009): per-tx ERC4626/vault-share NET mint/burn imbalance from the receipt. For each
// token, sum Transfer(from=0x0) as +mint and Transfer(to=0x0) as -burn; a net magnitude above dust
// for ANY token ⇒ a residual standing position was created/consumed ⇒ inventory/non-atomic. A plain
// atomic ERC4626 arb round-trips the same shares (deposit then redeem) and nets ~0. Pure receipt
// computation — no RPC. Returns the offending share-token addresses (empty ⇒ atomic on this axis).
export function shareTokenImbalanceTokens(receipt: Json | null): string[] {
  const net = new Map<string, bigint>();
  for (const log of receipt?.logs ?? []) {
    if (lower(String(log?.topics?.[0] ?? "")) !== TOPIC_TRANSFER) continue;
    const transfer = decodeTransfer(log);
    if (!transfer) continue;
    const from = lower(transfer.from);
    const to = lower(transfer.to);
    const token = lower(String(log?.address ?? ""));
    if (!isAddress(token)) continue;
    if (from === ZERO_ADDRESS && to === ZERO_ADDRESS) continue;
    if (from === ZERO_ADDRESS) net.set(token, (net.get(token) ?? 0n) + transfer.amount);
    else if (to === ZERO_ADDRESS) net.set(token, (net.get(token) ?? 0n) - transfer.amount);
  }
  const out: string[] = [];
  for (const [token, value] of net) {
    if (value < 0n ? -value > SHARE_IMBALANCE_DUST_RAW : value > SHARE_IMBALANCE_DUST_RAW) {
      out.push(token);
    }
  }
  return out;
}

// Layer 1 (F-009, operator directive): scan the tx call tree for a hardcoded ERC4626 vault-share
// rebalance selector (deposit/redeem observed as the inventory legs of 0x9be73297). Keyed by
// FUNCTION selector, NOT contract, since the same contracts' deposit/redeem are legit protocol-arb
// calls; the selector hit is only trusted by classifyWinnerStyle when it is NOT a comparable atomic
// loop. Best-effort: any trace failure returns false (Layer 2 remains the robust catch).
async function inventoryRebalanceSelectorPresent(rpc: RpcClient, txHash: string): Promise<boolean> {
  try {
    const trace = await rpc.traceTransaction(txHash);
    return callTreeHasSelector(trace, INVENTORY_REBALANCE_SELECTORS);
  } catch {
    return false;
  }
}

function callTreeHasSelector(node: Json | null | undefined, selectors: Set<string>): boolean {
  if (!node || typeof node !== "object") return false;
  const selector = lower(String(node.input ?? "0x")).slice(0, 10);
  if (selectors.has(selector)) return true;
  const calls = Array.isArray(node.calls) ? node.calls : [];
  return calls.some((child) => callTreeHasSelector(child, selectors));
}

export function realizedProfitUsdForReport(
  realizedProfitUsd: number | null,
  unpricedDeltas: TokenDelta[],
): RealizedProfitUsd {
  const tokens = uniq(unpricedDeltas.filter((delta) => delta.raw !== 0n).map((delta) => lower(delta.token)));
  return tokens.length === 0 ? realizedProfitUsd : `unpriceable(${tokens.join(",")})`;
}

function hasOneLegInventoryFlow(
  pricedDeltas: TokenDelta[],
  _unpricedDeltas: TokenDelta[],
  unpricedInTokensWithoutCounterTransfer: string[],
  nativeWeiNegative: boolean,
): boolean {
  // Native ETH spent (nativeWeiNegative) counts as an inventory-priced spend: a native-ETH-funded
  // one-leg buy (v4 native settle / any value-funded buy) shows the spend ONLY as a negative native
  // delta, invisible to the priced-token check. Guarded by the leftover-bought-token term below —
  // an atomic loop leaves no such token, and (ethDeltaEth net) a native atomic loop is net-positive
  // so nativeWeiNegative is false for it (mutually exclusive with nativeWeiPositive).
  const spentPricedOrNative =
    pricedDeltas.some((delta) => delta.raw < 0n && INVENTORY_PRICED_TOKENS.has(lower(delta.token)))
    || nativeWeiNegative;
  return spentPricedOrNative && unpricedInTokensWithoutCounterTransfer.length > 0;
}

function hasAtomicLoopFlow(
  pricedDeltas: TokenDelta[],
  unpricedDeltas: TokenDelta[],
  nativeWeiPositive: boolean,
): boolean {
  return (pricedDeltas.some((delta) => delta.raw > 0n) || nativeWeiPositive)
    && unpricedDeltas.every(
      (delta) => delta.raw === 0n || (delta.raw < 0n && -delta.raw <= UNPRICED_DUST_RAW),
    );
}

function unpricedTokenInFlowTokens(unpricedDeltas: TokenDelta[]): string[] {
  return uniq(
    unpricedDeltas
      .filter((delta) => delta.raw > 0n)
      .map((delta) => lower(delta.token)),
  );
}

function competitorBeneficiaries(tx: Json | null, receipt: Json | null, beneficiary: string): Set<string> {
  return new Set(
    [
      tx?.from,
      tx?.to,
      receipt?.from,
      receipt?.to,
      beneficiary,
    ]
      .map((address) => lower(String(address ?? "")))
      .filter(isAddress),
  );
}

async function unpricedInTokensWithoutCounterTransfers(
  rpc: RpcClient,
  blockNumber: number,
  txIndex: number,
  beneficiaries: Set<string>,
  unpricedDeltas: TokenDelta[],
): Promise<string[]> {
  const tokens = unpricedTokenInFlowTokens(unpricedDeltas);
  const out: string[] = [];
  for (const token of tokens) {
    try {
      const logs = await rpc.getLogs({
        address: token,
        fromBlock: toQuantity(blockNumber),
        toBlock: toQuantity(blockNumber),
        topics: [TOPIC_TRANSFER],
      });
      const counterTransfer = logs.some((log) => {
        const transfer = decodeTransfer(log);
        if (!transfer) return false;
        if (quantityToNumber(log.transactionIndex) < txIndex) return false;
        return beneficiaries.has(lower(transfer.from)) && !beneficiaries.has(lower(transfer.to));
      });
      if (!counterTransfer) out.push(token);
    } catch {
      // If the cheap block-local token scan is unavailable, do not force a one-leg classification.
    }
  }
  return out;
}

export async function detectWinnerMovedPriceBeyondPrestate(
  rpc: RpcClient,
  receipt: Json | null,
  prestateBlock: number,
): Promise<boolean> {
  if (prestateBlock < 0) return false;
  const primarySwap = primaryV3SwapForTick(receipt);
  if (!primarySwap) return false;
  const preTick = await fetchV3Slot0Tick(rpc, primarySwap.pool, prestateBlock);
  return preTick === null
    ? false
    : winnerMovedPriceBeyondPrestate(preTick, primarySwap.postTick, primarySwap.direction);
}

async function fetchV3Slot0Tick(rpc: RpcClient, pool: string, blockNumber: number): Promise<number | null> {
  try {
    const data = await rpc.call<string>("eth_call", [
      { to: pool, data: V3_SLOT0_SELECTOR },
      toQuantity(blockNumber),
    ]);
    return decodeV3Slot0Tick(data);
  } catch {
    return null;
  }
}

function decodeV3Slot0Tick(data: string): number | null {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const word = hex.slice(64, 128);
  if (word.length !== 64) return null;
  return Number(BigInt.asIntN(256, BigInt(`0x${word}`)));
}

function primaryV3SwapForTick(receipt: Json | null): { pool: string; postTick: number; direction: TickDirection } | null {
  for (const log of receipt?.logs ?? []) {
    const swap = v3SwapFromLog(log);
    if (swap) return swap;
  }
  return null;
}

function v3SwapFromLog(log: Json): { pool: string; postTick: number; direction: TickDirection } | null {
  if (lower(String(log?.topics?.[0] ?? "")) !== TOPIC_UNIV3_SWAP) return null;
  const pool = lower(String(log?.address ?? ""));
  if (!isAddress(pool)) return null;
  try {
    const parsed = V3_SWAP_IFACE.parseLog({ topics: log.topics, data: log.data ?? "0x" });
    if (!parsed) return null;
    const amount0 = BigInt(String(parsed.args[2]));
    const amount1 = BigInt(String(parsed.args[3]));
    const direction = amount0 < 0n ? "down" : amount1 < 0n ? "up" : null;
    if (!direction) return null;
    return {
      pool,
      postTick: Number(parsed.args[6]),
      direction,
    };
  } catch {
    return null;
  }
}

async function detectSandwichPattern(
  rpc: RpcClient,
  receipt: Json | null,
  candidate: CandidateTx,
  beneficiaries: Set<string>,
  blockNumber: number,
): Promise<boolean> {
  const currentSwap = primaryV3SwapForTick(receipt);
  if (!currentSwap || blockNumber <= 0) return false;
  try {
    const logs = await rpc.getLogs({
      address: currentSwap.pool,
      fromBlock: toQuantity(blockNumber),
      toBlock: toQuantity(blockNumber),
      topics: [TOPIC_UNIV3_SWAP],
    });
    for (const log of logs) {
      const otherIndex = quantityToNumber(log.transactionIndex);
      if (Math.abs(otherIndex - candidate.transactionIndex) !== 2) continue;
      const otherHash = lower(String(log.transactionHash ?? ""));
      if (!otherHash || otherHash === candidate.hash) continue;
      const otherSwap = v3SwapFromLog(log);
      if (!otherSwap || otherSwap.direction === currentSwap.direction) continue;
      const otherTx = await rpc.getTransaction(otherHash);
      const otherFrom = lower(String(otherTx?.from ?? ""));
      const otherTo = lower(String(otherTx?.to ?? ""));
      if (beneficiaries.has(otherFrom) || beneficiaries.has(otherTo)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function buildVerdict(event: Json, competitors: CompetitorReport[], builderReach: BuilderReach): Verdict {
  if (competitors.length === 0) {
    return {
      status: "no_competing_tx_found",
      winner: null,
      winnerPaymentWei: null,
      outbid: null,
      route_gap_decisive: null,
      one_shot: oneShotSummary(event),
      builder_reach: builderReach,
    };
  }
  const winner = chooseWinner(competitors);
  const winnerPayment = BigInt(winner.builderPaymentWei);
  const bid = parseWeiField(event.bid);
  const simulatedProfit = parseWeiField(event.simulated_profit);
  const nonComparable = isNonComparableWinnerStyle(winner.winner_style);
  return {
    status: "priced",
    winner: winner.hash,
    winnerPaymentWei: winner.builderPaymentWei,
    outbid: bid === null ? null : winnerPayment > bid,
    route_gap_decisive: simulatedProfit === null ? null : nonComparable ? false : winnerPayment > simulatedProfit,
    winner_style: winner.winner_style,
    non_comparable_winner: nonComparable ? true : undefined,
    note: nonComparable ? nonComparableWinnerNote(winner.winner_style) : undefined,
    one_shot: oneShotSummary(event),
    builder_reach: builderReach,
  };
}

export function isNonComparableWinnerStyle(style: WinnerStyle): boolean {
  return style === "one_leg_inventory"
    || style === "sandwich"
    || style === "inventory_vault_rebalance";
}

export function learningCaseFromPostmortem(report: PostmortemReport): LearningCase {
  const winner = report.analyzed_competitors?.find((tx) => tx.hash === report.verdict.winner)
    ?? report.analyzed_competitors?.[0]
    ?? null;
  const winnerStyle = report.verdict.winner_style ?? winner?.winner_style ?? "unknown";
  const comparable = winnerStyle === "atomic_loop";
  const missingVenues = (winner?.touchedVenues ?? []).filter((venue) => venue.in_graph === false);
  const primary_gap = postmortemPrimaryGap(report, winner, comparable, missingVenues);
  const targetBlock = numberOrUndefined(
    report.bundle_submitted.submission_target_block
      ?? report.bundle_submitted.target_block
      ?? report.triggering_swap.block,
  );
  const createdAt = timestampFromReport(report);
  const competitorTx = winner?.hash ?? report.verdict.winner ?? undefined;
  const edge_kinds: LearningCase["edge_kinds"] = winner?.edgeKinds && winner.edgeKinds.length > 0 ? winner.edgeKinds : (winner && winner.touchedVenues.length > 0 ? ["swap"] : []);

  return {
    learning_case_id: learningCaseId({
      strategy_kind: "backrun",
      trigger: "bundle_not_included",
      competitor_tx: competitorTx,
      source_block: undefined,
      cycle_fingerprint: undefined,
      primary_gap,
    }),
    status: primary_gap === "manual_required" ? "manual_required" : "open",
    strategy_kind: "backrun",
    edge_kinds,
    trigger: "bundle_not_included",
    competitor_tx: competitorTx,
    our_opportunity_id: optionalString(report.bundle_submitted.opportunity_id),
    target_block: targetBlock,
    comparable,
    primary_gap,
    evidence: {
      verdict_status: report.verdict.status,
      winner_style: winnerStyle,
      route_gap_decisive: report.verdict.route_gap_decisive,
      outbid: report.verdict.outbid,
      winner_payment_wei: report.verdict.winnerPaymentWei ?? winner?.builderPaymentWei ?? null,
      our_bid_wei: optionalString(report.bundle_submitted.bid),
      our_simulated_gross_wei: optionalString(
        report.bundle_submitted.simulated_profit ?? report.bundle_submitted.simulated_profit_wei,
      ),
      missing_venues: missingVenues.map((venue) => ({
        protocol: venue.protocol,
        id: venue.id,
        emitter: venue.emitter,
      })),
      touched_venues: (winner?.touchedVenues ?? []).map((venue) => ({
        protocol: venue.protocol,
        id: venue.id,
        in_graph: venue.in_graph,
      })),
    },
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function postmortemPrimaryGap(
  report: PostmortemReport,
  winner: CompetitorReport | null,
  comparable: boolean,
  missingVenues: TouchedVenue[],
): PrimaryGap {
  const winnerStyle = report.verdict.winner_style ?? winner?.winner_style ?? "unknown";
  if (isNonComparableWinnerStyle(winnerStyle)) return "non_comparable_winner";
  if (comparable && report.verdict.route_gap_decisive === true && missingVenues.length > 0) {
    return "venue_missing";
  }
  const winnerPayment = parseWeiField(report.verdict.winnerPaymentWei ?? winner?.builderPaymentWei);
  const bid = parseWeiField(report.bundle_submitted.bid);
  const simulatedGross = parseWeiField(
    report.bundle_submitted.simulated_profit ?? report.bundle_submitted.simulated_profit_wei,
  );
  if (
    comparable
    && winnerPayment !== null
    && bid !== null
    && simulatedGross !== null
    && winnerPayment > bid
    && winnerPayment < simulatedGross
  ) {
    return "outbid";
  }
  return "manual_required";
}

function learningCaseId(parts: {
  strategy_kind: string;
  trigger: string;
  competitor_tx?: string;
  source_block?: number;
  cycle_fingerprint?: string;
  primary_gap: PrimaryGap;
}): string {
  return ethers.id([
    parts.strategy_kind,
    parts.trigger,
    parts.competitor_tx ?? "",
    parts.source_block ?? "",
    parts.cycle_fingerprint ?? "",
    parts.primary_gap,
  ].join("|"));
}

function timestampFromReport(report: PostmortemReport): string {
  const timestamp = numberOrUndefined(report.block?.timestamp);
  if (timestamp !== undefined && timestamp >= 0) return new Date(timestamp * 1000).toISOString();
  const eventTime = optionalString(report.bundle_submitted.timestamp ?? report.bundle_submitted.time);
  if (eventTime) return eventTime;
  return "1970-01-01T00:00:00.000Z";
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonComparableWinnerNote(style: WinnerStyle): string {
  const label = style === "one_leg_inventory"
    ? "one_leg_inventory/CEX-DEX"
    : style === "inventory_vault_rebalance"
      ? "inventory_vault_rebalance (residual vault-share position; needs pre-held inventory)"
      : "sandwich";
  return `winner is ${label}; off-chain/out-of-posture - our atomic sim gross is the correct ceiling; no coverage/sizing/bid fix`;
}

function pendingVerdict(): Verdict {
  return {
    status: "pending_swap_never_landed",
    winner: null,
    winnerPaymentWei: null,
    outbid: null,
    route_gap_decisive: null,
    one_shot: "The triggering swap has no receipt, so the bundle had no landed source transaction to follow.",
  };
}

function chooseWinner(competitors: CompetitorReport[]): CompetitorReport {
  const preferred = competitors.some((tx) => tx.backrun_positioned)
    ? competitors.filter((tx) => tx.backrun_positioned)
    : competitors;
  return preferred.reduce((best, current) =>
    BigInt(current.builderPaymentWei) > BigInt(best.builderPaymentWei) ? current : best,
  );
}

function parseWeiField(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

function oneShotSummary(event: Json): string {
  return `The bundle embeds the pending swap raw transaction and was pinned to target block ${event.submission_target_block ?? "unknown"}; once that swap lands, later non-inclusion blocks are expected because the bundle is permanently invalid.`;
}

function assessBuilderReach(builder: string, miner: string, buildersSentValue: unknown): BuilderReach {
  const buildersSent = Array.isArray(buildersSentValue)
    ? buildersSentValue.map((value) => String(value))
    : [];
  const builderLower = lower(builder);
  const sentLower = buildersSent.map(lower);
  if (builderLower.includes("buildernet") && sentLower.includes("flashbots")) {
    return {
      status: "reached_via_flashbots_buildernet",
      builder,
      miner,
      builders_sent: buildersSent,
      note: "Flashbots Bundle Relay orderflow is auto-shared with BuilderNet (buildernet.org/docs/send-orderflow), so the bundle did reach the winning builder.",
    };
  }
  const direct = sentLower.some((sent) => sent && (builderLower.includes(sent) || sent.includes(builderLower)));
  if (direct) {
    return {
      status: "sent_directly",
      builder,
      miner,
      builders_sent: buildersSent,
      note: "The block builder identity appears in builders_sent.",
    };
  }
  return {
    status: "verify_manually",
    builder,
    miner,
    builders_sent: buildersSent,
    note: "Builder relationship is not known from this script; verify orderflow sharing manually.",
  };
}

function decodeExtraData(extraData: unknown): string {
  const hex = String(extraData ?? "");
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) return "";
  return Buffer.from(hex.slice(2), "hex")
    .toString("utf8")
    .replace(/[^\x20-\x7e]+/g, "")
    .trim();
}

function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isBytes32(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, jsonReplacer, 2)}\n`);
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return value instanceof Set ? [...value] : typeof value === "bigint" ? value.toString() : value;
}

function renderPendingSummary(report: Json): string {
  return [
    "bundle-postmortem",
    `verdict: ${report.verdict.status}`,
    `bundle_tx: ${report.bundle_submitted.tx_hash}`,
    `triggering_swap: ${report.triggering_swap.hash}`,
    "reason: no receipt exists for the triggering swap on this RPC",
  ].join("\n");
}

function renderSummary(report: Json): string {
  const verdict = report.verdict as Verdict;
  const winner = report.analyzed_competitors.find((tx: CompetitorReport) => tx.hash === verdict.winner) as CompetitorReport | undefined;
  const lines = [
    "bundle-postmortem",
    `verdict: outbid=${formatNullableBool(verdict.outbid)} route_gap_decisive=${formatNullableBool(verdict.route_gap_decisive)}`,
    `bundle_tx: ${report.bundle_submitted.tx_hash}`,
    `triggering_swap: ${report.triggering_swap.hash} block=${report.triggering_swap.block} index=${report.triggering_swap.transactionIndex} status=${report.triggering_swap.status}`,
    `target_block: ${report.bundle_submitted.submission_target_block ?? "unknown"} landed_in_targeted_block=${String(report.landed_in_targeted_block)}`,
    `block_builder: ${report.block.builder || "unknown"} miner=${report.block.miner} baseFeePerGas=${report.block.baseFeePerGas} timestamp=${report.block.timestamp}`,
    `graph: ${report.graph.status}${report.graph.status === "loaded" ? ` entries=${report.graph.entries}` : ""} path=${report.graph.path}`,
    `competing_txs: candidates=${report.competing_candidates.length} analyzed=${report.analyzed_competitors.length}`,
  ];

  if (winner) {
    lines.push(
      `winner: ${winner.hash} index=${winner.transactionIndex} backrun_positioned=${String(winner.backrun_positioned)}`,
      `winner_style: ${winner.winner_style} winner_moved_price_beyond_prestate=${String(winner.winner_moved_price_beyond_prestate)} unpriced_token_in_flow=${winner.unpriced_token_in_flow.length === 0 ? "none" : winner.unpriced_token_in_flow.join(",")}`,
      `winner_payment_wei: ${winner.builderPaymentWei} priority_tip_wei=${winner.priorityTipWei} coinbase_transfer_wei=${winner.coinbaseTransferWei ?? "unavailable"}`,
      `our_bid_wei: ${report.bundle_submitted.bid ?? "unknown"} simulated_profit_wei=${report.bundle_submitted.simulated_profit ?? "unknown"}`,
      `winner_realized_profit_usd: ${formatUsd(winner.realizedProfitUsd)} builder_payment_usd=${formatUsd(winner.builderPaymentUsd)}`,
    );
    lines.push(...renderVenueLines(winner));
  } else {
    lines.push("winner: none");
  }

  if (verdict.builder_reach) {
    lines.push(
      `builder_reach: ${verdict.builder_reach.status}`,
      `builder_reach_note: ${verdict.builder_reach.note}`,
    );
  }
  if (verdict.non_comparable_winner) {
    lines.push(
      `non_comparable_winner: true`,
      `note: ${verdict.note ?? ""}`,
    );
  }
  lines.push(`one_shot: ${verdict.one_shot}`);
  return lines.join("\n");
}

function renderVenueLines(tx: CompetitorReport): string[] {
  if (tx.touchedVenues.length === 0) return ["winner_venues: none"];
  return [
    "winner_venues:",
    ...tx.touchedVenues.map((venue) =>
      `  - ${venue.protocol} ${venue.id} in_graph=${venue.in_graph === null ? "unavailable" : String(venue.in_graph)}`,
    ),
  ];
}

function formatNullableBool(value: boolean | null): string {
  return value === null ? "unknown" : String(value);
}

function formatUsd(value: RealizedProfitUsd): string {
  if (typeof value === "string") return value;
  return value === null ? "unknown" : value.toFixed(2);
}
