import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "./fixtures/protocol-json/cases/wsteth--wrap-original-input.json";
import { parseProtocolJsonAcceptanceCase } from "./protocol-json-acceptance-facts.js";
import { registerAcceptanceSample } from "./protocol-json-sample-registration.js";
import { classifyAcceptanceEvidence, readFamilyRegressionVerdicts, selectRegressionFamilies, verifyRegressionCaseEvidence, type RegressionPlan } from "./family-json-regression.js";

test("batch acceptance requires the runner's registered sample and unchanged pins", () => {
  const normalized = parseProtocolJsonAcceptanceCase(sample);
  const registration = registerAcceptanceSample(normalized,
    fileURLToPath(new URL("./fixtures/protocol-json/cases/wsteth--wrap-original-input.json", import.meta.url)));
  const evidence = { format: "protocol-json-acceptance-v1", sample: normalized,
    drained: true, errors: [], result: "pass", registration,
    samples: [{ result: "pass", executions: [{ result: "pass" }] }] };
  assert.equal(classifyAcceptanceEvidence(evidence, sample, 0), "pass");
  for (const changed of [undefined, {...registration,sha256:"0".repeat(64)},
    {...registration,indexSha256:"0".repeat(64)}, {...registration,path:"/missing/case.json"}])
    assert.equal(classifyAcceptanceEvidence({...evidence,registration:changed},sample,0),"failed");
  assert.equal(classifyAcceptanceEvidence({...evidence, samples: []},sample,0),"failed");
  assert.equal(classifyAcceptanceEvidence(evidence,sample,1),"failed");
});

test("report recheck reads registered facts instead of trusting a cached pass", t => {
  const directory = mkdtempSync(join(tmpdir(), "registered-report-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = fileURLToPath(new URL("./fixtures/protocol-json/cases/wsteth--wrap-original-input.json", import.meta.url));
  const normalized = parseProtocolJsonAcceptanceCase(sample), registration = registerAcceptanceSample(normalized, file);
  const evidence = { format: "protocol-json-acceptance-v1", sample: normalized, drained: true,
    errors: [], result: "pass", registration, samples: [{ result: "pass", executions: [{ result: "pass" }] }] };
  const plan = {families:[{cases:[{id:"sample",file}]}]} as RegressionPlan;
  const verify = (facts: unknown, code = 0) => {
    const bytes = JSON.stringify(facts);
    writeFileSync(join(directory,"0000.json"),bytes);
    const rows = [{id:"sample",status:"pass",process:{code},evidence:"0000.json",
      evidenceSha256:createHash("sha256").update(bytes).digest("hex")}];
    return verifyRegressionCaseEvidence(plan, rows, directory, directory);
  };
  assert(verify(evidence));
  assert(!verify({...evidence,registration:undefined}));
  assert(!verify({...evidence,registration:{...registration,indexSha256:"0".repeat(64)}}));
  assert(!verify({...evidence,sample:{...normalized,instanceKey:"wrong"}}));
  assert(!verify(evidence,1));
  assert(!verifyRegressionCaseEvidence(plan, [], directory, directory));
});


test("one runner scopes registered cases and independently rechecks each Family verdict", t => {
  const directory = mkdtempSync(join(tmpdir(), "family-verdicts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = fileURLToPath(new URL("./fixtures/protocol-json/cases/wsteth--wrap-original-input.json", import.meta.url));
  const normalized = parseProtocolJsonAcceptanceCase(sample);
  const registration = registerAcceptanceSample(normalized, file);
  const passing = normalized.familyId, failing = "balancer-v1";
  const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const evidence = JSON.stringify({ format: "protocol-json-acceptance-v1", sample: normalized, registration,
    drained: true, errors: [], result: "pass", samples: [{ result: "pass", executions: [{ result: "pass" }] }] });
  const plan: RegressionPlan = { format: "family-json-regression-plan-v1", sourceFingerprint: "source", testFingerprint: "tests",
    families: [passing, failing].map(id => ({ familyId: id, domain: "protocol", definition: id + ".json", entry: id + ".ts",
      variants: [], gaps: [], cases: [{ id, familyId: id, file, sha256: registration.sha256 }] })) };
  const offline = [
    { name: `installed JSON definition: ${passing}`, status: "passed" },
    { name: `installed JSON definition: ${failing}`, status: "passed" },
    { name: `[family=${failing}] quote behavior`, status: "failed" },
    { summary: false, counts: { tests: 3, failed: 1, cancelled: 0 } },
  ].map(row => JSON.stringify(row)).join("\n");
  const passedCase = { id: passing, status: "pass", process: { code: 0 }, evidence: "0000.json", evidenceSha256: digest(evidence) };
  const report = { format: "family-json-regression-round-v1", sourceStable: true, finished: true,
    plan, offline: { code: 1, evidenceSha256: digest(offline) },
    definitions: { [passing]: { status: "pass" }, [failing]: { status: "pass" } },
    cases: [passedCase, { id: failing, status: "failed" }] };
  const path = join(directory, "report.json");
  const save = (value: unknown) => writeFileSync(path, JSON.stringify(value));
  writeFileSync(join(directory, "offline-tests.jsonl"), offline);
  writeFileSync(join(directory, "0000.json"), evidence);
  save(report);
  const verdicts = () => readFamilyRegressionVerdicts(path, plan, directory).map(row => [row.familyId, row.result]);
  assert.deepEqual(verdicts(), [[passing, "supplied-cases-pass"], [failing, "failed"]]);
  save({ ...report, plan: selectRegressionFamilies(plan, [passing]), cases: [passedCase] });
  assert.deepEqual(verdicts(), [[passing, "supplied-cases-pass"]], "a requested Family needs no other Family's cases");
  assert.throws(() => readFamilyRegressionVerdicts(path, { ...plan, testFingerprint: "new-tests" }, directory), /inputs changed/);
  assert.throws(() => selectRegressionFamilies(plan, ["uninstalled"]), /unknown/);
  writeFileSync(join(directory, "0000.json"), "{}");
  assert.deepEqual(verdicts(), [[passing, "failed"]], "a saved success cannot replace case evidence");
});
