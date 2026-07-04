/**
 * Fork-only native Uniswap v4 execution replay.
 *
 * Runs against a local Anvil fork whose upstream should be local reth:
 *   SEARCHER_LIVE_RPC_URL=http://127.0.0.1:8545 SEARCHER_FORK_BLOCK=<recent> \
 *     node --import tsx src/searcher/test/replay-v4-native-arb.ts
 *
 * This does not use a flash loan or broadcast. It pre-funds the BotVM executor
 * on the fork, executes one native v4 leg in each direction, and compares the
 * balance delta against V4Quoter.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import "../../shared/adapters/index.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import {
  DEFAULT_SEARCHER_EXECUTOR,
  DEFAULT_SEARCHER_OWNER,
  installForkBotVm,
} from "../../shared/executor/botvm-executor.js";
import { BotVMSimulator } from "../simulator/botvm-simulator.js";
import { buildResolvedPlanFromPath } from "../solver/plan-builder.js";
import { quote } from "../solver/quoter.js";
import { v4PoolId, type TokenEdge, type TokenPath, type V4PoolKey } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { ResolvedPlanNode } from "../../shared/types/plan.js";

const NATIVE_ETH_USDC_POOL_KEY: V4PoolKey = {
  currency0: ethers.ZeroAddress,
  currency1: ADDR.USDC,
  fee: 100,
  tickSpacing: 1,
  hooks: ethers.ZeroAddress,
};
const EXPECTED_NATIVE_ETH_USDC_POOL_ID =
  "0x00b9edc1583bf6ef09ff3a09f6c23ecb57fd7d0bb75625717ec81eed181e22d7";

const WETH_TO_USDC_AMOUNT_IN = 10n ** 16n; // 0.01 WETH
const USDC_TO_WETH_AMOUNT_IN = 25n * 10n ** 6n; // 25 USDC
const OUTPUT_TOLERANCE_BPS = 5n;
const DEFAULT_BLOCK_CONFIRMATIONS = 5;
const ANVIL_PORT = Number(process.env.SEARCHER_NATIVE_V4_ANVIL_PORT ?? "8564");
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const FORK_ETH_BALANCE = "0x56bc75e2d63100000"; // 100 ETH
const COMMON_ERC20_BALANCE_SLOTS = [0, 1, 2, 3, 4, 5, 9, 51];

function loadEnv(): void {
  let text = "";
  try {
    text = readFileSync(resolve("..", ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  loadEnv();
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL || process.env.MAINNET_RPC_URL;
  if (!rpcUrl) {
    throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required; prefer local reth at http://127.0.0.1:8545");
  }

  assertPoolIdStable();

  const upstream = new ethers.JsonRpcProvider(rpcUrl);
  const block = await resolveForkBlock(upstream);
  const state = new AnvilStateBackend(rpcUrl, ANVIL_URL, ANVIL_PORT);
  await state.start();

  try {
    console.log(`[v4-native-arb] fork upstream=${redactRpcUrl(rpcUrl)} block=${block} anvil=${ANVIL_URL}`);
    await state.forkAt(block);

    const wethToUsdcQuote = await quoteNativeV4OrThrow(
      state,
      "WETH(native)->USDC",
      ADDR.WETH,
      ADDR.USDC,
      WETH_TO_USDC_AMOUNT_IN,
      block,
    );
    const usdcToWethQuote = await quoteNativeV4OrThrow(
      state,
      "USDC->WETH(native)",
      ADDR.USDC,
      ADDR.WETH,
      USDC_TO_WETH_AMOUNT_IN,
      block,
    );

    await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);
    await state.provider.send("anvil_setBalance", [DEFAULT_SEARCHER_EXECUTOR, FORK_ETH_BALANCE]);

    await dealToken(state, ADDR.WETH, DEFAULT_SEARCHER_EXECUTOR, WETH_TO_USDC_AMOUNT_IN * 2n);
    await dealToken(state, ADDR.USDC, DEFAULT_SEARCHER_EXECUTOR, USDC_TO_WETH_AMOUNT_IN * 2n);

    const simulator = new BotVMSimulator(state, DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER);
    await runSingleLeg({
      state,
      simulator,
      label: "native input WETH->USDC",
      tokenIn: ADDR.WETH,
      tokenOut: ADDR.USDC,
      amountIn: WETH_TO_USDC_AMOUNT_IN,
      expectedOut: wethToUsdcQuote,
      profitToken: ADDR.USDC,
      proof: "withdraw -> sync(0x0) -> settle{value}",
    });
    await runSingleLeg({
      state,
      simulator,
      label: "native output USDC->WETH",
      tokenIn: ADDR.USDC,
      tokenOut: ADDR.WETH,
      amountIn: USDC_TO_WETH_AMOUNT_IN,
      expectedOut: usdcToWethQuote,
      profitToken: ADDR.WETH,
      proof: "take(0x0) -> deposit{value}",
    });

    console.log("v4-native-arb PASS");
  } finally {
    state.stop();
    upstream.destroy();
  }
}

async function resolveForkBlock(provider: ethers.JsonRpcProvider): Promise<number> {
  const raw = process.env.SEARCHER_FORK_BLOCK;
  if (raw) {
    const block = Number(raw);
    if (!Number.isInteger(block) || block <= 0) {
      throw new Error(`SEARCHER_FORK_BLOCK must be a positive integer, got ${raw}`);
    }
    return block;
  }

  const latest = await provider.getBlockNumber();
  const block = latest - DEFAULT_BLOCK_CONFIRMATIONS;
  if (block <= 0) throw new Error(`upstream latest block ${latest} is not usable`);
  console.log(
    `[v4-native-arb] SEARCHER_FORK_BLOCK unset; using latest-${DEFAULT_BLOCK_CONFIRMATIONS}=${block}`,
  );
  return block;
}

function assertPoolIdStable(): void {
  const poolId = v4PoolId(NATIVE_ETH_USDC_POOL_KEY);
  if (poolId !== EXPECTED_NATIVE_ETH_USDC_POOL_ID) {
    throw new Error(
      `native ETH/USDC PoolKey constants changed: v4PoolId=${poolId}, ` +
        `expected ${EXPECTED_NATIVE_ETH_USDC_POOL_ID}. Check fee/tickSpacing/hooks constants at top of this file.`,
    );
  }
}

async function quoteNativeV4OrThrow(
  state: AnvilStateBackend,
  label: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  block: number,
): Promise<bigint> {
  try {
    const amountOut = await quote(
      "univ4-unlock",
      ADDR.UNISWAP_V4_POOL_MANAGER,
      tokenIn,
      tokenOut,
      amountIn,
      state,
      undefined,
      NATIVE_ETH_USDC_POOL_KEY,
    );
    if (amountOut <= 0n) {
      throw new Error(`amountOut=${amountOut}`);
    }
    console.log(`[v4-native-arb] quote ${label}: amountIn=${amountIn} amountOut=${amountOut}`);
    return amountOut;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `V4Quoter failed for ${label} at block ${block}. ` +
        `PoolKey currency0=${NATIVE_ETH_USDC_POOL_KEY.currency0}, currency1=${NATIVE_ETH_USDC_POOL_KEY.currency1}, ` +
        `fee=${NATIVE_ETH_USDC_POOL_KEY.fee}, tickSpacing=${NATIVE_ETH_USDC_POOL_KEY.tickSpacing}, ` +
        `hooks=${NATIVE_ETH_USDC_POOL_KEY.hooks}. If this pool was moved or retuned, update the constants at the top. ` +
        `Cause: ${msg}`,
    );
  }
}

async function runSingleLeg(params: {
  state: AnvilStateBackend;
  simulator: BotVMSimulator;
  label: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  expectedOut: bigint;
  profitToken: string;
  proof: string;
}): Promise<void> {
  const root = await buildNativeUnlockLeg(
    params.state,
    params.tokenIn,
    params.tokenOut,
    params.amountIn,
    params.expectedOut,
  );
  const plan: ResolvedPlan = {
    root,
    netProfit: params.expectedOut,
    profitToken: params.profitToken,
    flashAmount: 0n,
    templateName: "v4-native-single-leg",
  };
  const sim = await params.simulator.simulate(plan);
  if (!sim.success) {
    throw new Error(
      `${params.label} execution failed; expected to prove ${params.proof}. ` +
        `revert=${sim.revertReason ?? "unknown"}`,
    );
  }
  assertApprox(
    sim.grossProfit,
    params.expectedOut,
    OUTPUT_TOLERANCE_BPS,
    `${params.label} balance delta`,
  );
  console.log(
    `[v4-native-arb] ${params.label}: delta=${sim.grossProfit} expected=${params.expectedOut} (${params.proof})`,
  );
}

async function buildNativeUnlockLeg(
  state: AnvilStateBackend,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOut: bigint,
): Promise<ResolvedPlanNode> {
  const edge = nativeV4Edge(tokenIn, tokenOut);
  const path: TokenPath = { edges: [edge] };
  const plan = await buildResolvedPlanFromPath(
    path,
    tokenIn,
    amountIn,
    [amountIn, amountOut],
    DEFAULT_SEARCHER_EXECUTOR,
    state,
    0n,
  );
  const leg = plan.children.find((node) => node.adapterId === "univ4-unlock");
  if (!leg) throw new Error(`buildResolvedPlanFromPath did not emit univ4-unlock for ${tokenIn}->${tokenOut}`);
  return leg;
}

function nativeV4Edge(tokenIn: string, tokenOut: string): TokenEdge {
  return {
    adapterId: "univ4-unlock",
    target: ADDR.UNISWAP_V4_POOL_MANAGER,
    tokenIn,
    tokenOut,
    slotKind: "swap",
    ...deriveEdgeTaxonomy("swap"),
    v4PoolKey: NATIVE_ETH_USDC_POOL_KEY,
    poolId: EXPECTED_NATIVE_ETH_USDC_POOL_ID,
    nativeCurrency0: true,
    nativeCurrency1: false,
    score: 100,
  };
}

async function dealToken(
  state: AnvilStateBackend,
  token: string,
  to: string,
  amount: bigint,
): Promise<void> {
  const tokenAddr = ethers.getAddress(token);
  const toAddr = ethers.getAddress(to);
  if (await tokenBalanceAtLeast(state, tokenAddr, toAddr, amount)) return;

  for (const slotIndex of COMMON_ERC20_BALANCE_SLOTS) {
    const snap = await state.snapshot();
    const slot = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [toAddr, slotIndex]),
    );
    const value = ethers.zeroPadValue(ethers.toBeHex(amount), 32);
    await state.provider.send("anvil_setStorageAt", [tokenAddr, slot, value]);
    if (await tokenBalanceAtLeast(state, tokenAddr, toAddr, amount)) {
      console.log(`[v4-native-arb] funded ${tokenAddr} balance via storage slot ${slotIndex}`);
      return;
    }
    await state.revert(snap);
  }

  throw new Error(
    `could not pre-fund ${tokenAddr} balance for ${toAddr}. ` +
      `Tried slots [${COMMON_ERC20_BALANCE_SLOTS.join(", ")}]; add the token's balance slot to this test.`,
  );
}

async function tokenBalanceAtLeast(
  state: AnvilStateBackend,
  token: string,
  account: string,
  amount: bigint,
): Promise<boolean> {
  try {
    return await state.getTokenBalance(token, account) >= amount;
  } catch {
    return false;
  }
}

function assertApprox(actual: bigint, expected: bigint, toleranceBps: bigint, label: string): void {
  const diff = actual > expected ? actual - expected : expected - actual;
  const tolerance = expected * toleranceBps / 10_000n + 1n;
  if (diff > tolerance) {
    throw new Error(
      `${label}: got ${actual}, expected ${expected}, diff ${diff} exceeds ${toleranceBps} bps tolerance (${tolerance})`,
    );
  }
}

function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = parsed.username ? "<redacted>" : "";
    parsed.password = parsed.password ? "<redacted>" : "";
    if (parsed.search) parsed.search = "?<redacted>";
    return parsed.toString();
  } catch {
    return url.startsWith("http") ? "<rpc-url>" : url;
  }
}

main().catch((err) => {
  console.error(`v4-native-arb FAIL: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
