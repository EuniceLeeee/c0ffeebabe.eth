# Handoff-relay status (the loop's OFF switch)

> Read by `docs/research/autonomous-handoff-relay-round.md` Step 0a. Updated by every relay round at
> Step 4b. Two consecutive independent "done" verifications flip `status` to COMPLETE, after which every
> future round NO-OPs. Do not hand-edit `consecutive_done_confirmations` to skip the two-round bar.

status: IN_PROGRESS
consecutive_done_confirmations: 0

> **2026-07-05 operator re-open (Phase 2b).** The pure-local phase was verified COMPLETE (2×, log
> below). The operator then approved the chain-enabled remainder — see the handoff's `## Phase 2b`
> section for the ordered slice list + authorization scope. Counter reset to 0: the relay runs again
> and the two-confirmation bar now applies to Phase 2b completion.
>
> **R-2b-7 (2026-07-05) confirmed the blocked-on-human-gate state; no code (correctly).** Checked the
> node read-only: `SEARCHER_SUBMIT_HASHONLY_MEVSHARE` still ABSENT from the running searcher env (PID
> 177547, up 12h54m) → the operator has NOT yet acted on the R-2b-6 flag decision (chip
> `task_3deb3186`). Bounded-live safety valve verified: signer balance 0.002704 ETH ≈ unchanged from
> the 0.0027 start (no drain). Live funnel freshness (per the R-2b-6 meta-finding, never run blind):
> recent tail = 86 `hash_only_unmatchable` / 0 `bundle_submitted` — identical profile to the R-2b-6
> measurement. All remaining work is gated: the flag flip is a Safety-Rule-1 human gate; Phase-2b
> scaffolding is paused by the arch-review verdict; BS-3 discovery-blocked; CR-5b design-blocked.
> **Fast-path for future rounds until the operator acts:** check the flag in the node env first — if
> still unset and no new operator input (no new commit / chip response / env change), close as blocked
> immediately; do NOT re-run the arch review or re-derive the verdict. Counter stays 0.
>
> **R-2b-1 (2026-07-05) landed the first two Phase 2b slices and handed BS-3 back.** Done: BS-0-curve
> (`9135cbc`, curve leg node-state-verified) + edge-kinds chip (`a6b72cd`). BS-3 full-pipeline is
> handed back to the operator with a premise-changing finding (the `f2de7499` exemplar is −EV at the
> block boundary; the profit is oracle-triggered, so BS-3 needs an execution-state fork or a new
> boundary-profitable exemplar + the node's anvil-fork environment). Remainder (CR-5/BS-lane/BS-4/
> CS-*/D/CR-8) stays gated behind BS-3. Counter stays 0 — Phase 2b work remains.
>
> **R-2b-2 (2026-07-05) landed BS-3-solve and EPIC-escalated BS-3 full-pipeline.** Proceeded on BS-3
> (R-2b-1's hand-back was over-conservative — anvil-fork/dry-run is inside Phase 2b scope). BS-3-solve
> (`c63e075`, `searcher:blockscan-fork-solve` 9/9, gated against Alchemy archive) proved the block-scan
> planner→solver→fork wiring works AND deterministically pinned that `f2de7499` is un-usable: its +EV
> is a stableswap-ng swap-time `stored_rates` refresh, −EV on every pre-coffee fork, invisible to
> view-quotes. BS-3 full-pipeline is now BLOCKED on a genuinely-viable +EV block-scan exemplar (needs
> census discovery, not more harness code). Remainder still gated behind it. Counter stays 0.
>
> **R-2b-6 (2026-07-05) ran the rule-13 architecture review (dual-blind); localized THE lever.**
> Verdict (`docs/research/reports/arch-review-20260705-verdict.md`, dual-blind fable-A + Codex-B,
> orchestrator-verified live): the binding production lever is **FLOW-ADMISSION at our submit gate** —
> a bounded-live window IS running (the R-2b relay was BLIND to it, never read the live events) with
> **3,889 +EV sims, 95.3% self-dropped at `submit_gate/hash_only_unmatchable`** (incl. the biggest,
> $50–$210) because `SEARCHER_SUBMIT_HASHONLY_MEVSHARE` is unset; the `submitMevShareBundle` drain is
> already built. Fix = one config flag, NOT an epic — but flipping what we broadcast is a Safety-Rule-1
> HUMAN GATE (escalated, chip `task_3deb3186`). Phase-2b scaffolding is NOT the lever and pauses pending
> the flag decision. A vs B converged (B code-only said measurement-gap/run-a-window; A read the window
> and localized flow-admission). Counter stays 0.
>
> **R-2b-5 (2026-07-05) hit the rule-13 architecture-review trigger; escalated to the operator.**
> Under the rule-13 behavior-or-escalate mandate, investigated both remaining behavior slices: CR-5c
> (gas table) has NO clean insertion — the EV gate already uses real `sim.gasUsed`, within-plan gas is
> constant, cross-plan pre-solve has no profit signal; and BS-lane is null infra (catches nothing new
> until BS-4, and is for a dust-ceiling strategy). With BS-3 discovery-blocked + CR-5b design-blocked +
> no +EV simSuccess growth across rounds, the rule-13 architecture-review trigger fired. Escalated:
> spawned operator chip `task_3246ef5f` (strategic fork: block-scan-dust vs credit-resolver-research);
> next round runs the architecture review in a fresh context, NOT a point-fix. No code this round (by
> design — shipping null infra would be lower integrity). Cleanly-autonomous Phase 2b work is DONE;
> remainder needs human/design input. Counter stays 0.
>
> **R-2b-4 (2026-07-05) validated CR-3 secondary (CR-5a) and escalated CR-5b as design-blocked.**
> Ran `searcher:ac3` on archive: PASS 2/2 (credit path extracts 870.99 wstUSR on block 24710788,
> > the reference bot's on-chain-verified 270.1) → CR-3 secondary validated WITHOUT a new harness
> (would duplicate AC-3). CR-5b (deterministic max-borrow) is DESIGN-BLOCKED: `quoteFluidVault()`
> throws — no deterministic Fluid quote path exists; building the resolver-quote adapter needs
> external protocol research, too large for a clean unattended slice (rule-13 escalation). Next
> tractable behavior slice = CR-5c (gas table, local) or BS-lane. No hot-path change; grid stays.
> Counter stays 0.
>
> **R-2b-3 (2026-07-05) picked up CR-5, verified its archive target, decomposed it as an epic.** BS-3
> is discovery-blocked, so moved to the next unblocked slice (item 4, CR-5). CR-5 is a large multi-part
> behavior slice → decomposed into ordered sub-slices CR-5a..e (Phase 2b list). Verified CR-5's
> max-borrow equivalence target on-chain: the reference bot's realized wstUSR delta on `0xf88b` (block
> 24710788) = **270.096803239981276728 wstUSR** (≈270.1, not the loose "~273"). No code slice this
> round — CR-5 is a fresh-context epic; a rushed archive-gated adapter on this long session would be
> lower-integrity than a clean decomposition. Next round executes CR-5a (the `0xf88b` archive replay).
> Counter stays 0.

## Confirmation log (append-only; each entry = one round that re-verified all slices landed + gates green)
<!-- round-id · date · gate command re-run · result -->
- R-verify-1 · 2026-07-04 · re-ran the full rule-12 gate suite (listener `searcher:blockscan-a0`
  19/19, `searcher:blockscan-scanner` 10/10, `searcher:blockscan-solver-center` 2/2, `searcher:planner`
  15/15 + replay 14/14, `searcher:blockscan-contract` 5/5, `searcher:submission-coordinator` 8/8,
  `searcher:bundle-router-safety` 4/4, `searcher:cycle-fingerprint` 7/7, `searcher:universe-split` 6/6,
  `searcher:standing-guard` 4/4, `searcher:taxonomy` 5/5, `searcher:replay-live-fixtures` buckets
  expired:1/no-profitable:1 byte-identical; analysis `test:learning-case` 6/6; tsc listener+analysis
  CLEAN) · result: ALL GREEN — every §9.1 slice committed + gated; no pure-local slice remains (next
  BS-3 full-pipeline needs a fork fixture, remainder operator-gated). First of two independent
  done-confirmations.
- R-verify-2 · 2026-07-04 · independently re-ran the full rule-12 gate suite on fresh Fable (listener
  `searcher:blockscan-a0` 19/19, `searcher:blockscan-scanner` 10/10, `searcher:blockscan-solver-center`
  2/2, `searcher:blockscan-contract` 5/5, `searcher:cycle-fingerprint` 7/7, `searcher:universe-split`
  6/6, `searcher:standing-guard` 4/4, `searcher:taxonomy` 5/5, `searcher:planner` 15/15 + replay 14/14
  + high-spread universe, `searcher:submission-coordinator` 8/8, `searcher:bundle-router-safety` 4/4,
  `searcher:replay-live-fixtures` buckets expired:1/no-profitable:1 unchanged; analysis
  `test:learning-case` 6/6; tsc listener+analysis CLEAN) AND verified all 17 §9.1 slice commits exist
  in git (S0…BS-3a), working tree clean · result: ALL GREEN — second independent done-confirmation →
  `status: COMPLETE`. The relay loop is OFF; every subsequent round NO-OPs at Step 0a. Remaining work
  (BS-3 full-pipeline fork fixture, BS-lane, BS-4 live window, CR-5 archive replay, CS-min/CS-full/D/
  CR-8) is operator-gated per impl-plan §9.1/§9.3b.
