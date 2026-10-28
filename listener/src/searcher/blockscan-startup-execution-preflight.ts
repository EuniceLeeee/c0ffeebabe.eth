import { keccak256, toUtf8Bytes } from "ethers";
import assert from "node:assert/strict";
import { ADDR } from "../shared/constants/addresses.js";
import { effectiveEnumerationMids, effectiveRowAmountReference, MAX_EFFECTIVE_INPUT_PATH_HOPS,
  type EffectiveMidSnapshot, type EffectiveMidRow } from "./blockscan-effective-mid.js";
import type { BlockScanSimRejectCache } from "./blockscan-sim-reject-cache.js";
import type { TokenEdge } from "./planner/token-graph.js";
import type { StartupNodeSimulation } from "./blockscan-startup-node-simulation.js";
import type { StrictProductionRuntimeSession } from "./strict-production-runtime-session.js";
import type { AdapterWorkControl } from "./adapter-work-intent.js";
import { blockScanEdgeKey } from "./venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "./venues/route-instance-identity.js";
import { StateCallAbortedError } from "../shared/state/state-backend.js";
import { applyStartupTargetFilters } from "./blockscan-startup-filter.js";

export type StartupExecutionPreflight = ReturnType<typeof createBlockScanStartupExecutionPreflight>;
export type StartupPrefixObservation = Readonly<Record<string, unknown>>;
export interface StartupContinuationState {
  readonly version: 1;
  readonly rows: readonly (readonly [string, { readonly key: string; readonly observation: StartupPrefixObservation }])[];
}
const digest = (value: unknown) => keccak256(toUtf8Bytes(JSON.stringify(value,
  (_, v) => typeof v === "bigint" ? v.toString() : v)));

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
  let deferred = false;
  let continuationRestored = false;
  const reusable = new Map<string, { readonly key: string; readonly observation: StartupPrefixObservation }>();
  let changes = new Map<string, StartupContinuationState["rows"][number][1]>(), resetPending = false;
  const successful = new Set<string>();
  return {
    reset() { complete = false; checkedSource = ""; successful.clear(); reusable.clear(); deferred = false; continuationRestored = false;
      changes.clear(); resetPending = true; },
    takeContinuationDelta() {
      const delta = { reset: resetPending, rows: [...changes] };
      changes = new Map(); resetPending = false;
      return delta;
    },
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
    async run(work: {
      effective: EffectiveMidSnapshot; edges: readonly TokenEdge[]; control: AdapterWorkControl;
      prepareQuote(ids: ReadonlySet<string>): Promise<void>;
      sessionFor(edge: TokenEdge): StrictProductionRuntimeSession;
    }): Promise<boolean> {
      if (deferred || complete || !work.effective.complete) return false;
      const { source } = work.effective;
      const sourceKey = `${source.number}:${source.hash.toLowerCase()}:${source.generation}`;
      if (sourceKey !== checkedSource) { checkedSource = sourceKey; successful.clear(); }
      const graph = new Map(work.edges.map(edge => [blockScanEdgeKey(edge), edge]));
      const priced = effectiveEnumerationMids({ sourceBlock: source.number, sourceBlockHash: source.hash,
        generation: source.generation, graph: { edges: work.edges }, effectiveMids: work.effective });
      const pending = [...priced.keys()].map(id => work.effective.rows.get(id)!);
      const verifiedThisRun: StartupPrefixObservation[] = [];
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
          inputFundingMode: "native-prefix", phase, ...counts,
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
        if (!reference || reference.amountIn !== row.amountIn || reference.path.length > MAX_EFFECTIVE_INPUT_PATH_HOPS) return;
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
        const fields = (row: EffectiveMidRow | undefined) => row && [
          row.edgeId, row.instanceKey, row.tokenIn, row.tokenOut,
          row.amountIn, row.amountOut, row.status, row.quotedAt,
        ];
        return digest(rows.map(row => [fields(row), fields(work.effective.rows.get(row.edgeId))]));
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
                  if (!programs.has(step.edgeId)) {
                    const edge = graph.get(step.edgeId)!;
                    programs.set(step.edgeId, work.sessionFor(edge).buildRuntimeAmountLeg({ edge,
                      executor: input.executor, runtimeEvidence: [] })?.program ?? null);
                  }
                  return { tokenIn: step.tokenIn, tokenOut: step.tokenOut, program: programs.get(step.edgeId) };
                });
                counts.compilationTotalMs += performance.now() - compileStarted;
                if (legs.some(leg => leg.program === null)) {
                  counts.unsupported++; record(row, { status: "unsupported", reason: "production-runtime-leg-unavailable" }); continue;
                }
                const invocation = { source, control: work.control,
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
                const observation = record(row, { status: result.kind, failureStage: stage, failedHop: result.failure?.hop ?? null,
                  failedEdgeId: result.failure && result.failure.hop >= 0 ? rows[result.failure.hop]?.edgeId ?? null : null,
                  targetAttempted: result.kind === "success" || stage === "target" ? true : stage === "unattributed" ? null : false,
                  prefixEdges: rows.slice(0, -1).map(step => step.edgeId), targetInstanceInPrefix: overlap,
                  prefixCanAffectTargetState: rows.length > 1, independentPriceEquivalent: false,
                  rootAmount: String(invocation.amount), actualAmountIn: actualIn === undefined ? null : String(actualIn),
                  amountEvidence, amountMatches: actualIn === undefined ? null : actualIn === row.amountIn,
                  actualAmountOut: result.kind === "success" ? String(result.receipts.at(-1)!.amountOut) : null,
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
