import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { aggregateVenueCandidates, type AggregatedVenue } from "../discovery/venue-aggregate.js";
import { extractVenueCandidates, type VenueScanInput } from "../discovery/venue-evidence.js";
import { ADDR } from "../../../listener/src/shared/constants/addresses.js";

interface CoffeeFixture {
  txHash: string;
  tx: { from: string; to: string };
  receiptLogs: VenueScanInput["receiptLogs"];
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const COFFEE_DIR = join(TEST_DIR, "fixtures", "coffee-20260704");
const LIQUITY_VENUE = "0xa2895d6a3bf110561dfe4b71ca539d84e1928b22";
const COFFEE_BOT = "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671";

test("coffee fixtures aggregate B2 venue evidence deterministically", () => {
  const perTx = Array.from({ length: 9 }, (_item, index) => {
    const fixture = loadCoffeeFixture(String(index + 1));
    return extractVenueCandidates(inputFromFixture(fixture));
  });

  const aggregated = aggregateVenueCandidates(perTx);
  const byAddress = new Map(aggregated.map((candidate) => [candidate.address, candidate]));

  const liquity = byAddress.get(LIQUITY_VENUE);
  assert.ok(liquity, "Liquity venue is an aggregate candidate");
  assert.ok(liquity.edgeKinds.includes("protocol"), "Liquity candidate carries protocol evidence");
  assert.ok(liquity.txCount >= 1, "Liquity venue was touched by at least one watched tx");

  assertSorted(aggregated);

  for (const excluded of [
    ADDR.WETH,
    ADDR.UNISWAP_V4_POOL_MANAGER,
    COFFEE_BOT,
  ]) {
    assert.equal(byAddress.has(excluded.toLowerCase()), false, `${excluded} is excluded`);
  }

  assert.deepEqual(aggregateVenueCandidates(perTx), aggregated, "aggregation is deterministic");
});

function assertSorted(items: AggregatedVenue[]): void {
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const curr = items[i];
    const cmp = (prev.txCount - curr.txCount)
      || (prev.totalLogCount - curr.totalLogCount)
      || curr.address.localeCompare(prev.address);
    assert.ok(cmp >= 0, `aggregate results are sorted at index ${i}`);
  }
}

function inputFromFixture(fixture: CoffeeFixture): VenueScanInput {
  return {
    txHash: fixture.txHash,
    from: fixture.tx.from,
    to: fixture.tx.to,
    receiptLogs: fixture.receiptLogs,
  };
}

function loadCoffeeFixture(label: string): CoffeeFixture {
  return JSON.parse(readFileSync(join(COFFEE_DIR, `tx-${label}.json`), "utf8")) as CoffeeFixture;
}
