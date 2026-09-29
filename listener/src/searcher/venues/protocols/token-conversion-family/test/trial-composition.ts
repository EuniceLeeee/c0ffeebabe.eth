import assert from "node:assert/strict";
import { test } from "node:test";
import { instanceKey } from "../../../adapter-family-identifiers.js";
import type { ExactQuoteInput, ExactQuoteResult } from "../../../adapter-family-plugin.js";
import { applyExactTrialState, emptyExactTrialState } from "../../../../exact-trial-state.js";
import { storageState, tokenBalanceState, tokenSupplyState } from "../../../local-state-models/resources.js";
import { v3TrialStateRef } from "../../../local-state-models/v3-state.js";
import { createUniV3Exact } from "../../../swaps/univ3-family/exact.js";
import { univ3Routes } from "../../../swaps/univ3-family/routes.js";
import type { UniV3Descriptor } from "../../../swaps/univ3-family/types.js";
import { v3SwapToState, type V3PoolState } from "../../../../solver/v3-math.js";
import { quoteXwinTransition, type XwinLocalFundState } from "../xwin-transition.js";
import { quoteBearTrial, quoteXwinTrial, type XwinTrialFund } from "../trial-state.js";
import { createConversionExact } from "../exact.js";
import { routes } from "../routes.js";
import { FAMILY, LINEAGE, XWIN_LINEAGE } from "../manifest.js";
import type { ConversionDescriptor, ConversionRoute } from "../types.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const BASE = addr(1), TARGET = addr(2), POOL = addr(3), FUND = addr(4), ACTOR = addr(5);
const WAD = 10n ** 18n;
const SOURCE = { number: 100, hash: `0x${"aa".repeat(32)}`, generation: 1 };
function trialView(...quotes: readonly ExactQuoteResult<unknown>[]) {
  let snapshot = emptyExactTrialState();
  for (const quote of quotes) snapshot = applyExactTrialState(snapshot, quote.stateChanges!, quote.stateEffects);
  return snapshot.view;
}
const descriptor: ConversionDescriptor = { familyId: FAMILY, lineageId: XWIN_LINEAGE, instanceKey: instanceKey(FUND),
  target: FUND, asset: BASE, variant: "xwin-allocations-v1", proxyAdmin: addr(6), codeHash: "fixture", provenance: [], runtimeRequirements: [] };
const conversionRoutes = routes.project({ descriptor });
function input(amountIn: bigint, direction: "mint" | "redeem", prior: readonly ExactQuoteResult<unknown>[] = []): ExactQuoteInput<ConversionDescriptor, ConversionRoute> {
  return { descriptor, route: conversionRoutes.find(route => route.direction === direction)!, amountIn, source: SOURCE,
    executor: ACTOR, runtimeEvidence: [], trialState: trialView(...prior) };
}
function fixture(): XwinTrialFund {
  const pool: V3PoolState = { sqrtPriceX96: 1n << 96n, tick: 0, liquidity: 10n ** 24n, fee: 3000n,
    tickSpacing: 60, tickBitmap: new Map([[-1, 0n], [0, 0n], [1, 0n]]), ticks: new Map(), unlocked: true };
  const state: XwinLocalFundState = { supply: 1000n * WAD, pendingMFee: 0n, managerFee: 200n,
    blocksPerDay: 7200n, lastManagerFeeCollection: 100n, blockNumber: 100n, baseToken: BASE,
    baseDecimals: 18, baseTokenAmt: 500n * WAD, balances: new Map([[BASE, 500n * WAD], [TARGET, 500n * WAD]]),
    targets: [{ token: TARGET, decimals: 18, weightBps: 5000n, priceInBase: WAD },
      { token: BASE, decimals: 18, weightBps: 5000n, priceInBase: WAD }], performanceFee: 0n,
    watermarkUnitprice: WAD, waived: false, prevCollectionBlock: 1n, collectionPeriod: 1000n, lockingDiscountBps: null,
    swaps: [{ tokenIn: BASE, tokenOut: TARGET, poolKey: POOL, zeroForOne: true, swapFeeBps: 30n, oraclePrice: WAD, slippageBps: 100n },
      { tokenIn: TARGET, tokenOut: BASE, poolKey: POOL, zeroForOne: false, swapFeeBps: 30n, oraclePrice: WAD, slippageBps: 100n }],
    pools: new Map([[POOL, pool]]) };
  return { state, resources: { dependencies: [storageState(FUND), tokenSupplyState(FUND),
    tokenBalanceState(BASE, FUND), tokenBalanceState(TARGET, FUND)], effects: [storageState(FUND), tokenSupplyState(FUND),
    tokenBalanceState(BASE, FUND), tokenBalanceState(TARGET, FUND)] } };
}
const v3Descriptor = { familyId: "univ3", lineageId: "univ3", instanceKey: instanceKey(POOL), pool: POOL,
  token0: BASE, token1: TARGET, fee: 3000n, tickSpacing: 60, factoryBinding: { factory: addr(7), reversePool: POOL },
  quoterBinding: { quoter: null, router: null, provenance: "none" }, swapAccess: { kind: "no-is-swapper-getter", codeHash: "fixture" },
} as unknown as UniV3Descriptor;
const v3Routes = univ3Routes.project({ descriptor: v3Descriptor });
function direct(amountIn: bigint, forward: boolean, prior: readonly ExactQuoteResult<unknown>[]) {
  const i = { descriptor: v3Descriptor, route: v3Routes[forward ? 0 : 1]!, amountIn, source: SOURCE,
    executor: ACTOR, runtimeEvidence: [], trialState: trialView(...prior) };
  const method = createUniV3Exact().methods(i).find(method => method.kind === "request-program")!;
  assert(method.kind === "request-program" && typeof method.trialState?.quote === "function");
  const result = method.trialState.quote(i);
  assert(result.status === "quoted");
  return result.result;
}

test("direct V3 → fund mint → fund redeem → direct V3 shares one actual pool state without prefix scanning", () => {
  const fund = fixture(), saved = structuredClone(fund);
  const baseline: ExactQuoteResult<unknown> = { amountOut: 0n, evidence: null,
    stateChanges: [{ ref: v3TrialStateRef(v3Descriptor), value: fund.state.pools.get(POOL)! }] };
  const run = (amount: bigint) => {
    const first = direct(amount, false, [baseline]);
    const externalState = v3SwapToState(fund.state.pools.get(POOL)!, false, amount).state;
    const mint = quoteXwinTrial(input(first.amountOut, "mint", [first]), fund)!;
    const expectedMint = quoteXwinTransition({ ...fund.state, pools: new Map([[POOL, externalState]]) }, "deposit", first.amountOut);
    assert.equal(mint.amountOut, expectedMint.amountOut);
    assert.notEqual(mint.amountOut, quoteXwinTransition(fund.state, "deposit", first.amountOut).amountOut,
      "freshly decoded baseline must not reset the external pool mutation");
    const redeem = quoteXwinTrial(input(mint.amountOut, "redeem", [first, mint]))!;
    const expectedRedeem = quoteXwinTransition(expectedMint.state, "withdraw", mint.amountOut);
    assert.equal(redeem.amountOut, expectedRedeem.amountOut);
    const last = direct(redeem.amountOut, true, [first, mint, redeem]);
    assert.equal(last.amountOut, v3SwapToState(expectedRedeem.state.pools.get(POOL)!, true, redeem.amountOut).amountOut);
    return [first.amountOut, mint.amountOut, redeem.amountOut, last.amountOut];
  };
  const a = run(5n * WAD), b = run(20n * WAD);
  assert.deepEqual(run(5n * WAD), a, "another amount never mutates the source or previous trial");
  assert.notDeepEqual(a, b);
  assert.deepEqual(fund, saved);
  assert.equal("requiresTrialState" in createConversionExact(), false, "route state has no separate Family opt-in flag");
});

test("BTB shared state applies backing and supply capacity in both directions", () => {
  const d: ConversionDescriptor = { ...descriptor, variant: "btb-bear-v1", lineageId: LINEAGE, assetCodeHash: "fixture" };
  const r = routes.project({ descriptor: d });
  const make = (amountIn: bigint, direction: "mint" | "redeem", prior: readonly ExactQuoteResult<unknown>[] = []) =>
    ({ ...input(amountIn, direction, prior), descriptor: d, route: r.find(route => route.direction === direction)! });
  const state = { source: SOURCE, supply: 100n, backing: 80n };
  const mint = quoteBearTrial(make(20n, "mint"), state)!;
  const redeem = quoteBearTrial(make(100n, "redeem", [mint]))!;
  assert.equal(redeem.amountOut, 100n);
  assert.throws(() => quoteBearTrial(make(1n, "redeem", [mint, redeem])), /capacity/);
  assert.throws(() => quoteBearTrial(make(81n, "redeem"), state), /capacity/);
  assert.deepEqual(state, { source: SOURCE, supply: 100n, backing: 80n });
  const donated = applyExactTrialState(applyExactTrialState(emptyExactTrialState(), mint.stateChanges!, mint.stateEffects),
    [], [tokenBalanceState(BASE, FUND)]);
  assert.throws(() => quoteBearTrial({ ...make(1n, "redeem"), trialState: donated.view }, state), /invalidated dependency/,
    "foreign backing mutations cannot be reset by a fresh source snapshot");
});

test("xWin dependency mutations reject both a retained fund and newly decoded original state", () => {
  const fund = fixture(), first = quoteXwinTrial(input(WAD, "mint"), fund)!;
  const snapshot = applyExactTrialState(emptyExactTrialState(), first.stateChanges!, first.stateEffects);
  const changed = applyExactTrialState(snapshot, [], [tokenBalanceState(TARGET, FUND)]);
  assert.throws(() => quoteXwinTrial({ ...input(first.amountOut, "redeem"), trialState: changed.view }, fund), /invalidated dependency/);
  const unseenChanged = applyExactTrialState(emptyExactTrialState(), [], [tokenBalanceState(TARGET, FUND)]);
  assert.throws(() => quoteXwinTrial({ ...input(WAD, "mint"), trialState: unseenChanged.view }, fund), /invalidated dependency/);
  assert.throws(() => quoteXwinTrial({ ...input(WAD, "mint"), trialState: undefined,
    prefix: [{ descriptor, route: conversionRoutes[0], amountIn: WAD, amountOut: WAD }] }, fund), /issued trial state/);
});

test("xWin publishes only actually traded pools; merely reading an unchanged pool never invalidates it", () => {
  const fund = fixture();
  // This deposit is entirely allocated to the base asset. The configured V3
  // route remains available to later withdrawals, but is not executed now.
  const noSwap = { ...fund, state: { ...fund.state,
    targets: fund.state.targets.map(target => ({ ...target, weightBps: target.token === BASE ? 10_000n : 0n })) } };
  const poolRef = v3TrialStateRef(v3Descriptor);
  const observerRef = { key: "test:pool-observer", schema: "test", binding: "test", dependencies: [poolRef.key] };
  const seeded = applyExactTrialState(emptyExactTrialState(), [
    { ref: poolRef, value: fund.state.pools.get(POOL)! }, { ref: observerRef, value: { stillValid: true } },
  ]);
  const q = quoteXwinTrial({ ...input(WAD, "mint"), trialState: seeded.view }, noSwap)!;
  assert.equal(q.stateChanges!.length, 1, "only fund state changes; no false pool write or seed");
  assert(!q.stateEffects!.includes(storageState(POOL)));
  const after = applyExactTrialState(seeded, q.stateChanges!, q.stateEffects);
  assert.deepEqual(after.view.get(observerRef), { stillValid: true });
  assert.deepEqual(after.view.get(poolRef), seeded.view.get(poolRef));
  const active = quoteXwinTrial(input(WAD, "mint"), fund)!;
  assert.equal(active.stateChanges!.filter(change => change.ref.key === poolRef.key).length, 1);
});
