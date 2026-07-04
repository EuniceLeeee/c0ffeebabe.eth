# Architecture Review Handoff — refired after R-2b-1..5 (2026-07-05)

> Regenerated per `docs/research/templates/architecture-review.md` §B. DATA + HYPOTHESIS, not
> conclusions. Scope: authorized defensive on-chain arbitrage research; mainnet fork + dry-run;
> broadcast is a human-gated step. Neutral wording.

## 0. FRAME AUDIT FIRST (mandatory — challenge the shared frame before localizing)
The trigger fired on "no +EV `simSuccess` growth across rounds." But the R-2b rounds ran **ZERO live
windows** — they were all OFFLINE Phase-2b strategy-expansion scaffolding (block-scan + credit). So the
flat-simSuccess "evidence" is not a fresh measurement; it is the ABSENCE of measurement. Two frame
challenges the reviewer MUST answer before naming a lever:
1. **Is "coverage/scaffolding exhausted" measured on COMPLETE, CURRENT intake — or inherited from stale
   data?** The last live window was **R11, 2026-07-03** (see prior handoff in git history). Since then:
   (a) the economics/sim-fidelity lever that review localized (the `gasUsed=0` sim bug) has been **FIXED**
   in code (verify below), and (b) **MEV-Share was flipped ON 2026-07-04** ([[project-mevshare-flow-discarded]]:
   the old "dust ceiling" was measured on ~1.4% of flow). Neither change has been measured live. So the
   binding production lever is being localized on data that predates the two biggest relevant changes.
2. **Are we conflating "not-worth-it-for-block-scan" with "no production lever"?** R-2b concluded
   block-scan is dust-limited ([[project-f2de7499-not-viable-blockscan-exemplar]]) and credit needs a
   Fluid-resolver research slice. Both are STRATEGY-EXPANSION tracks. The searcher's PRIMARY path is
   backrun (mempool + MEV-Share). Is the real distance-to-production lever in the EXISTING backrun path
   (intake completeness post-MEV-Share + the R11 inclusion/economics wall), not in Phase-2b scaffolding?

## 1. Trigger evidence — R-2b round table (all OFFLINE, no live simSuccess measured)
| round | type | shipped | live simSuccess? |
|---|---|---|---|
| R-2b-1 | offline | BS-0-curve (`9135cbc`) + edge-kinds (`a6b72cd`) | not measured |
| R-2b-2 | offline | BS-3-solve probe (`c63e075`); pinned f2de7499 non-viable | not measured |
| R-2b-3 | offline | CR-5 decomposition + verified 270.1 wstUSR archive target | not measured |
| R-2b-4 | offline | validated CR-3-secondary (AC-3 archive 2/2) | not measured |
| R-2b-5 | offline | investigated CR-5c/BS-lane → both blocked/null → this trigger | not measured |

**No live dry-run window has run since 2026-07-03 (R11).** The offline slices are all valid gated work;
none touched the backrun production path or measured live simSuccess/inclusion.

## 2. HYPOTHESIS to pressure-test (orchestrator's frame-audit read — treat as hypothesis, not verdict)
The binding lever is **NOT Phase-2b scaffolding** and **cannot be named from stale data**. The loop has
shipped offline strategy-expansion + a since-fixed economics bug without re-measuring live. Primary
candidate lever = **MEASUREMENT / backrun-path revalidation**: run a fresh dry-run window (post-MEV-Share,
post-gasUsed-fix) + Step-1 competitor cross-ref, then localize among {coverage | sim-fidelity | economics
| flow-admission}. Runner-up = **economics** (bribeBps=100% / EV-gate posture, §4) if the fresh window
still shows non-dust bundles dying pre-inclusion. Falsify by: if a fresh window shows simSuccess still 0
pre-EV-gate, the lever is plan→sim (coverage/fidelity), not measurement/economics.

## 3. Verified current-code facts (rule-13 #2 — re-derived this round, do not inherit)
- **`gasUsed=0` sim bug is FIXED.** `botvm-simulator.ts:48` `const gasUsed = await this.state.getGasUsed(txHash)`
  → real gas on success (AC-3 measured `sim.gasUsed=1059262`); `gasUsed:0n` (`:67`) is ONLY the
  revert/failure path. The 2026-07-03 review's headline economics finding is remediated.
- **`simSuccess` is pre-EV-gate.** Recorded at `main.ts:1810-1811` (`sim.success && sim.netProfit>0n`),
  the EV gate is later at `main.ts:1963`. So flat simSuccess=0 (when it occurs) is a plan→sim problem,
  not an EV-gate one. The EV gate uses REAL sim gas now (`main.ts:1919` `sim.gasUsed>0n ? sim.gasUsed : default`).
- **AC-3 archive replay PASSES 2/2** (R-2b-4): the credit-edge + curve/v4/psm path self-composes a
  profitable arb (870.99 wstUSR on block 24710788) — the offline pipeline is sound.

## 4. Economics config snapshot (verify against node `.env` — code defaults here)
| knob | code default | file |
|---|---|---|
| `SEARCHER_QUOTE_SAFETY_BPS` | 9999 | solver.ts / main.ts |
| `SEARCHER_QUOTE_PROFIT_FLOOR_BPS` | 20 dry / 0 live | main.ts |
| `SEARCHER_BRIBE_BPS` | 10000 (100%) | main.ts:350-ish |
| `SEARCHER_MIN_NET_ETH` | 0 | main.ts |
| `defaultGasUsed` fallback | 12,000,000 | main.ts (only when sim.gasUsed==0, i.e. reverts) |
Note: bribeBps=100% means `bidEth=expectedProfitEth` → `netEth=-gasCostEth` when the EV gate is ON —
still fail-by-construction IF the gate is on live; but the gate is OFF in dry-run and simSuccess is
upstream of it, so this is a pre-broadcast wall, not a simSuccess blocker. Confirm live `.env` values.

## 5. Pinned counterfactual case — STALE (2026-07-03 R11; no fresh window this round)
- tx `0x2e19d12618a20024759214b553a904c8a3f561ebee5d15b7c8b4c3aebdc5997c`, block 25447978, competitor
  `0xae2Fc483…FaE13`; gasUsed 106774 (~112x < our 12M fallback), pool `0x51840EdC…CCD74` (UniV3).
  Appeared in R11's own `no_candidate_plans` list yet script said not-in-routing-graph — unresolved
  path-vs-registration contradiction. **This is STALE — its value now is only to test whether the
  contradiction still reproduces; a fresh window is needed for a live counterfactual walk.**

## 6. Deliverable (per template's 4 hard requirements)
Answer the §0 frame-audit questions FIRST, then name the primary binding lever to a real +EV on-chain
bundle (coverage | sim-fidelity | economics | flow-admission | **measurement-gap**, or a combination
with a named primary). Re-derive load-bearing numbers from `file:line`. Give a runner-up + the evidence
separating it + one cheap falsification experiment. Inventory repo mechanisms before naming any `epic`.
Note explicitly: R-2b shipped offline scaffolding without a live window since the gasUsed fix + MEV-Share
flip — weigh whether the mandated next action is a fresh live measurement (operator-gated) vs a code lever.
