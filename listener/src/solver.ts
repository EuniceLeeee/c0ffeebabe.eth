/**
 * Plan Solver — Mode A: Historical replay.
 *
 * Extracts literal amounts directly from callTracer calldata.
 * No Anvil simulation needed — all values come from the original tx.
 *
 * Flow:
 *   NormalizedCallNode (with raw calldata) → decode params → ResolvedPlanNode (all bigint)
 *
 * Mode B (optimization, live) is future work — uses Anvil simulation
 * with placeholder → simulate → recompile cycle.
 */

import { ethers } from "ethers";
import type {
  NormalizedCallNode,
  ResolvedPlanNode,
} from "./types.js";

// ─── ABI decoders ──────────────────────────────────────────────

const DECODERS: Record<string, ethers.Interface> = {
  "0xe0232b42": new ethers.Interface(["function flashLoan(address token, uint256 assets, bytes data)"]),
  "0x5c38449e": new ethers.Interface(["function flashLoan(address recipient, address[] tokens, uint256[] amounts, bytes userData)"]),
  "0x032d2276": new ethers.Interface(["function operate(uint256 nftId, int256 newCol, int256 newDebt, address to)"]),
  "0x8433ea22": new ethers.Interface(["function liquidate(uint256 col, uint256 debt, address to, bool absorb)"]),
  "0x128acb08": new ethers.Interface(["function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes data)"]),
  "0x48c89491": new ethers.Interface(["function unlock(bytes data)"]),
  "0x022c0d9f": new ethers.Interface(["function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)"]),
  "0x095ea7b3": new ethers.Interface(["function approve(address spender, uint256 amount)"]),
  "0xa9059cbb": new ethers.Interface(["function transfer(address to, uint256 amount)"]),
  "0x95991276": new ethers.Interface(["function sellGem(address usr, uint256 gemAmt)"]),
  "0xafb43012": new ethers.Interface(["function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)"]),
  "0x767691e7": new ethers.Interface(["function exchange_received(uint256 i, uint256 j, uint256 dx, uint256 min_dy, address receiver)"]),
  "0x7e3db030": new ethers.Interface(["function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy)"]),
  "0x3df02124": new ethers.Interface(["function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)"]),
  "0xcb70e273": new ethers.Interface(["function executePath(bytes path, uint256[] amounts, address receiver)"]),
  "0xde0e9a3e": new ethers.Interface(["function unwrap(uint256 wstETHAmount)"]),
  "0x2e1a7d4d": new ethers.Interface(["function withdraw(uint256 wad)"]),
  // V4 internal ops
  "0xf3cd914c": new ethers.Interface(["function swap((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, bytes hookData)"]),
  "0x0b0d9c09": new ethers.Interface(["function take(address currency, address to, uint256 amount)"]),
  "0xa5841194": new ethers.Interface(["function sync(address currency)"]),
  "0x11da60b4": new ethers.Interface(["function settle()"]),
  // UniV2-style routers
  "0x38ed1739": new ethers.Interface(["function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)"]),
  "0x6c08c57e": new ethers.Interface(["function swapExactTokensForTokens(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, address to)"]),
};

// ─── Protocol → adapterId mapping ──────────────────────────────

const PROTOCOL_ADAPTER_MAP: Record<string, string> = {
  morpho: "morpho-flash",
  balancer: "balancer-flash",
  "fluid-vault": "fluid-vault",
  "fluid-dex-liquidate": "fluid-dex-liquidate",
  "fluid-dex-swap": "fluid-dex-swap",
  univ3: "univ3-swap",
  univ4: "univ4-unlock",
  "univ4-swap": "univ4-swap",
  "univ4-take": "univ4-take",
  "univ4-sync": "univ4-sync",
  "univ4-settle": "univ4-settle",
  univ2: "univ2-swap",
  "univ2-router": "univ2-router-swap-exact-in",
  "univ2-router-alt": "univ2-router-swap-exact-in-alt",
  curve: "curve-exchange",
  "curve-router": "curve-router-execute-path",
  psm: "psm",
  erc20: "erc20-transfer",
  "wsteth-unwrap": "wsteth-unwrap",
  "wsteth-wrap": "wsteth-wrap",
  "weth-withdraw": "weth-withdraw",
};

// ─── Main Entry ────────────────────────────────────────────────

/**
 * Mode A solver: extract literal amounts from trace calldata.
 * Converts NormalizedCallNode tree → ResolvedPlanNode tree.
 *
 * Receiver addresses are rewritten from original bot → our executor.
 */
export function solveFromTrace(
  node: NormalizedCallNode,
  executor: string,
  originalBot: string,
): ResolvedPlanNode {
  const resolved = resolveNode(node, executor, originalBot);
  synthesizeMissingApprovals(resolved);
  return resolved;
}

function resolveNode(
  node: NormalizedCallNode,
  executor: string,
  originalBot: string,
): ResolvedPlanNode {
  const decoder = DECODERS[node.selector];
  let adapterId = PROTOCOL_ADAPTER_MAP[node.protocol] ?? null;

  if (adapterId === "fluid-dex-swap") {
    throw new Error(
      `unsupported: fluid-dex-swap ${node.target} ${node.selector} uses dexCallback without bytes payload`,
    );
  }

  // Unknown direct actions are not safe to compile.
  if (!adapterId && node.protocol === "unknown") {
    const children = node.children.map((c) => resolveNode(c, executor, originalBot));
    if (children.length === 1) return children[0];
    throw new Error(`unsupported: unknown direct call target=${node.target} selector=${node.selector}`);
  }
  if (!adapterId) {
    throw new Error(`unsupported: no adapter for protocol=${node.protocol} selector=${node.selector}`);
  }
  let amount = 0n;
  const params: Record<string, any> = {};

  let tokenIn = node.tokenIn ?? "";
  let tokenOut = node.tokenOut ?? "";

  if (decoder && node.calldata.length >= 10) {
    try {
      const decoded = decoder.decodeFunctionData(
        decoder.getFunction(node.selector)!,
        node.calldata,
      );

      // Extract params based on selector
      switch (node.selector) {
        case "0xe0232b42": // Morpho flashLoan
          params.token = decoded[0];
          amount = decoded[1];
          tokenIn = decoded[0];
          tokenOut = decoded[0];
          break;
        case "0x5c38449e": // Balancer flashLoan
          params.tokens = [...decoded[1]];
          params.amounts = [...decoded[2]].map((a: any) => BigInt(a));
          amount = params.amounts[0] ?? 0n;
          // Set tokenIn/tokenOut to the (first) flash token so downstream
          // synthesizeMissingApprovals knows what asset to approve.
          if (params.tokens.length > 0) {
            tokenIn = params.tokens[0];
            tokenOut = params.tokens[0];
          }
          break;
        case "0x032d2276": // FluidVault operate
          params.nftId = decoded[0];
          params.collateralDelta = decoded[1];
          params.debtDelta = decoded[2];
          amount = decoded[1] > 0n ? decoded[1] : -decoded[1];
          break;
        case "0x8433ea22": // FluidDex liquidate
          params.col = decoded[0];
          params.debt = decoded[1];
          params.absorb = decoded[3];
          amount = decoded[0];
          break;
        case "0x128acb08": // UniV3 swap
          params.zeroForOne = decoded[1];
          params.amountSpecified = decoded[2];
          params.sqrtPriceLimit = decoded[3];
          amount = decoded[2] > 0n ? decoded[2] : -decoded[2];
          break;
        case "0x022c0d9f": // UniV2 swap
          params.amount0Out = decoded[0];
          params.amount1Out = decoded[1];
          amount = decoded[0] > 0n ? decoded[0] : decoded[1];
          break;
        case "0x095ea7b3": // approve
          adapterId = "erc20-approve";
          params.spender = rewriteAddr(decoded[0], originalBot, executor);
          params.amount = decoded[1];
          amount = decoded[1];
          break;
        case "0xa9059cbb": // transfer
          adapterId = "erc20-transfer";
          params.to = rewriteAddr(decoded[0], originalBot, executor);
          params.amount = decoded[1];
          amount = decoded[1];
          break;
        case "0x95991276": // PSM sellGem
          amount = decoded[1];
          break;
        case "0xafb43012": // curve exchange_received (int128 indexes, receiver)
          params.i = decoded[0];
          params.j = decoded[1];
          params.minDy = decoded[3];
          params.receiver = rewriteAddr(decoded[4], originalBot, executor);
          amount = decoded[2];
          break;
        case "0x767691e7": // curve exchange_received (uint256 indexes, receiver)
          adapterId = "curve-exchange-received-uint";
          params.i = decoded[0];
          params.j = decoded[1];
          params.minDy = decoded[3];
          params.receiver = rewriteAddr(decoded[4], originalBot, executor);
          amount = decoded[2];
          break;
        case "0x7e3db030": // curve exchange_received (4 params, no receiver)
          adapterId = "curve-exchange-nr";
          params.i = decoded[0];
          params.j = decoded[1];
          params.minDy = decoded[3];
          amount = decoded[2];
          break;
        case "0x3df02124": // curve exchange (4 params, no receiver)
          adapterId = "curve-exchange-plain";
          params.i = decoded[0];
          params.j = decoded[1];
          params.minDy = decoded[3];
          amount = decoded[2];
          break;
        case "0xcb70e273": // curve/router executePath
          params.path = decoded[0];
          params.amounts = [...decoded[1]].map((a: any) => BigInt(a));
          params.receiver = rewriteAddr(decoded[2], originalBot, executor);
          amount = params.amounts[0] ?? 0n;
          break;
        case "0xde0e9a3e": // wstETH unwrap
          amount = decoded[0];
          break;
        case "0x2e1a7d4d": // WETH withdraw
          amount = decoded[0];
          break;
        case "0xf3cd914c": { // V4 swap
          const key = decoded[0];
          const swapParams = decoded[1];
          params.currency0 = key[0];
          params.currency1 = key[1];
          params.fee = BigInt(key[2]);
          params.tickSpacing = BigInt(key[3]);
          params.hooks = key[4];
          params.zeroForOne = swapParams[0];
          params.amountSpecified = swapParams[1];
          params.sqrtPriceLimit = swapParams[2];
          amount = swapParams[1] > 0n ? swapParams[1] : -swapParams[1];
          break;
        }
        case "0x0b0d9c09": // V4 take
          params.currency = decoded[0];
          amount = decoded[2];
          break;
        case "0xa5841194": // V4 sync
          params.currency = decoded[0];
          break;
        case "0x11da60b4": // V4 settle
          break;
        case "0x38ed1739": { // UniV2 router swapExactTokensForTokens
          params.amountIn = decoded[0];
          params.amountOutMin = decoded[1];
          params.path = [...decoded[2]];
          params.deadline = decoded[4];
          amount = decoded[0];
          const pathArr = params.path as string[];
          if (pathArr.length > 0) {
            tokenIn = pathArr[0];
            tokenOut = pathArr[pathArr.length - 1];
          }
          break;
        }
        case "0x6c08c57e": { // UniV2-style router (alt)
          params.tokenIn = decoded[0];
          params.tokenOut = decoded[1];
          params.amountIn = decoded[2];
          params.amountOutMin = decoded[3];
          tokenIn = decoded[0];
          tokenOut = decoded[1];
          amount = decoded[2];
          break;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`unsupported: decode failed target=${node.target} selector=${node.selector}: ${message}`);
    }
  }

  // Rewrite target address for receiver fields
  const target = node.target;

  // Recurse children
  const children = node.children.map((c) =>
    resolveNode(c, executor, originalBot),
  );

  return {
    adapterId,
    target,
    tokenIn,
    tokenOut,
    amount: typeof amount === "bigint" ? amount : BigInt(amount),
    params,
    children,
  };
}

/** Rewrite original bot address → our executor */
function rewriteAddr(
  addr: string,
  originalBot: string,
  executor: string,
): string {
  if (addr.toLowerCase() === originalBot.toLowerCase()) {
    return executor;
  }
  return addr;
}

function synthesizeMissingApprovals(root: ResolvedPlanNode): void {
  if (!root.adapterId.endsWith("-flash") || root.tokenIn === "") return;

  const MAX_UINT256 = (1n << 256n) - 1n;

  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];

    // Determine if this child needs an upstream approval from BotVM.
    //   fluid-vault: needs flash-token approve to vault contract (spender = vault)
    //   fluid-dex-liquidate: DEX Vault calls transferFrom on BotVM for the debt token.
    //     For arb that uses flash to close a debt position, debt token = flash token.
    let needsApproval = false;
    let spender = "";
    if (child.adapterId === "fluid-vault") {
      const collateralDelta = child.params.collateralDelta;
      if (typeof collateralDelta !== "bigint" || collateralDelta <= 0n) continue;
      needsApproval = true;
      spender = child.target;
    } else if (child.adapterId === "fluid-dex-liquidate") {
      needsApproval = true;
      spender = child.target;
    } else {
      continue;
    }

    if (!needsApproval) continue;

    const hasApproval = root.children.slice(0, i).some((candidate) =>
      candidate.adapterId === "erc20-approve"
      && candidate.target.toLowerCase() === root.tokenIn.toLowerCase()
      && typeof candidate.params.spender === "string"
      && candidate.params.spender.toLowerCase() === spender.toLowerCase()
      && typeof candidate.params.amount === "bigint"
      && candidate.params.amount >= root.amount
    );

    if (hasApproval) continue;

    // For fluid-dex-liquidate use MAX to avoid undercounting (debt amount unknown
    // at solver stage). For fluid-vault, flash amount is correct.
    const approveAmount =
      child.adapterId === "fluid-dex-liquidate" ? MAX_UINT256 : root.amount;

    root.children.splice(i, 0, {
      adapterId: "erc20-approve",
      target: root.tokenIn,
      tokenIn: root.tokenIn,
      tokenOut: root.tokenIn,
      amount: approveAmount,
      params: { spender, amount: approveAmount },
      children: [],
    });
    i++;
  }
}
