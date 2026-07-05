// Authorized defensive on-chain arbitrage research; analysis tooling only.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fails, validateMethodTraceContent } from "./hermes-gate.js";
import { loadCases, type LearningCase } from "../learning/learning-case.js";

function loadCasesForMethodTraceCheck(): LearningCase[] {
  try {
    return loadCases();
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
}

function main(): void {
  const mdPath = process.argv[2];
  if (!mdPath) {
    console.error("usage: method-trace-check -- <analysis.md>");
    process.exit(2);
  }

  const md = readFileSync(mdPath, "utf8");
  const cases = loadCasesForMethodTraceCheck();

  fails.length = 0;
  validateMethodTraceContent(md, cases);
  // Store-wide open tooling_defect blocking remains a hermes-gate round-close concern.

  if (fails.length > 0) {
    console.error(`FAIL: Method Trace invalid in ${mdPath}`);
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(`PASS: Method Trace valid in ${mdPath}`);
  process.exit(0);
}

function isCliEntrypoint(): boolean {
  const argv1 = process.argv[1];
  return Boolean(argv1 && import.meta.url === pathToFileURL(argv1).href);
}

if (isCliEntrypoint()) {
  main();
}
