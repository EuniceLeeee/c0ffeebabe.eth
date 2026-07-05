import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadCases, type LearningCase } from "../learning/learning-case.js";

/** Walk up from a path to the git repo root (dir containing .git); fallback = cwd. */
function repoRoot(from: string): string {
  let dir = resolve(dirname(from));
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Hermes close-gate (forcing function for the mandatory Step-1 competitor
 * cross-reference, HERMES.md §Mechanics Step-1).
 *
 * Purpose: make it IMPOSSIBLE to close a cycle / write "Final Approval" on a
 * measured live/dry-run window without an actual Step-1 competitor
 * cross-reference for THAT window. Prose in the md cannot satisfy this — a
 * structured artifact with per-watchlist-EOA findings must exist on disk and be
 * consistent with the declared window. This is the gate that was missing when
 * cycle 20260702-v3fork Slice 2 closed on metrics only.
 *
 * Contract: the Hermes md must contain one fenced ```step1 block:
 *   ```step1
 *   run_id: 20260702-v3fork
 *   window_blocks: 25442352..25442520
 *   watchlist: 0xc0ffee...,0xae2f...
 *   artifact: docs/research/reports/step1-20260702-v3fork.json
 *   method: manual-onchain-trace   # or: live-loss-watch
 *   fable_manual: no               # yes|no
 *   ```
 *
 * The artifact is either:
 *   - a JSON manifest (method: manual-onchain-trace) with { run_id, window:{from,to},
 *     watchlist:[...], intake_audit:{pending_received,pending_filtered,mevshare_enabled},
 *     findings:[ { eoa, txCount, txs?:[{hash,block,class,source_flow?,seen_in_our_feed?,pools:[{addr,inGraph}],gap_class}] } ] }, or
 *   - a directory of `analysis live-loss --watch` outputs (method: live-loss-watch):
 *     ≥1 `*.json` WatchReport with a `block` inside the window.
 *
 * Usage: npm run hermes-gate -- <hermes-md-file>
 * Exit 0 = PASS (Step-1 evidence present + consistent → may write Final Approval).
 * Exit 1 = FAIL (blocking).
 */

export const fails: string[] = [];
function fail(msg: string): void {
  fails.push(msg);
}

function isPlaceholder(v: string): boolean {
  const t = v.trim();
  return t === ""
    || t.startsWith("<")
    || /<[^>]+>/.test(t)
    || t.includes(" | ")
    || /^(todo|tbd|n\/a|na|fill|pending)$/i.test(t);
}

const METHOD_TRACE_FIELDS = [
  "task_class",
  "tools_used",
  "evidence_order",
  "analysis_frame",
  "sanity_checks",
  "tool_gap",
  "codify_next",
  "distill_for_opus",
];

const ARCH_AXES: { key: string; re: RegExp }[] = [
  { key: "strategy_source", re: /strategy[\s_/-]*source/i },
  { key: "edge_model", re: /edge[\s_/-]*model/i },
  { key: "universe_admission", re: /universe|admission/i },
  { key: "planner", re: /planner/i },
  { key: "quote_pnl", re: /quote|pnl|p&l/i },
  { key: "state_freshness", re: /state|freshness|latency/i },
  { key: "sim_replay", re: /\bsim\b|replay/i },
  { key: "execution", re: /execution|builder/i },
  { key: "safety_position", re: /safety|position/i },
  { key: "learning_autoclose", re: /learning|auto[\s-]*close/i },
  { key: "observability_tooling", re: /observability|tooling/i },
  { key: "non_goals_isolation", re: /non[\s-]*goals?|isolation/i },
];

export function validateToolingDefects(cases: LearningCase[]): void {
  for (const c of cases) {
    const td = c.tooling_defect;
    if (!td) continue;
    const status = td.status;
    if (status !== "open" && status !== "codified" && status !== "human_killed") {
      fail(`LearningCase ${c.learning_case_id} tooling_defect.status invalid: ${String(status)} — must be open|codified|human_killed`);
    } else if (status === "open") {
      fail(`LearningCase ${c.learning_case_id} tooling_defect OPEN (${td.tool}: ${td.issue}) — a manual-`
        + `analysis-found tool error/omission MUST be codified (status:codified + codify_commit) or `
        + `human_killed before cycle-close (rule 16).`);
    } else if (status === "codified"
        && (typeof td.codify_commit !== "string" || td.codify_commit.trim() === "" || isPlaceholder(td.codify_commit))) {
      fail(`LearningCase ${c.learning_case_id} tooling_defect status=codified but codify_commit missing/`
        + `placeholder — cite the git ref that fixed the tool.`);
    }
  }
}

export function validateStep1RequiredFields(step1: Record<string, string>): void {
  for (const key of ["run_id", "window_blocks", "watchlist", "artifact", "method", "fable_manual"]) {
    if (!(key in step1) || isPlaceholder(step1[key])) fail(`step1.${key} missing or placeholder`);
  }
  if ("fable_manual" in step1 && step1.fable_manual !== "yes" && step1.fable_manual !== "no") {
    fail(`step1.fable_manual invalid: ${step1.fable_manual} — must be exactly yes or no`);
  }
}

export function validateMethodTrace(
  md: string,
  step1: Record<string, string>,
  cases: LearningCase[],
): void {
  if (step1.fable_manual !== "yes") return;
  const blocks = [...md.matchAll(/##\s*Method Trace[\s\S]*?(?=\n##\s|$)/gi)].map((m) => m[0]);
  if (blocks.length === 0) {
    fail("Fable manual analysis present but no `## Method Trace` block — missing = invalid handoff (rule 16).");
    return;
  }

  const blockFailures: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const errors = validateMethodTraceBlock(blocks[i], cases);
    if (errors.length === 0) {
      const taskClass = (blocks[i].match(/^\s*task_class\s*:\s*(.+)$/mi)?.[1] ?? "").trim();
      if (taskClass === "architecture_review") validateArchitectureCoverage(md);
      return;
    }
    const prefix = blocks.length === 1 ? "" : `Method Trace block ${i + 1}: `;
    for (const err of errors) blockFailures.push(`${prefix}${err}`);
  }
  for (const err of blockFailures) fail(err);
}

export function validateArchitectureCoverage(md: string): void {
  const m = md.match(/##\s*Architecture Coverage Matrix[\s\S]*?(?=\n##\s|$)/i);
  if (!m) {
    fail("task_class:architecture_review but no `## Architecture Coverage Matrix` section — the 12-axis "
      + "matrix is mandatory (HERMES rule 13/16).");
    return;
  }

  const rows = m[0]
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && !/^\s*\|[\s:|-]+\|?\s*$/.test(l));
  for (const axis of ARCH_AXES) {
    const row = rows.find((r) => axis.re.test((r.split("|").map((c) => c.trim())[1]) ?? ""));
    if (!row) {
      fail(`Architecture Coverage Matrix missing axis: ${axis.key}`);
      continue;
    }
    const decision = (row.split("|").map((c) => c.trim())[2]) ?? "";
    if (isPlaceholder(decision)) fail(`Architecture Coverage Matrix axis ${axis.key}: decision cell blank/placeholder`);
  }
}

function validateMethodTraceBlock(block: string, cases: LearningCase[]): string[] {
  const errors: string[] = [];
  for (const f of METHOD_TRACE_FIELDS) {
    const re = new RegExp(`^\\s*${f}\\s*:(.*)$`, "mi");
    const hit = block.match(re);
    if (!hit || isPlaceholder(hit[1] ?? "")) errors.push(`Method Trace missing/blank field: ${f}`);
  }
  const toolGap = (block.match(/^\s*tool_gap\s*:\s*(.+)$/mi)?.[1] ?? "").trim();
  const codifyNext = (block.match(/^\s*codify_next\s*:\s*(.+)$/mi)?.[1] ?? "").trim();
  const namesToolGap = toolGap !== "" && !/^(none|no)\b/i.test(toolGap);
  if (namesToolGap && /^(no|none)\b/i.test(codifyNext)) {
    errors.push("Method Trace tool_gap != none but codify_next = no — a found tool gap MUST be codified "
      + "(create a tooling_defect LearningCase).");
  }
  // Global-store scoped: an old case satisfies "filed"; per-window/per-gap matching is a future tightening.
  if (namesToolGap && !cases.some((c) => c.tooling_defect)) {
    errors.push("Method Trace names a tool_gap but no tooling_defect LearningCase is filed in the store — "
      + "rule 16 requires the gap be filed as a case (then codified or human_killed).");
  }
  return errors;
}

function loadCasesForToolingGate(): LearningCase[] {
  try {
    return loadCases();
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}

function parseStep1Block(md: string): Record<string, string> | null {
  const m = md.match(/```step1\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, "").trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) continue;
    fields[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return fields;
}

function parseWindow(v: string): { from: number; to: number } | null {
  const m = v.match(/^(\d+)\s*\.\.\s*(\d+)$/);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
  return { from, to };
}

function parseAddrs(v: string): string[] {
  return v
    .split(/[,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => /^0x[a-f0-9]{40}$/.test(x));
}

// EOAs that MUST be analyzed at full depth (every tx), not sampled.
const REQUIRE_FULL = new Set(["0xc0ffeebabe5d496b2dde509f9fa189c25cf29671"]);

export function validateTxRecord(tx: any, eoa: string, win: { from: number; to: number }): void {
  if (!/^0x[a-f0-9]{64}$/i.test(String(tx.hash ?? ""))) fail(`tx in ${eoa} missing valid hash`);
  if (!Number.isFinite(tx.block) || tx.block < win.from || tx.block > win.to) {
    fail(`tx ${tx.hash} block ${tx.block} outside window ${win.from}..${win.to}`);
  }
  const txClass = tx.class;
  if (txClass !== "atomic" && txClass !== "backrun") {
    fail(`tx ${tx.hash} missing/invalid class (atomic|backrun)`);
  } else if (txClass === "backrun") {
    const sourceFlow = tx.source_flow;
    if (sourceFlow !== "public" && sourceFlow !== "private" && sourceFlow !== "unknown") {
      fail(`tx ${tx.hash} missing/invalid source_flow (public|private|unknown)`);
    } else if (sourceFlow === "public" && typeof tx.seen_in_our_feed !== "boolean") {
      fail(`tx ${tx.hash} is a public backrun but missing seen_in_our_feed:boolean (did our mempool admission SEE the source swap?)`);
    }
  }
  if (!Array.isArray(tx.pools) || tx.pools.length === 0) {
    fail(`tx ${tx.hash} has no pools[] classified in/out of graph`);
  } else if (!tx.pools.every((p: any) => typeof p.inGraph === "boolean")) {
    fail(`tx ${tx.hash} pools[] must each carry inGraph:boolean`);
  }
  if (isPlaceholder(String(tx.gap_class ?? ""))) fail(`tx ${tx.hash} missing gap_class`);
}

function validateRunAnalysis(json: any): void {
  const ra = json.run_analysis;
  if (!ra || typeof ra !== "object") {
    return fail("artifact.run_analysis missing — the standard post-dry-run funnel/pipeline_dropped analysis is mandatory");
  }
  if (!ra.funnel || typeof ra.funnel !== "object" || Object.keys(ra.funnel).length === 0) {
    fail("run_analysis.funnel missing/empty (need hints/impacts/opportunities/plans/solverEntered/...)");
  }
  if (isPlaceholder(String(ra.dominant_drop ?? ""))) {
    fail("run_analysis.dominant_drop missing — name the dominant loss bucket for the window");
  }
  if (isPlaceholder(String(ra.events_source ?? ""))) {
    fail("run_analysis.events_source missing — declare jsonl vs log-counter (prefer jsonl)");
  }
}

export function validateIntakeAudit(json: any): void {
  const ia = json?.intake_audit;
  if (!ia || typeof ia !== "object" || Array.isArray(ia)) {
    return fail("artifact.intake_audit missing — pending_received/pending_filtered/mevshare_enabled are mandatory");
  }
  if (typeof ia.pending_received !== "number" || !Number.isFinite(ia.pending_received) || ia.pending_received < 0) {
    fail("intake_audit.pending_received must be a finite number >= 0");
  }
  if (typeof ia.pending_filtered !== "number" || !Number.isFinite(ia.pending_filtered) || ia.pending_filtered < 0) {
    fail("intake_audit.pending_filtered must be a finite number >= 0");
  }
  if (typeof ia.mevshare_enabled !== "boolean") {
    fail("intake_audit.mevshare_enabled must be boolean");
  }
}

function computeCoverageKpi(json: any): {
  competitorLegsTotal: number;
  legsOutOfGraph: number;
  outPoolAddrs: string[];
} {
  let competitorLegsTotal = 0;
  let legsOutOfGraph = 0;
  const outPoolAddrs = new Set<string>();

  const findings: any[] = Array.isArray(json?.findings) ? json.findings : [];
  for (const f of findings) {
    const txs: any[] = Array.isArray(f?.txs) ? f.txs : [];
    for (const tx of txs) {
      const pools: any[] = Array.isArray(tx?.pools) ? tx.pools : [];
      for (const p of pools) {
        competitorLegsTotal++;
        if (p?.inGraph === false) {
          legsOutOfGraph++;
          outPoolAddrs.add(String(p.addr ?? "").toLowerCase());
        }
      }
    }
  }

  return {
    competitorLegsTotal,
    legsOutOfGraph,
    outPoolAddrs: [...outPoolAddrs].sort(),
  };
}

function emitCoverageKpi(json: any): void {
  const kpi = computeCoverageKpi(json);
  console.log(JSON.stringify({
    competitor_legs_total: kpi.competitorLegsTotal,
    legs_out_of_graph: kpi.legsOutOfGraph,
    out_pools: kpi.outPoolAddrs.map((addr) => ({
      addr,
      token0: "<FILL>",
      token1: "<FILL>",
      class: "<closable|single_venue_noise>",
      evidence: "<FILL>",
    })),
    closable: 0,
    single_venue_noise: 0,
    prev_round: null,
  }, null, 2));
}

function validateCoverageKpi(json: any): void {
  const expected = computeCoverageKpi(json);
  const kpi = json.coverage_kpi;
  if (!kpi || typeof kpi !== "object" || Array.isArray(kpi)) {
    return fail("artifact.coverage_kpi missing — the per-window coverage metric is mandatory (compute it with --emit-kpi)");
  }

  if (kpi.competitor_legs_total !== expected.competitorLegsTotal) {
    fail(`coverage_kpi.competitor_legs_total ${String(kpi.competitor_legs_total)} != recomputed ${expected.competitorLegsTotal}`);
  }
  if (kpi.legs_out_of_graph !== expected.legsOutOfGraph) {
    fail(`coverage_kpi.legs_out_of_graph ${String(kpi.legs_out_of_graph)} != recomputed ${expected.legsOutOfGraph}`);
  }

  const outPools: any[] = Array.isArray(kpi.out_pools) ? kpi.out_pools : [];
  if (!Array.isArray(kpi.out_pools)) {
    fail("coverage_kpi.out_pools must be an array of one entry per unique out-of-graph pool");
  } else {
    const expectedAddrs = new Set(expected.outPoolAddrs);
    const actualAddrs = new Set(outPools.map((p) => String(p?.addr ?? "").toLowerCase()));
    const missing = expected.outPoolAddrs.filter((addr) => !actualAddrs.has(addr));
    const extra = [...actualAddrs].sort().filter((addr) => !expectedAddrs.has(addr));
    if (missing.length > 0 || extra.length > 0) {
      fail(`coverage_kpi.out_pools addr set mismatch: missing [${missing.join(", ") || "none"}], extra [${extra.join(", ") || "none"}]`);
    }
  }

  for (let i = 0; i < outPools.length; i++) {
    const p = outPools[i];
    if (!p || typeof p !== "object") {
      fail(`coverage_kpi.out_pools[${i}] must be an object`);
      continue;
    }
    const addr = String(p.addr ?? "").toLowerCase();
    if (p.class !== "closable" && p.class !== "single_venue_noise") {
      fail(`coverage_kpi.out_pools[${i}] ${addr}: class must be closable or single_venue_noise`);
    }
    if (isPlaceholder(String(p.token0 ?? ""))) fail(`coverage_kpi.out_pools[${i}] ${addr}: token0 missing`);
    if (isPlaceholder(String(p.token1 ?? ""))) fail(`coverage_kpi.out_pools[${i}] ${addr}: token1 missing`);
    if (isPlaceholder(String(p.evidence ?? ""))) fail(`coverage_kpi.out_pools[${i}] ${addr}: evidence missing`);
  }

  const hasClosable = typeof kpi.closable === "number" && Number.isFinite(kpi.closable);
  const hasNoise = typeof kpi.single_venue_noise === "number" && Number.isFinite(kpi.single_venue_noise);
  if (!hasClosable) fail("coverage_kpi.closable must be a number");
  if (!hasNoise) fail("coverage_kpi.single_venue_noise must be a number");
  if (hasClosable && hasNoise && kpi.closable + kpi.single_venue_noise !== outPools.length) {
    fail(`coverage_kpi.closable + single_venue_noise (${kpi.closable} + ${kpi.single_venue_noise}) != out_pools.length (${outPools.length})`);
  }

  if (!("prev_round" in kpi)) {
    fail("coverage_kpi.prev_round missing — set null for the first round or {run_id, legs_out_of_graph, closable} to link the trend");
  } else if (kpi.prev_round !== null && (typeof kpi.prev_round !== "object" || Array.isArray(kpi.prev_round))) {
    fail("coverage_kpi.prev_round must be null or an object");
  }
}

function validateManualArtifact(
  json: any,
  win: { from: number; to: number },
  watchlist: string[],
): void {
  if (!json || typeof json !== "object") return fail("artifact is not a JSON object");
  const w = json.window;
  if (!w || !Number.isFinite(w.from) || !Number.isFinite(w.to)) {
    return fail("artifact.window missing {from,to}");
  }
  // artifact window must overlap the declared window (not a stale/unrelated file)
  if (w.to < win.from || w.from > win.to) {
    fail(`artifact.window ${w.from}..${w.to} does not overlap declared window ${win.from}..${win.to}`);
  }

  // (1) standard analysis (funnel + dominant drop) is mandatory every dry-run
  validateRunAnalysis(json);
  validateIntakeAudit(json);

  const aw: string[] = Array.isArray(json.watchlist) ? json.watchlist.map((s: string) => String(s).toLowerCase()) : [];
  for (const addr of watchlist) {
    if (!aw.includes(addr)) fail(`artifact.watchlist missing declared watchlist addr ${addr}`);
  }
  // coffeebabe must always be in the watchlist for a window
  for (const req of REQUIRE_FULL) {
    if (!watchlist.includes(req)) fail(`watchlist must include ${req} (mandatory full analysis)`);
  }
  if (!Array.isArray(json.findings) || json.findings.length === 0) {
    return fail("artifact.findings is empty — no watchlist EOA was analyzed");
  }
  const byEoa = new Map<string, any>();
  for (const f of json.findings) byEoa.set(String(f.eoa ?? "").toLowerCase(), f);
  // every declared watchlist EOA must have a findings entry, and it must have been swept
  for (const addr of watchlist) {
    const f = byEoa.get(addr);
    if (!f) { fail(`no findings entry for watchlist EOA ${addr}`); continue; }
    if (f.swept !== true) fail(`findings ${addr}: swept!==true — every watchlist EOA must be swept over the window (no "not swept")`);
    if (!("txCount" in f) || typeof f.txCount !== "number") fail(`findings ${addr}: txCount must be a number from a real window sweep`);
    if (isPlaceholder(String(f.method ?? ""))) fail(`findings ${addr}: method missing (how the sweep was done, e.g. nonce delta)`);

    const isFull = REQUIRE_FULL.has(addr) || f.analysis_mode === "full";
    const txs: any[] = Array.isArray(f.txs) ? f.txs : [];

    if (isFull) {
      // (3) coffeebabe: EVERY tx must be hand-analyzed
      if (typeof f.txCount === "number" && f.txCount > 0 && txs.length !== f.txCount) {
        fail(`findings ${addr} is FULL mode: txs analyzed (${txs.length}) != txCount (${f.txCount}) — every tx must be analyzed`);
      }
      for (const tx of txs) validateTxRecord(tx, addr, win);
    } else {
      // (4) others: sampling analysis required (>=1 sample if it traded)
      if (typeof f.txCount === "number" && f.txCount > 0) {
        if (txs.length < 1) fail(`findings ${addr} is SAMPLE mode with txCount>0 but no sampled txs analyzed`);
        if (!Number.isFinite(f.sampleSize) || f.sampleSize < 1) fail(`findings ${addr}: sampleSize (>=1) required for sampling analysis`);
        for (const tx of txs) validateTxRecord(tx, addr, win);
      }
    }
  }
  validateCoverageKpi(json);
}

function validateWatchDir(dir: string, win: { from: number; to: number }): void {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return fail(`watch dir ${dir} has no *.json WatchReports`);
  let inWindow = 0;
  for (const f of files) {
    try {
      const rep = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (Number.isFinite(rep.block) && rep.block >= win.from && rep.block <= win.to) inWindow++;
    } catch {
      /* skip unreadable */
    }
  }
  if (inWindow === 0) {
    fail(`no watch WatchReport has a block inside window ${win.from}..${win.to}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const emitKpi = args.includes("--emit-kpi");
  const mdPath = args.find((arg) => !arg.startsWith("-"));
  if (!mdPath) {
    console.error("Usage: npm run hermes-gate -- <hermes-md-file> [--emit-kpi]");
    process.exit(2);
  }

  // ── main ──
  if (!existsSync(mdPath)) {
    console.error(`FAIL: hermes md not found: ${mdPath}`);
    process.exit(1);
  }
  const md = readFileSync(mdPath, "utf8");
  const step1 = parseStep1Block(md);
  if (!step1) {
    console.error("FAIL: no ```step1 block in the Hermes md.");
    console.error("Step-1 competitor cross-reference is mandatory before Final Approval (HERMES.md §Mechanics Step-1).");
    process.exit(1);
  }

  validateStep1RequiredFields(step1);

  const win = step1.window_blocks ? parseWindow(step1.window_blocks) : null;
  if (step1.window_blocks && !win) fail(`step1.window_blocks not "<from>..<to>": ${step1.window_blocks}`);
  const watchlist = step1.watchlist ? parseAddrs(step1.watchlist) : [];
  if (step1.watchlist && watchlist.length === 0) fail("step1.watchlist has no valid addresses");

  if (win && step1.artifact && !isPlaceholder(step1.artifact)) {
    const artifactPath = resolve(repoRoot(mdPath), step1.artifact);
    if (!existsSync(artifactPath)) {
      fail(`step1.artifact does not exist: ${step1.artifact}`);
    } else {
      const st = statSync(artifactPath);
      if (st.isDirectory()) {
        if (emitKpi) {
          fail("--emit-kpi requires step1.artifact to be a JSON artifact, not a directory");
        } else {
          validateWatchDir(artifactPath, win);
        }
      } else if (st.size === 0) {
        fail(`step1.artifact is empty: ${step1.artifact}`);
      } else {
        let json: any;
        try {
          json = JSON.parse(readFileSync(artifactPath, "utf8"));
        } catch (err) {
          json = null;
          fail(`step1.artifact is not valid JSON: ${(err as Error).message}`);
        }
        if (json) {
          if (emitKpi) {
            if (fails.length === 0) {
              emitCoverageKpi(json);
              process.exit(0);
            }
          } else {
            validateManualArtifact(json, win, watchlist);
          }
        }
      }
    }
  }

  const tdCases = loadCasesForToolingGate();
  validateMethodTrace(md, step1, tdCases);
  validateToolingDefects(tdCases);

  if (fails.length > 0) {
    console.error(`FAIL: Step-1 close-gate blocked ${mdPath}`);
    for (const f of fails) console.error(`  - ${f}`);
    console.error("Do NOT write Final Approval until Step-1 evidence exists and is consistent.");
    process.exit(1);
  }

  console.log(`PASS: Step-1 competitor cross-reference present for ${step1.run_id}`);
  console.log(`  window ${step1.window_blocks} · watchlist ${watchlist.length} · method ${step1.method}`);
  console.log(`  artifact ${step1.artifact}`);
  process.exit(0);
}

function isCliEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return import.meta.url === pathToFileURL(argv1).href || /[/\\]cli[/\\]index\.[jt]s$/.test(argv1);
}

if (isCliEntrypoint()) {
  main();
}
