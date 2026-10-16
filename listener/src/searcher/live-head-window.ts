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

  constructor(readonly seed: number, readonly limit: number,
    private readonly emit: (event: Record<string, unknown>) => void,
    private readonly closeIntake: () => void) {
    this.highest = seed;
    if (!Number.isSafeInteger(seed) || seed < 0 || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("invalid live head window");
    }
  }

  observe(head: LiveHeadObservation, schedule: () => void): void {
    const record = (event: string, extra: Record<string, unknown> = {}) =>
      this.emit({ event, ...head, count: this.count, limit: this.limit, seed: this.seed, ...extra });
    if (head.number <= this.seed) { record("seed_or_old"); return; }
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
