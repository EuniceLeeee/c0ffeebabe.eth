import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import { propagateAmounts } from "../solver/amount-propagation.js";
import type { TokenPath } from "../planner/token-graph.js";

const DEFAULT_BLOCK = 25_447_685;
const DEFAULT_RPC = "http://127.0.0.1:8545";
const DEFAULT_MIN_WEI = 10n ** 17n;
const DEFAULT_MAX_WEI = 10n ** 25n;
const DEFAULT_POINTS = 18;
const DEFAULT_GAS_COST_ETH = "0.00014";

const hop = (
  target: string,
  tokenIn: string,
  tokenOut: string,
): TokenPath["edges"][number] => ({
  adapterId: "univ3-swap",
  target,
  tokenIn,
  tokenOut,
  slotKind: "swap",
});

const PATH: TokenPath = {
  edges: [
    hop(ADDR.UNISWAP_V3_USDC_WETH_100, ADDR.WETH, ADDR.USDC),
    hop(ADDR.UNISWAP_V3_USDC_USDT_100, ADDR.USDC, ADDR.USDT),
    hop(ADDR.UNISWAP_V3_USDT_WETH, ADDR.USDT, ADDR.WETH),
  ],
};

interface Args {
  rpcUrl: string;
  block: number;
  minWei: bigint;
  maxWei: bigint;
  points: number;
  gasCostWei: bigint;
}

function arg(name: string, fallback: string): string {
  const key = `--${name}`;
  const withEquals = process.argv.find((v) => v.startsWith(`${key}=`));
  if (withEquals) return withEquals.slice(key.length + 1);
  const idx = process.argv.indexOf(key);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function parseArgs(): Args {
  const gasCostEth = arg("gas-cost-eth", DEFAULT_GAS_COST_ETH);
  return {
    rpcUrl: arg("rpc", process.env.SEARCHER_LIVE_RPC_URL ?? DEFAULT_RPC),
    block: Number(arg("block", String(DEFAULT_BLOCK))),
    minWei: parseWeiInteger(arg("min-wei", DEFAULT_MIN_WEI.toString())),
    maxWei: parseWeiInteger(arg("max-wei", DEFAULT_MAX_WEI.toString())),
    points: Number(arg("points", String(DEFAULT_POINTS))),
    gasCostWei: ethers.parseEther(gasCostEth),
  };
}

function parseWeiInteger(value: string): bigint {
  const match = value.toLowerCase().match(/^(\d+)e(\d+)$/);
  if (match) return BigInt(match[1]) * 10n ** BigInt(match[2]);
  return BigInt(value);
}

function logSpaced(min: bigint, max: bigint, points: number): bigint[] {
  if (points < 2) return [min];
  const out: bigint[] = [];
  const seen = new Set<string>();
  const lo = Math.log10(Number(min));
  const hi = Math.log10(Number(max));
  for (let i = 0; i < points; i++) {
    const exp = lo + ((hi - lo) * i) / (points - 1);
    const whole = Math.floor(exp);
    const mantissa = BigInt(Math.round(Math.pow(10, exp - whole) * 1_000_000));
    let amount = (mantissa * 10n ** BigInt(whole)) / 1_000_000n;
    if (i === 0) amount = min;
    if (i === points - 1) amount = max;
    const key = amount.toString();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(amount);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  if (opts.maxWei < opts.minWei) throw new Error("--max-wei must be >= --min-wei");

  const provider = new ethers.JsonRpcProvider(opts.rpcUrl);
  const state = {
    call: async (req: { to: string; data: string; from?: string }) =>
      provider.call({ to: req.to, data: req.data, from: req.from, blockTag: opts.block }),
  } as StateBackend;

  console.log(
    `[falsify-r11] block=${opts.block} rpc=${opts.rpcUrl} ` +
      `gas_cost_eth=${formatEth(opts.gasCostWei)} points=${opts.points}`,
  );
  console.log(
    `[falsify-r11] path WETH->USDC->USDT->WETH ` +
      `pools=${ADDR.UNISWAP_V3_USDC_WETH_100},${ADDR.UNISWAP_V3_USDC_USDT_100},${ADDR.UNISWAP_V3_USDT_WETH}`,
  );
  console.log("size_weth,gross_profit_eth,net_profit_eth");

  let best: { size: bigint; net: bigint } | null = null;
  let winner: { size: bigint; net: bigint } | null = null;
  for (const size of logSpaced(opts.minWei, opts.maxWei, opts.points)) {
    try {
      const amounts = await propagateAmounts(PATH, size, state);
      const gross = amounts[amounts.length - 1] - size;
      const net = gross - opts.gasCostWei;
      if (!best || net > best.net) best = { size, net };
      if (!winner && net > 0n) winner = { size, net };
      console.log(`${formatEth(size)},${formatEth(gross)},${formatEth(net)}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(`${formatEth(size)},ERROR,ERROR # ${error.slice(0, 160)}`);
    }
  }

  if (!best) throw new Error("all quote points failed");
  if (winner) {
    console.log(
      `FALSIFIED: sizing explains dust (net profit > 0 at size ${formatEth(winner.size)} WETH)`,
    );
  } else {
    console.log(
      `CONFIRMED: dust persists across full size range ` +
        `(max net profit = ${formatEth(best.net)} ETH at size ${formatEth(best.size)} WETH)`,
    );
  }
  provider.destroy();
}

function formatEth(value: bigint): string {
  return ethers.formatEther(value);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
