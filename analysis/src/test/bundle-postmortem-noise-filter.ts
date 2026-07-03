import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVerdict,
  classifyWinnerStyle,
  loadGraphMembership,
  realizedProfitUsdForReport,
  winnerMovedPriceBeyondPrestate,
  type WinnerStyle,
} from "../cli/bundle-postmortem.js";
import { ADDR, lower } from "../registry/protocols.js";
import type { TokenDelta } from "../types.js";

const CFG = "0xcccccccccccccccccccccccccccccccccccccccc";
const reach = {
  status: "sent_directly" as const,
  builder: "test-builder",
  miner: "0x0000000000000000000000000000000000000000",
  builders_sent: ["test-builder"],
  note: "test fixture",
};

const oneLegStyle = classifyWinnerStyle({
  pricedDeltas: [delta(ADDR.WETH, -305410000000000000n, "WETH", 18)],
  unpricedDeltas: [delta(CFG, 2640100000000000000000n, "CFG", 18)],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [lower(CFG)],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
});

const tickForcedStyle = classifyWinnerStyle({
  pricedDeltas: [],
  unpricedDeltas: [],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [],
  winner_moved_price_beyond_prestate: true,
  sandwich_detected: false,
});

const sandwichVerdict = buildVerdict(
  event("100", "50"),
  [competitor("sandwich", "200")],
  reach,
);

const oneLegVerdict = buildVerdict(
  event("100", "50"),
  [competitor(oneLegStyle, "200")],
  reach,
);

const atomicStyle = classifyWinnerStyle({
  pricedDeltas: [delta(ADDR.WETH, 399744634603446n, "WETH", 18)],
  unpricedDeltas: [],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
});

const atomicVerdict = buildVerdict(
  event("100", "50"),
  [competitor(atomicStyle, "200")],
  reach,
);

// Graph-membership v4 fixture: runtime-graph-pools.json stores v4 by PoolManager ADDRESS only
// (no poolId), so in_graph for v4 must come from the sibling active-pools.json poolId set — else
// EVERY v4 pool (incl. ones we index) is a false-negative not-in-graph. This asserts the union.
const V3_ADDR_IN_GRAPH = "0x08a10a8b713c03e2fecaa3e355cea18a459ffcbf";
const V4_POOLID_IN_ACTIVE = "0x267d01a3b23fe2340482242db5396f7544d36f398862efa591e92a079348cd9c";
const V4_POOLID_NOT_INDEXED = "0xaa9a1adf0000000000000000000000000000000000000000000000000000dead";
const graphFixtureDir = mkdtempSync(join(tmpdir(), "bundle-postmortem-graph-"));
writeFileSync(
  join(graphFixtureDir, "runtime-graph-pools.json"),
  JSON.stringify({ pools: [{ address: V3_ADDR_IN_GRAPH, adapter: "univ3" }] }) + "\n",
);
writeFileSync(
  join(graphFixtureDir, "active-pools.json"),
  JSON.stringify({ pools: [{ adapter: "univ4", poolId: V4_POOLID_IN_ACTIVE }] }) + "\n",
);
const graphMembership = loadGraphMembership(join(graphFixtureDir, "runtime-graph-pools.json"));

const checks: Array<() => void> = [
  () => assert.equal(graphMembership.status, "loaded"),
  // the fix: a v4 poolId present in active-pools is now in_graph (was a systematic false-negative)
  () => assert.equal(graphMembership.members.has(lower(V4_POOLID_IN_ACTIVE)), true),
  // a v4 poolId we do NOT index stays out of graph (real coverage gap preserved)
  () => assert.equal(graphMembership.members.has(lower(V4_POOLID_NOT_INDEXED)), false),
  // v2/v3 in_graph stays authoritative against runtime-graph
  () => assert.equal(graphMembership.members.has(lower(V3_ADDR_IN_GRAPH)), true),
  () => assert.equal(oneLegStyle, "one_leg_inventory"),
  () => assert.equal(tickForcedStyle, "one_leg_inventory"),
  () => assert.equal(oneLegVerdict.winner_style, "one_leg_inventory"),
  () => assert.equal(oneLegVerdict.route_gap_decisive, false),
  () => assert.equal(oneLegVerdict.non_comparable_winner, true),
  () => assert.match(oneLegVerdict.note ?? "", /one_leg_inventory\/CEX-DEX/),
  () => assert.equal(sandwichVerdict.route_gap_decisive, false),
  () => assert.equal(sandwichVerdict.non_comparable_winner, true),
  () => assert.equal(atomicStyle, "atomic_loop"),
  () => assert.equal(atomicVerdict.winner_style, "atomic_loop"),
  () => assert.equal(atomicVerdict.route_gap_decisive, true),
  () => assert.equal(atomicVerdict.non_comparable_winner, undefined),
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [],
    unpricedDeltas: [],
    nativeWeiPositive: true,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "atomic_loop"),
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [],
    unpricedDeltas: [],
    nativeWeiPositive: false,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "unknown"),
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [],
    unpricedDeltas: [delta(CFG, -1n, "CFG", 18)],
    nativeWeiPositive: true,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "atomic_loop"),
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [],
    unpricedDeltas: [delta(CFG, 5n, "CFG", 18)],
    nativeWeiPositive: true,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "unknown"),
  // Deliverable 3: native-ETH-funded one-leg inventory buy (ETH spent invisibly, bought token kept,
  // no counter-transfer) -> one_leg_inventory (was unknown: native-blind AND v4/v2 has no tick check).
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [],
    unpricedDeltas: [],
    nativeWeiPositive: false,
    nativeWeiNegative: true,
    unpricedInTokensWithoutCounterTransfer: [lower(CFG)],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "one_leg_inventory"),
  // guard: native spent but NO leftover bought-token without counter-transfer -> NOT one-leg (an
  // atomic loop returns to a priced token and leaves an empty list) -> falls through to unknown.
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [],
    unpricedDeltas: [],
    nativeWeiPositive: false,
    nativeWeiNegative: true,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "unknown"),
  () => assert.equal(winnerMovedPriceBeyondPrestate(90610, 90601, "down"), true),
  () => assert.equal(winnerMovedPriceBeyondPrestate(90610, 90610, "down"), false),
  () => assert.equal(winnerMovedPriceBeyondPrestate(90610, 90612, "down"), false),
  () => assert.equal(realizedProfitUsdForReport(-528, [delta(CFG, 1n, "CFG", 18)]), `unpriceable(${lower(CFG)})`),
];

try {
  for (const check of checks) check();
  rmSync(graphFixtureDir, { recursive: true, force: true });
  console.log(`bundle-postmortem-noise-filter PASS (${checks.length}/${checks.length})`);
  console.log("expected_transition: non-comparable (one_leg_inventory/sandwich) winner no longer triggers a false route_gap_decisive; only real atomic-loss coverage gaps do. verdict: fixed");
} catch (err) {
  console.error(`bundle-postmortem-noise-filter FAIL: ${(err as Error).message}`);
  process.exit(1);
}

function event(simulatedProfit: string, bid: string): Record<string, unknown> {
  return {
    simulated_profit: simulatedProfit,
    bid,
    submission_target_block: 25450951,
  };
}

function competitor(winnerStyle: WinnerStyle, builderPaymentWei: string): any {
  return {
    hash: `0x${winnerStyle.padEnd(64, "0").slice(0, 64)}`,
    transactionIndex: 11,
    backrun_positioned: true,
    matched_source_addresses: [],
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    status: "0x1",
    gasUsed: "0",
    effectiveGasPrice: "0",
    priorityTipWei: "0",
    coinbaseTransferWei: "0",
    builderPaymentWei,
    builderPaymentEth: null,
    builderPaymentUsd: null,
    realizedProfitUsd: null,
    profitConfidence: "high",
    nativeTraceUsed: false,
    tracePrestateUsed: false,
    traceError: null,
    v4Swaps: 0,
    v4PoolIds: [],
    touchedVenues: [],
    winner_style: winnerStyle,
    winner_moved_price_beyond_prestate: winnerStyle === "one_leg_inventory",
    unpriced_token_in_flow: winnerStyle === "one_leg_inventory" ? [lower(CFG)] : [],
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
