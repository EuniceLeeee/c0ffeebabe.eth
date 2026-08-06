import type { DiscoveryRange } from "./discovery-source-watermark.js";

export const DEFAULT_DISCOVERY_BACKFILL_CHUNK_BLOCKS = 8;

/**
 * Historical retention and one worker's CPU/RPC unit are different limits.
 * Keep the full catch-up target, but bound one preparation so a timeout can
 * publish progress instead of restarting the same large range forever.
 */
export function resolveDiscoveryBackfillChunkBlocks(
  maxCatchupBlocks: number,
  configured: string | undefined,
): number {
  positiveSafeInteger(maxCatchupBlocks, "maxCatchupBlocks");
  if (configured === undefined) {
    return Math.min(
      maxCatchupBlocks,
      DEFAULT_DISCOVERY_BACKFILL_CHUNK_BLOCKS,
    );
  }
  const parsed = Number(configured);
  positiveSafeInteger(parsed, "SEARCHER_DISCOVERY_BACKFILL_MAX_BLOCKS");
  return parsed;
}

export interface DiscoveryBackfillSource {
  readonly number: number;
  readonly hash: string;
}

export interface DiscoveryBackfillCanonicalProof {
  /** Monotonic canonical-chain journal revision read with `source`. */
  readonly revision: number;
  readonly source: DiscoveryBackfillSource;
}

export interface DiscoveryBackfillRequest {
  readonly id: string;
  readonly range: DiscoveryRange;
  /**
   * Current-N source used by every identity/probe/projection read. The
   * historical range may end earlier than this source.
   */
  readonly source: DiscoveryBackfillSource;
}

export interface DiscoveryBackfillStateDescriptor {
  /** Increments on every graph, ownership, evidence-cache or coverage commit. */
  readonly revision: number;
  /**
   * Hash of the complete immutable publication base: graph, ownership,
   * evidence cache, known/retryable pools, strategy views and cursors.
   */
  readonly baseFingerprint: string;
  /**
   * Hash of exact DEX source/graph coverage plus every protocol family×source
   * watermark and its canonical hash.
   */
  readonly coverageFingerprint: string;
  /** Global executable-graph minimum derived from that exact coverage set. */
  readonly graphCompleteThrough: number;
}

export interface DiscoveryBackfillPlan<State>
  extends DiscoveryBackfillRequest {
  /**
   * Immutable clone captured at schedule time. Preparation must read only this
   * state, never mutable live globals.
   */
  readonly baseState: State;
  readonly base: DiscoveryBackfillStateDescriptor;
}

export interface ValidatedDiscoveryBackfill<State> {
  /**
   * One immutable aggregate publication. It contains DEX + protocol graph,
   * ownership, caches, retry state, cursors and exact coverage together.
   */
  readonly state: State;
  /** Exact source fenced before/after preparation. */
  readonly source: DiscoveryBackfillSource;
}

export interface DiscoveryBackfillControl {
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  /**
   * Every background provider read must enter through this dedicated
   * semaphore. `work` must pass the supplied signal to an abort-aware
   * transport; an uncancellable transport belongs in a terminable worker.
   */
  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

export type DiscoveryBackfillScheduleResult =
  | { readonly scheduled: true; readonly jobId: number }
  | {
      readonly scheduled: false;
      readonly reason: "preparing" | "ready_pending";
      readonly jobId: number;
    };

export type DiscoveryBackfillHotResult<State> =
  | {
      readonly status: "ready";
      readonly state: State;
      readonly planId: string;
      readonly jobId: number;
      readonly graphCompleteThrough: number;
    }
  | {
      readonly status: "ready_degraded";
      readonly state: State;
      readonly planId: string;
      readonly jobId: number;
      readonly graphCompleteThrough: number;
      readonly reason: "coverage_behind";
    }
  | {
      readonly status: "degraded";
      readonly graphCompleteThrough: number;
      readonly reason:
        | "not_ready"
        | "preparing"
        | "preparation_timeout"
        | "preparation_failed"
        | "stale_base"
        | "non_canonical_source"
        | "projection_from_future"
        | "prepared_state_mutated";
      readonly planId?: string;
      readonly jobId?: number;
      readonly error?: string;
    };

export interface DiscoveryBackfillTelemetry {
  readonly scheduled: number;
  readonly prepared: number;
  readonly taken: number;
  readonly rejectedBusy: number;
  readonly rejectedReady: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly stale: number;
  readonly invalidated: number;
  readonly activeJobId: number | null;
  readonly readyJobId: number | null;
  readonly activeReads: number;
  readonly peakReads: number;
  readonly lastFailure: string | null;
}

export interface DiscoveryBackfillLaneOptions<State, Prepared> {
  /** Inclusive bound for one historical source chunk. */
  readonly maxBlocksPerJob: number;
  readonly maxPreparationMs: number;
  /** Dedicated background RPC budget; hot RPC does not share this semaphore. */
  readonly maxConcurrency: number;
  readonly describeState: (
    state: State,
  ) => DiscoveryBackfillStateDescriptor;
  readonly prepare: (
    plan: DiscoveryBackfillPlan<State>,
    control: DiscoveryBackfillControl,
  ) => Promise<Prepared>;
  /**
   * Trusted central validation. It must derive the next DEX source/graph
   * coverage and protocol family×source map from raw scanner results, enforce
   * contiguous ranges, and return one aggregate immutable state. A family
   * cannot self-assert a scalar completeness watermark.
   */
  readonly validateTransition: (
    plan: DiscoveryBackfillPlan<State>,
    prepared: Prepared,
  ) => ValidatedDiscoveryBackfill<State>;
  /**
   * Optional lane-aware rebase used when an independent publication changed
   * the aggregate after preparation. Returning null preserves fail-closed CAS
   * semantics. The rebased state is validated against the current revision
   * and the original canonical source before it can be taken.
   */
  readonly rebaseTransition?: (
    plan: DiscoveryBackfillPlan<State>,
    prepared: Prepared,
    currentState: State,
  ) => ValidatedDiscoveryBackfill<State> | null;
  readonly onError?: (
    plan: DiscoveryBackfillPlan<State>,
    error: unknown,
  ) => void;
  /**
   * Cooperative producer yield: before a historical preparation starts, wait
   * while `active()` is true (the blockscan producer's critical state phase),
   * up to `maxWaitMs` total, then proceed anyway to avoid starvation. The
   * producer's canonical receipts read stalls 10-14s when a backfill scan
   * saturates reth at the same time, which pushes N-1 publication past the
   * head cadence; this gate gives the producer a clean transport window.
   */
  readonly producerYield?: DiscoveryBackfillProducerYield;
}

export interface DiscoveryBackfillProducerYield {
  readonly active: () => boolean;
  readonly maxWaitMs: number;
}

interface ActiveJob<State> {
  readonly id: number;
  readonly plan: DiscoveryBackfillPlan<State>;
  readonly controller: AbortController;
  readonly reads: BackgroundReadBudget;
  readonly deadlineAtMs: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly settlement: Promise<void>;
  readonly resolveSettlement: () => void;
  timedOut: boolean;
  invalidated: boolean;
}

interface ReadyJob<State, Prepared> {
  readonly id: number;
  readonly plan: DiscoveryBackfillPlan<State>;
  readonly prepared: Prepared;
  readonly nextState: State;
  readonly next: DiscoveryBackfillStateDescriptor;
}

interface Failure {
  readonly jobId: number;
  readonly planId: string;
  readonly reason: "preparation_timeout" | "preparation_failed";
  readonly error: string;
}

/**
 * Single-worker historical discovery preparation lane.
 *
 * `schedule` starts preparation outside ProtocolDiscoveryMutationQueue.
 * `takeForHotHead` is synchronous: inside the mutation queue the caller either
 * takes one already-validated immutable state and swaps a single live pointer,
 * or immediately marks the head degraded. There is no pending request: after
 * a take, the caller plans the next contiguous chunk from the new state.
 *
 * Deadline abort is cooperative. A timed-out provider that ignores
 * AbortSignal keeps the sole worker occupied until its promise settles, so an
 * uncancelled RPC can never become orphan concurrent work.
 */
export class DiscoveryBackfillLane<State, Prepared> {
  private active: ActiveJob<State> | null = null;
  private ready: ReadyJob<State, Prepared> | null = null;
  private failure: Failure | null = null;
  private nextJobId = 1;
  private peakReads = 0;
  private producerYield: DiscoveryBackfillProducerYield | null = null;
  private counts = {
    scheduled: 0,
    prepared: 0,
    taken: 0,
    rejectedBusy: 0,
    rejectedReady: 0,
    failed: 0,
    timedOut: 0,
    stale: 0,
    invalidated: 0,
  };

  constructor(
    private readonly options: DiscoveryBackfillLaneOptions<State, Prepared>,
  ) {
    positiveSafeInteger(options.maxBlocksPerJob, "maxBlocksPerJob");
    if (
      !Number.isSafeInteger(options.maxPreparationMs) ||
      options.maxPreparationMs <= 0 ||
      options.maxPreparationMs > 2_147_483_647
    ) {
      throw new Error(
        `invalid discovery backfill maxPreparationMs ` +
          options.maxPreparationMs,
      );
    }
    positiveSafeInteger(options.maxConcurrency, "maxConcurrency");
    this.producerYield = options.producerYield ?? null;
  }

  /** Runtime-loop hook: set after construction so the producer can gate scans. */
  setProducerYield(hook: DiscoveryBackfillProducerYield | null): void {
    this.producerYield = hook;
  }

  schedule(
    request: DiscoveryBackfillRequest,
    baseState: State,
  ): DiscoveryBackfillScheduleResult {
    const frozenRequest = validateRequest(
      request,
      this.options.maxBlocksPerJob,
    );
    if (this.active) {
      this.counts.rejectedBusy++;
      return {
        scheduled: false,
        reason: "preparing",
        jobId: this.active.id,
      };
    }
    if (this.ready) {
      this.counts.rejectedReady++;
      return {
        scheduled: false,
        reason: "ready_pending",
        jobId: this.ready.id,
      };
    }

    const base = validateDescriptor(this.options.describeState(baseState));
    const plan: DiscoveryBackfillPlan<State> = Object.freeze({
      ...frozenRequest,
      baseState,
      base,
    });
    const controller = new AbortController();
    const reads = new BackgroundReadBudget(
      controller.signal,
      this.options.maxConcurrency,
      (peak) => {
        this.peakReads = Math.max(this.peakReads, peak);
      },
    );
    const deadlineAtMs = Date.now() + this.options.maxPreparationMs;
    const id = this.nextJobId++;
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    const active: ActiveJob<State> = {
      id,
      plan,
      controller,
      reads,
      deadlineAtMs,
      timer: setTimeout(() => {
        if (this.active !== active || active.invalidated || active.timedOut) {
          return;
        }
        active.timedOut = true;
        this.counts.timedOut++;
        controller.abort(
          new Error(
            `discovery backfill ${plan.id} exceeded ` +
              `${this.options.maxPreparationMs}ms`,
          ),
        );
      }, this.options.maxPreparationMs),
      settlement,
      resolveSettlement,
      timedOut: false,
      invalidated: false,
    };
    this.active = active;
    this.failure = null;
    this.counts.scheduled++;
    void Promise.resolve()
      .then(() => this.yieldForProducer(controller.signal))
      .then(() => this.options.prepare(plan, {
        signal: controller.signal,
        deadlineAtMs,
        run: (work) => reads.run(work),
      }))
      .then((prepared) => this.settleSuccess(active, prepared))
      .catch((error) => this.settleFailure(active, error))
      .finally(() => active.resolveSettlement());
    return { scheduled: true, jobId: id };
  }

  private async yieldForProducer(signal: AbortSignal): Promise<void> {
    const hook = this.producerYield;
    if (!hook) return;
    const startedAtMs = Date.now();
    while (hook.active()) {
      if (signal.aborted) {
        throw signal.reason ?? new Error("discovery backfill aborted");
      }
      if (Date.now() - startedAtMs >= Math.max(0, hook.maxWaitMs)) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }

  readyDescriptor(): {
    readonly jobId: number;
    readonly planId: string;
    readonly source: DiscoveryBackfillSource;
  } | null {
    return this.ready
      ? Object.freeze({
          jobId: this.ready.id,
          planId: this.ready.plan.id,
          source: this.ready.plan.source,
        })
      : null;
  }

  /**
   * Must run inside the live mutation queue. `currentState` is read there;
   * the proof comes from the canonical header journal immediately before the
   * queue, and its revision is compared again inside the queue.
   */
  takeForHotHead(input: {
    readonly targetSource: DiscoveryBackfillSource;
    readonly currentState: State;
    readonly canonicalPreparedSource: DiscoveryBackfillCanonicalProof | null;
    readonly currentCanonicalRevision: number;
  }): DiscoveryBackfillHotResult<State> {
    const target = validateSource(input.targetSource, "target source");
    if (
      !Number.isSafeInteger(input.currentCanonicalRevision) ||
      input.currentCanonicalRevision < 0
    ) {
      throw new Error(
        `invalid discovery canonical revision ` +
          input.currentCanonicalRevision,
      );
    }
    const current = validateDescriptor(
      this.options.describeState(input.currentState),
    );
    const ready = this.ready;
    if (!ready) return this.notReady(current.graphCompleteThrough);

    if (ready.plan.source.number > target.number) {
      // A latest-head scheduler may already have coalesced a newer head while
      // the current pass was waiting. Keep the canonical prepared generation
      // for that pending head instead of destroying valid work here.
      return {
        status: "degraded",
        graphCompleteThrough: current.graphCompleteThrough,
        reason: "projection_from_future",
        planId: ready.plan.id,
        jobId: ready.id,
      };
    }
    if (
      ready.plan.source.number === target.number &&
      ready.plan.source.hash !== target.hash
    ) {
      return this.discard(
        ready,
        current.graphCompleteThrough,
        "non_canonical_source",
      );
    }
    const proof = input.canonicalPreparedSource;
    if (
      proof === null ||
      proof.revision !== input.currentCanonicalRevision ||
      proof.source.number !== ready.plan.source.number ||
      normalizeHash(proof.source.hash) !== ready.plan.source.hash
    ) {
      return this.discard(
        ready,
        current.graphCompleteThrough,
        "non_canonical_source",
      );
    }
    const nextNow = validateDescriptor(
      this.options.describeState(ready.nextState),
    );
    if (!sameDescriptor(nextNow, ready.next)) {
      return this.discard(
        ready,
        current.graphCompleteThrough,
        "prepared_state_mutated",
      );
    }

    let takenState = ready.nextState;
    let takenDescriptor = ready.next;
    if (!sameDescriptor(current, ready.plan.base)) {
      const rebase = this.options.rebaseTransition;
      if (!rebase) {
        return this.discard(
          ready,
          current.graphCompleteThrough,
          "stale_base",
        );
      }
      let rebased: ValidatedDiscoveryBackfill<State> | null;
      try {
        rebased = rebase(
          ready.plan,
          ready.prepared,
          input.currentState,
        );
      } catch {
        rebased = null;
      }
      if (rebased === null) {
        return this.discard(
          ready,
          current.graphCompleteThrough,
          "stale_base",
        );
      }
      const rebasedSource = validateSource(
        rebased.source,
        "rebased source",
      );
      if (
        rebasedSource.number !== ready.plan.source.number ||
        rebasedSource.hash !== ready.plan.source.hash
      ) {
        return this.discard(
          ready,
          current.graphCompleteThrough,
          "non_canonical_source",
        );
      }
      const descriptor = validateDescriptor(
        this.options.describeState(rebased.state),
      );
      if (
        descriptor.revision !== current.revision + 1 ||
        descriptor.graphCompleteThrough < current.graphCompleteThrough ||
        descriptor.graphCompleteThrough > target.number
      ) {
        return this.discard(
          ready,
          current.graphCompleteThrough,
          "stale_base",
        );
      }
      takenState = rebased.state;
      takenDescriptor = descriptor;
    }

    this.ready = null;
    this.counts.taken++;
    const common = {
      state: takenState,
      planId: ready.plan.id,
      jobId: ready.id,
      graphCompleteThrough: takenDescriptor.graphCompleteThrough,
    };
    return takenDescriptor.graphCompleteThrough < target.number
      ? {
          status: "ready_degraded",
          ...common,
          reason: "coverage_behind",
        }
      : { status: "ready", ...common };
  }

  invalidate(reason: string): void {
    if (!reason.trim()) {
      throw new Error("discovery backfill invalidation requires a reason");
    }
    if (this.ready) {
      this.ready = null;
      this.counts.invalidated++;
    }
    if (!this.active || this.active.invalidated) return;
    this.active.invalidated = true;
    this.counts.invalidated++;
    this.active.controller.abort(
      new Error(`discovery backfill invalidated: ${reason}`),
    );
  }

  async settled(): Promise<void> {
    const active = this.active;
    if (active) await active.settlement;
  }

  telemetry(): DiscoveryBackfillTelemetry {
    return Object.freeze({
      ...this.counts,
      activeJobId: this.active?.id ?? null,
      readyJobId: this.ready?.id ?? null,
      activeReads: this.active?.reads.activeCount ?? 0,
      peakReads: this.peakReads,
      lastFailure: this.failure?.error ?? null,
    });
  }

  private settleSuccess(active: ActiveJob<State>, prepared: Prepared): void {
    if (this.active !== active) return;
    clearTimeout(active.timer);
    if (active.invalidated) {
      this.active = null;
      return;
    }
    if (active.timedOut || active.controller.signal.aborted) {
      this.active = null;
      this.recordFailure(
        active,
        "preparation_timeout",
        active.controller.signal.reason,
      );
      return;
    }
    try {
      const baseNow = validateDescriptor(
        this.options.describeState(active.plan.baseState),
      );
      if (!sameDescriptor(baseNow, active.plan.base)) {
        throw new Error(
          `discovery backfill ${active.plan.id} base snapshot mutated`,
        );
      }
      const validated = this.options.validateTransition(
        active.plan,
        prepared,
      );
      const source = validateSource(validated.source, "validated source");
      if (
        source.number !== active.plan.source.number ||
        source.hash !== active.plan.source.hash
      ) {
        throw new Error(
          `discovery backfill ${active.plan.id} validated source mismatch`,
        );
      }
      const next = validateDescriptor(
        this.options.describeState(validated.state),
      );
      if (next.revision !== active.plan.base.revision + 1) {
        throw new Error(
          `discovery backfill ${active.plan.id} revision ` +
            `${active.plan.base.revision}->${next.revision}; expected +1`,
        );
      }
      if (
        next.graphCompleteThrough <
          active.plan.base.graphCompleteThrough ||
        next.graphCompleteThrough > source.number
      ) {
        throw new Error(
          `discovery backfill ${active.plan.id} invalid graph coverage ` +
            `${active.plan.base.graphCompleteThrough}->` +
            `${next.graphCompleteThrough} at source ${source.number}`,
        );
      }
      this.ready = Object.freeze({
        id: active.id,
        plan: active.plan,
        prepared,
        nextState: validated.state,
        next,
      });
      this.active = null;
      this.counts.prepared++;
    } catch (error) {
      this.active = null;
      this.recordFailure(active, "preparation_failed", error);
    }
  }

  private settleFailure(active: ActiveJob<State>, error: unknown): void {
    if (this.active !== active) return;
    clearTimeout(active.timer);
    this.active = null;
    if (active.invalidated) return;
    this.recordFailure(
      active,
      active.timedOut ? "preparation_timeout" : "preparation_failed",
      error,
    );
  }

  private recordFailure(
    active: ActiveJob<State>,
    reason: Failure["reason"],
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.failure = Object.freeze({
      jobId: active.id,
      planId: active.plan.id,
      reason,
      error: message,
    });
    this.counts.failed++;
    try {
      this.options.onError?.(active.plan, error);
    } catch {
      // Reporting cannot create a second failure or release another worker.
    }
  }

  private notReady(
    graphCompleteThrough: number,
  ): DiscoveryBackfillHotResult<State> {
    if (this.active) {
      return {
        status: "degraded",
        graphCompleteThrough,
        reason: this.active.timedOut
          ? "preparation_timeout"
          : "preparing",
        planId: this.active.plan.id,
        jobId: this.active.id,
      };
    }
    return this.failure
      ? {
          status: "degraded",
          graphCompleteThrough,
          reason: this.failure.reason,
          planId: this.failure.planId,
          jobId: this.failure.jobId,
          error: this.failure.error,
        }
      : { status: "degraded", graphCompleteThrough, reason: "not_ready" };
  }

  private discard(
    ready: ReadyJob<State, Prepared>,
    graphCompleteThrough: number,
    reason:
      | "stale_base"
      | "non_canonical_source"
      | "prepared_state_mutated",
  ): DiscoveryBackfillHotResult<State> {
    this.ready = null;
    this.counts.stale++;
    return {
      status: "degraded",
      graphCompleteThrough,
      reason,
      planId: ready.plan.id,
      jobId: ready.id,
    };
  }
}

function validateRequest(
  request: DiscoveryBackfillRequest,
  maxBlocks: number,
): DiscoveryBackfillRequest {
  nonEmpty(request.id, "plan id");
  block(request.range.fromBlock, "range start");
  block(request.range.toBlock, "range end");
  if (request.range.fromBlock > request.range.toBlock) {
    throw new Error(
      `discovery backfill range starts after it ends ` +
        `${request.range.fromBlock}>${request.range.toBlock}`,
    );
  }
  const count = request.range.toBlock - request.range.fromBlock + 1;
  if (count > maxBlocks) {
    throw new Error(
      `discovery backfill range has ${count} blocks; max is ${maxBlocks}`,
    );
  }
  const source = validateSource(request.source, "plan source");
  if (source.number < request.range.toBlock) {
    throw new Error(
      `discovery backfill source ${source.number} precedes range end ` +
        request.range.toBlock,
    );
  }
  return Object.freeze({
    id: request.id,
    range: Object.freeze({ ...request.range }),
    source,
  });
}

function validateDescriptor(
  value: DiscoveryBackfillStateDescriptor,
): DiscoveryBackfillStateDescriptor {
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error(`invalid discovery backfill revision ${value.revision}`);
  }
  cursor(value.graphCompleteThrough, "graph completeness");
  nonEmpty(value.baseFingerprint, "base fingerprint");
  nonEmpty(value.coverageFingerprint, "coverage fingerprint");
  return Object.freeze({ ...value });
}

function sameDescriptor(
  a: DiscoveryBackfillStateDescriptor,
  b: DiscoveryBackfillStateDescriptor,
): boolean {
  return (
    a.revision === b.revision &&
    a.baseFingerprint === b.baseFingerprint &&
    a.coverageFingerprint === b.coverageFingerprint &&
    a.graphCompleteThrough === b.graphCompleteThrough
  );
}

function validateSource(
  source: DiscoveryBackfillSource,
  label: string,
): DiscoveryBackfillSource {
  block(source.number, `${label} block`);
  return Object.freeze({
    number: source.number,
    hash: normalizeHash(source.hash),
  });
}

function normalizeHash(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`invalid discovery backfill block hash ${value}`);
  }
  return normalized;
}

function block(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid discovery backfill ${label} ${value}`);
  }
}

function cursor(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < -1) {
    throw new Error(`invalid discovery backfill ${label} ${value}`);
  }
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid discovery backfill ${label} ${value}`);
  }
}

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`discovery backfill ${label} must be non-empty`);
  }
}

interface QueuedRead {
  readonly start: () => void;
  readonly reject: (error: unknown) => void;
}

class BackgroundReadBudget {
  private readonly queued: QueuedRead[] = [];
  private active = 0;
  private peak = 0;

  constructor(
    private readonly signal: AbortSignal,
    private readonly limit: number,
    private readonly onPeak: (peak: number) => void,
  ) {
    signal.addEventListener("abort", () => {
      const error = signal.reason ??
        new Error("discovery backfill aborted");
      for (const read of this.queued.splice(0)) read.reject(error);
    }, { once: true });
  }

  get activeCount(): number {
    return this.active;
  }

  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.signal.aborted) {
      return Promise.reject(
        this.signal.reason ?? new Error("discovery backfill aborted"),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const queued: QueuedRead = {
        reject,
        start: () => {
          if (this.signal.aborted) {
            reject(
              this.signal.reason ??
                new Error("discovery backfill aborted"),
            );
            return;
          }
          this.active++;
          this.peak = Math.max(this.peak, this.active);
          this.onPeak(this.peak);
          void Promise.resolve()
            .then(() => work(this.signal))
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.drain();
            });
        },
      };
      this.queued.push(queued);
      this.drain();
    });
  }

  private drain(): void {
    while (
      !this.signal.aborted &&
      this.active < this.limit &&
      this.queued.length > 0
    ) {
      this.queued.shift()!.start();
    }
  }
}
