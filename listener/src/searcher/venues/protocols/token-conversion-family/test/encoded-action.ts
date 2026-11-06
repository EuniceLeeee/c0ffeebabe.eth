import assert from "node:assert/strict";
import { ethers } from "ethers";
import type { ResolvedPlanNode } from "../../../../../types.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { plugin } from "../../../production-families/token-conversion.production.js";

const token = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)", "function approve(address,uint256) returns(bool)"]);

export function checkIssuedConversion(node: ResolvedPlanNode, executor: string, amountOut: bigint, expectedCall: string, mint: boolean) {
  const action = plugin.actionAdapters.find(adapter => adapter.id === node.adapterId)!;
  const script = action.encode(node, executor, new Uint8Array());
  assert.equal(script[0], 0x0e); assert.equal(BigInt(ethers.hexlify(script.slice(1, 33))), node.amount);
  assert.equal(Number(BigInt(ethers.hexlify(script.slice(33, 36)))), script.length - 36);
  let converted = false;
  const calls = inspectRuntime(ethers.hexlify(script.slice(36)), node.amount, { nativeBalance: () => 41n, call(call) {
    if (call.data === expectedCall) {
      assert.equal(call.target.toLowerCase(), node.target.toLowerCase()); assert(!converted); converted = true;
      return ethers.toBeHex(amountOut, 32);
    }
    const abi = token.parseTransaction({ data: call.data }); assert(abi);
    if (abi.name === "approve") { assert(call.target.toLowerCase() === node.tokenIn.toLowerCase()); return ethers.toBeHex(1n, 32); }
    assert(call.static);
    if (abi.name === "totalSupply") return ethers.toBeHex(node.amount + 400n + (converted ? mint ? amountOut : -node.amount : 0n), 32);
    assert.equal(abi.name, "balanceOf"); assert.equal(abi.args[0].toLowerCase(), executor.toLowerCase());
    return ethers.toBeHex(call.target.toLowerCase() === node.tokenIn.toLowerCase() ?
      node.amount + 31n - (converted ? node.amount : 0n) : 49n + (converted ? amountOut : 0n), 32);
  } }).calls.filter(call => !call.static);
  assert.equal(converted, true);
  assert.deepEqual(calls.map(call => call.data), mint ? [
    token.encodeFunctionData("approve", [node.target, 0n]), token.encodeFunctionData("approve", [node.target, node.amount]),
    expectedCall, token.encodeFunctionData("approve", [node.target, 0n]),
  ] : [expectedCall]);
}
