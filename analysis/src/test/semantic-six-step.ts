import assert from "node:assert/strict";
import test from "node:test";
import {
  createSemanticSixStepEvidence,
  semanticExactQuoteCommitmentSha256,
  semanticFinalSimCommitmentSha256,
  semanticJsonSha256,
  semanticProductionRouteChainError,
  semanticRouteMembershipProofSha256,
  semanticSixStepEquivalenceError,
  semanticSixStepSequenceError,
  validateSemanticSixStepEvidence,
} from "../../../listener/src/shared/evidence/semantic-six-step.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const RUN_SHA = "c".repeat(64);
const STATE_SHA = "d".repeat(64);
const ROUTE_SHA = "e".repeat(64);
const PLAN_SHA = "f".repeat(64);

function productionPass(
  step: 1 | 2 | 3 | 4 | 5 | 6,
) {
  const common = {
    run_id: RUN_SHA,
    state_anchor_sha256: STATE_SHA,
    target_route_sha256: ROUTE_SHA,
  } as const;
  const membership = {
    ...common,
    route_set_sha256: SHA_A,
    route_set_size: 1,
    target_present: true,
  };
  const quote = {
    ...common,
    source_block: 100,
    route_sha256: ROUTE_SHA,
    quote_status: "positive",
    probe_amount_in: "1",
    quoted_amount_out: "2",
    leg_quotes: [{ amount_in: "1", amount_out: "2" }],
  } as const;
  const finalSim = {
    ...common,
    input_resolved_plan_sha256: PLAN_SHA,
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
      source_block: 100,
      edge_set_sha256: SHA_A,
      edge_set_size: 2,
      target_membership: "present",
      materialized_graph: {
        scope: "all_materialized_edges",
        edge_count: 2,
        sha256: SHA_A,
        family_edges: [{
          family_id: "univ2-standard",
          edge_count: 2,
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
          edge_count: 2,
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
          edge_count: 2,
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
      route_sha256: ROUTE_SHA,
      input_exact_quote_sha256:
        semanticExactQuoteCommitmentSha256(quote),
      selected_by_solve_policy: true,
      solve_succeeded: true,
      solver_selected_amount: "1",
      resolved_plan_sha256: PLAN_SHA,
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

test("semantic six-step evidence is independent of metrics and extensions", () => {
  const graphOutput = productionPass(1).output;
  const baseline = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 1,
    status: "pass",
    output: graphOutput,
    metrics: { elapsed_ms: 11, edge_count: 100 },
    extensions: { producer_module: "old-layout" },
  });
  const challenger = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 1,
    status: "pass",
    output: { ...graphOutput },
    metrics: { elapsed_ms: 7, edge_count: 100 },
    extensions: { producer_module: "new-layout" },
  });

  assert.equal(
    semanticSixStepEquivalenceError([baseline], [challenger]),
    null,
  );
  assert.deepEqual(validateSemanticSixStepEvidence(baseline), []);
});

test("semantic six-step evidence rejects output drift and forged digests", () => {
  const baseline = productionPass(1);
  const challenger = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 1,
    status: "pass",
    output: {
      ...baseline.output,
      source_block: 101,
    },
  });
  assert.match(
    semanticSixStepEquivalenceError([baseline], [challenger]) ?? "",
    /semantic output differs/,
  );
  assert.match(
    validateSemanticSixStepEvidence({
      ...baseline,
      output_sha256: "0".repeat(64),
    }).join("\n"),
    /does not bind output/,
  );
});

test("semantic six-step evidence is an ordered domain-stage prefix", () => {
  const graph = productionPass(1);
  const quote = productionPass(3);
  assert.match(
    semanticSixStepSequenceError([graph, quote]) ?? "",
    /ordered prefix/,
  );
  assert.equal(graph.stage_id, "discovery_admission_graph");
  assert.equal(quote.stage_id, "exact_quote_refine");
});

test("current production evidence forms one causally linked run", () => {
  const chain = [1, 2, 3, 4, 5, 6].map(
    (step) => productionPass(step as 1 | 2 | 3 | 4 | 5 | 6),
  );
  assert.equal(semanticProductionRouteChainError(chain), null);

  chain[2] = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 3,
    status: "pass",
    output: {
      ...chain[2].output,
      target_route_sha256: SHA_B,
    },
  });
  assert.match(
    semanticProductionRouteChainError(chain) ?? "",
    /target_route_sha256 differs at step 3/,
  );
});

test("semantic six-step pass is fail-closed on empty or incomplete core output", () => {
  const empty = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 1,
    status: "pass",
    output: {},
  });
  assert.match(
    validateSemanticSixStepEvidence(empty).join("\n"),
    /missing source_block/,
  );

  const incomplete = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 4,
    status: "pass",
    output: {
      route_sha256: SHA_A,
      solve_succeeded: true,
    },
  });
  const errors = validateSemanticSixStepEvidence(incomplete).join("\n");
  assert.match(errors, /missing selected_by_solve_policy/);
  assert.match(errors, /missing resolved_plan_sha256/);
  assert.match(errors, /missing hop_amounts/);
});

test("semantic six-step pass rejects contradictory domain outcomes", () => {
  const contradictions = [
    [1, { ...productionPass(1).output, edge_set_size: 0 }, /edge_set_size must be a positive integer/],
    [1, { ...productionPass(1).output, target_membership: "missing" }, /target_membership must be the string present/],
    [2, { ...productionPass(2).output, target_present: false }, /target_present must be true/],
    [3, { ...productionPass(3).output, quoted_amount_out: "0" }, /quoted_amount_out must be a positive/],
    [4, { ...productionPass(4).output, solve_succeeded: false }, /solve_succeeded must be true/],
    [5, { ...productionPass(5).output, success: false }, /success must be true/],
    [5, { ...productionPass(5).output, leaves_standing_position: true }, /leaves_standing_position must be false/],
    [6, { ...productionPass(6).output, execution_status: "reject" }, /execution_status must be the string pass/],
    [6, { ...productionPass(6).output, decision: "skip" }, /decision must be allow or reject/],
    [6, { ...productionPass(6).output, decision_reason: "" }, /decision_reason must be a non-empty stable snake_case string/],
    [6, { ...productionPass(6).output, decision_reason: "Policy Allow" }, /decision_reason must be a non-empty stable snake_case string/],
    [6, { ...productionPass(6).output, net_ev_wei: "1.5" }, /net_ev_wei must be a signed decimal integer string/],
    [6, { ...productionPass(6).output, valuation_available: false }, /valuation_available must be true/],
  ] as const;

  for (const [step, output, expected] of contradictions) {
    const evidence = createSemanticSixStepEvidence({
      profile: "production_route_stage",
      step,
      status: "pass",
      output,
    });
    assert.match(validateSemanticSixStepEvidence(evidence).join("\n"), expected);
  }
});

test("semantic step 6 pass records a reproducible allow or reject decision", () => {
  const allowed = productionPass(6);
  assert.deepEqual(validateSemanticSixStepEvidence(allowed), []);

  const rejected = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 6,
    status: "pass",
    output: {
      ...allowed.output,
      decision: "reject",
      decision_reason: "net_ev_below_policy_minimum",
      net_ev_wei: "-42",
    },
  });
  assert.deepEqual(validateSemanticSixStepEvidence(rejected), []);

  const zeroEv = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 6,
    status: "pass",
    output: {
      ...allowed.output,
      decision: "reject",
      decision_reason: "net_ev_zero",
      net_ev_wei: "0",
    },
  });
  assert.deepEqual(validateSemanticSixStepEvidence(zeroEv), []);
  assert.equal(rejected.reason_code, null);
});

test("semantic schemas v1, v2, and v3 remain readable while new producers emit v4", () => {
  const current = productionPass(6);
  const legacyOutput = {
    decision: "allow",
    net_ev_wei: "1",
    gas_cost_eth: "1",
    bid_eth: "0",
    valuation_available: true,
    gas_measurement_available: true,
    fee_state_available: true,
  };
  const legacy = {
    ...current,
    schema_version: 1,
    output: legacyOutput,
    output_sha256: semanticJsonSha256(legacyOutput),
  };
  assert.deepEqual(validateSemanticSixStepEvidence(legacy), []);
  assert.deepEqual(validateSemanticSixStepEvidence({
    ...current,
    schema_version: 2,
    output: {
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
    output_sha256: semanticJsonSha256({
      execution_status: "pass",
      decision: "allow",
      decision_reason: "positive_ev",
      net_ev_wei: "1",
      gas_cost_eth: "1",
      bid_eth: "0",
      valuation_available: true,
      gas_measurement_available: true,
      fee_state_available: true,
    }),
  }), []);
  assert.deepEqual(validateSemanticSixStepEvidence({
    ...current,
    schema_version: 3,
    output: current.output,
    output_sha256: semanticJsonSha256(current.output),
  }), []);
});

test("semantic six-step sequence terminates after fail, reject, or not_reached", () => {
  for (const status of ["fail", "reject", "not_reached"] as const) {
    const terminal = createSemanticSixStepEvidence({
      profile: "production_route_stage",
      step: 1,
      status,
      output: { completed: false },
      reasonCode: "stage_terminal",
    });
    assert.match(
      semanticSixStepSequenceError([terminal, productionPass(2)]) ?? "",
      /terminate after step 1/,
    );
  }

  const missingReason = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 1,
    status: "fail",
    output: {},
  });
  const errors = validateSemanticSixStepEvidence(missingReason).join("\n");
  assert.match(errors, /output must be non-empty/);
  assert.match(errors, /reason_code must be non-null/);
});

test("only family execution may bypass discovery and enumeration", () => {
  const familyDiscovery = createSemanticSixStepEvidence({
    profile: "family_execution",
    step: 1,
    status: "bypassed",
    output: {
      mode: "route_pinned",
      state_anchor: { block_number: 100, block_hash: SHA_A },
      execution_family_id: "self-burn-native",
    },
    reasonCode: "adapter_replay_bypasses_discovery",
  });
  const familyEnumeration = createSemanticSixStepEvidence({
    profile: "family_execution",
    step: 2,
    status: "bypassed",
    output: {
      mode: "route_pinned",
      fixture_route_sha256: SHA_A,
      route_leg_count: 2,
    },
    reasonCode: "adapter_replay_uses_trace_route",
  });
  assert.deepEqual(validateSemanticSixStepEvidence(familyDiscovery), []);
  assert.deepEqual(validateSemanticSixStepEvidence(familyEnumeration), []);
  assert.equal(
    semanticSixStepSequenceError([familyDiscovery, familyEnumeration]),
    null,
  );

  const productionBypass = {
    ...familyDiscovery,
    profile: "production_route_stage",
  };
  assert.match(
    validateSemanticSixStepEvidence(productionBypass).join("\n"),
    /allowed only for family_execution steps 1 and 2/,
  );

  const familyLateBypass = createSemanticSixStepEvidence({
    profile: "family_execution",
    step: 3,
    status: "bypassed",
    output: { mode: "route_pinned" },
  });
  assert.match(
    validateSemanticSixStepEvidence(familyLateBypass).join("\n"),
    /allowed only for family_execution steps 1 and 2/,
  );

  const vagueBypass = createSemanticSixStepEvidence({
    profile: "family_execution",
    step: 1,
    status: "bypassed",
    output: {
      mode: "fixture",
      state_anchor: { block_number: 100 },
      execution_family_id: "self-burn-native",
    },
  });
  const vagueErrors = validateSemanticSixStepEvidence(vagueBypass).join("\n");
  assert.match(vagueErrors, /mode must be the string route_pinned/);
  assert.match(vagueErrors, /bypassed reason_code must be non-null/);
});
