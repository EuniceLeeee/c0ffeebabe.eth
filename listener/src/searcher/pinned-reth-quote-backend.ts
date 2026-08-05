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
 * Pass-scoped source-hash pinned quote backend for the block-scan exact
 * probe stage.
 *
 * All quote calls are coalesced into JSON-RPC batches (NOT Multicall3) sent
 * directly to local reth. Every batch item keeps its own to/data/from and the
 * EIP-1898 block-hash specifier, so per-item semantics (msg.sender, non-view
 * calls, revert data) are identical to individual eth_call requests. Items
 * that need real execution (self-burn / ethertoken native redemption) are
 * grouped into a separate eth_simulateV1 batch.
 *
 * Lifecycle: the backend is created per pass, bound to the pass signal and
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
  readonly signal?: AbortSignal;
  readonly deadlineAtMs?: number;
  readonly transportScheduler?: Pick<RethTransportScheduler, "run">;
}

export class PinnedRethQuoteBackend
  implements PassScopedExactStateBackend
{
  private readonly maxBatchSize: number;
  private readonly maxConcurrentBatches: number;
  private readonly maxConcurrentBatchesProvider:
    | (() => number)
    | undefined;
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

  private totalCalls = 0;
  private memoHits = 0;
  private batchesSent = 0;
  private batchedItems = 0;
  private batchLatencyMs = 0;
  private abortedBatches = 0;
  private completedAfterScopeAbort = 0;
  private transportQueueWaitMs = 0;
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
    this.blockSpecifier = eip1898BlockSpecifier(sourceBlockHash);

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
    const memoKey =
      `${req.to.toLowerCase()}|${req.data}|` +
      `${(req.from ?? "").toLowerCase()}`;
    const memoized = this.callMemo.get(memoKey);
    if (memoized !== undefined) {
      this.memoHits++;
      return memoized;
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

    this.detachParentAbort();
    if (this.scopeDeadlineTimer !== undefined) {
      clearTimeout(this.scopeDeadlineTimer);
      this.scopeDeadlineTimer = undefined;
    }

    this.lastDrainMs = Math.max(0, Date.now() - startedAtMs);
    return this.lastDrainMs;
  }

  stats(): Readonly<{
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
    drainMs: number;
  }> {
    return Object.freeze({
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
      drainMs: this.lastDrainMs,
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
    this.scheduleFlush();
  }

  private resolveItem(item: PendingQuoteItem, value: unknown): void {
    if (item.settled) return;
    item.settled = true;
    item.detachControl();
    this.liveItems.delete(item);
    item.resolve(value);
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
      `exact quote ${label} aborted: pass scope closed`,
      "signal",
      reason,
    );
  }

  private scheduleFlush(): void {
    if (this.closed || this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      if (this.closed) return;
      const task = this.flush();
      this.activeFlushes.add(task);
      void task
        .finally(() => {
          this.activeFlushes.delete(task);
        })
        .catch(() => {
          // flush() rejects items individually; this only prevents detached
          // rejections from surfacing as unhandled.
        });
    });
  }

  private async flush(): Promise<void> {
    const concurrencyLimit = Math.max(
      1,
      Math.floor(
        this.maxConcurrentBatchesProvider?.() ??
          this.maxConcurrentBatches,
      ),
    );
    if (this.inFlightBatches >= concurrencyLimit) return;
    if (this.pending.length === 0) return;
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
    if (alive.length === 0) {
      this.scheduleFlush();
      return;
    }
    this.inFlightBatches++;
    try {
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
    } finally {
      this.inFlightBatches--;
      this.scheduleFlush();
    }
  }

  private async runTransport<T>(
    signal: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const operation = this.options.transportScheduler
      ? this.options.transportScheduler.run(
          "exact",
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
    this.inFlightBatches++;
    let response: JsonRpcHttpResponse;
    try {
      response = await this.runTransport(controller.signal, () =>
        postJsonRpc(this.rpcUrl, payloads as never, controller.signal),
      );
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
      await Promise.allSettled(
        items
          .filter((item) => !item.settled)
          .map((item) =>
            this.retryItemSingle(item, method, transportError),
          ),
      );
      return;
    } finally {
      this.inFlightBatches--;
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

    this.batchesSent++;
    this.batchedItems += items.length;
    this.batchLatencyMs += Date.now() - batchStartedAtMs;

    const body = Array.isArray(response.body) ? response.body : null;
    if (
      response.statusCode < 200 ||
      response.statusCode >= 300 ||
      body === null
    ) {
      await Promise.allSettled(
        items
          .filter((item) => !item.settled)
          .map((item) =>
            this.retryItemSingle(
              item,
              method,
              new Error(
                `JSON-RPC batch ${method} HTTP ` +
                  `${response.statusCode} ${response.statusMessage}`,
              ),
            ),
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
      this.rejectItem(
        item,
        new Error(
          `JSON-RPC batch ${method} missing response for id ${item.id}`,
        ),
      );
    }
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
