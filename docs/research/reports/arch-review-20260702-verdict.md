# Architecture Review — Verdict (2026-07-02)

> Fired by CLAUDE.md rule 13's architecture-review trigger (R1–R3 closed with genuine +EV
> `simSuccess` ≈ 0). Dual-blind at the architecture level (rule 13 / Rounds step 4).
> Scope: authorized defensive on-chain arbitrage research; mainnet fork + dry-run; broadcast
> is a hard human gate; targets/harms no user.

## Method — three independent reviewers, blind to each other
- **A** = fable-5→opus fallback sub-agent (chain-side + code): per-bundle atomic state-diff walk on local reth (zero CU) + one Alchemy secondary check.
- **B** = Codex, read-only (code-side): re-derived the economics / sim-fidelity numbers from `file:line`.
- **C** = independent review (user): chain + code.
Each worked from primary sources; none saw the others' conclusion. Orchestrator verified the root cause on the node (SSM, zero CU) and compared A vs B vs C.

## localized_lever = **COVERAGE** (high confidence — 3-way convergence + node-verified root cause)

### Root cause (verified: code + live node)
The curated file-backed pool universe (`active-pools.json`, **2995 scored pools**) **never loads live**:
```
main.ts:330       SEARCHER_POOL_UNIVERSE_TOP_N defaults "0"
main.ts:452-455   loadPoolUniverse(path, { maxPools: 0 })
pool-universe.ts:64   const maxPools = opts.maxPools ?? Infinity   // 0 ?? Infinity === 0  (?? only catches null/undefined, NOT 0)
pool-universe.ts:70   pools.slice(0, 0) === []                      // entire scored universe dropped
```
Node confirm (SSM, zero CU): `.env` + running-process env have **no** `SEARCHER_POOL_UNIVERSE_TOP_N` → code default **0**; `active-pools.json` = 2995 entries; competitor return-venue pool `0x2beb35e7…ec63` is **present in active-pools.json, count 0 in `runtime-graph-pools.json`**. The runtime graph (~2928 pools) is built only from registry / pinned / factory-recent / swap-active — the scored universe contributes **0**. Likely intent was `0 = unlimited` (repo convention, cf. `maxCandidatesPerOpp=0`), broken by `??` (nullish) vs `||` (falsy).

### Why this is the dominant loss (A, from structured `pipeline_dropped` events)
`no_candidate_plans` = **R1 70% / R3 77%** of drops, splitting into:
| class | R1 | R3 | meaning |
|---|---|---|---|
| `only_immediate_same_pool_reverse` | 22 | 20 | impact pool **IS** in graph, but no cross-venue **return** pool to close the loop |
| `impact_pool_not_in_routing_graph` | 11 | 18 | impact pool itself out-of-graph |
Both = missing venues that live in the **dropped 2995-pool universe**. The graph holds hot/recent pools (factory/swap) but misses the curated **return venues** → loops can't close → `simSuccess=0`.

## Counterfactual walk (load-bearing, per-bundle)
| competitor tx | block | our drop | saw? | planned? | why lost | class |
|---|---|---|---|---|---|---|
| `0x4cece1af` (+0.050 WETH, verified) | 25442793 | expired-before-solver | yes (victim `0xd14dd150`, public UniV3) | yes | 2 of 5 route pools OUT (`0x2beb35e7`, `0xe9930ea6` carried +0.084 WETH) | coverage + latency |
| `0xa88206b2` | 25442740 | no_candidate | yes | no | 2 of 4 pools OUT (`0x1069cea8`, `0x7948548e`) | coverage |
| `0x5fab74f8` (14-leg) | 25442765 | quote-timeout | yes | — | 8 of 12 pools OUT | coverage |
| `0x476548cc` (AMP) | 25443539 | no_candidate | yes | no | **REFUTED**: atomic WETH delta = **−0.478 WETH** (A: Alchemy-confirmed; C: net negative) — an Amp security-token inventory move to operator EOA, **not a +EV atomic arb**. Proves missing-graph only, not replicable +EV. | — (killed) |

## What each reviewer uniquely caught (the dual-blind value)
- **A:** dominant loss is `no_candidate` (not `no-profitable-quote`); the 2-class split; **EV gate is OFF** (`main.ts:337`, `.env` unset); **R3's "~46 no-profitable-quote" was a log-counter artifact** (structured events = 2); the planner flip fixtures already exist + pass.
- **B:** the `simSuccess` counter is **UPSTREAM** of the EV gate (`main.ts:1509` vs `1619`) → economics cannot explain `simSuccess=0`; runner-up = path-breadth (`maxHops=3` vs 7-hop route).
- **C:** sharpened coverage to the **active-universe → runtime-graph admission layer** (pools discovered but not promoted); refuted AMP; named `0x2beb`/`0xe9930` in active-pools with scores ~229/~165.
- **Orchestrator (node):** empirically verified the `topN=0` mechanism + `0x2beb` present-in-active/absent-in-runtime.

## Ruled out
- **economics** — EV gate OFF live; counter upstream anyway → not the `simSuccess=0` cause (carry as a pre-broadcast fix).
- **flow-admission** — we DID admit the flow (saw the R1 triggering swap, planned it) → not "never saw it".
- **sim-fidelity** — samples die at plan construction, before quote/sim.

## Runner-up + falsifier
- **runner-up = funnel-latency** (second-order, on the already-covered subset — expired/quote-timeout on in-graph arbs).
- **separating evidence:** `no_candidate` counts (42–53/window) dwarf the latency-class takes, and the latency arbs ALSO need out-of-graph pools (e.g. `0x4cece1af`'s +0.084 WETH out-of-graph leg) → winning the latency race alone can't reconstruct those loops. Coverage is the gating constraint; latency is second-order.
- **cheap disproof:** fix the universe load; replay a live `only_immediate_same_pool_reverse` sample. Flips to `plans>0` + +EV sim → coverage confirmed. Stays 0 / quote ≤0 → sim-fidelity is primary.

## decision: **EPIC** — proactive venue-graph coverage (return-venue closure)
Trailing W3 (add-a-pool-after-a-competitor-shows-us) is **structurally insufficient**: the dominant class already HAS the impact pool; what's missing is the **pair's venue neighborhood**, indexed proactively.

### Slice-1 (rule-12 deterministic gate)
- **Gate ALREADY EXISTS + PASSES:** `test/planner.ts` fixtures `coverage-ovr-weth-gap → coverage-ovr-weth-flip`, `v3fork-triangle-gap → v3fork-triangle-flip` (add the missing cross-venue return pool → `only_immediate_same_pool_reverse` 0→≥1; `single-venue-longtail` stays 0 = anti-fabrication guard). `npm run searcher:planner` → **12/12 + 6/6 PASS**.
- **Slice-1 code (Codex, latency-aware):** make the curated scored universe actually enter the runtime graph — treat `topN=0` as unlimited **OR** set a deliberate `topN`/`min-score` that supplies return venues **without** blowing graph size (the latency runner-up). Then verify a **live** `only_immediate_same_pool_reverse` sample flips to `plans>0` → genuine +EV `simSuccess`.
- **expected_transition:** `no_candidate_plans (only_immediate_same_pool_reverse)` → `candidate_plans>0` → genuine +EV `simSuccess`.

## Findings Ledger
| finding | owner | carry_to | status |
|---|---|---|---|
| coverage root cause: `topN=0` → curated 2995-pool universe loads empty | epic slice-1 | R4 | **open** |
| latency runner-up (in-graph arbs expired/quote-timeout) | round after coverage | after slice-1 | open |
| `valueInEth`=0 for non-stable/WETH profit token (H3b) — post-sim, latent | pre-broadcast economics | go-live | open |
| EV gate OFF live (`SEARCHER_EV_GATE` unset) — must turn on before broadcast | pre-broadcast | go-live | open |
| AMP `0x476548cc` refuted as a +EV sample (−0.478 WETH inventory move) | — | — | **killed** |

## distance-to-production check
Closing coverage (return-venue neighborhoods) converts the 70–77% `no_candidate` loss into candidate plans — the first structural change that can produce a genuine +EV `simSuccess`, not another clean-but-null solver fix. Economics (EV gate on, `valueInEth`, bribe sizing) is a **separate pre-broadcast slice**, gated at go-live.
