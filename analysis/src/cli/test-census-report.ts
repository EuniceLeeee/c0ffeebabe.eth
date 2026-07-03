import assert from "node:assert/strict";
import { buildCensusReport, type CensusPerTx } from "./census-report.js";
import type { TouchedVenue } from "./bundle-postmortem.js";

const watch = ["0x1111111111111111111111111111111111111111"];
const window = { from: 100, to: 102 };
const perTx: CensusPerTx[] = [
  {
    hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    from: watch[0],
    realizedUsd: 2,
    touchedVenues: [
      venue("univ3", "0x3333333333333333333333333333333333333333", false),
      venue("univ2", "0x2222222222222222222222222222222222222222", true),
    ],
  },
  {
    hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    from: watch[0],
    realizedUsd: 0.5,
    touchedVenues: [
      venue("univ4", "0x4444444444444444444444444444444444444444444444444444444444444444", false),
    ],
  },
  {
    hash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    from: watch[0],
    realizedUsd: 5,
    touchedVenues: [
      venue("univ2", "0x5555555555555555555555555555555555555555", true),
    ],
  },
];

const report = buildCensusReport(perTx, 1, window, watch);
const checks: Array<() => void> = [
  () => assert.equal(report.verdict.route_gap_decisive, true),
  () => assert.deepEqual(report.analyzed_competitors.map((tx) => tx.hash), [perTx[0].hash]),
  () => assert.equal(report.analyzed_competitors[0]?.realized_profit_usd, 2),
  () => assert.equal(report.summary.matched_txs, 3),
  () => assert.equal(report.summary.qualifying_txs, 1),
  () => assert.equal(report.summary.skipped_below_profit, 1),
  () => assert.deepEqual(report.summary.distinct_out_of_graph, { univ2: 0, univ3: 1, univ4: 0 }),
  () => assert.equal(report.summary.net_realized_usd, 2),
];

try {
  for (const check of checks) check();
  console.log(`census-report PASS (${checks.length}/${checks.length})`);
  console.log("verdict: fixed");
} catch (err) {
  console.error(`census-report FAIL: ${(err as Error).message}`);
  process.exit(1);
}

function venue(protocol: TouchedVenue["protocol"], id: string, inGraph: boolean): TouchedVenue {
  return {
    protocol,
    id,
    emitter: protocol === "univ4" ? "0x0000000000000000000000000000000000000000" : id,
    in_graph: inGraph,
  };
}
