import assert from "node:assert/strict";
import test from "node:test";
import { verifyHistoricalQuoteCaller } from "./historical-native-dual.js";

const executor = `0x${"12".repeat(20)}`;
const tx = { to: `0x${"34".repeat(20)}`, data: "0x12345678", blockTag: 123 };
const pin = { blockHash: `0x${"56".repeat(32)}`, requireCanonical: true };

test("historical caller control preserves the issued default call and independently checks executor parity", async () => {
  const calls: unknown[][] = [], wire: any[] = [];
  const result = await verifyHistoricalQuoteCaller({ tx, sourceNumber: 123, pin, executor, wire,
    async send(method, params) { assert.equal(method, "eth_call"); calls.push(params); return "0x42"; } });
  assert.equal(result, "0x42");
  assert.deepEqual(calls, [[{ to: tx.to, data: tx.data }, pin],
    [{ to: tx.to, data: tx.data, from: executor }, pin]]);
  assert.deepEqual(wire.map(row => row.callerMode), ["production-rpc-default", "executor-parity-control"]);
});

test("historical declared executor is retained without a fabricated default control", async () => {
  const wire: any[] = [];
  await verifyHistoricalQuoteCaller({ tx: { ...tx, from: executor }, sourceNumber: 123, pin, executor, wire,
    async send(_method, params) { assert.deepEqual(params, [{ to: tx.to, data: tx.data, from: executor }, pin]); return "0x42"; } });
  assert.equal(wire.length, 1); assert.equal(wire[0].callerMode, "production-executor");
});

test("caller-dependent results, alien callers and wrong source reject before acceptance", async () => {
  const wire: any[] = [];
  await assert.rejects(verifyHistoricalQuoteCaller({ tx, sourceNumber: 123, pin, executor, wire,
    async send(_method, params) { return (params[0] as any).from ? "0x43" : "0x42"; } }), /quote mismatch/);
  assert.equal(wire.length, 2); assert.notEqual(wire[0].result, wire[1].result);
  for (const invalid of [{ ...tx, from: `0x${"78".repeat(20)}` }, { ...tx, blockTag: 124 }]) {
    await assert.rejects(verifyHistoricalQuoteCaller({ tx: invalid, sourceNumber: 123, pin, executor, wire: [],
      async send() { assert.fail("invalid caller/source must not reach RPC"); } }));
  }
});
