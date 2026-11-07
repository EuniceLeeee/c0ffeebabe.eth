import assert from "node:assert/strict";
import test from "node:test";
import { hexlify, MaxUint256 } from "ethers";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
import { assertRuntimeGuardRejects, inspectRuntime } from "./runtime-program-testkit.js";

test("execution negatives require the specified VM guard, not a test or fixture failure", () => {
  const unequal = new RuntimeAmountProgram().constant(1, 2n).equal(0, 1);
  assertRuntimeGuardRejects(() => inspectRuntime(hexlify(unequal.bytes()), 1n), "equality");
  const underflow = new RuntimeAmountProgram().constant(1, 2n).math("sub", 2, 0, 1);
  assertRuntimeGuardRejects(() => inspectRuntime(hexlify(underflow.bytes()), 1n), "uint256-range");
  assert.throws(() => assertRuntimeGuardRejects(() => inspectRuntime(hexlify(unequal.bytes()), 1n), "uint256-range"));
  const missingGuard = new RuntimeAmountProgram().constant(1, 2n);
  const masked = () => { inspectRuntime(hexlify(missingGuard.bytes()), 1n); assert.equal(1n, 2n); };
  assert.throws(masked); // The legacy negative assertion incorrectly passes.
  assert.throws(() => assertRuntimeGuardRejects(masked, "equality"));
  assert.throws(() => assertRuntimeGuardRejects(() => inspectRuntime(hexlify(missingGuard.bytes()), 1n), "equality"));
});

test("callback, missing/malformed fixtures and bad program bytes are not VM guard evidence", () => {
  const call = new RuntimeAmountProgram().directCall("0x0000000000000000000000000000000000000001", "0x");
  const native = new RuntimeAmountProgram().nativeBalance(1);
  for (const action of [
    () => inspectRuntime(hexlify(call.bytes()), 1n, { call: () => { throw new Error("host failed"); } }),
    () => inspectRuntime(hexlify(native.bytes()), 1n),
    () => inspectRuntime(hexlify(native.bytes()), 1n, { nativeBalance: () => -1n }),
    () => inspectRuntime(hexlify(native.bytes()), 1n, { nativeBalance: () => MaxUint256 + 1n }),
    () => inspectRuntime("0x01ff", 1n),
    () => { throw Object.assign(new Error("runtime amount mismatch"), { name: "RuntimeProgramGuardError", code: "equality" }); },
  ]) for (const code of ["equality", "uint256-range"] as const)
    assert.throws(() => assertRuntimeGuardRejects(action, code));
});
