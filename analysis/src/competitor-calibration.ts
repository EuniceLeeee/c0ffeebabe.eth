import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionsFromLogs } from "./actions/from-logs.js";
import {
  classifyWinnerStyle,
  detectNonArbSignals,
  extractOtherVenues,
  overlayNonArbStyle,
  shareTokenImbalanceTokens,
  type WinnerStyle,
} from "./cli/bundle-postmortem.js";
import { valueDeltas } from "./pnl/arb-profit.js";
import { classifyTxShape, type RawLog } from "./pnl/tx-shape.js";
import { ADDR, lower } from "./registry/protocols.js";

const COFFEE = "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures");
const COFFEE_FIXTURES = join(FIXTURES, "coffee-20260704");
const STEAK_USDT = "0xbeef047a543e45807105e51a8bbefcc5950fcfba";
const STEAK_USDC = "0xbeef01735c132ada46aa9aa4c54623caa92a64cb";
const SCALE_KEEPER_TX = "0xd63fa66f8c9e6effeb6d17030c16d4003beceb75a1ee31e8b4e4dca62747c628";

interface TxInputFixture {
  hash: string;
  from: string;
  input: string;
}

interface CoffeeFixture {
  label: string;
  txHash: string;
  txIndex: number;
  tx: { from: string; to: string };
  receiptLogs: RawLog[];
  sameBlockSwapLogs: RawLog[];
}

export interface CompetitorCalibrationCheck {
  tx_hash: string;
  axis: "source_shape" | "winner_style" | "vault_inventory_signal" | "venue_lineage";
  expected: string;
  actual: string;
  pass: boolean;
}

export interface CompetitorCalibrationResult {
  schema_version: 1;
  competitor: string;
  fixture_set: string;
  checks: CompetitorCalibrationCheck[];
  passed: number;
  failed: number;
  status: "pass" | "fail";
}

/**
 * Deterministic calibration for the two independent competitor axes:
 *  - source shape: atomic-state vs backrun (all nine pinned coffee txs);
 *  - comparability: conserving atomic loop vs vault inventory (real receipt controls).
 *
 * The second axis intentionally does not force every log-only fixture into a winner_style. Native
 * ETH and block context require RPC for several samples; pretending otherwise is the exact category
 * error this gate prevents.
 */
export function runCompetitorCalibration(): CompetitorCalibrationResult {
  const checks: CompetitorCalibrationCheck[] = [];
  try {
    const fixtures = loadCoffeeFixtures();
    for (const fixture of fixtures) {
      const actual = classifyTxShape({
        receiptLogs: fixture.receiptLogs,
        txIndex: fixture.txIndex,
        sameBlockSwapLogs: fixture.sameBlockSwapLogs,
      }).shape;
      const expected = fixture.label === "9" ? "backrun" : "atomic_state_arb";
      checks.push(check(fixture.txHash, "source_shape", expected, actual));
    }

    const tx2 = fixtures.find((fixture) => fixture.label === "2");
    const tx3 = fixtures.find((fixture) => fixture.label === "3");
    const tx4 = fixtures.find((fixture) => fixture.label === "4");
    if (!tx2 || !tx3 || !tx4) throw new Error("coffee fixtures #2/#3/#4 missing");

    const tx2Signals = shareTokenImbalanceTokens({ logs: tx2.receiptLogs });
    checks.push(check(tx2.txHash, "vault_inventory_signal", "none", tx2Signals.join(",") || "none"));
    checks.push(check(tx3.txHash, "winner_style", "atomic_loop", offlineWinnerStyle(tx3)));
    checks.push(check(tx4.txHash, "winner_style", "atomic_loop", offlineWinnerStyle(tx4)));

    const inventoryReceipt = JSON.parse(
      readFileSync(join(FIXTURES, "postmortem-0x9be73297", "receipt.json"), "utf8"),
    );
    const inventorySignals = shareTokenImbalanceTokens(inventoryReceipt).sort();
    const inventoryStyle = classifyWinnerStyle({
      pricedDeltas: [{ token: ADDR.WETH, symbol: "WETH", decimals: 18, raw: 1n }],
      unpricedDeltas: [],
      nativeWeiPositive: false,
      nativeWeiNegative: false,
      unpricedInTokensWithoutCounterTransfer: [],
      winner_moved_price_beyond_prestate: false,
      sandwich_detected: false,
      share_imbalance_tokens: inventorySignals,
      inventory_rebalance_selector_hit: false,
    });
    checks.push(check(
      "0x9be73297e0fd8b0ff9760356480b372e3f78b12ce6bc6dc9bb83888d1314b862",
      "winner_style",
      "inventory_vault_rebalance",
      inventoryStyle,
    ));
    checks.push(check(
      "0x9be73297e0fd8b0ff9760356480b372e3f78b12ce6bc6dc9bb83888d1314b862",
      "vault_inventory_signal",
      [lower(STEAK_USDC), lower(STEAK_USDT)].sort().join(","),
      inventorySignals.join(","),
    ));
    const fluidLineages = extractOtherVenues(inventoryReceipt, null)
      .map((venue) => venue.protocol)
      .filter((protocol) => protocol === "fluidDex");
    checks.push(check(
      "0x9be73297e0fd8b0ff9760356480b372e3f78b12ce6bc6dc9bb83888d1314b862",
      "venue_lineage",
      "fluidDex",
      fluidLineages.join(",") || "none",
    ));
    const keeperFixture = JSON.parse(
      readFileSync(join(FIXTURES, "postmortem-0xd63fa66f", "tx.json"), "utf8"),
    ) as TxInputFixture;
    if (lower(keeperFixture.hash) !== SCALE_KEEPER_TX) {
      throw new Error("SCALE keeper fixture hash mismatch");
    }
    const keeperSignals = detectNonArbSignals(
      keeperFixture.input,
      null,
      new Set([lower(keeperFixture.from)]),
      null,
    );
    checks.push(check(
      SCALE_KEEPER_TX,
      "winner_style",
      "keeper_claim",
      overlayNonArbStyle("unknown", keeperSignals),
    ));
  } catch (error) {
    checks.push(check(
      "fixture-loader",
      "winner_style",
      "no_error",
      error instanceof Error ? error.message : String(error),
    ));
  }

  const failed = checks.filter((entry) => !entry.pass).length;
  return {
    schema_version: 1,
    competitor: COFFEE,
    fixture_set: "coffee-20260704 + postmortem-0x9be73297 + postmortem-0xd63fa66f",
    checks,
    passed: checks.length - failed,
    failed,
    status: failed === 0 ? "pass" : "fail",
  };
}

function check(
  txHash: string,
  axis: CompetitorCalibrationCheck["axis"],
  expected: string,
  actual: string,
): CompetitorCalibrationCheck {
  return { tx_hash: lower(txHash), axis, expected, actual, pass: expected === actual };
}

function offlineWinnerStyle(fixture: CoffeeFixture): WinnerStyle {
  const rawDeltas = actionsFromLogs(
    { logs: fixture.receiptLogs },
    [fixture.tx.from, fixture.tx.to],
  ).rawDeltas;
  const valued = valueDeltas(rawDeltas, 1746.76);
  return classifyWinnerStyle({
    pricedDeltas: valued.priced,
    unpricedDeltas: valued.unpriced,
    nativeWeiPositive: false,
    nativeWeiNegative: false,
    unpricedInTokensWithoutCounterTransfer: valued.unpriced
      .filter((delta) => delta.raw > 0n)
      .map((delta) => delta.token),
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
    share_imbalance_tokens: shareTokenImbalanceTokens({ logs: fixture.receiptLogs }),
    inventory_rebalance_selector_hit: false,
  });
}

function loadCoffeeFixtures(): CoffeeFixture[] {
  const index = JSON.parse(readFileSync(join(COFFEE_FIXTURES, "index.json"), "utf8")) as Array<{
    label: string;
  }>;
  return index.map((entry) => JSON.parse(
    readFileSync(join(COFFEE_FIXTURES, `tx-${entry.label}.json`), "utf8"),
  ) as CoffeeFixture);
}
