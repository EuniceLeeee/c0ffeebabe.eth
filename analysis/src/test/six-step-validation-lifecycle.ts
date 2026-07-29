import assert from "node:assert/strict";
import test from "node:test";
import {
  createSemanticSixStepEvidence,
  semanticExactQuoteCommitmentSha256,
  semanticFinalSimCommitmentSha256,
  semanticJsonSha256,
  semanticRouteMembershipProofSha256,
  type SemanticSixStepEvidence,
} from "../../../listener/src/shared/evidence/semantic-six-step.js";
import {
  EMPTY_SHA256,
  sixStepLifecycleEnvelopeSha256,
  sixStepStateAnchorSha256,
  validateSixStepValidationLifecycle,
  type GitInspector,
} from "../six-step-validation-lifecycle.js";
import {
  canonicalTrustedSixStepInputSnapshotPayloadSha256,
  canonicalTrustedSixStepRuntimePayloadSha256,
  type TrustedSixStepInputSnapshot,
  type TrustedSixStepRuntimeAttestation,
} from "../trusted-six-step-runtime-attestation.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const HASH_A = `0x${SHA_A}`;
const HASH_B = `0x${SHA_B}`;
const TX_A = `0x${"1".repeat(64)}`;
const CANDIDATE = "1".repeat(40);
const BRANCH_TIP = CANDIDATE;
const MERGE = "3".repeat(40);
const ROLLBACK = "4".repeat(40);
const ORIGIN_MAIN = "5".repeat(40);
const RUN_ID = "6".repeat(64);
const TARGET_ROUTE = "7".repeat(64);
const RESOLVED_PLAN = "8".repeat(64);
const UNIVERSE_PATH =
  `/opt/MEV-runtime/universe/active-pools-${SHA_A}.json`;

function runtimeAttestation(
  commit: string,
  commandSuffix: "1" | "2",
): TrustedSixStepRuntimeAttestation {
  const unsigned = {
    schema_version: 1,
    kind: "trusted-six-step-runtime-attestation",
    instance_id: "i-0ff908dedeec9ebc6",
    runtime_commit: commit,
    process: {
      pid: 1234,
      starttime_ticks: "987654",
      n_restarts: 0,
    },
    universe: {
      path: UNIVERSE_PATH,
      sha256: SHA_A,
    },
    universe_manifest: {
      path: `${UNIVERSE_PATH}.manifest.json`,
      sha256: SHA_B,
    },
    pool_universe_top_n: 20_000,
    searcher_config: {
      SEARCHER_POOL_UNIVERSE_MANIFEST_PATH:
        `${UNIVERSE_PATH}.manifest.json`,
      SEARCHER_POOL_UNIVERSE_PATH: UNIVERSE_PATH,
      SEARCHER_POOL_UNIVERSE_TOP_N: "20000",
      SEARCHER_RUNTIME_COMMIT: commit,
    },
    sample_receipt: {
      tx_hash: TX_A,
      receipt_sha256: SHA_A,
      block_hash: HASH_A,
      block_number: 101,
      transaction_index: 1,
      status: 1,
    },
    parent_block: {
      number: 100,
      hash: HASH_A,
      state_root: HASH_B,
    },
    observed_at: commandSuffix === "1"
      ? "2026-07-28T01:02:03.000Z"
      : "2026-07-28T01:02:04.000Z",
  } as const;
  return {
    ...unsigned,
    searcher_config: { ...unsigned.searcher_config },
    payload_sha256: canonicalTrustedSixStepRuntimePayloadSha256(unsigned),
    command_id:
      `00000000-0000-0000-0000-00000000000${commandSuffix}`,
  };
}

function standingAnchor(): Record<string, unknown> {
  const base = {
    lane: "block_scan_standing",
    opportunity_block: 101,
    base_block: 100,
    base_block_hash: HASH_A,
    base_state_root: HASH_B,
    applied_prefix_tx_hashes: [],
    trigger_tx_hash: null,
    target_tx_index: null,
  };
  return {
    ...base,
    effective_state_hash: semanticJsonSha256({
      applied_prefix_tx_hashes: [],
      base_block_hash: HASH_A,
      base_state_root: HASH_B,
    }),
  };
}

function inputSnapshot(): TrustedSixStepInputSnapshot {
  const payload = {
    schema_version: 1 as const,
    kind: "trusted-six-step-input-snapshot" as const,
    sample_tx_hash: TX_A,
    lane: "block_scan_standing" as const,
    source_runtime_commit: ROLLBACK,
    local_universe: {
      path: "/tmp/frozen-universe.json",
      sha256: SHA_A,
    },
    local_universe_manifest: {
      path: "/tmp/frozen-universe.manifest.json",
      sha256: SHA_B,
    },
    runtime_attestation: runtimeAttestation(ROLLBACK, "1"),
    state_anchor: standingAnchor() as unknown as
      TrustedSixStepInputSnapshot["state_anchor"],
    created_at: "2026-07-28T01:02:05.000Z",
  };
  const payloadSha256 =
    canonicalTrustedSixStepInputSnapshotPayloadSha256(payload);
  return {
    ...payload,
    payload_sha256: payloadSha256,
  };
}

const MATERIALIZED_GRAPH = {
  scope: "all_materialized_edges",
  edgeCount: 2,
  sha256: SHA_A,
  familyEdges: [
    { familyId: "receipt-deposit", edgeCount: 1, sha256: SHA_A },
    { familyId: "univ3-standard", edgeCount: 1, sha256: SHA_B },
  ],
  targetInjected: false,
  graphReduced: false,
  capMode: "production_config",
} as const;

const SHARD_COMPLETENESS = {
  schemaVersion: 1,
  selection: "selected",
  dexShard: {
    shardId: "dex-universe",
    sourceKind: "dex-universe",
    status: "complete",
    required: true,
    edgeCount: 1,
    sha256: SHA_A,
    issues: [],
  },
  familyShards: [
    {
      shardId: "family:receipt-deposit",
      familyId: "receipt-deposit",
      sourceKind: "dynamic-discovery",
      status: "complete",
      required: true,
      disposition: "required",
      edgeCount: 1,
      sha256: SHA_A,
      sourceCoverage: [{ sourceId: "receipt-source", complete: true, issues: [] }],
      issues: [],
    },
    {
      shardId: "family:univ3-standard",
      familyId: "univ3-standard",
      sourceKind: "dex-universe",
      status: "complete",
      required: true,
      disposition: "required",
      edgeCount: 1,
      sha256: SHA_B,
      sourceCoverage: [],
      issues: [],
    },
  ],
  requiredFamilyIds: ["receipt-deposit", "univ3-standard"],
  requiredComplete: true,
  isolatedIncompleteFamilyIds: [],
  cacheReuse: { status: "not_measured", claimedHit: false },
} as const;

function stage(
  step: 1 | 2 | 3 | 4 | 5 | 6,
  stateAnchorSha256: string,
): SemanticSixStepEvidence {
  const common = {
    run_id: RUN_ID,
    state_anchor_sha256: stateAnchorSha256,
    target_route_sha256: TARGET_ROUTE,
  } as const;
  const membership = {
    ...common,
    route_set_sha256: SHA_A,
    route_set_size: 1,
    target_present: true,
  };
  const quote = {
    ...common,
    source_block: 101,
    route_sha256: TARGET_ROUTE,
    quote_status: "positive",
    probe_amount_in: "1",
    quoted_amount_out: "2",
    leg_quotes: [{ amount_in: "1", amount_out: "2" }],
  } as const;
  const finalSim = {
    ...common,
    input_resolved_plan_sha256: RESOLVED_PLAN,
    success: true,
    profit_token: "0xprofit",
    gross_profit: "2",
    net_profit: "1",
    gas_used: "100",
    calldata_sha256: SHA_A,
    repayment_and_conservation: "pass",
    leaves_standing_position: false,
  } as const;
  const outputs = {
    1: {
      ...common,
      source_block: 101,
      materialized_graph: {
        scope: "all_materialized_edges",
        edge_count: 2,
        sha256: SHA_A,
        family_edges: [
          { family_id: "receipt-deposit", edge_count: 1, sha256: SHA_A },
          { family_id: "univ3-standard", edge_count: 1, sha256: SHA_B },
        ],
        target_injected: false,
        graph_reduced: false,
        cap_mode: "production_config",
      },
      shard_completeness: {
        schema_version: 1,
        selection: "selected",
        dex_shard: {
          shard_id: "dex-universe",
          source_kind: "dex-universe",
          status: "complete",
          required: true,
          edge_count: 1,
          sha256: SHA_A,
          issues: [],
        },
        family_shards: SHARD_COMPLETENESS.familyShards.map((shard) => ({
          shard_id: shard.shardId,
          family_id: shard.familyId,
          source_kind: shard.sourceKind,
          status: shard.status,
          required: shard.required,
          disposition: shard.disposition,
          edge_count: shard.edgeCount,
          sha256: shard.sha256,
          source_coverage: shard.sourceCoverage.map((source) => ({
            source_id: source.sourceId,
            complete: source.complete,
            issues: source.issues,
          })),
          issues: shard.issues,
        })),
        required_family_ids: SHARD_COMPLETENESS.requiredFamilyIds,
        required_complete: true,
        isolated_incomplete_family_ids: [],
        cache_reuse: { status: "not_measured", claimed_hit: false },
      },
      edge_set_sha256: SHA_A,
      edge_set_size: 2,
      target_membership: "present",
      state_anchor_sha256: stateAnchorSha256,
    },
    2: {
      ...membership,
      target_route_membership_proof_sha256:
        semanticRouteMembershipProofSha256(membership),
    },
    3: {
      ...quote,
      selected_exact_quote_sha256:
        semanticExactQuoteCommitmentSha256(quote),
    },
    4: {
      ...common,
      route_sha256: TARGET_ROUTE,
      input_exact_quote_sha256:
        semanticExactQuoteCommitmentSha256(quote),
      selected_by_solve_policy: true,
      solve_succeeded: true,
      solver_selected_amount: "1",
      resolved_plan_sha256: RESOLVED_PLAN,
      hop_amounts: [{ amount_in: "1", amount_out: "2" }],
    },
    5: {
      ...finalSim,
      final_sim_sha256: semanticFinalSimCommitmentSha256(finalSim),
    },
    6: {
      ...common,
      input_final_sim_sha256: semanticFinalSimCommitmentSha256(finalSim),
      execution_status: "pass",
      decision: "allow",
      decision_reason: "positive_ev",
      net_ev_wei: "1",
      gas_cost_eth: "1",
      bid_eth: "0",
      valuation_available: true,
      gas_measurement_available: true,
      fee_state_available: true,
    },
  } as const;
  return createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step,
    status: "pass",
    output: outputs[step],
  });
}

function checkpoint(): Record<string, unknown> {
  const stateAnchor = standingAnchor();
  const stateAnchorSha256 = sixStepStateAnchorSha256(stateAnchor);
  const snapshot = inputSnapshot();
  const evidence: Record<string, unknown> = {
    schema_version: 1,
    gate: "six-step-validation-lifecycle",
    mode: "checkpoint",
    status: "checkpoint_pass",
    branch: "codex/receipt-deposit",
    branch_tip: BRANCH_TIP,
    candidate_commit: CANDIDATE,
    rollback_commit: ROLLBACK,
    sample_tx_hash: TX_A,
    target_route_sha256: TARGET_ROUTE,
    controller: {
      id: "trusted-production-replay-controller",
      controller_sha256: SHA_A,
      raw_producer_receipt_sha256: SHA_B,
    },
    state_anchor: stateAnchor,
    state_anchor_sha256: stateAnchorSha256,
    frozen_inputs: {
      universe_sha256: SHA_A,
      universe_manifest_sha256: SHA_B,
      config_sha256: SHA_A,
      graph_sha256: SHA_A,
      family_manifest_sha256: SHA_A,
      graph_builder_sha256: SHA_A,
      graph_snapshot_source_sha256: SHA_A,
      producer_sha256: SHA_A,
      pending_evidence_producer_sha256: SHA_B,
      pending_evidence_artifact_sha256: SHA_A,
      pending_evidence_required_sha256: SHA_B,
      comparator_sha256: SHA_A,
      input_snapshot_sha256: snapshot.payload_sha256,
      graph_snapshot_kind: "content_addressed",
      target_injected: false,
      graph_reduced: false,
    },
    materialized_graph: MATERIALIZED_GRAPH,
    shard_completeness: SHARD_COMPLETENESS,
    route_scope: "dex-permissionless-protocol",
    diff_class: "family_local",
    impacted_family_ids: ["receipt-deposit"],
    required_family_ids: ["univ3-standard", "receipt-deposit"],
    complete_family_ids: ["univ3-standard", "receipt-deposit"],
    central_behavior_diff_sha256: EMPTY_SHA256,
    other_family_source_set_baseline_sha256: SHA_B,
    other_family_source_set_challenger_sha256: SHA_B,
    exact_production_caps: true,
    runner_overrides: { wall_clock_timeout_ms: 600_000 },
    production_route_stage: [1, 2, 3, 4, 5, 6].map(
      (stepNumber) =>
        stage(
          stepNumber as 1 | 2 | 3 | 4 | 5 | 6,
          stateAnchorSha256,
        ),
    ),
    input_snapshot: snapshot,
  };
  evidence.checkpoint_evidence_sha256 =
    sixStepLifecycleEnvelopeSha256(evidence);
  return evidence;
}

function finalEvidence(
  mutate?: (evidence: Record<string, unknown>) => void,
): Record<string, unknown> {
  const evidence = checkpoint();
  evidence.mode = "final";
  evidence.status = "final_validated";
  delete evidence.checkpoint_evidence_sha256;
  delete evidence.input_snapshot;
  const runtimeBefore = runtimeAttestation(MERGE, "1");
  const runtimeAfter = runtimeAttestation(MERGE, "2");
  evidence.runtime_attestations = {
    before: runtimeBefore,
    after: runtimeAfter,
  };
  const frozenInputs = evidence.frozen_inputs as Record<string, unknown>;
  delete frozenInputs.input_snapshot_sha256;
  frozenInputs.runtime_attestation_before_sha256 =
    runtimeBefore.payload_sha256;
  frozenInputs.runtime_attestation_after_sha256 =
    runtimeAfter.payload_sha256;
  Object.assign(evidence, {
    merge_commit: MERGE,
    deployed_commit: MERGE,
    review: {
      reviewer_email: "reviewer@example.com",
      review_commit: ORIGIN_MAIN,
      artifact_path: "docs/research/reports/review.json",
      rollback_commit: ROLLBACK,
      reviewed_candidate_commit: CANDIDATE,
      reviewed_merge_commit: MERGE,
      diff_sha256: SHA_A,
      reviewed_at: "2026-07-28T01:02:06.000Z",
      evidence: "Independent review checked the exact candidate patch.",
      verdict: "pass",
      artifact_sha256: SHA_A,
    },
    checkpoint_receipt_sha256: SHA_A,
    deployment_receipt_sha256: SHA_A,
    config_receipt_sha256: SHA_B,
  });
  mutate?.(evidence);
  evidence.full_evidence_sha256 = sixStepLifecycleEnvelopeSha256(evidence);
  return evidence;
}

function gitInspector(overrides: Partial<GitInspector> = {}): GitInspector {
  const ancestors = new Set([
    `${CANDIDATE}:${MERGE}`,
    `${MERGE}:${ORIGIN_MAIN}`,
    `${CANDIDATE}:${BRANCH_TIP}`,
    `${ROLLBACK}:${CANDIDATE}`,
  ]);
  return {
    resolveRef: (ref) => ref === "refs/remotes/origin/main"
      ? ORIGIN_MAIN
      : ref === "refs/heads/codex/receipt-deposit"
        ? BRANCH_TIP
        : null,
    isAncestor: (ancestor, descendant) =>
      ancestors.has(`${ancestor}:${descendant}`),
    commitEmails: (commit) => commit === ORIGIN_MAIN
      ? ["reviewer@example.com"]
      : ["author@example.com", "committer@example.com"],
    commitRangeEmails: () => ["author@example.com", "committer@example.com"],
    pathLastCommit: () => ORIGIN_MAIN,
    changedPaths: () => ["docs/research/reports/review.json"],
    isValidBranchName: () => true,
    ...overrides,
  };
}

test("checkpoint accepts full production six-step evidence with only a timeout override", () => {
  assert.deepEqual(
    validateSixStepValidationLifecycle(checkpoint(), gitInspector()),
    [],
  );
});

test("checkpoint rejects cross-run stage splicing and broken causal commitments", () => {
  const cases: Array<[
    mutate: (stages: SemanticSixStepEvidence[]) => void,
    expected: RegExp,
  ]> = [
    [
      (stages) => {
        stages[3] = createSemanticSixStepEvidence({
          profile: "production_route_stage",
          step: 4,
          status: "pass",
          output: { ...stages[3].output, run_id: SHA_B },
        });
      },
      /run_id differs at step 4/,
    ],
    [
      (stages) => {
        stages[1] = createSemanticSixStepEvidence({
          profile: "production_route_stage",
          step: 2,
          status: "pass",
          output: {
            ...stages[1].output,
            target_route_membership_proof_sha256: SHA_B,
          },
        });
      },
      /membership proof does not bind/,
    ],
    [
      (stages) => {
        stages[3] = createSemanticSixStepEvidence({
          profile: "production_route_stage",
          step: 4,
          status: "pass",
          output: { ...stages[3].output, input_exact_quote_sha256: SHA_B },
        });
      },
      /does not consume the selected step 3 exact quote/,
    ],
    [
      (stages) => {
        stages[2] = createSemanticSixStepEvidence({
          profile: "production_route_stage",
          step: 3,
          status: "pass",
          output: {
            ...stages[2].output,
            selected_exact_quote_sha256: SHA_B,
          },
        });
      },
      /selected exact quote commitment does not bind/,
    ],
    [
      (stages) => {
        const changed = {
          ...stages[4].output,
          input_resolved_plan_sha256: SHA_B,
        };
        stages[4] = createSemanticSixStepEvidence({
          profile: "production_route_stage",
          step: 5,
          status: "pass",
          output: {
            ...changed,
            final_sim_sha256: semanticFinalSimCommitmentSha256(changed),
          },
        });
      },
      /does not execute the resolved step 4 plan/,
    ],
    [
      (stages) => {
        stages[4] = createSemanticSixStepEvidence({
          profile: "production_route_stage",
          step: 5,
          status: "pass",
          output: { ...stages[4].output, final_sim_sha256: SHA_B },
        });
      },
      /final sim commitment does not bind/,
    ],
    [
      (stages) => {
        stages[5] = createSemanticSixStepEvidence({
          profile: "production_route_stage",
          step: 6,
          status: "pass",
          output: { ...stages[5].output, input_final_sim_sha256: SHA_B },
        });
      },
      /does not evaluate the step 5 final sim/,
    ],
  ];

  for (const [mutate, expected] of cases) {
    const evidence = checkpoint();
    const stages = [
      ...(evidence.production_route_stage as SemanticSixStepEvidence[]),
    ];
    mutate(stages);
    evidence.production_route_stage = stages;
    evidence.checkpoint_evidence_sha256 =
      sixStepLifecycleEnvelopeSha256(evidence);
    assert.match(
      validateSixStepValidationLifecycle(evidence, gitInspector()).join("\n"),
      expected,
    );
  }
});

test("checkpoint rejects incomplete stages, target injection, and unrelated overrides", () => {
  const evidence = checkpoint();
  evidence.production_route_stage = (
    evidence.production_route_stage as SemanticSixStepEvidence[]
  ).slice(0, 5);
  (evidence.frozen_inputs as Record<string, unknown>).target_injected = true;
  evidence.runner_overrides = {
    wall_clock_timeout_ms: 600_000,
    max_candidates: 9_999,
  };
  const errors = validateSixStepValidationLifecycle(
    evidence,
    gitInspector(),
  ).join("\n");
  assert.match(errors, /all six stages/);
  assert.match(errors, /target_injected must be false/);
  assert.match(errors, /only wall_clock_timeout_ms/);
});

test("checkpoint binds the pending evidence producer and frozen artifact", () => {
  const missingProducer = checkpoint();
  delete (
    missingProducer.frozen_inputs as Record<string, unknown>
  ).pending_evidence_producer_sha256;
  missingProducer.checkpoint_evidence_sha256 =
    sixStepLifecycleEnvelopeSha256(missingProducer);
  assert.match(
    validateSixStepValidationLifecycle(
      missingProducer,
      gitInspector(),
    ).join("\n"),
    /pending_evidence_producer_sha256 must be a SHA-256 digest/,
  );

  const invalidArtifact = checkpoint();
  (
    invalidArtifact.frozen_inputs as Record<string, unknown>
  ).pending_evidence_artifact_sha256 = "not-a-sha";
  invalidArtifact.checkpoint_evidence_sha256 =
    sixStepLifecycleEnvelopeSha256(invalidArtifact);
  assert.match(
    validateSixStepValidationLifecycle(
      invalidArtifact,
      gitInspector(),
    ).join("\n"),
    /pending_evidence_artifact_sha256 must be a SHA-256 digest/,
  );
});

test("checkpoint enforces positive production EV independently of stage shape", () => {
  const evidence = checkpoint();
  const stages = evidence.production_route_stage as SemanticSixStepEvidence[];
  stages[5] = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 6,
    status: "reject",
    output: {
      decision: "reject",
      net_ev_wei: "0",
    },
    reasonCode: "negative_ev",
  });
  evidence.checkpoint_evidence_sha256 =
    sixStepLifecycleEnvelopeSha256(evidence);
  const errors = validateSixStepValidationLifecycle(
    evidence,
    gitInspector(),
  ).join("\n");
  assert.match(errors, /status must be pass/);
  assert.match(errors, /decision=allow and net_ev_wei>0/);
});

test("checkpoint requires current stage evidence and the exact candidate tip", () => {
  const legacyStage = checkpoint();
  const stages = legacyStage.production_route_stage as Record<string, unknown>[];
  stages[0] = { ...stages[0], schema_version: 1 };
  legacyStage.checkpoint_evidence_sha256 =
    sixStepLifecycleEnvelopeSha256(legacyStage);
  assert.match(
    validateSixStepValidationLifecycle(legacyStage, gitInspector()).join("\n"),
    /schema_version must be current v4/,
  );

  const descendant = checkpoint();
  descendant.candidate_commit = ROLLBACK;
  descendant.checkpoint_evidence_sha256 =
    sixStepLifecycleEnvelopeSha256(descendant);
  assert.match(
    validateSixStepValidationLifecycle(descendant, gitInspector()).join("\n"),
    /branch_tip must exactly equal candidate_commit/,
  );
});

test("checkpoint binds the sample, target route, and trusted controller receipt", () => {
  const missingController = checkpoint();
  delete missingController.controller;
  missingController.checkpoint_evidence_sha256 =
    sixStepLifecycleEnvelopeSha256(missingController);
  assert.match(
    validateSixStepValidationLifecycle(
      missingController,
      gitInspector(),
    ).join("\n"),
    /controller must be an object/,
  );

  const differentTarget = checkpoint();
  differentTarget.target_route_sha256 = SHA_B;
  differentTarget.checkpoint_evidence_sha256 =
    sixStepLifecycleEnvelopeSha256(differentTarget);
  assert.match(
    validateSixStepValidationLifecycle(
      differentTarget,
      gitInspector(),
    ).join("\n"),
    /must bind target_route_sha256/,
  );
});

test("checkpoint snapshot and controller fail closed on unsupported backrun", () => {
  const backrun = checkpoint();
  backrun.state_anchor = {
    lane: "backrun",
    opportunity_block: 101,
    base_block: 100,
    base_block_hash: HASH_A,
    base_state_root: HASH_B,
    applied_prefix_tx_hashes: [TX_A],
    trigger_tx_hash: TX_A,
    target_tx_index: 7,
    effective_state_hash: SHA_B,
  };
  const backrunAnchorSha = sixStepStateAnchorSha256(
    backrun.state_anchor as Record<string, unknown>,
  );
  backrun.state_anchor_sha256 = backrunAnchorSha;
  backrun.production_route_stage = [1, 2, 3, 4, 5, 6].map(
    (stepNumber) =>
      stage(stepNumber as 1 | 2 | 3 | 4 | 5 | 6, backrunAnchorSha),
  );
  backrun.checkpoint_evidence_sha256 =
    sixStepLifecycleEnvelopeSha256(backrun);
  assert.match(
    validateSixStepValidationLifecycle(backrun, gitInspector()).join("\n"),
    /input_snapshot state anchor does not equal lifecycle state anchor/,
  );
});

test("family-local evidence proves central and other-family isolation", () => {
  const centralDrift = checkpoint();
  centralDrift.central_behavior_diff_sha256 = SHA_A;
  assert.match(
    validateSixStepValidationLifecycle(centralDrift, gitInspector()).join("\n"),
    /central_behavior_diff_sha256/,
  );

  const otherFamilyDrift = checkpoint();
  otherFamilyDrift.other_family_source_set_challenger_sha256 = SHA_A;
  assert.match(
    validateSixStepValidationLifecycle(otherFamilyDrift, gitInspector()).join("\n"),
    /other-family source closures differ/,
  );
});

test("framework changes fail closed without a cross-family cohort", () => {
  const evidence = checkpoint();
  evidence.diff_class = "framework";
  delete evidence.central_behavior_diff_sha256;
  delete evidence.other_family_source_set_baseline_sha256;
  delete evidence.other_family_source_set_challenger_sha256;
  evidence.checkpoint_evidence_sha256 = sixStepLifecycleEnvelopeSha256(evidence);
  assert.match(
    validateSixStepValidationLifecycle(evidence, gitInspector()).join("\n"),
    /framework changes require an independently frozen cross-family cohort/,
  );
});

test("final validation binds exact production config, git ancestry, review, and receipts", () => {
  assert.deepEqual(
    validateSixStepValidationLifecycle(finalEvidence(), gitInspector()),
    [],
  );
});

test("final validation rejects author review, ref drift, and configuration override", () => {
  const evidence = finalEvidence((draft) => {
    draft.runner_overrides = {
      wall_clock_timeout_ms: 600_000,
      max_candidates: 99,
    };
    draft.review = {
      ...(draft.review as Record<string, unknown>),
      reviewer_email: "author@example.com",
    };
  });
  const errors = validateSixStepValidationLifecycle(
    evidence,
    gitInspector({
      resolveRef: (ref) => ref === "refs/remotes/origin/main"
        ? ORIGIN_MAIN
        : ref === "refs/heads/codex/receipt-deposit"
          ? ROLLBACK
          : null,
    }),
  ).join("\n");
  assert.match(errors, /only wall_clock_timeout_ms/);
  assert.match(errors, /branch ref does not exactly equal branch_tip/);
  assert.match(errors, /outside the entire candidate commit range/);
});

test("final evidence digest binds the complete envelope", () => {
  const evidence = finalEvidence();
  evidence.deployment_receipt_sha256 = SHA_B;
  assert.match(
    validateSixStepValidationLifecycle(evidence, gitInspector()).join("\n"),
    /full_evidence_sha256 does not bind/,
  );
});

test("final validation requires the pre-merge checkpoint receipt", () => {
  const evidence = finalEvidence();
  delete evidence.checkpoint_receipt_sha256;
  evidence.full_evidence_sha256 = sixStepLifecycleEnvelopeSha256(evidence);
  assert.match(
    validateSixStepValidationLifecycle(evidence, gitInspector()).join("\n"),
    /checkpoint_receipt_sha256 must be a lowercase SHA-256 digest/,
  );
});
