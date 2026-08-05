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

/**
 * Source-hash pinned quote backend for the block-scan exact probe stage.
 *
 * All quote calls are coalesced into JSON-RPC batches (NOT Multicall3) sent
 * directly to local reth. Every batch item keeps its own to/data/from and the
 * EIP-1898 block-hash specifier, so per-item semantics (msg.sender, non-view
 * calls, revert data) are identical to individual eth_call requests. Items
 * that need real execution (self-burn / ethertoken native redemption) are
 * grouped into a separate eth_simulateV1 batch.
 *
 * Per-item reverts are delivered back to the adapter with their original RPC
 * error data; only transport-level failures (HTTP/JSON/batch shape) fall back
 * to individual single-call requests.
 */
export class PinnedRethQuoteBackend implements StateBackend {
  private readonly maxBatchSize: number;
  private readonly maxConcurrentBatches: number;
  private readonly pending: PendingQuoteItem[] = [];
  private flushScheduled = false;
  private inFlightBatches = 0;
  private nextId = 1;
  private readonly balanceSlotMemo = new Map<string, string>();
  private readonly callMemo = new Map<string, Promise<string>>();
  private totalCalls = 0;
  private memoHits = 0;
  private batchesSent = 0;
  private batchedItems = 0;
  private batchLatencyMs = 0;

  constructor(
    private readonly rpcUrl: string,
    private readonly sourceBlockHash: string,
    opts: {
      readonly maxBatchSize?: number;
      readonly maxConcurrentBatches?: number;
    } = {},
  ) {
    this.maxBatchSize = opts.maxBatchSize ?? 500;
    this.maxConcurrentBatches = opts.maxConcurrentBatches ?? 8;
    const block = eip1898BlockSpecifier(sourceBlockHash);
    this.blockSpecifier = block;
  }

  private readonly blockSpecifier: {
    readonly blockHash: string;
    readonly requireCanonical: true;
  };

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
    return new Promise<string>((resolve, reject) => {
      const item: PendingQuoteItem = {
        kind: "eth_call",
        id: this.nextId++,
        req: { to: req.to, data: req.data, ...(req.from ? { from: req.from } : {}) },
        control,
        resolve: (value: unknown) => resolve(value as string),
        reject,
      };
      this.enqueue(item);
    }).then(
      (result) => {
        const promise = Promise.resolve(result);
        this.callMemo.set(memoKey, promise);
        return result;
      },
      (error) => {
        this.callMemo.delete(memoKey);
        throw error;
      },
    );
  }

  stats(): {
    readonly totalCalls: number;
    readonly memoHits: number;
    readonly batchesSent: number;
    readonly batchedItems: number;
    readonly batchLatencyMs: number;
  } {
    return {
      totalCalls: this.totalCalls,
      memoHits: this.memoHits,
      batchesSent: this.batchesSent,
      batchedItems: this.batchedItems,
      batchLatencyMs: this.batchLatencyMs,
    };
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
        resolve: (raw: unknown) => {
          const calls = simulationCalls(raw);
          if (calls.length !== 5 || calls.some((call) => call.status !== 1)) {
            reject(new Error(`token-to-native simulation failed for ${token}`));
            return;
          }
          const balanceBefore = decodeUintCall(calls[0].returnData, "balance before");
          const supplyBefore = decodeUintCall(calls[1].returnData, "supply before");
          const balanceAfter = decodeUintCall(calls[3].returnData, "balance after");
          const supplyAfter = decodeUintCall(calls[4].returnData, "supply after");
          if (balanceAfter > balanceBefore || supplyAfter > supplyBefore) {
            reject(new Error("token-to-native simulation observed increasing input state"));
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

  private enqueue(item: PendingQuoteItem): void {
    this.pending.push(item);
    const signal = item.control.signal;
    if (signal) {
      const onAbort = (): void => {
        const index = this.pending.indexOf(item);
        if (index >= 0) this.pending.splice(index, 1);
        item.reject(
          new StateCallAbortedError(
            `eth_call ${item.req.to} aborted: caller signal aborted`,
            "signal",
            signal.reason,
          ),
        );
        signal.removeEventListener("abort", onAbort);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.inFlightBatches >= this.maxConcurrentBatches) return;
    if (this.pending.length === 0) return;
    const now = Date.now();
    const batch = this.pending.splice(0, this.maxBatchSize);
    const alive: PendingQuoteItem[] = [];
    for (const item of batch) {
      const deadline = item.control.deadlineAtMs;
      if (deadline !== undefined && deadline <= now) {
        item.reject(
          new StateCallAbortedError(
            `eth_call ${item.req.to} aborted: absolute deadline reached`,
            "deadline",
          ),
        );
        continue;
      }
      if (item.control.signal?.aborted) {
        item.reject(
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
      const simulations = alive.filter((item) => item.kind === "eth_simulateV1");
      await Promise.all([
        ...(calls.length > 0
          ? [this.sendCallBatch(calls)]
          : []),
        ...(simulations.length > 0
          ? [this.sendSimulationBatch(simulations)]
          : []),
      ]);
    } finally {
      this.inFlightBatches--;
      this.scheduleFlush();
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

  private async sendSimulationBatch(items: PendingQuoteItem[]): Promise<void> {
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
    const byId = new Map(items.map((item) => [item.id, item]));
    let response: JsonRpcHttpResponse;
    const controller = new AbortController();
    const batchStartedAtMs = Date.now();
    const timeout = setTimeout(
      () => controller.abort(
        new Error(`JSON-RPC batch ${method} transport timeout`),
      ),
      30_000,
    );
    try {
      response = await postJsonRpc(
        this.rpcUrl,
        payloads as never,
        controller.signal,
      );
    } catch (transportError) {
      // Transport-level failure only: retry each item as an individual
      // request. Per-item contract reverts must NOT take this path.
      clearTimeout(timeout);
      await Promise.allSettled(
        items.map((item) => this.retryItemSingle(item, method, transportError)),
      );
      return;
    }
    clearTimeout(timeout);
    this.batchesSent++;
    this.batchedItems += items.length;
    this.batchLatencyMs += Date.now() - batchStartedAtMs;
    const body = Array.isArray(response.body) ? response.body : null;
    if (response.statusCode < 200 || response.statusCode >= 300 || body === null) {
      await Promise.allSettled(
        items.map((item) =>
          this.retryItemSingle(
            item,
            method,
            new Error(
              `JSON-RPC batch ${method} HTTP ${response.statusCode} ${response.statusMessage}`,
            ),
          ),
        ),
      );
      return;
    }
    const settled = new Set<number>();
    for (const entry of body) {
      if (!entry || typeof entry !== "object") continue;
      const entryObject = entry as { id?: unknown; result?: unknown; error?: unknown };
      if (typeof entryObject.id !== "number") continue;
      const item = byId.get(entryObject.id);
      if (!item || settled.has(entryObject.id)) continue;
      settled.add(entryObject.id);
      if (entryObject.error !== undefined && entryObject.error !== null) {
        item.reject(rpcItemError({ to: item.req.to }, entryObject.error));
      } else if (
        item.kind === "eth_call" &&
        typeof entryObject.result !== "string"
      ) {
        item.reject(
          new Error(`eth_call ${item.req.to} returned a non-string result`),
        );
      } else {
        item.resolve(entryObject.result);
      }
    }
    for (const item of items) {
      if (settled.has(item.id)) continue;
      item.reject(
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
    if (item.control.signal?.aborted) {
      item.reject(
        new StateCallAbortedError(
          `eth_call ${item.req.to} aborted: caller signal aborted`,
          "signal",
          item.control.signal.reason,
        ),
      );
      return;
    }
    try {
      const result =
        method === "eth_simulateV1"
          ? await this.rpcSingle(method, [item.simulation, this.blockSpecifier], item.req.to, item.control)
          : await this.rpcSingle(method, [
              {
                to: item.req.to,
                data: item.req.data,
                ...(item.req.from ? { from: item.req.from } : {}),
              },
              this.blockSpecifier,
            ], item.req.to, item.control);
      item.resolve(result);
    } catch (error) {
      item.reject(
        new Error(
          `single-call fallback for ${method} failed: ` +
            `${error instanceof Error ? error.message : String(error)} ` +
            `(transport: ${transportError instanceof Error ? transportError.message : String(transportError)})`,
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
    if (control.signal?.aborted) {
      throw new StateCallAbortedError(
        `${method} ${label} aborted: caller signal aborted`,
        "signal",
        control.signal.reason,
      );
    }
    const now = Date.now();
    const deadlineAtMs = control.deadlineAtMs ?? now + 30_000;
    if (deadlineAtMs <= now) {
      throw new StateCallAbortedError(
        `${method} ${label} aborted: absolute deadline reached`,
        "deadline",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(
        new StateCallAbortedError(
          `${method} ${label} aborted: 30-second transport timeout reached`,
          "timeout",
        ),
      ),
      Math.min(30_000, deadlineAtMs - now),
    );
    const onCallerAbort = (): void =>
      controller.abort(
        new StateCallAbortedError(
          `${method} ${label} aborted: caller signal aborted`,
          "signal",
          control.signal?.reason,
        ),
      );
    control.signal?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      const response = await postJsonRpc(
        this.rpcUrl,
        {
          jsonrpc: "2.0",
          id: 1,
          method,
          params: [...params],
        } as never,
        controller.signal,
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
      if (controller.signal.aborted && isStateCallAbortedError(error)) throw error;
      throw error;
    } finally {
      clearTimeout(timer);
      control.signal?.removeEventListener("abort", onCallerAbort);
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
      await this.verifyTokenBalanceSlot(token, caller, memoized, probeValue, control)
    ) {
      return memoized;
    }
    this.balanceSlotMemo.delete(memoKey);
    const candidates = new Set<string>();
    try {
      const raw = await this.rpcSingle(
        "eth_createAccessList",
        [
          { from: caller, to: token, data: ERC20.encodeFunctionData("balanceOf", [caller]) },
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
      candidates.add(ethers.keccak256(
        abi.encode(["address", "uint256"], [caller, BigInt(slot)]),
      ));
      candidates.add(ethers.keccak256(
        abi.encode(["uint256", "address"], [BigInt(slot), caller]),
      ));
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
              [token]: { stateDiff: { [slot]: ethers.toBeHex(probeValue, 32) } },
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
      return decodeUintCall(calls[0].returnData, "balance probe") === probeValue;
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
