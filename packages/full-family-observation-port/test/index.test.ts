import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIssuedProductionFullFamilyObservationPortV1,
} from "../src/index.ts";
import {
  issueProductionFullFamilyObservationPortV1,
  readProductionFullFamilyObservationResultV1,
} from "../src/internal/owner.ts";

const invocation = Object.freeze({
  checkpointReader: Object.freeze({}),
  stage12Capability: Object.freeze({}),
  runtimeReleaseTerminalBindingCapability: Object.freeze({}),
  fullGraphCoarseSweepCapability: Object.freeze({}),
});

test("only an owner-issued port can seal an opaque observation result", async () => {
  const expected = Object.freeze({ kind: "observed" });
  const port = issueProductionFullFamilyObservationPortV1(async input => {
    assert.equal(input.checkpointReader, invocation.checkpointReader);
    return expected;
  });
  assertIssuedProductionFullFamilyObservationPortV1(port);
  const capability = await port.observe(invocation);
  assert.equal(readProductionFullFamilyObservationResultV1(capability), expected);
  assert.throws(() => assertIssuedProductionFullFamilyObservationPortV1({ ...port }), /not owner-issued/);
  assert.throws(() => readProductionFullFamilyObservationResultV1({ ...capability }), /not issued/);
});

test("invocation shape is exact and cannot carry caller verdicts", async () => {
  const port = issueProductionFullFamilyObservationPortV1(async () => Object.freeze({}));
  await assert.rejects(
    port.observe({ ...invocation, verdict: "pass" } as never),
    /non-exact fields/,
  );
});
