import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { assertVictimFixturesAreNotArbs } from "../fixtures/victims.js";

const SEARCHER_ROOT = resolve("src/searcher");

const DISALLOWED_IMPORTS = [
  "classifier",
  "solve-from-trace",
  "solveFromTrace",
  "NormalizedCallNode",
  "debug_traceTransaction",
  "debugTraceTransaction",
];

const DISALLOWED_TX_HASH_BRANCH = /if\s*\([^)]*txHash[^)]*={2,3}\s*["']0x[0-9a-fA-F]{64}["']/;

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

  for (const file of walk(SEARCHER_ROOT)) {
    const rel = relative(process.cwd(), file);
    if (rel.endsWith("src/searcher/test/boundary.ts")) continue;
    const text = readFileSync(file, "utf8");

    for (const needle of DISALLOWED_IMPORTS) {
      if (text.includes(needle)) {
        failures.push(`${rel}: contains disallowed hot-path token "${needle}"`);
      }
    }
    if (DISALLOWED_TX_HASH_BRANCH.test(text)) {
      failures.push(`${rel}: contains txHash equality hardcode branch`);
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
