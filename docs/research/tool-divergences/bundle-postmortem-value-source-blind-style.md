---
divergence_id: bundle-postmortem-value-source-blind-style
status: open_frozen
tool: analysis:bundle-postmortem@f95ddb8367a489d02dff0552a9e9d529bc4db7e7
capability: classification
root_cause: The style classifier can call a one-way private payout, inventory sale, dormant-credit harvest, or RFQ an atomic loop because it does not first prove a permissionless funded input-side leg.
deferred_reason: analysis-tool freeze
fixed_by: null
---

# Bundle postmortem value-source blind style

Manual call-trace and transfer-flow review found that the transactions below do not have a permissionless,
self-funded closed-loop value source. The current canonical output either labels them `atomic_loop`, or assigns
the wrong non-comparable subtype. They remain excluded from production work regardless of the printed PnL.

Evidence source for every row: `eth_getTransactionReceipt` plus `debug_traceTransaction` with `callTracer`
against node-local reth. Receipt summary SHA-256 is
`8e291e0675a2b00174dd50510b51d1a3c9b52b3ac318078f537b53145c85c579`; trace-summary SHA-256 is
`0bbe2d25c479b217a00931c5011830e0d75b449be91461547a1d4a2404b059a6`; canonical bundle SHA-256 is
`4efceb98626a24c90a3c5cbc3837c3f91cac3e7ecff632aba1cfec4aa35b6548`.

```yaml
transactions:
  - tx_hash: 0x95395a0b3782c07b5bd2c1b9f0fb6aaccaedddda016eea40c486038cf8a01233
    block: 25534493
    tx_index: 142
    role: scanner
    production_gap_id: excluded-private-payout
    tool_actual: atomic_loop
    manual_ground_truth: unfunded private callback payout; no permissionless input-side leg
  - tx_hash: 0x90c01dd62af377f297138701aa9bcd1789d0d95a99640f6f84eaf582b76c1c3a
    block: 25534430
    tx_index: 27
    role: scanner
    production_gap_id: excluded-keeper-private
    tool_actual: atomic_loop
    manual_ground_truth: CVX arrives without executor consideration and is sold to WETH
  - tx_hash: 0xec8d5e1f689edb65f4d13cae72b1bd8d50b6967c61db719f1b812fd1b01a6656
    block: 25534306
    tx_index: 88
    role: scanner
    production_gap_id: excluded-keeper-private
    tool_actual: atomic_loop
    manual_ground_truth: INV claim/receipt without funded input, followed by a one-way sale
  - tx_hash: 0xb36d62a2249488176ed9232e4bcd4d93cba0e363da93988a63d493d374890a25
    block: 25534087
    tx_index: 114
    role: scanner
    production_gap_id: excluded-inventory
    tool_actual: atomic_loop
    manual_ground_truth: owned CRV inventory is sourced and sold; no closing permissionless input leg
  - tx_hash: 0x92adb8d0774f17f2fd9c1fe09b7c3521e2d4ee8915d9978a83ef1f5d512d0240
    block: 25533799
    tx_index: 1
    role: scanner
    production_gap_id: excluded-private-credit
    tool_actual: atomic_loop
    manual_ground_truth: Coffee-created helpers harvest dormant DDEX credit before the DEX sale
  - tx_hash: 0xec6cc693715116e294b761afec13a97476daaf1919dc5e5956b0072aebe8038e
    block: 25533799
    tx_index: 0
    role: scanner
    production_gap_id: excluded-private-credit
    tool_actual: atomic_loop
    manual_ground_truth: Coffee-created helpers harvest dormant DDEX credit before the DEX sale
  - tx_hash: 0x8ead67c40b88b1edbbeb2561f6ccde7123a567a1963d718f6dc3e4f9cf09e0c9
    block: 25533688
    tx_index: 53
    role: scanner
    production_gap_id: excluded-private-credit
    tool_actual: atomic_loop
    manual_ground_truth: zero-consideration allowance/credit supplies the sold token
  - tx_hash: 0x0da7f9459925ffd63444655a2e64f84efe85223b50905d8b310bbe9988793fd8
    block: 25533874
    tx_index: 1256
    role: scanner
    production_gap_id: excluded-rfq
    tool_actual: atomic_loop
    manual_ground_truth: BOLD principal is filled by a hardcoded counterparty; Liquity is only a price feed
  - tx_hash: 0x9b98257729109eefea518c9c2cc42d28b3ac2622ad5936784370e66a68a670ee
    block: 25534444
    tx_index: 44
    role: backrun_winner
    production_gap_id: excluded-rfq
    tool_actual: keeper_claim
    manual_ground_truth: private 1inch maker RFQ followed by a DEX unwind
```

The batch-scoped freeze forbids changing the classifier or adding its regression in this run. A later tooling
round should use all nine hashes as one value-source regression cohort.
