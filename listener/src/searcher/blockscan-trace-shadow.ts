import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { BlockTouchedCanonicalAnchor } from "./blockscan-touched-state.js";
import { isRpcQuotaExhaustedError, isRpcThrottleError } from "./rpc-throttle-guard.js";

export type BlockScanShadowTraceErrorCategory = "timeout" | "aborted" | "quota" | "throttle" |
  "http" | "rpc" | "transport" | "malformed-response" | "response-too-large" |
  "classification" | "invalid-anchor" | "invalid-logs" | "logs-unavailable";

/** Never carries provider text, response bytes, an endpoint, or a nested cause. */
export class BlockScanShadowTraceError extends Error {
  constructor(readonly category: BlockScanShadowTraceErrorCategory) {
    super(`blockscan trace shadow: ${category}`);
    this.name = "BlockScanShadowTraceError";
  }
}

export interface BlockScanShadowTraceControl {
  readonly blockNumber?: number;
  readonly anchor?: BlockTouchedCanonicalAnchor;
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
}
export type BlockScanShadowTraceRead = (
  blockHash: string, control: BlockScanShadowTraceControl,
) => Promise<unknown>;

interface ShadowEventBase {
  readonly chainId: number;
  readonly rootId: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly traceFinishedAtMs?: number;
  readonly logsObservedAtMs?: number;
  readonly traceWallMs?: number;
  readonly wallMs: number;
}
export type BlockScanTraceShadowEvent = ShadowEventBase & (
  | { readonly status: "compared"; readonly equalRefresh: boolean;
      readonly logStateKeys: readonly string[]; readonly traceStateKeys: readonly string[];
      readonly traceOnlyStateKeys: readonly string[]; readonly coveredByEachBlockStateKeys: readonly string[];
      readonly missingRefreshStateKeys: readonly string[];
      readonly oldRefreshStateKeys: readonly string[]; readonly newRefreshStateKeys: readonly string[] }
  | { readonly status: "skipped"; readonly reason: "duplicate" | "capacity" | "closed" | "logs-unavailable" }
  | { readonly status: "error"; readonly category: BlockScanShadowTraceErrorCategory }
  | { readonly status: "cancelled"; readonly reason: "closed" }
);

export interface BlockScanTraceShadowTicket {
  observeLogs(keys: Iterable<string>): void;
  failLogs(): void;
}
interface Entry {
  readonly number: number;
  readonly anchor: BlockTouchedCanonicalAnchor;
  readonly startedAtMs: number;
  readonly controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  logKeys?: ReadonlySet<string>;
  traceKeys?: ReadonlySet<string>;
  logsObservedAtMs?: number;
  traceFinishedAtMs?: number;
  comparing: boolean;
  done: boolean;
}
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const sorted = (keys: Iterable<string>): readonly string[] => Object.freeze([...new Set(keys)].sort());
function keysOf(keys: Iterable<string>): Set<string> {
  const result = new Set<string>();
  for (const key of keys) {
    if (typeof key !== "string" || !key.length) throw new Error("invalid state key");
    result.add(key.toLowerCase());
  }
  return result;
}
function bounded(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`invalid trace shadow ${name}`);
  return value;
}
function errorCategory(error: unknown): BlockScanShadowTraceErrorCategory {
  try {
    if (error instanceof BlockScanShadowTraceError) return error.category;
    if (isRpcQuotaExhaustedError(error)) return "quota";
    if (isRpcThrottleError(error)) return "throttle";
    if (error instanceof Error && error.name === "AbortError") return "aborted";
  } catch { /* Malformed error objects are diagnostics, never live failures. */ }
  return "transport";
}
function snapshotAnchor(number: number, anchor: BlockTouchedCanonicalAnchor): BlockTouchedCanonicalAnchor {
  if (!Number.isSafeInteger(number) || number < 0 || !anchor || !HASH.test(anchor.hash) ||
      !HASH.test(anchor.parentHash) || !Array.isArray(anchor.transactionHashes) ||
      Array.from(anchor.transactionHashes).some(hash => typeof hash !== "string" || !HASH.test(hash))) throw new Error("invalid anchor");
  const transactions = anchor.transactionHashes.map(hash => hash.toLowerCase());
  if (new Set(transactions).size !== transactions.length) throw new Error("duplicate transaction");
  const passive = anchor.passiveTouchedAddresses;
  if (passive !== undefined && (!Array.isArray(passive) || Array.from(passive).some(address => typeof address !== "string" || !ADDRESS.test(address)))) {
    throw new Error("invalid passive addresses");
  }
  return Object.freeze({ hash: anchor.hash.toLowerCase(), parentHash: anchor.parentHash.toLowerCase(),
    transactionHashes: Object.freeze(transactions), ...(passive === undefined ? {} : {
      passiveTouchedAddresses: Object.freeze(passive.map(address => address.toLowerCase())),
    }) });
}

/** Diagnostic ownership only. No live provider, cache, publication or scheduler.
 * A completed trace is reduced to keys immediately; it never waits in memory for logs.
 * Timeouts release logical entries, but an uncooperative reader keeps its physical
 * slot until it settles, preventing repeated timeouts from spawning unbounded I/O. */
export class BlockScanTraceShadow {
  private readonly known: ReadonlySet<string>;
  private readonly eachBlock: ReadonlySet<string>;
  private readonly maxConcurrent: number;
  private readonly maxRemembered: number;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, Entry>();
  private readonly inFlight = new Set<Entry>();
  private readonly remembered = new Map<string, number>();
  private closed = false;
  private readonly counts = { requested: 0, started: 0, compared: 0, equal: 0, withMissingRefresh: 0,
    missingRefreshKeys: 0, skipped: 0, duplicates: 0, capacitySkips: 0, closedSkips: 0,
    errors: 0, timeouts: 0, logsFailed: 0, cancelled: 0, callbackErrors: 0 };

  constructor(private readonly options: {
    readonly chainId: number;
    readonly rootId: string;
    readonly knownStateKeys: Iterable<string>;
    readonly perBlockRefreshStateKeys: Iterable<string>;
    readonly readTrace: BlockScanShadowTraceRead;
    readonly classifyTrace: (raw: unknown, number: number, anchor: BlockTouchedCanonicalAnchor, signal: AbortSignal) => Iterable<string> | Promise<Iterable<string>>;
    readonly onResult: (event: BlockScanTraceShadowEvent) => void | Promise<void>;
    readonly maxConcurrent?: number;
    readonly maxRemembered?: number;
    readonly timeoutMs?: number;
  }) {
    if (!Number.isSafeInteger(options.chainId) || options.chainId < 1 || !options.rootId) {
      throw new Error("invalid trace shadow identity");
    }
    this.options = Object.freeze({ ...options });
    this.known = keysOf(options.knownStateKeys);
    this.eachBlock = keysOf(options.perBlockRefreshStateKeys);
    if ([...this.eachBlock].some(key => !this.known.has(key))) throw new Error("unknown per-block shadow state key");
    this.maxConcurrent = bounded(options.maxConcurrent ?? 1, 4, "concurrency");
    this.maxRemembered = bounded(options.maxRemembered ?? 256, 4096, "retention");
    this.timeoutMs = bounded(options.timeoutMs ?? 30_000, 120_000, "timeout");
  }

  /** Synchronous admission; neither this method nor its ticket waits for trace. */
  begin(number: number, anchor: BlockTouchedCanonicalAnchor): BlockScanTraceShadowTicket | undefined {
    this.counts.requested++;
    let frozen: BlockTouchedCanonicalAnchor;
    try { frozen = snapshotAnchor(number, anchor); }
    catch {
      this.counts.errors++;
      const now = Date.now();
      this.emit({ ...this.identity(Number.isSafeInteger(number) ? number : -1,
        typeof anchor?.hash === "string" && HASH.test(anchor.hash) ? anchor.hash.toLowerCase() : ""),
        startedAtMs: now, finishedAtMs: now, wallMs: 0, status: "error", category: "invalid-anchor" });
      return undefined;
    }
    const skip = (reason: "closed" | "duplicate" | "capacity") => {
      this.counts.skipped++;
      if (reason === "duplicate") this.counts.duplicates++;
      else if (reason === "capacity") this.counts.capacitySkips++;
      else this.counts.closedSkips++;
      const now = Date.now();
      this.emit({ ...this.identity(number, frozen.hash), startedAtMs: now, finishedAtMs: now, wallMs: 0,
        status: "skipped", reason });
      return undefined;
    };
    if (this.closed) return skip("closed");
    if (this.pending.has(frozen.hash) || this.remembered.has(frozen.hash)) return skip("duplicate");
    if (this.pending.size >= this.maxConcurrent || this.inFlight.size >= this.maxConcurrent) return skip("capacity");
    const entry: Entry = { number, anchor: frozen, startedAtMs: Date.now(), controller: new AbortController(),
      comparing: false, done: false };
    this.pending.set(frozen.hash, entry);
    this.inFlight.add(entry);
    this.counts.started++;
    entry.timer = setTimeout(() => this.fail(entry, entry.traceKeys === undefined ? "timeout" : "logs-unavailable"), this.timeoutMs);
    entry.timer.unref();
    void this.run(entry);
    return Object.freeze({
      observeLogs: (keys: Iterable<string>) => {
        if (entry.done || entry.logKeys !== undefined) return;
        try {
          entry.logKeys = this.relevant(keys);
          entry.logsObservedAtMs = Date.now();
          this.compareWhenReady(entry);
        } catch { this.fail(entry, "invalid-logs"); }
      },
      failLogs: () => {
        if (entry.done) return;
        this.counts.logsFailed++;
        this.counts.skipped++;
        this.finish(entry, { ...this.eventBase(entry), status: "skipped", reason: "logs-unavailable" }, true);
      },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.pending.values()]) {
      this.counts.cancelled++;
      this.finish(entry, { ...this.eventBase(entry), status: "cancelled", reason: "closed" }, true);
    }
    for (const entry of this.inFlight) entry.controller.abort(new BlockScanShadowTraceError("aborted"));
    this.remembered.clear();
  }

  snapshot() {
    return Object.freeze({ ...this.counts, comparisonDenominator: this.counts.compared,
      active: this.pending.size, tracesInFlight: this.inFlight.size, remembered: this.remembered.size, closed: this.closed });
  }

  private async run(entry: Entry): Promise<void> {
    try {
      const raw = await this.options.readTrace(entry.anchor.hash, { signal: entry.controller.signal, blockNumber: entry.number, anchor: entry.anchor,
        deadlineAtMs: entry.startedAtMs + this.timeoutMs });
      if (entry.done) return;
      if (Date.now() >= entry.startedAtMs + this.timeoutMs) { this.fail(entry, "timeout"); return; }
      entry.traceFinishedAtMs = Date.now();
      try { entry.traceKeys = this.relevant(await this.options.classifyTrace(raw, entry.number, entry.anchor, entry.controller.signal)); }
      catch { this.fail(entry, "classification"); return; }
      if (entry.done) return;
      if (Date.now() >= entry.startedAtMs + this.timeoutMs) { this.fail(entry, "timeout"); return; }
      this.compareWhenReady(entry);
    } catch (error) { this.fail(entry, errorCategory(error)); }
    finally { this.inFlight.delete(entry); }
  }

  private relevant(keys: Iterable<string>): ReadonlySet<string> {
    return new Set([...keysOf(keys)].filter(key => this.known.has(key)));
  }

  private compareWhenReady(entry: Entry): void {
    if (entry.done || entry.comparing || entry.logKeys === undefined || entry.traceKeys === undefined) return;
    entry.comparing = true;
    // Even a trace-first completion cannot make observeLogs execute diagnostics inline.
    setImmediate(() => {
      if (entry.done) return;
      if (Date.now() >= entry.startedAtMs + this.timeoutMs) { this.fail(entry, "timeout"); return; }
      try {
        const logs = entry.logKeys!, trace = entry.traceKeys!;
        const traceOnly = [...trace].filter(key => !logs.has(key));
        const missing = traceOnly.filter(key => !this.eachBlock.has(key));
        const event: BlockScanTraceShadowEvent = { ...this.eventBase(entry), status: "compared",
          equalRefresh: missing.length === 0, logStateKeys: sorted(logs), traceStateKeys: sorted(trace),
          traceOnlyStateKeys: sorted(traceOnly), coveredByEachBlockStateKeys: sorted(traceOnly.filter(key => this.eachBlock.has(key))),
          missingRefreshStateKeys: sorted(missing), oldRefreshStateKeys: sorted([...logs, ...trace, ...this.eachBlock]),
          newRefreshStateKeys: sorted([...logs, ...this.eachBlock]) };
        this.counts.compared++;
        if (event.equalRefresh) this.counts.equal++;
        else this.counts.withMissingRefresh++;
        this.counts.missingRefreshKeys += missing.length;
        this.finish(entry, event, false);
      } catch { this.fail(entry, "classification"); }
    });
  }

  private fail(entry: Entry, category: BlockScanShadowTraceErrorCategory): void {
    if (entry.done) return;
    this.counts.errors++;
    if (category === "timeout") this.counts.timeouts++;
    if (category === "logs-unavailable") this.counts.logsFailed++;
    this.finish(entry, { ...this.eventBase(entry), status: "error", category }, true);
  }

  private finish(entry: Entry, event: BlockScanTraceShadowEvent, abort: boolean): void {
    if (entry.done) return;
    entry.done = true;
    clearTimeout(entry.timer);
    this.pending.delete(entry.anchor.hash);
    this.remembered.set(entry.anchor.hash, entry.number);
    while (this.remembered.size > this.maxRemembered) this.remembered.delete(this.remembered.keys().next().value!);
    entry.logKeys = undefined;
    entry.traceKeys = undefined;
    if (abort) entry.controller.abort(new BlockScanShadowTraceError(event.status === "error" ? event.category : "aborted"));
    this.emit(event);
  }

  private identity(blockNumber: number, blockHash: string) {
    return { chainId: this.options.chainId, rootId: this.options.rootId, blockNumber, blockHash };
  }

  private eventBase(entry: Entry): ShadowEventBase {
    const finishedAtMs = Date.now();
    return { ...this.identity(entry.number, entry.anchor.hash), startedAtMs: entry.startedAtMs, finishedAtMs,
      wallMs: Math.max(0, finishedAtMs - entry.startedAtMs),
      ...(entry.traceFinishedAtMs === undefined ? {} : { traceFinishedAtMs: entry.traceFinishedAtMs,
        traceWallMs: Math.max(0, entry.traceFinishedAtMs - entry.startedAtMs) }),
      ...(entry.logsObservedAtMs === undefined ? {} : { logsObservedAtMs: entry.logsObservedAtMs }) };
  }

  private emit(event: BlockScanTraceShadowEvent): void {
    const frozen = Object.freeze(event);
    queueMicrotask(() => {
      try { void Promise.resolve(this.options.onResult(frozen)).catch(() => { this.counts.callbackErrors++; }); }
      catch { this.counts.callbackErrors++; }
    });
  }
}

/** One independent request per trace, with no live permit/retry/fatal policy.
 * Dedicated agents bound sockets and close them on shutdown. JSON parsing still
 * runs in this process; the response ceiling bounds retained bytes, not CPU time. */
export function createBlockScanShadowTraceReader(endpoint: string, options: {
  readonly maxResponseBytes?: number; readonly timeoutMs?: number;
} = {}): BlockScanShadowTraceRead & { close(): void } {
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new Error("invalid trace shadow endpoint"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid trace shadow endpoint protocol");
  const maxBytes = bounded(options.maxResponseBytes ?? 32 * 1024 * 1024, 128 * 1024 * 1024, "response limit");
  // The observer's caller-supplied deadline owns normal timing. This ceiling
  // supports its entire allowed range; it must not silently shorten an override.
  const timeoutMs = bounded(options.timeoutMs ?? 120_000, 120_000, "transport timeout");
  // Admission is owned by the observer (default one, maximum four). Capacity
  // here supports that range without a hidden one-socket diagnostic queue.
  const http = new HttpAgent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 4 });
  const https = new HttpsAgent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 4 });
  const aborters = new Set<() => void>();
  let closed = false;
  const read: BlockScanShadowTraceRead = (blockHash, control) => {
    if (closed || control.signal.aborted) return Promise.reject(new BlockScanShadowTraceError("aborted"));
    if (!HASH.test(blockHash) || !Number.isFinite(control.deadlineAtMs)) {
      return Promise.reject(new BlockScanShadowTraceError("invalid-anchor"));
    }
    const remaining = Math.min(timeoutMs, control.deadlineAtMs - Date.now());
    if (remaining <= 0) return Promise.reject(new BlockScanShadowTraceError("timeout"));
    const deadlineAtMs = Date.now() + remaining;
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debug_traceBlockByHash",
        params: [blockHash.toLowerCase(), { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }] }));
      let request: ClientRequest | undefined, response: IncomingMessage | undefined;
      let done = false;
      const chunks: Buffer[] = [];
      let bytes = 0;
      const finish = (error?: BlockScanShadowTraceError, value?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        control.signal.removeEventListener("abort", abort);
        aborters.delete(abort);
        if (error) {
          response?.destroy(); request?.destroy(); chunks.length = 0;
          reject(error);
        } else { chunks.length = 0; resolve(value); }
      };
      const abort = () => finish(new BlockScanShadowTraceError("aborted"));
      const timer = setTimeout(() => finish(new BlockScanShadowTraceError("timeout")), remaining);
      timer.unref();
      aborters.add(abort);
      control.signal.addEventListener("abort", abort, { once: true });
      try {
        request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
          method: "POST", agent: url.protocol === "https:" ? https : http,
          headers: { "content-type": "application/json", "content-length": String(body.length) },
        }, incoming => {
          response = incoming;
          if (done) { incoming.destroy(); return; }
          const advertised = Number(incoming.headers["content-length"] ?? 0);
          if (advertised > maxBytes) { finish(new BlockScanShadowTraceError("response-too-large")); return; }
          incoming.on("data", (chunk: Buffer) => {
            if (done) return;
            bytes += chunk.length;
            if (bytes > maxBytes) { finish(new BlockScanShadowTraceError("response-too-large")); return; }
            chunks.push(chunk);
          });
          incoming.once("aborted", () => finish(new BlockScanShadowTraceError("transport")));
          incoming.once("error", () => finish(new BlockScanShadowTraceError("transport")));
          incoming.once("end", () => {
            if (done) return;
            if (Date.now() >= deadlineAtMs) { finish(new BlockScanShadowTraceError("timeout")); return; }
            const status = incoming.statusCode ?? 0;
            let parsed: unknown;
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
            catch { finish(new BlockScanShadowTraceError(status === 429 ? "throttle" :
              status >= 200 && status < 300 ? "malformed-response" : "http")); return; }
            if (Date.now() >= deadlineAtMs) { finish(new BlockScanShadowTraceError("timeout")); return; }
            const result = parsed as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown } | null;
            const category = errorCategory(result && typeof result === "object" ? result.error : undefined);
            if (status < 200 || status >= 300) {
              finish(new BlockScanShadowTraceError(category === "quota" ? "quota" : status === 429 ? "throttle" : "http")); return;
            }
            if (!result || typeof result !== "object" || Array.isArray(result) || result.jsonrpc !== "2.0" || result.id !== 1 ||
                Object.hasOwn(result, "result") === Object.hasOwn(result, "error")) {
              finish(new BlockScanShadowTraceError("malformed-response")); return;
            }
            if (Object.hasOwn(result, "error")) {
              finish(new BlockScanShadowTraceError(category === "quota" || category === "throttle" ? category : "rpc")); return;
            }
            finish(undefined, result.result);
          });
        });
        request.once("error", () => finish(new BlockScanShadowTraceError("transport")));
        if (closed || control.signal.aborted) abort();
        else request.end(body);
      } catch { finish(new BlockScanShadowTraceError("transport")); }
    });
  };
  return Object.assign(read, { close() {
    if (closed) return;
    closed = true;
    for (const abort of [...aborters]) abort();
    http.destroy(); https.destroy();
  } });
}
