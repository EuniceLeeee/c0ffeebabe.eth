import assert from "node:assert/strict";
import { test } from "node:test";
import { originalV4Leg } from "./history-evidence.js";
import { ERC20_SETTLEMENT_OBSERVATION as source } from "./history-erc20-observation.fixture.js";
const instance = source.descriptor.managerBinding.manager + "\u001f" + source.descriptor.poolId;
const observe = (f: any, optional = true) => originalV4Leg(instance, f.descriptor, f.receipt, f.trace, false, optional);
function calls(f: any): any[] { return [f, ...(f.calls ?? []).flatMap(calls)]; }
test("real Permit2-funded original swap binds actual payer, manager receipt, settle and take", () => {
  const actual = observe(source);
  assert.equal(actual.tokenIn, source.descriptor.poolKey.currency1);
  assert.equal(actual.tokenOut, source.descriptor.poolKey.currency0);
  assert.equal(actual.amountIn, 500798859n); assert.equal(actual.amountOut, 500729883n);
  assert.throws(() => observe(source, false), "legacy native observer has not been broadened");
});
test("delegated transfer requires success return and actual receipt, not caller identity alone", () => {
  for (const output of ["0x" + "00".repeat(32), "0x01"]) {
    const f = structuredClone(source); const payment = calls(f.trace).find(x => x.input?.startsWith("0x23b872dd"));
    payment.output = output; assert.throws(() => observe(f));
  }
  const f = structuredClone(source);
  f.receipt.logs = f.receipt.logs.filter(l => l.address.toLowerCase() !== f.descriptor.poolKey.currency1);
  assert.throws(() => observe(f));
});
test("delegated transfer outside the current sync/settle interval cannot prove funding", () => {
  const f = structuredClone(source), frames = calls(f.trace);
  const callback = frames.find(x => x.calls?.some((c: any) => c.input?.startsWith("0xa5841194")));
  const nestedPaymentIndex = callback.calls.findIndex((x: any) => x.to === "0x000000000022d473030f116ddee9f6b43ac78ba3");
  const [payment] = callback.calls.splice(nestedPaymentIndex, 1); callback.calls.unshift(payment);
  assert.throws(() => observe(f));
});
