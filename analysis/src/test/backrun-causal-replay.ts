import assert from "node:assert/strict";
import test from "node:test";
import {
  validateBackrunCausalReplay,
  type BackrunCausalReplayExpected,
  type BackrunCausalReplayResult,
} from "../backrun-causal-replay.js";

const WINNER = `0x${"11".repeat(32)}`;
const TRIGGER = `0x${"22".repeat(32)}`;

function expected(): BackrunCausalReplayExpected {
  return {
    stage: "final_sim_success",
    parentBlock: 99,
    winnerTxHash: WINNER,
    winnerTransactionIndex: 7,
    victimTxHash: TRIGGER,
    blockNumber: 100,
  };
}

function result(): BackrunCausalReplayResult {
  return {
    schema_version: 2,
    fork_block: 99,
    winner_tx_hash: WINNER,
    winner_transaction_index: 7,
    victim_tx_hash: TRIGGER,
    pre_state_anchor_kind: "parent-block",
    pre_state_anchor_hash: null,
    post_state_anchor_kind: "victim-tx",
    post_state_anchor_hash: TRIGGER,
    pre_execution_block: 100,
    pre_execution_index: 0,
    post_execution_block: 100,
    post_execution_index: 1,
    full_prefix_execution_success: true,
    full_prefix_execution_net_raw: "1",
    full_prefix_execution_block: 100,
    full_prefix_execution_index: 7,
    trigger_route_signature: "route-a",
    full_prefix_route_signature: "route-a",
    trigger_ev_bucket: "positive",
    full_prefix_ev_bucket: "positive",
    full_vs_trigger: "match",
    causal_replay_error: null,
  };
}

test("matching boundary/trigger-only/full-prefix replay passes", () => {
  assert.deepEqual(validateBackrunCausalReplay(result(), expected()), []);
});

test("wrong winner identity is rejected", () => {
  const value = result();
  value.winner_transaction_index = 8;
  assert.match(validateBackrunCausalReplay(value, expected()).join("\n"), /wrong winner/);
});

test("unreplayable full prefix is rejected", () => {
  const value = result();
  value.full_prefix_execution_success = null;
  value.full_prefix_execution_net_raw = null;
  value.full_vs_trigger = "unverified";
  value.causal_replay_error = "missing blob sidecar";
  const errors = validateBackrunCausalReplay(value, expected()).join("\n");
  assert.match(errors, /full-prefix route/);
  assert.match(errors, /cannot verify the full prefix/);
});

test("route or EV divergence is rejected", () => {
  const value = result();
  value.full_prefix_route_signature = "route-b";
  value.full_prefix_ev_bucket = "non_positive";
  value.full_vs_trigger = "diverge";
  assert.match(validateBackrunCausalReplay(value, expected()).join("\n"), /conflicts/);
});
