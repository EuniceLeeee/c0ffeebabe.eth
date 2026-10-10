import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { SAT1_SAMPLE as S, SAT1_INSTANCE as SI, V4_OBSERVATION_ABI as ABI, assertSat1Receipt, originalV4Leg } from "./history-evidence.js";

const manager = "0x000000000004444c5dc75cb358380d2e3de08a90";
const token = "0x8f66337a0c2a02202fd91dd596c411cf977c6060";
const hook = "0x2a0a30dd78af7698e6f40212b8b8324fce2ee888";
const caller = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const descriptor = { poolId: S.poolId, poolKey: { currency0: ethers.ZeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: hook }, managerBinding: { manager } };
const call = (from: string, to: string, name: string, args: unknown[], result?: unknown[]) => ({ type: "CALL", from, to,
  input: ABI.encodeFunctionData(name, args), output: result ? ABI.encodeFunctionResult(name, result) : "0x", value: "0x0", calls: [] as any[] });
function fixture(buy = true) {
  const input = 123n, output = 456n;
  const ds = buy ? [-input, output] : [output, -input];
  const packed = BigInt.asIntN(256, (BigInt.asUintN(128, ds[0]) << 128n) | BigInt.asUintN(128, ds[1]));
  const swap = call(caller, manager, "swap", [Object.values(descriptor.poolKey), [buy, -input, 1n], "0x"], [packed]);
  const settle = call(caller, manager, "settle", [], [input]);
  const sync = call(caller, manager, "sync", [token]);
  const balanceRead = (amount: bigint) => ({ ...call(manager, token, "balanceOf", [manager], [amount]), type: "STATICCALL" });
  const take = call(caller, manager, "take", [buy ? token : ethers.ZeroAddress, recipient, output]);
  const transfer = call(buy ? manager : caller, token, "transfer", [buy ? recipient : manager, buy ? output : input], [true]);
  if (buy) { settle.value = ethers.toQuantity(input); take.calls.push(transfer); }
  else { take.calls.push({ type: "CALL", from: manager, to: recipient, value: ethers.toQuantity(output), input: "0x", output: "0x" });
    sync.calls.push(balanceRead(1000n)); settle.calls.push(balanceRead(1000n + input)); }
  const unlock = call(caller, manager, "unlock", ["0x"], ["0x"]);
  unlock.calls = [...(buy ? [] : [sync, transfer]), settle, swap, take];
  const trace = { type: "CALL", from: recipient, to: caller, calls: [unlock] };
  const log = (address: string, event: string, args: unknown[]) => ({ address, ...ABI.encodeEventLog(ABI.getEvent(event)!, args),
    transactionHash: S.tx, blockHash: S.hash, blockNumber: ethers.toQuantity(S.block), removed: false });
  const receipt = { transactionHash: S.tx, blockHash: S.hash, blockNumber: ethers.toQuantity(S.block), status: "0x1",
    logs: [log(manager, "Swap", [S.poolId, caller, 0, 0, 1, 0, 0, 3000]),
      log(token, "Transfer", [buy ? manager : caller, buy ? recipient : manager, buy ? output : input])] };
  return { trace, receipt, swap, settle, take, unlock, transfer, sync };
}
for (const buy of [true, false]) {
  const observe = (f: ReturnType<typeof fixture>) => originalV4Leg(SI, descriptor, f.receipt, f.trace, buy);
  test(`custom-delta zero Swap events use actual payment: buy=${buy}`, () => {
    const f = fixture(buy); assertSat1Receipt(f.receipt);
    const result = observe(f); assert.equal(result.amountIn, 123n); assert.equal(result.amountOut, 456n);
    assert.equal(result.caller, caller); assert.equal(result.recipient, recipient);
  });
  const invalid: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ["failed ancestor", f => Object.assign(f.unlock, { error: "reverted" })],
    ["failed swap", f => Object.assign(f.swap, { error: "reverted" })],
    ["duplicate swap", f => f.unlock.calls.push(structuredClone(f.swap))],
    ["duplicate take", f => f.unlock.calls.push(structuredClone(f.take))],
    ["unbound take caller", f => f.take.from = recipient],
    ["unbound settlement caller", f => f.settle.from = recipient],
    ["wrong settle debit", f => f.settle.output = ABI.encodeFunctionResult("settle", [124n])],
    ["partial fill", f => f.swap.input = ABI.encodeFunctionData("swap", [Object.values(descriptor.poolKey), [buy, -124n, 1n], "0x"])],
    ["opposite direction", f => f.swap.input = ABI.encodeFunctionData("swap", [Object.values(descriptor.poolKey), [!buy, -123n, 1n], "0x"])],
    ["missing actual payment", f => f.take.calls = []],
    ["failed transfer", f => f.transfer.output = ABI.encodeFunctionResult("transfer", [false])],
    ["missing transfer log", f => f.receipt.logs.pop()],
    ["nested take payment borrowed", f => { const nested = call(caller, manager, "take", [buy ? token : ethers.ZeroAddress, recipient, 1n]);
      nested.calls = f.take.calls; f.take.calls = [nested]; }],
    ["take inside swap not after swap return", f => { f.unlock.calls.pop(); f.swap.calls.push(f.take); }],
  ];
  for (const [name, mutate] of invalid) test(`reject ${name}: buy=${buy}`, () => {
    const f = fixture(buy); mutate(f); assert.throws(() => observe(f));
  });
}
test("ERC20 settlement requires current currency and exact actual balance increase", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.sync.input = ABI.encodeFunctionData("sync", [recipient]),
    (f: ReturnType<typeof fixture>) => f.sync.calls = [],
    (f: ReturnType<typeof fixture>) => f.settle.calls = [],
    (f: ReturnType<typeof fixture>) => f.settle.calls[0].output = ABI.encodeFunctionResult("balanceOf", [1122n]),
    (f: ReturnType<typeof fixture>) => f.settle.calls[0].to = recipient,
    (f: ReturnType<typeof fixture>) => f.unlock.calls.splice(2, 0, call(recipient, manager, "sync", [recipient])),
    (f: ReturnType<typeof fixture>) => f.unlock.calls.splice(2, 0, call(recipient, manager, "settle", [], [1n])),
    (f: ReturnType<typeof fixture>) => f.unlock.calls.splice(2, 0, call(recipient, manager, "settleFor", [recipient], [1n])),
  ]) { const f = fixture(false); mutate(f); assert.throws(() => originalV4Leg(SI, descriptor, f.receipt, f.trace, false)); }
});
test("receipt source and removal are bound", () => {
  for (const mutate of [
    (r: any) => r.blockNumber = "0x1", (r: any) => r.transactionHash = ethers.ZeroHash,
    (r: any) => r.blockHash = ethers.ZeroHash, (r: any) => r.logs[0].removed = true,
    (r: any) => r.logs[0].blockHash = ethers.ZeroHash, (r: any) => r.status = "0x0",
  ]) { const f = fixture(); mutate(f.receipt); assert.throws(() => assertSat1Receipt(f.receipt)); }
});
test("pool key and manager are independently bound", () => {
  const f = fixture();
  for (const d of [{ ...descriptor, managerBinding: { manager: recipient } },
    { ...descriptor, poolKey: { ...descriptor.poolKey, fee: 500 } }])
    assert.throws(() => originalV4Leg(SI, d, f.receipt, f.trace, true));
  assert.throws(() => originalV4Leg(S.poolId, descriptor, f.receipt, f.trace, true), /manager plus poolId/);
});
