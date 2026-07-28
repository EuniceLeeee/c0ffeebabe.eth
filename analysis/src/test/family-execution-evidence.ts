import assert from "node:assert/strict";
import test from "node:test";
import {
  familyReplayFailureFingerprint,
  type FamilyReplayFingerprintReport,
} from "../family-execution-evidence.js";
import {
  createSemanticSixStepEvidence,
} from "../../../listener/src/shared/evidence/semantic-six-step.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function report(): FamilyReplayFingerprintReport & {
  failure: string;
  telemetry: Record<string, unknown>;
} {
  return {
    schemaVersion: 2,
    fixtureId: "fixture",
    fixturePath: "docs/research/reports/fixture.json",
    fixtureSha256: SHA_A,
    referenceTx: `0x${"1".repeat(64)}`,
    landedEvidencePath: "docs/research/reports/evidence.md",
    landedEvidenceSha256: SHA_B,
    executionFamilyId: "protocol:subject",
    routeExecutionFamilies: ["univ3-standard", "protocol:subject"],
    stateAnchor: { kind: "parent-block", blockNumber: 100 },
    anchorBlockHash: `0x${"2".repeat(64)}`,
    anchorStateRoot: `0x${"3".repeat(64)}`,
    anchorReconstruction: { kind: "canonical-parent-block", blockNumber: 100 },
    baseCommit: "4".repeat(40),
    adapterCommit: "5".repeat(40),
    familySourceSha256: SHA_A,
    sharedApiSha256: SHA_B,
    runtimeSourceSha256: "c".repeat(64),
    harnessSha256: "d".repeat(64),
    botVmArtifactSha256: "e".repeat(64),
    replayFlash: { adapterId: "balancer-flash", token: "0x1" },
    routeHash: "f".repeat(64),
    referenceRouteHash: "0".repeat(64),
    stages: {
      chainAnchor: true,
      referenceRoute: true,
      familyEdges: true,
      planner: false,
    },
    verdict: "implemented_not_validated",
    failureOwnerFamilyId: "protocol:subject",
    sixStepEvidence: [
      createSemanticSixStepEvidence({
        profile: "family_execution",
        step: 1,
        status: "bypassed",
        output: {
          mode: "route_pinned",
          execution_family_id: "protocol:subject",
          state_anchor: { kind: "parent-block", block_number: 100 },
        },
        reasonCode: "adapter_replay_bypasses_discovery",
      }),
      createSemanticSixStepEvidence({
        profile: "family_execution",
        step: 2,
        status: "bypassed",
        output: {
          mode: "route_pinned",
          fixture_route_sha256: SHA_A,
          route_leg_count: 2,
        },
        reasonCode: "adapter_replay_uses_trace_route",
      }),
      createSemanticSixStepEvidence({
        profile: "family_execution",
        step: 3,
        status: "fail",
        output: { completed: false },
        reasonCode: "adapter_replay_execution_error",
        metrics: { elapsed_ms: 1 },
        extensions: { error: "first" },
      }),
    ],
    failure: "first dynamic error",
    telemetry: { elapsedMs: 1 },
  };
}

test("family failure fingerprint excludes telemetry and raw error prose", () => {
  const baseline = report();
  const noisy = {
    ...baseline,
    failure: "different dynamic error",
    telemetry: { elapsedMs: 999 },
    sixStepEvidence: baseline.sixStepEvidence.map((stage, index) =>
      index !== 2
        ? stage
        : createSemanticSixStepEvidence({
            profile: "family_execution",
            step: 3,
            status: "fail",
            output: { completed: false },
            reasonCode: "adapter_replay_execution_error",
            metrics: { elapsed_ms: 999 },
            extensions: { error: "different" },
          })
    ),
  };
  assert.equal(
    familyReplayFailureFingerprint(baseline),
    familyReplayFailureFingerprint(noisy),
  );
});

test("family failure fingerprint binds owner, anchor, route and semantic output", () => {
  const baseline = report();
  const digest = familyReplayFailureFingerprint(baseline);
  for (const changed of [
    { ...baseline, failureOwnerFamilyId: "univ3-standard" },
    { ...baseline, anchorStateRoot: `0x${"9".repeat(64)}` },
    { ...baseline, routeHash: "9".repeat(64) },
    { ...baseline, stages: { ...baseline.stages, planner: true } },
    {
      ...baseline,
      sixStepEvidence: [
        ...baseline.sixStepEvidence.slice(0, 2),
        createSemanticSixStepEvidence({
          profile: "family_execution",
          step: 3,
          status: "fail",
          output: { completed: true },
          reasonCode: "adapter_replay_execution_error",
        }),
      ],
    },
  ]) {
    assert.notEqual(familyReplayFailureFingerprint(changed), digest);
  }
});
