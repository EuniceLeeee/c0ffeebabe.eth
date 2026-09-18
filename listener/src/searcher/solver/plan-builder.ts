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
import type { RuntimeEvidence } from "../venues/adapter-family-plugin.js";
import type { AdapterWorkControl } from "../adapter-work-intent.js";

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
  actualFlow?: {
    runtimeEvidence: readonly RuntimeEvidence[];
    control?: AdapterWorkControl;
    shouldStop?: () => boolean;
    onExactCall?: () => void;
  },
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

  function buildFragment(i: number, exact: StrictProductionExactHandle, minAmountOut: bigint): PlanFragment {
    const edge = path.edges[i]!;
    let fragment: PlanFragment;
    try {
      const execution = strictSession!.buildExecution({
        edge,
        exact,
        minAmountOut,
        executor,
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

  if (actualFlow) {
    // Only finalists prepare the finite exact-input cases. No haircuts affect
    // Solver search/ranking. At most 1+2+4+8+16+32 cases for six hops; equal
    // amounts are deduplicated. Every case has its own unmodified exact handle.
    if (!path.edges.length || path.edges.length > 6 || path.edges.some(edge =>
      edge.tokenIn.toLowerCase() === edge.tokenOut.toLowerCase() ||
      edge.leavesStandingPosition || strictSession.blocksPrefixInversion(edge))) {
      throw new Error("actual amount flow requires a closed fungible exact-input path of at most six hops");
    }
    let inputs = new Set([flashAmount]);
    const steps: ResolvedPlanNode[] = [];
    for (let i = 0; i < path.edges.length; i++) {
      const edge = path.edges[i]!;
      const cases: ResolvedPlanNode[] = [];
      const next = new Set<bigint>();
      for (const amountIn of inputs) {
        if (actualFlow.shouldStop?.()) throw new Error("actual amount flow aborted: deadline");
        let exact = amountIn === amounts[i] ? exactHandles[i]! : undefined;
        if (!exact) {
          actualFlow.onExactCall?.();
          exact = await strictSession.issueExact({ edge, amountIn, executor,
            runtimeEvidence: actualFlow.runtimeEvidence,
            ...(actualFlow.control ? { control: actualFlow.control } : {}) });
        }
        if (exact.amountOut <= 1n) throw new Error("actual amount flow has no positive one-unit minimum");
        const fragment = buildFragment(i, exact, exact.amountOut - 1n);
        const children: ResolvedPlanNode[] = [];
        for (const requirement of fragment.requirements) {
          if (requirement.kind === "approve") {
            if (requirement.amount === undefined || requirement.amount === MAX_UINT) {
              ensureApprove(requirement.token, requirement.spender, requirement.amount);
            } else {
              // A finite Family allowance belongs to this exact-input case.
              // Do not widen it to unlimited or hoist one alternative's bound.
              children.push({ adapterId: "erc20-approve", target: requirement.token,
                tokenIn: requirement.token, tokenOut: requirement.token, amount: requirement.amount,
                params: { spender: requirement.spender, amount: requirement.amount }, children: [] });
            }
          } else {
            children.push({ adapterId: "erc20-transfer", target: requirement.token,
              tokenIn: requirement.token, tokenOut: requirement.token, amount: requirement.amount,
              params: { to: requirement.pool, amount: requirement.amount }, children: [] });
          }
        }
        children.push(...fragment.nodes);
        cases.push({ adapterId: "actual-amount-case", target: executor,
          tokenIn: edge.tokenIn, tokenOut: edge.tokenOut, amount: amountIn,
          params: { quotedAmountOut: exact.amountOut }, children });
        next.add(exact.amountOut);
        next.add(exact.amountOut - 1n);
      }
      steps.push({ adapterId: "actual-amount-step", target: executor,
        tokenIn: edge.tokenIn, tokenOut: edge.tokenOut, amount: 0n, params: {}, children: cases });
      inputs = next;
    }
    inner.push({ adapterId: "actual-amount-flow", target: executor,
      tokenIn: flashToken, tokenOut: flashToken, amount: flashAmount,
      params: { toleranceRawUnits: 1n }, children: steps });
  } else for (let i = 0; i < path.edges.length; i++) {
    const fragment = buildFragment(i, exactHandles[i]!, amounts[i + 1]!);
    for (const requirement of fragment.requirements) {
      if (requirement.kind === "approve") {
        ensureApprove(requirement.token, requirement.spender, requirement.amount);
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
