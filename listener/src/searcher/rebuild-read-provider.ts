import { ethers } from "ethers";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { gunzipSync } from "node:zlib";
import { setTimeout as wait } from "node:timers/promises";
import { ReadyRpcRateError, type ReadyRpcThrottle } from "./ready-rpc-throttle.js";
import { isRpcQuotaExhaustedError, isRpcThrottleError } from "./rpc-throttle-guard.js";

const MAX_PHYSICAL_REQUESTS = 8;
type ReadyRpcResult = ethers.JsonRpcResult & { error?: unknown };

// These are original provider error envelopes, not decoded contract output.
// Do not require a 429/rate marker for an explicit spent allocation.
function readyQuotaExhausted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const item = error as { code?: unknown; data?: unknown; message?: unknown };
  if (item.code === 3 || item.code === "CALL_EXCEPTION" ||
      item.code === -32000 && typeof item.data === "string" && /^0x[0-9a-f]*$/i.test(item.data)) return false;
  const message = typeof item.message === "string" ? item.message : "";
  if (/\bexecution revert(?:ed)?\b/i.test(message)) return false;
  return isRpcQuotaExhaustedError(error) ||
    /\b(?:monthly|daily)\b.*\b(?:limit|quota|capacity)\b|\b(?:quota|credits?|compute[ -]units?)\b.*\b(?:exhaust(?:ed|ion)|deplet(?:ed|ion))\b/i.test(message);
}

export type RebuildReadProviderOptions = ethers.JsonRpcApiProviderOptions & {
  /** Infinity retains concurrency already bounded by a dedicated caller. */
  readonly maxPhysicalRequests?: number;
  /** Total time per physical scan request, including body transfer and retries. */
  readonly requestTimeoutMs?: number;
  /** Optional per-response wire/body limits. Undefined preserves existing behavior. */
  readonly maxReceivedBytes?: number;
  readonly maxDecompressedBytes?: number;
  readonly readyThrottle?: ReadyRpcThrottle;
};

/** Read fencing and bounded HTTP transport shared by rebuild providers. */
export class RebuildReadProvider extends ethers.JsonRpcProvider {
  private activeRequests = 0;
  private readonly maxPhysicalRequests: number;
  private readonly requestTimeoutMs?: number;
  private readonly maxReceivedBytes?: number;
  private readonly maxDecompressedBytes?: number;
  private readonly readyThrottle?: ReadyRpcThrottle;
  private readonly inflight = new Set<AbortController>();
  private readonly waiting: {
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];

  constructor(
    private readonly read: <T>(operation: () => Promise<T>) => Promise<T>,
    url?: ConstructorParameters<typeof ethers.JsonRpcProvider>[0],
    network?: ConstructorParameters<typeof ethers.JsonRpcProvider>[1],
    options?: RebuildReadProviderOptions,
  ) {
    const { maxPhysicalRequests = MAX_PHYSICAL_REQUESTS, requestTimeoutMs,
      maxReceivedBytes, maxDecompressedBytes, readyThrottle, ...rpcOptions } = options ?? {};
    if (maxPhysicalRequests !== Infinity &&
        (!Number.isSafeInteger(maxPhysicalRequests) || maxPhysicalRequests < 1)) {
      throw new Error("maxPhysicalRequests must be a positive integer or Infinity");
    }
    if (requestTimeoutMs !== undefined && (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0)) {
      throw new Error("requestTimeoutMs must be a positive integer");
    }
    for (const [name, limit] of Object.entries({ maxReceivedBytes, maxDecompressedBytes })) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error(name + " must be a positive integer");
    }
    super(url, network, { batchMaxCount: 8, ...rpcOptions });
    this.maxPhysicalRequests = maxPhysicalRequests;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxReceivedBytes = maxReceivedBytes;
    this.maxDecompressedBytes = maxDecompressedBytes;
    this.readyThrottle = readyThrottle;
  }

  private assertOpen(): void {
    if (this.destroyed) throw this.destroyedError();
    this.readyThrottle?.assertOpen();
  }

  private destroyedError(): Error {
    return ethers.makeError("provider destroyed; cancelled request", "UNSUPPORTED_OPERATION", {
      operation: "_send",
    });
  }

  private async acquire(): Promise<void> {
    this.assertOpen();
    if (this.activeRequests < this.physicalLimit) {
      this.activeRequests++;
      return;
    }
    await new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  private release(): void {
    if (this.activeRequests > this.physicalLimit) {
      this.activeRequests--;
      return;
    }
    const next = this.waiting.shift();
    if (next) {
      // Transfer the occupied slot directly, so later arrivals cannot jump
      // ahead of this waiter between its resolution and continuation.
      next.resolve();
    } else {
      this.activeRequests--;
    }
  }

  private get physicalLimit(): number {
    return Math.min(this.maxPhysicalRequests, this.readyThrottle?.concurrency ?? Infinity);
  }

  // Limit only the physical transport: public methods and network detection
  // can call send/_send recursively and must never hold another queue slot.
  override _send(...args: Parameters<ethers.JsonRpcProvider["_send"]>) {
    const operation = () => this.read(async () => {
      await this.acquire();
      try {
        // The fatal latch may have changed while ethers batched the request
        // or while this batch waited for a slot. Recheck before any HTTP I/O.
        return await this.read(() => {
          this.assertOpen();
          if (this.readyThrottle) return this.sendReady(args[0]);
          return this.requestTimeoutMs === undefined && this.maxReceivedBytes === undefined && this.maxDecompressedBytes === undefined
            ? super._send(...args) : this.sendBounded(...args);
        });
      } finally {
        this.release();
      }
    });
    return this.readyThrottle ? this.readyThrottle.read(operation) : operation();
  }

  private async sendReady(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]) {
    const items = Array.isArray(payload) ? payload : [payload];
    const results: ethers.JsonRpcResult[] = [];
    for (let offset = 0; offset < items.length;) {
      this.assertOpen();
      const chunk = items.slice(offset, offset + this.readyThrottle!.batchMaxCount);
      results.push(...await this.sendBounded(chunk.length === 1 ? chunk[0]! : chunk));
      offset += chunk.length;
    }
    return results;
  }

  private rateFailure(quotaExhausted: boolean): ReadyRpcRateError {
    const error = new ReadyRpcRateError(quotaExhausted);
    this.readyThrottle?.markFailure(error);
    this.readyThrottle?.observe(error);
    return error;
  }

  private async sendBounded(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]) {
    const request = this._getConnection();
    request.body = JSON.stringify(payload);
    request.setHeader("content-type", "application/json");
    const timeoutMs = Math.min(request.timeout, this.requestTimeoutMs ?? request.timeout);
    const deadline = performance.now() + timeoutMs;
    const controller = new AbortController();
    const sizeError = () => Object.assign(new Error("rebuild RPC response exceeds configured byte limit"), { code: "RESPONSE_SIZE_LIMIT" });
    const timeoutError = ethers.makeError("rebuild RPC request deadline timed out", "TIMEOUT", {
      operation: "request.send", reason: "absolute request deadline exceeded",
    });
    const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    this.inflight.add(controller);
    const checkDeadline = () => {
      if (performance.now() >= deadline && !controller.signal.aborted) controller.abort(timeoutError);
      controller.signal.throwIfAborted();
    };
    // Scan callers use ethers' default 250ms throttle policy. Keep its attempt
    // limit, but move waits into abortable preflight: ethers' private retry
    // timer otherwise survives both cancel() and provider.destroy(). Exhaustion
    // is checked by ethers BEFORE preflight, so the final 429 never waits.
    const preflight = request.preflightFunc, retry = request.retryFunc;
    let retryAfter: string | undefined, retryDelayMs = 0;
    request.setThrottleParams({ slotInterval: 0, ...(this.readyThrottle ? { maxAttempts: 1 } : {}) });
    request.preflightFunc = async req => {
      const delayMs = retryDelayMs;
      retryDelayMs = 0;
      if (delayMs > 0) await wait(delayMs, undefined, { signal: controller.signal });
      checkDeadline();
      return preflight ? preflight(req) : req;
    };
    request.retryFunc = async (req, response, attempt) => {
      const originalResponse = retryAfter === undefined ? response : new ethers.FetchResponse(
        response.statusCode, response.statusMessage,
        { ...response.headers, "retry-after": retryAfter }, response.body, req,
      );
      if (retry && !(await retry(req, originalResponse, attempt))) return false;
      checkDeadline();
      // Match the installed ethers policy, including numeric Retry-After in ms.
      retryDelayMs = retryAfter && /^[1-9][0-9]*$/.test(retryAfter)
        ? Number.parseInt(retryAfter, 10)
        : 250 * Math.trunc(Math.random() * 2 ** attempt);
      return true;
    };
    // ethers' Node transport uses an idle timer, and its cancel path does not
    // reliably close the socket. Bind the real HTTP request to our abort signal.
    request.getUrlFunc = async (req, signal) => {
      checkDeadline();
      signal?.checkSignal();
      const url = new URL(req.url);
      ethers.assert(url.protocol === "http:" || url.protocol === "https:", "unsupported RPC transport", "UNSUPPORTED_OPERATION", { operation: "request" });
      ethers.assert(url.protocol === "https:" || !req.credentials || req.allowInsecureAuthentication,
        "insecure authorized connections unsupported", "UNSUPPORTED_OPERATION", { operation: "request" });
      return new Promise((resolve, reject) => {
        const physical = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
          method: req.method, headers: req.headers, signal: controller.signal,
        }, response => {
          const chunks: Buffer[] = [];
          let receivedBytes = 0;
          const gzip = response.headers["content-encoding"] === "gzip";
          const receivedLimit = Math.min(this.maxReceivedBytes ?? Infinity,
            gzip ? Infinity : this.maxDecompressedBytes ?? Infinity);
          response.on("error", reject);
          if (Number(response.headers["content-length"]) > receivedLimit) {
            controller.abort(sizeError()); return;
          }
          response.on("data", chunk => {
            if (controller.signal.aborted) return;
            receivedBytes += chunk.length;
            if (receivedBytes > receivedLimit) {
              chunks.length = 0; controller.abort(sizeError()); return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.on("end", () => {
            try {
              checkDeadline();
              const headers = Object.fromEntries(Object.entries(response.headers)
                .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value ?? ""]));
              retryAfter = response.statusCode === 429 ? headers["retry-after"] : undefined;
              // Our preflight owns this wait; never schedule ethers' second,
              // uncancellable sleep. The original retry callback sees it above.
              if (response.statusCode === 429) delete headers["retry-after"];
              let body = chunks.length === 0 ? null : Buffer.concat(chunks);
              chunks.length = 0;
              if (headers["content-encoding"] === "gzip" && body !== null) {
                try { body = gunzipSync(body, this.maxDecompressedBytes === undefined ? {} : { maxOutputLength: this.maxDecompressedBytes }); }
                catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
                    controller.abort(sizeError()); return;
                  }
                  reject(ethers.makeError("bad response data", "SERVER_ERROR", {
                    request: req, info: { error },
                  }));
                  return;
                }
              }
              if (body !== null && body.length > (this.maxDecompressedBytes ?? Infinity)) {
                controller.abort(sizeError()); return;
              }
              checkDeadline();
              if (this.readyThrottle && response.statusCode === 429) {
                try {
                  let value: unknown;
                  try { value = body === null ? undefined : JSON.parse(body.toString("utf8")); } catch { /* Plain HTTP 429. */ }
                  const entries = Array.isArray(value) ? value : [value];
                  const quota = readyQuotaExhausted({ status: 429, message: body?.toString("utf8") ?? "" }) ||
                    entries.some(item => item !== null && typeof item === "object" &&
                    readyQuotaExhausted((item as { error?: unknown }).error ?? { status: 429, ...item }));
                  if (entries.some(item => item !== null && typeof item === "object" && "jsonrpc" in item)) {
                    const bound = validateReadyRpcResponse(payload, value);
                    if (bound.some(item => readyQuotaExhausted(item.error))) throw this.rateFailure(true);
                    if (!validReadySuccessfulReads(payload, bound) || bound.some(item => item.error !== undefined &&
                      !isRpcThrottleError(item.error))) throw new Error("Ready HTTP 429 also contains a non-rate or malformed read");
                  }
                  throw this.rateFailure(quota);
                } catch (error) {
                  controller.abort(error);
                  return;
                }
              }
              resolve({ statusCode: response.statusCode ?? 0, statusMessage: response.statusMessage ?? "", headers, body });
            } catch (error) { reject(error); }
          });
        });
        signal?.addListener(() => physical.destroy(ethers.makeError("request cancelled", "CANCELLED", {})));
        physical.on("error", reject);
        physical.end(req.body === null ? undefined : Buffer.from(req.body));
      });
    };
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        request.cancel();
        reject(controller.signal.reason);
      }, { once: true });
    });
    try {
      // The abort also settles time spent in ethers' redirect/throttle wait;
      // cancel prevents that wait from dispatching a late request afterwards.
      const response = await Promise.race([request.send(), cancelled]);
      checkDeadline();
      response.assertOk();
      const result = response.bodyJson;
      checkDeadline();
      if (this.readyThrottle) {
        const entries = validateReadyRpcResponse(payload, result);
        const errors = entries.flatMap(item => item.error === undefined ? [] : [item.error]);
        if (errors.some(readyQuotaExhausted)) throw this.rateFailure(true);
        if (errors.some(isRpcThrottleError)) {
          if (!errors.every(isRpcThrottleError) || !validReadySuccessfulReads(payload, entries)) {
            throw new Error("Ready RPC rate response also contains a non-rate or malformed read");
          }
          throw this.rateFailure(false);
        }
      }
      // Match JsonRpcProvider._send's declared type; ethers' dispatcher still
      // receives error envelopes unchanged and maps them to public RPC errors.
      return (Array.isArray(result) ? result : [result]) as ethers.JsonRpcResult[];
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }

  override send(...args: Parameters<ethers.JsonRpcProvider["send"]>) {
    return this.ownedRead(() => super.send(...args));
  }
  override getBlock(...args: Parameters<ethers.JsonRpcProvider["getBlock"]>) {
    return this.ownedRead(() => super.getBlock(...args));
  }
  override getCode(...args: Parameters<ethers.JsonRpcProvider["getCode"]>) {
    return this.ownedRead(() => super.getCode(...args));
  }
  override getStorage(...args: Parameters<ethers.JsonRpcProvider["getStorage"]>) {
    return this.ownedRead(() => super.getStorage(...args));
  }
  override getLogs(...args: Parameters<ethers.JsonRpcProvider["getLogs"]>) {
    return this.ownedRead(() => super.getLogs(...args));
  }

  private async ownedRead<T>(work: () => Promise<T>): Promise<T> {
    try { return await this.read(work); }
    catch (error) {
      // One ethers batch may join different candidate async contexts. Fence
      // each consumer even when a Family catches its own rejected read.
      if (error instanceof Error && this.readyThrottle?.isThrottle(error)) this.readyThrottle.markFailure(error);
      throw error;
    }
  }

  override destroy(): void {
    super.destroy();
    for (const controller of this.inflight) controller.abort(this.destroyedError());
    for (const waiter of this.waiting.splice(0)) waiter.reject(this.destroyedError());
  }
}

/** Preserve response binding; a malformed batch is never hidden by a rate retry. */
function validateReadyRpcResponse(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[], value: unknown): ReadyRpcResult[] {
  const requests = Array.isArray(payload) ? payload : [payload];
  const entries = Array.isArray(value) ? value : [value];
  const ids = new Set(requests.map(item => item.id));
  const seen = new Set<unknown>();
  if (entries.length !== requests.length || entries.some(item => {
    if (!item || typeof item !== "object" || item.jsonrpc !== "2.0" || !ids.has(item.id) || seen.has(item.id) ||
      (Object.hasOwn(item, "result") === Object.hasOwn(item, "error"))) return true;
    seen.add(item.id); return false;
  })) throw new Error("Ready RPC response identity mismatch");
  return entries;
}

function validReadySuccessfulReads(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[], entries: ReadyRpcResult[]): boolean {
  const requests = Array.isArray(payload) ? payload : [payload];
  return entries.every(entry => {
    if (entry.error !== undefined) return true;
    const method = requests.find(item => item.id === entry.id)!.method;
    const value = entry.result;
    if (["eth_chainId", "eth_getBalance", "eth_getTransactionCount", "eth_blockNumber"].includes(method)) {
      return typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
    }
    if (["eth_getCode", "eth_call", "eth_getStorageAt"].includes(method)) {
      return typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value) &&
        (method !== "eth_getStorageAt" || value.length === 66);
    }
    if (["eth_getBlockByHash", "eth_getBlockByNumber"].includes(method)) {
      return value !== null && typeof value === "object" && ["hash", "parentHash", "stateRoot"]
        .every(key => typeof value[key] === "string" && /^0x[0-9a-f]{64}$/i.test(value[key]));
    }
    return true;
  });
}
