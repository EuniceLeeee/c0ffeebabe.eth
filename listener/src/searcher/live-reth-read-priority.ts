type CriticalWork<T> = () => Promise<T>;
type ForegroundWork<T> = () => Promise<T>;
type BackgroundWork<T> = (signal: AbortSignal) => Promise<T>;

interface ActiveBackgroundAttempt {
  readonly controller: AbortController;
  readonly foregroundHandoffMs: number;
  settled: Promise<void>;
  preempted: boolean;
}

export interface LiveRethBackgroundOptions {
  /**
   * Let one already-started background RPC finish before a newly announced
   * foreground lease begins. The lease still owns the transport exclusively:
   * no new background attempt may start, and the retained attempt is aborted
   * once this grace period expires. Foreground still drains the abort-aware
   * transport before starting, so it never overlaps the retained attempt.
   */
  readonly foregroundHandoffMs?: number;
}

type BackgroundOutcome<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "failure"; readonly error: unknown }
  | { readonly kind: "external-abort"; readonly error: unknown };

/**
 * Gives current-block reth reads priority over retry-safe background RPCs.
 *
 * Background work must be one idempotent RPC attempt and must pass the
 * supplied signal to its transport. Foreground leases may overlap each other;
 * critical work remains serial. Critical work always preempts background.
 * Foreground work normally does the same, but may grant one explicitly opted
 * in attempt a bounded exclusive handoff before it starts. Internally
 * preempted attempts retry after every foreground/critical lease drains;
 * caller cancellation never retries.
 */
export class LiveRethReadPriority {
  private readonly activeBackground = new Set<ActiveBackgroundAttempt>();
  private readonly backgroundWaiters = new Set<() => void>();
  private foregroundCount = 0;
  private criticalCount = 0;
  private criticalTail: Promise<void> = Promise.resolve();
  private foregroundHandoff: Promise<void> | null = null;

  async runForeground<T>(work: ForegroundWork<T>): Promise<T> {
    this.foregroundCount++;

    try {
      await this.prepareForeground();
      return await work();
    } finally {
      this.foregroundCount--;
      if (this.foregroundCount === 0 && this.criticalCount === 0) {
        this.releaseBackgroundWaiters();
      }
    }
  }

  async runCritical<T>(
    work: CriticalWork<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(parentSignal);
    this.criticalCount++;

    const previous = this.criticalTail;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.criticalTail = previous.then(() => turn);

    try {
      await this.preemptBackground();
      await waitForSettlement(previous, parentSignal);
      throwIfAborted(parentSignal);
      return await work();
    } finally {
      release();
      this.criticalCount--;
      if (this.foregroundCount === 0 && this.criticalCount === 0) {
        this.releaseBackgroundWaiters();
      }
    }
  }

  async runBackground<T>(
    work: BackgroundWork<T>,
    parentSignal?: AbortSignal,
    options: LiveRethBackgroundOptions = {},
  ): Promise<T> {
    for (;;) {
      await this.waitForForegroundQueue(parentSignal);
      throwIfAborted(parentSignal);
      // `await` always yields, even when no critical work existed when the
      // wait began. A critical request may announce itself in that gap before
      // this attempt is registered and therefore cannot abort it. Recheck in
      // the same synchronous turn that registers the attempt.
      if (this.foregroundCount > 0 || this.criticalCount > 0) continue;

      const controller = new AbortController();
      const attempt: ActiveBackgroundAttempt = {
        controller,
        foregroundHandoffMs: normalizeHandoffMs(
          options.foregroundHandoffMs,
        ),
        settled: Promise.resolve(),
        preempted: false,
      };
      let resolveExternalAbort!: (
        outcome: BackgroundOutcome<T>,
      ) => void;
      const externalAbort = new Promise<BackgroundOutcome<T>>((resolve) => {
        resolveExternalAbort = resolve;
      });
      const onParentAbort = () => {
        const error = abortReason(parentSignal!);
        controller.abort(error);
        resolveExternalAbort({ kind: "external-abort", error });
      };
      parentSignal?.addEventListener("abort", onParentAbort, { once: true });

      this.activeBackground.add(attempt);
      const completion = Promise.resolve()
        .then(() => work(controller.signal))
        .then<BackgroundOutcome<T>, BackgroundOutcome<T>>(
          (value) => ({ kind: "success", value }),
          (error: unknown) => ({ kind: "failure", error }),
        );
      attempt.settled = completion.then(() => undefined).finally(() => {
        parentSignal?.removeEventListener("abort", onParentAbort);
        this.activeBackground.delete(attempt);
      });

      const outcome = await Promise.race([completion, externalAbort]);
      await attempt.settled;
      if (outcome.kind === "external-abort") throw outcome.error;
      if (parentSignal?.aborted) throw abortReason(parentSignal);
      if (attempt.preempted) continue;
      if (outcome.kind === "failure") throw outcome.error;
      return outcome.value;
    }
  }

  private waitForForegroundQueue(parentSignal?: AbortSignal): Promise<void> {
    throwIfAborted(parentSignal);
    if (this.foregroundCount === 0 && this.criticalCount === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (operation: () => void) => {
        if (done) return;
        done = true;
        this.backgroundWaiters.delete(onReleased);
        parentSignal?.removeEventListener("abort", onAborted);
        operation();
      };
      const onReleased = () => finish(resolve);
      const onAborted = () =>
        finish(() => reject(abortReason(parentSignal!)));
      this.backgroundWaiters.add(onReleased);
      parentSignal?.addEventListener("abort", onAborted, { once: true });

      // Close the registration race if the last critical turn completed while
      // this waiter was being installed.
      if (parentSignal?.aborted) onAborted();
      else if (this.foregroundCount === 0 && this.criticalCount === 0) {
        onReleased();
      }
    });
  }

  private releaseBackgroundWaiters(): void {
    for (const release of [...this.backgroundWaiters]) release();
  }

  private prepareForeground(): Promise<void> {
    if (this.foregroundHandoff !== null) {
      return this.foregroundHandoff;
    }

    const retained = [...this.activeBackground].find((attempt) =>
      !attempt.preempted && attempt.foregroundHandoffMs > 0
    );
    if (!retained) return this.preemptBackground();

    const handoff = this.drainForForegroundWithHandoff(retained);
    this.foregroundHandoff = handoff;
    const clearHandoff = () => {
      if (this.foregroundHandoff === handoff) {
        this.foregroundHandoff = null;
      }
    };
    void handoff.then(clearHandoff, clearHandoff);
    return handoff;
  }

  private async drainForForegroundWithHandoff(
    retained: ActiveBackgroundAttempt,
  ): Promise<void> {
    const active = [...this.activeBackground];
    for (const attempt of active) {
      if (attempt === retained) continue;
      preemptBackgroundAttempt(attempt);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      retained.settled.then(() => "settled" as const),
      new Promise<"expired">((resolve) => {
        timer = setTimeout(
          () => resolve("expired"),
          retained.foregroundHandoffMs,
        );
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "expired") {
      preemptBackgroundAttempt(retained);
    }
    await Promise.allSettled(active.map((attempt) => attempt.settled));
  }

  private async preemptBackground(): Promise<void> {
    const active = [...this.activeBackground];
    for (const attempt of active) {
      preemptBackgroundAttempt(attempt);
    }
    await Promise.allSettled(active.map((attempt) => attempt.settled));
  }
}

function preemptBackgroundAttempt(attempt: ActiveBackgroundAttempt): void {
  if (attempt.preempted) return;
  attempt.preempted = true;
  attempt.controller.abort(new LiveRethBackgroundPreempted());
}

function normalizeHandoffMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.floor(value));
}

function waitForSettlement(
  promise: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAborted);
      operation();
    };
    const onAborted = () => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAborted, { once: true });
    promise.then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) onAborted();
  });
}

class LiveRethBackgroundPreempted extends Error {
  constructor() {
    super("live reth background read preempted by higher-priority work");
    this.name = "LiveRethBackgroundPreempted";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}
