export interface CoalescingPublicationChain {
  /**
   * Queue one publication-chain run for a producer. Runs are serialized in
   * producer order; a re-enqueue for the same producer while its run is in
   * flight coalesces into exactly one rerun (the closure captures the latest
   * live publication), so no producer can queue unboundedly behind a slow
   * pass. Distinct producers beyond the backlog bound evict the oldest
   * pending producer and are reported through onError.
   */
  readonly enqueue: (
    run: () => Promise<void>,
    options?: {
      readonly producerKey?: string;
      readonly deadlineMs?: number;
    },
  ) => void;
  /** Resolves when every queued/in-flight run has settled. */
  readonly idle: () => Promise<void>;
  /** Distinct producers currently waiting behind the in-flight run. */
  readonly backlogSize: () => number;
  /** Producers evicted because the backlog bound was exceeded. */
  readonly evictions: () => number;
}

export class PublicationChainDeadlineError extends Error {
  readonly producerKey: string;
  readonly deadlineMs: number;
  constructor(producerKey: string, deadlineMs: number) {
    super(
      `strict publication chain producer ${producerKey} exceeded ` +
        `${deadlineMs}ms deadline`,
    );
    this.name = "PublicationChainDeadlineError";
    this.producerKey = producerKey;
    this.deadlineMs = deadlineMs;
  }
}

export class PublicationChainBacklogEvictionError extends Error {
  readonly producerKey: string;
  readonly maxBacklog: number;
  constructor(producerKey: string, maxBacklog: number) {
    super(
      `strict publication chain backlog bound ${maxBacklog} exceeded; ` +
        `evicted producer ${producerKey}`,
    );
    this.name = "PublicationChainBacklogEvictionError";
    this.producerKey = producerKey;
    this.maxBacklog = maxBacklog;
  }
}

/**
 * Serialized, coalescing execution for the live strict publication chain.
 * Checkpoint inventory sync and catalogRoot CAS share one capture per run,
 * and runs are strictly ordered, so two publication callbacks can never
 * interleave checkpoint writes with the catalog CAS.
 */
export function createCoalescingPublicationChain(
  onError?: (error: unknown) => void,
  options?: { readonly maxBacklog?: number },
): CoalescingPublicationChain {
  const maxBacklog = options?.maxBacklog ?? 64;
  if (!Number.isSafeInteger(maxBacklog) || maxBacklog < 1) {
    throw new Error("publication chain maxBacklog must be a positive integer");
  }
  let tail: Promise<void> = Promise.resolve();
  let running = false;
  let evictions = 0;
  const pending = new Map<string, {
    readonly run: () => Promise<void>;
    readonly deadlineMs: number | undefined;
  }>();

  const runWithDeadline = async (
    producerKey: string,
    deadlineMs: number | undefined,
    run: () => Promise<void>,
  ): Promise<void> => {
    if (deadlineMs === undefined) {
      await run();
      return;
    }
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
      throw new Error("publication chain deadlineMs must be a positive integer");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PublicationChainDeadlineError(
              producerKey,
              deadlineMs,
            )),
            deadlineMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const drain = async (): Promise<void> => {
    while (true) {
      while (pending.size > maxBacklog) {
        const oldestKey = pending.keys().next().value as string;
        pending.delete(oldestKey);
        evictions++;
        if (onError !== undefined) {
          onError(new PublicationChainBacklogEvictionError(
            oldestKey,
            maxBacklog,
          ));
        }
      }
      const first = pending.keys().next();
      if (first.done) break;
      const key = first.value;
      const entry = pending.get(key)!;
      pending.delete(key);
      try {
        await runWithDeadline(key, entry.deadlineMs, entry.run);
      } catch (error) {
        if (onError !== undefined) onError(error);
      }
    }
    running = false;
    if (pending.size > 0) {
      running = true;
      await drain();
    }
  };

  return Object.freeze({
    enqueue(run: () => Promise<void>, enqueueOptions?: {
      readonly producerKey?: string;
      readonly deadlineMs?: number;
    }) {
      const producerKey = enqueueOptions?.producerKey ?? "default";
      pending.set(producerKey, Object.freeze({
        run,
        deadlineMs: enqueueOptions?.deadlineMs,
      }));
      if (running) return;
      running = true;
      tail = tail.then(drain);
    },
    idle: () => tail,
    backlogSize: () => pending.size,
    evictions: () => evictions,
  });
}
