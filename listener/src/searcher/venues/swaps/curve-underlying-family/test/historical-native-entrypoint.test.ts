import assert from "node:assert/strict";
import { test } from "node:test";
import { historicalCurveNativeFamily, assertHistoricalNegativeRevert } from "../../curve-plain-family/test/historical-native-dual.js";

test("historical native dual selects only the requested Curve family and preserves plain default", () => {
  assert.equal(historicalCurveNativeFamily(), "curve-plain");
  assert.equal(historicalCurveNativeFamily("curve-underlying"), "curve-underlying");
  for (const wrong of ["", "univ3-standard", "curve-plain,curve-underlying", "curve-plain "])
    assert.throws(() => historicalCurveNativeFamily(wrong), /unknown native Curve family/);
});

test("negative history evidence rejects missing results, transport errors, success and gas halts", () => {
  const good = { ok: true, success: false, strict: { outcome: { kind: "Revert", phase: "main", nestedHalt: null } } };
  assertHistoricalNegativeRevert(good);
  for (const bad of [null, {}, { ...good, ok: false }, { ...good, success: true },
    { ...good, strict: { outcome: { ...good.strict.outcome, kind: "Halt" } } },
    { ...good, strict: { outcome: { ...good.strict.outcome, phase: "probe" } } },
    { ...good, strict: { outcome: { ...good.strict.outcome, nestedHalt: "OutOfGas" } } }])
    assert.throws(() => assertHistoricalNegativeRevert(bad), /recorded main-call revert/);
});
