// Synthetic ABI/effect contracts. Historical issuer/EVM evidence is separate.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeDeferredOpeningFloor, runtimeDeferredPayment,
  type RuntimeSettlementRequest } from "../../../../../adapters/runtime-amount-program.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { inspectRuntime, type RuntimeCall } from "../../../../test/runtime-program-testkit.js";
import { MAX_UINT, MOONISWAP_ACTION, MOONISWAP_ID, MOONISWAP_LINEAGE, POOL, TOKEN } from "../codec.js";
import { mooniswapRoutes } from "../routes.js";
import { buildMooniswapRuntimeLeg as build } from "../runtime-execution.js";
import type { MooniswapDescriptor } from "../types.js";

const addr = (n: number) => ethers.getAddress(ethers.toBeHex(n, 20));
const pool = addr(10), token0 = addr(20), token1 = addr(30), executor = addr(40), receiver = addr(50);
const source = { number: 100, generation: 1, hash: `0x${"11".repeat(32)}` };
const d: MooniswapDescriptor = { familyId: MOONISWAP_ID, lineageId: MOONISWAP_LINEAGE,
  instanceKey: instanceKey(pool.toLowerCase()), pool, token0, token1, codeHash: `0x${"22".repeat(32)}`,
  provenance: [], runtimeRequirements: [{ kind: "source-state", freshness: "current-head" }] };
const routes = mooniswapRoutes.project({ descriptor: d });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const input = (i: number, settlement?: RuntimeSettlementRequest) => ({ descriptor: d, route: routes[i], executor,
  source, runtimeEvidence: [], ...(settlement ? { settlement } : {}) });
const word = (n: bigint) => ethers.toBeHex(n, 32);
const debtABI = new ethers.Interface(["function borrow(uint256 amount,bytes payment)", "function settle(uint256 amount,bytes payment)"]);
type Fault = "none" | "zero-output" | "short-output" | "extra-output" | "wrong-recipient" | "zero-debit" | "under-debit" |
  "over-debit" | "old-output" | "receiver-input" | "native" | "inactive" | "approval-failure" | "empty-reserve";

function model(i: number, program: string, amount: bigint, recipient: string, fault: Fault = "none", root = false, verify = true) {
  const r = routes[i], balances = new Map<string, bigint>();
  const key = (token: string, owner: string) => token.toLowerCase() + ":" + owner.toLowerCase();
  const get = (token: string, owner: string) => balances.get(key(token, owner)) ?? 0n;
  const add = (token: string, owner: string, value: bigint) => {
    const next = get(token, owner) + value; assert(next >= 0n, "balance underflow"); balances.set(key(token, owner), next);
  };
  add(r.tokenIn, executor, amount + 101n); add(r.tokenOut, executor, 103n);
  if (!same(recipient, executor)) { add(r.tokenIn, recipient, 107n); add(r.tokenOut, recipient, 10n ** 30n); }
  add(r.tokenIn, pool, fault === "empty-reserve" ? 0n : 10n ** 30n); add(r.tokenOut, pool, 10n ** 30n);
  const before = new Map(balances); let native = 17n, calls = 0, approvals = 0, readonlyQuotes = 0;
  const quote = amount * 2n; // Explicit fixture result, never Mooniswap pricing logic.
  const call = (c: RuntimeCall): string => {
    assert.equal(c.value, 0n);
    if (same(c.target, recipient) && c.data.startsWith(debtABI.getFunction("borrow")!.selector)) {
      assert(root); const [debt, encoded] = debtABI.decodeFunctionData("borrow", c.data);
      assert.equal(debt, quote); add(r.tokenIn, executor, amount + 1n);
      const bytes = ethers.getBytes(encoded), cap = BigInt(ethers.hexlify(bytes.slice(1, 33)));
      assert.equal(cap, debt);
      inspectRuntime(ethers.hexlify(bytes.slice(36)), cap, { call, nativeBalance: () => native, allowance,
        calldata: debtABI.encodeFunctionData("settle", [debt, encoded]) }); return "0x";
    }
    if (c.data.startsWith(TOKEN.getFunction("balanceOf")!.selector)) {
      assert(c.static); return word(get(c.target, TOKEN.decodeFunctionData("balanceOf", c.data)[0]));
    }
    assert(same(c.target, pool)); const parsed = POOL.parseTransaction({ data: c.data }); assert(parsed);
    assert(same(parsed.args[0], r.tokenIn)); assert(same(parsed.args[1], r.tokenOut)); assert.equal(parsed.args[2], amount);
    if (parsed.name === "getReturn") { assert(c.static); readonlyQuotes++; return word(quote); }
    assert.equal(parsed.name, "swapFor"); assert(!c.static); assert.equal(parsed.args[3], 1n);
    assert.equal(parsed.args[4], ethers.ZeroAddress); assert(same(parsed.args[5], recipient));
    assert.equal(c.incoming, 0); assert.equal(c.outgoing, 0);
    assert.notEqual(fault, "inactive", "real swapFor checks mutable governance after readonly preparation"); calls++;
    const debit = fault === "zero-debit" ? 0n : amount + (fault === "under-debit" ? -1n : fault === "over-debit" ? 1n : 0n);
    const receipt = fault === "zero-output" ? 0n : quote + (fault === "short-output" ? -1n : fault === "extra-output" ? 1n : 0n);
    add(r.tokenIn, executor, -debit); add(r.tokenIn, pool, debit);
    add(r.tokenOut, pool, -receipt); add(r.tokenOut, fault === "wrong-recipient" ? executor : recipient, receipt);
    if (fault === "old-output") add(r.tokenOut, executor, -1n);
    if (fault === "receiver-input") add(r.tokenIn, recipient, -1n);
    if (fault === "native") native--;
    return word(quote); // A truthful-looking return is not evidence of receipt.
  };
  const allowance = (grant: { token: string; spender: string; minimum: bigint; grant: bigint }) => {
    assert.notEqual(fault, "approval-failure"); approvals++;
    assert(same(grant.token, r.tokenIn)); assert(same(grant.spender, pool)); assert.equal(grant.minimum, amount); assert.equal(grant.grant, MAX_UINT);
  };
  inspectRuntime(program, amount, { call, allowance, nativeBalance: () => native });
  if (!verify) return;
  assert.equal(calls, 1); assert.equal(approvals, 1); assert(readonlyQuotes > 0); assert.equal(native, 17n);
  assert.equal(get(r.tokenIn, executor), before.get(key(r.tokenIn, executor))! + (root ? 1n : -amount));
  assert.equal(get(r.tokenOut, recipient), before.get(key(r.tokenOut, recipient))! + quote);
  if (!same(recipient, executor)) { assert.equal(get(r.tokenOut, executor), 103n); assert.equal(get(r.tokenIn, recipient), 107n); }
}

test("Mooniswap declares quote/direct only, preserves default bytes and full input", () => {
  for (const [i, r] of routes.entries()) {
    const leg = build(input(i)); assert(leg); assert.deepEqual(leg.settlement, { quoteOutput: true, directOutput: true });
    const old = new RuntimeAmountProgram().allowance(r.tokenIn, pool, 0, MAX_UINT)
      .call(pool, POOL.encodeFunctionData("swapFor", [r.tokenIn, r.tokenOut, 0n, 1n, ethers.ZeroAddress, executor]), { patches: [{ offset: 68, reg: 0 }] });
    assert.equal(leg.program, ethers.hexlify(old.bytes())); assert.equal(leg.actionAdapterId, MOONISWAP_ACTION);
    assert.equal(build(input(i, { kind: "deferred-input", paymentAmount: 1n, paymentProgram: "0x" })), null);
    for (const kind of ["direct-output", "quote-output"] as const) {
      const request = { kind, recipient: receiver }; assert.deepEqual(build(input(i, request))!.settlementRequest, request);
      for (const bad of [ethers.ZeroAddress, pool, token0, token1, "invalid"]) assert.throws(() => build(input(i, { kind, recipient: bad })));
    }
    assert.throws(() => build(input(i, { kind: "direct-output" } as RuntimeSettlementRequest)));
    assert.equal(build(input(i, { kind: "unknown" } as unknown as RuntimeSettlementRequest)), null);
    assert.throws(() => build({ ...input(i), route: { ...r, tokenOut: r.tokenIn } }));
    assert.equal(build({ ...input(i), descriptor: { ...d, token0: ethers.ZeroAddress } }), null);
  }
});

test("Mooniswap transaction quote is readonly and receiver independent, with positive/capacity boundaries", () => {
  for (const i of [0, 1]) for (const recipient of [undefined, executor, receiver]) {
    const leg = build(input(i, { kind: "quote-output", ...(recipient ? { recipient } : {}) })); assert(leg);
    const run = (amount: bigint, output: bigint, reserveIn = 100n, reserveOut = 100n) => inspectRuntime(leg.program, amount, {
      call(c) {
        assert(c.static); assert.equal(c.value, 0n);
        if (same(c.target, pool)) { const parsed = POOL.decodeFunctionData("getReturn", c.data); assert.equal(parsed[2], amount); return word(output); }
        assert(same(TOKEN.decodeFunctionData("balanceOf", c.data)[0], pool));
        return word(same(c.target, routes[i].tokenIn) ? reserveIn : reserveOut);
      }, allowance() { throw Error("quote must not approve"); },
    }, { output: true, readOnly: true });
    assert.equal(run(7n, 13n).registers[0], 13n); assert.equal(run(7n, 100n).registers[0], 100n);
    for (const args of [[0n, 1n], [1n, 0n], [1n, 101n], [1n, 1n, 0n]]) assert.throws(() => run(args[0], args[1], args[2]));
  }
});

test("Mooniswap direct checks both directions and self/external actual credit, debit and old inventory", () => {
  for (const i of [0, 1]) for (const recipient of [executor, receiver]) {
    const leg = build(input(i, { kind: "direct-output", recipient })); assert(leg);
    for (const amount of [1n, 123456789n, 947347012323163156825n]) model(i, leg.program, amount, recipient);
    for (const fault of ["zero-output", "short-output", "extra-output", "zero-debit", "under-debit", "over-debit", "native", "inactive", "approval-failure", "empty-reserve"] as const)
      assert.throws(() => model(i, leg.program, 1000n, recipient, fault, false, false), fault);
    if (!same(recipient, executor)) for (const fault of ["wrong-recipient", "old-output", "receiver-input"] as const)
      assert.throws(() => model(i, leg.program, 1000n, recipient, fault, false, false), fault);
    assert.throws(() => model(i, leg.program, 0n, recipient, "none", false, false));
  }
});

test("negative model does not manufacture reverts after removing emitted receipt/inventory guards", () => {
  for (const [i, r] of routes.entries()) {
    const unsafe = new RuntimeAmountProgram().allowance(r.tokenIn, pool, 0, MAX_UINT)
      .call(pool, POOL.encodeFunctionData("swapFor", [r.tokenIn, r.tokenOut, 0n, 1n, ethers.ZeroAddress, receiver]), { patches: [{ offset: 68, reg: 0 }] });
    for (const fault of ["zero-output", "short-output", "extra-output", "wrong-recipient", "zero-debit", "under-debit", "over-debit", "old-output", "receiver-input", "native"] as const)
      assert.doesNotThrow(() => model(i, ethers.hexlify(unsafe.bytes()), 1000n, receiver, fault, false, false), fault);
  }
});

test("production sim selector uses Mooniswap quote/direct with zero off-chain Exact or quoted fallback", async () => {
  for (const i of [0, 1]) {
    const r = routes[i]; let exact = 0, quoted = 0, simulated = 0;
    const edges = [{ adapterId: MOONISWAP_ACTION, target: pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut },
      { adapterId: "fixture-deferred", target: receiver, tokenIn: r.tokenOut, tokenOut: r.tokenIn }];
    const selector = createBlockScanSimAmountSelector({ source, executor, async simulate(plan) {
      simulated++; assert.equal(plan.root.adapterId, "runtime-amount-flow"); assert(plan.root.params.settlementProgram);
      model(i, plan.root.params.settlementProgram as string, plan.flashAmount, receiver, "none", true);
      return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: r.tokenIn, calldata: "0x" };
    } });
    const session: any = { source, blocksPrefixInversion: () => false, fundingActionIds: () => [],
      buildRuntimeAmountLeg({ edge, settlement }: any) {
        if (edge === edges[0]) return build(input(i, settlement));
        if (!settlement) return { actionAdapterId: "fixture-deferred", program: "0x010001" + "00".repeat(32), settlement: { deferredInput: receiver } };
        assert.equal(settlement.kind, "deferred-input");
        const payment = runtimeDeferredPayment({ tokenOut: r.tokenIn, executor, debtOffset: 4, ...settlement });
        const p = new RuntimeAmountProgram(); runtimeDeferredOpeningFloor(p, r.tokenIn, executor, settlement.paymentAmount);
        p.call(receiver, debtABI.encodeFunctionData("borrow", [0n, payment.script]), { callback: { incomingOffset: 100, outgoingOffset: 100 },
          patches: [{ offset: 4, reg: 0 }, { offset: 100 + payment.limitOffset, reg: 0 }, { offset: 100 + payment.floorOffset, reg: 13 }] });
        return { actionAdapterId: "fixture-deferred", program: ethers.hexlify(p.bytes()), settlementRequest: settlement };
      }, issueExact() { exact++; throw Error("Exact forbidden"); }, buildExecution() { quoted++; throw Error("quoted forbidden"); },
    };
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 1000000n }, flashToken: r.tokenIn,
      profitToken: r.tokenIn, targetNetProfit: 1n }, tokenPath: { edges }, maxFlashAmount: 2000000n, templateName: "Mooniswap fixture" } as any,
      { call() { throw Error("RPC forbidden"); } } as any, { executor } as any,
      { strictSession: session, deferPhase2Sim: true, gssMaxTries: 0, deadlineAtMs: Date.now() + 10000 });
    assert(simulated > 0); assert.equal(exact, 0); assert.equal(quoted, 0);
  }
});
