import assert from "node:assert/strict";
import { guardRpcThrottle } from "../rpc-throttle-guard.js";

for (const failure of [new Error("HTTP 429 Too Many Requests"), { code: 429 },
  new Error("outer", { cause: new Error("compute units exceeded throughput limit") })]) {
  let calls = 0, stops = 0;
  const guarded = guardRpcThrottle({ call: async () => { calls++; throw failure; } }, () => { stops++; });
  await assert.rejects(guarded.call({ to: "0x1", data: "0x" }));
  await assert.rejects(guarded.call({ to: "0x1", data: "0x" }), /guard is closed/);
  assert.equal(calls, 1); assert.equal(stops, 1);
}
let calls = 0, stops = 0;
const normal = guardRpcThrottle({ call: async () => {
  calls++; if (calls === 1) throw new Error("execution reverted"); return "0x12";
} }, () => { stops++; });
await assert.rejects(normal.call({ to: "0x1", data: "0x" }));
assert.equal(await normal.call({ to: "0x1", data: "0x" }), "0x12");
assert.equal(stops, 0);
console.log("RPC throttle guard: PASS");
