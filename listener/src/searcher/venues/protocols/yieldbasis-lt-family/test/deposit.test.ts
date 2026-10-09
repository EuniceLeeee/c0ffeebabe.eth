import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { balancedDepositDebt, decodeDepositBalances, decodeDepositReceipt, depositBalanceRequests,
  depositProgram, depositSimulation, depositProgramSimulation, decodeDepositProgramReceipt, DEPOSIT_REQUIREMENTS } from "../deposit.js";
import { buildSubscriptCalldata } from "../../../../../shared/executor/botvm-program-entry.js";
import { runtimeProgramScript } from "../../../../../adapters/runtime-amount-program.js";
import { declareRequestProgram, type AdapterRequestResult } from "../../../adapter-request-program.js";
import { LT_INTERFACE } from "../abi.js";

const addr = (n: number) => ethers.getAddress(ethers.toBeHex(n, 20));
const s = { lt: addr(1), asset: addr(2), stablecoin: addr(3), cryptopool: addr(4), amm: addr(5) };
const actor = addr(6), source = { number: 100, hash: ethers.toBeHex(7, 32), generation: 1 };
const assets = 37n, shares = 71n;
function receipt(): any {
  const e = LT_INTERFACE.encodeEventLog(LT_INTERFACE.getEvent("Deposit")!, [actor, actor, assets, shares]);
  return { id: "deposit", ok: true, completion: "returned", source,
    provenance: { kind: "synthetic-yb-deposit", fingerprint: "fixture-not-chain" },
    data: LT_INTERFACE.encodeFunctionResult("deposit(uint256,uint256,uint256)", [shares]),
    effects: { tokenDeltas: [
      { token: s.asset, account: actor, delta: -assets }, { token: s.lt, account: actor, delta: shares },
      { token: s.stablecoin, account: actor, delta: 0n },
    ], nativeDeltas: [{ account: actor, before: 0n, after: 0n, delta: 0n }],
    logs: [{ address: s.lt, ...e }] } };
}
test("balanced debt uses raw reserves, checked uint256 intermediates and no decimal/price guess", () => {
  assert.equal(balancedDepositDebt(3n, { stable: 101n, asset: 10n }), 30n);
  assert.equal(balancedDepositDebt(10n ** 8n, { stable: 2n * 10n ** 24n, asset: 10n ** 10n }), 2n * 10n ** 22n);
  for (const args of [[0n, 1n, 1n], [1n, 0n, 1n], [1n, 1n, 0n], [1n, 1n, 2n],
    [ethers.MaxUint256, 2n, 3n], [-1n, 1n, 1n], [ethers.MaxUint256 + 1n, 1n, 1n]]) {
    assert.throws(() => balancedDepositDebt(args[0]!, { stable: args[1]!, asset: args[2]! }));
  }
});
test("deposit simulation declares central caller and funds only caller asset, never protocol stablecoin", () => {
  const request = depositSimulation("deposit", s, assets, 100n);
  assert.equal(request.kind, "effect-delta-simulation");
  if (request.kind !== "effect-delta-simulation") throw new Error("wrong request");
  assert.deepEqual(request.overrideIntent.tokenBalances, [{ token: s.asset, amount: assets }]);
  assert.equal(request.preCalls?.length, 2);
  assert(request.preCalls!.every(c => c.to === s.asset));
  // Run real declaration validation, including effect scope and caller authority.
  declareRequestProgram({ requirements: () => DEPOSIT_REQUIREMENTS,
    buildRequests: () => [request], decode: ({ results }: any) => results }, undefined);
  assert.equal(decodeDepositReceipt([receipt()], "deposit", s, source, actor, assets), shares);
  assert.equal(decodeDepositReceipt([receipt()], "deposit", s, source, undefined, assets), shares);
});
test("receipt binds full input, actual mint, stable/native inventory, event and source", () => {
  const bad: ((r: any) => void)[] = [
    r => { r.source = { ...source, generation: 2 }; },
    r => { r.effects.tokenDeltas[0].delta += 1n; },
    r => { r.effects.tokenDeltas[0].delta -= 1n; },
    r => { r.effects.tokenDeltas[1].delta -= 1n; },
    r => { r.effects.tokenDeltas[2].delta = -1n; },
    r => { r.effects.tokenDeltas[2].delta = 1n; },
    r => { r.effects.tokenDeltas[0].account = addr(7); },
    r => { r.effects.tokenDeltas.push({ ...r.effects.tokenDeltas[1] }); },
    r => { r.effects.nativeDeltas[0].delta = 1n; },
    r => { r.effects.nativeDeltas = []; },
    r => { r.effects.logs = []; },
    r => { r.effects.logs.push(r.effects.logs[0]); },
    r => { r.effects.logs[0].address = addr(7); },
    r => { r.data = "0x"; },
  ];
  for (const mutate of bad) { const r = receipt(); mutate(r); assert.throws(() => decodeDepositReceipt([r], "deposit", s, source, actor, assets)); }
  assert.throws(() => decodeDepositReceipt([receipt()], "deposit", s, source, addr(7), assets));
  // Staker rebase can change total supply independently from this user's mint.
  const r = receipt(); r.effects.totalSupplyDeltas = [{ token: s.lt, delta: shares + 19n }];
  assert.equal(decodeDepositReceipt([r], "deposit", s, source, actor, assets), shares);
});
test("reserve evidence rejects failed, stale and zero values; runtime emitter is amount-free", () => {
  const requests = depositBalanceRequests(s, "reserves");
  assert.equal(requests.length, 2);
  const results = requests.map((r, i) => ({ ...receipt(), id: r.id, effects: undefined,
    data: ethers.toBeHex(i === 0 ? 100n : 5n, 32) })) as AdapterRequestResult[];
  assert.deepEqual(decodeDepositBalances(results, "reserves", source), { stable: 100n, asset: 5n });
  assert.throws(() => decodeDepositBalances([], "reserves", source));
  assert.throws(() => decodeDepositBalances(results, "reserves", { ...source, number: 101 }));
  const bytes = depositProgram(s, actor).bytes();
  assert(bytes.length > 0 && bytes.length < 65536);
  assert.throws(() => depositProgram(s, s.amm));
  assert.throws(() => depositProgram({ ...s, asset: s.stablecoin }, actor));
  assert.throws(() => depositProgram(s, actor, { quotedDebt: 0n }));
  assert.throws(() => depositProgram(s, actor, { minimumShares: 0n }));
});

test("full-program quote uses the same emitted program, no raw preCalls or chain-supplied code", () => {
  const r = depositProgramSimulation("deposit", s, actor, assets);
  if (r.kind !== "effect-delta-simulation") throw new Error("wrong request");
  assert.equal(r.call.executionMode, "executor-program"); assert.equal(r.call.to, actor);
  assert.equal(r.call.data, buildSubscriptCalldata(runtimeProgramScript(depositProgram(s, actor).bytes(), assets)));
  assert.equal(r.preCalls, undefined); assert.equal("executorRuntimeCode" in r, false);
  assert.deepEqual(r.overrideIntent, { caller: { kind: "executor" }, tokenBalances: [{ token: s.asset, amount: assets }] });
  declareRequestProgram({ requirements: () => DEPOSIT_REQUIREMENTS,
    buildRequests: () => [r], decode: ({ results }: any) => results }, undefined);
  const proof = receipt(); proof.data = "0x";
  assert.equal(decodeDepositProgramReceipt([proof], "deposit", s, source, actor, assets), shares);
  assert.throws(() => decodeDepositProgramReceipt([receipt()], "deposit", s, source, actor, assets), /unexpected data/);
  proof.effects.tokenDeltas[1].delta--;
  assert.throws(() => decodeDepositProgramReceipt([proof], "deposit", s, source, actor, assets), /event\/effect/);
});
