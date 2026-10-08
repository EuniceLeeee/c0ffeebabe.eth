import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/badger-sett-withdraw.production.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { VAULT, TOKEN, MAX, WAD } from "../codec.js";
import { withdrawProgram } from "../execution.js";
import { actor, original, fixture, descriptor, input, dataFor } from "./fixture.js";
import type { Fixture } from "./fixture.js";
// Independent VM instruction interpretation + a small native-call fixture.
// This is NOT EVM execution, original TX replay, historical parity, or live acceptance.
function run(f: Fixture, amount: bigint, options: { short?: bigint; bonus?: bigint; extraBurn?: bigint; minimum?: bigint } = {}) {
  const d = descriptor(f), beforeShares = f.shares, beforeAura = f.aura;
  let calls = 0;
  const result = inspectRuntime(ethers.hexlify(withdrawProgram(d, actor, options.minimum).bytes()), amount, { call(c) {
    assert.equal(c.value, 0n); assert.equal(c.incoming, 0); assert.equal(c.outgoing, 0);
    if (c.target.toLowerCase() === d.vault && c.data.startsWith(VAULT.getFunction("withdraw")!.selector)) {
      assert.equal(c.static, false); assert.deepEqual(c.patches, [{ offset: 4, reg: 0 }]);
      const q = VAULT.decodeFunctionData("withdraw", c.data)[0]; assert.equal(q, amount);
      const s = f.state;
      assert(!s.vaultPaused && q > 0n && q <= f.shares && q <= s.supply, "native eligibility");
      const b = s.vaultIdle + s.strategyIdle + s.locked, gross = b * q / s.supply;
      const needed = gross > s.vaultIdle ? gross - s.vaultIdle : 0n;
      if (needed) { assert(!s.strategyPaused, "native strategy pause"); assert(needed <= s.strategyIdle, "unsupported unlock must be guarded before call"); }
      const fee = gross * s.feeBps / 10000n, out = gross - fee, postSupply = s.supply - q;
      const feeShares = fee ? postSupply ? fee * postSupply / (b - gross) : fee : 0n;
      if (feeShares) assert.notEqual(s.treasury, ethers.ZeroAddress);
      f.shares -= q + (options.extraBurn ?? 0n);
      if (s.treasury === actor) f.shares += feeShares;
      f.aura += out - (options.short ?? 0n) + (options.bonus ?? 0n);
      f.state = { ...s, supply: postSupply + feeShares, vaultIdle: s.vaultIdle + needed - out, strategyIdle: s.strategyIdle - needed };
      calls++; return "0x";
    }
    assert(c.static, "only one native mutation"); return dataFor(f, c.target, c.data);
  } });
  assert.equal(calls, 1); assert.equal(result.allowances.length, 0); assert.equal(result.registers[0], amount);
  return { result, burned: beforeShares - f.shares, receipt: f.aura - beforeAura, oldAura: beforeAura };
}
test("runtime construction precedes Exact and has zero offchain amount/quote/provider access", () => {
  const i = input();
  for (const key of ["amountIn", "quotedAmountOut", "minAmountOut", "exactEvidence", "quote", "provider", "rpc"])
    Object.defineProperty(i, key, { get() { throw new Error("forbidden offchain " + key); } });
  const leg = plugin.execution.buildRuntimeLeg!(i); assert(leg);
  assert.equal(leg.program, ethers.hexlify(withdrawProgram(i.descriptor, actor).bytes()));
  assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...input(), route: { ...input().route, tokenOut: actor } }), /route binding/);
  for (const executor of [original.vault, original.strategy, original.vaultAdmin, original.strategyAdmin, original.asset, ethers.ZeroAddress])
    assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...input(), executor }), /executor|zero address/);
});
test("runtime uses actual current shares in vault-only, strategy-liquid, full-supply and fee branches", () => {
  for (const amount of [19n, WAD, 12000n * WAD, fixture().state.supply]) {
    for (const feeBps of [0n, 200n]) {
      const f = fixture(); f.state = { ...f.state, feeBps };
      const b = f.state.vaultIdle + f.state.strategyIdle + f.state.locked;
      const gross = b * amount / f.state.supply;
      const expected = gross - gross * feeBps / 10000n;
      const r = run(f, amount); assert.equal(r.burned, amount); assert.equal(r.receipt, expected);
      assert.equal(f.aura - r.receipt, r.oldAura);
    }
  }
});
test("AURA old inventory never covers a short receipt; share debit and minimum guard exact deltas", () => {
  const amount = WAD;
  for (const options of [{ short: 1n }, { extraBurn: 1n }, { extraBurn: -1n }])
    assert.throws(() => run(fixture(), amount, options), /checked uint256|mismatch/);
  const normal = run(fixture(), amount);
  assert.equal(run(fixture(), amount, { bonus: 7n }).receipt, normal.receipt + 7n);
  assert.throws(() => run(fixture(), amount, { minimum: normal.receipt + 1n }), /checked uint256/);
  assert.equal(run(fixture(), amount, { minimum: normal.receipt }).receipt, normal.receipt);
});
test("runtime liquid-capacity guard rejects lock-unlock branch before native call", () => {
  const f = fixture(); f.state = { ...f.state, supply: 10000n, vaultIdle: 1000n, strategyIdle: 2000n, locked: 7000n };
  assert.equal(run(structuredClone(f), 3000n).receipt, 3000n);
  assert.throws(() => run(f, 3001n), /checked uint256/);
});
test("native pauses remain branch-specific; treasury refund and insufficient shares reject", () => {
  const f = fixture(); f.state = { ...f.state, strategyPaused: true };
  assert(run(structuredClone(f), WAD).receipt > 0n);
  assert.throws(() => run(structuredClone(f), f.state.supply), /strategy pause/);
  f.state = { ...f.state, vaultPaused: true }; assert.throws(() => run(f, WAD), /native eligibility/);
  const treasury = fixture(); treasury.state = { ...treasury.state, feeBps: 200n, treasury: actor };
  assert.throws(() => run(treasury, treasury.state.supply), /mismatch/);
  const low = fixture(); low.shares = WAD - 1n; assert.throws(() => run(low, WAD), /native eligibility/);
});
test("calldata/current getter binding and checked numerator overflow reject", () => {
  const f = fixture(); f.wrongWant = actor; assert.throws(() => run(f, WAD), /mismatch/);
  const big = fixture(); big.state = { ...big.state, supply: MAX, vaultIdle: MAX, strategyIdle: 0n }; big.shares = MAX;
  assert.throws(() => run(big, 2n), /checked uint256/);
});
