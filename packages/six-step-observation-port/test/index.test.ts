import assert from "node:assert/strict";
import test from "node:test";
import { assertIssuedProductionSixStepObservationPortV1 } from "../src/index.ts";
import {
  issueProductionSixStepObservationPortV1,
  readProductionSixStepObservationResultV1,
} from "../src/internal/owner.ts";

test("Six-Step observation is acceptance-issued and opaque", async () => {
  const expected = Object.freeze({ status: "observed" });
  const windowSelectionCapability = Object.freeze({});
  const terminalBindingCapability = Object.freeze({});
  const joinedProcessCapability = Object.freeze({});
  const port = issueProductionSixStepObservationPortV1(async input => {
    assert.equal(input.windowSelectionCapability, windowSelectionCapability);
    assert.equal(input.terminalBindingCapability, terminalBindingCapability);
    assert.equal(input.joinedProcessCapability, joinedProcessCapability);
    return expected;
  });
  assertIssuedProductionSixStepObservationPortV1(port);
  const capability = await port.observe({ windowSelectionCapability, terminalBindingCapability, joinedProcessCapability });
  assert.equal(readProductionSixStepObservationResultV1(capability), expected);
  assert.throws(() => assertIssuedProductionSixStepObservationPortV1({ ...port }), /not owner-issued/);
  assert.throws(() => readProductionSixStepObservationResultV1({ ...capability }), /not issued/);
});

test("Six-Step invocation rejects caller verdict fields", async () => {
  const port = issueProductionSixStepObservationPortV1(async () => Object.freeze({}));
  await assert.rejects(port.observe({
    windowSelectionCapability: Object.freeze({}),
    terminalBindingCapability: Object.freeze({}),
    joinedProcessCapability: Object.freeze({}),
    verdict: "pass",
  } as never), /non-exact fields/);
});
