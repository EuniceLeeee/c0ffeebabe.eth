export interface CoalescingPublicationChain {
  /**
   * Queue one publication-chain run. While a run is in flight, further
   * enqueue calls are coalesced into exactly one rerun (the caller's
   * closures capture the latest live publication inside the run), so the
   * chain can never queue unboundedly behind a slow pass.
   */
  readonly enqueue: (run: () => Promise<void>) => void;
  /** Resolves when every queued/in-flight run has settled. */
  readonly idle: () => Promise<void>;
}

/**
 * Serialized, coalescing execution for the live strict publication chain.
 * Checkpoint inventory sync and catalogRoot CAS share one capture per run,
 * and runs are strictly ordered, so two publication callbacks can never
 * interleave checkpoint writes with the catalog CAS.
 */
export function createCoalescingPublicationChain(
  onError?: (error: unknown) => void,
): CoalescingPublicationChain {
  let tail: Promise<void> = Promise.resolve();
  let running = false;
  let rerunRequested = false;
  let latestRun: (() => Promise<void>) | null = null;
  return Object.freeze({
    enqueue(run: () => Promise<void>) {
      latestRun = run;
      if (running) {
        rerunRequested = true;
        return;
      }
      running = true;
      tail = tail.then(async () => {
        do {
          rerunRequested = false;
          const current = latestRun;
          try {
            if (current !== null) await current();
          } catch (error) {
            if (onError !== undefined) onError(error);
          }
        } while (rerunRequested);
        running = false;
      });
    },
    idle: () => tail,
  });
}
