import { setMaxListeners } from "node:events";
import {
  isStateCallAbortedError,
  type StateBackend,
  withStateCallControl,
} from "../../shared/state/state-backend.js";
import { quote } from "../solver/quoter.js";
import type { BlockScanOpportunity } from "./detector.js";
import {
  BlockScanFamilyAttributedError,
  BlockScanFamilyStageBudget,
  blockScanEdgeFamilyId,
  blockScanRouteFamilyIds,
  orderByBlockScanFamily,
  selectByBlockScanFamily,
} from "./blockscan-family-budget.js";

const DEFAULT_CONCURRENCY = 24;
const DEFAULT_FAMILY_PROBE_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_CONCURRENT_PER_FAMILY = 3;

export interface BlockScanRefinementResult {
  opportunities: BlockScanOpportunity[];
  attempted: number;
  positive: number;
  negative: number;
  failed: number;
  deadlineHit: boolean;
  openFamilyIds: readonly string[];
  openCompositeKeys: readonly string[];
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
    | "family_timeout"
    | "global_deadline"
    | "quote_error";
  readonly familyIds: readonly string[];
  readonly attributedFamilyId: string | null;
  readonly stage: string | null;
  readonly causeName: string | null;
  readonly causeCode: string | null;
  readonly causeKind: string | null;
}

export interface BlockScanRefinementOptions {
  readonly familyTimeoutMs?: number;
  readonly maxConcurrentPerFamily?: number;
}

interface RankedProbe {
  opportunity: BlockScanOpportunity;
  marginBps: number;
  priority: number;
  index: number;
}

class ProbeDeadlineError extends Error {}
class FamilyProbeDeadlineError extends Error {
  constructor(readonly familyIds: readonly string[], timeoutMs: number) {
    super(
      `block-scan exact probe family ${familyIds.join(",")} exceeded ${timeoutMs}ms`,
    );
    this.name = "FamilyProbeDeadlineError";
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
  const work = orderByBlockScanFamily(
    opportunities.map((opportunity, index) => ({ opportunity, index })),
    ({ opportunity }) => blockScanRouteFamilyIds(opportunity.seedEdges),
  );
  const ranked: RankedProbe[] = [];
  const fallback: Array<{ opportunity: BlockScanOpportunity; index: number }> = [];
  const stageBudget = new BlockScanFamilyStageBudget();
  let attempted = 0;
  let negative = 0;
  let failed = 0;
  let deadlineHit = false;
  const workerCount = Math.max(1, Math.min(concurrency, work.length));
  const familyTimeoutMs = positiveInteger(
    options.familyTimeoutMs ?? DEFAULT_FAMILY_PROBE_TIMEOUT_MS,
    "family timeout",
  );
  const maxConcurrentPerFamily = positiveInteger(
    options.maxConcurrentPerFamily ?? DEFAULT_MAX_CONCURRENT_PER_FAMILY,
    "family concurrency",
  );
  const deadlineController = new AbortController();
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
  const inFlightByFamily = new Map<string, number>();
  const active = new Set<Promise<void>>();
  const routeFamilies = (opportunity: BlockScanOpportunity): readonly string[] => {
    const familyIds = blockScanRouteFamilyIds(opportunity.seedEdges);
    return familyIds.length > 0 ? familyIds : ["<unowned-family>"];
  };
  const releaseFamilies = (familyIds: readonly string[]): void => {
    for (const familyId of familyIds) {
      const remaining = (inFlightByFamily.get(familyId) ?? 1) - 1;
      if (remaining <= 0) inFlightByFamily.delete(familyId);
      else inFlightByFamily.set(familyId, remaining);
    }
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
      const familyIds = routeFamilies(item.opportunity);
      if (
        familyIds.every(
          (familyId) =>
            (inFlightByFamily.get(familyId) ?? 0) <
              maxConcurrentPerFamily,
        )
      ) {
        pending.splice(index, 1);
        for (const familyId of familyIds) {
          inFlightByFamily.set(
            familyId,
            (inFlightByFamily.get(familyId) ?? 0) + 1,
          );
        }
        return item;
      }
      index++;
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
      onProbe?.({
        index: item.index,
        status: "failed",
        marginBps: null,
        attempted: false,
        failure: probeFailureDiagnostic(
          "family_circuit_open",
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
    const familyController = new AbortController();
    const detachGlobal = linkAbort(
      deadlineController.signal,
      familyController,
    );
    const startedAtMs = Date.now();
    const localBudgetMs = Math.min(
      familyTimeoutMs,
      Math.max(0, deadlineAtMs - startedAtMs),
    );
    const familyDeadlineAtMs = Math.min(
      deadlineAtMs,
      startedAtMs + localBudgetMs,
    );
    let localTimedOut = false;
    const familyTimer = familyDeadlineAtMs < deadlineAtMs
      ? setTimeout(() => {
          localTimedOut = true;
          familyController.abort(
            new FamilyProbeDeadlineError(familyIds, localBudgetMs),
          );
        }, Math.max(0, familyDeadlineAtMs - Date.now()))
      : undefined;
    const controlledState = withStateCallControl(state, {
      deadlineAtMs: familyDeadlineAtMs,
      signal: familyController.signal,
    });
    attempted++;
    try {
      const probe = exactProbeMarginBps(
        controlledState,
        opportunity,
        familyDeadlineAtMs,
        familyController.signal,
        () =>
          familyDeadlineAtMs < deadlineAtMs
            ? new FamilyProbeDeadlineError(familyIds, localBudgetMs)
            : new ProbeDeadlineError("exact probe deadline reached"),
      );
      const marginBps = await probe;
      if (deadlineController.signal.aborted || Date.now() >= deadlineAtMs) {
        throw new ProbeDeadlineError("exact probe deadline reached");
      }
      if (familyController.signal.aborted || Date.now() >= familyDeadlineAtMs) {
        localTimedOut = true;
        throw familyController.signal.reason ??
          new FamilyProbeDeadlineError(familyIds, localBudgetMs);
      }
      if (marginBps > 0) {
        ranked.push({
          opportunity,
          marginBps,
          priority: exactProbePriority(opportunity, marginBps, pricedTokens),
          index,
        });
        onProbe?.({
          index,
          status: "positive",
          marginBps,
          attempted: true,
          failure: null,
        });
      } else {
        negative++;
        onProbe?.({
          index,
          status: "negative",
          marginBps,
          attempted: true,
          failure: null,
        });
      }
      stageBudget.recordSuccess(opportunity.seedEdges);
    } catch (error) {
      if (
        error instanceof FamilyProbeDeadlineError ||
        (
          familyDeadlineAtMs < deadlineAtMs &&
          Date.now() >= familyDeadlineAtMs &&
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
        stageBudget.recordFailure(opportunity.seedEdges, budgetError);
        onProbe?.({
          index,
          status: "failed",
          marginBps: null,
          attempted: true,
          failure: probeFailureDiagnostic(
            localTimedOut ? "family_timeout" : "quote_error",
            familyIds,
            budgetError,
          ),
        });
      }
    } finally {
      if (familyTimer !== undefined) clearTimeout(familyTimer);
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
        const task = probeOne(item, familyIds).finally(() => {
          releaseFamilies(familyIds);
        });
        active.add(task);
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
  }

  ranked.sort((a, b) =>
    b.priority - a.priority || b.marginBps - a.marginBps || a.index - b.index
  );
  fallback.sort((a, b) => a.index - b.index);
  const openFamilyIds = stageBudget.openFamilyIds();
  const openCompositeKeys = stageBudget.openCompositeKeys();
  const eligibleRanked = ranked.filter((entry) =>
    !stageBudget.blocks(entry.opportunity.seedEdges)
  );
  const eligibleFallback = fallback.filter(({ opportunity }) =>
    !stageBudget.blocks(opportunity.seedEdges)
  );
  const selectedRanked = selectByBlockScanFamily(
    eligibleRanked,
    maxCandidates,
    (entry) => blockScanRouteFamilyIds(entry.opportunity.seedEdges),
  );
  const selectedFallback = selectByBlockScanFamily(
    eligibleFallback,
    Math.max(0, maxCandidates - selectedRanked.length),
    ({ opportunity }) => blockScanRouteFamilyIds(opportunity.seedEdges),
  );
  const selected = [
    ...selectedRanked.map((entry) => entry.opportunity),
    ...selectedFallback.map((entry) => entry.opportunity),
  ];
  return {
    opportunities: selected,
    attempted,
    positive: eligibleRanked.length,
    negative,
    failed,
    deadlineHit: deadlineHit || Date.now() >= deadlineAtMs,
    openFamilyIds,
    openCompositeKeys,
  };
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
  deadlineError: () => Error = () =>
    new ProbeDeadlineError("exact probe deadline reached"),
): Promise<number> {
  const ceiling = minBigint(opportunity.searchSeed.searchCenter, opportunity.searchSeed.maxInput);
  const amountIn = maxBigint(9n, ceiling / 1024n);
  if (amountIn > ceiling || amountIn <= 0n) return 0;
  let amount = amountIn;
  for (const edge of opportunity.seedEdges) {
    if (Date.now() >= deadlineAtMs) {
      throw deadlineError();
    }
    try {
      amount = await awaitWithAbort(
        quote(
          edge.adapterId,
          edge.target,
          edge.tokenIn,
          edge.tokenOut,
          amount,
          state,
          undefined,
          edge.v4PoolKey,
          edge.poolToken0,
          edge.poolToken1,
        ),
        signal,
      );
    } catch (error) {
      throw new BlockScanFamilyAttributedError(
        blockScanEdgeFamilyId(edge),
        "exact quote",
        error,
      );
    }
    if (amount <= 0n) return 0;
  }
  const profit = amount - amountIn;
  if (profit <= 0n) return 0;
  const marginBps = Number(profit) * 10_000 / Number(amountIn);
  return Number.isFinite(marginBps) && marginBps > 0 ? marginBps : 0;
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
  return Object.freeze({
    reason,
    familyIds: Object.freeze([...familyIds]),
    attributedFamilyId: attributed?.familyId ?? null,
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
