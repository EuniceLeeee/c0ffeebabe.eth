import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { actionsFromLogs } from "../actions/from-logs.js";
import {
  buildVerdict,
  classifyWinnerStyle,
  decodeV4SwapFills,
  detectNonArbSignals,
  detectJitLiquidity,
  extractOtherVenues,
  hasBeneficiaryWethUnwrapExit,
  isNonComparableWinnerStyle,
  loadGraphMembership,
  overlayNonArbStyle,
  realizedProfitUsdForReport,
  shareTokenImbalanceTokens,
  winnerMovedPriceBeyondPrestate,
  type WinnerStyle,
} from "../cli/bundle-postmortem.js";
import { valueDeltas } from "../pnl/arb-profit.js";
import { ADDR, lower, TOPICS } from "../registry/protocols.js";
import type { TokenDelta } from "../types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
interface ActualReceiptFixture {
  transactionHash: string;
  blockNumber: string;
  from: string;
  to: string;
  status: string;
  logs: Array<Record<string, unknown>>;
}

interface DisputedReceiptFixture {
  susdsAtomicLoops: ActualReceiptFixture[];
  externalMintNonComparable: ActualReceiptFixture[];
}

const COFFEE = "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671";
const COFFEE_EXECUTOR = "0xe08d97e151473a848c3d9ca3f323cb720472d015";
const COMPETITOR_ACTORS = new Set([COFFEE, COFFEE_EXECUTOR]);
// F-009 atomicity detector: a real inventory-rebalance receipt (0x9be73297: steakUSDC/steakUSDT
// rebalance through private vault-wrappers) vs a clean atomic 4-leg AMM loop (0xf2de7499).
const inventoryReceipt = JSON.parse(
  readFileSync(join(FIXTURES, "postmortem-0x9be73297", "receipt.json"), "utf8"),
);
const atomicReceipt = JSON.parse(
  readFileSync(join(FIXTURES, "postmortem-0xf2de7499", "receipt.json"), "utf8"),
);
const liquityMintReceipt = JSON.parse(
  readFileSync(join(FIXTURES, "coffee-20260704", "tx-2.json"), "utf8"),
);
const disputedReceipts = JSON.parse(
  readFileSync(join(FIXTURES, "bundle-postmortem-disputed-receipts.json"), "utf8"),
) as DisputedReceiptFixture;
const STEAK_USDT = "0xbeef047a543e45807105e51a8bbefcc5950fcfba";
const STEAK_USDC = "0xbeef01735c132ada46aa9aa4c54623caa92a64cb";
const inventoryImbalanceTokens = shareTokenImbalanceTokens(inventoryReceipt, COMPETITOR_ACTORS).sort();
const atomicImbalanceTokens = shareTokenImbalanceTokens(atomicReceipt, COMPETITOR_ACTORS);

// FALSE-POSITIVE FIX (coffeebabe srUSDe loops 0xf391d0 / 0x2b84e28c): an atomic loop that BUYS a vault
// share in-tx (from a swap venue) then REDEEMS it (burn to 0x0) shows a GLOBAL net BURN but the executor
// nets ~0. The old unconditional `value<0` flagged it as pre-held inventory. Now it must NOT flag (no
// non-venue holder ends with a residual). A GENUINE pre-held burn (a non-venue helper -> 0x0, no in-tx
// source) still flags. Synthetic receipts, deterministic.
const SHARE_TOK = "0x00000000000000000000000000000000000000a1";
const SWAP_VENUE = "0x00000000000000000000000000000000000000b2";
const EXEC_ACTOR = "0x00000000000000000000000000000000000000c3";
const INV_HELPER = "0x00000000000000000000000000000000000000d4";
const erc20If = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const erc4626If = new ethers.Interface([
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
]);
const v3If = new ethers.Interface(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"]);
const xfer = (token: string, from: string, to: string, amt: bigint, li: number) => {
  const { data, topics } = erc20If.encodeEventLog("Transfer", [from, to, amt]);
  return { address: token, topics, data, logIndex: "0x" + li.toString(16) };
};
const v3SwapLog = (pool: string, li: number) => {
  const { data, topics } = v3If.encodeEventLog("Swap", [EXEC_ACTOR, EXEC_ACTOR, 1, -1, 0, 0, 0]);
  return { address: pool, topics, data, logIndex: "0x" + li.toString(16) };
};
const vaultWithdrawLog = (vault: string, actor: string, amount: bigint, li: number) => {
  const { data, topics } = erc4626If.encodeEventLog("Withdraw", [actor, actor, actor, amount, amount]);
  return { address: vault, topics, data, logIndex: "0x" + li.toString(16) };
};
const SHARE_AMT = 934n * 10n ** 18n;
// buy the share from a swap venue, redeem it (burn) — executor nets 0 => NOT inventory (the fix).
const atomicBuyRedeem = { logs: [v3SwapLog(SWAP_VENUE, 0), xfer(SHARE_TOK, SWAP_VENUE, EXEC_ACTOR, SHARE_AMT, 1), xfer(SHARE_TOK, EXEC_ACTOR, ethers.ZeroAddress, SHARE_AMT, 2), vaultWithdrawLog(SHARE_TOK, EXEC_ACTOR, SHARE_AMT, 3)] };
// a non-venue helper burns a PRE-HELD share (no in-tx source) => still inventory.
const preHeldBurn = { logs: [xfer(SHARE_TOK, INV_HELPER, ethers.ZeroAddress, SHARE_AMT, 0), vaultWithdrawLog(SHARE_TOK, INV_HELPER, SHARE_AMT, 1)] };
const buyRedeemImbalance = shareTokenImbalanceTokens(atomicBuyRedeem, new Set([EXEC_ACTOR]));
const preHeldBurnImbalance = shareTokenImbalanceTokens(preHeldBurn, new Set([INV_HELPER]));
const liquityMintImbalance = shareTokenImbalanceTokens(
  { logs: liquityMintReceipt.receiptLogs },
  new Set([lower(liquityMintReceipt.tx.from), lower(liquityMintReceipt.tx.to)]),
);
const fluidOtherVenues = extractOtherVenues({
  logs: [{ address: ADDR.FLUID_DEX_USDC_USDT, topics: [TOPICS.fluidDexSwap] }],
}, null);
const susdsLoopAnalyses = disputedReceipts.susdsAtomicLoops.map(analyzeActualReceiptFixture);
const externalMintAnalyses = disputedReceipts.externalMintNonComparable.map(analyzeActualReceiptFixture);
const expectedExternalMintRecipients = new Map([
  [
    "0xe45fee762983a4f3eddf3395d32069778e5b7637df985c06a91635fe6f1812f5",
    ["0x34cf4cdb502b8ff43943149224060c0de2ddff82"],
  ],
  [
    "0x191b9eb5ea5f8d08e1c38a450950c1eba76ffb943086934f012e712e59661912",
    ["0xe1f4b19806573681ee761776a5ff8a6dd04fcec5"],
  ],
]);

const CFG = "0xcccccccccccccccccccccccccccccccccccccccc";
const reach = {
  status: "sent_directly" as const,
  builder: "test-builder",
  miner: "0x0000000000000000000000000000000000000000",
  builders_sent: ["test-builder"],
  note: "test fixture",
};
const scaleKeeperSignals = detectNonArbSignals(
  "0x8cbf856600000000e4fc6b6d00000000",
  null,
  new Set([EXEC_ACTOR]),
  null,
);

// The inventory receipt's residual vault-share position => inventory_vault_rebalance (non-comparable),
// even though the executor's priced/native net looks like a clean atomic loop (+profit only).
const inventoryVaultStyle = classifyWinnerStyle({
  pricedDeltas: [delta(ADDR.WETH, 399744634603446n, "WETH", 18)], // looks atomic on the executor axis
  unpricedDeltas: [],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
  share_imbalance_tokens: inventoryImbalanceTokens,
  inventory_rebalance_selector_hit: true,
});

// The clean atomic loop: no share imbalance; a hardcoded selector hit alone must NOT reclassify a
// comparable atomic loop (a plain ERC4626 arb calls deposit/redeem but nets zero shares).
const atomicWithSelectorHit = classifyWinnerStyle({
  pricedDeltas: [delta(ADDR.WETH, 399744634603446n, "WETH", 18)],
  unpricedDeltas: [],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
  share_imbalance_tokens: atomicImbalanceTokens,
  inventory_rebalance_selector_hit: true,
});

const inventoryVaultVerdict = buildVerdict(
  event("100", "50"),
  [competitor(inventoryVaultStyle, "200")],
  reach,
);

const oneLegStyle = classifyWinnerStyle({
  pricedDeltas: [delta(ADDR.WETH, -305410000000000000n, "WETH", 18)],
  unpricedDeltas: [delta(CFG, 2640100000000000000000n, "CFG", 18)],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [lower(CFG)],
  winner_moved_price_beyond_prestate: false,
  sandwich_detected: false,
});

// Selling one priced inventory asset into another is still one-leg inventory. The old classifier
// treated any positive priced residual as an atomic loop, even when a different priced token was spent.
const pricedOneLegStyle = classifyWinnerStyle({
  pricedDeltas: [
    delta(ADDR.WETH, -1_000_000_000_000_000_000n, "WETH", 18),
    delta(ADDR.USDC, 3_500_000_000n, "USDC", 6),
  ],
  unpricedDeltas: [],
  nativeWeiPositive: false,
  unpricedInTokensWithoutCounterTransfer: [],
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

// A closed cross-venue backrun can leave one venue beyond block N-1. The closed transaction flow
// is decisive; the tick heuristic must not turn it into inventory.
const tickMovedClosedAtomicStyle = classifyWinnerStyle({
  pricedDeltas: [delta(ADDR.WETH, 210_700_510_961_548n, "WETH", 18)],
  unpricedDeltas: [],
  nativeWeiPositive: false,
  nativeWeiNegative: false,
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
const unknownVerdict = buildVerdict(
  event("100", "50"),
  [competitor("unknown", "200")],
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

// v4 real-fill decode + JIT detection (synthetic PoolManager logs, no RPC). Mirrors 0xf391d0's
// c069abea leg: swapper pays 949.488853 USDC (amount1 < 0) and receives 934.46 srUSDe (amount0 > 0).
const V4_PM = lower(ADDR.UNIV4_POOL_MANAGER);
const C069ABEA = "0xc069abea3d235a4f38cb7d0219f66cc7cbbce92f0b4740bac46bef896c2277b8";
const SENDER = "0x00000000000000000000000000000000000000e0";
const v4LogIface = new ethers.Interface([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]);
function v4SwapLog(poolId: string, amount0: bigint, amount1: bigint, logIndex: number) {
  const { data, topics } = v4LogIface.encodeEventLog("Swap", [poolId, SENDER, amount0, amount1, 0n, 0n, 0, 0]);
  return { address: V4_PM, topics, data, logIndex: "0x" + logIndex.toString(16) };
}
function v4ModifyLog(poolId: string, delta: bigint, logIndex: number) {
  const { data, topics } = v4LogIface.encodeEventLog("ModifyLiquidity", [poolId, SENDER, 0, 0, delta, ethers.ZeroHash]);
  return { address: V4_PM, topics, data, logIndex: "0x" + logIndex.toString(16) };
}
// F-391 shape: a lone Swap, no ModifyLiquidity (no JIT).
const f391Receipt = { logs: [v4SwapLog(C069ABEA, 934460889828731878592n, -949488853n, 2)] };
const f391Jit = detectJitLiquidity(f391Receipt);
const f391Fills = decodeV4SwapFills(f391Receipt, new Set(f391Jit));
// JIT shape: add-liquidity (positive delta) BEFORE the swap on the same pool.
const jitReceipt = { logs: [v4ModifyLog(C069ABEA, 5_000n, 0), v4SwapLog(C069ABEA, 1n, -1n, 1)] };
const jitPools = detectJitLiquidity(jitReceipt);
const jitFills = decodeV4SwapFills(jitReceipt, new Set(jitPools));
// Add-AFTER-swap must NOT count as JIT (ordering matters).
const addAfterJit = detectJitLiquidity({ logs: [v4SwapLog(C069ABEA, 1n, -1n, 0), v4ModifyLog(C069ABEA, 5_000n, 1)] });

const checks: Array<() => void> = [
  () => assert.equal(graphMembership.status, "loaded"),
  // the fix: a v4 poolId present in active-pools is now in_graph (was a systematic false-negative)
  () => assert.equal(graphMembership.members.has(lower(V4_POOLID_IN_ACTIVE)), true),
  // a v4 poolId we do NOT index stays out of graph (real coverage gap preserved)
  () => assert.equal(graphMembership.members.has(lower(V4_POOLID_NOT_INDEXED)), false),
  // v2/v3 in_graph stays authoritative against runtime-graph
  () => assert.equal(graphMembership.members.has(lower(V3_ADDR_IN_GRAPH)), true),
  () => assert.equal(oneLegStyle, "one_leg_inventory"),
  () => assert.equal(pricedOneLegStyle, "one_leg_inventory"),
  () => assert.equal(tickForcedStyle, "one_leg_inventory"),
  () => assert.equal(tickMovedClosedAtomicStyle, "atomic_loop"),
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
  () => assert.equal(unknownVerdict.route_gap_decisive, false),
  () => assert.equal(scaleKeeperSignals.claim_selector_hit, true),
  () => assert.equal(overlayNonArbStyle("unknown", scaleKeeperSignals), "keeper_claim"),
  () => assert.equal(isNonComparableWinnerStyle("keeper_claim"), true),
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
  }), "atomic_loop"),
  // Dust is sign-symmetric and value-aware: either sign below one cent is ignored, while a
  // material stablecoin drawdown still prevents a closed-loop verdict.
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [delta(ADDR.SUSDS, 1_000_000_000_000n, "sUSDS", 18)],
    unpricedDeltas: [],
    nativeWeiPositive: true,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "atomic_loop"),
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [delta(ADDR.SUSDS, -1_000_000_000_000n, "sUSDS", 18)],
    unpricedDeltas: [],
    nativeWeiPositive: true,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
  }), "atomic_loop"),
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [delta(ADDR.SUSDS, -20_000_000_000_000_000n, "sUSDS", 18)],
    unpricedDeltas: [],
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

  // False-positive fix: atomic BUY-share-then-REDEEM (executor nets 0, share bought from a swap venue)
  // must NOT be flagged inventory — even though it is a GLOBAL net burn. This is the coffeebabe srUSDe
  // loop shape (0xf391d0 / 0x2b84e28c) the old unconditional `value<0` mis-flagged.
  () => assert.deepEqual(buyRedeemImbalance, []),
  // ...but a genuine pre-held burn (non-venue helper -> 0x0, no in-tx source) still flags.
  () => assert.deepEqual(preHeldBurnImbalance, [lower(SHARE_TOK)]),
  // Coffee #2 is a Liquity BOLD protocol mint, not an ERC4626 share position. A plain token mint
  // without Deposit/Withdraw evidence must not poison comparable atomic-loop analysis.
  () => assert.deepEqual(liquityMintImbalance, []),
  // Fluid DEX is a swap venue in canonical any-tx postmortems, not an opaque emitter.
  () => assert.deepEqual(fluidOtherVenues, [{
    protocol: "fluidDex",
    id: lower(ADDR.FLUID_DEX_USDC_USDT),
    emitter: lower(ADDR.FLUID_DEX_USDC_USDT),
    in_graph: null,
  }]),

  // Actual-receipt regressions: ten position-conserving sUSDS/ERC4626 loops carry only actor dust.
  // Counterparty and settlement-address share nets must not become competitor inventory.
  ...susdsLoopAnalyses.flatMap((analysis) => [
    () => assert.equal(analysis.style, "atomic_loop", analysis.receipt.transactionHash),
    () => assert.deepEqual(analysis.shareImbalanceTokens, [], analysis.receipt.transactionHash),
    () => assert.deepEqual(analysis.signals.external_mint_recipients, [], analysis.receipt.transactionHash),
  ]),
  // Two independent token shapes prove the retained external-mint rule is generic: direct
  // zero->recipient (GENI) and mint-to-token-then-settle-to-recipient both become non-comparable.
  ...externalMintAnalyses.flatMap((analysis) => [
    () => assert.equal(analysis.style, "one_leg_inventory", analysis.receipt.transactionHash),
    () => assert.equal(isNonComparableWinnerStyle(analysis.style), true, analysis.receipt.transactionHash),
    () => assert.deepEqual(
      analysis.signals.external_mint_recipients,
      expectedExternalMintRecipients.get(analysis.receipt.transactionHash),
      analysis.receipt.transactionHash,
    ),
  ]),

  // F-009 atomicity / inventory-rebalance detector ---------------------------------------------
  // Layer 2 (robust receipt signal): 0x9be73297 leaves a residual position in BOTH vault-share
  // tokens (steakUSDT minted, steakUSDC burned) => both flagged. Reconciles the F-009 on-chain trace.
  () => assert.deepEqual(inventoryImbalanceTokens, [lower(STEAK_USDC), lower(STEAK_USDT)].sort()),
  // Negative control: the clean atomic 4-leg AMM loop 0xf2de7499 has NO share mint/burn => empty.
  () => assert.deepEqual(atomicImbalanceTokens, []),
  // 0x9be73297 => inventory_vault_rebalance even though its executor net looks atomic (+WETH only).
  () => assert.equal(inventoryVaultStyle, "inventory_vault_rebalance"),
  () => assert.equal(isNonComparableWinnerStyle("inventory_vault_rebalance"), true),
  () => assert.equal(inventoryVaultVerdict.winner_style, "inventory_vault_rebalance"),
  () => assert.equal(inventoryVaultVerdict.non_comparable_winner, true),
  () => assert.equal(inventoryVaultVerdict.route_gap_decisive, false),
  () => assert.match(inventoryVaultVerdict.note ?? "", /inventory_vault_rebalance/),
  // Guard: hardcoded selector hit alone on a clean atomic loop (no share imbalance) does NOT
  // reclassify it — a plain ERC4626 arb calls deposit/redeem but nets zero shares. Stays atomic_loop.
  () => assert.equal(atomicWithSelectorHit, "atomic_loop"),
  // Guard: a residual share imbalance with NO selector hit STILL flags (Layer 2 is sufficient alone).
  () => assert.equal(classifyWinnerStyle({
    pricedDeltas: [delta(ADDR.WETH, 399744634603446n, "WETH", 18)],
    unpricedDeltas: [],
    nativeWeiPositive: false,
    unpricedInTokensWithoutCounterTransfer: [],
    winner_moved_price_beyond_prestate: false,
    sandwich_detected: false,
    share_imbalance_tokens: [lower(STEAK_USDT)],
    inventory_rebalance_selector_hit: false,
  }), "inventory_vault_rebalance"),
  // Regression: the plain atomic-loop fixture (no new signals passed) is unchanged.
  () => assert.equal(atomicStyle, "atomic_loop"),

  // v4 real per-leg fill decode (0xf391d0 c069abea entry leg) -----------------------------------
  () => assert.equal(f391Fills.length, 1),
  () => assert.equal(f391Fills[0].poolId, lower(C069ABEA)),
  // USDC paid in (amount1 < 0), srUSDe received (amount0 > 0) => oneForZero, i.e. NOT zeroForOne.
  () => assert.equal(f391Fills[0].amount1, "-949488853"),
  () => assert.equal(f391Fills[0].amount0, "934460889828731878592"),
  () => assert.equal(f391Fills[0].zeroForOne, false),
  () => assert.equal(f391Fills[0].jit, false),
  () => assert.deepEqual(f391Jit, []),
  // JIT detection: add-before-swap on the same pool flags it; the fill carries jit=true.
  () => assert.deepEqual(jitPools, [lower(C069ABEA)]),
  () => assert.equal(jitFills[0].jit, true),
  // Ordering guard: liquidity added AFTER the swap is not JIT.
  () => assert.deepEqual(addAfterJit, []),
];

try {
  for (const check of checks) check();
  rmSync(graphFixtureDir, { recursive: true, force: true });
  console.log(`bundle-postmortem-noise-filter PASS (${checks.length}/${checks.length})`);
  console.log("expected_transition: ten sUSDS/ERC4626 receipts inventory_vault_rebalance->atomic_loop with no vault-inventory signal; two externally retained mint receipts atomic_loop->one_leg_inventory with explicit recipients; private-helper control 0x9be73297 remains inventory_vault_rebalance. verdict: fixed");
} catch (err) {
  console.error(`bundle-postmortem-noise-filter FAIL: ${(err as Error).message}`);
  process.exit(1);
}

function analyzeActualReceiptFixture(receipt: ActualReceiptFixture) {
  const actors = new Set([lower(receipt.from), lower(receipt.to)]);
  const rawDeltas = actionsFromLogs(receipt, [...actors]).rawDeltas;
  const valued = valueDeltas(rawDeltas, 3500);
  const shareImbalanceTokens = shareTokenImbalanceTokens(receipt, actors);
  const signals = detectNonArbSignals(null, receipt, actors, null);
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
    inventory_rebalance_selector_hit: false,
  });
  return {
    receipt,
    shareImbalanceTokens,
    signals,
    style: overlayNonArbStyle(base, signals),
  };
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
