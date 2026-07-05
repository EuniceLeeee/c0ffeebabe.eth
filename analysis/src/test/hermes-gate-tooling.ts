import assert from "node:assert/strict";
import {
  fails,
  validateMethodTrace,
  validateToolingDefects,
} from "../cli/hermes-gate.js";
import type { LearningCase } from "../learning/learning-case.js";

const checks: Array<() => void> = [
  () => expectFail("open tooling defect blocks", () => {
    validateToolingDefects([
      baseCase({
        learning_case_id: "case-open",
        tooling_defect: {
          tool: "bundle-postmortem",
          issue: "missing native-ETH delta",
          evidence: "manual trace showed ETH balance movement",
          codify_target: "analysis/src/cli/bundle-postmortem.ts add native ETH metric",
          status: "open",
        },
      }),
    ]);
  }, "case-open", "OPEN"),
  () => expectPass("codified tooling defect with commit passes", () => {
    validateToolingDefects([
      baseCase({
        tooling_defect: {
          tool: "bundle-postmortem",
          issue: "missing native-ETH delta",
          evidence: "manual trace showed ETH balance movement",
          codify_target: "analysis/src/cli/bundle-postmortem.ts add native ETH metric",
          codify_commit: "abc1234",
          status: "codified",
        },
      }),
    ]);
  }),
  () => expectFail("codified tooling defect needs commit", () => {
    validateToolingDefects([
      baseCase({
        learning_case_id: "case-no-commit",
        tooling_defect: {
          tool: "bundle-postmortem",
          issue: "missing native-ETH delta",
          evidence: "manual trace showed ETH balance movement",
          codify_target: "analysis/src/cli/bundle-postmortem.ts add native ETH metric",
          status: "codified",
        },
      }),
    ]);
  }, "case-no-commit", "codify_commit missing"),
  () => expectPass("human killed tooling defect passes", () => {
    validateToolingDefects([
      baseCase({
        tooling_defect: {
          tool: "bundle-postmortem",
          issue: "missing native-ETH delta",
          evidence: "manual trace showed ETH balance movement",
          codify_target: "analysis/src/cli/bundle-postmortem.ts add native ETH metric",
          status: "human_killed",
        },
      }),
    ]);
  }),
  () => expectPass("absent tooling defect passes", () => {
    validateToolingDefects([baseCase()]);
  }),
  () => expectPass("no fable marker needs no method trace", () => {
    validateMethodTrace("# Hermes\n\nNo external analyst was used in this round.\n");
  }),
  () => expectPass("fable marker with full method trace passes", () => {
    validateMethodTrace(validTraceMd());
  }),
  () => expectFail("fable marker without method trace fails", () => {
    validateMethodTrace("# Hermes\n\nfresh fable reviewed the raw data.\n");
  }, "no `## Method Trace` block"),
  () => expectFail("method trace missing sanity checks fails", () => {
    validateMethodTrace(validTraceMd().replace(/^sanity_checks:.*\n/m, ""));
  }, "Method Trace missing/blank field: sanity_checks"),
  () => expectFail("tool gap with no codify plan fails", () => {
    validateMethodTrace(validTraceMd()
      .replace(/^tool_gap:.*$/m, "tool_gap: native-ETH delta")
      .replace(/^codify_next:.*$/m, "codify_next: no"));
  }, "tool_gap != none", "codify_next = no"),
];

try {
  for (const check of checks) check();
  console.log(`hermes-gate-tooling PASS (${checks.length}/${checks.length})`);
  console.log("verdict: fixed");
} catch (err) {
  console.error(`FAIL: ${(err as Error).message}`);
  process.exit(1);
}

function expectPass(label: string, fn: () => void): void {
  fails.length = 0;
  fn();
  assert.deepEqual(fails, [], label);
}

function expectFail(label: string, fn: () => void, ...expected: string[]): void {
  fails.length = 0;
  fn();
  const actual = fails.join("\n");
  for (const snippet of expected) {
    assert.ok(
      actual.includes(snippet),
      `${label}: expected ${JSON.stringify(snippet)}, got ${JSON.stringify(fails)}`,
    );
  }
}

function baseCase(overrides: Partial<LearningCase> = {}): LearningCase {
  return {
    learning_case_id: "case-1",
    status: "open",
    strategy_kind: "backrun",
    edge_kinds: ["swap"],
    trigger: "competitor_not_seen",
    comparable: true,
    primary_gap: "manual_required",
    evidence: {},
    created_at: "2026-07-05T00:00:00.000Z",
    updated_at: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

function validTraceMd(): string {
  return `# Hermes

fresh fable reviewed the raw data.

## Method Trace
\`\`\`
task_class: competitor_path
tools_used: analysis live-loss; cast run
evidence_order: structured output, raw trace, repo taxonomy
analysis_frame: comparable before gap classification
sanity_checks: same tx/block/source verified
tool_gap: none
codify_next: no
distill_for_opus: run structured tooling before ad-hoc trace work
\`\`\`

## Next Run
- next_state: continue
`;
}
