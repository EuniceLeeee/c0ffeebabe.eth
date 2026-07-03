import assert from "node:assert/strict";
import {
  buildVerdict,
  classifyWinnerStyle,
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
  unpricedInTokensWithoutCounterTransfer: [lower(CFG)],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
});

const tickForcedStyle = classifyWinnerStyle({
  pricedDeltas: [],
  unpricedDeltas: [],
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
  unpricedInTokensWithoutCounterTransfer: [],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
});

const atomicVerdict = buildVerdict(
  event("100", "50"),
  [competitor(atomicStyle, "200")],
  reach,
);

const checks: Array<() => void> = [
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
  () => assert.equal(winnerMovedPriceBeyondPrestate(90610, 90601, "down"), true),
  () => assert.equal(winnerMovedPriceBeyondPrestate(90610, 90610, "down"), false),
  () => assert.equal(winnerMovedPriceBeyondPrestate(90610, 90612, "down"), false),
  () => assert.equal(realizedProfitUsdForReport(-528, [delta(CFG, 1n, "CFG", 18)]), `unpriceable(${lower(CFG)})`),
];

try {
  for (const check of checks) check();
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
