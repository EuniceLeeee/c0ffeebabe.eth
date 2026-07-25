/**
 * V3 cross-tick equivalence test (path B correctness gate for v3).
 *
 * Warms a real pool's state from mainnet (slot0 + liquidity + fee + tickSpacing,
 * plus tick data via TickLens.getPopulatedTicksInWord around the current tick),
 * then asserts our local v3SwapExactInput() equals the on-chain QuoterV2 for
 * several amounts (small → large/cross-tick). This is what validates the
 * cross-tick loop; the per-step math is already vector-verified in v3-math.ts.
 * Read-only; no anvil.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { v3SwapExactInput, type V3PoolState } from "../solver/v3-math.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { q96DirectedReserves } from "../venues/swaps/blockscan-state-shared.js";

function loadEnv(): void {
  try {
    const text = readFileSync(resolve("..", ".env"), "utf8");
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

const QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const TICK_LENS = "0xbfd8137f7d1516D3ea5cA83523914859ec47F573";

const poolIface = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const quoterIface = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
]);
const tickLensIface = new ethers.Interface([
  "function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex) view returns ((int24 tick,int128 liquidityNet,uint128 liquidityGross)[])",
]);

async function callAt(
  provider: ethers.JsonRpcProvider,
  to: string,
  data: string,
  block: number,
): Promise<string> {
  return provider.call({ to, data, blockTag: block });
}

interface PoolMeta {
  name: string;
  address: string;
  token0: string;
  token1: string;
}

async function warmV3(
  provider: ethers.JsonRpcProvider,
  pool: string,
  block: number,
  wordRadius: number,
): Promise<V3PoolState & { tickSpacing: number }> {
  const slot0Res = await callAt(provider, pool, poolIface.encodeFunctionData("slot0"), block);
  const slot0 = poolIface.decodeFunctionResult("slot0", slot0Res);
  const sqrtPriceX96 = BigInt(slot0[0]);
  const tick = Number(slot0[1]);
  const liquidity = BigInt(
    await callAt(provider, pool, poolIface.encodeFunctionData("liquidity"), block),
  );
  const fee = BigInt(await callAt(provider, pool, poolIface.encodeFunctionData("fee"), block));
  const tickSpacing = Number(
    BigInt(await callAt(provider, pool, poolIface.encodeFunctionData("tickSpacing"), block)),
  );

  const compressed = Math.floor(tick / tickSpacing);
  const currentWord = compressed >> 8;
  const tickBitmap = new Map<number, bigint>();
  const ticks = new Map<number, bigint>();

  for (let w = currentWord - wordRadius; w <= currentWord + wordRadius; w++) {
    const res = await callAt(
      provider,
      TICK_LENS,
      tickLensIface.encodeFunctionData("getPopulatedTicksInWord", [pool, w]),
      block,
    );
    const populated = tickLensIface.decodeFunctionResult("getPopulatedTicksInWord", res)[0] as Array<{
      tick: bigint;
      liquidityNet: bigint;
    }>;
    // Ensure the word exists in the bitmap map even if it has no ticks.
    if (!tickBitmap.has(w)) tickBitmap.set(w, 0n);
    for (const t of populated) {
      const tk = Number(t.tick);
      ticks.set(tk, BigInt(t.liquidityNet));
      const c = Math.floor(tk / tickSpacing);
      const word = c >> 8;
      const bit = ((c % 256) + 256) % 256;
      tickBitmap.set(word, (tickBitmap.get(word) ?? 0n) | (1n << BigInt(bit)));
    }
  }

  return { sqrtPriceX96, tick, liquidity, fee, tickSpacing, tickBitmap, ticks };
}

let pass = 0;
let total = 0;

async function testPool(
  provider: ethers.JsonRpcProvider,
  meta: PoolMeta,
  amounts: Array<[boolean, bigint, string]>,
  block: number,
): Promise<void> {
  const state = await warmV3(provider, meta.address, block, 12);
  console.log(
    `[v3equiv] ${meta.name}: tick=${state.tick} liq=${state.liquidity} fee=${state.fee} ` +
      `spacing=${state.tickSpacing} ticksWarmed=${state.ticks.size}`,
  );

  for (const [zeroForOne, amountIn, label] of amounts) {
    total++;
    const tokenIn = zeroForOne ? meta.token0 : meta.token1;
    const tokenOut = zeroForOne ? meta.token1 : meta.token0;
    let onchain: bigint;
    try {
      const res = await callAt(
        provider,
        QUOTER_V2,
        quoterIface.encodeFunctionData("quoteExactInputSingle", [
          { tokenIn, tokenOut, amountIn, fee: state.fee, sqrtPriceLimitX96: 0n },
        ]),
        block,
      );
      onchain = BigInt(quoterIface.decodeFunctionResult("quoteExactInputSingle", res)[0]);
    } catch (err) {
      console.log(`[v3equiv] SKIP ${meta.name} ${label}: quoter revert ${String(err).slice(0, 60)}`);
      total--;
      continue;
    }

    let local: bigint;
    try {
      local = v3SwapExactInput(state, zeroForOne, amountIn);
    } catch (err) {
      console.log(`[v3equiv] FAIL ${meta.name} ${label}: local threw ${String(err).slice(0, 80)}`);
      continue;
    }
    const diff = local > onchain ? local - onchain : onchain - local;
    // small tolerance: QuoterV2 includes the exact-output rounding; allow a few wei
    const ok = diff <= 3n;
    if (ok) pass++;
    console.log(
      `[v3equiv] ${ok ? "PASS" : "FAIL"} ${meta.name} ${label}: local=${local} onchain=${onchain} diff=${diff}`,
    );
  }
}

async function testExtremeSpotRepresentation(
  provider: ethers.JsonRpcProvider,
  block: number,
): Promise<void> {
  const pool = "0x616c5d79d8ffe6579a5ed63a84e7b3143557fe38";
  const [
    token0Raw,
    token1Raw,
    slot0Raw,
    liquidityRaw,
    feeRaw,
  ] = await Promise.all([
    callAt(provider, pool, poolIface.encodeFunctionData("token0"), block),
    callAt(provider, pool, poolIface.encodeFunctionData("token1"), block),
    callAt(provider, pool, poolIface.encodeFunctionData("slot0"), block),
    callAt(provider, pool, poolIface.encodeFunctionData("liquidity"), block),
    callAt(provider, pool, poolIface.encodeFunctionData("fee"), block),
  ]);
  const token0 = ethers.getAddress(`0x${token0Raw.slice(-40)}`);
  const token1 = ethers.getAddress(`0x${token1Raw.slice(-40)}`);
  const sqrtPriceX96 = BigInt(
    poolIface.decodeFunctionResult("slot0", slot0Raw)[0],
  );
  const liquidity = BigInt(liquidityRaw);
  const fee = BigInt(feeRaw);
  const directEdge: TokenEdge = {
    adapterId: "univ3-swap",
    target: pool,
    tokenIn: token0,
    tokenOut: token1,
    poolToken0: token0,
    poolToken1: token1,
    v3Fee: Number(fee),
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
  };
  const reverseEdge: TokenEdge = {
    ...directEdge,
    tokenIn: token1,
    tokenOut: token0,
  };
  const direct = q96DirectedReserves({
    sqrtPriceX96,
    liquidity,
    token0,
    token1,
    edge: directEdge,
  });
  const reverse = q96DirectedReserves({
    sqrtPriceX96,
    liquidity,
    token0,
    token1,
    edge: reverseEdge,
  });
  if (
    direct.reserveIn <= 0n ||
    direct.reserveOut <= 0n ||
    reverse.reserveIn <= 0n ||
    reverse.reserveOut <= 0n ||
    !Number.isFinite(direct.mid) ||
    direct.mid <= 0 ||
    !Number.isFinite(reverse.mid) ||
    reverse.mid <= 0
  ) {
    throw new Error("extreme V3 spot representation is not finite and positive");
  }
  if (Math.abs(direct.mid * reverse.mid - 1) >= 1e-12) {
    throw new Error("extreme V3 directed spots are not reciprocal");
  }

  const amountIn = 10n;
  const quoteRaw = await callAt(
    provider,
    QUOTER_V2,
    quoterIface.encodeFunctionData("quoteExactInputSingle", [{
      tokenIn: token0,
      tokenOut: token1,
      amountIn,
      fee,
      sqrtPriceLimitX96: 0n,
    }]),
    block,
  );
  const amountOut = BigInt(
    quoterIface.decodeFunctionResult("quoteExactInputSingle", quoteRaw)[0],
  );
  const averageExecutionPrice = Number(amountOut) / Number(amountIn);
  if (
    amountOut <= 0n ||
    !Number.isFinite(averageExecutionPrice) ||
    averageExecutionPrice <= 0 ||
    averageExecutionPrice > direct.mid
  ) {
    throw new Error(
      `extreme V3 onchain quote contradicts spot direction: ` +
        `spot=${direct.mid} quote=${amountIn}->${amountOut}`,
    );
  }
  console.log(
    `[v3equiv] PASS extreme source spot: block=${block} ` +
      `reserves=${direct.reserveIn}/${direct.reserveOut} ` +
      `quote=${amountIn}->${amountOut}`,
  );
}

async function main(): Promise<void> {
  loadEnv();
  const rpc = process.env.MAINNET_RPC_URL;
  if (!rpc) throw new Error("MAINNET_RPC_URL required");
  const provider = new ethers.JsonRpcProvider(rpc);
  const requested = process.env.SEARCHER_V3_EQUIV_BLOCK;
  const block = requested === undefined
    ? await provider.getBlockNumber()
    : Number(requested);
  if (!Number.isSafeInteger(block) || block <= 0) {
    throw new Error(`invalid SEARCHER_V3_EQUIV_BLOCK ${requested}`);
  }
  console.log(`[v3equiv] pinned block ${block}`);

  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

  // USDC/USDT 0.01% — token0=USDC (a0 < da), token1=USDT
  await testPool(
    provider,
    { name: "USDC/USDT-100", address: "0x3416cF6C708Da44DB2624D63ea0AAef7113527C6", token0: USDC, token1: USDT },
    [
      [true, 1_000n * 10n ** 6n, "1k USDC→USDT"],
      [false, 1_000n * 10n ** 6n, "1k USDT→USDC"],
      [true, 100_000n * 10n ** 6n, "100k USDC→USDT"],
      [true, 1_000_000n * 10n ** 6n, "1M USDC→USDT"],
    ],
    block,
  );
  await testExtremeSpotRepresentation(provider, block);

  // WETH pools (volatile, tick far from 0) — these are what AC-3's path uses.
  // USDC/WETH 0.01% — token0=USDC, token1=WETH
  await testPool(
    provider,
    { name: "USDC/WETH-100", address: "0xE0554a476A092703abdB3Ef35c80e0D76d32939F", token0: USDC, token1: WETH },
    [
      [true, 10_000n * 10n ** 6n, "10k USDC→WETH"],
      [false, 5n * 10n ** 18n, "5 WETH→USDC"],
    ],
    block,
  );
  // WETH/USDT 0.01% — token0=WETH (C0 < dA), token1=USDT
  await testPool(
    provider,
    { name: "WETH/USDT-100", address: "0xc7bBeC68d12a0d1830360F8Ec58fA599bA1b0e9b", token0: WETH, token1: USDT },
    [
      [true, 5n * 10n ** 18n, "5 WETH→USDT"],
      [false, 10_000n * 10n ** 6n, "10k USDT→WETH"],
    ],
    block,
  );

  console.log(`[v3equiv] ${pass}/${total} equivalence checks passed`);
  if (pass !== total) throw new Error("v3 cross-tick mismatch — see FAIL rows above");
  console.log("v3-equiv PASS (cross-tick vs QuoterV2)");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
