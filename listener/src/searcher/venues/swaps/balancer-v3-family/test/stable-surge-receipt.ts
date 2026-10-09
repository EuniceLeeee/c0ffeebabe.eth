import assert from "node:assert/strict";
import test from "node:test";
import { assertOriginalReceipt } from "./historical-runtime-dual.js";

test("historical original input receipt binds a 32-byte block hash, not an address", () => {
  const hash = "0x828d403abbfd3b30704129a575bbc9406609546f110f64e70ee5fc34d06735a6";
  const source = { number: 26030897, hash: hash as `0x${string}`, generation: 1 };
  const receipt = { blockNumber: "0x" + source.number.toString(16), blockHash: hash, status: "0x1" };
  assert.doesNotThrow(() => assertOriginalReceipt(receipt, source));
  for (const bad of [{ ...receipt, status: "0x0" }, { ...receipt, blockNumber: "0x1" },
    { ...receipt, blockHash: "0x" + "11".repeat(32) }, { ...receipt, blockHash: "0x" + "11".repeat(20) }]) {
    assert.throws(() => assertOriginalReceipt(bad, source));
  }
});
