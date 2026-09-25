import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getAmount0Delta, getAmount1Delta, getSqrtRatioAtTick, getTickAtSqrtRatio,
  MAX_SQRT_RATIO, MAX_TICK, MIN_SQRT_RATIO, MIN_TICK,
  V3MissingBitmapWordError, v3SwapToState, type V3PoolState,
} from "../solver/v3-math.js";
import { instanceKey } from "../venues/adapter-family-identifiers.js";
import type { ExactQuoteInput } from "../venues/adapter-family-plugin.js";
import { UNIV3_CANONICAL_FACTORY, UNIV3_QUOTER_V2 } from "../venues/swaps/univ3-abi.js";
import { createUniV3Exact } from "../venues/swaps/univ3-family/exact.js";
import { UNIV3_FACTORY_LINEAGE_ID, UNIV3_FAMILY_ID } from "../venues/swaps/univ3-family/manifest.js";
import { univ3Routes } from "../venues/swaps/univ3-family/routes.js";
import { UNIV3_STATE_READER_INTERFACE } from "../venues/swaps/univ3-family/state-reader.js";
import type { UniV3Descriptor, UniV3Route } from "../venues/swaps/univ3-family/types.js";

const Q96 = 1n << 96n;
const POOL = "0x3333333333333333333333333333333333333333";
const EXECUTOR = "0x6666666666666666666666666666666666666666";
const SOURCE = Object.freeze({ number: 22_000_000, hash: `0x${"ab".repeat(32)}`, generation: 7 });
const descriptor: UniV3Descriptor = Object.freeze({
  familyId: UNIV3_FAMILY_ID, lineageId: UNIV3_FACTORY_LINEAGE_ID,
  instanceKey: instanceKey(POOL), provenance: [], runtimeRequirements: [],
  pool: POOL, token0: "0x1111111111111111111111111111111111111111",
  token1: "0x2222222222222222222222222222222222222222", fee: 3000n, tickSpacing: 60,
  factoryBinding: { factory: UNIV3_CANONICAL_FACTORY, reversePool: POOL },
  quoterBinding: { quoter: UNIV3_QUOTER_V2, router: null, provenance: "factory-bound-infrastructure" as const },
  swapAccess: { kind: "no-is-swapper-getter" as const, codeHash: `0x${"cd".repeat(32)}` },
});
const routes = univ3Routes.project({ descriptor });
type Input = ExactQuoteInput<UniV3Descriptor, UniV3Route>;
function input(amountIn: bigint, zeroForOne = true, retain = true): Input {
  return { descriptor, route: routes[zeroForOne ? 0 : 1]!, source: SOURCE,
    executor: EXECUTOR, runtimeEvidence: [], amountIn,
    ...(retain ? { retainLocalState: true as const } : {}) };
}

function state(liquidity = 10n ** 18n, fee = descriptor.fee): V3PoolState {
  const ticks = new Map([[-120, liquidity / 4n], [-60, liquidity / 2n],
    [60, -liquidity / 2n], [120, -liquidity / 4n]]);
  const tickBitmap = new Map<number, bigint>();
  for (let word = -24; word <= 24; word++) tickBitmap.set(word, 0n);
  for (const tick of ticks.keys()) {
    const compressed = tick / 60, word = compressed >> 8;
    tickBitmap.set(word, tickBitmap.get(word)! | (1n << BigInt(compressed & 255)));
  }
  return { sqrtPriceX96: Q96, tick: 0, liquidity, fee, tickSpacing: 60, tickBitmap, ticks };
}

function encodedState(value: V3PoolState): string {
  return UNIV3_STATE_READER_INTERFACE.encodeFunctionResult("getFullStateWithRelativeBitmaps", [{
    pool: POOL, blockTimestamp: 1_800_000_000,
    slot0: { sqrtPriceX96: value.sqrtPriceX96, tick: value.tick, observationIndex: 0,
      observationCardinality: 1, observationCardinalityNext: 1, feeProtocol: 0, unlocked: true },
    liquidity: value.liquidity, tickSpacing: value.tickSpacing, maxLiquidityPerTick: (1n << 128n) - 1n,
    observation: { blockTimestamp: 1_800_000_000, tickCumulative: 0n,
      secondsPerLiquidityCumulativeX128: 0n, initialized: true },
    tickBitmap: [...value.tickBitmap].filter(([, bitmap]) => bitmap !== 0n)
      .map(([index, bitmap]) => ({ index, value: bitmap })),
    ticks: [...value.ticks].map(([index, net]) => ({ index, value: {
      liquidityGross: net < 0n ? -net : net === 0n ? 1n : net, liquidityNet: net,
      tickCumulativeOutside: 0n, secondsPerLiquidityOutsideX128: 0n,
      secondsOutside: 0, initialized: true,
    } })),
  }]);
}

function method(exact: ReturnType<typeof createUniV3Exact>, programInput = input(10n ** 15n)) {
  const result = exact.methods(programInput)[1]!;
  assert.equal(result.kind, "request-program");
  if (result.kind !== "request-program") throw new Error("missing V3 state method");
  return result;
}

function first(exact: ReturnType<typeof createUniV3Exact>, programInput: Input, base = state()) {
  return method(exact, programInput).program.decode({ programInput, dependentEvidence: [], initialResults: [{
    id: "local-pool-state", ok: true, source: SOURCE, completion: "returned", data: encodedState(base),
    provenance: { kind: "fixture", fingerprint: "univ3-local-sequential" },
  }] });
}

test("TickMath inverse preserves canonical bounds and exact/below-tick rounding", () => {
  assert.equal(getTickAtSqrtRatio(MIN_SQRT_RATIO), MIN_TICK);
  assert.equal(getTickAtSqrtRatio(MAX_SQRT_RATIO - 1n), MAX_TICK - 1);
  assert.equal(getTickAtSqrtRatio(Q96), 0);
  assert.equal(getTickAtSqrtRatio(Q96 - 1n), -1);
  assert.throws(() => getTickAtSqrtRatio(MIN_SQRT_RATIO - 1n), /R/);
  assert.throws(() => getTickAtSqrtRatio(MAX_SQRT_RATIO), /R/);
  for (const tick of [-887271, -256, -120, -60, -1, 0, 1, 60, 120, 256, 887271]) {
    const ratio = getSqrtRatioAtTick(tick);
    assert.equal(getTickAtSqrtRatio(ratio), tick);
    assert.equal(getTickAtSqrtRatio(ratio - 1n), tick - 1);
  }
});

test("same-direction partial steps update the actual tick without changing input state/maps", () => {
  const base = state(4n * Q96, 0n);
  base.ticks.clear();
  for (const word of base.tickBitmap.keys()) base.tickBitmap.set(word, 0n);
  const p20 = getSqrtRatioAtTick(20), p40 = getSqrtRatioAtTick(40);
  const a = v3SwapToState(base, false, 4n * (p20 - Q96));
  assert.equal(a.state.sqrtPriceX96, p20);
  assert.equal(a.state.tick, 20);
  assert.equal(a.amountOut, getAmount0Delta(Q96, p20, base.liquidity, false));
  const b = v3SwapToState(a.state, false, 4n * (p40 - p20));
  assert.equal(b.state.sqrtPriceX96, p40);
  assert.equal(b.state.tick, 40);
  assert.equal(b.amountOut, getAmount0Delta(p20, p40, base.liquidity, false));
  assert.equal(b.state.liquidity, base.liquidity);
  assert.equal(base.sqrtPriceX96, Q96);
  assert.equal(base.tick, 0);
  assert.equal(a.state.tick, 20);
  assert.equal(b.state.tickBitmap, base.tickBitmap);
  assert.equal(b.state.ticks, base.ticks);
});

test("exact-boundary downward crossings and reversal restore liquidity with correct tick side", () => {
  const base = state(4n * Q96, 0n);
  const p60 = getSqrtRatioAtTick(-60), p120 = getSqrtRatioAtTick(-120);
  const a = v3SwapToState(base, true, getAmount0Delta(p60, Q96, 4n * Q96, true));
  assert.equal(a.state.sqrtPriceX96, p60);
  assert.equal(a.state.tick, -61);
  assert.equal(a.state.liquidity, 2n * Q96);
  assert.equal(a.amountOut, getAmount1Delta(p60, Q96, 4n * Q96, false));
  const b = v3SwapToState(a.state, true, getAmount0Delta(p120, p60, 2n * Q96, true));
  assert.equal(b.state.sqrtPriceX96, p120);
  assert.equal(b.state.tick, -121);
  assert.equal(b.state.liquidity, Q96);
  const reverse = v3SwapToState(b.state, false, 2n * (p60 - p120));
  assert.equal(reverse.state.sqrtPriceX96, p60);
  assert.equal(reverse.state.tick, -60);
  assert.equal(reverse.state.liquidity, 4n * Q96);
  const home = v3SwapToState(reverse.state, false, 4n * (Q96 - p60));
  assert.equal(home.state.sqrtPriceX96, Q96);
  assert.equal(home.state.tick, 0);
  assert.equal(home.state.liquidity, 4n * Q96);
  assert.equal(base.tick, 0);
  assert.equal(base.liquidity, 4n * Q96);
});

test("fee-only input does not replace a downward boundary tick with its inverse", () => {
  const base = { ...state(), sqrtPriceX96: getSqrtRatioAtTick(-60), tick: -61, fee: 999999n };
  const quote = v3SwapToState(base, true, 1n);
  assert.equal(quote.amountOut, 0n);
  assert.equal(quote.state.sqrtPriceX96, base.sqrtPriceX96);
  assert.equal(quote.state.tick, -61);
});

test("Family isolated local state quotes sequential same/reverse directions without I/O", () => {
  const exact = createUniV3Exact(), base = state(), initialInput = input(4n * 10n ** 15n);
  const advance = method(exact).isolatedLocalState!;
  assert(advance);
  const a = first(exact, initialInput, base);
  const expectedA = v3SwapToState(base, true, initialInput.amountIn);
  const sameInput = input(3n * 10n ** 15n), same = advance.quote(sameInput, a.evidence);
  const expectedSame = v3SwapToState(expectedA.state, true, sameInput.amountIn);
  assert.equal(same.amountOut, expectedSame.amountOut);
  assert.equal(same.evidence.sqrtPriceX96After, expectedSame.state.sqrtPriceX96);
  const reverseInput = input(a.amountOut, false), reverse = advance.quote(reverseInput, a.evidence);
  const expectedReverse = v3SwapToState(expectedA.state, false, reverseInput.amountIn);
  assert.equal(reverse.amountOut, expectedReverse.amountOut);
  assert.equal(reverse.evidence.sqrtPriceX96After, expectedReverse.state.sqrtPriceX96);
  assert.notEqual(reverse.amountOut, first(exact, reverseInput).amountOut,
    "a repeated pool must not quote its untouched baseline");
  assert(Object.isFrozen(reverse.evidence));
  assert.equal("state" in reverse.evidence, false, "opaque evidence never contains tick maps");
  assert.equal(advance.quote(sameInput, a.evidence).amountOut, same.amountOut,
    "branching from one prior quote cannot mutate it");
});

test("concurrent amount trials retain isolated evidence and do not leak reverse post-state", async () => {
  const exact = createUniV3Exact(), advance = method(exact).isolatedLocalState!;
  const runs = await Promise.all([1n, 8n, 1n].map(async multiplier => {
    const a = first(exact, input(multiplier * 10n ** 15n));
    await Promise.resolve();
    const b = advance.quote(input(a.amountOut, false), a.evidence);
    await Promise.resolve();
    const c = advance.quote(input(b.amountOut), b.evidence);
    return [a.amountOut, b.amountOut, c.amountOut];
  }));
  assert.deepEqual(runs[0], runs[2]);
  assert.notDeepEqual(runs[0], runs[1]);
});

test("ordinary quotes retain no trial state and permission/Quoter variants do not opt in", () => {
  const exact = createUniV3Exact(), ordinaryInput = input(10n ** 15n, true, false);
  const ordinary = first(exact, ordinaryInput), retained = first(exact, input(ordinaryInput.amountIn));
  assert.deepEqual(ordinary, retained);
  const local = method(exact);
  assert.deepEqual(local.program.buildRequests(ordinaryInput), local.program.buildRequests(input(ordinaryInput.amountIn)));
  assert.throws(() => local.isolatedLocalState!.quote(input(1n), ordinary.evidence), /not retained/);
  const quoter = method(createUniV3Exact("quoter"));
  assert.equal("chainAmountQuote" in quoter && quoter.chainAmountQuote, true);
  assert.equal(quoter.isolatedLocalState, undefined);
  for (const kind of ["is-swapper", "unsupported"] as const) {
    const gated = { ...ordinaryInput, descriptor: { ...descriptor,
      swapAccess: { ...descriptor.swapAccess, kind } } };
    assert.equal(method(exact, gated).isolatedLocalState, undefined);
    assert.throws(() => local.isolatedLocalState!.quote(gated, retained.evidence), /unsupported/);
  }
});

test("missing bitmap coverage fails closed without changing the retained predecessor", () => {
  const exact = createUniV3Exact(), advance = method(exact).isolatedLocalState!;
  const a = first(exact, input(10n ** 15n));
  const reverseInput = input(a.amountOut, false);
  const expected = advance.quote(reverseInput, a.evidence);
  const outOfRange = advance.quote(input(10n ** 40n), a.evidence);
  assert.equal(outOfRange.amountOut, 0n);
  assert.throws(() => advance.quote(input(1n), outOfRange.evidence), /not retained/);
  assert.deepEqual(advance.quote(reverseInput, a.evidence), expected);
  const missing = state();
  missing.tickBitmap.delete(-1);
  assert.throws(() => v3SwapToState(missing, true, 10n ** 15n), V3MissingBitmapWordError);
  assert.equal(missing.sqrtPriceX96, Q96);
});

test("retained state requires the original Family evidence and unchanged source/pool/caller", () => {
  const exact = createUniV3Exact(), advance = method(exact).isolatedLocalState!;
  const a = first(exact, input(10n ** 15n));
  assert.throws(() => advance.quote(input(a.amountOut, false), { ...a.evidence }), /not retained/);
  assert.throws(() => method(createUniV3Exact()).isolatedLocalState!
    .quote(input(a.amountOut, false), a.evidence), /not retained/);
  for (const source of [{ ...SOURCE, number: SOURCE.number + 1 },
    { ...SOURCE, generation: SOURCE.generation + 1 }, { ...SOURCE, hash: `0x${"ef".repeat(32)}` }]) {
    assert.throws(() => advance.quote({ ...input(a.amountOut, false), source }, a.evidence), /foreign source/);
  }
  assert.throws(() => advance.quote({ ...input(a.amountOut, false),
    executor: "0x7777777777777777777777777777777777777777" }, a.evidence), /binding changed/);
  const foreignDescriptor = { ...descriptor, pool: "0x4444444444444444444444444444444444444444" };
  const foreignRoute = { ...routes[1]!, pool: foreignDescriptor.pool };
  assert.throws(() => advance.quote({ ...input(a.amountOut, false),
    descriptor: foreignDescriptor, route: foreignRoute }, a.evidence), /binding changed/);
});

// Optional same-work CPU measurement; excludes RPC, issuer/session work and
// Solver completion. No timing threshold is a correctness assertion.
test("local V3 same-work microbenchmark", { skip: process.env.MEV_UNIV3_LOCAL_BENCH !== "1" }, t => {
  const exact = createUniV3Exact(), local = method(exact), base = state();
  const aInput = input(4n * 10n ** 15n, false), a = first(exact, aInput, base);
  const postState = v3SwapToState(base, false, aInput.amountIn).state;
  const result = (data: string) => [{ id: "local-pool-state", ok: true as const,
    source: SOURCE, completion: "returned" as const, data,
    provenance: { kind: "fixture", fingerprint: "univ3-local-bench" } }];
  const initialResults = result(encodedState(base)), postResults = result(encodedState(postState));
  const amounts = [1n, 2n, 4n, 8n].map(n => n * 10n ** 14n);
  const ordinaryInputs = amounts.map(amount => input(amount, true, false));
  const retainedInputs = amounts.map(amount => input(amount));
  const decode = (programInput: Input, results = initialResults) => local.program.decode({
    programInput, initialResults: results, dependentEvidence: [],
  });
  for (const programInput of retainedInputs) {
    assert.equal(local.isolatedLocalState!.quote(programInput, a.evidence).amountOut,
      decode(programInput, postResults).amountOut);
  }
  const count = 3000, rounds = 7;
  const samples: Record<string, number[]> = {};
  const tasks: [string, (i: number) => bigint][] = [
    ["baselineStateDecode", i => decode(ordinaryInputs[i % 4]!).amountOut],
    ["retainStateDecode", i => decode(retainedInputs[i % 4]!).amountOut],
    ["samePostStateDecode", i => decode(retainedInputs[i % 4]!, postResults).amountOut],
    ["samePostStateTransition", i => local.isolatedLocalState!.quote(retainedInputs[i % 4]!, a.evidence).amountOut],
  ];
  let checksum = 0n;
  for (const [, run] of tasks) for (let i = 0; i < 500; i++) checksum ^= run(i);
  for (let round = 0; round < rounds; round++) {
    for (const [name, run] of round % 2 === 0 ? tasks : [...tasks].reverse()) {
      const started = performance.now();
      for (let i = 0; i < count; i++) checksum ^= run(i);
      (samples[name] ??= []).push((performance.now() - started) * 1000 / count);
    }
  }
  const medianUs = Object.fromEntries(Object.entries(samples).map(([name, values]) =>
    [name, [...values].sort((a, b) => a - b)[Math.floor(rounds / 2)]!]));
  t.diagnostic(JSON.stringify({ unit: "microseconds-per-quote", count, rounds, medianUs, samples,
    checksum: checksum.toString(), scope: "synthetic-state, same amounts, no IO/issuer/Solver" }));
});

test("V3 terminal inverse before/after microbenchmark", {
  skip: process.env.MEV_UNIV3_INVERSE_BENCH !== "1",
}, async t => {
  const { execFileSync } = await import("node:child_process");
  const ts = await import("typescript");
  const baselineRef = process.env.MEV_UNIV3_BENCH_BASELINE ?? "df0a3217de60f48c286639c2bb3cfb91feb6a901";
  const baselineCommit = execFileSync("git", ["rev-parse", "--verify", `${baselineRef}^{commit}`],
    { encoding: "utf8" }).trim();
  const baselineSource = execFileSync("git", ["show", `${baselineCommit}:listener/src/searcher/solver/v3-math.ts`],
    { encoding: "utf8" });
  assert(!baselineSource.includes("export function getTickAtSqrtRatio"),
    "benchmark requires the pinned pre-inverse baseline, not an already updated HEAD");
  const compiled = ts.transpileModule(baselineSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const baseline = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`) as {
    v3SwapToState: typeof v3SwapToState;
  };
  const base = state();
  const groups = {
    short: [1n, 2n, 4n, 8n].map(n => n * 10n ** 14n),
    crossing: [4n, 5n, 6n, 8n].map(n => n * 10n ** 15n),
  };
  const count = 20_000, rounds = 9, reports: unknown[] = [];
  let checksum = 0n;
  for (const [name, amounts] of Object.entries(groups)) {
    const cases = amounts.flatMap(amount => [true, false].map(zeroForOne => ({ amount, zeroForOne })));
    for (const { amount, zeroForOne } of cases) {
      const before = baseline.v3SwapToState(base, zeroForOne, amount);
      const after = v3SwapToState(base, zeroForOne, amount);
      assert.equal(after.amountOut, before.amountOut);
      assert.equal(after.state.sqrtPriceX96, before.state.sqrtPriceX96);
      assert.equal(after.state.liquidity, before.state.liquidity);
    }
    const samples: Record<string, number[]> = { before: [], after: [] };
    const tasks = [["before", baseline.v3SwapToState], ["after", v3SwapToState]] as const;
    for (const [, run] of tasks) for (let i = 0; i < 3000; i++) {
      const item = cases[i % cases.length]!;
      checksum ^= run(base, item.zeroForOne, item.amount).amountOut;
    }
    for (let round = 0; round < rounds; round++) {
      for (const [label, run] of round % 2 === 0 ? tasks : [...tasks].reverse()) {
        const started = performance.now();
        for (let i = 0; i < count; i++) {
          const item = cases[i % cases.length]!;
          checksum ^= run(base, item.zeroForOne, item.amount).amountOut;
        }
        samples[label]!.push((performance.now() - started) * 1000 / count);
      }
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(rounds / 2)]!;
    const beforeUs = median(samples.before!), afterUs = median(samples.after!);
    reports.push({ name, beforeUs, afterUs, deltaUs: afterUs - beforeUs,
      deltaPercent: (afterUs / beforeUs - 1) * 100, samples });
  }
  t.diagnostic(JSON.stringify({ baselineCommit, unit: "microseconds-per-quote", count, rounds,
    reports, checksum: checksum.toString(), scope: "same warmed synthetic state and amounts, math only" }));
});
