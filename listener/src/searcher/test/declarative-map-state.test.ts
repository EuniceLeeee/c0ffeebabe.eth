import assert from "node:assert/strict";
import test from "node:test";
import { toBeHex } from "ethers";
import { applyExactTrialState, emptyExactTrialState, immutableExactTrialData } from "../exact-trial-state.js";
import { immutableDeclarativeData } from "../venues/declarative-immutable.js";
import { createDeclarativeMathRegistry } from "../venues/declarative-math.js";
import { compileDeclarativeTrialState } from "../venues/declarative-trial-state.js";
import { compileDeclarativeValues } from "../venues/declarative-values.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { readV3TrialState, v3TrialStateRef } from "../venues/local-state-models/v3-state.js";
import { quoteXwinTransition, type XwinLocalFundState } from "../venues/protocols/token-conversion-family/xwin-transition.js";
import type { V3PoolState } from "../solver/v3-math.js";

const address = (n: number) => toBeHex(n, 20);
const BASE = address(1), TOKEN = address(2), POOL = address(3), FUND = address(4), ACTOR = address(5), WAD = 10n ** 18n;
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const poolBinding = { pool: POOL, token0: BASE, token1: TOKEN, fee: 3000n, tickSpacing: 60 };
const fundRef = { key: `fund:${FUND}`, schema: "fixture:fund:v1", binding: "fixture-bound-fund-and-executor", dependencies: ["oracle:one"] };
function fixture(): XwinLocalFundState {
  const pool: V3PoolState = { sqrtPriceX96: 1n << 96n, tick: 0, liquidity: 10n ** 24n, fee: 3000n, tickSpacing: 60,
    tickBitmap: new Map([[-1, 0n], [0, 0n], [1, 0n]]), ticks: new Map(), unlocked: true };
  return { supply: 1000n * WAD, pendingMFee: 0n, managerFee: 200n, blocksPerDay: 7200n, lastManagerFeeCollection: 100n,
    blockNumber: 100n, baseToken: BASE, baseDecimals: 18, baseTokenAmt: 500n * WAD,
    balances: new Map([[BASE, 500n * WAD], [TOKEN, 500n * WAD]]),
    targets: [{ token: TOKEN, decimals: 18, weightBps: 5000n, priceInBase: WAD }, { token: BASE, decimals: 18, weightBps: 5000n, priceInBase: WAD }],
    performanceFee: 0n, watermarkUnitprice: WAD, waived: false, prevCollectionBlock: 1n, collectionPeriod: 1000n, lockingDiscountBps: null,
    swaps: [{ tokenIn: BASE, tokenOut: TOKEN, poolKey: POOL, zeroForOne: true, swapFeeBps: 30n, oraclePrice: WAD, slippageBps: 100n },
      { tokenIn: TOKEN, tokenOut: BASE, poolKey: POOL, zeroForOne: false, swapFeeBps: 30n, oraclePrice: WAD, slippageBps: 100n }],
    pools: new Map([[POOL, pool]]) };
}
// Explicit test projection, not a new production encoding. Canonical hashing
// continues to require the existing plain-record/array semantic projection.
function projection(state: XwinLocalFundState): any {
  return { ...state, balances: [...state.balances].sort(([a], [b]) => a.localeCompare(b)),
    pools: [...state.pools].sort(([a], [b]) => a.localeCompare(b)).map(([key, pool]) => [key, { ...pool,
      tickBitmap: [...pool.tickBitmap].sort(([a], [b]) => a - b), ticks: [...pool.ticks].sort(([a], [b]) => a - b) }]) };
}
function bindings(evaluate = (input: any) => quoteXwinTransition(input.state, "deposit", input.amount) as any) {
  return createDeclarativeMathRegistry([{ id: "fixture:xwin", version: 1,
    validateInput(input: any) { assert(input.state.balances instanceof Map); assert(input.state.pools instanceof Map); },
    evaluate, validateOutput(output: any) { assert(output.state.pools instanceof Map); },
  }]).bind({ version: 1, entries: { transition: { model: "fixture:xwin", version: 1 } } });
}
function assertImmutableMap(map: ReadonlyMap<any, any>): void {
  assert(map instanceof Map);
  assert(Object.isFrozen(map));
  assert.throws(() => (map as Map<any, any>).set("bad", 1n), /immutable/);
  assert.throws(() => (map as Map<any, any>).delete([...map.keys()][0]), /immutable/);
  assert.throws(() => (map as Map<any, any>).clear(), /immutable/);
  assert.throws(() => Map.prototype.set.call(map, "bad", 1n), TypeError);
  assert.throws(() => (map.valueOf() as Map<any, any>).clear(), /immutable/);
  assert.throws(() => map.forEach((_value, _key, receiver) => (receiver as Map<any, any>).clear()), /immutable/);
}

test("runtime math preserves real nested xWin Maps, integer metadata and the original mathematical result", () => {
  const state = fixture(), model = bindings(), expected = quoteXwinTransition(state, "deposit", WAD);
  const output = model.transition({ state, amount: WAD });
  assert.equal(output.amountOut, expected.amountOut);
  assert.equal(hashCanonical(projection(output.state)), hashCanonical(projection(expected.state)));
  assert.equal(output.state.baseDecimals, 18);
  assert.equal(output.state.lockingDiscountBps, null);
  assertImmutableMap(output.state.balances);
  assertImmutableMap(output.state.pools);
  assertImmutableMap(output.state.pools.get(POOL).tickBitmap);
  assert.throws(() => { output.state.pools.get(POOL).liquidity = 0n; }, TypeError);
  assert.throws(() => { output.state.targets[0].weightBps = 0n; }, TypeError);
  assert.equal(Object.isFrozen(state), false);
  assert.equal(Object.isFrozen(state.pools.get(POOL)), false);
  assert.equal(hashCanonical(projection(state)), hashCanonical(projection(fixture())));
});

test("immutable math Maps are accepted by actual atomic state publication and subsequent shared pool reads", () => {
  const output = bindings().transition({ state: fixture(), amount: WAD });
  const ref = v3TrialStateRef(poolBinding), pool = output.state.pools.get(POOL);
  const before = ref.binding;
  const first = applyExactTrialState(emptyExactTrialState(), [{ ref, value: pool }]);
  const retrieved = readV3TrialState(first.view, poolBinding)!;
  assert(retrieved.tickBitmap instanceof Map);
  assert.equal(retrieved, pool, "the same issuer may safely reuse an already immutable subtree");
  assert.equal(v3TrialStateRef({ ...poolBinding, fee: retrieved.fee, tickSpacing: retrieved.tickSpacing }).binding, before,
    "the existing V3 canonical binding projection is unchanged");
  const next = applyExactTrialState(first, [{ ref, value: { ...retrieved, liquidity: retrieved.liquidity + 1n } }]);
  assert.equal(readV3TrialState(next.view, poolBinding)!.liquidity, retrieved.liquidity + 1n);
  assert.equal(readV3TrialState(first.view, poolBinding)!.liquidity, pool.liquidity);
  assertImmutableMap(readV3TrialState(next.view, poolBinding)!.tickBitmap);
});

test("common trial-state bootstrap, commit and local quote preserve Map cells across calls", () => {
  const state = fixture(), models = bindings();
  const values = compileDeclarativeValues({ abi: {}, constants: {}, expressions: {} });
  const document = { version: 1, reads: [{ id: "fund", refs: [fundRef], initial: ["$prepared"] }], model: "transition",
    input: { state: "$stateReads.fund.0.state", amount: "$amountIn" }, amountOut: "$modelResult.amountOut",
    stateChanges: [{ ref: "$stateRefs.fund.0", value: { state: "$modelResult.state" } }], stateEffects: ["fund:changed"] };
  const input: any = { source, executor: ACTOR, amountIn: WAD, descriptor: {},
    route: { direction: "deposit", bindingRef: { fingerprint: "fixture-route" } }, runtimeEvidence: [], prefix: [], trialState: emptyExactTrialState().view };
  const runtime = compileDeclarativeTrialState(document, { values, models, environment: input => ({ ...input }),
    evidence: (input: any, amountOut) => ({ source: input.source, executor: input.executor, direction: input.route.direction,
      amountIn: input.amountIn, amountOut, bindingFingerprint: input.route.bindingRef.fingerprint }) });
  const first = runtime.fromReadFlow(input, { state }, [{ id: "state", ok: true, source, completion: "returned", data: "0x",
    provenance: { kind: "fixture", fingerprint: "fixture" } }]);
  const snapshot = applyExactTrialState(emptyExactTrialState(), first.stateChanges!, first.stateEffects);
  const stored = (snapshot.view.get(fundRef) as any).state as XwinLocalFundState;
  const second = runtime.model.quote({ ...input, trialState: snapshot.view });
  assert.equal(second.status, "quoted");
  if (second.status !== "quoted") throw new Error("expected local trial quote");
  assert.equal(second.result.amountOut, quoteXwinTransition(stored, "deposit", WAD).amountOut);
  const next = applyExactTrialState(snapshot, second.result.stateChanges!, second.result.stateEffects);
  assert((next.view.get(fundRef) as any).state.pools instanceof Map);
  assert.equal(hashCanonical(projection((snapshot.view.get(fundRef) as any).state)), hashCanonical(projection(stored)));
  assert.equal(hashCanonical(projection(state)), hashCanonical(projection(fixture())));
  const invalidated = applyExactTrialState(snapshot, [], ["oracle:one"]);
  assert.throws(() => runtime.model.quote({ ...input, trialState: invalidated.view }), /invalidated dependency/);
});

test("mutating original or one returned Map cannot contaminate later independent mathematical calls", () => {
  const state = fixture(), model = bindings(), first = model.transition({ state, amount: WAD });
  const firstHash = hashCanonical(projection(first.state));
  assert.throws(() => first.state.balances.set(BASE, 0n), /immutable/);
  const second = model.transition({ state, amount: WAD });
  assert.equal(hashCanonical(projection(second.state)), firstHash);
  (state.balances as Map<string, bigint>).set(BASE, 0n);
  state.pools.get(POOL)!.tickBitmap.set(1, 1n);
  assert.equal(hashCanonical(projection(first.state)), firstHash);
  const bad = bindings((input: any) => { input.state.pools.get(POOL).tickBitmap.clear(); return input; });
  assert.throws(() => bad.transition({ state: fixture(), amount: WAD }), /immutable/);
});

test("Map key types, insertion order and explicit canonical projections are preserved", () => {
  const raw = new Map<any, any>([[0, { value: 1n }], ["0", { value: 2n }], [0n, { value: 3n }]]);
  const frozen = immutableDeclarativeData(raw, "math");
  assert.deepEqual([...frozen.keys()], [0, "0", 0n]);
  assert.deepEqual([...frozen.values()].map(value => value.value), [1n, 2n, 3n]);
  assert.equal(hashCanonical([...raw]), hashCanonical([...frozen]));
  assert.throws(() => hashCanonical(frozen as any), /plain records/, "no silent Map-to-empty-object hashing");
  const entry = frozen.entries().next().value!;
  entry[0] = "changed";
  assert(frozen.has(0)); assert.equal(frozen.has("changed"), false);
});

test("unsafe numbers, object keys, cycles, accessors and foreign Map proxies fail closed", () => {
  const cyclic = new Map<any, any>(); cyclic.set("self", cyclic);
  const nested: any = { map: new Map() }; nested.map.set("cycle", nested);
  const withMethod = new Map(); Object.defineProperty(withMethod, "entries", { value: () => { throw new Error("must not execute"); } });
  const accessor = { get value() { throw new Error("must not execute"); } };
  const invalid = [new Map([[{}, 1n]]), new Map([[1.5, 1n]]), new Map([[Number.MAX_SAFE_INTEGER + 1, 1n]]),
    cyclic, nested, withMethod, new Map([["value", accessor]]), new Proxy(new Map([["v", 1n]]), {}),
    new Map([["async", Promise.resolve(1n)]]), new Map([["bad", NaN]]), new Map([["undefined", undefined]])];
  for (const value of invalid) assert.throws(() => immutableDeclarativeData(value, "math"));
  assert.throws(() => immutableDeclarativeData(Object.assign([1n], { map: () => [] }), "math"));
  assert.throws(() => immutableDeclarativeData(new Array(2), "math"));
  assert.equal(immutableDeclarativeData(18, "math"), 18);
  assert.equal(immutableDeclarativeData(null, "math"), null);
  const issued = immutableExactTrialData(new Map([["fraction", 1.5]]));
  assert.throws(() => immutableDeclarativeData(issued, "math"), /lossless/);
  assert.equal(immutableDeclarativeData(issued, "trial"), issued, "trial data retains its existing finite-number contract");
});
