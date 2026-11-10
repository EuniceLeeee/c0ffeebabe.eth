import assert from "node:assert/strict";
import test from "node:test";
import { selectFamilyActivation } from "../../../scripts/test-family-activation-report.mjs";

const ids = ["balancer-v1", "univ4", "protocol:erc4626"];
const result = (name: string, status = "passed", aggregate = false) => ({ name, status, aggregate });
const definitions = ids.map(id => result("installed JSON definition: " + id));
const summary = (failed: number) => ({ summary: failed === 0, counts: { tests: 10, failed, cancelled: 0 } });
const labels = (report: ReturnType<typeof selectFamilyActivation>) =>
  Object.fromEntries(report.families.map(({ id, result }: { id: string; result: string }) => [id, result]));

test("a Family-scoped failure does not prevent another tested Family from activating", () => {
  const report = selectFamilyActivation([
    ...definitions,
    result("[family=balancer-v1] production behavior", "failed"),
    result("parent suite", "failed", true),
    result("[family=univ4] production behavior"),
    summary(2),
  ], ids, 1);
  assert.deepEqual(report.sharedFailures, []);
  assert.deepEqual(labels(report), { "balancer-v1": "failed", univ4: "passed", "protocol:erc4626": "incomplete" });
});

test("unowned failures, skipped behavior and an incomplete report cannot promote Families", () => {
  const report = selectFamilyActivation([
    ...definitions, result("[family=univ4] behavior"),
    result("[family=univ4] second direction", "incomplete"), result("shared compiler", "failed"), summary(1),
  ], ids, 1);
  assert.deepEqual(report.sharedFailures, ["shared compiler"]);
  assert.equal(labels(report).univ4, "incomplete");
  assert.throws(() => selectFamilyActivation(definitions, ids, 0), /incomplete/);
  assert.throws(() => selectFamilyActivation([...definitions, summary(1)], ids, 1), /failure accounting/);
});
