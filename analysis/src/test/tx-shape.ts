import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decodeAnySwapLog } from "../pnl/swap-log-registry.js";
import {
  classifyTxShape,
  type RawLog,
  type TxShapeResult,
} from "../pnl/tx-shape.js";

const V4_POOL_MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90";

interface CoffeeFixture {
  label: string;
  txHash: string;
  block: number;
  txIndex: number;
  tx: unknown;
  arbPools: string[];
  receiptLogs: RawLog[];
  sameBlockSwapLogs: RawLog[];
}

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "coffee-20260704",
);

test("coffee tx-shape fixture gate classifies 8 atomic-state arbs and 1 backrun", () => {
  const fixtures = loadCoffeeFixtures();
  const byLabel = new Map<string, TxShapeResult>();
  const counts = {
    atomic_state_arb: 0,
    backrun: 0,
    unknown: 0,
  };

  for (const fixture of fixtures) {
    const result = classifyTxShape({
      receiptLogs: fixture.receiptLogs,
      txIndex: fixture.txIndex,
      sameBlockSwapLogs: fixture.sameBlockSwapLogs,
    });

    byLabel.set(fixture.label, result);
    counts[result.shape] += 1;
    assert.deepEqual(result.arb_pools, fixture.arbPools, `tx #${fixture.label} arb_pools`);
    if (result.shape === "atomic_state_arb") {
      assert.equal(result.source_swap_hash, undefined, `tx #${fixture.label} atomic has no source hash`);
      assert.equal(result.source_router, null, `tx #${fixture.label} atomic has null source router`);
    }
  }

  console.log(
    `tx-shape split: atomic_state_arb=${counts.atomic_state_arb} backrun=${counts.backrun} unknown=${counts.unknown}`,
  );

  assert.deepEqual(counts, {
    atomic_state_arb: 8,
    backrun: 1,
    unknown: 0,
  });

  const tx9 = byLabel.get("9");
  assert.ok(tx9, "tx #9 classified");
  assert.equal(tx9.shape, "backrun");
  assert.equal(
    tx9.source_swap_hash,
    "0x8e0c59b404087fe5c9be7b68d1ffc80a34703d5222e41f4cf6b2c906cfae3881",
  );
  assert.equal(tx9.source_router, "0x663dc15d3c1ac63ff12e45ab68fea3f0a883c251");

  // Strict-boundary lock: #2 and #3's sameBlockSwapLogs are the arb tx's OWN
  // same-index logs on the SAME poolIds — a `<=` boundary (counting a swap at
  // the same transactionIndex as "preceding") would flip them to backrun.
  // The v4 poolId-vs-log.address identity is locked by the per-tx arb_pools
  // pin above and the dedicated v4-identity test below (with these
  // pre-filtered fixtures, address-keying corrupts arb_pools, not shape).
  assert.equal(byLabel.get("2")?.shape, "atomic_state_arb", "tx #2 v4 strict-boundary gate");
  assert.equal(byLabel.get("3")?.shape, "atomic_state_arb", "tx #3 v4 strict-boundary gate");
});

test("v4 arb-pool identity comes from the registry poolId, not the singleton log.address", () => {
  const fixtures = loadCoffeeFixtures().filter((f) => f.label === "2" || f.label === "3");
  assert.equal(fixtures.length, 2, "fixtures #2 and #3 present");

  for (const fixture of fixtures) {
    const result = classifyTxShape({
      receiptLogs: fixture.receiptLogs,
      txIndex: fixture.txIndex,
      sameBlockSwapLogs: fixture.sameBlockSwapLogs,
    });

    // The pinned pools carry bytes32 v4 poolIds and never the shared singleton.
    assert.ok(
      result.arb_pools.some((p) => p.length === 66),
      `tx #${fixture.label} arb_pools include a bytes32 v4 poolId`,
    );
    assert.ok(
      !result.arb_pools.includes(V4_POOL_MANAGER),
      `tx #${fixture.label} arb_pools exclude the PoolManager singleton address`,
    );

    // Negative check (documents the v4 trap): keying pool identity on
    // log.address instead of decodeAnySwapLog(...).poolId would emit the
    // shared PoolManager singleton, collapsing distinct v4 pools into one id.
    const addressKeyedPools = [...new Set(
      fixture.receiptLogs
        .filter((log) => decodeAnySwapLog(log) !== null)
        .map((log) => log.address.toLowerCase()),
    )];
    assert.ok(
      addressKeyedPools.includes(V4_POOL_MANAGER),
      `tx #${fixture.label} receipt swap logs live on the singleton — the trap is exercised`,
    );
    assert.notDeepEqual(
      addressKeyedPools,
      result.arb_pools,
      `tx #${fixture.label} address-keyed pools must differ from poolId-keyed arb_pools`,
    );
  }
});

function loadCoffeeFixtures(): CoffeeFixture[] {
  const index = JSON.parse(readFileSync(join(FIXTURES_DIR, "index.json"), "utf8")) as Array<{
    label: string;
  }>;
  return index.map((entry) => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURES_DIR, `tx-${entry.label}.json`), "utf8"),
    ) as CoffeeFixture;
    return fixture;
  });
}
