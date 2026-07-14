import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildCensusReport,
  fetchSameBlockSwapLogs,
  type CensusPerTx,
} from "../cli/census-report.js";
import type { WinnerStyle } from "../cli/bundle-postmortem.js";
import type { RawLog } from "../pnl/tx-shape.js";
import { lower, TOPICS } from "../registry/protocols.js";

interface CoffeeFixture {
  label: string;
  txHash: string;
  block: number;
  txIndex: number;
  tx: {
    from: string;
    to: string;
  };
  receiptLogs: RawLog[];
  sameBlockSwapLogs: RawLog[];
}

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "coffee-20260704",
);
const CURVE_POOL = "0x7777777777777777777777777777777777777777";
const EXPECTED_SWAP_TOPICS = [
  TOPICS.univ2Swap,
  TOPICS.univ3Swap,
  TOPICS.univ4Swap,
  TOPICS.curveTokenExchange,
  TOPICS.curveCryptoTokenExchange,
  TOPICS.curveTokenExchangeUnderlying,
  TOPICS.balancerV2Swap,
].map(lower);

test("census production log fetch feeds the pinned 8 atomic / 1 backrun split", async () => {
  const fixtures = loadCoffeeFixtures();
  const perTx: CensusPerTx[] = [];

  for (const fixture of fixtures) {
    let requestedFilter: Record<string, unknown> | undefined;
    const rpcLogs = fixture.sameBlockSwapLogs.map((log) => ({
      ...log,
      logIndex: toQuantity(log.logIndex),
      transactionIndex: toQuantity(log.transactionIndex),
      txTo: undefined,
    }));
    const transactions = fixture.sameBlockSwapLogs.map((log) => ({
      hash: log.transactionHash,
      to: log.txTo,
    }));
    const sameBlockSwapLogs = await fetchSameBlockSwapLogs({
      async getLogs(filter) {
        requestedFilter = filter;
        return rpcLogs;
      },
    }, fixture.block, transactions);

    assert.deepEqual(requestedFilter, {
      fromBlock: toQuantity(fixture.block),
      toBlock: toQuantity(fixture.block),
      topics: [EXPECTED_SWAP_TOPICS],
    }, `tx #${fixture.label} requests the supported same-block swap topics`);

    perTx.push({
      hash: fixture.txHash,
      from: fixture.tx.from,
      realizedUsd: 1,
      touchedVenues: [{
        protocol: "curve",
        id: CURVE_POOL,
        emitter: CURVE_POOL,
        in_graph: false,
      }],
      txIndex: fixture.txIndex,
      receiptLogs: fixture.receiptLogs,
      sameBlockSwapLogs,
      winner_style: "atomic_loop" satisfies WinnerStyle,
    });
  }

  const report = buildCensusReport(perTx, 0.1, { from: fixtures[0]!.block, to: fixtures.at(-1)!.block }, [
    fixtures[0]!.tx.from,
  ]);
  const shapes = countBy(report.analyzed_competitors.map((competitor) => competitor.tx_shape));

  assert.deepEqual(shapes, {
    atomic_state_arb: 8,
    backrun: 1,
    unknown: 0,
  });
  assert.equal(report.verdict.route_gap_decisive, true);
  assert.equal(report.summary.qualifying_txs, 9);
  assert.deepEqual(report.summary.distinct_out_of_graph, {
    univ2: 0,
    univ3: 0,
    univ4: 0,
    other: 1,
  });
  assert.ok(
    report.analyzed_competitors.every((competitor) =>
      competitor.touchedVenues.some((venue) => venue.protocol === "curve" && venue.in_graph === false)
    ),
    "non-Uni out-of-graph venues remain visible in the existing touchedVenues contract",
  );
  assert.ok(
    report.matched_competitors.every((competitor) => competitor.all_venues_in_graph === false),
    "non-Uni graph gaps affect the unfiltered matched-tx summary",
  );
});

function loadCoffeeFixtures(): CoffeeFixture[] {
  const index = JSON.parse(readFileSync(join(FIXTURES_DIR, "index.json"), "utf8")) as Array<{
    label: string;
  }>;
  return index.map(({ label }) =>
    JSON.parse(readFileSync(join(FIXTURES_DIR, `tx-${label}.json`), "utf8")) as CoffeeFixture
  );
}

function countBy(shapes: Array<"atomic_state_arb" | "backrun" | "unknown">): Record<string, number> {
  const counts = {
    atomic_state_arb: 0,
    backrun: 0,
    unknown: 0,
  };
  for (const shape of shapes) counts[shape]++;
  return counts;
}

function toQuantity(value: number): string {
  return `0x${value.toString(16)}`;
}
