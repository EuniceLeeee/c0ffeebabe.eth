import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ethers } from "ethers";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
const TOKEN_ABI = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)"]);
import type { AdapterRequest, AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";
import { curveUnderlyingStrictFamilyPlugin as family } from "../../curve-underlying-family-plugin.js";
import { curveUnderlyingLendingIdentity as variant } from "../lending-identity.js";
import { LENDING_ABI as ABI, LENDING_LP_SLOT, LENDING_MINTER_SLOT, LENDING_LOOKUP, lendingKind,
  lendingGuardRequests, assertLendingGuards, lendingSwapRequest, decodeLendingSwap } from "../lending.js";
import type { CurveUnderlyingCandidate, CurveUnderlyingIdentity, CurveUnderlyingDescriptor } from "../types.js";

import { model, codes, source, executor, result, lendingTestReply, lendingTestIdentity, lendingTestDescriptor } from "./lending-fixture.js";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const word = (n: bigint) => ethers.toBeHex(n, 32);
test("lending executable profiles are code-bound while pool identity is LP and wrapper reverse-bound", () => {
  assert.equal(lendingKind(codes.dtokenPool), "legacy-dtoken-four");
  assert.equal(lendingKind(codes.yvaultPool), "legacy-yvault-four");
  assert.equal(lendingKind(codes.dtokenPool + "00"), undefined);
  assert.equal(variant.kind, "standalone-contract");
  const identity = lendingTestIdentity();
  assert.equal(identity.facts.registryBinding.lookupSemantics, LENDING_LOOKUP);
  assert.equal(identity.facts.verifiedDirections.length, 12);
  assert(identity.facts.lending);
  const reads = lendingGuardRequests(model.pool, identity.facts.lending).map(r => lendingTestReply(r));
  assertLendingGuards(model.pool, model.coins, identity.facts.lending, source, reads);
  for (const id of ["lending-minter", "lending-lp", "lending-underlying:0", "lending-wrapper-token:0"]) {
    assert.throws(() => assertLendingGuards(model.pool, model.coins, identity.facts.lending!, source,
      reads.map(r => r.id === id ? result(id, ethers.zeroPadValue(executor, 32)) : r)), /binding/);
  }
  for (const id of ["lending-pool-code", "lending-lp-code", "lending-wrapper-code:0"]) {
    assert.throws(() => assertLendingGuards(model.pool, model.coins, identity.facts.lending!, source,
      reads.map(r => r.id === id ? result(id, "0x6000") : r)), /binding/);
  }
  assert.throws(() => assertLendingGuards(model.pool, model.coins, identity.facts.lending!, { ...source, hash: ethers.ZeroHash }, reads), /source/);
});
test("lending Exact uses measured receipt, retains every input unit and requests no output funding", () => {
  const descriptor = lendingTestDescriptor(), route = family.routes.project({ descriptor })[0];
  const amountIn = 334763168622976369n, actual = 334703n;
  const input = { descriptor, route, amountIn, source, executor, runtimeEvidence: [] };
  const method = family.exact.methods(input).find(m => m.kind === "request-program"); assert(method && method.kind === "request-program");
  assert.equal(method.chainAmountQuote, true);
  const requests = method.program.buildRequests(input);
  const sim = requests.find(r => r.kind === "effect-delta-simulation"); assert(sim && sim.kind === "effect-delta-simulation");
  assert.deepEqual(sim.overrideIntent.tokenBalances, [{ token: route.tokenIn, amount: amountIn }]);
  assert.equal(ABI.decodeFunctionData("exchange_underlying", sim.call.data)[2], amountIn);
  assert.equal(requests.some(r => r.kind === "eth-call" && r.data.startsWith(ethers.id("get_dy_underlying(int128,int128,uint256)").slice(0, 10))), false);
  const reads = requests.map(r => lendingTestReply(r, source, actual));
  const quote = method.program.decode({ programInput: input, initialResults: reads, dependentEvidence: [] });
  assert.equal(quote.amountOut, actual); assert.equal(quote.evidence.kind, "curve-underlying-lending");
  assert.notEqual(quote.amountOut, 334705n, "old view value is not the execution amount");
  const fragment = family.execution.buildFragment({ ...input, exactEvidence: quote.evidence,
    quotedAmountOut: quote.amountOut, minAmountOut: quote.amountOut, transactionOrigin: executor });
  assert.equal(fragment.nodes[0].amount, amountIn);
  assert.equal(fragment.nodes[0].params.minDy, actual);
});
test("lending observation rejects zero, partial or excessive debits, wrong accounts, foreign sources and native changes", () => {
  const d = lendingTestDescriptor(), amountIn = 1_000_000_000_000_000_000n;
  const request = lendingSwapRequest({ id: "effect", pool: d.pool, i: 0, j: 1, tokenIn: d.coins[0], tokenOut: d.coins[1], amountIn });
  const good = lendingTestReply(request) as Extract<AdapterRequestResult, { ok: true }>;
  const input = { pool: d.pool, coins: d.coins, binding: d.lending!, i: 0, j: 1, amountIn, source, executor };
  assert(decodeLendingSwap(input, good)! > 0n);
  for (const delta of [0n, -(amountIn - 1n), -(amountIn + 1n)]) {
    const tokenDeltas = good.effects!.tokenDeltas!.map((r, i) => i === 0 ? { ...r, delta } : r);
    assert.throws(() => decodeLendingSwap(input, { ...good, effects: { ...good.effects, tokenDeltas } }), /debit/);
  }
  assert.throws(() => decodeLendingSwap({ ...input, executor: d.pool }, good), /debit/);
  assert.throws(() => decodeLendingSwap(input, { ...good, source: { ...source, generation: source.generation + 1 } }), /source/);
  assert.throws(() => decodeLendingSwap(input, { ...good, effects: { ...good.effects,
    nativeDeltas: [{ account: executor, delta: -1n }] } }), /debit/);
  assert.equal(decodeLendingSwap(input, { ...good, completion: "reverted-as-declared" }), null);
  for (const n of [0n, -1n, 1n << 256n]) assert.throws(() =>
    lendingSwapRequest({ id: "bad", pool: d.pool, i: 0, j: 1, tokenIn: d.coins[0], tokenOut: d.coins[1], amountIn: n }), /input/);
});
test("lending raw price and Exact share actual receipt semantics, with each-block freshness and wrapper dependencies", () => {
  const descriptor = lendingTestDescriptor(), route = family.routes.project({ descriptor })[0];
  const pd = family.pricing.compileDraft({ descriptor, routes: [route], stateKey: route.routeKey });
  const current = { descriptor: pd, routes: [route], source };
  assert.equal(family.pricing.refreshPolicyForInstance!({ descriptor: pd, routes: [route] }), "each-block");
  const deps = family.pricing.dependencies({ descriptor: pd, routes: [route] });
  assert(descriptor.lending!.wrappedCoins.every(c => deps.some(a => same(a, c))));
  const initial = family.pricing.current.buildRequests(current).map(r => lendingTestReply(r));
  const round = family.pricing.current.buildDependentProgram!({ current, initialResults: initial, priorEvidence: [], completedRound: 0 });
  assert(round); assert.equal(round.requests.length, 1); assert.equal(round.requests[0].kind, "effect-delta-simulation");
  const next = round.decode(round.requests.map(r => lendingTestReply(r, source, 999998n)));
  const snapshot = family.pricing.current.decodeSnapshot({ descriptor: pd, initialResults: initial, dependentEvidence: [next] });
  assert.equal(snapshot.amountOut, 999998n);
  const effects = family.execution.expectedEffects({ descriptor, route });
  assert.equal(effects.length, 2); assert(effects.every(e => e.kind === "token-delta" && e.account === "executor"));
});

test("lending quoted minimum applies to new caller receipt after the pool's intermediate check", () => {
  const d = lendingTestDescriptor(), route = family.routes.project({ descriptor: d })[0];
  const simulate = (minimum: bigint, received: bigint, faults: {
    debit?: bigint; noCleanup?: boolean; native?: bigint; amount?: bigint;
  } = {}) => {
    const amount = faults.amount ?? 100n;
    let inputBalance = 1100n, outputBalance = 777n, approved = 9n, native = 23n, swaps = 0;
    const exactEvidence = { kind: "curve-underlying-lending" as const, source, pool: d.pool,
      routeKey: route.routeKey, i: route.i, j: route.j, tokenIn: route.tokenIn, tokenOut: route.tokenOut,
      amountIn: amount, amountOut: minimum > 0n ? minimum : 1n };
    const fragment = family.execution.buildFragment({ descriptor: d, route, source, executor,
      amountIn: amount, quotedAmountOut: exactEvidence.amountOut, minAmountOut: minimum, exactEvidence,
      transactionOrigin: executor, runtimeEvidence: [] });
    assert.deepEqual(fragment.requirements, []);
    const node = fragment.nodes[0];
    const action = family.actionAdapters.find(a => a.id === node.adapterId); assert(action);
    const script = action.encode(node, executor, new Uint8Array());
    assert.equal(script[0], 0x0e);
    const program = ethers.hexlify(script.slice(36));
    if (minimum === 1n) assert.equal(program, family.execution.buildRuntimeLeg({ descriptor: d, route, executor })!.program);
    inspectRuntime(program, amount, {
      nativeBalance: () => native,
      call(c) {
        assert.equal(c.value, 0n);
        if (same(c.target, d.pool)) {
          const [i, j, dx, protocolMinimum] = ABI.decodeFunctionData("exchange_underlying", c.data);
          assert.deepEqual([i, j, dx], [BigInt(route.i), BigInt(route.j), amount]);
          assert.equal(protocolMinimum, 1n);
          assert(7n >= protocolMinimum, "intermediate pre-redemption amount");
          assert(received >= protocolMinimum, "final pool cash includes any donated cash");
          assert.equal(approved, amount);
          inputBalance -= faults.debit ?? amount; outputBalance += received;
          native += faults.native ?? 0n; swaps++;
          return "0x";
        }
        const decoded = TOKEN_ABI.parseTransaction({ data: c.data }); assert(decoded);
        if (decoded.name === "approve") {
          if (!(faults.noCleanup && swaps > 0 && decoded.args[1] === 0n)) approved = decoded.args[1];
          return word(1n);
        }
        if (decoded.name === "allowance") return word(approved);
        assert.equal(decoded.name, "balanceOf");
        return word(same(c.target, route.tokenIn) ? inputBalance : outputBalance);
      },
    });
    return { inputBalance, outputBalance, approved, native, swaps };
  };
  // The old encoder passed 9 to an intermediate amount of 7 and rejected this.
  assert.deepEqual(simulate(9n, 9n), { inputBalance: 1000n, outputBalance: 786n, approved: 0n, native: 23n, swaps: 1 });
  assert.throws(() => simulate(10n, 9n), /uint256/, "777 old output cannot satisfy a missing receipt unit");
  assert.throws(() => simulate(9n, 8n), /uint256/);
  for (const debit of [0n, 99n, 101n]) assert.throws(() => simulate(9n, 9n, { debit }), /mismatch/);
  assert.throws(() => simulate(9n, 9n, { noCleanup: true }), /mismatch/);
  for (const native of [-1n, 1n]) assert.throws(() => simulate(9n, 9n, { native }), /mismatch/);
  assert.throws(() => simulate(9n, 9n, { amount: 0n }), /amount|action/);
  assert.equal(simulate(1n, 9n).outputBalance, 786n, "runtime uses the same input/receipt safeguards");
});
