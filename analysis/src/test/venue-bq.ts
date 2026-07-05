import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { rowsToVenueInputs, type BqLogRow } from "../discovery/bq-rows.js";
import {
  aggregateVenueCandidates,
  mergeAggregates,
  type AggregatedVenue,
} from "../discovery/venue-aggregate.js";
import { extractVenueCandidates } from "../discovery/venue-evidence.js";
import { ADDR } from "../../../listener/src/shared/constants/addresses.js";

interface CoffeeFixture {
  txHash: string;
  block: number;
  txIndex: number;
  tx: { from: string; to: string };
  receiptLogs: CoffeeLog[];
}

interface CoffeeLog {
  address?: string;
  topics?: unknown;
  logIndex?: number;
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const COFFEE_DIR = join(TEST_DIR, "fixtures", "coffee-20260704");
const LIQUITY_VENUE = "0xa2895d6a3bf110561dfe4b71ca539d84e1928b22";
const COFFEE_BOT = "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671";

test("BigQuery NDJSON rows surface the Liquity protocol venue and exclude known emitters", () => {
  const tx2 = loadCoffeeFixture("2");
  const rows = parseNdjson(ndjsonFromFixture(tx2));
  const inputs = rowsToVenueInputs(rows);

  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].txHash, tx2.txHash);
  assert.equal(inputs[0].from, tx2.tx.from);
  assert.equal(inputs[0].to, tx2.tx.to);

  const aggregated = aggregateRows(rows);
  const byAddress = new Map(aggregated.map((candidate) => [candidate.address, candidate]));
  const liquity = byAddress.get(LIQUITY_VENUE);

  assert.ok(liquity, "Liquity venue is an aggregate candidate");
  assert.ok(liquity.edgeKinds.includes("protocol"), "Liquity candidate carries protocol evidence");

  for (const excluded of [
    ADDR.WETH,
    ADDR.UNISWAP_V4_POOL_MANAGER,
    COFFEE_BOT,
  ]) {
    assert.equal(byAddress.has(excluded.toLowerCase()), false, `${excluded} is excluded`);
  }
});

test("BigQuery aggregate halves merge to the same result as the whole export", () => {
  const tx2Rows = rowsFromFixture(loadCoffeeFixture("2"));
  const tx3Rows = rowsFromFixture(loadCoffeeFixture("3"));
  const whole = aggregateRows([...tx2Rows, ...tx3Rows]);
  const merged = mergeAggregates(aggregateRows(tx2Rows), aggregateRows(tx3Rows));

  assert.deepEqual(merged, whole);
});

function aggregateRows(rows: BqLogRow[]): AggregatedVenue[] {
  return aggregateVenueCandidates(rowsToVenueInputs(rows).map((input) => extractVenueCandidates(input)));
}

function ndjsonFromFixture(fixture: CoffeeFixture): string {
  return `${rowsFromFixture(fixture).reverse().map((row) => JSON.stringify(row)).join("\n")}\n\n`;
}

function rowsFromFixture(fixture: CoffeeFixture): BqLogRow[] {
  return fixture.receiptLogs.map((log) => ({
    tx_hash: fixture.txHash,
    block_number: fixture.block,
    transaction_index: fixture.txIndex,
    from_address: fixture.tx.from,
    executor: fixture.tx.to,
    log_index: log.logIndex,
    log_address: log.address,
    topics: log.topics,
    receipt_status: 1,
  }));
}

function parseNdjson(content: string): BqLogRow[] {
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as BqLogRow);
}

function loadCoffeeFixture(label: string): CoffeeFixture {
  return JSON.parse(readFileSync(join(COFFEE_DIR, `tx-${label}.json`), "utf8")) as CoffeeFixture;
}
