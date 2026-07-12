import { ethers } from "ethers";
import { actionsFromLogs } from "../actions/from-logs.js";
import { RpcClient, hexToBigInt } from "../rpc/client.js";
import { ADDR, TOPICS, lower, tokenMeta } from "../registry/protocols.js";
import { isPublicRouter } from "../registry/routers.js";
import type { TokenDelta } from "../types.js";

const V4_MANAGER = lower(ADDR.UNIV4_POOL_MANAGER);
const V4_SWAP_IFACE = new ethers.Interface([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);
const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"; // latestAnswer() → 8 decimals

export interface V4Swap {
  poolId: string;
  sender: string;
  amount0: string;
  amount1: string;
  fee: number;
  currency0?: string;
  currency1?: string;
}

export interface PricedLeg {
  bot: string;
  block: number;
  realized: number | null;
  unsafe: boolean;
  hasV4: boolean;
}

export interface ArbProfit {
  /** ERC20 (incl. WETH) + native-ETH net value the bot gained, USD. null if nothing priceable.
   *  Already net of any in-tx coinbase-transfer bribe (that ETH left the beneficiary), but PRE-gas. */
  realizedProfitUsd: number | null;
  /** realized − total gas (the correct kept-profit). NOT realized − builderPayment (that double-counts
   *  a coinbase-transfer bribe already excluded from realized). null when realized is null. */
  netProfitUsd: number | null;
  /** gasUsed × effectiveGasPrice, USD (base fee + priority tip). */
  gasCostUsd: number | null;
  builderPaymentEth: number | null;
  builderPaymentUsd: number | null;
  erc20Usd: number | null;
  pricedDeltas: TokenDelta[];
  unpricedDeltas: TokenDelta[];
  profitConfidence: "high" | "medium" | "requires_decode" | "unsafe";
  ethDeltaEth: number;
  ethProfitUsd: number;
  nativeTraceUsed: boolean;
  beneficiary: string;
  v4Swaps: V4Swap[];
  v4PoolIds: string[];
}

export interface PriceArbOptions {
  entityActors: string[];
  allowTrace: boolean;
  coinbase?: string;
  /** Block baseFeePerGas (wei) — enables the priority-fee-tip component of builder_payment. */
  baseFeePerGas?: bigint;
}

export function valueDeltas(
  deltas: TokenDelta[],
  ethUsd: number,
): { usd: number | null; priced: TokenDelta[]; unpriced: TokenDelta[] } {
  let usd = 0;
  const priced: TokenDelta[] = [];
  const unpriced: TokenDelta[] = [];
  for (const d of deltas) {
    const meta = tokenMeta(d.token);
    const amount = Number(d.raw) / 10 ** d.decimals;
    if (meta.roughUsd !== undefined) {
      usd += amount * meta.roughUsd;
      priced.push(d);
    } else if (meta.symbol === "WETH") {
      usd += amount * ethUsd;
      priced.push(d);
    } else {
      unpriced.push(d);
    }
  }
  return { usd: priced.length === 0 ? null : usd, priced, unpriced };
}

/**
 * Net profit per (bot, block) over legs where realized != null AND !unsafe,
 * INCLUDING negative legs, because arb bots can split one arbitrage across
 * multiple txs in a block; summing only positive legs overcounts (~6x on the
 * 20260701 window). The group key is `${bot}:${block}`. total = sum of block
 * nets; viaV4 = sum of block nets for groups where any leg hasV4.
 */
export function aggregateNetProfit(legs: PricedLeg[]): {
  total: number;
  viaV4: number;
  byBotBlock: Map<string, { net: number; hasV4: boolean }>;
} {
  const byBotBlock = new Map<string, { net: number; hasV4: boolean }>();
  for (const leg of legs) {
    const key = `${leg.bot}:${leg.block}`;
    const group = byBotBlock.get(key) ?? { net: 0, hasV4: false };
    if (!leg.unsafe && leg.realized !== null) group.net += leg.realized;
    if (leg.hasV4) group.hasV4 = true;
    byBotBlock.set(key, group);
  }

  let total = 0;
  let viaV4 = 0;
  for (const group of byBotBlock.values()) {
    total += group.net;
    if (group.hasV4) viaV4 += group.net;
  }
  return { total, viaV4, byBotBlock };
}

/** Chainlink ETH/USD (8 decimals). Falls back on any failure. */
export async function fetchEthUsd(rpc: RpcClient, fallback = 3500): Promise<number> {
  try {
    const res = await rpc.call<string>("eth_call", [
      { to: CHAINLINK_ETH_USD, data: "0x50d25bcd" },
      "latest",
    ]);
    const raw = hexToBigInt(res);
    if (raw > 0n) return Number(raw) / 1e8;
  } catch {
    // fall through
  }
  return fallback;
}

export function decodeV4Swaps(receipt: any): V4Swap[] {
  const out: V4Swap[] = [];
  const swapTopic = lower(TOPICS.univ4Swap);
  for (const log of receipt?.logs ?? []) {
    if (lower(log.address) !== V4_MANAGER || lower(log.topics?.[0]) !== swapTopic) continue;
    try {
      const parsed = V4_SWAP_IFACE.parseLog({ topics: log.topics, data: log.data ?? "0x" });
      if (!parsed) continue;
      out.push({
        poolId: lower(String(parsed.args[0])),
        sender: lower(String(parsed.args[1])),
        amount0: String(parsed.args[2]),
        amount1: String(parsed.args[3]),
        fee: Number(parsed.args[7]),
      });
    } catch {
      // Ignore malformed logs after the address/topic guard.
    }
  }
  return out;
}

function prestateBalanceWei(m: Record<string, any>, a: string): bigint | null {
  return a in m && m[a]?.balance !== undefined ? hexToBigInt(m[a].balance) : null;
}

export function builderPaymentWeiFromPrestate(
  pre: Record<string, any>,
  post: Record<string, any>,
  coinbase: string,
): bigint {
  const a = lower(coinbase);
  const b0 = prestateBalanceWei(pre, a);
  const b1 = prestateBalanceWei(post, a);
  if (b0 === null && b1 === null) return 0n;
  return (b1 ?? b0 ?? 0n) - (b0 ?? b1 ?? 0n);
}

/**
 * Realized profit of an arb tx = net value the caller-supplied bot entity actors
 * gained, in USD. Covers ERC20 (incl. WETH) via Transfer logs AND
 * native ETH via prestate balance diff — so Uniswap v4 native-ETH settlement, which
 * emits no Transfer log, is finally counted (turn-4's confounded −$55 was this hole
 * plus WETH being valued at 0 because ethUsd was never passed to roughValueUsd).
 */
export async function priceArb(
  rpc: RpcClient,
  txHash: string,
  tx: any,
  receipt: any,
  ethUsd: number,
  options: PriceArbOptions,
): Promise<ArbProfit> {
  const beneficiary = lower(tx?.to ?? receipt?.to ?? "");
  const from = lower(receipt?.from ?? tx?.from ?? "");
  const actors = [...new Set(options.entityActors.map(lower).filter(Boolean))];

  // ERC20 net for the bot (WETH now valued at ethUsd, not 0).
  const { rawDeltas } = actionsFromLogs(receipt, actors);
  const valuedDeltas = valueDeltas(rawDeltas, ethUsd);
  const erc20Usd = valuedDeltas.usd;
  const profitConfidence =
    erc20Usd === null
      ? "requires_decode"
      : isPublicRouter(beneficiary)
        ? "unsafe"
        : valuedDeltas.unpriced.length === 0
          ? "high"
          : "medium";

  // Native ETH: add gas back only when tx.from is part of the supplied entity.
  let ethWei = 0n;
  let tracedEth = false;
  // Direct-to-coinbase transfers within the tx (this reth's prestateTracer diffMode does NOT
  // credit the coinbase with the priority-fee tip, so the coinbase balance delta = explicit
  // coinbase transfers only). Total builder payment = priority-fee tip (below) + this.
  let coinbaseTransferWei: bigint | null = null;
  if (options.allowTrace) {
    try {
      const tr = await rpc.tracePrestate(txHash);
      const pre = tr?.pre ?? {};
      const post = tr?.post ?? {};
      const delta = (a: string): bigint => {
        const b0 = prestateBalanceWei(pre, a);
        const b1 = prestateBalanceWei(post, a);
        if (b0 === null && b1 === null) return 0n;
        return (b1 ?? b0 ?? 0n) - (b0 ?? b1 ?? 0n);
      };
      if (options.coinbase) coinbaseTransferWei = builderPaymentWeiFromPrestate(pre, post, options.coinbase);
      const gas = hexToBigInt(receipt?.gasUsed) * hexToBigInt(receipt?.effectiveGasPrice);
      for (const actor of actors) {
        ethWei += delta(actor);
        if (from && actor === from) ethWei += gas;
      }
      tracedEth = true;
    } catch {
      // trace unavailable → ETH profit unknown, leave 0
    }
  }
  const ethDeltaEth = Number(ethWei) / 1e18;
  const ethProfitUsd = ethDeltaEth * ethUsd;
  // Priority-fee tip to the builder = gasUsed * (effectiveGasPrice - baseFee). Protocol-defined,
  // needs no trace; usually the DOMINANT builder-payment term (coffeebabe's top tx: $2.13 tip vs
  // ~$0.01 direct). builder_payment = tip + direct coinbase transfers (robust profit floor).
  const priorityTipWei = options.baseFeePerGas != null
    ? hexToBigInt(receipt?.gasUsed) * (hexToBigInt(receipt?.effectiveGasPrice) - options.baseFeePerGas)
    : null;
  const builderPaymentWei = priorityTipWei === null && coinbaseTransferWei === null
    ? null
    : (priorityTipWei ?? 0n) + (coinbaseTransferWei ?? 0n);
  const builderPaymentEth = builderPaymentWei === null ? null : Number(builderPaymentWei) / 1e18;
  const builderPaymentUsd = builderPaymentEth === null ? null : builderPaymentEth * ethUsd;

  // Total gas the EOA paid = gasUsed * effectiveGasPrice (base fee burned + priority tip to builder).
  const totalGasWei = hexToBigInt(receipt?.gasUsed) * hexToBigInt(receipt?.effectiveGasPrice);
  const gasCostUsd = (Number(totalGasWei) / 1e18) * ethUsd;

  const v4Swaps = decodeV4Swaps(receipt);
  const v4PoolIds = [...new Set(v4Swaps.map((swap) => swap.poolId))];

  const realizedProfitUsd =
    erc20Usd === null && (!tracedEth || ethWei === 0n) ? null : (erc20Usd ?? 0) + ethProfitUsd;
  // NET = realized − total gas. realized is the beneficiary's INTERNAL gain (ERC20 + native ETH),
  // which is ALREADY net of any in-tx coinbase-transfer bribe (that ETH left the beneficiary to the
  // coinbase, so it is not in realized) but PRE-gas (gas is protocol-deducted from the EOA, outside
  // the internal transfers). So the ONLY remaining cost to subtract is total gas. Do NOT subtract
  // builderPaymentUsd: its coinbase-transfer component is already out of realized (subtracting it
  // again double-counts, which turned coffee's break-even dust into fake ~-$0.14 losses, 2026-07-12),
  // and its priority-tip component is part of totalGas. builderPayment stays informational (how much
  // the builder captured — the auction-competitiveness read).
  const netProfitUsd = realizedProfitUsd === null ? null : realizedProfitUsd - gasCostUsd;
  return {
    realizedProfitUsd,
    netProfitUsd,
    gasCostUsd,
    builderPaymentEth,
    builderPaymentUsd,
    erc20Usd,
    pricedDeltas: valuedDeltas.priced,
    unpricedDeltas: valuedDeltas.unpriced,
    profitConfidence,
    ethDeltaEth,
    ethProfitUsd,
    nativeTraceUsed: tracedEth,
    beneficiary,
    v4Swaps,
    v4PoolIds,
  };
}
