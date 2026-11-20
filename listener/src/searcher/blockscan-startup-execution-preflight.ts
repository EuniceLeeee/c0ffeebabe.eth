import { keccak256, toUtf8Bytes } from "ethers";
import assert from "node:assert/strict";
import { ADDR } from "../shared/constants/addresses.js";
import { effectiveEnumerationMids, effectiveRowAmountReference, effectiveInputPathHops,
  effectiveExecutionReceiptHash, type EffectiveExecutionVerification,
  type EffectiveMidSnapshot, type EffectiveMidRow, type EffectiveAmountReference } from "./blockscan-effective-mid.js";
import type { BlockScanSimRejectCache } from "./blockscan-sim-reject-cache.js";
import type { TokenEdge } from "./planner/token-graph.js";
import type { StartupNodeSimulation } from "./blockscan-startup-node-simulation.js";
import type { StrictProductionRuntimeSession } from "./strict-production-runtime-session.js";
import type { AdapterWorkControl } from "./adapter-work-intent.js";
import { blockScanEdgeKey } from "./venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "./venues/route-instance-identity.js";
import { StateCallAbortedError } from "../shared/state/state-backend.js";
import { applyStartupTargetFilters } from "./blockscan-startup-filter.js";
import type { CanonicalSource } from "./venues/adapter-request-program.js";
import { startupPriceRevert } from "./startup-prefix-failure.js";
import type { StartupPrefixReceipt } from "./simulator/startup-prefix-program.js";

export type StartupExecutionPreflight = ReturnType<typeof createBlockScanStartupExecutionPreflight>;
export type StartupPrefixObservation = Readonly<Record<string, unknown>>;
export interface StartupEffectiveQuote {
  readonly source: CanonicalSource;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly amountSpent: bigint;
  readonly inputReference: EffectiveAmountReference;
  readonly pricingMethod: "startup-simulation";
  readonly executionVerification: EffectiveExecutionVerification;
}
export interface StartupContinuationState {
  readonly version: 1;
  readonly rows: readonly (readonly [string, { readonly key: string; readonly observation: StartupPrefixObservation }])[];
}
const digest = (value: unknown) => keccak256(toUtf8Bytes(JSON.stringify(value,
  (_, v) => typeof v === "bigint" ? v.toString() : v)));
const sourcePolicyKey = (source: CanonicalSource, maxInputPathHops: number) =>
  `${source.number}:${source.hash.toLowerCase()}:${source.generation}:${maxInputPathHops}`;
const rowFields = (row: EffectiveMidRow | undefined) => row && [row.edgeId, row.instanceKey,
  row.tokenIn, row.tokenOut, row.amountIn, row.amountOut, row.amountSpent, row.pricingMethod,
  row.executionVerification, row.status, row.quotedAt];
const issuedKey = (source: CanonicalSource, maxInputPathHops: number, rows: readonly EffectiveMidRow[]) =>
  digest({ source, maxInputPathHops, rows: rows.map(rowFields) });

/** Observations stay immutable. Optional target-revert policy writes to live's
 * existing rejection cache, never another filter or price warmup. */
export function createBlockScanStartupExecutionPreflight(input: {
  executor: string; transactionOrigin: string; simRejects: BlockScanSimRejectCache;
  concurrency: number; simulateStandalone: StartupNodeSimulation;
  filterTargetReverts?: boolean;
  onProgress?: (progress: Readonly<Record<string, number | string>>) => void;
  onObservation?: (observation: StartupPrefixObservation) => void;
}) {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1) throw new Error("invalid startup simulation concurrency");
  let complete = false, checkedSource = "";
  let activePolicy: number | undefined;
  let deferred = false;
  let continuationRestored = false;
  const reusable = new Map<string, { readonly key: string; readonly observation: StartupPrefixObservation }>();
  let changes = new Map<string, StartupContinuationState["rows"][number][1]>(), resetPending = false;
  const successful = new Set<string>();
  // All quotes in a published GraphView share this immutable topology. Index
  // it once rather than rebuilding a full-table Map for every SQL leg/amount.
  const publishedGraphs = new WeakMap<readonly TokenEdge[],ReadonlyMap<string,TokenEdge>>();
  const graphFor = (edges:readonly TokenEdge[]):ReadonlyMap<string,TokenEdge> => {
    const cached=publishedGraphs.get(edges);
    if(cached) return cached;
    const graph=new Map(edges.map(edge=>[blockScanEdgeKey(edge),edge]));
    assert.equal(graph.size,edges.length,"duplicate public leg ID in price graph");
    if(Object.isFrozen(edges) && edges.every(edge=>Object.isFrozen(edge) && !!edge.canonicalEdgeId)) publishedGraphs.set(edges,graph);
    return graph;
  };
  const issued = new Map<string, { sourceKey: string; requestKey: string; key?: string;
    observation: StartupPrefixObservation; result?: StartupEffectiveQuote }>();
  const usePolicy = (maxInputPathHops: number) => {
    if (activePolicy !== undefined && activePolicy !== maxInputPathHops) {
      complete = false; successful.clear(); reusable.clear(); issued.clear(); changes.clear(); resetPending = true;
    }
    activePolicy = maxInputPathHops;
  };
  return {
    reset() { complete = false; checkedSource = ""; successful.clear(); reusable.clear(); deferred = false; continuationRestored = false;
      issued.clear(); activePolicy = undefined; changes.clear(); resetPending = true; },
    takeContinuationDelta() {
      const delta = { reset: resetPending, rows: [...changes] };
      changes = new Map(); resetPending = false;
      return delta;
    },
    // Catch-up may postpone one-time filtering, never the execution that owns
    // a refreshed price. Otherwise resume would quote first and simulate again.
    defer(value: boolean) { deferred = value; },
    exportContinuation(): StartupContinuationState { return { version: 1, rows: [...reusable] }; },
    restoreContinuation(state: StartupContinuationState) {
      assert(!complete && reusable.size === 0 && state.version === 1 && Array.isArray(state.rows),
        "startup continuation requires a fresh preflight");
      for (const [id, entry] of state.rows) {
        assert(typeof id === "string" && !reusable.has(id) && /^0x[0-9a-f]{64}$/.test(entry.key) &&
          entry.observation.edgeId === id && ["success", "revert"].includes(String(entry.observation.status)),
        "invalid startup continuation observation");
        reusable.set(id, Object.freeze({ key: entry.key, observation: Object.freeze({ ...entry.observation }) }));
      }
      continuationRestored = true;
    },
    /** The existing startup transaction supplies both the price and execution
     * observation. The later preflight consumes this receipt, never resimulates
     * a successful price with the same source, input path and target. */
    async quoteEffective(work: {
      edge: TokenEdge; amountIn: bigint; source: CanonicalSource; reference: EffectiveAmountReference;
      maxInputPathHops: number; edges: readonly TokenEdge[]; control: AdapterWorkControl;
      prepareQuote(ids: ReadonlySet<string>): Promise<void>;
      sessionFor(edge: TokenEdge): StrictProductionRuntimeSession;
    }): Promise<StartupEffectiveQuote | undefined> {
      const maxInputPathHops = effectiveInputPathHops(work.maxInputPathHops);
      usePolicy(maxInputPathHops);
      // Completion and deferral govern the screening pass below. A new source
      // still prefers its funded execution receipt over a separate Exact call.
      const { source, edge, reference } = work;
      const open = () => {
        work.control.signal?.throwIfAborted();
        if (Date.now() >= (work.control.deadlineAtMs ?? Infinity))
          throw new StateCallAbortedError("startup execution price deadline", "deadline");
      };
      open();
      const graph = graphFor(work.edges);
      const edgeId = blockScanEdgeKey(edge), instanceKey = edgeInstanceKey(edge);
      assert(graph.size === work.edges.length && graph.get(edgeId) === edge &&
        work.amountIn > 0n && reference.amountIn === work.amountIn && reference.path.length <= maxInputPathHops,
      "invalid startup execution price input");
      let token = ADDR.WETH.toLowerCase(), output: bigint | undefined;
      const visited = new Set([token]);
      for (const step of reference.path) {
        const bound = graph.get(step.edgeId);
        assert(bound && !bound.leavesStandingPosition && step.instanceKey === edgeInstanceKey(bound) &&
          step.status === "quoted" && step.tokenIn.toLowerCase() === token &&
          step.tokenIn.toLowerCase() === bound.tokenIn.toLowerCase() && step.tokenOut.toLowerCase() === bound.tokenOut.toLowerCase() &&
          typeof step.amountIn === "bigint" && step.amountIn > 0n && typeof step.amountOut === "bigint" && step.amountOut > 0n &&
          (output === undefined || step.amountIn === output) && step.quotedAt && step.quotedAt.number <= source.number &&
          step.quotedAt.generation <= source.generation &&
          (step.quotedAt.number !== source.number || step.quotedAt.hash.toLowerCase() === source.hash.toLowerCase()) &&
          !visited.has(step.tokenOut.toLowerCase()), "invalid startup execution price lineage");
        token = step.tokenOut.toLowerCase(); visited.add(token); output = step.amountOut;
      }
      assert(token === edge.tokenIn.toLowerCase() && (output === undefined || output === work.amountIn),
        "startup execution price target does not follow lineage");
      const requestKey = digest({ source, maxInputPathHops, edgeId, instanceKey, amountIn: work.amountIn,
        reference: reference.path.map(rowFields) });
      const prior = issued.get(edgeId);
      if (prior?.requestKey === requestKey) {
        if (prior.result) return prior.result;
        throw startupPriceRevert(work,prior.observation);
      }
      const selected = [...reference.path.map(row => graph.get(row.edgeId)!), edge];
      await work.prepareQuote(new Set(selected.map(blockScanEdgeKey)));
      open();
      const compile = (value:TokenEdge, variantId?:string) => {
        const leg = work.sessionFor(value).buildRuntimeAmountLeg({ edge: value, executor: input.executor, runtimeEvidence: [], variantId });
        return leg && { tokenIn: value.tokenIn, tokenOut: value.tokenOut, program: leg.program };
      };
      const prefix = selected.slice(0,-1).map((value,i)=>compile(value,reference.path[i]!.executionVerification?.variantId));
      if (prefix.some(leg => !leg)) return undefined;
      const rootAmount = reference.path[0]?.amountIn ?? work.amountIn;
      const targetIndex = selected.length - 1;
      const session = work.sessionFor(edge);
      const variants = session.executionVariantIds?.(edge) ?? [undefined];
      let usedVariant:string|undefined, uncompiled = false, uncertainRevert = false;
      let result:Awaited<ReturnType<StartupNodeSimulation>>|undefined;
      for (const variantId of variants) {
        open();
        const targetLeg = compile(edge,variantId);
        if (!targetLeg) {uncompiled = true;continue;}
        result = await input.simulateStandalone({source,maxInputPathHops,control:work.control,
          callerAuthority:{executor:input.executor,transactionOrigin:input.transactionOrigin},
          amount:rootAmount,legs:[...prefix.map(leg=>leg!),targetLeg]});
        open();
        assert(result.targetBlock === source.number + 1, "startup execution price virtual source mismatch");
        usedVariant = variantId;
        if(result.kind==="success" || (result.failure && result.failure.hop!==targetIndex)) break;
        if(!result.failure) uncertainRevert = true;
      }
      if(!result) return undefined;
      const stage = result.kind === "success" ? "none" : result.failure === undefined ? "unattributed"
        : result.failure.hop < 0 ? "funding" : result.failure.hop === targetIndex ? "target" : "prefix";
      let priced: StartupEffectiveQuote | undefined, rows: readonly EffectiveMidRow[] | undefined;
      if (result.kind === "success") {
        assert(result.receipts.length === selected.length + 1 && result.receipts[0]!.hop === -1 &&
          result.receipts[0]!.amountIn === rootAmount && result.receipts[0]!.amountOut === rootAmount &&
          result.receipts[0]!.amountSpent === rootAmount, "startup execution price funding receipt mismatch");
        const quotedAt = Object.freeze({ ...source });
        const simulatedRows: EffectiveMidRow[] = [];
        for (const [index, value] of selected.entries()) {
          const receipt: StartupPrefixReceipt = result.receipts[index + 1]!;
          assert(receipt.hop === index && receipt.amountIn === result.receipts[index]!.amountOut &&
            receipt.amountIn > 0n && receipt.amountOut > 0n && receipt.amountSpent >= 0n && receipt.amountSpent <= receipt.amountIn,
          "startup execution price receipt continuity mismatch");
          const row: EffectiveMidRow = { edgeId: blockScanEdgeKey(value), instanceKey: edgeInstanceKey(value),
            tokenIn: value.tokenIn.toLowerCase(), tokenOut: value.tokenOut.toLowerCase(),
            amountIn: receipt.amountIn, amountOut: receipt.amountOut, amountSpent: receipt.amountSpent,
            effectiveMid: Number(receipt.amountOut) / Number(receipt.amountIn), status: "quoted" as const, quotedAt,
            pricingMethod: "startup-simulation" as const };
          const variantId=index===targetIndex?usedVariant:reference.path[index]!.executionVerification?.variantId;
          const executionVerification = Object.freeze({ kind: "startup-simulation" as const,
            ...(variantId===undefined?{}:{variantId}),
            targetBlock: result.targetBlock, scriptHash: result.scriptHash,
            receiptHash: effectiveExecutionReceiptHash(row,
              { amountIn: receipt.amountIn, path: simulatedRows }, maxInputPathHops, result.targetBlock, result.scriptHash,variantId) });
          simulatedRows.push(Object.freeze({ ...row, executionVerification }));
        }
        rows = Object.freeze(simulatedRows);
        const target = result.receipts.at(-1)!;
        priced = Object.freeze({ source: quotedAt, amountIn: target.amountIn, amountOut: target.amountOut,
          amountSpent: target.amountSpent, pricingMethod: "startup-simulation" as const,
          executionVerification: rows.at(-1)!.executionVerification!,
          inputReference: Object.freeze({ amountIn: target.amountIn, path: Object.freeze(rows.slice(0, -1)) }) });
      }
      if(priced && usedVariant!==undefined) session.confirmExecutionVariant(edge,usedVariant);
      const observation = Object.freeze({ sourceBlock: source.number, sourceBlockHash: source.hash,
        generation: source.generation, edgeId, instanceKey, mode: "observe-only", filterApplied: false,
        pricingMethod: "startup-simulation", expectedAmountIn: String(work.amountIn), expectedAmountOut: null,
        status: result.kind, failureStage: stage==="target" && (uncompiled || uncertainRevert) ? "unattributed" : stage, failedHop: result.failure?.hop ?? null,
        failedEdgeId: result.failure && result.failure.hop >= 0 ? blockScanEdgeKey(selected[result.failure.hop]!) : null,
        targetAttempted: result.kind === "success" || stage === "target" ? true : stage === "unattributed" ? null : false,
        prefixEdges: reference.path.map(step => step.edgeId), prefixCanAffectTargetState: reference.path.length > 0,
        targetInstanceInPrefix: reference.path.some(step => step.instanceKey === instanceKey), independentPriceEquivalent: false,
        rootAmount: String(rootAmount), actualAmountIn: priced ? String(priced.amountIn) : null,
        actualAmountOut: priced ? String(priced.amountOut) : null, actualAmountSpent: priced ? String(priced.amountSpent) : null,
        amountEvidence: priced ? "same-transaction" : "unavailable", amountMatches: priced ? priced.amountIn === work.amountIn : null,
        targetBlock: result.targetBlock, scriptHash: result.scriptHash, gasUsed: String(result.gasUsed),
        simulationMs: result.simulationMs, nodeQueueMs: result.nodeQueueMs,
        revertReasonHash: result.failure ? keccak256(result.failure.reason) : null,
        revertDataHash: result.kind === "revert" ? keccak256(result.returnData) : null });
      issued.set(edgeId, { requestKey, sourceKey: sourcePolicyKey(source, maxInputPathHops),
        key: rows && issuedKey(source, maxInputPathHops, rows), observation, result: priced });
      console.log(`[searcher/startup-prefix-observation] ${JSON.stringify(observation)}`);
      input.onObservation?.(observation);
      if (!priced) throw startupPriceRevert(work,observation);
      return priced;
    },
    async run(work: {
      effective: EffectiveMidSnapshot; edges: readonly TokenEdge[]; control: AdapterWorkControl;
      prepareQuote(ids: ReadonlySet<string>): Promise<void>;
      sessionFor(edge: TokenEdge): StrictProductionRuntimeSession;
    }): Promise<boolean> {
      const maxInputPathHops = effectiveInputPathHops(work.effective.maxInputPathHops);
      usePolicy(maxInputPathHops);
      if (deferred || complete || !work.effective.complete) return false;
      const { source } = work.effective;
      const sourceKey = sourcePolicyKey(source, maxInputPathHops);
      if (sourceKey !== checkedSource) { checkedSource = sourceKey; successful.clear(); }
      const graph = graphFor(work.edges);
      const priced = effectiveEnumerationMids({ sourceBlock: source.number, sourceBlockHash: source.hash,
        generation: source.generation, graph: { edges: work.edges }, effectiveMids: work.effective });
      const pending = [...priced.keys()].map(id => work.effective.rows.get(id)!);
      const verifiedThisRun: StartupPrefixObservation[] = [...issued.values()]
        .filter(value => value.sourceKey === sourceKey && !value.result).map(value => value.observation);
      const started = Date.now();
      const counts = { eligibleDirections: pending.length, checked: 0, succeeded: 0, reverted: 0,
        prefixReverted: 0, targetReverted: 0, fundingReverted: 0, unattributedReverted: 0,
        reusedSuccessful: 0, reusedReverted: 0, skippedFiltered: 0, skippedFilteredPrefix: 0, unsupported: 0, unavailable: 0,
        infrastructureFailures: 0, exactAmountMatches: 0, exactAmountMismatches: 0,
        replayedAmountMatches: 0, replayedAmountMismatches: 0, unknownAmounts: 0,
        targetInstanceInPrefix: 0, prefixDiagnosticSimulations: 0, prefixReplayDiverged: 0,
        simulationTotalMs: 0, nodeQueueTotalMs: 0, bindingTotalMs: 0, compilationTotalMs: 0 };
      const record = (row: EffectiveMidRow, fields: Record<string, unknown>) => {
        const observation = Object.freeze({ sourceBlock: source.number, sourceBlockHash: source.hash,
          generation: source.generation, edgeId: row.edgeId, instanceKey: row.instanceKey,
          expectedAmountIn: String(row.amountIn), expectedAmountOut: String(row.amountOut),
          mode: "observe-only", filterApplied: false, ...fields });
        console.log(`[searcher/startup-prefix-observation] ${JSON.stringify(observation)}`);
        input.onObservation?.(observation);
        return observation;
      };
      const report = (phase: string) => {
        const progress = Object.freeze({ sourceBlock: source.number, sourceBlockHash: source.hash,
          generation: source.generation, mode: "observe-only", executionBackend: "eth_simulateV1",
          targetRevertFilterEnabled: Number(input.filterTargetReverts === true),
          inputFundingMode: "native-prefix", maxInputPathHops, phase, ...counts,
          pending: pending.length - counts.checked - counts.reusedSuccessful - counts.reusedReverted - counts.skippedFiltered -
            counts.skippedFilteredPrefix - counts.unsupported - counts.unavailable,
          elapsedMs: Date.now() - started });
        console.log(`[searcher/startup-execution-preflight] ${JSON.stringify(progress)}`);
        input.onProgress?.(progress);
      };
      const open = () => {
        work.control.signal?.throwIfAborted();
        if (Date.now() >= (work.control.deadlineAtMs ?? Infinity)) throw new StateCallAbortedError("startup execution preflight deadline", "deadline");
      };
      const lineage = (row: EffectiveMidRow): readonly EffectiveMidRow[] | undefined => {
        const reference = effectiveRowAmountReference(row);
        if (!reference || reference.amountIn !== row.amountIn || reference.path.length > maxInputPathHops) return;
        const rows = [...reference.path, row];
        let token = ADDR.WETH.toLowerCase();
        for (const [i, step] of rows.entries()) {
          const edge = graph.get(step.edgeId);
          if (!edge || step.instanceKey !== edgeInstanceKey(edge) || step.status !== "quoted" ||
              step.tokenIn.toLowerCase() !== token || step.tokenIn.toLowerCase() !== edge.tokenIn.toLowerCase() ||
              step.tokenOut.toLowerCase() !== edge.tokenOut.toLowerCase() ||
              typeof step.amountIn !== "bigint" || step.amountIn <= 0n ||
              typeof step.amountOut !== "bigint" || step.amountOut <= 0n ||
              i > 0 && step.amountIn !== rows[i - 1]!.amountOut || !step.quotedAt ||
              step.quotedAt.number > source.number || step.quotedAt.generation > source.generation ||
              step.quotedAt.number === source.number && step.quotedAt.hash.toLowerCase() !== source.hash.toLowerCase()) return;
          token = step.tokenOut.toLowerCase();
        }
        return rows;
      };
      // Include BOTH the original amount lineage and today's observations for
      // every dependency. With amount cascading off, the old lineage alone
      // would miss a touched prefix whose current price has changed.
      const continuationKey = (rows: readonly EffectiveMidRow[]) => {
        return digest({ maxInputPathHops, rows: rows.map(row => [rowFields(row), rowFields(work.effective.rows.get(row.edgeId))]) });
      };
      const programs = new Map<string, string | null>();
      const diagnosticCache = new Map<string, ReturnType<StartupNodeSimulation>>();
      report("started");
      const timer = setInterval(() => report("running"), 5000);
      try {
        for (let offset = 0; offset < pending.length; offset += 64) {
          open();
          const batch: { row: EffectiveMidRow; rows: readonly EffectiveMidRow[] }[] = [];
          for (const row of pending.slice(offset, offset + 64)) {
            if (input.simRejects.hasPool(graph.get(row.edgeId)!)) { counts.skippedFiltered++; record(row, { status: "filtered-by-existing-live-sim" }); continue; }
            const rows = lineage(row);
            if (!rows) { counts.unavailable++; record(row, { status: "unverified", reason: "recorded-lineage-unavailable" }); continue; }
            if (rows.slice(0, -1).some(step => input.simRejects.hasPool(graph.get(step.edgeId)!))) {
              counts.skippedFilteredPrefix++; record(row, { status: "prefix-filtered-by-existing-live-sim" }); continue;
            }
            const shared = issued.get(row.edgeId);
            if (shared?.result && shared.sourceKey === sourceKey && shared.key === issuedKey(source, maxInputPathHops, rows)) {
              counts.reusedSuccessful++;
              const observation = Object.freeze({ ...shared.observation, reused: true,
                reusePolicy: "same-startup-simulation-price" });
              reusable.set(row.edgeId, Object.freeze({ key: continuationKey(rows), observation }));
              changes.set(row.edgeId, reusable.get(row.edgeId)!);
              verifiedThisRun.push(observation);
              input.onObservation?.(observation);
              continue;
            }
            const cached = reusable.get(row.edgeId);
            if (continuationRestored && cached?.key === continuationKey(rows)) {
              if (cached.observation.status === "success") counts.reusedSuccessful++;
              else counts.reusedReverted++;
              // Preserve the actual old evidence source; the new source is
              // only where unchanged dependencies were checked for reuse.
              const observation = Object.freeze({ ...cached.observation, reused: true,
                reuseCheckedAt: source, reusePolicy: "unchanged-effective-and-prefix-observations" });
              console.log(`[searcher/startup-prefix-observation] ${JSON.stringify(observation)}`);
              input.onObservation?.(observation);
              verifiedThisRun.push(observation);
              continue;
            }
            batch.push({ row, rows });
          }
          if (!batch.length) continue;
          const binding = performance.now();
          await work.prepareQuote(new Set(batch.flatMap(item => item.rows.map(row => row.edgeId))));
          counts.bindingTotalMs += performance.now() - binding;
          let cursor = 0, failure: unknown;
          await Promise.all(Array.from({ length: Math.min(input.concurrency, batch.length) }, async () => {
            while (cursor < batch.length && failure === undefined) {
              const { row, rows } = batch[cursor++]!;
              try {
                open();
                if (input.simRejects.hasPool(graph.get(row.edgeId)!)) {
                  counts.skippedFiltered++; record(row, { status: "filtered-by-existing-live-sim" }); continue;
                }
                if (rows.slice(0, -1).some(step => input.simRejects.hasPool(graph.get(step.edgeId)!))) {
                  counts.skippedFilteredPrefix++; record(row, { status: "prefix-filtered-by-existing-live-sim" }); continue;
                }
                const compileStarted = performance.now();
                const legs = rows.map(step => {
                  const variantId=step.executionVerification?.variantId;
                  const cacheKey=JSON.stringify([step.edgeId,variantId??null]);
                  if (!programs.has(cacheKey)) {
                    const edge = graph.get(step.edgeId)!;
                    programs.set(cacheKey, work.sessionFor(edge).buildRuntimeAmountLeg({ edge,
                      executor: input.executor, runtimeEvidence: [],variantId })?.program ?? null);
                  }
                  return { tokenIn: step.tokenIn, tokenOut: step.tokenOut, program: programs.get(cacheKey) };
                });
                counts.compilationTotalMs += performance.now() - compileStarted;
                if (legs.some(leg => leg.program === null)) {
                  counts.unsupported++; record(row, { status: "unsupported", reason: "production-runtime-leg-unavailable" }); continue;
                }
                const invocation = { source, control: work.control, maxInputPathHops,
                  callerAuthority: { executor: input.executor, transactionOrigin: input.transactionOrigin },
                  amount: rows[0]!.amountIn!, legs: legs.map(leg => ({ ...leg, program: leg.program! })) };
                const checkKey = digest({ source, amount: invocation.amount, legs: invocation.legs, expectedAmount: row.amountIn });
                if (successful.has(checkKey)) { counts.reusedSuccessful++; record(row, { status: "reused-success" }); continue; }
                const overlap = rows.slice(0, -1).some(step => step.instanceKey === row.instanceKey);
                counts.targetInstanceInPrefix += Number(overlap);
                const result = await input.simulateStandalone(invocation);
                open();
                counts.simulationTotalMs += result.simulationMs; counts.nodeQueueTotalMs += result.nodeQueueMs;
                let actualIn = result.receipts.at(-1)?.amountIn;
                let amountEvidence: "same-transaction" | "prefix-replay" | "unavailable" = actualIn === undefined ? "unavailable" : "same-transaction";
                const targetIndex = rows.length - 1;
                const stage = result.kind === "success" ? "none" : result.failure === undefined ? "unattributed"
                  : result.failure.hop < 0 ? "funding" : result.failure.hop === targetIndex ? "target" : "prefix";
                // Reverted transactions erase receipts. A separately labelled,
                // cached replay of the identical input prefix can recover an
                // input estimate, never fabricate a receipt from the failed tx.
                if (stage === "target") {
                  const prefix = { ...invocation, legs: invocation.legs.slice(0, -1) };
                  const key = digest({ source, amount: prefix.amount, legs: prefix.legs });
                  let diagnostic = diagnosticCache.get(key);
                  if (!diagnostic) {
                    counts.prefixDiagnosticSimulations++;
                    diagnostic = input.simulateStandalone(prefix);
                    diagnosticCache.set(key, diagnostic);
                    void diagnostic.catch(() => diagnosticCache.delete(key));
                  }
                  const replay = await diagnostic;
                  open();
                  if (replay.kind === "success") { actualIn = replay.receipts.at(-1)!.amountOut; amountEvidence = "prefix-replay"; }
                  else counts.prefixReplayDiverged++;
                }
                if (actualIn === undefined) counts.unknownAmounts++;
                else if (amountEvidence === "same-transaction") {
                  if (actualIn === row.amountIn) counts.exactAmountMatches++; else counts.exactAmountMismatches++;
                } else if (actualIn === row.amountIn) counts.replayedAmountMatches++; else counts.replayedAmountMismatches++;
                if (result.kind === "success") { counts.succeeded++; successful.add(checkKey); }
                else {
                  counts.reverted++;
                  if (stage === "target") counts.targetReverted++;
                  else if (stage === "prefix") counts.prefixReverted++;
                  else if (stage === "funding") counts.fundingReverted++;
                  else counts.unattributedReverted++;
                }
                // A replay of the stored receipt tests that exact private
                // encoding, not its siblings. Do not poison the public ID.
                const replayScope=stage==="target" && (work.sessionFor(graph.get(row.edgeId)!).executionVariantIds?.(graph.get(row.edgeId)!)?.length??1)>1
                  ? "target-encoding-only" : stage;
                const observation = record(row, { status: result.kind, failureStage: replayScope, failedHop: result.failure?.hop ?? null,
                  failedEdgeId: result.failure && result.failure.hop >= 0 ? rows[result.failure.hop]?.edgeId ?? null : null,
                  targetAttempted: result.kind === "success" || stage === "target" ? true : stage === "unattributed" ? null : false,
                  prefixEdges: rows.slice(0, -1).map(step => step.edgeId), targetInstanceInPrefix: overlap,
                  prefixCanAffectTargetState: rows.length > 1, independentPriceEquivalent: false,
                  rootAmount: String(invocation.amount), actualAmountIn: actualIn === undefined ? null : String(actualIn),
                  amountEvidence, amountMatches: actualIn === undefined ? null : actualIn === row.amountIn,
                  actualAmountOut: result.kind === "success" ? String(result.receipts.at(-1)!.amountOut) : null,
                  actualAmountSpent: result.kind === "success" ? String(result.receipts.at(-1)!.amountSpent) : null,
                  targetBlock: result.targetBlock, scriptHash: result.scriptHash, gasUsed: String(result.gasUsed),
                  simulationMs: result.simulationMs, nodeQueueMs: result.nodeQueueMs,
                  revertReasonHash: result.failure ? keccak256(result.failure.reason) : null,
                  revertDataHash: result.kind === "revert" ? keccak256(result.returnData) : null });
                reusable.set(row.edgeId, Object.freeze({ key: continuationKey(rows), observation }));
                changes.set(row.edgeId, reusable.get(row.edgeId)!);
                verifiedThisRun.push(observation);
                counts.checked++;
              } catch (error) {
                counts.infrastructureFailures++; failure ??= error;
                record(row, { status: "infrastructure-or-cancelled", reason: error instanceof StateCallAbortedError ? "cancelled" : "execution-or-observation-failed" });
              }
            }
          }));
          if (failure !== undefined) throw failure;
        }
        open();
        const filtersAdded = applyStartupTargetFilters({ enabled: input.filterTargetReverts === true,
          rows: verifiedThisRun, edges: work.edges,
          cache: input.simRejects,
          record: event => console.log(`[searcher/startup-pool-filter] ${JSON.stringify(event)}`) });
        complete = true;
        report(counts.unavailable || counts.unsupported || counts.unattributedReverted ? "completed-with-unverified" : "completed");
        successful.clear();
        return filtersAdded > 0;
      } catch (error) { report("interrupted"); throw error; }
      finally { clearInterval(timer); }
    },
  };
}
