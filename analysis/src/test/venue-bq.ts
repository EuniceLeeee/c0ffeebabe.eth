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
import { classifyTxLoopCoverage } from "../discovery/loop-coverage.js";
import { deriveEdgeKindsFromLogs } from "../learning/edge-kinds.js";
import { TOPICS } from "../registry/protocols.js";
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
const HG_USDC = "0x4f95c5ba0c7c69fb2f9340e190ccee890b3bd87c";
const UNKNOWN_HELPER = "0x35d1b3f3d7966a1dfe207aa4514c12a259a0492b";
const UNKNOWN_PROTOCOL = "0x0000000000000000000000000000000000004626";
const UNKNOWN_TOPIC = `0x${"11".repeat(32)}`;

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

test("receipt-log coverage separates protocol gaps from unknown emitters and requires trace", () => {
  const logs = [
    { address: HG_USDC, topics: [TOPICS.erc4626Withdraw] },
    { address: ADDR.SKY_PSM_LITE, topics: [TOPICS.psmSellGem] },
    { address: ADDR.FLUID_DEX_USDC_USDT, topics: [TOPICS.fluidDexSwap] },
    { address: UNKNOWN_HELPER, topics: [UNKNOWN_TOPIC] },
  ];
  const result = classifyTxLoopCoverage({ txHash: "0x95805790", receiptLogs: logs });

  assert.deepEqual(deriveEdgeKindsFromLogs([logs[2]]), ["swap"]);
  assert.deepEqual(result.vaults, []);
  assert.deepEqual(result.protocolVenues, [HG_USDC, ADDR.SKY_PSM_LITE.toLowerCase()].sort());
  assert.deepEqual(result.observedSwapVenues, [
    {
      addr: ADDR.FLUID_DEX_USDC_USDT.toLowerCase(),
      family: "fluid",
      topic0s: [TOPICS.fluidDexSwap.toLowerCase()],
      productionRoutability: "unassessed",
      reason: "emitter_or_routing_graph_not_attested",
      in_graph: null,
    },
  ]);
  assert.deepEqual(result.swapRouteGaps, []);
  assert.equal(result.observedSwapEmitterCount, 1);
  assert.deepEqual(result.protocolVenueGaps, []);
  assert.deepEqual(result.unclassifiedEmitters, [{ addr: UNKNOWN_HELPER, topic0: UNKNOWN_TOPIC }]);
  assert.equal(result.protocolAdapterCandidate, true);
  assert.equal(result.receiptRouteCoverageComplete, false);
  assert.equal(result.coverageScope, "receipt_log_emitters_only");
  assert.equal(result.routabilityScope, "production_listener_descriptors_receipt_only");
  assert.equal(result.comparability, "requires_trace");
});

test("an ERC4626 event without a registered adapter is a known protocol venue gap", () => {
  const result = classifyTxLoopCoverage({
    txHash: "0xunsupported",
    receiptLogs: [
      { address: UNKNOWN_PROTOCOL, topics: [TOPICS.transfer] },
      { address: UNKNOWN_PROTOCOL, topics: [TOPICS.erc4626Deposit] },
    ],
  });

  assert.deepEqual(result.protocolVenueGaps, [
    { addr: UNKNOWN_PROTOCOL, topic0: TOPICS.erc4626Deposit.toLowerCase() },
  ]);
  assert.deepEqual(result.unclassifiedEmitters, []);
  assert.equal(result.protocolAdapterCandidate, false);
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
