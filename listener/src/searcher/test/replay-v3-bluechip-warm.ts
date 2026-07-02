/**
 * Bluechip UniV3 bitmap warm replay for R1.
 *
 * Read-only repair replay. It records USDC/WETH-100 state at the pinned block,
 * proves the old +/-8-word local state would throw an unwarmed-word miss, then
 * proves PoolStateCache.quoteV3 completes locally with adaptive word warming and
 * matches QuoterV2. The runner should point RPC at local reth:
 *
 *   SEARCHER_LIVE_RPC_URL=http://127.0.0.1:8545 \
 *   node --import tsx src/searcher/test/replay-v3-bluechip-warm.ts
 *
 * Knobs:
 *   SEARCHER_FORK_BLOCK              default 25442793
 *   SEARCHER_BLUECHIP_TX_INDEX       default 30, source swap in the pinned block
 *   SEARCHER_BLUECHIP_TX_HASH        optional source tx override
 *   SEARCHER_BLUECHIP_AMOUNT_IN      optional raw amount override
 *   SEARCHER_BLUECHIP_DIRECTION      usdc-weth | weth-usdc | zeroForOne | oneForZero
 *   SEARCHER_V3_ADAPTIVE_MAX_WORDS   default 64 in PoolStateCache
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import type { StateBackend } from "../../shared/state/state-backend.js";
import {
  V3MissingBitmapWordError,
  v3SwapExactInput,
  type V3PoolState,
} from "../solver/v3-math.js";

const DEFAULT_BLOCK = 25_442_793;
const DEFAULT_SOURCE_TX_INDEX = 30;
const OLD_WORD_RADIUS = 8;

const POOL = "0xE0554a476A092703abdB3Ef35c80e0D76d32939F";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const TICK_LENS = "0xbfd8137f7d1516D3ea5cA83523914859ec47F573";

// Fallback only if the pinned source swap cannot be read. Prefer the real block
// tx impact; override this with SEARCHER_BLUECHIP_AMOUNT_IN when calibrating.
const DEFAULT_LARGE_USDC_TO_WETH_AMOUNT_IN = 25_000_000n * 10n ** 6n;

const poolIface = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const tickLensIface = new ethers.Interface([
  "function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) view returns ((int24 tick,int128 liquidityNet,uint128 liquidityGross)[])",
]);
const quoterIface = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
]);
const swapIface = new ethers.Interface([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);

interface ReplayQuote {
  zeroForOne: boolean;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  source: string;
}

interface WarmedV3 extends V3PoolState {
  token0: string;
  token1: string;
}

function loadEnv(): void {
  for (const path of [resolve("..", ".env"), resolve(".env")]) {
    try {
      const text = readFileSync(path, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#") || !t.includes("=")) continue;
        const [rawKey, ...rest] = t.split("=");
        const key = rawKey.replace(/^export\s+/, "");
        if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
      }
    } catch {
      /* rely on ambient env */
    }
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function callAt(
  provider: ethers.JsonRpcProvider,
  to: string,
  data: string,
  block: number,
): Promise<string> {
  return provider.call({ to, data, blockTag: block });
}

async function warmV3(
  provider: ethers.JsonRpcProvider,
  pool: string,
  block: number,
  wordRadius: number,
): Promise<WarmedV3> {
  const [slot0Res, liquidityRes, feeRes, tickSpacingRes, token0Res, token1Res] = await Promise.all([
    callAt(provider, pool, poolIface.encodeFunctionData("slot0"), block),
    callAt(provider, pool, poolIface.encodeFunctionData("liquidity"), block),
    callAt(provider, pool, poolIface.encodeFunctionData("fee"), block),
    callAt(provider, pool, poolIface.encodeFunctionData("tickSpacing"), block),
    callAt(provider, pool, poolIface.encodeFunctionData("token0"), block),
    callAt(provider, pool, poolIface.encodeFunctionData("token1"), block),
  ]);
  const slot0 = poolIface.decodeFunctionResult("slot0", slot0Res);
  const tick = Number(slot0[1]);
  const tickSpacing = Number(poolIface.decodeFunctionResult("tickSpacing", tickSpacingRes)[0]);
  const compressed = Math.floor(tick / tickSpacing);
  const currentWord = compressed >> 8;
  const tickBitmap = new Map<number, bigint>();
  const ticks = new Map<number, bigint>();

  const words: number[] = [];
  for (let w = currentWord - wordRadius; w <= currentWord + wordRadius; w++) words.push(w);
  await Promise.all(words.map((word) => fetchTickWord(provider, pool, block, tickSpacing, tickBitmap, ticks, word)));

  return {
    sqrtPriceX96: BigInt(slot0[0]),
    tick,
    liquidity: BigInt(poolIface.decodeFunctionResult("liquidity", liquidityRes)[0]),
    fee: BigInt(poolIface.decodeFunctionResult("fee", feeRes)[0]),
    tickSpacing,
    token0: ethers.getAddress("0x" + token0Res.slice(-40)).toLowerCase(),
    token1: ethers.getAddress("0x" + token1Res.slice(-40)).toLowerCase(),
    tickBitmap,
    ticks,
  };
}

async function fetchTickWord(
  provider: ethers.JsonRpcProvider,
  pool: string,
  block: number,
  tickSpacing: number,
  tickBitmap: Map<number, bigint>,
  ticks: Map<number, bigint>,
  word: number,
): Promise<void> {
  const result = await callAt(
    provider,
    TICK_LENS,
    tickLensIface.encodeFunctionData("getPopulatedTicksInWord", [pool, word]),
    block,
  );
  const populated = tickLensIface.decodeFunctionResult(
    "getPopulatedTicksInWord",
    result,
  )[0] as Array<{ tick: bigint; liquidityNet: bigint }>;
  tickBitmap.set(word, tickBitmap.get(word) ?? 0n);
  for (const t of populated) {
    const tk = Number(t.tick);
    ticks.set(tk, BigInt(t.liquidityNet));
    const compressed = Math.floor(tk / tickSpacing);
    const bitmapWord = compressed >> 8;
    const bit = ((compressed % 256) + 256) % 256;
    tickBitmap.set(bitmapWord, (tickBitmap.get(bitmapWord) ?? 0n) | (1n << BigInt(bit)));
  }
}

async function quoteQuoterV2(
  provider: ethers.JsonRpcProvider,
  block: number,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: bigint,
): Promise<bigint> {
  const result = await callAt(
    provider,
    QUOTER_V2,
    quoterIface.encodeFunctionData("quoteExactInputSingle", [
      { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n },
    ]),
    block,
  );
  return BigInt(quoterIface.decodeFunctionResult("quoteExactInputSingle", result)[0]);
}

async function selectReplayQuote(provider: ethers.JsonRpcProvider, block: number): Promise<ReplayQuote> {
  const directionOverride = parseDirection(process.env.SEARCHER_BLUECHIP_DIRECTION);
  const amountOverride = process.env.SEARCHER_BLUECHIP_AMOUNT_IN
    ? BigInt(process.env.SEARCHER_BLUECHIP_AMOUNT_IN)
    : null;
  let sourceSwap: ReplayQuote | null = null;
  try {
    sourceSwap = await readPinnedSourceSwap(provider, block);
  } catch (err) {
    console.log(
      `[v3-bluechip-warm] source swap read skipped: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (amountOverride !== null) {
    const zeroForOne = directionOverride ?? sourceSwap?.zeroForOne ?? true;
    const [tokenIn, tokenOut] = zeroForOne ? [USDC, WETH] : [WETH, USDC];
    return {
      zeroForOne,
      tokenIn,
      tokenOut,
      amountIn: amountOverride,
      source: `SEARCHER_BLUECHIP_AMOUNT_IN override${directionOverride === null ? " (direction from source/default)" : ""}`,
    };
  }
  if (sourceSwap) return sourceSwap;

  return {
    zeroForOne: true,
    tokenIn: USDC,
    tokenOut: WETH,
    amountIn: DEFAULT_LARGE_USDC_TO_WETH_AMOUNT_IN,
    source: "DEFAULT_LARGE_USDC_TO_WETH_AMOUNT_IN fallback; set SEARCHER_BLUECHIP_AMOUNT_IN to pin exact impact",
  };
}

async function readPinnedSourceSwap(provider: ethers.JsonRpcProvider, block: number): Promise<ReplayQuote> {
  const txHash = process.env.SEARCHER_BLUECHIP_TX_HASH ?? await txHashAtIndex(
    provider,
    block,
    Number(process.env.SEARCHER_BLUECHIP_TX_INDEX ?? DEFAULT_SOURCE_TX_INDEX),
  );
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`receipt missing for source tx ${txHash}`);

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== POOL.toLowerCase()) continue;
    let parsed: ethers.LogDescription | null;
    try {
      parsed = swapIface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    const amount0 = BigInt(parsed.args.amount0);
    const amount1 = BigInt(parsed.args.amount1);
    if (amount0 > 0n && amount1 < 0n) {
      return {
        zeroForOne: true,
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: amount0,
        source: `source tx ${txHash} USDC->WETH pool Swap log`,
      };
    }
    if (amount1 > 0n && amount0 < 0n) {
      return {
        zeroForOne: false,
        tokenIn: WETH,
        tokenOut: USDC,
        amountIn: amount1,
        source: `source tx ${txHash} WETH->USDC pool Swap log`,
      };
    }
  }
  throw new Error(`no USDC/WETH-100 Swap log in source tx ${txHash}`);
}

async function txHashAtIndex(provider: ethers.JsonRpcProvider, block: number, txIndex: number): Promise<string> {
  const raw = await provider.send("eth_getBlockByNumber", [ethers.toQuantity(block), true]) as {
    transactions?: Array<{ hash?: string }>;
  } | null;
  const tx = raw?.transactions?.[txIndex];
  if (!tx?.hash) throw new Error(`block ${block} tx index ${txIndex} missing`);
  return tx.hash;
}

function parseDirection(value: string | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/_/g, "-");
  if (["usdc-weth", "token0-token1", "zero-for-one", "zeroforone", "true"].includes(normalized)) {
    return true;
  }
  if (["weth-usdc", "token1-token0", "one-for-zero", "oneforzero", "false"].includes(normalized)) {
    return false;
  }
  throw new Error(
    `bad SEARCHER_BLUECHIP_DIRECTION=${value}; expected usdc-weth, weth-usdc, zeroForOne, or oneForZero`,
  );
}

function assertOldNarrowMiss(state: V3PoolState, zeroForOne: boolean, amountIn: bigint): number {
  try {
    const out = v3SwapExactInput(state, zeroForOne, amountIn);
    throw new Error(
      `old +/-${OLD_WORD_RADIUS} warming completed unexpectedly (amountOut=${out}). ` +
        `Increase SEARCHER_BLUECHIP_AMOUNT_IN or check the pinned source swap amount.`,
    );
  } catch (err) {
    if (err instanceof V3MissingBitmapWordError) return err.word;
    throw err;
  }
}

function makeRpcState(provider: ethers.JsonRpcProvider, block: number): StateBackend {
  return {
    async call(req: { to: string; data: string; from?: string }): Promise<string> {
      return provider.call({ to: req.to, data: req.data, from: req.from, blockTag: block });
    },
  } as unknown as StateBackend;
}

function diffAbs(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

async function main(): Promise<void> {
  loadEnv();
  const rpc = process.env.SEARCHER_LIVE_RPC_URL || process.env.MAINNET_RPC_URL;
  if (!rpc) throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required");
  const block = Number(process.env.SEARCHER_FORK_BLOCK ?? DEFAULT_BLOCK);
  assert(Number.isInteger(block) && block > 0, `bad SEARCHER_FORK_BLOCK=${process.env.SEARCHER_FORK_BLOCK}`);

  const provider = new ethers.JsonRpcProvider(rpc);
  const quote = await selectReplayQuote(provider, block);
  const oldState = await warmV3(provider, POOL, block, OLD_WORD_RADIUS);
  assert(oldState.token0 === USDC.toLowerCase(), `pool token0 changed: ${oldState.token0}`);
  assert(oldState.token1 === WETH.toLowerCase(), `pool token1 changed: ${oldState.token1}`);

  console.log(
    `[v3-bluechip-warm] block=${block} pool=${POOL} tick=${oldState.tick} ` +
      `liquidity=${oldState.liquidity} fee=${oldState.fee} spacing=${oldState.tickSpacing}`,
  );
  console.log(
    `[v3-bluechip-warm] replay amount source=${quote.source} direction=` +
      `${quote.zeroForOne ? "USDC->WETH" : "WETH->USDC"} amountIn=${quote.amountIn}`,
  );

  const missingWord = assertOldNarrowMiss(oldState, quote.zeroForOne, quote.amountIn);
  console.log(
    `[v3-bluechip-warm] baseline old +/-${OLD_WORD_RADIUS} would fall back: ` +
      `missing bitmap word ${missingWord}`,
  );

  const { PoolStateCache } = await import("../solver/pool-state-cache.js");
  const cache = new PoolStateCache(provider);
  cache.setTickBlock(block);
  const fixedLocal = await cache.quoteV3(
    makeRpcState(provider, block),
    POOL,
    quote.tokenIn,
    quote.tokenOut,
    quote.amountIn,
  );
  const onchain = await quoteQuoterV2(provider, block, quote.tokenIn, quote.tokenOut, quote.amountIn, oldState.fee);
  const diff = diffAbs(fixedLocal, onchain);
  assert(
    diff <= 1n,
    `fixed local quote mismatch: local=${fixedLocal} quoterV2=${onchain} diff=${diff} missingWord=${missingWord}`,
  );

  console.log(
    `[v3-bluechip-warm] fixed local=${fixedLocal} quoterV2=${onchain} diff=${diff} ` +
      `(baseline missing word ${missingWord})`,
  );
  console.log("v3-bluechip-warm PASS");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
