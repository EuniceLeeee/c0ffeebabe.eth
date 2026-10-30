import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { evidenceFailures, type FamilyReview } from "./family-settlement-review.js";
import { explicitSettlementAssertionFailures, isLegacySettlementRegistrarEvidence,
  legacySettlementRegistrarEvidenceFailures } from "./settlement-registrar-evidence.js";

const ordinaryAssertions = ["actual-input-debit", "actual-output-receipt", "old-inventory"];
const allAssertions = [...ordinaryAssertions, "rollback"];
const oldSummary = (passed: boolean, boring = false) => ({
  runSource: { number: 101, hash: "0x" + "01".repeat(32), generation: 1 },
  block: "0x" + "01".repeat(32),
  positive: { success: passed, grossProfit: passed ? "7" : "0", deltas: null, logs: 0 },
  [boring ? "impossible" : "rejected"]: { success: false, grossProfit: "0", deltas: null, logs: 0 },
  assertions: Object.fromEntries(allAssertions.map(key => [key, passed])),
});
function fixture(ordinary = false) {
  const store = new Map<string, Buffer>();
  const pin = (path: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value)); store.set(path, bytes);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  const read = (path: string) => { const bytes = store.get(path); assert(bytes, "missing fixture"); return bytes; };
  const source = [pin("listener/src/fixture.ts", "source")];
  const review = pin("docs/research/reports/review.json", { families: [{ familyId: "test:fixture",
    variants: [{ id: "v1", callback: ordinary ? "internal-only" : "none", recipient: ordinary ? "no" : "yes", callerContinuation: false }] }] });
  const saved = pin("single-leg.json", { fixture: "independent historical report shape", measurements: [{ inputDelta: "-7", outputDelta: "8", oldInput: "101", oldOutput: "103" }] });
  const row: FamilyReview = { familyId: "test:fixture", domain: "protocol", coverage: "complete", source, review,
    variants: [{ id: "v1", interface: "verified", identity: "verified", callback: ordinary ? "internal-only" : "none",
      recipient: ordinary ? "no" : "yes", wiring: "verified", execution: ordinary ? "not-required" : "verified", gaps: [], evidence: [review] }] };
  const base = {
    kind: ordinary ? "family-ordinary-execution-evidence-v1" : "family-settlement-behavior-evidence-v1",
    familyId: row.familyId, variantIds: ["v1"], result: "pass", positiveExecutions: 1, rejections: 1,
    source, commonSource: [], verifiedAssertions: ordinary ? ordinaryAssertions : allAssertions, evidence: [saved],
  };
  function update(patch: object = {}) {
    const evidence = pin("execution.json", { ...base, ...patch });
    if (ordinary) row.variants[0]!.ordinaryExecutionEvidence = evidence;
    else row.variants[0]!.executionEvidence = evidence;
  }
  update();
  return { row, update, read, pin };
}

test("legacy registrar detection is shape-specific and includes Boring and incomplete summaries", () => {
  for (const value of [oldSummary(true), oldSummary(false, true), { positive: null, assertions: {} },
    { positive: { success: true, grossProfit: "1" } }, { runSource: {}, impossible: {}, assertions: {} }]) {
    assert.equal(isLegacySettlementRegistrarEvidence(value), true);
    assert.match(legacySettlementRegistrarEvidenceFailures(value)[0]!, /single-leg/);
  }
  for (const value of [null, [], {}, { assertions: { "actual-input-debit": true } },
    { executions: [{ balances: [{ before: "108", after: "101", delta: "-7" }] }] }]) {
    assert.equal(isLegacySettlementRegistrarEvidence(value), false);
    assert.deepEqual(legacySettlementRegistrarEvidenceFailures(value), []);
  }
});

test("fresh hashes and verified labels cannot pass a false legacy positive execution", () => {
  for (const ordinary of [false, true]) for (const boring of [false, true]) {
    const f = fixture(ordinary); f.update(oldSummary(false, boring));
    assert.match(evidenceFailures(f.row, [], f.read).join("\n"), /whole-transaction/);
  }
});

test("all-true whole-loop summaries still lack single-leg facts and executed source/plan binding", () => {
  for (const patch of [oldSummary(true), oldSummary(true, true),
    { ...oldSummary(true), runSource: { number: 102, hash: "wrong-block", generation: 0 } },
    { ...oldSummary(true), block: "0x" + "02".repeat(32) },
    { ...oldSummary(true), singleLegFacts: { verified: true } }]) {
    const f = fixture();
    // The old writer always pinned trial-1, even if it executed a different
    // selected trial. A valid hash cannot establish that missing relationship.
    const wrongPlan = f.pin("trial-1-input.json", { source: { number: 99 }, plan: { id: "not-the-selected-plan" } });
    f.update({ ...patch, evidence: [wrongPlan] });
    assert.match(evidenceFailures(f.row, [], f.read).join("\n"), /executed source and plan pin/);
  }
});

test("explicit false required assertions reject in other report shapes, including ordinary execution", () => {
  for (const ordinary of [false, true]) {
    for (const key of ordinary ? ordinaryAssertions : allAssertions) for (const value of [false, null, 0, "true"]) {
      const f = fixture(ordinary); f.update({ assertions: { [key]: value } });
      assert.match(evidenceFailures(f.row, [], f.read).join("\n"), /explicit settlement assertion is not true/);
    }
  }
  for (const key of ["callback-caller", "callback-debt", "output-before-payment"]) {
    const f = fixture(); f.row.variants[0]!.callback = "output-first";
    f.update({ verifiedAssertions: [...allAssertions, "callback-caller", "callback-debt", "output-before-payment"], assertions: { [key]: false } });
    assert.match(evidenceFailures(f.row, [], f.read).join("\n"), /explicit settlement assertion is not true/);
  }
  assert.deepEqual(explicitSettlementAssertionFailures({ assertions: { unrelatedOptionalCheck: false } }, allAssertions), []);
  assert.match(explicitSettlementAssertionFailures({ assertions: false }, allAssertions)[0]!, /record/);
});

test("other historical evidence formats retain their existing contract without new acceptance claims", () => {
  for (const ordinary of [false, true]) {
    const f = fixture(ordinary);
    assert.deepEqual(evidenceFailures(f.row, [], f.read), []);
    f.update({ assertions: Object.fromEntries((ordinary ? ordinaryAssertions : allAssertions).map(key => [key, true])) });
    assert.deepEqual(evidenceFailures(f.row, [], f.read), []);
  }
});

test("retired registrars fail before external artifact reads, RPC or registry writes", () => {
  const guard = `
    import fs from 'node:fs';
    import net from 'node:net';
    import { syncBuiltinESMExports } from 'node:module';
    const forbidden = () => { throw Error('FORBIDDEN_REGISTRAR_SIDE_EFFECT'); };
    for (const key of ['readFileSync', 'writeFileSync', 'readdirSync']) {
      const original = fs[key];
      fs[key] = function(path, ...args) {
        const value = String(path);
        if (value.includes('/opt/mev-cloud/') || value === '/tmp/ds-rpc.json') forbidden();
        return original.call(this, path, ...args);
      };
    }
    net.Socket.prototype.connect = forbidden;
    globalThis.fetch = forbidden;
    syncBuiltinESMExports();
  `;
  for (const file of ["settlement-register-family.ts", "settlement-register-boring.ts"]) {
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
      "--import", "data:text/javascript," + encodeURIComponent(guard),
      fileURLToPath(new URL(file, import.meta.url)), "fixture", "missing-lane", "v1", "none", "yes"],
    { encoding: "utf8", env: { ...process.env, TSX_DISABLE_CACHE: "1" }, timeout: 15000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 1);
    assert.match(result.stderr, /Settlement registrar disabled/);
    assert.doesNotMatch(result.stderr, /FORBIDDEN_REGISTRAR_SIDE_EFFECT/);
  }
});
