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
}

interface ScheduledHead extends LatestHeadObservation {
  readonly blockNumber: number;
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
    if (
      !Number.isFinite(observation.sourceHeadSeenAtMs) ||
      !Number.isFinite(observation.sourceHeadSeenAtMonotonicMs)
    ) {
      throw new Error(`invalid source-head observation for ${blockNumber}`);
    }
    if (!this.accepting) return;
    this.submitted++;
    if (this.latestSubmitted !== null && blockNumber <= this.latestSubmitted) {
      this.coalesced++;
      return;
    }
    this.latestSubmitted = blockNumber;
    const scheduled = Object.freeze({ blockNumber, ...observation });
    if (this.active !== null) {
      if (this.pending !== null) this.coalesced++;
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
}
