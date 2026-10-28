// Observations only: no pricing model or admission decisions.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { XWIN_ABI } from "../xwin.js";

const ERC20 = new ethers.Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "function transfer(address,uint256) returns(bool)",
  "function transferFrom(address,address,uint256) returns(bool)",
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function calls(root: any, target: string, selector: string) {
  const found: { frame: any; path: number[] }[] = [];
  const visit = (frame: any, path: number[]) => {
    if (!frame || frame.error || frame.revertReason) return;
    if (frame.type === "CALL" && same(frame.to ?? "", target) && same(frame.input?.slice(0, 10) ?? "", selector))
      found.push({ frame, path });
    for (const [i, child] of (frame.calls ?? []).entries()) visit(child, [...path, i]);
  };
  visit(root, []); return found;
}
function receiptTransfer(receipt: any, subtree: any, token: string, from: string, to: string, amount: bigint) {
  const matches = receipt.logs.filter((l: any) => !l.removed && same(l.address, token) &&
    l.topics?.[0] === ERC20.getEvent("Transfer")!.topicHash).filter((l: any) => {
      const a = ERC20.parseLog(l)!.args;
      return same(a.from, from) && same(a.to, to) && a.value === amount;
    });
  assert.equal(matches.length, 1, "missing/ambiguous xWin receipt transfer");
  const scoped: any[] = [];
  const visit = (f: any) => {
    if (!f || f.error || f.revertReason) return;
    scoped.push(...(f.logs ?? []));
    for (const c of f.calls ?? []) visit(c);
  };
  visit(subtree);
  const selected = matches[0];
  assert.equal(scoped.filter(l => same(l.address ?? "", selected.address) && same(l.data ?? "", selected.data) &&
    Array.isArray(l.topics) && l.topics.length === selected.topics.length &&
    l.topics.every((t: string, i: number) => same(t, selected.topics[i]))).length, 1,
  "xWin receipt transfer not uniquely emitted in selected successful subtree");
  return matches[0];
}
export function originalXwinLeg(instance: string, descriptor: any, receipt: any, trace: any, direction: "mint" | "redeem") {
  assert(!trace.error && !trace.revertReason);
  assert.equal(descriptor.variant, "xwin-allocations-v1");
  assert(same(descriptor.target, instance) && ethers.isAddress(descriptor.asset) && !same(descriptor.asset, instance));
  const method = direction === "mint" ? "deposit" : "withdraw";
  const matches = calls(trace, instance, XWIN_ABI.getFunction(method)!.selector);
  assert.equal(matches.length, 1, "exactly one successful xWin original leg required");
  const { frame, path } = matches[0]!;
  assert(ethers.isAddress(frame.from) && !same(frame.from, instance));
  const data = XWIN_ABI.decodeFunctionData(method, frame.input);
  const amountIn = BigInt(data[0]), amountOut = BigInt(XWIN_ABI.decodeFunctionResult(method, frame.output)[0]);
  assert(amountIn > 0n && amountOut > 0n);
  const actor = frame.from.toLowerCase(), mint = direction === "mint";
  const shares = receiptTransfer(receipt, frame, instance, mint ? ethers.ZeroAddress : actor,
    mint ? actor : ethers.ZeroAddress, mint ? amountOut : amountIn);
  const assetAmount = mint ? amountIn : amountOut;
  // A matching receipt alone could come from a sibling operation. Bind the
  // actual asset movement to this successful call subtree and payer.
  const transferMethod = mint ? "transferFrom" : "transfer";
  const payments = calls(frame, descriptor.asset, ERC20.getFunction(transferMethod)!.selector).filter(({ frame: c }) => {
    if (!same(c.from, instance)) return false;
    const a = ERC20.decodeFunctionData(transferMethod, c.input);
    return (mint ? same(a[0], actor) && same(a[1], instance) && a[2] === assetAmount :
      same(a[0], actor) && a[1] === assetAmount) && ERC20.decodeFunctionResult(transferMethod, c.output)[0] === true;
  });
  assert.equal(payments.length, 1, "xWin actual asset movement is missing/ambiguous in selected call subtree");
  const assetReceipt = receiptTransfer(receipt, payments[0]!.frame, descriptor.asset,
    mint ? actor : instance, mint ? instance : actor, assetAmount);
  return { tokenIn: (mint ? descriptor.asset : instance).toLowerCase(), tokenOut: (mint ? instance : descriptor.asset).toLowerCase(),
    amountIn, amountOut, caller: actor, recipient: actor, originalInterface: method + "(uint256,uint32)",
    originalSlippage: BigInt(data[1]), comparison: "original amounts observed; production slippage argument may differ; N-end is NOT original pre-call state",
    logIndex: (mint ? shares : assetReceipt).logIndex, tracePath: path };
}
