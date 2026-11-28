import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  replayRealTxDiscovery,
  replayRealTxExecution,
  loadCompiledSelectorFamily,
  verifySelectorRealTxFixture,
  type RealTxSelectorFixture,
} from "./selector-real-tx-replay-testkit.js";

const FIXTURE_TAGS = ["5b41b908", "65b2489b", "767691e7", "e2ad025a"] as const;

function loadFixture(tag: string): RealTxSelectorFixture {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/real-tx/selector-${tag}.real-tx.json`, import.meta.url), "utf8"),
  ) as RealTxSelectorFixture;
}

for (const tag of FIXTURE_TAGS) {
  test(`real-tx replay 0x${tag}: discovers >=1 edge per valid call frame and executes BotVM against recorded on-chain reads`, async () => {
    const fixture = loadFixture(tag);
    const summary = await verifySelectorRealTxFixture(fixture);
    assert(summary.transactionsVerified >= 1);
    assert(summary.edgesVerified >= summary.transactionsVerified);
  });
}

test("real-tx replay gate rejects immediately when discovered edge count < selector-appearing tx count", async () => {
  const fixture = loadFixture("5b41b908");
  const singleSwapTx = fixture.transactions[0]!;
  const { rule, discoverFn } = await loadCompiledSelectorFamily("0x5b41b908");
  assert(discoverFn);

  // Simulate the historical bug where StableSwap int128 TokenExchange topic0 was used instead of Crypto NG topic0,
  // causing a tx where 0x5b41b908 appeared to yield 0 edges (< 1 tx).
  const ngTopic = "0x143f1f8e861fbdeddd5b46e844b7d3ac7b86a122f36e8c463859ee6811b1f29c";
  const brokenSample = {
    ...singleSwapTx,
    logs: singleSwapTx.logs.filter(l => l.topics[0] !== ngTopic),
  };

  await assert.rejects(
    () => replayRealTxDiscovery({ selector: "0x5b41b908", rule, discoverFn, sample: brokenSample }),
    /discovered 0 edge\(s\) < 1 for a tx where selector appeared/,
  );
});

test("real-tx replay gate rejects immediately on unrecorded or reverting on-chain getters (no fake ABI callbacks)", async () => {
  const fixture = loadFixture("65b2489b");
  const sample = fixture.transactions[0]!;
  const { definition, rule, discoverFn } = await loadCompiledSelectorFamily("0x65b2489b");
  const { callFrames, edges } = await replayRealTxDiscovery({ selector: "0x65b2489b", rule, discoverFn, sample });

  // Drop recorded static calls to prove no fallback/handwritten mock can rescue missing on-chain getters.
  await assert.rejects(
    () =>
      replayRealTxExecution({
        definition,
        recordedStaticCalls: {},
        sample,
        edge: edges[0]!,
        callFrame: callFrames[0]!,
      }),
    /Unrecorded on-chain static call/,
  );
});

test("real-tx replay gate rejects immediately when BotVM swap routing arguments diverge from real mainnet calldata", async () => {
  const fixture = loadFixture("65b2489b");
  const sample = fixture.transactions[0]!;
  const { definition, rule, discoverFn } = await loadCompiledSelectorFamily("0x65b2489b");
  const { callFrames, edges } = await replayRealTxDiscovery({ selector: "0x65b2489b", rule, discoverFn, sample });

  // Corrupt the historical callFrame bought_id word (arg[1]) from 2 -> 1 to simulate a 2-coin-only index bug.
  const origInput = callFrames[0]!.input;
  const corruptedInput =
    origInput.slice(0, 10 + 64) +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    origInput.slice(10 + 128);

  await assert.rejects(
    () =>
      replayRealTxExecution({
        definition,
        recordedStaticCalls: fixture.recordedStaticCalls,
        sample,
        edge: edges[0]!,
        callFrame: { ...callFrames[0]!, input: corruptedInput },
      }),
    /arg\[1\] \(uint256\): BotVM encoded 2 != real mainnet 1/,
  );
});
