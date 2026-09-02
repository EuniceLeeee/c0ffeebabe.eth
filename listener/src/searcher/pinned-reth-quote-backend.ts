import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ethers } from "ethers";
import {
  decodeUintCall,
  isStateCallAbortedError,
  nativeTransfersToCaller,
  postJsonRpc,
  simulationCalls,
  StateCallAbortedError,
  type JsonRpcHttpResponse,
  type StateBackend,
  type StateCallControl,
  type TokenToNativeDeltaRequest,
  type TokenToNativeDeltaResult,
} from "../shared/state/state-backend.js";
import type {
  RethTransportScheduler,
} from "./reth-transport-scheduler.js";

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
  /**
   * Dynamic concurrency limit consulted on every flush. While the N-1
   * producer lags the head, the runtime supplies a low limit (1-2) so exact
   * batches cannot saturate reth; once the producer catches up it returns
   * the normal limit. When absent the static maxConcurrentBatches applies.
   */
  readonly maxConcurrentBatchesProvider?: () => number;
  /** Physical lane used when acquiring the shared reth transport permit. */
  readonly transportLane?: "producer-bulk" | "exact";
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
  readonly transportScheduler?: Pick<RethTransportScheduler, "run">;
  /**
   * Replay-only durable cache for successful deterministic eth_call results.
   * Ordinary live passes never supply this option.
   */
  readonly persistentEthCallCachePath?: string;
}

export class PinnedRethQuoteBackend
  implements PassScopedExactStateBackend
{
  private readonly maxBatchSize: number;
  private readonly maxConcurrentBatches: number;
  private readonly maxConcurrentBatchesProvider:
    | (() => number)
    | undefined;
  private readonly transportLane: "producer-bulk" | "exact";
  private readonly scopeLabel: string;
  private readonly allowSingleCallFallback: boolean;
  private readonly pending: PendingQuoteItem[] = [];
  private readonly liveItems = new Set<PendingQuoteItem>();
  private readonly activeFlushes = new Set<Promise<void>>();
  private readonly activeTransports = new Set<Promise<unknown>>();
  private readonly scopeController = new AbortController();

  private flushScheduled = false;
  private inFlightBatches = 0;
  private nextId = 1;
  private closed = false;
  private detachParentAbort: () => void = () => {};
  private scopeDeadlineTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly balanceSlotMemo = new Map<string, string>();
  private readonly callMemo = new Map<string, Promise<string>>();
  private readonly persistentCallCache:
    | PersistentPinnedEthCallCache
    | undefined;

  private totalCalls = 0;
  private memoHits = 0;
  private batchesSent = 0;
  private batchedItems = 0;
  private batchLatencyMs = 0;
  private abortedBatches = 0;
  private completedAfterScopeAbort = 0;
  private transportQueueWaitMs = 0;
  private batchFailures = 0;
  private singleCallFallbacks = 0;
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
    this.maxConcurrentBatchesProvider =
      options.maxConcurrentBatchesProvider;
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
        control,
        settled: false,
        detachControl: () => {},
        resolve: (value: unknown) => resolve(value as string),
        reject,
      };
      this.enqueue(item);
    }).then(
      (result) => {
        const settled = Promise.resolve(result);
        this.callMemo.set(memoKey, settled);
        return result;
      },
      (error) => {
        this.callMemo.delete(memoKey);
        throw error;
      },
    );
    return promise;
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
  }

  async closeAndDrain(
    reason: unknown = new Error("exact quote pass completed"),
  ): Promise<number> {
    const startedAtMs = Date.now();
    this.abort(reason);

    for (;;) {
      const active = [
        ...this.activeFlushes,
        ...this.activeTransports,
      ];
      if (active.length === 0) break;
      await Promise.allSettled(active);
    }

    await this.persistentCallCache?.closeAndDrain();

    this.detachParentAbort();
    if (this.scopeDeadlineTimer !== undefined) {
      clearTimeout(this.scopeDeadlineTimer);
      this.scopeDeadlineTimer = undefined;
    }

    this.lastDrainMs = Math.max(0, Date.now() - startedAtMs);
    return this.lastDrainMs;
  }

  stats(): Readonly<{
    lane: "producer-bulk" | "exact";
    scopeLabel: string;
    allowSingleCallFallback: boolean;
    maxBatchSize: number;
    maxConcurrentBatches: number;
    currentConcurrentBatchLimit: number;
    totalCalls: number;
    memoHits: number;
    batchesSent: number;
    batchedItems: number;
    batchLatencyMs: number;
    pendingItems: number;
    liveItems: number;
    inFlightBatches: number;
    activeTransports: number;
    abortedBatches: number;
    completedAfterScopeAbort: number;
    transportQueueWaitMs: number;
    batchFailures: number;
    singleCallFallbacks: number;
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
      currentConcurrentBatchLimit: Math.max(
        1,
        Math.floor(
          this.maxConcurrentBatchesProvider?.() ??
            this.maxConcurrentBatches,
        ),
      ),
      totalCalls: this.totalCalls,
      memoHits: this.memoHits,
      batchesSent: this.batchesSent,
      batchedItems: this.batchedItems,
      batchLatencyMs: this.batchLatencyMs,
      pendingItems: this.pending.length,
      liveItems: this.liveItems.size,
      inFlightBatches: this.inFlightBatches,
      activeTransports: this.activeTransports.size,
      abortedBatches: this.abortedBatches,
      completedAfterScopeAbort: this.completedAfterScopeAbort,
      transportQueueWaitMs: this.transportQueueWaitMs,
      batchFailures: this.batchFailures,
      singleCallFallbacks: this.singleCallFallbacks,
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
    if (this.pending.length >= this.maxBatchSize) this.pump();
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
      reason,
    );
  }

  private scheduleFlush(): void {
    if (this.closed || this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    const concurrencyLimit = Math.max(
      1,
      Math.floor(
        this.maxConcurrentBatchesProvider?.() ??
        this.maxConcurrentBatches,
      ),
    );
    while (
      !this.closed &&
      this.pending.length > 0 &&
      this.inFlightBatches < concurrencyLimit
    ) {
      const now = Date.now();
      const batch = this.pending.splice(0, this.maxBatchSize);
      const alive: PendingQuoteItem[] = [];
      for (const item of batch) {
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
      const task = this.flushBatch(alive).finally(() => {
        this.inFlightBatches--;
        this.activeFlushes.delete(task);
        this.scheduleFlush();
      });
      this.activeFlushes.add(task);
      void task.catch(() => {
        // flushBatch rejects items individually; this only prevents detached
        // rejections from surfacing as unhandled.
      });
    }
  }

  private async flushBatch(alive: PendingQuoteItem[]): Promise<void> {
    const calls = alive.filter((item) => item.kind === "eth_call");
    const simulations = alive.filter(
      (item) => item.kind === "eth_simulateV1",
    );
    await Promise.all([
      ...(calls.length > 0 ? [this.sendCallBatch(calls)] : []),
      ...(simulations.length > 0
        ? [this.sendSimulationBatch(simulations)]
        : []),
    ]);
  }

  private async runTransport<T>(
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const operation = this.options.transportScheduler
      ? this.options.transportScheduler.run(
          this.transportLane,
          signal,
          async ({ queueWaitMs }) => {
            this.transportQueueWaitMs += queueWaitMs;
            return work();
          },
        )
      : work();
    this.activeTransports.add(operation);
    try {
      return await operation;
    } finally {
      this.activeTransports.delete(operation);
    }
  }

  private async sendCallBatch(items: PendingQuoteItem[]): Promise<void> {
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
    await this.sendBatchPayloads(payloads, items, "eth_call");
  }

  private async sendSimulationBatch(
    items: PendingQuoteItem[],
  ): Promise<void> {
    const payloads = items.map((item) => ({
      jsonrpc: "2.0",
      id: item.id,
      method: "eth_simulateV1",
      params: [item.simulation, this.blockSpecifier],
    }));
    await this.sendBatchPayloads(payloads, items, "eth_simulateV1");
  }

  private async sendBatchPayloads(
    payloads: unknown[],
    items: PendingQuoteItem[],
    method: string,
  ): Promise<void> {
    if (this.closed || this.scopeController.signal.aborted) {
      const error = this.scopeAbortError(method);
      for (const item of items) this.rejectItem(item, error);
      return;
    }

    const byId = new Map(items.map((item) => [item.id, item]));
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

    const remainingScopeMs = Math.min(
      30_000,
      Math.max(
        0,
        (this.options.deadlineAtMs ?? Date.now() + 30_000) - Date.now(),
      ),
    );
    const timeout = setTimeout(
      () =>
        controller.abort(
          new StateCallAbortedError(
            `JSON-RPC batch ${method} transport timeout`,
            "timeout",
          ),
        ),
      remainingScopeMs,
    );

    const batchStartedAtMs = Date.now();
    let response: JsonRpcHttpResponse;
    try {
      response = await this.runTransport(controller.signal, () => {
        this.batchesSent++;
        this.batchedItems += items.length;
        return postJsonRpc(this.rpcUrl, payloads as never, controller.signal);
      });
    } catch (transportError) {
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
      await this.handleBatchFailure(items, method, transportError);
      return;
    } finally {
      this.batchLatencyMs += Math.max(0, Date.now() - batchStartedAtMs);
      clearTimeout(timeout);
      this.scopeController.signal.removeEventListener(
        "abort",
        onScopeAbort,
      );
    }

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
      now + 30_000,
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
    const timeout = setTimeout(
      () =>
        controller.abort(
          new StateCallAbortedError(
            `${method} ${label} aborted: transport timeout reached`,
            "timeout",
          ),
        ),
      Math.max(1, deadlineAtMs - now),
    );
    try {
      const response = await this.runTransport(controller.signal, () =>
        postJsonRpc(
          this.rpcUrl,
          {
            jsonrpc: "2.0",
            id: 1,
            method,
            params: [...params],
          } as never,
          controller.signal,
        ),
      );
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
    } catch (error) {
      if (
        controller.signal.aborted &&
        isStateCallAbortedError(error)
      ) {
        throw error;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
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

  constructor(
    private readonly path: string,
    private readonly sourceBlockHash: string,
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
    const contents = readFileSync(path, "utf8");
    const repair = this.load(contents, normalizedSource);
    if (repair === "truncate") {
      const validPrefix = contents.slice(
        0,
        contents.lastIndexOf("\n") + 1,
      );
      truncateSync(path, Buffer.byteLength(validPrefix, "utf8"));
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
    this.contentSha256 = sha256(readFileSync(path));
  }

  get(identity: PersistentCallIdentity): string | undefined {
    this.assertIdentitySource(identity);
    const result = this.entries.get(identity.key);
    if (result !== undefined) this.hits++;
    return result;
  }

  record(identity: PersistentCallIdentity, result: string): void {
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
      void this.flush().catch(() => {
        // closeAndDrain awaits the same writeTail and reports the failure at
        // the replay attempt boundary; avoid a detached rejection meanwhile.
      });
    }
  }

  async closeAndDrain(): Promise<void> {
    await this.flush();
    await this.writeTail;
    assertOwnerOnlyRegularFile(this.path);
    this.contentSha256 = sha256(readFileSync(this.path));
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
    if (this.pendingRows.length === 0) return this.writeTail;
    const payload = this.pendingRows.splice(0).join("");
    this.writeTail = this.writeTail.then(() =>
      serializedOwnerOnlyAppend(this.path, payload)
    );
    return this.writeTail;
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

interface PendingQuoteItem {
  readonly id: number;
  readonly kind: "eth_call" | "eth_simulateV1";
  readonly control: StateCallControl;
  readonly req: { to: string; data: string; from?: string };
  readonly simulation?: unknown;

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
