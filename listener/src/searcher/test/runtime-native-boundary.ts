import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
import { runtimeNativeBoundary, RUNTIME_WRAP } from "../venues/runtime-execution.js";
import { inspectRuntime } from "./runtime-program-testkit.js";

const wrapped = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const callData = "0x12345678";

// This checks the common emitter, independently of any Family ABI/identity.
// Real VM and historical per-Family receipts are separate acceptance gates.
function exercise(nativeIn: boolean, amount: bigint, initial: bigint,
  failure?: "short-unwrap" | "refund" | "native-loss" | "bad-wrapper") {
  const p = new RuntimeAmountProgram();
  const boundary = runtimeNativeBoundary(p, wrapped);
  if (nativeIn) boundary.unwrapInput();
  p.call(target, callData, nativeIn ? { valueReg: 0 } : {});
  if (!nativeIn) boundary.wrapOutput();
  boundary.assertRestored();
  let native = initial, wrapping = initial + (nativeIn ? amount : 0n);
  let received = 0n;
  inspectRuntime(ethers.hexlify(p.bytes()), amount, {
    nativeBalance: () => native,
    call(c) {
      if (c.target.toLowerCase() === target) {
        assert.equal(c.data, callData);
        assert.equal(c.value, nativeIn ? amount : 0n);
        assert(native >= c.value);
        native -= c.value;
        if (nativeIn) received = c.value;
        else native += amount * 3n;
        if (failure === "refund") native++;
        if (failure === "native-loss") native--;
        return "0x";
      }
      assert.equal(c.target.toLowerCase(), wrapped);
      const decoded = RUNTIME_WRAP.parseTransaction({ data: c.data }); assert(decoded);
      if (decoded.name === "withdraw") {
        assert.equal(decoded.args[0], amount);
        wrapping -= amount;
        native += amount - (failure === "short-unwrap" ? 1n : 0n);
      } else {
        assert.equal(decoded.name, "deposit");
        assert.equal(c.value, amount * 3n);
        wrapping += c.value;
        if (failure !== "bad-wrapper") native -= c.value;
      }
      return "0x";
    },
  });
  assert.equal(native, initial, "native stock is not funding or leftover output");
  assert.equal(wrapping, nativeIn ? initial : initial + amount * 3n);
  if (nativeIn) assert.equal(received, amount);
}

test("shared native boundary unwraps working input and wraps only actual output", () => {
  for (const input of [true, false]) for (const amount of [1n, 10n ** 15n, 10n ** 18n])
    for (const stock of [0n, 777n, 10n ** 20n]) exercise(input, amount, stock);
});

test("native inventory cannot subsidize a short unwrap or hide a refund/loss", () => {
  for (const failure of ["short-unwrap", "refund", "native-loss"] as const)
    assert.throws(() => exercise(true, 100n, 777n, failure), /mismatch/);
  assert.throws(() => exercise(false, 100n, 777n, "bad-wrapper"), /mismatch/);
});

test("native boundary rejects aliasing and invalid register/address contracts", () => {
  for (const regs of [[0, 14], [13, 0], [13, 13], [16, 14], [13, -1], [1.5, 14]])
    assert.throws(() => runtimeNativeBoundary(new RuntimeAmountProgram(), wrapped, ...regs as [number, number]), /boundary registers/);
  assert.throws(() => runtimeNativeBoundary(new RuntimeAmountProgram(), ethers.ZeroAddress), /wrapper address/);
  const boundary = runtimeNativeBoundary(new RuntimeAmountProgram(), wrapped);
  for (const amountReg of [-1, 13, 14, 16, 1.5])
    assert.throws(() => boundary.unwrapInput(amountReg), /amount register/);
});
