/**
 * Plan Builder — generic ResolvedPlanNode tree from a TokenPath + amounts.
 *
 * Walks planner-produced path edges and constructs the appropriate adapter
 * nodes, auto-nesting wrapper callbacks
 * (UniV3 swap, UniV4 unlock, UniV2 swap), auto-synthesizing approve/transfer
 * before lending/swaps, and inserting the assert-balance guard before flash repay.
 */

import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { TokenEdge, TokenPath } from "../planner/token-graph.js";
import { resolveCurveIndices } from "./quoter.js";

const MAX_UINT = (1n << 256n) - 1n;
const MIN_SQRT_PRICE = 4295128740n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970341n;

const poolFeeIface = new ethers.Interface([
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

/**
 * Build a complete ResolvedPlanNode wrapped in the flash adapter.
 *
 * @param path           DFS-enumerated TokenPath (start = end = flashToken)
 * @param flashToken     Flash loan asset (must equal path.edges[0].tokenIn and last edge tokenOut)
 * @param flashAmount    Flash loan amount (concrete bigint)
 * @param amounts        Propagated amounts (length = edges + 1); amounts[i] flows into edge i
 * @param executor       BotVM executor address (receiver for receiver rewrites)
 * @param state          StateBackend for protocol metadata lookups (curve coins, V3 fee, etc.)
 * @param minProfit      Minimum profit required (added to flashAmount in assert-balance guard)
 */
export async function buildResolvedPlanFromPath(
  path: TokenPath,
  flashToken: string,
  flashAmount: bigint,
  amounts: bigint[],
  executor: string,
  state: StateBackend,
  minProfit: bigint = 1n,
  flashAdapterId: string = "morpho-flash",
): Promise<ResolvedPlanNode> {
  if (amounts.length !== path.edges.length + 1) {
    throw new Error(
      `amounts length ${amounts.length} != edges + 1 (${path.edges.length + 1})`,
    );
  }

  const inner: ResolvedPlanNode[] = [];
  const approvedSpenders = new Set<string>(); // key = "token@spender" lowercased

  function ensureApprove(token: string, spender: string): void {
    const key = `${token.toLowerCase()}@${spender.toLowerCase()}`;
    if (approvedSpenders.has(key)) return;
    approvedSpenders.add(key);
    inner.push({
      adapterId: "erc20-approve",
      target: token,
      tokenIn: token,
      tokenOut: token,
      amount: MAX_UINT,
      params: { spender, amount: MAX_UINT },
      children: [],
    });
  }

  function transferToPool(token: string, pool: string, amount: bigint): void {
    inner.push({
      adapterId: "erc20-transfer",
      target: token,
      tokenIn: token,
      tokenOut: token,
      amount,
      params: { to: pool, amount },
      children: [],
    });
  }

  for (let i = 0; i < path.edges.length; i++) {
    const edge = path.edges[i];
    const amtIn = amounts[i];
    const amtOut = amounts[i + 1];

    const node = await buildEdgeNode(
      edge,
      amtIn,
      amtOut,
      executor,
      state,
      ensureApprove,
      transferToPool,
    );
    if (node) inner.push(node);
  }

  // Guard before repay: balance(flashToken) >= flashAmount + minProfit
  inner.push({
    adapterId: "assert-balance",
    target: flashToken,
    tokenIn: flashToken,
    tokenOut: flashToken,
    amount: flashAmount + minProfit,
    params: {},
    children: [],
  });

  // Approve flash source for repay
  const flashTarget = FLASH_ADAPTER_TARGETS[flashAdapterId];
  if (!flashTarget) throw new Error(`plan-builder: unknown flash adapter ${flashAdapterId}`);
  ensureApprove(flashToken, flashTarget);

  // Wrap entire sequence in flash loan
  const flashParams: Record<string, string[] | bigint[]> =
    flashAdapterId === "balancer-flash"
      ? { tokens: [flashToken], amounts: [flashAmount] }
      : {};

  return {
    adapterId: flashAdapterId,
    target: flashTarget,
    tokenIn: flashToken,
    tokenOut: flashToken,
    amount: flashAmount,
    params: flashParams,
    children: inner,
  };
}

const FLASH_ADAPTER_TARGETS: Record<string, string> = {
  "morpho-flash": ADDR.MORPHO,
  "balancer-flash": ADDR.BALANCER_VAULT,
};

// ─── Per-adapter node builders ─────────────────────────────────

async function buildEdgeNode(
  edge: TokenEdge,
  amtIn: bigint,
  amtOut: bigint,
  executor: string,
  state: StateBackend,
  ensureApprove: (token: string, spender: string) => void,
  transferToPool: (token: string, pool: string, amount: bigint) => void,
): Promise<ResolvedPlanNode | null> {
  switch (edge.adapterId) {
    case "fluid-vault":
      ensureApprove(edge.tokenIn, edge.target);
      return {
        adapterId: "fluid-vault",
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amount: amtIn,
        params: {
          nftId: 0n,
          collateralDelta: amtIn,
          debtDelta: amtOut,
        },
        children: [],
      };

    case "psm":
      // sellGem(usr, gemAmt) — requires approval of input token to the PSM
      ensureApprove(edge.tokenIn, edge.target);
      return {
        adapterId: "psm",
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amount: amtIn,
        params: {},
        children: [],
      };

    case "curve-exchange":
    case "curve-exchange-received-uint":
    case "curve-exchange-nr":
    case "curve-exchange-plain": {
      // Always use plain exchange (transferFrom mode) — avoids the
      // "transfer pre-estimated amount to pool" problem of _received variants
      // which is fragile when quoter is off by even one wei.
      // Plain exchange uses transferFrom so BotVM doesn't need to know the
      // exact actual amount mid-execution.
      ensureApprove(edge.tokenIn, edge.target);
      const [i, j] = await resolveCurveIndices(state, edge.target, edge.tokenIn, edge.tokenOut);
      return {
        adapterId: "curve-exchange-plain",
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amount: amtIn,
        params: { i: BigInt(i), j: BigInt(j), minDy: 0n },
        children: [],
      };
    }

    case "univ3-swap": {
      // Wrapper: callback is BotVM transferring tokenIn (the inbound) to pool.
      // exactInput mode: amountSpecified > 0
      const [token0, token1] = await uniV3PoolTokens(state, edge.target);
      const zeroForOne = edge.tokenIn.toLowerCase() === token0.toLowerCase();
      const sqrtLimit = zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE;
      const callbackChildren: ResolvedPlanNode[] = [
        // Inside V3 callback: transfer the exact amountIn to the pool
        {
          adapterId: "erc20-transfer",
          target: edge.tokenIn,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenIn,
          amount: amtIn,
          params: { to: edge.target, amount: amtIn },
          children: [],
        },
      ];
      return {
        adapterId: "univ3-swap",
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amount: amtIn,
        params: {
          zeroForOne,
          amountSpecified: amtIn, // exactInput (positive)
          sqrtPriceLimit: sqrtLimit,
        },
        children: callbackChildren,
      };
    }

    case "univ4-unlock": {
      // V4 unlock wrapper. Inside callback: swap → take output → sync input → transfer input → settle.
      // We need pool key (fee + tickSpacing). For stablecoin pairs in our path
      // we use known DAI/USDT 0.0068% pool config.
      const { fee, tickSpacing } = uniV4PoolKey(edge.tokenIn, edge.tokenOut);
      const [c0, c1] = sortedPair(edge.tokenIn, edge.tokenOut);
      const zeroForOne = edge.tokenIn.toLowerCase() === c0.toLowerCase();

      const unlockChildren: ResolvedPlanNode[] = [
        // swap: exactInput (amountSpecified negative in V4 convention)
        {
          adapterId: "univ4-swap",
          target: edge.target,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenOut,
          amount: amtIn,
          params: {
            currency0: c0,
            currency1: c1,
            fee,
            tickSpacing,
            hooks: ADDR.ZERO,
            zeroForOne,
            amountSpecified: -amtIn, // V4 exactIn = negative
            sqrtPriceLimit: zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE,
          },
          children: [],
        },
        // take output to executor
        {
          adapterId: "univ4-take",
          target: edge.target,
          tokenIn: "",
          tokenOut: edge.tokenOut,
          amount: amtOut,
          params: { currency: edge.tokenOut },
          children: [],
        },
        // sync input
        {
          adapterId: "univ4-sync",
          target: edge.target,
          tokenIn: edge.tokenIn,
          tokenOut: "",
          amount: 0n,
          params: { currency: edge.tokenIn },
          children: [],
        },
        // transfer input to PM
        {
          adapterId: "erc20-transfer",
          target: edge.tokenIn,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenIn,
          amount: amtIn,
          params: { to: edge.target, amount: amtIn },
          children: [],
        },
        // settle
        {
          adapterId: "univ4-settle",
          target: edge.target,
          tokenIn: "",
          tokenOut: "",
          amount: 0n,
          params: {},
          children: [],
        },
      ];
      return {
        adapterId: "univ4-unlock",
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amount: 0n,
        params: {},
        children: unlockChildren,
      };
    }

    case "univ2-swap": {
      // UniV2: transfer tokenIn to pair, then call swap(amount0Out, amount1Out, to, data).
      // Callback children handle the transfer.
      const [t0, t1] = sortedPair(edge.tokenIn, edge.tokenOut);
      const zeroForOne = edge.tokenIn.toLowerCase() === t0.toLowerCase();
      const callbackChildren: ResolvedPlanNode[] = [
        {
          adapterId: "erc20-transfer",
          target: edge.tokenIn,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenIn,
          amount: amtIn,
          params: { to: edge.target, amount: amtIn },
          children: [],
        },
      ];
      return {
        adapterId: "univ2-swap",
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amount: amtIn,
        params: {
          amount0Out: zeroForOne ? 0n : amtOut,
          amount1Out: zeroForOne ? amtOut : 0n,
          to: executor,
        },
        children: callbackChildren,
      };
    }

    default:
      throw new Error(`plan-builder: no handler for adapter ${edge.adapterId}`);
  }
}

// ─── Protocol metadata helpers ─────────────────────────────────

const univ3PoolCache = new Map<string, [string, string]>();

async function uniV3PoolTokens(
  state: StateBackend,
  pool: string,
): Promise<[string, string]> {
  const key = pool.toLowerCase();
  const cached = univ3PoolCache.get(key);
  if (cached) return cached;
  const t0Result = await state.call({
    to: pool,
    data: poolFeeIface.encodeFunctionData("token0"),
  });
  const t1Result = await state.call({
    to: pool,
    data: poolFeeIface.encodeFunctionData("token1"),
  });
  const t0 = ethers.getAddress("0x" + t0Result.slice(-40));
  const t1 = ethers.getAddress("0x" + t1Result.slice(-40));
  univ3PoolCache.set(key, [t0, t1]);
  return [t0, t1];
}

function sortedPair(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/**
 * Hardcoded UniV4 pool keys for known stablecoin pairs in our token graph.
 * (V4 doesn't have a registry; fee/tickSpacing is part of the pool identity.)
 */
function uniV4PoolKey(
  tokenIn: string,
  tokenOut: string,
): { fee: bigint; tickSpacing: bigint } {
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  const dai = ADDR.DAI.toLowerCase();
  const usdt = ADDR.USDT.toLowerCase();
  const usdc = ADDR.USDC.toLowerCase();
  // DAI/USDT pool with 0.0068% fee, tickSpacing 1
  if ((a === dai && b === usdt) || (a === usdt && b === dai)) {
    return { fee: 68n, tickSpacing: 1n };
  }
  // USDC/USDT pool with 0.01% fee, tickSpacing 1
  if ((a === usdc && b === usdt) || (a === usdt && b === usdc)) {
    return { fee: 100n, tickSpacing: 1n };
  }
  throw new Error(
    `UniV4 pool key not configured for ${tokenIn} <-> ${tokenOut}`,
  );
}
