// Synthetic negative controls, separate from the CLI's pinned real evidence.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { LT_INTERFACE as LT } from "../../../venues/protocols/yieldbasis-lt-family/abi.js";
import { CTOKEN_INTERFACE as CT } from "../../../venues/protocols/compound-ctoken-family/abi.js";
import { ERC20 } from "./evidence.js";
import { observeYbInput, observeCompoundInput, successfulFrames } from "./historical-input-origin.js";
const a = (n: number) => ethers.getAddress(ethers.toBeHex(n, 20));
const user = a(1), lt = a(2), asset = a(3), stable = a(4), amm = a(5), ct = a(6), wrapper = a(7);
const token = new ethers.Interface(["function transferFrom(address from,address to,uint256 amount) returns(bool)",
  "function transfer(address to,uint256 amount) returns(bool)"]);
const event = (abi: ethers.Interface, name: string, args: unknown[], address: string, index: number) =>
  ({ address, ...abi.encodeEventLog(abi.getEvent(name)!, args), logIndex: ethers.toQuantity(index) });
const transfer = (t: string, from: string, to: string, value: bigint, i: number) => event(ERC20, "Transfer", [from, to, value], t, i);
const call = (abi: ethers.Interface, name: string, args: unknown[], result: unknown[], from: string, to: string, calls: any[] = []) =>
  ({ type: "CALL", from, to, input: abi.encodeFunctionData(name, args), output: abi.encodeFunctionResult(name, result), calls });
function yb() {
  const deposit = call(LT, "deposit(uint256,uint256,uint256)", [17n, 23n, 16n], [19n], user, lt, [
    call(token, "transferFrom", [amm, lt, 23n], [true], lt, stable),
    call(token, "transferFrom", [user, lt, 17n], [true], lt, asset),
  ]);
  return { receipt: { logs: [transfer(stable, amm, lt, 23n, 1), transfer(asset, user, lt, 17n, 2),
    transfer(lt, ethers.ZeroAddress, user, 19n, 3), event(LT, "Deposit", [user, user, 17n, 19n], lt, 4),
    transfer(asset, lt, user, 21n, 5), event(LT, "Withdraw", [user, user, user, 21n, 19n], lt, 6)] },
    trace: { type: "CALL", from: a(8), to: user, calls: [deposit,
      call(LT, "withdraw(uint256,uint256)", [19n, 0n], [21n], user, lt)] } };
}
test("YB external caller pays one asset; protocol stablecoins are not a second caller input", () => {
  const x = yb(), r = observeYbInput(x.receipt, x.trace, lt, asset);
  assert.equal(r.assetInput.from, user.toLowerCase()); assert.equal(r.protocolStableInput.from, amm.toLowerCase());
  assert.equal(r.mintedAndWithdrawnShares, 19n);
});
test("YB requires actual input receipts, share mint and ordered deposit/withdraw amounts", () => {
  for (const mutate of [
    (x: ReturnType<typeof yb>) => { x.receipt.logs.splice(0, 1); },
    (x: ReturnType<typeof yb>) => { x.receipt.logs[2] = transfer(lt, amm, user, 19n, 3); },
    (x: ReturnType<typeof yb>) => { x.receipt.logs[3].logIndex = "0x7"; },
    (x: ReturnType<typeof yb>) => { x.trace.calls[0].calls[0] = call(token, "transferFrom", [user, lt, 23n], [true], lt, stable); },
    (x: ReturnType<typeof yb>) => { x.trace.calls[0].calls[0].output = token.encodeFunctionResult("transferFrom", [false]); },
    (x: ReturnType<typeof yb>) => { x.trace.calls.push(x.trace.calls[0]); },
    (x: ReturnType<typeof yb>) => { x.trace.calls[0].output = LT.encodeFunctionResult("deposit(uint256,uint256,uint256)", [20n]); },
  ]) { const x = yb(); mutate(x); assert.throws(() => observeYbInput(x.receipt, x.trace, lt, asset)); }
});
test("failed ancestors and DELEGATECALL are never new successful external call evidence", () => {
  const x = yb();
  assert.equal(successfulFrames({ error: "reverted", calls: [x.trace] }).length, 0);
  assert.equal(successfulFrames({ type: "DELEGATECALL", from: lt, to: amm }).length, 0);
  assert.throws(() => observeYbInput(x.receipt, { calls: [{ error: "reverted", calls: [x.trace] }] }, lt, asset));
});
function compound() {
  const redeem = call(CT, "redeemUnderlying", [31n], [0n], wrapper, ct);
  const parent = { type: "CALL", from: user, to: wrapper, input: "0x27b25fa9" + ethers.toBeHex(13n, 32).slice(2),
    calls: [redeem, call(token, "transfer", [user, 31n], [true], wrapper, asset)] };
  return { receipt: { logs: [transfer(wrapper, a(9), user, 12n, 1), transfer(wrapper, user, ethers.ZeroAddress, 13n, 2),
    transfer(asset, ct, wrapper, 31n, 3), event(CT, "Redeem", [wrapper, 31n, 29n], ct, 4),
    transfer(asset, wrapper, user, 31n, 5)] }, trace: { type: "CALL", from: a(8), to: user, calls: [parent] } };
}
test("nested Compound caller owns cTokens; wrapper share input is separate and any inventory delta stays visible", () => {
  const x = compound(), r = observeCompoundInput(x.receipt, x.trace, [{ share: ct, underlying: asset }])[0];
  assert.equal(r.redeemer, wrapper.toLowerCase()); assert.equal(r.searcherCTokenTransfers, 0);
  assert.equal(r.cTokenSharesBurned, 29n); assert.equal(r.wrapperSharesBurned, 13n);
  assert.equal(r.unaccountedWrapperShareInput, 1n);
});
test("nested Compound attribution rejects siblings, missing forwarded receipt, cToken user input and error codes", () => {
  for (const mutate of [
    (x: ReturnType<typeof compound>) => { x.trace.calls[0].from = a(9); },
    (x: ReturnType<typeof compound>) => { x.receipt.logs.pop(); },
    (x: ReturnType<typeof compound>) => { x.receipt.logs.push(transfer(ct, a(9), user, 29n, 6)); },
    (x: ReturnType<typeof compound>) => { x.trace.calls[0].calls[0].output = CT.encodeFunctionResult("redeemUnderlying", [2n]); },
  ]) { const x = compound(); mutate(x); assert.throws(() => observeCompoundInput(x.receipt, x.trace, [{ share: ct, underlying: asset }])); }
});
