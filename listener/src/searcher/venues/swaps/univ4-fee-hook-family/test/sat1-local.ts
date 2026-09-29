import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { ADDR } from "../../../../../shared/constants/addresses.js";
import { applyExactTrialState, emptyExactTrialState } from "../../../../exact-trial-state.js";
import { plugin } from "../../../production-families/univ4-fee-hook.production.js";
import { nativeBalanceState, storageState, tokenSupplyState } from "../../../local-state-models/resources.js";
import { v4PoolId } from "../../univ4-common.js";
import { UNIV4_STATE_VIEW_INTERFACE } from "../../univ4-abi.js";
import { hookDataFor, SAT1, SAT1_HOOK_CODE_HASH, SAT1_TOKEN_CODE_HASH } from "../sat1.js";
import { sat1IdentityVariant } from "../sat1-identity.js";
import { createUniv4FeeHookExact } from "../exact.js";
import { sat1QuoteAndApply, SAT1_WAD as W, type Sat1LocalState } from "../sat1-math.js";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import type { ExactQuoteResult } from "../../../adapter-family-plugin.js";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import { v3TrialStateRef } from "../../../local-state-models/v3-state.js";
import { createUniV3Exact } from "../../univ3-family/exact.js";
import { univ3Routes } from "../../univ3-family/routes.js";
import type { UniV3Descriptor } from "../../univ3-family/types.js";
import { v3SwapToState, type V3PoolState } from "../../../../solver/v3-math.js";

const hook = "0x2a0a30dd78af7698e6f40212b8b8324fce2ee888", token = "0x8f66337a0c2a02202fd91dd596c411cf977c6060";
const executor = "0x1111111111111111111111111111111111111111";
const source = { number: 26029537, hash: ethers.id("sat1-local-synthetic"), generation: 1 };
function fixture() {
  const poolKey = { currency0: ethers.ZeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: hook };
  const poolId = v4PoolId(poolKey);
  const candidate = { candidateKind: "univ4-pool-key" as const, sourceKind: "pool-surface" as const,
    manager: ADDR.UNISWAP_V4_POOL_MANAGER, poolId, poolKey };
  const result = sat1IdentityVariant.decide({ candidate, step: 1, evidence: {
    source, managerCodeHash: ethers.id("manager-fixture"), hookCodeHash: SAT1_HOOK_CODE_HASH,
    tokenCodeHash: SAT1_TOKEN_CODE_HASH, manager: candidate.manager, token, minter: hook,
    genesis: 25044547n, initialized: true, sqrtPriceX96: 1n << 96n,
  } });
  assert.equal(result.status, "verified");
  if (result.status !== "verified") throw new Error("fixture identity failed");
  const descriptor = plugin.instance.finalizeDescriptor({ identity: result.identity,
    draft: plugin.instance.compileDraft(result.identity), sharedBindings: [] });
  const routes = plugin.routes.project({ descriptor });
  const buy = routes.find(r => r.direction === "zero-for-one")!, sell = routes.find(r => r.direction === "one-for-zero")!;
  const actor = (buy: boolean) => String(ethers.AbiCoder.defaultAbiCoder().decode(["address"], hookDataFor(descriptor, executor, buy))[0]).toLowerCase();
  const state: Sat1LocalState = { ethCum: 24278393268966303699n, actualSupply: 1700000n * W,
    nativeBalance: 30n * W, managerNativeBalance: 1000n * W, managerTokenBalance: 1700000n * W,
    genesisBlock: 25044547n, initialized: true, deprecated: false,
    lastBuyBlocks: { [actor(true)]: 0n, [actor(false)]: 0n } };
  const input = { descriptor, route: buy, amountIn: W / 100n, source, executor, runtimeEvidence: [] };
  const method = plugin.exact.methods(input).find(m => m.id === "sat1-local-exact-in")!;
  assert(method.kind === "request-program" && method.trialState);
  const quoteTrial = method.trialState.quote;
  assert(typeof quoteTrial === "function", "expected supported Sat1 trial model");
  const balance = new ethers.Interface(["function getEthBalance(address) view returns(uint256)"]);
  function results(requests: readonly AdapterRequest[], s = state, poolInitialized = true): AdapterRequestResult[] {
    return requests.map(r => {
      assert(r.kind === "eth-call");
      let data: string;
      if (r.id === "sat1-local:slot0") {
        data = UNIV4_STATE_VIEW_INTERFACE.encodeFunctionResult("getSlot0", [poolInitialized ? 1n << 96n : 0n, 0, 0, 3000]);
      } else if (r.id === "sat1-local:nativeBalance" || r.id === "sat1-local:managerNativeBalance") {
        const manager = r.id === "sat1-local:managerNativeBalance";
        assert.equal(balance.decodeFunctionData("getEthBalance", r.data)[0].toLowerCase(), manager ? descriptor.managerBinding.manager.toLowerCase() : hook);
        data = balance.encodeFunctionResult("getEthBalance", [manager ? s.managerNativeBalance : s.nativeBalance]);
      } else {
        const decoded = SAT1.parseTransaction({ data: r.data })!;
        const values: Record<string, bigint | boolean> = { ethCum: s.ethCum, totalSupply: s.actualSupply,
          GENESIS_BLOCK: s.genesisBlock, poolInitialized: s.initialized, selfDeprecated: s.deprecated, balanceOf: s.managerTokenBalance,
          lastBuyBlock: decoded.name === "lastBuyBlock" ? s.lastBuyBlocks[String(decoded.args[0]).toLowerCase()]! : 0n };
        data = SAT1.encodeFunctionResult(decoded.name, [values[decoded.name]]);
      }
      return { id: r.id, source, ok: true, completion: "returned", data,
        provenance: { kind: "fixture", fingerprint: "not-chain-evidence" } };
    });
  }
  return { descriptor, buy, sell, actor, state, input, method, quoteTrial, results };
}

test("Sat1 defaults to bounded local reads and retains explicit Quoter mode", () => {
  const f = fixture();
  assert.equal("requiresTrialState" in plugin.exact, false, "no Family-specific route-state opt-in flag");
  const reads = f.method.program.buildRequests(f.input);
  assert.equal(reads.length, 11);
  assert.throws(() => f.method.program.buildRequests({ ...f.input, amountIn: 5n * W + 1n }), /MAX_BUY/);
  assert(reads.every(r => r.kind === "eth-call" && r.to.toLowerCase() !== f.descriptor.managerBinding.quoter.toLowerCase()));
  assert.equal(f.method.stateOnlyReads, undefined, "block height affects entropy and cooldown");
  assert.equal(f.method.sequentialPrefix, undefined, "public state composition replaces prefix shape special cases");
  const q = f.method.program.decode({ programInput: f.input, initialResults: f.results(reads), dependentEvidence: [] });
  const expected = sat1QuoteAndApply(f.state, f.input.amountIn, true, f.actor(true), BigInt(source.number));
  assert.equal(q.amountOut, expected.amountOut);
  assert.equal(q.evidence.kind, "sat1-local-exact-in");
  assert.equal(q.stateChanges, undefined, "single-leg consumers do not create trial state");
  assert(createUniv4FeeHookExact("quoter").methods(f.input).some(m => m.id === "univ4-fee-hook-quoter"));
  const fragment = plugin.execution.buildFragment({ ...f.input, quotedAmountOut: q.amountOut, exactEvidence: q.evidence, minAmountOut: q.amountOut });
  assert.equal(fragment.nodes[0]!.children[1]!.amount, q.amountOut);
  const zero = { ...f.input, amountIn: 0n };
  assert.deepEqual(f.method.program.buildRequests(zero), []);
  assert.equal(f.method.program.decode({ programInput: zero, initialResults: [], dependentEvidence: [] }).amountOut, 0n);
});

test("Sat1 buy/interleaved untouched resource/sell uses advanced state without another read", () => {
  const f = fixture(), baseline = emptyExactTrialState();
  const input = { ...f.input, trialState: baseline.view };
  assert.equal(f.quoteTrial(input).status, "not-applicable");
  const reads = f.method.program.buildRequests(input);
  const q = f.method.program.decode({ programInput: input, initialResults: f.results(reads), dependentEvidence: [] });
  assert(q.stateChanges?.length);
  const afterBuy = applyExactTrialState(baseline, q.stateChanges, q.stateEffects);
  const afterOther = applyExactTrialState(afterBuy, [], [storageState("0x3333333333333333333333333333333333333333")]);
  const sellInput = { ...input, route: f.sell, amountIn: q.amountOut, trialState: afterOther.view };
  const attempt = f.quoteTrial(sellInput);
  assert.equal(attempt.status, "quoted");
  if (attempt.status !== "quoted") throw new Error("missing sequential result");
  const next = sat1QuoteAndApply(f.state, f.input.amountIn, true, f.actor(true), BigInt(source.number));
  const expected = sat1QuoteAndApply(next.nextState, q.amountOut, false, f.actor(false), BigInt(source.number));
  assert.equal(attempt.result.amountOut, expected.amountOut);
  const baselineSell = sat1QuoteAndApply(f.state, q.amountOut, false, f.actor(false), BigInt(source.number));
  assert.notEqual(attempt.result.amountOut, baselineSell.amountOut, "must not quote original state");
  const memoDecode = f.method.program.decode({ programInput: sellInput, initialResults: f.results(reads), dependentEvidence: [] });
  assert.equal(memoDecode.amountOut, expected.amountOut, "source-read memo cannot overwrite trial state");
  const secondAmount = f.method.program.decode({ programInput: { ...input, amountIn: f.input.amountIn * 2n },
    initialResults: f.results(reads), dependentEvidence: [] });
  assert.equal(secondAmount.amountOut, sat1QuoteAndApply(f.state, f.input.amountIn * 2n, true, f.actor(true), BigInt(source.number)).amountOut);
  assert.equal(f.quoteTrial(input).status, "not-applicable", "earlier snapshot isolates other amounts/routes");
});

test("Sat1 dependency mutations, stale sources, entropy, cooldown and output capacity fail closed", () => {
  const f = fixture(), baseline = emptyExactTrialState(), input = { ...f.input, trialState: baseline.view };
  const reads = f.method.program.buildRequests(input);
  const q = f.method.program.decode({ programInput: input, initialResults: f.results(reads), dependentEvidence: [] });
  const loaded = applyExactTrialState(baseline, q.stateChanges!, q.stateEffects);
  for (const dependency of [storageState(hook), nativeBalanceState(hook), storageState(token), tokenSupplyState(token),
    nativeBalanceState(f.descriptor.managerBinding.manager),
    `token-balance:${token}:${f.descriptor.managerBinding.manager.toLowerCase()}`]) {
    for (const start of [baseline, loaded]) {
      const changed = applyExactTrialState(start, [], [dependency]);
      assert.throws(() => f.quoteTrial({ ...input, trialState: changed.view }), /invalidated dependency/);
      assert.throws(() => f.method.program.decode({ programInput: { ...input, trialState: changed.view },
        initialResults: f.results(reads), dependentEvidence: [] }), /invalidated dependency/);
    }
  }
  assert.throws(() => f.method.program.decode({ programInput: input, initialResults: f.results(reads).map((r, i) =>
    i === 0 ? { ...r, source: { ...source, generation: 2 } } : r), dependentEvidence: [] }), /source/);
  for (const change of [{ genesisBlock: BigInt(source.number) - 99n }, { initialized: false }, { deprecated: true }]) {
    assert.throws(() => f.method.program.decode({ programInput: input,
      initialResults: f.results(reads, { ...f.state, ...change }), dependentEvidence: [] }));
  }
  assert.throws(() => f.method.program.decode({ programInput: input,
    initialResults: f.results(reads, { ...f.state, managerNativeBalance: input.amountIn - 1n }), dependentEvidence: [] }), /temporary input capacity/);
  assert.throws(() => f.method.program.decode({ programInput: input,
    initialResults: f.results(reads, f.state, false), dependentEvidence: [] }), /source pool is not initialized/);
  for (const change of [{ nativeBalance: 0n }, { managerTokenBalance: 999n * W },
    { lastBuyBlocks: { ...f.state.lastBuyBlocks, [f.actor(false)]: BigInt(source.number) } }]) {
    assert.throws(() => f.method.program.decode({ programInput: { ...input, route: f.sell, amountIn: 1000n * W },
      initialResults: f.results(reads, { ...f.state, ...change }), dependentEvidence: [] }));
  }
});

test("different PoolIds sharing one Sat1 hook retain its state and require source initialization proof", () => {
  const f = fixture(), base = emptyExactTrialState(), input = { ...f.input, trialState: base.view };
  const q = f.method.program.decode({ programInput: input,
    initialResults: f.results(f.method.program.buildRequests(input)), dependentEvidence: [] });
  const after = applyExactTrialState(base, q.stateChanges!, q.stateEffects);
  const poolKey = { ...f.descriptor.poolKey, tickSpacing: 120 }, poolId = v4PoolId(poolKey);
  const descriptor = { ...f.descriptor, poolId, poolKey,
    instanceKey: instanceKey(`${f.descriptor.managerBinding.manager.toLowerCase()}\u001f${poolId}`) };
  const route = plugin.routes.project({ descriptor }).find(r => r.direction === "one-for-zero")!;
  const next = { ...input, descriptor, route, amountIn: q.amountOut, trialState: after.view };
  assert.equal(f.quoteTrial(next).status, "not-applicable", "new PoolId needs proof, not a new curve baseline");
  const reads = f.method.program.buildRequests(next);
  assert.throws(() => f.method.program.decode({ programInput: next,
    initialResults: f.results(reads, f.state, false), dependentEvidence: [] }), /source pool is not initialized/);
  const sold = f.method.program.decode({ programInput: next, initialResults: f.results(reads), dependentEvidence: [] });
  const expectedBuy = sat1QuoteAndApply(f.state, input.amountIn, true, f.actor(true), BigInt(source.number));
  assert.equal(sold.amountOut, sat1QuoteAndApply(expectedBuy.nextState, next.amountIn, false, f.actor(false), BigInt(source.number)).amountOut);
  const loaded = applyExactTrialState(after, sold.stateChanges!, sold.stateEffects);
  assert.equal(f.quoteTrial({ ...input, trialState: loaded.view }).status, "quoted");
});

test("V3 → Sat1 buy → Sat1 sell → same V3 preserves both model poststates in the public trial", () => {
  const f = fixture(), pool = "0x4444444444444444444444444444444444444444";
  const otherToken = "0x0000000000000000000000000000000000000010";
  // Synthetic pool, actual production V3 and Sat1 methods; not historical
  // discovery/Solver acceptance. Its 1:1 initial quote keeps buy below 5 ETH.
  const descriptor = { familyId: "univ3", lineageId: "univ3", instanceKey: instanceKey(pool), pool,
    token0: otherToken, token1: f.descriptor.graphToken0, fee: 3000n, tickSpacing: 60,
    factoryBinding: { factory: "0x5555555555555555555555555555555555555555", reversePool: pool },
    quoterBinding: { quoter: null, router: null, provenance: "none" },
    swapAccess: { kind: "no-is-swapper-getter", codeHash: "fixture" },
  } as unknown as UniV3Descriptor;
  const routes = univ3Routes.project({ descriptor });
  const state: V3PoolState = { sqrtPriceX96: 1n << 96n, tick: 0, liquidity: 1000n * W,
    fee: 3000n, tickSpacing: 60, tickBitmap: new Map([[-1, 0n], [0, 0n], [1, 0n]]), ticks: new Map(), unlocked: true };
  const saved = structuredClone(state);
  function run(amount: bigint) {
    let trial = applyExactTrialState(emptyExactTrialState(), [{ ref: v3TrialStateRef(descriptor), value: state }]);
    const firstInput = { descriptor, route: routes[0]!, source, executor, runtimeEvidence: [], amountIn: amount, trialState: trial.view };
    const v3Method = createUniV3Exact().methods(firstInput)[1]!;
    assert(v3Method.kind === "request-program" && typeof v3Method.trialState?.quote === "function");
    const first = v3Method.trialState.quote(firstInput);
    assert(first.status === "quoted");
    const firstQuote: ExactQuoteResult<unknown> = first.result;
    trial = applyExactTrialState(trial, firstQuote.stateChanges!, firstQuote.stateEffects);
    const buyInput = { ...f.input, amountIn: first.result.amountOut, trialState: trial.view,
      prefix: [{ descriptor, route: routes[0]!, amountIn: amount, amountOut: first.result.amountOut }] };
    const buy = f.method.program.decode({ programInput: buyInput,
      initialResults: f.results(f.method.program.buildRequests(buyInput)), dependentEvidence: [] });
    trial = applyExactTrialState(trial, buy.stateChanges!, buy.stateEffects);
    const sellInput = { ...buyInput, route: f.sell, amountIn: buy.amountOut, trialState: trial.view,
      prefix: [...buyInput.prefix, { descriptor: f.descriptor, route: f.buy, amountIn: buyInput.amountIn, amountOut: buy.amountOut }] };
    const sell = f.quoteTrial(sellInput);
    assert(sell.status === "quoted", "foreign V3 prefix is not a Sat1-specific rejection");
    trial = applyExactTrialState(trial, sell.result.stateChanges!, sell.result.stateEffects);
    const finalInput = { ...firstInput, route: routes[1]!, amountIn: sell.result.amountOut, trialState: trial.view };
    const last = v3Method.trialState.quote(finalInput);
    assert(last.status === "quoted");
    const advancedV3 = v3SwapToState(state, true, amount).state;
    assert.equal(last.result.amountOut, v3SwapToState(advancedV3, false, sell.result.amountOut).amountOut);
    assert.notEqual(last.result.amountOut, v3SwapToState(state, false, sell.result.amountOut).amountOut,
      "return to V3 consumes poststate instead of source state");
    assert.throws(() => f.method.program.buildRequests({ ...buyInput, trialState: undefined }), /issued trial state/);
    return [first.result.amountOut, buy.amountOut, sell.result.amountOut, last.result.amountOut];
  }
  const first = run(W / 10n), second = run(W / 5n);
  assert.notDeepEqual(first, second);
  assert.deepEqual(run(W / 10n), first, "route and amount trials remain isolated");
  assert.deepEqual(state, saved);
});
