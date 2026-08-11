import assert from "node:assert/strict";
import {
  evaluateDefaultAuthorityCutoverGate,
} from "../default-authority-cutover-gate.js";

function main(): void {
  const ready = evaluateDefaultAuthorityCutoverGate({
    strictConsumerActive: true,
    legacyAuthorityActive: false,
    batchParityPass: true,
    heldOutNegativesPass: true,
    systemicLiveGatePass: true,
  });
  assert.deepEqual(ready, { status: "ready", reasons: [] });

  const inactive = evaluateDefaultAuthorityCutoverGate({
    strictConsumerActive: false,
    legacyAuthorityActive: true,
    batchParityPass: true,
    heldOutNegativesPass: true,
    systemicLiveGatePass: true,
  });
  assert.equal(inactive.status, "not-eligible");
  assert(inactive.reasons.some((reason) =>
    reason.includes("not the active production path")
  ));
  assert(inactive.reasons.some((reason) =>
    reason.includes("dual authority")
  ));

  const dual = evaluateDefaultAuthorityCutoverGate({
    strictConsumerActive: true,
    legacyAuthorityActive: true,
    batchParityPass: true,
    heldOutNegativesPass: true,
    systemicLiveGatePass: true,
  });
  assert.equal(dual.status, "not-eligible");
  assert(dual.reasons.some((reason) => reason.includes("dual authority")));

  const parityFail = evaluateDefaultAuthorityCutoverGate({
    strictConsumerActive: true,
    legacyAuthorityActive: false,
    batchParityPass: false,
    heldOutNegativesPass: true,
    systemicLiveGatePass: true,
  });
  assert.equal(parityFail.status, "not-eligible");
  assert(parityFail.reasons.some((reason) =>
    reason.includes("batch parity receipt")
  ));

  const heldOutFail = evaluateDefaultAuthorityCutoverGate({
    strictConsumerActive: true,
    legacyAuthorityActive: false,
    batchParityPass: true,
    heldOutNegativesPass: false,
    systemicLiveGatePass: true,
  });
  assert.equal(heldOutFail.status, "not-eligible");
  assert(heldOutFail.reasons.some((reason) =>
    reason.includes("held-out negative")
  ));

  const systemicFail = evaluateDefaultAuthorityCutoverGate({
    strictConsumerActive: true,
    legacyAuthorityActive: false,
    batchParityPass: true,
    heldOutNegativesPass: true,
    systemicLiveGatePass: false,
  });
  assert.equal(systemicFail.status, "not-eligible");
  assert(systemicFail.reasons.some((reason) =>
    reason.includes("systemic-live")
  ));

  assert(Object.isFrozen(ready.reasons));
  console.log("default-authority cutover gate PASS");
}

main();
