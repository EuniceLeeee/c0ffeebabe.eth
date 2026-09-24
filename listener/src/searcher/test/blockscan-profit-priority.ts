import assert from "node:assert/strict";
import { test } from "node:test";
import { ADDR } from "../../shared/constants/addresses.js";
import { blockScanGrossProfitWeth } from "../blockscan-profit-priority.js";
import { runOrderedBlockScanPipeline } from "../blockscan-ordered-pipeline.js";
import type { RawTokenRate } from "../blockscan-amount-reference.js";

const weth = ADDR.WETH.toLowerCase(), usdc = ADDR.USDC.toLowerCase(), dai = "dai-fixture";
const marks = new Map<string, RawTokenRate>([
  [weth, { num: 2000n, den: 10n ** 18n }],
  [usdc, { num: 1n, den: 10n ** 6n }], [dai, { num: 1n, den: 10n ** 18n }],
]);
test("absolute gross ranking normalizes 6/18 decimals and never divides by principal", async () => {
  const plans = [
    { token: weth, profit: 100_000_000_000_000n, principal: 10_000_000_000_000_000n }, // 1%
    { token: usdc, profit: 2_000_000n, principal: 2_000_000_000n }, // 0.1%, 10x ETH gross
    { token: dai, profit: 2n * 10n ** 18n, principal: 2_000n * 10n ** 18n },
    { token: "unpriced", profit: 10n ** 60n, principal: 1n },
  ];
  const score = (p: typeof plans[number]) => blockScanGrossProfitWeth(p.token, p.profit, marks);
  assert.deepEqual(plans.map(score), [10n ** 14n, 10n ** 15n, 10n ** 15n, null]);
  const seen: number[] = [];
  await runOrderedBlockScanPipeline({ count: plans.length, workers: plans.map((_, i) => i),
    signal: new AbortController().signal, deadlineAtMs: Date.now() + 5000,
    produce: async index => plans[index]!, priority: score,
    consume: async index => { seen.push(index); },
  });
  assert.deepEqual(seen, [1, 2, 0, 3]);
});
test("ranking preserves integer precision, explicit unavailable values and WETH identity", () => {
  assert.equal(blockScanGrossProfitWeth(ADDR.WETH.toUpperCase(), 10n ** 30n + 1n, new Map()), 10n ** 30n + 1n);
  assert.equal(blockScanGrossProfitWeth(usdc, 1n, marks), 500_000_000n);
  assert.equal(blockScanGrossProfitWeth(usdc, 1n, new Map()), null);
  for (const rate of [{ num: 0n, den: 1n }, { num: 1n, den: 0n }, { num: -1n, den: 1n }])
    assert.equal(blockScanGrossProfitWeth(usdc, 1n, new Map([...marks, [usdc, rate]])), null);
});
