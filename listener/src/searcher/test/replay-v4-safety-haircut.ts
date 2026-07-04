/**
 * Fork-only Uniswap v4 quote-safety haircut replay.
 *
 * Human gate against local reth (zero CU upstream):
 *   SEARCHER_LIVE_RPC_URL=http://127.0.0.1:8545 SEARCHER_FORK_BLOCK=<recent> \
 *     node --import tsx src/searcher/test/replay-v4-safety-haircut.ts
 *
 * This does not broadcast. It starts a local Anvil fork from the supplied RPC,
 * installs BotVM, pre-funds the executor, and exercises:
 *   propagateAmountsWithRawOutputs(quoteSafetyBps=9999)
 *     -> buildResolvedPlanFromPath
 *     -> BotVMSimulator
 *
 * Baseline deliberately omits rawOutputs, proving the haircutted v4 take
 * reverts in PoolManager.unlock. Fixed path passes rawOutputs, proving take()
 * and native-output WETH deposit use the exact raw v4 quote output.
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
import { BotVMSimulator, type SimulationResult } from "../simulator/botvm-simulator.js";
import { propagateAmountsWithRawOutputs } from "../solver/amount-propagation.js";
import { buildResolvedPlanFromPath } from "../solver/plan-builder.js";
import type { ResolvedPlan } from "../solver/solver.js";
import { v4PoolId, type TokenEdge, type TokenPath, type V4PoolKey } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { ResolvedPlanNode } from "../../shared/types/plan.js";

const PINNED_NATIVE_ETH_USDC_POOL_KEY: V4PoolKey = {
  currency0: ethers.ZeroAddress,
  currency1: ADDR.USDC,
  fee: 100,
  tickSpacing: 1,
  hooks: ethers.ZeroAddress,
};
const PINNED_NATIVE_ETH_USDC_POOL_ID =
  "0x00b9edc1583bf6ef09ff3a09f6c23ecb57fd7d0bb75625717ec81eed181e22d7";
const INPUT_TOKEN = ADDR.USDC;
const OUTPUT_TOKEN = ADDR.WETH; // PoolKey output is native ETH; plan wraps to WETH.
const USDC_TO_NATIVE_WETH_AMOUNT_IN = 25n * 10n ** 6n;
const QUOTE_SAFETY_BPS = 9999n;
const DEFAULT_BLOCK_CONFIRMATIONS = 5;
const ANVIL_PORT = Number(process.env.SEARCHER_V4_SAFETY_ANVIL_PORT ?? "8565");
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
    console.log(
      `[v4-safety-haircut] fork upstream=${redactRpcUrl(rpcUrl)} block=${block} ` +
        `anvil=${ANVIL_URL} pool=${PINNED_NATIVE_ETH_USDC_POOL_ID} ` +
        `amountIn=${USDC_TO_NATIVE_WETH_AMOUNT_IN} safetyBps=${QUOTE_SAFETY_BPS}`,
    );
    await state.forkAt(block);
    await installForkBotVm(state.provider, DEFAULT_SEARCHER_OWNER, DEFAULT_SEARCHER_EXECUTOR);
    await state.provider.send("anvil_setBalance", [DEFAULT_SEARCHER_EXECUTOR, FORK_ETH_BALANCE]);
    await dealToken(state, ADDR.USDC, DEFAULT_SEARCHER_EXECUTOR, USDC_TO_NATIVE_WETH_AMOUNT_IN * 2n);

    const path = v4SafetyPath();
    const propagated = await propagateAmountsWithRawOutputs(
      path,
      USDC_TO_NATIVE_WETH_AMOUNT_IN,
      state,
      { safetyBps: QUOTE_SAFETY_BPS },
    );
    const rawOut = propagated.rawOutputs[0];
    const haircuttedOut = propagated.amounts[1];
    const expectedHaircut = (rawOut * QUOTE_SAFETY_BPS) / 10000n;
    if (rawOut <= 0n) throw new Error(`raw v4 quote output is zero: ${rawOut}`);
    if (haircuttedOut !== expectedHaircut) {
      throw new Error(`haircut mismatch: propagated=${haircuttedOut} expected=${expectedHaircut} raw=${rawOut}`);
    }
    if (haircuttedOut >= rawOut) {
      throw new Error(`test amount too small to prove haircut: raw=${rawOut} haircutted=${haircuttedOut}`);
    }
    console.log(`[v4-safety-haircut] quote rawOut=${rawOut} haircuttedOut=${haircuttedOut}`);

    const simulator = new BotVMSimulator(state, DEFAULT_SEARCHER_EXECUTOR, DEFAULT_SEARCHER_OWNER);
    const baselineRoot = await buildV4CandidateRoot(state, path, propagated.amounts);
    const baselineTake = findRequiredNode(baselineRoot, "univ4-take");
    if (baselineTake.amount !== haircuttedOut) {
      throw new Error(`baseline take amount ${baselineTake.amount} != haircutted output ${haircuttedOut}`);
    }
    const baseline = await simulateCandidate(simulator, baselineRoot, "baseline-haircutted-take");
    if (baseline.success) {
      throw new Error(`baseline haircutted take unexpectedly succeeded; raw=${rawOut} haircutted=${haircuttedOut}`);
    }
    if (!isUnlockRevert(baseline.revertReason)) {
      throw new Error(`baseline reverted, but not at PoolManager.unlock: ${baseline.revertReason ?? "unknown"}`);
    }
    console.log(`[v4-safety-haircut] baseline reverted at unlock as expected: ${baseline.revertReason}`);

    const fixedRoot = await buildV4CandidateRoot(state, path, propagated.amounts, propagated.rawOutputs);
    const fixedTake = findRequiredNode(fixedRoot, "univ4-take");
    const fixedDeposit = findRequiredNode(fixedRoot, "weth-deposit-value");
    if (fixedTake.amount !== rawOut) {
      throw new Error(`fixed take amount ${fixedTake.amount} != raw output ${rawOut}`);
    }
    if (fixedDeposit.amount !== rawOut) {
      throw new Error(`fixed WETH deposit amount ${fixedDeposit.amount} != raw output ${rawOut}`);
    }

    const fixed = await simulateCandidate(simulator, fixedRoot, "fixed-raw-take");
    if (!fixed.success) {
      throw new Error(`fixed raw take simulation failed: ${fixed.revertReason ?? "unknown"}`);
    }
    if (fixed.grossProfit !== rawOut) {
      throw new Error(`fixed WETH delta ${fixed.grossProfit} != raw output ${rawOut}`);
    }
    console.log(`[v4-safety-haircut] fixed succeeded: wethDelta=${fixed.grossProfit} rawOut=${rawOut}`);
    console.log("v4-safety-haircut PASS");
  } finally {
    state.stop();
    upstream.destroy();
  }
}

async function resolveForkBlock(provider: ethers.JsonRpcProvider): Promise<number> {
  const raw = process.env.SEARCHER_V4_SAFETY_BLOCK || process.env.SEARCHER_FORK_BLOCK;
  if (raw) {
    const block = Number(raw);
    if (!Number.isInteger(block) || block <= 0) {
      throw new Error(`SEARCHER_V4_SAFETY_BLOCK/SEARCHER_FORK_BLOCK must be a positive integer, got ${raw}`);
    }
    return block;
  }

  const latest = await provider.getBlockNumber();
  const block = latest - DEFAULT_BLOCK_CONFIRMATIONS;
  if (block <= 0) throw new Error(`upstream latest block ${latest} is not usable`);
  console.log(
    `[v4-safety-haircut] fork block unset; using latest-${DEFAULT_BLOCK_CONFIRMATIONS}=${block}`,
  );
  return block;
}

function assertPoolIdStable(): void {
  const poolId = v4PoolId(PINNED_NATIVE_ETH_USDC_POOL_KEY);
  if (poolId !== PINNED_NATIVE_ETH_USDC_POOL_ID) {
    throw new Error(
      `native ETH/USDC PoolKey constants changed: v4PoolId=${poolId}, ` +
        `expected ${PINNED_NATIVE_ETH_USDC_POOL_ID}`,
    );
  }
}

async function buildV4CandidateRoot(
  state: AnvilStateBackend,
  path: TokenPath,
  amounts: bigint[],
  rawOutputs?: bigint[],
): Promise<ResolvedPlanNode> {
  const plan = await buildResolvedPlanFromPath(
    path,
    INPUT_TOKEN,
    USDC_TO_NATIVE_WETH_AMOUNT_IN,
    amounts,
    DEFAULT_SEARCHER_EXECUTOR,
    state,
    0n,
    "morpho-flash",
    rawOutputs,
  );
  return findRequiredNode(plan, "univ4-unlock");
}

async function simulateCandidate(
  simulator: BotVMSimulator,
  root: ResolvedPlanNode,
  label: string,
): Promise<SimulationResult> {
  const plan: ResolvedPlan = {
    root,
    netProfit: 0n,
    profitToken: OUTPUT_TOKEN,
    flashAmount: 0n,
    templateName: `v4-safety-haircut-${label}`,
  };
  return simulator.simulate(plan);
}

function v4SafetyPath(): TokenPath {
  return {
    edges: [{
      adapterId: "univ4-unlock",
      target: ADDR.UNISWAP_V4_POOL_MANAGER,
      tokenIn: INPUT_TOKEN,
      tokenOut: OUTPUT_TOKEN,
      slotKind: "swap",
      ...deriveEdgeTaxonomy("swap"),
      v4PoolKey: PINNED_NATIVE_ETH_USDC_POOL_KEY,
      poolId: PINNED_NATIVE_ETH_USDC_POOL_ID,
      nativeCurrency0: true,
      nativeCurrency1: false,
      score: 100,
    } as TokenEdge],
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
      console.log(`[v4-safety-haircut] funded ${tokenAddr} balance via storage slot ${slotIndex}`);
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

function findRequiredNode(root: ResolvedPlanNode, adapterId: string): ResolvedPlanNode {
  if (root.adapterId === adapterId) return root;
  for (const child of root.children) {
    const found = findOptionalNode(child, adapterId);
    if (found) return found;
  }
  throw new Error(`plan did not include ${adapterId}`);
}

function findOptionalNode(root: ResolvedPlanNode, adapterId: string): ResolvedPlanNode | null {
  if (root.adapterId === adapterId) return root;
  for (const child of root.children) {
    const found = findOptionalNode(child, adapterId);
    if (found) return found;
  }
  return null;
}

function isUnlockRevert(reason: string | undefined): boolean {
  const text = (reason ?? "").toLowerCase();
  return text.includes("selector=0x48c89491") && text.includes(ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase());
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
  console.error(`v4-safety-haircut FAIL: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
