---
divergence_id: bundle-postmortem-call-defined-protocol-leg-coverage
status: partially_codified
tool: analysis:bundle-postmortem@f95ddb8367a489d02dff0552a9e9d529bc4db7e7
capability: classification
root_cause: Event-led edge classification omits successful call-defined mint, migration, LP lifecycle, burn-to-native, and surplus protocol legs that are required to close the landed route.
deferred_reason: analysis-tool freeze
fixed_by: c9f2c59
---

# Bundle postmortem call-defined protocol leg coverage

For the transactions below, raw call order plus mint/burn/transfer conservation proves one or more protocol
legs, while the canonical `edgeKinds` output contains only `flash+swap` or `swap`. This does not invalidate the
receipt/PnL/DEX portions of the report, but it cannot be used as the complete production route.

Evidence hashes:

- receipt summary: `8e291e0675a2b00174dd50510b51d1a3c9b52b3ac318078f537b53145c85c579`
- trace summary: `0bbe2d25c479b217a00931c5011830e0d75b449be91461547a1d4a2404b059a6`
- canonical bundle: `4efceb98626a24c90a3c5cbc3837c3f91cac3e7ecff632aba1cfec4aa35b6548`

```yaml
transactions:
  - { tx_hash: 0x7ce631b94570e8ebcaea60e93ccfb808327087405e6f0561450d4bb7f69b3c87, block: 25535037, tx_index: 65, role: scanner, production_gap_id: rocksolid-balancer-v3, tool_actual: "pre-fix edgeKinds=[flash,swap]; post-fix edgeKinds=[flash,swap,protocol], route_gap=manual_required", manual_ground_truth: "RockSolid share deposit/redeem closes the rETH route" }
  - { tx_hash: 0x14026eeda918e2be6f5efe754fe93fc4acdf2cc7a70b24f39ea62ed097f4fd53, block: 25534878, tx_index: 213, role: scanner, production_gap_id: uad-uar-conversion, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "uAD burn/uAR mint conversion is interleaved with Curve underlying" }
  - { tx_hash: 0xda01c3be4a34740d9379fb9db9d90bd245a24191eb177ea2547a3ee6b5127d8b, block: 25534839, tx_index: 70, role: backrun_winner, production_gap_id: legacy-rpl-migration, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "legacy RPL migration converts old RPL to new RPL" }
  - { tx_hash: 0xecf9079f202b00a44c7e104e502e63d153d6d3a2d5dcf9272c23676fd8ecc161, block: 25534716, tx_index: 91, role: scanner, production_gap_id: curve-lp-lifecycle, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "Curve add-liquidity and remove-one-coin LP legs close the route" }
  - { tx_hash: 0x2b482266301fba9ce989227c2b003ade8b7c29f40ebb57dce14412d4554e1e5b, block: 25534476, tx_index: 42, role: scanner, production_gap_id: curve-lp-lifecycle, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "apxUSD LP mint and remove-one-coin legs close the route" }
  - { tx_hash: 0x03b3c17385820830b9a38321ad1a477dec13083fa4864e0d25a05287c5ee4626, block: 25534459, tx_index: 55, role: backrun_winner, production_gap_id: legacy-rpl-migration, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "legacy RPL migration converts old RPL to new RPL" }
  - { tx_hash: 0x59c4fa7530611c63da69bdeccc90034313c9116085efdc11f3a9a4e05068a4b6, block: 25534451, tx_index: 69, role: backrun_winner, production_gap_id: curve-btc-lp-lifecycle, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "Curve BTC LP mint/remove legs close the route" }
  - { tx_hash: 0x6a152fce7664283a8d0b4795a4cb557528293f6cf00d3fa0aba94ebda150d238, block: 25534436, tx_index: 0, role: scanner, production_gap_id: curve-btc-lp-lifecycle, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "Curve BTC LP lifecycle closes the route" }
  - { tx_hash: 0x5eb6dd6b9ae7fe1666666d125e8b61b41c1121ed6da4a205155880ce70a8502f, block: 25533690, tx_index: 2, role: scanner, production_gap_id: cashiva-burn-native, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "Cashiva token self-transfer burns the token and pays native ETH" }
  - { tx_hash: 0xd8171509037a51f87bcd58d68e8634580c9b56dd04b5f69852dab1b6525b141a, block: 25533690, tx_index: 1, role: scanner, production_gap_id: cashiva-burn-native, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "Cashiva token self-transfer burns the token and pays native ETH" }
  - { tx_hash: 0x3ab5ca68abc87d4143d8b5cbb3d1f4cde88f2c302a090b575317f46cc6c7ef53, block: 25533690, tx_index: 0, role: scanner, production_gap_id: cashiva-burn-native, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "Cashiva token self-transfer burns the token and pays native ETH" }
  - { tx_hash: 0x3591d78cbc1013a89cd279347ef911b58f280ae9978e0e78e3f64fa7e65d3b40, block: 25524466, tx_index: 687, role: scanner, production_gap_id: atf-bun-migration, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "ATF burn/BUN mint migration is visible in receipt flow; exact selector awaits archive trace" }
  - { tx_hash: 0x1cb5fa67ae848b72c4c96f3f5221af6279382611ef002dbeb7d4f8de6cbf72f0, block: 25524268, tx_index: 81, role: backrun_winner, production_gap_id: curve-ldo-lp-lifecycle, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "LP mint equals burn and remove-one-coin closes the route; archive trace required" }
  - { tx_hash: 0xd41e3fb8b5432a932195e865a017743e235ddba46214e976939e8e25fc02d132, block: 25524268, tx_index: 80, role: backrun_winner, production_gap_id: curve-ldo-lp-lifecycle, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "LP mint equals burn and remove-one-coin closes the route; archive trace required" }
  - { tx_hash: 0x464e8d8434ac3f0c3a3ba40a511122c7c200ae0195ef8831b5511cb53d3af1e5, block: 25524268, tx_index: 79, role: backrun_winner, production_gap_id: curve-ldo-lp-lifecycle, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "LP mint equals burn and remove-one-coin closes the route; archive trace required" }
  - { tx_hash: 0xf155ac45ce6d808c539af3aa04cf464af04a6a5ad353fde894a1ff5ec1f8efd5, block: 25524268, tx_index: 78, role: backrun_winner, production_gap_id: curve-ldo-lp-lifecycle, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "LP mint equals burn and remove-one-coin closes the route; archive trace required" }
  - { tx_hash: 0x9d7cc2a9e6d42c7867558e2139853bd42f313721dbff4ed5f1885021d4a93d5b, block: 25524250, tx_index: 97, role: backrun_winner, production_gap_id: goldfish-conversion, tool_actual: "edgeKinds=[flash,swap]", manual_ground_truth: "Goldfish protocol conversion closes the DEX route; exact selector awaits archive trace" }
```

The RockSolid row is codified by registering its exact target and `syncDeposit(uint256,address,address)`
selector in the trace-aware analyzer, with successful/wrong-target/reverted-call regressions. The remaining
rows stay open: they require their own target/selector evidence and must not be generalized from this one fix.
