---
divergence_id: bundle-postmortem-hook-aware-family-routing-blindness
status: open_frozen
tool: analysis:bundle-postmortem@3c8a04b9c31960d39992d139a310f868edbe5631
capability: graph
root_cause: The analyzer treats every swap-affecting Uniswap V4 hook as statically unroutable and does not reconcile a registered hook-aware execution family plus its projected runtime graph row.
deferred_reason: analysis-tool freeze
fixed_by: null
---

# Bundle postmortem hook-aware family routing blindness

The analyzer's generic V4 graph check correctly rejects a hooked pool from the
`univ4-standard` execution family, but incorrectly turns that family-local
rejection into a global routing rejection. It does not check whether another
registered execution family owns the same physical PoolKey and has emitted its
own runtime graph row.

```yaml
transactions:
  - tx_hash: 0x4be8087e364551cc820151b75218002c3b664cb8204bbf02f911f832ac77a7dc
    block: 25642417
    tx_index: 138
    role: scanner
    production_gap_id: blockscan-startup-warm-head-supersession
    pool_id: 0xe500210c7ea6bfd9f69dce044b09ef384ec2b34832f132baec3b418208e3a657
    hook: 0x0000000aa232009084bd71a5797d089aa4edfad4
    tool_actual: "routing_admitted=false; routing_reason=hooked_v4; landed_adapter=null"
    manual_ground_truth: "live runtime graph contains the separate angstrom-v4 projection for this PoolKey; custom-swap:angstrom-v4 owns two directed USDC/WETH edges, while univ4-standard remains correctly excluded"
```

The indexed run was executed through `tool-run` on the active node against its
local reth. `bundle-postmortem.ts` is byte-identical between the tested live
commit and `origin/main@87079e5210b44e8d84051b8b11edca89d36e3cfe`.

- selection manifest SHA-256:
  `fb4dde3de994c52956029a9ab8cb40587ec6940563341913fec39b3ce97c77b3`;
- bundle output SHA-256:
  `fd937c0d3418a37780bc737e88fe97f862a5c9965dc97519680b0ddc23bfbf94`;
- tool classification that remains usable:
  `winner_style=atomic_loop`, `positioning=standing_state_take`,
  `edge_kind_evidence=logs_plus_call_trace`;
- live runtime graph evidence:
  `runtime-blockscan-pools.json` and `runtime-graph-pools.json` each contain
  both the physical `univ4` PoolKey row and the projected `angstrom-v4` row
  with `logicalInstanceId` equal to the PoolId;
- live state-coordinator evidence:
  `familyId=custom-swap:angstrom-v4`, `uniqueStateKeys=2`, `reads=4`.

This divergence invalidates only the analyzer's `hooked_v4` routing verdict.
It does not invalidate the receipt, trace, flow, PnL or standing-state
classification. Under the analysis-tool freeze, the analyzer is not repaired
in this transaction-gap round.
