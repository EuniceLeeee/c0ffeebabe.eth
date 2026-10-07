import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/set-redemption.production.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { ACTION, FAMILY, LINEAGE } from "../manifest.js";
import { MODULE, SET, TOKEN, WAD, MAX, members } from "../codec.js";
import { key } from "../instance.js";
import type { Descriptor, Route } from "../types.js";
import { actor, set, module, controller, components, source } from "./fixture.js";

// Independent instruction interpretation, not EVM or historical admission.
const descriptor = (tokens = components): Descriptor => ({ familyId: FAMILY, lineageId: LINEAGE,
  instanceKey: instanceKey(key({ set, module })), set, module, controller,
  controllerCodeHash: ethers.keccak256("0x6000"), components: tokens, provenance: [], runtimeRequirements: [] });
const input = (d: Descriptor, r: Route) => ({ descriptor: d, route: r, executor: actor, source: source(), runtimeEvidence: [] });
const projected = (d: Descriptor) => plugin.routes.project({ descriptor: d });
const SUBSCRIPT = new ethers.Interface(["function execSubscript(bytes)"]);
// This is this emitter's measured encoding boundary, NOT an identity limit.
const MAX_ENCODED_COMPONENTS = 187;
const tokensFor = (n: number) => Array.from({ length: n }, (_, i) => ethers.toBeHex(i + 1, 20));
assert(plugin.execution.buildRuntimeLeg);
const buildRuntimeLeg = plugin.execution.buildRuntimeLeg;
function leg(d: Descriptor, r = projected(d)[0]) {
  const result = buildRuntimeLeg(input(d, r)); assert(result); return result;
}
function run(d: Descriptor, amount: bigint, options: {
  units?: bigint[]; members?: string[]; short?: number; bonus?: number; extraBurn?: bigint;
  nativeReject?: boolean; setBalance?: bigint;
} = {}) {
  const units = options.units ?? d.components.map((_, n) => (BigInt(n + 1) * WAD + WAD / 3n));
  const inventory = 10n ** 30n;
  const initial = d.components.map(() => inventory);
  const balances = [...initial];
  let setBalance = options.setBalance ?? inventory, redemptions = 0;
  const expected = units.map(unit => amount * unit / WAD);
  const frames: ReturnType<typeof inspectRuntime>[] = [];
  const interpret = (program: string, inputAmount: bigint): ReturnType<typeof inspectRuntime> => inspectRuntime(program, inputAmount, { call(c) {
    const target = c.target.toLowerCase();
    if (target === actor) {
      assert.equal(c.static, false); assert.equal(c.value, 0n);
      assert.equal(c.incoming, 0); assert.equal(c.outgoing, 0);
      assert.deepEqual(c.patches, [{ offset: 69, reg: 0 }]);
      const script = ethers.getBytes(SUBSCRIPT.decodeFunctionData("execSubscript", c.data)[0]);
      assert.equal(script[0], 0x0e);
      const childAmount = BigInt(ethers.hexlify(script.slice(1, 33)));
      const size = Number(BigInt(ethers.hexlify(script.slice(33, 36))));
      assert.equal(childAmount, amount); assert.equal(script.length, 36 + size);
      frames.push(interpret(ethers.hexlify(script.slice(36)), childAmount));
      return "0x";
    }
    if (target === module) {
      assert.equal(c.static, false); assert.equal(c.value, 0n);
      assert.deepEqual([...MODULE.decodeFunctionData("redeem", c.data)].map(v => typeof v === "string" ? v.toLowerCase() : v), [set, amount, actor]);
      assert.deepEqual(c.patches, [{ offset: 36, reg: 0 }]);
      if (options.nativeReject) throw new Error("native redemption ineligible");
      redemptions++; setBalance -= amount + (options.extraBurn ?? 0n);
      for (let n = 0; n < balances.length; n++) balances[n] += expected[n] - (options.short === n ? 1n : 0n) + (options.bonus === n ? 7n : 0n);
      return "0x";
    }
    assert.equal(c.static, true, "only redeem may mutate state");
    if (c.data.startsWith(TOKEN.getFunction("balanceOf")!.selector)) {
      assert.equal(TOKEN.decodeFunctionData("balanceOf", c.data)[0].toLowerCase(), actor);
      return TOKEN.encodeFunctionResult("balanceOf", [target === set ? setBalance : balances[d.components.indexOf(target)]]);
    }
    assert.equal(target, set);
    const call = SET.parseTransaction({ data: c.data }); assert(call);
    if (call.name === "getComponents") return SET.encodeFunctionResult(call.name, [options.members ?? d.components]);
    assert.equal(call.name, "getDefaultPositionRealUnit");
    return SET.encodeFunctionResult(call.name, [units[d.components.indexOf(call.args[0].toLowerCase())]]);
  } });
  const trace = interpret(leg(d).program, amount); frames.push(trace);
  assert.equal(redemptions, 1); assert.equal(frames.length, Math.ceil(d.components.length / 8));
  for (const frame of frames) { assert.equal(frame.allowances.length, 0); assert.equal(frame.registers[0], amount); }
  assert.equal(setBalance, (options.setBalance ?? inventory) - amount);
  return { trace, frames, deltas: balances.map((b, n) => b - initial[n]), expected };
}

test("Set runtime constructs all directions without amounts, Exact evidence or minOut", () => {
  const d = descriptor();
  for (const r of projected(d)) {
    const i = input(d, r);
    for (const field of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
      Object.defineProperty(i, field, { get() { throw new Error("accessed " + field); } });
    const built = buildRuntimeLeg(i); assert(built);
    assert.equal(built.actionAdapterId, ACTION);
    assert.equal(built.program, leg(d).program, "one whole-basket redemption, whichever component is selected");
    assert.throws(() => buildRuntimeLeg({ ...input(d, r), route: { ...r, tokenOut: actor } }), /binding/);
    for (const forbidden of [set, module, controller, ...components, ethers.ZeroAddress])
      assert.throws(() => buildRuntimeLeg({ ...input(d, r), executor: forbidden }), /executor/);
  }
});

test("multiple inputs use current real-unit floor; all basket outputs and surplus survive", () => {
  const d = descriptor();
  for (const amount of [19n, 123456789n, 66538227599871553n, 665382275998715530n]) {
    const normal = run(d, amount); assert.deepEqual(normal.deltas, normal.expected);
    for (let n = 0; n < d.components.length; n++) {
      const higher = run(d, amount, { bonus: n });
      assert.equal(higher.deltas[n], higher.expected[n] + 7n, "surplus is not replaced by an off-chain output");
    }
    const changedUnits = [2n * WAD, 5n * WAD / 2n, 0n, WAD / 3n];
    const changed = run(d, amount, { units: changedUnits });
    assert.deepEqual(changed.deltas, changedUnits.map(u => amount * u / WAD));
  }
});

test("old inventory cannot mask selected or extra component shortfall, nor extra Set debit", () => {
  const d = descriptor();
  for (let n = 0; n < d.components.length; n++)
    assert.throws(() => run(d, WAD, { short: n }), /checked uint256/);
  assert.throws(() => run(d, WAD, { extraBurn: 1n }), /mismatch/);
  assert.throws(() => run(d, WAD, { extraBurn: -1n }), /mismatch/);
  assert.throws(() => run(d, WAD, { nativeReject: true }), /native redemption ineligible/);
});

test("changed basket membership, negative units and overflow reject safely", () => {
  const d = descriptor();
  assert.throws(() => run(d, 19n, { members: [...components].reverse() }), /mismatch/);
  assert.throws(() => run(d, 19n, { members: components.slice(1) }), /mismatch/);
  assert.throws(() => run(d, 19n, { units: [-1n, WAD, WAD, WAD] }), /checked uint256/);
  assert.throws(() => run(d, MAX / 2n + 1n, { setBalance: MAX }), /checked uint256/);
});

test("eight components retain every guard; nine and larger use nested actual input, never null", () => {
  const d = descriptor(tokensFor(8));
  assert.deepEqual(run(d, 19n).deltas, run(d, 19n).expected);
  for (const n of [9, 17, MAX_ENCODED_COMPONENTS]) {
    const basket = descriptor(tokensFor(n));
    for (const amount of [19n, 66538227599871553n]) {
      const outcome = run(basket, amount, { bonus: n - 1 });
      assert.deepEqual(outcome.deltas, outcome.expected.map((v, i) => v + (i === n - 1 ? 7n : 0n)));
    }
  }
  assert.equal(typeof plugin.execution.buildFragment, "function");
  assert.equal(typeof plugin.exact.methods, "function");
});

test("codec has no count cap; full nested payload enforces the existing 64KiB boundary", () => {
  assert.equal(members(tokensFor(MAX_ENCODED_COMPONENTS + 1)).length, MAX_ENCODED_COMPONENTS + 1);
  const largest = descriptor(tokensFor(MAX_ENCODED_COMPONENTS));
  const program = leg(largest).program;
  assert.equal(ethers.getBytes(program).length, 65313);
  assert(ethers.getBytes(program).length <= 65536);
  for (const count of [MAX_ENCODED_COMPONENTS + 1, MAX_ENCODED_COMPONENTS + 8])
    assert.throws(() => leg(descriptor(tokensFor(count))), /runtime program size/);
  for (const basket of [descriptor(tokensFor(9)), largest]) for (const route of projected(basket)) {
    const i = input(basket, route);
    for (const field of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
      Object.defineProperty(i, field, { get() { throw new Error("accessed " + field); } });
    const built = buildRuntimeLeg(i); assert(built);
    assert.equal(built.program, basket === largest ? program : leg(basket).program);
  }
  console.log("Set nested encoding: identity count uncapped; 187 components=65313 bytes; 188 rejected by unchanged 65536-byte VM gate (synthetic)");
});

test("cross-group short receipts, wrong members, negative real units and Set debit remain guarded", () => {
  const d = descriptor(tokensFor(17));
  for (const index of [0, 7, 8, 15, 16]) {
    assert.throws(() => run(d, WAD, { short: index }), /checked uint256/);
    const units = d.components.map(() => WAD); units[index] = -1n;
    assert.throws(() => run(d, WAD, { units }), /checked uint256/);
    const changed = [...d.components]; changed[index] = ethers.toBeHex(1000n, 20);
    assert.throws(() => run(d, WAD, { members: changed }), /mismatch/);
  }
  assert.throws(() => run(d, WAD, { extraBurn: 1n }), /mismatch/);
  assert.throws(() => run(d, WAD, { extraBurn: -1n }), /mismatch/);
  assert.throws(() => run(d, WAD, { nativeReject: true }), /native redemption ineligible/);
  const units = d.components.map((_, n) => n % 3 ? WAD / 3n : 0n);
  const outcome = run(d, WAD + 1n, { units });
  assert.deepEqual(outcome.deltas, units.map(u => (WAD + 1n) * u / WAD));
});

test("production selector uses nested 9/187-component emitters with zero Exact, quoted builds or RPC", async () => {
  const at = source();
  for (const n of [9, MAX_ENCODED_COMPONENTS]) {
    const d = descriptor(tokensFor(n)), routes = projected(d);
    for (const r of [routes[0], routes.at(-1)!]) {
      let exact = 0, quoted = 0, rpc = 0, simulated = 0; const events: any[] = [];
      const edges: any[] = [{ adapterId: ACTION, target: module, tokenIn: r.tokenIn, tokenOut: r.tokenOut },
        { adapterId: "fixture-return", target: actor, tokenIn: r.tokenOut, tokenOut: r.tokenIn }];
      const session: any = { source: at, fundingActionIds: () => ["verified-fixture-funding"],
        buildRuntimeAmountLeg({ edge }: any) { return edge === edges[0] ? leg(d, r) :
          { actionAdapterId: "fixture-return", program: "0x010001" + "00".repeat(32) }; },
        issueExact() { exact++; throw Error("unexpected Exact"); },
        buildExecution() { quoted++; throw Error("unexpected quoted construction"); },
        buildFundingRoot(i: any) { return { adapterId: "fixture", target: actor, tokenIn: set,
          tokenOut: set, amount: i.amount, params: {}, children: i.children }; } };
      const selector = createBlockScanSimAmountSelector({ source: at, executor: actor, record: e => events.push(e),
        async simulate(plan) { simulated++;
          const flow = plan.root.children[0]!;
          assert.equal(flow.adapterId, "runtime-amount-flow");
          assert.equal(JSON.parse(flow.params.legs as string)[0].program, leg(d, r).program);
          return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: set, calldata: "0x" };
        } });
      await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n },
        flashToken: set, profitToken: set }, tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "synthetic-set-capacity" } as any,
        { call() { rpc++; throw Error("unexpected RPC"); } } as any, { executor: actor } as any,
        { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 30000 });
      assert.equal(exact, 0); assert.equal(quoted, 0); assert.equal(rpc, 0); assert(simulated >= 4);
      assert(events.some(e => e.type === "sim_amount_construction"));
      assert(events.filter(e => e.type === "sim_amount_construction").every(e => e.mode === "runtime-actual"));
    }
  }
});
