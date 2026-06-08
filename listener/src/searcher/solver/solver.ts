/**
 * Solver — converts a CandidatePlan (token path + unresolved amounts) into
 * a profitable ResolvedPlan by:
 *   1. Binary-searching flashAmount over [low, high] bounds
 *   2. For each flashAmount, propagating amounts via quoter chain
 *   3. Building a generic ResolvedPlanNode via plan-builder (no path hardcode)
 *   4. Submitting to simulator probe to get real netProfit on Anvil
 *   5. Tracking best candidate
 *
 * This is the V4 Phase 2 generic solver. It accepts any TokenPath produced
 * by the planner and never builds a route-specific plan by name.
 */

import type { ResolvedPlanNode } from "../../shared/types/plan.js";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { CandidatePlan } from "../planner/planner.js";
import { candidateFlashAmounts, estimateFlashBounds } from "./amount-bounds.js";
import { propagateAmounts } from "./amount-propagation.js";
import { buildResolvedPlanFromPath } from "./plan-builder.js";

export interface ResolvedPlan {
  root: ResolvedPlanNode;
  netProfit: bigint;
  profitToken: string;
  flashAmount: bigint;
  templateName: string;
}

export interface SolverProbe {
  readonly executor: string;
  simulate(plan: ResolvedPlan): Promise<{
    success: boolean;
    netProfit: bigint;
    revertReason?: string;
  }>;
}

export interface Solver {
  solve(plan: CandidatePlan, state: StateBackend, probe: SolverProbe): Promise<ResolvedPlan>;
}

export class AnvilSolver implements Solver {
  async solve(
    plan: CandidatePlan,
    state: StateBackend,
    probe: SolverProbe,
  ): Promise<ResolvedPlan> {
    let best: ResolvedPlan | null = null;
    let lastFailure = "no flash amounts tried";

    const [low, high] = estimateFlashBounds(plan.opportunity.victimAmountIn);
    const flashToken = plan.opportunity.startToken;
    const executor = probe.executor;
    const targetNetProfit = plan.opportunity.targetNetProfit ?? 1n;
    const unsupported = unsupportedExactQuote(plan);
    if (unsupported) throw new Error(unsupported);

    for (const flashAmount of candidateFlashAmounts(low, high)) {
      for (const fluidDebtBps of fluidDebtBpsCandidates(plan)) {
        console.log(
          `[searcher/ac3] solver: try flashAmount=${flashAmount} fluidDebtBps=${fluidDebtBps} ` +
            `path=${pathSummary(plan.tokenPath)}`,
        );

        // 1. Propagate amounts through quoter chain
        let amounts: bigint[];
        try {
          amounts = await propagateAmounts(plan.tokenPath, flashAmount, state, { fluidDebtBps });
        } catch (err) {
          lastFailure = `propagation failed: ${err instanceof Error ? err.message : String(err)}`;
          console.log(`[searcher/ac3] solver:   propagation ${lastFailure.slice(0, 160)}`);
          continue;
        }

        // 2. Build resolved plan from path + amounts
        let resolvedNode: ResolvedPlanNode;
        try {
          resolvedNode = await buildResolvedPlanFromPath(
            plan.tokenPath,
            flashToken,
            flashAmount,
            amounts,
            executor,
            state,
            targetNetProfit,
          );
        } catch (err) {
          lastFailure = `build failed: ${err instanceof Error ? err.message : String(err)}`;
          console.log(`[searcher/ac3] solver:   build ${lastFailure.slice(0, 160)}`);
          continue;
        }

        // 3. Run through simulator probe
        const candidate: ResolvedPlan = {
          root: resolvedNode,
          netProfit: 0n,
          profitToken: plan.opportunity.profitToken,
          flashAmount,
          templateName: plan.templateName,
        };
        const sim = await probe.simulate(candidate);
        if (!sim.success) {
          lastFailure = sim.revertReason ?? "simulation failed";
          console.log(`[searcher/ac3] solver:   sim rejected: ${lastFailure.slice(0, 160)}`);
          continue;
        }

        const scored: ResolvedPlan = { ...candidate, netProfit: sim.netProfit };
        console.log(`[searcher/ac3] solver:   accepted, netProfit=${sim.netProfit}`);
        if (!best || scored.netProfit > best.netProfit) best = scored;
        if (best.netProfit >= targetNetProfit) return best;
      }
    }

    if (!best) throw new Error(`no profitable plan: ${lastFailure}`);
    return best;
  }
}

function fluidDebtBpsCandidates(
  plan: { tokenPath: { edges: { adapterId: string }[] } },
): bigint[] {
  if (!plan.tokenPath.edges.some((edge) => edge.adapterId === "fluid-vault")) return [0n];
  return [8500n, 9500n, 10000n, 10400n, 10800n, 11200n];
}

function unsupportedExactQuote(
  plan: { tokenPath: { edges: { adapterId: string }[] } },
): string | null {
  if (plan.tokenPath.edges.some((edge) => edge.adapterId === "univ4-unlock")) {
    return "unsupported exact quote: univ4-unlock requires dry-run quoter";
  }
  return null;
}

function pathSummary(path: { edges: { adapterId: string; tokenIn: string; tokenOut: string }[] }): string {
  return path.edges.map((e) => `${shortToken(e.tokenIn)}->${shortToken(e.tokenOut)}@${e.adapterId}`).join(" → ");
}

function shortToken(addr: string): string {
  return addr.slice(0, 6);
}
