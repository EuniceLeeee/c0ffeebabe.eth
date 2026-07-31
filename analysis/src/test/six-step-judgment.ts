import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createSemanticSixStepEvidence,
  semanticExactQuoteCommitmentSha256,
  semanticFinalSimCommitmentSha256,
  semanticJsonSha256,
  semanticRouteMembershipProofSha256,
  type SemanticJson,
} from "../../../listener/src/shared/evidence/semantic-six-step.js";
import {
  evaluateSixStepJudgment,
} from "../six-step-judgment.js";
import {
  familyReplayFailureFingerprint,
} from "../family-execution-evidence.js";

const BASE = "1".repeat(40);
const CANDIDATE = "2".repeat(40);
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const SHA_F = "f".repeat(64);
const FAMILY = "custom-swap:test";

test("family-local replay flip authorizes adapter merge only", () => {
  const result = evaluateSixStepJudgment(adapterInput());
  assert.equal(result.verdict, "pass", result.errors.join("; "));
  assert.equal(result.adapter_fixed, true);
  assert.equal(result.adapter_merge_ready, true);
  assert.equal(result.production_gap_fixed, false);
  assert.deepEqual(result.assessed, {
    adapter: true,
    production_gap: false,
  });
});

test("framework boundary preserves adapter-fixed but blocks merge", () => {
  const input = adapterInput();
  input.family_boundary.classification = "framework";
  input.family_boundary.reasons = ["runtime path has no family owner"];
  const result = evaluateSixStepJudgment(input);
  assert.equal(result.adapter_fixed, true);
  assert.equal(result.adapter_merge_ready, false);
  assert.equal(result.verdict, "fail");
  assert.match(result.errors.join("\n"), /family_local/);
});

test("conformance failure preserves adapter-fixed but blocks merge", () => {
  const input = adapterInput();
  input.promotion_receipt.family_conformance.checks = [];
  bindPromotion(input);
  const result = evaluateSixStepJudgment(input);
  assert.equal(result.adapter_fixed, true);
  assert.equal(result.adapter_merge_ready, false);
  assert.match(result.errors.join("\n"), /family_conformance/);
});

test("one family may prove more than one required fixture", () => {
  const input = adapterInput();
  const second = structuredClone(
    input.promotion_receipt.family_execution_artifacts[0],
  );
  second.fixture_path = "fixture-2.json";
  second.fixture_sha256 = SHA_F;
  second.evidence_path = "evidence-2.json";
  second.evidence_sha256 = SHA_E;
  second.reference_tx = `0x${"6".repeat(64)}`;
  second.challenger.replay.fixturePath = second.fixture_path;
  second.challenger.replay.fixtureSha256 = second.fixture_sha256;
  second.challenger.replay.landedEvidencePath = second.evidence_path;
  second.challenger.replay.landedEvidenceSha256 = second.evidence_sha256;
  second.challenger.replay.referenceTx = second.reference_tx;
  input.promotion_receipt.family_execution_artifacts.push(second);
  bindPromotion(input);
  const result = evaluateSixStepJudgment(input);
  assert.equal(result.adapter_merge_ready, true, result.errors.join("; "));
});

test("non-reproducible baseline cannot manufacture adapter-fixed", () => {
  const input = adapterInput();
  const artifact = input.promotion_receipt.family_execution_artifacts[0];
  const failure = replayReport(
    BASE,
    "implemented_not_validated",
    familyFailureEvidence(),
  );
  artifact.baseline = {
    status: "implemented_not_validated",
    probe: probe(true),
    replay: failure,
    output_sha256: SHA_A,
    failure_fingerprint_sha256: familyReplayFailureFingerprint(failure),
    confirmation_replay: failure,
    confirmation_output_sha256: SHA_B,
    confirmation_failure_fingerprint_sha256: SHA_C,
  };
  bindPromotion(input);
  const result = evaluateSixStepJudgment(input);
  assert.equal(result.adapter_fixed, false);
  assert.equal(result.adapter_merge_ready, false);
  assert.match(result.errors.join("\n"), /did not reproduce/);
});

test("stable pre-route family failure may have an empty route hash", () => {
  const input = adapterInput();
  const artifact = input.promotion_receipt.family_execution_artifacts[0];
  const failure = replayReport(
    BASE,
    "implemented_not_validated",
    familyFailureEvidence(),
  );
  failure.routeHash = "";
  failure.referenceRouteHash = null;
  const fingerprint = familyReplayFailureFingerprint(failure);
  artifact.baseline = {
    status: "implemented_not_validated",
    probe: probe(true),
    replay: failure,
    output_sha256: SHA_A,
    failure_fingerprint_sha256: fingerprint,
    confirmation_replay: structuredClone(failure),
    confirmation_output_sha256: SHA_B,
    confirmation_failure_fingerprint_sha256: fingerprint,
  };
  bindPromotion(input);
  const result = evaluateSixStepJudgment(input);
  assert.equal(result.adapter_fixed, true, result.errors.join("; "));
  assert.equal(result.adapter_merge_ready, true, result.errors.join("; "));
});

test("target-blind natural six-step output closes production gap", () => {
  const result = evaluateSixStepJudgment(productionInput());
  assert.equal(result.verdict, "pass", result.errors.join("; "));
  assert.equal(result.production_gap_fixed, true);
  assert.equal(result.adapter_fixed, false);
  assert.deepEqual(result.assessed, {
    adapter: false,
    production_gap: true,
  });
});

test("forced selection cannot close production gap", () => {
  const input = productionInput();
  input.natural_scan.forced_selection_count = 1;
  const result = evaluateSixStepJudgment(input);
  assert.equal(result.production_gap_fixed, false);
  assert.match(result.errors.join("\n"), /incomplete, forced/);
});

test("rejected EV cannot close production gap", () => {
  const input = productionInput();
  const prior = input.production_route_stage[5];
  input.production_route_stage[5] = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 6,
    status: "pass",
    output: {
      ...prior.output,
      decision: "reject",
      decision_reason: "below_threshold",
      net_ev_wei: "0",
    },
  });
  const result = evaluateSixStepJudgment(input);
  assert.equal(result.production_gap_fixed, false);
  assert.match(result.errors.join("\n"), /positive allowed EV/);
});

test("malformed semantic evidence fails closed without throwing", () => {
  const input = productionInput();
  input.production_route_stage[2] = null;
  assert.doesNotThrow(() => evaluateSixStepJudgment(input));
  assert.equal(
    evaluateSixStepJudgment(input).production_gap_fixed,
    false,
  );
});

function adapterInput(): any {
  const promotion = {
    schema_version: 1,
    gate: "historical-gap-gate",
    track: "family-execution",
    base_commit: BASE,
    challenger_commit: CANDIDATE,
    auth_tag: SHA_F,
    auth_command_id: "12345678-1234-1234-1234-123456789abc",
    family_execution_artifacts: [{
      fixture_path: "fixture.json",
      fixture_sha256: SHA_C,
      evidence_path: "evidence.json",
      evidence_sha256: SHA_D,
      reference_tx: `0x${"9".repeat(64)}`,
      execution_family_id: FAMILY,
      baseline: {
        status: "family_not_registered",
        probe: probe(false),
        replay: null,
        output_sha256: SHA_A,
      },
      challenger: {
        status: "adapter_replay_pass",
        probe: probe(true),
        replay: replayReport(
          CANDIDATE,
          "adapter_replay_pass",
          familyEvidence(),
        ),
        output_sha256: SHA_B,
      },
    }],
    family_conformance: {
      schema_version: 1,
      checks: [{
        script_path: "src/searcher/test/route-adapters.ts",
        source_sha256: SHA_A,
        output_sha256: SHA_B,
      }],
    },
    family_ownership: {
      schema_version: 1,
      manifest_script_sha256: SHA_A,
      baseline_manifest_sha256: SHA_B,
      challenger_manifest_sha256: SHA_C,
      baseline_registry_skeleton_sha256: SHA_D,
      challenger_registry_skeleton_sha256: SHA_D,
      baseline_action_index_skeleton_sha256: SHA_E,
      challenger_action_index_skeleton_sha256: SHA_E,
      affected_execution_family_ids: [FAMILY],
      subject_execution_family_ids: [FAMILY],
    },
  };
  const boundary: any = {
    schema_version: 1,
    gate: "adapter-family-boundary",
    baseline_commit: BASE,
    candidate_commit: CANDIDATE,
    classification: "family_local",
    impacted_family_ids: [FAMILY],
    reasons: [],
    other_family_source_set_baseline_sha256: SHA_A,
    other_family_source_set_candidate_sha256: SHA_A,
  };
  boundary.receipt_sha256 = semanticJsonSha256(
    boundary as SemanticJson,
  );
  const input = {
    schema_version: 1,
    gate: "six-step-judgment",
    claim: "adapter_merge",
    promotion_receipt: promotion,
    promotion_receipt_sha256: promotionSha256(promotion),
    family_boundary: boundary,
  };
  return input;
}

function probe(registered: boolean) {
  return { schemaVersion: 1, executionFamilyId: FAMILY, registered };
}

function replayReport(
  commit: string,
  verdict: "adapter_replay_pass" | "implemented_not_validated",
  sixStepEvidence: ReturnType<typeof familyEvidence>,
): any {
  const failed = verdict !== "adapter_replay_pass";
  return {
    schemaVersion: 3,
    fixtureId: "fixture",
    fixturePath: "fixture.json",
    fixtureSha256: SHA_C,
    referenceTx: `0x${"9".repeat(64)}`,
    landedEvidencePath: "evidence.json",
    landedEvidenceSha256: SHA_D,
    executionFamilyId: FAMILY,
    routeExecutionFamilies: [FAMILY],
    stateAnchor: { block: 100 },
    anchorBlockHash: `0x${"8".repeat(64)}`,
    anchorStateRoot: `0x${"7".repeat(64)}`,
    anchorReconstruction: { kind: "canonical-parent-block" },
    baseCommit: BASE,
    adapterCommit: commit,
    familySourceSha256: SHA_A,
    sharedApiSha256: SHA_B,
    runtimeSourceSha256: SHA_C,
    harnessSha256: SHA_D,
    botVmArtifactSha256: SHA_E,
    replayFlash: { adapterId: "flash", token: "token" },
    routeHash: SHA_A,
    referenceRouteHash: failed ? null : SHA_B,
    stages: failed
      ? { chainAnchor: true, exactQuote: false }
      : { chainAnchor: true, exactQuote: true, finalSim: true, productionEvPositive: true },
    sixStepEvidence,
    verdict,
    failureOwnerFamilyId: failed ? FAMILY : null,
    failureIdentity: failed ? {
      ownerFamilyId: FAMILY,
      stageId: "exact_quote_refine",
      code: "quote_failed",
    } : null,
    failure: failed ? "quote failed" : null,
  };
}

function familyEvidence() {
  const outputs = {
    1: {
      mode: "route_pinned",
      state_anchor: { block: 100 },
      execution_family_id: FAMILY,
    },
    2: {
      mode: "route_pinned",
      fixture_route_sha256: SHA_A,
      route_leg_count: 2,
    },
    3: {
      source_block: 100,
      route_sha256: SHA_A,
      quote_status: "positive",
      probe_amount_in: "1",
      quoted_amount_out: "2",
      leg_quotes: [{ amount_in: "1", amount_out: "2" }],
    },
    4: {
      route_sha256: SHA_A,
      selected_by_solve_policy: true,
      solve_succeeded: true,
      solver_selected_amount: "1",
      resolved_plan_sha256: SHA_B,
      hop_amounts: [{ amount_in: "1", amount_out: "2" }],
    },
    5: {
      success: true,
      profit_token: "0xprofit",
      gross_profit: "2",
      net_profit: "1",
      gas_used: "100",
      calldata_sha256: SHA_C,
      repayment_and_conservation: "pass",
      leaves_standing_position: false,
    },
    6: {
      execution_status: "pass",
      decision: "allow",
      decision_reason: "policy_allow",
      net_ev_wei: "1",
      gas_cost_eth: "1",
      bid_eth: "0",
      valuation_available: true,
      gas_measurement_available: true,
      fee_state_available: true,
    },
  } as const;
  return [1, 2, 3, 4, 5, 6].map((rawStep) => {
    const step = rawStep as 1 | 2 | 3 | 4 | 5 | 6;
    return createSemanticSixStepEvidence({
      profile: "family_execution",
      step,
      status: step <= 2 ? "bypassed" : "pass",
      output: outputs[step],
      reasonCode: step <= 2 ? "route_pinned" : null,
    });
  });
}

function familyFailureEvidence(): ReturnType<typeof familyEvidence> {
  return [
    ...familyEvidence().slice(0, 2),
    createSemanticSixStepEvidence({
      profile: "family_execution",
      step: 3,
      status: "fail",
      output: {
        failure_owner_family_id: FAMILY,
        failure_stage_id: "exact_quote_refine",
        failure_code: "quote_failed",
        failure_promotable: true,
      },
      reasonCode: "quote_failed",
    }),
  ];
}

function bindPromotion(input: any): void {
  input.promotion_receipt_sha256 = promotionSha256(input.promotion_receipt);
}

function promotionSha256(receipt: any): string {
  const { closed_at: _closed, merge_commit: _merge, ...promotion } = receipt;
  return createHash("sha256")
    .update(`${JSON.stringify(promotion)}\n`)
    .digest("hex");
}

function productionInput(): any {
  const productionRouteStage = [1, 2, 3, 4, 5, 6].map(
    (step) => productionPass(step as 1 | 2 | 3 | 4 | 5 | 6),
  );
  return {
    schema_version: 1,
    gate: "six-step-judgment",
    claim: "production_gap",
    candidate_commit: CANDIDATE,
    producer_contract: {
      candidate_commit: CANDIDATE,
      target_blind: true,
      explicit_route_injected: false,
      explicit_amount_injected: false,
      amount_source: "solver",
      run_id: SHA_C,
      state_anchor_sha256: SHA_D,
      frozen_output_sha256: SHA_A,
      target_late_verifier_sha256: SHA_B,
    },
    natural_scan: {
      outcome: "ran",
      rank_complete: true,
      refinement_deadline_exceeded: false,
      evaluation_complete: true,
      forced_selection_count: 0,
      run_id: SHA_C,
      state_anchor_sha256: SHA_D,
      target_route_sha256: SHA_E,
      route_set_sha256: SHA_A,
    },
    production_route_stage: productionRouteStage,
  };
}

function productionPass(step: 1 | 2 | 3 | 4 | 5 | 6) {
  const common = {
    run_id: SHA_C,
    state_anchor_sha256: SHA_D,
    target_route_sha256: SHA_E,
  };
  const membership = {
    ...common,
    route_set_sha256: SHA_A,
    route_set_size: 1,
    target_present: true,
  };
  const quote = {
    ...common,
    source_block: 100,
    route_sha256: SHA_E,
    quote_status: "positive",
    probe_amount_in: "1",
    quoted_amount_out: "2",
    leg_quotes: [{ amount_in: "1", amount_out: "2" }],
  };
  const finalSim = {
    ...common,
    input_resolved_plan_sha256: SHA_F,
    success: true,
    profit_token: "0xprofit",
    gross_profit: "2",
    net_profit: "1",
    gas_used: "100",
    calldata_sha256: SHA_A,
    repayment_and_conservation: "pass",
    leaves_standing_position: false,
  };
  const outputs = {
    1: {
      ...common,
      source_block: 100,
      edge_set_sha256: SHA_A,
      edge_set_size: 1,
      target_membership: "present",
      materialized_graph: {
        scope: "all_materialized_edges",
        edge_count: 1,
        sha256: SHA_A,
        family_edges: [{
          family_id: "univ2-standard",
          edge_count: 1,
          sha256: SHA_A,
        }],
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
        family_shards: [{
          shard_id: "family:univ2-standard",
          family_id: "univ2-standard",
          source_kind: "dex-universe",
          status: "complete",
          required: true,
          disposition: "required",
          edge_count: 1,
          sha256: SHA_A,
          source_coverage: [],
          issues: [],
        }],
        required_family_ids: ["univ2-standard"],
        required_complete: true,
        isolated_incomplete_family_ids: [],
        cache_reuse: {
          status: "not_measured",
          claimed_hit: false,
        },
      },
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
      route_sha256: SHA_E,
      input_exact_quote_sha256:
        semanticExactQuoteCommitmentSha256(quote),
      selected_by_solve_policy: true,
      solve_succeeded: true,
      solver_selected_amount: "1",
      resolved_plan_sha256: SHA_F,
      hop_amounts: [{ amount_in: "1", amount_out: "2" }],
    },
    5: {
      ...finalSim,
      final_sim_sha256: semanticFinalSimCommitmentSha256(finalSim),
    },
    6: {
      ...common,
      input_final_sim_sha256:
        semanticFinalSimCommitmentSha256(finalSim),
      execution_status: "pass",
      decision: "allow",
      decision_reason: "policy_allow",
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
