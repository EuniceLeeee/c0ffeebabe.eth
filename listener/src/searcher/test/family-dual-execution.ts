import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD as load } from "../venues/production-family-composition.js";
import { createBlockScanSimAmountSelector } from "../simulator/blockscan-sim-amount-selector.js";
import { inspectRuntime } from "./runtime-program-testkit.js";
import { PSM_INTERFACE, PSM_WAD, psmBuyQuote, psmBuyCost } from "../venues/protocols/psm-family/codec.js";
import { MODES, EXECUTION, executionFunction, pullsInput } from "../venues/swaps/curve-plain-family/codec.js";
import { ROUTER, PERMIT2, PERMIT2_ABI, ROUTER_ABI } from "../venues/swaps/balancer-v3-family/codec.js";
import { METRONOME_HGUSDC_ROUTER_INTERFACE } from "../venues/protocols/metronome-hgusdc-family/shared.js";
import { METRONOME_HGUSDC_PATH } from "../../adapters/metronome-hgusdc.js";
import { ANGSTROM_ADAPTER_SWAP_ABI } from "../venues/swaps/angstrom-attestation.js";
import { descriptor as ekuboFixture } from "../venues/swaps/ekubo-family/test/fixtures.js";
import { candidate as ekuboCandidate } from "../venues/swaps/ekubo-family/codec.js";
import { identity as ekuboIdentity } from "../venues/swaps/ekubo-family/test/fixtures.js";
import { ekuboRouterIface, EKUBO_ROUTER } from "../venues/swaps/ekubo/abi.js";
import { EKUBO_SUPPORTED_CORE_HASH, EKUBO_SUPPORTED_ROUTER_HASH, EKUBO_SUPPORTED_TWAMM_HASH } from "../venues/swaps/ekubo-family/extension.js";
import { hookDataFor } from "../venues/swaps/univ4-fee-hook-family/sat1.js";
import { UNIV4_FEE_HOOK_ADDRESS } from "../venues/swaps/univ4-fee-hook-family/manifest.js";
import { v4PoolId } from "../venues/swaps/univ4-common.js";

const executor = ethers.getAddress("0x1000000000000000000000000000000000000002");
const origin = ethers.getAddress("0x1000000000000000000000000000000000000003");
const foreign = ethers.getAddress("0x1000000000000000000000000000000000000004");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const source = Object.freeze({ number: 26088150, hash: "0x" + "ab".repeat(32), generation: 7 });
const erc20 = new ethers.Interface(["function approve(address,uint256) returns(bool)",
  "function transfer(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)",
  "function withdraw(uint256)", "function deposit() payable"]);
const word = (x: bigint) => ethers.toBeHex(x, 32);
const installed = [...load.plugins, ...load.disabledPlugins];
const priced = installed.filter(x => ["swap", "protocol"].includes(x.plugin.manifest.domain));
const family = (id: string): any => { const found = priced.find(x => x.familyId === id); assert(found, id); return found.plugin; };
const raw = JSON.parse(readFileSync(new URL("./fixtures/runtime-family-descriptors.json", import.meta.url), "utf8"),
  (_key, value) => value?.$durableType === "bigint" ? BigInt(value.value) : value);
const fixtures: any[] = raw.descriptors;
// These four missing Ready families are synthetic ABI fixtures, not minted
// identity/admission records. Normal strict/Ready verification is NOT bypassed.
function synthetic(id: string, fields: Record<string, unknown>, lineage = 0) {
  const p = family(id), identity = { familyId: id, lineageId: p.manifest.supportedLineages[lineage],
    subject: foreign, provenance: [], ...fields };
  const d = p.instance.finalizeDescriptor({ identity, draft: p.instance.compileDraft(identity), sharedBindings: [] });
  fixtures.push(d); return d;
}
synthetic("protocol:self-burn-native", { token: foreign });
synthetic("protocol:metronome-hgusdc", { router: foreign });
synthetic("protocol:metronome-synth", { pool: foreign, tokens: [ADDR.MSETH, ADDR.MSBTC],
  directions: [{ tokenIn: ADDR.MSETH, tokenOut: ADDR.MSBTC }, { tokenIn: ADDR.MSBTC, tokenOut: ADDR.MSETH }] });
synthetic("protocol:token-conversion", { variant: "btb-bear-v1", asset: ADDR.USDC, codeHash: word(1n), assetCodeHash: word(2n) });
const xwin = synthetic("protocol:token-conversion", { variant: "xwin-allocations-v1", asset: ADDR.USDC,
  codeHash: word(3n), proxyAdmin: ethers.getAddress("0x1000000000000000000000000000000000000005") }, 1);
const dFor = (id: string) => { const d = fixtures.find(d => d.familyId === id); assert(d, id); return d; };
// Additional synthetic direction/variant fixtures are never written back to Ready.
synthetic("protocol:erc4626", { asset: ADDR.USDC, verifiedDirections: { deposit: true, redeem: true } });
const sat1Fixture = dFor("univ4-fee-hook");
const tieredKey = { ...sat1Fixture.poolKey, hooks: UNIV4_FEE_HOOK_ADDRESS };
synthetic("univ4-fee-hook", { facts: { poolId: v4PoolId(tieredKey), poolKey: tieredKey,
  managerBinding: sat1Fixture.managerBinding } });
const inputFor = (d: any, route: any) => ({ descriptor: d, route, executor, transactionOrigin: origin, runtimeEvidence: [], source });
const build = (d: any, r: any) => { const l = family(d.familyId).execution.buildRuntimeLeg(inputFor(d, r)); assert(l); return l; };
const routes = (d: any): any[] => family(d.familyId).routes.project({ descriptor: d });

test("every installed swap/protocol Family, including disabled entries, has both real interfaces and a behavior fixture", () => {
  assert.deepEqual([...new Set(fixtures.map(d => d.familyId))].sort(), priced.map(x => x.familyId).sort());
  for (const entry of priced) {
    assert.equal(typeof (entry.plugin as any).exact.methods, "function", entry.familyId);
    assert.equal(typeof (entry.plugin as any).execution.buildRuntimeLeg, "function", entry.familyId);
  }
  for (const entry of installed.filter(x => !priced.includes(x))) {
    const p: any = entry.plugin;
    assert(["funding", "credit"].includes(p.manifest.domain));
    assert(p[p.manifest.domain], entry.familyId + " must retain its own domain capability");
  }
});

for (const d of fixtures) test(d.familyId + (d.variant ? ":" + d.variant : "") + ": all projected directions construct without a quoted amount and reject foreign tokens", () => {
  const p = family(d.familyId);
  assert(routes(d).length > 0);
  for (const r of routes(d)) {
    const i: any = inputFor(d, r);
    for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
      Object.defineProperty(i, key, { get() { throw Error("runtime construction accessed " + key); } });
    const leg = p.execution.buildRuntimeLeg(i);
    assert(leg && /^0x01/.test(leg.program));
    assert(p.actionAdapters.some((a: any) => a.id === leg.actionAdapterId), "must use Family-owned action");
    assert.throws(() => p.execution.buildRuntimeLeg({ ...inputFor(d, r), route: { ...r, tokenOut: executor } }));
    assert(p.exact.methods({ ...inputFor(d, r), amountIn: 123456789n }).length > 0,
      "explicit-amount quote capability must not disappear");
  }
});

test("production sim selector uses each real Family emitter, never Exact, and retains coarse/fine amount search", async () => {
  for (const d of fixtures) for (const r of routes(d)) {
    const target = d.pool ?? d.target ?? d.vault ?? d.router ?? foreign;
    const edges: any[] = [{ adapterId: "family-leg", target, tokenIn: r.tokenIn, tokenOut: r.tokenOut },
      { adapterId: "fixture-return", target: executor, tokenIn: r.tokenOut, tokenOut: r.tokenIn }];
    let exact = 0, builds = 0, simulated = 0; const events: any[] = [];
    const session: any = { source, fundingActionIds: () => ["verified-fixture-funding"],
      buildRuntimeAmountLeg({ edge }: any) { return edge === edges[0] ? build(d, r) :
        { actionAdapterId: "fixture-return", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()) }; },
      issueExact() { exact++; throw Error("unexpected chain-external hop quote"); },
      buildExecution() { builds++; throw Error("unexpected quoted construction"); },
      buildFundingRoot(i: any) { return { adapterId: "fixture", target: executor, tokenIn: r.tokenIn,
        tokenOut: r.tokenIn, amount: i.amount, params: {}, children: i.children }; } };
    const selector = createBlockScanSimAmountSelector({ source, executor, record: e => events.push(e),
      async simulate(plan) { simulated++;
        const flow = plan.root.children[0]!;
        assert.equal(flow.adapterId, "runtime-amount-flow");
        assert.equal(JSON.parse(flow.params.legs as string)[0].program, build(d, r).program);
        return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: r.tokenIn, calldata: "0x" };
      } });
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n },
      flashToken: r.tokenIn, profitToken: r.tokenIn }, tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "contract-fixture" } as any,
      { call() { throw Error("unexpected RPC"); } } as any, { executor } as any,
      { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
    assert.equal(exact, 0, d.familyId); assert.equal(builds, 0);
    assert(simulated >= 4);
    assert(events.filter(e => e.type === "sim_amount_construction").every(e => e.mode === "runtime-actual"));
  }
});

// ABI argument assertions are independent of emitter offsets. Multiple amounts
// must patch exactly the protocol's amount argument and preserve receivers.
const direct = [
  ["protocol:astra-multitoken", "change(address,address,uint256,uint256)", "change", 2],
  ["protocol:eigenpie", "depositAsset(address,uint256,uint256,address)", "depositAsset", 1],
  ["protocol:erc4626-silo-redeem", "redeem(address,uint256,address,address)", "redeem", 1],
  ["protocol:goldx", "mint(address,uint256)", "mint", 1],
  ["protocol:rocksolid", "syncDeposit(uint256,address,address)", "syncDeposit", 0],
  ["protocol:metronome-synth", "swap(address,address,uint256)", "swap", 2],
  ["protocol:token-migration", "migrateBIT(uint256)", "migrateBIT", 0],
  ["fluid-dex", "swapIn(bool,uint256,uint256,address)", "swapIn", 1],
  ["curve-underlying", "exchange_underlying(int128,int128,uint256,uint256)", "exchange_underlying", 2],
] as const;
for (const [id, signature, method, arg] of direct)
test(id + ": runtime ABI uses actual input for each direction and keeps approvals explicit", () => {
  const d = dFor(id), abi = new ethers.Interface(["function " + signature]);
  for (const r of routes(d)) for (const amount of [19n, 123456789n, 10n ** 18n]) {
    const trace = inspectRuntime(build(d, r).program, amount);
    const calls = trace.calls.filter(c => c.data.slice(0, 10) === abi.getFunction(method)!.selector);
    assert.equal(calls.length, 1);
    assert.equal(abi.decodeFunctionData(method, calls[0].data)[arg], amount);
    const temporary = trace.calls.filter(c => c.data.slice(0, 10) === erc20.getFunction("approve")!.selector);
    if (temporary.length) assert.deepEqual(temporary.map(c => erc20.decodeFunctionData("approve", c.data)[1]), [0n, amount, 0n]);
    for (const a of trace.allowances) assert.equal(a.minimum, amount);
  }
});

for (const id of ["protocol:erc4626", "protocol:wsteth", "protocol:token-conversion"])
test(id + ": both amount directions preserve method, recipient and temporary allowance semantics", () => {
  for (const d of fixtures.filter(d => d.familyId === id)) for (const r of routes(d)) for (const amount of [19n, 123456789n]) {
    const abi = new ethers.Interface(id === "protocol:erc4626"
      ? ["function deposit(uint256,address)", "function redeem(uint256,address,address)"]
      : id === "protocol:wsteth" ? ["function wrap(uint256)", "function unwrap(uint256)"]
      : d.variant === "btb-bear-v1" ? ["function mint(uint256)", "function redeem(uint256)"]
      : ["function deposit(uint256,uint32)", "function withdraw(uint256,uint32)"]);
    const method = id !== "protocol:token-conversion" || d.variant === "btb-bear-v1" ? r.direction : r.direction === "mint" ? "deposit" : "withdraw";
    const trace = inspectRuntime(build(d, r).program, amount);
    const calls = trace.calls.filter(c => c.data.slice(0, 10) === abi.getFunction(method)!.selector);
    assert.equal(calls.length, 1); const args = abi.decodeFunctionData(method, calls[0].data);
    assert.equal(args[0], amount);
    if (id === "protocol:erc4626") { assert.equal(args[1], executor); if (r.direction === "redeem") assert.equal(args[2], executor); }
    if (d.variant === "xwin-allocations-v1") assert.equal(args[1], 0n);
    const approves = trace.calls.filter(c => c.data.startsWith(erc20.getFunction("approve")!.selector));
    if (id === "protocol:token-conversion" && r.direction === "mint")
      assert.deepEqual(approves.map(c => erc20.decodeFunctionData("approve", c.data)[1]), [0n, amount, 0n]);
  }
});

test("Balancer V3 exact temporary ERC20/Permit2 approvals, recipient policy and uint160 boundary", () => {
  const d = dFor("balancer-v3");
  for (const r of routes(d)) for (const amount of [1n, 123456789n, (1n << 160n) - 1n]) {
    const trace = inspectRuntime(build(d, r).program, amount);
    const tokenApproves = trace.calls.filter(c => c.target === r.tokenIn);
    assert.deepEqual(tokenApproves.map(c => [...erc20.decodeFunctionData("approve", c.data)]), [[PERMIT2, 0n], [PERMIT2, amount], [PERMIT2, 0n]]);
    const permits = trace.calls.filter(c => c.target === PERMIT2).map(c => PERMIT2_ABI.decodeFunctionData("approve", c.data));
    assert.equal(permits.length, 2); assert.equal(permits[0][1], ROUTER); assert.equal(permits[0][2], amount);
    assert.equal(permits[1][2], 0n); assert.equal(permits[1][3], 0n);
    const call = trace.calls.find(c => c.target === ROUTER)!;
    const args = ROUTER_ABI.decodeFunctionData("swapSingleTokenExactIn", call.data);
    assert.deepEqual([...args].slice(0, 5), [d.pool, r.tokenIn, r.tokenOut, amount, 1n]); assert.equal(args[6], false);
  }
  assert.throws(() => inspectRuntime(build(d, routes(d)[0]).program, 1n << 160n), /mismatch/);
});

test("Curve all five admitted execution modes: received dx is credit delta, never pool inventory", () => {
  const base = dFor("curve-plain");
  for (const mode of MODES) {
    const d = { ...base, directions: base.directions.map((r: any) => ({ ...r, executionMode: mode })) };
    for (const r of routes(d)) for (const amount of [100n, 123456789n]) {
      let reads = 0; const credited = amount * 9n / 10n;
      const trace = inspectRuntime(build(d, r).program, amount, { call(c) {
        if (c.data.startsWith(erc20.getFunction("balanceOf")!.selector)) return word(1000000000n + (++reads === 1 ? 0n : credited));
        return "0x";
      } });
      const call = trace.calls.find(c => same(c.target, d.pool))!;
      const args = EXECUTION[mode].decodeFunctionData(executionFunction(mode), call.data);
      assert.equal(args[0], BigInt(r.i)); assert.equal(args[1], BigInt(r.j));
      assert.equal(args[2], pullsInput(mode) ? amount : credited); assert.equal(args[3], 1n);
      if (args.length === 5) assert.equal(args[4], executor);
      assert.equal(trace.allowances.length, pullsInput(mode) ? 1 : 0);
    }
  }
});

test("PSM both directions read the current fee in the transaction and match integer cost/rounding", () => {
  const d = dFor("protocol:psm");
  for (const r of routes(d)) for (const fee of [0n, 1n, 10n ** 15n, PSM_WAD]) for (const amount of [10n ** 18n, 123456789012345678901n]) {
    const trace = inspectRuntime(build(d, r).program, amount, { call(c) {
      return c.static ? PSM_INTERFACE.encodeFunctionResult("tout", [fee]) : "0x";
    } });
    const last = trace.calls.at(-1)!;
    const sell = r.direction === "sell-gem", method = sell ? "sellGem" : "buyGem";
    const args = PSM_INTERFACE.decodeFunctionData(method, last.data);
    assert.equal(args[0], executor); assert.equal(args[1], sell ? amount : psmBuyQuote(amount, fee, d.decimalScale));
    if (!sell) { assert(psmBuyCost(args[1], fee, d.decimalScale) <= amount);
      assert(psmBuyCost(args[1] + 1n, fee, d.decimalScale) > amount); }
  }
  const buy = routes(d).find(r => r.direction === "buy-gem");
  assert.throws(() => inspectRuntime(build(d, buy).program, 10n ** 18n, { call: () => word(PSM_WAD + 1n) }), /checked/);
});

test("native receipt families wrap the independently observed delta, not an expected output or old ETH", () => {
  for (const id of ["protocol:self-burn-native", "protocol:ethertoken-native-redeem", "ella-exchange", "custom-swap:uniswap-v1"]) {
    const d = dFor(id);
    for (const r of routes(d)) for (const amount of [11n, 123456789n]) {
      const outputNative = r.tokenOut.toLowerCase() === ADDR.WETH.toLowerCase();
      let native = 777n;
      const trace = inspectRuntime(build(d, r).program, amount, { nativeBalance: () => native, call(c) {
        if (outputNative && c.target.toLowerCase() !== ADDR.WETH.toLowerCase() && !c.static &&
            !c.data.startsWith(erc20.getFunction("approve")!.selector)) native += 319n;
        return "0x";
      } });
      if (outputNative) {
        const wrap = trace.calls.find(c => c.data === erc20.encodeFunctionData("deposit"))!;
        assert(wrap); assert.equal(wrap.value, 319n);
      } else {
        const withdraw = trace.calls.find(c => c.data.startsWith(erc20.getFunction("withdraw")!.selector))!;
        assert.equal(erc20.decodeFunctionData("withdraw", withdraw.data)[0], amount);
        assert.equal(trace.calls.find(c => same(c.target, d.pool))!.value, amount);
      }
    }
  }
});

test("DODO requires origin, transfers actual input and routes sellBase/sellQuote to executor", () => {
  const d = dFor("custom-swap:dodo-v2"), abi = new ethers.Interface(["function sellBase(address)", "function sellQuote(address)"]);
  for (const r of routes(d)) {
    assert.throws(() => family(d.familyId).execution.buildRuntimeLeg({ ...inputFor(d, r), transactionOrigin: undefined }), /origin/);
    const trace = inspectRuntime(build(d, r).program, 151n);
    assert.deepEqual([...erc20.decodeFunctionData("transfer", trace.calls[0].data)], [d.pool, 151n]);
    assert.deepEqual([...abi.decodeFunctionData(r.direction === "sell-base" ? "sellBase" : "sellQuote", trace.calls[1].data)], [executor]);
  }
  const r = routes(xwin)[0];
  assert.throws(() => family(xwin.familyId).execution.buildRuntimeLeg({ ...inputFor(xwin, r), transactionOrigin: undefined }), /origin/);
  assert.throws(() => family(xwin.familyId).execution.buildRuntimeLeg({ ...inputFor(xwin, r), executor: xwin.proxyAdmin }), /executor/);
});

test("Metronome hgUSDC patches the dynamic amounts array, not encoded path bytes", () => {
  const d = dFor("protocol:metronome-hgusdc"), r = routes(d)[0];
  for (const amount of [17n, 123456789n]) {
    const trace = inspectRuntime(build(d, r).program, amount);
    assert.deepEqual([...erc20.decodeFunctionData("transfer", trace.calls[0].data)], [d.curve, amount]);
    const args = METRONOME_HGUSDC_ROUTER_INTERFACE.decodeFunctionData("executePath", trace.calls[1].data);
    assert.equal(args[0], METRONOME_HGUSDC_PATH); assert.deepEqual([...args[1]], [amount]); assert.equal(args[2], ethers.ZeroAddress);
  }
});

test("Angstrom source-unlocked input retains the real source block and uint128 amount; never forges attestations", () => {
  const d = dFor("custom-swap:angstrom-v4"), abi = new ethers.Interface(ANGSTROM_ADAPTER_SWAP_ABI);
  for (const r of routes(d)) {
    for (const number of [source.number, source.number + 1]) {
      const i = { ...inputFor(d, r), source: { ...source, number } };
      const leg = family(d.familyId).execution.buildRuntimeLeg(i);
      const trace = inspectRuntime(leg.program, 331n), call = trace.calls[0];
      const args = abi.decodeFunctionData("swap", call.data);
      assert.equal(args[2], 331n); assert.equal(args[3], 1n); assert.equal(args[4].length, 1);
      assert.equal(args[4][0][0], BigInt(number)); assert.equal(args[4][0][1], "0x"); assert.equal(args[5], executor);
      assert.throws(() => inspectRuntime(leg.program, 1n << 128n), /mismatch/);
    }
    assert.throws(() => family(d.familyId).execution.buildRuntimeLeg({ ...inputFor(d, r), source: undefined }), /source/);
    assert.throws(() => family(d.familyId).execution.buildRuntimeLeg({ ...inputFor(d, r), runtimeEvidence: [{}] }));
  }
});

test("Ekubo covers ERC20 and native both ways without changing signed input semantics", () => {
  const normal = dFor("custom-swap:ekubo-router-v1");
  const baseIdentity = ekuboIdentity();
  const found = ekuboCandidate({ ...normal.poolKey, token0: ethers.ZeroAddress });
  // As in the Family extension-native contract: a synthetic descriptor with
  // the known Core/Router behavior binding, NOT a fabricated strict result.
  const native = ekuboFixture({ ...baseIdentity, subject: found.poolId, facts: { ...baseIdentity.facts, ...found,
    coreCodeHash: EKUBO_SUPPORTED_CORE_HASH, routerCodeHash: EKUBO_SUPPORTED_ROUTER_HASH, decimals: [18, 6] } });
  const extension = "0xd47f1b1edcfeabb08f6ebd8fc337c27e636c75ba";
  const twamm = [normal.poolKey, native.poolKey].map(key => {
    const found = ekuboCandidate({ ...key, config: extension + "00c49ba5e353f7ce00000000" });
    return ekuboFixture({ ...baseIdentity, subject: found.poolId, facts: { ...baseIdentity.facts, ...found,
      coreCodeHash: EKUBO_SUPPORTED_CORE_HASH, routerCodeHash: EKUBO_SUPPORTED_ROUTER_HASH,
      extensionCodeHash: EKUBO_SUPPORTED_TWAMM_HASH, decimals: [18, 6] } });
  });
  for (const d of [normal, native, ...twamm]) for (const r of routes(d)) {
    let balance = 999n;
    const trace = inspectRuntime(build(d, r).program, 551n, { nativeBalance: () => balance, call(c) {
      if (same(c.target, EKUBO_ROUTER)) balance += 343n;
      return "0x";
    } });
    const call = trace.calls.find(c => same(c.target, EKUBO_ROUTER))!;
    const args = ekuboRouterIface.decodeFunctionData("swap", call.data);
    assert.equal(args[1], r.isToken1); assert.equal(args[2], 551n); assert.equal(args[5], 1n); assert.equal(args[6], executor);
    assert.equal(call.value, d.poolKey.token0 === ethers.ZeroAddress && !r.isToken1 ? 551n : 0n);
    if (d.poolKey.token0 === ethers.ZeroAddress && r.isToken1)
      assert.equal(trace.calls.find(c => c.data === erc20.encodeFunctionData("deposit"))!.value, 343n);
    assert.throws(() => inspectRuntime(build(d, r).program, 1n << 127n), /mismatch/);
  }
});

test("V4 fee hook executes the shared actual-debt callback with Family hookData, both directions", () => {
  const abi = new ethers.Interface(["function unlock(bytes)",
    "function swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes) returns(int256)",
    "function take(address,address,uint256)", "function settle() payable returns(uint256)"]);
  for (const d of fixtures.filter(d => d.familyId === "univ4-fee-hook")) for (const r of routes(d)) {
    const outer = inspectRuntime(build(d, r).program, 551n), call = outer.calls[0];
    assert.equal(call.incoming, 68); assert.equal(call.outgoing, 68);
    const script = ethers.getBytes(abi.decodeFunctionData("unlock", call.data)[0]);
    assert.equal(BigInt(ethers.hexlify(script.slice(1, 33))), 551n);
    const size = Number(BigInt(ethers.hexlify(script.slice(33, 36))));
    const zero = r.direction === "zero-for-one", debt = 531n, out = 339n;
    const packed = zero ? (BigInt.asUintN(128, -debt) << 128n) | out : (out << 128n) | BigInt.asUintN(128, -debt);
    const inner = inspectRuntime(ethers.hexlify(script.slice(36, 36 + size)), 551n, { call(c) {
      if (c.data.startsWith(abi.getFunction("swap")!.selector)) return word(packed);
      if (c.data.startsWith(abi.getFunction("settle")!.selector)) return word(debt);
      return "0x";
    } });
    const swap = inner.calls.find(c => c.data.startsWith(abi.getFunction("swap")!.selector))!;
    const args = abi.decodeFunctionData("swap", swap.data);
    assert.equal(args[1][1], -551n); assert.equal(args[2], hookDataFor(d, executor, zero));
    const take = inner.calls.find(c => c.data.startsWith(abi.getFunction("take")!.selector))!;
    assert.deepEqual([...abi.decodeFunctionData("take", take.data)], [r.realTokenOut, executor, out]);
  }
});
