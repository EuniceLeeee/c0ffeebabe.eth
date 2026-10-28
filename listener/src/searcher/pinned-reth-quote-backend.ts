import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as retryDelay } from "node:timers/promises";
import { ethers } from "ethers";
import {
  decodeUintCall,
  isStateCallAbortedError,
  nativeTransfersToCaller,
  postJsonRpc,
  simulationCalls,
  StateCallAbortedError,
  type JsonRpcHttpResponse,
  type JsonRpcHttpTiming,
  type StateBackend,
  type StateCallControl,
  type TokenToNativeDeltaRequest,
  type TokenToNativeDeltaResult,
} from "../shared/state/state-backend.js";
import {
  RethTransportScheduler,
  isRethTransportTimeout,
  type RethTransportAttempt,
  type RethTransportLease,
  type RethTransportLoad,
  type RethTransportRetryState,
  type RethTransportRetryBatch,
} from "./reth-transport-scheduler.js";
import { isRpcQuotaExhaustedError, isRpcThrottleError } from "./rpc-throttle-guard.js";

/**
 * Pass-scoped source-hash pinned quote backend for block-scan producer and
 * exact work.
 *
 * All quote calls are coalesced into JSON-RPC batches (NOT Multicall3) sent
 * directly to local reth. Every batch item keeps its own to/data/from and the
 * EIP-1898 block-hash specifier, so per-item semantics (msg.sender, non-view
 * calls, revert data) are identical to individual eth_call requests. Items
 * that need real execution (self-burn / ethertoken native redemption) are
 * grouped into a separate eth_simulateV1 batch.
 *
 * Lifecycle: the backend is created per producer generation or exact pass,
 * bound to that scope's signal and
 * deadline. abort() rejects every outstanding item and stops all in-flight
 * transports; closeAndDrain() waits for the transports to actually settle
 * before the pass is recorded, so an old exact batch can never keep running
 * on reth while the next pass/producer works. A pass-scope abort never
 * triggers the single-call fallback (that would re-create N old requests).
 */
export interface PassScopedExactStateBackend extends StateBackend {
  abort(reason?: unknown): void;
  closeAndDrain(reason?: unknown): Promise<number>;
}

export function isPassScopedExactStateBackend(
  value: StateBackend | null,
): value is PassScopedExactStateBackend {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<PassScopedExactStateBackend>;
  return (
    typeof candidate.abort === "function" &&
    typeof candidate.closeAndDrain === "function"
  );
}

export interface PinnedRethQuoteBackendOptions {
  readonly maxBatchSize?: number;
  readonly maxConcurrentBatches?: number;
  /** Opt into failed-batch recovery; physical timeouts always use it. */
  readonly retryRpcThrottle?: boolean;
  /** Physical lane used when acquiring the shared reth transport permit. */
  readonly transportLane?: "producer-critical" | "producer-bulk" | "exact";
  /** Human-readable scope included in diagnostics and abort errors. */
  readonly scopeLabel?: string;
  /**
   * Transport failure policy. Exact keeps the historical per-item fallback;
   * producer-bulk rejects the whole failed batch so a transport incident
   * cannot fan out into one physical request per logical work item.
   */
  readonly allowSingleCallFallback?: boolean;
  readonly signal?: AbortSignal;
  readonly deadlineAtMs?: number;
  /** Notified once after a confirmed unavailable source closes this backend. */
  readonly onSourceUnavailable?: (error: Error) => void;
  /** Notified once after raw RPC throttling closes this backend. */
  readonly onRpcThrottle?: (error: Error) => void;
  readonly transportScheduler?: Pick<RethTransportScheduler, "run">;
  /**
   * Durable cache for successful deterministic source-pinned eth_call results.
   * Replay and ordinary startup may opt in; hot passes remain memory-only.
   */
  readonly persistentEthCallCachePath?: string;
  readonly onPersistentCacheError?: (error: Error) => void;
}

interface SharedPendingCall {
  readonly controller: AbortController;
  readonly promise: Promise<string>;
  waiters: number;
}

let nextDiagnosticBackendId = 1;

export class PinnedRethQuoteBackend
  implements PassScopedExactStateBackend
{
  private readonly maxBatchSize: number;
  private readonly maxConcurrentBatches: number;
  private readonly transportScheduler: Pick<RethTransportScheduler, "run">;
  private standaloneScheduler: RethTransportScheduler | undefined;
  private transportLoad: RethTransportLoad | undefined;
  private throttleRetries = 0;
  private timeoutRetries = 0;
  private readonly transportLane: "producer-critical" | "producer-bulk" | "exact";
  private criticalBackend?: PinnedRethQuoteBackend;
  /** Parent of a critical-call view. Identity stays structural: a view
   *  and its owner are the same logical pricing backend. */
  private ownerBackend?: PinnedRethQuoteBackend;
  private readonly scopeLabel: string;
  private readonly allowSingleCallFallback: boolean;
  private readonly pending: PendingQuoteItem[] = [];
  private readonly liveItems = new Set<PendingQuoteItem>();
  private readonly activeFlushes = new Set<Promise<void>>();
  private readonly activeTransports = new Set<Promise<unknown>>();
  private readonly scopeController = new AbortController();

  private flushScheduled = false;
  private inFlightBatches = 0;
  private readonly activeRetryBatches = new Map<RethTransportRetryBatch, number>();
  private retryWake: {timer: ReturnType<typeof setTimeout>; promise: Promise<void>; resolve: () => void} | undefined;
  private nextId = 1;
  private readonly diagnosticBackendId = nextDiagnosticBackendId++;
  private closed = false;
  private detachParentAbort: () => void = () => {};
  private scopeDeadlineTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly balanceSlotMemo = new Map<string, string>();
  private readonly callMemo = new Map<string, Promise<string>>();
  private readonly pendingCalls = new Map<string, SharedPendingCall>();
  private readonly persistentCallCache:
    | PersistentPinnedEthCallCache
    | undefined;

  private totalCalls = 0;
  private memoHits = 0;
  private batchesSent = 0;
  private batchedItems = 0;
  private batchLatencyMs = 0;
  private maxBatchItemsSent = 0;
  private peakInFlightBatches = 0;
  private abortedBatches = 0;
  private completedAfterScopeAbort = 0;
  private transportQueueWaitMs = 0;
  private maxTransportQueueWaitMs = 0;
  private peakSchedulerActiveTotal = 0;
  private peakSchedulerLaneActive = 0;
  private batchFailures = 0;
  private singleCallFallbacks = 0;
  private batchesOnNewSocket = 0;
  private batchesOnReusedSocket = 0;
  private lastDrainMs = 0;

  private readonly blockSpecifier: {
    readonly blockHash: string;
    readonly requireCanonical: true;
  };

  constructor(
    private readonly rpcUrl: string,
    private readonly sourceBlockHash: string,
    private readonly options: PinnedRethQuoteBackendOptions = {},
  ) {
    /*
     * 32 bounds one physical HTTP batch. A 300+ item batch that the client
     * aborts would otherwise keep occupying reth for tens of seconds while it
     * drains server-side.
     */
    this.maxBatchSize = options.maxBatchSize ?? 32;
    this.maxConcurrentBatches = options.maxConcurrentBatches ?? 8;
    this.transportScheduler = options.transportScheduler ?? this.localScheduler();
    this.transportLane = options.transportLane ?? "exact";
    this.scopeLabel = options.scopeLabel ?? "exact quote";
    this.allowSingleCallFallback = options.allowSingleCallFallback ??
      this.transportLane === "exact";
    this.blockSpecifier = eip1898BlockSpecifier(sourceBlockHash);
    this.persistentCallCache = options.persistentEthCallCachePath === undefined
      ? undefined
      : new PersistentPinnedEthCallCache(
          options.persistentEthCallCachePath,
          this.blockSpecifier.blockHash,
          options.onPersistentCacheError,
        );

    if (options.signal) {
      const onAbort = (): void => this.abort(options.signal!.reason);
      options.signal.addEventListener("abort", onAbort, { once: true });
      this.detachParentAbort = () =>
        options.signal!.removeEventListener("abort", onAbort);
      if (options.signal.aborted) onAbort();
    }

    if (options.deadlineAtMs !== undefined) {
      const remainingMs = options.deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        this.abort(
          new StateCallAbortedError(
            "exact quote scope deadline reached",
            "deadline",
          ),
        );
      } else {
        this.scopeDeadlineTimer = setTimeout(
          () =>
            this.abort(
              new StateCallAbortedError(
                "exact quote scope deadline reached",
                "deadline",
              ),
            ),
          remainingMs,
        );
      }
    }
  }

  async forkAt(): Promise<void> {
    throw new Error("PinnedRethQuoteBackend does not fork");
  }

  async forkAfterTx(): Promise<void> {
    throw new Error("PinnedRethQuoteBackend does not fork");
  }

  async prepareVictimPostState(): Promise<never> {
    throw new Error("PinnedRethQuoteBackend has no victim state");
  }

  async applyRawTx(): Promise<string> {
    throw new Error("PinnedRethQuoteBackend does not apply transactions");
  }

  async queueHistoricalRawTransactions(): Promise<string[]> {
    throw new Error("PinnedRethQuoteBackend does not replay transactions");
  }

  async snapshot(): Promise<string> {
    throw new Error("PinnedRethQuoteBackend has no snapshot state");
  }

  async revert(): Promise<void> {
    throw new Error("PinnedRethQuoteBackend has no snapshot state");
  }

  call(
    req: { to: string; data: string; from?: string },
    control: StateCallControl = {},
  ): Promise<string> {
    const controlError = this.callControlError(control, req.to);
    if (controlError) return Promise.reject(controlError);
    const identity = persistentCallIdentity(
      this.blockSpecifier.blockHash,
      req,
    );
    const memoKey = identity.key;
    const memoized = this.callMemo.get(memoKey);
    if (memoized !== undefined) {
      this.memoHits++;
      return memoized;
    }
    const persisted = this.persistentCallCache?.get(identity);
    if (persisted !== undefined) {
      const result = Promise.resolve(persisted);
      this.callMemo.set(memoKey, result);
      return result;
    }
    const pending = this.pendingCalls.get(memoKey);
    if (pending !== undefined) {
      this.memoHits++;
      return this.waitForSharedCall(memoKey, pending, control, req.to);
    }
    // One physical read, independently cancellable waiters. No caller owns
    // another caller's transport lifetime; the last departing waiter aborts it.
    const controller = new AbortController();
    this.totalCalls++;
    const promise = new Promise<string>((resolve, reject) => {
      const item: PendingQuoteItem = {
        kind: "eth_call",
        id: this.nextId++,
        req: {
          to: req.to,
          data: req.data,
          ...(req.from ? { from: req.from } : {}),
        },
        control: { signal: controller.signal },
        settled: false,
        detachControl: () => {},
        resolve: (value: unknown) => resolve(value as string),
        reject,
      };
      this.enqueue(item);
    }).then(
      (result) => {
        if (this.pendingCalls.get(memoKey) === shared) {
          this.pendingCalls.delete(memoKey);
          if (!this.closed && !controller.signal.aborted) {
            this.callMemo.set(memoKey, Promise.resolve(result));
          }
        }
        return result;
      },
      (error) => {
        if (this.pendingCalls.get(memoKey) === shared) this.pendingCalls.delete(memoKey);
        throw error;
      },
    );
    const shared: SharedPendingCall = { controller, promise, waiters: 0 };
    this.pendingCalls.set(memoKey, shared);
    return this.waitForSharedCall(memoKey, shared, control, req.to);
  }

  /**
   * Successful bytes only: a miss neither joins pending work nor issues I/O.
   * Cross-stage consumers supply their source hash; a different pin is a miss.
   */
  callCached(
    req: { to: string; data: string; from?: string },
    control: StateCallControl = {},
    expectedSourceBlockHash?: string,
  ): Promise<string> | undefined {
    const error = this.callControlError(control, req.to);
    if (error) return Promise.reject(error);
    if (
      expectedSourceBlockHash !== undefined &&
      expectedSourceBlockHash.toLowerCase() !== this.blockSpecifier.blockHash
    ) return undefined;
    const cached = this.callMemo.get(persistentCallIdentity(this.sourceBlockHash, req).key);
    if (cached !== undefined) this.memoHits++;
    return cached;
  }

  /** Durable attempt boundary without retiring the shared startup backend. */
  async checkpoint(): Promise<void> {
    await this.persistentCallCache?.closeAndDrain();
  }

  private callControlError(control: StateCallControl, label: string): StateCallAbortedError | null {
    if (this.closed || this.scopeController.signal.aborted) return this.scopeAbortError(label);
    if (control.signal?.aborted) {
      return new StateCallAbortedError(`eth_call ${label} aborted: caller signal aborted`, "signal", control.signal.reason);
    }
    if (control.deadlineAtMs !== undefined && control.deadlineAtMs <= Date.now()) {
      return new StateCallAbortedError(`eth_call ${label} aborted: absolute deadline reached`, "deadline");
    }
    return null;
  }

  private waitForSharedCall(
    key: string,
    shared: SharedPendingCall,
    control: StateCallControl,
    label: string,
  ): Promise<string> {
    shared.waiters++;
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error: unknown, value?: string): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        control.signal?.removeEventListener("abort", onAbort);
        shared.waiters--;
        if (shared.waiters === 0 && this.pendingCalls.get(key) === shared) {
          this.pendingCalls.delete(key);
          shared.controller.abort(error ?? new Error("shared call has no remaining waiters"));
        }
        if (error !== null) reject(error);
        else resolve(value!);
      };
      const onAbort = (): void => finish(this.callControlError(control, label));
      control.signal?.addEventListener("abort", onAbort, { once: true });
      // Attach both handlers even for an already-cancelled waiter so a late
      // shared rejection is observed and cannot escape as unhandled.
      void shared.promise.then(
        (value) => finish(this.callControlError(control, label), value),
        (error) => finish(error),
      );
      const error = this.callControlError(control, label);
      if (error) { finish(error); return; }
      if (control.deadlineAtMs !== undefined) {
        const expire = (): void => {
          const remaining = control.deadlineAtMs! - Date.now();
          // Node timers may fire just before the wall-clock millisecond. Do
          // not turn that early callback into a completed quote rejection.
          if (remaining > 0) { timer = setTimeout(expire, remaining); return; }
          finish(new StateCallAbortedError(
            `eth_call ${label} aborted: absolute deadline reached`, "deadline",
          ));
        };
        timer = setTimeout(expire, Math.max(1, control.deadlineAtMs - Date.now()));
      }
    });
  }

  async simulateTokenToNativeDelta(
    req: TokenToNativeDeltaRequest,
    control: StateCallControl = {},
  ): Promise<TokenToNativeDeltaResult> {
    const token = ethers.getAddress(req.token);
    const caller = ethers.getAddress(req.caller);
    if (!ethers.isHexString(req.callData)) {
      throw new Error("token-to-native simulation requires hex calldata");
    }
    const code = await this.rpcSingle(
      "eth_getCode",
      [token, this.blockSpecifier],
      token,
      control,
    );
    if (typeof code !== "string" || code === "0x") {
      throw new Error(`token-to-native simulation target ${token} has no code`);
    }
    const codeHash = ethers.keccak256(code);
    const slot = await this.resolveTokenBalanceSlot(
      token,
      caller,
      codeHash,
      req.amountIn,
      control,
    );
    if (slot === null) {
      throw new Error(
        `token-to-native simulation cannot prove balance storage for ${token}`,
      );
    }
    const balanceData = ERC20.encodeFunctionData("balanceOf", [caller]);
    const supplyData = ERC20.encodeFunctionData("totalSupply");
    const simulation = {
      blockStateCalls: [{
        stateOverrides: {
          [token]: {
            stateDiff: {
              [slot]: ethers.toBeHex(req.amountIn, 32),
            },
          },
        },
        calls: [
          { from: caller, to: token, data: balanceData },
          { from: caller, to: token, data: supplyData },
          { from: caller, to: token, data: req.callData },
          { from: caller, to: token, data: balanceData },
          { from: caller, to: token, data: supplyData },
        ],
      }],
      validation: false,
      traceTransfers: true,
    };
    return new Promise<TokenToNativeDeltaResult>((resolve, reject) => {
      this.enqueue({
        kind: "eth_simulateV1",
        id: this.nextId++,
        req: { to: token, data: req.callData },
        simulation,
        control,
        settled: false,
        detachControl: () => {},
        resolve: (raw: unknown) => {
          const calls = simulationCalls(raw);
          if (calls.length !== 5 || calls.some((call) => call.status !== 1)) {
            reject(new Error(`token-to-native simulation failed for ${token}`));
            return;
          }
          const balanceBefore = decodeUintCall(
            calls[0].returnData,
            "balance before",
          );
          const supplyBefore = decodeUintCall(
            calls[1].returnData,
            "supply before",
          );
          const balanceAfter = decodeUintCall(
            calls[3].returnData,
            "balance after",
          );
          const supplyAfter = decodeUintCall(
            calls[4].returnData,
            "supply after",
          );
          if (balanceAfter > balanceBefore || supplyAfter > supplyBefore) {
            reject(
              new Error(
                "token-to-native simulation observed increasing input state",
              ),
            );
            return;
          }
          resolve({
            tokenInSpent: balanceBefore - balanceAfter,
            totalSupplyBurned: supplyBefore - supplyAfter,
            nativeOut: nativeTransfersToCaller(calls[2].logs, token, caller),
          });
        },
        reject,
      });
    });
  }

  async send(): Promise<string> {
    throw new Error("PinnedRethQuoteBackend does not send transactions");
  }

  async getGasUsed(): Promise<bigint> {
    throw new Error("PinnedRethQuoteBackend has no executed transactions");
  }

  async getTokenBalance(): Promise<bigint> {
    throw new Error("PinnedRethQuoteBackend does not expose token balances");
  }

  abort(
    reason: unknown = new Error("exact quote pass closed"),
  ): void {
    if (!this.closed) this.closed = true;
    if (!this.scopeController.signal.aborted) {
      this.scopeController.abort(reason);
    }
    const error = this.scopeAbortError(this.sourceBlockHash);
    for (const item of [...this.liveItems]) {
      this.rejectItem(item, error);
    }
    this.pending.length = 0;
    this.clearRetryWake();
  }

  /** Separate pending batches for critical source preparation; physical
   * permits, source, cancellation and retry policy remain shared. This cannot
   * preempt an HTTP request already on the wire. The parent owns its lifetime. */
  /** The backend this view was derived from, or undefined for a root backend. */
  quoteBackendOwner(): PinnedRethQuoteBackend | undefined {
    return this.ownerBackend;
  }

  criticalCalls(): PinnedRethQuoteBackend {
    if (this.criticalBackend !== undefined) return this.criticalBackend;
    const view = new PinnedRethQuoteBackend(this.rpcUrl, this.sourceBlockHash, {
      transportLane: "producer-critical",
      transportScheduler: this.transportScheduler,
      maxBatchSize: 32,
      maxConcurrentBatches: 2,
      signal: this.scopeController.signal,
      deadlineAtMs: this.options.deadlineAtMs,
      retryRpcThrottle: this.options.retryRpcThrottle,
      allowSingleCallFallback: false,
      scopeLabel: `${this.scopeLabel} critical preparation`,
      onSourceUnavailable: this.options.onSourceUnavailable,
      onRpcThrottle: this.options.onRpcThrottle,
    });
    view.ownerBackend = this;
    this.criticalBackend = view;
    return view;
  }

  async closeAndDrain(
    reason: unknown = new Error("exact quote pass completed"),
  ): Promise<number> {
    const startedAtMs = Date.now();
    this.abort(reason);
    await Promise.all([this.drain(), this.criticalBackend?.closeAndDrain(reason)]);

    await this.persistentCallCache?.closeAndDrain();

    this.detachParentAbort();
    if (this.scopeDeadlineTimer !== undefined) {
      clearTimeout(this.scopeDeadlineTimer);
      this.scopeDeadlineTimer = undefined;
    }

    this.lastDrainMs = Math.max(0, Date.now() - startedAtMs);
    return this.lastDrainMs;
  }

  /** Settle a completed phase without discarding this source-pinned call memo. */
  async drain(): Promise<void> {
    for (;;) {
      // Include the partial batch whose setImmediate flush has not run yet.
      // Callers stop issuing phase work before awaiting this boundary.
      this.pump();
      const active = [...this.activeFlushes, ...this.activeTransports,
        ...(this.retryWake ? [this.retryWake.promise] : [])];
      if (active.length === 0) return;
      await Promise.allSettled(active);
    }
  }

  stats(): Readonly<{
    lane: "producer-critical" | "producer-bulk" | "exact";
    scopeLabel: string;
    allowSingleCallFallback: boolean;
    maxBatchSize: number;
    maxConcurrentBatches: number;
    currentConcurrentBatchLimit: number;
    currentBatchSizeLimit: number;
    throttleRetries: number;
    timeoutRetries: number;
    totalCalls: number;
    memoHits: number;
    batchesSent: number;
    batchedItems: number;
    batchLatencyMs: number;
    maxBatchItemsSent: number;
    pendingItems: number;
    liveItems: number;
    inFlightBatches: number;
    peakInFlightBatches: number;
    activeTransports: number;
    abortedBatches: number;
    completedAfterScopeAbort: number;
    transportQueueWaitMs: number;
    maxTransportQueueWaitMs: number;
    peakSchedulerActiveTotal: number;
    peakSchedulerLaneActive: number;
    batchFailures: number;
    singleCallFallbacks: number;
    batchesOnNewSocket: number;
    batchesOnReusedSocket: number;
    drainMs: number;
    persistentCacheContentSha256: string | null;
    persistentCacheConfigured: boolean;
    persistentCacheEntries: number;
    persistentCacheHits: number;
    persistentCacheSourceBlockHash: string | null;
    persistentCacheWrites: number;
  }> {
    const persistent = this.persistentCallCache?.stats();
    return Object.freeze({
      lane: this.transportLane,
      scopeLabel: this.scopeLabel,
      allowSingleCallFallback: this.allowSingleCallFallback,
      maxBatchSize: this.maxBatchSize,
      maxConcurrentBatches: this.maxConcurrentBatches,
      currentConcurrentBatchLimit: this.currentConcurrentBatchLimit,
      currentBatchSizeLimit: this.currentBatchSizeLimit,
      throttleRetries: this.throttleRetries,
      timeoutRetries: this.timeoutRetries,
      totalCalls: this.totalCalls,
      memoHits: this.memoHits,
      batchesSent: this.batchesSent,
      batchedItems: this.batchedItems,
      batchLatencyMs: this.batchLatencyMs,
      maxBatchItemsSent: this.maxBatchItemsSent,
      pendingItems: this.pending.length,
      liveItems: this.liveItems.size,
      inFlightBatches: this.inFlightBatches,
      peakInFlightBatches: this.peakInFlightBatches,
      activeTransports: this.activeTransports.size,
      abortedBatches: this.abortedBatches,
      completedAfterScopeAbort: this.completedAfterScopeAbort,
      transportQueueWaitMs: this.transportQueueWaitMs,
      maxTransportQueueWaitMs: this.maxTransportQueueWaitMs,
      peakSchedulerActiveTotal: this.peakSchedulerActiveTotal,
      peakSchedulerLaneActive: this.peakSchedulerLaneActive,
      batchFailures: this.batchFailures,
      singleCallFallbacks: this.singleCallFallbacks,
      batchesOnNewSocket: this.batchesOnNewSocket,
      batchesOnReusedSocket: this.batchesOnReusedSocket,
      drainMs: this.lastDrainMs,
      persistentCacheContentSha256:
        persistent?.contentSha256 ?? null,
      persistentCacheConfigured: persistent !== undefined,
      persistentCacheEntries: persistent?.entries ?? 0,
      persistentCacheHits: persistent?.hits ?? 0,
      persistentCacheSourceBlockHash:
        persistent?.sourceBlockHash ?? null,
      persistentCacheWrites: persistent?.writes ?? 0,
    });
  }

  private enqueue(item: PendingQuoteItem): void {
    if (process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS === "1") item.enqueuedAtMs = Date.now();
    this.liveItems.add(item);

    if (this.closed || this.scopeController.signal.aborted) {
      this.rejectItem(item, this.scopeAbortError(item.req.to));
      return;
    }

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = item.control.signal;

    const onCallerAbort = (): void => {
      const index = this.pending.indexOf(item);
      if (index >= 0) this.pending.splice(index, 1);
      this.rejectItem(
        item,
        new StateCallAbortedError(
          `eth_call ${item.req.to} aborted: caller signal aborted`,
          "signal",
          signal?.reason,
        ),
      );
    };

    const deadlineAtMs = item.control.deadlineAtMs;
    if (deadlineAtMs !== undefined) {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        this.rejectItem(
          item,
          new StateCallAbortedError(
            `eth_call ${item.req.to} aborted: absolute deadline reached`,
            "deadline",
          ),
        );
        return;
      }
      deadlineTimer = setTimeout(() => {
        const index = this.pending.indexOf(item);
        if (index >= 0) this.pending.splice(index, 1);
        this.rejectItem(
          item,
          new StateCallAbortedError(
            `eth_call ${item.req.to} aborted: absolute deadline reached`,
            "deadline",
          ),
        );
      }, remainingMs);
    }

    item.detachControl = () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", onCallerAbort);
    };

    if (signal?.aborted) {
      onCallerAbort();
      return;
    }
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    this.pending.push(item);
    // A full logical batch is ready now; dispatch it immediately instead of
    // waiting for the setImmediate tail flush. This keeps wide exact fan-out
    // from fragmenting into many half-filled HTTP batches while preserving a
    // zero-delay flush for the final partial batch.
    let freshItems = 0;
    for (const pending of this.pending) {
      if (!pending.settled && pending.kind === item.kind && !pending.transportRetryBatch) freshItems++;
      if (freshItems >= this.currentBatchSizeLimit) break;
    }
    if (freshItems >= this.currentBatchSizeLimit) this.pump();
    else this.scheduleFlush();
  }

  private resolveItem(item: PendingQuoteItem, value: unknown): void {
    if (item.settled) return;
    item.settled = true;
    item.detachControl();
    this.liveItems.delete(item);
    try {
      if (item.kind === "eth_call") {
        if (typeof value !== "string") {
          throw new Error(
            `eth_call ${item.req.to} returned a non-string result`,
          );
        }
        this.persistentCallCache?.record(
          persistentCallIdentity(
            this.blockSpecifier.blockHash,
            item.req,
          ),
          value,
        );
      }
      item.resolve(value);
    } catch (error) {
      item.reject(error);
    }
  }

  private rejectItem(item: PendingQuoteItem, error: unknown): void {
    if (item.settled) return;
    item.settled = true;
    item.detachControl();
    this.liveItems.delete(item);
    item.reject(error);
  }

  private scopeAbortError(label: string): StateCallAbortedError {
    const reason = this.scopeController.signal.reason;
    if (isStateCallAbortedError(reason)) return reason;
    return new StateCallAbortedError(
      `${this.scopeLabel} ${label} aborted: scope closed`,
      "signal",
      { cause: reason },
    );
  }

  private abortForRpcFailure(error: Error): void {
    if (this.closed) return;
    const record = error as Error & { code?: unknown; data?: unknown };
    const sourceUnavailable = record.code === -32000 &&
      record.message === "hash is not currently canonical" && record.data == null;
    if (!sourceUnavailable && !isRpcThrottleError(error)) return;

    // Close before notifying: callbacks may abort parents or retry synchronously.
    this.abort(error);
    const marker = sourceUnavailable ? "source-unavailable" : "rpc-throttle HTTP 429";
    console.warn(`[pinned-reth-quote-backend] ${marker} source_block_hash=${this.blockSpecifier.blockHash}`);
    try {
      const notify = sourceUnavailable ? this.options.onSourceUnavailable : this.options.onRpcThrottle;
      notify?.(error);
    } finally {
      // Preserve the raw diagnostic even if the observer itself throws.
      throw error;
    }
  }

  private scheduleFlush(): void {
    if (this.closed || this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.pump();
    });
  }

  private get currentConcurrentBatchLimit(): number {
    return this.transportLoad?.limits(this.maxBatchSize, this.maxConcurrentBatches).concurrency ?? this.maxConcurrentBatches;
  }

  private localScheduler(): RethTransportScheduler {
    return this.standaloneScheduler ??= new RethTransportScheduler({
      capacity: this.maxConcurrentBatches + 1, producerReserved: 1,
    });
  }

  private get currentBatchSizeLimit(): number {
    return this.transportLoad?.limits(this.maxBatchSize, this.maxConcurrentBatches).batchSize ?? this.maxBatchSize;
  }

  private retryTransport(error: unknown, items: readonly RethTransportRetryState[], attempt: RethTransportAttempt): boolean {
    if (this.closed || this.scopeController.signal.aborted ||
        (this.options.deadlineAtMs !== undefined && Date.now() >= this.options.deadlineAtMs) ||
        (!isRethTransportTimeout(error) && !this.options.retryRpcThrottle)) return false;
    if (!this.transportLoad?.retry(error, items, attempt)) return false;
    if (isRethTransportTimeout(error)) this.timeoutRetries++;
    else this.throttleRetries++;
    const marker = isRethTransportTimeout(error) ? "transport-timeout-retry" : "rpc-throttle-retry status=429";
    const atOne = Math.max(...items.map(item => item.transportRetriesAtOne ?? 0));
    const next = this.transportLoad.limits(this.maxBatchSize, this.maxConcurrentBatches, items);
    console.warn(`[pinned-reth-quote-backend] ${marker} concurrency=${attempt.concurrency}->${next.concurrency} retry_at_one=${atOne}/${this.transportLoad.maxRetriesAtOne ?? 3} delay_ms=${this.transportLoad.retryDelayMs(items)} items=${items.length} retry_scope=batch batch_size=${next.batchSize}`);
    return true;
  }

  private queueTransportRetry(items: PendingQuoteItem[], error: unknown, attempt: RethTransportAttempt): "queued" | "unused" | "refused" {
    const live = items.filter(item => {
      if (item.settled) return false;
      const cancelled = this.callControlError(item.control, item.req.to);
      if (cancelled) this.rejectItem(item, cancelled);
      return !cancelled;
    });
    if (!live.length) return "unused";
    if (!this.retryTransport(error, live, attempt)) return "refused";
    this.pending.unshift(...live);
    return "queued";
  }

  private pump(): void {
    this.clearRetryWake();
    const concurrencyLimit = this.currentConcurrentBatchLimit;
    while (
      !this.closed &&
      this.pending.length > 0 &&
      this.inFlightBatches < concurrencyLimit
    ) {
      const now = Date.now();
      // Skip cooling or locally saturated retries: fresh work retains its
      // configured limit, while every physical request still shares permits.
      const firstIndex = this.pending.findIndex(item => {
        if (item.settled) return true;
        const group = item.transportRetryBatch;
        const limits = this.transportLoad?.limits(this.maxBatchSize, this.maxConcurrentBatches, [item]);
        return !group || (group.notBeforeMs <= now &&
          (this.activeRetryBatches.get(group) ?? 0) < limits!.concurrency);
      });
      if (firstIndex < 0) break;
      const first = this.pending[firstIndex]!;
      const group = first.transportRetryBatch;
      const limits = this.transportLoad?.limits(this.maxBatchSize, this.maxConcurrentBatches, [first]);
      const batchSize = limits?.batchSize ?? this.maxBatchSize;
      const batch: PendingQuoteItem[] = [];
      for (let i = firstIndex; i < this.pending.length && batch.length < batchSize;) {
        const item = this.pending[i]!;
        if (item.kind === first.kind && item.transportRetryBatch === group) batch.push(...this.pending.splice(i, 1));
        else i++;
      }
      const alive: PendingQuoteItem[] = [];
      for (const item of batch) {
        if (item.settled) continue;
        // One admitted batch is one physical request, even for mixed callers.
        if (alive.length && item.kind !== alive[0]!.kind) {
          this.pending.push(item);
          continue;
        }
        const deadline = item.control.deadlineAtMs;
        if (deadline !== undefined && deadline <= now) {
          this.rejectItem(
            item,
            new StateCallAbortedError(
              `eth_call ${item.req.to} aborted: absolute deadline reached`,
              "deadline",
            ),
          );
          continue;
        }
        if (item.control.signal?.aborted) {
          this.rejectItem(
            item,
            new StateCallAbortedError(
              `eth_call ${item.req.to} aborted: caller signal aborted`,
              "signal",
              item.control.signal.reason,
            ),
          );
          continue;
        }
        alive.push(item);
      }
      if (alive.length === 0) continue;

      this.inFlightBatches++;
      if (group) this.activeRetryBatches.set(group, (this.activeRetryBatches.get(group) ?? 0) + 1);
      this.peakInFlightBatches = Math.max(
        this.peakInFlightBatches,
        this.inFlightBatches,
      );
      const task = this.flushBatch(alive, limits?.concurrency ?? concurrencyLimit).finally(() => {
        this.inFlightBatches--;
        if (group) {
          const remaining = this.activeRetryBatches.get(group)! - 1;
          if (remaining) this.activeRetryBatches.set(group, remaining);
          else this.activeRetryBatches.delete(group);
        }
        this.activeFlushes.delete(task);
        this.scheduleFlush();
      });
      this.activeFlushes.add(task);
      void task.catch(() => {
        // flushBatch rejects items individually; this only prevents detached
        // rejections from surfacing as unhandled.
      });
    }
    if (!this.closed) {
      const now = Date.now();
      const next = this.pending.reduce((time, item) => item.settled ? time :
        Math.min(time, (item.transportRetryBatch?.notBeforeMs ?? 0) > now
          ? item.transportRetryBatch!.notBeforeMs : Infinity), Infinity);
      if (Number.isFinite(next)) {
        let resolve!: () => void;
        const promise = new Promise<void>(done => { resolve = done; });
        const timer = setTimeout(() => {
          this.retryWake = undefined;
          resolve();
          this.scheduleFlush();
        }, Math.max(1, next - now));
        this.retryWake = {timer, promise, resolve};
      }
    }
  }

  private clearRetryWake(): void {
    if (!this.retryWake) return;
    clearTimeout(this.retryWake.timer);
    this.retryWake.resolve();
    this.retryWake = undefined;
  }

  private async flushBatch(alive: PendingQuoteItem[], scheduledLimit: number): Promise<void> {
    const calls = alive.filter((item) => item.kind === "eth_call");
    const simulations = alive.filter(
      (item) => item.kind === "eth_simulateV1",
    );
    await Promise.all([
      ...(calls.length > 0 ? [this.sendCallBatch(calls, scheduledLimit)] : []),
      ...(simulations.length > 0
        ? [this.sendSimulationBatch(simulations, scheduledLimit)]
        : []),
    ]);
  }

  private async runTransport(
    signal: AbortSignal,
    work: (wireSignal: AbortSignal, attempt: RethTransportAttempt, lease: RethTransportLease) => Promise<JsonRpcHttpResponse>,
    retry?: (error: unknown, attempt: RethTransportAttempt) => boolean,
    items: readonly RethTransportRetryState[] = [],
  ): Promise<JsonRpcHttpResponse> {
    const checkedWork = async (lease: RethTransportLease): Promise<JsonRpcHttpResponse> => {
      // Legacy run-only test doubles may not provide load. Real shared
      // schedulers always do, including through run-only forwarding wrappers.
      if (!lease.load) return this.localScheduler().run(this.transportLane, signal, checkedWork);
      this.transportLoad = lease.load;
      this.transportQueueWaitMs += lease.queueWaitMs;
      this.maxTransportQueueWaitMs = Math.max(this.maxTransportQueueWaitMs, lease.queueWaitMs);
      this.peakSchedulerActiveTotal = Math.max(this.peakSchedulerActiveTotal, lease.activeTotal);
      this.peakSchedulerLaneActive = Math.max(this.peakSchedulerLaneActive, lease.activeByLane[this.transportLane]);
      if (signal.aborted) throw signal.reason;
      if (this.closed) throw this.scopeAbortError(this.sourceBlockHash);
      if (this.options.deadlineAtMs !== undefined && Date.now() >= this.options.deadlineAtMs) {
        throw new StateCallAbortedError("scope absolute deadline reached", "deadline");
      }
      const attempt = lease.load.limits(this.maxBatchSize, this.maxConcurrentBatches, items);
      const wire = new AbortController();
      const onAbort = (): void => wire.abort(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      // Permit waiting is covered only by original caller/scope controls. This
      // timer measures a physical attempt, never time in the shared queue.
      const timeout = setTimeout(() => wire.abort(new StateCallAbortedError(
        "JSON-RPC physical transport timeout", "timeout",
      )), lease.load.timeoutMs);
      try {
        const response = await work(wire.signal, attempt, lease);
        if (signal.aborted) throw signal.reason;
        if (wire.signal.aborted) throw wire.signal.reason;
        if (response.statusCode === 429) {
          // Keep structured error codes/data: contract revert text inside an
          // HTTP 429 body is not proof that the account allocation is spent.
          const envelopes = Array.isArray(response.body) ? response.body : [response.body];
          const quotaExhausted = envelopes.some(envelope => envelope && typeof envelope === "object" &&
            isRpcQuotaExhaustedError((envelope as { error?: unknown }).error));
          const error = new Error("JSON-RPC HTTP 429", quotaExhausted
            ? { cause: new Error("account quota exhausted") } : undefined);
          (error as Error & { statusCode: number }).statusCode = 429;
          throw error;
        }
        // Singles and whole-batch RPC rejections use an object envelope.
        if (response.statusCode >= 200 && response.statusCode < 300 && !Array.isArray(response.body)) {
          const body = response.body as { error?: unknown } | null;
          if (body?.error != null) {
            const error = rpcItemError({ to: this.sourceBlockHash }, body.error);
            if (isRpcThrottleError(error)) throw error;
            this.abortForRpcFailure(error);
          }
        }
        return response;
      } catch (error) {
        if (error instanceof QueuedTransportRetry) throw error;
        if (signal.aborted) throw signal.reason;
        if (retry?.(error, attempt)) throw new QueuedTransportRetry();
        if (error instanceof Error) this.abortForRpcFailure(error);
        throw error;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
      }
    };
    const operation = this.transportScheduler.run(this.transportLane, signal, checkedWork);
    this.activeTransports.add(operation);
    try {
      return await operation;
    } finally {
      this.activeTransports.delete(operation);
    }
  }

  private async sendCallBatch(items: PendingQuoteItem[], scheduledLimit: number): Promise<void> {
    const payloads = items.map((item) => ({
      jsonrpc: "2.0",
      id: item.id,
      method: "eth_call",
      params: [
        {
          to: item.req.to,
          data: item.req.data,
          ...(item.req.from ? { from: item.req.from } : {}),
        },
        this.blockSpecifier,
      ],
    }));
    await this.sendBatchPayloads(payloads, items, "eth_call", scheduledLimit);
  }

  private async sendSimulationBatch(
    items: PendingQuoteItem[],
    scheduledLimit: number,
  ): Promise<void> {
    const payloads = items.map((item) => ({
      jsonrpc: "2.0",
      id: item.id,
      method: "eth_simulateV1",
      params: [item.simulation, this.blockSpecifier],
    }));
    await this.sendBatchPayloads(payloads, items, "eth_simulateV1", scheduledLimit);
  }

  private async sendBatchPayloads(
    payloads: unknown[],
    items: PendingQuoteItem[],
    method: string,
    scheduledLimit: number,
  ): Promise<void> {
    if (this.closed || this.scopeController.signal.aborted) {
      const error = this.scopeAbortError(method);
      for (const item of items) this.rejectItem(item, error);
      return;
    }

    const byId = new Map(items.map((item) => [item.id, item]));
    const retryIds = new Set<number>();
    const controller = new AbortController();
    const onScopeAbort = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(this.scopeAbortError(method));
      }
    };
    this.scopeController.signal.addEventListener(
      "abort",
      onScopeAbort,
      { once: true },
    );

    // A shared eth_call can lose its final waiter while its HTTP batch is in
    // flight. Cancel the envelope only when no sibling item still needs it.
    const itemSignals = new Set(items.flatMap((item) =>
      item.control.signal === undefined ? [] : [item.control.signal]
    ));
    const abortIfUnused = (): void => {
      if (items.every((item) => item.settled) && !controller.signal.aborted) {
        controller.abort(new StateCallAbortedError(
          `JSON-RPC batch ${method} has no remaining waiters`, "signal",
        ));
      }
    };
    for (const signal of itemSignals) signal.addEventListener("abort", abortIfUnused);
    abortIfUnused();

    const batchStartedAtMs = Date.now();
    let response: JsonRpcHttpResponse;
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      response = await this.runTransport(controller.signal, async (wireSignal, attempt, lease) => {
        // Only split siblings can change this envelope's local retry tier
        // while it waits for a shared permit. Never send abandoned items.
        if (items.some(item => item.settled) || items.length > attempt.batchSize || scheduledLimit > attempt.concurrency ||
            (attempt.batch?.notBeforeMs ?? 0) > Date.now()) {
          this.pending.unshift(...items.filter(item => !item.settled));
          throw new QueuedTransportRetry();
        }
        this.batchesSent++;
        this.batchedItems += items.length;
        this.maxBatchItemsSent = Math.max(
          this.maxBatchItemsSent,
          items.length,
        );
        const wireStartedAtMs = process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS === "1" ? Date.now() : undefined;
        const batchId = `${this.diagnosticBackendId}:${this.batchesSent}`;
        if (wireStartedAtMs !== undefined) {
          try {
            console.log(`[searcher/quote-batch-dispatch] ${JSON.stringify({
              batchId, sourceBlockHash: this.blockSpecifier.blockHash,
              lane: this.transportLane, scopeLabel: this.scopeLabel, method,
              createdAtMs: batchStartedAtMs, startedAtMs: wireStartedAtMs,
              permitQueueWaitMs: lease.queueWaitMs, schedulerActiveTotal: lease.activeTotal,
              calls: items.map(item => ({
                rpcId: item.id, target: item.req.to.toLowerCase(),
                from: item.req.from?.toLowerCase() ?? null,
                selector: item.req.data.length >= 10 ? item.req.data.slice(0, 10).toLowerCase() : null,
                calldataSha256: sha256(Buffer.from(item.req.data.slice(2), "hex")),
                enqueuedAtMs: item.enqueuedAtMs ?? null,
              })),
            })}`);
          } catch { /* No payload, result body or endpoint belongs in diagnostics. */ }
        }
        let httpTiming: JsonRpcHttpTiming | undefined;
        let response: JsonRpcHttpResponse | undefined;
        try {
          response = await postJsonRpc(this.rpcUrl, payloads as never, wireSignal,
            wireStartedAtMs === undefined ? undefined : timing => { httpTiming = timing; });
        } finally {
          if (wireStartedAtMs !== undefined) {
            try {
              console.log(`[searcher/quote-batch-timing] ${JSON.stringify({
                batchId,
                sourceBlockHash: this.blockSpecifier.blockHash,
                lane: this.options.transportLane ?? "exact", scopeLabel: this.options.scopeLabel ?? "exact quote",
                method, items: items.length, startedAtMs: wireStartedAtMs,
                wallMs: Date.now() - wireStartedAtMs,
                status: response === undefined ? "transport-failed" : "returned",
                statusCode: response?.statusCode ?? null,
                permitQueueWaitMs: lease.queueWaitMs,
                createdAtMs: batchStartedAtMs,
                http: httpTiming ?? null,
              })}`);
            } catch { /* No diagnostic may change retry, cancellation or quote results. */ }
          }
        }
        // Inspect before releasing the shared permit or settling any sibling.
        // Otherwise the scheduler can dispatch queued RPCs on the dead source.
        if (response.statusCode >= 200 && response.statusCode < 300 && Array.isArray(response.body)) {
          const throttled = new Map<PendingQuoteItem, Error>();
          for (const entry of response.body) {
            if (!entry || typeof entry !== "object") continue;
            const record = entry as { id?: unknown; error?: unknown };
            const item = typeof record.id === "number" ? byId.get(record.id) : undefined;
            if (item && record.error != null) {
              const error = rpcItemError({ to: item.req.to }, record.error);
              if (this.options.retryRpcThrottle && isRpcThrottleError(error) && !isRpcQuotaExhaustedError(error)) {
                throttled.set(item, error);
              } else this.abortForRpcFailure(error);
            }
          }
          if (throttled.size) {
            const error = throttled.values().next().value!;
            // An abandoned recoverable item needs neither retry nor fatal
            // escalation. Source/quota errors were still inspected above.
            if (this.queueTransportRetry([...throttled.keys()], error, attempt) === "refused") this.abortForRpcFailure(error);
            for (const item of throttled.keys()) retryIds.add(item.id);
          }
        }
        return response;
      }, (error, attempt) => this.queueTransportRetry(items, error, attempt) === "queued", items);
    } catch (transportError) {
      if (transportError instanceof QueuedTransportRetry) return;
      /*
       * Pass/head/deadline abort must never fall back to single calls:
       * cancelling one old batch would immediately manufacture N old
       * requests.
       */
      if (
        this.closed ||
        this.scopeController.signal.aborted ||
        controller.signal.aborted
      ) {
        this.abortedBatches++;
        const error = this.scopeAbortError(method);
        for (const item of items) this.rejectItem(item, error);
        return;
      }
      this.batchFailures++;
      if (isRethTransportTimeout(transportError)) {
        for (const item of items) this.rejectItem(item, transportError);
        return; // Exhaustion must not manufacture single-call retries.
      }
      await this.handleBatchFailure(items, method, transportError);
      return;
    } finally {
      this.batchLatencyMs += Math.max(0, Date.now() - batchStartedAtMs);
      this.scopeController.signal.removeEventListener(
        "abort",
        onScopeAbort,
      );
      for (const signal of itemSignals) signal.removeEventListener("abort", abortIfUnused);
    }

    if (response.reusedSocket) this.batchesOnReusedSocket++;
    else this.batchesOnNewSocket++;

    if (this.scopeController.signal.aborted || this.closed) {
      this.completedAfterScopeAbort++;
      const error = this.scopeAbortError(method);
      for (const item of items) this.rejectItem(item, error);
      return;
    }

    const body = Array.isArray(response.body) ? response.body : null;
    if (
      response.statusCode < 200 ||
      response.statusCode >= 300 ||
      body === null
    ) {
      this.batchFailures++;
      await this.handleBatchFailure(
        items,
        method,
        new Error(
          `JSON-RPC batch ${method} HTTP ` +
            `${response.statusCode} ${response.statusMessage}`,
        ),
      );
      return;
    }

    const settledIds = new Set<number>();
    for (const entry of body) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as {
        id?: unknown;
        result?: unknown;
        error?: unknown;
      };
      if (typeof record.id !== "number") continue;
      const item = byId.get(record.id);
      if (!item || settledIds.has(record.id)) continue;
      settledIds.add(record.id);
      if (retryIds.has(record.id)) continue;

      if (record.error !== undefined && record.error !== null) {
        this.rejectItem(
          item,
          rpcItemError({ to: item.req.to }, record.error),
        );
      } else if (
        item.kind === "eth_call" &&
        typeof record.result !== "string"
      ) {
        this.rejectItem(
          item,
          new Error(
            `eth_call ${item.req.to} returned a non-string result`,
          ),
        );
      } else {
        this.resolveItem(item, record.result);
      }
    }

    for (const item of items) {
      if (item.settled || settledIds.has(item.id)) continue;
      const error = new Error(
        `JSON-RPC batch ${method} missing response for id ${item.id}`,
      );
      this.batchFailures++;
      if (this.allowSingleCallFallback) {
        this.singleCallFallbacks++;
        await this.retryItemSingle(item, method, error);
      } else {
        this.rejectItem(item, error);
      }
    }
  }

  private async handleBatchFailure(
    items: PendingQuoteItem[],
    method: string,
    error: unknown,
  ): Promise<void> {
    const live = items.filter((item) => !item.settled);
    if (!this.allowSingleCallFallback) {
      const message = error instanceof Error ? error.message : String(error);
      for (const item of live) {
        this.rejectItem(
          item,
          new Error(
            `${this.scopeLabel} batch ${method} failed: ${message}`,
            { cause: error },
          ),
        );
      }
      return;
    }
    await Promise.allSettled(live.map((item) => {
      this.singleCallFallbacks++;
      return this.retryItemSingle(item, method, error);
    }));
  }

  private async retryItemSingle(
    item: PendingQuoteItem,
    method: string,
    transportError: unknown,
  ): Promise<void> {
    if (item.settled) return;
    if (
      this.closed ||
      this.scopeController.signal.aborted ||
      item.control.signal?.aborted ||
      (
        item.control.deadlineAtMs !== undefined &&
        Date.now() >= item.control.deadlineAtMs
      )
    ) {
      this.rejectItem(item, this.scopeAbortError(method));
      return;
    }
    try {
      const result =
        method === "eth_simulateV1"
          ? await this.rpcSingle(
              method,
              [item.simulation, this.blockSpecifier],
              item.req.to,
              item.control,
            )
          : await this.rpcSingle(
              method,
              [
                {
                  to: item.req.to,
                  data: item.req.data,
                  ...(item.req.from ? { from: item.req.from } : {}),
                },
                this.blockSpecifier,
              ],
              item.req.to,
              item.control,
            );
      this.resolveItem(item, result);
    } catch (error) {
      this.rejectItem(
        item,
        new Error(
          `single-call fallback for ${method} failed: ` +
            `${error instanceof Error ? error.message : String(error)} ` +
            `(transport: ${
              transportError instanceof Error
                ? transportError.message
                : String(transportError)
            })`,
          { cause: transportError },
        ),
      );
    }
  }

  private async rpcSingle(
    method: string,
    params: readonly unknown[],
    label: string,
    control: StateCallControl,
  ): Promise<unknown> {
    if (this.closed || this.scopeController.signal.aborted) {
      throw this.scopeAbortError(label);
    }
    if (control.signal?.aborted) {
      throw new StateCallAbortedError(
        `${method} ${label} aborted: caller signal aborted`,
        "signal",
        control.signal.reason,
      );
    }
    const now = Date.now();
    const scopeDeadline = this.options.deadlineAtMs;
    const deadlineAtMs = Math.min(
      control.deadlineAtMs ?? Number.POSITIVE_INFINITY,
      scopeDeadline ?? Number.POSITIVE_INFINITY,
    );
    if (deadlineAtMs <= now) {
      throw new StateCallAbortedError(
        `${method} ${label} aborted: absolute deadline reached`,
        "deadline",
      );
    }
    const controller = new AbortController();
    const onScopeAbort = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(this.scopeAbortError(label));
      }
    };
    this.scopeController.signal.addEventListener(
      "abort",
      onScopeAbort,
      { once: true },
    );
    const onCallerAbort = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(
          new StateCallAbortedError(
            `${method} ${label} aborted: caller signal aborted`,
            "signal",
            control.signal?.reason,
          ),
        );
      }
    };
    control.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const deadlineTimer = Number.isFinite(deadlineAtMs) ? setTimeout(
      () =>
        controller.abort(
          new StateCallAbortedError(
            `${method} ${label} aborted: absolute deadline reached`,
            "deadline",
          ),
        ),
      Math.max(1, deadlineAtMs - now),
    ) : undefined;
    const retryState: RethTransportRetryState = {};
    try {
      for (;;) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (Date.now() >= deadlineAtMs) throw new StateCallAbortedError("absolute deadline reached", "deadline");
        const remainingMs = (retryState.transportRetryBatch?.notBeforeMs ?? 0) - Date.now();
        if (remainingMs > 0) {
          // Backoff owns no shared physical permit and remains cancellable.
          try { await retryDelay(remainingMs, undefined, {signal:controller.signal}); }
          catch (error) { throw controller.signal.aborted ? controller.signal.reason : error; }
          continue;
        }
        let response: JsonRpcHttpResponse;
        try {
          response = await this.runTransport(controller.signal, wireSignal =>
            postJsonRpc(
              this.rpcUrl,
              {
                jsonrpc: "2.0",
                id: 1,
                method,
                params: [...params],
              } as never,
              wireSignal,
            ),
            // Single-request 429 remains fatal. Only physical timeouts gained
            // recovery here; the prior opt-in 429 policy is batch-only.
            (error, attempt) => isRethTransportTimeout(error) && !controller.signal.aborted && Date.now() < deadlineAtMs &&
              this.retryTransport(error, [retryState], attempt),
            [retryState],
          );
        } catch (error) {
          if (error instanceof QueuedTransportRetry) continue;
          throw error;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new Error(
            `${method} ${label} HTTP ${response.statusCode} ${response.statusMessage}`,
          );
        }
        const body = response.body as Partial<{
          result?: unknown;
          error?: { code?: unknown; message?: unknown; data?: unknown };
        }>;
        if (body.error !== undefined && body.error !== null) {
          throw rpcItemError({ to: label }, body.error);
        }
        return body.result;
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      control.signal?.removeEventListener("abort", onCallerAbort);
      this.scopeController.signal.removeEventListener(
        "abort",
        onScopeAbort,
      );
    }
  }

  private async resolveTokenBalanceSlot(
    token: string,
    caller: string,
    codeHash: string,
    probeValue: bigint,
    control: StateCallControl,
  ): Promise<string | null> {
    const memoKey = `${token.toLowerCase()}|${caller.toLowerCase()}|${codeHash}`;
    const memoized = this.balanceSlotMemo.get(memoKey);
    if (
      memoized !== undefined &&
      await this.verifyTokenBalanceSlot(
        token,
        caller,
        memoized,
        probeValue,
        control,
      )
    ) {
      return memoized;
    }
    this.balanceSlotMemo.delete(memoKey);
    const candidates = new Set<string>();
    try {
      const raw = await this.rpcSingle(
        "eth_createAccessList",
        [
          {
            from: caller,
            to: token,
            data: ERC20.encodeFunctionData("balanceOf", [caller]),
          },
          this.blockSpecifier,
        ],
        token,
        control,
      ) as { accessList?: unknown };
      const accessList = Array.isArray(raw?.accessList) ? raw.accessList : [];
      for (const entry of accessList) {
        const item = entry as { address?: unknown; storageKeys?: unknown };
        if (
          typeof item.address !== "string" ||
          item.address.toLowerCase() !== token.toLowerCase() ||
          !Array.isArray(item.storageKeys)
        ) continue;
        for (const key of item.storageKeys) {
          if (typeof key === "string" && ethers.isHexString(key, 32)) {
            candidates.add(key.toLowerCase());
          }
        }
      }
    } catch {
      // A node may not implement eth_createAccessList. The bounded layout
      // scan below remains fail closed.
    }
    const abi = ethers.AbiCoder.defaultAbiCoder();
    for (let slot = 0; slot < 32; slot++) {
      candidates.add(
        ethers.keccak256(
          abi.encode(["address", "uint256"], [caller, BigInt(slot)]),
        ),
      );
      candidates.add(
        ethers.keccak256(
          abi.encode(["uint256", "address"], [BigInt(slot), caller]),
        ),
      );
    }
    for (const candidate of [...candidates].slice(0, 128)) {
      if (
        await this.verifyTokenBalanceSlot(
          token,
          caller,
          candidate,
          probeValue,
          control,
        )
      ) {
        this.balanceSlotMemo.set(memoKey, candidate);
        return candidate;
      }
    }
    return null;
  }

  private async verifyTokenBalanceSlot(
    token: string,
    caller: string,
    slot: string,
    probeValue: bigint,
    control: StateCallControl,
  ): Promise<boolean> {
    try {
      const raw = await this.rpcSingle(
        "eth_simulateV1",
        [{
          blockStateCalls: [{
            stateOverrides: {
              [token]: {
                stateDiff: {
                  [slot]: ethers.toBeHex(probeValue, 32),
                },
              },
            },
            calls: [{
              from: caller,
              to: token,
              data: ERC20.encodeFunctionData("balanceOf", [caller]),
            }],
          }],
          validation: false,
          traceTransfers: false,
        }, this.blockSpecifier],
        token,
        control,
      );
      const calls = simulationCalls(raw);
      if (calls.length !== 1 || calls[0].status !== 1) return false;
      return (
        decodeUintCall(calls[0].returnData, "balance probe") === probeValue
      );
    } catch {
      return false;
    }
  }
}

const PERSISTENT_CALL_CACHE_PROFILE =
  "pinned-reth-eth-call-cache-v1" as const;
const PERSISTENT_CALL_CACHE_FLUSH_ROWS = 256;

interface PersistentCallIdentity {
  readonly sourceBlockHash: string;
  readonly target: string;
  readonly calldata: string;
  readonly caller: string | null;
  readonly key: string;
}

interface PersistentCallCacheHeader {
  readonly schemaVersion: 1;
  readonly profile: typeof PERSISTENT_CALL_CACHE_PROFILE;
  readonly sourceBlockHash: string;
  readonly headerSha256: string;
}

interface PersistentCallCacheEntry extends PersistentCallIdentity {
  readonly schemaVersion: 1;
  readonly profile: typeof PERSISTENT_CALL_CACHE_PROFILE;
  readonly result: string;
  readonly entrySha256: string;
}

/**
 * Append-only replay cache. It is deliberately below the Family/runtime
 * layer: a row is only the deterministic answer to one source-hash pinned
 * eth_call. It cannot admit an instance, create an edge or supply a fallback
 * at another source hash.
 */
class PersistentPinnedEthCallCache {
  private readonly entries = new Map<string, string>();
  private readonly pendingRows: string[] = [];
  private writeTail: Promise<void> = Promise.resolve();
  private hits = 0;
  private writes = 0;
  private contentSha256: string;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private writeError: Error | undefined;

  constructor(
    private readonly path: string,
    private readonly sourceBlockHash: string,
    private readonly onError?: (error: Error) => void,
  ) {
    if (!isAbsolute(path)) {
      throw new Error("persistent eth_call cache path must be absolute");
    }
    const normalizedSource = normalizedHash32(
      sourceBlockHash,
      "persistent eth_call cache source hash",
    );
    if (normalizedSource !== sourceBlockHash) {
      throw new Error("persistent eth_call cache source hash is not canonical");
    }
    if (!existsSync(path)) {
      createPersistentCallCache(path, normalizedSource);
    }
    assertOwnerOnlyRegularFile(path);
    // Validate bounded groups of complete rows, never one giant JS string.
    // The map is authoritative only after all rows have passed validation.
    const fdRead = openSync(path, "r"), buffer = Buffer.alloc(1024 * 1024);
    const decoder = new StringDecoder("utf8");
    let header: string | undefined, tail = "", completeBytes = 0;
    let repair: "truncate" | "newline" | null = null;
    try {
      for (;;) {
        const count = readSync(fdRead, buffer);
        tail += count === 0 ? decoder.end() : decoder.write(buffer.subarray(0, count));
        if (header === undefined) {
          const end = tail.indexOf("\n");
          if (end >= 0) {
            header = tail.slice(0, end);
            completeBytes = Buffer.byteLength(tail.slice(0, end + 1));
            tail = tail.slice(end + 1);
            this.load(header + "\n", normalizedSource);
          }
        }
        if (header !== undefined) {
          const end = tail.lastIndexOf("\n");
          if (end >= 0) {
            const rows = tail.slice(0, end + 1);
            this.load(header + "\n" + rows, normalizedSource);
            completeBytes += Buffer.byteLength(rows);
            tail = tail.slice(end + 1);
          }
        }
        if (Buffer.byteLength(tail) > 16 * 1024 * 1024) throw new Error("persistent eth_call cache row exceeds 16 MiB");
        if (count === 0) {
          repair = this.load(header === undefined ? tail : header + "\n" + tail, normalizedSource);
          break;
        }
      }
    } finally { closeSync(fdRead); }
    if (repair === "truncate") {
      truncateSync(path, completeBytes);
      const fd = openSync(path, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else if (repair === "newline") {
      const fd = openSync(path, "a", 0o600);
      try {
        writeSync(fd, "\n", undefined, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.contentSha256 = sha256CacheFile(path);
  }

  get(identity: PersistentCallIdentity): string | undefined {
    if (this.writeError) throw this.writeError;
    this.assertIdentitySource(identity);
    const result = this.entries.get(identity.key);
    if (result !== undefined) this.hits++;
    return result;
  }

  record(identity: PersistentCallIdentity, result: string): void {
    if (this.writeError) throw this.writeError;
    this.assertIdentitySource(identity);
    const normalizedResult = normalizedHex(
      result,
      "persistent eth_call result",
    );
    const existing = this.entries.get(identity.key);
    if (existing !== undefined) {
      if (existing !== normalizedResult) {
        throw new Error(
          `persistent eth_call cache conflict for ${identity.key}`,
        );
      }
      return;
    }
    const row = persistentCallCacheEntry(identity, normalizedResult);
    this.entries.set(identity.key, normalizedResult);
    this.pendingRows.push(`${JSON.stringify(row)}\n`);
    this.writes++;
    if (this.pendingRows.length >= PERSISTENT_CALL_CACHE_FLUSH_ROWS) {
      void this.flush().catch(error => this.fail(error));
    } else if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flush().catch(error => this.fail(error));
      }, 1000);
      this.flushTimer.unref();
    }
  }

  async closeAndDrain(): Promise<void> {
    try { await this.flush(); await this.writeTail; }
    catch (error) { this.fail(error); throw error; }
    assertOwnerOnlyRegularFile(this.path);
    this.contentSha256 = sha256CacheFile(this.path);
  }

  stats(): Readonly<{
    sourceBlockHash: string;
    entries: number;
    hits: number;
    writes: number;
    contentSha256: string;
  }> {
    return Object.freeze({
      sourceBlockHash: this.sourceBlockHash,
      entries: this.entries.size,
      hits: this.hits,
      writes: this.writes,
      contentSha256: this.contentSha256,
    });
  }

  private flush(): Promise<void> {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.pendingRows.length === 0) return this.writeTail;
    const payload = this.pendingRows.splice(0).join("");
    this.writeTail = this.writeTail.then(() =>
      serializedOwnerOnlyAppend(this.path, payload)
    );
    return this.writeTail;
  }

  private fail(error: unknown): void {
    if (this.writeError) return;
    this.writeError = error instanceof Error ? error : new Error("persistent call cache write failed");
    this.onError?.(this.writeError);
  }

  private assertIdentitySource(identity: PersistentCallIdentity): void {
    if (identity.sourceBlockHash !== this.sourceBlockHash) {
      throw new Error(
        "persistent eth_call cache identity escaped its source hash",
      );
    }
  }

  private load(
    contents: string,
    expectedSourceBlockHash: string,
  ): "truncate" | "newline" | null {
    const trailingNewline = contents.endsWith("\n");
    const lines = contents.split("\n");
    if (trailingNewline) lines.pop();
    if (lines.length === 0 || lines[0]?.trim() === "") {
      throw new Error("persistent eth_call cache header is missing");
    }
    const values: unknown[] = [];
    let ignoredTruncatedRow = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (line.trim() === "") {
        throw new Error(
          `persistent eth_call cache has an empty row at ${index + 1}`,
        );
      }
      try {
        values.push(JSON.parse(line));
      } catch (error) {
        if (!trailingNewline && index === lines.length - 1) {
          // The process may have died between write(2) and the terminating
          // newline. Only a syntactically truncated final row is ignored.
          ignoredTruncatedRow = true;
          break;
        }
        throw new Error(
          `persistent eth_call cache JSON row ${index + 1} is invalid`,
          { cause: error },
        );
      }
    }
    const header = validatePersistentCallCacheHeader(
      values[0],
      expectedSourceBlockHash,
    );
    if (header.sourceBlockHash !== this.sourceBlockHash) {
      throw new Error("persistent eth_call cache header source mismatch");
    }
    for (let index = 1; index < values.length; index++) {
      const row = validatePersistentCallCacheEntry(
        values[index],
        expectedSourceBlockHash,
        index + 1,
      );
      const existing = this.entries.get(row.key);
      if (existing !== undefined && existing !== row.result) {
        throw new Error(
          `persistent eth_call cache conflicting row for ${row.key}`,
        );
      }
      this.entries.set(row.key, row.result);
    }
    if (ignoredTruncatedRow) return "truncate";
    return trailingNewline ? null : "newline";
  }
}

const persistentAppendTails = new Map<string, Promise<void>>();

function serializedOwnerOnlyAppend(
  path: string,
  payload: string,
): Promise<void> {
  const prior = persistentAppendTails.get(path) ?? Promise.resolve();
  const next = prior.then(async () => {
    assertOwnerOnlyRegularFile(path);
    const handle = await openFile(path, "a", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
  persistentAppendTails.set(path, next);
  void next.then(
    () => {
      if (persistentAppendTails.get(path) === next) {
        persistentAppendTails.delete(path);
      }
    },
    () => {
      if (persistentAppendTails.get(path) === next) {
        persistentAppendTails.delete(path);
      }
    },
  );
  return next;
}

function createPersistentCallCache(
  path: string,
  sourceBlockHash: string,
): void {
  const headerBody = {
    schemaVersion: 1 as const,
    profile: PERSISTENT_CALL_CACHE_PROFILE,
    sourceBlockHash,
  };
  const header: PersistentCallCacheHeader = Object.freeze({
    ...headerBody,
    headerSha256: sha256CanonicalTuple([
      headerBody.schemaVersion,
      headerBody.profile,
      headerBody.sourceBlockHash,
    ]),
  });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(header)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function validatePersistentCallCacheHeader(
  value: unknown,
  expectedSourceBlockHash: string,
): PersistentCallCacheHeader {
  const record = objectRecord(value, "persistent eth_call cache header");
  assertExactKeys(record, [
    "headerSha256",
    "profile",
    "schemaVersion",
    "sourceBlockHash",
  ], "persistent eth_call cache header");
  if (
    record.schemaVersion !== 1 ||
    record.profile !== PERSISTENT_CALL_CACHE_PROFILE
  ) {
    throw new Error("persistent eth_call cache header profile is invalid");
  }
  const sourceBlockHash = normalizedHash32(
    record.sourceBlockHash,
    "persistent eth_call cache header source hash",
  );
  if (sourceBlockHash !== expectedSourceBlockHash) {
    throw new Error(
      "persistent eth_call cache belongs to a different source hash",
    );
  }
  const expectedHeaderSha256 = sha256CanonicalTuple([
    1,
    PERSISTENT_CALL_CACHE_PROFILE,
    sourceBlockHash,
  ]);
  if (record.headerSha256 !== expectedHeaderSha256) {
    throw new Error("persistent eth_call cache header hash is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    profile: PERSISTENT_CALL_CACHE_PROFILE,
    sourceBlockHash,
    headerSha256: expectedHeaderSha256,
  });
}

function validatePersistentCallCacheEntry(
  value: unknown,
  expectedSourceBlockHash: string,
  rowNumber: number,
): PersistentCallCacheEntry {
  const label = `persistent eth_call cache row ${rowNumber}`;
  const record = objectRecord(value, label);
  assertExactKeys(record, [
    "calldata",
    "caller",
    "entrySha256",
    "key",
    "profile",
    "result",
    "schemaVersion",
    "sourceBlockHash",
    "target",
  ], label);
  if (
    record.schemaVersion !== 1 ||
    record.profile !== PERSISTENT_CALL_CACHE_PROFILE
  ) {
    throw new Error(`${label} profile is invalid`);
  }
  const identity = persistentCallIdentity(expectedSourceBlockHash, {
    to: String(record.target),
    data: String(record.calldata),
    ...(record.caller === null ? {} : { from: String(record.caller) }),
  });
  if (
    record.sourceBlockHash !== identity.sourceBlockHash ||
    record.target !== identity.target ||
    record.calldata !== identity.calldata ||
    record.caller !== identity.caller ||
    record.key !== identity.key
  ) {
    throw new Error(`${label} identity is not canonical`);
  }
  const result = normalizedHex(record.result, `${label} result`);
  const expectedEntrySha256 = persistentCallEntrySha256(identity, result);
  if (record.entrySha256 !== expectedEntrySha256) {
    throw new Error(`${label} content hash is invalid`);
  }
  return Object.freeze({
    schemaVersion: 1,
    profile: PERSISTENT_CALL_CACHE_PROFILE,
    ...identity,
    result,
    entrySha256: expectedEntrySha256,
  });
}

function persistentCallCacheEntry(
  identity: PersistentCallIdentity,
  result: string,
): PersistentCallCacheEntry {
  return Object.freeze({
    schemaVersion: 1,
    profile: PERSISTENT_CALL_CACHE_PROFILE,
    ...identity,
    result,
    entrySha256: persistentCallEntrySha256(identity, result),
  });
}

function persistentCallEntrySha256(
  identity: PersistentCallIdentity,
  result: string,
): string {
  return sha256CanonicalTuple([
    1,
    PERSISTENT_CALL_CACHE_PROFILE,
    identity.sourceBlockHash,
    identity.target,
    identity.calldata,
    identity.caller,
    identity.key,
    result,
  ]);
}

function persistentCallIdentity(
  sourceBlockHash: string,
  req: { readonly to: string; readonly data: string; readonly from?: string },
): PersistentCallIdentity {
  const source = normalizedHash32(
    sourceBlockHash,
    "persistent eth_call source hash",
  );
  const target = normalizedAddress(req.to, "persistent eth_call target");
  const calldata = normalizedHex(req.data, "persistent eth_call calldata");
  const caller = req.from === undefined
    ? null
    : normalizedAddress(req.from, "persistent eth_call caller");
  return Object.freeze({
    sourceBlockHash: source,
    target,
    calldata,
    caller,
    key: sha256CanonicalTuple([source, target, calldata, caller]),
  });
}

function assertOwnerOnlyRegularFile(path: string): void {
  const link = lstatSync(path);
  if (!link.isFile() || link.isSymbolicLink()) {
    throw new Error("persistent eth_call cache must be a regular file");
  }
  const stat = statSync(path);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("persistent eth_call cache permissions must be owner-only");
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error("persistent eth_call cache owner does not match runtime");
  }
}

function objectRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function normalizedAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !ethers.isAddress(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value.toLowerCase();
}

function normalizedHash32(value: unknown, label: string): string {
  if (typeof value !== "string" || !ethers.isHexString(value, 32)) {
    throw new Error(`${label} is invalid`);
  }
  return value.toLowerCase();
}

function normalizedHex(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value.toLowerCase();
}

function sha256CanonicalTuple(value: readonly unknown[]): string {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256CacheFile(path: string): string {
  const hash = createHash("sha256"), fd = openSync(path, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(fd, buffer);
      if (count === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, count));
    }
  } finally { closeSync(fd); }
}

class QueuedTransportRetry extends Error {}

interface PendingQuoteItem extends RethTransportRetryState {
  readonly id: number;
  readonly kind: "eth_call" | "eth_simulateV1";
  readonly control: StateCallControl;
  readonly req: { to: string; data: string; from?: string };
  readonly simulation?: unknown;
  /** Diagnostic-only: original entry into the backend queue, before retries. */
  enqueuedAtMs?: number;

  settled: boolean;
  detachControl: () => void;

  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

function eip1898BlockSpecifier(blockHash: string): {
  readonly blockHash: string;
  readonly requireCanonical: true;
} {
  if (!/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
    throw new Error(`invalid source block hash ${blockHash}`);
  }
  return Object.freeze({
    blockHash: blockHash.toLowerCase(),
    requireCanonical: true as const,
  });
}

function rpcItemError(
  item: { to: string },
  error: unknown,
): Error {
  const record = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown; data?: unknown }
    : null;
  const message =
    typeof record?.message === "string"
      ? record.message
      : `eth_call ${item.to} failed`;
  const err = new Error(message);
  if (record?.code !== undefined) {
    (err as { code?: unknown }).code = record.code;
  }
  if (record?.data !== undefined) {
    (err as { data?: unknown }).data = record.data;
  }
  return err;
}
