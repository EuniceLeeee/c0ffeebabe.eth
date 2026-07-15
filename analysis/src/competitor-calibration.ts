import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionsFromLogs } from "./actions/from-logs.js";
import {
  classifyWinnerStyle,
  detectNonArbSignals,
  extractOtherVenues,
  hasBeneficiaryWethUnwrapExit,
  overlayNonArbStyle,
  positionAccountImbalanceTokens,
  retainedSharePositionTokensForOwners,
  shareTokenImbalanceTokens,
  type WinnerStyle,
} from "./cli/bundle-postmortem.js";
import {
  loadLiveCompetitorProfile,
  positionAccountsForActors,
} from "./live-competitors.js";
import { valueDeltas } from "./pnl/arb-profit.js";
import { classifyTxShape, type RawLog } from "./pnl/tx-shape.js";
import { ADDR, lower, tokenMeta } from "./registry/protocols.js";

const COFFEE = "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures");
const COFFEE_FIXTURES = join(FIXTURES, "coffee-20260704");
const HOLDOUT_FIXTURE = join(FIXTURES, "competitor-calibration-holdouts.json");
const DISPUTED_RECEIPTS_FIXTURE = join(FIXTURES, "bundle-postmortem-disputed-receipts.json");
const STEAK_USDT = "0xbeef047a543e45807105e51a8bbefcc5950fcfba";
const STEAK_USDC = "0xbeef01735c132ada46aa9aa4c54623caa92a64cb";
const SCALE_KEEPER_TX = "0xd63fa66f8c9e6effeb6d17030c16d4003beceb75a1ee31e8b4e4dca62747c628";
const COFFEE_EXECUTOR = "0xe08d97e151473a848c3d9ca3f323cb720472d015";
const LIQUITY_EXTERNAL_MINT_RECIPIENTS = [
  "0x807def5e7d057df05c796f4bc75c3fe82bd6eee1",
  "0x9502b7c397e9aa22fe9db7ef7daf21cd2aebe56b",
];
const SUSDS_ATOMIC_LOOP_TXS = [
  "0x294d326bc58cf7aea2a108a18526cc351881de159da872d464c5735b5cc8cef8",
  "0x868d2dc5d4f60d73ea755015dfe9b668618c72228e442cf7381cdb5e1aa64ea4",
  "0x9d5156cb01a7dfbcaed31ecb028132089d59517472901da130d95e5e4b3020be",
  "0xf2130409bfe9636c5cb6e7b85c523b07a0e20c209508f43a6e375607da3a4527",
  "0x17f767fda9db5e4ad7ddb325c9b125436f2262df8ed09e97cb497fe6f0e2ce7d",
  "0x1c2999d6422e16cea36973416e16dd8e84410f7cf5adf78f5531f4d160d5eaf2",
  "0x69075e9e45ed3840f6bf46c37552b62b66e5537aab1369475a57027750b68c70",
  "0xa82dafbae5f82a016736fc35dea9ed8d9b154b8692b243d074d07c62f0738e85",
  "0x8b56e5d54f3be0a13cfb6f837291c81c416ef79b4269927e4a1c2b1b6e9a8a63",
  "0xba5a95362281d11b1b132c99c6cdc220d076da240e5741bf392a445a134c4a26",
];
const EXTERNAL_MINT_RECIPIENTS = new Map([
  [
    "0xe45fee762983a4f3eddf3395d32069778e5b7637df985c06a91635fe6f1812f5",
    "0x34cf4cdb502b8ff43943149224060c0de2ddff82",
  ],
  [
    "0x191b9eb5ea5f8d08e1c38a450950c1eba76ffb943086934f012e712e59661912",
    "0xe1f4b19806573681ee761776a5ff8a6dd04fcec5",
  ],
]);
const EXTERNAL_MINT_TOKENS = new Map([
  [
    "0xe45fee762983a4f3eddf3395d32069778e5b7637df985c06a91635fe6f1812f5",
    "0x444444444444c1a66f394025ac839a535246fcc8",
  ],
  [
    "0x191b9eb5ea5f8d08e1c38a450950c1eba76ffb943086934f012e712e59661912",
    "0x5d2caad2b7f851dcb001e7d1156fdc3b4936666c",
  ],
]);
const DISPUTED_RECEIPT_LOG_COUNTS = new Map([
  ["0x17f767fda9db5e4ad7ddb325c9b125436f2262df8ed09e97cb497fe6f0e2ce7d", 68],
  ["0x191b9eb5ea5f8d08e1c38a450950c1eba76ffb943086934f012e712e59661912", 90],
  ["0x1c2999d6422e16cea36973416e16dd8e84410f7cf5adf78f5531f4d160d5eaf2", 40],
  ["0x294d326bc58cf7aea2a108a18526cc351881de159da872d464c5735b5cc8cef8", 50],
  ["0x69075e9e45ed3840f6bf46c37552b62b66e5537aab1369475a57027750b68c70", 37],
  ["0x868d2dc5d4f60d73ea755015dfe9b668618c72228e442cf7381cdb5e1aa64ea4", 59],
  ["0x8b56e5d54f3be0a13cfb6f837291c81c416ef79b4269927e4a1c2b1b6e9a8a63", 70],
  ["0x9d5156cb01a7dfbcaed31ecb028132089d59517472901da130d95e5e4b3020be", 59],
  ["0xa82dafbae5f82a016736fc35dea9ed8d9b154b8692b243d074d07c62f0738e85", 71],
  ["0xba5a95362281d11b1b132c99c6cdc220d076da240e5741bf392a445a134c4a26", 74],
  ["0xe45fee762983a4f3eddf3395d32069778e5b7637df985c06a91635fe6f1812f5", 23],
  ["0xf2130409bfe9636c5cb6e7b85c523b07a0e20c209508f43a6e375607da3a4527", 30],
]);

interface TxInputFixture {
  hash: string;
  from: string;
  input: string;
}

interface CoffeeFixture {
  label: string;
  txHash: string;
  txIndex: number;
  receiptStatus?: string;
  tx: { from: string; to: string };
  receiptLogs: RawLog[];
  sameBlockSwapLogs: RawLog[];
}

interface HoldoutFixture {
  txHash: string;
  expectedWinnerStyle: WinnerStyle;
  expectedNonArbSignal: "keeper" | "rfq" | "none";
  nativeWeiPositive: boolean;
  manualEvidence: string;
  tx: { from: string; to: string; input: string };
  blockTimestamp: number;
  receiptLogs: RawLog[];
}

interface ActualReceiptFixture {
  transactionHash: string;
  from: string;
  to: string;
  status: string;
  logs: RawLog[];
}

interface DisputedReceiptFixture {
  susdsAtomicLoops: ActualReceiptFixture[];
  externalMintNonComparable: ActualReceiptFixture[];
}

export interface CompetitorCalibrationCheck {
  tx_hash: string;
  axis: "source_shape" | "winner_style" | "vault_inventory_signal" | "venue_lineage"
    | "non_arb_signal" | "external_mint_signal" | "receipt_integrity" | "token_metadata";
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

    const tx2LogHashes = new Set(tx2.receiptLogs.map((log) => lower(String(log.transactionHash ?? ""))));
    checks.push(check(
      tx2.txHash,
      "receipt_integrity",
      `0x1/21/${lower(tx2.txHash)}`,
      `${tx2.receiptStatus}/${tx2.receiptLogs.length}/${[...tx2LogHashes].join(",")}`,
    ));
    const tx2Signals = inventoryImbalanceTokens(
      { logs: tx2.receiptLogs },
      new Set([lower(tx2.tx.from), lower(tx2.tx.to)]),
    );
    checks.push(check(tx2.txHash, "vault_inventory_signal", "none", tx2Signals.join(",") || "none"));
    checks.push(check(tx2.txHash, "winner_style", "atomic_loop", offlineWinnerStyle(tx2)));
    const tx2NonArb = detectNonArbSignals(
      null,
      { logs: tx2.receiptLogs },
      new Set([lower(tx2.tx.from), lower(tx2.tx.to)]),
      null,
    );
    checks.push(check(
      tx2.txHash,
      "external_mint_signal",
      LIQUITY_EXTERNAL_MINT_RECIPIENTS.join(","),
      tx2NonArb.external_mint_recipients.join(",") || "none",
    ));
    checks.push(check(tx3.txHash, "winner_style", "atomic_loop", offlineWinnerStyle(tx3)));
    checks.push(check(tx4.txHash, "winner_style", "atomic_loop", offlineWinnerStyle(tx4)));

    const inventoryReceipt = JSON.parse(
      readFileSync(join(FIXTURES, "postmortem-0x9be73297", "receipt.json"), "utf8"),
    );
    const inventorySignals = inventoryImbalanceTokens(
      inventoryReceipt,
      new Set([lower(COFFEE), lower(COFFEE_EXECUTOR)]),
    ).sort();
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

    const disputedReceipts = loadDisputedReceipts();
    for (const receipt of disputedReceipts.susdsAtomicLoops) {
      const actual = offlineActualReceiptStyle(receipt);
      checks.push(check(
        receipt.transactionHash,
        "receipt_integrity",
        `0x1/${DISPUTED_RECEIPT_LOG_COUNTS.get(receipt.transactionHash)}`,
        `${receipt.status}/${receipt.logs.length}`,
      ));
      checks.push(check(receipt.transactionHash, "winner_style", "atomic_loop", actual.style));
      checks.push(check(
        receipt.transactionHash,
        "vault_inventory_signal",
        "none",
        actual.shareImbalanceTokens.join(",") || "none",
      ));
    }
    for (const receipt of disputedReceipts.externalMintNonComparable) {
      const actual = offlineActualReceiptStyle(receipt);
      checks.push(check(
        receipt.transactionHash,
        "receipt_integrity",
        `0x1/${DISPUTED_RECEIPT_LOG_COUNTS.get(receipt.transactionHash)}`,
        `${receipt.status}/${receipt.logs.length}`,
      ));
      checks.push(check(receipt.transactionHash, "winner_style", "unknown", actual.style));
      checks.push(check(
        receipt.transactionHash,
        "external_mint_signal",
        EXTERNAL_MINT_RECIPIENTS.get(receipt.transactionHash) ?? "missing_expected_recipient",
        actual.externalMintRecipients.join(",") || "none",
      ));
      checks.push(check(
        receipt.transactionHash,
        "external_mint_signal",
        EXTERNAL_MINT_TOKENS.get(receipt.transactionHash) ?? "missing_expected_token",
        actual.externalMintTokens.join(",") || "none",
      ));
    }
    const usdsMeta = tokenMeta(ADDR.USDS);
    checks.push(check(
      ADDR.USDS,
      "token_metadata",
      "USDS/18/1",
      `${usdsMeta.symbol}/${usdsMeta.decimals}/${usdsMeta.roughUsd ?? "unpriced"}`,
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

    for (const holdout of loadHoldouts()) {
      const actual = offlineHoldoutStyle(holdout);
      checks.push(check(holdout.txHash, "winner_style", holdout.expectedWinnerStyle, actual.style));
      checks.push(check(
        holdout.txHash,
        "non_arb_signal",
        holdout.expectedNonArbSignal,
        actual.nonArbSignal,
      ));
    }
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
    fixture_set: "coffee-20260704 + disputed actual receipts + postmortem-0x9be73297 + postmortem-0xd63fa66f + three manually-labelled holdouts",
    checks,
    passed: checks.length - failed,
    failed,
    status: failed === 0 ? "pass" : "fail",
  };
}

function offlineHoldoutStyle(holdout: HoldoutFixture): {
  style: WinnerStyle;
  nonArbSignal: HoldoutFixture["expectedNonArbSignal"];
} {
  const receipt = { logs: holdout.receiptLogs };
  const actors = new Set([lower(holdout.tx.from), lower(holdout.tx.to)]);
  const rawDeltas = actionsFromLogs(receipt, [holdout.tx.from, holdout.tx.to]).rawDeltas;
  const valued = valueDeltas(rawDeltas, 1746.76);
  const nonArb = detectNonArbSignals(
    holdout.tx.input,
    receipt,
    actors,
    holdout.blockTimestamp,
  );
  const base = classifyWinnerStyle({
    pricedDeltas: valued.priced,
    unpricedDeltas: valued.unpriced,
    nativeWeiPositive: holdout.nativeWeiPositive,
    nativeWeiNegative: false,
    unpricedInTokensWithoutCounterTransfer: valued.unpriced
      .filter((delta) => delta.raw > 0n)
      .map((delta) => delta.token),
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
    share_imbalance_tokens: inventoryImbalanceTokens(receipt, actors),
    retained_share_position_tokens: retainedSharePositionTokensForOwners(receipt, actors),
    inventory_rebalance_selector_hit: false,
  });
  const nonArbSignal = nonArb.claim_selector_hit || nonArb.conserved_sink_cut
    ? "keeper"
    : nonArb.rfq_sig_count > 0 && nonArb.rfq_deadline_in_calldata
      ? "rfq"
      : "none";
  return { style: overlayNonArbStyle(base, nonArb), nonArbSignal };
}

function offlineActualReceiptStyle(receipt: ActualReceiptFixture): {
  style: WinnerStyle;
  shareImbalanceTokens: string[];
  externalMintRecipients: string[];
  externalMintTokens: string[];
} {
  const actors = new Set([lower(receipt.from), lower(receipt.to)]);
  const rawDeltas = actionsFromLogs(receipt, [...actors]).rawDeltas;
  const valued = valueDeltas(rawDeltas, 1746.76);
  const shareImbalanceTokens = inventoryImbalanceTokens(receipt, actors);
  const nonArb = detectNonArbSignals(null, receipt, actors, null);
  const base = classifyWinnerStyle({
    pricedDeltas: valued.priced,
    unpricedDeltas: valued.unpriced,
    nativeWeiPositive: hasBeneficiaryWethUnwrapExit(receipt, actors),
    nativeWeiNegative: false,
    unpricedInTokensWithoutCounterTransfer: valued.unpriced
      .filter((delta) => delta.raw > 0n)
      .map((delta) => delta.token),
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
    share_imbalance_tokens: shareImbalanceTokens,
    retained_share_position_tokens: retainedSharePositionTokensForOwners(receipt, actors),
    inventory_rebalance_selector_hit: false,
  });
  return {
    style: overlayNonArbStyle(base, nonArb),
    shareImbalanceTokens,
    externalMintRecipients: nonArb.external_mint_recipients,
    externalMintTokens: nonArb.external_mint_tokens,
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
  const actors = new Set([lower(fixture.tx.from), lower(fixture.tx.to)]);
  const receipt = { logs: fixture.receiptLogs };
  const rawDeltas = actionsFromLogs(
    receipt,
    [fixture.tx.from, fixture.tx.to],
  ).rawDeltas;
  const valued = valueDeltas(rawDeltas, 1746.76);
  const base = classifyWinnerStyle({
    pricedDeltas: valued.priced,
    unpricedDeltas: valued.unpriced,
    nativeWeiPositive: hasBeneficiaryWethUnwrapExit(receipt, actors),
    nativeWeiNegative: false,
    unpricedInTokensWithoutCounterTransfer: valued.unpriced
      .filter((delta) => delta.raw > 0n)
      .map((delta) => delta.token),
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
    share_imbalance_tokens: inventoryImbalanceTokens(receipt, actors),
    retained_share_position_tokens: retainedSharePositionTokensForOwners(receipt, actors),
    inventory_rebalance_selector_hit: false,
  });
  return overlayNonArbStyle(base, detectNonArbSignals(null, receipt, actors, null));
}

function inventoryImbalanceTokens(receipt: { logs: RawLog[] }, actors: Set<string>): string[] {
  // Match production: actor-owned share drawdowns are evaluated per holder, while configured
  // position accounts are evaluated only as one aggregate entity. Load the default profile per call,
  // matching the profileless library path instead of retaining module-global ownership state.
  const positionAccounts = new Set(positionAccountsForActors(loadLiveCompetitorProfile(), actors));
  return [...new Set([
    ...shareTokenImbalanceTokens(receipt, actors),
    ...positionAccountImbalanceTokens(receipt, positionAccounts),
  ])].sort();
}

function loadDisputedReceipts(): DisputedReceiptFixture {
  const fixture = JSON.parse(readFileSync(DISPUTED_RECEIPTS_FIXTURE, "utf8")) as DisputedReceiptFixture;
  if (!Array.isArray(fixture.susdsAtomicLoops)
    || !Array.isArray(fixture.externalMintNonComparable)) {
    throw new Error("disputed receipt fixture groups missing");
  }
  const actualLoops = fixture.susdsAtomicLoops.map((sample) => lower(sample.transactionHash)).sort();
  const expectedLoops = SUSDS_ATOMIC_LOOP_TXS.map(lower).sort();
  const actualExternal = fixture.externalMintNonComparable
    .map((sample) => lower(sample.transactionHash))
    .sort();
  const expectedExternal = [...EXTERNAL_MINT_RECIPIENTS.keys()].map(lower).sort();
  if (actualLoops.join(",") !== expectedLoops.join(",")) {
    throw new Error("sUSDS disputed receipt hash set mismatch");
  }
  if (actualExternal.join(",") !== expectedExternal.join(",")) {
    throw new Error("external-mint disputed receipt hash set mismatch");
  }
  for (const sample of [...fixture.susdsAtomicLoops, ...fixture.externalMintNonComparable]) {
    const hash = lower(sample.transactionHash);
    const logHashes = new Set(sample.logs.map((log) => lower(String(log.transactionHash ?? ""))));
    if (lower(sample.from) !== lower(COFFEE)
      || lower(sample.to) !== lower(COFFEE_EXECUTOR)
      || sample.status !== "0x1"
      || !Array.isArray(sample.logs)
      || sample.logs.length !== DISPUTED_RECEIPT_LOG_COUNTS.get(hash)
      || logHashes.size !== 1
      || !logHashes.has(hash)) {
      throw new Error(`invalid disputed receipt fixture ${sample.transactionHash}`);
    }
  }
  return fixture;
}

function loadCoffeeFixtures(): CoffeeFixture[] {
  const index = JSON.parse(readFileSync(join(COFFEE_FIXTURES, "index.json"), "utf8")) as Array<{
    label: string;
  }>;
  return index.map((entry) => JSON.parse(
    readFileSync(join(COFFEE_FIXTURES, `tx-${entry.label}.json`), "utf8"),
  ) as CoffeeFixture);
}

function loadHoldouts(): HoldoutFixture[] {
  const fixture = JSON.parse(readFileSync(HOLDOUT_FIXTURE, "utf8")) as {
    samples?: HoldoutFixture[];
  };
  if (!Array.isArray(fixture.samples) || fixture.samples.length < 3) {
    throw new Error("competitor calibration requires at least three holdout samples");
  }
  for (const sample of fixture.samples) {
    if (!sample.manualEvidence || !sample.txHash || !Array.isArray(sample.receiptLogs)) {
      throw new Error("competitor holdout missing manual evidence, tx hash, or receipt logs");
    }
  }
  return fixture.samples;
}
