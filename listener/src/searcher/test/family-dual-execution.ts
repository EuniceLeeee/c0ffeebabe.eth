import { descriptor as aquaFixture } from "../venues/swaps/aqua-swapvm-family/test/fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD as load } from "../venues/production-family-composition.js";
import { createBlockScanSimAmountSelector } from "../simulator/blockscan-sim-amount-selector.js";
import { inspectRuntime, type RuntimeCall } from "./runtime-program-testkit.js";
import { applyRuntimeAssetBoundary, mapRuntimeAssetSettlementRequest } from "../execution-asset-boundary.js";
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
import { descriptor as balancerV1Fixture } from "../venues/swaps/balancer-v1-family/test/fixtures.js";
import { setup as balancerV2Fixture, fixture as balancerV2Responses } from "../venues/swaps/balancer-v2-family/test/fixtures.js";
import { descriptor as compoundCTokenFixture } from "../venues/protocols/compound-ctoken-family/test/fixtures.js";
import { descriptor as algebraIntegralFixture } from "../venues/swaps/algebra-integral-family/test/fixtures.js";
import { descriptor as kyberswapElasticFixture } from "../venues/swaps/kyberswap-elastic-family/test/fixtures.js";
import { descriptor as yieldBasisLtFixture, answerFor as yieldBasisAnswers } from "../venues/protocols/yieldbasis-lt-family/test/fixtures.js";
import { setup as yearnAuctionFixture } from "../venues/protocols/yearn-auction-family/test/fixtures.js";
import { setup as curveLpFixture } from "../venues/protocols/curve-lp-family/test/fixtures.js";
import { descriptor as fewWrappedFixture } from "../venues/protocols/few-wrapped-family/test/fixtures.js";
import { descriptor as vaultSpotFixture } from "../venues/swaps/vault-spot-family/test/fixtures.js";


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
fixtures.push(fewWrappedFixture());
fixtures.push(vaultSpotFixture());
fixtures.push(aquaFixture());
// These saved Fluid fixtures are ERC20-only. Upgrade their test shape, not
// production Ready: real stale descriptors must still be re-attested.
for (const d of fixtures.filter(d => d.familyId === "fluid-dex")) {
  d.rawToken0 = d.token0;
  d.rawToken1 = d.token1;
}
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
// Synthetic Set basket: ABI/selector coverage only, not historical admission.
synthetic("protocol:set-redemption", { binding: { set: foreign,
  module: ethers.getAddress("0x1000000000000000000000000000000000000005"),
  controller: ethers.getAddress("0x1000000000000000000000000000000000000006"),
  controllerCodeHash: word(4n), components: [ADDR.USDC, ADDR.WETH, ADDR.DAI, ADDR.USDT].map(a => a.toLowerCase()),
} });
// New installed entries receive offline emitter coverage even while disabled.
// These descriptors remain synthetic; no Ready/admission objects are issued.
fixtures.push(balancerV1Fixture(), balancerV2Fixture().descriptor,
  balancerV2Fixture(balancerV2Responses([ADDR.WETH, ADDR.DAI, ADDR.USDC], [18, 18, 6])).descriptor);
synthetic("protocol:badger-sett-withdraw", { binding: {
  vault: foreign.toLowerCase(),
  vaultImplementation: "0x1000000000000000000000000000000000000005",
  strategy: "0x1000000000000000000000000000000000000006",
  strategyImplementation: "0x1000000000000000000000000000000000000007",
  asset: "0xc0c293ce456ff0ed870add98a0828dd4d2903dbf",
  locker: "0x1000000000000000000000000000000000000008",
  vaultAdmin: "0x1000000000000000000000000000000000000009",
  strategyAdmin: "0x1000000000000000000000000000000000000009",
} });

// Synthetic single-asset POD only; production identity is verified separately.
synthetic("protocol:peapods-debond", { binding: { pod: foreign.toLowerCase(), asset: ADDR.USDC.toLowerCase(),
  staking: "0x1000000000000000000000000000000000000005", codeHash: word(1n), assetCodeHash: word(2n),
  stakingCodeHash: word(3n), decimals: 6, feeBps: 200n } });
// Synthetic PSV ABI coverage only; production admission is not fabricated.
synthetic("protocol:psv", { binding: { target: foreign.toLowerCase(), implementation: "0x1000000000000000000000000000000000000005",
  proxyCodeHash: word(1n), implementationCodeHash: word(2n), gem: ADDR.USDC.toLowerCase(), stable: ADDR.DAI.toLowerCase(),
  gemCodeHash: word(3n), stableCodeHash: word(4n), gemDecimals: 6, stableDecimals: 18 } });
// Algebra Integral: static-fee (plugin DYNAMIC_FEE clear) exact-input swap.
// Synthetic descriptor only: no Ready/admission object is issued here.
fixtures.push(algebraIntegralFixture());
// Compound V2 cToken: registry-admitted share redemption (deepseek four-family branch).
// Synthetic descriptor only: no Ready/admission object is issued here.
fixtures.push(compoundCTokenFixture());
fixtures.push(kyberswapElasticFixture());
// Yield Basis LT: LevAMM-bound single-asset crypto redemption (deepseek four-family branch).
// Synthetic descriptor only: no Ready/admission object is issued here.
fixtures.push(yieldBasisLtFixture(), yieldBasisLtFixture(yieldBasisAnswers({ deposit: true })));
// Synthetic maximum-budget auction; historical debit/receipt proof is separate.
fixtures.push(yearnAuctionFixture().d);
// Four synthetic coin/LP directions; historical receipt evidence is separate.
fixtures.push(curveLpFixture().d);
const dFor = (id: string) => { const d = fixtures.find(d => d.familyId === id); assert(d, id); return d; };
// Both Fluid native-token positions also go through the real sim selector's
// no-Exact/no-quoted-fallback construction contract. Synthetic, never Ready.
const fluidBase = dFor("fluid-dex"), fluidNative = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
fixtures.push({ ...fluidBase, rawToken0: fluidNative, token0: ADDR.WETH, rawToken1: foreign, token1: foreign,
  token0Decimals: 18, token1Decimals: 18 },
{ ...fluidBase, rawToken0: foreign, token0: foreign, rawToken1: fluidNative, token1: ADDR.WETH,
  token0Decimals: 18, token1Decimals: 18 });
// Additional synthetic direction/variant fixtures are never written back to Ready.
synthetic("protocol:erc4626", { asset: ADDR.USDC, verifiedDirections: { deposit: true, redeem: true } });
const sat1Fixture = dFor("univ4-fee-hook");
const tieredKey = { ...sat1Fixture.poolKey, hooks: UNIV4_FEE_HOOK_ADDRESS };
synthetic("univ4-fee-hook", { facts: { poolId: v4PoolId(tieredKey), poolKey: tieredKey,
  managerBinding: sat1Fixture.managerBinding } });
const inputFor = (d: any, route: any) => ({ descriptor: d, route, executor, transactionOrigin: origin, runtimeEvidence: [], source });
const build = (d: any, r: any) => { const l = family(d.familyId).execution.buildRuntimeLeg(inputFor(d, r)); assert(l); return l; };
const routes = (d: any): any[] => family(d.familyId).routes.project({ descriptor: d });

// These existing ABI variants also go through the production selector contract,
// not only the local instruction interpreter. They remain synthetic descriptors.
const curveBase = dFor("curve-plain");
const curveModeFixtures = MODES.map(mode => ({ ...curveBase,
  directions: curveBase.directions.map((r: any) => ({ ...r, executionMode: mode })) }));
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
const ekuboVariants = [normal, native, ...twamm];
fixtures.push(...curveModeFixtures, native, ...twamm);

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
      blocksPrefixInversion: () => false,
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
  ["protocol:peapods-debond", "debond(uint256,address[],uint8[])", "debond", 0],
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
  for (const d of curveModeFixtures) {
    const mode: (typeof MODES)[number] = d.directions[0].executionMode;
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
  const subscript = new ethers.Interface(["function execSubscript(bytes)"]);
  for (const id of ["protocol:self-burn-native", "protocol:ethertoken-native-redeem", "ella-exchange", "custom-swap:uniswap-v1"]) {
    const d = dFor(id);
    for (const r of routes(d)) for (const amount of [11n, 123456789n]) {
      const outputNative = r.tokenOut.toLowerCase() === ADDR.WETH.toLowerCase();
      let native = 777n;
      const balances = new Map([[r.tokenIn.toLowerCase(), 777n + amount], [r.tokenOut.toLowerCase(), 777n]]);
      const calls: RuntimeCall[] = [];
      const credit = (token: string, delta: bigint) => {
        const key = token.toLowerCase(), next = balances.get(key)! + delta;
        assert(next >= 0n, "synthetic token balance underflow"); balances.set(key, next);
      };
      const call = (c: RuntimeCall): string => {
        calls.push(c);
        if (c.static && c.data.startsWith(erc20.getFunction("balanceOf")!.selector)) return word(balances.get(c.target.toLowerCase())!);
        if (same(c.target, executor)) {
          // Follow the exact central envelope emitted by the production issuer.
          // This remains an ABI interpreter, not historical EVM evidence.
          const [encoded] = subscript.decodeFunctionData("execSubscript", c.data);
          const bytes = ethers.getBytes(encoded);
          assert.equal(bytes[0], 0x0e);
          assert.equal(Number(BigInt(ethers.hexlify(bytes.slice(33, 36)))), bytes.length - 36);
          inspectRuntime(ethers.hexlify(bytes.slice(36)), BigInt(ethers.hexlify(bytes.slice(1, 33))),
            { call, nativeBalance: () => native });
        } else if (same(c.target, ADDR.WETH) && c.data.startsWith(erc20.getFunction("withdraw")!.selector)) {
          const [value] = erc20.decodeFunctionData("withdraw", c.data);
          credit(ADDR.WETH, -value); native += value;
        } else if (same(c.target, ADDR.WETH) && c.data === erc20.encodeFunctionData("deposit")) {
          native -= c.value; credit(ADDR.WETH, c.value);
        } else if (!c.static && !c.data.startsWith(erc20.getFunction("approve")!.selector)) {
          if (outputNative) { credit(r.tokenIn, -amount); native += 319n; }
          else { assert.equal(c.value, amount); native -= c.value; credit(r.tokenOut, 319n); }
        }
        assert(native >= 777n, "old native inventory must never subsidize a call");
        return word(1n);
      };
      const issued = applyRuntimeAssetBoundary({ route: r, executor, leg: build(d, r) });
      inspectRuntime(issued.program, amount, { nativeBalance: () => native, call });
      assert.equal(native, 777n);
      assert.equal(balances.get(r.tokenIn.toLowerCase()), 777n);
      assert.equal(balances.get(r.tokenOut.toLowerCase()), 777n + 319n);
      if (outputNative) {
        const wrap = calls.find(c => c.data === erc20.encodeFunctionData("deposit"))!;
        assert(wrap); assert.equal(wrap.value, 319n);
      } else {
        const withdraw = calls.find(c => same(c.target, ADDR.WETH) && c.data.startsWith(erc20.getFunction("withdraw")!.selector))!;
        assert.equal(erc20.decodeFunctionData("withdraw", withdraw.data)[0], amount);
        assert.equal(calls.find(c => same(c.target, d.pool))!.value, amount);
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
  for (const d of ekuboVariants) for (const r of routes(d)) {
    const leg = build(d, r), trace = inspectRuntime(leg.program, 551n);
    const call = trace.calls.find(c => same(c.target, EKUBO_ROUTER))!;
    const args = ekuboRouterIface.decodeFunctionData("swap", call.data);
    assert.equal(args[1], r.isToken1); assert.equal(args[2], 551n); assert.equal(args[5], 1n); assert.equal(args[6], executor);
    assert.equal(call.value, d.poolKey.token0 === ethers.ZeroAddress && !r.isToken1 ? 551n : 0n);
    assert.deepEqual(r.executionAssets, {
      input: d.poolKey.token0 === ethers.ZeroAddress && !r.isToken1 ? "native" : "erc20",
      output: d.poolKey.token0 === ethers.ZeroAddress && r.isToken1 ? "native" : "erc20",
    });
    assert(!trace.calls.some(c => same(c.target, ADDR.WETH)), "raw Router leg must not double-wrap");
    const issued = applyRuntimeAssetBoundary({ route: r, executor, leg });
    if (d.poolKey.token0 === ethers.ZeroAddress) assert.notEqual(issued.program, leg.program);
    else assert.equal(issued, leg);
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

// Exercise request binding across every installed Family and retained variant.
// These emitter models complement the real historical execution fixtures.

test("settlement: all installed domains remain covered by their existing fixtures", () => {
  assert.deepEqual([...new Set(fixtures.map(d => d.familyId))].sort(), priced.map(x => x.familyId).sort());
  assert.equal(installed.length, 46, "update the audit deliberately when the installed set changes");
  for (const entry of installed.filter(x => !priced.includes(x))) {
    assert(["funding", "credit"].includes(entry.plugin.manifest.domain));
    assert((entry.plugin as any)[entry.plugin.manifest.domain], "funding/credit keeps its own contract");
  }
});

for (const d of fixtures) for (const r of routes(d))
test(`settlement: request binding and unchanged default ${d.familyId}/${d.variant ?? "default"}/${r.routeKey}`, () => {
  const p = family(d.familyId), normal = build(d, r);
  const paymentProgram = ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes());
  // Keep the receiver distinct from every fixture-bound protocol address.
  // `foreign` intentionally aliases a synthetic ERC4626 vault elsewhere.
  const recipient = ethers.getAddress("0x9000000000000000000000000000000000000009");
  assert(!JSON.stringify(d, (_key, value) => typeof value === "bigint" ? value.toString() : value)
    .toLowerCase().includes(recipient.toLowerCase()));
  const requests = [
    { kind: "quote-output" },
    { kind: "direct-output", recipient },
    { kind: "deferred-input", paymentAmount: 91n, paymentProgram },
  ];
  for (const request of requests) {
    const supported = request.kind === "quote-output" ? normal.settlement?.quoteOutput === true :
      request.kind === "direct-output" ? normal.settlement?.directOutput === true :
      typeof normal.settlement?.deferredInput === "string";
    const mapped = mapRuntimeAssetSettlementRequest({ route: r, executor: inputFor(d, r).executor,
      request: request as import("../../adapters/runtime-amount-program.js").RuntimeSettlementRequest });
    const actual = mapped === null ? null : p.execution.buildRuntimeLeg({ ...inputFor(d, r), settlement: mapped });
    if (!supported) {
      // A legacy raw emitter may ignore an unknown field. The central issuer
      // rejects that unchanged result because it does not echo the request.
      // The matching issuer fixture below tests its mandatory null result.
      if (actual !== null) {
        assert.notDeepEqual(actual.settlementRequest, request, "an undeclared request cannot be accepted");
        assert.deepEqual(actual, normal, "legacy unsupported request cannot alter the default emitter");
      }
    } else {
      assert(actual, "declared request must construct for this already valid route");
      assert.deepEqual(actual.settlementRequest, mapped, "raw Family must bind the complete mapped request; issuer separately preserves the original receiver");
      assert(p.manifest.ownedActionAdapterIds.includes(actual.actionAdapterId));
      if (request.kind !== "quote-output") assert.equal(actual.inputMode, normal.inputMode);
    }
    assert.deepEqual(build(d, r), normal, "unsupported or supported requests cannot mutate the default emitter");
  }
  if (d.familyId === "curve-underlying") {
    assert.equal(normal.settlement?.deferredInput, undefined,
      "reviewed Curve underlying profiles have no output-first deferred settlement");
  }
});


// Append to the existing family-dual-execution.ts. Synthetic emitter behavior,
// never Ready/admission, public-chain execution, or VM authentication evidence.
test("settlement: V2 requests use actual recipient and emitted payment across existing quote profiles", () => {
  const abi = new ethers.Interface(["function getReserves() view returns(uint112,uint112,uint32)",
    "function getAmountOut(address,uint256) view returns(uint256)",
    "function swap(uint256,uint256,address,bytes)"]);
  for (const d of fixtures.filter(d => d.familyId === "univ2-standard")) for (const r of routes(d)) {
    const cap = 1000n, reserve = 1000000n, marker = "0x5eed0002";
    const tokenModel = d.tokenTransfers?.[r.direction === "zero-for-one" ? 0 : 1];
    const poolCredit = tokenModel?.kind === "verified-transfer-tax" && !same(d.pool, tokenModel.token)
      ? cap - cap * tokenModel.taxNumerator / tokenModel.taxDenominator : cap;
    const quoteCall = (c: RuntimeCall): string => {
      assert(c.static, "quote must only issue static calls");
      const parsed = abi.parseTransaction({ data: c.data }); assert(parsed);
      if (parsed.name === "getReserves") return abi.encodeFunctionResult(parsed.name, [reserve, reserve, 0]);
      assert.equal(parsed.name, "getAmountOut");
      assert(same(parsed.args[0], r.tokenIn)); assert.equal(parsed.args[1], poolCredit);
      return abi.encodeFunctionResult(parsed.name, [997n]);
    };
    const quoteRequest = { kind: "quote-output" };
    const quoted = family(d.familyId).execution.buildRuntimeLeg({ ...inputFor(d, r), settlement: quoteRequest });
    assert(quoted); assert.deepEqual(quoted.settlementRequest, quoteRequest);
    const quote = inspectRuntime(quoted.program, cap, { call: quoteCall }, { output: true, readOnly: true });
    const expectedOut = d.quoteModel.kind === "pool-get-amount-out" ? 997n :
      poolCredit * (10000n - d.feeRule.feeBps) * reserve / (reserve * 10000n + poolCredit * (10000n - d.feeRule.feeBps));
    assert.equal(quote.registers[0], expectedOut); assert(expectedOut > 0n);
    for (const mode of ["direct-output", "deferred-input"]) {
      const paymentProgram = ethers.hexlify(new RuntimeAmountProgram().call(foreign, marker)
        .constant(1, cap).call(r.tokenIn, erc20.encodeFunctionData("transfer", [d.pool, 0n]), { patches: [{ offset: 36, reg: 1 }] })
        .constant(0, cap).bytes());
      const request = mode === "direct-output" ? { kind: mode, recipient: foreign } :
        { kind: mode, paymentAmount: 1n, paymentProgram };
      const leg = family(d.familyId).execution.buildRuntimeLeg({ ...inputFor(d, r), settlement: request });
      if (mode === "direct-output" && d.quoteModel.kind === "pool-get-amount-out") {
        assert.equal(build(d, r).settlement?.directOutput, undefined,
          "pool-quote callback recipient is the swap output recipient, not an independent payer");
        assert.equal(leg, null, "external recipient must not receive the executor's payment continuation");
        continue;
      }
      assert(leg);
      assert.deepEqual(leg.settlementRequest, request);
      let paid = 0n, credited = 0n, output = 0n, markerCalls = 0, callbacks = 0;
      const events: string[] = [];
      const call = (c: RuntimeCall): string => {
        if (same(c.target, foreign) && c.data === marker) { markerCalls++; events.push("requested-payment"); return "0x"; }
        const t = (() => { try { return erc20.parseTransaction({ data: c.data }); } catch { return null; } })();
        if (t?.name === "balanceOf") {
          const value = same(c.target, r.tokenIn) && same(t.args[0], d.pool) ? reserve + credited :
            same(c.target, r.tokenOut) && same(t.args[0], executor) ? 23n + output : 23n;
          return erc20.encodeFunctionResult("balanceOf", [value]);
        }
        if (t?.name === "transfer") {
          assert(same(c.target, r.tokenIn)); assert(same(t.args[0], d.pool)); assert.equal(t.args[1], cap);
          paid += cap; credited += poolCredit; events.push("debt-paid"); return erc20.encodeFunctionResult("transfer", [true]);
        }
        const a = abi.parseTransaction({ data: c.data }); assert(a);
        if (a.name !== "swap") return quoteCall(c);
        assert(same(a.args[2], mode === "direct-output" ? foreign : executor));
        assert.equal(a.args[r.direction === "zero-for-one" ? 1 : 0], expectedOut);
        assert.equal(a.args[r.direction === "zero-for-one" ? 0 : 1], 0n);
        output += expectedOut; events.push("output-released");
        if (a.args[3] !== "0x") {
          assert(same(a.args[2], executor), "pair callback is delivered to swap.to, not msg.sender");
          const script = ethers.getBytes(a.args[3]); assert.equal(script[0], 0x0e);
          const callbackAmount = BigInt(ethers.hexlify(script.slice(1, 33)));
          const size = Number(BigInt(ethers.hexlify(script.slice(33, 36))));
          assert.equal(callbackAmount, cap); assert(c.incoming > 0 && c.outgoing > 0); callbacks++;
          inspectRuntime(ethers.hexlify(script.slice(36, 36 + size)), callbackAmount, { call });
        }
        return "0x";
      };
      inspectRuntime(leg.program, cap, { call });
      assert.equal(paid, cap); assert.equal(output, expectedOut);
      assert.equal(markerCalls, mode === "deferred-input" ? 1 : 0);
      assert.equal(callbacks, mode === "deferred-input" || d.quoteModel.kind === "pool-get-amount-out" ? 1 : 0);
      assert.equal(events.indexOf("output-released") < events.indexOf("debt-paid"),
        mode === "deferred-input" || d.quoteModel.kind === "pool-get-amount-out");
    }
  }
});

test("settlement: both V4 owners bind receiver and requested payment; native requests stay unsupported", () => {
  const abi = new ethers.Interface(["function unlock(bytes)",
    "function swap((address,address,uint24,int24,address),(bool,int256,uint160),bytes) returns(int256)",
    "function take(address,address,uint256)", "function sync(address)", "function settle() payable returns(uint256)"]);
  for (const d of fixtures.filter(d => ["univ4", "univ4-fee-hook"].includes(d.familyId))) for (const r of routes(d)) {
    const cap = 91n, credit = 97n, manager = d.managerBinding.manager, marker = "0x5eed0004";
    const paymentProgram = ethers.hexlify(new RuntimeAmountProgram().call(foreign, marker)
      .call(r.tokenIn, erc20.encodeFunctionData("transfer", [manager, 0n]), { patches: [{ offset: 36, reg: 0 }] }).bytes());
    const requests = [{ kind: "direct-output", recipient: foreign }, { kind: "deferred-input", paymentAmount: cap, paymentProgram }];
    const native = same(r.realTokenIn, ethers.ZeroAddress) || same(r.realTokenOut, ethers.ZeroAddress);
    for (const request of requests) {
      const leg = family(d.familyId).execution.buildRuntimeLeg({ ...inputFor(d, r), settlement: request });
      if (native) { assert.equal(leg, null); assert.equal(build(d, r).settlement, undefined); continue; }
      assert(leg); assert.deepEqual(leg.settlementRequest, request);
      assert(same(leg.settlement.deferredInput, manager)); assert.equal(leg.settlement.directOutput, true);
      let output = 0n, paid = 0n, markers = 0; const events: string[] = [];
      const zero = r.direction === "zero-for-one";
      const packed = zero ? (BigInt.asUintN(128, -cap) << 128n) | credit : (credit << 128n) | BigInt.asUintN(128, -cap);
      const call = (c: RuntimeCall): string => {
        if (same(c.target, foreign) && c.data === marker) { markers++; events.push("requested-payment"); return "0x"; }
        const t = (() => { try { return erc20.parseTransaction({ data: c.data }); } catch { return null; } })();
        if (t?.name === "balanceOf") {
          assert(same(c.target, r.tokenOut)); assert(same(t.args[0], executor));
          return erc20.encodeFunctionResult("balanceOf", [2000n + output]);
        }
        if (t?.name === "transfer") {
          assert(same(c.target, r.tokenIn)); assert(same(t.args[0], manager)); assert.equal(t.args[1], cap);
          paid += cap; events.push("debt-paid"); return erc20.encodeFunctionResult("transfer", [true]);
        }
        assert(same(c.target, manager)); const a = abi.parseTransaction({ data: c.data }); assert(a);
        if (a.name === "unlock") {
          assert.equal(c.incoming, 68); assert.equal(c.outgoing, 68);
          const script = ethers.getBytes(a.args[0]); assert.equal(script[0], 0x0e);
          const amount = BigInt(ethers.hexlify(script.slice(1, 33))), size = Number(BigInt(ethers.hexlify(script.slice(33, 36))));
          assert.equal(amount, cap); inspectRuntime(ethers.hexlify(script.slice(36, 36 + size)), amount, { call }); return "0x";
        }
        if (a.name === "swap") {
          assert.equal(a.args[1][1], -cap);
          assert.equal(a.args[2], d.familyId === "univ4-fee-hook" ? hookDataFor(d, executor, zero) : "0x");
          return word(packed);
        }
        if (a.name === "take") {
          assert(same(a.args[0], r.tokenOut)); assert.equal(a.args[2], credit);
          assert(same(a.args[1], request.kind === "direct-output" ? foreign : executor));
          output += credit; events.push("output-released"); return "0x";
        }
        if (a.name === "sync") { assert(same(a.args[0], r.tokenIn)); events.push("sync"); return "0x"; }
        assert.equal(a.name, "settle"); assert.equal(c.value, 0n); assert.equal(paid, cap); events.push("settled"); return word(paid);
      };
      inspectRuntime(leg.program, cap, { call });
      assert.equal(output, credit); assert.equal(paid, cap); assert.equal(markers, request.kind === "deferred-input" ? 1 : 0);
      assert(events.indexOf("output-released") < events.indexOf("debt-paid"));
      assert(events.indexOf("sync") < events.indexOf("debt-paid"));
      assert(events.indexOf("debt-paid") < events.indexOf("settled"));
    }
  }
});

// Current V3 emitter behavior using the existing Family descriptor.
// The protocol model invokes the emitted callback, not a test-created default
// payment. Authentication and one-shot rejection still require actual VM tests.
for (const id of ["univ3-standard"])
test(`settlement: ${id} binds the requested recipient and executes the requested payment continuation`, () => {
  const abi = new ethers.Interface([id === "kyberswap-elastic"
    ? "function swap(address recipient,int256 swapQty,bool isToken0,uint160 limit,bytes data) returns(int256,int256)"
    : "function swap(address recipient,bool zeroForOne,int256 amount,uint160 limit,bytes data) returns(int256,int256)"]);
  const ds = fixtures.filter(d => d.familyId === id); assert(ds.length);
  for (const d of ds) for (const r of routes(d)) for (const invalidExecutor of [ethers.ZeroAddress, d.pool]) {
    assert.throws(() => family(id).execution.buildRuntimeLeg({ ...inputFor(d, r), executor: invalidExecutor,
      settlement: { kind: "direct-output", recipient: foreign } }),
    "a foreign requested recipient must not weaken the original executor-address guard");
  }
  for (const d of ds) for (const r of routes(d)) for (const mode of ["direct-output", "deferred-input"]) {
    const cap = 91n, credit = 97n, zero = id === "kyberswap-elastic" ? r.isToken0 : r.direction === "zero-for-one";
    for (const debt of mode === "deferred-input" ? [cap, cap - 1n] : [cap]) {
    const marker = "0x5eed0001";
    // Model the upstream continuation delivering input directly to the pool.
    // The terminal executor's input-token balance must remain unchanged in the
    // deferred case; requiring it to fall by cap would reject valid composition.
    const paymentProgram = ethers.hexlify(new RuntimeAmountProgram()
      .call(foreign, marker)
      .constant(0, debt).bytes());
    const request = mode === "direct-output" ? { kind: mode, recipient: foreign } :
      { kind: mode, paymentProgram, paymentAmount: cap };
    const normal = build(d, r);
    assert.equal(normal.settlement?.directOutput, true, "declared recipient capability");
    assert(same(normal.settlement?.deferredInput ?? ethers.ZeroAddress, d.pool), "declared debt recipient");
    const leg = family(id).execution.buildRuntimeLeg({ ...inputFor(d, r), settlement: request }); assert(leg);
    assert.deepEqual(leg.settlementRequest, request); assert.equal(leg.inputMode, normal.inputMode);
    let paid = 0n, output = 0n, markerCalls = 0, callbacks = 0;
    const events: string[] = [];
    const balance = (token: string, account: string) => same(token, r.tokenIn) && same(account, executor) ? 1000n + cap - (mode === "direct-output" ? paid : 0n) :
      same(token, r.tokenOut) && same(account, mode === "direct-output" ? foreign : executor) ? 2000n + output : 2000n;
    const settleCall = (c: RuntimeCall): string => {
      if (same(c.target, foreign) && c.data === marker) {
        markerCalls++; events.push("requested-payment"); paid += debt; events.push("debt-paid"); return "0x";
      }
      const tokenCall = (() => { try { return erc20.parseTransaction({ data: c.data }); } catch { return null; } })();
      if (tokenCall?.name === "balanceOf") return erc20.encodeFunctionResult("balanceOf", [balance(c.target, tokenCall.args[0])]);
      if (tokenCall?.name === "transfer") {
        assert.equal(mode, "direct-output", "deferred request cannot silently use the default executor transfer");
        assert(same(c.target, r.tokenIn)); assert(same(tokenCall.args[0], d.pool)); assert.equal(tokenCall.args[1], cap);
        paid += tokenCall.args[1]; events.push("debt-paid"); return erc20.encodeFunctionResult("transfer", [true]);
      }
      assert.fail("unexpected callback operation");
    };
    const execute = () => inspectRuntime(leg.program, cap, { nativeBalance: () => 17n, call(c) {
      if (!same(c.target, d.pool)) return settleCall(c);
      const a = abi.decodeFunctionData("swap", c.data);
      assert(same(a[0], mode === "direct-output" ? foreign : executor));
      assert.equal(id === "kyberswap-elastic" ? a[1] : a[2], cap);
      output = credit; events.push("output-released");
      const script = ethers.getBytes(a[4]); assert.equal(script[0], 0x0e);
      const callbackCap = BigInt(ethers.hexlify(script.slice(1, 33)));
      const size = Number(BigInt(ethers.hexlify(script.slice(33, 36))));
      assert.equal(callbackCap, cap); assert(c.incoming > 0 && c.outgoing > 0);
      const deltas = zero ? [debt, -credit] : [-credit, debt];
      const calldata = "0x00000000" + ethers.AbiCoder.defaultAbiCoder().encode(["int256", "int256", "bytes"], [...deltas, a[4]]).slice(2);
      callbacks++; events.push("callback-entered");
      inspectRuntime(ethers.hexlify(script.slice(36, 36 + size)), callbackCap, { calldata, nativeBalance: () => 17n, call: settleCall });
      assert.equal(paid, debt, "callback must actually pay the input token debt");
      return abi.encodeFunctionResult("swap", deltas);
    } });
    if (debt < cap) {
      assert.throws(execute, /runtime amount mismatch/, "deferred partial debt must fail for funded fallback");
      assert.equal(markerCalls, 1, "the rejection must occur after the requested continuation, not before callback execution");
      continue;
    }
    execute();
    assert.equal(callbacks, 1); assert.equal(output, credit); assert.equal(paid, cap);
    assert.equal(markerCalls, mode === "deferred-input" ? 1 : 0,
      "default callback payment cannot satisfy a requested continuation");
    assert(events.indexOf("output-released") < events.indexOf("callback-entered"));
    if (mode === "deferred-input") assert(events.indexOf("requested-payment") < events.indexOf("debt-paid"));
    if (mode === "deferred-input") assert.equal(balance(r.tokenIn, executor), 1000n + cap,
      "valid deferred settlement does not require a terminal executor input debit");
    }
  }
});

import { ABI as settlementFewAbi } from "../venues/protocols/few-wrapped-family/codec.js";
import { ABI as settlementVaultAbi } from "../venues/swaps/vault-spot-family/codec.js";
import { psmSellQuote as settlementPsmSellQuote } from "../venues/protocols/psm-family/codec.js";

// Capability tests must not silently skip undeclared supported behavior.
// The protocol models extend the same balances/ABIs as existing Family tests;
// they are emitter behavior evidence, not historical or EVM execution evidence.
for (const id of ["protocol:few-wrapped", "vault-spot", "protocol:psm"])
test(`settlement: ${id} sends each direction's actual output to the requested recipient`, () => {
  const ds = fixtures.filter(d => d.familyId === id); assert(ds.length);
  for (const d of ds) for (const r of routes(d)) {
    const cap = id === "protocol:psm" && r.direction === "buy-gem" ? 1234567890123456789n : 91n;
    const request = { kind: "direct-output", recipient: foreign };
    const normal = build(d, r);
    assert.equal(normal.settlement?.directOutput, true, "receiver capability");
    assert.equal(normal.settlement?.deferredInput, undefined, "these selected operations are not flash settlement");
    const leg = family(id).execution.buildRuntimeLeg({ ...inputFor(d, r), settlement: request });
    assert(leg); assert.deepEqual(leg.settlementRequest, request);
    assert.equal(leg.inputMode, normal.inputMode);
    const key = (token: string, account: string) => `${token.toLowerCase()}:${account.toLowerCase()}`;
    const balances = new Map([
      [key(r.tokenIn, executor), 101n + cap], [key(r.tokenOut, executor), 103n],
      [key(r.tokenOut, foreign), 107n], [key(r.tokenIn, d.vault ?? d.target), 1000n],
    ]);
    const get = (token: string, account: string) => balances.get(key(token, account)) ?? 0n;
    const move = (token: string, from: string, to: string, amount: bigint) => {
      assert(get(token, from) >= amount);
      balances.set(key(token, from), get(token, from) - amount);
      balances.set(key(token, to), get(token, to) + amount);
    };
    let allowance = 0n, swapped = false, protocolCalls = 0, expectedCredit = 0n, debit = 0n;
    const pool = d.vault ?? d.target, fee = 10n ** 15n;
    const protocolAbi = id === "protocol:few-wrapped" ? settlementFewAbi :
      id === "vault-spot" ? settlementVaultAbi : PSM_INTERFACE;
    const trace = inspectRuntime(leg.program, cap, { nativeBalance: () => 17n, call(c) {
      const tokenCall = (() => { try { return erc20.parseTransaction({ data: c.data }); } catch { return null; } })();
      if (tokenCall?.name === "balanceOf") return erc20.encodeFunctionResult("balanceOf", [get(c.target, tokenCall.args[0])]);
      if (tokenCall?.name === "approve") { allowance = tokenCall.args[1]; return erc20.encodeFunctionResult("approve", [true]); }
      if (c.data.slice(0, 10) === "0xdd62ed3e") return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [allowance]);
      if (tokenCall?.name === "transfer") {
        assert.equal(id, "vault-spot"); assert(same(tokenCall.args[0], pool)); assert.equal(tokenCall.args[1], cap);
        move(r.tokenIn, executor, pool, cap); debit += cap;
        return erc20.encodeFunctionResult("transfer", [true]);
      }
      const a = protocolAbi.parseTransaction({ data: c.data }); assert(a);
      if (a.name === "tin" || a.name === "tout") return protocolAbi.encodeFunctionResult(a.name, [fee]);
      if (a.name === "tokenBalances") return protocolAbi.encodeFunctionResult(a.name, [1000n + (swapped ? cap : 0n)]);
      protocolCalls++;
      let recipient: string;
      if (id === "protocol:few-wrapped") {
        assert.equal(a.name, `${r.direction}To`); assert.equal(a.args[0], cap); recipient = a.args[1];
        debit = cap; expectedCredit = cap;
      } else if (id === "vault-spot") {
        assert.equal(a.name, "swap"); assert(same(a.args[0], r.tokenIn) && same(a.args[1], r.tokenOut));
        assert.equal(get(r.tokenIn, pool) - 1000n, cap, "pool receives input before output");
        recipient = a.args[2]; expectedCredit = 97n;
      } else {
        const sell = r.direction === "sell-gem";
        assert.equal(a.name, sell ? "sellGem" : "buyGem"); recipient = a.args[0];
        const gem = a.args[1];
        if (sell) { assert.equal(gem, cap); debit = cap; expectedCredit = settlementPsmSellQuote(cap, fee, d.decimalScale); }
        else { assert.equal(gem, psmBuyQuote(cap, fee, d.decimalScale)); debit = psmBuyCost(gem, fee, d.decimalScale); expectedCredit = gem; }
      }
      assert(same(recipient, foreign), "decode the actual recipient from emitted calldata");
      if (id !== "vault-spot") move(r.tokenIn, executor, pool, debit);
      balances.set(key(r.tokenOut, recipient), get(r.tokenOut, recipient) + expectedCredit);
      swapped = true;
      return id === "protocol:psm" ? "0x" : protocolAbi.encodeFunctionResult(a.name, [expectedCredit]);
    } });
    assert.equal(protocolCalls, 1); assert.equal(trace.registers[0], cap);
    assert.equal(get(r.tokenOut, foreign) - 107n, expectedCredit); assert(expectedCredit > 0n);
    assert.equal(get(r.tokenOut, executor), 103n, "old executor output cannot stand in for receiver credit");
    assert.equal(101n + cap - get(r.tokenIn, executor), debit); assert(debit > 0n && debit <= cap);
    if (id === "protocol:psm" && r.direction === "buy-gem") {
      assert.equal(leg.inputMode, "maximum");
      if (d.decimalScale === 1000000000000n) assert(cap - debit > 1n);
    } else { assert.equal(debit, cap); assert.equal(leg.inputMode, undefined); }
    if (id === "protocol:few-wrapped") assert.equal(allowance, 0n);
  }
});

// Positive callback behavior for the two newly adapted callback Families.
// The protocol model invokes the emitted callback, not a test-created default
// payment. Authentication and one-shot rejection still require actual VM tests.
for (const id of ["swap:algebra-integral", "kyberswap-elastic"])
test(`settlement: ${id} binds the requested recipient and executes the requested payment continuation`, () => {
  const abi = new ethers.Interface([id === "kyberswap-elastic"
    ? "function swap(address recipient,int256 swapQty,bool isToken0,uint160 limit,bytes data) returns(int256,int256)"
    : "function swap(address recipient,bool zeroForOne,int256 amount,uint160 limit,bytes data) returns(int256,int256)"]);
  const ds = fixtures.filter(d => d.familyId === id); assert(ds.length);
  for (const d of ds) for (const r of routes(d)) for (const invalidExecutor of [ethers.ZeroAddress, d.pool]) {
    assert.throws(() => family(id).execution.buildRuntimeLeg({ ...inputFor(d, r), executor: invalidExecutor,
      settlement: { kind: "direct-output", recipient: foreign } }),
    "a foreign requested recipient must not weaken the original executor-address guard");
  }
  for (const d of ds) for (const r of routes(d)) for (const mode of ["direct-output", "deferred-input"]) {
    const cap = 91n, credit = 97n, zero = id === "kyberswap-elastic" ? r.isToken0 : r.direction === "zero-for-one";
    for (const debt of mode === "deferred-input" ? [cap, cap - 1n] : [cap]) {
    const marker = "0x5eed0001";
    // Model the upstream continuation delivering input directly to the pool.
    // The terminal executor's input-token balance must remain unchanged in the
    // deferred case; requiring it to fall by cap would reject valid composition.
    const paymentProgram = ethers.hexlify(new RuntimeAmountProgram()
      .call(foreign, marker)
      .constant(0, debt).bytes());
    const request = mode === "direct-output" ? { kind: mode, recipient: foreign } :
      { kind: mode, paymentProgram, paymentAmount: cap };
    const normal = build(d, r);
    assert.equal(normal.settlement?.directOutput, true, "recipient capability");
    assert(same(normal.settlement?.deferredInput ?? ethers.ZeroAddress, d.pool), "deferred debt sink");
    const leg = family(id).execution.buildRuntimeLeg({ ...inputFor(d, r), settlement: request }); assert(leg);
    assert.deepEqual(leg.settlementRequest, request); assert.equal(leg.inputMode, normal.inputMode);
    let paid = 0n, output = 0n, markerCalls = 0, callbacks = 0;
    const events: string[] = [];
    const balance = (token: string, account: string) => same(token, r.tokenIn) && same(account, executor) ? 1000n + cap - (mode === "direct-output" ? paid : 0n) :
      same(token, r.tokenOut) && same(account, mode === "direct-output" ? foreign : executor) ? 2000n + output : 2000n;
    const settleCall = (c: RuntimeCall): string => {
      if (same(c.target, foreign) && c.data === marker) {
        markerCalls++; events.push("requested-payment"); paid += debt; events.push("debt-paid"); return "0x";
      }
      const tokenCall = (() => { try { return erc20.parseTransaction({ data: c.data }); } catch { return null; } })();
      if (tokenCall?.name === "balanceOf") return erc20.encodeFunctionResult("balanceOf", [balance(c.target, tokenCall.args[0])]);
      if (tokenCall?.name === "transfer") {
        assert.equal(mode, "direct-output", "deferred request cannot silently use the default executor transfer");
        assert(same(c.target, r.tokenIn)); assert(same(tokenCall.args[0], d.pool)); assert.equal(tokenCall.args[1], cap);
        paid += tokenCall.args[1]; events.push("debt-paid"); return erc20.encodeFunctionResult("transfer", [true]);
      }
      assert.fail("unexpected callback operation");
    };
    const execute = () => inspectRuntime(leg.program, cap, { nativeBalance: () => 17n, call(c) {
      if (!same(c.target, d.pool)) return settleCall(c);
      const a = abi.decodeFunctionData("swap", c.data);
      assert(same(a[0], mode === "direct-output" ? foreign : executor));
      assert.equal(id === "kyberswap-elastic" ? a[1] : a[2], cap);
      output = credit; events.push("output-released");
      const script = ethers.getBytes(a[4]); assert.equal(script[0], 0x0e);
      const callbackCap = BigInt(ethers.hexlify(script.slice(1, 33)));
      const size = Number(BigInt(ethers.hexlify(script.slice(33, 36))));
      assert.equal(callbackCap, cap); assert(c.incoming > 0 && c.outgoing > 0);
      const deltas = zero ? [debt, -credit] : [-credit, debt];
      const calldata = "0x00000000" + ethers.AbiCoder.defaultAbiCoder().encode(["int256", "int256", "bytes"], [...deltas, a[4]]).slice(2);
      callbacks++; events.push("callback-entered");
      inspectRuntime(ethers.hexlify(script.slice(36, 36 + size)), callbackCap, { calldata, nativeBalance: () => 17n, call: settleCall });
      assert.equal(paid, debt, "callback must actually pay the input token debt");
      return abi.encodeFunctionResult("swap", deltas);
    } });
    if (debt < cap) {
      assert.throws(execute, /runtime amount mismatch/, "deferred partial debt must fail for funded fallback");
      assert.equal(markerCalls, 1, "the rejection must occur after the requested continuation, not before callback execution");
      continue;
    }
    execute();
    assert.equal(callbacks, 1); assert.equal(output, credit); assert.equal(paid, cap);
    assert.equal(markerCalls, mode === "deferred-input" ? 1 : 0,
      "default callback payment cannot satisfy a requested continuation");
    assert(events.indexOf("output-released") < events.indexOf("callback-entered"));
    if (mode === "deferred-input") assert(events.indexOf("requested-payment") < events.indexOf("debt-paid"));
    if (mode === "deferred-input") assert.equal(balance(r.tokenIn, executor), 1000n + cap,
      "valid deferred settlement does not require a terminal executor input debit");
    }
  }
});

import { ABI as aquaSettlementAbi } from "../venues/swaps/aqua-swapvm-family/codec.js";

// Append to the existing family-dual suite. Uses its fixtures, build/inputFor,
// routes, inspectRuntime and balance conventions; this is NOT EVM evidence.
// Requires descriptor(sampleIndex=0) from the fixture candidate in this pack.
const aquaCallbackAbi = new ethers.Interface([
  "function preTransferInCallback(address maker,address taker,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut,bytes32 orderHash,bytes data)",
]);
function aquaTakerSlices(data: string) {
  const bytes = ethers.getBytes(data), head = BigInt(ethers.hexlify(bytes.slice(0, 22)));
  const ends = Array.from({ length: 10 }, (_, i) => Number((head >> BigInt(16 + 16 * i)) & 65535n));
  return { flags: head & 65535n, at: (i: number) => ethers.hexlify(bytes.slice(22 + (i ? ends[i - 1]! : 0), 22 + ends[i]!)) };
}
test("settlement: Aqua v1 both admitted strategies and directions bind recipient, quote and output-first callback", () => {
  for (const d of [aquaFixture(0), aquaFixture(1)]) for (const r of routes(d)) for (const cap of [1n, 91n]) {
    const id = d.familyId, gross = cap + 6n, paymentAmount = cap;
    assert.deepEqual(build(d, r).settlement, { quoteOutput: true, directOutput: true, deferredInput: executor.toLowerCase() });
    const emit = (request: any, actor = executor) => family(id).execution.buildRuntimeLeg({ ...inputFor(d, r), executor: actor, settlement: request });
    for (const actor of [ethers.ZeroAddress, d.router, d.aqua, d.order.maker, ...d.tokens]) {
      assert.throws(() => emit({ kind: "direct-output", recipient: foreign }, actor));
    }
    for (const recipient of [ethers.ZeroAddress, d.router, d.aqua, d.order.maker, ...d.tokens]) {
      assert.throws(() => emit({ kind: "direct-output", recipient }));
    }
    assert.equal(emit({ kind: "unknown" }), null, "unknown request must not silently run funded mode");
    for (const fault of ["none", "amount-in", "order-hash", "zero-output"]) {
      const request = { kind: "quote-output" }, leg = emit(request); assert(leg); assert.deepEqual(leg.settlementRequest, request);
      let calls = 0;
      const run = () => inspectRuntime(leg.program, cap, { call(c) {
        calls++; assert(c.static); assert(same(c.target, d.router));
        const q = aquaSettlementAbi.decodeFunctionData("quote", c.data);
        assert.equal(q.amount, cap); assert(same(q.tokenIn, r.tokenIn) && same(q.tokenOut, r.tokenOut));
        assert.equal(aquaTakerSlices(q.takerTraitsAndData).flags, 0x61n);
        return aquaSettlementAbi.encodeFunctionResult("quote", [fault === "amount-in" ? cap - 1n : cap,
          fault === "zero-output" ? 0n : gross, fault === "order-hash" ? word(1n) : d.strategyHash]);
      } }, { output: true, readOnly: true });
      if (fault === "none") assert.equal(run().registers[0], gross); else assert.throws(run);
      assert.equal(calls, 1);
    }
    for (const mode of ["direct-output", "deferred-input"] as const) {
      const faults = mode === "direct-output" ? ["none", "wrong-recipient", "input-short", "zero-debit", "native-changed"] :
        ["none", "no-release", "short-receipt", "input-short", "input-over", "zero-debit", "spend-old-output", "partial-debt", "over-debt", "native-changed"];
      for (const fault of faults) {
        const key = (token: string, account: string) => `${token.toLowerCase()}:${account.toLowerCase()}`;
        const balances = new Map<string, bigint>([
          [key(r.tokenIn, executor), 101n + (mode === "direct-output" ? cap : 0n)],
          [key(r.tokenOut, executor), 103n], [key(r.tokenOut, foreign), 107n],
          [key(r.tokenIn, foreign), 10000n], [key(r.tokenIn, d.order.maker), 10000n], [key(r.tokenOut, d.order.maker), 10000n],
        ]);
        const get = (token: string, account: string) => balances.get(key(token, account)) ?? 0n;
        const move = (token: string, from: string, to: string, value: bigint) => {
          assert(value >= 0n && get(token, from) >= value); balances.set(key(token, from), get(token, from) - value);
          balances.set(key(token, to), get(token, to) + value);
        };
        const marker = "0x5eed0002", events: string[] = [];
        let allowance = 0n, callbackCalls = 0, paymentCalls = 0, native = 17n, ledgerIn = 10000n, ledgerOut = 10000n;
        const debt = fault === "partial-debt" ? cap - 1n : fault === "over-debt" ? cap + 1n : cap;
        const paymentProgram = ethers.hexlify(new RuntimeAmountProgram().call(foreign, marker).constant(0, debt).bytes());
        const request = mode === "direct-output" ? { kind: mode, recipient: foreign } : { kind: mode, paymentAmount, paymentProgram };
        const leg = emit(request); assert(leg); assert.deepEqual(leg.settlementRequest, request); assert.equal(leg.inputMode, undefined);
        const onCall = (c: RuntimeCall): string => {
          if (same(c.target, foreign) && c.data === marker) {
            paymentCalls++; events.push("prefix-payment");
            move(r.tokenOut, executor, foreign, paymentAmount + (fault === "spend-old-output" ? 1n : 0n));
            move(r.tokenIn, foreign, executor, debt + (fault === "input-short" ? -1n : fault === "input-over" ? 1n : 0n));
            return "0x";
          }
          const tokenCall = (() => { try { return aquaSettlementAbi.parseTransaction({ data: c.data }); } catch { return null; } })();
          if (tokenCall?.name === "balanceOf") return word(get(c.target, tokenCall.args[0]));
          if (tokenCall?.name === "approve") { assert(same(c.target, r.tokenIn)); assert(same(tokenCall.args[0], d.router)); allowance = tokenCall.args[1]; return word(1n); }
          if (tokenCall?.name === "allowance") return word(allowance);
          assert(same(c.target, d.router)); assert(!c.static); const a = aquaSettlementAbi.decodeFunctionData("swap", c.data);
          assert.equal(a.amount, cap); assert(same(a.tokenIn, r.tokenIn) && same(a.tokenOut, r.tokenOut));
          assert.equal(a[0].data, d.order.data); assert.equal(a[0].traits, BigInt(d.order.traits));
          const traits = aquaTakerSlices(a.takerTraitsAndData);
          assert.equal(traits.flags, mode === "direct-output" ? 0x61n : 0x45n);
          const receiver = traits.at(1) === "0x" ? executor : ethers.getAddress(traits.at(1));
          assert(same(receiver, mode === "direct-output" ? foreign : executor));
          const pullAndPush = () => {
            assert(allowance >= debt); events.push("router-transferFrom");
            const debit = fault === "zero-debit" ? 0n : mode === "direct-output" && fault === "input-short" ? cap - 1n : debt;
            move(r.tokenIn, executor, d.router, debit); allowance -= debit;
            // Model the actual router push: both maker balance and strategy ledger
            // must change. Direct payment to maker cannot replace this operation.
            move(r.tokenIn, d.router, d.order.maker, debit); ledgerIn += debit; events.push("aqua-push");
          };
          const release = () => {
            const actual = fault === "no-release" ? 0n : fault === "short-receipt" ? gross - 1n : gross;
            move(r.tokenOut, d.order.maker, fault === "wrong-recipient" ? executor : receiver, actual); ledgerOut -= actual; events.push("aqua-pull-output");
          };
          if (mode === "direct-output") { assert.equal(traits.at(7), "0x"); assert.equal(c.incoming, 0); pullAndPush(); release(); }
          else {
            release(); callbackCalls++; events.push("callback");
            const callbackData = aquaCallbackAbi.encodeFunctionData("preTransferInCallback", [d.order.maker, executor, r.tokenIn, r.tokenOut, debt, gross, d.strategyHash, traits.at(7)]);
            const [scriptHex] = ethers.AbiCoder.defaultAbiCoder().decode(["bytes"], traits.at(7));
            const script = ethers.getBytes(scriptHex), size = Number(BigInt(ethers.hexlify(script.slice(33, 36))));
            assert.equal(c.incoming, 356); assert.equal(BigInt(ethers.dataSlice(callbackData, 132, 164)), debt);
            assert.equal(ethers.dataSlice(callbackData, c.incoming - 32, c.incoming), word(BigInt(script.length)));
            assert.equal(ethers.dataSlice(callbackData, c.incoming, c.incoming + script.length), scriptHex);
            assert.equal(ethers.dataSlice(c.data, c.outgoing, c.outgoing + script.length), scriptHex);
            assert.equal(BigInt(ethers.hexlify(script.slice(1, 33))), cap); assert.equal(script[0], 0x0e);
            inspectRuntime(ethers.hexlify(script.slice(36, 36 + size)), cap, { call: onCall, calldata: callbackData, nativeBalance: () => native });
            pullAndPush();
          }
          if (fault === "native-changed") native++;
          return aquaSettlementAbi.encodeFunctionResult("swap", [debt, gross, d.strategyHash]);
        };
        const run = () => inspectRuntime(leg.program, cap, { call: onCall, nativeBalance: () => native });
        if (fault !== "none") { assert.throws(run, `${mode}/${fault}`); continue; }
        run(); assert.equal(allowance, 0n); assert.equal(native, 17n); assert.equal(get(r.tokenIn, executor), 101n);
        assert.equal(ledgerIn, 10000n + cap); assert.equal(ledgerOut, 10000n - gross);
        assert.equal(get(r.tokenIn, d.order.maker), 10000n + cap);
        assert.equal(callbackCalls, mode === "deferred-input" ? 1 : 0); assert.equal(paymentCalls, callbackCalls);
        if (mode === "deferred-input") {
          assert.equal(get(r.tokenOut, executor) - 103n + paymentAmount, gross);
          assert(events.indexOf("aqua-pull-output") < events.indexOf("callback"));
          assert(events.indexOf("prefix-payment") < events.indexOf("router-transferFrom"));
          assert(events.indexOf("router-transferFrom") < events.indexOf("aqua-push"));
        } else { assert.equal(get(r.tokenOut, foreign), 107n + gross); assert.equal(get(r.tokenOut, executor), 103n); }
      }
    }
    const unchanged = build(d, r); let touched = false;
    assert.throws(() => inspectRuntime(unchanged.program, 0n, { call() { touched = true; return "0x"; }, nativeBalance: () => 17n }));
    assert.equal(touched, false, "zero input fails before a protocol call");
  }
});
