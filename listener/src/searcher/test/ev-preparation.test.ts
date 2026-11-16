import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { evaluateEv, prepareEvEvaluation, type EvPolicy } from "../ev-evaluator.js";
import { DEFAULT_PROFIT_TOKEN_VALUATION, type ProfitTokenValuation } from "../profit-token-valuation.js";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const source = { number: 100, hash: `0x${"ab".repeat(32)}` };
const header = { ...source, timestamp: 10_000, baseFeePerGas: 11n, gasUsed: 17_000_000n, gasLimit: 30_000_000n };
const policies: readonly EvPolicy[] = [
  { evGate: true, profitHaircutBps: 123, bribeBps: 9000, bribeAllAboveGas: false },
  { evGate: true, profitHaircutBps: 0, bribeBps: 0, bribeAllAboveGas: false },
  { evGate: true, profitHaircutBps: 0, bribeBps: 0, bribeAllAboveGas: true },
  { evGate: true, profitHaircutBps: 0, bribeBps: 9900, bribeAllAboveGas: false, profitMode: "positive-gross-profit" },
];
function oracle(answer = 2000_00000000n, updatedAt = 9990n, round = 2n) {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint80", "int256", "uint256", "uint256", "uint80"], [round, answer, updatedAt, updatedAt, round],
  );
}
function provider(encoded = oracle(), observed = header) {
  const calls: string[] = [];
  return {
    calls,
    async getBlock(tag: number | "latest") { assert.equal(tag, source.number); calls.push("header"); return observed; },
    async call(tx: { blockTag?: number }) { assert.equal(tx.blockTag, source.number); calls.push("oracle"); return encoded; },
  };
}
const scanned: ProfitTokenValuation = {
  source, canValue: () => true, valueInEth: (_token, amount) => amount * 3n / 2n,
};

for (const [name, token, valuation] of [
  ["unbound WETH", WETH, DEFAULT_PROFIT_TOKEN_VALUATION],
  ["unbound USD", USDC, DEFAULT_PROFIT_TOKEN_VALUATION],
  ["source-bound snapshot", USDC, scanned],
] as const) {
  for (const policy of policies) test(`prepared arithmetic matches legacy: ${name} ${JSON.stringify(policy)}`, async () => {
    const legacy = provider(), preparedProvider = provider();
    const expected = await evaluateEv(legacy, token, 987654321n, 123456n, policy, valuation, source.number);
    const prepared = await prepareEvEvaluation({ provider: preparedProvider, profitToken: token, profitHint: 1n,
      policy, valuation, sourceBlock: source.number, sourceBlockHash: source.hash, initialParent: header });
    let canonicalReads = 0;
    const actual = await prepared.evaluate(987654321n, 123456n, async () => { canonicalReads++; return source; });
    assert.deepEqual(actual, expected);
    assert.equal(canonicalReads, 1);
    assert.equal(preparedProvider.calls.filter(x => x === "header").length, 0);
    assert.equal(preparedProvider.calls.filter(x => x === "oracle").length, name === "unbound USD" ? 1 : 0);
  });
}

for (const [name, encoded] of [
  ["invalid encoding", "0x"], ["nonpositive answer", oracle(0n)],
  ["stale answer", oracle(2000_00000000n, 1n)], ["future answer", oracle(2000_00000000n, 10001n)],
] as const) test(`invalid prefetch stays unpriceable without retry: ${name}`, async () => {
  const p = provider(encoded);
  const prepared = await prepareEvEvaluation({ provider: p, profitToken: USDC, profitHint: 1n,
    policy: policies[0]!, valuation: DEFAULT_PROFIT_TOKEN_VALUATION,
    sourceBlock: source.number, sourceBlockHash: source.hash, initialParent: header });
  assert.equal(prepared.oraclePrefetched, true);
  const actual = await prepared.evaluate(999999n, 100n, async () => source);
  assert.equal(actual.valuationAvailable, false);
  assert.equal(actual.ethUsd, null);
  assert.deepEqual(p.calls, ["oracle"]);
});

test("a failed oracle prefetch is not retried for the actual amount", async () => {
  let calls = 0;
  const p = { ...provider(), async call() { calls++; throw new Error("unavailable"); } };
  const prepared = await prepareEvEvaluation({ provider: p, profitToken: USDC, profitHint: 1n,
    policy: policies[0]!, valuation: DEFAULT_PROFIT_TOKEN_VALUATION,
    sourceBlock: source.number, sourceBlockHash: source.hash, initialParent: header });
  const actual = await prepared.evaluate(50000n, 100n, async () => source);
  assert.equal(actual.valuationAvailable, false);
  assert.equal(calls, 1);
});

test("oracle hint never supplies actual-profit valuation and extra prefetched USD is not used", async () => {
  const valuation: ProfitTokenValuation = { canValue: () => true,
    valueInEth: (_token, amount, usd) => amount === 1n && !Number.isFinite(usd) ? null : amount * 17n };
  const p = provider();
  const prepared = await prepareEvEvaluation({ provider: p, profitToken: USDC, profitHint: 1n,
    policy: policies[1]!, valuation, sourceBlock: source.number, sourceBlockHash: source.hash, initialParent: header });
  const actual = await prepared.evaluate(99n, 1n, async () => source);
  assert.equal(actual.rawProfitEth, 99n * 17n);
  assert.equal(actual.ethUsd, null);
  assert.equal(prepared.oraclePrefetched, true);
  assert.deepEqual(p.calls, ["oracle"]);
});

test("actual amount supplements a missed oracle dependency before final canonical read", async () => {
  const order: string[] = [];
  const valuation: ProfitTokenValuation = { canValue: () => true,
    valueInEth: (_token, amount, usd) => amount === 1n ? 1n : Number.isFinite(usd) ? amount * 13n : null };
  const p = { ...provider(), async call() { order.push("oracle"); return oracle(); } };
  const prepared = await prepareEvEvaluation({ provider: p, profitToken: USDC, profitHint: 1n,
    policy: policies[1]!, valuation, sourceBlock: source.number, sourceBlockHash: source.hash, initialParent: header });
  assert.equal(prepared.oraclePrefetched, false);
  const actual = await prepared.evaluate(91n, 1n, async () => { order.push("canonical"); return source; });
  assert.deepEqual(order, ["oracle", "canonical"]);
  assert.equal(actual.rawProfitEth, 91n * 13n);
});

test("preparation snapshots policy, valuation source and header and is single-use", async () => {
  const policy = { ...policies[0]! }, initialParent = { ...header }, valuationSource = { ...source };
  const valuation = { ...scanned, source: valuationSource };
  const expected = await evaluateEv(provider(), WETH, 100_000_000n, 100n, { ...policy }, scanned, source.number);
  const pending = prepareEvEvaluation({ provider: provider(), profitToken: WETH, profitHint: 1n,
    policy, valuation, sourceBlock: source.number, sourceBlockHash: source.hash, initialParent });
  policy.profitHaircutBps = 10000; policy.bribeBps = 0;
  initialParent.baseFeePerGas = 99999n; initialParent.hash = `0x${"cd".repeat(32)}`;
  valuationSource.hash = initialParent.hash;
  const prepared = await pending;
  assert.equal(Object.isFrozen(prepared), true);
  assert.deepEqual(await prepared.evaluate(100_000_000n, 100n, async () => source), expected);
  await assert.rejects(prepared.evaluate(100_000_000n, 100n, async () => source), /already consumed/);
});

test("a hint-only valuation exception does not reject a valid actual amount", async () => {
  const valuation: ProfitTokenValuation = { canValue: () => true, valueInEth: (_token, amount) => {
    if (amount === 1n) throw new Error("hint outside this valuation's domain"); return amount;
  } };
  const prepared = await prepareEvEvaluation({ provider: provider(), profitToken: WETH, profitHint: 1n,
    policy: policies[1]!, valuation, sourceBlock: source.number, sourceBlockHash: source.hash, initialParent: header });
  assert.equal((await prepared.evaluate(77n, 1n, async () => source)).rawProfitEth, 77n);
});

test("owner-fenced fatal error propagates unchanged from preparation", async () => {
  const fatal = new Error("source integrity fault");
  await assert.rejects(prepareEvEvaluation({ provider: { ...provider(), async call() { throw fatal; } },
    profitToken: USDC, profitHint: 1n, policy: policies[0]!, valuation: DEFAULT_PROFIT_TOKEN_VALUATION,
    sourceBlock: source.number, sourceBlockHash: source.hash, initialParent: header,
    onReadError: error => { throw error; },
  }), error => error === fatal);
});

test("source-block preparation preserves a real zero base fee", async () => {
  const zeroHeader = { ...header, baseFeePerGas: 0n };
  const prepared = await prepareEvEvaluation({ provider: provider(oracle(), zeroHeader), profitToken: WETH,
    profitHint: 1n, policy: policies[0]!, valuation: DEFAULT_PROFIT_TOKEN_VALUATION,
    sourceBlock: source.number, sourceBlockHash: source.hash, initialParent: zeroHeader,
    feeEnvironment: { mode: "source-block", sourceBlockHash: source.hash },
  });
  const result = await prepared.evaluate(1000n, 1234n, async () => source);
  assert.equal(result.feeStateAvailable, true);
  assert.equal(result.maxBaseFeePerGas, 0n);
  assert.equal(result.gasCostEth, 0n);
});
