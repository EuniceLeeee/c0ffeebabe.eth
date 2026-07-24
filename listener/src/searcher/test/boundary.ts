import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { VICTIM_FIXTURES, assertVictimFixturesAreNotArbs } from "../fixtures/victims.js";

const SEARCHER_ROOT = resolve("src/searcher");

const DISALLOWED_IMPORTS = [
  "../research",
  "../../research",
  "../classifier",
  "../../classifier",
  "solve-from-trace",
  "solveFromTrace",
  "NormalizedCallNode",
  "CaptureArbSim",
  "BASE_FLASH",
  "BASE_DEBT",
  "BASE_V3",
  "BASE_V4",
  "buildResolvedWstUsrPlan",
  "buildResolvedXxxPlan",
  "wstUSR-to-DOLA",
  "DOLA-to-wstUSR",
  "SEARCHER_MIN_PROFIT_WSTUSR",
  "minProfitWstUsr",
];

const DISALLOWED_HOT_PATH_TOKENS = [
  "debug_traceTransaction",
  "debugTraceTransaction",
];

const BACKGROUND_TRACE_FILES = new Set([
  // Discovery may use a bounded trace prefilter before the family-owned
  // identity/behavior probes. It is not part of quote/plan/solve execution.
  "src/searcher/protocol-instance-discovery.ts",
]);

const DISALLOWED_TX_HASH_BRANCH = /if\s*\([^)]*txHash[^)]*={2,3}\s*["']0x[0-9a-fA-F]{64}["']/;
const DISALLOWED_FIXED_SPLIT = /(half|otherHalf)\s*=.*\/\s*2n/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

function main(): void {
  assertVictimFixturesAreNotArbs();
  const failures: string[] = [];
  if (VICTIM_FIXTURES.length < 2) {
    failures.push(`fixtures: expected >= 2 victim fixtures, got ${VICTIM_FIXTURES.length}`);
  }

  for (const file of walk(SEARCHER_ROOT)) {
    const rel = relative(process.cwd(), file);
    if (rel.endsWith("src/searcher/test/boundary.ts")) continue;
    const text = readFileSync(file, "utf8");

    for (const needle of DISALLOWED_IMPORTS) {
      if (text.includes(needle)) {
        failures.push(`${rel}: contains disallowed hot-path token "${needle}"`);
      }
    }
    if (
      !rel.startsWith("src/searcher/test/") &&
      !BACKGROUND_TRACE_FILES.has(rel)
    ) {
      for (const needle of DISALLOWED_HOT_PATH_TOKENS) {
        if (text.includes(needle)) {
          failures.push(`${rel}: contains disallowed hot-path token "${needle}"`);
        }
      }
    }
    if (DISALLOWED_TX_HASH_BRANCH.test(text)) {
      failures.push(`${rel}: contains txHash equality hardcode branch`);
    }
    if (DISALLOWED_FIXED_SPLIT.test(text)) {
      failures.push(`${rel}: contains fixed half/otherHalf split`);
    }
    if (text.includes(".direction ===")) {
      failures.push(`${rel}: contains hardcoded impact direction filter`);
    }
    if (rel.endsWith("src/searcher/hot-path.ts") && text.includes(".forkAt(")) {
      failures.push(`${rel}: hot path must use prepareVictimPostState, not forkAt`);
    }
  }

  if (failures.length > 0) {
    console.error("[searcher/lint] FAIL");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("[searcher/lint] PASS");
}

main();
