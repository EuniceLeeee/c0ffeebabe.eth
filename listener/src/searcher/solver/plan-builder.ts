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
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import { buildFlashLoanRoot } from "../venues/funding/flash-loan-framework.js";
import type { PlanFragment } from "../venues/route-leg-adapter.js";

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
  flashAdapterId: string =
    PRODUCTION_ADAPTER_FAMILIES.defaultFunding().funding.actionAdapterId,
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

    const routeAdapter = PRODUCTION_ADAPTER_FAMILIES.routes().findForEdge(edge.adapterId);
    if (routeAdapter) {
      let fragment: PlanFragment;
      try {
        fragment = await routeAdapter.buildPlanFragment({
          edge,
          amountIn: amtIn,
          amountOut: amtOut,
          rawOut,
          executor,
          state,
        });
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

    throw new BlockScanFamilyAttributedError(
      blockScanEdgeFamilyId(edge),
      "plan build",
      new Error(`plan-builder: no family owns adapter ${edge.adapterId}`),
    );
  }

  const flashFamily = PRODUCTION_ADAPTER_FAMILIES.findFundingByAction(flashAdapterId);
  if (!flashFamily) throw new Error(`plan-builder: unknown flash adapter ${flashAdapterId}`);
  return buildFlashLoanRoot(flashFamily, {
    flashToken,
    flashAmount,
    minProfit,
    children: inner,
  });
}

function isControlFailure(error: unknown): boolean {
  return error instanceof Error &&
    /\b(?:abort(?:ed)?|deadline|timed?\s*out|timeout)\b/i.test(error.message);
}
