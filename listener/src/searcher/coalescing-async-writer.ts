export interface CoalescingAsyncWriterTelemetry {
  readonly scheduled: number;
  readonly started: number;
  readonly completed: number;
  readonly failed: number;
  readonly coalesced: number;
  readonly active: boolean;
  readonly pending: boolean;
}

/**
 * One asynchronous writer with one latest pending value. Callers never wait
 * for persistence; flush is reserved for orderly shutdown and tests.
 */
export class CoalescingAsyncWriter<T> {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private pending: T | null = null;
  private lastError: unknown = null;
  private scheduled = 0;
  private started = 0;
  private completed = 0;
  private failed = 0;
  private coalesced = 0;

  constructor(
    private readonly delayMs: number,
    private readonly write: (value: T) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new Error(`invalid coalescing writer delay ${delayMs}`);
    }
  }

  schedule(value: T): void {
    this.scheduled++;
    if (this.pending !== null) this.coalesced++;
    this.pending = value;
    if (this.active || this.timer) return;
    this.arm();
  }

  telemetry(): CoalescingAsyncWriterTelemetry {
    return Object.freeze({
      scheduled: this.scheduled,
      started: this.started,
      completed: this.completed,
      failed: this.failed,
      coalesced: this.coalesced,
      active: this.active !== null,
      pending: this.pending !== null,
    });
  }

  async flush(): Promise<void> {
    this.clearTimer();
    while (this.active || this.pending !== null) {
      if (!this.active) this.start();
      await this.active;
      this.clearTimer();
    }
    if (this.lastError !== null) {
      const error = this.lastError;
      // Report every observed failure once. A later explicit schedule+flush
      // may then prove that the newest state was durably written.
      this.lastError = null;
      throw error;
    }
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, this.delayMs);
    this.timer.unref();
  }

  private start(): void {
    if (this.active || this.pending === null) return;
    const value = this.pending;
    this.pending = null;
    this.started++;
    let succeeded = false;
    this.active = this.write(value)
      .then(() => {
        succeeded = true;
      })
      .catch((error) => {
        this.failed++;
        this.lastError = error;
        this.onError(error);
      })
      .finally(() => {
        if (succeeded) this.completed++;
        this.active = null;
        if (this.pending !== null && this.timer === null) this.arm();
      });
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
