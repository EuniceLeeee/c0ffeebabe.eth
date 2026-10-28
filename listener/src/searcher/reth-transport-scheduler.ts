import { isStateCallAbortedError } from "../shared/state/state-backend.js";
import { isRpcQuotaExhaustedError, isRpcThrottleError } from "./rpc-throttle-guard.js";

/**
 * Shared reth transport permit scheduler.
 *
 * One permit covers one physical HTTP request/batch, never a whole
 * generation or exact stage. Producer lanes may use the full capacity;
 * exact and discovery share the residual capacity after the producer
 * reserve, so exact traffic can never starve the N-1 producer.
 */
export type RethTransportLane =
  | "producer-critical"
  | "producer-bulk"
  | "exact"
  | "discovery";

export interface RethTransportLease {
  readonly queueWaitMs: number;
  readonly activeTotal: number;
  readonly activeByLane: Readonly<Record<RethTransportLane, number>>;
  /** Shared authority survives run-only forwarding wrappers and new scopes. */
  readonly load?: RethTransportLoad;
}

export interface RethTransportAttempt {
  readonly version: number;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly batch?: RethTransportRetryBatch;
}

/** Shared only by the failed envelope and its split retries, never by a scope. */
export interface RethTransportRetryBatch {
  version: number;
  level: number;
  notBeforeMs: number;
  delayMs: number;
}

export interface RethTransportRetryState {
  transportRetriesAtOne?: number;
  transportRetryBatch?: RethTransportRetryBatch;
}

export interface RethTransportLoad {
  readonly timeoutMs: number;
  limits(batchSize: number, concurrency: number, items?: readonly RethTransportRetryState[]): RethTransportAttempt;
  retryDelayMs(items?: readonly RethTransportRetryState[]): number;
  /** Only report actual wire failures, while the caller/scope is still live. */
  retry(error: unknown, items: readonly RethTransportRetryState[], attempt: RethTransportAttempt): boolean;
  /** Effective per-batch retry budget at concurrency 1, so logs can report the real denominator. */
  readonly maxRetriesAtOne?: number;
}

/** No message matching: a logical deadline/revert is not a socket timeout. */
export function isRethTransportTimeout(error: unknown): boolean {
  if (isStateCallAbortedError(error)) return error.kind === "timeout";
  return error instanceof Error &&
    ["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]
      .includes((error as Error & { code?: string }).code ?? "");
}

interface SchedulerWaiter {
  readonly lane: RethTransportLane;
  readonly signal: AbortSignal;
  readonly queuedAtMs: number;
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason?: unknown) => void;
  readonly onAbort: () => void;
}

const LANE_ORDER: readonly RethTransportLane[] = Object.freeze([
  "producer-critical",
  "producer-bulk",
  "exact",
  "discovery",
]);

function emptyLaneCounts(): Record<RethTransportLane, number> {
  return {
    "producer-critical": 0,
    "producer-bulk": 0,
    exact: 0,
    discovery: 0,
  };
}

export class RethTransportScheduler {
  private startupCompleted = false;
  private readonly load: RethTransportLoad;
  private activeTotal = 0;
  private readonly activeByLane = emptyLaneCounts();
  private readonly queues: Record<
    RethTransportLane,
    SchedulerWaiter[]
  > = {
    "producer-critical": [],
    "producer-bulk": [],
    exact: [],
    discovery: [],
  };

  constructor(
    private readonly options: {
      readonly capacity: number;
      readonly producerReserved: number;
      readonly transportTimeoutMs?: number;
      readonly retryDelayMs?: number;
      /**
       * Throttle/timeout retries still allowed once this batch's ladder has
       * degraded to concurrency 1. A metered provider can refuse one batch for
       * minutes while the caller still holds a valid budget; giving up after a
       * handful of attempts turns a recoverable throughput dip into a dead
       * pass. Only the throttled batch pays this, never the whole scope.
       */
      readonly maxRetriesAtOne?: number;
      /** Ceiling for the exponential retry backoff of a degraded batch. */
      readonly maxRetryDelayMs?: number;
    },
  ) {
    if (
      !Number.isSafeInteger(options.capacity) ||
      options.capacity < 2
    ) {
      throw new Error(
        `invalid reth transport capacity ${options.capacity}`,
      );
    }
    if (
      !Number.isSafeInteger(options.producerReserved) ||
      options.producerReserved < 1 ||
      options.producerReserved >= options.capacity
    ) {
      throw new Error(
        `invalid producer reserve ${options.producerReserved}`,
      );
    }
    for (const value of [options.transportTimeoutMs ?? 30_000, options.retryDelayMs ?? 1_000]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid reth transport timing");
    }
    const maxRetriesAtOne = options.maxRetriesAtOne ?? 3;
    const maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    if (!Number.isSafeInteger(maxRetriesAtOne) || maxRetriesAtOne < 1) {
      throw new Error("invalid reth transport retry budget");
    }
    if (!Number.isSafeInteger(maxRetryDelayMs) || maxRetryDelayMs <= 0) {
      throw new Error("invalid reth transport retry delay");
    }
    this.load = Object.freeze({
      timeoutMs: options.transportTimeoutMs ?? 30_000,
      maxRetriesAtOne,
      limits: (batchSize: number, concurrency: number, items: readonly RethTransportRetryState[] = []) => {
        const batch = items[0]?.transportRetryBatch;
        const reduce = (n: number) => Math.max(1, Math.floor(n / 2 ** (batch?.level ?? 0)));
        return Object.freeze({version: batch?.version ?? 0, batchSize: reduce(batchSize),
          concurrency: reduce(concurrency), ...(batch ? {batch} : {})});
      },
      retryDelayMs: (items: readonly RethTransportRetryState[] = []) => items[0]?.transportRetryBatch?.delayMs ?? 0,
      retry: (error: unknown, items: readonly RethTransportRetryState[], attempt: RethTransportAttempt) => {
        if ((!isRethTransportTimeout(error) && !isRpcThrottleError(error)) ||
            isRpcQuotaExhaustedError(error) || items.length === 0) return false;
        const batch = attempt.batch ?? items[0]?.transportRetryBatch ?? {
          version: 0, level: 0, notBeforeMs: 0, delayMs: 0,
        };
        for (const item of items) item.transportRetryBatch = batch;
        // In-flight split siblings from one tier lower their own group once.
        if (attempt.version === batch.version) {
          batch.version++;
          batch.level++;
        }
        const exhausted = attempt.concurrency === 1 &&
          items.some(item => (item.transportRetriesAtOne ?? 0) >= maxRetriesAtOne);
        if (!exhausted && attempt.concurrency === 1) for (const item of items) {
          item.transportRetriesAtOne = (item.transportRetriesAtOne ?? 0) + 1;
        }
        const atOne = Math.max(...items.map(item => item.transportRetriesAtOne ?? 0));
        const delayMs = Math.min(
          (options.retryDelayMs ?? 1_000) * 2 ** Math.max(0, atOne - 1),
          maxRetryDelayMs,
        );
        batch.delayMs = delayMs;
        batch.notBeforeMs = Math.max(batch.notBeforeMs, Date.now() + delayMs);
        return !exhausted;
      },
    });
  }

  /** Call after startup-owned work drains, before dispatching the first steady head. */
  completeStartup(): boolean {
    if (this.startupCompleted) return false;
    this.startupCompleted = true;
    return true;
  }

  private get capacity(): number { return this.options.capacity; }
  private get producerReserved(): number {
    return this.options.producerReserved;
  }

  async run<T>(
    lane: RethTransportLane,
    signal: AbortSignal,
    work: (lease: RethTransportLease) => Promise<T>,
  ): Promise<T> {
    const queuedAtMs = performance.now();
    const release = await this.acquire(lane, signal, queuedAtMs);
    const lease = Object.freeze({
      queueWaitMs: Math.max(0, performance.now() - queuedAtMs),
      activeTotal: this.activeTotal,
      activeByLane: Object.freeze({ ...this.activeByLane }),
      load: this.load,
    });

    try {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      return await work(lease);
    } finally {
      release();
    }
  }

  snapshot(): Readonly<{
    activeTotal: number;
    activeByLane: Readonly<Record<RethTransportLane, number>>;
    queuedByLane: Readonly<Record<RethTransportLane, number>>;
    capacity: number;
    producerReserved: number;
    reductionVersion: number;
    reductionLevel: number;
  }> {
    return Object.freeze({
      activeTotal: this.activeTotal,
      capacity: this.capacity,
      producerReserved: this.producerReserved,
      // Compatibility diagnostics: there is no run-wide reduction anymore.
      reductionVersion: 0,
      reductionLevel: 0,
      activeByLane: Object.freeze({ ...this.activeByLane }),
      queuedByLane: Object.freeze({
        "producer-critical": this.queues["producer-critical"].length,
        "producer-bulk": this.queues["producer-bulk"].length,
        exact: this.queues.exact.length,
        discovery: this.queues.discovery.length,
      }),
    });
  }

  private acquire(
    lane: RethTransportLane,
    signal: AbortSignal,
    queuedAtMs: number,
  ): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    }

    return new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        const queue = this.queues[lane];
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        signal.removeEventListener("abort", onAbort);
        reject(
          signal.reason ?? new DOMException("Aborted", "AbortError"),
        );
        this.drain();
      };

      const waiter: SchedulerWaiter = {
        lane,
        signal,
        queuedAtMs,
        resolve,
        reject,
        onAbort,
      };

      this.queues[lane].push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      else this.drain();
    });
  }

  private canAdmit(lane: RethTransportLane): boolean {
    if (this.activeTotal >= this.capacity) return false;
    if (
      lane === "producer-critical" ||
      lane === "producer-bulk"
    ) {
      return true;
    }
    const activeNonProducer =
      this.activeByLane.exact + this.activeByLane.discovery;
    return (
      activeNonProducer <
      this.capacity - this.producerReserved
    );
  }

  private drain(): void {
    if (!LANE_ORDER.some(lane => this.queues[lane].length > 0)) return;
    for (;;) {
      let admitted = false;

      for (const lane of LANE_ORDER) {
        const queue = this.queues[lane];
        while (queue[0]?.signal.aborted) {
          const aborted = queue.shift()!;
          aborted.signal.removeEventListener(
            "abort",
            aborted.onAbort,
          );
          aborted.reject(
            aborted.signal.reason ??
              new DOMException("Aborted", "AbortError"),
          );
        }

        const waiter = queue[0];
        if (!waiter || !this.canAdmit(lane)) continue;

        queue.shift();
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        this.activeTotal++;
        this.activeByLane[lane]++;
        waiter.resolve(this.releaseOnce(lane));
        admitted = true;
        break;
      }

      if (!admitted) return;
    }
  }

  private releaseOnce(lane: RethTransportLane): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.activeTotal--;
      this.activeByLane[lane]--;
      this.drain();
    };
  }
}
