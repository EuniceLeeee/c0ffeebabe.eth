// Diagnostic input cassette, never imported by live. Only the live-owned
// prerequisite phase can record/replay; measured work is always forwarded.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { redactToolOutput } from "../../analysis/src/tool-run-security.js";
import { isRpcThrottleError } from "../src/searcher/rpc-throttle-guard.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Rpc = { id: number | string; method: string; params: Json[] };
type Reply = { result: Json } | { error: { code: number; message: string; data?: string } };
export type CachePhase = "record" | "replay" | "measured";
export const cacheDigest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function cacheJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return { $benchmarkBigint: item.toString() };
    if (item instanceof Map) return { $benchmarkMap: [...item].sort(([a], [b]) => String(a).localeCompare(String(b))) };
    if (item instanceof Set) return { $benchmarkSet: [...item].sort() };
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
  });
}

const READS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getLogs",
  "eth_call", "eth_getBalance", "eth_getCode", "eth_getTransactionCount", "eth_getStorageAt",
  "eth_simulateV1", "debug_traceCall", "debug_traceBlockByNumber", "debug_traceBlockByHash"]);
function rpcRequest(value: unknown): Rpc {
  assert(value && typeof value === "object", "invalid RPC request");
  const rpc = value as Rpc;
  assert((typeof rpc.id === "number" || typeof rpc.id === "string") && READS.has(rpc.method) &&
    Array.isArray(rpc.params), "cache endpoint only accepts explicit read-only RPC calls");
  return rpc;
}
function requestKey(rpc: Rpc): string {
  // No request IDs, batching order, URL, credential, or transport timing enters
  // the key. Explicit historical parameters (including overrides) do.
  const quantity = (value: Json | undefined) => typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
  const hash = (value: Json | undefined) => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
  const object = (value: Json | undefined): value is { [key: string]: Json } => !!value && typeof value === "object" && !Array.isArray(value);
  const blockPin = (value: Json | undefined): boolean => quantity(value) || object(value) && (
    hash(value.blockHash) && value.blockNumber === undefined &&
      (value.requireCanonical === undefined || typeof value.requireCanonical === "boolean") ||
    quantity(value.blockNumber) && value.blockHash === undefined
  );
  const position = rpc.method === "eth_getStorageAt" ? 2 :
    ["eth_call", "eth_getBalance", "eth_getCode", "eth_getTransactionCount", "eth_simulateV1", "debug_traceCall"].includes(rpc.method) ? 1 : null;
  if (position !== null) assert(blockPin(rpc.params[position]), "unpinned prerequisite RPC");
  if (rpc.method.endsWith("ByNumber")) assert(quantity(rpc.params[0]), "unpinned prerequisite RPC");
  if (rpc.method.endsWith("ByHash")) assert(hash(rpc.params[0]), "unpinned prerequisite RPC");
  if (rpc.method === "eth_getLogs") {
    const filter = rpc.params[0];
    assert(object(filter) && (hash(filter.blockHash) && filter.fromBlock === undefined && filter.toBlock === undefined ||
      filter.blockHash === undefined && quantity(filter.fromBlock) && quantity(filter.toBlock)), "unpinned prerequisite RPC");
  }
  if (rpc.method === "eth_chainId") assert.equal(rpc.params.length, 0, "invalid chain ID request");
  return cacheJson([rpc.method, rpc.params]);
}
function recordableReply(value: unknown): Reply {
  assert(value && typeof value === "object", "invalid RPC response");
  const reply = value as { result?: Json; error?: { code?: number; message?: string; data?: string } };
  if (Object.hasOwn(reply, "result") && reply.error === undefined) return { result: reply.result! };
  const error = reply.error;
  // A deterministic contract revert is input evidence. Provider throttles,
  // timeouts and infrastructure failures must never become reusable fixtures.
  assert(error && (error.code === 3 || error.code === -32000) && typeof error.message === "string" &&
    /execution reverted/i.test(error.message) && !/https?:\/\//i.test(error.message) &&
    (error.data === undefined || /^0x[0-9a-f]*$/i.test(error.data)), "non-cacheable RPC failure");
  return { error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } };
}

export interface PrerequisiteManifest {
  schema: 1;
  compatibility: unknown;
  producer: unknown;
  entryCount: number;
  rpcSha256: string;
  /** Output hashes verify local restoration, not a substitute for computation. */
  heads: Record<string, { effectiveSha256: string; candidatesSha256: string | null }>;
}

export class PrerequisiteCache {
  private readonly entries = new Map<string, Reply>();
  private readonly unresolvedThrottles = new Set<string>();
  private phase: CachePhase;
  private fault: Error | undefined;
  private faultPhase: CachePhase | undefined;
  private rpcFailure: { method: string; code: unknown; message: string; dataType: string; dataKeyCount: number } | undefined;
  private counts = { replayed: 0, recorded: 0, forwarded: 0, measured: 0, misses: 0, throttled: 0 };
  private readonly active = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  // Ready restoration can block the local event loop beyond the default idle
  // timeout. Keep these loopback sockets until explicit close(), which destroys
  // idle connections as well as in-flight requests; live never imports this cache.
  private readonly server = createServer({ keepAliveTimeout: 0 }, (request, response) => {
    const phase = this.phase; // Requests retain their dispatch phase across a boundary.
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => { if (!response.writableEnded) controller.abort(); };
    request.once("aborted", abort); response.once("close", abort);
    const work = (async () => {
      try {
        assert(request.method === "POST" && request.url === this.secretPath, "invalid cache endpoint");
        const chunks: Buffer[] = []; let size = 0;
        for await (const part of request) {
          size += part.length; assert(size <= 64 * 1024 * 1024, "RPC request too large"); chunks.push(part);
        }
        const body = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = JSON.parse(body), batch = Array.isArray(parsed);
        const calls = (batch ? parsed : [parsed]).map(rpcRequest);
        assert(calls.length > 0 && calls.length <= 1024, "invalid RPC batch");
        if (phase === "replay") {
          const replies = calls.map(rpc => {
            const reply = this.entries.get(requestKey(rpc));
            if (!reply) { this.counts.misses++; throw new Error(`prerequisite cache miss: ${rpc.method}`); }
            this.counts.replayed++;
            return { jsonrpc: "2.0", id: rpc.id, ...reply };
          });
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(batch ? replies : replies[0])); return;
        }
        const keys = phase === "record" ? calls.map(requestKey) : [];
        this.counts.forwarded += calls.length;
        if (phase === "measured") this.counts.measured += calls.length;
        const upstream = await fetch(this.upstreamUrl, { method: "POST", headers: { "content-type": "application/json" },
          body, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]) });
        const bytes = await upstream.text();
        if (phase === "record") {
          assert(upstream.ok, "non-cacheable HTTP failure");
          const result = JSON.parse(bytes), results: Array<{ id: number | string }> = batch ? result : [result];
          assert(Array.isArray(results) && results.length === calls.length, "incomplete RPC batch response");
          const byId = new Map(results.map(reply => [reply.id, reply]));
          assert.equal(byId.size, results.length, "duplicate RPC reply ID");
          calls.forEach((rpc, index) => {
            const key = keys[index]!;
            let value: Reply;
            try { value = recordableReply(byId.get(rpc.id)); }
            catch (failure) {
              const reply = byId.get(rpc.id) as { error?: { code?: unknown; message?: string; data?: unknown } } | undefined;
              const error = reply?.error;
              this.rpcFailure ??= { method: rpc.method, code: typeof error?.code === "number" ? error.code : null,
                message: redactToolOutput(String(error?.message ?? "missing response"), { MAINNET_RPC_URL: this.upstreamUrl }).slice(0, 240),
                dataType: error?.data === null ? "null" : typeof error?.data,
                dataKeyCount: error?.data && typeof error.data === "object" ? Object.keys(error.data).length : 0 };
              if (isRpcThrottleError(error)) {
                // Return the original response to the production retry policy.
                // This transport does not retry and never caches a throttle.
                // A completed capture must have a stable reply for every key.
                this.counts.throttled++;
                if (!this.entries.has(key)) this.unresolvedThrottles.add(key);
                return;
              }
              throw failure;
            }
            const previous = this.entries.get(key);
            assert(previous === undefined || cacheJson(previous) === cacheJson(value), "historical RPC result changed during capture");
            this.entries.set(key, value); this.counts.recorded++;
            this.unresolvedThrottles.delete(key);
          });
        }
        response.statusCode = upstream.status;
        response.setHeader("content-type", "application/json"); response.end(bytes);
      } catch (error) {
        // Latch the failure even if a Family turns the returned error into an
        // unavailable quote. A cache miss may never masquerade as no opportunity.
        if (phase !== "measured" || error instanceof assert.AssertionError) {
          if (!this.fault) {
            this.faultPhase = phase;
            const safeReason = error instanceof assert.AssertionError && ["invalid RPC request", "invalid cache endpoint",
              "cache endpoint only accepts explicit read-only RPC calls", "unpinned prerequisite RPC", "missing prerequisite block pin",
              "RPC request too large", "invalid RPC batch", "non-cacheable HTTP failure", "non-cacheable RPC failure",
              "invalid RPC response", "incomplete RPC batch response", "duplicate RPC reply ID", "historical RPC result changed during capture"].includes(error.message)
              ? `: ${error.message}` : "";
            this.fault = new Error(error instanceof assert.AssertionError ? `prerequisite cache validation failed${safeReason}` :
              error instanceof Error && error.message.startsWith("prerequisite cache miss:") ? error.message : "prerequisite cache transport failed");
            this.onFault?.(this.fault);
          }
        }
        if (!response.destroyed) { response.statusCode = 502; response.end('{"error":"prerequisite cache failed"}'); }
      } finally {
        this.controllers.delete(controller); request.removeListener("aborted", abort); response.removeListener("close", abort);
      }
    })();
    this.active.add(work); void work.finally(() => this.active.delete(work));
  });
  private readonly secretPath = `/${randomUUID()}`;
  private constructor(private readonly upstreamUrl: string, mode: "record" | "replay", private readonly onFault?: (error: Error) => void) { this.phase = mode; }

  static async open(input: { upstreamUrl: string; mode: "record" | "replay"; directory: string; compatibility: unknown; onFault?: (error: Error) => void }) {
    const cache = new PrerequisiteCache(input.upstreamUrl, input.mode, input.onFault);
    let manifest: PrerequisiteManifest | undefined;
    if (input.mode === "replay") {
      manifest = JSON.parse(readFileSync(resolve(input.directory, "manifest.json"), "utf8"));
      assert(manifest?.schema === 1 && cacheJson(manifest.compatibility) === cacheJson(input.compatibility), "incompatible prerequisite cache");
      const bytes = readFileSync(resolve(input.directory, "rpc.json.gz"));
      assert.equal(cacheDigest(bytes), manifest.rpcSha256, "prerequisite cache content changed");
      const rows = JSON.parse(gunzipSync(bytes, { maxOutputLength: 1024 * 1024 * 1024 }).toString("utf8"));
      assert(Array.isArray(rows) && rows.length === manifest.entryCount, "invalid prerequisite entries");
      for (const [key, value] of rows) {
        const [method, params] = JSON.parse(key);
        assert.equal(requestKey(rpcRequest({ id: 1, method, params })), key);
        assert(!cache.entries.has(key), "duplicate prerequisite key");
        cache.entries.set(key, recordableReply(value));
      }
    } else {
      assert(!existsSync(input.directory), "prepare-cache must be a new directory");
      mkdirSync(input.directory, { recursive: true, mode: 0o700 });
    }
    await new Promise<void>((done, reject) => { cache.server.once("error", reject); cache.server.listen(0, "127.0.0.1", done); });
    const address = cache.server.address(); assert(address && typeof address === "object");
    return { cache, manifest, rpcUrl: `http://127.0.0.1:${address.port}${cache.secretPath}` };
  }
  setPhase(phase: CachePhase) { this.phase = phase; }
  assertHealthy() {
    if (this.fault) throw this.fault;
    assert.equal(this.unresolvedThrottles.size, 0, "prerequisite capture has unresolved throttled requests");
  }
  stats() { return { ...this.counts, entries: this.entries.size, phase: this.phase, fault: this.fault?.message ?? null,
    faultPhase: this.faultPhase ?? null, rpcFailure: this.rpcFailure ?? null, unresolvedThrottles: this.unresolvedThrottles.size }; }
  save(directory: string, metadata: Omit<PrerequisiteManifest, "schema" | "rpcSha256" | "entryCount">) {
    this.assertHealthy(); assert.equal(this.active.size, 0, "cache writes require a drained transport");
    const bytes = gzipSync(JSON.stringify([...this.entries].sort(([a], [b]) => a.localeCompare(b))));
    writeFileSync(resolve(directory, "rpc.json.gz"), bytes, { flag: "wx", mode: 0o600 });
    const manifest: PrerequisiteManifest = { schema: 1, ...metadata, entryCount: this.entries.size, rpcSha256: cacheDigest(bytes) };
    // Manifest is the commit marker. Interrupted/incomplete captures are never reusable.
    writeFileSync(resolve(directory, "manifest.json"), cacheJson(manifest), { flag: "wx", mode: 0o600 });
    return manifest;
  }
  async close() {
    for (const controller of this.controllers) controller.abort();
    this.server.closeAllConnections();
    await Promise.allSettled([...this.active]);
    await new Promise<void>(done => this.server.close(() => done()));
  }
}
