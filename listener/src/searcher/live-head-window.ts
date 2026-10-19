export function parseLiveMaxNewHeads(value: string | undefined): number {
  if (value === undefined || value === "0") return 0;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("SEARCHER_LIVE_MAX_NEW_HEADS must be a nonnegative safe integer");
  }
  return Number(value);
}

export interface LiveHeadObservation {
  number: number;
  hash?: string;
  source: "ws" | "http";
  observedAtMs: number;
  observedAtMonotonicMs: number;
}

/** Bound intake only; success, failure and drain remain owned by the live scheduler. */
export class LiveHeadWindow {
  private readonly seen = new Map<number, string | undefined>();
  private highest: number;
  private count = 0;
  private nextHeadResolve!: () => void;
  readonly nextHead = new Promise<void>((resolve) => { this.nextHeadResolve = resolve; });
  closed = false;
  private nextHeadSeen = false;
  private measurementSeed: number | undefined;
  private warmupCount = 0;
  private readonly warmupDeadlineAt: number | undefined;
  private warmupTimer: ReturnType<typeof setTimeout> | undefined;
  warmupFailure: "head-limit" | "deadline" | undefined;

  get waitingForWarmup(): boolean { return this.measurementSeed === undefined; }

  /** A completed startup publication may arm once, after all its I/O drained. */
  armAfterWarmup(): boolean {
    if (this.closed || !this.waitingForWarmup) return false;
    // Check the absolute deadline even if a busy event loop has delayed its timer.
    if (performance.now() >= this.warmupDeadlineAt!) {
      this.closeWarmup("deadline");
      return false;
    }
    if (this.warmupCount >= this.limit) {
      this.closeWarmup("head-limit");
      return false;
    }
    this.measurementSeed = this.highest;
    this.dispose();
    this.emit({ event: "measurement_armed", seed: this.seed, measurementSeed: this.measurementSeed,
      count: 0, warmupCount: this.warmupCount, limit: this.limit,
      observedAtMs: Date.now(), observedAtMonotonicMs: performance.now() });
    return true;
  }

  dispose(): void { clearTimeout(this.warmupTimer); this.warmupTimer = undefined; }

  private closeWarmup(reason: "head-limit" | "deadline"): void {
    if (this.closed || !this.waitingForWarmup) return;
    this.warmupFailure = reason;
    this.closed = true;
    this.dispose();
    this.emit({ event: "input_closed", phase: "warmup", reason, seed: this.seed,
      count: 0, warmupCount: this.warmupCount, limit: this.limit,
      observedAtMs: Date.now(), observedAtMonotonicMs: performance.now() });
    this.closeIntake();
  }

  constructor(readonly seed: number, readonly limit: number,
    private readonly emit: (event: Record<string, unknown>) => void,
    private readonly closeIntake: () => void,
    options?: { readonly waitForWarmup: boolean; readonly warmupMaxMs: number }) {
    this.highest = seed;
    if (!Number.isSafeInteger(seed) || seed < 0 || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("invalid live head window");
    }
    if (options?.waitForWarmup) {
      if (!Number.isSafeInteger(options.warmupMaxMs) || options.warmupMaxMs <= 0 || options.warmupMaxMs > 2_147_483_647) {
        throw new Error("invalid live warmup deadline");
      }
      const startedAtMonotonicMs = performance.now();
      this.warmupDeadlineAt = startedAtMonotonicMs + options.warmupMaxMs;
      this.emit({ event: "warmup_started", phase: "warmup", seed, limit,
        warmupMaxMs: options.warmupMaxMs, deadlineAtMonotonicMs: this.warmupDeadlineAt,
        observedAtMs: Date.now(), observedAtMonotonicMs: startedAtMonotonicMs });
      this.warmupTimer = setTimeout(() => this.closeWarmup("deadline"), options.warmupMaxMs);
      this.warmupTimer.unref?.();
    } else this.measurementSeed = seed;
  }

  observe(head: LiveHeadObservation, schedule: () => void): void {
    const record = (event: string, extra: Record<string, unknown> = {}) =>
      this.emit({ event, ...head, count: this.count, limit: this.limit, seed: this.seed,
        ...(this.warmupDeadlineAt === undefined ? {} : { phase: this.waitingForWarmup ? "warmup" : "measurement",
          warmupCount: this.warmupCount, measurementSeed: this.measurementSeed ?? null }), ...extra });
    if (this.waitingForWarmup && !this.closed && performance.now() >= this.warmupDeadlineAt!) {
      this.closeWarmup("deadline");
    }
    if (head.number <= (this.measurementSeed ?? this.seed)) { record("seed_or_old"); return; }
    if (this.seen.has(head.number)) {
      const previousHash = this.seen.get(head.number);
      record(previousHash && head.hash && previousHash !== head.hash ? "reorg" : "duplicate",
        { previousHash: previousHash ?? null });
      if (head.hash) this.seen.set(head.number, head.hash);
      return;
    }
    if (this.closed) {
      if (!this.nextHeadSeen && head.number > this.highest) {
        this.nextHeadSeen = true;
        record("next_head");
        this.nextHeadResolve();
      }
      return;
    }
    if (head.number > this.highest + 1) record("gap", { from: this.highest + 1, to: head.number - 1 });
    else if (head.number < this.highest) record("out_of_order");
    this.seen.set(head.number, head.hash);
    this.highest = Math.max(this.highest, head.number);
    if (this.waitingForWarmup) {
      this.warmupCount++;
      record("warmup_head");
      schedule();
      if (this.warmupCount === this.limit) this.closeWarmup("head-limit");
      return;
    }
    this.count++;
    record("head");
    schedule(); // The last head is delivered before intake closes.
    if (this.count === this.limit) {
      this.closed = true;
      record("input_closed");
      this.closeIntake();
    }
  }
}
