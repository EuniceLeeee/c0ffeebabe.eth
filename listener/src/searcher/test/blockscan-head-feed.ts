import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { startBlockScanHeadFeed, type BlockScanHeadFeedOptions, type BlockScanHeadFeedStatus } from "../blockscan-head-feed.js";

const HASH = "0x" + "ab".repeat(32);
const OTHER_HASH = "0x" + "cd".repeat(32);
const URL = "wss://head-feed.invalid/private-test-token";

class FakeSocket extends EventTarget {
  sent: string[] = [];
  closeCalls = 0;
  throwOnSend = false;
  throwOnClose = false;
  open(): void { this.dispatchEvent(new Event("open")); }
  message(value: unknown): void { this.raw(JSON.stringify(value)); }
  raw(data: unknown): void { this.dispatchEvent(new MessageEvent("message", { data })); }
  ack(subscription = "test-subscription"): void { this.message({ jsonrpc: "2.0", id: 1, result: subscription }); }
  head(number: unknown = "0x10", hash: unknown = HASH, subscription = "test-subscription"): void {
    this.message({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription, result: { number, hash } } });
  }
  send(data: string): void {
    if (this.throwOnSend) throw new Error(URL);
    this.sent.push(data);
  }
  close(): void {
    this.closeCalls++;
    this.dispatchEvent(new Event("close")); // Exercise synchronous/reentrant close events, too.
    if (this.throwOnClose) throw new Error(URL);
  }
}

// No network or wall-clock waits: replace only the global WebSocket and timeout pair.
function harness(t: TestContext, callbacks: Partial<BlockScanHeadFeedOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const heads: Array<[number, string]> = [];
  const statuses: BlockScanHeadFeedStatus[] = [];
  const controller = new AbortController();
  let failCreate = false;
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: class {
    constructor(url: string) {
      assert.equal(url, URL);
      if (failCreate) throw new Error(URL);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }
  } });
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, delay: number) => {
    const id = ++timerId;
    timers.set(id, { at: now + delay, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  t.mock.method(globalThis, "clearTimeout", ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number);
  }) as typeof clearTimeout);
  let feed: ReturnType<typeof startBlockScanHeadFeed> | undefined;
  t.after(() => {
    feed?.close();
    if (webSocketDescriptor) Object.defineProperty(globalThis, "WebSocket", webSocketDescriptor);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  });
  return {
    sockets, heads, statuses, controller, timers,
    start() {
      feed = startBlockScanHeadFeed({ url: URL, signal: controller.signal,
        onHead: (number, hash) => { heads.push([number, hash]); },
        onStatus: status => { statuses.push(status); }, ...callbacks });
      return feed;
    },
    failCreate(value: boolean) { failCreate = value; },
    tick(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = target;
    },
  };
}

test("returns immediately, subscribes once on open and forwards only its acknowledged subscription", t => {
  const h = harness(t);
  const feed = h.start();
  assert.equal(typeof feed.close, "function");
  const ws = h.sockets[0]!;
  assert.deepEqual(ws.sent, []);
  ws.ack(); // A response before sending a request is not a handshake.
  ws.head();
  ws.open();
  ws.open();
  assert.deepEqual(ws.sent.map(s => JSON.parse(s)), [{ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }]);
  ws.head();
  ws.message({ jsonrpc: "2.0", id: 2, result: "other-subscription" });
  ws.head("0x10", HASH, "other-subscription");
  assert.deepEqual(h.heads, []);
  ws.ack();
  ws.head("0x10", HASH, "other-subscription");
  ws.head("0x10", HASH.toUpperCase().replace("0X", "0x"));
  assert.deepEqual(h.heads, [[16, HASH]]);
  assert.deepEqual(h.statuses, ["connecting", "subscribed"]);
  assert.equal(h.timers.size, 0);
});

test("rejects malformed envelopes, unsafe/non-positive heights and non-32-byte hashes", t => {
  const h = harness(t); h.start();
  const ws = h.sockets[0]!; ws.open(); ws.ack();
  for (const data of ["{", "null", "[]", "1", '"string"', new Uint8Array([1, 2])]) ws.raw(data);
  for (const params of [null, [], {}, { result: {} }, { subscription: "test-subscription", result: [] }]) {
    ws.message({ jsonrpc: "2.0", method: "eth_subscription", params });
  }
  for (const number of [undefined, null, 16, 0, "", "16", "0x", "0x0", "0x00", "0x01", "-0x1", "0x1g",
    "0x1.2", "0x20000000000000", "0x20000000000001", "0x" + "f".repeat(100)]) {
    ws.message({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "test-subscription", result: { number, hash: HASH } } });
  }
  for (const hash of [undefined, null, 1, "", "ab".repeat(32), "0x" + "ab".repeat(31), HASH + "00", "0x" + "gg".repeat(32)]) {
    // Explicit undefined bypasses the helper's default argument.
    ws.message({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "test-subscription", result: { number: "0x10", hash } } });
  }
  ws.message({ jsonrpc: "1.0", method: "eth_subscription", params: { subscription: "test-subscription", result: { number: "0x10", hash: HASH } } });
  ws.message({ jsonrpc: "2.0", method: "wrong-method", params: { subscription: "test-subscription", result: { number: "0x10", hash: HASH } } });
  assert.deepEqual(h.heads, []);
  ws.head("0x1"); ws.head("0x1fffffffffffff");
  assert.deepEqual(h.heads, [[1, HASH], [Number.MAX_SAFE_INTEGER, HASH]]);
});

test("does not cache/filter duplicates, same-height replacements or lower heads", t => {
  const h = harness(t); h.start();
  const ws = h.sockets[0]!; ws.open(); ws.ack();
  ws.head("0x10"); ws.head("0x10"); ws.head("0x10", OTHER_HASH); ws.head("0xf");
  assert.deepEqual(h.heads, [[16, HASH], [16, HASH], [16, OTHER_HASH], [15, HASH]]);
});

for (const phase of ["opening", "acknowledging"] as const) {
  test(`handshake has one bounded timeout while ${phase}`, t => {
    const h = harness(t); h.start();
    const old = h.sockets[0]!;
    h.tick(5_000);
    if (phase === "acknowledging") old.open();
    h.tick(4_999);
    assert.equal(old.closeCalls, 0);
    h.tick(1);
    assert.equal(old.closeCalls, 1);
    assert.deepEqual(h.statuses, ["connecting", "reconnecting"]);
    assert.equal(h.timers.size, 1);
    h.tick(999); assert.equal(h.sockets.length, 1);
    h.tick(1); assert.equal(h.sockets.length, 2);
    old.open(); old.ack(); old.head(); old.dispatchEvent(new Event("error")); old.close();
    assert.deepEqual(h.heads, []);
    assert.equal(h.timers.size, 1, "old events must not replace the new handshake timer");
    const current = h.sockets[1]!; current.open(); current.ack(); current.head();
    assert.deepEqual(h.heads, [[16, HASH]]);
    h.tick(60_000); assert.equal(h.sockets.length, 2);
  });
}

test("errors/close schedule one capped exponential reconnect, reset only after acknowledgement", t => {
  const h = harness(t); h.start();
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const ws = h.sockets.at(-1)!;
    ws.open(); // Opening alone must not reset repeated subscription failures.
    ws.dispatchEvent(new Event("error"));
    ws.dispatchEvent(new Event("close"));
    ws.dispatchEvent(new Event("error"));
    assert.equal(ws.closeCalls, 1);
    const count = h.sockets.length;
    assert.equal(h.timers.size, 1);
    h.tick(delay - 1); assert.equal(h.sockets.length, count);
    h.tick(1); assert.equal(h.sockets.length, count + 1);
  }
  const healthy = h.sockets.at(-1)!; healthy.open(); healthy.ack();
  healthy.dispatchEvent(new Event("close"));
  const count = h.sockets.length;
  h.tick(999); assert.equal(h.sockets.length, count);
  h.tick(1); assert.equal(h.sockets.length, count + 1);
});

test("already-queued old socket events and timeout cannot affect the replacement connection", t => {
  const add = t.mock.method(FakeSocket.prototype, "addEventListener");
  const h = harness(t); h.start();
  const old = h.sockets[0]!;
  const handlers = add.mock.calls.map(call => call.arguments);
  const oldTimeout = [...h.timers.values()][0]!.callback;
  old.open(); old.ack(); old.dispatchEvent(new Event("error"));
  h.tick(1_000);
  const current = h.sockets[1]!; current.open(); current.ack();
  for (const [type, handler] of handlers) {
    const event = type === "message"
      ? new MessageEvent("message", { data: JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription",
        params: { subscription: "test-subscription", result: { number: "0x10", hash: HASH } } }) })
      : new Event(type);
    if (typeof handler === "function") handler.call(old, event);
    else handler?.handleEvent(event);
  }
  oldTimeout();
  assert.deepEqual(h.heads, []);
  assert.equal(h.timers.size, 0);
  assert.equal(current.closeCalls, 0);
  assert.equal(old.sent.length, 1);
  current.head();
  assert.deepEqual(h.heads, [[16, HASH]]);
});

test("constructor, send, close and rejected subscription failures stay sanitized and recover", t => {
  const h = harness(t); h.failCreate(true);
  assert.doesNotThrow(() => h.start());
  assert.deepEqual(h.statuses, ["connecting", "reconnecting"]);
  h.failCreate(false); h.tick(1_000);
  const sendFailure = h.sockets[0]!; sendFailure.throwOnSend = true; sendFailure.throwOnClose = true;
  assert.doesNotThrow(() => sendFailure.open());
  h.tick(2_000);
  const rejected = h.sockets[1]!; rejected.open();
  rejected.message({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: URL } });
  h.tick(4_000);
  const malformed = h.sockets[2]!; malformed.open(); malformed.message({ jsonrpc: "2.0", id: 1, result: "" });
  h.tick(8_000);
  const recovered = h.sockets[3]!; recovered.open(); recovered.ack(); recovered.head();
  assert.deepEqual(h.heads, [[16, HASH]]);
  assert(h.statuses.every(status => ["connecting", "reconnecting", "subscribed"].includes(status)));
  assert(!JSON.stringify(h.statuses).includes(URL));
});

for (const phase of ["before-start", "connecting", "subscribed", "reconnecting"] as const) {
  test(`abort at ${phase} cancels all sockets/timers and is terminal`, t => {
    const h = harness(t);
    if (phase === "before-start") h.controller.abort();
    const feed = h.start();
    const ws = h.sockets[0];
    if (phase === "subscribed") { ws!.open(); ws!.ack(); }
    if (phase === "reconnecting") ws!.dispatchEvent(new Event("error"));
    h.controller.abort(); feed.close(); h.controller.abort();
    assert.equal(h.timers.size, 0);
    const count = h.sockets.length;
    ws?.open(); ws?.ack(); ws?.head(); ws?.dispatchEvent(new Event("error"));
    h.tick(120_000);
    assert.equal(h.sockets.length, count);
    assert.deepEqual(h.heads, []);
    assert.equal(h.statuses.filter(s => s === "closed").length, 1);
    assert.equal(ws?.closeCalls ?? 0, phase === "before-start" ? 0 : 1);
  });
}

test("explicit close works without abort and detaches the abort listener", t => {
  const h = harness(t);
  const add = t.mock.method(h.controller.signal, "addEventListener");
  const remove = t.mock.method(h.controller.signal, "removeEventListener");
  const feed = h.start();
  const ws = h.sockets[0]!; ws.open(); ws.ack();
  feed.close(); feed.close(); h.controller.abort(); h.tick(120_000);
  assert.equal(add.mock.callCount(), 1);
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(h.timers.size, 0);
  assert.equal(ws.closeCalls, 1);
  assert.equal(h.sockets.length, 1);
});

test("consumer throws/rejections do not escape, reconnect or leak error details", async t => {
  let attempts = 0;
  const h = harness(t, {
    onHead: () => { attempts++; if (attempts === 1) throw new Error(URL); return Promise.reject(new Error(URL)); },
    onStatus: status => { if (status === "connecting") throw new Error(URL); return Promise.reject(new Error(URL)); },
  });
  assert.doesNotThrow(() => h.start());
  const ws = h.sockets[0]!; ws.open(); ws.ack(); ws.head(); ws.head();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.timers.size, 0);
  h.controller.abort();
  await new Promise<void>(resolve => setImmediate(resolve));
});

for (const phase of ["connecting", "subscribed", "reconnecting"] as const) {
  test(`reentrant abort from ${phase} status leaves no resources`, t => {
    const controller = new AbortController();
    const h = harness(t, { signal: controller.signal, onStatus: status => { if (status === phase) controller.abort(); } });
    h.start();
    if (phase === "subscribed") { h.sockets[0]!.open(); h.sockets[0]!.ack(); }
    if (phase === "reconnecting") h.sockets[0]!.dispatchEvent(new Event("error"));
    assert.equal(h.timers.size, 0);
    const count = h.sockets.length; h.tick(120_000); assert.equal(h.sockets.length, count);
    assert(h.sockets.every(ws => ws.closeCalls === 1));
  });
}
