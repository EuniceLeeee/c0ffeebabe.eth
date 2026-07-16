import { ethers } from "ethers";
import type { PoolImpact } from "../detector/pool-impact.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { knownTokenStorageLayout } from "../solver/balance-slots.js";

/**
 * Victim-state overlay for the revm backend.
 *
 * The RPC/Anvil path shifts the target pool by impersonating a whale and
 * replaying the victim's swap on the fork (see `impersonateSwap` in main.ts).
 * revm has no fork to mutate, so we express the *same* mutation as a set of
 * sidecar primitives the revm-sim engine applies on top of mainnet state:
 *
 *   tokenDeals → seed the whale with `amountIn * 2` of tokenIn (storage write)
 *   preCalls   → approve(spender) then the actual swap, executed whale → router
 *
 * The output MUST stay byte-for-byte equivalent to `impersonateSwap`, otherwise
 * the revm pool state diverges from Anvil and the equivalence acceptance fails.
 * Whenever `impersonateSwap` changes (router address, swap encoding, deal size),
 * this builder changes in lockstep.
 */

const WHALE = "0x000000000000000000000000000000000000dEaD";
const UNIV3_SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const UNIV2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";

const ERC20_IFACE = new ethers.Interface([
  "function approve(address spender, uint256 amount)",
]);
const CURVE_EXCHANGE_IFACE = new ethers.Interface([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)",
]);
const UNIV2_ROUTER_IFACE = new ethers.Interface([
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
]);
const UNIV3_ROUTER_IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)",
]);

export interface OverlayTokenDeal {
  token: string;
  to: string;
  amount: string;
  balanceSlot?: number;
}

export interface OverlayPreCall {
  from: string;
  to: string;
  calldata: string;
  gasLimit?: number;
  allowanceSlot?: number;
}

export interface VictimOverlay {
  /** Whale account that needs ETH funding for gas (engine funds it). */
  whale: string;
  tokenDeals: OverlayTokenDeal[];
  preCalls: OverlayPreCall[];
}

export function isCurveAdapter(adapterId: string): boolean {
  return adapterId === "curve-exchange" ||
    adapterId === "curve-exchange-nr" ||
    adapterId === "curve-exchange-plain" ||
    adapterId === "curve-exchange-received-uint";
}

/**
 * Whether this impact's adapter is one we can replay as a victim overlay.
 * Mirrors the adapters `impersonateSwap` supports.
 */
export function overlaySupportsAdapter(adapterId: string): boolean {
  return (
    isCurveAdapter(adapterId) ||
    adapterId === "univ2-swap" ||
    adapterId === "univ3-swap"
  );
}

export interface OverlayResolveCtx {
  /** Routing graph — used to recover curve i/j coin indices for the pool. */
  graph: TokenEdge[];
  /** Resolves a UniV3 pool's fee tier (cached by the caller). */
  resolveUniv3Fee: (pool: string) => Promise<number>;
}

/**
 * Build the victim overlay for a pool impact. Async only because UniV3 needs
 * the pool fee tier; curve/univ2 resolve synchronously from the graph + impact.
 */
export async function buildVictimOverlay(
  impact: PoolImpact,
  ctx: OverlayResolveCtx,
): Promise<VictimOverlay> {
  const whale = ethers.getAddress(WHALE);
  const tokenIn = ethers.getAddress(impact.tokenIn);
  const pool = ethers.getAddress(impact.pool);
  const dealAmount = impact.amountIn * 2n;

  const tokenDeals: OverlayTokenDeal[] = [
    {
      token: tokenIn,
      to: whale,
      amount: dealAmount.toString(),
      balanceSlot: knownTokenStorageLayout(tokenIn)?.balanceSlot,
    },
  ];

  let approveTarget: string;
  let swapCall: OverlayPreCall;

  if (isCurveAdapter(impact.matchedAdapterId)) {
    approveTarget = pool;
    const edge = ctx.graph.find(
      (e) =>
        e.target.toLowerCase() === impact.pool.toLowerCase() &&
        e.tokenIn.toLowerCase() === impact.tokenIn.toLowerCase() &&
        e.curveI !== undefined,
    );
    if (!edge || edge.curveI === undefined || edge.curveJ === undefined) {
      throw new Error(`overlay: no curve edge for ${impact.pool}`);
    }
    swapCall = {
      from: whale,
      to: pool,
      calldata: CURVE_EXCHANGE_IFACE.encodeFunctionData("exchange", [
        edge.curveI,
        edge.curveJ,
        impact.amountIn,
        0,
      ]),
      gasLimit: 0x1000000,
    };
  } else if (impact.matchedAdapterId === "univ2-swap") {
    approveTarget = UNIV2_ROUTER;
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    swapCall = {
      from: whale,
      to: UNIV2_ROUTER,
      calldata: UNIV2_ROUTER_IFACE.encodeFunctionData("swapExactTokensForTokens", [
        impact.amountIn,
        0,
        [tokenIn, ethers.getAddress(impact.tokenOut)],
        whale,
        deadline,
      ]),
      gasLimit: 0x1000000,
    };
  } else if (impact.matchedAdapterId === "univ3-swap") {
    approveTarget = UNIV3_SWAP_ROUTER;
    const fee = await ctx.resolveUniv3Fee(pool);
    swapCall = {
      from: whale,
      to: UNIV3_SWAP_ROUTER,
      calldata: UNIV3_ROUTER_IFACE.encodeFunctionData("exactInputSingle", [
        {
          tokenIn,
          tokenOut: ethers.getAddress(impact.tokenOut),
          fee,
          recipient: whale,
          amountIn: impact.amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ]),
      gasLimit: 0x1000000,
    };
  } else {
    throw new Error(`overlay: unsupported adapter ${impact.matchedAdapterId}`);
  }

  const approveCall: OverlayPreCall = {
    from: whale,
    to: tokenIn,
    calldata: ERC20_IFACE.encodeFunctionData("approve", [approveTarget, dealAmount]),
    gasLimit: 0x1000000,
    allowanceSlot: knownTokenStorageLayout(tokenIn)?.allowanceSlot,
  };

  return { whale, tokenDeals, preCalls: [approveCall, swapCall] };
}
