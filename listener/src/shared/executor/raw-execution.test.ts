import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram as P, runtimeProgramScript, runtimeCallSequenceScript } from "../../adapters/runtime-amount-program.js";
import { buildRawExecuteCalldata, buildExecuteCalldata } from "./botvm-executor.js";

test("raw entry preserves the exact original script and keeps ABI default", () => {
  const script = runtimeProgramScript(new P().constant(1, 17n).bytes(), 30n);
  assert.equal(buildRawExecuteCalldata(script), ethers.id("executeRaw()").slice(0, 10) + ethers.hexlify(script).slice(2));
  assert.equal(buildExecuteCalldata(script), new ethers.Interface(["function execute(bytes)"]).encodeFunctionData("execute", [script]));
});
test("raw entry rejects outer calldata reads, including same-frame nested programs", () => {
  for (const p of [new P().calldata(1, 4), new P().run(new P().calldata(1, 4).bytes())])
    assert.throws(() => buildRawExecuteCalldata(runtimeProgramScript(p.bytes())), /entry context/);
});
test("raw entry permits independent callback frames but rejects unknown script shapes", () => {
  const callback = runtimeProgramScript(new P().calldata(1, 4).bytes());
  const script = runtimeProgramScript(new P().call("0x1000000000000000000000000000000000000001", callback).bytes());
  assert.doesNotThrow(() => buildRawExecuteCalldata(script));
  for (const bad of [new Uint8Array(), script.slice(1), script.slice(0, -1), new Uint8Array([14, 1])])
    assert.throws(() => buildRawExecuteCalldata(bad), /entry context/);
});
test("compact ordinary calls and returned floors preserve the raw script", () => {
  const script = runtimeProgramScript(new P()
    .directCall("0x1000000000000000000000000000000000000001", "0x12345678")
    .returnedFloor(0, 20n, true).bytes());
  assert.equal(ethers.dataSlice(buildRawExecuteCalldata(script), 4), ethers.hexlify(script));
  assert.throws(() => buildRawExecuteCalldata(script.slice(0, -1)), /entry context/);
});
test("call-only compiler rejects dynamic instructions and preserves callback frame", () => {
  const target = "0x1000000000000000000000000000000000000001";
  const child = runtimeCallSequenceScript(new P().directCall(target, "0x12345678").bytes());
  const payload = new ethers.Interface(["function run(bytes)"]).encodeFunctionData("run", [child]);
  const program = new P().call(target, payload, { callback: { incomingOffset: 68, outgoingOffset: 68 } }).returnedFloor(0, 10n);
  const script = runtimeCallSequenceScript(program.bytes());
  assert.equal(ethers.dataSlice(buildRawExecuteCalldata(script), 4), ethers.hexlify(script));
  for (const dynamic of [new P().calldata(0, 4), new P().constant(0, 1n), new P().call(target, "0x12345678"),
    new P().call(target, payload, { callback: { incomingOffset: 68, outgoingOffset: 68 }, patches: [{ offset: 4, reg: 0 }] })])
    assert.throws(() => runtimeCallSequenceScript(dynamic.bytes()), /call sequence/);
});
