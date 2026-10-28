// Test-only receipt/trace observer; never supplies identity, prices or calldata.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { ETHERTOKEN_NATIVE_INTERFACE } from "../shared.js";
const BURN = new ethers.Interface(["event Destruction(uint256 amount)"]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function originalEtherTokenLeg(instance: string, descriptor: { token: string; nativeAnchor: string }, receipt: any, trace: any) {
  assert(same(instance, descriptor.token) && same(descriptor.nativeAnchor, ADDR.WETH));
  assert(!trace.error && !trace.revertReason && BigInt(receipt.status) === 1n);
  const calls: any[] = [];
  const visit = (frame: any) => {
    if (!frame || frame.error || frame.revertReason) return;
    if (frame.type === "CALL" && same(frame.to ?? "", instance) &&
      frame.input?.slice(0, 10) === ETHERTOKEN_NATIVE_INTERFACE.getFunction("withdraw")!.selector) calls.push(frame);
    for (const child of frame.calls ?? []) visit(child);
  };
  visit(trace); assert.equal(calls.length, 1, "one successful native withdrawal required");
  const call = calls[0], amountIn = BigInt(ETHERTOKEN_NATIVE_INTERFACE.decodeFunctionData("withdraw", call.input)[0]);
  assert(amountIn > 0n && ethers.isAddress(call.from) && !same(call.from, instance));
  // callTracer may omit an empty return; withdraw has no return values.
  assert.equal(call.output ?? "0x", "0x");
  const payments = (call.calls ?? []).filter((c: any) => c.type === "CALL" && !c.error && !c.revertReason &&
    same(c.from ?? "", instance) && same(c.to ?? "", call.from) && c.input === "0x" && BigInt(c.value ?? "0x0") > 0n);
  assert.equal(payments.length, 1, "withdrawal must pay its actual caller native ETH");
  const amountOut = BigInt(payments[0].value); assert.equal(amountOut, amountIn);
  const logs = receipt.logs.filter((l: any) => same(l.address, instance) && l.topics?.[0] === BURN.getEvent("Destruction")!.topicHash);
  assert.equal(logs.length, 1, "unambiguous one-argument burn required");
  assert.equal(logs[0].topics.length, 1); assert.equal(BURN.parseLog(logs[0])!.args.amount, amountIn);
  return { tokenIn: instance.toLowerCase(), tokenOut: descriptor.nativeAnchor.toLowerCase(), amountIn, amountOut,
    caller: call.from.toLowerCase(), recipient: call.from.toLowerCase(), originalInterface: "withdraw(uint256)",
    comparison: "original native ETH payout mapped to graph WETH; N-end execution is NOT original pre-call replay",
    originalOutputAsset: "native-ETH", logIndex: logs[0].logIndex };
}
