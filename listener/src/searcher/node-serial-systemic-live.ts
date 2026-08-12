import { readFile } from "node:fs/promises";
import {
  deriveSerialSideEvidence,
  evaluateSystemicLiveFromSerialEvidence,
} from "./serial-systemic-live-evidence.js";

/**
 * Node CLI: derives the fail-closed systemic-live gate verdict from the two
 * serial dry-run sides' events.jsonl (block_scan_result rows). Serial
 * evidence is honestly relative_diagnostic_only, so the gate cannot pass on
 * it alone. Usage: node-serial-systemic-live <baseline-events> <baseline-sha>
 * <challenger-events> <challenger-sha> <window-seconds>
 */

async function main(): Promise<void> {
  const [baselineEventsPath, baselineSha, challengerEventsPath,
    challengerSha, windowSecondsRaw] = process.argv.slice(2);
  if (
    !baselineEventsPath || !baselineSha || !challengerEventsPath ||
    !challengerSha || !windowSecondsRaw
  ) {
    throw new Error(
      "usage: node-serial-systemic-live <baseline-events> <baseline-sha> " +
        "<challenger-events> <challenger-sha> <window-seconds>",
    );
  }
  const windowSeconds = Number(windowSecondsRaw);
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error("window seconds must be a positive integer");
  }
  const baselineLines = (await readFile(baselineEventsPath, "utf8"))
    .split("\n").filter((line) => line.trim() !== "");
  const challengerLines = (await readFile(challengerEventsPath, "utf8"))
    .split("\n").filter((line) => line.trim() !== "");
  const baseline = deriveSerialSideEvidence({
    sha: baselineSha,
    eventsLines: baselineLines,
    windowSeconds,
  });
  const challenger = deriveSerialSideEvidence({
    sha: challengerSha,
    eventsLines: challengerLines,
    windowSeconds,
  });
  const verdict = evaluateSystemicLiveFromSerialEvidence({
    baseline,
    challenger,
  });
  console.log(JSON.stringify({
    format: "s1-node-serial-systemic-live-v1",
    status: "pass",
    windowSeconds,
    baseline: {
      sha: baseline.sha,
      eligibleHeads: baseline.eligibleHeads,
      fullCoverageHeads: baseline.fullCoverageHeads,
      completedHeads: baseline.completedHeads,
      p95TotalMs: baseline.p95TotalMs,
    },
    challenger: {
      sha: challenger.sha,
      eligibleHeads: challenger.eligibleHeads,
      fullCoverageHeads: challenger.fullCoverageHeads,
      completedHeads: challenger.completedHeads,
      p95TotalMs: challenger.p95TotalMs,
    },
    gateVerdict: verdict.status,
    gateReasons: verdict.reasons,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
