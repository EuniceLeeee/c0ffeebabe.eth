import assert from "node:assert/strict";
import {
  fails,
  validateManualArtifact,
  validateMethodTrace,
  validateMethodTraceContent,
  validateStep1RequiredFields,
  validateToolingDefects,
} from "../cli/hermes-gate.js";
import type { LearningCase } from "../learning/learning-case.js";

const COFFEEBABE = "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671";
const TEST_POOL = "0x1111111111111111111111111111111111111111";

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
  () => expectPass("prose fable marker with fable_manual no needs no method trace", () => {
    validateStep1RequiredFields(step1({ fable_manual: "no" }));
    validateMethodTrace("# Hermes\n\nfresh fable reviewed the raw data.\n", step1({ fable_manual: "no" }), []);
  }),
  () => expectPass("content validator accepts full competitor path method trace", () => {
    validateMethodTraceContent(validTraceMd(), []);
  }),
  () => expectPass("content validator accepts implementation method trace without coverage matrix", () => {
    validateMethodTraceContent(validTraceMd().replace(/^task_class:.*$/m, "task_class: implementation"), []);
  }),
  () => expectFail("content validator requires method trace block", () => {
    validateMethodTraceContent("# Daily Analysis\n\nNo trace here.\n", []);
  }, "no `## Method Trace`"),
  () => expectFail("content validator architecture review requires coverage matrix", () => {
    validateMethodTraceContent(archTraceMd(), []);
  }, "task_class:architecture_review", "no `## Architecture Coverage Matrix` section"),
  () => expectPass("content validator architecture review with full matrix passes", () => {
    validateMethodTraceContent(archTraceMd(archMatrix()), []);
  }),
  () => expectFail("content validator named tool gap requires filed tooling defect case", () => {
    validateMethodTraceContent(validTraceMd()
      .replace(/^tool_gap:.*$/m, "tool_gap: native-ETH delta missed")
      .replace(/^codify_next:.*$/m, "codify_next: add metric"), []);
  }, "names a tool_gap", "no tooling_defect LearningCase is filed"),
  () => expectPass("content validator named tool gap passes with filed tooling defect case", () => {
    validateMethodTraceContent(validTraceMd()
      .replace(/^tool_gap:.*$/m, "tool_gap: native-ETH delta missed")
      .replace(/^codify_next:.*$/m, "codify_next: add metric"), [toolingDefectCase("open")]);
  }),
  () => expectPass("round wrapper fable_manual no preserves early return", () => {
    validateMethodTrace(validTraceMd().replace(/^task_class:.*\n/m, ""), step1({ fable_manual: "no" }), []);
  }),
  () => expectPass("fable_manual yes with full method trace passes", () => {
    validateStep1RequiredFields(step1({ fable_manual: "yes" }));
    validateMethodTrace(validTraceMd(), step1({ fable_manual: "yes" }), []);
  }),
  () => expectFail("architecture review trace without coverage matrix fails", () => {
    validateStep1RequiredFields(step1({ fable_manual: "yes" }));
    validateMethodTrace(archTraceMd(), step1({ fable_manual: "yes" }), []);
  }, "task_class:architecture_review", "no `## Architecture Coverage Matrix` section"),
  () => expectPass("architecture review trace with full coverage matrix passes", () => {
    validateStep1RequiredFields(step1({ fable_manual: "yes" }));
    validateMethodTrace(archTraceMd(archMatrix()), step1({ fable_manual: "yes" }), []);
  }),
  () => expectFail("architecture review coverage matrix missing planner fails", () => {
    validateStep1RequiredFields(step1({ fable_manual: "yes" }));
    validateMethodTrace(
      archTraceMd(archMatrix().replace(/^\| planner \|.*\n/m, "")),
      step1({ fable_manual: "yes" }),
      [],
    );
  }, "Architecture Coverage Matrix missing axis: planner"),
  () => expectFail("architecture review coverage matrix blank decision fails", () => {
    validateStep1RequiredFields(step1({ fable_manual: "yes" }));
    validateMethodTrace(
      archTraceMd(archMatrix().replace("| quote/pnl | covered |", "| quote/pnl |  |")),
      step1({ fable_manual: "yes" }),
      [],
    );
  }, "Architecture Coverage Matrix axis quote_pnl: decision cell blank/placeholder"),
  () => expectPass("competitor path trace without coverage matrix passes", () => {
    validateStep1RequiredFields(step1({ fable_manual: "yes" }));
    validateMethodTrace(validTraceMd(), step1({ fable_manual: "yes" }), []);
  }),
  () => expectFail("fable_manual yes without method trace fails", () => {
    validateStep1RequiredFields(step1({ fable_manual: "yes" }));
    validateMethodTrace("# Hermes\n\nfresh fable reviewed the raw data.\n", step1({ fable_manual: "yes" }), []);
  }, "no `## Method Trace` block"),
  () => expectFail("method trace missing sanity checks fails", () => {
    validateMethodTrace(validTraceMd().replace(/^sanity_checks:.*\n/m, ""), step1({ fable_manual: "yes" }), []);
  }, "Method Trace missing/blank field: sanity_checks"),
  () => expectFail("tool gap with no codify plan fails", () => {
    validateMethodTrace(validTraceMd()
      .replace(/^tool_gap:.*$/m, "tool_gap: native-ETH delta")
      .replace(/^codify_next:.*$/m, "codify_next: no"), step1({ fable_manual: "yes" }), [toolingDefectCase("human_killed")]);
  }, "tool_gap != none", "codify_next = no"),
  () => expectFail("fable_manual absent from step1 fails required key", () => {
    const s = step1();
    delete s.fable_manual;
    validateStep1RequiredFields(s);
  }, "step1.fable_manual missing or placeholder"),
  () => expectFail("fable_manual maybe fails exact value check", () => {
    validateStep1RequiredFields(step1({ fable_manual: "maybe" }));
  }, "step1.fable_manual invalid", "must be exactly yes or no"),
  () => expectFail("step1 method left as unfilled menu fails", () => {
    validateStep1RequiredFields(step1({ method: "manual-onchain-trace | live-loss-watch" }));
  }, "step1.method missing or placeholder"),
  () => expectPass("fable_manual no needs no method trace", () => {
    validateStep1RequiredFields(step1({ fable_manual: "no" }));
    validateMethodTrace("# Hermes\n\nNo trace here.\n", step1({ fable_manual: "no" }), []);
  }),
  () => expectFail("raw Method Trace menu text is blank", () => {
    validateMethodTrace(menuTraceMd(), step1({ fable_manual: "yes" }), []);
  }, "Method Trace missing/blank field: task_class", "Method Trace missing/blank field: tool_gap"),
  () => expectPass("bracket-like shipped values are not placeholders", () => {
    validateManualArtifact(
      manualArtifact({ dominant_drop: "<=1 tx repeated across >=3 streak", evidence: "WETH<->USDT" }),
      { from: 1, to: 2 },
      [COFFEEBABE],
    );
  }),
  () => expectFail("real angle-bracket placeholders still fail", () => {
    validateManualArtifact(
      manualArtifact({ dominant_drop: "<from>", evidence: "<FILL>" }),
      { from: 1, to: 2 },
      [COFFEEBABE],
    );
  }, "run_analysis.dominant_drop missing", "evidence missing"),
  () => expectPass("shell pipeline in tools_used is not a placeholder", () => {
    validateMethodTrace(
      validTraceMd().replace(/^tools_used:.*$/m, "tools_used: curl -s $RPC | jq '.result', cast run"),
      step1({ fable_manual: "yes" }),
      [],
    );
  }),
  () => expectPass("multi-line distill_for_opus with quoted placeholders is valid", () => {
    validateMethodTrace(
      validTraceMd().replace(
        /^distill_for_opus:.*$/m,
        "distill_for_opus: preserve the runnable capsule\n  replay with --tx <ours>\n  compare <field/test/gate> templates as quoted examples",
      ),
      step1({ fable_manual: "yes" }),
      [],
    );
  }),
  () => expectFail("unfilled task_class menu is blank", () => {
    validateMethodTrace(
      validTraceMd().replace(/^task_class:.*$/m, "task_class: competitor_path | bundle_postmortem | architecture_review | replay_fixture | protocol_leg | implementation"),
      step1({ fable_manual: "yes" }),
      [],
    );
  }, "Method Trace missing/blank field: task_class"),
  () => expectFail("unfilled tool_gap menu is blank", () => {
    validateMethodTrace(
      validTraceMd().replace(/^tool_gap:.*$/m, "tool_gap: none | <what the tool missed>"),
      step1({ fable_manual: "yes" }),
      [],
    );
  }, "Method Trace missing/blank field: tool_gap"),
  () => expectFail("continuation-only none-of tool_gap names a real gap", () => {
    validateMethodTrace(
      validTraceMd()
        .replace(/^tool_gap:.*$/m, "tool_gap:\nnone of the verdicts cover X")
        .replace(/^codify_next:.*$/m, "codify_next: no"),
      step1({ fable_manual: "yes" }),
      [],
    );
  }, "tool_gap != none", "no tooling_defect LearningCase is filed"),
  () => expectPass("none parenthetical tool_gap remains no-gap", () => {
    validateMethodTrace(
      validTraceMd().replace(/^tool_gap:.*$/m, "tool_gap: none (minor harness note: existing fixture phrasing)"),
      step1({ fable_manual: "yes" }),
      [],
    );
  }),
  () => expectFail("later architecture trace without matrix is not masked by earlier valid trace", () => {
    validateMethodTrace(`${validTraceMd()}\n${archTraceMd()}`, step1({ fable_manual: "yes" }), []);
  }, "task_class:architecture_review", "no `## Architecture Coverage Matrix` section"),
  () => expectFail("later tool gap with no codify case is not masked by earlier valid trace", () => {
    validateMethodTrace(`${validTraceMd()}\n${validTraceMd()
      .replace(/^tool_gap:.*$/m, "tool_gap: native-ETH delta missed")
      .replace(/^codify_next:.*$/m, "codify_next: no")}`, step1({ fable_manual: "yes" }), []);
  }, "Method Trace block 2: Method Trace tool_gap != none", "no tooling_defect LearningCase is filed"),
  () => expectFail("invalid task_class spelling fails", () => {
    validateMethodTrace(
      archTraceMd().replace(/^task_class:.*$/m, "task_class: architecture-review"),
      step1({ fable_manual: "yes" }),
      [],
    );
  }, "Method Trace task_class invalid: architecture-review", "must be one of"),
  () => expectFail("non-menu task_class value fails", () => {
    validateMethodTraceContent(
      validTraceMd().replace(/^task_class:.*$/m, "task_class: build_stuff"),
      [],
    );
  }, "Method Trace task_class invalid: build_stuff"),
  () => expectPass("architecture_review task_class allows inline comment", () => {
    validateMethodTrace(
      archTraceMd(archMatrix()).replace(/^task_class:.*$/m, "task_class: architecture_review   # per rule 13"),
      step1({ fable_manual: "yes" }),
      [],
    );
  }),
  () => expectPass("multi-line task_class validates on the first line", () => {
    validateMethodTrace(
      validTraceMd().replace(
        /^task_class:.*$/m,
        "task_class: implementation\nclassification note quotes <field/test/gate> examples",
      ),
      step1({ fable_manual: "yes" }),
      [],
    );
  }),
  () => expectFail("architecture matrix rows are consumed by first matching axis", () => {
    validateMethodTrace(
      archTraceMd(archMatrix()
        .replace("| universe/admission | covered |", "| pool universe admission & freshness | covered |")
        .replace(/^\| state\/freshness \|.*\n/m, "")),
      step1({ fable_manual: "yes" }),
      [],
    );
  }, "Architecture Coverage Matrix missing axis: state_freshness"),
  () => expectPass("inline code mention of architecture matrix header is ignored", () => {
    validateMethodTrace(
      archTraceMd(`\nReviewer note: include a \`## Architecture Coverage Matrix\` table in the handoff.\n${archMatrix()}`),
      step1({ fable_manual: "yes" }),
      [],
    );
  }),
  () => expectFail("named tool gap requires filed tooling defect case", () => {
    validateMethodTrace(validTraceMd()
      .replace(/^tool_gap:.*$/m, "tool_gap: native-ETH delta missed")
      .replace(/^codify_next:.*$/m, "codify_next: add metric"), step1({ fable_manual: "yes" }), []);
  }, "names a tool_gap", "no tooling_defect LearningCase is filed"),
  () => expectFailWithout("filed open tooling defect satisfies filing check then open status blocks", () => {
    const cases = [toolingDefectCase("open")];
    validateMethodTrace(validTraceMd()
      .replace(/^tool_gap:.*$/m, "tool_gap: native-ETH delta missed")
      .replace(/^codify_next:.*$/m, "codify_next: add metric"), step1({ fable_manual: "yes" }), cases);
    validateToolingDefects(cases);
  }, ["tooling_defect OPEN"], ["no tooling_defect LearningCase is filed"]),
  () => expectFail("codify_next none fails consistency for named tool gap", () => {
    validateMethodTrace(validTraceMd()
      .replace(/^tool_gap:.*$/m, "tool_gap: native-ETH delta missed")
      .replace(/^codify_next:.*$/m, "codify_next: none"), step1({ fable_manual: "yes" }), [toolingDefectCase("human_killed")]);
  }, "tool_gap != none", "codify_next = no"),
  () => expectPass("horizontal rule after Method Trace header does not truncate block", () => {
    validateMethodTrace(validTraceMd().replace("## Method Trace\n", "## Method Trace\n---\n"), step1({ fable_manual: "yes" }), []);
  }),
  () => expectPass("one valid Method Trace block is enough", () => {
    validateMethodTrace(`# Hermes

## Method Trace
\`\`\`
task_class:
tools_used:
evidence_order:
analysis_frame:
sanity_checks:
tool_gap:
codify_next:
distill_for_opus:
\`\`\`

${validTraceMd()}
`, step1({ fable_manual: "yes" }), []);
  }),
  () => expectFail("invalid tooling defect status fails", () => {
    validateToolingDefects([toolingDefectCase("Open")]);
  }, "tooling_defect.status invalid: Open", "must be open|codified|human_killed"),
  // F1-F3 (fable review of the multi-line parser): single-line heuristics must scope to the first line.
  () => expectPass("F1 multiline distill_for_opus quoting <ours> not flagged placeholder", () => {
    validateMethodTraceContent(validTraceMd().replace(/^distill_for_opus:.*$/m,
      "distill_for_opus: (1) run the postmortem first:\nnpm run bundle-postmortem -- --tx <ours> --rpc x\n(2) classify winner_style"), []);
  }),
  () => expectFail("F2 multiline tool_gap 'none of the...' is a named gap", () => {
    validateMethodTraceContent(validTraceMd()
      .replace(/^tool_gap:.*$/m, "tool_gap:\nnone of the verdicts cover sim-undervaluation")
      .replace(/^codify_next:.*$/m, "codify_next: no"), []);
  }, "tool_gap != none"),
  () => expectPass("F2 tool_gap 'none (note)' stays no-gap", () => {
    validateMethodTraceContent(validTraceMd().replace(/^tool_gap:.*$/m,
      "tool_gap: none (minor harness note: sleep blocked)"), []);
  }),
  () => expectPass("F3 multiline task_class validates on first line", () => {
    validateMethodTraceContent(validTraceMd().replace(/^task_class:.*$/m,
      "task_class: competitor_path\n(chosen: hand-traced coffeebabe)"), []);
  }),
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

function expectFailWithout(label: string, fn: () => void, expected: string[], unexpected: string[]): void {
  fails.length = 0;
  fn();
  const actual = fails.join("\n");
  for (const snippet of expected) {
    assert.ok(
      actual.includes(snippet),
      `${label}: expected ${JSON.stringify(snippet)}, got ${JSON.stringify(fails)}`,
    );
  }
  for (const snippet of unexpected) {
    assert.ok(
      !actual.includes(snippet),
      `${label}: did not expect ${JSON.stringify(snippet)}, got ${JSON.stringify(fails)}`,
    );
  }
}

function step1(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    run_id: "tooling-test",
    window_blocks: "1..2",
    watchlist: "0xc0ffeebabe5d496b2dde509f9fa189c25cf29671",
    artifact: "docs/research/reports/step1-tooling-test.json",
    method: "manual-onchain-trace",
    fable_manual: "yes",
    ...overrides,
  };
}

function manualArtifact(overrides: { dominant_drop?: string; evidence?: string } = {}): any {
  return {
    window: { from: 1, to: 2 },
    run_analysis: {
      funnel: { opportunities: 1, plans: 0 },
      dominant_drop: overrides.dominant_drop ?? "coverage_gap",
      events_source: "events.jsonl",
    },
    intake_audit: {
      pending_received: 1,
      pending_filtered: 0,
      mevshare_enabled: true,
    },
    watchlist: [COFFEEBABE],
    findings: [{
      eoa: COFFEEBABE,
      swept: true,
      txCount: 1,
      method: "nonce delta",
      txs: [{
        hash: `0x${"1".repeat(64)}`,
        block: 1,
        class: "atomic",
        pools: [{ addr: TEST_POOL, inGraph: false }],
        gap_class: "pool_gap",
      }],
    }],
    coverage_kpi: {
      competitor_legs_total: 1,
      legs_out_of_graph: 1,
      out_pools: [{
        addr: TEST_POOL,
        token0: "WETH",
        token1: "USDT",
        class: "closable",
        evidence: overrides.evidence ?? "pool gap",
      }],
      closable: 1,
      single_venue_noise: 0,
      prev_round: null,
    },
  };
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

function toolingDefectCase(status: string): LearningCase {
  return baseCase({
    learning_case_id: `case-${status}`,
    tooling_defect: {
      tool: "bundle-postmortem",
      issue: "missing native-ETH delta",
      evidence: "manual trace showed ETH balance movement",
      codify_target: "analysis/src/cli/bundle-postmortem.ts add native ETH metric",
      status,
    } as LearningCase["tooling_defect"],
  });
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

function archTraceMd(matrix = ""): string {
  return `# Hermes

fresh fable reviewed the raw data.

## Method Trace
\`\`\`
task_class: architecture_review
tools_used: architecture-review handoff; repo grep
evidence_order: structured output, raw trace, repo taxonomy
analysis_frame: comparable before gap classification
sanity_checks: same tx/block/source verified
tool_gap: none
codify_next: no
distill_for_opus: architecture review requires the coverage matrix
\`\`\`
${matrix}`;
}

function archMatrix(): string {
  return `
## Architecture Coverage Matrix
| axis | decision | repo mechanism | missing piece | gate |
|---|---|---|---|---|
| strategy source | covered | current source catalog | none | build |
| edge model | covered | quote model | none | build |
| universe/admission | covered | intake audit | none | build |
| planner | covered | planner harness | none | build |
| quote/pnl | covered | pnl tooling | none | build |
| state/freshness | covered | latency metrics | none | build |
| sim/replay | covered | replay harness | none | build |
| execution | covered | bundle router | none | build |
| safety/position | covered | safety gates | none | build |
| learning/auto-close | covered | learning case store | none | build |
| observability/tooling | covered | hermes gate | none | build |
| non-goals/isolation | covered | scope notes | none | build |
`;
}

function menuTraceMd(): string {
  return `# Hermes

## Method Trace
\`\`\`
task_class: competitor_path | bundle_postmortem | architecture_review | replay_fixture | protocol_leg | implementation
tools_used: - <tool / command / file>
evidence_order: 1. structured output | 2. raw trace
analysis_frame: - <frame>
sanity_checks: - <checks>
tool_gap: none | <what the tool missed>
codify_next: no | <field/test/gate/tooling_defect + target file>
distill_for_opus: <one reusable rule Opus should learn>
\`\`\`
`;
}
