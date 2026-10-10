import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { declareRequestProgram } from "../../../adapter-request-program.js";
import { INFINIFI_ABI as ABI, INFINIFI_GATEWAY, INFINIFI_MULTICALL, INFINIFI_VARIANT, INFINIFI_SLOT,
  infinifiQuoteRequest, decodeInfiniFiQuote, checkInfiniFiGuard, infinifiGuardRequests } from "../infinifi.js";
import { infinifiIdentity } from "../infinifi-identity.js";
import { infinifiProgram } from "../infinifi-execution.js";
import { ERC4626_INTERFACE, ERC4626_PROBE_ACTOR as actor } from "../abi.js";
import { erc4626Instance } from "../instance.js";
import { erc4626Routes } from "../routes.js";
import { erc4626Exact } from "../exact.js";
import { erc4626Pricing } from "../pricing.js";
import { erc4626Execution } from "../execution.js";
import { erc4626DepositFamilyOwnedAction, erc4626RedeemFamilyOwnedAction } from "../action.js";
import { RequiredAdapterRequestError } from "../../../adapter-request-failure.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { assertInfiniFiEffects } from "./infinifi-historical-dual.js";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { runUniv2Lifecycle } from "../../../../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { createAdapterFamilyExactQuoteCache, type AdapterExactStateCacheAddress } from "../../../../adapter-family-exact-quote-cache.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../../../swaps/univ2-family/codec.js";
import { ERC4626_FAMILY_ID, INFINIFI_LINEAGE_ID } from "../manifest.js";

// Synthetic contract tests only; no RPC or historical identity claim.
const addr = (n: number) => ethers.getAddress(ethers.toBeHex(n, 20));
const vault = addr(101), asset = addr(102), core = addr(103), ys = addr(104), gi = addr(105), yi = addr(106), executor = addr(107);
const source = { number: 25944594, hash: "0x" + "11".repeat(32), generation: 3 };
const lower = (s: string) => s.toLowerCase(), word = (n: bigint) => ethers.toBeHex(n, 32);
const candidate = { candidateKind: "erc4626-vault" as const, vault };
const amount = 10n ** 18n;
const out = (deposit: boolean, n: bigint) => deposit ? n * 10n / 11n : n * 11n / 10n;
const returned = (id: string, data: string): AdapterRequestResult => ({
  id, ok: true, source, data, completion: "returned", provenance: { kind: "fixture", fingerprint: "infinifi-synthetic" },
});
function quoteReply(deposit: boolean, n: bigint) {
  return ABI.encodeFunctionResult("aggregate3", [[{ success: true, returnData: "0x" }, { success: true, returnData: word(out(deposit, n)) }]]);
}
function reads(requests: readonly AdapterRequest[]): AdapterRequestResult[] {
  return requests.map(r => {
    if (r.kind === "get-code") return returned(r.id, "0x6001600055");
    if (r.kind === "get-storage") { assert.equal(r.slot, INFINIFI_SLOT); return returned(r.id, word(BigInt(lower(r.address) === lower(ys) ? yi : gi))); }
    assert.equal(r.kind, "eth-call"); if (r.kind !== "eth-call") throw new Error("read fixture");
    const c = ABI.parseTransaction({ data: r.data })!; let v: unknown[];
    switch (c.name) {
      case "getAddress": v = [c.args[0] === "stakedToken" ? vault : c.args[0] === "receiptToken" ? asset : ys]; break;
      case "asset": case "receiptToken": v = [asset]; break;
      case "stakedToken": v = [vault]; break;
      case "yieldSharing": v = [ys]; break;
      case "core": v = [core]; break;
      case "decimals": v = [18]; break;
      case "hasRole": v = [true]; break;
      case "paused": v = [false]; break;
      case "unaccruedYield": v = [0n]; break;
      case "aggregate3": {
        assert.equal(c.args[0].length, 2); assert.equal(lower(c.args[0][0].target), lower(ys));
        assert.equal(ABI.parseTransaction({ data: c.args[0][0].callData })!.name, "distributeInterpolationRewards");
        const q = ABI.parseTransaction({ data: c.args[0][1].callData })!;
        return returned(r.id, quoteReply(q.name === "previewDeposit", BigInt(q.args[0])));
      }
      default: throw new Error("unexpected read " + c.name);
    }
    return returned(r.id, ABI.encodeFunctionResult(c.name, v));
  });
}
function active(direction: "deposit" | "redeem"): AdapterRequestResult {
  const deposit = direction === "deposit", expected = out(deposit, amount);
  const lifecycle = ERC4626_INTERFACE.encodeEventLog(ERC4626_INTERFACE.getEvent(deposit ? "Deposit" : "Withdraw")!,
    deposit ? [INFINIFI_GATEWAY, actor, amount, expected] : [INFINIFI_GATEWAY, actor, INFINIFI_GATEWAY, expected, amount]);
  const mintBurn = ABI.encodeEventLog(ABI.getEvent("Transfer")!, deposit ? [ethers.ZeroAddress, actor, expected] : [INFINIFI_GATEWAY, ethers.ZeroAddress, amount]);
  return { ...returned("infinifi-active-" + direction, word(expected)), ok: true,
    effects: { tokenDeltas: [{ token: vault, account: actor, delta: deposit ? expected : -amount },
      { token: asset, account: actor, delta: deposit ? -amount : expected },
      { token: vault, account: INFINIFI_GATEWAY, delta: 0n }, { token: asset, account: INFINIFI_GATEWAY, delta: 0n }],
      logs: [{ address: vault, ...lifecycle }, { address: vault, ...mintBurn }] } } as AdapterRequestResult;
}
function stage() {
  let step: any = { candidate, step: 0 };
  for (let i = 0; i < 3; i++) {
    const declared = declareRequestProgram({ requirements: infinifiIdentity.requirements,
      buildRequests: infinifiIdentity.buildRequests, decode: () => null }, step);
    step = { ...step, step: i + 1, evidence: infinifiIdentity.decode({ step, results: reads(declared.requests) }) };
  }
  assert.equal(step.evidence.phase, "probe"); return step;
}
function setup() {
  const step = stage();
  const requests = declareRequestProgram({ requirements: infinifiIdentity.requirements,
    buildRequests: infinifiIdentity.buildRequests, decode: () => null }, step).requests;
  const results = [...reads(requests.filter(r => r.kind === "get-code")), active("deposit"), active("redeem")];
  const evidence = infinifiIdentity.decode({ step, results });
  const decision = infinifiIdentity.decide({ ...step, evidence });
  assert.equal(decision.status, "verified"); if (decision.status !== "verified") throw new Error("fixture identity");
  const descriptor = erc4626Instance.compileDraft(decision.identity);
  return { descriptor, routes: erc4626Routes.project({ descriptor }), step, results };
}
test("registry-backed identity is derived, source-bound and proves both Gateway directions", () => {
  const { descriptor, routes } = setup();
  assert.equal(descriptor.vault, vault); assert.equal(descriptor.infinifi!.gateway, ethers.getAddress(INFINIFI_GATEWAY));
  assert.equal(routes.length, 2);
  const requests = infinifiIdentity.buildRequests({ candidate, step: 0 });
  assert.equal(requests.length, 2);
  const evidence = infinifiIdentity.decode({ step: { candidate: { ...candidate, vault: addr(999) }, step: 0 }, results: reads(requests) });
  assert.equal(infinifiIdentity.decide({ candidate, evidence, step: 1 }).status, "chain-proven-rejected");
  const first: any = { candidate, step: 1, evidence: { phase: "registry", source: { ...source, generation: 2 } } };
  assert.equal((infinifiIdentity.decode({ step: first, results: reads(infinifiIdentity.buildRequests(first)) }) as any).phase, "retry");
});
test("registry absence is a variant nonmatch; malformed, reverted and transport-failed registry evidence is not", () => {
  const step = { candidate, step: 0 }, requests = infinifiIdentity.buildRequests(step), good = reads(requests);
  const absent = good.map(r => returned(r.id, "0x"));
  const missing: any = infinifiIdentity.decode({ step, results: absent });
  assert.equal(infinifiIdentity.decide({ ...step, evidence: missing }).status, "chain-proven-rejected");
  assert.equal(missing.reason, "infinifi_registry_not_deployed");
  assert.deepEqual(missing.evidenceRequestIds, ["infinifi-registry-code"]);
  for (const value of ["0x", "0x01", "0x" + "ff".repeat(32)]) {
    const bad = good.map(r => r.id === "infinifi-registry" ? returned(r.id, value) : r);
    assert.equal((infinifiIdentity.decode({ step, results: bad }) as any).phase, "retry");
  }
  const reverted = good.map(r => r.id === "infinifi-registry" ? { ...r, completion: "reverted", data: "0x" } : r) as AdapterRequestResult[];
  assert.equal((infinifiIdentity.decode({ step, results: reverted }) as any).phase, "retry");
  const failed = good.map(r => r.id === "infinifi-registry" ? { id: r.id, ok: false, source, failure: "rpc" } : r) as AdapterRequestResult[];
  assert.throws(() => infinifiIdentity.decode({ step, results: failed }), RequiredAdapterRequestError);
});

test("temporary losses do not permanently remove the redemption direction", () => {
  let step: any = { candidate, step: 0 };
  for (let i = 0; i < 2; i++) step = { ...step, step: i + 1,
    evidence: infinifiIdentity.decode({ step, results: reads(infinifiIdentity.buildRequests(step)) }) };
  const good = reads(infinifiIdentity.buildRequests(step));
  const bad = good.map(r => r.id === "infinifi-loss" ? returned(r.id, word(ethers.MaxUint256)) : r);
  const evidence: any = infinifiIdentity.decode({ step, results: bad });
  assert.equal(evidence.phase, "retry"); assert.equal(evidence.reason, "infinifi_pending_losses");
  assert.equal(infinifiIdentity.decide({ ...step, evidence }).status, "retryable");
});

test("identity preserves transport failures, missing output observations, forged events and Gateway leftovers", () => {
  const { step, results } = setup();
  assert.throws(() => infinifiIdentity.decode({ step, results: [{ id: "x", ok: false, source, failure: "rpc" }] }), RequiredAdapterRequestError);
  for (const mutate of [
    (r: any) => { r.effects.tokenDeltas = r.effects.tokenDeltas.filter((x: any) => lower(x.token) !== lower(asset)); },
    (r: any) => { r.effects.logs[0].address = addr(999); },
    (r: any) => { r.effects.tokenDeltas[2].delta = 1n; },
    (r: any) => { r.data = word(123n); },
  ]) {
    const bad = structuredClone(results); mutate(bad.find(r => r.id === "infinifi-active-deposit"));
    assert.equal((infinifiIdentity.decode({ step, results: bad }) as any).phase, "retry");
  }
});
test("quote combines public reward distribution and the actual requested input; failed subcalls cannot price", () => {
  const { descriptor } = setup(), b = descriptor.infinifi!;
  for (const direction of ["deposit", "redeem"] as const) for (const n of [17n, amount, amount * 7n]) {
    const req = infinifiQuoteRequest("quote", b, direction, n);
    assert.equal(req.kind, "eth-call"); if (req.kind !== "eth-call") throw new Error("quote");
    assert.equal(lower(req.to), lower(INFINIFI_MULTICALL));
    const calls = ABI.decodeFunctionData("aggregate3", req.data)[0];
    assert.equal(calls.length, 2); assert(calls.every((r: any) => !r.allowFailure));
    assert.equal(ABI.parseTransaction({ data: calls[0].callData })!.name, "distributeInterpolationRewards");
    const preview = ABI.parseTransaction({ data: calls[1].callData })!;
    assert.equal(preview.args[0], n); assert.equal(decodeInfiniFiQuote(quoteReply(direction === "deposit", n)), out(direction === "deposit", n));
  }
  assert.throws(() => decodeInfiniFiQuote(ABI.encodeFunctionResult("aggregate3", [[{ success: false, returnData: "0x" }, { success: true, returnData: word(1n) }]])));
});
test("current-source guards reject dependency/implementation changes, pause, lost role and unaccrued loss", () => {
  const { descriptor } = setup(), b = descriptor.infinifi!, requests = infinifiGuardRequests("g", b), good = reads(requests);
  checkInfiniFiGuard(good, "g", b, true, source);
  for (const [id, value] of [
    ["g-entry-point", word(0n)], ["g-vault-paused", word(1n)], ["g-gateway-paused", word(1n)],
    ["g-loss", word(ethers.MaxUint256)], ["g-gateway-implementation", word(BigInt(addr(888)))],
    ["g-registry-receiptToken", word(BigInt(addr(777)))], ["g-code-yieldSharingImplementation", "0x6002"],
  ]) {
    const bad = good.map(r => r.id === id ? returned(id, value) : r);
    assert.throws(() => checkInfiniFiGuard(bad, "g", b, true, source), id);
  }
  assert.throws(() => checkInfiniFiGuard(good, "g", b, true, { ...source, hash: "0x" + "22".repeat(32) }), /source/);
  assert.equal(erc4626Pricing.refreshPolicyForInstance!({ descriptor } as any), "each-block");
});
test("production Exact and raw pricing use Gateway quotes; snapshots keep source and time refresh requirements", () => {
  const { descriptor, routes } = setup();
  for (const route of routes) {
    const input = { descriptor, route, amountIn: amount * 3n, source, executor, runtimeEvidence: [] };
    const method = erc4626Exact.methods().find(m => m.kind === "request-program")!;
    if (method.kind !== "request-program") throw new Error("exact");
    const requests = declareRequestProgram({ requirements: method.program.requirements,
      buildRequests: method.program.buildRequests, decode: () => null }, input).requests;
    const q = method.program.decode({ programInput: input, initialResults: reads(requests), dependentEvidence: [] });
    assert.equal(q.amountOut, out(route.direction === "deposit", input.amountIn)); assert.equal(q.evidence.kind, "infinifi-gateway-preview");
    assert.throws(() => method.program.buildRequests({ ...input, prefix: [{}] } as any), /sequential/);
    const fragment = erc4626Execution.buildFragment({ ...input, quotedAmountOut: q.amountOut, minAmountOut: 1n, exactEvidence: q.evidence });
    assert.equal(fragment.requirements.length, 0); assert.equal(fragment.nodes[0]!.params.variant, INFINIFI_VARIANT);
    const action = route.direction === "deposit" ? erc4626DepositFamilyOwnedAction : erc4626RedeemFamilyOwnedAction;
    const bytes = action.encode(fragment.nodes[0] as any, executor, new Uint8Array());
    assert.equal(bytes[0], 0x0e);
    assert.equal(action.matchTrace(INFINIFI_GATEWAY, ABI.getFunction(route.direction === "deposit" ? "stake" : "unstake")!.selector), true);
    assert.throws(() => erc4626Execution.buildFragment({ ...input, quotedAmountOut: q.amountOut, minAmountOut: 1n,
      exactEvidence: { ...q.evidence, executor: addr(999) } }), /actor/);
  }
  const draft = erc4626Pricing.compileDraft({ descriptor, routes, stateKey: descriptor.instanceKey });
  const pricing = erc4626Pricing.finalizePricingDescriptor({ draft, staticEvidence: { oneAsset: amount, oneShare: amount }, sharedBindings: [] });
  const requests = declareRequestProgram({ requirements: erc4626Pricing.current.requirements,
    buildRequests: erc4626Pricing.current.buildRequests, decode: () => null }, { descriptor: pricing } as any).requests;
  const snapshot = erc4626Pricing.current.decodeSnapshot({ descriptor: pricing, initialResults: reads(requests) } as any);
  assert.equal(Object.keys(snapshot.quotes).length, 2); assert.deepEqual(snapshot.source, source);
});
function model(deposit: boolean, n: bigint, options: { spent?: bigint; received?: bigint; returned?: bigint; funds?: bigint; supply?: bigint; leftover?: bigint; role?: boolean; approveFalse?: boolean } = {}) {
  const { descriptor } = setup(), input = deposit ? asset : vault, output = deposit ? vault : asset;
  const balances = new Map<string, bigint>();
  const key = (t: string, a: string) => lower(t) + ":" + lower(a);
  balances.set(key(input, executor), options.funds ?? n + 7n); balances.set(key(output, executor), 73n);
  balances.set(key(input, INFINIFI_GATEWAY), 13n); balances.set(key(output, INFINIFI_GATEWAY), 19n);
  let allowance = 9n, supply = amount * 1000n, swaps = 0;
  const prog = infinifiProgram(descriptor.infinifi!, executor, deposit ? "deposit" : "redeem");
  const r = inspectRuntime(ethers.hexlify(prog.bytes()), n, { call(c) {
    const call = ABI.parseTransaction({ data: c.data })!; let result: unknown[];
    switch (call.name) {
      case "getAddress": result = [call.args[0] === "stakedToken" ? vault : call.args[0] === "receiptToken" ? asset : ys]; break;
      case "asset": result = [asset]; break;
      case "yieldSharing": result = [ys]; break;
      case "core": result = [core]; break;
      case "hasRole": result = [options.role ?? true]; break;
      case "balanceOf": result = [balances.get(key(c.target, call.args[0])) ?? 0n]; break;
      case "totalSupply": result = [supply]; break;
      case "allowance": result = [allowance]; break;
      case "approve": assert.equal(lower(c.target), lower(input)); assert.equal(lower(call.args[0]), lower(INFINIFI_GATEWAY));
        allowance = call.args[1]; result = [!options.approveFalse]; break;
      case "stake": case "unstake": {
        assert.equal(c.static, false); assert.equal(lower(c.target), lower(INFINIFI_GATEWAY));
        assert.equal(call.args[0], executor); assert.equal(call.args[1], n); assert.equal(allowance, n);
        const spent = options.spent ?? n, received = options.received ?? n * 2n;
        balances.set(key(input, executor), balances.get(key(input, executor))! - spent);
        balances.set(key(output, executor), balances.get(key(output, executor))! + received);
        if (options.leftover) balances.set(key(input, INFINIFI_GATEWAY), 13n + options.leftover);
        supply += options.supply ?? (deposit ? received : -spent); swaps++; result = [options.returned ?? n * 2n]; break;
      }
      default: throw new Error("runtime unexpectedly quoted or called " + call.name);
    }
    return ABI.encodeFunctionResult(call.name, result);
  } });
  return { r, allowance, swaps, balances, key, input, output };
}
test("runtime consumes r0, measures receipt, protects old inventory and cleans exact allowance", () => {
  for (const deposit of [false, true]) for (const n of [1n, 91n, amount]) {
    const m = model(deposit, n);
    assert.equal(m.swaps, 1); assert.equal(m.allowance, 0n);
    assert.equal(m.balances.get(m.key(m.input, executor)), 7n);
    assert.equal(m.balances.get(m.key(m.output, executor)), 73n + n * 2n);
    assert.equal(m.r.registers[0], n);
    assert(m.r.calls.every(c => c.value === 0n && c.incoming === 0 && c.outgoing === 0));
  }
});
test("runtime rejects missing funds, under/overspend, false return, missing output, supply mismatch and leftover tokens", () => {
  for (const deposit of [false, true]) {
    for (const options of [{ funds: 0n }, { spent: 90n }, { spent: 92n }, { received: 0n }, { returned: 1n }, { supply: 0n }, { leftover: 1n }, { role: false }, { approveFalse: true }])
      assert.throws(() => model(deposit, 91n, options));
    assert.throws(() => model(deposit, 0n));
  }
});

test("production sim selector constructs both Gateway directions without Exact or quoted fallback (synthetic simulation)", async () => {
  const { descriptor, routes } = setup();
  for (const route of routes) {
    const build = () => erc4626Execution.buildRuntimeLeg!({ descriptor, route, source, executor, runtimeEvidence: [] });
    const expected = build(); assert(expected);
    const edges = [{ adapterId: "family-leg", target: vault, tokenIn: route.tokenIn, tokenOut: route.tokenOut },
      { adapterId: "fixture-return", target: executor, tokenIn: route.tokenOut, tokenOut: route.tokenIn }];
    let exact = 0, quoted = 0, rpc = 0, simulated = 0;
    const events: any[] = [], amounts = new Set<bigint>();
    const session: any = { source, fundingActionIds: () => ["fixture-funding"],
      buildRuntimeAmountLeg({ edge }: any) { return edge === edges[0] ? build() :
        { actionAdapterId: "fixture-return", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()) }; },
      issueExact() { exact++; throw new Error("unexpected external Exact"); },
      buildExecution() { quoted++; throw new Error("unexpected quoted fallback"); },
      buildFundingRoot(i: any) { amounts.add(i.amount); return { adapterId: "fixture-funding", target: executor,
        tokenIn: route.tokenIn, tokenOut: route.tokenIn, amount: i.amount, params: {}, children: i.children }; },
    };
    const selector = createBlockScanSimAmountSelector({ source, executor, record: event => events.push(event),
      async simulate(plan) {
        simulated++; const flow = plan.root.children[0]!;
        assert.equal(flow.adapterId, "runtime-amount-flow");
        assert.equal(JSON.parse(flow.params.legs as string)[0].program, expected.program);
        return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: route.tokenIn, calldata: "0x" };
      } });
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n },
      flashToken: route.tokenIn, profitToken: route.tokenIn }, tokenPath: { edges }, maxFlashAmount: 10000n,
      templateName: "infinifi-construction-contract-only" } as any,
      { call() { rpc++; throw new Error("unexpected RPC"); } } as any, { executor } as any,
      { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
    assert.equal(exact, 0); assert.equal(quoted, 0); assert.equal(rpc, 0);
    assert(simulated >= 4 && amounts.size >= 4);
    const construction = events.filter(event => event.type === "sim_amount_construction");
    assert(construction.length > 0); assert(construction.every(event => event.mode === "runtime-actual"));
  }
});

test("historical observer rejects missing, duplicate, wrong-sign and old-inventory receipt deltas", () => {
  const good = { tokenDeltas: [{ token: asset, account: executor, delta: -91n },
    { token: vault, account: executor, delta: 182n }, { token: asset, account: INFINIFI_GATEWAY, delta: 0n },
    { token: vault, account: INFINIFI_GATEWAY, delta: 0n }], nativeDeltas: [{ account: executor, delta: 0n }] };
  const check = (effects: any) => assertInfiniFiEffects(effects, executor, asset, vault, 91n, 182n);
  check(good);
  for (const mutate of [
    (x: typeof good) => { x.tokenDeltas.pop(); },
    (x: typeof good) => { x.tokenDeltas[1] = x.tokenDeltas[0]!; },
    (x: typeof good) => { x.tokenDeltas[0]!.delta = 91n; },
    (x: typeof good) => { x.tokenDeltas[1]!.delta = 0n; },
    (x: typeof good) => { x.tokenDeltas[2]!.delta = 1n; },
    (x: typeof good) => { x.nativeDeltas[0]!.delta = -1n; },
  ]) { const bad = structuredClone(good); mutate(bad); assert.throws(() => check(bad)); }
});

test("production coordinator refreshes InfiniFi without pool activity, withdraws failed prices and recovers without refreshing unrelated pools", async () => {
  // Offline wiring evidence: synthetic observations/state/simulation effects,
  // unchanged production Family, catalog, strict issuer, coordinator and Exact.
  // This is not historical EVM parity, an opportunity or a latency result.
  const at = (tick: number) => tick === 0 ? source : ({ number: source.number + tick,
    generation: source.generation + tick, hash: ethers.id("infinifi-offline-source-" + tick) });
  const pools = [addr(201), addr(202)], poolTokens = [asset, vault];
  type Mode = "healthy" | "rpc-failed" | "paused" | "role-disabled" | "loss" | "binding-changed";
  let mode: Mode = "healthy";
  const observed: { lane: string; method: string; target: string; tick: number }[] = [];
  function runtime(tick: number, lane: string) {
    const current = at(tick);
    return createStrictCentralAdapterRuntime({ executor, verifiedActors: { "erc4626-probe-actor": actor },
      generationFence: { assertCurrent(generation, requested) { assert.equal(generation, current.generation); assert.deepEqual(requested, current); } },
      simulator: { async simulate({ request, source: requested }) {
        assert.deepEqual(requested, source); assert.equal(tick, 0);
        assert(["infinifi-active-deposit", "infinifi-active-redeem"].includes(request.id));
        const response = active(request.id.endsWith("deposit") ? "deposit" : "redeem");
        assert(response.ok); return { data: response.data, effects: response.effects };
      } },
      provider: {
        async getCode(_address, block) { assert.equal(block, current.number); return "0x6001600055"; },
        async getStorage(address, slot, block) {
          assert.equal(block, current.number); assert.equal(slot, INFINIFI_SLOT);
          assert([lower(ys), lower(INFINIFI_GATEWAY)].includes(lower(address)));
          return word(BigInt(lower(address) === lower(ys) ? yi : gi));
        },
        async call(request, block) {
          assert.equal(block, current.number);
          const target = lower(request.to), selector = request.data.slice(0, 10);
          if (pools.some(p => lower(p) === target)) {
            assert.equal(selector, UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector);
            observed.push({ lane, method: "getReserves", target, tick });
            return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [1000n * amount, 2000n * amount, source.number]);
          }
          if (selector === ABI.getFunction("balanceOf")!.selector) {
            const holder = lower(String(ABI.decodeFunctionData("balanceOf", request.data)[0]));
            assert(pools.some(p => lower(p) === holder));
            return UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [target === lower(ADDR.WETH) ? 1000n * amount : 2000n * amount]);
          }
          // Deliberately non-standard synthetic vault, so the real lifecycle
          // proceeds to registry-backed InfiniFi instead of standard ERC4626.
          if (["totalAssets", "totalSupply", "convertToShares", "convertToAssets", "previewDeposit", "previewRedeem"]
            .some(name => ERC4626_INTERFACE.getFunction(name)!.selector === selector)) return word(0n);
          const parsed = ABI.parseTransaction({ data: request.data }); assert(parsed);
          observed.push({ lane, method: parsed.name, target, tick });
          if (parsed.name === "aggregate3") {
            if (mode === "rpc-failed") throw new Error("synthetic offline quote transport failure");
            const calls = parsed.args[0]; assert.equal(calls.length, 2);
            assert.equal(lower(String(calls[0].target)), lower(ys));
            assert.equal(ABI.parseTransaction({ data: calls[0].callData })!.name, "distributeInterpolationRewards");
            assert.equal(lower(String(calls[1].target)), lower(vault));
            const q = ABI.parseTransaction({ data: calls[1].callData })!;
            // Canned changing response; NOT a second implementation of pricing.
            const value = out(q.name === "previewDeposit", BigInt(q.args[0])) + BigInt(tick);
            return ABI.encodeFunctionResult("aggregate3", [[{ success: true, returnData: "0x" }, { success: true, returnData: word(value) }]]);
          }
          if (parsed.name === "hasRole" && mode === "role-disabled") return word(0n);
          if (parsed.name === "paused" && mode === "paused") return word(1n);
          if (parsed.name === "unaccruedYield" && mode === "loss") return word(ethers.MaxUint256);
          if (parsed.name === "getAddress" && parsed.args[0] === "yieldSharing" && mode === "binding-changed") return word(BigInt(addr(999)));
          const reply = reads([{ id: "offline", kind: "eth-call", to: request.to, data: request.data, completion: "return-data" }])[0]!;
          assert(reply.ok); return reply.data;
        },
      },
    });
  }
  const event = ERC4626_INTERFACE.encodeEventLog(ERC4626_INTERFACE.getEvent("Withdraw")!,
    [INFINIFI_GATEWAY, actor, INFINIFI_GATEWAY, out(false, amount), amount]);
  const admitted = await runStrictFamilyLifecycle({ catalog, familyId: ERC4626_FAMILY_ID, source,
    observations: [{ kind: "log", address: vault, ...event, source }], runtime: runtime(0, "identity") });
  assert.equal(admitted.instances.length, 1);
  assert.equal(Reflect.get(admitted.instances[0]!.descriptor, "lineageId"), INFINIFI_LINEAGE_ID);
  assert.equal(admitted.instances[0]!.routes.length, 2);
  const background = await Promise.all(pools.map((pool, i) => runUniv2Lifecycle(source, {
    pool, factory: addr(203), token0: ADDR.WETH, token1: poolTokens[i]!,
    reserves: { reserve0: 1000n * amount, reserve1: 2000n * amount, blockTimestampLast: source.number },
  }, catalog)));
  const instances = [...admitted.instances, ...background.flatMap(r => r.instances)];
  const edges = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, i) => ({
    family: catalog.forFamily(instance.familyId), descriptor: instance.descriptor, route, handle: instance.routeHandles[i],
  }))) }).edges;
  assert.equal(edges.length, 6);
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: source, readyGraph: edges, readyInstances: instances, readyFundingAssets: [] });
  const ownKeys = edges.filter(e => lower(e.instanceKey!) === lower(vault)).map(blockScanEdgeKey);
  assert.equal(ownKeys.length, 2);
  const unrelatedKeys = edges.map(blockScanEdgeKey).filter(k => !ownKeys.includes(k));
  const stateKey = root.pricingIndex().stateKeyByEdgeKey.get(ownKeys[0]!)!;
  assert.deepEqual(root.pricingIndex().perBlockRefreshStateKeys, [stateKey]);
  const cache = createAdapterFamilyExactQuoteCache();
  const coordinator = new StrictCurrentRuntimeCoordinator(request => root.createSession({
    source: request.source, runtime: runtime(request.source.number - source.number, "raw"), fundingAssets: [],
    kind: request.purpose === "exact-execution" ? "exact" : "pricing", touchedPools: request.touchedPools,
    requiredEdgeIds: request.requiredEdgeIds, control: request.control,
  }), () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const current = reuse?.quoteGraph ?? pricing;
    const requested = { number: current.sourceBlock, hash: current.sourceBlockHash, generation: current.generation };
    let exact: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, disabledEdgeIds: reuse?.disabledEdgeIds,
      control, weth: ADDR.WETH, gasCostWei: null, enumerationSpreadBps: 50, concurrency: 2,
      prepareQuote: async requiredEdgeIds => { exact = await root.createSession({ source: requested,
        runtime: runtime(requested.number - source.number, "exact"), fundingAssets: [], kind: "exact", requiredEdgeIds, control }); },
      quote: async request => { assert(exact); const quoted = await exact.issueExact({ ...request, executor, runtimeEvidence: [] });
        assert("amountIn" in quoted); return quoted; },
    });
  }, cache);
  async function step(tick: number) {
    observed.length = 0;
    const current = at(tick), touched = new Set<string>();
    const graph = createVerifiedGraphView({ id: "infinifi-offline-" + tick, edges, generation: current.generation,
      sourceBlock: current.number, sourceBlockHash: current.hash, completenessWatermark: current.number,
      familyIdForEdge: e => root.pricingIndex().familyIdByEdgeKey.get(blockScanEdgeKey(e))!,
      perSourceCoverage: [...new Set(instances.map(i => i.familyId))].map(familyId => ({ familyId,
        sourceId: "offline-fixture", sourceFingerprint: "infinifi-refresh-contract", completeThroughBlock: current.number, completeThroughHash: current.hash })),
    });
    await coordinator.prepareCoarsePricing({ graph, deadlineAtMs: Date.now() + 10000, touchedPools: touched,
      canonicalActivity: { source: current, parentHash: tick === 0 ? ethers.ZeroHash : at(tick - 1).hash, touchedStateKeys: touched, complete: true } });
    assert.equal(touched.size, 0);
    const snapshot = coordinator.latestPricingSnapshot()!; assert.equal(snapshot.sourceBlock, current.number);
    if (tick > 0) {
      assert(!observed.some(r => r.lane === "raw"), "must not reread startup raw mids");
      assert(!observed.some(r => r.method === "getReserves"), "unrelated on-touch pools must carry");
      assert.equal(observed.filter(r => r.method === "aggregate3").length, mode === "rpc-failed" ? 4 : 2,
        "both directions refresh; transport failure uses the central bounded retry: " + mode);
    }
    return snapshot;
  }
  const before = await step(0);
  assert.equal(before.mids.size, 6); assert.equal(before.effectiveMids!.rows.size, 6);
  assert([...before.effectiveMids!.rows.values()].every(r => r.status === "quoted"));
  const sentinel: AdapterExactStateCacheAddress = { familyRuntimeIdentity: {}, familyId: ERC4626_FAMILY_ID,
    instanceKey: admitted.instances[0]!.instanceKey, routeKey: admitted.instances[0]!.routes[0]!.routeKey, stateKey,
    instanceFingerprint: "01".repeat(32), routeBindingFingerprint: "02".repeat(32), capabilityHash: "03".repeat(32),
    compatibilityFingerprint: "04".repeat(32), methodId: "sentinel", methodIndex: 0, methodOrderFingerprint: "05".repeat(32),
    requestFingerprint: "06".repeat(32), amountIn: 1n, executor, source };
  const cached = { trustedResults: [returned("sentinel", "0x6000")], roundFingerprints: ["07".repeat(32)], evidenceRefs: [] };
  const unrelated = { ...sentinel, stateKey: root.pricingIndex().stateKeyByEdgeKey.get(unrelatedKeys[0]!)! };
  assert(cache.storeState(sentinel, cached)); assert(cache.storeState(unrelated, cached));
  const after = await step(1);
  assert(!cache.lookupState({ ...sentinel, source: at(1) })); assert(cache.lookupState({ ...unrelated, source: at(1) }));
  for (const key of ownKeys) {
    assert.notEqual(after.effectiveMids!.rows.get(key)!.amountOut, before.effectiveMids!.rows.get(key)!.amountOut);
    assert.deepEqual(after.effectiveMids!.rows.get(key)!.quotedAt, at(1));
  }
  const modes: Mode[] = ["rpc-failed", "rpc-failed", "healthy", "paused", "role-disabled", "loss", "binding-changed", "binding-changed", "healthy"];
  for (const [i, nextMode] of modes.entries()) {
    mode = nextMode; const tick = i + 2, snapshot = await step(tick);
    assert.strictEqual(snapshot.mids, before.mids); assert.deepEqual(snapshot.rawMidSource, source);
    for (const key of unrelatedKeys) {
      assert.strictEqual(snapshot.effectiveMids!.rows.get(key), before.effectiveMids!.rows.get(key));
      assert.equal(snapshot.pricingProvenanceByEdgeKey!.get(key), "carried");
    }
    for (const key of ownKeys) {
      const row = snapshot.effectiveMids!.rows.get(key)!;
      const allowed = nextMode === "healthy" || (nextMode === "loss" && lower(row.tokenIn) === lower(asset));
      assert.equal(row.status, allowed ? "quoted" : "quote-failed", nextMode + ":" + row.tokenIn);
      if (allowed) { assert.deepEqual(row.quotedAt, at(tick)); assert(snapshot.coverage.resolvedEdgeKeys.includes(key)); }
      else {
        assert.equal(row.amountOut, null); assert.equal(row.quotedAt, undefined);
        assert(snapshot.coverage.unresolvedEdgeKeys.includes(key)); assert(!snapshot.coverage.resolvedEdgeKeys.includes(key));
      }
    }
  }
});
