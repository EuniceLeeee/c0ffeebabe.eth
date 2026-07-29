export interface LatestHeadSchedulerTelemetry {
  readonly submitted: number;
  readonly started: number;
  readonly completed: number;
  readonly coalesced: number;
  readonly latestSubmitted: number | null;
  readonly active: number | null;
  readonly pending: number | null;
}

export interface LatestHeadObservation {
  readonly sourceHeadSeenAtMs: number;
  readonly sourceHeadSeenAtMonotonicMs: number;
  /** Positive only for a same-head execution-context refresh. */
  readonly revision?: number;
}

interface ScheduledHead extends LatestHeadObservation {
  readonly blockNumber: number;
  readonly revisionNumber: number;
}

export type LatestHeadDropReason =
  | "scheduler_coalesced"
  | "shutdown_pending_dropped";

export interface DroppedLatestHead extends LatestHeadObservation {
  readonly blockNumber: number;
  readonly reason: LatestHeadDropReason;
}

/**
 * Single-worker, latest-pending head scheduler.
 *
 * A busy pass never causes the newest head to disappear. Intermediate heads
 * may coalesce while one generation is active; when it settles, exactly the
 * newest pending head runs next.
 */
export class LatestHeadScheduler {
  private active: ScheduledHead | null = null;
  private pending: ScheduledHead | null = null;
  private accepting = true;
  private drainTask: Promise<void> | null = null;
  private latestSubmitted: number | null = null;
  private latestRevision = 0;
  private submitted = 0;
  private started = 0;
  private completed = 0;
  private coalesced = 0;

  constructor(
    private readonly runHead: (
      blockNumber: number,
      observation: LatestHeadObservation,
    ) => Promise<void>,
    private readonly onError: (blockNumber: number, error: unknown) => void =
      () => {},
    private readonly onDrop: (head: DroppedLatestHead) => void = () => {},
  ) {}

  schedule(
    blockNumber: number,
    observation: LatestHeadObservation = {
      sourceHeadSeenAtMs: Date.now(),
      sourceHeadSeenAtMonotonicMs: performance.now(),
    },
  ): void {
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new Error(`invalid scheduled head ${blockNumber}`);
    }
    this.validateObservation(blockNumber, observation);
    if (!this.accepting) return;
    this.submitted++;
    if (this.latestSubmitted !== null && blockNumber <= this.latestSubmitted) {
      this.coalesced++;
      return;
    }
    this.latestSubmitted = blockNumber;
    this.latestRevision = 0;
    this.admit(Object.freeze({
      blockNumber,
      revisionNumber: 0,
      ...observation,
    }));
  }

  /**
   * Admit a new immutable execution context for the same canonical head.
   * Revisions are caller-owned monotonic sequence numbers. A newer block
   * always dominates every pending refresh from an older block.
   */
  scheduleRevision(
    blockNumber: number,
    revision: number,
    observation: LatestHeadObservation,
  ): boolean {
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
      throw new Error(`invalid scheduled head ${blockNumber}`);
    }
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error(`invalid scheduled head revision ${revision}`);
    }
    this.validateObservation(blockNumber, observation);
    if (!this.accepting) return false;
    this.submitted++;
    if (
      this.latestSubmitted !== null &&
      (
        blockNumber < this.latestSubmitted ||
        (
          blockNumber === this.latestSubmitted &&
          revision <= this.latestRevision
        )
      )
    ) {
      this.coalesced++;
      return false;
    }
    if (this.latestSubmitted === null || blockNumber > this.latestSubmitted) {
      this.latestSubmitted = blockNumber;
      this.latestRevision = 0;
    }
    this.latestRevision = revision;
    this.admit(Object.freeze({
      blockNumber,
      revisionNumber: revision,
      ...observation,
      revision,
    }));
    return true;
  }

  private admit(scheduled: ScheduledHead): void {
    if (this.active !== null) {
      if (this.pending !== null) {
        this.coalesced++;
        this.reportDrop(this.pending, "scheduler_coalesced");
      }
      this.pending = scheduled;
      return;
    }
    this.active = scheduled;
    this.drainTask = this.drain();
    void this.drainTask;
  }

  /**
   * Stop accepting heads, discard the not-yet-started pending head and wait
   * until the active pass has settled.
   */
  async shutdown(): Promise<void> {
    this.accepting = false;
    if (this.pending !== null) {
      this.reportDrop(this.pending, "shutdown_pending_dropped");
    }
    this.pending = null;
    await this.drainTask;
  }

  telemetry(): LatestHeadSchedulerTelemetry {
    return Object.freeze({
      submitted: this.submitted,
      started: this.started,
      completed: this.completed,
      coalesced: this.coalesced,
      latestSubmitted: this.latestSubmitted,
      active: this.active?.blockNumber ?? null,
      pending: this.pending?.blockNumber ?? null,
    });
  }

  private async drain(): Promise<void> {
    while (this.active !== null) {
      const scheduled = this.active;
      const blockNumber = scheduled.blockNumber;
      this.started++;
      try {
        await this.runHead(blockNumber, {
          sourceHeadSeenAtMs: scheduled.sourceHeadSeenAtMs,
          sourceHeadSeenAtMonotonicMs: scheduled.sourceHeadSeenAtMonotonicMs,
          ...(scheduled.revisionNumber === 0
            ? {}
            : { revision: scheduled.revisionNumber }),
        });
      } catch (error) {
        this.onError(blockNumber, error);
      } finally {
        this.completed++;
      }
      const next = this.pending;
      this.pending = null;
      this.active = next;
    }
  }

  private reportDrop(
    head: ScheduledHead,
    reason: LatestHeadDropReason,
  ): void {
    try {
      this.onDrop(Object.freeze({ ...head, reason }));
    } catch {
      // Observability must never disrupt latest-head admission.
    }
  }

  private validateObservation(
    blockNumber: number,
    observation: LatestHeadObservation,
  ): void {
    if (
      !Number.isFinite(observation.sourceHeadSeenAtMs) ||
      !Number.isFinite(observation.sourceHeadSeenAtMonotonicMs)
    ) {
      throw new Error(`invalid source-head observation for ${blockNumber}`);
    }
  }
}
