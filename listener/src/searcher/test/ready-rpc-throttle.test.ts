import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { ReadyRpcRateError, ReadyRpcThrottle } from "../ready-rpc-throttle.js";
import { RebuildReadProvider } from "../rebuild-read-provider.js";
import { RevmFatalError } from "../revm-sim-client.js";
import { createSourceCodeProviders } from "../source-code-cache.js";

const quiet = () => {};
const rate = () => new ReadyRpcRateError();

test("three physical responses per level; no upgrade, no premature stop at 1/1", () => {
  const control = new ReadyRpcThrottle(4, quiet);
  const levels = [[3, 8], [2, 8], [1, 8], [1, 4], [1, 2], [1, 1]];
  for (const [concurrency, batch] of levels) {
    for (let i = 0; i < 3; i++) control.observe(rate());
    assert.equal(control.concurrency, concurrency);
    assert.equal(control.batchMaxCount, batch);
    assert.equal(control.snapshot().responsesAtLevel, 0);
    assert.equal(control.snapshot().stopped, false);
  }
  control.observe(rate()); control.observe(rate());
  assert.equal(control.snapshot().stopped, false);
  assert.throws(() => control.observe(rate()), /persisted at concurrency=1 batch=1/);
  assert.equal(control.snapshot().responsesAtLevel, 3);
});

test("one propagated response is counted once; explicitly spent quota stops immediately", () => {
  const control = new ReadyRpcThrottle(4, quiet), one = rate();
  for (let i = 0; i < 5; i++) control.observe(one);
  assert.equal(control.snapshot().responsesAtLevel, 1);
  assert.equal(control.concurrency, 4);
  assert.throws(() => control.observe(new ReadyRpcRateError(true)), /allocation exhausted/);
  assert.throws(() => control.assertOpen(), /allocation exhausted/);
  const native = new ReadyRpcThrottle(4, quiet);
  assert.throws(() => native.observe(new RevmFatalError({ kind: "rpc-throttle", category: "rpc-quota-exhausted", rpcCode: 429 })), /allocation exhausted/);
});

test("a swallowed simulation throttle still fences its own candidate, not its siblings", async () => {
  const control = new ReadyRpcThrottle(4, quiet);
  await assert.rejects(control.attempt(async () => {
    const fail = control.captureFailure();
    fail({ kind: "rpc-throttle", category: "rpc-limit-code", rpcCode: 429 });
    return "incorrect acceptance";
  }), RevmFatalError);
  assert.equal(await control.attempt(async () => "healthy sibling"), "healthy sibling");
});

test("temporary failures requeue the same candidate; completion remains exact", async () => {
  const control = new ReadyRpcThrottle(4, quiet), attempts = new Map<number, number>(), completed: number[] = [];
  await control.runCandidates([0, 1, 2, 3, 4, 5], async candidate => {
    const count = (attempts.get(candidate) ?? 0) + 1; attempts.set(candidate, count);
    if (candidate === 0 && count <= 3) throw new RevmFatalError({ kind: "rpc-throttle", category: "rpc-limit-code", rpcCode: 429 });
    return candidate;
  }, value => completed.push(value));
  assert.deepEqual(completed.sort(), [0, 1, 2, 3, 4, 5]);
  assert.equal(attempts.get(0), 4);
  assert.equal(control.concurrency, 3);
});

test("lowest-level exhaustion never marks the throttled candidate completed", async () => {
  const control = new ReadyRpcThrottle(1, quiet), completed: number[] = [];
  let attempts = 0;
  await assert.rejects(control.runCandidates([1], async candidate => {
    attempts++; throw rate();
  }, value => completed.push(value)), /persisted/);
  assert.equal(attempts, 12);
  assert.deepEqual(completed, []);
});

test("an unowned latched simulator fatal stops source reads rather than looping on one response", async () => {
  const control = new ReadyRpcThrottle(4, quiet);
  const fatal = new RevmFatalError({ kind: "rpc-throttle", category: "http429", httpStatus: 429 });
  let reads = 0;
  await assert.rejects(control.read(async () => { reads++; throw fatal; }), error => error === fatal);
  assert.equal(reads, 1);
  assert.equal(control.snapshot().responsesAtLevel, 0);
});

type Rpc = { id: number; jsonrpc: string; method: string; params: unknown[] };
async function fixture(handler: (requests: Rpc[], attempt: number) => { status?: number; body: unknown }) {
  let attempts = 0;
  const sizes: number[] = [];
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as Rpc | Rpc[];
    const requests = Array.isArray(payload) ? payload : [payload]; sizes.push(requests.length);
    const answer = handler(requests, ++attempts);
    response.writeHead(answer.status ?? 200, { "content-type": "application/json" });
    const body = Array.isArray(answer.body) && !Array.isArray(payload) ? answer.body[0] : answer.body;
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert(address && typeof address !== "string");
  const control = new ReadyRpcThrottle(4, quiet);
  const provider = new RebuildReadProvider(async work => work(), `http://127.0.0.1:${address.port}`, 1,
    { staticNetwork: ethers.Network.from(1), cacheTimeout: -1, requestTimeoutMs: 2000, readyThrottle: control });
  return { control, provider, sizes, attempts: () => attempts, async close() {
    provider.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
const limited = (requests: Rpc[], message = "Your app has exceeded its compute units per second capacity") =>
  requests.map(request => ({ jsonrpc: "2.0", id: request.id, error: { code: 429, message } }));

test("real HTTP batches count once each and shrink 8->4->2->1 without losing reads", async () => {
  const f = await fixture((requests, attempt) => ({ body: attempt <= 18 ? limited(requests)
    : requests.map(request => ({ jsonrpc: "2.0", id: request.id, result: "0x6000" })).reverse() }));
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      f.provider.send("eth_getCode", [ethers.toBeHex(i + 1, 20), "0x7b"])));
    assert.deepEqual(results, Array(8).fill("0x6000"));
    assert.equal(f.control.concurrency, 1); assert.equal(f.control.batchMaxCount, 1);
    assert.equal(f.attempts(), 26);
    assert.deepEqual(f.sizes.slice(0, 18), [...Array(12).fill(8), ...Array(3).fill(4), ...Array(3).fill(2)]);
    assert(f.sizes.slice(18).every(size => size === 1));
  } finally { await f.close(); }
});

test("HTTP 429 transport attempts are not secretly multiplied by the ethers retry loop", async () => {
  const f = await fixture(requests => ({ status: 429, body: limited(requests) }));
  try {
    await assert.rejects(f.provider.send("eth_getCode", [ethers.toBeHex(1, 20), "0x7b"]), /persisted/);
    assert.equal(f.attempts(), 21);
  } finally { await f.close(); }
});

test("a shared physical batch fences every consumer even if each catches the rejected read", async () => {
  const f = await fixture((requests, attempt) => ({ body: attempt <= 3 ? limited(requests)
    : requests.map(request => ({ jsonrpc: "2.0", id: request.id, result: "0x6000" })) }));
  const healthy = new Set<number>(), completed: number[] = [];
  try {
    await f.control.runCandidates([0,1,2,3], async candidate => {
      try { await f.provider.getCode(ethers.toBeHex(candidate + 1, 20), 123); healthy.add(candidate); }
      catch { /* Match a lifecycle that converts a failed read into a result. */ }
      return candidate;
    }, candidate => {
      assert(healthy.has(candidate), "an unvalidated consumer cannot be marked completed");
      completed.push(candidate);
    });
    assert.deepEqual(completed.sort(), [0,1,2,3]);
    assert.equal(f.control.concurrency, 3);
    assert.equal(f.control.snapshot().responsesAtLevel, 0);
  } finally { await f.close(); }
});

test("explicit monthly exhaustion stops after one actual response", async () => {
  const f = await fixture(requests => ({ status: 429, body: limited(requests, "Monthly quota exhausted") }));
  try {
    await assert.rejects(f.provider.send("eth_getCode", [ethers.toBeHex(1, 20), "0x7b"]), /allocation exhausted/);
    assert.equal(f.attempts(), 1);
  } finally { await f.close(); }
});

test("unbound HTTP 429 quota text also stops after the first physical response", async () => {
  const f = await fixture(() => ({ status: 429, body: "Monthly quota exhausted" }));
  try {
    await assert.rejects(f.provider.send("eth_getCode", [ethers.toBeHex(1, 20), "0x7b"]), /allocation exhausted/);
    assert.equal(f.attempts(), 1);
  } finally { await f.close(); }
});

for (const status of [200, 429]) for (const message of ["Monthly request limit exceeded", "Daily request limit exceeded", "Credits exhausted"]) {
  test("spent allocation cannot complete a caught-error candidate: HTTP" + status + " " + message, async () => {
    const f = await fixture(requests => ({ status, body: requests.map(request => ({ jsonrpc: "2.0", id: request.id,
      error: { code: -32000, message } })) }));
    const completed: number[] = [];
    try {
      await assert.rejects(f.control.runCandidates([1], async candidate => {
        try { await f.provider.getCode(ethers.toBeHex(candidate, 20), 123); }
        catch { /* A Family must not turn spent quota into a rejection or success. */ }
        return candidate;
      }, value => completed.push(value)), /allocation exhausted/);
      assert.deepEqual(completed, []);
      assert.equal(f.attempts(), 1);
      assert.equal(f.control.snapshot().stopped, true);
    } finally { await f.close(); }
  });
}

test("shared cached code failures fence all consuming candidates, not only the cache creator", async () => {
  const f = await fixture((requests, attempt) => ({ body: attempt <= 3 ? limited(requests)
    : requests.map(request => ({ jsonrpc: "2.0", id: request.id, result: "0x6000" })) }));
  const code = createSourceCodeProviders(f.provider, () => f.control.assertOpen(), {
    onReadError(error) { if (error instanceof Error && f.control.isThrottle(error)) f.control.markFailure(error); },
  })({ number: 123, hash: "0x" + "11".repeat(32), generation: 1 });
  const healthy = new Set<number>(), completed: number[] = [];
  try {
    await f.control.runCandidates([0,1,2,3], async candidate => {
      try { await code.getCode(ethers.toBeHex(1, 20), 123); healthy.add(candidate); }
      catch { /* Family may swallow the shared cache rejection. */ }
      return candidate;
    }, candidate => { assert(healthy.has(candidate)); completed.push(candidate); });
    assert.deepEqual(completed.sort(), [0,1,2,3]);
    assert.equal(f.control.concurrency, 3);
    assert.equal(f.control.snapshot().responsesAtLevel, 0);
    assert.equal(f.attempts(), 4);
  } finally { await f.close(); }
});

test("wrong response IDs are not hidden by retrying an apparent 429", async () => {
  const f = await fixture(() => ({ body: [{ jsonrpc: "2.0", id: -1, error: { code: 429, message: "rate limit" } }] }));
  try {
    await assert.rejects(f.provider.send("eth_getCode", [ethers.toBeHex(1, 20), "0x7b"]), /identity mismatch/);
    assert.equal(f.attempts(), 1); assert.equal(f.control.snapshot().responsesAtLevel, 0);
  } finally { await f.close(); }
});

for (const status of [200, 429]) for (const code of [3, -32000]) test("contract revert text never spends the RPC downgrade budget: HTTP" + status + " RPC" + code, async () => {
  const f = await fixture(requests => ({ status, body: requests.map(request => ({ jsonrpc: "2.0", id: request.id,
    error: { code, message: "execution reverted: monthly quota exhausted 429", data: "0xdeadbeef" } })) }));
  try {
    await assert.rejects(f.provider.send("eth_call", [{ to: ethers.toBeHex(1, 20), data: "0x" }, "0x7b"]));
    assert.equal(f.attempts(), 1); assert.equal(f.control.snapshot().responsesAtLevel, 0);
    assert.equal(f.control.snapshot().stopped, false);
  } finally { await f.close(); }
});
