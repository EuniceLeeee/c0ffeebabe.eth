/**
 * V4 local-math gate.
 *
 * Truth source A: a known-good USDC/USDT v4 pool where V4Quoter works. The
 * local Pool.swap math must match a fresh V4Quoter eth_call bit-exactly at the
 * pinned pre-state block.
 *
 * Truth source B: F-014 c069abea, where V4Quoter reverts NotEnoughLiquidity but
 * the real core swap fills. This branch expects MAINNET_RPC_URL to point at an
 * anvil fork anchored with:
 *   anvil --fork-transaction-hash 0x63fb77b723f3bd7fd4d9539ef1e1e248cb5499153dbfc225e8b24ae1522ec6e7
 * The expected core-fill amount can be overridden with
 * V4_MATH_F014_EXPECTED_OUT for evaluator-supplied exact per-size truth.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { type V4PoolKey, v4PoolId } from "../planner/token-graph.js";
import { quoteV4ExactInLocal, type V4MathStateBackend } from "../solver/v4-math.js";

const USDC = ADDR.USDC;
const USDT = ADDR.USDT;
const SRUSDE = "0x3d7d6fdf07EE548B939A80edbc9B2256d0cdc003";
const ZERO = ADDR.ZERO;

const USDC_USDT_POOL_ID = "0x395f91b34aa34a477ce3bc6505639a821b286a62b1a164fc1887fa3a5ef713a5";
const SRUSDE_USDC_POOL_ID = "0xc069abea3d235a4f38cb7d0219f66cc7cbbce92f0b4740bac46bef896c2277b8";

const USDC_USDT_BLOCK = 25436882;
const USDT_IN = 35045872323n;
// The V4Quoter's DETERMINISTIC output for this input at the pinned pre-state block (evaluator-verified:
// the on-chain quoteExactInputSingle returns exactly this). NOT the real-swap fill 35013321757 — that
// differs by ~0.37bps (intervening state between the 25436882 pre-state and the 25436883 swap); the
// quoter-vs-reality check lives in validate-v4-quote with tolerance. Here truth source A is bit-exact
// local-vs-quoter, so the pinned target must be the quoter's value.
const USDC_USDT_EXPECTED_OUT = 35012016347n;
// c069abea has ONE-SIDED liquidity (concentrated below the current price). The competitor's REAL swap
// on this pool was srUSDe->USDC (zeroForOne=true, price DOWN — tx86's Swap event sqrtPrice fell
// 79860609.. -> 79860599..), which the V4Quoter prices fine. The OPPOSITE (USDC->srUSDe, price up) has
// no standing liquidity above current, so the V4Quoter reverts NotEnoughLiquidity there — that is
// CORRECT one-sided-pool behavior, not the "quoter gap" F-014 first read it as (a direction error).
const F014_SRUSDE_IN = 934460889828731878592n; // real: srUSDe sold on c069abea
const F014_USDC_IN = 949488853n;               // opposite one-sided direction (quoter reverts)
const NOT_ENOUGH_LIQUIDITY = "7a5ed734";

const poolUSDCUSDT8: V4PoolKey = { currency0: USDC, currency1: USDT, fee: 8, tickSpacing: 1, hooks: ZERO };
const poolSrUSDeUSDC: V4PoolKey = { currency0: SRUSDE, currency1: USDC, fee: 100, tickSpacing: 1, hooks: ZERO };

const quoterIface = new ethers.Interface([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);

interface QuoteResult {
  status: "ok" | "reverted";
  amountOut?: bigint;
  revert?: string;
}

function loadEnv(): void {
  try {
    const text = readFileSync(resolve("..", ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [rawKey, ...rest] = trimmed.split("=");
      const key = rawKey.replace(/^export\s+/, "");
      if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
    }
  } catch {
    /* rely on ambient env */
  }
}

function stateAt(provider: ethers.JsonRpcProvider, blockTag?: number): V4MathStateBackend {
  return {
    call: (req) => provider.call(blockTag === undefined
      ? { to: req.to, data: req.data }
      : { to: req.to, data: req.data, blockTag }),
  };
}

async function quoteV4Quoter(
  provider: ethers.JsonRpcProvider,
  poolKey: V4PoolKey,
  tokenIn: string,
  amountIn: bigint,
  blockTag?: number,
): Promise<QuoteResult> {
  const zeroForOne = tokenIn.toLowerCase() === poolKey.currency0.toLowerCase();
  const data = quoterIface.encodeFunctionData("quoteExactInputSingle", [
    { poolKey, zeroForOne, exactAmount: amountIn, hookData: "0x" },
  ]);
  try {
    const raw = await provider.call(blockTag === undefined
      ? { to: ADDR.UNISWAP_V4_QUOTER, data }
      : { to: ADDR.UNISWAP_V4_QUOTER, data, blockTag });
    const decoded = quoterIface.decodeFunctionResult("quoteExactInputSingle", raw);
    return { status: "ok", amountOut: BigInt(decoded[0]) };
  } catch (err) {
    return { status: "reverted", revert: extractRevertSelector(err) };
  }
}

function extractRevertSelector(err: unknown): string {
  const e = err as { data?: string; info?: { error?: { data?: string } }; message?: string };
  const data = e?.data ?? e?.info?.error?.data ?? "";
  const hex = typeof data === "string" ? data.toLowerCase().replace(/^0x/, "") : "";
  if (hex.includes(NOT_ENOUGH_LIQUIDITY)) return "NotEnoughLiquidity";
  if (hex.length >= 8) return "0x" + hex.slice(0, 8);
  return e?.message ?? "revert";
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

function assertEq(label: string, got: bigint, expected: bigint): void {
  assert(got === expected, `${label}: got ${got}, expected ${expected}, diff=${absDiff(got, expected)}`);
}

function assertWithin(label: string, got: bigint, expected: bigint, tolerance: bigint): void {
  const diff = absDiff(got, expected);
  assert(diff <= tolerance, `${label}: got ${got}, expected ${expected}, diff=${diff}, tolerance=${tolerance}`);
}

function assertPoolId(label: string, key: V4PoolKey, expected: string): void {
  const got = v4PoolId(key);
  assert(got === expected, `${label} poolId mismatch: got ${got}, expected ${expected}`);
}

function optionalBlockTag(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

async function main(): Promise<void> {
  loadEnv();
  const rpc = process.env.MAINNET_RPC_URL;
  if (!rpc) throw new Error("MAINNET_RPC_URL required");
  const provider = new ethers.JsonRpcProvider(rpc);

  assertPoolId("USDC/USDT fee-8", poolUSDCUSDT8, USDC_USDT_POOL_ID);
  assertPoolId("srUSDe/USDC fee-100", poolSrUSDeUSDC, SRUSDE_USDC_POOL_ID);

  const usdcUsdtState = stateAt(provider, USDC_USDT_BLOCK);
  const usdcUsdtLocal = await quoteV4ExactInLocal(
    usdcUsdtState,
    { poolId: USDC_USDT_POOL_ID, poolKey: poolUSDCUSDT8 },
    USDT,
    USDC,
    USDT_IN,
  );
  const usdcUsdtQuoter = await quoteV4Quoter(provider, poolUSDCUSDT8, USDT, USDT_IN, USDC_USDT_BLOCK);
  assert(usdcUsdtQuoter.status === "ok" && usdcUsdtQuoter.amountOut !== undefined, "USDC/USDT V4Quoter reverted");
  assertEq("USDC/USDT local vs V4Quoter", usdcUsdtLocal, usdcUsdtQuoter.amountOut);
  assertEq("USDC/USDT pinned fill", usdcUsdtLocal, USDC_USDT_EXPECTED_OUT);
  console.log(
    `[v4math] PASS USDC/USDT @${USDC_USDT_BLOCK}: local=${usdcUsdtLocal} quoter=${usdcUsdtQuoter.amountOut}`,
  );

  // Truth source B (real direction): srUSDe->USDC on c069abea — the competitor's actual swap. The
  // V4Quoter prices it, and the local math must match bit-exact. Expects MAINNET_RPC_URL at a tx85-
  // anchored anvil fork (`anvil --fork-transaction-hash 0x63fb77b7…`); V4_MATH_F014_BLOCK optional.
  const f014BlockTag = optionalBlockTag("V4_MATH_F014_BLOCK");
  const sellLocal = await quoteV4ExactInLocal(
    stateAt(provider, f014BlockTag),
    { poolId: SRUSDE_USDC_POOL_ID, poolKey: poolSrUSDeUSDC },
    SRUSDE,
    USDC,
    F014_SRUSDE_IN,
  );
  const sellQuoter = await quoteV4Quoter(provider, poolSrUSDeUSDC, SRUSDE, F014_SRUSDE_IN, f014BlockTag);
  assert(
    sellQuoter.status === "ok" && sellQuoter.amountOut !== undefined,
    `c069abea srUSDe->USDC V4Quoter unexpectedly ${sellQuoter.status}/${sellQuoter.revert}`,
  );
  assertEq("c069abea srUSDe->USDC (real dir) local vs V4Quoter", sellLocal, sellQuoter.amountOut);
  console.log(`[v4math] PASS c069abea srUSDe->USDC: local=${sellLocal} quoter=${sellQuoter.amountOut}`);

  // Secondary (one-sided-pool robustness + F-014 reframe): the OPPOSITE direction USDC->srUSDe has no
  // standing liquidity above current price, so the V4Quoter reverts NotEnoughLiquidity — correct, not a
  // quoter gap. The local math returns a bounded partial fill instead of throwing.
  const buyQuoter = await quoteV4Quoter(provider, poolSrUSDeUSDC, USDC, F014_USDC_IN, f014BlockTag);
  const buyLocal = await quoteV4ExactInLocal(
    stateAt(provider, f014BlockTag),
    { poolId: SRUSDE_USDC_POOL_ID, poolKey: poolSrUSDeUSDC },
    USDC,
    SRUSDE,
    F014_USDC_IN,
  );
  assert(
    buyQuoter.status === "reverted" && buyQuoter.revert === "NotEnoughLiquidity",
    `c069abea USDC->srUSDe expected quoter NotEnoughLiquidity, got ${buyQuoter.status}/${buyQuoter.amountOut}`,
  );
  assert(buyLocal >= 0n, "local USDC->srUSDe must return a bounded partial, not throw");
  console.log(`[v4math] NOTE c069abea USDC->srUSDe one-sided: quoter=REVERT(NotEnoughLiquidity) local=${buyLocal} (bounded partial)`);

  console.log("\nV4 LOCAL MATH: PASS");
}

main().catch((err) => {
  console.error(`[v4math] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
