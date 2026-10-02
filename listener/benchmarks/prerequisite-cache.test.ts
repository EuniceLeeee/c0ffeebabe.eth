import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { PrerequisiteCache, type CachePhase, type PrerequisiteManifest } from "./prerequisite-cache.js";

// These fixtures use only disposable directories and real HTTP on 127.0.0.1.
// Import no runtime/config loaders: this suite must not read .env or contact an archive.
const address = `0x${"12".repeat(20)}`, blockHash = `0x${"ab".repeat(32)}`, block = "0x64";
const compatibility = { state: { number: 100, hash: blockHash, stateRoot: `0x${"cd".repeat(32)}` },
  config: { chainId: 1, concurrency: 2 }, universeSha256: "a".repeat(64) };
const metadata = { compatibility, producer: { sourceSha256: "b".repeat(64) },
  heads: { "100": { effectiveSha256: "c".repeat(64), candidatesSha256: "d".repeat(64) } } };
type Rpc = { jsonrpc: "2.0"; id: number | string; method: string; params: unknown[] };
type Body = Rpc | Rpc[];
type Response = { status: number; body: unknown };
type Responder = (body: Body, response: ServerResponse, number: number) => void;
const rpc = (id: Rpc["id"] = 1, method = "eth_call", params: unknown[] = [{ to: address, data: "0x1234" }, block]): Rpc =>
  ({ jsonrpc: "2.0", id, method, params });
const success = (call: Rpc, result: unknown) => ({ jsonrpc: "2.0", id: call.id, result });
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const send = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body));
};
const successful: Responder = (body, response, number) => {
  const replies = (Array.isArray(body) ? body : [body]).map(call => success(call, `0x${number}`));
  send(response, Array.isArray(body) ? replies : replies[0]);
};
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_done, reject) => {
    timer = setTimeout(() => reject(new Error("loopback operation did not drain within 3 seconds")), 3000);
  })]); } finally { clearTimeout(timer); }
}
function post(url: string, body: Body): Promise<Response> {
  assert.equal(new URL(url).hostname, "127.0.0.1");
  return new Promise((done, reject) => {
    const req = request(url, { method: "POST", agent: false, headers: { "content-type": "application/json" } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", part => chunks.push(part)); res.on("error", reject);
      res.on("end", () => {
        try { done({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("loopback request timeout")));
    req.end(JSON.stringify(body));
  });
}
async function fixture(t: TestContext, respond: Responder = successful) {
  const root = mkdtempSync(join(tmpdir(), "prerequisite-cache-test-")), directory = join(root, "cassette");
  const bodies: Body[] = [], caches = new Set<PrerequisiteCache>();
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(part);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
      bodies.push(body); respond(body, res, bodies.length);
    })().catch(error => res.destroy(error));
  });
  async function stopUpstream() {
    if (!server.listening) return;
    const closed = new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    server.closeAllConnections(); await bounded(closed);
  }
  async function close(cache: PrerequisiteCache) { await bounded(cache.close()); caches.delete(cache); }
  t.after(async () => {
    try { for (const cache of caches) await close(cache); }
    finally { try { await stopUpstream(); } finally { rmSync(root, { recursive: true, force: true }); } }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const socket = server.address(); assert(socket && typeof socket === "object");
  const upstreamUrl = `http://127.0.0.1:${socket.port}`;
  async function open(mode: "record" | "replay" = "record", expected: unknown = compatibility) {
    const opened = await PrerequisiteCache.open({ upstreamUrl, mode, directory, compatibility: expected });
    caches.add(opened.cache); return opened;
  }
  async function capture() {
    const opened = await open(); assert.equal((await post(opened.rpcUrl, rpc())).status, 200);
    const manifest = opened.cache.save(directory, metadata); await close(opened.cache); return manifest;
  }
  return { directory, bodies, open, close, capture, stopUpstream };
}

test("record -> compressed write -> replay rewrites IDs and batch order without an upstream", async t => {
  const f = await fixture(t, (body, response) => {
    assert(Array.isArray(body));
    send(response, body.map(call => success(call, call.method === "eth_call" ? "0xbeef" : "0x6000")).reverse());
  });
  const recorded = await f.open();
  const calls = [rpc(1), rpc("1", "eth_getCode", [address, block])]; // Numeric and string IDs are distinct.
  assert.deepEqual(await post(recorded.rpcUrl, calls), { status: 200,
    body: [success(calls[1]!, "0x6000"), success(calls[0]!, "0xbeef")] });
  const manifest = recorded.cache.save(f.directory, metadata);
  const bytes = readFileSync(join(f.directory, "rpc.json.gz"));
  assert.equal(bytes.subarray(0, 2).toString("hex"), "1f8b");
  assert.equal(manifest.rpcSha256, digest(bytes)); assert.equal(manifest.entryCount, 2);
  assert.equal(JSON.parse(gunzipSync(bytes).toString()).length, 2);
  await f.close(recorded.cache); await f.stopUpstream();
  const replay = await f.open("replay"); assert.deepEqual(replay.manifest, manifest);
  const reordered = [rpc("new-code", "eth_getCode", [address, block]),
    rpc(88, "eth_call", [{ data: "0x1234", to: address }, block]), rpc(89)];
  assert.deepEqual(await post(replay.rpcUrl, reordered), { status: 200,
    body: [success(reordered[0]!, "0x6000"), success(reordered[1]!, "0xbeef"), success(reordered[2]!, "0xbeef")] });
  assert.deepEqual(await post(replay.rpcUrl, rpc("single")), { status: 200, body: success(rpc("single"), "0xbeef") });
  assert.equal(f.bodies.length, 1); assert.equal(replay.cache.stats().replayed, 4);
  replay.cache.assertHealthy();
});

test("measured calls always forward, including exact cache hits, and never replace or add entries", async t => {
  const f = await fixture(t); await f.capture(); const replay = await f.open("replay");
  const same = rpc(); replay.cache.setPhase("measured");
  for (const result of ["0x2", "0x3"])
    assert.deepEqual(await post(replay.rpcUrl, same), { status: 200, body: success(same, result) });
  const measuredOnly = rpc(2, "eth_getBalance", [address, block]);
  assert.equal((await post(replay.rpcUrl, measuredOnly)).status, 200);
  const moving = rpc(3, "eth_call", [{ to: address }, "latest"]);
  assert.equal((await post(replay.rpcUrl, moving)).status, 200, "measured reads do not use prerequisite pin policy");
  assert.equal(replay.cache.stats().entries, 1); assert.equal(replay.cache.stats().measured, 4);
  replay.cache.setPhase("replay");
  assert.deepEqual(await post(replay.rpcUrl, same), { status: 200, body: success(same, "0x1") });
  assert.equal((await post(replay.rpcUrl, measuredOnly)).status, 502);
  assert.equal(f.bodies.length, 5, "replay miss must not call upstream");
  assert.equal(JSON.parse(gunzipSync(readFileSync(join(f.directory, "rpc.json.gz"))).toString()).length, 1);
});

test("replay miss fails closed and health stays failed after hits and phase changes", async t => {
  const f = await fixture(t); await f.capture(); const replay = await f.open("replay");
  const missing = rpc(2, "eth_call", [{ to: address, data: "0x5678" }, block]);
  assert.equal((await post(replay.rpcUrl, [rpc(), missing])).status, 502);
  assert.equal(f.bodies.length, 1); assert.equal(replay.cache.stats().misses, 1);
  assert.throws(() => replay.cache.assertHealthy(), /prerequisite cache miss: eth_call/);
  assert.equal((await post(replay.rpcUrl, rpc(3))).status, 200);
  replay.cache.setPhase("measured"); assert.equal((await post(replay.rpcUrl, missing)).status, 200);
  replay.cache.setPhase("replay");
  assert.throws(() => replay.cache.assertHealthy(), /prerequisite cache miss: eth_call/);
  assert.throws(() => replay.cache.save(f.directory, metadata), /prerequisite cache miss/);
});

for (const [name, change] of [
  ["state block hash", () => ({ ...compatibility, state: { ...compatibility.state, hash: `0x${"ef".repeat(32)}` } })],
  ["state root", () => ({ ...compatibility, state: { ...compatibility.state, stateRoot: `0x${"ef".repeat(32)}` } })],
  ["configuration", () => ({ ...compatibility, config: { ...compatibility.config, concurrency: 9 } })],
  ["input universe", () => ({ ...compatibility, universeSha256: "e".repeat(64) })],
] as const) test(`rejects cache with changed ${name}`, async t => {
  const f = await fixture(t); await f.capture();
  await assert.rejects(f.open("replay", change()), /incompatible prerequisite cache/);
  assert.equal(f.bodies.length, 1);
});

type Mutation = (directory: string, manifest: PrerequisiteManifest) => void;
function rewriteRows(directory: string, manifest: PrerequisiteManifest, change: (rows: [string, unknown][]) => void) {
  const path = join(directory, "rpc.json.gz");
  const rows = JSON.parse(gunzipSync(readFileSync(path)).toString()) as [string, unknown][];
  change(rows); const bytes = gzipSync(JSON.stringify(rows)); writeFileSync(path, bytes);
  manifest.entryCount = rows.length; manifest.rpcSha256 = digest(bytes);
}
const corruptions: [string, Mutation][] = [
  ["compressed bytes changed", directory => {
    const path = join(directory, "rpc.json.gz"), bytes = readFileSync(path); bytes[bytes.length - 1]! ^= 1; writeFileSync(path, bytes);
  }],
  ["manifest content hash changed", (_directory, manifest) => { manifest.rpcSha256 = "0".repeat(64); }],
  ["manifest state tampered", (_directory, manifest) => { manifest.compatibility = { ...compatibility, state: null }; }],
  ["manifest config tampered", (_directory, manifest) => { manifest.compatibility = { ...compatibility, config: {} }; }],
  ["entry count incomplete", (_directory, manifest) => { manifest.entryCount++; }],
  ["unsupported schema", (_directory, manifest) => { Object.assign(manifest, { schema: 2 }); }],
  ["truncated gzip with matching checksum", (directory, manifest) => {
    const path = join(directory, "rpc.json.gz"), bytes = readFileSync(path).subarray(0, 12);
    writeFileSync(path, bytes); manifest.rpcSha256 = digest(bytes);
  }],
  ["duplicate entries with matching checksum", (directory, manifest) => rewriteRows(directory, manifest, rows => { rows.push(rows[0]!); })],
  ["unpinned entry with matching checksum", (directory, manifest) => rewriteRows(directory, manifest, rows => {
    rows[0]![0] = JSON.stringify(["eth_call", [{ to: address, data: "0x1234" }, "latest"]]);
  })],
  ["transient error entry with matching checksum", (directory, manifest) => rewriteRows(directory, manifest, rows => {
    rows[0]![1] = { error: { code: -32005, message: "rate limited" } };
  })],
];
for (const [name, change] of corruptions) test(`rejects cache corruption: ${name}`, async t => {
  const f = await fixture(t), manifest = await f.capture(); change(f.directory, manifest);
  writeFileSync(join(f.directory, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(f.open("replay")); assert.equal(f.bodies.length, 1);
});
for (const filename of ["manifest.json", "rpc.json.gz"]) test(`incomplete cache without ${filename} cannot replay`, async t => {
  const f = await fixture(t); await f.capture(); rmSync(join(f.directory, filename));
  await assert.rejects(f.open("replay")); assert.equal(f.bodies.length, 1);
});

const unpinned: [string, string, unknown[]][] = [
  ...["latest", "pending", "safe", "finalized"].map(tag => [tag, "eth_call", [{ to: address }, tag]] as [string, string, unknown[]]),
  ["missing call block", "eth_call", [{ to: address }]],
  ["missing storage block", "eth_getStorageAt", [address, "0x0"]],
  ["missing simulation block", "eth_simulateV1", [{ blockStateCalls: [] }]],
  ["null call block", "eth_call", [{ to: address }, null]],
  ["empty EIP-1898 selector", "eth_call", [{ to: address }, {}]],
  ["logs with no range", "eth_getLogs", [{ address }]],
  ["logs without toBlock", "eth_getLogs", [{ address, fromBlock: block }]],
  ["logs without fromBlock", "eth_getLogs", [{ address, toBlock: block }]],
  ["missing header block", "eth_getBlockByNumber", []],
  ["missing trace block", "debug_traceBlockByNumber", []],
];
for (const [name, method, params] of unpinned) test(`rejects unpinned prerequisite before forwarding: ${name}`, async t => {
  const f = await fixture(t), opened = await f.open();
  assert.equal((await post(opened.rpcUrl, rpc(1, method, params))).status, 502);
  assert.equal(f.bodies.length, 0); assert.equal(opened.cache.stats().entries, 0);
  assert.throws(() => opened.cache.assertHealthy());
  assert.throws(() => opened.cache.save(f.directory, metadata));
});

test("explicit block numbers, EIP-1898 hashes and bounded log filters survive replay", async t => {
  const f = await fixture(t), recorded = await f.open();
  const calls = [rpc(), rpc(2, "eth_call", [{ to: address }, { blockHash, requireCanonical: true }]),
    rpc(3, "eth_getLogs", [{ address, fromBlock: "0x63", toBlock: block }]),
    rpc(4, "eth_getLogs", [{ address, blockHash }]), rpc(5, "eth_getStorageAt", [address, "0x0", block])];
  assert.equal((await post(recorded.rpcUrl, calls)).status, 200);
  recorded.cache.save(f.directory, metadata); await f.close(recorded.cache);
  const replay = await f.open("replay"); assert.equal((await post(replay.rpcUrl, calls)).status, 200);
  assert.equal(f.bodies.length, 1); replay.cache.assertHealthy();
});

for (const phase of ["record", "replay", "measured"] as const) test(`blocks signing/broadcast in ${phase}, including mixed batches`, async t => {
  const f = await fixture(t), opened = await f.open(); opened.cache.setPhase(phase);
  for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "eth_signTransaction",
    "personal_sign", "eth_signTypedData_v4", "eth_sendBundle", "mev_sendBundle", "wallet_sendCalls"])
    assert.equal((await post(opened.rpcUrl, [rpc(), rpc(2, method, [])])).status, 502, method);
  assert.equal(f.bodies.length, 0); assert.equal(opened.cache.stats().entries, 0);
  assert.throws(() => opened.cache.assertHealthy());
});

for (const code of [3, -32000]) test(`deterministic revert ${code} preserves its code and data across replay`, async t => {
  const error = { code, message: "execution reverted", data: "0x08c379a0" };
  const f = await fixture(t, (body, response) => { assert(!Array.isArray(body)); send(response, { jsonrpc: "2.0", id: body.id, error }); });
  const captured = await f.open();
  assert.deepEqual(await post(captured.rpcUrl, rpc()), { status: 200, body: { jsonrpc: "2.0", id: 1, error } });
  captured.cache.save(f.directory, metadata); await f.close(captured.cache); await f.stopUpstream();
  const replay = await f.open("replay");
  assert.deepEqual(await post(replay.rpcUrl, rpc("new-id")), { status: 200, body: { jsonrpc: "2.0", id: "new-id", error } });
  replay.cache.assertHealthy();
});

test("a deterministic revert without data preserves its only reason string", async t => {
  const error = { code: 3, message: "execution reverted: fixture guard not satisfied" };
  const f = await fixture(t, (body, response) => { assert(!Array.isArray(body)); send(response, { jsonrpc: "2.0", id: body.id, error }); });
  await f.capture(); const replay = await f.open("replay");
  assert.deepEqual(await post(replay.rpcUrl, rpc(2)), { status: 200, body: { jsonrpc: "2.0", id: 2, error } });
});

const transientFailures: [string, Responder][] = [
  ["HTTP throttle", (_body, response) => send(response, { error: "rate limited" }, 429)],
  ["HTTP failure even with valid JSON-RPC result", (body, response) => send(response, success(body as Rpc, "0x0"), 503)],
  ["provider timeout", (body, response) => send(response, { jsonrpc: "2.0", id: (body as Rpc).id, error: { code: -32000, message: "request timed out" } })],
  ["network disconnect", (_body, response) => response.destroy()],
  ["non-JSON response", (_body, response) => response.end("not JSON")],
];
for (const [name, fail] of transientFailures) test(`does not reuse ${name}; a later success cannot clear failed health`, async t => {
  const f = await fixture(t, (body, response, number) => number === 1 ? fail(body, response, number) : successful(body, response, number));
  const opened = await f.open(); assert.equal((await post(opened.rpcUrl, rpc())).status, 502);
  assert.equal(opened.cache.stats().entries, 0); assert.throws(() => opened.cache.assertHealthy());
  assert.equal((await post(opened.rpcUrl, rpc(2))).status, 200, "same request retries upstream, never a failed fixture");
  assert.equal(f.bodies.length, 2); assert.throws(() => opened.cache.assertHealthy());
  assert.throws(() => opened.cache.save(f.directory, metadata));
  assert.equal(existsSync(join(f.directory, "manifest.json")), false);
});

for (const error of [
  { code: 429, message: "rate limited: compute units per second capacity" },
  { code: -32005, message: "rate limited: compute units per second capacity" },
  { code: -32005, message: "Too many requests" },
]) test(`RPC throttle ${error.code}/${error.message} passes to live retries, not to the reusable cache`, async t => {
  const f = await fixture(t, (body, response, number) => {
    assert(!Array.isArray(body));
    send(response, number === 1 ? { jsonrpc: "2.0", id: body.id, error } : success(body, "0x1234"));
  });
  const recorded = await f.open();
  assert.deepEqual(await post(recorded.rpcUrl, rpc()), { status: 200, body: { jsonrpc: "2.0", id: 1, error } });
  assert.equal(f.bodies.length, 1, "proxy must not add its own retry scheduler");
  assert.equal(recorded.cache.stats().entries, 0);
  assert.equal(recorded.cache.stats().throttled, 1);
  assert.throws(() => recorded.cache.save(f.directory, metadata), /unresolved throttled/);
  assert(!existsSync(join(f.directory, "manifest.json")));
  assert.deepEqual(await post(recorded.rpcUrl, rpc(2)), { status: 200, body: success(rpc(2), "0x1234") });
  recorded.cache.assertHealthy();
  assert.equal(recorded.cache.stats().unresolvedThrottles, 0);
  recorded.cache.save(f.directory, metadata); await f.close(recorded.cache); await f.stopUpstream();
  const replay = await f.open("replay");
  assert.deepEqual(await post(replay.rpcUrl, rpc(3)), { status: 200, body: success(rpc(3), "0x1234") });
  assert.equal(f.bodies.length, 2);
});

test("provider diagnostic object keys and values never enter saved cache statistics", async t => {
  const secret = "https://provider.invalid/v2/fixture-secret-key";
  const f = await fixture(t, (body, response) => {
    assert(!Array.isArray(body));
    send(response, { jsonrpc: "2.0", id: body.id,
      error: { code: 429, message: `Too many requests: ${secret}`, data: { [secret]: secret } } });
  });
  const recorded = await f.open();
  assert.equal((await post(recorded.rpcUrl, rpc())).status, 200);
  const stats = recorded.cache.stats();
  assert.equal(stats.rpcFailure?.dataKeyCount, 1);
  assert(!JSON.stringify(stats).includes("fixture-secret-key"));
  assert(!JSON.stringify(stats).includes("provider.invalid"));
});

test("a measured success cannot repair an uncaptured prerequisite throttle", async t => {
  const f = await fixture(t, (body, response, number) => {
    assert(!Array.isArray(body));
    send(response, number === 1 ? { jsonrpc: "2.0", id: body.id, error: { code: 429, message: "rate limited" } } : success(body, "0x1"));
  });
  const recorded = await f.open(); await post(recorded.rpcUrl, rpc());
  recorded.cache.setPhase("measured"); await post(recorded.rpcUrl, rpc(2));
  assert.equal(recorded.cache.stats().entries, 0);
  assert.throws(() => recorded.cache.save(f.directory, metadata), /unresolved throttled/);
});

for (const name of ["missing reply", "duplicate reply ID", "unknown reply ID"] as const)
  test(`malformed upstream batch fails closed: ${name}`, async t => {
    const f = await fixture(t, (body, response) => {
      assert(Array.isArray(body)); const first = success(body[0]!, "0x1"), second = success(body[1]!, "0x2");
      send(response, name === "missing reply" ? [first] : [first, { ...second, id: name === "duplicate reply ID" ? first.id : 99 }]);
    });
    const opened = await f.open();
    assert.equal((await post(opened.rpcUrl, [rpc(1), rpc(2, "eth_getCode", [address, block])])).status, 502);
    assert.throws(() => opened.cache.assertHealthy()); assert.throws(() => opened.cache.save(f.directory, metadata));
    assert.equal(existsSync(join(f.directory, "manifest.json")), false);
  });

test("inconsistent historical results cannot produce a reusable capture", async t => {
  const f = await fixture(t), opened = await f.open();
  assert.equal((await post(opened.rpcUrl, rpc())).status, 200);
  assert.equal((await post(opened.rpcUrl, rpc(2))).status, 502);
  assert.throws(() => opened.cache.assertHealthy()); assert.throws(() => opened.cache.save(f.directory, metadata));
});

for (const [start, finish, entries] of [["record", "measured", 1], ["measured", "record", 0]] as const)
  test(`in-flight ${start} request retains its phase after switching to ${finish}`, async t => {
    const seen = latch(); let pending!: ServerResponse;
    const f = await fixture(t, (_body, response) => { pending = response; seen.resolve(); });
    const opened = await f.open(); opened.cache.setPhase(start);
    const reply = post(opened.rpcUrl, rpc()); await bounded(seen.promise);
    opened.cache.setPhase(finish); send(pending, success(rpc(), "0xcafe"));
    assert.equal((await reply).status, 200); assert.equal(opened.cache.stats().entries, entries);
    assert.equal(opened.cache.stats().measured, start === "measured" ? 1 : 0);
    opened.cache.setPhase("replay");
    assert.equal((await post(opened.rpcUrl, rpc(2))).status, entries ? 200 : 502);
    assert.equal(f.bodies.length, 1);
  });

test("save requires drained requests and successful close releases the listening socket", async t => {
  const seen = latch(); let pending!: ServerResponse;
  const f = await fixture(t, (_body, response) => { pending = response; seen.resolve(); });
  const opened = await f.open(), reply = post(opened.rpcUrl, rpc()); await bounded(seen.promise);
  assert.throws(() => opened.cache.save(f.directory, metadata), /drained transport/);
  assert.equal(existsSync(join(f.directory, "manifest.json")), false);
  send(pending, success(rpc(), "0xcafe")); assert.equal((await reply).status, 200);
  opened.cache.save(f.directory, metadata); await f.close(opened.cache);
  await bounded(opened.cache.close()); // Shutdown is safe to repeat.
  await assert.rejects(post(opened.rpcUrl, rpc()), (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED");
});

for (const phase of ["record", "measured"] satisfies CachePhase[]) test(`close aborts/drains in-flight ${phase} work and releases both transports`, async t => {
  const seen = latch(), upstreamClosed = latch();
  const f = await fixture(t, (_body, response) => { response.once("close", upstreamClosed.resolve); seen.resolve(); });
  const opened = await f.open(); opened.cache.setPhase(phase);
  const outcome = post(opened.rpcUrl, rpc()).then(value => value, error => error as Error);
  await bounded(seen.promise); await f.close(opened.cache); await bounded(upstreamClosed.promise);
  const result = await bounded(outcome); assert(result instanceof Error || result.status === 502);
  assert.equal(opened.cache.stats().entries, 0);
  if (phase === "record") assert.throws(() => opened.cache.assertHealthy());
  else opened.cache.assertHealthy();
  await assert.rejects(post(opened.rpcUrl, rpc()), (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED");
});
