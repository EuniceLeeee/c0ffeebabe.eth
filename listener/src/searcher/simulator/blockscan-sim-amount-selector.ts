import { isDeepStrictEqual } from "node:util";
import { assertExecutionRounding } from "../../shared/executor/amount-rounding.js";
import { blockScanRouteId } from "../blockscan-route-identity.js";
import { isStateCallAbortedError, withStateCallControl } from "../../shared/state/state-backend.js";
import { propagateAmountsWithRawOutputs } from "../solver/amount-propagation.js";
import { buildResolvedPlanFromPath } from "../solver/plan-builder.js";
import { AmountNotExecutableError } from "../solver/amount-rejection.js";
import { BlockScanFamilyAttributedError } from "../detector/blockscan-family-budget.js";
import type { ResolvedPlan } from "../solver/solver.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import type { SimulationResult } from "./botvm-simulator.js";
import { createSimAmountSelector, type createTrialLimiter, type TrialControl } from "./sim-amount-selector.js";
import type { AmountSimulation } from "./sim-amount-search.js";

/** Strict runtime programs pass actual receipts between hops without Exact.
 * Unsupported routes retain strict quoted construction; actual execution
 * profit owns amount ranking in both cases.
 * The runtime owns backend/environment, trial slots, cancellation and final sim. */
export function createBlockScanSimAmountSelector(input: {
  source: CanonicalSource;
  executor: string;
  simulate(plan: ResolvedPlan, control: TrialControl): Promise<SimulationResult>;
  runTrial?: ReturnType<typeof createTrialLimiter>;
  record?(event: Record<string, unknown>): void;
  /** False is the frozen quoted-construction control for paired benchmarks. */
  runtimeAmounts?: boolean;
}) {
  return createSimAmountSelector({
    record: input.record,
    evaluate(plan, amount, state, probe, opts, control) {
      const run = input.runTrial ?? (async (_control: TrialControl, work: () => Promise<AmountSimulation<ResolvedPlan>>) => work());
      return run(control, async () => {
        const session = opts.strictSession!;
        if (plan.opportunity.kind !== "block-scan-arb" ||
            probe.executor.toLowerCase() !== input.executor.toLowerCase() ||
            !isDeepStrictEqual(session.source, input.source)) {
          throw new Error("sim amount selector execution/source mismatch");
        }
        const tolerance = opts.quoteToleranceRawUnits ?? 0n;
        assertExecutionRounding(tolerance);
        const controlledState = withStateCallControl(state, control);
        const identity = { routeId: blockScanRouteId(plan.tokenPath.edges), sourceBlockHash: input.source.hash,
          flashToken: plan.opportunity.flashToken.toLowerCase(), amount: amount.toString() };
        try {
          const quoteStart = performance.now();
          const legs = input.runtimeAmounts === false || !session.buildRuntimeAmountLeg ? null : plan.tokenPath.edges.map(edge => {
            const leg = session.buildRuntimeAmountLeg({ edge, executor: input.executor, runtimeEvidence: opts.runtimeEvidence ?? [] });
            return leg === null ? null : { ...leg, tokenIn: edge.tokenIn, tokenOut: edge.tokenOut };
          });
          const runtimeLegs = legs !== null && legs.every(leg => leg !== null) ? legs : null;
          input.record?.({ type: "sim_amount_construction", mode: runtimeLegs ? "runtime-actual" : "quoted",
            ...identity,
            hops: plan.tokenPath.edges.length, unsupportedLegs: legs?.filter(leg => leg === null).length ?? null });
          const propagated = runtimeLegs ? null : await propagateAmountsWithRawOutputs(plan.tokenPath, amount, controlledState, {
            executor: input.executor, strictSession: session, runtimeEvidence: opts.runtimeEvidence ?? [],
            adapterWorkControl: control, safetyBps: opts.quoteSafetyBps ?? 10000n,
            toleranceRawUnits: tolerance, shouldStop: () => control.signal.aborted,
            onExactCall: () => { if (opts.timing) opts.timing.hopExactCalls++; },
          });
          if (opts.timing) opts.timing.quoteMs += performance.now() - quoteStart;
          const actions = session.fundingActionIds(plan.opportunity.flashToken, amount);
          if (!actions.length) throw new Error("sim amount selector missing verified funding action");
          let best: AmountSimulation<ResolvedPlan> = { success: false, reason: "no positive executable funding action" };
          for (const action of actions) {
            control.signal.throwIfAborted();
            const buildStart = performance.now();
            const root = runtimeLegs ? session.buildFundingRoot({ actionAdapterId: action,
              asset: plan.opportunity.flashToken, amount, minProfit: plan.opportunity.targetNetProfit ?? 1n,
              children: [{ adapterId: "runtime-amount-flow", target: input.executor,
                tokenIn: plan.opportunity.flashToken, tokenOut: plan.opportunity.flashToken, amount,
                params: { legs: JSON.stringify(runtimeLegs), quoteToleranceRawUnits: tolerance,
                  minimumReturn: amount + (plan.opportunity.targetNetProfit ?? 1n) }, children: [] }],
            }) : await buildResolvedPlanFromPath(plan.tokenPath, plan.opportunity.flashToken, amount,
              propagated!.amounts, input.executor, controlledState, plan.opportunity.targetNetProfit ?? 1n,
              action, propagated!.rawOutputs, session, propagated!.exactHandles, tolerance);
            if (opts.timing) opts.timing.planBuildMs += performance.now() - buildStart;
            const candidate: ResolvedPlan = { root, flashAmount: amount, profitToken: plan.opportunity.profitToken,
              ...(runtimeLegs ? { simulationTokens: runtimeLegs.flatMap(leg => [leg.tokenIn, leg.tokenOut]) } : {}),
              netProfit: 0n, templateName: plan.templateName };
            const simStart = performance.now();
            let sim: SimulationResult;
            try { sim = await input.simulate(candidate, control); }
            finally { if (opts.timing) opts.timing.simMs += performance.now() - simStart; }
            control.signal.throwIfAborted();
            input.record?.({ type: "sim_amount_execution", mode: runtimeLegs ? "runtime-actual" : "quoted",
              ...identity, fundingActionId: action,
              amount: amount.toString(), success: sim.success, gasUsed: sim.gasUsed.toString(),
              grossProfit: sim.grossProfit.toString(), netProfit: sim.netProfit.toString(),
              failureKind: sim.failure?.kind ?? null, failureCode: sim.failure?.code ?? null });
            if (sim.profitToken.toLowerCase() !== candidate.profitToken.toLowerCase()) {
              throw new Error("sim amount selector profit token mismatch");
            }
            if (!sim.success) {
              if ((sim.failure?.kind === "revert" && sim.failure.code === "TRANSACTION_REVERTED") ||
                  (!sim.failure && sim.netProfit <= 0n)) continue;
              // Preserve infrastructure identity: never score RPC/source faults as zero.
              throw sim.failure?.cause ?? new Error("non-economic amount simulation failure");
            }
            if (sim.failure) throw new Error("inconsistent amount simulation result");
            if (sim.netProfit > 0n && (!best.success || sim.netProfit > best.profit)) {
              best = { success: true, profit: sim.netProfit, value: { ...candidate, netProfit: sim.netProfit } };
            }
          }
          return best;
        } catch (error) {
          const failure = error instanceof BlockScanFamilyAttributedError ? error.failureCause : error;
          const exactReason = failure instanceof Error && failure.message.startsWith("strict exact unresolved for ")
            ? failure.message.slice(failure.message.lastIndexOf(": ") + 2) : null;
          // Record public route/amount identity and local categories, not raw
          // provider messages, URLs, request bodies or cancellation reasons.
          input.record?.({ type: "sim_amount_failure", ...identity,
            sourceBlock: input.source.number, generation: input.source.generation,
            familyId: error instanceof BlockScanFamilyAttributedError ? error.familyId : null,
            failureStage: error instanceof BlockScanFamilyAttributedError ? error.stage : null,
            quoteContext: error instanceof BlockScanFamilyAttributedError ? error.quoteContext : null,
            failureName: failure instanceof Error ? failure.name : "unknown",
            exactReasonCode: exactReason?.replace(/https?:\/\/[^\s"'`]+/gi, "[redacted]").slice(0,1024) ?? null,
            aborted: control.signal.aborted });
          if (control.signal.aborted && isStateCallAbortedError(error) && error.kind === "signal") {
            throw control.signal.reason;
          }
          // Attribution alone is not economic proof: that wrapper also holds
          // source/RPC failures. Only explicit amount evidence is skippable.
          const cause = error instanceof BlockScanFamilyAttributedError ? error.failureCause : error;
          if (cause instanceof AmountNotExecutableError) {
            return { success: false, reason: "amount-not-executable" };
          }
          throw error;
        }
      });
    },
  });
}
