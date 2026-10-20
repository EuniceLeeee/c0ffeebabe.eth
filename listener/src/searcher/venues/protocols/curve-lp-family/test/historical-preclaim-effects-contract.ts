import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { PRECLAIM, feeWitness, preclaimScope, assertPreclaimEffects } from "./historical-preclaim-effects.js";
import type { ObservedEffects } from "../../../adapter-request-program.js";

const addr = (n: number) => ethers.toBeHex(n, 20), pool = addr(3801), coins = [addr(3802), addr(3803)], executor = addr(3804), owner = addr(3805), factory = addr(3806), feeReceiver = addr(3807);
const source = { number: 26202387, hash: ethers.id("preclaim-observer-contract"), generation: 1 }, word = (a: string) => ethers.zeroPadValue(a, 32);
function fixture(external = false, fees = [7n, 11n], admin = feeReceiver) {
  const recipient = external ? owner : executor, witness = feeWitness(source, pool, factory, word(admin), word(admin)), amountIn = 100n, output = 123n;
  const i = { source, pool, lp: pool, coins, executor, owner, recipient, index: 1, amountIn, witness };
  const tokenDeltas = preclaimScope([...coins, pool], [executor, owner, pool, admin]).map(v => ({ ...v, delta: 0n }));
  const change = (token: string, account: string, amount: bigint) => { tokenDeltas.find(v => v.token === token && v.account === account)!.delta += amount; };
  change(pool, executor, -amountIn); change(coins[1]!, recipient, output);
  for (let j = 0; j < 2; j++) { change(coins[j]!, pool, -fees[j]! - (j === 1 ? output : 0n)); change(coins[j]!, admin, fees[j]!); }
  const emit = (token: string, name: string, values: unknown[]) => ({ address: token, ...PRECLAIM.encodeEventLog(PRECLAIM.getEvent(name)!, values) });
  const logs = [emit(pool, "Transfer", [executor, ethers.ZeroAddress, amountIn]), emit(coins[1]!, "Transfer", [pool, recipient, output])];
  if (fees.some(n => n !== 0n)) logs.push(...coins.map((c, j) => emit(c, "Transfer", [pool, admin, fees[j]])), emit(pool, "ClaimAdminFee", [admin, fees]));
  const effects: ObservedEffects = { tokenDeltas, totalSupplyDeltas: [{ token: pool, delta: -amountIn }], nativeDeltas: [{ account: executor, delta: 0n }], logs };
  return { i, effects, output, emit };
}
test("independent oracle accepts actual fee-bearing receipts for both recipients and requires the complete matrix", () => {
  for (const external of [false, true]) { const f = fixture(external), r = assertPreclaimEffects(f.i, f.effects); assert.equal(r.actualReceipt, 123n); assert.equal(r.actualDebit, 100n); assert.deepEqual(r.adminTokens, [7n, 11n]); assert.equal(r.expectedMatrix.length, 12); }
  const none = fixture(false, [0n, 0n]); assert.equal(assertPreclaimEffects(none.i, none.effects).claimPresent, false);
  const zero = fixture(false, [0n, 0n], ethers.ZeroAddress); assert.equal(assertPreclaimEffects(zero.i, zero.effects).claimPresent, false);
});
test("scope deduplicates real account aliases without missing balances; fee/output aliases remain unsafe", () => {
  const f = fixture(false, [7n, 11n], owner); assert.equal(assertPreclaimEffects(f.i, f.effects).expectedMatrix.length, 9);
  const ambiguous = fixture(true, [7n, 11n], owner); assert.throws(() => assertPreclaimEffects(ambiguous.i, ambiguous.effects), /ambiguous/);
});
test("source witness requires canonical addresses, matching factory/pool getters and exact source", () => {
  assert.throws(() => feeWitness(source, pool, factory, word(feeReceiver), word(owner)));
  assert.throws(() => feeWitness(source, pool, factory, word(feeReceiver) + "00", word(feeReceiver)));
  const f = fixture(); assert.throws(() => assertPreclaimEffects({ ...f.i, source: { ...source, generation: 2 } }, f.effects));
});
test("missing, duplicate, wrong-admin, wrong-fee and noncanonical ClaimAdminFee events cannot authenticate a receipt", () => {
  const f = fixture(), topic = PRECLAIM.getEvent("ClaimAdminFee")!.topicHash, c = f.effects.logs!.find(v => v.topics[0] === topic)!;
  for (const logs of [f.effects.logs!.filter(v => v !== c), [...f.effects.logs!, c], f.effects.logs!.map(v => v === c ? f.emit(pool, "ClaimAdminFee", [owner, [7n, 11n]]) : v),
    f.effects.logs!.map(v => v === c ? f.emit(pool, "ClaimAdminFee", [feeReceiver, [7n, 12n]]) : v), f.effects.logs!.map(v => v === c ? { ...v, data: v.data + "00".repeat(32) } : v)])
    assert.throws(() => assertPreclaimEffects(f.i, { ...f.effects, logs }));
});
test("independent balances detect incomplete input debit, short fees/output, excess pool debit and old actor/owner/fee LP inventory use", () => {
  const f = fixture();
  for (const [token, account, change] of [[pool, executor, 1n], [coins[1]!, feeReceiver, -1n], [coins[1]!, executor, -1n], [coins[0]!, pool, -1n],
    [coins[0]!, executor, -1n], [coins[0]!, owner, -1n], [pool, feeReceiver, -1n], [pool, pool, -1n]] as const) {
    const tokenDeltas = f.effects.tokenDeltas!.map(v => v.token === token && v.account === account ? { ...v, delta: v.delta + change } : v);
    assert.throws(() => assertPreclaimEffects(f.i, { ...f.effects, tokenDeltas }));
  }
  assert.throws(() => assertPreclaimEffects(f.i, { ...f.effects, tokenDeltas: f.effects.tokenDeltas!.slice(1) }));
  assert.throws(() => assertPreclaimEffects(f.i, { ...f.effects, tokenDeltas: [...f.effects.tokenDeltas!, f.effects.tokenDeltas![0]!] }));
});
test("extra hidden transfers and LP admin mint cannot be netted away by equal aggregate deltas", () => {
  const f = fixture(), stranger = addr(3899), lpMint = f.emit(pool, "Transfer", [ethers.ZeroAddress, feeReceiver, 1n]);
  const roundTrip = [f.emit(coins[0]!, "Transfer", [pool, stranger, 1n]), f.emit(coins[0]!, "Transfer", [stranger, pool, 1n])];
  for (const logs of [[...f.effects.logs!, ...roundTrip], [...f.effects.logs!, lpMint], f.effects.logs!.filter(l => l.address !== pool)])
    assert.throws(() => assertPreclaimEffects(f.i, { ...f.effects, logs }));
  assert.throws(() => assertPreclaimEffects(f.i, { ...f.effects, totalSupplyDeltas: [{ token: pool, delta: -99n }] }));
  assert.throws(() => assertPreclaimEffects(f.i, { ...f.effects, nativeDeltas: [{ account: executor, delta: -1n }] }));
});
