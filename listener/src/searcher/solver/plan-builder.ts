/**
 * Plan Builder — generic ResolvedPlanNode tree from a TokenPath + amounts.
 *
 * Walks planner-produced path edges and constructs the appropriate adapter
 * nodes, auto-nesting wrapper callbacks
 * (UniV3 swap, UniV4 unlock, UniV2 swap), auto-synthesizing approve/transfer
 * before lending/swaps, and inserting the assert-balance guard before flash repay.
 */

import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import {
  isStateCallAbortedError,
  type StateBackend,
} from "../../shared/state/state-backend.js";
import {
  BlockScanFamilyAttributedError,
  blockScanEdgeFamilyId,
} from "../detector/blockscan-family-budget.js";
import type { TokenPath } from "../planner/token-graph.js";
import type {
  StrictProductionExactHandle,
  StrictProductionRuntimeSession,
} from "../strict-production-runtime-session.js";
import type {
  PlanFragment,
} from "../venues/route-leg-adapter.js";

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
  flashAdapterId?: string,
  rawOutputs?: bigint[],
  strictSession?: StrictProductionRuntimeSession,
  exactHandles?: readonly StrictProductionExactHandle[],
  quoteToleranceRawUnits: bigint = 0n,
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
  if (strictSession === undefined) {
    throw new Error("plan-builder requires a strict current-source session");
  }
  if (flashAdapterId === undefined || flashAdapterId.length === 0) {
    throw new Error("plan-builder requires a strict Funding action");
  }
  if (exactHandles?.length !== path.edges.length) {
    throw new Error(
      `exact handles length ${exactHandles?.length ?? 0} != edges (${path.edges.length})`,
    );
  }

  if (quoteToleranceRawUnits !== 0n && quoteToleranceRawUnits !== 1n) {
    throw new Error("execution tolerance must be 0 or 1 token raw unit");
  }

  const inner: ResolvedPlanNode[] = [];
  function approval(token: string, spender: string, amount: bigint,
    inputToken: string, inputAmount: bigint): ResolvedPlanNode {
    // Only an unlimited input-token grant can use this exact leg's spend as
    // its minimum. Finite requirements and other assets retain their declared
    // minimum; do not infer conversions or reduce a Family's requested bound.
    const minimumAllowance = amount === MAX_UINT && token.toLowerCase() === inputToken.toLowerCase() ? inputAmount : amount;
    if (minimumAllowance <= 0n || amount < minimumAllowance || amount > MAX_UINT) {
      throw new Error("Family approval does not cover its exact input");
    }
    return {
      adapterId: "erc20-approve",
      target: token,
      tokenIn: token,
      tokenOut: token,
      amount,
      params: { spender, amount, minimumAllowance },
      children: [],
    };
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

  function buildFragment(i: number, exact: StrictProductionExactHandle, minAmountOut: bigint): PlanFragment {
    const edge = path.edges[i]!;
    let fragment: PlanFragment;
    try {
      const execution = strictSession!.buildExecution({
        edge,
        exact,
        minAmountOut,
        executor,
        priorQuotes: exactHandles!.slice(0, i),
      });
      if (execution.status !== "resolved") {
        const reason = "reasonCode" in execution
          ? execution.reasonCode
          : execution.outcome.reasonCode;
        throw new Error(`strict execution unresolved: ${reason}`);
      }
      fragment = execution.fragment;
    } catch (error) {
      if (
        error instanceof BlockScanFamilyAttributedError ||
        isStateCallAbortedError(error) ||
        isControlFailure(error)
      ) {
        throw error;
      }
      throw new BlockScanFamilyAttributedError(
        blockScanEdgeFamilyId(edge),
        "plan build",
        error,
      );
    }
    return fragment;
  }

  // Tolerance only relaxes a Family's existing minimum-output argument.
  // Do not wrap legs in ACTUAL_AMOUNT_FLOW, query balances, re-quote +/-1
  // branches, or pre-subtract from the nominal input/output amount chain.
  // A middle-leg shortfall can still fail downstream; final simulation and
  // conservation/repayment remain mandatory, never subsidized from inventory.
  for (let i = 0; i < path.edges.length; i++) {
    const nominalOut = amounts[i + 1]!;
    if (nominalOut <= quoteToleranceRawUnits) {
      throw new Error("execution tolerance has no positive minimum output");
    }
    const fragment = buildFragment(i, exactHandles[i]!, nominalOut - quoteToleranceRawUnits);
    for (const requirement of fragment.requirements) {
      if (requirement.kind === "approve") {
        inner.push(approval(requirement.token, requirement.spender, requirement.amount, path.edges[i]!.tokenIn, amounts[i]!));
      } else {
        transferToPool(requirement.token, requirement.pool, requirement.amount);
      }
    }
    inner.push(...fragment.nodes);
  }

  return strictSession.buildFundingRoot({
    actionAdapterId: flashAdapterId,
    asset: flashToken,
    amount: flashAmount,
    minProfit,
    children: inner,
  });
}

function isControlFailure(error: unknown): boolean {
  return error instanceof Error &&
    /\b(?:abort(?:ed)?|deadline|timed?\s*out|timeout)\b/i.test(error.message);
}
