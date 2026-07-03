import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  builderPaymentWeiFromPrestate,
  fetchEthUsd,
  priceArb,
} from "../pnl/arb-profit.js";
import { ADDR, lower, TOPICS } from "../registry/protocols.js";
import { hexToBigInt, RpcClient, toQuantity } from "../rpc/client.js";
import { parseArgs, uniq, writeText } from "../util.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_POOLS_DIR = resolve(REPO_ROOT, "listener/searcher/pools");
const DEFAULT_GRAPH_PATH = resolve(DEFAULT_POOLS_DIR, "runtime-graph-pools.json");
const UNIV4_POOL_MANAGER = lower(ADDR.UNIV4_POOL_MANAGER);
const TOPIC_UNIV4_SWAP = lower(TOPICS.univ4Swap);
const TOPIC_UNIV3_SWAP = lower(TOPICS.univ3Swap);
const TOPIC_UNIV2_SWAP = lower((TOPICS as Record<string, string>).univ2Swap ?? "");

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

interface SourceQuery {
  address: string;
  origin: "opportunity_seen" | "triggering_receipt";
  venue?: string;
  id?: string;
}

interface TouchedVenue {
  protocol: "univ2" | "univ3" | "univ4";
  id: string;
  emitter: string;
  in_graph: boolean | null;
}

interface GraphMembership {
  status: "loaded" | "unavailable";
  path: string;
  entries: number;
  members: Set<string>;
}

interface CandidateTx {
  hash: string;
  transactionIndex: number;
  backrun_positioned: boolean;
  matched_source_addresses: string[];
}

interface CompetitorReport extends CandidateTx {
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
  realizedProfitUsd: number | null;
  profitConfidence: string;
  nativeTraceUsed: boolean;
  tracePrestateUsed: boolean;
  traceError: string | null;
  v4Swaps: number;
  v4PoolIds: string[];
  touchedVenues: TouchedVenue[];
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
  one_shot: string;
  builder_reach?: BuilderReach;
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
    };
    console.log(renderPendingSummary(report));
    if (outPath) await writeJson(outPath, report);
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
  };

  console.log(renderSummary(report));
  if (outPath) await writeJson(outPath, report);
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
    realizedProfitUsd: profit.realizedProfitUsd,
    profitConfidence: profit.profitConfidence,
    nativeTraceUsed: profit.nativeTraceUsed,
    tracePrestateUsed: payment.traceUsed,
    traceError: payment.traceError,
    v4Swaps: profit.v4Swaps.length,
    v4PoolIds: profit.v4PoolIds,
    touchedVenues: extractTouchedVenues(receipt, graph),
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

function extractTouchedVenues(receipt: Json, graph: GraphMembership | null): TouchedVenue[] {
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

function loadGraphMembership(path: string): GraphMembership {
  if (!existsSync(path)) return { status: "unavailable", path, entries: 0, members: new Set() };
  try {
    const text = readFileSyncText(path);
    const members = new Set<string>();
    collectGraphMembers(JSON.parse(text), members);
    return { status: "loaded", path, entries: members.size, members };
  } catch {
    return { status: "unavailable", path, entries: 0, members: new Set() };
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

function buildVerdict(event: Json, competitors: CompetitorReport[], builderReach: BuilderReach): Verdict {
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
  return {
    status: "priced",
    winner: winner.hash,
    winnerPaymentWei: winner.builderPaymentWei,
    outbid: bid === null ? null : winnerPayment > bid,
    route_gap_decisive: simulatedProfit === null ? null : winnerPayment > simulatedProfit,
    one_shot: oneShotSummary(event),
    builder_reach: builderReach,
  };
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

function formatUsd(value: number | null): string {
  return value === null ? "unknown" : value.toFixed(2);
}
