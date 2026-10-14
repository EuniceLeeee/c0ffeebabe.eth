// Synthetic balances through the real strict lifecycle/issuer and emitted
// runtime program. No historical EVM, source recompilation or latency claim.
// Run separately from legacy shadow Family definitions.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram, type RuntimeSettlementRequest } from "../../adapters/runtime-amount-program.js";
import { createBlockScanSimAmountSelector } from "../simulator/blockscan-sim-amount-selector.js";
import { buildRuntimeSettlementRoot } from "../simulator/runtime-settlement.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../strict-family-lifecycle-runner.js";
import { buildFamilyRuntimeAmountLeg } from "../venues/adapter-family-runtime.js";
import { FamilyCapabilityCatalog, isPricedFamily } from "../venues/family-capability-catalog.js";
import { generatedCapabilityManifestFromShadowArtifact } from "../venues/family-capability-shadow.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD as load } from "../venues/production-family-composition.js";
import artifact from "../generated/family-capability-shadow.generated.json";
import { ABI, NEED, TAKE, scales } from "../venues/protocols/yearn-auction-family/codec.js";
import { FAMILY } from "../venues/protocols/yearn-auction-family/manifest.js";
import { addr, actor, source, fixture, attest, reads, contractCost, type Fixture } from "../venues/protocols/yearn-auction-family/test/fixtures.js";
import { inspectRuntime } from "./runtime-program-testkit.js";

// The production Family remains default-disabled. Explicit test catalog scope
// includes installed disabled entries, as the existing Yearn refresh test does.
const modules = [...load.plugins, ...load.disabledPlugins];
const catalog = new FamilyCapabilityCatalog({ modules, requireCapture: true,
  generatedManifest: generatedCapabilityManifestFromShadowArtifact({ artifact, strictFamilyIds: modules.map(m => m.familyId) }) });
const taker = addr(91), same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function prepared(f: Fixture) {
  const effects = new Map<string, { data: string; effects: any }>();
  f.mutate = r => { effects.set(r.id, { data: r.data, effects: r.effects }); };
  assert.equal(attest(f).decision.status, "verified");
  let transport = 0;
  const runtime = createStrictCentralAdapterRuntime({ executor: actor,
    generationFence: { assertCurrent(generation, requested) { assert.equal(generation, source.generation); assert.deepEqual(requested, source); } },
    simulator: { executorProgramCodeHash: ethers.keccak256("0x6000"), async simulate({ request, source: requested }) {
      transport++; assert.deepEqual(requested, source); const result = effects.get(request.id); assert(result); return result;
    } },
    provider: {
      async getStorage() { throw new Error("unexpected Yearn storage read"); },
      async getCode(address, block) {
        transport++; assert.equal(block, source.number);
        const r = reads(f, [{ id: "code", kind: "get-code", address }])[0]; assert(r.ok); return r.data;
      },
      async call(request, block) {
        transport++; assert.equal(block, source.number);
        const r = reads(f, [{ id: "read", kind: "eth-call", to: request.to, data: request.data, completion: "return-data" }])[0];
        assert(r.ok); return r.data;
      },
    } });
  const event = ABI.encodeEventLog(ABI.getEvent("AuctionKicked")!, [f.sold, f.available]);
  const publication = await runStrictFamilyLifecycle({ catalog, familyId: FAMILY, source, runtime,
    observations: [{ kind: "log", source, address: f.target, ...event }] });
  assert.equal(publication.instances.length, 1);
  const instance = publication.instances[0], family = catalog.forFamily(FAMILY); assert(isPricedFamily(family));
  assert.equal(instance.routes.length, 1);
  const build = (settlement?: RuntimeSettlementRequest, executor = actor) => {
    const before = transport;
    const leg = buildFamilyRuntimeAmountLeg({ family, route: instance.routeHandles[0], source, runtime, executor,
      runtimeEvidence: [], actionOwnership: catalog, ...(settlement ? { settlement } : {}) });
    assert.equal(transport, before, "runtime construction must not quote or query the provider"); return leg;
  };
  return { build };
}

type Fault = "none" | "wrong-recipient" | "old-output-only" | "short-output" | "zero-debit" |
  "under-debit" | "over-budget" | "return-mismatch" | "approval-false" | "insufficient-input" | "native";
function run(f: Fixture, program: string, budget: bigint, receiver: string, fault: Fault = "none") {
  const key = (token: string, owner: string) => `${token.toLowerCase()}:${owner.toLowerCase()}`;
  const balances = new Map<string, bigint>();
  const get = (token: string, owner: string) => balances.get(key(token, owner)) ?? 0n;
  const add = (token: string, owner: string, delta: bigint) => {
    const value = get(token, owner) + delta; assert(value >= 0n, "fixture balance underflow"); balances.set(key(token, owner), value);
  };
  const outputOld = 10n ** 30n, proceedsOld = 109n;
  add(f.want, actor, fault === "insufficient-input" ? budget - 1n : budget + 101n);
  add(f.sold, actor, 103n);
  if (!same(receiver, actor)) { add(f.sold, receiver, outputOld); add(f.want, receiver, 107n); }
  add(f.want, f.receiver, proceedsOld); add(f.sold, f.target, f.available);
  const initialWant = get(f.want, actor), initialActorSold = get(f.sold, actor), initialReceiverSold = get(f.sold, receiver);
  let allowance = 0n, native = 17n, actual = 0n, spent = 0n, takeCalls = 0;
  const approvals: bigint[] = [];
  inspectRuntime(program, budget, { nativeBalance: () => native, call(c) {
    assert.equal(c.value, 0n); assert.equal(c.incoming, 0); assert.equal(c.outgoing, 0);
    const parsed = ABI.parseTransaction({ data: c.data }); assert(parsed);
    if (parsed.name === "balanceOf") return ABI.encodeFunctionResult("balanceOf", [get(c.target, parsed.args[0])]);
    if (parsed.name === "getAmountNeeded") {
      assert(c.static); assert(same(c.target, f.target)); assert(same(parsed.args[0], f.sold));
      assert.equal(parsed.args[1], scales(f).priceProbe);
      return ABI.encodeFunctionResult(NEED, [contractCost(f, parsed.args[1])]);
    }
    if (parsed.name === "approve") {
      assert(!c.static); assert(same(c.target, f.want)); assert(same(parsed.args[0], f.target));
      approvals.push(parsed.args[1]); allowance = parsed.args[1];
      return ABI.encodeFunctionResult("approve", [fault !== "approval-false"]);
    }
    assert.equal(parsed.name, "take"); assert(!c.static); assert(same(c.target, f.target)); takeCalls++;
    assert.equal(parsed.signature, same(receiver, actor) ? TAKE : "take(address,uint256,address)");
    assert(same(parsed.args[0], f.sold));
    const requestedReceiver: string = parsed.args.length === 2 ? actor : parsed.args[2]; assert(same(requestedReceiver, receiver));
    assert.equal(allowance, budget);
    const desired = BigInt(parsed.args[1]); actual = desired < f.available ? desired : f.available;
    spent = contractCost(f, actual); assert(spent > 0n && spent <= budget);
    // Source semantics: sold is sent to takerReceiver, while payment is pulled
    // from msg.sender/executor to the independent configured proceeds receiver.
    const receipt = fault === "old-output-only" ? 0n : actual - (fault === "short-output" ? 1n : 0n);
    add(f.sold, f.target, -receipt); add(f.sold, fault === "wrong-recipient" ? f.receiver : receiver, receipt);
    const debit = fault === "zero-debit" ? 0n : fault === "under-debit" ? spent - 1n : fault === "over-budget" ? budget + 1n : spent;
    add(f.want, actor, -debit); add(f.want, f.receiver, debit);
    if (fault === "native") native--;
    return ABI.encodeFunctionResult(parsed.signature, [actual + (fault === "return-mismatch" ? 1n : 0n)]);
  } });
  assert.equal(takeCalls, 1); assert.deepEqual(approvals, [0n, budget, 0n]); assert.equal(allowance, 0n);
  assert.equal(get(f.want, actor), initialWant - spent); assert(get(f.want, actor) >= 101n);
  assert.equal(get(f.want, f.receiver), proceedsOld + spent);
  if (!same(receiver, actor)) assert.equal(get(f.want, receiver), 107n);
  assert.equal(get(f.sold, receiver), initialReceiverSold + actual);
  if (!same(receiver, actor)) assert.equal(get(f.sold, actor), initialActorSold);
  assert.equal(get(f.sold, f.target), f.available - actual); assert.equal(native, 17n);
  return { actual, spent, residual: budget - spent };
}

test("Yearn ordinary receiver is issuer-bound, separates proceeds, and keeps maximum budget/capacity semantics", async () => {
  for (const f of [fixture(), { ...fixture(), wantDecimals: 6 }, { ...fixture(), soldDecimals: 6, available: 772943155n }]) {
    const h = await prepared(f), request = { kind: "direct-output" as const, recipient: taker };
    const direct = h.build(request); assert(direct);
    assert.equal(direct.inputMode, "maximum"); assert.deepEqual(direct.settlement, { quoteOutput: true, directOutput: true, deferredInput: ethers.getAddress(actor) });
    assert.deepEqual(direct.settlementRequest, request);
    const defaultLeg = h.build(); assert(defaultLeg); assert.equal(defaultLeg.inputMode, "maximum");
    for (const budget of [10n * 10n ** BigInt(f.wantDecimals), contractCost(f, f.available) + 17n]) {
      const outcome = run(f, direct.program, budget, taker);
      run(f, defaultLeg.program, budget, actor); // The old two-argument entry still executes.
      if (budget === contractCost(f, f.available) + 17n) { assert.equal(outcome.actual, f.available); assert.equal(outcome.residual, 17n); }
    }
    const budget = 10n * 10n ** BigInt(f.wantDecimals);
    for (const fault of ["wrong-recipient", "old-output-only", "short-output", "zero-debit", "over-budget",
      "under-debit", "return-mismatch", "approval-false", "insufficient-input", "native"] as const) {
      assert.throws(() => run(f, direct.program, budget, taker, fault), /runtime amount mismatch|checked uint256 math/);
    }
    assert(h.build({ kind: "quote-output" }));
    assert.throws(() => h.build({ kind: "deferred-input", paymentAmount: budget, paymentProgram: "0x" }), /subprogram shape/);
    assert.throws(() => h.build(request, taker), /caller mismatch/);
    for (const recipient of [ethers.ZeroAddress, f.target, f.implementation, f.want, f.sold]) {
      assert.throws(() => h.build({ kind: "direct-output", recipient }), /invalid executor/);
    }
  }
});

test("Yearn maximum-input policy prevents automatic deferred settlement even with forged extra capability flags", async () => {
  const f = fixture(), h = await prepared(f), leg = h.build({ kind: "direct-output", recipient: taker }); assert(leg);
  let builds = 0;
  const root = buildRuntimeSettlementRoot({ executor: actor, amount: 10n ** 18n, minimumProfit: 1n, legs: [
    { ...leg, tokenIn: f.want, tokenOut: f.sold, settlement: { directOutput: true, quoteOutput: true } },
    { ...leg, tokenIn: f.sold, tokenOut: f.want, settlement: { deferredInput: taker } },
  ], build() { builds++; throw new Error("maximum input cannot enter settlement construction"); } });
  assert.equal(root, null); assert.equal(builds, 0); assert.equal(leg.inputMode, "maximum");
});

// This must fail on the pre-adaptation issuer: the four-argument path was absent.
test("Yearn issuer exposes quote and output-first callback settlement", async () => {
  const f = fixture(), h = await prepared(f), leg = h.build(); assert(leg);
  assert.equal(leg.settlement?.quoteOutput, true);
  assert.equal(leg.settlement?.deferredInput?.toLowerCase(), actor.toLowerCase());
  assert(h.build({ kind: "quote-output" }));
  const payment = "0x010001" + "00".repeat(32);
  assert(h.build({ kind: "deferred-input", paymentAmount: 1n, paymentProgram: payment }));
});

test("Yearn runtime quote caps capacity and matches full-price payable quantity without funded input", async () => {
  for (const soldDecimals of [0, 6, 18]) for (const wantDecimals of [0, 6, 18]) {
    const f = { ...fixture(), soldDecimals, wantDecimals, available: 700n * 10n ** BigInt(soldDecimals) };
    const h = await prepared(f);
    for (const recipient of [undefined, actor, taker]) {
      const leg = h.build({ kind: "quote-output", ...(recipient ? { recipient } : {}) }); assert(leg);
      const quote = (amount: bigint, state = f) => inspectRuntime(leg.program, amount, { call(c) {
        assert(c.static); assert.equal(c.value, 0n);
        const result = reads(state, [{ id: "quote", kind: "eth-call", to: c.target, data: c.data, completion: "return-data" }])[0];
        assert(result.ok); return result.data;
      } }, { output: true, readOnly: true }).registers[0];
      for (const budget of [1n, 17n, 10n * 10n ** BigInt(wantDecimals), contractCost(f, f.available) + 17n]) {
        let low = 0n, high = f.available;
        while (low < high) { const mid = (low + high + 1n) / 2n; if (contractCost(f, mid) <= budget) low = mid; else high = mid - 1n; }
        if (low === 0n || contractCost(f, low) === 0n) assert.throws(() => quote(budget));
        else assert.equal(quote(budget), low);
      }
      for (const state of [{ ...f, receiver: actor }, { ...f, available: 0n }, { ...f, rawPrice: 0n }]) assert.throws(() => quote(100n, state));
      assert.throws(() => quote(0n)); assert.throws(() => quote(ethers.MaxUint256));
    }
  }
});

test("production selector builds final maximum callback through the real issuer with Exact and quoted disabled", async () => {
  const f = fixture(), h = await prepared(f), yearn = h.build(); assert(yearn);
  const prefix = { actionAdapterId: "fixture-exact-prefix", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()),
    settlement: { quoteOutput: true as const, directOutput: true as const } };
  const edges = [{ adapterId: prefix.actionAdapterId, target: addr(89), tokenIn: f.sold, tokenOut: f.want },
    { adapterId: yearn.actionAdapterId, target: f.target, tokenIn: f.want, tokenOut: f.sold }];
  let exact = 0, quoted = 0, rpc = 0, simulated = 0, funded = 0;
  const session: any = { source, blocksPrefixInversion: () => false, fundingActionIds: () => ["fixture-funding"],
    buildRuntimeAmountLeg({ edge, settlement }: any) {
      return edge === edges[1] ? h.build(settlement) : { ...prefix, ...(settlement ? { settlementRequest: settlement } : {}) };
    }, issueExact() { exact++; throw Error("forbidden Exact"); }, buildExecution() { quoted++; throw Error("forbidden quoted"); },
    buildFundingRoot() { funded++; throw Error("unexpected funded fallback"); } };
  const selector = createBlockScanSimAmountSelector({ source, executor: actor, async simulate(plan) {
    simulated++; assert.equal(typeof plan.root.params.settlementProgram, "string");
    assert.equal(plan.root.amount, plan.flashAmount); assert.equal(plan.root.params.minimumReturn, plan.flashAmount + 1n);
    return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: f.sold, calldata: "0x" }; } });
  await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 100n },
    flashToken: f.sold, profitToken: f.sold, targetNetProfit: 1n }, tokenPath: { edges }, maxFlashAmount: 10000n,
    templateName: "yearn-callback-contract" } as any,
    { call() { rpc++; throw Error("forbidden RPC"); } } as any, { executor: actor } as any,
    { strictSession: session, deferPhase2Sim: true, gssMaxTries: 0, deadlineAtMs: Date.now() + 10000 });
  assert(simulated > 0); assert.equal(exact, 0); assert.equal(quoted, 0); assert.equal(rpc, 0); assert.equal(funded, 0);
});
