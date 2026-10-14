// Offline central behavior fixtures only. The matching Solidity tests own EVM
// callback authentication and atomic rollback; no admission/chain proof here.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeDeferredOpeningFloor, runtimeDeferredPayment,
  runtimeAmountFlowAdapter, type RuntimeAmountLeg, type RuntimeSettlementRequest } from "../../adapters/runtime-amount-program.js";
import { buildRuntimeSettlementRoot } from "../simulator/runtime-settlement.js";
import { createBlockScanSimAmountSelector } from "../simulator/blockscan-sim-amount-selector.js";
import { inspectRuntime, type RuntimeCall } from "./runtime-program-testkit.js";

const address = (i: number) => ethers.getAddress("0x" + i.toString(16).padStart(40, "0"));
const executor = address(101), a = address(102), b = address(103), prefix = address(104), debtRecipient = address(105);
const word = (x: bigint) => ethers.toBeHex(x, 32);
const erc20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
const abi = new ethers.Interface(["function swap(address recipient,uint256 amount) returns(uint256)",
  "function borrow(uint256 amount,bytes payment)", "function settle(uint256 amount,bytes payment)"]);
const plain = ethers.hexlify(new RuntimeAmountProgram().constant(1, 0n).bytes());
type Leg = RuntimeAmountLeg & { tokenIn: string; tokenOut: string };
const legs = (): Leg[] => [
  { actionAdapterId: "fixture-prefix", program: plain, tokenIn: a, tokenOut: b,
    settlement: { quoteOutput: true, directOutput: true } },
  { actionAdapterId: "fixture-deferred", program: plain, tokenIn: b, tokenOut: a,
    settlement: { deferredInput: debtRecipient } },
];

function builder(index: number, request: RuntimeSettlementRequest): RuntimeAmountLeg | null {
  const p = new RuntimeAmountProgram();
  if (index === 0 && request.kind === "quote-output") {
    p.constant(1, 2n).math("mul", 0, 0, 1);
  } else if (index === 0 && request.kind === "direct-output") {
    // Deliberately expose an untrusted returned value in r0; the central
    // composer must use the receiver's balance delta and private registers.
    p.call(prefix, abi.encodeFunctionData("swap", [request.recipient, 0n]), { patches: [{ offset: 36, reg: 0 }] }).load(0, 0);
  } else if (index === 1 && request.kind === "deferred-input") {
    const payment = runtimeDeferredPayment({ tokenOut: a, executor, debtOffset: 4, ...request });
    runtimeDeferredOpeningFloor(p, a, executor, request.paymentAmount);
    p.call(debtRecipient, abi.encodeFunctionData("borrow", [0n, payment.script]), {
      callback: { incomingOffset: 100, outgoingOffset: 100 },
      patches: [{ offset: 4, reg: 0 }, { offset: 100 + payment.limitOffset, reg: 0 },
        { offset: 100 + payment.floorOffset, reg: 13 }],
    });
  } else return null;
  return { actionAdapterId: index === 0 ? "fixture-prefix" : "fixture-deferred",
    program: ethers.hexlify(p.bytes()), settlementRequest: request };
}

function scenario(options: { debitDelta?: bigint; creditDelta?: bigint; release?: bigint;
  returned?: bigint; wrongReceiver?: boolean; changeNative?: bigint; stealIntermediate?: bigint; recipientDependent?: boolean } = {}) {
  const balances = new Map<string, bigint>();
  const key = (t: string, actor: string) => t.toLowerCase() + ":" + actor.toLowerCase();
  const get = (t: string, actor: string) => balances.get(key(t, actor)) ?? 0n;
  const add = (t: string, actor: string, delta: bigint) => {
    const next = get(t, actor) + delta; assert(next >= 0n, "fixture balance underflow"); balances.set(key(t, actor), next);
  };
  add(a, executor, 1000n); add(b, executor, 777n); add(b, debtRecipient, 555n);
  let native = 17n, prefixCalls = 0;
  const call = (c: RuntimeCall): string => {
    if (c.static && c.data.startsWith(erc20.getFunction("balanceOf")!.selector)) {
      const [actor] = erc20.decodeFunctionData("balanceOf", c.data);
      return word(get(c.target, actor));
    }
    assert.equal(c.static, false);
    if (c.target === prefix) {
      prefixCalls++;
      const [recipient, amount] = abi.decodeFunctionData("swap", c.data);
      add(a, executor, -(amount + (options.debitDelta ?? 0n)));
      add(b, options.wrongReceiver ? executor : recipient, amount * 2n + (options.creditDelta ?? 0n));
      add(b, executor, -(options.stealIntermediate ?? 0n));
      native += options.changeNative ?? 0n;
      return word(options.returned ?? 999999n);
    }
    assert.equal(c.target, debtRecipient);
    const [amount, encoded] = abi.decodeFunctionData("borrow", c.data);
    assert.equal(c.incoming, 100); assert.equal(c.outgoing, 100);
    add(a, executor, options.release ?? 120n);
    const script = ethers.getBytes(encoded);
    assert.equal(script[0], 0x0e);
    assert.equal(Number(BigInt(ethers.hexlify(script.slice(33, 36)))), script.length - 36);
    const cap = BigInt(ethers.hexlify(script.slice(1, 33)));
    assert.equal(cap, amount);
    inspectRuntime(ethers.hexlify(script.slice(36)), cap, { call, nativeBalance: () => native,
      calldata: abi.encodeFunctionData("settle", [amount, encoded]) });
    return "0x";
  };
  const root = buildRuntimeSettlementRoot({ legs: legs(), amount: 100n, minimumProfit: 1n, executor, build(index, request) {
    if (options.recipientDependent && index === 0 && request.kind === "quote-output") {
      const p = new RuntimeAmountProgram().constant(1, request.recipient === debtRecipient ? 2n : 3n).math("mul", 0, 0, 1);
      return { actionAdapterId: "fixture-prefix", program: ethers.hexlify(p.bytes()), settlementRequest: request };
    }
    return builder(index, request);
  } });
  assert(root);
  return { root, get, get native() { return native; }, get prefixCalls() { return prefixCalls; },
    run() { return inspectRuntime(root.params.settlementProgram as string, 100n, { call, nativeBalance: () => native }); } };
}

test("settlement measures recipient delta and protects executor inventory, ignoring returned r0", () => {
  for (const returned of [0n, 1n, 999999n]) {
    const s = scenario({ returned }); s.run();
    assert.equal(s.get(a, executor), 1020n); assert.equal(s.get(b, executor), 777n);
    assert.equal(s.get(b, debtRecipient), 755n); assert.equal(s.native, 17n);
  }
});

test("settlement exact positive debit rejects zero, one-unit under-debit and one-unit inventory over-debit", () => {
  for (const debitDelta of [-100n, -1n, 1n]) assert.throws(() => scenario({ debitDelta }).run());
});

test("settlement cannot replace real recipient credit with return data or credit elsewhere", () => {
  for (const creditDelta of [-200n, -1n, 1n]) assert.throws(() => scenario({ creditDelta, returned: 200n }).run());
  assert.throws(() => scenario({ wrongReceiver: true, returned: 200n }).run());
});

test("settlement opening floor blocks old inventory before prefix work and still enforces final profit", () => {
  const short = scenario({ release: 99n }); assert.throws(() => short.run());
  assert.equal(short.prefixCalls, 0, "old 1000-unit inventory cannot bridge an output-first shortfall");
  assert.throws(() => scenario({ release: 100n }).run(), "full principal alone is not positive profit");
  assert.throws(() => scenario({ stealIntermediate: 1n }).run());
  assert.throws(() => scenario({ changeNative: -1n }).run());
  assert.throws(() => scenario({ changeNative: 1n }).run());
});

test("settlement declines maximum-input and malformed/unsupported compositions before execution", () => {
  const build = () => { throw Error("must not build a maximum-input settlement"); };
  for (const index of [0, 1]) {
    const list = legs(); list[index] = { ...list[index]!, inputMode: "maximum" };
    assert.equal(buildRuntimeSettlementRoot({ legs: list, amount: 100n, minimumProfit: 1n, executor, build }), null);
  }
  assert.equal(buildRuntimeSettlementRoot({ legs: legs(), amount: 0n, minimumProfit: 1n, executor, build }), null);
  assert.equal(buildRuntimeSettlementRoot({ legs: legs(), amount: 1n, minimumProfit: 0n, executor, build }), null);
  assert.equal(buildRuntimeSettlementRoot({ legs: legs(), amount: 1n, minimumProfit: 1n, executor, build: () => null }), null);
  const list = legs(); list[1] = { ...list[1]!, tokenOut: b };
  assert.throws(() => buildRuntimeSettlementRoot({ legs: list, amount: 1n, minimumProfit: 1n, executor, build: builder }), /continuity/);
  const root = scenario().root;
  root.params.legs = JSON.stringify(legs().map((leg, i) => i ? leg : { ...leg, inputMode: "maximum" }));
  assert.throws(() => runtimeAmountFlowAdapter.encode(root, executor, new Uint8Array()), /settlement program bounds/);
});

for (const tolerance of [0n, 1n]) for (const maximum of [false, true])
test(`production selector retains funded actual-amount fallback at tolerance=${tolerance}, maximum=${maximum}`, async () => {
  const source = Object.freeze({ number: 7, hash: "0x" + "ab".repeat(32), generation: 7 });
  const base = legs().map((leg, i) => maximum && i === 0 ? { ...leg, inputMode: "maximum" as const } : leg);
  const edges = base.map((leg, i) => ({ adapterId: leg.actionAdapterId, target: i ? debtRecipient : prefix,
    tokenIn: leg.tokenIn, tokenOut: leg.tokenOut }));
  let exact = 0, quoted = 0, deferred = 0, funded = 0; const events: any[] = [];
  const session: any = { source, blocksPrefixInversion: () => false, fundingActionIds: () => ["verified-fixture-funding"],
    buildRuntimeAmountLeg({ edge, settlement }: any) { const index = edges.indexOf(edge); assert(index >= 0);
      return settlement ? builder(index, settlement) : base[index]; },
    issueExact() { exact++; throw Error("unexpected off-chain Exact"); },
    buildExecution() { quoted++; throw Error("unexpected quoted fallback"); },
    buildFundingRoot(i: any) { assert.equal(i.minProfit, 1n); return { adapterId: "fixture-funding", target: executor,
      tokenIn: a, tokenOut: a, amount: i.amount, params: {}, children: i.children }; },
  };
  const selector = createBlockScanSimAmountSelector({ source, executor, record: e => events.push(e),
    async simulate(plan) {
      if (plan.root.params.settlementProgram !== undefined) {
        deferred++; return { success: false, netProfit: -1n, grossProfit: 0n, gasUsed: 1n, profitToken: a,
          calldata: "0x", failure: { kind: "revert", code: "TRANSACTION_REVERTED" } } as any;
      }
      funded++; const flow = plan.root.children[0]!;
      assert.equal(flow.params.quoteToleranceRawUnits, tolerance);
      assert.equal(flow.params.minimumReturn, plan.flashAmount + 1n);
      assert.equal(flow.amount, plan.flashAmount, "request input must never be artificially decremented");
      assert.equal(JSON.parse(flow.params.legs as string)[0].inputMode, maximum ? "maximum" : undefined);
      return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: a, calldata: "0x" };
    },
  });
  const selected = await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n },
    flashToken: a, profitToken: a, targetNetProfit: 1n }, tokenPath: { edges }, maxFlashAmount: 10000n,
    templateName: "settlement-contract-fixture" } as any,
    { call() { throw Error("unexpected RPC"); } } as any, { executor } as any,
    { strictSession: session, deferPhase2Sim: true, quoteToleranceRawUnits: tolerance, gssMaxTries: 0,
      deadlineAtMs: Date.now() + 10000 });
  assert.equal(selected.root.adapterId, "fixture-funding"); assert(funded > 0);
  assert.equal(deferred, maximum ? 0 : funded); assert.equal(exact, 0); assert.equal(quoted, 0);
  assert(events.filter(e => e.type === "sim_amount_construction").every(e => e.mode === "runtime-actual"));
});

test("settlement quotes the actual receiver before calculating callback debt", () => {
  const s = scenario({ recipientDependent: true }); s.run();
  assert.equal(s.get(a, executor), 1020n); assert.equal(s.get(b, debtRecipient), 755n);
});

test("settlement binds each prefix quote to its actual intermediate or debt receiver", () => {
  const requested: Array<[number, RuntimeSettlementRequest]> = [];
  const list = legs(), third = { ...list[1]!, tokenIn: a, tokenOut: a };
  const c = address(106);
  const root = buildRuntimeSettlementRoot({ legs: [list[0]!, { ...list[0]!, tokenIn: b, tokenOut: c },
    { ...third, tokenIn: c }], amount: 100n, minimumProfit: 1n, executor,
    build(index, request) { requested.push([index, request]); return { actionAdapterId: "fixture", program: plain }; } });
  assert(root);
  assert.deepEqual(requested.filter(([, r]) => r.kind === "quote-output"),
    [[0, { kind: "quote-output", recipient: executor }], [1, { kind: "quote-output", recipient: debtRecipient }]]);
});
