import assert from "node:assert/strict";
import { buildCensusReport, type CensusPerTx } from "./census-report.js";
import { classifyWinnerStyle, type TouchedVenue } from "./bundle-postmortem.js";
import { ADDR, lower } from "../registry/protocols.js";
import type { TokenDelta } from "../types.js";

const watch = ["0x1111111111111111111111111111111111111111"];
const window = { from: 100, to: 102 };
const CFG = "0xcccccccccccccccccccccccccccccccccccccccc";
const atomicStyle = classifyWinnerStyle({
  pricedDeltas: [delta(ADDR.WETH, 399744634603446n, "WETH", 18)],
  unpricedDeltas: [],
  unpricedInTokensWithoutCounterTransfer: [],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
});
const oneLegStyle = classifyWinnerStyle({
  pricedDeltas: [delta(ADDR.WETH, -305410000000000000n, "WETH", 18)],
  unpricedDeltas: [delta(CFG, 2640100000000000000000n, "CFG", 18)],
  unpricedInTokensWithoutCounterTransfer: [lower(CFG)],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
});
const atomicMissingPool = "0x3333333333333333333333333333333333333333";
const oneLegMissingPool = "0x4444444444444444444444444444444444444444444444444444444444444444";
const perTx: CensusPerTx[] = [
  {
    hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    from: watch[0],
    realizedUsd: 2,
    touchedVenues: [
      venue("univ3", atomicMissingPool, false),
      venue("univ2", "0x2222222222222222222222222222222222222222", true),
    ],
    winner_style: atomicStyle,
  },
  {
    hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    from: watch[0],
    realizedUsd: 3,
    touchedVenues: [
      venue("univ4", oneLegMissingPool, false),
    ],
    winner_style: oneLegStyle,
    winner_moved_price_beyond_prestate: true,
    unpriced_token_in_flow: [lower(CFG)],
  },
  {
    hash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    from: watch[0],
    realizedUsd: 5,
    touchedVenues: [
      venue("univ2", "0x5555555555555555555555555555555555555555", true),
    ],
    winner_style: atomicStyle,
  },
  {
    hash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    from: watch[0],
    realizedUsd: 0.5,
    touchedVenues: [
      venue("univ4", "0x6666666666666666666666666666666666666666666666666666666666666666", false),
    ],
    winner_style: atomicStyle,
  },
];

const report = buildCensusReport(perTx, 1, window, watch);
const atomic = report.analyzed_competitors.find((tx) => tx.hash === perTx[0].hash);
const oneLeg = report.analyzed_competitors.find((tx) => tx.hash === perTx[1].hash);
const coverageIds = report.analyzed_competitors.flatMap((tx) =>
  tx.touchedVenues.filter((venue) => venue.in_graph === false).map((venue) => venue.id),
);
const checks: Array<() => void> = [
  () => assert.equal(atomicStyle, "atomic_loop"),
  () => assert.equal(oneLegStyle, "one_leg_inventory"),
  () => assert.equal(report.verdict.route_gap_decisive, true),
  () => assert.deepEqual(report.analyzed_competitors.map((tx) => tx.hash), [perTx[0].hash, perTx[1].hash]),
  () => assert.equal(atomic?.winner_style, "atomic_loop"),
  () => assert.equal(oneLeg?.winner_style, "one_leg_inventory"),
  () => assert.equal(oneLeg?.non_comparable_winner, true),
  () => assert.deepEqual(coverageIds, [atomicMissingPool]),
  () => assert.equal(report.analyzed_competitors[0]?.realized_profit_usd, 2),
  () => assert.equal(report.summary.matched_txs, 4),
  () => assert.equal(report.summary.qualifying_txs, 1),
  () => assert.equal(report.summary.skipped_below_profit, 1),
  () => assert.deepEqual(report.summary.distinct_out_of_graph, { univ2: 0, univ3: 1, univ4: 0 }),
  () => assert.equal(report.summary.net_realized_usd, 2),
];

try {
  for (const check of checks) check();
  console.log(`census-report PASS (${checks.length}/${checks.length})`);
  console.log("expected_transition: census missed-opp analysis now filters non-comparable competitors (winner_style), matching the lost-bundle branch. verdict: fixed");
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

function delta(token: string, raw: bigint, symbol: string, decimals: number): TokenDelta {
  return {
    token: lower(token),
    symbol,
    decimals,
    raw,
  };
}
