// Observation-only support for the two coffee single-swap samples. No identity,
// graph, pricing or execution implementation; reject other original interfaces.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { EKUBO_CORE, EKUBO_ROUTER, parseEkuboCoreSwapLog, ekuboRouterIface, decodeEkuboBalanceUpdate } from "../../ekubo/abi.js";
import { ekuboPoolId, ekuboGraphToken } from "../../ekubo/pool-key.js";
import { NO_RECEIVER, NO_RECEIVER_SELECTOR } from "../codec.js";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const transfer = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)",
  "function transfer(address,uint256) returns(bool)"]);
function successfulFrames(root: any): any[] {
  const frames: any[] = [];
  const visit = (frame: any) => {
    if (!frame || frame.error || frame.revertReason) return;
    if (frame.type === "CALL") frames.push(frame);
    for (const child of frame.calls ?? []) visit(child);
  };
  visit(root); return frames;
}
export function originalEkuboLeg(instance: string, descriptor: any, receipt: any, trace: any) {
  assert(!trace.error && !trace.revertReason);
  assert(ethers.isHexString(instance, 32) && same(ekuboPoolId(descriptor.poolKey), instance));
  const logs = receipt.logs.flatMap((log: any) => {
    if (!same(log.address, EKUBO_CORE) || log.topics.length !== 0) return [];
    try { const parsed = parseEkuboCoreSwapLog(log.data); return parsed.poolId === instance.toLowerCase() ? [{ log, parsed }] : []; }
    catch { return []; }
  });
  assert.equal(logs.length, 1, "one original Core event for this pool required");
  const { log, parsed } = logs[0]; assert(same(parsed.locker, EKUBO_ROUTER));
  const calls = successfulFrames(trace).flatMap(frame => {
    if (!same(frame.to ?? "", EKUBO_ROUTER)) return [];
    const selector = frame.input?.slice(0, 10), abi = selector === NO_RECEIVER_SELECTOR ? NO_RECEIVER : ekuboRouterIface;
    if (selector !== abi.getFunction("swap")!.selector) return [];
    const data = abi.decodeFunctionData("swap", frame.input);
    const key = { token0: String(data[0][0]), token1: String(data[0][1]), config: String(data[0][2]) };
    return same(ekuboPoolId(key), instance) ? [{ frame, abi, data }] : [];
  });
  assert.equal(calls.length, 1, "one direct full-input original Router swap required; multihop not inferred");
  const { frame, abi, data } = calls[0];
  const update = decodeEkuboBalanceUpdate(String(abi.decodeFunctionResult("swap", frame.output)[0]));
  assert.equal(update.delta0, parsed.delta0); assert.equal(update.delta1, parsed.delta1);
  const isToken1 = Boolean(data[1]);
  const amountIn = isToken1 ? parsed.delta1 : parsed.delta0, amountOut = -(isToken1 ? parsed.delta0 : parsed.delta1);
  assert(amountIn > 0n && amountOut > 0n && BigInt(data[2]) === amountIn);
  assert.equal(BigInt(data[3]), 0n); assert.equal(BigInt(data[4]), 0n);
  const rawIn = isToken1 ? descriptor.poolKey.token1 : descriptor.poolKey.token0;
  const rawOut = isToken1 ? descriptor.poolKey.token0 : descriptor.poolKey.token1;
  const recipient = data.length === 7 ? String(data[6]) : frame.from;
  const swapFrames = successfulFrames(frame);
  const paidByEkubo = (from: string) => [EKUBO_CORE, EKUBO_ROUTER].some(a => same(from, a));
  if (same(rawOut, ethers.ZeroAddress)) {
    assert.equal(swapFrames.filter(f => same(f.to ?? "", recipient) && paidByEkubo(f.from ?? "") && BigInt(f.value ?? 0) === amountOut).length, 1,
      "original native output transfer is missing/ambiguous");
  } else {
    const payments = swapFrames.filter(f => {
      if (!same(f.to ?? "", rawOut) || !paidByEkubo(f.from ?? "") || f.input?.slice(0, 10) !== transfer.getFunction("transfer")!.selector) return false;
      const [to, value] = transfer.decodeFunctionData("transfer", f.input);
      return same(to, recipient) && BigInt(value) === amountOut;
    });
    assert.equal(payments.length, 1, "selected swap token output transfer is missing/ambiguous");
    const received = receipt.logs.filter((l: any) => same(l.address, rawOut) && l.topics[0] === transfer.getEvent("Transfer")!.topicHash)
      .map((l: any) => transfer.parseLog(l)!.args)
      .filter((a: any) => same(a.from, payments[0]!.from) && same(a.to, recipient) && a.value === amountOut);
    assert.equal(received.length, 1, "original token output receipt is missing/ambiguous");
  }
  return { tokenIn: ekuboGraphToken(rawIn).toLowerCase(), tokenOut: ekuboGraphToken(rawOut).toLowerCase(), amountIn, amountOut,
    caller: frame.from.toLowerCase(), recipient: recipient.toLowerCase(), logIndex: log.logIndex,
    originalInterface: abi.getFunction("swap")!.format("sighash"),
    comparison: "receipt plus successful Router return; graph WETH maps raw native ETH; N-end is NOT original pre-call state" };
}
