import { FetchRequest, JsonRpcProvider, type JsonRpcPayload, type JsonRpcResult, type JsonRpcError } from "ethers";
import { setTimeout as delay } from "node:timers/promises";
import { postJsonRpc, StateCallAbortedError, type StateCallControl } from "../shared/state/state-backend.js";
import type { BlockTouchedProvider } from "./blockscan-touched-state.js";
import { isRethTransportTimeout, RethTransientReadError, type RethTransportScheduler, type RethTransportLoad, type RethTransportRetryState } from "./reth-transport-scheduler.js";
import { isRpcQuotaExhaustedError, isRpcThrottleError } from "./rpc-throttle-guard.js";

interface ActivityItem extends RethTransportRetryState { readonly payload: JsonRpcPayload }
type Reply = JsonRpcResult | JsonRpcError;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const IDEMPOTENT_ACTIVITY_METHODS = new Set([
  "eth_chainId", "eth_getLogs", "eth_getBlockByHash", "eth_getBlockByNumber",
  "debug_traceBlockByHash", "debug_traceBlockByNumber",
]);

// Keep provider text/URLs out of errors while preserving structured retry evidence.
function rpcError(value: unknown, retryableRead: boolean): Error & { code: number; data?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid activity RPC error");
  const raw = value as { code?: unknown; message?: unknown; data?: unknown };
  if (!Number.isSafeInteger(raw.code) || typeof raw.message !== "string") throw new Error("invalid activity RPC error");
  const transient = retryableRead && (raw.code === -32000 || raw.code === -32603) &&
    (raw.data === undefined || raw.data === null) && /^internal(?: server| json-rpc)? error[.!]?$/i.test(raw.message.trim());
  const message = isRpcQuotaExhaustedError(raw) ? "activity RPC quota exhausted"
    : isRpcThrottleError(raw) ? "activity RPC rate limit"
    : raw.code === 3 || raw.code === -32000 && typeof raw.data === "string" && /^0x[0-9a-f]*$/i.test(raw.data)
    ? "activity RPC execution reverted" : `activity RPC error code ${raw.code}`;
  return Object.assign(transient ? new RethTransientReadError("activity RPC internal error") : new Error(message), { code: raw.code as number,
    ...(typeof raw.data === "string" && /^0x[0-9a-f]*$/i.test(raw.data) ? { data: raw.data } : {}) });
}

/** The provider still owns JSON-RPC batching and log normalization. Only the
 * physical wire is replaced, so even network-detection eth_chainId takes a
 * shared permit. One failed envelope owns one retry group; siblings that
 * succeeded are never replayed. Trace/light remain separate provider queues. */
class ScheduledActivityProvider extends JsonRpcProvider {
  constructor(request: FetchRequest, private readonly scheduler: RethTransportScheduler,
    private readonly lifetime: AbortSignal) { super(request); }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    // Ethers narrows this concrete declaration although its consumer supports
    // error envelopes. Keep the library-boundary cast out of our wire helper.
    return await this.sendPayload(payload, this.lifetime) as JsonRpcResult[];
  }

  /** A controlled call owns its physical envelope, so cancelling one caller
   * cannot cancel an unrelated ethers batch. It uses the same wire/retry path. */
  async sendWithControl(method: string, params: unknown[], control: StateCallControl): Promise<unknown> {
    const { signal, deadlineAtMs } = control;
    if (deadlineAtMs !== undefined && !Number.isFinite(deadlineAtMs)) {
      throw new Error("invalid activity deadline");
    }
    const controller = new AbortController();
    const abort = () => controller.abort(new StateCallAbortedError("activity call aborted", "signal"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armDeadline = () => {
      if (deadlineAtMs === undefined) return;
      const remaining = deadlineAtMs - Date.now();
      if (remaining <= 0) controller.abort(new StateCallAbortedError("activity call deadline exceeded", "deadline"));
      else timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
    };
    this.lifetime.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    if (this.lifetime.aborted || signal?.aborted) abort();
    armDeadline();
    try {
      // Each controlled call is a distinct single-request envelope; IDs only
      // need to be unique within an envelope, not across concurrent sockets.
      const payload: JsonRpcPayload = { jsonrpc: "2.0", id: 1, method, params };
      const [reply] = await this.sendPayload(payload, controller.signal, deadlineAtMs);
      if (!reply) throw new Error("activity call lost its result");
      if ("error" in reply) throw rpcError(reply.error, false);
      return reply.result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.lifetime.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async sendPayload(payload: JsonRpcPayload | JsonRpcPayload[], signal: AbortSignal,
    deadlineAtMs?: number): Promise<Reply[]> {
    const original = Array.isArray(payload) ? payload : [payload];
    const batchSize = original.length;
    const pending: ActivityItem[][] = [original.map(payload => ({ payload }))];
    const replies = new Map<number, Reply>();
    let load: RethTransportLoad | undefined;
    const assertOpen = () => {
      if (signal.aborted) throw signal.reason instanceof StateCallAbortedError
        ? signal.reason : new StateCallAbortedError("activity transport aborted", "signal");
      if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
        throw new StateCallAbortedError("activity call deadline exceeded", "deadline");
      }
    };
    // A provider _send has at most one active physical envelope. Its split
    // retries are serial, but each releases the shared permit before backoff.
    while (pending.length) {
      assertOpen();
      const group = pending.shift()!;
      const wait = (group[0]?.transportRetryBatch?.notBeforeMs ?? 0) - Date.now();
      if (wait > 0) {
        try { await delay(wait, undefined, { signal }); }
        catch { assertOpen(); throw new Error("activity retry wait failed"); }
      }
      assertOpen();
      const limit = load?.limits(batchSize, 1, group).batchSize ?? batchSize;
      const items = group.slice(0, limit);
      if (group.length > items.length) pending.unshift(group.slice(items.length));
      await this.scheduler.run("producer-bulk", signal, async lease => {
        assertOpen();
        load = lease.load;
        if (!load) throw new Error("activity transport requires shared retry policy");
        const attempt = load.limits(batchSize, 1, items);
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason instanceof StateCallAbortedError
          ? signal.reason : new StateCallAbortedError("activity transport aborted", "signal"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        const timer = setTimeout(() => controller.abort(new StateCallAbortedError("activity transport timeout", "timeout")), load.timeoutMs);
        const retry = (error: unknown, failed: ActivityItem[]): boolean => {
          assertOpen();
          if (!load!.retry(error, failed, attempt)) return false;
          pending.unshift(failed);
          const next = load!.limits(batchSize, 1, failed);
          try {
            console.warn(`[searcher/activity-transport-retry] ${JSON.stringify({
              category: isRpcThrottleError(error) ? "throttle" : isRethTransportTimeout(error) ? "timeout" : "internal",
              items: failed.length, batchSize: attempt.batchSize, nextBatchSize: next.batchSize,
              delayMs: load!.retryDelayMs(failed), maxRetriesAtOne: load!.maxRetriesAtOne,
            })}`);
          } catch { /* Diagnostics do not change transport results. */ }
          return true;
        };
        try {
          const bodyPayload = items.map(item => item.payload);
          const response = await postJsonRpc(this._getConnection().url,
            (Array.isArray(payload) || items.length > 1 ? bodyPayload : bodyPayload[0]) as never, controller.signal);
          assertOpen();
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const bodies = Array.isArray(response.body) ? response.body : [response.body];
            const quota = bodies.some(body => isRecord(body) && isRpcQuotaExhaustedError(body.error));
            throw Object.assign(new Error(quota ? "activity RPC quota exhausted" : `activity HTTP ${response.statusCode}`),
              { statusCode: response.statusCode });
          }
          const whole = response.body;
          if (isRecord(whole) && whole.jsonrpc === "2.0" &&
              whole.id === null && Object.hasOwn(whole, "error") && !Object.hasOwn(whole, "result")) {
            throw rpcError(whole.error, items.every(item => IDEMPOTENT_ACTIVITY_METHODS.has(item.payload.method)));
          }
          const records = Array.isArray(response.body) ? response.body : [response.body];
          const expected = new Set(items.map(item => item.payload.id));
          const found = new Map<number, Reply>();
          const failures = new Map<number, Error>();
          for (const record of records) {
            if (!isRecord(record) || record.jsonrpc !== "2.0" || typeof record.id !== "number" ||
                !Number.isSafeInteger(record.id) || !expected.has(record.id) || found.has(record.id) ||
                Object.hasOwn(record, "error") === Object.hasOwn(record, "result")) {
              throw new Error("invalid activity JSON-RPC batch");
            }
            if (Object.hasOwn(record, "error")) {
              const item = items.find(item => item.payload.id === record.id)!;
              const error = rpcError(record.error, IDEMPOTENT_ACTIVITY_METHODS.has(item.payload.method));
              failures.set(record.id, error);
              found.set(record.id, { id: record.id, error: { code: error.code, message: error.message,
                ...(error.data === undefined ? {} : { data: error.data }) } });
            } else found.set(record.id, { id: record.id, result: record.result });
          }
          if (found.size !== items.length) throw new Error("incomplete activity JSON-RPC batch");
          // Validate the complete envelope before admitting any successful row.
          const quota = [...failures.values()].some(isRpcQuotaExhaustedError);
          const retryIds = new Set<number>();
          if (!quota) {
            for (const classify of [isRpcThrottleError, (error: unknown) => error instanceof RethTransientReadError]) {
              const failed = items.filter(item => classify(failures.get(item.payload.id)));
              if (failed.length && retry(failures.get(failed[0]!.payload.id), failed)) {
                for (const item of failed) retryIds.add(item.payload.id);
              }
            }
          }
          for (const [id, record] of found) if (!retryIds.has(id)) replies.set(id, record);
          if (quota) {
            // No newly dispatched retry can recover a spent allocation.
            for (const rest of pending.splice(0)) for (const item of rest) replies.set(item.payload.id,
              { id: item.payload.id, error: { code: 429, message: "activity RPC quota exhausted" } });
          }
        } catch (error) {
          assertOpen();
          // Only transport timeout/429 or explicitly classified read-only
          // internal errors use the shared retry policy. Malformed results,
          // source faults and execution errors remain fail-closed.
          if (!retry(error, items)) {
            const quota = isRpcQuotaExhaustedError(error), throttle = isRpcThrottleError(error);
            const message = quota ? "activity RPC quota exhausted" : throttle ? "activity RPC rate limit"
              : isRethTransportTimeout(error) ? "activity transport timeout"
              : error instanceof RethTransientReadError ? "activity RPC internal error" : "activity transport or JSON-RPC envelope failed";
            // Settle only this failed envelope. Other split siblings still drain
            // and successful replies remain intact, even after a terminal error.
            for (const item of items) replies.set(item.payload.id,
              { id: item.payload.id, error: { code: throttle ? 429 : -32603, message } });
            if (quota) for (const rest of pending.splice(0)) for (const item of rest) replies.set(item.payload.id,
              { id: item.payload.id, error: { code: 429, message } });
          }
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
      }); // The permit is released before any retry delay or split is visited.
    }
    assertOpen();
    return original.map(item => {
      const reply = replies.get(item.id);
      if (!reply) throw new Error("activity batch lost a result");
      return reply;
    });
  }
}

/** Independent batch queues: a slow trace response cannot hold a log/header
 * response in the same HTTP batch. Both retain ordinary RPC batching. Production
 * supplies the same physical scheduler used by effective/Exact quote work. */
export function createBlockScanActivityTransport(rpcUrl: string, options?: {
  readonly scheduler: RethTransportScheduler;
  readonly signal: AbortSignal;
}): BlockTouchedProvider & {
  sendWithControl(method: string, params: unknown[], control: StateCallControl): Promise<unknown>;
  destroy(): void;
} {
  const lifetime = new AbortController();
  const provider = () => {
    const request = new FetchRequest(rpcUrl);
    request.timeout = 30_000;
    return options ? new ScheduledActivityProvider(request, options.scheduler, lifetime.signal) : new JsonRpcProvider(request);
  };
  const light = provider(), trace = provider();
  const destroy = () => {
    options?.signal.removeEventListener("abort", destroy);
    if (lifetime.signal.aborted) return;
    lifetime.abort(new StateCallAbortedError("activity transport closed", "signal"));
    light.destroy(); trace.destroy();
  };
  options?.signal.addEventListener("abort", destroy, { once: true });
  if (options?.signal.aborted) destroy();
  return {
    getLogs: filter => light.getLogs(filter),
    send: (method, params) => (method.startsWith("debug_trace") || method.startsWith("trace_")
      ? trace : light).send(method, params),
    sendWithControl: (method, params, control) => {
      const provider = method.startsWith("debug_trace") || method.startsWith("trace_") ? trace : light;
      if (!(provider instanceof ScheduledActivityProvider)) {
        return Promise.reject(new Error("controlled activity reads require shared scheduler"));
      }
      return provider.sendWithControl(method, params, control);
    },
    destroy,
  };
}
