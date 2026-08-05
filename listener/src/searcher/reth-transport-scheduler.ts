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
    });

    try {
      return await work(lease);
    } finally {
      release();
    }
  }

  snapshot(): Readonly<{
    activeTotal: number;
    activeByLane: Readonly<Record<RethTransportLane, number>>;
    queuedByLane: Readonly<Record<RethTransportLane, number>>;
  }> {
    return Object.freeze({
      activeTotal: this.activeTotal,
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
    if (this.activeTotal >= this.options.capacity) return false;
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
      this.options.capacity - this.options.producerReserved
    );
  }

  private drain(): void {
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
