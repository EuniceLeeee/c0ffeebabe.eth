---
divergence_id: tx-source-shape-boundary-positive-false-backrun
status: open_frozen
tool: analysis:tx-source-shape@21990d29c2642ece92122f13e6918eb0e071d549
capability: causality
root_cause: The classifier treats a preceding opposite-direction same-pool swap as sufficient proof of a victim-driven backrun and does not execute the required parent-boundary counterfactual.
deferred_reason: analysis-tool freeze
fixed_by: null
---

# tx-source-shape boundary-positive false backrun

```yaml
transactions:
  - tx_hash: 0x4bc637dbae3fe4960ab32c36ac7cdc273b44feba20e6ee9e0e7474c71bcc3ad5
    block: 25642822
    tx_index: 128
    tool_actual: victim
    manual_ground_truth: blockscan
    candidate_trigger:
      tx_hash: 0x11bbcc0f5091e710d7c0f205f329072ab0f04b0632fc3a94544183a44680c953
      tx_index: 45
    counterfactual:
      boundary:
        receipt_status: 1
        transaction_index: 0
        sender_net_wei: "133465670878506"
      trigger_only:
        receipt_status: 1
        transaction_index: 1
        sender_net_wei: "144970137103439"
```

The exact signed winner succeeds and leaves the sender net-positive when mined
as transaction zero on the untouched parent-block state. Under the trusted
three-state contract, a positive boundary disqualifies a causal backrun before
`trigger_only` or `full_prefix` equivalence is considered. The earlier
opposite-direction swap changes the result but is not necessary for success or
positive value.

The generated selection manifest was `/tmp/tx4bc-tools.json`:

- initial manifest SHA-256:
  `aa9979aaa7364c5a01af4f07bd0a42373181a9e817a47e7978d0eeac14de0fbc`;
- receipt-bearing manifest SHA-256:
  `f69e2955b17ad7c0d0e9b1dbe9f8a65ae280ddc2dcab0c0711aaab21c5dd5936`;
- tool descriptor SHA-256:
  `973ff39a28d014188d03cc6e6818e2ba643937d8308303e731033e6429217db6`;
- tool stdout SHA-256:
  `bdbeab877099eacb7eedf47b62a09f6ad9131bb4d039c34b9e51b5166ffadfc1`.

This divergence invalidates only the tool's `victim` lane classification for
this sample. The raw receipt, logs, trace and PnL evidence remain usable. Under
the analysis-tool freeze, the classifier is not repaired during this tx-gap
round.
