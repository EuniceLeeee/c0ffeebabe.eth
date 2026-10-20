import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { declareRequestProgram, type AdapterRequest, type AdapterRequestResult } from "../../../adapter-request-program.js";
import { ABI, META } from "../codec.js";
import { GENERIC, GENERIC_CALLS, STABLE_CALC, STABLE_CALC_CODE_HASH, CURVE_V1_FACTORY, V1_FACTORY_CODE_HASH, NATIVE, WETH,
  genericIdentityVariant, genericQuoteResult, genericStateRequests, decodeGenericState, genericProgram, genericScalarData } from "../generic.js";
import { program, requests } from "../exact.js";
import { execution } from "../execution.js";
import { instance } from "../instance.js";
import { routes, assertRoute } from "../routes.js";
import { discovery } from "../discovery.js";
import { pricing } from "../pricing.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { source, addr, actor, attest as attestLegacy } from "./fixtures.js";

// These are contract fixtures and the independent bytecode interpreter, not
// EVM/chain execution evidence. Historical amount parity remains unverified.
const verifiedFixtures = JSON.parse(readFileSync(new URL("generic-verified-fixtures.json", import.meta.url), "utf8"));
const verified = (a: string): string => verifiedFixtures.runtime[a];
const calcCode = verified(STABLE_CALC), v1Code = verified(CURVE_V1_FACTORY);
assert.equal(ethers.keccak256(calcCode), STABLE_CALC_CODE_HASH);
assert.equal(ethers.keccak256(v1Code), V1_FACTORY_CODE_HASH);
const scalar = (n: bigint) => ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [n]);
const reverted = (id: string): AdapterRequestResult => ({ ...row(id, "0x"), completion: "reverted-as-declared" });
const row = (id: string, data: string): Extract<AdapterRequestResult, { ok: true }> => ({ id, ok: true, source, completion: "returned", data,
  provenance: { kind: "synthetic", fingerprint: "curve-lp-generic-contract" } });
function fixture(n = 3, kind: "stable" | "crypto" = "stable") { return { pool: addr(301), lp: addr(302),
  coins: Array.from({ length: n }, (_v, i) => addr(310 + i)), decimals: [18, 6, 8, 18].slice(0, n), code: "0x60016000", supply: 2_000_000n * 10n ** 18n,
  reverse: addr(301), kind, basePool: ethers.ZeroAddress, cached: undefined as bigint | undefined, fresh: 10n ** 18n,
  index: "uint256" as "uint256" | "int128", quoteStyle: "bool", receiver: true, noRedeem: false, registered: true, v1: false,
  quoteDelta: 0n, fault: {} as { debit?: bigint; output?: bigint; native?: bigint; supply?: bigint; recipient?: string; approve?: boolean; receiverOnly?: boolean } }; }
type Fixture = ReturnType<typeof fixture>;
function quote(f: Fixture, direction: "mint" | "redeem", index: number, amount: bigint) {
  const scale = 10n ** BigInt(18 - f.decimals[index]); return direction === "mint" ? amount * scale * 99n / 100n : amount * 99n / 100n / scale;
}
function parse(data: string) { for (const abi of [GENERIC, ABI, ...GENERIC_CALLS.map(v => v.abi),
    new ethers.Interface(["function coins(int128) view returns(address)", "function balances(int128) view returns(uint256)",
      "function calc_withdraw_one_coin(uint256,uint256) view returns(uint256)", "function calc_token_amount(uint256[2]) view returns(uint256)",
      "function calc_token_amount(uint256[3],bool) view returns(uint256)", "function calc_token_amount(uint256[3]) view returns(uint256)"])]) {
  try { const p = abi.parseTransaction({ data }); if (p) return { abi, p }; } catch {} }
  throw new Error("unexpected synthetic call " + data.slice(0, 10)); }
function behavior(f: Fixture, req: Extract<AdapterRequest, { kind: "effect-delta-simulation" | "state-override-simulation" }>): AdapterRequestResult {
  if (req.id === "g-actor") return { ...row(req.id, scalar(0n)), effects: { tokenDeltas: [{ token: WETH, account: actor, delta: 0n }], nativeDeltas: [{ account: actor, delta: 0n }] } };
  const script = ethers.getBytes(GENERIC.decodeFunctionData("execSubscript", req.call.data)[0]); assert.equal(script[0], 0x0e);
  const amount = BigInt(ethers.hexlify(script.slice(1, 33))), len = Number(BigInt(ethers.hexlify(script.slice(33, 36)))); assert.equal(script.length, 36 + len);
  let traded = false, nativeActor = req.overrideIntent?.nativeBalanceWei ?? 10n ** 18n, nativePool = 10n ** 30n, supplyDelta = 0n, allowance = 0n;
  const initialNativeActor = nativeActor, initialNativePool = nativePool, balances = new Map<string, bigint>(), initial = new Map<string, bigint>();
  const key = (t: string, a: string) => `${t.toLowerCase()}:${a.toLowerCase()}`;
  for (const v of req.observeTokenBalances ?? []) { const a = typeof v.account === "string" ? v.account : actor;
    balances.set(key(v.token, a), a === actor ? (req.overrideIntent?.tokenBalances?.find(x => x.token === v.token)?.amount ?? 10n ** 30n) : 10n ** 30n); }
  for (const [k, v] of balances) initial.set(k, v);
  const change = (t: string, a: string, delta: bigint) => { if (t === NATIVE) { if (a === actor) nativeActor += delta; else if (a === f.pool) nativePool += delta; }
    else balances.set(key(t, a), (balances.get(key(t, a)) ?? 10n ** 30n) + delta); };
  try {
    inspectRuntime(ethers.hexlify(script.slice(36)), amount, { nativeBalance: () => nativeActor,
      call(c) { const { abi, p } = parse(c.data);
        if (p.name === "approve") { if (f.fault.approve !== false) allowance = p.args[1]; return "0x"; }
        if (p.name === "allowance") return scalar(allowance);
        if (p.name === "balanceOf") return scalar(balances.get(key(c.target, p.args[0])) ?? 10n ** 30n);
        const mint = p.name === "add_liquidity"; if (!mint && p.name !== "remove_liquidity_one_coin") throw new Error("unexpected runtime function");
        const mode = p.args.length === (mint ? 2 : 3) ? "none" : p.signature.includes("bool,address") ? "bool-receiver" : "receiver";
        if ((mode !== "none" && !f.receiver) || mode === "bool-receiver" && f.kind !== "crypto" || mode === "none" && f.fault.receiverOnly) throw new Error("unsupported receiver ABI");
        if (!mint && f.noRedeem) throw new Error("no single coin burn");
        const index = mint ? [...p.args[0]].findIndex(v => v > 0n) : Number(p.args[1]), actualAmount = mint ? p.args[0][index] : p.args[0]; assert.equal(actualAmount, amount);
        const recipient = f.fault.recipient ?? (mode === "none" ? actor : String(p.args[mint ? 2 + (mode === "bool-receiver" ? 1 : 0) : 3 + (mode === "bool-receiver" ? 1 : 0)]).toLowerCase());
        const out = f.fault.output ?? quote(f, mint ? "mint" : "redeem", index, amount), debit = f.fault.debit ?? amount,
          input = mint ? f.coins[index] : f.lp, output = mint ? f.lp : f.coins[index];
        assert.equal(c.value, input === NATIVE ? amount : 0n); change(input, actor, -debit); if (mint) change(input, f.pool, debit);
        change(output, recipient, out); if (!mint) change(output, f.pool, -out);
        supplyDelta = f.fault.supply ?? (mint ? out : -debit); nativeActor += f.fault.native ?? 0n; traded = true;
        return "0x"; // Valid old Curve operations can have no return value.
      } });
    assert(traded);
  } catch { return reverted(req.id); }
  return { ...row(req.id, "0x"), effects: { tokenDeltas: (req.observeTokenBalances ?? []).map(v => {
    const account = typeof v.account === "string" ? v.account.toLowerCase() : actor, k = key(v.token, account);
    return { token: v.token, account, delta: balances.get(k)! - initial.get(k)! }; }), nativeDeltas: [
      { account: actor, delta: nativeActor - initialNativeActor }, { account: f.pool, delta: nativePool - initialNativePool }],
    totalSupplyDeltas: [{ token: f.lp, delta: supplyDelta }], logs: [] } };
}
function resolve(f: Fixture, req: AdapterRequest): AdapterRequestResult {
  if (req.kind === "get-code") return row(req.id, req.address.toLowerCase() === STABLE_CALC ? calcCode : req.address.toLowerCase() === CURVE_V1_FACTORY ? v1Code : req.address.toLowerCase() === f.pool ? f.code : "0x6000");
  if (req.kind === "effect-delta-simulation") return behavior(f, req);
  if (req.kind !== "eth-call") throw new Error("unexpected synthetic request");
  const { p } = parse(req.data), target = req.to.toLowerCase();
  if (p.name === "get_registry_handlers_from_pool") return row(req.id, ABI.encodeFunctionResult(p.name, [[f.registered ? addr(350) : ethers.ZeroAddress, ...Array(9).fill(ethers.ZeroAddress)]]));
  if (p.name === "get_lp_token") return row(req.id, ABI.encodeFunctionResult(p.name, [f.registered ? f.lp : ethers.ZeroAddress]));
  if (p.name === "get_pool_from_lp_token") return row(req.id, ABI.encodeFunctionResult(p.name, [String(p.args[0]).toLowerCase() === f.coins[f.coins.length - 1] && f.basePool !== ethers.ZeroAddress ? f.basePool : f.reverse]));
  if (p.name === "get_coins") return row(req.id, (target === CURVE_V1_FACTORY ? GENERIC : ABI).encodeFunctionResult(p.name, [[...(target === CURVE_V1_FACTORY ? f.v1 ? f.coins : [] : f.registered ? f.coins : []), ...Array((target === CURVE_V1_FACTORY ? 2 : 8) - (target === CURVE_V1_FACTORY ? f.v1 ? f.coins.length : 0 : f.registered ? f.coins.length : 0)).fill(ethers.ZeroAddress)]]));
  if (p.name === "get_base_pool") return row(req.id, GENERIC.encodeFunctionResult(p.name, [f.basePool]));
  if (p.name === "gamma") return f.kind === "crypto" ? row(req.id, scalar(100n)) : reverted(req.id);
  if (p.name === "coins" || p.name === "balances") {
    if (!p.signature.includes(f.index)) return reverted(req.id);
    const i = Number(p.args[0]); return row(req.id, p.name === "coins" ? ethers.AbiCoder.defaultAbiCoder().encode(["address"], [f.coins[i]]) : scalar(1_000_000n * 10n ** BigInt(f.decimals[i])));
  }
  if (p.name === "decimals") return row(req.id, scalar(BigInt(target === f.lp ? 18 : f.decimals[f.coins.indexOf(target)])));
  if (p.name === "lp_token") return row(req.id, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [f.lp]));
  if (p.name === "minter") return row(req.id, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [f.pool]));
  if (p.name === "totalSupply") return row(req.id, scalar(f.supply));
  if (p.name === "fee") return row(req.id, scalar(1000000n));
  if (p.name === "A_precise" || p.name === "future_A") return row(req.id, scalar(10000n));
  if (p.name === "is_killed") return row(req.id, scalar(0n));
  if (p.name === "base_virtual_price") return f.cached === undefined ? reverted(req.id) : row(req.id, scalar(f.cached));
  if (p.name === "get_virtual_price") return row(req.id, scalar(f.fresh));
  if (p.name === "calc_withdraw_one_coin") { if (f.noRedeem) return reverted(req.id); return row(req.id, scalar(quote(f, "redeem", Number(p.args[1]), p.args[0]) + f.quoteDelta)); }
  if (p.name === "calc_token_amount" || p.name === "calc_token_amount_meta") {
    if (target !== STABLE_CALC && p.signature.includes("bool") !== (f.quoteStyle === "bool")) return reverted(req.id);
    const amounts = target === STABLE_CALC ? p.args[2] : p.args[0], index = [...amounts].findIndex(v => v > 0n);
    if (target === STABLE_CALC) { assert.equal(p.name, f.basePool === ethers.ZeroAddress ? "calc_token_amount" : "calc_token_amount_meta"); assert.equal(p.args[p.args.length - 1], false); }
    return row(req.id, scalar(quote(f, "mint", index, amounts[index]) + f.quoteDelta));
  }
  throw new Error("unexpected synthetic ABI " + p.name);
}
function attest(f: Fixture) { let step: any = { candidate: { candidateKind: "curve-lp", pool: f.pool }, step: 0 };
  for (let k = 0; k < 9; k++) { const declared = declareRequestProgram({ requirements: genericIdentityVariant.requirements,
    buildRequests: genericIdentityVariant.buildRequests, decode: () => null }, step), results = declared.requests.map(r => resolve(f, r));
    step = { ...step, step: k + 1, evidence: genericIdentityVariant.decode({ step, results }) }; const decision = genericIdentityVariant.decide(step);
    if (decision.status !== "continue") return decision; } throw new Error("generic fixture did not finish"); }
function setup(f: Fixture) { const decision = attest(f); assert.equal(decision.status, "verified", JSON.stringify(decision)); assert(decision.status === "verified");
  const d = instance.compileDraft(decision.identity), rs = routes.project({ descriptor: d }); return { d, rs }; }

test("source-bound infrastructure fixtures match actual fixed-block code hashes", () => {
  assert.equal(ethers.keccak256(calcCode), STABLE_CALC_CODE_HASH); assert.equal(ethers.keccak256(v1Code), V1_FACTORY_CODE_HASH);
});
test("legacy remains available; generic fixed arrays 2/3/4 and mixed coin getters project only behavior-proven directions", () => {
  assert.equal(attestLegacy().decision.status, "verified");
  for (const n of [2, 3, 4]) for (const kind of ["stable", "crypto"] as const) { if (kind === "crypto" && n === 4) continue;
    const f = fixture(n, kind); if (n === 3) f.index = "int128"; const { d, rs } = setup(f);
    assert.equal(rs.length, n * 2); assert(d.generic!.directions.every(v => v.receiverMode !== "none")); }
});
test("52EA-like mint-only ABI remains mint-only; receiver failures retain the default execution path", () => {
  const f = fixture(3); f.index = "int128"; f.noRedeem = true; f.receiver = false;
  const { d, rs } = setup(f); assert.equal(rs.length, 3); assert(rs.every(v => v.direction === "mint"));
  for (const r of rs) assert.equal(execution.buildRuntimeLeg({ descriptor: d, route: r, executor: actor, source, runtimeEvidence: [], settlement: { kind: "direct-output", recipient: addr(351) } } as any), null);
});
test("unknown provenance stays unavailable; no-code and authoritative reciprocal contradictions retain typed family rejection", async () => {
  const f = fixture(); const nominated = await discovery.nominate!.nominate({ nominations: [{ address: f.pool, opaque: { familyId: "protocol:curve-lp" } }], source,
    provider: { async getCode() { return f.code; } } } as any); assert.equal(nominated.length, 1);
  const missing = fixture(); missing.code = "0x"; assert.equal(attest(missing).status, "chain-proven-rejected");
  const reverse = fixture(); reverse.reverse = addr(351); assert.equal(attest(reverse).status, "chain-proven-rejected");
  const unknown = fixture(); unknown.registered = false; assert.equal(attest(unknown).status, "retryable");
});
test("stored V1 factory membership is distinct from arbitrary pool getter reflection", () => {
  const f = fixture(2); f.lp = f.pool; f.registered = false; f.v1 = true; f.basePool = addr(352);
  const { d, rs } = setup(f); assert.equal(d.generic!.identitySource, "v1-factory"); assert.equal(d.generic!.basePool, f.basePool); assert.equal(rs.length, 4);
});
test("actual debit, actual output, native balance and supply deltas independently gate identity", () => {
  for (const fault of [{ debit: 0n }, { debit: 1n }, { debit: 10n ** 30n }, { output: 0n }, { native: 1n }, { supply: 0n }, { recipient: addr(353) }]) {
    const f = fixture(); f.fault = fault; assert.notEqual(attest(f).status, "verified", JSON.stringify(fault, (_k, v) => typeof v === "bigint" ? v.toString() : v)); }
  const f = fixture(); f.quoteDelta = 1n; assert.notEqual(attest(f).status, "verified");
});
test("specified quote keeps amountIn, binds source/evidence, and the runtime accepts valid void-return operations", () => {
  const f = fixture(4), { d, rs } = setup(f);
  for (const r of rs) for (const n of [1n, 37n]) { const amountIn = n * 10n ** BigInt(r.direction === "mint" ? f.decimals[r.index] : 18), input: any = { descriptor: d, route: r, source, amountIn, executor: actor, runtimeEvidence: [] };
    const results = requests(input).map(req => resolve(f, req)), q = program.decode({ programInput: input, initialResults: results, dependentEvidence: [] });
    assert.equal(q.amountOut, quote(f, r.direction, r.index, amountIn)); const fragment = execution.buildFragment({ ...input, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence });
    assert.equal(fragment.nodes[0].amount, amountIn); assert(execution.buildRuntimeLeg({ ...input }));
    assert.throws(() => execution.buildFragment({ ...input, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: { ...q.evidence, amountIn: amountIn - 1n } }));
    assert.throws(() => program.decode({ programInput: input, initialResults: results.map(v => ({ ...v, source: { ...source, generation: 2 } })), dependentEvidence: [] })); }
});
test("native aliases use common route boundary and forged executionAssets cannot change raw operation", () => {
  const f = fixture(2); f.coins[0] = NATIVE; const { d, rs } = setup(f); const mint = rs.find(v => v.direction === "mint" && v.index === 0)!;
  assert.equal(mint.tokenIn, WETH); assert.equal(mint.executionAssets?.input, "native");
  assert.throws(() => assertRoute(d, { ...mint, executionAssets: { input: "erc20", output: "erc20" } }));
  assert.throws(() => genericProgram(d, mint, actor, 1n, addr(354)));
});
test("state guards reject changed code, reciprocal identity and stale cached meta rates", () => {
  const f = fixture(2); f.basePool = addr(352); f.cached = f.fresh; const { d } = setup(f);
  const good = genericStateRequests(d).map(req => resolve(f, req)); assert.doesNotThrow(() => decodeGenericState(d, good, source));
  assert.throws(() => decodeGenericState(d, good.map(r => r.id === "g-pool-code" ? row(r.id, "0x6002") : r), source));
  f.cached = f.fresh - 1n; assert.throws(() => decodeGenericState(d, genericStateRequests(d).map(req => resolve(f, req)), source));
  f.cached = undefined; assert.throws(() => decodeGenericState(d, genericStateRequests(d).map(req => resolve(f, req)), source), /unproved base rate model/);
});
test("4096-byte scalar normalization is limited to a proved historical forwarder binding", () => {
  const { d } = setup(fixture(2)), raw = scalar(7n) + "00".repeat(4096 - 32);
  assert.equal(genericScalarData(d, raw), raw); assert.throws(() => genericQuoteResult(d, row("q", raw)));
  const forwarder = { ...d, generic: { ...d.generic!, forwarderBytes: 4096 as const } }; assert.equal(genericScalarData(forwarder, raw), scalar(7n));
  assert.equal(genericQuoteResult(forwarder, row("q", raw)), 7n);
});
test("generic pricing uses current state dependent fee-aware quotes only for admitted directions", () => {
  const f = fixture(3); f.noRedeem = true; const { d, rs } = setup(f), current: any = { descriptor: d, source }, initialResults = pricing.current.buildRequests(current).map(req => resolve(f, req));
  const dependent: any = pricing.current.buildDependentProgram!({ current, completedRound: 0, initialResults, priorEvidence: [] }), built = dependent.buildRequests ? dependent.buildRequests({}) : dependent,
    reads = Array.isArray(built) ? built : built.requests;
  assert.equal(reads.length, rs.length); assert(reads.every((r: any) => r.id.startsWith("g-mid-mint")));
});

test("production nomination/catalog/lifecycle publishes generic directions and preserves no-code/unknown-source distinction", async () => {
  const { createStrictCentralAdapterRuntime } = await import("../../../../strict-central-adapter-runtime.js");
  const { executeAdapterFamilyLifecycleBatch } = await import("../../../adapter-family-runtime.js");
  const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog } = await import("../../../production-family-composition.js");
  const { FAMILY } = await import("../manifest.js");
  for (const mode of ["positive", "no-code", "unknown", "reverse-unknown-class", "transport"] as const) {
    const f = fixture(3); if (mode === "no-code") f.code = "0x"; if (mode === "unknown") f.registered = false; if (mode === "reverse-unknown-class") f.reverse = addr(355);
    const provider = { async getCode(address: string) { const r = resolve(f, { id: "rpc-code", kind: "get-code", address }); assert(r.ok); return r.data; },
      async getStorage() { return scalar(0n); }, async call(tx: { to: string; data: string }) {
        if (mode === "transport" && tx.to.toLowerCase() === META) throw new Error("synthetic RPC connection failure");
        const r = resolve(f, { id: "rpc-call", kind: "eth-call", ...tx, completion: "return-data" }); assert(r.ok);
        if (r.completion !== "returned") throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data: "0x" }); return r.data; } };
    const observations = await discovery.nominate!.nominate({ nominations: [{ address: f.pool, opaque: { familyId: FAMILY } }], source, provider } as any);
    const runtime = createStrictCentralAdapterRuntime({ provider, executor: actor, transactionOrigin: addr(72),
      generationFence: { assertCurrent(g, s) { assert.equal(g, source.generation); assert.deepEqual(s, source); } },
      simulator: { executorProgramCodeHash: ethers.id("synthetic-generic-VM-capability"), async simulate({ request }) { const r = resolve(f, request); assert(r.ok); if (r.completion !== "returned") throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data: "0x" }); return { data: r.data, effects: r.effects }; } } });
    const matches = observations.flatMap(observation => catalog.matches(observation).filter(m => m.familyId === FAMILY).map(m => ({ observation, matchedPatternId: m.patternId })));
    assert(matches.length > 0); let published = 0;
    const result = await executeAdapterFamilyLifecycleBatch({ family: catalog.forFamily(FAMILY), matches, source, generation: source.generation, runtime, publisher: { publish() { published++; } } });
    if (mode === "positive") { assert.equal(published, 1, JSON.stringify(result.outcomes)); assert.equal(result.publication!.instances[0].routes.length, 6); }
    else { assert.equal(published, 0); assert.equal(result.publication, null); const outcome = result.outcomes.find(v => v.stage === "identity"); assert(outcome);
      if (mode === "no-code") { assert.equal(outcome.status, "rejected", JSON.stringify(outcome)); assert.match(outcome.reasonCode!, /chain-proven.*no-code/); }
      else { assert.equal(outcome.status, "unresolved", JSON.stringify(outcome));
        if (mode === "transport") assert.match(outcome.reasonCode!, /:rpc:/);
        // Current central precedence retains unknown alternatives. An individual
        // variant rejection is deliberately not relabeled whole-Family rejection.
        else assert.match(outcome.reasonCode!, /identity-work-unresolved:/); }
    }
  }
});

test("production sim construction uses generic runtime without off-chain Exact or quoted fallback", async () => {
  const { RuntimeAmountProgram } = await import("../../../../../adapters/runtime-amount-program.js");
  const { createBlockScanSimAmountSelector } = await import("../../../../simulator/blockscan-sim-amount-selector.js");
  const { d, rs } = setup(fixture(3)); let exact = 0, quoted = 0, rpc = 0, simulated = 0;
  for (const r of rs) { const edges = [{ adapterId: "curve-lp", target: d.pool, tokenIn: r.tokenIn, tokenOut: r.tokenOut },
      { adapterId: "fixture-return", target: actor, tokenIn: r.tokenOut, tokenOut: r.tokenIn }];
    const session: any = { source, blocksPrefixInversion: () => false, fundingActionIds: () => ["fixture-funding"], buildRuntimeAmountLeg({ edge }: any) {
      return edge === edges[0] ? execution.buildRuntimeLeg({ descriptor: d, route: r, source, executor: actor, runtimeEvidence: [] }) :
        { actionAdapterId: "fixture-return", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()) }; },
      issueExact() { exact++; throw new Error("forbidden Exact"); }, buildExecution() { quoted++; throw new Error("forbidden quoted fallback"); },
      buildFundingRoot(i: any) { return { adapterId: "fixture-funding", target: actor, tokenIn: r.tokenIn, tokenOut: r.tokenIn, amount: i.amount, params: {}, children: i.children }; } };
    const selector = createBlockScanSimAmountSelector({ source, executor: actor, async simulate() { simulated++; return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: r.tokenIn, calldata: "0x" }; } });
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n }, flashToken: r.tokenIn, profitToken: r.tokenIn }, tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "curve-lp-generic-fixture" } as any,
      { call() { rpc++; throw new Error("forbidden RPC"); } } as any, { executor: actor } as any,
      { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
  }
  assert.equal(exact, 0); assert.equal(quoted, 0); assert.equal(rpc, 0); assert(simulated >= rs.length * 6);
});


test("all saved deployed AddLiquidity/RemoveLiquidityOne event ABIs naturally nominate and reject malformed payloads", () => {
  const signatures = new Set<string>();
  for (const saved of verifiedFixtures.events) {
    for (const event of saved.abi.filter((v: any) => v.type === "event" && ["AddLiquidity", "RemoveLiquidityOne"].includes(v.name))) {
      const iface = new ethers.Interface([event]), fragment = iface.getEvent(event.name)!, signature = fragment.format("full");
      if (signatures.has(signature)) continue; signatures.add(signature);
      const args = event.inputs.map((v: any, i: number) => v.type === "address" ? i === 0 ? actor : addr(399) : v.type.includes("[") ? Array(Number(v.type.match(/\[(\d+)\]/)[1])).fill(1n) : 1n),
        encoded = iface.encodeEventLog(fragment, args), observation = { kind: "log" as const, source, address: addr(398), ...encoded },
        patterns = discovery.logPatterns.filter(v => v.topic === fragment.topicHash);
      assert(patterns.length > 0, `missing deployed event ${signature}`);
      assert(patterns.some(p => discovery.decodeCandidate({ observation, matchedPatternId: p.id })?.pool === observation.address), `no canonical decode ${signature}`);
      assert(patterns.every(p => discovery.decodeCandidate({ observation: { ...observation, data: observation.data + "00" }, matchedPatternId: p.id }) === null));
    }
  }
  assert(signatures.size >= 10);
});
