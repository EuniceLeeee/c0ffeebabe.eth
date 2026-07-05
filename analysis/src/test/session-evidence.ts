import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractSessionEvidence } from "../cli/session-evidence.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(TEST_DIR, "fixtures", "session-evidence-sample.jsonl");

test("session evidence extracts visible deterministic transcript facts", () => {
  const fixtureLines = readFileSync(FIXTURE, "utf8").split(/\r?\n/);
  const evidence = extractSessionEvidence(fixtureLines);

  assert.deepEqual(evidence.human_asks, ["Please extract the method trace evidence."]);
  assert.equal(evidence.human_asks.some((ask) => ask.includes("Stop hook feedback")), false);
  assert.equal(evidence.human_asks.some((ask) => ask.includes("CLAUDE.md contents")), false);

  assert.deepEqual(evidence.tools_used, [
    { tool: "Read", count: 1 },
    { tool: "Bash", count: 1 },
  ]);
  assert.deepEqual(evidence.evidence_order, [
    { tool: "Read", detail: "CLAUDE.md" },
    { tool: "Bash", detail: "npm run method-trace-check -- docs/analysis/example.md" },
  ]);

  assert.deepEqual(evidence.assistant_conclusions, ["I found the visible conclusion."]);
  assert.equal(evidence.assistant_conclusions.some((text) => text.includes("hidden reasoning")), false);
});
