/**
 * Plan Builder — generic ResolvedPlanNode tree from a TokenPath + amounts.
 *
 * Walks planner-produced path edges and constructs the appropriate adapter
 * nodes, auto-nesting wrapper callbacks
 * (UniV3 swap, UniV4 unlock, UniV2 swap), auto-synthesizing approve/transfer
 * before lending/swaps, and inserting the assert-balance guard before flash repay.
 */

import { ethers } from "ethers";
import { PROTOCOL_LEG_DESCRIPTORS } from "../../adapters/protocol-legs.js";
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
 * @param rawOutputs     Optional raw pre-haircut quote outputs; only v4 physical
 *                       take/deposit consumes these, while amounts stay spendable.
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
  rawOutputs?: bigint[],
): Promise<ResolvedPlanNode> {
  if (amounts.length !== path.edges.length + 1) {
    throw new Error(
      `amounts length ${amounts.length} != edges + 1 (${path.edges.length + 1})`,
    );
  }
  if (rawOutputs !== undefined && rawOutputs.length !== path.edges.length) {
    throw new Error(
      `rawOutputs length ${rawOutputs.length} != edges (${path.edges.length})`,
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
    const rawOut = rawOutputs?.[i];

    const node = await buildEdgeNode(
      edge,
      amtIn,
      amtOut,
      rawOut,
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
  rawOut: bigint | undefined,
  executor: string,
  state: StateBackend,
  ensureApprove: (token: string, spender: string) => void,
  transferToPool: (token: string, pool: string, amount: bigint) => void,
): Promise<ResolvedPlanNode | null> {
  const protocolLeg = PROTOCOL_LEG_DESCRIPTORS.find((desc) => desc.id === edge.adapterId);
  if (protocolLeg) {
    if (protocolLeg.needsApprove) ensureApprove(edge.tokenIn, edge.target);
    return {
      adapterId: edge.adapterId,
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: amtIn,
      params: {},
      children: [],
    };
  }

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
      // sellGem/buyGem gemAmt is always the USDC-side amount.
      ensureApprove(edge.tokenIn, edge.target);
      const gemAmount = edge.tokenIn.toLowerCase() === ADDR.USDC.toLowerCase() ? amtIn : amtOut;
      return {
        adapterId: "psm",
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amount: gemAmount,
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

    case "fluid-dex-swap": {
      ensureApprove(edge.tokenIn, edge.target);
      if (!edge.poolToken0 || !edge.poolToken1) {
        throw new Error(`fluid-dex edge missing poolToken0/poolToken1: ${edge.tokenIn} -> ${edge.tokenOut}`);
      }
      const inLower = edge.tokenIn.toLowerCase();
      const outLower = edge.tokenOut.toLowerCase();
      const t0 = edge.poolToken0.toLowerCase();
      const t1 = edge.poolToken1.toLowerCase();
      const swap0to1 =
        inLower === t0 && outLower === t1
          ? true
          : inLower === t1 && outLower === t0
            ? false
            : null;
      if (swap0to1 === null) {
        throw new Error(
          `fluid-dex tokens ${edge.tokenIn} -> ${edge.tokenOut} do not match pool ` +
            `${edge.poolToken0} / ${edge.poolToken1}`,
        );
      }
      return {
        adapterId: "fluid-dex-swap",
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amount: amtIn,
        params: { swap0to1, amountOutMin: 0n },
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
      // V4 unlock wrapper. Inside callback: swap, take output, then resolve
      // input debt through either ERC20 transfer+settle or native settle{value}.
      // The PoolKey MUST come from the edge (the exact pool the quote used) — never a
      // hardcoded fee, because pinned v4 pools have different fee tiers (e.g. 7 vs 8);
      // quoting one pool and executing another reverts.
      const key = edge.v4PoolKey;
      if (!key) {
        throw new Error(`univ4-unlock edge missing v4PoolKey: ${edge.tokenIn} -> ${edge.tokenOut}`);
      }
      const normalizedKey = normalizeV4PoolKey(key);
      rejectNativeWethV4Pool(normalizedKey, "plan-builder");
      const c0 = normalizedKey.currency0;
      const c1 = normalizedKey.currency1;
      const hooks = normalizedKey.hooks;
      // params encode as bigint (ResolvedParam); V4PoolKey stores fee/tickSpacing as number.
      const fee = BigInt(normalizedKey.fee);
      const tickSpacing = BigInt(normalizedKey.tickSpacing);
      const realIn = realV4Currency(edge.tokenIn, normalizedKey, "tokenIn");
      const realOut = realV4Currency(edge.tokenOut, normalizedKey, "tokenOut");
      validateV4CurrencyPair(realIn, realOut, normalizedKey, "plan-builder");
      const zeroForOne = realIn.toLowerCase() === c0.toLowerCase();
      const inputIsNative = realIn.toLowerCase() === ethers.ZeroAddress.toLowerCase();
      const outputIsNative = realOut.toLowerCase() === ethers.ZeroAddress.toLowerCase();
      const takeAmount = rawOut ?? amtOut;

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
            hooks,
            zeroForOne,
            amountSpecified: -amtIn, // V4 exactIn = negative
            sqrtPriceLimit: zeroForOne ? MIN_SQRT_PRICE : MAX_SQRT_PRICE,
          },
          children: [],
        },
        // take output to executor; native pools must take the real 0x0 currency.
        {
          adapterId: "univ4-take",
          target: edge.target,
          tokenIn: "",
          tokenOut: edge.tokenOut,
          amount: takeAmount,
          params: { currency: realOut },
          children: [],
        },
      ];

      if (outputIsNative) {
        unlockChildren.push({
          adapterId: "weth-deposit-value",
          target: ADDR.WETH,
          tokenIn: realOut,
          tokenOut: ADDR.WETH,
          amount: takeAmount,
          params: {},
          children: [],
        });
      }

      if (inputIsNative) {
        unlockChildren.push(
          {
            adapterId: "weth-withdraw-amount",
            target: ADDR.WETH,
            tokenIn: ADDR.WETH,
            tokenOut: realIn,
            amount: amtIn,
            params: {},
            children: [],
          },
          {
            adapterId: "univ4-sync",
            target: edge.target,
            tokenIn: realIn,
            tokenOut: "",
            amount: 0n,
            params: { currency: ethers.ZeroAddress },
            children: [],
          },
          {
            adapterId: "univ4-settle-value",
            target: edge.target,
            tokenIn: "",
            tokenOut: "",
            amount: amtIn,
            params: {},
            children: [],
          },
        );
      } else {
        unlockChildren.push(
          // sync input
          {
            adapterId: "univ4-sync",
            target: edge.target,
            tokenIn: realIn,
            tokenOut: "",
            amount: 0n,
            params: { currency: realIn },
            children: [],
          },
          // transfer input to PM
          {
            adapterId: "erc20-transfer",
            target: realIn,
            tokenIn: realIn,
            tokenOut: realIn,
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
        );
      }
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

function normalizeV4PoolKey(poolKey: NonNullable<TokenEdge["v4PoolKey"]>): NonNullable<TokenEdge["v4PoolKey"]> {
  return {
    currency0: normalizeV4Currency(poolKey.currency0, "currency0"),
    currency1: normalizeV4Currency(poolKey.currency1, "currency1"),
    fee: poolKey.fee,
    tickSpacing: poolKey.tickSpacing,
    hooks: normalizeV4Currency(poolKey.hooks, "hooks"),
  };
}

function normalizeV4Currency(value: string, field: string): string {
  if (value.toLowerCase() === "0x0") return ethers.ZeroAddress;
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`plan-builder: v4 ${field} must be an address or 0x0, got ${value}`);
  }
}

function realV4Currency(
  token: string,
  key: NonNullable<TokenEdge["v4PoolKey"]>,
  field: string,
): string {
  const c0 = key.currency0;
  const c1 = key.currency1;
  const t = token.toLowerCase();
  if (t === c0.toLowerCase()) return c0;
  if (t === c1.toLowerCase()) return c1;

  const c0Native = c0.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  const c1Native = c1.toLowerCase() === ethers.ZeroAddress.toLowerCase();
  if (c0Native !== c1Native && t === ADDR.WETH.toLowerCase()) {
    return c0Native ? c0 : c1;
  }

  throw new Error(
    `plan-builder: v4 ${field} ${token} does not match PoolKey ${c0} / ${c1}`,
  );
}

function validateV4CurrencyPair(
  realIn: string,
  realOut: string,
  key: NonNullable<TokenEdge["v4PoolKey"]>,
  context: string,
): void {
  const resolved = [realIn.toLowerCase(), realOut.toLowerCase()].sort().join("/");
  const poolPair = [key.currency0.toLowerCase(), key.currency1.toLowerCase()].sort().join("/");
  if (resolved !== poolPair) {
    throw new Error(
      `${context}: resolved pair ${realIn} / ${realOut} does not match PoolKey ` +
        `${key.currency0} / ${key.currency1}`,
    );
  }
}

function rejectNativeWethV4Pool(
  key: NonNullable<TokenEdge["v4PoolKey"]>,
  context: string,
): void {
  const c0 = key.currency0.toLowerCase();
  const c1 = key.currency1.toLowerCase();
  const weth = ADDR.WETH.toLowerCase();
  const zero = ethers.ZeroAddress.toLowerCase();
  if ((c0 === zero && c1 === weth) || (c1 === zero && c0 === weth)) {
    throw new Error(`${context}: native/WETH v4 pool not supported (ambiguous alias)`);
  }
}
