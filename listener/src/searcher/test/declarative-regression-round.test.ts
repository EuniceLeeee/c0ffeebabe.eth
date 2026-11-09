import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { buildFamilyRegressionPlan, sameRegressionInputs, summarizeFamilyRerun, classifyAcceptanceEvidence, type RegressionPlan } from "./family-json-regression.js";
import sample from "./fixtures/protocol-json/cases/wsteth--wrap-original-input.json";
import { parseProtocolJsonAcceptanceCase } from "./protocol-json-acceptance-facts.js";

// The normal shared suite also checks every installed JSON entry automatically.
// This is explicitly definition-level evidence; historical facts use the batch entry.
const installed = await buildFamilyRegressionPlan();
for (const family of installed.families) test(`installed JSON definition: ${family.familyId}`, async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const { plugin } = await import(pathToFileURL(resolve(root, family.entry)).href);
  assert.equal(plugin.manifest.familyId, family.familyId);
  assert.equal(plugin.manifest.domain, family.domain);
});

const plan: RegressionPlan = { format: "family-json-regression-plan-v1", testFingerprint: "test-a", sourceFingerprint: "source-a", families: [
  { familyId: "protocol:enabled", domain: "protocol", definition: "a.json", entry: "a.production.ts", variants: [{ id: "standard", lineageId: "a" }], gaps: [],
    cases: [{ id: "a", familyId: "protocol:enabled", file: "cases/a.json", sha256: "a" }] },
  { familyId: "swap-disabled", domain: "swap", definition: "b.json", entry: "b.production.ts", variants: [{ id: "standard", lineageId: "b" }], gaps: [],
    cases: [{ id: "b", familyId: "swap-disabled", file: "cases/b.json", sha256: "b" }] },
] };

test("shared test changes expire the complete installed family round, independent of activation", () => {
  assert(sameRegressionInputs(plan, structuredClone(plan)));
  for (const edit of [
    (p: RegressionPlan) => { p.testFingerprint = "test-b"; },
    (p: RegressionPlan) => { p.sourceFingerprint = "source-b"; },
    (p: RegressionPlan) => { p.families[0]!.cases[0]!.sha256 = "changed-sample"; },
    (p: RegressionPlan) => { p.families.pop(); },
    (p: RegressionPlan) => { p.families[0]!.variants.push({ id: "new", lineageId: "new" }); },
  ]) { const changed = structuredClone(plan); edit(changed); assert(!sameRegressionInputs(changed, plan)); }
});

test("a framework pass never promotes missing, partial, failed or unexecuted family facts", () => {
  const family = plan.families[0]!;
  assert.equal(summarizeFamilyRerun(family, [{ id: "a", status: "pass" }], true).result, "supplied-cases-pass");
  for (const status of ["not-run", "running", "incomplete"] as const)
    assert.equal(summarizeFamilyRerun(family, [{ id: "a", status }], true).result, "incomplete");
  assert.equal(summarizeFamilyRerun(family, [], true).result, "incomplete");
  assert.equal(summarizeFamilyRerun(family, [{ id: "a", status: "failed" }], true).result, "failed");
  assert.equal(summarizeFamilyRerun(family, [{ id: "a", status: "pass" }], false).result, "failed");
  assert.equal(summarizeFamilyRerun({ ...family, cases: [] }, [], true).result, "incomplete");
  assert.equal(summarizeFamilyRerun({ ...family, gaps: ["reverse direction missing"] }, [{ id: "a", status: "pass" }], true).result, "incomplete");
  assert.equal(summarizeFamilyRerun(plan.families[1]!, [{ id: "a", status: "pass" }], true).result, "incomplete");
});

test("case aggregation normalizes inputs and separates missing coverage from a real failure", () => {
  const normalized = parseProtocolJsonAcceptanceCase(sample);
  const evidence = { format: "protocol-json-acceptance-v1", sample: normalized, drained: true, errors: [], result: "pass",
    samples: [{ result: "pass", executions: [{ result: "pass" }] }] };
  assert.equal(classifyAcceptanceEvidence(evidence, sample, 0), "pass");
  assert.equal(classifyAcceptanceEvidence({ ...evidence, result: "incomplete-or-failed" }, sample, 1), "incomplete");
  for (const changed of [
    { ...evidence, result: "incomplete-or-failed", samples: [{ result: "failed", executions: [], error: "actual debit mismatch" }] },
    { ...evidence, result: "incomplete-or-failed", samples: [{ result: "partial", executions: [{ result: "failed" }] }] },
    { ...evidence, errors: ["transport failure"] },
    { ...evidence, drained: false },
    { ...evidence, samples: [] },
  ]) assert.equal(classifyAcceptanceEvidence(changed, sample, 1), "failed");
  assert.equal(classifyAcceptanceEvidence(evidence, sample, null), "failed");
  assert.throws(() => classifyAcceptanceEvidence({ ...evidence, sample: { ...normalized, instanceKey: "wrong" } }, sample, 0));
});
