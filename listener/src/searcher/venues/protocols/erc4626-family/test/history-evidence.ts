// Evidence decoder only: no discovery, pricing, simulation or production policy.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { ERC4626_INTERFACE as STANDARD } from "../abi.js";
const VAULT = new ethers.Interface([...STANDARD.fragments,
  "function withdraw(uint256 assets,address receiver,address owner) returns(uint256 shares)",
  "function depositNative(address receiver) payable returns(uint256 shares)"]);
const ERC20 = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function originalStandardErc4626Leg(instance: string, descriptor: any, receipt: any, trace: any) {
  assert(!trace.error && !trace.revertReason, "original transaction reverted");
  assert(!descriptor.custodian && same(descriptor.vault, instance) && same(descriptor.share, instance),
    "standard vault-owned shares required");
  const logs = receipt.logs.filter((log: any) => !log.removed && same(log.address, instance) &&
    ["Deposit", "Withdraw"].some(name => same(log.topics?.[0] ?? "", VAULT.getEvent(name)!.topicHash)));
  assert.equal(logs.length, 1, "one unambiguous original vault event required");
  const event = VAULT.parseLog(logs[0])!, a = event.args;
  const deposit = event.name === "Deposit";
  const methods = deposit ? ["deposit", "depositNative"] : ["redeem", "withdraw"];
  const calls: { frame: any; method: string }[] = [];
  const visit = (frame: any) => {
    if (!frame || frame.error || frame.revertReason) return;
    if (frame.type === "CALL" && same(frame.to ?? "", instance)) {
      for (const method of methods) if (frame.input?.slice(0, 10) === VAULT.getFunction(method)!.selector)
        calls.push({ frame, method });
    }
    for (const child of frame.calls ?? []) visit(child);
  };
  visit(trace);
  assert.equal(calls.length, 1, "one successful supported vault call required");
  const { frame: call, method } = calls[0]!;
  const scoped: any[] = [];
  const collect = (frame: any) => {
    if (!frame || frame.error || frame.revertReason) return;
    scoped.push(...(frame.logs ?? []));
    for (const child of frame.calls ?? []) collect(child);
  };
  collect(call);
  const assertInCall = (selected: any) => assert.equal(scoped.filter(log =>
    same(log.address ?? "", selected.address) && same(log.data ?? "", selected.data) &&
    Array.isArray(log.topics) && log.topics.length === selected.topics.length &&
    log.topics.every((topic: string, i: number) => same(topic, selected.topics[i]))).length, 1,
  "receipt log not uniquely emitted in selected successful vault subtree");
  // A successful sibling's identical event/payment cannot authenticate this leg.
  // The actual payer may be a liquidity contract, not the vault itself.
  assertInCall(logs[0]);
  const input = VAULT.decodeFunctionData(method, call.input), native = method === "depositNative";
  const amountIn = BigInt(deposit ? a.assets : a.shares);
  const amountOut = BigInt(deposit ? a.shares : a.assets);
  const tokenIn = deposit ? descriptor.asset : descriptor.share;
  const tokenOut = deposit ? descriptor.share : descriptor.asset;
  const recipient = String(input[native ? 0 : 1]), caller = String(call.from);
  assert(ethers.isAddress(tokenIn) && ethers.isAddress(tokenOut) && !same(tokenIn, tokenOut));
  assert(amountIn > 0n && amountOut > 0n);
  if (native) {
    assert(same(tokenIn, WETH), "only observed ETH-to-WETH input mapping is declared");
    assert.equal(BigInt(call.value ?? "0x0"), amountIn);
  } else {
    assert.equal(BigInt(call.value ?? "0x0"), 0n);
    assert.equal(input[0], method === "withdraw" ? amountOut : amountIn);
  }
  assert.equal(VAULT.decodeFunctionResult(method, call.output)[0], method === "withdraw" ? amountIn : amountOut);
  assert(same(a.sender, caller));
  if (deposit) assert(same(a.owner, recipient));
  else assert(same(input[2], caller) && same(a.owner, caller) && same(a.receiver, recipient));
  const receipts = receipt.logs.filter((log: any) => !log.removed && same(log.address, tokenOut) &&
    log.topics?.[0] === ERC20.getEvent("Transfer")!.topicHash)
    .filter((log: any) => {
      const transfer = ERC20.parseLog(log)!.args;
      return same(transfer.to, recipient) && transfer.value === amountOut &&
        (!deposit || same(transfer.from, ethers.ZeroAddress));
    });
  assert.equal(receipts.length, 1, "independent original output receipt required");
  assertInCall(receipts[0]);
  const comparison = native
    ? "native deposit amount mapped to ERC20 WETH deposit at N-end; NOT original interface/pre-call parity"
    : method === "withdraw"
      ? "asset-output withdraw burned shares mapped to redeem at N-end; NOT original interface/pre-call parity"
      : "same interface at N-end; original pre-call state NOT restored";
  return { tokenIn: tokenIn.toLowerCase(), tokenOut: tokenOut.toLowerCase(), amountIn, amountOut,
    caller: caller.toLowerCase(), recipient: recipient.toLowerCase(), originalInterface: method,
    comparison, logIndex: logs[0].logIndex };
}
