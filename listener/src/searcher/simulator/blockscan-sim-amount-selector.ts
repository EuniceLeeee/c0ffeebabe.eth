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
import { prepareRuntimeSettlement } from "./runtime-settlement.js";
import {effectiveRowExecutionVerified,effectiveHistoricalRankingHint,type EffectiveMidSnapshot} from "../blockscan-effective-mid.js";
import type {TokenEdge} from "../planner/token-graph.js";

/** No transport and no mutable last-winner lookup: use the receipt published
 * for this pass, including the authenticated original receipt on a carry.
 * A stale/forked/missing receipt is not authorization to try another encoding. */
export function publishedSolverVariant(snapshot:EffectiveMidSnapshot|undefined,source:CanonicalSource,edge:TokenEdge):string {
  const row=edge.canonicalEdgeId&&snapshot?.rows.get(edge.canonicalEdgeId);
  const id=row&&row.executionVerification?.variantId;
  if(!snapshot?.complete||snapshot.source.number!==source.number||snapshot.source.hash.toLowerCase()!==source.hash.toLowerCase()||
    snapshot.source.generation!==source.generation||!row||typeof id!=="string"||!id.length||
    !effectiveRowExecutionVerified(snapshot,row,edge))throw Error("SQL amount selection lacks its current published execution recipe");
  return id;
}

const historicalTrials=new WeakMap<ResolvedPlan,{source:CanonicalSource;scriptHex:string;amount:bigint;net:bigint;token:string}>();
/** Only the amount evaluator below writes this proof, after a real funded
 * positive trial. Historical receipt hashes and quote marks are not inputs. */
export function matchesHistoricalAmountTrial(plan:ResolvedPlan,source:CanonicalSource,scriptHex:string):boolean{
  const proof=historicalTrials.get(plan);
  return !!proof&&isDeepStrictEqual(proof.source,source)&&proof.scriptHex===scriptHex.toLowerCase()&&proof.net>0n&&
    proof.amount===plan.flashAmount&&proof.net===plan.netProfit&&proof.token===plan.profitToken.toLowerCase();
}

/** Strict runtime programs pass actual receipts between hops without Exact.
 * Unsupported routes retain strict quoted construction; actual execution
 * profit owns amount ranking in both cases.
 * The runtime owns backend/environment, trial slots, cancellation and final sim. */
export function createBlockScanSimAmountSelector(input: {
  source: CanonicalSource;
  effectiveMids?: EffectiveMidSnapshot;
  executor: string;
  simulate(plan: ResolvedPlan, control: TrialControl): Promise<SimulationResult>;
  runTrial?: ReturnType<typeof createTrialLimiter>;
  record?(event: Record<string, unknown>): void;
  /** False is the frozen quoted-construction control for paired benchmarks. */
  runtimeAmounts?: boolean;
  /** Source-pinned per-token maximum-borrow entry selected once by the caller. */
  fundingActionId?: string;
  fundingId?: string;
  /** Paired execution benchmark control, not an independent search policy. */
  callbackSettlement?: boolean;
}) {
  // createSimAmountSelector issues fresh options for each solve. Weak ownership
  // prevents reuse across sources, concurrent solves or changed runtime evidence.
  const routes = new WeakMap<object, {
    legs: Array<import("../../adapters/runtime-amount-program.js").RuntimeAmountLeg & { tokenIn: string; tokenOut: string }> | null;
    legsJson: string; unsupported: number | null;
    settlement: ReturnType<typeof prepareRuntimeSettlement>;
    callbackRejectedAtSeed: boolean;
    hintTrial: boolean;
  }>();
  return createSimAmountSelector({
    record: input.record,
    evaluate(plan, amount, state, probe, opts, control) {
      const run = input.runTrial ?? (async (_control: TrialControl, work: () => Promise<AmountSimulation<ResolvedPlan>>) => work());
      const queuedAt = performance.now();
      return run(control, async () => {
        const queueMs = performance.now() - queuedAt;
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
          let prepared = routes.get(opts);
          const preparedHit = prepared !== undefined;
          if (!prepared) {
            let hintTrial=false;
            const recipeFor=(edge:TokenEdge)=>{
              if(!session.needsPublishedExecutionVariant?.(edge))return;
              const snapshot=input.effectiveMids;
              if(snapshot?.complete&&isDeepStrictEqual(snapshot.source,input.source)){
                const hint=effectiveHistoricalRankingHint(snapshot,edge);
                if(hint){hintTrial=true;return hint.variantId;}
              }
              return publishedSolverVariant(snapshot,input.source,edge);
            };
            const recipes=plan.tokenPath.edges.map(recipeFor);
            const legs = input.runtimeAmounts === false || !session.buildRuntimeAmountLeg ? null : plan.tokenPath.edges.map((edge,index) => {
              const leg = session.buildRuntimeAmountLeg({ edge, executor: input.executor, runtimeEvidence: opts.runtimeEvidence ?? [],
                variantId:recipes[index] });
              return leg === null ? null : { ...leg, tokenIn: edge.tokenIn, tokenOut: edge.tokenOut };
            });
            const runtimeLegs = legs !== null && legs.every(leg => leg !== null) ? legs : null;
            if(hintTrial&&!runtimeLegs)throw Error("historical screen requires current runtime amount legs");
            prepared = { callbackRejectedAtSeed: false, hintTrial, legs: runtimeLegs, legsJson: JSON.stringify(runtimeLegs), unsupported: legs?.filter(leg => leg === null).length ?? null,
              settlement: hintTrial || input.callbackSettlement === false || !runtimeLegs ||
                !runtimeLegs.at(-1)?.settlement?.deferredInput ||
                plan.tokenPath.edges.some(edge => session.blocksPrefixInversion(edge)) ? null : prepareRuntimeSettlement({
                  legs: runtimeLegs, executor: input.executor,
                  build: (index, request) => session.buildRuntimeAmountLeg({ edge: plan.tokenPath.edges[index]!, executor: input.executor,
                    runtimeEvidence: opts.runtimeEvidence ?? [], settlement: request, variantId:recipes[index] }),
                }) };
            routes.set(opts, prepared);
          }
          const runtimeLegs = prepared.legs;
          const settlement = prepared.callbackRejectedAtSeed ? null
            : prepared.settlement?.(amount, plan.opportunity.targetNetProfit ?? 1n) ?? null;
          input.record?.({ type: "sim_amount_construction", mode: runtimeLegs ? "runtime-actual" : "quoted",
            ...identity,
            hops: plan.tokenPath.edges.length, unsupportedLegs: prepared.unsupported, preparedHit, callbackRejectedAtSeed: prepared.callbackRejectedAtSeed, queueMs, preparationMs: performance.now() - quoteStart });
          const propagated = runtimeLegs ? null : await propagateAmountsWithRawOutputs(plan.tokenPath, amount, controlledState, {
            executor: input.executor, strictSession: session, runtimeEvidence: opts.runtimeEvidence ?? [],
            executionVariantForEdge:edge=>session.needsPublishedExecutionVariant?.(edge)?
              publishedSolverVariant(input.effectiveMids,input.source,edge):undefined,
            adapterWorkControl: control, safetyBps: opts.quoteSafetyBps ?? 10000n,
            toleranceRawUnits: tolerance, shouldStop: () => control.signal.aborted,
            onExactCall: () => { if (opts.timing) opts.timing.hopExactCalls++; },
          });
          if (opts.timing) opts.timing.quoteMs += performance.now() - quoteStart;
          const actions = session.fundingChoices(plan.opportunity.flashToken, amount).filter(choice =>
            (input.fundingActionId === undefined || choice.actionAdapterId === input.fundingActionId) &&
            (input.fundingId === undefined || choice.fundingId === input.fundingId));
          if (input.fundingActionId !== undefined && input.fundingId === undefined && actions.length > 1)
            throw new Error("sim amount selector fixed funding action requires a provider fundingId");
          if (!actions.length) throw new Error("sim amount selector missing verified funding action");
          let best: AmountSimulation<ResolvedPlan> = { success: false, reason: "no positive executable funding action" };
          for (const action of [...(settlement ? [null] : []), ...actions]) {
            control.signal.throwIfAborted();
            const buildStart = performance.now();
            const root = action === null ? settlement! : runtimeLegs ? session.buildFundingRoot({ actionAdapterId: action.actionAdapterId, fundingId: action.fundingId,
              asset: plan.opportunity.flashToken, amount, minProfit: plan.opportunity.targetNetProfit ?? 1n,
              children: [{ adapterId: "runtime-amount-flow", target: input.executor,
                tokenIn: plan.opportunity.flashToken, tokenOut: plan.opportunity.flashToken, amount,
                params: { legs: prepared.legsJson, quoteToleranceRawUnits: tolerance, minimumReturn: amount + (plan.opportunity.targetNetProfit ?? 1n) }, children: [] }],
            }) : await buildResolvedPlanFromPath(plan.tokenPath, plan.opportunity.flashToken, amount,
              propagated!.amounts, input.executor, controlledState, plan.opportunity.targetNetProfit ?? 1n,
              action.actionAdapterId, propagated!.rawOutputs, session, propagated!.exactHandles, tolerance, action.fundingId);
            if (opts.timing) opts.timing.planBuildMs += performance.now() - buildStart;
            const candidate: ResolvedPlan = { root, flashAmount: amount, profitToken: plan.opportunity.profitToken,
              netProfit: 0n, templateName: plan.templateName };
            const simStart = performance.now();
            let sim: SimulationResult;
            try { sim = await input.simulate(candidate, { ...control,
              onSimulationTiming: input.record ? timing => input.record!({ type: "sim_amount_phase", ...identity,
                settlementMode: action === null ? "deferred-input" : "funded", ...timing }) : undefined }); }
            finally { if (opts.timing) opts.timing.simMs += performance.now() - simStart; }
            control.signal.throwIfAborted();
            input.record?.({ type: "sim_amount_execution", mode: runtimeLegs ? "runtime-actual" : "quoted",
              ...identity, fundingActionId: action?.actionAdapterId ?? null, fundingId: action?.fundingId ?? null, settlementMode: action === null ? "deferred-input" : "funded",
              amount: amount.toString(), success: sim.success, gasUsed: sim.gasUsed.toString(),
              grossProfit: sim.grossProfit.toString(), netProfit: sim.netProfit.toString(),
              failureKind: sim.failure?.kind ?? null, failureCode: sim.failure?.code ?? null });
            if (sim.profitToken.toLowerCase() !== candidate.profitToken.toLowerCase()) {
              throw new Error("sim amount selector profit token mismatch");
            }
            if (!sim.success) {
              if ((sim.failure?.kind === "revert" && sim.failure.code === "TRANSACTION_REVERTED") ||
                  (!sim.failure && sim.netProfit <= 0n)) {
                // searchSimAmounts awaits p before starting coarse/refine trials.
                // This is a per-solve funding policy, not a proof that all larger
                // amounts would revert. Keep their search through verified funding.
                if (action === null && amount === plan.opportunity.searchSeed.searchCenter) {
                  prepared.callbackRejectedAtSeed = true;
                  input.record?.({ type: "sim_amount_funding_policy", ...identity,
                    mode: "funded", reason: sim.failure ? "seed-callback-reverted" : "seed-callback-nonpositive" });
                }
                continue;
              }
              // Preserve infrastructure identity: never score RPC/source faults as zero.
              throw sim.failure?.cause ?? new Error("non-economic amount simulation failure");
            }
            if (sim.failure) throw new Error("inconsistent amount simulation result");
            if (sim.netProfit > 0n && (!best.success || sim.netProfit > best.profit)) {
              const value={ ...candidate, netProfit: sim.netProfit };
              if(prepared.hintTrial){
                if(!sim.scriptHex||!/^0x(?:[0-9a-f]{2})+$/i.test(sim.scriptHex))throw Error("positive historical-screen trial lacks simulated bytes");
                historicalTrials.set(value,{source:Object.freeze({...input.source}),scriptHex:sim.scriptHex.toLowerCase(),
                  amount:value.flashAmount,net:sim.netProfit,token:sim.profitToken.toLowerCase()});
              }
              best = { success: true, profit: sim.netProfit, value };
            }
            // The existing funded construction remains available when the
            // deferred composition cannot execute at this amount/state.
            if (action === null && best.success) break;
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
