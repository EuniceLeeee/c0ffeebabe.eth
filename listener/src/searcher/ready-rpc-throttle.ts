import { AsyncLocalStorage } from "node:async_hooks";
import { RevmFatalError, type RevmFatalReason } from "./revm-sim-client.js";
import { isRpcQuotaExhaustedError, isRpcThrottleError } from "./rpc-throttle-guard.js";

export class ReadyRpcRateError extends Error {
  constructor(readonly quotaExhausted = false) {
    super(quotaExhausted ? "Ready RPC allocation exhausted" : "Ready RPC temporary rate limit");
    this.name = "ReadyRpcRateError";
  }
}

export interface ReadyRpcThrottleState {
  readonly concurrency: number;
  readonly batchMaxCount: number;
  readonly responsesAtLevel: number;
  readonly stopped: boolean;
}

/** One Ready run owns this policy; Families and live transports do not. */
export class ReadyRpcThrottle {
  private concurrencyLimit: number;
  private batchLimit = 8;
  private responses = 0;
  private terminal?: Error;
  private readonly observed = new WeakSet<object>();
  private readonly attempts = new AsyncLocalStorage<{ failure?: Error }>();

  constructor(initialConcurrency = 4, private readonly log: (state: ReadyRpcThrottleState) => void = state => {
    console.warn("[ready/rpc-throttle] " + JSON.stringify(state));
  }, initialState?: ReadyRpcThrottleState) {
    if (!Number.isSafeInteger(initialConcurrency) || initialConcurrency < 1 || initialConcurrency > 4) {
      throw new Error("Ready concurrency must be between 1 and 4");
    }
    this.concurrencyLimit = initialConcurrency;
    if (initialState !== undefined) {
      if (initialState.stopped !== false ||
          !Number.isSafeInteger(initialState.concurrency) || initialState.concurrency < 1 || initialState.concurrency > 4 ||
          ![1, 2, 4, 8].includes(initialState.batchMaxCount) ||
          initialState.concurrency > 1 && initialState.batchMaxCount !== 8 ||
          !Number.isSafeInteger(initialState.responsesAtLevel) || initialState.responsesAtLevel < 0 || initialState.responsesAtLevel > 2) {
        throw new Error("Cannot resume a stopped or invalid Ready RPC policy");
      }
      this.concurrencyLimit = Math.min(initialConcurrency, initialState.concurrency);
      this.batchLimit = initialState.batchMaxCount;
      this.responses = initialState.responsesAtLevel;
    }
  }

  get concurrency(): number { return this.concurrencyLimit; }
  get batchMaxCount(): number { return this.batchLimit; }
  limitConcurrency(maximum: number): void {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("invalid Ready concurrency ceiling");
    this.concurrencyLimit = Math.min(this.concurrencyLimit, maximum);
  }
  get inAttempt(): boolean { return this.attempts.getStore() !== undefined; }
  snapshot(): ReadyRpcThrottleState {
    return Object.freeze({ concurrency: this.concurrencyLimit, batchMaxCount: this.batchLimit,
      responsesAtLevel: this.responses, stopped: this.terminal !== undefined });
  }

  isTemporary(reason: RevmFatalReason): boolean {
    return reason.kind === "rpc-throttle" && reason.category !== "rpc-quota-exhausted";
  }

  isThrottle(error: unknown): boolean {
    return error instanceof ReadyRpcRateError || error instanceof RevmFatalError && error.fatal.kind === "rpc-throttle";
  }

  /** Capture the owner before child I/O callbacks cross an async boundary. */
  captureFailure(): (reason: RevmFatalReason) => boolean {
    const attempt = this.attempts.getStore();
    return reason => {
      if (attempt) attempt.failure ??= new RevmFatalError(reason);
      return attempt !== undefined;
    };
  }

  markFailure(error: Error): void {
    const attempt = this.attempts.getStore();
    if (attempt) attempt.failure ??= error;
  }

  assertOpen(): void {
    if (this.terminal) throw this.terminal;
    const failure = this.attempts.getStore()?.failure;
    if (failure) throw failure;
  }

  async attempt<T>(work: () => Promise<T>): Promise<T> {
    return this.attempts.run({}, async () => {
      this.assertOpen();
      const result = await work();
      this.assertOpen();
      return result;
    });
  }

  /** Observe once at the retry owner, never once per diagnostic propagation. */
  observe(error: unknown): void {
    if (this.terminal) throw this.terminal;
    if (!this.isThrottle(error) && !isRpcThrottleError(error)) throw error;
    const exhausted = error instanceof ReadyRpcRateError ? error.quotaExhausted
      : error instanceof RevmFatalError ? error.fatal.kind === "rpc-throttle" && error.fatal.category === "rpc-quota-exhausted"
      : isRpcQuotaExhaustedError(error);
    if (exhausted) {
      this.terminal = new ReadyRpcRateError(true);
      this.log(this.snapshot());
    } else if (typeof error === "object" && error !== null && !this.observed.has(error)) {
      this.observed.add(error);
      if (++this.responses === 3) {
        if (this.concurrencyLimit > 1) this.concurrencyLimit--;
        else if (this.batchLimit > 1) this.batchLimit /= 2;
        else this.terminal = new Error("Ready RPC throttling persisted at concurrency=1 batch=1");
        if (!this.terminal) this.responses = 0;
      }
      this.log(this.snapshot());
    }
    if (this.terminal) throw this.terminal;
  }

  /** Source reads outside candidate admission use the same response budget. */
  async read<T>(work: () => Promise<T>): Promise<T> {
    for (;;) {
      this.assertOpen();
      try { return await work(); }
      catch (error) {
        // Only this provider's wire errors can start a fresh source read.
        // An unowned simulator fatal is latched by wiring and cannot recover
        // by repeating the same rejected operation (or spend a second budget).
        if (this.inAttempt || !(error instanceof ReadyRpcRateError)) throw error;
        this.observe(error);
      }
    }
  }

  /** Retire slots after a downgrade; a throttled candidate is never completed. */
  async runCandidates<C, R>(candidates: readonly C[], work: (candidate: C) => Promise<R>, completed: (result: R) => void): Promise<void> {
    type Settled = { index: number; pending: Promise<Settled> } &
      ({ ok: true; result: R } | { ok: false; error: unknown });
    const active = new Set<Promise<Settled>>();
    const retries: number[] = [];
    let next = 0;
    const launch = (index: number): void => {
      let pending: Promise<Settled>;
      pending = this.attempt(() => work(candidates[index]!)).then(
        result => ({ ok: true as const, result, index, pending }),
        error => ({ ok: false as const, error, index, pending }),
      );
      active.add(pending);
    };
    try {
      while (next < candidates.length || retries.length || active.size) {
        this.assertOpen();
        while (active.size < this.concurrency && (retries.length || next < candidates.length)) {
          launch(retries.shift() ?? next++);
        }
        const settled = await Promise.race(active);
        active.delete(settled.pending);
        if (settled.ok) completed(settled.result);
        else {
          this.observe(settled.error);
          retries.push(settled.index);
        }
      }
    } finally {
      // Join already-started siblings before the runner flushes its checkpoint.
      for (const settled of await Promise.all(active)) if (settled.ok) completed(settled.result);
    }
  }
}
