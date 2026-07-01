import { actionsFromLogs } from "../actions/from-logs.js";
import { roughValueUsd } from "./raw-delta.js";
import { RpcClient, hexToBigInt } from "../rpc/client.js";
import { ADDR, TOPICS, lower } from "../registry/protocols.js";

const V4_MANAGER = lower(ADDR.UNIV4_POOL_MANAGER);
const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"; // latestAnswer() → 8 decimals

export interface ArbProfit {
  /** ERC20 (incl. WETH) + native-ETH net value the bot gained, USD. null if nothing priceable. */
  realizedProfitUsd: number | null;
  erc20Usd: number | null;
  ethDeltaEth: number;
  ethProfitUsd: number;
  beneficiary: string;
  v4Swaps: number;
  v4Pools: number;
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
  const erc20Usd = roughValueUsd(rawDeltas, ethUsd);

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

  // Uniswap v4 usage: distinct poolIds swapped in the PoolManager.
  let v4Swaps = 0;
  const v4Pools = new Set<string>();
  const swapTopic = lower(TOPICS.univ4Swap);
  for (const log of receipt?.logs ?? []) {
    if (lower(log.address) === V4_MANAGER && lower(log.topics?.[0]) === swapTopic) {
      v4Swaps++;
      if (log.topics?.[1]) v4Pools.add(lower(log.topics[1]));
    }
  }

  const realizedProfitUsd =
    erc20Usd === null && (!tracedEth || ethWei === 0n) ? null : (erc20Usd ?? 0) + ethProfitUsd;
  return { realizedProfitUsd, erc20Usd, ethDeltaEth, ethProfitUsd, beneficiary: to, v4Swaps, v4Pools: v4Pools.size };
}
