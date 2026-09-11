import assert from "node:assert/strict";
import { guardRpcThrottle, isRpcQuotaExhaustedError, isRpcThrottleError } from "../rpc-throttle-guard.js";

const throttleFailures = [
  new Error("HTTP 429 Too Many Requests"),
  { code: 429 },
  { status: 429 },
  { statusCode: 429 },
  // Explicit transport status still wins over body text, without reinterpreting
  // a typed contract revert (covered separately below) as a transport error.
  { code: 429, message: "execution reverted" },
  { status: 429, message: "execution reverted" },
  { statusCode: 429, message: "execution reverted" },
  { statusCode: 429, message: "execution reverted: account quota exhausted" },
  new Error("rate limit reached"),
  new Error("throughput capacity exceeded"),
  new Error("compute units exceeded throughput limit"),
  { code: -32005, message: "quota limit exceeded" },
  { code: -32000, message: "account quota exhausted" },
  { code: -32000, message: "compute units depleted" },
  { code: -32005, message: "account quota exhausted" },
  new Error("account quota exhaustion"),
  new Error("account quota depleted"),
  new Error("account quota depletion"),
  new Error("compute unit exhausted"),
  new Error("compute unit depletion"),
  new Error("compute-unit exhausted"),
  new Error("compute-unit depletion"),
  new Error("compute-units exhaustion"),
  new Error("COMPUTE-UNITS HAVE BEEN DEPLETED"),
];
for (const inner of throttleFailures) {
  for (const failure of [inner, new Error("outer transport failure", { cause: inner }),
    new Error("execution reverted", { cause: inner }),
    new Error("execution reverted: quota exhausted", {
      cause: new Error("execution reverted", { cause: inner }),
    })]) {
    assert.equal(isRpcThrottleError(failure), true, `missed throttle: ${JSON.stringify(inner)}`);
    let calls = 0, stops = 0;
    const guarded = guardRpcThrottle({ call: async () => { calls++; throw failure; } }, () => { stops++; });
    await assert.rejects(guarded.call({ to: "0x1", data: "0x" }), error => error === failure);
    // Retried callers after the observed failure never reach physical dispatch.
    await Promise.all(Array.from({ length: 32 }, () =>
      assert.rejects(guarded.call({ to: "0x1", data: "0x" }), /HTTP 429 guard is closed/)));
    assert.equal(calls, 1); assert.equal(stops, 1);
  }
}

const ordinaryFailures = [
  new Error("execution reverted"),
  new Error("execution reverted: account quota exhausted"),
  { code: -32000, message: "execution reverted: compute units depleted" },
  new Error("execution revert: compute-unit depletion"),
  new Error("execution reverted: rate limit"),
  new Error("execution reverted: HTTP 429 Too Many Requests"),
  new Error("execution reverted: HTTP429"),
  { code: 3, status: 429, message: "execution reverted: account quota exhausted" },
  { code: "CALL_EXCEPTION", statusCode: 429, message: "execution reverted: compute units depleted" },
  { code: -32000, status: 429, data: "0x", message: "execution reverted: HTTP 429" },
  // Unlike message-only wrappers, typed reverts still terminate traversal.
  { code: 3, message: "execution reverted", cause: { status: 429 } },
  { code: "CALL_EXCEPTION", message: "execution reverted", cause: { code: 429 } },
  { code: -32000, data: "0x1234", message: "execution reverted", cause: { statusCode: 429 } },
  { code: -32000, data: "0x", message: "execution reverted", cause: { status: 429 } },
  ...["account quota exhausted", "compute units depleted", "rate limit", "HTTP 429 Too Many Requests"].flatMap(message => [
    { code: 3, message },
    { code: "CALL_EXCEPTION", message },
    { code: -32000, message, data: "0x1234" },
    { code: -32000, message, data: "0x" },
  ]),
  new Error("contract returned 429"),
  "429",
  { code: -32005, message: "unrelated error" },
  new Error("account quota available"),
  new Error("compute units remaining"),
];
for (const inner of ordinaryFailures) {
  for (const failure of [inner, new Error("outer transport failure", { cause: inner }),
    new Error("execution reverted", { cause: inner })]) {
    assert.equal(isRpcThrottleError(failure), false);
    let calls = 0, stops = 0;
    const normal = guardRpcThrottle({ call: async () => {
      calls++; if (calls === 1) throw failure; return "0x12";
    } }, () => { stops++; });
    await assert.rejects(normal.call({ to: "0x1", data: "0x" }), error => error === failure);
    assert.equal(await normal.call({ to: "0x1", data: "0x" }), "0x12");
    assert.equal(calls, 2); assert.equal(stops, 0);
  }
}
assert.equal(isRpcThrottleError(null), false);
assert.equal(isRpcThrottleError(undefined), false);

// Preserve the existing eight-node bound even when every message is skipped.
let cycleReads = 0;
const cycle = { message: "execution reverted: quota exhausted", get cause(): unknown {
  cycleReads++; return cycle;
} };
assert.equal(isRpcThrottleError(cycle), false);
assert.equal(cycleReads, 8);
let pairReads = 0;
const first = { message: "execution reverted", get cause(): unknown { pairReads++; return second; } };
const second = { message: "ordinary failure", get cause(): unknown { pairReads++; return first; } };
assert.equal(isRpcThrottleError(first), false);
assert.equal(pairReads, 8);
let atBound: unknown = { status: 429 };
for (let depth = 0; depth < 7; depth++) atBound = new Error("execution reverted", { cause: atBound });
assert.equal(isRpcThrottleError(atBound), true);
assert.equal(isRpcThrottleError(new Error("execution reverted", { cause: atBound })), false);
console.log("RPC throttle guard: PASS");
assert.equal(isRpcQuotaExhaustedError({ code: 429, message: "compute units per second capacity exceeded" }), false);
assert.equal(isRpcQuotaExhaustedError({ code: 429, message: "monthly capacity exceeded" }), true);
assert.equal(isRpcQuotaExhaustedError(new Error("wrapper", { cause: { code: 429, message: "account quota exhausted" } })), true);
assert.equal(isRpcQuotaExhaustedError({ code: 3, message: "execution reverted: quota exhausted" }), false);
assert.equal(isRpcQuotaExhaustedError(new Error("execution reverted: quota exhausted", {
  cause: { code: 429, message: "compute units per second capacity exceeded" },
})), false);
