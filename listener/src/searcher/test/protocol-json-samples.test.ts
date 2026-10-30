import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadProtocolJsonSamples, protocolJsonSamplesPath } from "./protocol-json-samples.js";

test("every stored historical case has a matching source, transaction, direction and amount provenance", () => {
  const result = loadProtocolJsonSamples();
  assert(result.cases.length > 0); assert.equal(result.execution, "not-run");
  assert(result.summary.every(row => row.execution === "not-run"));
});

function changed(change: (index: any, root: string) => void, pattern: RegExp) {
  const root = mkdtempSync(join(tmpdir(), "protocol-json-samples-"));
  try {
    cpSync(dirname(protocolJsonSamplesPath), root, { recursive: true });
    const path = join(root, "index.json"), index = JSON.parse(readFileSync(path, "utf8"));
    change(index, root); writeFileSync(path, JSON.stringify(index));
    assert.throws(() => loadProtocolJsonSamples(path), pattern);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const first = (index: any) => index.families.flatMap((family: any) => family.samples).find((sample: any) => sample.casePath !== null);

test("sample metadata cannot upgrade absent inputs, orphan a case or substitute another transaction", () => {
  changed(index => { first(index).transactionHash = "0x" + "12".repeat(32); }, /transaction mismatch/);
  changed(index => { first(index).missing.push("amountIn"); }, /missing fields/);
  changed(index => { first(index).amounts = []; }, /assertion|false/i);
  changed(index => { index.families.find((f: any) => f.completeCases > 0).completeCases++; }, /stale sample count/);
  changed((index, root) => { const s = first(index); writeFileSync(join(root, "cases", "unindexed.json"), readFileSync(join(root, s.casePath))); }, /unindexed case/);
});

test("case paths cannot escape the library and historical outputs are not automatic new-state expectations", () => {
  changed(index => { first(index).casePath = protocolJsonSamplesPath; }, /library relative/);
  changed((index, root) => { const s = first(index), file = join(root, s.casePath); rmSync(file); symlinkSync(protocolJsonSamplesPath, file); }, /escapes sample library/);
  changed((index, root) => { const file = join(root, first(index).casePath), data = JSON.parse(readFileSync(file, "utf8"));
    data.trials[0].expectedAmountOut = "1"; writeFileSync(file, JSON.stringify(data)); }, /borrows input only/);
});

test("case identity, state and actor metadata cannot drift independently of executable inputs", () => {
  changed(index => { first(index).instanceKey = "another-instance"; }, /assertion|equal|another-instance/i);
  changed(index => { first(index).lineageId = "another:variant"; }, /assertion|equal|another:variant/i);
  changed(index => { first(index).source.number++; }, /assertion|equal/i);
  changed(index => { first(index).source.hash = "0x" + "34".repeat(32); }, /assertion|equal/i);
  changed(index => { first(index).actors.executor = "0x" + "45".repeat(20); }, /actor mismatch/);
  changed(index => { first(index).actors.owner = "0x" + "56".repeat(20); }, /actor mismatch/);
  changed(index => { first(index).amounts[0].amountIn = "1"; }, /recorded input source/);
});

test("runnable references must retain historical provenance and canonical block-end scope", () => {
  changed(index => { first(index).classification = "synthetic-unit-fixture"; }, /historical|classification/i);
  changed(index => { first(index).stateScope = "pre-competitor-in-block"; }, /canonical|scope|block-end/i);
  changed(index => { first(index).amounts[0].provenance.sha256 = "malformed"; }, /provenance|pin/i);
  changed(index => { first(index).amounts[0].provenance.sha256 = "ab".repeat(32); }, /provenance|pin/i);
  changed((index, root) => { const reference = first(index), original = join(root, reference.casePath);
    reference.casePath = "outside-cases.json";
    writeFileSync(join(root, reference.casePath), readFileSync(original)); rmSync(original);
  }, /cases|library relative/i);
});

test("passing historical labels never become executable case assertions", () => {
  changed((index, root) => { const file = join(root, first(index).casePath), data = JSON.parse(readFileSync(file, "utf8"));
    data.acceptance = "pass"; writeFileSync(file, JSON.stringify(data));
  }, /unknown field/);
  changed(index => { const pending = index.families.flatMap((family: any) => family.samples)
    .find((sample: any) => sample.casePath === null); pending.missing = []; }, /missing-field reason/);
});
