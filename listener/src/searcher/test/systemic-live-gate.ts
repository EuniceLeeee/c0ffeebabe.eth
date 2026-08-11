import assert from "node:assert/strict";
import {
  evaluateSystemicLiveGate,
  type SystemicLiveGateInput,
} from "../systemic-live-gate.js";

function input(overrides: Partial<SystemicLiveGateInput> = {}): SystemicLiveGateInput {
  return Object.freeze({
    pairedLiveVerdict: "pass",
    exactSemanticsStatus: "pass",
    challengerOnlyRepeatedFailureCategories: Object.freeze([]),
    baselineAbsoluteHeadCoveragePass: true,
    challengerAbsoluteHeadCoveragePass: true,
    challengerRelativeHeadCoveragePass: true,
    completedHeadsPass: true,
    candidateOverlapPass: true,
    throughputPass: true,
    baselineTimingPass: true,
    challengerTimingPass: true,
    ...overrides,
  });
}

function main(): void {
  const pass = evaluateSystemicLiveGate(input());
  assert.deepEqual(pass, { status: "pass", reasons: [] });
  assert(Object.isFrozen(pass));
  assert(Object.isFrozen(pass.reasons));

  const verdictFail = evaluateSystemicLiveGate(input({
    pairedLiveVerdict: "fail",
  }));
  assert.equal(verdictFail.status, "not-pass");
  assert(verdictFail.reasons.some((reason) =>
    reason.includes("paired-live verdict")
  ));

  const semanticFail = evaluateSystemicLiveGate(input({
    exactSemanticsStatus: "fail",
  }));
  assert.equal(semanticFail.status, "not-pass");
  assert(semanticFail.reasons.some((reason) =>
    reason.includes("exact semantics")
  ));

  const repeated = evaluateSystemicLiveGate(input({
    challengerOnlyRepeatedFailureCategories: ["queue-exhaustion"],
  }));
  assert.equal(repeated.status, "not-pass");
  assert(repeated.reasons.some((reason) =>
    reason.includes("challenger-only repeated")
  ));

  for (const [key, label] of [
    ["baselineAbsoluteHeadCoveragePass", "baseline absolute"],
    ["challengerAbsoluteHeadCoveragePass", "challenger absolute"],
    ["challengerRelativeHeadCoveragePass", "challenger relative"],
    ["completedHeadsPass", "completed-heads"],
    ["candidateOverlapPass", "candidate overlap"],
    ["throughputPass", "throughput"],
    ["baselineTimingPass", "baseline terminal-latency"],
    ["challengerTimingPass", "challenger terminal-latency"],
  ] as const) {
    const failed = evaluateSystemicLiveGate(input({
      [key]: false,
    } as Partial<SystemicLiveGateInput>));
    assert.equal(failed.status, "not-pass");
    assert(failed.reasons.some((reason) => reason.includes(label)));
  }

  const all = evaluateSystemicLiveGate(input({
    pairedLiveVerdict: "invalid",
    exactSemanticsStatus: "n/a",
    challengerOnlyRepeatedFailureCategories: ["a", "b"],
    baselineAbsoluteHeadCoveragePass: false,
    challengerAbsoluteHeadCoveragePass: false,
    challengerRelativeHeadCoveragePass: false,
    completedHeadsPass: false,
    candidateOverlapPass: false,
    throughputPass: false,
    baselineTimingPass: false,
    challengerTimingPass: false,
  }));
  assert.equal(all.status, "not-pass");
  assert.equal(all.reasons.length, 11);
  console.log("systemic-live gate PASS");
}

main();
