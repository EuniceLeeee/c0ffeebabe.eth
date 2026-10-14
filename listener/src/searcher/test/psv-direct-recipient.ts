// Production strict issuer and emitted programs against synthetic protocol
// effects. Historical EVM evidence is recorded separately; no admission grant
// or real nonzero-fee/whitelist history is inferred from these fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeDeferredOpeningFloor, runtimeDeferredPayment,
  type RuntimeAmountLeg, type RuntimeSettlementRequest } from "../../adapters/runtime-amount-program.js";
import { buildRuntimeSettlementRoot } from "../simulator/runtime-settlement.js";
import { createBlockScanSimAmountSelector } from "../simulator/blockscan-sim-amount-selector.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../strict-family-lifecycle-runner.js";
import { buildFamilyRuntimeAmountLeg } from "../venues/adapter-family-runtime.js";
import { FamilyCapabilityCatalog, isPricedFamily } from "../venues/family-capability-catalog.js";
import { generatedCapabilityManifestFromShadowArtifact } from "../venues/family-capability-shadow.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD as load } from "../venues/production-family-composition.js";
import artifact from "../generated/family-capability-shadow.generated.json";
import { ABI, WAD } from "../venues/protocols/psv-family/codec.js";
import { FAMILY } from "../venues/protocols/psv-family/manifest.js";
import { addr, actor, source, fixture, attest, reads, type Fixture } from "../venues/protocols/psv-family/test/fixtures.js";
import type { Route } from "../venues/protocols/psv-family/types.js";
import { inspectRuntime, type RuntimeCall } from "./runtime-program-testkit.js";

const modules = [...load.plugins, ...load.disabledPlugins];
const catalog = new FamilyCapabilityCatalog({ modules, requireCapture: true,
  generatedManifest: generatedCapabilityManifestFromShadowArtifact({ artifact, strictFamilyIds: modules.map(m => m.familyId) }) });
const receiver = addr(91), same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const debtABI = new ethers.Interface(["function borrow(uint256 amount,bytes payment)", "function settle(uint256 amount,bytes payment)"]);
type Build = (direction: number, request?: RuntimeSettlementRequest) => RuntimeAmountLeg | null;

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
      async getStorage(address, slot, block) {
        transport++; assert.equal(block, source.number);
        const r = reads(f, [{ id: "slot", kind: "get-storage", address, slot }])[0]; assert(r.ok); return r.data;
      },
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
  const publication = await runStrictFamilyLifecycle({ catalog, familyId: FAMILY, source, runtime,
    observations: [{ kind: "call", source, target: f.target, sender: actor, data: ABI.encodeFunctionData("sellGem", [actor, 1000000n]) }] });
  assert.equal(publication.instances.length, 1);
  const instance = publication.instances[0], family = catalog.forFamily(FAMILY); assert(isPricedFamily(family));
  assert.equal(instance.routes.length, 2);
  const build = (direction: number, settlement?: RuntimeSettlementRequest, executor = actor) => {
    const before = transport;
    const leg = buildFamilyRuntimeAmountLeg({ family, route: instance.routeHandles[direction], source, runtime, executor,
      runtimeEvidence: [], actionOwnership: catalog, ...(settlement ? { settlement } : {}) });
    assert.equal(transport, before, "runtime construction must not call Exact/RPC"); return leg;
  };
  return { build, routes: instance.routes as readonly Route[] };
}

type Fault = "none" | "wrong-recipient" | "zero-output" | "short-output" | "zero-debit" | "under-debit" |
  "over-debit" | "native" | "payer-old-output" | "receiver-old-input" | "approval-false" | "insufficient-input";
function model(f: Fixture, r: Route, program: string, amount: bigint, recipient: string, fault: Fault = "none", root = false, verify = true, observed?: { mutations: number }) {
  const key = (token: string, owner: string) => token.toLowerCase() + ":" + owner.toLowerCase();
  const balances = new Map<string, bigint>();
  const get = (token: string, owner: string) => balances.get(key(token, owner)) ?? 0n;
  const add = (token: string, owner: string, delta: bigint) => {
    const value = get(token, owner) + delta; assert(value >= 0n, "fixture balance underflow"); balances.set(key(token, owner), value);
  };
  add(r.tokenIn, actor, fault === "insufficient-input" ? amount - 1n : amount + 101n); add(r.tokenOut, actor, 103n);
  if (!same(recipient, actor)) { add(r.tokenIn, recipient, 107n); add(r.tokenOut, recipient, 10n ** 30n); }
  add(f.gem, f.target, f.gemReserve); add(f.stable, f.target, f.stableReserve);
  const before = new Map(balances); let allowance = 0n, native = 17n, calls = 0, net = 0n, fee = 0n, credit = 0n;
  const preview = (value: bigint, who: string) => {
    const sell = r.direction === "sell-gem", wad = value * 10n ** BigInt(18 - (sell ? f.gemDecimals : f.stableDecimals));
    const scale = 10n ** BigInt(18 - (sell ? f.stableDecimals : f.gemDecimals));
    const charge = f.exempt || f.exemptRecipients.has(who.toLowerCase()) ? 0n : wad * (sell ? f.tout : f.tin) / WAD / scale;
    return { net: wad / scale - charge, fee: charge, wad };
  };
  const call = (c: RuntimeCall): string => {
    assert.equal(c.value, 0n); if (!c.static && observed) observed.mutations++;
    if (same(c.target, recipient) && c.data.startsWith(debtABI.getFunction("borrow")!.selector)) {
      assert(root); const [debt, encoded] = debtABI.decodeFunctionData("borrow", c.data);
      assert.equal(c.incoming, 100); assert.equal(c.outgoing, 100); add(r.tokenIn, actor, amount + 1n);
      const script = ethers.getBytes(encoded), cap = BigInt(ethers.hexlify(script.slice(1, 33))); assert.equal(cap, debt);
      inspectRuntime(ethers.hexlify(script.slice(36)), cap, { call, nativeBalance: () => native,
        calldata: debtABI.encodeFunctionData("settle", [debt, encoded]) }); return "0x";
    }
    const parsed = ABI.parseTransaction({ data: c.data }); assert(parsed);
    if (parsed.name === "balanceOf") return ABI.encodeFunctionResult("balanceOf", [get(c.target, parsed.args[0])]);
    if (parsed.name === "approve") {
      assert(!c.static); assert(same(c.target, r.tokenIn)); assert(same(parsed.args[0], f.target)); allowance = parsed.args[1];
      return ABI.encodeFunctionResult("approve", [fault !== "approval-false"]);
    }
    assert(same(c.target, f.target));
    if (parsed.name.startsWith("preview")) {
      assert(c.static); const q = preview(parsed.args[0], parsed.args[1]); return ABI.encodeFunctionResult(parsed.name, [q.net, q.fee]);
    }
    if (c.static) {
      const result = reads(f, [{ id: "state", kind: "eth-call", to: c.target, data: c.data, completion: "return-data" }])[0];
      assert(result.ok); return result.data;
    }
    assert.equal(parsed.name, r.direction === "sell-gem" ? "sellGem" : "buyGem"); calls++;
    assert(same(parsed.args[0], recipient)); assert.equal(parsed.args[1], amount); assert.equal(allowance, amount);
    const q = preview(amount, recipient); net = q.net; fee = q.fee;
    assert(!f.paused && net > 0n && (!f.maxPerTransaction || q.wad <= f.maxPerTransaction) && (!f.maxPerBlock || q.wad <= f.remaining));
    if (f.maxPerBlock) f.remaining -= q.wad;
    const debit = fault === "zero-debit" ? 0n : amount + (fault === "under-debit" ? -1n : fault === "over-debit" ? 1n : 0n);
    add(r.tokenIn, actor, -debit); add(r.tokenIn, f.target, debit);
    const received = fault === "zero-output" ? 0n : net - (fault === "short-output" ? 1n : 0n);
    add(r.tokenOut, f.target, -received - fee); add(r.tokenOut, fault === "wrong-recipient" ? actor : recipient, received); add(r.tokenOut, f.treasury, fee);
    if (fault === "payer-old-output") add(r.tokenOut, actor, -1n);
    if (fault === "receiver-old-input") add(r.tokenIn, recipient, -1n);
    if (fault === "native") native--;
    credit = received + (same(f.treasury, recipient) ? fee : 0n);
    return ABI.encodeFunctionResult(parsed.name, [net]); // Net ABI return may differ from actual treasury receipt.
  };
  inspectRuntime(program, amount, { call, nativeBalance: () => native });
  if (!verify) return { net, fee, credit };
  assert.equal(calls, 1); assert.equal(allowance, 0n); assert.equal(native, 17n);
  assert.equal(get(r.tokenIn, actor), before.get(key(r.tokenIn, actor))! + (root ? 1n : -amount));
  assert.equal(get(r.tokenOut, recipient), before.get(key(r.tokenOut, recipient))! + credit);
  if (!same(recipient, actor)) { assert.equal(get(r.tokenOut, actor), 103n); assert.equal(get(r.tokenIn, recipient), 107n); }
  return { net, fee, credit };
}

function settlement(h: { build: Build; routes: readonly Route[] }, index: number, amount: bigint, recipient: string) {
  const r = h.routes[index], base = h.build(index); assert(base);
  return buildRuntimeSettlementRoot({ amount, minimumProfit: 1n, executor: actor, legs: [
    { ...base, tokenIn: r.tokenIn, tokenOut: r.tokenOut },
    { actionAdapterId: "fixture-deferred", program: "0x010001" + "00".repeat(32), tokenIn: r.tokenOut, tokenOut: r.tokenIn, settlement: { deferredInput: recipient } },
  ], build(i, request) {
    if (i === 0) return h.build(index, request);
    assert.equal(request.kind, "deferred-input"); if (request.kind !== "deferred-input") return null;
    const payment = runtimeDeferredPayment({ tokenOut: r.tokenIn, executor: actor, debtOffset: 4, ...request });
    const p = new RuntimeAmountProgram(); runtimeDeferredOpeningFloor(p, r.tokenIn, actor, request.paymentAmount);
    p.call(recipient, debtABI.encodeFunctionData("borrow", [0n, payment.script]), { callback: { incomingOffset: 100, outgoingOffset: 100 },
      patches: [{ offset: 4, reg: 0 }, { offset: 100 + payment.limitOffset, reg: 0 }, { offset: 100 + payment.floorOffset, reg: 13 }] });
    return { actionAdapterId: "fixture-deferred", program: ethers.hexlify(p.bytes()), settlementRequest: request };
  } });
}

test("PSV issuer declares receiver-aware quote/direct only and retains default runtime bytes", async () => {
  const f = fixture(), h = await prepared(f);
  for (const [i, route] of h.routes.entries()) {
    const base = h.build(i); assert(base); assert.deepEqual(base.settlement, { quoteOutput: true, directOutput: true });
    // The established default four-call program is intentionally unchanged.
    const old = new RuntimeAmountProgram().constant(12, 1n)
      .call(route.tokenIn, ABI.encodeFunctionData("approve", [f.target, 0n])).load(1, 0).equal(1, 12)
      .call(route.tokenIn, ABI.encodeFunctionData("approve", [f.target, 0n]), { patches: [{ offset: 36, reg: 0 }] }).load(1, 0).equal(1, 12)
      .call(f.target, ABI.encodeFunctionData(i ? "buyGem" : "sellGem", [actor, 0n]), { patches: [{ offset: 36, reg: 0 }] })
      .call(route.tokenIn, ABI.encodeFunctionData("approve", [f.target, 0n])).load(1, 0).equal(1, 12);
    assert.equal(base.program, ethers.hexlify(old.bytes()));
    for (const kind of ["direct-output", "quote-output"] as const) {
      const request = { kind, recipient: receiver }, leg = h.build(i, request); assert(leg); assert.deepEqual(leg.settlementRequest, request);
      for (const bad of [ethers.ZeroAddress, f.target, f.implementation, f.gem, f.stable]) assert.throws(() => h.build(i, { kind, recipient: bad }), /invalid executor/);
      assert.throws(() => h.build(i, request, receiver), /caller mismatch/);
    }
    assert.equal(h.build(i, { kind: "deferred-input", paymentAmount: 100n, paymentProgram: "0x" }), null);
  }
});

test("PSV actual recipient controls whitelist and treasury gross receipt in both directions", async () => {
  for (const variant of ["charged", "receiver-exempt", "payer-exempt", "treasury-receiver", "zero-fee"] as const) {
    const f = fixture(); if (variant === "receiver-exempt") f.exemptRecipients.add(receiver);
    if (variant === "payer-exempt") f.exemptRecipients.add(actor);
    if (variant === "treasury-receiver") f.treasury = receiver;
    if (variant === "zero-fee") f.tin = f.tout = 0n;
    const h = await prepared(f);
    for (const [i, r] of h.routes.entries()) for (const amount of [1n, 1234567n, 7361655916n]) {
      const direct = h.build(i, { kind: "direct-output", recipient: receiver }); assert(direct);
      const result = model(f, r, direct.program, amount, receiver);
      if (variant === "receiver-exempt" || variant === "zero-fee") assert.equal(result.fee, 0n);
      if (variant === "treasury-receiver") assert.equal(result.credit, amount);
      if (variant === "charged" || variant === "payer-exempt") assert.equal(result.credit, amount - amount * (i ? f.tin : f.tout) / WAD);
      const root = settlement(h, i, amount, receiver); assert(root);
      model(f, r, root.params.settlementProgram as string, amount, receiver, "none", true);
    }
  }
});

test("PSV direct rejects false receipts, wrong payer/recipient balances and one-unit under/over debit", async () => {
  const f = fixture(), h = await prepared(f);
  for (const [i, r] of h.routes.entries()) {
    const direct = h.build(i, { kind: "direct-output", recipient: receiver }); assert(direct);
    for (const fault of ["wrong-recipient", "zero-output", "short-output", "zero-debit", "under-debit", "over-debit", "native",
      "payer-old-output", "receiver-old-input", "approval-false", "insufficient-input"] as const)
      assert.throws(() => model(f, r, direct.program, 1000000n, receiver, fault, false, false));
    // Mutable treasury can change after admission; split output must roll back.
    assert.throws(() => model({ ...f, treasury: actor }, r, direct.program, 1000000n, receiver, "none", false, false), /runtime amount mismatch/);
    model({ ...f, treasury: actor, tin: 0n, tout: 0n }, r, direct.program, 1000000n, receiver);
  }
});

test("PSV transaction-local quote checks positive output, gross reserves and inclusive WAD capacities", async () => {
  const f = fixture(), h = await prepared(f);
  for (const [i, r] of h.routes.entries()) {
    const direct = h.build(i, { kind: "direct-output", recipient: receiver }); assert(direct);
    const capped = { ...f, gemReserve: 1000000n, stableReserve: 1000000n, maxPerTransaction: WAD, maxPerBlock: WAD, remaining: WAD };
    model({ ...capped }, r, direct.program, 1000000n, receiver);
    for (const delta of [{ maxPerTransaction: WAD - 1n }, { remaining: WAD - 1n }, { gemReserve: 999999n, stableReserve: 999999n }, { paused: true }])
    {
      const observed = { mutations: 0 };
      assert.throws(() => model({ ...capped, ...delta }, r, direct.program, 1000000n, receiver, "none", false, false, observed));
      assert.equal(observed.mutations, 0, "capacity preflight must reject before approval or swap");
    }
    for (const amount of [0n, ethers.MaxUint256]) {
      const observed = { mutations: 0 };
      assert.throws(() => model(f, r, direct.program, amount, receiver, "none", false, false, observed));
      assert.equal(observed.mutations, 0);
    }
  }
});

test("PSV production amount selector constructs receiver settlement with zero Exact and no quoted fallback", async () => {
  const f = fixture(), h = await prepared(f), r = h.routes[0], root = settlement(h, 0, 1000000n, receiver); assert(root);
  let exact = 0, quoted = 0, simulated = 0;
  const edges = [{ adapterId: "psv-swap", target: f.target, tokenIn: r.tokenIn, tokenOut: r.tokenOut },
    { adapterId: "fixture-deferred", target: receiver, tokenIn: r.tokenOut, tokenOut: r.tokenIn }];
  const selector = createBlockScanSimAmountSelector({ source, executor: actor, async simulate(plan) {
    simulated++; assert.equal(plan.root.adapterId, "runtime-amount-flow"); assert(plan.root.params.settlementProgram);
    model(f, r, plan.root.params.settlementProgram as string, plan.flashAmount, receiver, "none", true);
    return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: r.tokenIn, calldata: "0x" };
  } });
  const session: any = { source, blocksPrefixInversion: () => false, fundingActionIds: () => [],
    buildRuntimeAmountLeg({ edge, settlement: request }: any) {
      if (edge === edges[0]) return h.build(0, request);
      if (!request) return { actionAdapterId: "fixture-deferred", program: "0x010001" + "00".repeat(32), settlement: { deferredInput: receiver } };
      assert.equal(request.kind, "deferred-input");
      const payment = runtimeDeferredPayment({ tokenOut: r.tokenIn, executor: actor, debtOffset: 4, ...request });
      const p = new RuntimeAmountProgram(); runtimeDeferredOpeningFloor(p, r.tokenIn, actor, request.paymentAmount);
      p.call(receiver, debtABI.encodeFunctionData("borrow", [0n, payment.script]), { callback: { incomingOffset: 100, outgoingOffset: 100 },
        patches: [{ offset: 4, reg: 0 }, { offset: 100 + payment.limitOffset, reg: 0 }, { offset: 100 + payment.floorOffset, reg: 13 }] });
      return { actionAdapterId: "fixture-deferred", program: ethers.hexlify(p.bytes()), settlementRequest: request };
    }, issueExact() { exact++; throw Error("Exact forbidden"); }, buildExecution() { quoted++; throw Error("quoted forbidden"); },
  };
  await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 1000000n }, flashToken: r.tokenIn,
    profitToken: r.tokenIn, targetNetProfit: 1n }, tokenPath: { edges }, maxFlashAmount: 2000000n, templateName: "PSV fixture" } as any,
    { call() { throw Error("RPC forbidden"); } } as any, { executor: actor } as any,
    { strictSession: session, deferPhase2Sim: true, gssMaxTries: 0, deadlineAtMs: Date.now() + 10000 });
  assert(simulated > 0); assert.equal(exact, 0); assert.equal(quoted, 0);
});
