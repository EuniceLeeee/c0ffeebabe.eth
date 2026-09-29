import { ethers } from "ethers";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { gunzipSync } from "node:zlib";
import { setTimeout as wait } from "node:timers/promises";

const MAX_PHYSICAL_REQUESTS = 8;

export type RebuildReadProviderOptions = ethers.JsonRpcApiProviderOptions & {
  /** Infinity retains concurrency already bounded by a dedicated caller. */
  readonly maxPhysicalRequests?: number;
  /** Total time per physical scan request, including body transfer and retries. */
  readonly requestTimeoutMs?: number;
};

/** Read fencing and bounded HTTP transport shared by rebuild providers. */
export class RebuildReadProvider extends ethers.JsonRpcProvider {
  private activeRequests = 0;
  private readonly maxPhysicalRequests: number;
  private readonly requestTimeoutMs?: number;
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
    const { maxPhysicalRequests = MAX_PHYSICAL_REQUESTS, requestTimeoutMs, ...rpcOptions } = options ?? {};
    if (maxPhysicalRequests !== Infinity &&
        (!Number.isSafeInteger(maxPhysicalRequests) || maxPhysicalRequests < 1)) {
      throw new Error("maxPhysicalRequests must be a positive integer or Infinity");
    }
    if (requestTimeoutMs !== undefined && (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0)) {
      throw new Error("requestTimeoutMs must be a positive integer");
    }
    super(url, network, { batchMaxCount: 8, ...rpcOptions });
    this.maxPhysicalRequests = maxPhysicalRequests;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  private assertOpen(): void {
    if (this.destroyed) throw this.destroyedError();
  }

  private destroyedError(): Error {
    return ethers.makeError("provider destroyed; cancelled request", "UNSUPPORTED_OPERATION", {
      operation: "_send",
    });
  }

  private async acquire(): Promise<void> {
    this.assertOpen();
    if (this.activeRequests < this.maxPhysicalRequests) {
      this.activeRequests++;
      return;
    }
    await new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      // Transfer the occupied slot directly, so later arrivals cannot jump
      // ahead of this waiter between its resolution and continuation.
      next.resolve();
    } else {
      this.activeRequests--;
    }
  }

  // Limit only the physical transport: public methods and network detection
  // can call send/_send recursively and must never hold another queue slot.
  override _send(...args: Parameters<ethers.JsonRpcProvider["_send"]>) {
    return this.read(async () => {
      await this.acquire();
      try {
        // The fatal latch may have changed while ethers batched the request
        // or while this batch waited for a slot. Recheck before any HTTP I/O.
        return await this.read(() => {
          this.assertOpen();
          return this.requestTimeoutMs === undefined ? super._send(...args) : this.sendBounded(...args);
        });
      } finally {
        this.release();
      }
    });
  }

  private async sendBounded(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]) {
    const request = this._getConnection();
    request.body = JSON.stringify(payload);
    request.setHeader("content-type", "application/json");
    const timeoutMs = Math.min(request.timeout, this.requestTimeoutMs!);
    const deadline = performance.now() + timeoutMs;
    const controller = new AbortController();
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
    request.setThrottleParams({ slotInterval: 0 });
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
          response.on("data", chunk => chunks.push(Buffer.from(chunk)));
          response.on("error", reject);
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
              if (headers["content-encoding"] === "gzip" && body !== null) {
                try { body = gunzipSync(body); }
                catch (error) {
                  reject(ethers.makeError("bad response data", "SERVER_ERROR", {
                    request: req, info: { error },
                  }));
                  return;
                }
              }
              checkDeadline();
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
    return this.read(() => super.send(...args));
  }
  override getBlock(...args: Parameters<ethers.JsonRpcProvider["getBlock"]>) {
    return this.read(() => super.getBlock(...args));
  }
  override getCode(...args: Parameters<ethers.JsonRpcProvider["getCode"]>) {
    return this.read(() => super.getCode(...args));
  }
  override getStorage(...args: Parameters<ethers.JsonRpcProvider["getStorage"]>) {
    return this.read(() => super.getStorage(...args));
  }
  override getLogs(...args: Parameters<ethers.JsonRpcProvider["getLogs"]>) {
    return this.read(() => super.getLogs(...args));
  }

  override destroy(): void {
    super.destroy();
    for (const controller of this.inflight) controller.abort(this.destroyedError());
    for (const waiter of this.waiting.splice(0)) waiter.reject(this.destroyedError());
  }
}
