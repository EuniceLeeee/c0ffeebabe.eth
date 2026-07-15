import fs from "node:fs";
import { ethers } from "ethers";
import { classifyWinnerTxStyle } from "./cli/bundle-postmortem.js";
import type { AbExperiment } from "./ab-canary.js";
import { decodeTransfer } from "./decode/erc20.js";
import { fetchEthUsd, priceArb } from "./pnl/arb-profit.js";
import { classifyTxShape, type RawLog } from "./pnl/tx-shape.js";
import { decodeAnySwapLog, type DecodedSwap } from "./pnl/swap-log-registry.js";
import { deriveEdgeKindsFromLogs } from "./learning/edge-kinds.js";
import { hexToBigInt, RpcClient } from "./rpc/client.js";
import { lower } from "./registry/protocols.js";

export interface ProductionSampleObservation {
  tx_hash: string;
  block_number: number;
  transaction_index: number;
  source_shape: "atomic_state_arb" | "backrun" | "unknown";
  winner_style: string;
  net_profit_usd: number | null;
  arb_pools: string[];
  arb_swap_path: Array<{ pool_id: string; direction: DecodedSwap["direction"] }>;
  protocol_calls: Array<{ target: string; selector: string }>;
  edge_kinds: string[];
  victim_tx_hash?: string;
  victim_transaction_index?: number;
  victim_previous_tx_hash?: string;
  victim_edge_kinds?: string[];
}

export interface ProductionSwapPathStep {
  pool_id: string;
  direction: DecodedSwap["direction"];
}

export interface ProductionRouteStep {
  adapterId: string;
  slotKind: "swap" | "protocol";
  target: string;
  tokenIn: string;
  tokenOut: string;
  poolId?: string;
}

export function validateExactProductionSwapPath(
  expected: ProductionSwapPathStep[],
  matched: ProductionSwapPathStep[] | undefined,
): string[] {
  if (!matched || JSON.stringify(matched) !== JSON.stringify(expected)) {
    return ["hunt did not match the exact ordered pool/direction path from the on-chain sample"];
  }
  return [];
}

export function selectProductionSwapWindow(
  expectedRoute: ProductionRouteStep[],
  observed: DecodedSwap[],
): { matched: DecodedSwap[]; errors: string[] } {
  const expectedPools = expectedRoute
    .filter((edge) => edge.slotKind === "swap")
    .map((edge) => lower(String(edge.poolId ?? edge.target)));
  if (expectedPools.length === 0) {
    return { matched: [], errors: ["production sample expected_route contains no swap edge"] };
  }
  const windows: DecodedSwap[][] = [];
  for (let start = 0; start + expectedPools.length <= observed.length; start++) {
    const candidate = observed.slice(start, start + expectedPools.length);
    if (candidate.every((swap, offset) => lower(swap.poolId) === expectedPools[offset])) {
      windows.push(candidate);
    }
  }
  if (windows.length === 0) {
    return {
      matched: [],
      errors: ["production sample expected_route swap sequence is not a contiguous on-chain swap window"],
    };
  }
  if (windows.length > 1) {
    return {
      matched: [],
      errors: ["production sample expected_route swap sequence is ambiguous in the on-chain swap logs"],
    };
  }
  return { matched: windows[0], errors: [] };
}

/** Recompute the sample classification from the local archive node at deploy time. This prevents a
 * report from relabelling a backrun (or a fake tx hash) as a standing-state atomic sample. */
export async function verifyOnchainProductionSample(
  experiment: AbExperiment,
  rpcUrl: string,
  universePath: string,
): Promise<{ errors: string[]; observation?: ProductionSampleObservation }> {
  const errors: string[] = [];
  const sample = experiment.production_evidence?.sample;
  if (!sample) return { errors: ["production sample missing"] };

  const rpc = new RpcClient(rpcUrl);
  const [tx, receipt] = await Promise.all([
    rpc.getTransaction(sample.tx_hash),
    rpc.getReceipt(sample.tx_hash),
  ]);
  if (!tx || !receipt) return { errors: ["production sample is not present on the configured archive node"] };
  const blockNumber = Number(hexToBigInt(receipt.blockNumber));
  if (Number(hexToBigInt(receipt.status)) !== 1) errors.push("production sample receipt status is not successful");
  if (blockNumber !== sample.block_number) errors.push("production sample block_number disagrees with the receipt");

  const block = await rpc.getBlockByNumber(blockNumber, true);
  const receipts = await rpc.call<Record<string, any>[]>("eth_getBlockReceipts", [receipt.blockNumber]);
  const transactions = Array.isArray(block?.transactions) ? block.transactions : [];
  const transactionByHash = new Map<string, Record<string, any>>(
    transactions
      .filter((entry: unknown): entry is Record<string, any> => typeof entry === "object" && entry !== null)
      .map((entry: Record<string, any>) => [lower(String(entry.hash ?? "")), entry]),
  );
  const sameActorTxHashes = transactions
    .filter((entry: unknown): entry is Record<string, any> => typeof entry === "object" && entry !== null)
    .filter((entry: Record<string, any>) => lower(String(entry.from ?? "")) === lower(String(tx.from ?? "")))
    .map((entry: Record<string, any>) => lower(String(entry.hash ?? "")));
  const allLogs = receipts.flatMap((entry) => rawLogs(entry, transactionByHash));
  const receiptLogs = rawLogs(receipt, transactionByHash);
  const decodedSwaps = receiptLogs
    .map((log) => decodeAnySwapLog(log))
    .filter((swap): swap is DecodedSwap => swap !== null)
    .sort((a, b) => a.logIndex - b.logIndex);
  const expectedRoute = sample.expected_route ?? [];
  const selectedSwapWindow = selectProductionSwapWindow(expectedRoute, decodedSwaps);
  errors.push(...selectedSwapWindow.errors);
  const routeSwaps = selectedSwapWindow.matched;
  const arbSwapPath = routeSwaps
    .map((swap) => ({ pool_id: swap.poolId, direction: swap.direction }));
  const universe = loadProductionUniverse(universePath);
  await validateOnchainSwapRoute(
    expectedRoute.filter((edge) => edge.slotKind === "swap"),
    routeSwaps,
    universe,
    rpc,
    receipt.blockNumber,
    errors,
  );
  const trace = await rpc.traceTransaction(sample.tx_hash);
  const protocolCalls = validateOnchainExecutionRoute(
    expectedRoute,
    trace,
    receipt.logs,
    tx,
    errors,
  );
  const transactionIndex = Number(hexToBigInt(receipt.transactionIndex));
  const routeSwapLogIndexes = new Set(routeSwaps.map((swap) => swap.logIndex));
  const shape = classifyTxShape({
    receiptLogs: receiptLogs.filter((log) => routeSwapLogIndexes.has(log.logIndex)),
    txIndex: transactionIndex,
    sameBlockSwapLogs: allLogs,
    sameActorTxHashes,
  });
  if (shape.arb_pools.length === 0) errors.push("production sample has no DEX swap pool recognized by the canonical classifier");
  const strategyKind = experiment.production_evidence?.strategy_kind;
  if (strategyKind === "block-scan" && shape.shape !== "atomic_state_arb") {
    errors.push(`production sample source shape is ${shape.shape}; block-scan scope requires victim-independent atomic_state_arb`);
  }
  let victimTxHash: string | undefined;
  let victimTransactionIndex: number | undefined;
  let victimPreviousTxHash: string | undefined;
  let victimEdgeKinds: string[] | undefined;
  if (strategyKind === "backrun") {
    victimTxHash = lower(String(sample.victim_tx_hash ?? ""));
    const [victimTx, victimReceipt] = await Promise.all([
      rpc.getTransaction(victimTxHash),
      rpc.getReceipt(victimTxHash),
    ]);
    if (!victimTx || !victimReceipt) {
      errors.push("declared backrun victim is unavailable on the configured archive node");
    } else {
      const victimBlock = Number(hexToBigInt(victimReceipt.blockNumber));
      victimTransactionIndex = Number(hexToBigInt(victimReceipt.transactionIndex));
      if (victimTransactionIndex > 0) {
        const previous = transactions[victimTransactionIndex - 1];
        victimPreviousTxHash = previous && typeof previous === "object"
          ? lower(String((previous as Record<string, unknown>).hash ?? ""))
          : undefined;
        if (!/^0x[a-f0-9]{64}$/i.test(victimPreviousTxHash ?? "")) {
          errors.push("declared backrun victim previous transaction is unavailable");
        }
      }
      victimEdgeKinds = deriveEdgeKindsFromLogs(victimReceipt.logs);
      if (Number(hexToBigInt(victimReceipt.status)) !== 1) errors.push("declared backrun victim reverted");
      if (victimBlock !== blockNumber) errors.push("declared backrun victim is not in the winner block");
      if (victimTransactionIndex >= transactionIndex) errors.push("declared backrun victim does not precede the winner");
      if (experiment.production_evidence?.trigger_kind === "victim-swap"
          && !victimEdgeKinds.includes("swap")) {
        errors.push("victim-swap trigger has no canonical swap edge");
      }
      if (experiment.production_evidence?.trigger_kind === "oracle-update"
          && (typeof victimTx.to !== "string" || String(victimTx.input ?? victimTx.data ?? "0x") === "0x")) {
        errors.push("oracle-update trigger is not a contract call with calldata");
      }
    }
  }
  const edgeKinds = deriveEdgeKindsFromLogs(receipt.logs);
  if (!edgeKinds.includes("swap")) errors.push("production sample does not contain a recognized DEX swap edge");
  if (edgeKinds.includes("credit") || edgeKinds.includes("lp")) {
    errors.push(`production sample edge kinds [${edgeKinds.join(",")}] are outside the current no-credit/no-LP scope`);
  }
  if (experiment.production_evidence?.route_scope === "dex-dex" && edgeKinds.includes("protocol")) {
    errors.push("production sample declares dex-dex but canonical logs contain a protocol edge");
  }
  if (experiment.production_evidence?.route_scope === "dex-permissionless-protocol"
      && !edgeKinds.includes("protocol")) {
    errors.push("production sample declares dex-permissionless-protocol but canonical logs contain no protocol edge");
  }

  const ethUsd = await fetchEthUsd(rpc);
  const baseFeePerGas = block?.baseFeePerGas != null ? hexToBigInt(block.baseFeePerGas) : 0n;
  const profit = await priceArb(rpc, sample.tx_hash, tx, receipt, ethUsd, {
    entityActors: [tx?.to, tx?.from].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    allowTrace: true,
    coinbase: lower(String(block?.miner ?? "")),
    baseFeePerGas,
  });
  const style = await classifyWinnerTxStyle({
    rpc,
    txHash: sample.tx_hash,
    tx,
    receipt,
    profit,
    transactionIndex,
    blockNumber,
    prestateBlock: Math.max(0, blockNumber - 1),
    blockTimestamp: block?.timestamp != null ? Number(hexToBigInt(block.timestamp)) : null,
  });
  if (style.winner_style !== "atomic_loop") {
    errors.push(`production sample winner_style is ${style.winner_style}; current B scope requires atomic_loop`);
  }
  if (profit.netProfitUsd === null || profit.netProfitUsd <= 0) {
    errors.push("canonical tx-profit recomputation does not show positive net profit");
  }
  if (profit.profitConfidence === "unsafe" || profit.profitConfidence === "requires_decode") {
    errors.push(`canonical tx-profit confidence ${profit.profitConfidence} is insufficient for B admission`);
  }

  return {
    errors,
    observation: {
      tx_hash: lower(sample.tx_hash),
      block_number: blockNumber,
      transaction_index: transactionIndex,
      source_shape: shape.shape,
      winner_style: style.winner_style,
      net_profit_usd: profit.netProfitUsd,
      arb_pools: shape.arb_pools,
      arb_swap_path: arbSwapPath,
      protocol_calls: protocolCalls,
      edge_kinds: edgeKinds,
      victim_tx_hash: victimTxHash,
      victim_transaction_index: victimTransactionIndex,
      victim_previous_tx_hash: victimPreviousTxHash,
      victim_edge_kinds: victimEdgeKinds,
    },
  };
}

export interface UniversePoolFact {
  address: string;
  adapter: string;
  venueId?: string;
  factory?: string;
  identitySource?: string;
  poolId?: string;
  token0?: string;
  token1?: string;
  currency0?: string;
  currency1?: string;
  underlyingCoins?: string[];
  fixedTokenIn?: string;
  fixedTokenOut?: string;
}

interface OrderedCall {
  target: string;
  selector: string;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const PAIR_IFACE = new ethers.Interface([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const CURVE_UINT_IFACE = new ethers.Interface(["function coins(uint256) view returns (address)"]);
const CURVE_INT_IFACE = new ethers.Interface(["function coins(int128) view returns (address)"]);
const CURVE_UNDERLYING_INT_IFACE = new ethers.Interface([
  "function underlying_coins(int128) view returns (address)",
]);
const CURVE_METAREGISTRY = "0xf98b45fa17de75fb1ad0e7afd971b0ca00e379fc";
const CURVE_METAREGISTRY_IFACE = new ethers.Interface([
  "function get_underlying_coins(address pool) view returns (address[8])",
]);
const ROUTE_SELECTORS = new Map<string, Set<string>>([
  ["univ2-swap", selectors("swap(uint256,uint256,address,bytes)")],
  ["univ2-router-swap-exact-in", selectors("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)")],
  ["univ2-router-swap-exact-in-alt", selectors("swapExactTokensForTokens(address,address,uint256,uint256,address)")],
  ["univ3-swap", selectors("swap(address,bool,int256,uint160,bytes)")],
  ["univ4-unlock", selectors("unlock(bytes)")],
  ["curve-exchange", new Set(["0xafb43012"])],
  ["curve-exchange-received-uint", new Set(["0x767691e7"])],
  ["curve-exchange-nr", new Set(["0x7e3db030"])],
  ["curve-exchange-plain", new Set(["0x3df02124"])],
  ["curve-exchange-underlying", new Set(["0xa6417ed6"])],
  ["curve-router-execute-path", selectors("executePath(bytes,uint256[],address)")],
  ["fluid-dex-swap", selectors("swapIn(bool,uint256,uint256,address)")],
  ["wsteth-wrap", selectors("wrap(uint256)")],
  ["wsteth-unwrap", selectors("unwrap(uint256)")],
  ["erc4626-deposit", selectors("deposit(uint256,address)")],
  ["erc4626-redeem", selectors("redeem(uint256,address,address)")],
  ["erc4626-redeem-silo", selectors("redeem(address,uint256,address,address)")],
  ["metronome-synth-swap", selectors("swap(address,address,uint256)")],
  ["metronome-hgusdc-exit", selectors("executePath(bytes,uint256[],address)")],
  ["psm", selectors("sellGem(address,uint256)", "buyGem(address,uint256)")],
]);

function loadProductionUniverse(universePath: string): UniversePoolFact[] {
  const parsed = JSON.parse(fs.readFileSync(universePath, "utf8")) as unknown;
  const pools = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { pools?: unknown }).pools)
      ? (parsed as { pools: unknown[] }).pools
      : null;
  if (!pools) throw new Error("production universe must be an array or { pools: [...] }");
  return pools.filter((entry): entry is UniversePoolFact => Boolean(
    entry && typeof entry === "object"
      && typeof (entry as UniversePoolFact).address === "string"
      && typeof (entry as UniversePoolFact).adapter === "string",
  ));
}

export async function validateOnchainSwapRoute(
  expected: ProductionRouteStep[],
  observed: DecodedSwap[],
  universe: UniversePoolFact[],
  rpc: RpcClient,
  blockTag: string,
  errors: string[],
): Promise<void> {
  if (expected.length !== observed.length) return;
  for (let index = 0; index < expected.length; index++) {
    const edge = expected[index];
    const swap = observed[index];
    const pool = universe.find((candidate) => candidate.adapter === "univ4"
      ? lower(String(candidate.poolId ?? "")) === lower(swap.poolId)
      : lower(candidate.address) === lower(swap.poolId));
    if (!pool) {
      errors.push(`production swap route[${index}] is absent from the attested universe`);
      continue;
    }
    const expectedTarget = pool.adapter === "univ4" ? lower(pool.address) : lower(swap.poolId);
    if (lower(edge.target) !== expectedTarget) {
      errors.push(`production swap route[${index}] target does not match the attested venue identity`);
    }
    if (!adapterMatchesUniverse(edge.adapterId, pool.adapter)) {
      errors.push(`production swap route[${index}] adapter ${edge.adapterId} does not match universe ${pool.adapter}`);
    }
    if ((pool.adapter === "univ2" || pool.adapter === "univ3")
        && (!pool.factory || !pool.venueId || !pool.identitySource)) {
      errors.push(`production swap route[${index}] lacks factory-backed venue identity attestation`);
    }
    const tokens = await resolveObservedSwapTokens(pool, swap, rpc, blockTag);
    if (!tokens || canonicalToken(edge.tokenIn) !== canonicalToken(tokens.tokenIn)
        || canonicalToken(edge.tokenOut) !== canonicalToken(tokens.tokenOut)) {
      errors.push(`production swap route[${index}] token direction is not grounded by the landed swap`);
    }
  }
}

function adapterMatchesUniverse(adapterId: string, universeAdapter: string): boolean {
  if (universeAdapter === "univ2") return adapterId === "univ2-swap";
  if (universeAdapter === "univ3") return adapterId === "univ3-swap";
  if (universeAdapter === "univ4") return adapterId === "univ4-unlock";
  if (universeAdapter === "curve-underlying") return adapterId === "curve-exchange-underlying";
  if (universeAdapter === "curve" || universeAdapter === "curve-nr") return adapterId.startsWith("curve-");
  if (universeAdapter === "fluid-dex") return adapterId === "fluid-dex-swap";
  return false;
}

async function resolveObservedSwapTokens(
  pool: UniversePoolFact,
  swap: DecodedSwap,
  rpc: RpcClient,
  blockTag: string,
): Promise<{ tokenIn: string; tokenOut: string } | null> {
  if (swap.tokenIn && swap.tokenOut) return { tokenIn: swap.tokenIn, tokenOut: swap.tokenOut };
  let token0 = pool.adapter === "univ4" ? pool.currency0 : pool.token0;
  let token1 = pool.adapter === "univ4" ? pool.currency1 : pool.token1;
  if ((!token0 || !token1) && (pool.adapter === "univ2" || pool.adapter === "univ3")) {
    try {
      [token0, token1] = await Promise.all([
        ethCallAddress(rpc, pool.address, PAIR_IFACE, "token0", [], blockTag),
        ethCallAddress(rpc, pool.address, PAIR_IFACE, "token1", [], blockTag),
      ]);
    } catch {
      return null;
    }
  }
  if ((pool.adapter === "curve" || pool.adapter === "curve-nr")
      && swap.tokenInIndex !== undefined && swap.tokenOutIndex !== undefined) {
    try {
      const [tokenIn, tokenOut] = await Promise.all([
        curveCoin(rpc, pool.address, swap.tokenInIndex, blockTag),
        curveCoin(rpc, pool.address, swap.tokenOutIndex, blockTag),
      ]);
      return { tokenIn, tokenOut };
    } catch {
      return null;
    }
  }
  if (pool.adapter === "curve-underlying"
      && swap.tokenInIndex !== undefined && swap.tokenOutIndex !== undefined) {
    try {
      const [tokenIn, tokenOut] = await Promise.all([
        curveUnderlyingCoin(rpc, pool.address, swap.tokenInIndex, blockTag),
        curveUnderlyingCoin(rpc, pool.address, swap.tokenOutIndex, blockTag),
      ]);
      const recordedIn = pool.underlyingCoins?.[swap.tokenInIndex];
      const recordedOut = pool.underlyingCoins?.[swap.tokenOutIndex];
      if ((recordedIn && lower(recordedIn) !== tokenIn)
          || (recordedOut && lower(recordedOut) !== tokenOut)) {
        return null;
      }
      return { tokenIn, tokenOut };
    } catch {
      return null;
    }
  }
  if (!token0 || !token1) return null;
  return swap.direction === "0for1"
    ? { tokenIn: token0, tokenOut: token1 }
    : { tokenIn: token1, tokenOut: token0 };
}

async function ethCallAddress(
  rpc: RpcClient,
  target: string,
  iface: ethers.Interface,
  method: string,
  values: unknown[],
  blockTag: string,
): Promise<string> {
  const data = iface.encodeFunctionData(method, values);
  const raw = await rpc.call<string>("eth_call", [{ to: target, data }, blockTag]);
  return lower(String(iface.decodeFunctionResult(method, raw)[0]));
}

async function curveCoin(rpc: RpcClient, target: string, index: number, blockTag: string): Promise<string> {
  try {
    return await ethCallAddress(rpc, target, CURVE_UINT_IFACE, "coins", [index], blockTag);
  } catch {
    return ethCallAddress(rpc, target, CURVE_INT_IFACE, "coins", [index], blockTag);
  }
}

async function curveUnderlyingCoin(
  rpc: RpcClient,
  target: string,
  index: number,
  blockTag: string,
): Promise<string> {
  try {
    return await ethCallAddress(
      rpc,
      target,
      CURVE_UNDERLYING_INT_IFACE,
      "underlying_coins",
      [index],
      blockTag,
    );
  } catch {
    const data = CURVE_METAREGISTRY_IFACE.encodeFunctionData("get_underlying_coins", [target]);
    const raw = await rpc.call<string>("eth_call", [{ to: CURVE_METAREGISTRY, data }, blockTag]);
    const coins = Array.from(
      CURVE_METAREGISTRY_IFACE.decodeFunctionResult("get_underlying_coins", raw)[0] as readonly string[],
    ).map((coin) => lower(String(coin)));
    const coin = coins[index];
    if (!coin || coin === ZERO_ADDRESS) throw new Error("curve underlying coin index is unavailable");
    return coin;
  }
}

function canonicalToken(token: string): string {
  const value = lower(token);
  return value === ZERO_ADDRESS || value === "0x0" ? WETH : value;
}

export function validateOnchainExecutionRoute(
  expected: ProductionRouteStep[],
  trace: Record<string, any>,
  logs: Record<string, any>[],
  tx: Record<string, any>,
  errors: string[],
): OrderedCall[] {
  const calls = flattenSuccessfulStateChangingCalls(trace);
  const matched: OrderedCall[] = [];
  let cursor = 0;
  const executorActors = new Set([lower(String(tx.from ?? "")), lower(String(tx.to ?? ""))]);
  const transferTokens = new Set(logs.map((log) => decodeTransfer(log)).filter(Boolean)
    .map((transfer) => lower(transfer!.token)));
  for (const [index, edge] of expected.entries()) {
    if (edge.slotKind === "protocol" && executorActors.has(lower(edge.target))) {
      errors.push(`production protocol route[${index}] targets the winner's private actor, not a permissionless venue`);
    }
    const allowedSelectors = ROUTE_SELECTORS.get(edge.adapterId);
    if (!allowedSelectors) {
      errors.push(`production route[${index}] adapter ${edge.adapterId} has no trusted selector contract`);
      continue;
    }
    const callIndex = calls.findIndex((call, candidateIndex) =>
      candidateIndex >= cursor
      && call.target === lower(edge.target)
      && allowedSelectors.has(call.selector));
    if (callIndex < 0) {
      errors.push(`production route[${index}] adapter selector is absent or out of order in the successful call trace`);
      continue;
    }
    const call = calls[callIndex];
    if (edge.slotKind === "protocol") matched.push(call);
    cursor = callIndex + 1;
    if (edge.slotKind === "protocol" && !edge.adapterId.startsWith("weth-")
        && (!transferTokens.has(lower(edge.tokenIn)) || !transferTokens.has(lower(edge.tokenOut)))) {
      errors.push(`production protocol route[${index}] token flow is absent from the landed receipt`);
    }
  }
  return matched;
}

function selectors(...signatures: string[]): Set<string> {
  return new Set(signatures.map((signature) => ethers.id(signature).slice(0, 10).toLowerCase()));
}

function flattenSuccessfulStateChangingCalls(node: Record<string, any> | null | undefined): OrderedCall[] {
  if (!node || typeof node !== "object" || node.error) return [];
  const result: OrderedCall[] = [];
  const type = String(node.type ?? "CALL").toUpperCase();
  const input = String(node.input ?? "0x");
  if (typeof node.to === "string" && type !== "STATICCALL" && input.length >= 10) {
    result.push({ target: lower(node.to), selector: input.slice(0, 10).toLowerCase() });
  }
  for (const child of Array.isArray(node.calls) ? node.calls : []) {
    result.push(...flattenSuccessfulStateChangingCalls(child));
  }
  return result;
}

function rawLogs(
  receipt: Record<string, any>,
  transactionByHash: Map<string, Record<string, any>>,
): RawLog[] {
  return (Array.isArray(receipt?.logs) ? receipt.logs : []).map((log: Record<string, any>) => {
    const transactionHash = lower(String(log.transactionHash ?? receipt.transactionHash ?? ""));
    return {
      address: lower(String(log.address ?? "")),
      topics: Array.isArray(log.topics) ? log.topics.map((topic: unknown) => lower(String(topic))) : [],
      data: String(log.data ?? "0x"),
      logIndex: Number(hexToBigInt(log.logIndex)),
      transactionIndex: Number(hexToBigInt(log.transactionIndex ?? receipt.transactionIndex)),
      transactionHash,
      txTo: transactionByHash.get(transactionHash)?.to ?? null,
    };
  });
}
