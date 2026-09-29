import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { XWIN_LOCAL_ABI, decodeXwinLocal, quoteXwinLocal } from "../xwin-local.js";
import { decodeXwinSurface } from "../xwin.js";

// Fresh hash-pinned state reads + archived same-environment execution outputs.
// Not a new final EVM execution or a natural production replay.
// tool-reconciled: listener:searcher:at-block n/a this is a narrow cached Family
// amount/parity regression, not an alternative production enumeration pipeline.
function fixture() {
  const root = process.env.XWIN_LOCAL_STATE_EVIDENCE, baseline = process.env.TOKEN_CONVERSION_BASELINE;
  assert(root && baseline, "XWIN_LOCAL_STATE_EVIDENCE and TOKEN_CONVERSION_BASELINE are required");
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"), (_, v) => v?.$type === "bigint" ? BigInt(v.value) : v);
  const saved = read(resolve(root, "xwin-local-program-state.json"));
  const surface = decodeXwinSurface(saved.results, "exact-xwin", saved.surface.target);
  const prices = read(resolve(baseline, "xwin-production-environment/production/prices.json")).runtime;
  const sim = read(resolve(baseline, "xwin-production-environment/production/simulation-2.json"));
  assert.equal(surface.source.number, 26029584);
  assert.equal(surface.source.hash, sim.executionInput.sourceHeader.parentHash);
  assert.equal(sim.executionInput.sourceHeader.gasUsed, "0");
  assert.equal(prices.sourceBlock, surface.source.number + 1);
  assert.equal(prices.sourceBlockHash, sim.executionInput.source.hash);
  assert.equal(saved.executor.toLowerCase(), sim.executionInput.executor);
  const state = decodeXwinLocal("exact-xwin", surface, saved.executor, saved.results);
  // The supported source templates have no timestamp/baseFee/coinbase-dependent
  // swaps/oracles. Empty N changes fund fee accrual's block.number, not holdings.
  return { saved, surface, sim, prices, state: { ...state, blockNumber: BigInt(prices.sourceBlock) } };
}

test("xWin local production amount model matches both archived effective P outputs and sequential final cash", () => {
  const { saved, surface, sim, prices, state } = fixture();
  const rows = prices.pricing.effectiveMids.rows.entries.filter(([, r]: [string, any]) => r.instanceKey.toLowerCase() === surface.target.toLowerCase());
  assert.equal(rows.length, 2);
  const comparisons = rows.map(([, row]: [string, any]) => {
    assert.equal(row.status, "quoted");
    const direction = row.tokenIn.toLowerCase() === state.baseToken ? "mint" : "redeem";
    const output = quoteXwinLocal(state, direction, row.amountIn);
    assert.equal(output, row.amountOut);
    return { direction, amountIn: String(row.amountIn), amountOut: String(output), delta: "0" };
  });
  const amount = BigInt(sim.executionInput.funding.amount);
  const shares = quoteXwinLocal(state, "mint", amount);
  const out = quoteXwinLocal(state, "redeem", shares, [{ direction: "mint", amountIn: amount, amountOut: shares }]);
  assert.equal(amount, 5538803n); assert.equal(shares, 6618975557313964400n);
  assert.equal(out, 6966038n); assert.equal(out - amount, 1427235n);
  console.log(JSON.stringify({ kind: "xwin-local-cached-execution-parity", stateBlock: surface.source.number,
    executionBlock: Number(state.blockNumber), comparisons, selectedAmount: String(amount), shares: String(shares),
    returnAmount: String(out), cashProfit: String(out - amount), newFinalSim: false, pinnedReadCount: saved.results.length }));
});

test("xWin local read decoder rejects changed dependencies, paused/blacklisted tokens, foreign source and invalid prefixes", () => {
  const { saved, surface, state } = fixture();
  const changed = (id: string, encoded: string) => saved.results.map((r: any) => r.id === id ? { ...r, data: encoded } : r);
  const decode = (r: any[]) => decodeXwinLocal("exact-xwin", surface, saved.executor, r);
  assert.throws(() => decode(changed("exact-xwin-token-paused-0", XWIN_LOCAL_ABI.encodeFunctionResult("paused", [true]))), /paused/);
  assert.throws(() => decode(changed("exact-xwin-blacklist-0-0", XWIN_LOCAL_ABI.encodeFunctionResult("isBlacklisted", [true]))), /blocked/);
  assert.throws(() => decode(changed("exact-xwin-token-implementation-code-0", "0x6000")), /implementation/);
  assert.throws(() => decode(changed("exact-xwin-router-code-0", "0x6000")), /router/);
  assert.throws(() => decode(changed("exact-xwin-aggregator-code-0", "0x6000")), /aggregator/);
  assert.throws(() => decode(saved.results.map((r: any, j: number) => j === 0 ? { ...r, source: { ...r.source, number: r.source.number + 1 } } : r)), /source/);
  assert.throws(() => quoteXwinLocal(state, "redeem", 1n, [{ direction: "mint", amountIn: 1000000n, amountOut: 1n }]), /prefix output/);
});
