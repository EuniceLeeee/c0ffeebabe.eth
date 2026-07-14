export interface BackrunCausalReplayResult {
  schema_version: number;
  fork_block: number;
  winner_tx_hash: string;
  winner_transaction_index: number;
  victim_tx_hash: string;
  pre_state_anchor_kind: "parent-block" | "previous-tx";
  pre_state_anchor_hash: string | null;
  post_state_anchor_kind: "victim-tx";
  post_state_anchor_hash: string;
  pre_execution_block: number | null;
  pre_execution_index: number | null;
  post_execution_block: number | null;
  post_execution_index: number | null;
  full_prefix_execution_success: boolean | null;
  full_prefix_execution_net_raw: string | null;
  full_prefix_execution_block: number | null;
  full_prefix_execution_index: number | null;
  trigger_route_signature: string | null;
  full_prefix_route_signature: string | null;
  trigger_ev_bucket: "positive" | "non_positive" | "unverified";
  full_prefix_ev_bucket: "positive" | "non_positive" | "unverified";
  full_vs_trigger: "match" | "diverge" | "unverified";
  causal_replay_error: string | null;
}

export interface BackrunCausalReplayExpected {
  stage: string;
  parentBlock: number;
  winnerTxHash: string;
  winnerTransactionIndex: number;
  victimTxHash: string;
  blockNumber: number;
}

export function validateBackrunCausalReplay(
  result: BackrunCausalReplayResult,
  expected: BackrunCausalReplayExpected,
): string[] {
  const errors: string[] = [];
  if (result.schema_version !== 2 || result.fork_block !== expected.parentBlock) {
    errors.push("replay did not execute from the sample parent block");
  }
  if (result.winner_tx_hash.toLowerCase() !== expected.winnerTxHash.toLowerCase()
      || result.winner_transaction_index !== expected.winnerTransactionIndex) {
    errors.push("replay used the wrong winner transaction/index");
  }
  if (result.victim_tx_hash.toLowerCase() !== expected.victimTxHash.toLowerCase()) {
    errors.push("replay used the wrong selected trigger");
  }
  if (result.pre_state_anchor_kind !== "parent-block" || result.pre_state_anchor_hash !== null) {
    errors.push("boundary is not the untouched parent block");
  }
  if (result.post_state_anchor_kind !== "victim-tx"
      || result.post_state_anchor_hash.toLowerCase() !== expected.victimTxHash.toLowerCase()) {
    errors.push("trigger-only state is not bound to the selected raw trigger");
  }

  if (expected.stage !== "final_sim_success") return errors;

  if (result.pre_execution_block !== expected.blockNumber || result.pre_execution_index !== 0
      || result.post_execution_block !== expected.blockNumber || result.post_execution_index !== 1) {
    errors.push("boundary/trigger-only executions were not isolated in the historical block context");
  }
  if (result.full_prefix_execution_block !== expected.blockNumber
      || result.full_prefix_execution_index !== expected.winnerTransactionIndex
      || result.full_prefix_execution_success !== true
      || result.full_prefix_execution_net_raw === null
      || BigInt(result.full_prefix_execution_net_raw) <= 0n) {
    errors.push("full-prefix route did not execute positively at the winner index");
  }
  if (result.full_vs_trigger !== "match"
      || result.trigger_route_signature === null
      || result.trigger_route_signature !== result.full_prefix_route_signature
      || result.trigger_ev_bucket !== "positive"
      || result.full_prefix_ev_bucket !== "positive"
      || result.causal_replay_error !== null) {
    errors.push("trigger-only replay conflicts with or cannot verify the full prefix");
  }
  return errors;
}
