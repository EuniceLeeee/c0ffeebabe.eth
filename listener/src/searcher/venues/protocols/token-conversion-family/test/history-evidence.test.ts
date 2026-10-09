import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { XWIN_ABI } from "../xwin.js";
import { originalXwinLeg } from "./history-evidence.js";
const actor = "0x1000000000000000000000000000000000000001";
const target = "0x1000000000000000000000000000000000000002";
const asset = "0x1000000000000000000000000000000000000003";
const wrong = "0x1000000000000000000000000000000000000004";
const ERC20 = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)",
  "function transfer(address,uint256) returns(bool)", "function transferFrom(address,address,uint256) returns(bool)"]);
function fixture(mint: boolean) {
  const event = (token: string, from: string, to: string, n: bigint) => ({ address: token,
    ...ERC20.encodeEventLog(ERC20.getEvent("Transfer")!, [from, to, n]), logIndex: "0x1" });
  const method = mint ? "deposit" : "withdraw", transfer = mint ? "transferFrom" : "transfer";
  const payment = { type: "CALL", from: target, to: asset,
    input: ERC20.encodeFunctionData(transfer, mint ? [actor, target, 17n] : [actor, 19n]),
    output: ERC20.encodeFunctionResult(transfer, [true]),
    logs: [event(asset, mint ? actor : target, mint ? target : actor, mint ? 17n : 19n)] };
  const selected = { type: "CALL", from: actor, to: target, input: XWIN_ABI.encodeFunctionData(method, [17n, mint ? 0 : 100]),
    output: XWIN_ABI.encodeFunctionResult(method, [19n]), calls: [payment],
    logs: [event(target, mint ? ethers.ZeroAddress : actor, mint ? actor : ethers.ZeroAddress, mint ? 19n : 17n)] };
  return { descriptor: { variant: "xwin-allocations-v1", target, asset },
    receipt: { logs: [event(target, mint ? ethers.ZeroAddress : actor, mint ? actor : ethers.ZeroAddress, mint ? 19n : 17n),
      event(asset, mint ? actor : target, mint ? target : actor, mint ? 17n : 19n)] },
    trace: { type: "CALL", calls: [selected] }, selected, payment };
}
for (const mint of [true, false]) {
  const run = (f: ReturnType<typeof fixture>) => originalXwinLeg(target, f.descriptor, f.receipt, f.trace, mint ? "mint" : "redeem");
  test(`xWin ${mint ? "mint" : "redeem"}: observe original input/output/slippage, not quote`, () => {
    const r = run(fixture(mint));
    assert.equal(r.amountIn, 17n); assert.equal(r.amountOut, 19n);
    assert.equal(r.originalSlippage, mint ? 0n : 100n);
    assert.match(r.comparison, /NOT original pre-call/);
  });
  test(`xWin ${mint ? "mint" : "redeem"}: refuse unbound, reverted and sibling evidence`, () => {
    const mutations = [
      (f: any) => { f.trace.error = "reverted"; },
      (f: any) => { f.selected.error = "reverted"; },
      (f: any) => { f.payment.error = "reverted"; },
      (f: any) => { f.payment.from = wrong; },
      (f: any) => { f.payment.output = ERC20.encodeFunctionResult(mint ? "transferFrom" : "transfer", [false]); },
      (f: any) => { f.selected.calls = []; f.trace.calls.push(f.payment); },
      (f: any) => { f.selected.calls.push(f.payment); },
      (f: any) => { f.trace.calls.push(f.selected); },
      (f: any) => { f.receipt.logs.pop(); },
      (f: any) => { f.receipt.logs[0].removed = true; },
      (f: any) => { f.receipt.logs[1].topics[1] = ethers.zeroPadValue(wrong, 32); },
      (f: any) => { f.receipt.logs.push(f.receipt.logs[1]); },
      (f: any) => { f.descriptor.target = wrong; },
      (f: any) => { f.trace.logs = f.selected.logs; f.selected.logs = []; },
      (f: any) => { f.trace.logs = f.payment.logs; f.payment.logs = []; },
      (f: any) => { f.selected.logs.push(...f.payment.logs); f.payment.logs = []; },
      (f: any) => { f.selected.calls.push({ error: "reverted", logs: f.selected.logs }); f.selected.logs = []; },
    ];
    for (const mutate of mutations) { const f = fixture(mint); mutate(f); assert.throws(() => run(f)); }
  });
}
