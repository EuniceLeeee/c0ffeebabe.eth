---
divergence_id: bundle-postmortem-ekubo-call-defined-swap-coverage
status: open_frozen
tool: analysis:bundle-postmortem@866c5f4
capability: venue_identity
root_cause: Event-led swap classification omits successful call-defined Ekubo swaps whose Core events do not match a registered production swap venue.
deferred_reason: analysis-tool freeze
---

# Bundle postmortem Ekubo call-defined swap coverage

Transaction
`0x73078d54fe1bac89e934d71a574e290ddb98e9d9a2e44c6ec7ae2a05cc88c823`
at block `25633846` contains the following trace-proven ordered core route:

1. native ETH to EKUBO through direct target
   `0xd26f20001a72a18c002b00e6710000d68700ce00`, selector `0x4adbe0cc`
   (`swapAllowPartialFill`), which enters Ekubo Core
   `0x00000000000014aa86c5d3c41765bb24e11bd701`;
2. EKUBO to WBTC through direct target
   `0xa94193321ea67f1b6058ad574527f258147f9bb9`, selector `0xe854bac3`
   (`swapExactInput`), which enters the same Core;
3. WBTC to WETH through the registered UniV3-like pool
   `0x84348b059fb42f4fad3fec70db82629b9ce495c4`.

The ordered call trace, decoded calldata/return values, native-value continuity and token transfers
independently establish both Ekubo legs. The canonical tool was selected through `tool-index` and executed
through `tool-run`, but reported `route_gap_analysis=swap_venues_only` and identified only the standard
UniV3 swap venue. It therefore cannot be used as the complete venue or route inventory for this sample.
Its receipt, balance-flow and PnL outputs remain usable.

Evidence hashes:

- tool-index manifest:
  `bc75468fab82039012801bdcb764dede5ed6b6111a0d1b645f9d48446ba6a180`;
- canonical bundle report:
  `118cce8177ae106e278742775de8484e81a05330e41fc66510bbf95071868fc4`;
- audited baseline:
  `866c5f494e4ef55b3b3ea0f3fe7f4dc3feb7b82a`.

This tx-gap round is frozen: it records the coverage disagreement but does not modify the analyzer, hooks or
gates. Production diagnosis must prefer the raw trace for the missing Ekubo venue legs until this divergence
is separately codified and reviewed.
