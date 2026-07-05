import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EdgeKind, StrategyKind } from "../../../listener/src/searcher/strategy-taxonomy.js";

export type PrimaryGap =
  // intake (pre-funnel): source_not_seen = backrun's intake gap; scan_not_triggered = block-scan's:
  | "source_not_seen" | "scan_not_triggered" | "edge_kind_disabled"
  // view/graph:
  | "view_missing" | "venue_missing"
  // execution capability (NEW in v2 — the venue-adapter-epic dispatch key both reviewers found missing):
  | "adapter_missing"
  // path/plan:
  | "path_not_found"
  // pricing/sizing:
  | "quote_failed" | "sizing_failed"
  // sim:
  | "sim_failed"
  // economics:
  | "below_ev" | "gas_underwater" | "liquidity_or_cap_bound"
  // auction:
  | "outbid" | "lost_intra_lane_priority"
  // terminals (no close action):
  | "non_comparable_winner" | "standing_position_required" | "oracle_not_diverged" | "edge_inactive"
  | "replay_state_unavailable" | "manual_required";

export interface LearningCase {
  learning_case_id: string;
  status: "open" | "proposed_close" | "replay_passed" | "applied" | "live_verified"
        | "parked_uneconomic" | "manual_required";          // forward-only (impl plan §1.5 rules)
  /** "unknown" is legal ONLY on competitor-observation cases; an "unknown" strategy_kind
   *  short-circuits to manual_required — no close action may consume it. */
  strategy_kind: StrategyKind | "unknown";
  edge_kinds: EdgeKind[];
  trigger: "bundle_not_included" | "competitor_not_seen";
  competitor_tx?: string;
  our_opportunity_id?: string;
  source_block?: number;      // block-scan: competitor_execution_block − 1 (user pt 1)
  target_block?: number;
  cycle_fingerprint?: string;
  comparable: boolean;
  primary_gap: PrimaryGap;    // FIRST blocking gap, funnel order
  gap_detail?: string;        // owner routing (single string)
  secondary_gaps?: PrimaryGap[];   // optional additional funnel positions (ADR-a's secondaryGaps)
  our_stage?: string;
  strategy_view_version?: string;
  backrun_view_hash?: string; blockscan_view_hash?: string;
  capability_replay_stage?: string;  live_admission_stage?: string;
  evidence: Record<string, unknown>;
  /** rule 16: set when MANUAL (Fable) analysis found our analysis TOOL itself wrong/insufficient.
   *  An OPEN tooling_defect BLOCKS hermes-gate cycle-close until codified or human-killed. */
  tooling_defect?: {
    tool: string;            // which analysis tool/script/metric was wrong or missing
    issue: string;           // what was wrong (valuation artifact / missing metric / mis-classification)
    evidence: string;        // concrete proof
    codify_target: string;   // the file/tool + what to add (a field / test / gate)
    codify_commit?: string;  // git ref of the fix (required when status === "codified")
    status: "open" | "codified" | "human_killed";
  };
  close_action?: { kind: string; target_file?: string; entries?: string[] };
  replay_gate?: { command: string; expected_transition: string; before?: string; after?: string };
  created_at: string; updated_at: string;
}

interface LearningCaseStore {
  cases: LearningCase[];
}

const DEFAULT_STORE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../learning-cases/store.json",
);
const STATUS_ORDER: Record<LearningCase["status"], number> = {
  open: 0,
  proposed_close: 1,
  replay_passed: 2,
  applied: 3,
  live_verified: 4,
  parked_uneconomic: 100,
  manual_required: 100,
};
const TERMINAL_STATUSES = new Set<LearningCase["status"]>([
  "parked_uneconomic",
  "manual_required",
]);
const TERMINAL_PRIMARY_GAPS = new Set<PrimaryGap>([
  "non_comparable_winner",
  "standing_position_required",
  "oracle_not_diverged",
  "edge_inactive",
  "replay_state_unavailable",
  "manual_required",
]);

export function loadCases(): LearningCase[] {
  return readStore().cases;
}

export function upsertCase(c: LearningCase): LearningCase {
  const nextCase = normalizeCaseForStore(c);
  const store = readStore();
  const index = store.cases.findIndex((item) => item.learning_case_id === nextCase.learning_case_id);
  if (index === -1) {
    store.cases.push(nextCase);
    writeStore(store);
    return nextCase;
  }

  const existing = store.cases[index];
  const status = forwardStatus(existing.status, nextCase.status);
  const merged = normalizeCaseForStore({
    ...existing,
    ...nextCase,
    status,
    created_at: existing.created_at,
  });
  store.cases[index] = merged;
  writeStore(store);
  return merged;
}

export function advanceStatus(id: string, next: LearningCase["status"]): LearningCase {
  const store = readStore();
  const index = store.cases.findIndex((item) => item.learning_case_id === id);
  if (index === -1) throw new Error(`LearningCase not found: ${id}`);

  const current = store.cases[index];
  if (current.status === next) return current;
  if (current.strategy_kind === "unknown" && next !== "manual_required") {
    throw new Error(`Cannot advance unknown-strategy LearningCase ${id} to ${next}`);
  }
  if (TERMINAL_PRIMARY_GAPS.has(current.primary_gap)) {
    throw new Error(`Cannot advance terminal-gap LearningCase ${id} with primary_gap=${current.primary_gap}`);
  }
  if (TERMINAL_STATUSES.has(current.status)) {
    throw new Error(`Cannot advance terminal LearningCase ${id} from ${current.status} to ${next}`);
  }
  if (STATUS_ORDER[next] < STATUS_ORDER[current.status]) {
    throw new Error(`Backward LearningCase status transition for ${id}: ${current.status} -> ${next}`);
  }

  const updated = normalizeCaseForStore({ ...current, status: next });
  store.cases[index] = updated;
  writeStore(store);
  return updated;
}

function normalizeCaseForStore(c: LearningCase): LearningCase {
  if (!c.learning_case_id) throw new Error("LearningCase.learning_case_id is required");
  if (c.strategy_kind === "unknown") {
    if (c.trigger !== "competitor_not_seen") {
      throw new Error("Unknown strategy_kind is only legal for competitor_not_seen LearningCases");
    }
    return {
      ...c,
      status: "manual_required",
      close_action: undefined,
    };
  }
  if (TERMINAL_PRIMARY_GAPS.has(c.primary_gap)) {
    return {
      ...c,
      status: c.primary_gap === "manual_required" ? "manual_required" : c.status,
      close_action: undefined,
    };
  }
  return c;
}

function forwardStatus(
  current: LearningCase["status"],
  next: LearningCase["status"],
): LearningCase["status"] {
  if (current === next) return current;
  if (TERMINAL_STATUSES.has(current)) return current;
  if (TERMINAL_STATUSES.has(next)) return next;
  return STATUS_ORDER[next] > STATUS_ORDER[current] ? next : current;
}

function storePath(): string {
  return process.env.LEARNING_CASE_STORE_PATH || DEFAULT_STORE_PATH;
}

function readStore(): LearningCaseStore {
  const path = storePath();
  if (!existsSync(path)) return { cases: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LearningCaseStore>;
  return { cases: Array.isArray(parsed.cases) ? parsed.cases : [] };
}

function writeStore(store: LearningCaseStore): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
}
