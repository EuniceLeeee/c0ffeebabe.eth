import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { originalEtherTokenLeg } from "./history-evidence.js";
const token = "0xc0829421c1d260bd3cb3e0f06cfe2d52db2ce315", actor = "0x1000000000000000000000000000000000000002";
const descriptor = { token, nativeAnchor: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" };
const abi = new ethers.Interface(["function withdraw(uint256)", "event Destruction(uint256 amount)"]);
function fixture() {
  const receipt = { status: "0x1", logs: [{address: token, ...abi.encodeEventLog(abi.getEvent("Destruction")!, [137n]), logIndex: "0x3"}] };
  const call = {type:"CALL",from:actor,to:token,input:abi.encodeFunctionData("withdraw",[137n]),output:"0x",
    calls:[{type:"CALL",from:token,to:actor,input:"0x",value:"0x89",output:"0x"}]};
  return {receipt, trace:{type:"CALL",calls:[call]}};
}
test("native original output is the withdrawal's ETH payment, not an ERC20 receipt", () => {
  const f=fixture(), r=originalEtherTokenLeg(token,descriptor,f.receipt,f.trace);
  assert.equal(r.amountOut,137n); assert.equal(r.originalOutputAsset,"native-ETH");
  assert.equal(r.tokenOut,descriptor.nativeAnchor); assert.match(r.comparison,/NOT original pre-call/);
  const empty: any=fixture(); delete empty.trace.calls[0].output;
  assert.equal(originalEtherTokenLeg(token,descriptor,empty.receipt,empty.trace).amountOut,137n);
});
for (const [name, mutate] of [
  ["failed ancestor", f => { f.trace.error="reverted"; }],
  ["failed child payment", f => { f.trace.calls[0].calls[0].error="reverted"; }],
  ["wrong payment recipient", f => { f.trace.calls[0].calls[0].to=token; }],
  ["wrong payment amount", f => { f.trace.calls[0].calls[0].value="0x88"; }],
  ["unexpected return value", f => { f.trace.calls[0].output="0x1234"; }],
  ["wrong burn amount", f => { f.receipt.logs[0].data=abi.encodeEventLog(abi.getEvent("Destruction")!,[138n]).data; }],
  ["ambiguous withdrawal", f => { f.trace.calls.push(f.trace.calls[0]); }],
  ["ambiguous burn", f => { f.receipt.logs.push(f.receipt.logs[0]); }],
] as [string,(f:any)=>void][]) test(`native observer rejects ${name}`, () => {
  const f=fixture(); mutate(f); assert.throws(()=>originalEtherTokenLeg(token,descriptor,f.receipt,f.trace));
});
