import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { plugin, activation } from "../../../production-families/badger-sett-withdraw.production.js";
import { VAULT, STRATEGY, TOKEN, LOCKER, CODE, MAX, WAD } from "../codec.js";
import { program, quoteTrial } from "../exact.js";
import { assertBinding } from "../instance.js";
import { capacity, decodeState, withdraw } from "../state.js";
import { actor, original, saved, rpc, baseline, source, historicalSource, fixture, descriptor, input, collect, attest, read, row } from "./fixture.js";
import { emptyExactTrialState, applyExactTrialState } from "../../../../exact-trial-state.js";
import { storageState, tokenBalanceState } from "../../../local-state-models/resources.js";
test("verified ABI covers every declared getter and void share withdrawal, not ERC4626", () => {
  for (const [abi, impl] of [[VAULT, original.vaultImplementation], [STRATEGY, original.strategyImplementation], [TOKEN, original.asset], [LOCKER, original.locker]] as const) {
    const verified = new ethers.Interface(saved(impl + ".abi.json"));
    for (const fn of abi.fragments.filter(f => f.type === "function")) {
      const our = abi.getFunction(fn.format("sighash"))!, actual = verified.getFunction(our.selector);
      assert(actual, fn.format()); assert.equal(actual.format("sighash"), our.format("sighash"));
      assert.deepEqual(actual.outputs.map(o => o.type), our.outputs.map(o => o.type));
      assert.equal(actual.stateMutability, our.stateMutability);
    }
  }
  assert.equal(VAULT.getFunction("withdraw")!.selector, "0x2e1a7d4d");
  assert.equal(VAULT.getFunction("withdraw")!.outputs.length, 0);
  assert.equal(STRATEGY.getFunction("balanceOf")!.selector, "0x722713f7");
  assert.equal(activation.defaultEnabled, true);
});
test("code and reciprocal proxy/strategy binding, never a vault address allowlist", async () => {
  assert.equal((await attest()).status, "verified");
  const f = fixture(); f.binding = { ...f.binding, vault: ethers.toBeHex(88, 20), strategy: ethers.toBeHex(89, 20),
    vaultImplementation: ethers.toBeHex(90, 20), strategyImplementation: ethers.toBeHex(91, 20) };
  assert.equal((await attest(f)).status, "verified");
  const paused = fixture(); paused.state = { ...paused.state, vaultPaused: true, strategyPaused: true };
  assert.equal((await attest(paused)).status, "verified", "mutable pause is not an identity rejection");
});
for (const kind of Object.keys(CODE) as (keyof typeof CODE)[]) test("unsupported " + kind + " code is retryable, not permanent rejection", async () => {
  const f = fixture(); f.codes[kind] = "0x6000"; assert.equal((await attest(f)).status, "retryable");
});
test("wrong reverse bindings and aliasing decline identity, retaining re-admission", async () => {
  for (const field of ["wrongVault", "wrongWant", "wrongLockerToken"] as const) {
    const f = fixture(); f[field] = actor; assert.equal((await attest(f)).status, "retryable");
  }
  const f = fixture(); f.binding = { ...f.binding, strategyAdmin: f.binding.vault };
  assert.equal((await attest(f)).status, "retryable");
});
test("call nomination is canonical; only one supported share-to-AURA direction", () => {
  const observation = { kind: "call" as const, target: original.vault, source: source(), data: VAULT.encodeFunctionData("withdraw", [100n]) };
  const nominate = (data: string) => plugin.discovery.decodeCandidate({ observation: { ...observation, data }, matchedPatternId: "badger-sett-withdraw-call" });
  assert.equal(nominate(observation.data)?.vault, original.vault);
  assert.equal(nominate(observation.data + "00"), null); assert.equal(nominate(VAULT.encodeFunctionData("withdraw", [0n])), null);
  const d = descriptor(), routes = plugin.routes.project({ descriptor: d }); assert.equal(routes.length, 1);
  assert.equal(routes[0].tokenIn, original.vault); assert.equal(routes[0].tokenOut, original.asset);
});
test("saved block-end state math: floor B*q/S, no PPS double rounding and no TX-prestate claim", async () => {
  const f = fixture(historicalSource), i = input(f, WAD, historicalSource), collected = await collect(f, i);
  const s = decodeState(i.descriptor, collected.initialResults, collected.dependentEvidence, historicalSource);
  assert.equal(s.supply, 24685044970807531810340n);
  assert.equal(s.vaultIdle + s.strategyIdle + s.locked, 26530206517415158308347n);
  assert.equal(capacity(s), s.supply);
  const pps = BigInt(rpc("rpc-015-vault-getPricePerFullShare.json"));
  const exact = withdraw(s, s.supply, actor);
  assert.equal(exact.amountOut, 26530206517415158308347n);
  assert.notEqual(exact.amountOut, s.supply * pps / WAD);
  const boundary = ((s.vaultIdle + 1n) * s.supply - 1n) / (s.vaultIdle + s.strategyIdle);
  assert.equal(boundary, 11584899496401074852828n);
  const paused = { ...s, strategyPaused: true };
  assert.equal(capacity(paused), boundary);
  assert.equal(withdraw(paused, boundary).state.strategyIdle, s.strategyIdle);
  assert.throws(() => withdraw(paused, boundary + 1n), /strategy paused/);
  assert.equal(withdraw(s, boundary + 1n).state.vaultIdle, 0n);
});
test("nonzero locks: liquid amounts supported; any actual unlock branch explicitly declines", () => {
  const s = { ...baseline(), supply: 10000n, vaultIdle: 1000n, strategyIdle: 2000n, locked: 7000n };
  assert.equal(withdraw(s, 1000n).amountOut, 1000n);
  assert.equal(withdraw(s, 3000n).amountOut, 3000n); assert.equal(capacity(s), 3000n);
  for (const safetyCheck of [true, false]) for (const deviationBps of [0n, 50n, 10000n])
    assert.throws(() => withdraw({ ...s, safetyCheck, deviationBps }, 3001n), /unsupported locker-unlock/);
});
test("fee floor, fee-share floor, last-share branch and treasury actor exclusion", () => {
  const s = { ...baseline(), supply: 300n, vaultIdle: 1000n, strategyIdle: 0n, locked: 0n, feeBps: 200n };
  const q = withdraw(s, 30n, actor);
  assert.deepEqual([q.gross, q.fee, q.amountOut, q.feeShares], [100n, 2n, 98n, 0n]);
  const r = withdraw({ ...s, supply: 10000n }, 1000n, actor);
  assert.equal(r.feeShares, 20n); assert.equal(r.state.supply, 9020n); assert.equal(r.state.vaultIdle, 902n);
  const last = withdraw(s, 300n, actor);
  assert.deepEqual([last.amountOut, last.feeShares, last.state.supply, last.state.vaultIdle], [980n, 20n, 20n, 20n]);
  assert.throws(() => withdraw({ ...s, treasury: actor }, 300n, actor), /treasury executor/);
  assert.throws(() => withdraw({ ...s, treasury: ethers.ZeroAddress }, 300n, actor), /mint to zero/);
  // No mint when feeShares floors to zero: alias has no actual share effect.
  assert.equal(withdraw({ ...s, treasury: actor }, 30n, actor).amountOut, 98n);
});
test("zero supply/amount, capacity, pause and source SafeMath overflows fail closed", () => {
  const s = baseline();
  for (const q of [0n, -1n, s.supply + 1n, MAX + 1n]) assert.throws(() => withdraw(s, q));
  assert.throws(() => withdraw({ ...s, supply: 0n }, 1n), /supply/);
  assert.throws(() => withdraw({ ...s, vaultPaused: true }, 1n), /vault paused/);
  assert.throws(() => withdraw({ ...s, supply: MAX, vaultIdle: MAX, strategyIdle: 0n }, 2n), /overflow/);
  const big = { ...s, supply: 1n, vaultIdle: 0n, strategyIdle: MAX / 2n, locked: 0n };
  assert.throws(() => withdraw(big, 1n), /overflow/, "safety multiplication executes even when fully liquid");
  assert.equal(withdraw({ ...big, safetyCheck: false }, 1n).amountOut, MAX / 2n);
  assert.throws(() => withdraw({ ...big, safetyCheck: false, feeBps: 200n }, 1n), /overflow/);
});
test("current-state closure rejects upgrades, corrupt accounting and foreign/missing/duplicate results", async () => {
  const f = fixture(), i = input(f), c = await collect(f, i);
  for (const at of [{ ...source(), generation: 101 }, { ...source(), hash: ethers.ZeroHash }, source(101)])
    assert.throws(() => decodeState(i.descriptor, c.initialResults.map((r, n) => n ? r : { ...r, source: at }), c.dependentEvidence), /foreign source/);
  assert.throws(() => decodeState(i.descriptor, c.initialResults.slice(1), c.dependentEvidence), /missing/);
  assert.throws(() => decodeState(i.descriptor, [c.initialResults[0], c.initialResults[0], ...c.initialResults.slice(2)], c.dependentEvidence), /unresolved/);
  const changed = fixture(); changed.binding = { ...changed.binding, strategy: actor };
  await assert.rejects(() => collect(changed, i), /binding changed/);
  const bad = fixture(); bad.backingError = 1n; const b = await collect(bad, i);
  assert.throws(() => decodeState(i.descriptor, b.initialResults, b.dependentEvidence), /inconsistent backing/);
  const upgrade = fixture(); upgrade.codes.strategy = "0x6000"; const u = await collect(upgrade, i);
  assert.throws(() => decodeState(i.descriptor, u.initialResults, u.dependentEvidence), /unsupported strategy/);
  assert.throws(() => assertBinding(i.descriptor, { ...original, vaultAdmin: actor }), /re-admission/);
});
test("Exact requests are amount-independent local state; explicit quoted fragment remains", async () => {
  const f = fixture(), i = input(f), collected = await collect(f, i);
  assert.deepEqual(program.buildRequests(i), program.buildRequests({ ...i, amountIn: i.amountIn * 7n }));
  const q = program.decode({ programInput: i, ...collected });
  assert.equal(q.amountOut, withdraw(baseline(), i.amountIn).amountOut);
  assert(!("chainAmountQuote" in plugin.exact.methods(i)[1])); assert(!("stateOnlyReads" in plugin.exact.methods(i)[1]));
  const fragment = plugin.execution.buildFragment({ ...i, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence });
  assert.equal(fragment.nodes.length, 1); assert.equal(fragment.nodes[0].amount, i.amountIn);
  const encoded = plugin.actionAdapters[0].encode(fragment.nodes[0], actor, new Uint8Array());
  assert.equal(encoded[0], 14); assert.equal(BigInt(ethers.hexlify(encoded.slice(1, 33))), i.amountIn);
  assert.throws(() => plugin.execution.buildFragment({ ...i, amountIn: i.amountIn + 1n, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence }), /evidence mismatch/);
  assert.throws(() => plugin.execution.buildFragment({ ...i, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut + 1n, exactEvidence: q.evidence }), /evidence mismatch/);
  for (const executor of [original.vaultAdmin, original.strategyAdmin, original.vault, original.asset, ethers.ZeroAddress])
    assert.throws(() => program.buildRequests({ ...i, executor }), /executor|zero address/);
  assert.throws(() => program.buildRequests({ ...i, prefix: [{}] as any }), /issued trial/);
  const zero = { ...i, amountIn: 0n }; assert.deepEqual(program.buildRequests(zero), []);
  assert.equal(program.decode({ programInput: zero, initialResults: [], dependentEvidence: [] }).amountOut, 0n);
});
test("trial composition updates fee/supply/backing; unrelated acquisition is allowed; dirty dependencies never reload baseline", () => {
  const i = input(), s = { ...baseline(), supply: 10000n, vaultIdle: 5001n, strategyIdle: 5000n, feeBps: 200n };
  let trial = emptyExactTrialState();
  trial = applyExactTrialState(trial, [], [tokenBalanceState(original.vault, actor), tokenBalanceState(original.asset, actor)]);
  const first = quoteTrial({ ...i, amountIn: 3000n, trialState: trial.view }, s)!;
  trial = applyExactTrialState(trial, first.stateChanges!, first.stateEffects);
  const second = quoteTrial({ ...i, amountIn: 6000n, trialState: trial.view }, s)!;
  assert.equal(second.amountOut, withdraw(withdraw(s, 3000n, actor).state, 6000n, actor).amountOut);
  assert.notEqual(second.amountOut, withdraw(s, 6000n, actor).amountOut);
  for (const resource of [storageState(original.strategy), storageState(original.vaultImplementation), tokenBalanceState(original.asset, original.vault)]) {
    const dirty = applyExactTrialState(trial, [], [resource]);
    assert.throws(() => quoteTrial({ ...i, trialState: dirty.view }, s), /invalidated dependency/);
  }
  assert.throws(() => quoteTrial({ ...i, source: source(101), trialState: trial.view }, s), /foreign source/);
  assert.equal(s.supply, 10000n, "source baseline remains immutable");
});
