import { readFileSync } from "node:fs";
import { encodeIntegrityReport, validateReferenceLockIntegrity } from "./index.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const repoPath = argument("--repo") ?? "/private/tmp/mev-s1-impl";
const ledgerPath = argument("--ledger");
const referenceLockPath = argument("--reference-lock");
const report = validateReferenceLockIntegrity({ repoPath, ledger: ledgerPath, referenceLock: referenceLockPath });
const output = encodeIntegrityReport(report);
const outputPath = argument("--out");
if (outputPath !== undefined) {
  // The report is an explicit operator artifact; the validator itself never
  // mutates the reference repository or the Aloha source tree.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outputPath, `${output}\n`, { encoding: "utf8", flag: "wx" });
} else {
  process.stdout.write(`${output}\n`);
}
if (report.verdict !== "pass") process.exitCode = 1;
