// Offline compatibility of existing Family quote programs. Admission and EVM
// behavior remain covered by the existing Family/issuer and historical suites.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD as load } from "../venues/production-family-composition.js";
import { plugin as aqua } from "../venues/production-families/aqua-swapvm.production.js";
import { descriptor as aquaFixture } from "../venues/swaps/aqua-swapvm-family/test/fixtures.js";
import { ABI, takerData } from "../venues/swaps/aqua-swapvm-family/codec.js";
import { inspectRuntime } from "./runtime-program-testkit.js";

const executor = "0x1000000000000000000000000000000000000002", recipient = "0x1000000000000000000000000000000000000003";
const source = { number: 1, hash: ethers.ZeroHash, generation: 1 };
test("Aqua quote binds actual receiver in the same taker slice as swap, preserving omitted receiver", () => {
  const d = aquaFixture();
  for (const route of aqua.routes.project({ descriptor: d })) for (const receiver of [undefined, executor, recipient]) {
    const request = { kind: "quote-output" as const, ...(receiver ? { recipient: receiver } : {}) };
    const leg = aqua.execution.buildRuntimeLeg!({ descriptor: d, route, source, executor, runtimeEvidence: [], settlement: request }); assert(leg);
    assert.deepEqual(leg.settlementRequest, request);
    const q = inspectRuntime(leg.program, 123n, { call(c) {
      assert(c.static); const parsed = ABI.decodeFunctionData("quote", c.data);
      assert.equal(parsed.amount, 123n); assert.equal(parsed.takerTraitsAndData, takerData(1n, receiver ? { recipient: receiver } : {}));
      return ABI.encodeFunctionResult("quote", [123n, 117n, d.strategyHash]);
    } }, { output: true, readOnly: true }); assert.equal(q.registers[0], 117n);
    for (const bad of [ethers.ZeroAddress, d.router, d.aqua, d.order.maker, ...d.tokens])
      assert.throws(() => aqua.execution.buildRuntimeLeg!({ descriptor: d, route, source, executor, runtimeEvidence: [],
        settlement: { kind: "quote-output", recipient: bad } }), /invalid executor/);
  }
});

test("UniV2 constant-product receiver does not change quote; opaque callback quotes remain self-only", () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/runtime-family-descriptors.json", import.meta.url), "utf8"),
    (_key, value) => value?.$durableType === "bigint" ? BigInt(value.value) : value);
  const family: any = [...load.plugins, ...load.disabledPlugins].find(m => m.familyId === "univ2-standard")!.plugin;
  const models = new Set<string>();
  const descriptors = raw.descriptors.filter((d: any) => d.familyId === "univ2-standard"); assert(descriptors.length > 0);
  // The saved corpus has only CP here. Explicit synthetic opaque profile for
  // emitter compatibility; it is never turned into a Ready/admission record.
  descriptors.push({ ...descriptors[0], quoteModel: { kind: "pool-get-amount-out", probe0: 1n, probe1: 1n },
    feeRule: { kind: "included-in-pool-quote", feeBps: 0n, evidence: "pool-quote" } });
  for (const d of descriptors) for (const route of family.routes.project({ descriptor: d })) {
    models.add(d.quoteModel.kind);
    const build = (who?: string) => family.execution.buildRuntimeLeg({ descriptor: d, route, source, executor, runtimeEvidence: [],
      settlement: { kind: "quote-output", ...(who ? { recipient: who } : {}) } });
    const original = build(), explicit = build(executor); assert(original && explicit); assert.equal(original.program, explicit.program);
    const other = build(recipient);
    if (d.quoteModel.kind === "pool-get-amount-out") assert.equal(other, null);
    else { assert(other); assert.equal(other.program, original.program); assert.equal(other.settlementRequest.recipient, recipient); }
    for (const bad of [ethers.ZeroAddress, d.pool, route.tokenIn, route.tokenOut]) assert.throws(() => build(bad), /invalid output recipient/);
  }
  assert.deepEqual([...models].sort(), ["constant-product", "pool-get-amount-out"]);
});
