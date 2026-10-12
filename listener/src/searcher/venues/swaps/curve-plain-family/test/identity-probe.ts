import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { AdapterRequest } from "../../../adapter-request-program.js";
import { assertSubscriptCalldata } from "../../../../../shared/executor/botvm-program-entry.js";

// Test-only independent decoder for the two ordinary CALL instructions. The
// preparation and swap must be in one trusted executor transaction, never in
// out-of-band preCalls whose failure says nothing about the main frame.
export function erc20ProbeCalls(request: AdapterRequest) {
  assert(request.kind === "effect-delta-simulation");
  assert.equal(request.call.executionMode, "executor-program");
  assert.equal(request.preCalls, undefined);
  assertSubscriptCalldata(request.call.data);
  const [script] = ethers.AbiCoder.defaultAbiCoder().decode(["bytes"], `0x${request.call.data.slice(10)}`);
  const bytes = ethers.getBytes(script), calls: { to: string; data: string }[] = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.equal(bytes[offset], 0, "ordinary CALL only");
    assert(offset + 24 <= bytes.length);
    const length = bytes[offset + 21] * 65536 + bytes[offset + 22] * 256 + bytes[offset + 23];
    assert(length >= 4 && offset + 24 + length <= bytes.length);
    calls.push({ to: ethers.hexlify(bytes.slice(offset + 1, offset + 21)),
      data: ethers.hexlify(bytes.slice(offset + 24, offset + 24 + length)) });
    offset += 24 + length;
  }
  assert.equal(calls.length, 2, "one setup followed by one exchange, with no hidden calls");
  return calls;
}
