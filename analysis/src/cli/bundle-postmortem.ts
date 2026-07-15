import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { decodeTransfer } from "../decode/erc20.js";
import { deriveEdgeKindsFromLogs, deriveEdgeKindsFromLogsAndTrace } from "../learning/edge-kinds.js";
import type { LearningCase, PrimaryGap } from "../learning/learning-case.js";
import {
  loadLiveCompetitorProfile,
  positionAccountsForActors,
  type LiveCompetitorProfile,
} from "../live-competitors.js";
import {
  directCoinbasePaymentWeiFromCallTrace,
  fetchEthUsd,
  priceArb,
} from "../pnl/arb-profit.js";
import { buildFlowReport, formatTokenAmount, renderFlowWalk } from "../pnl/flow-walk.js";
import { decodeAnySwapLog, v4SwapFillFromLog } from "../pnl/swap-log-registry.js";
import { ADDR, lower, TOKEN_META, TOPICS } from "../registry/protocols.js";
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
// Any-tx mode constants live at module top: `await main()` runs at module scope, so consts declared
// below it are TDZ at call time (the census-report 83923ef crash class).
const KEEPER_CLAIM_SELECTORS = [
  "755da811",
  "42b1689d",
  "30c54085",
  // Scale/S88 distribute(): protocol rewards are allocated to the caller and
  // then sold through DEXes. The selector is embedded in Coffee's executor
  // batch calldata rather than being the top-level private entrypoint.
  "e4fc6b6d",
];
const RFQ_DEADLINE_MAX_AHEAD_S = 3600;
const RFQ_DEADLINE_MAX_BEHIND_S = 120;
const OTHER_SWAP_TOPIC_PROTOCOLS: Array<{ topic: string; protocol: string; landedAdapter?: string }> = [
  { topic: lower(TOPICS.curveTokenExchange), protocol: "curve", landedAdapter: "curve-exchange" },
  { topic: lower(TOPICS.curveCryptoTokenExchange), protocol: "curve", landedAdapter: "curve-exchange" },
  {
    topic: lower(TOPICS.curveTokenExchangeUnderlying),
    protocol: "curve",
    landedAdapter: "curve-exchange-underlying",
  },
  { topic: lower(TOPICS.balancerV2Swap), protocol: "balancerV2" },
  { topic: lower(TOPICS.pancakeV3Swap), protocol: "pancakeV3" },
  { topic: lower(TOPICS.dodoSwap), protocol: "dodo" },
  { topic: lower(TOPICS.fluidDexSwap), protocol: "fluidDex" },
  { topic: lower(TOPICS.psmSellGem), protocol: "psm" },
  { topic: lower(TOPICS.psmBuyGem), protocol: "psm" },
];
const V3_SLOT0_SELECTOR = "0x3850c7bd";
const V3_SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);
const FACTORY_IFACE = new ethers.Interface(["function factory() view returns (address)"]);
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
const USD_MICRO_SCALE = 1_000_000n;
const POSITION_DUST_USD_MICROS = 10_000n; // one cent
const REGISTERED_TOKEN_DUST_DECIMALS = 9; // one billionth of a token
// Preserve the pre-value-aware raw-unit boundary when no authoritative decimals are registered.
const UNKNOWN_TOKEN_DUST_RAW = 1000n;
const LIQUITY_PROTOCOL_EMITTER = "0xa2895d6a3bf110561dfe4b71ca539d84e1928b22";
const LIQUITY_BOLD = "0x6440f144b7e50d6a8439336510312d2f54beb01d";
const LIQUITY_INTEREST_ROUTER = "0x807def5e7d057df05c796f4bc75c3fe82bd6eee1";
const LIQUITY_STABILITY_POOL = "0x9502b7c397e9aa22fe9db7ef7daf21cd2aebe56b";
const LIQUITY_STABILITY_POOL_B_UPDATED = lower(ethers.id("B_Updated(uint256,uint256)"));
const LIQUITY_APPLY_BATCH_INTEREST_AND_FEE = 3n;
const SUSDS_MINT_CONTEXT_TOKENS = new Set([lower(ADDR.USDS), lower(ADDR.SUSDS)]);

export type WinnerStyle =
  | "atomic_loop"
  | "one_leg_inventory"
  | "inventory_vault_rebalance"
  | "keeper_claim"
  | "rfq_fill"
  | "sandwich"
  | "unknown";
export type TickDirection = "down" | "up";

// Atomicity / inventory-rebalance detector (ref decision-log F-009). A flash-wrapped inventory
// rebalance through private vault-wrapper contracts (e.g. 0x9be73297: steakUSDC/steakUSDT) presents
// a CLEAN executor intra-tx net (+profit only) and a closed-loop flash flow, so it otherwise
// misclassifies as atomic_loop and pollutes atomic-arb competitor analysis. It is NOT ours: it needs
// pre-held vault-share inventory (~$2.9M) and leaves a residual position in helper contracts.
//
// The robust general signal is an explicitly entity-owned ERC4626/vault-share mint/burn
// imbalance from the receipt — but ONLY for token contracts that also emitted an ERC4626
// Deposit/Withdraw in this tx. A generic Transfer(0x0, ...) is not enough, and protocol
// counterparties are not actor inventory. Pure receipt computation — no extra RPC.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
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
  /** v4 only: swap-affecting hook bits set (hooks & 0xcc != 0). null = hooks unknown. */
  hooked?: boolean | null;
  /** ROUTING-level reachability — in_graph is DISCOVERY-level and misleading for v4: a hooked v4
   *  pool sits in active-pools (in_graph=true) but token-graph admission skips it (0 edges), so a
   *  ring through it can never close. false here = the structural reason a take is unreproducible. */
  routing_admitted?: boolean | null;
  /** Topic is only the landed event family; factory facts carry actual venue identity. */
  venue_id?: string;
  factory?: string;
  identity_source?: "factory-call" | "event-shape-only" | "v4-pool-manager";
  landed_adapter?: string | null;
  routing_reason?: "not_in_graph" | "hooked_v4" | "routed_edge_unverified";
}

export interface GraphMembership {
  status: "loaded" | "unavailable";
  path: string;
  entries: number;
  members: Set<string>;
  /** v4 poolId → hooks address, from the sibling active-pools.json (empty when unavailable). */
  v4Hooks: Map<string, string>;
}

// Swap-affecting v4 hook permission bits — mirrors listener token-graph.ts V4_SWAP_HOOK_MASK
// (BEFORE_SWAP 0x80 | AFTER_SWAP 0x40 | BEFORE_SWAP_RETURNS_DELTA 0x08 | AFTER_SWAP_RETURNS_DELTA 0x04).
const V4_SWAP_HOOK_MASK = 0xccn;

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
  receipt_weth_unwrap_exit: boolean;
  winner_moved_price_beyond_prestate: boolean;
  unpriced_token_in_flow: string[];
  non_arb_signals?: NonArbSignals;
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
  // Retained for report/test compatibility. A generic vault selector is diagnostic only and cannot
  // establish competitor ownership without a receipt-grounded share/account imbalance.
  inventory_rebalance_selector_hit?: boolean;
  share_imbalance_tokens?: string[];
  retained_share_position_tokens?: string[];
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
    positionEthDeltaEth?: number;
    nativeTraceUsed: boolean;
  };
  transactionIndex: number;
  blockNumber: number;
  prestateBlock: number;
  // Optional: enables the rfq_fill deadline check (F-010). Callers without a block header simply
  // skip that signal; keeper_claim detection works regardless.
  blockTimestamp?: number | null;
  // Ownership is caller-selected. CLI callers pass the profile they loaded (including a custom
  // --watch-config); library callers may instead supply already-resolved entity position accounts.
  competitorProfile?: LiveCompetitorProfile;
  positionAccounts?: Iterable<string>;
}

export interface WinnerStyleAnalysis {
  winner_style: WinnerStyle;
  receipt_weth_unwrap_exit: boolean;
  winner_moved_price_beyond_prestate: boolean;
  unpriced_token_in_flow: string[];
  retained_share_position_tokens?: string[];
  non_arb_signals?: NonArbSignals;
}

const USAGE = `Usage: npm run bundle-postmortem -- --events <jsonl> (--tx <hash-or-prefix> | --opportunity <id>) --rpc <url> [--watch-config <live-competitors.json>] [--graph <runtime-graph-pools.json>] [--blockscan-log <mev-live.log>] [--out <report.json>]
  --tx with a FULL hash that matches no bundle_submitted falls back to any-tx competitor mode:
  PnL + winner_style (incl. keeper_claim/rfq_fill signals) + venues incl. non-univ lineages +
  same-block prior movers + our-events venue overlap.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || Object.keys(args).length === 0) usage();

  const eventsPath = stringArg(args, "events");
  const txQuery = stringArg(args, "tx", false);
  const opportunityQuery = stringArg(args, "opportunity", false);
  const rpcUrl = stringArg(args, "rpc");
  const graphPath = args.graph ? resolveCliPath(String(args.graph)) : DEFAULT_GRAPH_PATH;
  const blockScanLogPath = args["blockscan-log"] ? resolveCliPath(String(args["blockscan-log"])) : "";
  const outPath = args.out ? resolveCliPath(String(args.out)) : "";
  const competitorProfile = loadLiveCompetitorProfile(
    args["watch-config"] ? resolveCliPath(String(args["watch-config"])) : undefined,
  );

  if (!eventsPath || !rpcUrl || Boolean(txQuery) === Boolean(opportunityQuery)) usage();

  const loaded = await readJsonlSkippingBad(resolveCliPath(eventsPath));
  let match: MatchResult;
  try {
    match = findBundleSubmitted(loaded.events, txQuery, opportunityQuery);
  } catch (err) {
    // Any-tx fallback (F-010/F-011/F-012 workflow): a full hash that matched NONE of our
    // bundle_submitted events is a competitor/foreign tx — post-mortem it directly from the chain
    // instead of erroring. Only the no-match case falls back: an Ambiguous multi-match is still an
    // own-bundle query (disambiguate with --opportunity), and prefix queries need the full hash.
    if ((err as { code?: string }).code === "NO_BUNDLE_MATCH" && /^0x[0-9a-fA-F]{64}$/.test(txQuery)) {
      console.error(`[bundle-postmortem] no bundle_submitted matched --tx ${txQuery} — any-tx competitor mode.`);
      await anyTxPostmortem(
        new RpcClient(rpcUrl),
        txQuery,
        loaded,
        graphPath,
        outPath,
        resolveCliPath(eventsPath),
        blockScanLogPath,
        competitorProfile,
      );
      return;
    }
    throw err;
  }
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
  const ethUsd = selected.length > 0 ? await fetchEthUsd(rpc, toQuantity(landingBlockNumber)) : null;
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
        blockInfo.timestamp,
        competitorProfile,
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

// NOTE: `.catch()` not top-level `await` — a top-level await (even inside this entry guard) marks the
// whole module as top-level-await, which esbuild's cjs transform rejects, breaking `import`s of
// exported helpers (loadGraphMembership etc.) under tsx on the node. Keep this await-free so the
// v4-aware membership check is importable/runnable anywhere.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
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

// ---------------------------------------------------------------------------
// Any-tx competitor postmortem (no bundle_submitted required).
// Codifies the F-010/F-011/F-012 manual workflow: PnL, per-leg venues incl. non-univ lineages,
// winner_style with non-arb signals, same-block prior movers (atomic vs backrun), and whether OUR
// live events had any signal on the touched venues at that block.
// ---------------------------------------------------------------------------

export interface OtherVenue {
  protocol: string;
  id: string;
  emitter: string;
  in_graph: boolean | null;
  landed_adapter?: string;
}

// Swap-like venues OUTSIDE the univ2/3/4 lineages extractTouchedVenues covers — the census verdict
// is blind to these (filed defect), so the any-tx report surfaces them explicitly.
export function extractOtherVenues(receipt: Json, graph: GraphMembership | null): OtherVenue[] {
  const out: OtherVenue[] = [];
  const seen = new Set<string>();
  for (const log of receipt?.logs ?? []) {
    const emitter = lower(String(log?.address ?? ""));
    const topic0 = lower(String(log?.topics?.[0] ?? ""));
    const hit = OTHER_SWAP_TOPIC_PROTOCOLS.find((entry) => entry.topic === topic0);
    if (!hit || !isAddress(emitter) || seen.has(emitter)) continue;
    seen.add(emitter);
    out.push({
      protocol: hit.protocol,
      id: emitter,
      emitter,
      in_graph: graph?.status === "loaded" ? graph.members.has(emitter) : null,
      ...(hit.landedAdapter ? { landed_adapter: hit.landedAdapter } : {}),
    });
  }
  return out;
}

const MODIFY_LIQ_IFACE = new ethers.Interface([
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]);

export interface V4LegFill {
  poolId: string;
  amount0: string; // signed BalanceDelta (swapper view): negative = paid in, positive = received
  amount1: string;
  zeroForOne: boolean;
  jit: boolean; // liquidity was self-added to this pool earlier in the same tx (see detectJitLiquidity)
}

// The REAL per-leg v4 fills the competitor moved (the census/touchedVenues layer only surfaces poolIds,
// not amounts). Feeds quote-fidelity reconciliation (validate-v4-quote) + loss attribution.
export function decodeV4SwapFills(receipt: Json, jitPoolIds: Set<string>): V4LegFill[] {
  const out: V4LegFill[] = [];
  for (const log of receipt?.logs ?? []) {
    if (lower(String(log?.address ?? "")) !== UNIV4_POOL_MANAGER) continue;
    const fill = v4SwapFillFromLog(log);
    if (!fill) continue;
    out.push({
      poolId: fill.poolId,
      amount0: fill.amount0.toString(),
      amount1: fill.amount1.toString(),
      zeroForOne: fill.zeroForOne,
      jit: jitPoolIds.has(fill.poolId),
    });
  }
  return out;
}

// v4 poolIds that had liquidity ADDED (ModifyLiquidity, positive delta) BEFORE their Swap in the SAME
// tx = JIT self-provided liquidity. A JIT'd leg is not reproducible against standing liquidity, so it
// marks a competitor take as non-replicable — a distinct signal from a pool/path gap or a quote gap.
export function detectJitLiquidity(receipt: Json): string[] {
  const addTopic = lower(TOPICS.univ4ModifyLiquidity);
  const swapTopic = lower(TOPICS.univ4Swap);
  const firstAdd = new Map<string, number>();
  const firstSwap = new Map<string, number>();
  for (const log of receipt?.logs ?? []) {
    if (lower(String(log?.address ?? "")) !== UNIV4_POOL_MANAGER) continue;
    const topic0 = lower(String(log?.topics?.[0] ?? ""));
    const poolId = lower(String(log?.topics?.[1] ?? ""));
    const li = quantityToNumber(log?.logIndex) ?? 0;
    if (topic0 === addTopic) {
      let delta = 0n;
      try {
        const parsed = MODIFY_LIQ_IFACE.parseLog({ topics: log.topics, data: log.data ?? "0x" });
        delta = BigInt(String(parsed?.args?.[4] ?? 0n));
      } catch { /* not a ModifyLiquidity we can decode */ }
      if (delta > 0n && li < (firstAdd.get(poolId) ?? Number.POSITIVE_INFINITY)) firstAdd.set(poolId, li);
    } else if (topic0 === swapTopic) {
      if (li < (firstSwap.get(poolId) ?? Number.POSITIVE_INFINITY)) firstSwap.set(poolId, li);
    }
  }
  const jit: string[] = [];
  for (const [poolId, addLi] of firstAdd) {
    const swapLi = firstSwap.get(poolId);
    if (swapLi !== undefined && addLi < swapLi) jit.push(poolId);
  }
  return jit;
}

export interface PriorMover {
  txHash: string;
  transactionIndex: number;
  emitter: string;
}

export function partitionPriorMoversByActor(
  movers: PriorMover[],
  actorByTxHash: ReadonlyMap<string, string>,
  actor: string,
): { external: PriorMover[]; sameActor: PriorMover[] } {
  const normalizedActor = lower(actor);
  const external: PriorMover[] = [];
  const sameActor: PriorMover[] = [];
  for (const mover of movers) {
    const moverActor = lower(actorByTxHash.get(lower(mover.txHash)) ?? "");
    (moverActor && moverActor === normalizedActor ? sameActor : external).push(mover);
  }
  return { external, sameActor };
}

// Any tx earlier in the same block that touched one of the winner's venues — discriminates an
// in-block reaction (backrun-like) from a standing-state take (block-scan-like), 0x5d8e9097 method.
async function findPriorMovers(
  rpc: RpcClient,
  blockNumber: number,
  ourIndex: number,
  ourHash: string,
  addressVenues: string[],
  v4PoolIds: string[],
): Promise<PriorMover[]> {
  const movers = new Map<string, PriorMover>();
  const v4Pools = new Set(v4PoolIds.map(lower));
  const emitters = uniq([
    ...addressVenues.map(lower),
    ...(v4Pools.size > 0 ? [UNIV4_POOL_MANAGER] : []),
  ]).slice(0, 8);
  for (const emitter of emitters) {
    const logs = await rpc.getLogs({
      address: emitter,
      fromBlock: toQuantity(blockNumber),
      toBlock: toQuantity(blockNumber),
    });
    for (const log of logs) {
      const hash = lower(String(log.transactionHash ?? ""));
      const index = quantityToNumber(log.transactionIndex);
      if (!hash || hash === lower(ourHash) || index >= ourIndex) continue;
      if (emitter === UNIV4_POOL_MANAGER) {
        const poolId = lower(String(log?.topics?.[1] ?? ""));
        if (!v4Pools.has(poolId)) continue;
      }
      const existing = movers.get(hash);
      if (!existing || index < existing.transactionIndex) {
        movers.set(hash, { txHash: hash, transactionIndex: index, emitter });
      }
    }
  }
  return [...movers.values()].sort((a, b) => a.transactionIndex - b.transactionIndex);
}

interface OurEventsAtBlock {
  total: number;
  by_type: Record<string, number>;
  venue_overlap: Array<{ type: string; pool: string; victim_hash?: string }>;
}

export type BlockScanLogStatus =
  | "complete"
  | "budget_exceeded"
  | "skipped_busy"
  | "error"
  | "incomplete"
  | "not_running"
  | "unknown_log_rotated"
  | "unknown_log_not_covered"
  | "unknown_log_empty";

export interface BlockScanRingEvidence {
  ring: string;
  tokens: string[];
  net: string | null;
  error?: string;
}

export interface BlockScanActivity {
  sourceBlock: number;
  status: BlockScanLogStatus;
  ran: boolean;
  detailComplete: boolean;
  passLine?: string;
  scannedTokens: Set<string>;
  rings: BlockScanRingEvidence[];
  ringCount: number;
  anySubmitted: boolean;
  skippedBusy: boolean;
  budgetExceeded: boolean;
  minBlock?: number;
  maxBlock?: number;
}

export function blockScanSourceBlockForTarget(targetBlock: number): number {
  return Math.max(0, targetBlock - 1);
}

export function competitorArbTokenSet(
  flowSteps: Array<{ token: string }>,
  pricedDeltas: TokenDelta[],
  unpricedDeltas: TokenDelta[],
): Set<string> {
  const tokens = new Set<string>();
  for (const value of [
    ...flowSteps.map((step) => step.token),
    ...pricedDeltas.map((delta) => delta.token),
    ...unpricedDeltas.map((delta) => delta.token),
  ]) {
    const token = lower(value);
    if (isAddress(token) && token !== "0x0000000000000000000000000000000000000000") tokens.add(token);
  }
  return tokens;
}

/**
 * Parse one source-block pass from the text log. Solve/submission lines do not
 * carry a block number, so attribution is stateful: a real warm line opens the
 * pass and its matching stage line closes it. A later `skipped=busy` marker is
 * an overlapping head notification, not a new active pass.
 */
export function blockScanActivityAtBlock(logText: string, sourceBlock: number): BlockScanActivity {
  const anyBlockRe = /\[searcher\/blockscan\]\s+block=(\d+)\b/;
  const warmRe = /\[searcher\/blockscan\]\s+block=(\d+)\s+warm=(?:full|incremental)\b/;
  const summaryRe = /\[searcher\/blockscan\]\s+block=(\d+)\s+scannedPairs=/;
  const stageRe = /\[searcher\/blockscan\]\s+block=(\d+)\s+stage\b/;
  const busyRe = /\[searcher\/blockscan\]\s+block=(\d+)\s+skipped=busy\b/;
  const budgetRe = /\[searcher\/blockscan\]\s+block=(\d+)\s+pass_budget_exceeded\b/;
  const errorRe = /\[searcher\/blockscan\]\s+block=(\d+)\s+(?:fork error|scan error):/;
  const solveRe = /\[searcher\/blockscan\]\s+(?:block=(\d+)\s+)?solve ring=(\S+)\s+net=(null|-?\d+)(?:\s+error=(\S+))?/;
  const submittedRe = /\[searcher\/blockscan\]\s+(?:block=(\d+)\s+)?submitted\s+atomic\s+via\b/;

  let minBlock: number | undefined;
  let maxBlock: number | undefined;
  let activeBlock: number | null = null;
  let sawWarm = false;
  let sawSummary = false;
  let sawStage = false;
  let skippedBusy = false;
  let budgetExceeded = false;
  let sawError = false;
  let passLine: string | undefined;
  let anySubmitted = false;
  const rings: BlockScanRingEvidence[] = [];
  const scannedTokens = new Set<string>();

  for (const line of logText.split(/\r?\n/)) {
    const anyBlock = line.match(anyBlockRe);
    if (anyBlock) {
      const block = Number(anyBlock[1]);
      minBlock = minBlock === undefined ? block : Math.min(minBlock, block);
      maxBlock = maxBlock === undefined ? block : Math.max(maxBlock, block);
    }

    const busy = line.match(busyRe);
    if (busy) {
      if (Number(busy[1]) === sourceBlock) skippedBusy = true;
      // Crucial: a busy notification is emitted while another pass is still
      // producing untagged solve lines. It must not change activeBlock.
      continue;
    }

    const warm = line.match(warmRe);
    if (warm) {
      activeBlock = Number(warm[1]);
      if (activeBlock === sourceBlock) {
        sawWarm = true;
        passLine = line;
      }
      continue;
    }

    const budget = line.match(budgetRe);
    if (budget && Number(budget[1]) === sourceBlock) budgetExceeded = true;

    const scanError = line.match(errorRe);
    if (scanError && Number(scanError[1]) === sourceBlock) sawError = true;

    const summary = line.match(summaryRe);
    if (summary && Number(summary[1]) === sourceBlock) sawSummary = true;

    const stage = line.match(stageRe);
    if (stage) {
      const block = Number(stage[1]);
      if (block === sourceBlock) {
        sawStage = true;
        passLine = line;
      }
      if (activeBlock === block) activeBlock = null;
      continue;
    }

    const solve = line.match(solveRe);
    const solveBlock = solve?.[1] ? Number(solve[1]) : activeBlock;
    if (solve && solveBlock === sourceBlock) {
      const tokens = [...solve[2].matchAll(/0x[a-fA-F0-9]{40}/g)].map((match) => lower(match[0]));
      for (const token of tokens) scannedTokens.add(token);
      rings.push({
        ring: solve[2],
        tokens: uniq(tokens),
        net: solve[3] === "null" ? null : solve[3],
        error: solve[4],
      });
    }
    const submitted = line.match(submittedRe);
    const submittedBlock = submitted?.[1] ? Number(submitted[1]) : activeBlock;
    if (submitted && submittedBlock === sourceBlock) anySubmitted = true;
  }

  const detailComplete = sawWarm && sawSummary && sawStage;
  let status: BlockScanLogStatus;
  if (minBlock === undefined || maxBlock === undefined) status = "unknown_log_empty";
  else if (sourceBlock < minBlock) status = "unknown_log_rotated";
  else if (sourceBlock > maxBlock) status = "unknown_log_not_covered";
  else if (detailComplete && budgetExceeded) status = "budget_exceeded";
  else if (detailComplete) status = "complete";
  else if (sawError) status = "error";
  else if (sawWarm || sawSummary || sawStage || budgetExceeded) status = "incomplete";
  else if (skippedBusy) status = "skipped_busy";
  else status = "not_running";

  return {
    sourceBlock,
    status,
    ran: sawStage,
    detailComplete,
    passLine,
    scannedTokens,
    rings,
    ringCount: rings.length,
    anySubmitted,
    skippedBusy,
    budgetExceeded,
    minBlock,
    maxBlock,
  };
}

export interface OurBlockScanForTarget {
  target_block: number;
  source_block: number;
  status: BlockScanLogStatus | "log_unavailable";
  ran: boolean;
  detail_complete: boolean;
  pass_line?: string;
  solve_ring_count: number;
  solve_ring_token_count: number;
  competitor_token_count: number;
  token_overlap_count: number;
  token_overlap_tokens: string[];
  fully_covered_by_ring_count: number;
  any_submitted: boolean;
  jsonl_submission_seen: boolean;
  related_jsonl_submission_seen: boolean;
  related_jsonl_submission_count: number;
  text_submission_seen: boolean;
  log_min_source_block?: number;
  log_max_source_block?: number;
  log_error?: string;
  limitations: string[];
}

export function blockScanSubmissionCycleTokenSets(events: Json[], targetBlock: number): Set<string>[] {
  return events
    .filter((event) =>
      event?.type === "bundle_submitted"
      && event?.opportunity_kind === "block-scan-arb"
      && Number(event?.target_block) === targetBlock
    )
    .map((event) => new Set(
      [...String(event?.cycle_id ?? "").matchAll(/0x[a-fA-F0-9]{40}/g)]
        .map((match) => lower(match[0])),
    ));
}

async function blockScanEvidenceForTarget(
  logPath: string,
  targetBlock: number,
  competitorTokens: Set<string>,
  events: Json[],
): Promise<OurBlockScanForTarget> {
  const sourceBlock = blockScanSourceBlockForTarget(targetBlock);
  const submissionCycleTokenSets = blockScanSubmissionCycleTokenSets(events, targetBlock);
  const jsonlSubmissionSeen = submissionCycleTokenSets.length > 0;
  const relatedJsonlSubmissionCount = competitorTokens.size === 0
    ? 0
    : submissionCycleTokenSets.filter((tokens) =>
      [...competitorTokens].every((token) => tokens.has(token))
    ).length;
  const base = {
    target_block: targetBlock,
    source_block: sourceBlock,
    competitor_token_count: competitorTokens.size,
    limitations: [
      "ring logs contain solved candidate rings, not the full scannedPairs token universe",
      "native ETH without a wrapped-token flow edge is not represented in the token join",
      "text submission lines are pass-wide; only JSONL cycle_id tokens can establish route-token coverage",
    ],
  };

  let logText: string;
  try {
    logText = await readFile(logPath, "utf8");
  } catch (err) {
    return {
      ...base,
      status: "log_unavailable",
      ran: false,
      detail_complete: false,
      solve_ring_count: 0,
      solve_ring_token_count: 0,
      token_overlap_count: 0,
      token_overlap_tokens: [],
      fully_covered_by_ring_count: 0,
      any_submitted: jsonlSubmissionSeen,
      jsonl_submission_seen: jsonlSubmissionSeen,
      related_jsonl_submission_seen: relatedJsonlSubmissionCount > 0,
      related_jsonl_submission_count: relatedJsonlSubmissionCount,
      text_submission_seen: false,
      log_error: err instanceof Error ? err.message : String(err),
    };
  }

  const activity = blockScanActivityAtBlock(logText, sourceBlock);
  const overlap = [...competitorTokens]
    .filter((token) => activity.scannedTokens.has(token))
    .sort();
  const fullyCoveredByRingCount = competitorTokens.size === 0
    ? 0
    : activity.rings.filter((ring) => {
      const ringTokens = new Set(ring.tokens);
      return [...competitorTokens].every((token) => ringTokens.has(token));
    }).length;
  return {
    ...base,
    status: activity.status,
    ran: activity.ran,
    detail_complete: activity.detailComplete,
    pass_line: activity.passLine,
    solve_ring_count: activity.ringCount,
    solve_ring_token_count: activity.scannedTokens.size,
    token_overlap_count: overlap.length,
    token_overlap_tokens: overlap,
    fully_covered_by_ring_count: fullyCoveredByRingCount,
    any_submitted: activity.anySubmitted || jsonlSubmissionSeen,
    jsonl_submission_seen: jsonlSubmissionSeen,
    related_jsonl_submission_seen: relatedJsonlSubmissionCount > 0,
    related_jsonl_submission_count: relatedJsonlSubmissionCount,
    text_submission_seen: activity.anySubmitted,
    log_min_source_block: activity.minBlock,
    log_max_source_block: activity.maxBlock,
  };
}

// Did OUR live pipeline emit anything for this block touching the winner's venues? (v4 caveat: our
// events store the PoolManager address, not the poolId, so a v4 overlap is manager-level only.)
function ourEventsAtBlock(events: Json[], blockNumber: number, venueEmitters: Set<string>): OurEventsAtBlock {
  const byType: Record<string, number> = {};
  const overlap: OurEventsAtBlock["venue_overlap"] = [];
  let total = 0;
  for (const event of events) {
    if (Number(event?.target_block) !== blockNumber) continue;
    total += 1;
    const type = String(event?.type ?? "unknown");
    byType[type] = (byType[type] ?? 0) + 1;
    const pool = lower(String(event?.pool ?? ""));
    if (pool && venueEmitters.has(pool)) {
      overlap.push({ type, pool, victim_hash: event?.victim_hash });
    }
  }
  return { total, by_type: byType, venue_overlap: overlap };
}

interface FlowSummaryEntry {
  token: string;
  executor_edge_in: string;
  top_net: Array<{ address: string; net: string }>;
}

function summarizeFlowLedger(
  ledger: Map<string, FlowLedgerToken>,
  executors: Set<string>,
): FlowSummaryEntry[] {
  const out: FlowSummaryEntry[] = [];
  for (const [token, { net, edges }] of ledger) {
    let executorEdgeIn = 0n;
    for (const edge of edges) if (executors.has(edge.to)) executorEdgeIn += edge.amount;
    const topNet = [...net.entries()]
      .filter(([, amount]) => amount !== 0n)
      .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
      .slice(0, 3)
      .map(([address, amount]) => ({ address, net: amount.toString() }));
    out.push({ token, executor_edge_in: executorEdgeIn.toString(), top_net: topNet });
    if (out.length >= 10) break;
  }
  return out;
}

async function anyTxPostmortem(
  rpc: RpcClient,
  txHash: string,
  loaded: JsonlLoad,
  graphPath: string,
  outPath: string,
  eventsPath: string,
  blockScanLogPath: string,
  competitorProfile: LiveCompetitorProfile,
): Promise<void> {
  const [tx, receipt] = await Promise.all([rpc.getTransaction(txHash), rpc.getReceipt(txHash)]);
  if (!tx || !receipt) throw new Error(`any-tx mode: ${txHash} not found on-chain (need the full hash of a mined tx)`);
  const blockNumber = quantityToNumber(receipt.blockNumber);
  const transactionIndex = quantityToNumber(receipt.transactionIndex);
  const block = await rpc.getBlockByNumber(blockNumber, true);
  const baseFeePerGas = block?.baseFeePerGas != null ? hexToBigInt(block.baseFeePerGas) : 0n;
  const coinbase = lower(block?.miner ?? "");
  const blockTimestamp = quantityToNumber(block?.timestamp);
  const graph = loadGraphMembership(graphPath);
  const ethUsd = await fetchEthUsd(rpc, toQuantity(blockNumber));
  const profit = await priceArb(rpc, txHash, tx, receipt, ethUsd, {
    entityActors: [tx?.to, tx?.from].filter((actor): actor is string => typeof actor === "string" && actor.length > 0),
    allowTrace: true,
    coinbase,
    baseFeePerGas,
  });
  const payment = await computeBuilderPaymentWei(rpc, txHash, receipt, baseFeePerGas, coinbase);
  const styleAnalysis = await classifyWinnerTxStyle({
    rpc,
    txHash,
    tx,
    receipt,
    profit,
    transactionIndex,
    blockNumber,
    prestateBlock: Math.max(blockNumber - 1, 0),
    blockTimestamp,
    competitorProfile,
  });
  const touchedVenues = await resolveLandedTouchedVenues(rpc, receipt, graph, blockNumber);
  const otherVenues = extractOtherVenues(receipt, graph);
  const jitPoolIds = detectJitLiquidity(receipt);
  const v4LegFills = decodeV4SwapFills(receipt, new Set(jitPoolIds));
  const addressVenues = [
    ...touchedVenues.filter((venue) => venue.protocol !== "univ4").map((venue) => venue.emitter),
    ...otherVenues.map((venue) => venue.emitter),
  ];
  const v4PoolIds = touchedVenues.filter((venue) => venue.protocol === "univ4").map((venue) => venue.id);
  const priorMoverCandidates = await findPriorMovers(
    rpc,
    blockNumber,
    transactionIndex,
    txHash,
    addressVenues,
    v4PoolIds,
  );
  const actorByTxHash = new Map<string, string>();
  for (const blockTx of Array.isArray(block?.transactions) ? block.transactions : []) {
    if (typeof blockTx !== "object" || blockTx === null) continue;
    const hash = lower(String(blockTx.hash ?? ""));
    const from = lower(String(blockTx.from ?? ""));
    if (hash && from) actorByTxHash.set(hash, from);
  }
  const priorMovers = partitionPriorMoversByActor(
    priorMoverCandidates,
    actorByTxHash,
    lower(String(tx?.from ?? "")),
  );
  const venueEmitters = new Set([...addressVenues.map(lower), ...(v4PoolIds.length > 0 ? [UNIV4_POOL_MANAGER] : [])]);
  const executors = competitorBeneficiaries(tx, receipt, competitorProfile);
  const flowReport = await buildFlowReport(rpc, receipt, executors);
  const competitorTokens = competitorArbTokenSet(
    flowReport.steps,
    profit.pricedDeltas,
    profit.unpricedDeltas,
  );
  const blockScanEvidence = blockScanLogPath
    ? await blockScanEvidenceForTarget(
      blockScanLogPath,
      blockNumber,
      competitorTokens,
      loaded.events,
    )
    : undefined;
  const report = {
    command: "bundle-postmortem" as const,
    mode: "any_tx" as const,
    events: { path: eventsPath, parsed: loaded.parsed, skipped_unparsable: loaded.skipped },
    tx: {
      hash: lower(txHash),
      from: lower(tx?.from ?? ""),
      to: tx?.to ? lower(tx.to) : null,
      status: receipt?.status ? String(receipt.status) : null,
      block: blockNumber,
      transactionIndex,
      gasUsed: hexToBigInt(receipt?.gasUsed).toString(),
      priorityTipWei: payment.priorityTipWei.toString(),
      builderPaymentWei: payment.builderPaymentWei.toString(),
    },
    block: {
      number: blockNumber,
      miner: coinbase,
      builder: decodeExtraData(block?.extraData),
      timestamp: blockTimestamp,
    },
    pnl: {
      ethUsd,
      realizedProfitUsd: realizedProfitUsdForReport(profit.realizedProfitUsd, profit.unpricedDeltas),
      builderPaymentUsd: profit.builderPaymentUsd,
      gasCostUsd: profit.gasCostUsd,
      // net = realized − total gas (NOT realized − builderPayment — that double-counts a
      // coinbase-transfer bribe already excluded from realized). See arb-profit.ts.
      netProfitUsd: profit.netProfitUsd,
      unpricedDeltas: profit.unpricedDeltas,
    },
    winner_style: styleAnalysis.winner_style,
    receipt_weth_unwrap_exit: styleAnalysis.receipt_weth_unwrap_exit,
    non_comparable_winner: isNonComparableWinnerStyle(styleAnalysis.winner_style) ? true : undefined,
    non_arb_signals: styleAnalysis.non_arb_signals,
    edgeKinds: deriveEdgeKindsFromLogsAndTrace(receipt?.logs, payment.callTrace),
    touchedVenues,
    v4LegFills,
    jitPoolIds: jitPoolIds.length > 0 ? jitPoolIds : undefined,
    otherVenues,
    out_of_graph_venues: [
      ...touchedVenues.filter((venue) => venue.in_graph === false),
      ...otherVenues.filter((venue) => venue.in_graph === false),
    ],
    // Backward-compatible raw field: all prior movers. Consumers that need
    // causal attribution should use the explicit external/same-actor split.
    prior_same_block_movers: priorMoverCandidates,
    external_prior_same_block_movers: priorMovers.external,
    same_actor_prior_same_block_movers: priorMovers.sameActor,
    positioning: priorMovers.external.length === 0 ? "standing_state_take" : "after_in_block_movers",
    our_events_at_block: ourEventsAtBlock(loaded.events, blockNumber, venueEmitters),
    our_blockscan_for_target: blockScanEvidence,
    flow: summarizeFlowLedger(buildFlowLedger(receipt), executors),
    flow_walk: flowReport.steps.map((step) => ({
      logIndex: step.logIndex,
      kind: step.kind,
      token: step.token,
      symbol: flowReport.tokens.get(step.token)?.symbol,
      from: step.from,
      to: step.to,
      amount: step.amount.toString(),
      display: formatTokenAmount(step.amount, flowReport.tokens.get(step.token)?.decimals ?? null),
    })),
    graph: { status: graph.status, path: graph.path, entries: graph.entries },
  };
  console.log(renderAnyTxSummary(report));
  console.log(renderFlowWalk(flowReport));
  if (outPath) await writeJson(outPath, report);
}

function renderAnyTxSummary(report: any): string {
  const lines: string[] = [];
  const fmtUsd = (value: unknown) => (typeof value === "number" ? `$${value.toFixed(2)}` : String(value ?? "—"));
  lines.push(`any-tx postmortem ${report.tx.hash}`);
  lines.push(`  block ${report.tx.block} idx ${report.tx.transactionIndex} builder=${report.block.builder || "?"} status=${report.tx.status}`);
  lines.push(`  pnl: realized ${fmtUsd(report.pnl.realizedProfitUsd)} builder ${fmtUsd(report.pnl.builderPaymentUsd)} net ${fmtUsd(report.pnl.netProfitUsd)} (ethUsd ${report.pnl.ethUsd})`);
  const signals = report.non_arb_signals ?? {};
  lines.push(`  winner_style: ${report.winner_style}${report.non_comparable_winner ? " (NON-COMPARABLE)" : ""}`
    + ` [claim_selector=${signals.claim_selector_hit} sink_cut=${signals.conserved_sink_cut}`
    + ` rfq_sigs=${signals.rfq_sig_count} deadline=${signals.rfq_deadline_in_calldata}`
    + ` external_mints=${(signals.external_mint_recipients ?? []).length}`
    + ` mint_context=${signals.external_mint_protocol_context ?? "none"}]`
    + ` edges=[${(report.edgeKinds ?? []).join(",")}]`);
  if ((signals.external_mint_recipients ?? []).length > 0) {
    lines.push(`  external_mint_recipients: ${signals.external_mint_recipients.join(",")}`);
  }
  const venueLine = (venue: any) => {
    const identity = venue.venue_id ? ` venue=${venue.venue_id}` : "";
    const factory = venue.factory ? ` factory=${venue.factory}` : "";
    const adapter = venue.landed_adapter ? ` adapter=${venue.landed_adapter}` : "";
    const routing = venue.routing_admitted === undefined
      ? ""
      : ` routing=${venue.routing_admitted}${venue.routing_reason ? `(${venue.routing_reason})` : ""}`;
    return `${venue.protocol}:${venue.id.slice(0, 12)}… in_graph=${venue.in_graph}${identity}${factory}${adapter}${routing}`;
  };
  lines.push(`  venues: ${[...report.touchedVenues, ...report.otherVenues].map(venueLine).join(" | ") || "none"}`);
  if (report.out_of_graph_venues.length > 0) {
    lines.push(`  OUT-OF-GRAPH: ${report.out_of_graph_venues.map(venueLine).join(" | ")}`);
  }
  const positioningMovers = report.external_prior_same_block_movers ?? report.prior_same_block_movers;
  lines.push(positioningMovers.length === 0
    ? "  positioning: standing_state_take (no external same-block prior mover on any touched venue)"
    : `  positioning: after_in_block_movers — ${positioningMovers
      .map((mover: PriorMover) => `idx ${mover.transactionIndex} ${mover.txHash.slice(0, 10)}`)
      .join(", ")}`);
  if ((report.same_actor_prior_same_block_movers ?? []).length > 0) {
    lines.push(`  actor-batch context: ${report.same_actor_prior_same_block_movers
      .map((mover: PriorMover) => `idx ${mover.transactionIndex} ${mover.txHash.slice(0, 10)}`)
      .join(", ")} (excluded as external source)`);
  }
  const ours = report.our_events_at_block;
  const byType = Object.entries(ours.by_type).map(([type, count]) => `${count} ${type}`).join(", ") || "none";
  lines.push(`  our events @block: ${ours.total} (${byType}); venue overlap: ${ours.venue_overlap.length}`
    + (ours.venue_overlap.length === 0 ? " → no JSONL/backrun-lane venue signal" : ""));
  const blockScan = report.our_blockscan_for_target;
  if (blockScan) {
    lines.push(
      `  our block-scan for target ${blockScan.target_block}: source=${blockScan.source_block} `
      + `status=${blockScan.status} rings=${blockScan.solve_ring_count} `
      + `token_overlap=${blockScan.token_overlap_count}/${blockScan.competitor_token_count} `
      + `pass_submitted=${blockScan.any_submitted} `
      + `related_jsonl_submitted=${blockScan.related_jsonl_submission_count}`,
    );
  }
  return lines.join("\n");
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
    throw Object.assign(
      new Error(`No bundle_submitted matched --tx ${txQuery}. Near misses:\n${formatNearMisses(bundles, txQuery, "tx_hash")}`),
      { code: "NO_BUNDLE_MATCH" },
    );
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
  blockTimestamp: number | null = null,
  competitorProfile?: LiveCompetitorProfile,
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
    blockTimestamp,
    competitorProfile,
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
    touchedVenues: await resolveLandedTouchedVenues(rpc, receipt, graph, blockNumber),
    edgeKinds: deriveEdgeKindsFromLogsAndTrace(receipt?.logs, payment.callTrace),
    winner_style: winnerStyleAnalysis.winner_style,
    receipt_weth_unwrap_exit: winnerStyleAnalysis.receipt_weth_unwrap_exit,
    winner_moved_price_beyond_prestate: winnerStyleAnalysis.winner_moved_price_beyond_prestate,
    unpriced_token_in_flow: winnerStyleAnalysis.unpriced_token_in_flow,
    non_arb_signals: winnerStyleAnalysis.non_arb_signals,
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
  callTrace: Json | null;
}> {
  const gasUsed = hexToBigInt(receipt?.gasUsed);
  const effectiveGasPrice = hexToBigInt(receipt?.effectiveGasPrice);
  const priorityFee = effectiveGasPrice > baseFeePerGas ? effectiveGasPrice - baseFeePerGas : 0n;
  const priorityTipWei = gasUsed * priorityFee;
  try {
    const trace = await rpc.traceTransaction(txHash);
    const coinbaseTransferWei = directCoinbasePaymentWeiFromCallTrace(trace, coinbase);
    return {
      priorityTipWei,
      coinbaseTransferWei,
      builderPaymentWei: priorityTipWei + coinbaseTransferWei,
      traceUsed: true,
      traceError: null,
      callTrace: trace,
    };
  } catch (err) {
    return {
      priorityTipWei,
      coinbaseTransferWei: null,
      builderPaymentWei: priorityTipWei,
      traceUsed: false,
      traceError: (err as Error).message,
      callTrace: null,
    };
  }
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

/**
 * Resolve landed factory identity at the transaction block. Swap topics only
 * prove an ABI/event family; they never prove official Uniswap lineage.
 */
export async function resolveLandedTouchedVenues(
  rpc: Pick<RpcClient, "call">,
  receipt: Json,
  graph: GraphMembership | null,
  blockNumber: number,
): Promise<TouchedVenue[]> {
  const venues = extractTouchedVenues(receipt, graph);
  await Promise.all(venues.map(async (item) => {
    if (item.protocol === "univ4") return;
    try {
      const raw = await rpc.call<string>("eth_call", [
        { to: item.emitter, data: FACTORY_IFACE.encodeFunctionData("factory") },
        toQuantity(blockNumber),
      ]);
      const factory = lower(String(FACTORY_IFACE.decodeFunctionResult("factory", raw)[0]));
      const capability = await runtimeVenueByFactory(factory);
      item.factory = factory;
      item.venue_id = capability?.venue ?? "unknown";
      item.identity_source = "factory-call";
      item.landed_adapter = capability?.runtimeAdapter
        ? `${capability.runtimeAdapter}-swap`
        : null;
    } catch {
      item.venue_id = "unknown";
      item.identity_source = "event-shape-only";
      item.landed_adapter = null;
    }
  }));
  return venues;
}

async function runtimeVenueByFactory(factory: string): Promise<{
  venue: string;
  runtimeAdapter?: "univ2" | "univ3";
} | null> {
  try {
    // Dynamic on purpose: Hermes lifecycle tests replay old repository commits
    // that predate the production venue registry. Current checkouts reuse the
    // production fact source; old checkouts degrade honestly to unknown.
    const registry = await import("../../../listener/src/searcher/venues/capability.js");
    return registry.findVenueByFactory(factory);
  } catch {
    return null;
  }
}

function venue(
  protocol: TouchedVenue["protocol"],
  id: string,
  emitter: string,
  graph: GraphMembership | null,
): TouchedVenue {
  const inGraph = graph?.status === "loaded" ? graph.members.has(lower(id)) : null;
  if (protocol !== "univ4") {
    // Current runtime-*-pools files are admitted pool views, not proof that
    // buildTokenGraph emitted a successful TokenEdge. OUT is decisive; IN is
    // discovery evidence only until the routed-edge index lands.
    return {
      protocol,
      id,
      emitter,
      in_graph: inGraph,
      routing_admitted: inGraph === false ? false : null,
      routing_reason: inGraph === false ? "not_in_graph" : "routed_edge_unverified",
      venue_id: "unknown",
      identity_source: "event-shape-only",
      landed_adapter: null,
    };
  }
  const hooks = graph?.v4Hooks.get(lower(id));
  const hooked = hooks !== undefined ? (BigInt(hooks || "0x0") & V4_SWAP_HOOK_MASK) !== 0n : null;
  return {
    protocol,
    id,
    emitter,
    in_graph: inGraph,
    hooked,
    routing_admitted: inGraph === false ? false : hooked === true ? false : null,
    routing_reason: inGraph === false
      ? "not_in_graph"
      : hooked === true
        ? "hooked_v4"
        : "routed_edge_unverified",
    venue_id: "univ4",
    identity_source: "v4-pool-manager",
    landed_adapter: hooked === false ? "univ4-unlock" : null,
  };
}

export function loadGraphMembership(path: string): GraphMembership {
  if (!existsSync(path)) return { status: "unavailable", path, entries: 0, members: new Set(), v4Hooks: new Map() };
  try {
    const text = readFileSyncText(path);
    const members = new Set<string>();
    const v4Hooks = new Map<string, string>();
    collectGraphMembers(JSON.parse(text), members);
    // v4 pools are stored in runtime-graph-pools.json by PoolManager ADDRESS only (no poolId),
    // so a poolId membership check against the runtime graph is a systematic FALSE-NEGATIVE for
    // ALL v4 pools (it would report every v4 pool — including ones we already index — as not in
    // graph). The v4 poolIds live in the sibling active-pools.json (the loaded universe); union
    // them in so v4 in_graph is correct. Mirrors live-loss readActiveV4PoolIds.
    addActivePoolsV4PoolIds(path, members, v4Hooks);
    return { status: "loaded", path, entries: members.size, members, v4Hooks };
  } catch {
    return { status: "unavailable", path, entries: 0, members: new Set(), v4Hooks: new Map() };
  }
}

// Union the v4 poolIds from the sibling active-pools.json into graph membership. Only bytes32
// poolIds are added (v4-only field); v2/v3 in_graph stays authoritative against runtime-graph.
// Also capture poolId → hooks so callers can tell DISCOVERY membership apart from ROUTING
// admission (token-graph skips swap-hooked v4 pools).
function addActivePoolsV4PoolIds(graphPath: string, members: Set<string>, v4Hooks?: Map<string, string>): void {
  const activePoolsPath = resolve(dirname(graphPath), "active-pools.json");
  if (!existsSync(activePoolsPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(activePoolsPath, "utf8")) as unknown;
    const pools = Array.isArray(parsed)
      ? parsed
      : ((parsed as { pools?: unknown[] })?.pools ?? []);
    for (const pool of pools) {
      const poolId = lower(String((pool as { poolId?: unknown })?.poolId ?? ""));
      if (!isBytes32(poolId)) continue;
      members.add(poolId);
      const hooks = lower(String((pool as { hooks?: unknown })?.hooks ?? ""));
      if (v4Hooks && /^0x[a-f0-9]{40}$/.test(hooks)) v4Hooks.set(poolId, hooks);
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

// Non-comparable winner detection (decision-log F-010/F-011): classes and explicit signals that
// must not feed atomic-loop coverage/bid analysis:
//  - keeper_claim (F-011): protocol fee-sweep / claim bounty. Layer 1 = known claim selectors in the
//    calldata (Curve FeeCollector withdraw_many/collect + legacy withdraw_admin_fees — verified on
//    0xcfacdd69/0xaffe7e05). Layer 2 (general flow SHAPE, receipt-only): a conserved intermediary
//    (token in == out) whose outflow splits into a dominant non-executor sink plus a small executor
//    cut (<10% of the largest sink edge) — "value conserved into a fixed sink + caller cut".
//  - rfq_fill (F-010): the cheap side is a signed off-chain order — ABI-encoded 65-byte ECDSA
//    signature(s) plus a seconds-scale deadline near the block timestamp in the calldata (verified on
//    0x15352456: 3 sigs + deadline = block_ts+29s).
//  - external mint: a non-actor, non-venue recipient retains a material token balance created by an
//    in-tx mint. This remains diagnostic; any unrecognized co-mint makes closure unknown but never
//    manufactures competitor inventory ownership.
export interface NonArbSignals {
  claim_selector_hit: boolean;
  conserved_sink_cut: boolean;
  rfq_sig_count: number;
  rfq_deadline_in_calldata: boolean;
  external_mint_recipients: string[];
  external_mint_tokens: string[];
  external_mint_unknown_tokens: string[];
  external_mint_protocol_context: "liquity" | "susds" | null;
}

interface FlowLedgerToken {
  net: Map<string, bigint>;
  edges: Array<{ from: string; to: string; amount: bigint }>;
}

export function buildFlowLedger(receipt: Json | null): Map<string, FlowLedgerToken> {
  const ledger = new Map<string, FlowLedgerToken>();
  for (const log of receipt?.logs ?? []) {
    const transfer = decodeTransfer(log);
    if (!transfer || transfer.amount === 0n) continue;
    const token = lower(transfer.token);
    let entry = ledger.get(token);
    if (!entry) {
      entry = { net: new Map(), edges: [] };
      ledger.set(token, entry);
    }
    const from = lower(transfer.from);
    const to = lower(transfer.to);
    entry.net.set(from, (entry.net.get(from) ?? 0n) - transfer.amount);
    entry.net.set(to, (entry.net.get(to) ?? 0n) + transfer.amount);
    entry.edges.push({ from, to, amount: transfer.amount });
  }
  return ledger;
}

// Conserved-sink-cut shape: some intermediary I with net == 0 pays the executor a small cut while a
// non-executor sink takes the dominant share of I's outflow. Edge-based (not net-based) so it still
// fires when the executor immediately converts its cut (its NET goes to ~0, the EDGE remains).
export function hasConservedSinkCutShape(
  ledger: Map<string, FlowLedgerToken>,
  executors: Set<string>,
): boolean {
  for (const { net, edges } of ledger.values()) {
    for (const [intermediary, netAmount] of net) {
      if (netAmount !== 0n || executors.has(intermediary)) continue;
      let executorOut = 0n;
      let maxNonExecutorOut = 0n;
      let sawOutflow = false;
      for (const edge of edges) {
        if (edge.from !== intermediary) continue;
        sawOutflow = true;
        if (executors.has(edge.to)) executorOut += edge.amount;
        else if (edge.amount > maxNonExecutorOut) maxNonExecutorOut = edge.amount;
      }
      if (sawOutflow && executorOut > 0n && executorOut * 9n < maxNonExecutorOut) return true;
    }
  }
  return false;
}

// ABI-encoded 65-byte ECDSA signature: a 32-byte length word of 0x41 followed by r‖s‖v with
// v ∈ {0x1b, 0x1c}. Matches both top-level ABI args and order structs nested in router batches.
function countAbiEncodedSignatures(inputHex: string): number {
  return [...inputHex.matchAll(/0{62}41[0-9a-f]{128}(?:1b|1c)/g)].length;
}

// A zero-padded uint32 word within a seconds-scale window around the block timestamp — an order
// deadline. 56 leading zeros + 8 hex = a full 32-byte word holding a unix timestamp. Lookahead form:
// a greedy /0{56}…/ consumes long zero runs and can mis-align past the real word (a run of 57+
// zeros captured "0xxxxxxx" and then skipped the true window — 0x15352456 verification miss).
function hasDeadlineWord(inputHex: string, blockTimestamp: number): boolean {
  for (const match of inputHex.matchAll(/(?=0{56}([0-9a-f]{8}))/g)) {
    const value = Number.parseInt(match[1], 16);
    if (value >= blockTimestamp - RFQ_DEADLINE_MAX_BEHIND_S
      && value <= blockTimestamp + RFQ_DEADLINE_MAX_AHEAD_S) return true;
  }
  return false;
}

export function detectNonArbSignals(
  txInput: string | null | undefined,
  receipt: Json | null,
  executors: Set<string>,
  blockTimestamp: number | null,
): NonArbSignals {
  const inputHex = lower(String(txInput ?? "")).replace(/^0x/, "");
  const externalMint = retainedExternalMintEvidence(receipt, executors);
  return {
    claim_selector_hit: KEEPER_CLAIM_SELECTORS.some((selector) => inputHex.includes(selector)),
    conserved_sink_cut: hasConservedSinkCutShape(buildFlowLedger(receipt), executors),
    rfq_sig_count: countAbiEncodedSignatures(inputHex),
    rfq_deadline_in_calldata: blockTimestamp != null && hasDeadlineWord(inputHex, blockTimestamp),
    external_mint_recipients: externalMint.recipients,
    external_mint_tokens: externalMint.tokens,
    external_mint_unknown_tokens: externalMint.unknownTokens,
    external_mint_protocol_context: externalMint.recipients.length > 0
      ? recognizedExternalMintProtocolContext(receipt, externalMint)
      : null,
  };
}

// Overlay the non-arb classes on a base style. keeper_claim needs the decisive selector OR the flow
// shape. An external co-mint is diagnostic, not proof of competitor inventory. A material co-mint
// without recognized protocol semantics makes closure ambiguous, so fail to unknown;
// rfq_fill only reinterprets an otherwise atomic/unknown win.
export function overlayNonArbStyle(base: WinnerStyle, signals: NonArbSignals): WinnerStyle {
  if (signals.claim_selector_hit || signals.conserved_sink_cut) return "keeper_claim";
  if (signals.external_mint_tokens.length > 0
    && signals.external_mint_protocol_context === null
    && (base === "atomic_loop" || base === "unknown")) return "unknown";
  if (signals.rfq_sig_count >= 1 && signals.rfq_deadline_in_calldata
    && (base === "atomic_loop" || base === "unknown")) return "rfq_fill";
  return base;
}

export function classifyWinnerStyle(input: WinnerStyleClassifierInput): WinnerStyle {
  // Atomicity check FIRST: a vault-share inventory rebalance (F-009) otherwise reads as atomic_loop
  // because the executor's intra-tx net is clean. Only explicit receipt/account ownership evidence
  // is sufficient; generic ERC4626 selectors are shared by ordinary deposits and redemptions.
  const shareImbalance = (input.share_imbalance_tokens?.length ?? 0) > 0;
  if (shareImbalance) return "inventory_vault_rebalance";
  // Opening or retaining a material actor-owned vault-share position is not a closed atomic loop.
  // It also does not prove use of pre-held inventory, so preserve the honest unknown distinction.
  if ((input.retained_share_position_tokens?.length ?? 0) > 0) return "unknown";
  const closedAtomicFlow = hasAtomicLoopFlow(
    input.pricedDeltas,
    input.unpricedDeltas,
    input.nativeWeiPositive ?? false,
  );
  // A backrun can push one venue beyond block N-1 while still closing through other venues. Tick
  // movement is inventory evidence only when the transaction-level flow is not already closed.
  if (input.winner_moved_price_beyond_prestate && !closedAtomicFlow) return "one_leg_inventory";
  if (input.sandwich_detected) return "sandwich";
  if (hasOneLegInventoryFlow(
    input.pricedDeltas,
    input.unpricedDeltas,
    input.unpricedInTokensWithoutCounterTransfer,
    input.nativeWeiNegative ?? false,
  )) {
    return "one_leg_inventory";
  }
  if (closedAtomicFlow) return "atomic_loop";
  return "unknown";
}

export async function classifyWinnerTxStyle(input: WinnerStyleTxInput): Promise<WinnerStyleAnalysis> {
  const beneficiaries = competitorBeneficiaries(
    input.tx,
    input.receipt,
    input.competitorProfile,
  );
  const entityPositionAccounts = competitorPositionAccounts(
    beneficiaries,
    input.competitorProfile,
    input.positionAccounts,
  );
  const receiptWethUnwrapExit = hasBeneficiaryWethUnwrapExit(input.receipt, beneficiaries);
  // A successful WETH Withdrawal to the executor is the receipt-level native
  // profit exit used by Coffee's atomic loops. Use it only when prestate trace
  // is unavailable; an available trace remains authoritative for native net.
  const positionEthDeltaEth = input.profit.positionEthDeltaEth ?? input.profit.ethDeltaEth;
  const nativeWeiPositive = input.profit.nativeTraceUsed
    ? positionEthDeltaEth > 0
    : receiptWethUnwrapExit;
  const nativeWeiNegative = input.profit.nativeTraceUsed && positionEthDeltaEth < 0;
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
  // Atomicity / inventory-rebalance detector (F-009): receipt-grounded actor drawdown plus the
  // aggregate net of explicitly configured entity position accounts.
  const shareImbalanceTokens = [...new Set([
    ...shareTokenImbalanceTokens(input.receipt, beneficiaries),
    ...positionAccountImbalanceTokens(input.receipt, entityPositionAccounts),
  ])].sort();
  const retainedSharePositionTokens = retainedSharePositionTokensForOwners(
    input.receipt,
    beneficiaries,
  );
  const nonArbSignals = detectNonArbSignals(
    input.tx?.input,
    input.receipt,
    beneficiaries,
    input.blockTimestamp ?? null,
  );
  return {
    non_arb_signals: nonArbSignals,
    winner_style: overlayNonArbStyle(classifyWinnerStyle({
      pricedDeltas: input.profit.pricedDeltas,
      unpricedDeltas: input.profit.unpricedDeltas,
      unpricedInTokensWithoutCounterTransfer,
      winner_moved_price_beyond_prestate: winnerMovedPriceBeyondPrestate,
      sandwich_detected: sandwichDetected,
      nativeWeiPositive,
      nativeWeiNegative,
      share_imbalance_tokens: shareImbalanceTokens,
      retained_share_position_tokens: retainedSharePositionTokens,
    }), nonArbSignals),
    receipt_weth_unwrap_exit: receiptWethUnwrapExit,
    winner_moved_price_beyond_prestate: winnerMovedPriceBeyondPrestate,
    unpriced_token_in_flow: unpricedTokenInFlow,
    retained_share_position_tokens: retainedSharePositionTokens,
  };
}

export function hasBeneficiaryWethUnwrapExit(
  receipt: Json | null,
  beneficiaries: Set<string>,
): boolean {
  for (const log of receipt?.logs ?? []) {
    if (lower(String(log?.address ?? "")) !== lower(ADDR.WETH)) continue;
    if (lower(String(log?.topics?.[0] ?? "")) !== lower(TOPICS.wethWithdrawal)) continue;
    const party = `0x${String(log?.topics?.[1] ?? "").slice(-40)}`.toLowerCase();
    if (!beneficiaries.has(party)) continue;
    try {
      if (hexToBigInt(log?.data ?? "0x0") > 0n) return true;
    } catch {
      // Malformed receipt evidence is ignored; it must never manufacture an
      // atomic classification.
    }
  }
  return false;
}

// A vault-share supply change is actor inventory evidence only when an explicit actor materially
// draws down shares. A positive share mint can be ordinary profit/new position creation and cannot
// prove use of pre-held inventory. Configured entity accounts are handled sign-symmetrically by
// positionAccountImbalanceTokens below.
export function shareTokenImbalanceTokens(receipt: Json | null, positionOwners: Set<string>): string[] {
  return actorVaultSharePositionTokens(receipt, positionOwners, (net) => net < 0n);
}

export function retainedSharePositionTokensForOwners(
  receipt: Json | null,
  positionOwners: Set<string>,
): string[] {
  return actorVaultSharePositionTokens(receipt, positionOwners, (net) => net > 0n);
}

function actorVaultSharePositionTokens(
  receipt: Json | null,
  positionOwners: Set<string>,
  matchesDirection: (net: bigint) => boolean,
): string[] {
  const evidencedVaultTokens = erc4626VaultTokens(receipt);
  const explicitOwners = new Set([...positionOwners].map(lower).filter(isAddress));
  const supplyChangedTokens = new Set<string>();
  const perHolder = new Map<string, Map<string, bigint>>();
  const venueEmitters = swapVenueEmitters(receipt);
  for (const log of receipt?.logs ?? []) {
    if (lower(String(log?.topics?.[0] ?? "")) !== TOPIC_TRANSFER) continue;
    const transfer = decodeTransfer(log);
    if (!transfer) continue;
    const from = lower(transfer.from);
    const to = lower(transfer.to);
    const token = lower(String(log?.address ?? ""));
    if (!isAddress(token) || !evidencedVaultTokens.has(token)) continue;
    if (from === ZERO_ADDRESS && to === ZERO_ADDRESS) continue;
    if (from === ZERO_ADDRESS || to === ZERO_ADDRESS) supplyChangedTokens.add(token);
    let holders = perHolder.get(token);
    if (!holders) {
      holders = new Map();
      perHolder.set(token, holders);
    }
    if (from !== ZERO_ADDRESS) holders.set(from, (holders.get(from) ?? 0n) - transfer.amount);
    if (to !== ZERO_ADDRESS) holders.set(to, (holders.get(to) ?? 0n) + transfer.amount);
  }
  const out: string[] = [];
  for (const token of supplyChangedTokens) {
    const holders = perHolder.get(token) ?? new Map<string, bigint>();
    for (const [holder, holderNet] of holders) {
      if (matchesDirection(holderNet)
        && explicitOwners.has(holder)
        && !venueEmitters.has(holder)
        && isMaterialTokenAmount(token, holderNet)) {
        out.push(token);
        break;
      }
    }
  }
  return out.sort();
}

// Declared entity position accounts are stronger ownership evidence than receipt roles. Aggregate
// their net per token so internal A->B movement conserves the entity position, while any material
// external drawdown/deposit remains inventory evidence even without an ERC4626 event.
export function positionAccountImbalanceTokens(
  receipt: Json | null,
  positionAccounts: Set<string>,
): string[] {
  const accounts = new Set([...positionAccounts].map(lower).filter(isAddress));
  const out = new Set<string>();
  for (const [token, { net }] of buildFlowLedger(receipt)) {
    let entityNet = 0n;
    for (const account of accounts) entityNet += net.get(account) ?? 0n;
    if (isMaterialTokenAmount(token, entityNet)) out.add(token);
  }
  return [...out].sort();
}

// A generic protocol mint to the executor can be part of an atomic protocol/DEX loop. Retained
// balances at unrelated non-venue addresses are recorded as co-mint evidence; they are not ownership
// evidence. ERC4626 share mints follow the same diagnostic path, while inventory still requires an
// explicitly owned account above.
export function retainedExternalMintRecipients(receipt: Json | null, actors: Set<string>): string[] {
  return retainedExternalMintEvidence(receipt, actors).recipients;
}

interface RetainedExternalMintEvidence {
  recipients: string[];
  tokens: string[];
  unknownTokens: string[];
  recipientsByToken: Map<string, string[]>;
  retainedProvenanceByToken: Map<string, Map<string, bigint>>;
  transactionNetByToken: Map<string, Map<string, bigint>>;
}

function retainedExternalMintEvidence(
  receipt: Json | null,
  actors: Set<string>,
): RetainedExternalMintEvidence {
  const normalizedActors = new Set([...actors].map(lower).filter(isAddress));
  const venueEmitters = swapVenueEmitters(receipt);
  const provenance = mintProvenance(receipt);
  const ledger = buildFlowLedger(receipt);
  const mintedTokens = [...provenance.mintedAmounts]
    .filter(([token, amount]) => isMaterialTokenAmount(token, amount))
    .map(([token]) => token);

  const recipients = new Set<string>();
  const tokens = new Set<string>();
  const unknownTokens = new Set<string>();
  const recipientSetsByToken = new Map<string, Set<string>>();
  const retainedProvenanceByToken = new Map<string, Map<string, bigint>>();
  const transactionNetByToken = new Map<string, Map<string, bigint>>();
  for (const token of mintedTokens) {
    const eligibleRecipients: Array<[string, bigint, bigint]> = [];
    for (const [holder, amount] of provenance.balancesByToken.get(token) ?? []) {
      if (amount <= 0n) continue;
      if (holder === ZERO_ADDRESS || holder === token || normalizedActors.has(holder)) continue;
      if (venueEmitters.has(holder)) continue;
      // Mint provenance can settle a debt without creating a retained position. A flash lender
      // that sends X before the mint and receives the minted X later is net-zero, not an external
      // mint recipient. Require positive transaction-level net as well as surviving provenance.
      const positiveNet = ledger.get(token)?.net.get(holder) ?? 0n;
      if (positiveNet <= 0n) continue;
      eligibleRecipients.push([holder, amount, positiveNet]);
    }
    const retainedAmount = (entry: [string, bigint, bigint]): bigint =>
      entry[1] < entry[2] ? entry[1] : entry[2];
    const materialRecipients = eligibleRecipients.filter((entry) =>
      isMaterialTokenAmount(token, retainedAmount(entry)));
    const subthresholdRecipients = eligibleRecipients.filter((entry) =>
      !isMaterialTokenAmount(token, retainedAmount(entry)));
    const subthresholdTotal = subthresholdRecipients.reduce((sum, entry) => sum + retainedAmount(entry), 0n);
    const evidencedRecipients = isMaterialTokenAmount(token, subthresholdTotal)
      ? [...materialRecipients, ...subthresholdRecipients]
      : materialRecipients;
    for (const [holder, provenanceAmount, positiveNet] of evidencedRecipients) {
      recipients.add(holder);
      tokens.add(token);
      if (!TOKEN_META[token]) unknownTokens.add(token);
      let tokenRecipients = recipientSetsByToken.get(token);
      if (!tokenRecipients) {
        tokenRecipients = new Set();
        recipientSetsByToken.set(token, tokenRecipients);
      }
      tokenRecipients.add(holder);
      let retainedProvenance = retainedProvenanceByToken.get(token);
      if (!retainedProvenance) {
        retainedProvenance = new Map();
        retainedProvenanceByToken.set(token, retainedProvenance);
      }
      retainedProvenance.set(holder, provenanceAmount);
      let transactionNet = transactionNetByToken.get(token);
      if (!transactionNet) {
        transactionNet = new Map();
        transactionNetByToken.set(token, transactionNet);
      }
      transactionNet.set(holder, positiveNet);
    }
  }
  return {
    recipients: [...recipients].sort(),
    tokens: [...tokens].sort(),
    unknownTokens: [...unknownTokens].sort(),
    recipientsByToken: new Map(
      [...recipientSetsByToken].map(([token, tokenRecipients]) =>
        [token, [...tokenRecipients].sort()]),
    ),
    retainedProvenanceByToken,
    transactionNetByToken,
  };
}

interface MintProvenance {
  mintedAmounts: Map<string, bigint>;
  balancesByToken: Map<string, Map<string, bigint>>;
}

// Receipt-local provenance is ordered. A later mint cannot retroactively explain an unrelated
// earlier deposit, and only the minted portion of a mixed holder balance propagates downstream.
function mintProvenance(receipt: Json | null): MintProvenance {
  const mintedAmounts = new Map<string, bigint>();
  const balancesByToken = new Map<string, Map<string, bigint>>();
  for (const log of receipt?.logs ?? []) {
    const transfer = decodeTransfer(log);
    if (!transfer || transfer.amount <= 0n) continue;
    const token = lower(transfer.token);
    const from = lower(transfer.from);
    const to = lower(transfer.to);
    let balances = balancesByToken.get(token);
    if (!balances) {
      balances = new Map();
      balancesByToken.set(token, balances);
    }
    if (from === ZERO_ADDRESS) {
      mintedAmounts.set(token, (mintedAmounts.get(token) ?? 0n) + transfer.amount);
      if (to !== ZERO_ADDRESS) balances.set(to, (balances.get(to) ?? 0n) + transfer.amount);
      continue;
    }
    const available = balances.get(from) ?? 0n;
    const moved = available < transfer.amount ? available : transfer.amount;
    if (moved === 0n) continue;
    const remaining = available - moved;
    if (remaining === 0n) balances.delete(from);
    else balances.set(from, remaining);
    if (to !== ZERO_ADDRESS) balances.set(to, (balances.get(to) ?? 0n) + moved);
  }
  return { mintedAmounts, balancesByToken };
}

function recognizedExternalMintProtocolContext(
  receipt: Json | null,
  evidence: RetainedExternalMintEvidence,
): "liquity" | "susds" | null {
  if (evidence.tokens.length === 1
    && evidence.tokens[0] === LIQUITY_BOLD
    && hasGroundedLiquityBoldMint(receipt, evidence)) {
    return "liquity";
  }
  if (evidence.tokens.length > 0
    && evidence.tokens.every((token) => SUSDS_MINT_CONTEXT_TOKENS.has(token))
    && hasGroundedSusdsMintContext(receipt, evidence)) {
    return "susds";
  }
  return null;
}

function hasGroundedLiquityBoldMint(
  receipt: Json | null,
  evidence: RetainedExternalMintEvidence,
): boolean {
  const boldMints = zeroMintAmountsByRecipient(receipt, LIQUITY_BOLD);
  const retainedRecipients = evidence.recipientsByToken.get(LIQUITY_BOLD) ?? [];
  const retainedProvenance = evidence.retainedProvenanceByToken.get(LIQUITY_BOLD) ?? new Map();
  const transactionNet = evidence.transactionNetByToken.get(LIQUITY_BOLD) ?? new Map();
  if (retainedRecipients.length !== 2
      || !retainedRecipients.includes(LIQUITY_INTEREST_ROUTER)
      || !retainedRecipients.includes(LIQUITY_STABILITY_POOL)) return false;

  const logs = receipt?.logs ?? [];
  const pendingOperationSubjects = new Set<string>();
  for (let index = 0; index + 3 < logs.length; index++) {
    const log = logs[index];
    if (lower(String(log?.address ?? "")) === LIQUITY_PROTOCOL_EMITTER
      && lower(String(log?.topics?.[0] ?? "")) === lower(TOPICS.liquityBatchUpdated)) {
      const subject = addressFromTopic(log?.topics?.[1]);
      const operation = dataWord(log?.data, 0);
      if (subject && operation === LIQUITY_APPLY_BATCH_INTEREST_AND_FEE) {
        pendingOperationSubjects.add(subject);
      }
      continue;
    }

    const batchMint = decodeTransfer(logs[index]);
    const routerMint = decodeTransfer(logs[index + 1]);
    const stabilityMint = decodeTransfer(logs[index + 2]);
    const rewardsUpdate = logs[index + 3];
    const batchRecipient = batchMint ? lower(batchMint.to) : "";
    if (!isBoldMintTo(batchMint, pendingOperationSubjects)) continue;
    // One canonical BatchUpdated may ground only the next matching batch mint. Consuming it here
    // prevents stale context from blessing a later, unrelated mint quartet.
    pendingOperationSubjects.delete(batchRecipient);
    if (!isBoldMintTo(routerMint, new Set([LIQUITY_INTEREST_ROUTER]))
      || !isBoldMintTo(stabilityMint, new Set([LIQUITY_STABILITY_POOL]))) continue;
    if (lower(String(rewardsUpdate?.address ?? "")) !== LIQUITY_STABILITY_POOL
      || lower(String(rewardsUpdate?.topics?.[0] ?? "")) !== LIQUITY_STABILITY_POOL_B_UPDATED) continue;

    const routerAmount = routerMint!.amount;
    const stabilityAmount = stabilityMint!.amount;
    const totalInterest = routerAmount + stabilityAmount;
    if (!isMaterialTokenAmount(LIQUITY_BOLD, batchMint!.amount)
      || !isMaterialTokenAmount(LIQUITY_BOLD, totalInterest)
      || stabilityAmount !== totalInterest * 75n / 100n) continue;
    if (boldMints.get(LIQUITY_INTEREST_ROUTER) !== routerAmount
      || boldMints.get(LIQUITY_STABILITY_POOL) !== stabilityAmount) continue;
    if (retainedProvenance.get(LIQUITY_INTEREST_ROUTER) !== routerAmount
      || retainedProvenance.get(LIQUITY_STABILITY_POOL) !== stabilityAmount
      || transactionNet.get(LIQUITY_INTEREST_ROUTER) !== routerAmount
      || transactionNet.get(LIQUITY_STABILITY_POOL) !== stabilityAmount) continue;
    return true;
  }
  return false;
}

function isBoldMintTo(
  transfer: ReturnType<typeof decodeTransfer>,
  recipients: ReadonlySet<string>,
): boolean {
  return transfer !== null
    && lower(transfer.token) === LIQUITY_BOLD
    && lower(transfer.from) === ZERO_ADDRESS
    && recipients.has(lower(transfer.to))
    && transfer.amount > 0n;
}

function hasGroundedSusdsMintContext(
  receipt: Json | null,
  evidence: RetainedExternalMintEvidence,
): boolean {
  const susds = lower(ADDR.SUSDS);
  const usds = lower(ADDR.USDS);
  if (!erc4626VaultTokens(receipt).has(susds)) return false;

  if (evidence.tokens.includes(usds)) {
    const retainedUsdsRecipients = evidence.recipientsByToken.get(usds) ?? [];
    const usdsMints = zeroMintAmountsByRecipient(receipt, usds);
    if (retainedUsdsRecipients.length === 0
      || retainedUsdsRecipients.some((recipient) => recipient !== susds)
      || (!isMaterialTokenAmount(usds, usdsMints.get(susds) ?? 0n)
        && !hasGroundedSusdsDepositAssetFlow(receipt, usdsMints))) return false;
  }

  if (evidence.tokens.includes(susds)) {
    const shareMints = zeroMintAmountsByRecipient(receipt, susds);
    const depositShares = susdsDepositSharesByOwner(receipt);
    let sawMaterialShareMint = false;
    for (const [recipient, amount] of shareMints) {
      if (!isMaterialTokenAmount(susds, amount)) continue;
      sawMaterialShareMint = true;
      if ((depositShares.get(recipient) ?? 0n) !== amount) return false;
    }
    if (!sawMaterialShareMint) return false;
  }
  return true;
}

function hasGroundedSusdsDepositAssetFlow(
  receipt: Json | null,
  zeroMintsByRecipient: Map<string, bigint>,
): boolean {
  const depositedBySender = new Map<string, bigint>();
  for (const log of receipt?.logs ?? []) {
    if (lower(String(log?.address ?? "")) !== lower(ADDR.SUSDS)
      || lower(String(log?.topics?.[0] ?? "")) !== lower(TOPICS.erc4626Deposit)) continue;
    const sender = addressFromTopic(log?.topics?.[1]);
    const assets = dataWord(log?.data, 0);
    if (!sender || assets === null) continue;
    depositedBySender.set(sender, (depositedBySender.get(sender) ?? 0n) + assets);
  }

  const transferredBySender = new Map<string, bigint>();
  for (const { from, to, amount } of buildFlowLedger(receipt).get(lower(ADDR.USDS))?.edges ?? []) {
    if (to !== lower(ADDR.SUSDS)) continue;
    transferredBySender.set(from, (transferredBySender.get(from) ?? 0n) + amount);
  }
  return [...depositedBySender].some(([sender, assets]) =>
    isMaterialTokenAmount(ADDR.USDS, assets)
      && transferredBySender.get(sender) === assets
      && (zeroMintsByRecipient.get(sender) ?? 0n) >= assets);
}

function zeroMintAmountsByRecipient(receipt: Json | null, token: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const log of receipt?.logs ?? []) {
    const transfer = decodeTransfer(log);
    if (!transfer
      || lower(transfer.token) !== lower(token)
      || lower(transfer.from) !== ZERO_ADDRESS) continue;
    const recipient = lower(transfer.to);
    out.set(recipient, (out.get(recipient) ?? 0n) + transfer.amount);
  }
  return out;
}

function susdsDepositSharesByOwner(receipt: Json | null): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const log of receipt?.logs ?? []) {
    if (lower(String(log?.address ?? "")) !== lower(ADDR.SUSDS)
      || lower(String(log?.topics?.[0] ?? "")) !== lower(TOPICS.erc4626Deposit)) continue;
    const owner = addressFromTopic(log?.topics?.[2]);
    const shares = dataWord(log?.data, 1);
    if (!owner || shares === null) continue;
    out.set(owner, (out.get(owner) ?? 0n) + shares);
  }
  return out;
}

function addressFromTopic(topic: unknown): string | null {
  const hex = lower(String(topic ?? "")).replace(/^0x/, "");
  if (!/^[a-f0-9]{64}$/.test(hex)) return null;
  const address = `0x${hex.slice(-40)}`;
  return isAddress(address) ? address : null;
}

function dataWord(data: unknown, index: number): bigint | null {
  const hex = lower(String(data ?? "")).replace(/^0x/, "");
  const word = hex.slice(index * 64, (index + 1) * 64);
  if (!/^[a-f0-9]{64}$/.test(word)) return null;
  return BigInt(`0x${word}`);
}

function erc4626VaultTokens(receipt: Json | null): Set<string> {
  const out = new Set<string>();
  for (const log of receipt?.logs ?? []) {
    const topic0 = lower(String(log?.topics?.[0] ?? ""));
    const emitter = lower(String(log?.address ?? ""));
    if (isAddress(emitter)
      && (topic0 === lower(TOPICS.erc4626Deposit) || topic0 === lower(TOPICS.erc4626Withdraw))) {
      out.add(emitter);
    }
  }
  return out;
}

function swapVenueEmitters(receipt: Json | null): Set<string> {
  const out = new Set<string>();
  for (const log of receipt?.logs ?? []) {
    const topic0 = lower(String(log?.topics?.[0] ?? ""));
    const emitter = lower(String(log?.address ?? ""));
    if (!isAddress(emitter)) continue;
    if (topic0 === TOPIC_UNIV4_SWAP || topic0 === TOPIC_UNIV3_SWAP
      || (TOPIC_UNIV2_SWAP && topic0 === TOPIC_UNIV2_SWAP)
      || OTHER_SWAP_TOPIC_PROTOCOLS.some((entry) => entry.topic === topic0)) {
      out.add(emitter);
    }
  }
  return out;
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
  // an atomic loop leaves no such token. The caller passes a direct-builder-payment-adjusted native
  // position delta, so paying the builder cannot masquerade as native inventory funding.
  const spentPricedOrNative =
    pricedDeltas.some((delta) => delta.raw < 0n
      && isMaterialTokenAmount(delta.token, delta.raw)
      && INVENTORY_PRICED_TOKENS.has(lower(delta.token)))
    || nativeWeiNegative;
  const retainedPricedPosition = pricedDeltas.some(
    (delta) => delta.raw > 0n && isMaterialTokenAmount(delta.token, delta.raw),
  );
  return spentPricedOrNative
    && (retainedPricedPosition || unpricedInTokensWithoutCounterTransfer.length > 0);
}

function hasAtomicLoopFlow(
  pricedDeltas: TokenDelta[],
  unpricedDeltas: TokenDelta[],
  nativeWeiPositive: boolean,
): boolean {
  return (pricedDeltas.some(
    (delta) => delta.raw > 0n && isMaterialTokenAmount(delta.token, delta.raw),
  ) || nativeWeiPositive)
    && pricedDeltas.every((delta) => delta.raw >= 0n || !isMaterialTokenAmount(delta.token, delta.raw))
    && unpricedDeltas.every((delta) => !isMaterialTokenAmount(delta.token, delta.raw));
}

function isMaterialTokenAmount(token: string, raw: bigint): boolean {
  const magnitude = raw < 0n ? -raw : raw;
  if (magnitude === 0n) return false;
  const meta = TOKEN_META[lower(token)];
  if (!meta) return magnitude > UNKNOWN_TOKEN_DUST_RAW;
  const unit = 10n ** BigInt(meta.decimals);
  if (meta.roughUsd !== undefined) {
    const roughUsdMicros = BigInt(Math.round(meta.roughUsd * Number(USD_MICRO_SCALE)));
    return magnitude * roughUsdMicros > unit * POSITION_DUST_USD_MICROS;
  }
  const fractionalDigits = Math.min(meta.decimals, REGISTERED_TOKEN_DUST_DECIMALS);
  return magnitude > 10n ** BigInt(meta.decimals - fractionalDigits);
}

function unpricedTokenInFlowTokens(unpricedDeltas: TokenDelta[]): string[] {
  return uniq(
    unpricedDeltas
      .filter((delta) => delta.raw > 0n)
      .map((delta) => lower(delta.token)),
  );
}

function competitorBeneficiaries(
  tx: Json | null,
  receipt: Json | null,
  suppliedProfile?: LiveCompetitorProfile,
): Set<string> {
  const profile = suppliedProfile ?? loadLiveCompetitorProfile();
  const observed = new Set(
    [tx?.from, receipt?.from, tx?.to, receipt?.to]
      .map((address) => lower(String(address ?? "")))
      .filter(isAddress),
  );
  const matches = profile.entities.filter((entity) =>
    [entity.eoa, ...entity.executors].some((address) => observed.has(address)));
  const owned = matches.length === 1
    ? [matches[0].eoa, ...matches[0].executors]
    : [tx?.from, receipt?.from];
  return new Set(
    owned
      .map((address) => lower(String(address ?? "")))
      .filter(isAddress),
  );
}

function competitorPositionAccounts(
  beneficiaries: Set<string>,
  profile: LiveCompetitorProfile | undefined,
  supplied: Iterable<string> | undefined,
): Set<string> {
  if (supplied !== undefined) {
    return new Set([...supplied].map(lower).filter(isAddress));
  }
  // Profileless library consumers use the same validated default profile as the CLI. Load it for
  // each call so a caller-provided/watch profile and the default can never diverge through a cache.
  const accounts = positionAccountsForActors(
    profile ?? loadLiveCompetitorProfile(),
    beneficiaries,
  );
  return new Set(accounts.map(lower).filter(isAddress));
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
  if (blockNumber <= 0) return false;
  const supportedTopics = new Set([TOPIC_UNIV2_SWAP, TOPIC_UNIV3_SWAP].filter(Boolean));
  const currentSwaps = ((receipt?.logs ?? []) as Json[])
    .filter((log: Json) => supportedTopics.has(lower(String(log?.topics?.[0] ?? ""))))
    .map((log: Json) => decodeAnySwapLog(log))
    .filter((swap): swap is NonNullable<ReturnType<typeof decodeAnySwapLog>> => swap !== null);
  if (currentSwaps.length === 0) return false;

  const txCache = new Map<string, Promise<Json | null>>();
  const transaction = (hash: string): Promise<Json | null> => {
    const normalized = lower(hash);
    const cached = txCache.get(normalized);
    if (cached) return cached;
    const pending = rpc.getTransaction(normalized).catch(() => null);
    txCache.set(normalized, pending);
    return pending;
  };
  const isSameActor = (tx: Json | null): boolean => {
    const from = lower(String(tx?.from ?? ""));
    const to = lower(String(tx?.to ?? ""));
    return beneficiaries.has(from) || beneficiaries.has(to);
  };

  const checkedPools = new Set<string>();
  try {
    for (const currentSwap of currentSwaps) {
      if (checkedPools.has(currentSwap.poolId)) continue;
      checkedPools.add(currentSwap.poolId);
      const logs = await rpc.getLogs({
        address: currentSwap.poolId,
        fromBlock: toQuantity(blockNumber),
        toBlock: toQuantity(blockNumber),
        topics: [[...supportedTopics]],
      });
      const poolSwaps = logs
        .map((log) => ({ log, swap: decodeAnySwapLog(log) }))
        .filter((entry): entry is { log: Json; swap: NonNullable<ReturnType<typeof decodeAnySwapLog>> } =>
          entry.swap !== null && entry.swap.poolId === currentSwap.poolId
        );

      for (const other of poolSwaps) {
        const otherHash = lower(other.swap.txHash);
        if (!otherHash || otherHash === candidate.hash) continue;
        if (other.swap.direction === currentSwap.direction) continue;
        if (!isSameActor(await transaction(otherHash))) continue;

        const frontIndex = Math.min(other.swap.index, candidate.transactionIndex);
        const backIndex = Math.max(other.swap.index, candidate.transactionIndex);
        if (backIndex - frontIndex < 2) continue;
        const frontDirection = other.swap.index < candidate.transactionIndex
          ? other.swap.direction
          : currentSwap.direction;

        for (const victim of poolSwaps) {
          if (victim.swap.index <= frontIndex || victim.swap.index >= backIndex) continue;
          if (victim.swap.direction !== frontDirection) continue;
          const victimHash = lower(victim.swap.txHash);
          if (!victimHash || victimHash === candidate.hash || victimHash === otherHash) continue;
          const victimTx = await transaction(victimHash);
          // A missing historical transaction is unknown, not proof of an external victim.
          // Sandwich classification is non-comparable, so fail closed unless actor identity
          // is available and positively differs from the candidate beneficiaries.
          if (victimTx && !isSameActor(victimTx)) return true;
        }
      }
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
  const comparableAtomic = winner.winner_style === "atomic_loop";
  return {
    status: "priced",
    winner: winner.hash,
    winnerPaymentWei: winner.builderPaymentWei,
    outbid: bid === null ? null : winnerPayment > bid,
    route_gap_decisive: simulatedProfit === null ? null : comparableAtomic ? winnerPayment > simulatedProfit : false,
    winner_style: winner.winner_style,
    non_comparable_winner: nonComparable ? true : undefined,
    note: nonComparable ? nonComparableWinnerNote(winner.winner_style, winner.non_arb_signals) : undefined,
    one_shot: oneShotSummary(event),
    builder_reach: builderReach,
  };
}

export function isNonComparableWinnerStyle(style: WinnerStyle): boolean {
  return style === "one_leg_inventory"
    || style === "sandwich"
    || style === "inventory_vault_rebalance"
    || style === "keeper_claim"
    || style === "rfq_fill";
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

function nonComparableWinnerNote(style: WinnerStyle, signals?: NonArbSignals): string {
  const externalMintRecipients = signals?.external_mint_recipients ?? [];
  const label = style === "one_leg_inventory"
    ? "one_leg_inventory/CEX-DEX"
    : style === "inventory_vault_rebalance"
      ? "inventory_vault_rebalance (residual vault-share position; needs pre-held inventory)"
      : style === "keeper_claim"
        ? "keeper_claim/protocol reward harvest"
        : style === "rfq_fill"
          ? "rfq_fill/off-chain signed liquidity"
          : "sandwich";
  const coMintDiagnostic = externalMintRecipients.length > 0
    ? `; external co-mint diagnostic recipients=${externalMintRecipients.join(",")}`
    : "";
  return `winner is ${label}${coMintDiagnostic}; off-chain/out-of-posture - our atomic sim gross is the correct ceiling; no coverage/sizing/bid fix`;
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

export function decodeExtraData(extraData: unknown): string {
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
    const externalMintRecipients = winner.non_arb_signals?.external_mint_recipients ?? [];
    lines.push(
      `winner: ${winner.hash} index=${winner.transactionIndex} backrun_positioned=${String(winner.backrun_positioned)}`,
      `winner_style: ${winner.winner_style} winner_moved_price_beyond_prestate=${String(winner.winner_moved_price_beyond_prestate)} unpriced_token_in_flow=${winner.unpriced_token_in_flow.length === 0 ? "none" : winner.unpriced_token_in_flow.join(",")} external_mint_recipients=${externalMintRecipients.length === 0 ? "none" : externalMintRecipients.join(",")}`,
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
