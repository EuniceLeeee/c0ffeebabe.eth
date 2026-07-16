/**
 * Plan Builder — generic ResolvedPlanNode tree from a TokenPath + amounts.
 *
 * Walks planner-produced path edges and constructs the appropriate adapter
 * nodes, auto-nesting wrapper callbacks
 * (UniV3 swap, UniV4 unlock, UniV2 swap), auto-synthesizing approve/transfer
 * before lending/swaps, and inserting the assert-balance guard before flash repay.
 */

import { PROTOCOL_LEG_DESCRIPTORS } from "../../adapters/protocol-legs.js";
import { ADDR } from "../../shared/constants/addresses.js";
import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { TokenEdge, TokenPath } from "../planner/token-graph.js";
import { PRODUCTION_ROUTE_ADAPTERS } from "../venues/production-registry.js";

const MAX_UINT = (1n << 256n) - 1n;

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

  function ensureApprove(token: string, spender: string, amount: bigint = MAX_UINT): void {
    const key = `${token.toLowerCase()}@${spender.toLowerCase()}`;
    if (approvedSpenders.has(key)) return;
    approvedSpenders.add(key);
    inner.push({
      adapterId: "erc20-approve",
      target: token,
      tokenIn: token,
      tokenOut: token,
      amount,
      params: { spender, amount },
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

    const routeAdapter = PRODUCTION_ROUTE_ADAPTERS.routeLegs.findForEdge(edge.adapterId);
    if (routeAdapter) {
      const fragment = await routeAdapter.buildPlanFragment({
        edge,
        amountIn: amtIn,
        amountOut: amtOut,
        rawOut,
        executor,
        state,
      });
      for (const requirement of fragment.requirements) {
        if (requirement.kind === "approve") {
          ensureApprove(requirement.token, requirement.spender, requirement.amount);
        } else {
          transferToPool(requirement.token, requirement.pool, requirement.amount);
        }
      }
      inner.push(...fragment.nodes);
      continue;
    }

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

  // Repay the flash. Morpho PULLS the repayment via transferFrom after the callback (needs an approve).
  // Balancer does NOT pull — receiveFlashLoan must leave the borrowed amount back in the vault (it
  // verifies its own balance is restored), so the repay must be a TRANSFER to the vault. An approve is a
  // silent no-op for Balancer and the flashLoan then reverts. (Balancer protocol flash fee is 0, so we
  // transfer exactly flashAmount.)
  const flashTarget = FLASH_ADAPTER_TARGETS[flashAdapterId];
  if (!flashTarget) throw new Error(`plan-builder: unknown flash adapter ${flashAdapterId}`);
  if (flashAdapterId === "balancer-flash") {
    transferToPool(flashToken, flashTarget, flashAmount);
  } else {
    ensureApprove(flashToken, flashTarget);
  }

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
    case "metronome-hgusdc-exit":
      // The router starts with Curve exchange_received; it does not pull msUSD.
      // Pre-fund the exact Curve pool, matching the successful reference trace.
      transferToPool(edge.tokenIn, ADDR.CURVE_MSUSD_FRXUSD, amtIn);
      return {
        adapterId: "metronome-hgusdc-exit",
        target: edge.target,
        tokenIn: edge.tokenIn,
        tokenOut: edge.tokenOut,
        amount: amtIn,
        params: {},
        children: [],
      };

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

    default:
      throw new Error(`plan-builder: no handler for adapter ${edge.adapterId}`);
  }
}
