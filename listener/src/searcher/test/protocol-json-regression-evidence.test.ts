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
import { classifyAcceptanceEvidence, verifyRegressionCaseEvidence, type RegressionPlan } from "./family-json-regression.js";

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
