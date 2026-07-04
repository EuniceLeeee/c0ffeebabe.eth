import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  learningCaseFromPostmortem,
  type PostmortemReport,
} from "../cli/bundle-postmortem.js";
import {
  advanceStatus,
  loadCases,
  type LearningCase,
  upsertCase,
} from "../learning/learning-case.js";
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
    edge_kinds: txShape.arb_pools.length > 0 ? ["swap"] : [],
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
  return index.map((entry) =>
    JSON.parse(readFileSync(join(COFFEE_DIR, `tx-${entry.label}.json`), "utf8")) as CoffeeFixture
  );
}

function readJsonFixture<T>(path: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, path), "utf8")) as T;
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
