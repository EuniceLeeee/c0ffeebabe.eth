import assert from "node:assert/strict";
import test from "node:test";
import { assertIssuedProductionTerminalPhaseObservationPortV1 } from "../src/index.ts";
import {
  issueProductionTerminalPhaseObservationPortV1,
  readProductionTerminalPhaseObservationResultV1,
} from "../src/internal/owner.ts";

const invocation = Object.freeze({
  finalDurableWindowCapability: Object.freeze({}),
  fullGraphCoarseSweepCapability: Object.freeze({}),
  runtimeReleaseTerminalBindingCapability: Object.freeze({}),
  fullFamilyObservationResultCapability: Object.freeze({}),
  sixStepObservationResultCapability: Object.freeze({}),
});

test("terminal-phase observation is acceptance-issued and opaque", async () => {
  const expected = Object.freeze({ kind: "sealed" });
  const port = issueProductionTerminalPhaseObservationPortV1(async input => {
    assert.equal(input.finalDurableWindowCapability, invocation.finalDurableWindowCapability);
    return expected;
  });
  assertIssuedProductionTerminalPhaseObservationPortV1(port);
  const result = await port.seal(invocation);
  assert.equal(readProductionTerminalPhaseObservationResultV1(result), expected);
  assert.throws(() => assertIssuedProductionTerminalPhaseObservationPortV1({ ...port }), /not owner-issued/);
  assert.throws(() => readProductionTerminalPhaseObservationResultV1({ ...result }), /not issued/);
});

test("terminal-phase invocation rejects decoded results and caller verdicts", async () => {
  const port = issueProductionTerminalPhaseObservationPortV1(async () => Object.freeze({}));
  await assert.rejects(port.seal({ ...invocation, verdict: "pass" } as never), /non-exact fields/);
});
