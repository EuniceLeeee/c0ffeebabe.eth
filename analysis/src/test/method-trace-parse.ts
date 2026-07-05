import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMethodTraceFields } from "../learning/method-trace.js";

test("parseMethodTraceFields keeps continuation lines without field bleed", () => {
  const fields = parseMethodTraceFields(`## Method Trace
\`\`\`
task_class: implementation
tools_used: cast run
jq '.result'
evidence_order: structured output
analysis_frame: implementation frame
sanity_checks: checked same block
tool_gap: none
codify_next: no
distill_for_opus: (1) first reusable rule
(2) second reusable rule
(3) third reusable rule
\`\`\`
`);

  assert.equal(fields.task_class, "implementation");
  assert.equal(fields.tools_used, "cast run\njq '.result'");
  assert.equal(
    fields.distill_for_opus,
    "(1) first reusable rule\n(2) second reusable rule\n(3) third reusable rule",
  );
});

test("parseMethodTraceFields stops at a code fence terminator", () => {
  const fields = parseMethodTraceFields(`## Method Trace
\`\`\`
distill_for_opus: keep this
and keep this
\`\`\`
not part of the field
`);

  assert.equal(fields.distill_for_opus, "keep this\nand keep this");
  assert.ok(!fields.distill_for_opus.includes("```"));
  assert.ok(!fields.distill_for_opus.includes("not part of the field"));
});

test("parseMethodTraceFields preserves the real multi-line distill_for_opus fixture", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const md = readFileSync(
    join(repoRoot, "docs", "analysis", "plan-unified-strategy-edge-20260705.md"),
    "utf8",
  );
  const block = md.match(/##\s*Method Trace[\s\S]*?(?=\n##\s|$)/i)?.[0];
  assert.ok(block, "expected Method Trace block in fixture");

  const fields = parseMethodTraceFields(block);
  assert.ok(fields.distill_for_opus.includes("(2)"), fields.distill_for_opus);
  assert.ok(fields.distill_for_opus.includes("(3)"), fields.distill_for_opus);
});
