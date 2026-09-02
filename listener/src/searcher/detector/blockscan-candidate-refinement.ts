import { setMaxListeners } from "node:events";
import {
  isStateCallAbortedError,
  type StateBackend,
  withStateCallControl,
} from "../../shared/state/state-backend.js";
import type { BlockScanOpportunity } from "./detector.js";
import { BLOCKSCAN_MIN_EXECUTABLE_INPUT } from "./blockscan-sizing-constants.js";
import {
  BlockScanFamilyAttributedError,
  BlockScanFamilyStageBudget,
  type BlockScanCircuitAttribution,
  blockScanEdgeFamilyId,
  blockScanFailureCircuitAttribution,
  blockScanRouteFamilyIds,
} from "./blockscan-family-budget.js";
import type { StrictProductionRuntimeSession } from
  "../strict-production-runtime-session.js";
import type { RuntimeEvidence } from
  "../venues/adapter-family-plugin.js";

const DEFAULT_CONCURRENCY = 24;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

export interface BlockScanRefinementResult {
  opportunities: BlockScanOpportunity[];
  concurrencyLimit: number;
  peakConcurrentProbes: number;
  attempted: number;
  positive: number;
  negative: number;
  failed: number;
  deadlineHit: boolean;
  shadow?: BlockScanRefinementShadow;
  openFamilyIds: readonly string[];
  openInstanceCircuitKeys: readonly string[];
  openCompositeKeys: readonly string[];
}

export interface BlockScanRefinementShadow {
  readonly admissionSpreadBps: number;
  readonly admitted: BlockScanShadowBand;
  readonly notAdmitted: BlockScanShadowBand;
  readonly wouldRejectCapital: BlockScanShadowBand;
  readonly familyOutcomes: Readonly<
    Record<string, BlockScanShadowBand>
  >;
  readonly admittedSpreadBuckets: {
    readonly "floor-2x": BlockScanShadowBand;
    readonly "2x-5x": BlockScanShadowBand;
    readonly "5x-10x": BlockScanShadowBand;
    readonly "10x+": BlockScanShadowBand;
  };
}

export interface BlockScanShadowBand {
  total: number;
  positive: number;
  negative: number;
  failed: number;
  unprobed: number;
  positiveMaxInputMin?: string | null;
  positiveMaxInputMax?: string | null;
}

export interface BlockScanProbeDiagnostic {
  index: number;
  status: "positive" | "negative" | "failed" | "unprobed";
  marginBps: number | null;
  attempted: boolean;
  failure: BlockScanProbeFailureDiagnostic | null;
}

export interface BlockScanProbeFailureDiagnostic {
  readonly reason:
    | "family_circuit_open"
    | "instance_circuit_open"
    | "composite_circuit_open"
    | "probe_timeout"
    | "global_deadline"
    | "quote_error";
  readonly familyIds: readonly string[];
  readonly attributedFamilyId: string | null;
  readonly attributedInstanceCircuitKey: string | null;
  readonly blockingCircuitScope:
    | BlockScanCircuitAttribution["scope"]
    | null;
  readonly stage: string | null;
  readonly causeName: string | null;
  readonly causeCode: string | null;
  readonly causeKind: string | null;
}

export interface BlockScanRefinementOptions {
  /** Uniform deadline for each exact route probe. */
  readonly probeTimeoutMs?: number;
  /**
   * Hard exact admission floor in bps. Candidates whose coarse spread clears
   * the floor are probed; the rest are skipped and counted in
   * shadow.notAdmitted (exact_not_admitted) without executing any quote.
   * When omitted every candidate is probed (legacy behavior).
   */
  readonly admissionSpreadBps?: number;
  /**
   * Shadow capital floor (maxInput / maxBorrow). When set, refinement splits
   * probe outcomes by whether the candidate would be rejected by the floor,
   * without removing any candidate. Calibrates the floor from real exact
   * outcomes instead of guessing.
   */
  readonly minCapitalFraction?: number;
  /**
   * Production execution contract used by route families whose quote depends
   * on caller-observable balance deltas. Other families ignore it through the
   * shared QuoteContext.
   */
  readonly executor?: string;
  /** Sole current-source exact authority for this route pass. */
  readonly strictSession?: StrictProductionRuntimeSession;
  /** Plugin-issued evidence bound to that exact source/session. */
  readonly runtimeEvidence?: readonly RuntimeEvidence[];
  /** Caller-owned pass cancellation. */
  readonly signal?: AbortSignal;
}

interface RankedProbe {
  opportunity: BlockScanOpportunity;
  marginBps: number;
  priority: number;
  index: number;
}

class ProbeDeadlineError extends Error {}
class ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `block-scan exact probe exceeded ${timeoutMs}ms`,
    );
    this.name = "ProbeTimeoutError";
  }
}

/**
 * Cheap exact route probe before GSS/final-sim. Quotes every leg through the
 * production dispatcher without the approximate pool cache, then keeps the
 * highest normalized expected returns. Deadline-unprobed routes remain
 * fallback entries; exact failures and routes proven non-positive fail closed.
 */
export async function refineBlockScanCandidates(
  state: StateBackend,
  opportunities: readonly BlockScanOpportunity[],
  maxCandidates: number,
  deadlineAtMs: number,
  pricedTokens: ReadonlyMap<string, { maxBorrow: bigint }>,
  onProbe?: (diagnostic: BlockScanProbeDiagnostic) => void,
  concurrency = DEFAULT_CONCURRENCY,
  options: BlockScanRefinementOptions = {},
): Promise<BlockScanRefinementResult> {
  // The central scheduler owns one global work queue. Family IDs remain
  // opaque attribution data only; they must not create separate queues or
  // concurrency quotas.
  let work = opportunities.map((opportunity, index) => ({ opportunity, index }));
  const ranked: RankedProbe[] = [];
  const fallback: Array<{ opportunity: BlockScanOpportunity; index: number }> = [];
  const stageBudget = new BlockScanFamilyStageBudget();
  let attempted = 0;
  let negative = 0;
  let failed = 0;
  let deadlineHit = false;
  const shadow =
    options.admissionSpreadBps === undefined
      ? null
      : {
          admissionSpreadBps: options.admissionSpreadBps,
          admitted: emptyShadowBand(),
          notAdmitted: emptyShadowBand(),
          wouldRejectCapital: emptyShadowBand(),
          familyOutcomes: {} as Record<string, BlockScanShadowBand>,
          admittedSpreadBuckets: {
            "floor-2x": emptyShadowBand(),
            "2x-5x": emptyShadowBand(),
            "5x-10x": emptyShadowBand(),
            "10x+": emptyShadowBand(),
          },
        };
  if (shadow) {
    const admitted: typeof work = [];
    for (const item of work) {
      const spread = item.opportunity.coarseSpreadBps;
      if (typeof spread === "number" && spread < shadow.admissionSpreadBps) {
        // exact_not_admitted: keep the funnel count, never execute a quote.
        shadow.notAdmitted.total++;
      } else {
        admitted.push(item);
      }
    }
    work = admitted;
  }
  const routeFamilyIds = (
    opportunity: BlockScanOpportunity,
  ): readonly string[] => {
    const ids = blockScanRouteFamilyIds(opportunity.seedEdges);
    return ids.length > 0 ? ids : ["<unowned-family>"];
  };
  const familyBand = (familyId: string): BlockScanShadowBand => {
    let band = shadow!.familyOutcomes[familyId];
    if (!band) {
      band = emptyShadowBand();
      shadow!.familyOutcomes[familyId] = band;
    }
    return band;
  };
  const wouldRejectCapital = (
    opportunity: BlockScanOpportunity,
  ): boolean => {
    if (
      !shadow ||
      options.minCapitalFraction === undefined ||
      options.minCapitalFraction <= 0
    ) return false;
    const maxBorrow =
      pricedTokens.get(opportunity.flashToken.toLowerCase())?.maxBorrow ?? 0n;
    const maxInput = opportunity.coarseMaxInput;
    if (typeof maxInput !== "bigint" || maxBorrow <= 0n) return false;
    return Number(maxInput) / Number(maxBorrow) <
      options.minCapitalFraction;
  };
  const recordPositiveMaxInput = (
    band: BlockScanShadowBand,
    opportunity: BlockScanOpportunity,
  ): void => {
    if (typeof opportunity.coarseMaxInput !== "bigint") return;
    const value = opportunity.coarseMaxInput;
    const currentMin =
      band.positiveMaxInputMin === undefined ||
      band.positiveMaxInputMin === null
        ? value
        : value < BigInt(band.positiveMaxInputMin)
          ? value
          : BigInt(band.positiveMaxInputMin);
    const currentMax =
      band.positiveMaxInputMax === undefined ||
      band.positiveMaxInputMax === null
        ? value
        : value > BigInt(band.positiveMaxInputMax)
          ? value
          : BigInt(band.positiveMaxInputMax);
    band.positiveMaxInputMin = currentMin.toString();
    band.positiveMaxInputMax = currentMax.toString();
  };
  const recordShadow = (
    opportunity: BlockScanOpportunity,
    status: "positive" | "negative" | "failed" | "unprobed",
  ): void => {
    if (!shadow) return;
    shadow.admitted[status]++;
    if (wouldRejectCapital(opportunity)) {
      shadow.wouldRejectCapital[status]++;
    }
    for (const familyId of routeFamilyIds(opportunity)) {
      const band = familyBand(familyId);
      band[status]++;
      if (status === "positive") {
        recordPositiveMaxInput(band, opportunity);
      }
    }
    if (status === "positive") {
      recordPositiveMaxInput(shadow.admitted, opportunity);
    }
    const spread = opportunity.coarseSpreadBps;
    if (typeof spread === "number") {
      const floor = shadow.admissionSpreadBps;
      const bucket =
        spread >= 10 * floor
          ? "10x+"
          : spread >= 5 * floor
            ? "5x-10x"
            : spread >= 2 * floor
              ? "2x-5x"
              : "floor-2x";
      const bucketBand = shadow.admittedSpreadBuckets[bucket];
      bucketBand[status]++;
      if (status === "positive") {
        recordPositiveMaxInput(bucketBand, opportunity);
      }
    }
  };
  const recordShadowTotal = (opportunity: BlockScanOpportunity): void => {
    if (!shadow) return;
    shadow.admitted.total++;
    if (wouldRejectCapital(opportunity)) {
      shadow.wouldRejectCapital.total++;
    }
    for (const familyId of routeFamilyIds(opportunity)) {
      familyBand(familyId).total++;
    }
    const spread = opportunity.coarseSpreadBps;
    if (typeof spread === "number") {
      const floor = shadow.admissionSpreadBps;
      const bucket =
        spread >= 10 * floor
          ? "10x+"
          : spread >= 5 * floor
            ? "5x-10x"
            : spread >= 2 * floor
              ? "2x-5x"
              : "floor-2x";
      shadow.admittedSpreadBuckets[bucket].total++;
    }
  };
  const workerCount = Math.max(1, Math.min(concurrency, work.length));
  const probeTimeoutMs = positiveInteger(
    options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    "probe timeout",
  );
  const deadlineController = new AbortController();
  const detachCaller = options.signal
    ? linkAbort(options.signal, deadlineController)
    : () => {};
  // One shared signal owns every in-flight worker call. Each call removes its
  // listener in finally; lift EventTarget's warning threshold for this bounded
  // fan-out so 24 legitimate workers do not emit a false leak warning.
  setMaxListeners(workerCount * 2 + 1, deadlineController.signal);
  const deadlineDelayMs = deadlineAtMs - Date.now();
  if (deadlineDelayMs <= 0) {
    deadlineController.abort(new ProbeDeadlineError("exact probe deadline reached"));
  }
  const deadlineTimer = deadlineDelayMs > 0
    ? setTimeout(
        () => deadlineController.abort(new ProbeDeadlineError("exact probe deadline reached")),
        deadlineDelayMs,
      )
    : undefined;
  const pending = [...work];
  const active = new Set<Promise<void>>();
  let peakConcurrentProbes = 0;
  const routeFamilies = (opportunity: BlockScanOpportunity): readonly string[] => {
    const familyIds = blockScanRouteFamilyIds(opportunity.seedEdges);
    return familyIds.length > 0 ? familyIds : ["<unowned-family>"];
  };
  const claimNext = (): typeof work[number] | null => {
    for (let index = 0; index < pending.length;) {
      const item = pending[index];
      if (stageBudget.blocks(item.opportunity.seedEdges)) {
        // A success already in flight for the same dependency set may clear a
        // circuit opened by earlier siblings. Keep the candidate pending until
        // every active probe settles; otherwise scheduling order permanently
        // drops a healthy route even though the final circuit is closed.
        index++;
        continue;
      }
      pending.splice(index, 1);
      return item;
    }
    return null;
  };
  const dropBlockedWithoutRecoveryPath = (): number => {
    let dropped = 0;
    for (let index = 0; index < pending.length;) {
      const item = pending[index];
      if (!stageBudget.blocks(item.opportunity.seedEdges)) {
        index++;
        continue;
      }
      pending.splice(index, 1);
      failed++;
      dropped++;
      recordShadowTotal(item.opportunity);
      recordShadow(item.opportunity, "failed");
      const blocking = stageBudget.blockingCircuit(
        item.opportunity.seedEdges,
      );
      if (!blocking) {
        throw new Error("block-scan circuit state changed while dropping work");
      }
      onProbe?.({
        index: item.index,
        status: "failed",
        marginBps: null,
        attempted: false,
        failure: probeCircuitDiagnostic(
          blocking,
          routeFamilies(item.opportunity),
        ),
      });
    }
    return dropped;
  };
  const probeOne = async (
    item: typeof work[number],
    familyIds: readonly string[],
  ): Promise<void> => {
    const { opportunity, index } = item;
    const probeController = new AbortController();
    const detachGlobal = linkAbort(
      deadlineController.signal,
      probeController,
    );
    const startedAtMs = Date.now();
    const localBudgetMs = Math.min(
      probeTimeoutMs,
      Math.max(0, deadlineAtMs - startedAtMs),
    );
    const probeDeadlineAtMs = Math.min(
      deadlineAtMs,
      startedAtMs + localBudgetMs,
    );
    let localTimedOut = false;
    const probeTimer = probeDeadlineAtMs < deadlineAtMs
      ? setTimeout(() => {
          localTimedOut = true;
          probeController.abort(new ProbeTimeoutError(localBudgetMs));
        }, Math.max(0, probeDeadlineAtMs - Date.now()))
      : undefined;
    const controlledState = withStateCallControl(state, {
      deadlineAtMs: probeDeadlineAtMs,
      signal: probeController.signal,
    });
    attempted++;
    recordShadowTotal(opportunity);
    try {
      const probeStartedAtMs = Date.now();
      const probe = exactProbeMarginBps(
        controlledState,
        opportunity,
        probeDeadlineAtMs,
        probeController.signal,
        options.executor,
        options.strictSession,
        options.runtimeEvidence,
        () =>
          probeDeadlineAtMs < deadlineAtMs
          ? new ProbeTimeoutError(localBudgetMs)
            : new ProbeDeadlineError("exact probe deadline reached"),
        (edge) => stageBudget.recordEdgeSuccess(edge),
        () => stageBudget.recordRouteSuccess(opportunity.seedEdges),
      );
      const marginBps = await probe;
      const probeWallMs = Date.now() - probeStartedAtMs;
      if (probeWallMs > 100) {
        console.log(
          "[exact-probe] idx=" + index +
            " wallMs=" + probeWallMs +
            " families=" + familyIds.join(","),
        );
      }
      if (deadlineController.signal.aborted || Date.now() >= deadlineAtMs) {
        throw new ProbeDeadlineError("exact probe deadline reached");
      }
      if (probeController.signal.aborted || Date.now() >= probeDeadlineAtMs) {
        localTimedOut = true;
        throw probeController.signal.reason ?? new ProbeTimeoutError(localBudgetMs);
      }
      if (marginBps > 0) {
        // The exact admission probe is deliberately cheap: it prices one
        // small executable amount (ceiling / 1024).  Preserve that amount as
        // the solver's search anchor.  The coarse scanner's center is a
        // capacity estimate, not evidence that this much capital remains
        // profitable; restoring it here can move the solver ~1000x away from
        // the only amount that just passed exact admission.
        const probeAmount = exactProbeAmount(opportunity);
        const anchoredOpportunity: BlockScanOpportunity = {
          ...opportunity,
          searchSeed: {
            ...opportunity.searchSeed,
            searchCenter: probeAmount,
          },
        };
        ranked.push({
          opportunity: anchoredOpportunity,
          marginBps,
          priority: exactProbePriority(opportunity, marginBps, pricedTokens),
          index,
        });
        recordShadow(opportunity, "positive");
        onProbe?.({
          index,
          status: "positive",
          marginBps,
          attempted: true,
          failure: null,
        });
      } else {
        negative++;
        recordShadow(opportunity, "negative");
        onProbe?.({
          index,
          status: "negative",
          marginBps,
          attempted: true,
          failure: null,
        });
      }
    } catch (error) {
      if (
        error instanceof ProbeTimeoutError ||
        (
          probeDeadlineAtMs < deadlineAtMs &&
          Date.now() >= probeDeadlineAtMs &&
          !deadlineController.signal.aborted
        )
      ) {
        localTimedOut = true;
      }
      const probeCause = error instanceof BlockScanFamilyAttributedError
        ? error.failureCause
        : error;
      const globalDeadline =
        deadlineController.signal.aborted ||
        (!localTimedOut && Date.now() >= deadlineAtMs) ||
        error instanceof ProbeDeadlineError;
      if (
        globalDeadline ||
        (!localTimedOut &&
          isStateCallAbortedError(probeCause) &&
          probeCause.kind !== "timeout")
      ) {
        deadlineHit = true;
        fallback.push({ opportunity, index });
        recordShadow(opportunity, "unprobed");
        onProbe?.({
          index,
          status: "unprobed",
          marginBps: null,
          attempted: true,
          failure: probeFailureDiagnostic(
            "global_deadline",
            familyIds,
            error,
          ),
        });
      } else {
        failed++;
        recordShadow(opportunity, "failed");
        const budgetError =
          localTimedOut &&
            familyIds.length === 1 &&
            !(error instanceof BlockScanFamilyAttributedError)
            ? new BlockScanFamilyAttributedError(
                familyIds[0],
                "exact probe timeout",
                error,
              )
            : error;
        console.log(
          "[exact-probe-fail] idx=" + index +
            " families=" + familyIds.join(",") +
            " reason=" + (localTimedOut ? "probe_timeout" : "quote_error") +
            " error=" + (error instanceof Error
              ? error.message.slice(0, 400)
              : String(error)),
        );
        stageBudget.recordFailure(opportunity.seedEdges, budgetError);
        onProbe?.({
          index,
          status: "failed",
          marginBps: null,
          attempted: true,
          failure: probeFailureDiagnostic(
            localTimedOut ? "probe_timeout" : "quote_error",
            familyIds,
            budgetError,
            opportunity.seedEdges,
          ),
        });
      }
    } finally {
      if (probeTimer !== undefined) clearTimeout(probeTimer);
      detachGlobal();
    }
  };
  try {
    while (pending.length > 0 || active.size > 0) {
      if (
        deadlineController.signal.aborted ||
        Date.now() >= deadlineAtMs
      ) {
        deadlineHit = true;
        for (const item of pending.splice(0)) {
          fallback.push(item);
          recordShadowTotal(item.opportunity);
          recordShadow(item.opportunity, "unprobed");
          onProbe?.({
            index: item.index,
            status: "unprobed",
            marginBps: null,
            attempted: false,
            failure: probeFailureDiagnostic(
              "global_deadline",
              routeFamilies(item.opportunity),
            ),
          });
        }
      }
      while (
        !deadlineController.signal.aborted &&
        Date.now() < deadlineAtMs &&
        active.size < workerCount
      ) {
        const item = claimNext();
        if (!item) break;
        const familyIds = routeFamilies(item.opportunity);
        const task = probeOne(item, familyIds);
        active.add(task);
        peakConcurrentProbes = Math.max(
          peakConcurrentProbes,
          active.size,
        );
        void task.then(
          () => active.delete(task),
          () => active.delete(task),
        );
      }
      if (active.size > 0) {
        await Promise.race(active);
      } else if (pending.length > 0) {
        // With no active probe left, no future success can close a circuit.
        // Only now is a blocked pending route definitively unavailable.
        if (dropBlockedWithoutRecoveryPath() === 0) {
          throw new Error("block-scan family refinement scheduler deadlocked");
        }
      }
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    await Promise.allSettled(active);
    detachCaller();
  }

  ranked.sort((a, b) =>
    b.priority - a.priority || b.marginBps - a.marginBps || a.index - b.index
  );
  fallback.sort((a, b) => a.index - b.index);
  const openFamilyIds = stageBudget.openFamilyIds();
  const openInstanceCircuitKeys = stageBudget.openInstanceCircuitKeys();
  const openCompositeKeys = stageBudget.openCompositeKeys();
  // A circuit limits future work; it does not invalidate an exact-positive
  // route that already completed. Later failures can come from unrelated pool
  // instances in the same family, so retroactively filtering ranked results
  // would turn a resource guard into a semantic false negative.
  const eligibleRanked = ranked;
  const eligibleFallback = fallback.filter(({ opportunity }) =>
    !stageBudget.blocks(opportunity.seedEdges)
  );
  const selectedRanked = eligibleRanked.slice(0, maxCandidates);
  const selectedFallback = eligibleFallback.slice(
    0,
    Math.max(0, maxCandidates - selectedRanked.length),
  );
  const selected = [
    ...selectedRanked.map((entry) => entry.opportunity),
    ...selectedFallback.map((entry) => entry.opportunity),
  ];
  return {
    opportunities: selected,
    concurrencyLimit: workerCount,
    peakConcurrentProbes,
    attempted,
    positive: eligibleRanked.length,
    negative,
    failed,
    deadlineHit: deadlineHit || Date.now() >= deadlineAtMs,
    ...(shadow === null
      ? {}
      : {
          shadow: Object.freeze({
            admissionSpreadBps: shadow.admissionSpreadBps,
            admitted: Object.freeze({ ...shadow.admitted }),
            notAdmitted: Object.freeze({ ...shadow.notAdmitted }),
            wouldRejectCapital: Object.freeze({
              ...shadow.wouldRejectCapital,
            }),
            familyOutcomes: Object.freeze(
              Object.fromEntries(
                Object.entries(shadow.familyOutcomes).map(
                  ([familyId, band]) => [
                    familyId,
                    Object.freeze({ ...band }),
                  ],
                ),
              ),
            ),
            admittedSpreadBuckets: Object.freeze({
              "floor-2x": Object.freeze({
                ...shadow.admittedSpreadBuckets["floor-2x"],
              }),
              "2x-5x": Object.freeze({
                ...shadow.admittedSpreadBuckets["2x-5x"],
              }),
              "5x-10x": Object.freeze({
                ...shadow.admittedSpreadBuckets["5x-10x"],
              }),
              "10x+": Object.freeze({
                ...shadow.admittedSpreadBuckets["10x+"],
              }),
            }),
          }),
        }),
    openFamilyIds,
    openInstanceCircuitKeys,
    openCompositeKeys,
  };
}

function emptyShadowBand(): {
  total: number;
  positive: number;
  negative: number;
  failed: number;
  unprobed: number;
} {
  return { total: 0, positive: 0, negative: 0, failed: 0, unprobed: 0 };
}

/** Compare exact probe returns across flash assets without comparing raw units. */
export function exactProbePriority(
  opportunity: BlockScanOpportunity,
  marginBps: number,
  pricedTokens: ReadonlyMap<string, { maxBorrow: bigint }>,
): number {
  const maxBorrow = pricedTokens.get(opportunity.flashToken.toLowerCase())?.maxBorrow ?? 0n;
  if (maxBorrow <= 0n) return 0;
  const ceiling = minBigint(opportunity.searchSeed.searchCenter, opportunity.searchSeed.maxInput);
  const capacityShare = Number(ceiling) / Number(maxBorrow);
  const priority = marginBps * capacityShare;
  return Number.isFinite(priority) && priority > 0 ? priority : 0;
}

async function exactProbeMarginBps(
  state: StateBackend,
  opportunity: BlockScanOpportunity,
  deadlineAtMs: number,
  signal: AbortSignal,
  executor?: string,
  strictSession?: StrictProductionRuntimeSession,
  runtimeEvidence: readonly RuntimeEvidence[] = Object.freeze([]),
  deadlineError: () => Error = () =>
    new ProbeDeadlineError("exact probe deadline reached"),
  onEdgeSuccess: (
    edge: BlockScanOpportunity["seedEdges"][number],
  ) => void = () => {},
  onRouteSuccess: () => void = () => {},
): Promise<number> {
  const ceiling = minBigint(opportunity.searchSeed.searchCenter, opportunity.searchSeed.maxInput);
  const amountIn = exactProbeAmount(opportunity);
  if (amountIn > ceiling || amountIn <= 0n) {
    return 0;
  }
  let amount = amountIn;
  for (const edge of opportunity.seedEdges) {
    if (Date.now() >= deadlineAtMs) {
      throw new BlockScanFamilyAttributedError(
        blockScanEdgeFamilyId(edge),
        "exact quote",
        deadlineError(),
        edge.canonicalEdgeId ?? null,
      );
    }
    try {
      void state;
      if (strictSession === undefined || executor === undefined) {
        throw new Error("exact refinement requires a strict current-source session");
      }
      const exact = await awaitWithAbort(strictSession.issueExact({
        edge,
        amountIn: amount,
        executor,
        runtimeEvidence,
        control: { deadlineAtMs, signal },
      }), signal);
      amount = exact.amountOut;
    } catch (error) {
      if (error instanceof BlockScanFamilyAttributedError) throw error;
      throw new BlockScanFamilyAttributedError(
        blockScanEdgeFamilyId(edge),
        "exact quote",
        error,
        edge.canonicalEdgeId ?? null,
      );
    }
    onEdgeSuccess(edge);
    if (amount <= 0n) return 0;
  }
  onRouteSuccess();
  const profit = amount - amountIn;
  if (profit <= 0n) return 0;
  const marginBps = Number(profit) * 10_000 / Number(amountIn);
  return Number.isFinite(marginBps) && marginBps > 0 ? marginBps : 0;
}

function exactProbeAmount(opportunity: BlockScanOpportunity): bigint {
  const ceiling = minBigint(
    opportunity.searchSeed.searchCenter,
    opportunity.searchSeed.maxInput,
  );
  return maxBigint(BLOCKSCAN_MIN_EXECUTABLE_INPUT, ceiling / 1024n);
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxBigint(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function probeFailureDiagnostic(
  reason: BlockScanProbeFailureDiagnostic["reason"],
  familyIds: readonly string[],
  error?: unknown,
  edges?: readonly BlockScanOpportunity["seedEdges"][number][],
): BlockScanProbeFailureDiagnostic {
  const attributed = error instanceof BlockScanFamilyAttributedError
    ? error
    : null;
  const cause = attributed?.failureCause ?? error;
  const record = typeof cause === "object" && cause !== null
    ? cause as {
        name?: unknown;
        code?: unknown;
        kind?: unknown;
      }
    : null;
  const attribution = edges && error !== undefined
    ? blockScanFailureCircuitAttribution(edges, error)
    : null;
  return Object.freeze({
    reason,
    familyIds: Object.freeze([...familyIds]),
    attributedFamilyId:
      edges && error !== undefined
        ? attribution?.familyId ?? null
        : attributed?.familyId ?? null,
    attributedInstanceCircuitKey:
      attribution?.scope === "instance" ? attribution.key : null,
    blockingCircuitScope:
      reason === "quote_error" || reason === "probe_timeout"
        ? attribution?.scope ?? null
        : null,
    stage: attributed?.stage ?? null,
    causeName: cause instanceof Error
      ? cause.name
      : typeof record?.name === "string"
        ? record.name
        : null,
    causeCode: typeof record?.code === "string" ||
        typeof record?.code === "number"
      ? String(record.code)
      : null,
    causeKind: typeof record?.kind === "string" ? record.kind : null,
  });
}

function probeCircuitDiagnostic(
  blocking: BlockScanCircuitAttribution,
  familyIds: readonly string[],
): BlockScanProbeFailureDiagnostic {
  return Object.freeze({
    reason: blocking.scope === "instance"
      ? "instance_circuit_open"
      : blocking.scope === "composite"
        ? "composite_circuit_open"
        : "family_circuit_open",
    familyIds: Object.freeze([...familyIds]),
    attributedFamilyId: blocking.familyId,
    attributedInstanceCircuitKey:
      blocking.scope === "instance" ? blocking.key : null,
    blockingCircuitScope: blocking.scope,
    stage: null,
    causeName: null,
    causeCode: null,
    causeKind: null,
  });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid block-scan ${label} ${String(value)}`);
  }
  return Math.max(1, Math.floor(value));
}

function linkAbort(
  source: AbortSignal,
  target: AbortController,
): () => void {
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }
  const abort = (): void => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    throw signal.reason ?? new Error("aborted");
  }
  let remove = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void =>
      reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    remove = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    remove();
    promise.catch(() => undefined);
  }
}
