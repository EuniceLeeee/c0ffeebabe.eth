import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

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
 * cross-reference, CLAUDE.md Hermes §Step-1).
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
 *   ```
 *
 * The artifact is either:
 *   - a JSON manifest (method: manual-onchain-trace) with { run_id, window:{from,to},
 *     watchlist:[...], findings:[ { eoa, txCount, txs?:[{hash,block,pools:[{addr,inGraph}],gap_class}] } ] }, or
 *   - a directory of `analysis live-loss --watch` outputs (method: live-loss-watch):
 *     ≥1 `*.json` WatchReport with a `block` inside the window.
 *
 * Usage: npm run hermes-gate -- <hermes-md-file>
 * Exit 0 = PASS (Step-1 evidence present + consistent → may write Final Approval).
 * Exit 1 = FAIL (blocking).
 */

const mdPath = process.argv[2];
if (!mdPath) {
  console.error("Usage: npm run hermes-gate -- <hermes-md-file>");
  process.exit(2);
}

const fails: string[] = [];
function fail(msg: string): void {
  fails.push(msg);
}

function isPlaceholder(v: string): boolean {
  const t = v.trim();
  return t === "" || t.startsWith("<") || /^(todo|tbd|n\/a|na|fill|pending)$/i.test(t);
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

function validateTxRecord(tx: any, eoa: string, win: { from: number; to: number }): void {
  if (!/^0x[a-f0-9]{64}$/i.test(String(tx.hash ?? ""))) fail(`tx in ${eoa} missing valid hash`);
  if (!Number.isFinite(tx.block) || tx.block < win.from || tx.block > win.to) {
    fail(`tx ${tx.hash} block ${tx.block} outside window ${win.from}..${win.to}`);
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

// ── main ──
if (!existsSync(mdPath)) {
  console.error(`FAIL: hermes md not found: ${mdPath}`);
  process.exit(1);
}
const md = readFileSync(mdPath, "utf8");
const step1 = parseStep1Block(md);
if (!step1) {
  console.error("FAIL: no ```step1 block in the Hermes md.");
  console.error("Step-1 competitor cross-reference is mandatory before Final Approval (CLAUDE.md Hermes §Step-1).");
  process.exit(1);
}

for (const key of ["run_id", "window_blocks", "watchlist", "artifact", "method"]) {
  if (!(key in step1) || isPlaceholder(step1[key])) fail(`step1.${key} missing or placeholder`);
}

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
      validateWatchDir(artifactPath, win);
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
      if (json) validateManualArtifact(json, win, watchlist);
    }
  }
}

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
