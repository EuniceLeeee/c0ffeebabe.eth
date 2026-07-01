import { ethers } from "ethers";
import { actionsFromLogs } from "../actions/from-logs.js";
import { RpcClient, hexToBigInt } from "../rpc/client.js";
import { ADDR, TOPICS, lower, tokenMeta } from "../registry/protocols.js";
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
}

export interface ArbProfit {
  /** ERC20 (incl. WETH) + native-ETH net value the bot gained, USD. null if nothing priceable. */
  realizedProfitUsd: number | null;
  erc20Usd: number | null;
  pricedDeltas: TokenDelta[];
  unpricedDeltas: TokenDelta[];
  profitConfidence: "high" | "medium" | "requires_decode";
  ethDeltaEth: number;
  ethProfitUsd: number;
  beneficiary: string;
  v4Swaps: V4Swap[];
  v4PoolIds: string[];
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

/**
 * Realized profit of an arb tx = net value the bot entity (tx.to contract + tx.from
 * EOA, net of gas) gained, in USD. Covers ERC20 (incl. WETH) via Transfer logs AND
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
): Promise<ArbProfit> {
  const to = lower(receipt?.to ?? tx?.to ?? "");
  const from = lower(receipt?.from ?? tx?.from ?? "");
  const actors = [to, from].filter(Boolean);

  // ERC20 net for the bot (WETH now valued at ethUsd, not 0).
  const { rawDeltas } = actionsFromLogs(receipt, actors);
  const valuedDeltas = valueDeltas(rawDeltas, ethUsd);
  const erc20Usd = valuedDeltas.usd;
  const profitConfidence =
    erc20Usd === null ? "requires_decode" : valuedDeltas.unpriced.length === 0 ? "high" : "medium";

  // Native ETH: contract keeps profit as-is; for the EOA add gas back to isolate the
  // non-gas ETH flow (profit swept to owner, or a bribe paid, both show correctly).
  let ethWei = 0n;
  let tracedEth = false;
  try {
    const tr = await rpc.tracePrestate(txHash);
    const pre = tr?.pre ?? {};
    const post = tr?.post ?? {};
    const bal = (m: Record<string, any>, a: string): bigint | null =>
      a in m && m[a]?.balance !== undefined ? hexToBigInt(m[a].balance) : null;
    const delta = (a: string): bigint => {
      const b0 = bal(pre, a);
      const b1 = bal(post, a);
      if (b0 === null && b1 === null) return 0n;
      return (b1 ?? b0 ?? 0n) - (b0 ?? b1 ?? 0n);
    };
    if (to) ethWei += delta(to);
    if (from && from !== to) {
      const gas = hexToBigInt(receipt?.gasUsed) * hexToBigInt(receipt?.effectiveGasPrice);
      ethWei += delta(from) + gas;
    }
    tracedEth = true;
  } catch {
    // trace unavailable → ETH profit unknown, leave 0
  }
  const ethDeltaEth = Number(ethWei) / 1e18;
  const ethProfitUsd = ethDeltaEth * ethUsd;

  const v4Swaps = decodeV4Swaps(receipt);
  const v4PoolIds = [...new Set(v4Swaps.map((swap) => swap.poolId))];

  const realizedProfitUsd =
    erc20Usd === null && (!tracedEth || ethWei === 0n) ? null : (erc20Usd ?? 0) + ethProfitUsd;
  return {
    realizedProfitUsd,
    erc20Usd,
    pricedDeltas: valuedDeltas.priced,
    unpricedDeltas: valuedDeltas.unpriced,
    profitConfidence,
    ethDeltaEth,
    ethProfitUsd,
    beneficiary: to,
    v4Swaps,
    v4PoolIds,
  };
}
