import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex, encodeWrapNativeDelta, hexToBytes } from "../../encoder.js";

test("native-delta wrapper matches Solidity vector and contains no quote", () => {
  assert.equal(bytesToHex(encodeWrapNativeDelta(hexToBytes("0x001122"))),"0x0b000003001122");
  assert.equal(bytesToHex(encodeWrapNativeDelta(new Uint8Array())),"0x0b000000");
});
test("native-delta script length cannot truncate", () => {
  const max = new Uint8Array(0xffffff);
  assert.deepEqual(encodeWrapNativeDelta(max).slice(0,4),new Uint8Array([0x0b,0xff,0xff,0xff]));
  assert.throws(() => encodeWrapNativeDelta(new Uint8Array(0x1000000)), /uint24 overflow/);
});
