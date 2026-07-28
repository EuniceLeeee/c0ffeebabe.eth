import assert from "node:assert/strict";
import test from "node:test";
import {
  createSemanticSixStepEvidence,
  semanticSixStepEquivalenceError,
  semanticSixStepSequenceError,
  validateSemanticSixStepEvidence,
} from "../../../listener/src/shared/evidence/semantic-six-step.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function productionPass(
  step: 1 | 2 | 3 | 4 | 5 | 6,
) {
  const outputs = {
    1: {
      source_block: 100,
      edge_set_sha256: SHA_A,
      edge_set_size: 2,
      target_membership: "present",
    },
    2: {
      route_set_sha256: SHA_A,
      route_set_size: 1,
      target_present: true,
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
      resolved_plan_sha256: SHA_A,
      hop_amounts: [{ amount_in: "1", amount_out: "2" }],
    },
    5: {
      success: true,
      profit_token: "0xprofit",
      gross_profit: "2",
      net_profit: "1",
      gas_used: "100",
      calldata_sha256: SHA_A,
      repayment_and_conservation: "pass",
      leaves_standing_position: false,
    },
    6: {
      decision: "allow",
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
  const baseline = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 1,
    status: "pass",
    output: {
      source_block: 100,
      edge_set_sha256: SHA_A,
      edge_set_size: 2,
      target_membership: "present",
    },
    metrics: { elapsed_ms: 11, edge_count: 100 },
    extensions: { producer_module: "old-layout" },
  });
  const challenger = createSemanticSixStepEvidence({
    profile: "production_route_stage",
    step: 1,
    status: "pass",
    output: {
      target_membership: "present",
      edge_set_size: 2,
      edge_set_sha256: SHA_A,
      source_block: 100,
    },
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
      edge_set_sha256: SHA_B,
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
});
