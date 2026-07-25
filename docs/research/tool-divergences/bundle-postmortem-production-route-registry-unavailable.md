---
divergence_id: bundle-postmortem-production-route-registry-unavailable
status: resolved
tool: analysis:bundle-postmortem@a699009a8aad5112522a9f37f1627896359bb869
capability: classification,pnl,flow,graph,causality
root_cause: The analyzer still expects the pre-AdapterFamily production route/action registry export and aborts before analysis when run against the universal AdapterFamily branch.
deferred_reason: null
fixed_by: 669e03d269d97eeda78fd6c010c417589cbc4102
---

# Bundle postmortem production route registry unavailable

```yaml
transactions:
  - tx_hash: 0x02a8b803ed975ebc944d61a218c9438f5ae62615969434046a5d53ab4d1966af
    block: 25599790
    tx_index: 68
    role: scanner
    production_gap_id: curve-underlying-dormant-universe-retention
    tool_actual: "exit 1: Error: production route/action registry unavailable"
    manual_ground_truth: "position-conserving USDT -> PAXG -> GOLDX -> USDX -> USDT loop using univ3-swap, goldx-mint, univ2-swap and curve-exchange-underlying"
```

The manual result was established first from node-local raw transaction, receipt and successful call trace.
The exact raw transaction was then submitted to an isolated Anvil fork at parent block `25599789`; it
reproduced the same transaction hash, `status=1`, `gasUsed=0x19702e`, 35 receipt logs and a successful
324-node call trace.

Canonical reconciliation was selected from the current tool index for
`single-transaction,causality,pnl,flow,graph`. It recommended only `analysis:bundle-postmortem`. The indexed
run failed before producing a classification:

- descriptor SHA-256: `ebd4d61f8766d282fed217269cf3bede1cc52b97e5a8d32a4bdd6ae8de472af6`;
- argv SHA-256: `945dd356d7d44ad9fe5ffe16969682b5c6b2bfd3370f4ce5a14066f75901f9ce`;
- stdout SHA-256: `2c3ae8d42495157c02f1c3bd8d71d852d2242aa11ba038120aeae0cd2875ba22`;
- stderr SHA-256: `3b4fb124e39b24e0b80b628f1c16ec943b745f9184d8b338c14c37eab14b3e30`;
- updated execution manifest SHA-256:
  `1690bd6e533b2f0fcdd076bb01f99f4e454895bf88fb983e863acff649a96b94`.

Node-local evidence is retained outside Git under
`/opt/MEV-runtime/evidence/new-sentinel-02a8b803/`:

- transaction JSON: `69535e0bcaa5775ae63200d0530042bb6a9fb40adef2bfbb5f61fa819ee2ab55`;
- raw transaction JSON: `37a262b88c538e88abfb3ebc9f9cb501a6288f4f3b6f6ac02aab494e8e52d225`;
- receipt JSON: `802e9c7364ff0815a2294b0b7b9fe3339edf2876fb9f6ea6a18f5a53bb38d40f`;
- call trace JSON: `4ff73208190efc7f4477c09abf96a7f68f538790eadcf66f1a6e07c4257f0505`;
- block JSON: `d8419a8eeacf4fc9bff6febc556bbd80e236b099e19abcfa62eb2d63996eb8ca`;
- parent block JSON: `e5d5622e7bd1b09159067d59a3dbbb7f829b422067ebb9020096237ef44616cc`;
- raw replay receipt: `ad63e5313622262af82f7ab63c8974a54a1a908d04f169428679b957c5113c9b`;
- raw replay trace: `da498969852b5bdcff54309a5e324e3e9011293a4d07a5400db4a1159ae806ed`;
- active-universe natural graph diagnostic:
  `156cf2ffdaba58e5d99914f3d01239e21a1034a1a980482611d3dd010a0e196b`;
- pre-existing non-active universe diagnostic:
  `5ebdb21d97a4941a3a611ddba99ae612abc6b609fc4631779a3ce32e3f17ee6e`.

## Resolution

Commit `669e03d269d97eeda78fd6c010c417589cbc4102` removed the obsolete production-registry
assumption. After making the independent chain/fork judgment above, the current tool inventory was queried
again for `single-transaction,causality`; it selected `analysis:bundle-postmortem`, which completed
successfully against the same transaction from the adapter-family validation checkout.

- tested searcher SHA: `54fe13d58bbd27033897348d7e7d9bf8adea9d9e`;
- indexed tool count: `236`;
- current selection manifest SHA-256:
  `ef0a25ae99d6effb9ada5a9a36b4dff88ef8b7b4e464e2c0da3c305807825b24`;
- postmortem output SHA-256:
  `cd0f1016f7f1575c9ada7ca6e51c8fa80519964397e4bd2296da11851b5b8fee`;
- node evidence:
  `/opt/MEV-runtime/evidence/adapter-family-024562f/tx02-tool-manifest-54fe13d.json` and
  `/opt/MEV-runtime/evidence/adapter-family-024562f/tx02-bundle-postmortem-54fe13d.json`.

The repaired analyzer classifies the transaction as `atomic_loop` /
`standing_state_take` from logs plus call trace. It still marks the non-swap protocol ordering for manual
resolution; that is an analysis taxonomy limitation, not the former registry-loading crash. The frozen
full-graph six-step artifact independently proves the GoldX protocol edge and the complete four-leg route.
