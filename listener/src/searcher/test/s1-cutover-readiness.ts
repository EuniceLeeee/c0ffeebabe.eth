import assert from "node:assert/strict";
import {
  evaluateS1CutoverReadiness,
  type S1CutoverReadinessInput,
} from "../s1-cutover-readiness.js";
import { productionFamilyStartupManifest } from
  "../production-family-startup-manifest.js";

function input(overrides: Partial<S1CutoverReadinessInput> = {}): S1CutoverReadinessInput {
  return Object.freeze({
    batchParityPass: true,
    heldOutNegativesPass: true,
    systemicLiveVerdict: "pass",
    startupManifest: productionFamilyStartupManifest(),
    strictConsumerSourceBound: true,
    ...overrides,
  });
}

function main(): void {
  const ready = evaluateS1CutoverReadiness(input());
  assert.deepEqual(ready, { status: "ready", reasons: [] });
  assert(Object.isFrozen(ready));

  const parityFail = evaluateS1CutoverReadiness(input({
    batchParityPass: false,
  }));
  assert.equal(parityFail.status, "not-ready");
  assert(parityFail.reasons.some((reason) =>
    reason.includes("batch parity")
  ));

  const heldOutFail = evaluateS1CutoverReadiness(input({
    heldOutNegativesPass: false,
  }));
  assert.equal(heldOutFail.status, "not-ready");
  assert(heldOutFail.reasons.some((reason) =>
    reason.includes("held-out negative")
  ));

  const liveFail = evaluateS1CutoverReadiness(input({
    systemicLiveVerdict: "not-pass",
  }));
  assert.equal(liveFail.status, "not-ready");
  assert(liveFail.reasons.some((reason) =>
    reason.includes("systemic-live gate")
  ));

  const manifestFail = evaluateS1CutoverReadiness(input({
    startupManifest: Object.freeze({
      ...productionFamilyStartupManifest(),
      manifestHash: "0".repeat(64),
    }),
  }));
  assert.equal(manifestFail.status, "not-ready");
  assert(manifestFail.reasons.some((reason) =>
    reason.includes("startup manifest")
  ));

  const sourceBoundFail = evaluateS1CutoverReadiness(input({
    strictConsumerSourceBound: false,
  }));
  assert.equal(sourceBoundFail.status, "not-ready");
  assert(sourceBoundFail.reasons.some((reason) =>
    reason.includes("source-bound")
  ));

  const all = evaluateS1CutoverReadiness(input({
    batchParityPass: false,
    heldOutNegativesPass: false,
    systemicLiveVerdict: "not-pass",
    strictConsumerSourceBound: false,
  }));
  assert.equal(all.status, "not-ready");
  assert.equal(all.reasons.length, 4);
  console.log("s1 cutover readiness PASS");
}

main();
