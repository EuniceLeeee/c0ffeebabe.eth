import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import {
  assessRouteGapAnalysis,
  extractOtherVenues,
  learningCaseFromPostmortem,
  resolveLandedTouchedVenues,
  type PostmortemReport,
} from "../cli/bundle-postmortem.js";
import {
  deriveEdgeKindsFromLogs,
  deriveEdgeKindsFromLogsAndTrace,
  deriveProtocolActionsFromLogs,
} from "../learning/edge-kinds.js";
import { requireProductionRouteCallRegistry } from "../learning/production-route-calls.js";
import {
  advanceStatus,
  loadCases,
  type LearningCase,
  upsertCase,
} from "../learning/learning-case.js";
import { TOPICS } from "../registry/protocols.js";
import {
  classifyTxShape,
  type RawLog,
  type TxShapeResult,
} from "../pnl/tx-shape.js";
import { strategyKindFromTxShape } from "../../../listener/src/searcher/strategy-taxonomy.js";

interface CoffeeFixture {
  label: string;
  txHash: string;
  block: number;
  txIndex: number;
  arbPools: string[];
  receiptLogs: RawLog[];
  sameBlockSwapLogs: RawLog[];
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(TEST_DIR, "fixtures");
const COFFEE_DIR = join(FIXTURES_DIR, "coffee-20260704");
const CENSUS_REPORT_SOURCE = resolve(TEST_DIR, "../cli/census-report.ts");
const FIXED_TIME = "2026-07-04T00:00:00.000Z";

test("postmortem fixtures fold into the merged LearningCase schema", () => {
  const a32b = learningCaseFromPostmortem(readJsonFixture<PostmortemReport>("postmortem-0xa32b/report.json"));
  assert.equal(a32b.strategy_kind, "backrun");
  assert.equal(a32b.primary_gap, "venue_missing");
  assert.equal(a32b.comparable, true);
  assert.deepEqual(a32b.edge_kinds, ["swap"]);

  const ee7b = learningCaseFromPostmortem(readJsonFixture<PostmortemReport>("postmortem-0xee7b98ad/report.json"));
  assert.equal(ee7b.primary_gap, "non_comparable_winner");
  assert.equal(ee7b.comparable, false);
  assert.equal("close_action" in ee7b, false);
});

test("deriveEdgeKindsFromLogs classifies topic0 into stable edge kinds", () => {
  assert.deepEqual(deriveEdgeKindsFromLogs([
    { topics: [TOPICS.balancerV2FlashLoan] },
    { topics: [TOPICS.univ4Swap] },
    { topics: [TOPICS.curveTokenExchange] },
  ]), ["flash", "swap"]);

  assert.deepEqual(deriveEdgeKindsFromLogs([
    { topics: [TOPICS.morphoBorrow] },
    { topics: [TOPICS.univ3Swap] },
  ]), ["swap", "credit"]);

  assert.deepEqual(deriveEdgeKindsFromLogs([
    { topics: [TOPICS.univ3Mint] },
  ]), ["lp"]);

  assert.deepEqual(deriveEdgeKindsFromLogs([
    { topics: [TOPICS.liquityTroveOperation] },
    { topics: [TOPICS.liquityTroveUpdated] },
    { topics: [TOPICS.liquityBatchUpdated] },
  ]), ["protocol"]);

  assert.deepEqual(deriveEdgeKindsFromLogs([
    { topics: [TOPICS.pancakeV3Swap] },
    { topics: [TOPICS.dodoSwap] },
    { topics: [TOPICS.erc4626Deposit] },
  ]), ["swap", "protocol"]);

  assert.deepEqual(deriveEdgeKindsFromLogs([
    { topics: [TOPICS.erc4626Withdraw] },
  ]), ["protocol"]);

  // Sky LitePSM SellGem/BuyGem (node-verified topic0s) = a protocol convert leg.
  assert.deepEqual(deriveEdgeKindsFromLogs([{ topics: [TOPICS.psmSellGem] }]), ["protocol"]);
  assert.deepEqual(deriveEdgeKindsFromLogs([{ topics: [TOPICS.psmBuyGem] }]), ["protocol"]);
  assert.deepEqual(deriveProtocolActionsFromLogs([{ topics: [TOPICS.psmSellGem] }]), ["convert"]);

  assert.deepEqual(deriveEdgeKindsFromLogs([
    { topics: ["0x0000000000000000000000000000000000000000000000000000000000000000"] },
  ]), []);

  assert.deepEqual(deriveEdgeKindsFromLogs(undefined), []);
  assert.deepEqual(deriveEdgeKindsFromLogs(null), []);
});

test("production-registered GOLDx mint adds protocol only for the successful registered target", async () => {
  const registry = await requireProductionRouteCallRegistry();
  const matchesProtocolCall = (target: string, callSelector: string) =>
    registry.matchesProtocolCall(target, callSelector);
  const selector = ethers.id("mint(address,uint256)").slice(0, 10);
  const goldx = registry.pools.find((pool) => pool.adapter === "goldx");
  assert(goldx, "production GOLDx pool missing");
  const swapLogs = [{ topics: [TOPICS.univ3Swap] }];
  assert.deepEqual(deriveEdgeKindsFromLogsAndTrace(swapLogs, {
    to: "0x0000000000000000000000000000000000000001",
    input: "0xdeadbeef",
    calls: [{ to: goldx.address, input: selector }],
  }, matchesProtocolCall), ["swap", "protocol"]);
  assert.deepEqual(deriveEdgeKindsFromLogsAndTrace(swapLogs, {
    to: "0x0000000000000000000000000000000000000002",
    input: selector,
  }, matchesProtocolCall), ["swap"]);
  assert.deepEqual(deriveEdgeKindsFromLogsAndTrace(swapLogs, {
    to: goldx.address,
    input: selector,
    error: "execution reverted",
  }, matchesProtocolCall), ["swap"]);
});

test("production-registered RockSolid syncDeposit needs no analysis target list", async () => {
  const registry = await requireProductionRouteCallRegistry();
  const matchesProtocolCall = (target: string, callSelector: string) =>
    registry.matchesProtocolCall(target, callSelector);
  const selector = ethers.id("syncDeposit(uint256,address,address)").slice(0, 10);
  const rocksolid = registry.pools.find((pool) => pool.adapter === "rocksolid");
  assert(rocksolid, "production RockSolid pool missing");
  const swapLogs = [{ topics: [TOPICS.univ3Swap] }];
  assert.deepEqual(deriveEdgeKindsFromLogsAndTrace(swapLogs, {
    to: rocksolid.address,
    input: selector,
  }, matchesProtocolCall), ["swap", "protocol"]);
  assert.deepEqual(deriveEdgeKindsFromLogsAndTrace(swapLogs, {
    to: "0x0000000000000000000000000000000000000001",
    input: selector,
  }, matchesProtocolCall), ["swap"]);
  assert.deepEqual(deriveEdgeKindsFromLogsAndTrace(swapLogs, {
    to: rocksolid.address,
    input: selector,
    error: "execution reverted",
  }, matchesProtocolCall), ["swap"]);
  assert.deepEqual(deriveEdgeKindsFromLogsAndTrace(swapLogs, {
    to: "0x0000000000000000000000000000000000000001",
    input: "0xdeadbeef",
    error: "execution reverted",
    calls: [{ to: rocksolid.address, input: selector }],
  }, matchesProtocolCall), ["swap"]);

  const derivedTarget = "0x00000000000000000000000000000000000000aa";
  assert.deepEqual(deriveEdgeKindsFromLogsAndTrace(swapLogs, {
    to: derivedTarget,
    input: selector,
  }, (target, callSelector) => registry.matchesProtocolCall(
    target,
    callSelector,
    [{ address: derivedTarget, adapter: "rocksolid" }],
  )), ["swap", "protocol"]);
});

test("route gap analysis fails closed when a non-swap leg has not been ordered", () => {
  assert.deepEqual(assessRouteGapAnalysis(["flash", "swap"]), {
    status: "swap_venues_only",
    unresolved_edge_kinds: [],
  });
  assert.deepEqual(assessRouteGapAnalysis(["flash", "swap", "protocol"]), {
    status: "manual_required",
    reason: "non_swap_leg_order_unresolved",
    unresolved_edge_kinds: ["protocol"],
  });
  assert.deepEqual(assessRouteGapAnalysis(["swap", "credit", "lp"]), {
    status: "manual_required",
    reason: "non_swap_leg_order_unresolved",
    unresolved_edge_kinds: ["credit", "lp"],
  });
  assert.deepEqual(assessRouteGapAnalysis(["flash", "swap"], "logs_only"), {
    status: "manual_required",
    reason: "call_trace_unavailable",
    unresolved_edge_kinds: [],
  });
});

test("landed venue facts preserve unknown factory and Curve underlying adapter", async () => {
  const moxiePool = "0x1bc6104bf242ac7047d1d50f01bb02529a0c7250";
  const moxieFactory = "0x197F4d712D0544E6aE1417867e1f066fc54Dcff8";
  const factoryIface = new ethers.Interface(["function factory() view returns (address)"]);
  const v2Receipt = { logs: [{ address: moxiePool, topics: [TOPICS.univ2Swap] }] };
  const venues = await resolveLandedTouchedVenues({
    call: async <T>(_method: string, params: unknown[] = []): Promise<T> => {
      assert.equal(params[1], "0x185a0af");
      return factoryIface.encodeFunctionResult("factory", [moxieFactory]) as T;
    },
  }, v2Receipt, null, 25534639);
  assert.equal(venues[0]?.protocol, "univ2", "topic remains an event-family observation");
  assert.equal(venues[0]?.venue_id, "unknown");
  assert.equal(venues[0]?.factory, moxieFactory.toLowerCase());
  assert.equal(venues[0]?.landed_adapter, null);

  const curveUnderlyingIface = new ethers.Interface([
    "event TokenExchangeUnderlying(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)",
  ]);
  const encoded = curveUnderlyingIface.encodeEventLog("TokenExchangeUnderlying", [
    "0x0000000000000000000000000000000000000001", 3, 100n, 2, 101n,
  ]);
  const other = extractOtherVenues({
    logs: [{
      address: "0xfe0a8e9d60131404ffaee95b48ebf908f4d8d808",
      topics: encoded.topics,
      data: encoded.data,
    }],
  }, null);
  assert.equal(other[0]?.landed_adapter, "curve-exchange-underlying");
});

test("coffee tx-2 (Liquity BOLD mint) flips to [flash,swap,protocol] with a mint action", () => {
  const tx2 = loadCoffeeFixture("2");

  // Fixture-verification: the computed Liquity topic0s MUST be what the Liquity emitter actually
  // logged (0x962110f2… / 0x0fba2673… / 0xecf6daab…) — a hash mismatch fails here, not silently.
  const topic0s = new Set(tx2.receiptLogs.map((log) => log.topics[0]?.toLowerCase()));
  assert.ok(topic0s.has(TOPICS.liquityTroveOperation.toLowerCase()), "tx-2 emits TroveOperation");
  assert.ok(topic0s.has(TOPICS.liquityTroveUpdated.toLowerCase()), "tx-2 emits TroveUpdated");
  assert.ok(topic0s.has(TOPICS.liquityBatchUpdated.toLowerCase()), "tx-2 emits BatchUpdated");

  // Rule-12 flip: was ["flash","swap"] (protocol legs invisible), now the Liquity leg is seen.
  assert.deepEqual(deriveEdgeKindsFromLogs(tx2.receiptLogs), ["flash", "swap", "protocol"]);
  // BOLD (0x6440f144…) mints via Transfer(from=0x0) — the generic mint heuristic must observe it.
  assert.ok(deriveProtocolActionsFromLogs(tx2.receiptLogs).includes("mint"));
});

test("coffee tx-4 recognizes the pancake-v3 and DODO swap topics", () => {
  const tx4 = loadCoffeeFixture("4");

  const topic0s = new Set(tx4.receiptLogs.map((log) => log.topics[0]?.toLowerCase()));
  assert.ok(topic0s.has(TOPICS.pancakeV3Swap.toLowerCase()), "tx-4 emits pancake-v3 Swap");
  assert.ok(topic0s.has(TOPICS.dodoSwap.toLowerCase()), "tx-4 emits DODOSwap");

  assert.ok(deriveEdgeKindsFromLogs(tx4.receiptLogs).includes("swap"));
  // The new topics classify as swap on their own (not just via tx-4's uni legs).
  assert.deepEqual(deriveEdgeKindsFromLogs([{ topics: [TOPICS.pancakeV3Swap] }]), ["swap"]);
  assert.deepEqual(deriveEdgeKindsFromLogs([{ topics: [TOPICS.dodoSwap] }]), ["swap"]);
});

test("coffee tx-7 (unresolved venue) derives without crashing — explicit unknown, not a silent misclassification", () => {
  // tx-7's three topic0s (0x554841bb…, 0x6c51882b…, 0x8580f507…) have no verified signature yet
  // (plausibly Fluid DEX; candidate signatures did not match). Until the venue is resolved we assert
  // only that derivation is total (no crash) — no specific classification is pinned here.
  const tx7 = loadCoffeeFixture("7");
  assert.equal(tx7.arbPools.length, 0);
  const kinds = deriveEdgeKindsFromLogs(tx7.receiptLogs);
  const actions = deriveProtocolActionsFromLogs(tx7.receiptLogs);
  assert.ok(Array.isArray(kinds));
  assert.ok(Array.isArray(actions));
  // None of tx-7's logs are Transfers, so the mint heuristic must not fire on its zero-topic1 log.
  assert.equal(actions.includes("mint"), false);
});

test("learningCaseFromPostmortem carries derived edgeKinds and preserves old-report swap fallback", () => {
  const derivedReport = readJsonFixture<PostmortemReport>("postmortem-0xa32b/report.json");
  const derivedWinner = winnerInReport(derivedReport);
  derivedWinner.edgeKinds = ["flash", "swap"];
  assert.deepEqual(learningCaseFromPostmortem(derivedReport).edge_kinds, ["flash", "swap"]);

  const oldReport = readJsonFixture<PostmortemReport>("postmortem-0xa32b/report.json");
  const oldWinner = winnerInReport(oldReport);
  delete (oldWinner as { edgeKinds?: unknown }).edgeKinds;
  assert.ok(oldWinner.touchedVenues.length > 0, "fixture winner has touched venues");
  assert.deepEqual(learningCaseFromPostmortem(oldReport).edge_kinds, ["swap"]);

  const logsOnlyReport = readJsonFixture<PostmortemReport>("postmortem-0xa32b/report.json");
  const logsOnlyWinner = winnerInReport(logsOnlyReport);
  logsOnlyWinner.edgeKindEvidence = "logs_only";
  logsOnlyReport.verdict.route_gap_decisive = true;
  const logsOnlyCase = learningCaseFromPostmortem(logsOnlyReport);
  assert.equal(logsOnlyCase.primary_gap, "manual_required");
  assert.equal(logsOnlyCase.evidence.edge_kind_evidence, "logs_only");
});

test("coffee tx-shape fixtures construct competitor-observation LearningCases", () => {
  const cases = loadCoffeeFixtures().map((fixture) => {
    const shape = classifyTxShape({
      receiptLogs: fixture.receiptLogs,
      txIndex: fixture.txIndex,
      sameBlockSwapLogs: fixture.sameBlockSwapLogs,
    });
    return learningCaseFromCoffeeFixture(fixture, shape);
  });

  const blockScanCases = cases.filter((c) =>
    c.strategy_kind === "block-scan"
    && c.primary_gap === "scan_not_triggered"
    && c.trigger === "competitor_not_seen"
  );
  const backrunCases = cases.filter((c) =>
    c.strategy_kind === "backrun"
    && c.primary_gap === "source_not_seen"
    && c.gap_detail === "router_not_watched"
    && c.trigger === "competitor_not_seen"
  );

  assert.equal(blockScanCases.length, 8);
  assert.equal(backrunCases.length, 1);
});

test("unknown strategy cases are forced to manual_required and cannot advance toward close", () => {
  withTempStore(() => {
    const unknown = baseLearningCase({
      learning_case_id: "test-unknown",
      strategy_kind: "unknown",
      status: "open",
      trigger: "competitor_not_seen",
      comparable: false,
      primary_gap: "manual_required",
      close_action: { kind: "should_be_stripped" },
    });

    const stored = upsertCase(unknown);
    assert.equal(stored.status, "manual_required");
    assert.equal(stored.close_action, undefined);
    assert.deepEqual(loadCases().map((c) => c.learning_case_id), ["test-unknown"]);
    assert.throws(() => advanceStatus("test-unknown", "proposed_close"), /Cannot advance/);
  });
});

test("LearningCase store upserts are idempotent and status is forward-only", () => {
  withTempStore(() => {
    const c = baseLearningCase({
      learning_case_id: "test-idempotent",
      strategy_kind: "backrun",
      status: "open",
      trigger: "bundle_not_included",
      comparable: true,
      primary_gap: "venue_missing",
    });

    upsertCase(c);
    upsertCase(c);
    assert.equal(loadCases().length, 1);
    assert.equal(loadCases()[0].status, "open");

    advanceStatus("test-idempotent", "proposed_close");
    advanceStatus("test-idempotent", "replay_passed");
    advanceStatus("test-idempotent", "applied");
    upsertCase(c);
    assert.equal(loadCases()[0].status, "applied");
    assert.throws(() => advanceStatus("test-idempotent", "open"), /Backward/);
  });
});

test("credit reference arb 0xf88b folds into an S1 LearningCase (edge_kinds flash+credit+swap, strategy from source evidence)", () => {
  withTempStore(() => {
    // CR-3 analysis gate. 0xf88b = the wstUSR reference arb (Morpho flash + Fluid credit leg + DEX
    // swaps). Anti-binding rule: strategy_kind comes from SOURCE EVIDENCE (its source swap is tx
    // index 0 => backrun), NEVER from the credit leg. The S1 schema must carry the credit + flash
    // edge kinds and still let the case advance toward close (credit does not force manual_required).
    const c = baseLearningCase({
      learning_case_id: "credit-0xf88b",
      strategy_kind: "backrun",
      status: "open",
      trigger: "bundle_not_included",
      comparable: true,
      primary_gap: "venue_missing",
      edge_kinds: ["flash", "credit", "swap"],
      competitor_tx: "0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970",
    });
    upsertCase(c);

    const loaded = loadCases().find((x) => x.learning_case_id === "credit-0xf88b");
    assert.ok(loaded, "credit case persisted");
    assert.deepEqual(loaded.edge_kinds, ["flash", "credit", "swap"]);
    assert.equal(loaded.strategy_kind, "backrun");

    // A known (non-"unknown") strategy_kind advances toward close — NOT short-circuited to
    // manual_required — proving a credit edge_kind is closable, not blocked, by the schema.
    advanceStatus("credit-0xf88b", "proposed_close");
    assert.equal(
      loadCases().find((x) => x.learning_case_id === "credit-0xf88b")?.status,
      "proposed_close",
    );
  });
});

test("census-report source emits tx_shape and omits the banned field name", () => {
  const source = readFileSync(CENSUS_REPORT_SOURCE, "utf8");
  assert.match(source, /\btx_shape\b/);
  assert.equal(source.includes(`atomic${"_scan_shape"}`), false);
});

function learningCaseFromCoffeeFixture(fixture: CoffeeFixture, txShape: TxShapeResult): LearningCase {
  const strategy_kind = strategyKindFromTxShape(txShape.shape);
  const isBackrun = txShape.shape === "backrun";
  return baseLearningCase({
    learning_case_id: `coffee-${fixture.txHash}-${txShape.shape}`,
    status: strategy_kind === "unknown" ? "manual_required" : "open",
    strategy_kind,
    edge_kinds: deriveEdgeKindsFromLogs(fixture.receiptLogs),
    trigger: "competitor_not_seen",
    competitor_tx: fixture.txHash,
    source_block: fixture.block - 1,
    target_block: fixture.block,
    comparable: true,
    primary_gap: isBackrun ? "source_not_seen" : txShape.shape === "atomic_state_arb" ? "scan_not_triggered" : "manual_required",
    gap_detail: isBackrun ? "router_not_watched" : undefined,
    evidence: {
      tx_shape: txShape.shape,
      source_swap_hash: txShape.source_swap_hash,
      source_router: txShape.source_router,
    },
  });
}

function baseLearningCase(overrides: Partial<LearningCase> & Pick<
  LearningCase,
  "learning_case_id" | "strategy_kind" | "status" | "trigger" | "comparable" | "primary_gap"
>): LearningCase {
  return {
    edge_kinds: [],
    evidence: {},
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    ...overrides,
  };
}

function loadCoffeeFixtures(): CoffeeFixture[] {
  const index = JSON.parse(readFileSync(join(COFFEE_DIR, "index.json"), "utf8")) as Array<{ label: string }>;
  return index.map((entry) => loadCoffeeFixture(entry.label));
}

function loadCoffeeFixture(label: string): CoffeeFixture {
  return JSON.parse(readFileSync(join(COFFEE_DIR, `tx-${label}.json`), "utf8")) as CoffeeFixture;
}

function readJsonFixture<T>(path: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, path), "utf8")) as T;
}

function winnerInReport(report: PostmortemReport): NonNullable<PostmortemReport["analyzed_competitors"]>[number] {
  const winner = report.analyzed_competitors?.find((tx) => tx.hash === report.verdict.winner)
    ?? report.analyzed_competitors?.[0];
  assert.ok(winner, "postmortem report has an analyzed competitor");
  return winner;
}

function withTempStore(fn: () => void): void {
  const oldPath = process.env.LEARNING_CASE_STORE_PATH;
  const dir = mkdtempSync(join(tmpdir(), "learning-case-store-"));
  process.env.LEARNING_CASE_STORE_PATH = join(dir, "store.json");
  try {
    fn();
  } finally {
    if (oldPath === undefined) delete process.env.LEARNING_CASE_STORE_PATH;
    else process.env.LEARNING_CASE_STORE_PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
}
