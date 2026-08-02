type CriticalWork<T> = () => Promise<T>;
type BackgroundWork<T> = (signal: AbortSignal) => Promise<T>;

interface ActiveBackgroundAttempt {
  readonly controller: AbortController;
  settled: Promise<void>;
  preempted: boolean;
}

type BackgroundOutcome<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "failure"; readonly error: unknown }
  | { readonly kind: "external-abort"; readonly error: unknown };

/**
 * Gives current-block reth reads priority over retry-safe background RPCs.
 *
 * Background work must be one idempotent RPC attempt and must pass the
 * supplied signal to its transport. A critical request aborts and drains all
 * active background attempts before it starts. Internally preempted attempts
 * retry after the complete critical queue drains; caller cancellation never
 * retries.
 */
export class LiveRethReadPriority {
  private readonly activeBackground = new Set<ActiveBackgroundAttempt>();
  private readonly backgroundWaiters = new Set<() => void>();
  private criticalCount = 0;
  private criticalTail: Promise<void> = Promise.resolve();

  async runCritical<T>(work: CriticalWork<T>): Promise<T> {
    this.criticalCount++;

    const previous = this.criticalTail;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.criticalTail = previous.then(() => turn);

    const active = [...this.activeBackground];
    for (const attempt of active) {
      attempt.preempted = true;
      attempt.controller.abort(new LiveRethBackgroundPreempted());
    }

    try {
      await Promise.allSettled(active.map((attempt) => attempt.settled));
      await previous;
      return await work();
    } finally {
      release();
      this.criticalCount--;
      if (this.criticalCount === 0) this.releaseBackgroundWaiters();
    }
  }

  async runBackground<T>(
    work: BackgroundWork<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    for (;;) {
      await this.waitForCriticalQueue(parentSignal);
      throwIfAborted(parentSignal);
      // `await` always yields, even when no critical work existed when the
      // wait began. A critical request may announce itself in that gap before
      // this attempt is registered and therefore cannot abort it. Recheck in
      // the same synchronous turn that registers the attempt.
      if (this.criticalCount > 0) continue;

      const controller = new AbortController();
      const attempt: ActiveBackgroundAttempt = {
        controller,
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

  private waitForCriticalQueue(parentSignal?: AbortSignal): Promise<void> {
    throwIfAborted(parentSignal);
    if (this.criticalCount === 0) return Promise.resolve();

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
      else if (this.criticalCount === 0) onReleased();
    });
  }

  private releaseBackgroundWaiters(): void {
    for (const release of [...this.backgroundWaiters]) release();
  }
}

class LiveRethBackgroundPreempted extends Error {
  constructor() {
    super("live reth background read preempted by critical work");
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
