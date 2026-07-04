# Architecture Review Verdict — 2026-07-05 (rule-13 refire, dual-blind)

> Scope: authorized defensive on-chain arbitrage research; the live window is a bounded-live envelope
> (Safety Rule 1). Neutral wording. Verdict drives the Findings Ledger; the actionable fix is a
> broadcast-behavior change and therefore a HUMAN GATE — recommended, not auto-applied.

## Verdict: PRIMARY lever = FLOW-ADMISSION at the submit gate (one unset flag)
**We admit MEV-Share flow at intake, simulate its highest-value +EV opportunities, then discard 95% of
them at our OWN submit gate whose drain is already built but disabled by one unset flag.**

### Independently verified live evidence (run_id `7f19a027`, node PID 177561, bounded-live)
| funnel stage | count | note |
|---|---|---|
| `simulation_result` ok=true | **3,889** | genuine +EV sims — simSuccess is NOT flat-0 |
| drop `submit_gate/hash_only_unmatchable` | **3,706 (95.3%)** | MEV-Share opps, submit flag OFF |
| drop `submit_gate/below_ev_gate` | 159 | true dust (gas > profit) |
| drop `submit_gate/hash_only_unverifiable` | 18 | |
| `bundle_submitted` | **6 (0.15%)** | rawTx mempool only; top sim $16 |
Arithmetic closes exactly: 3706 + 159 + 18 + 6 = 3889. Biggest dropped sims (fable A, per-token
re-derived): WETH ~0.0605 ETH (~$210), USDC ~$50 — all in the `hash_only_unmatchable` bucket.

### file:line + node facts (re-derived, verified by orchestrator)
- Submit gate: `hashOnlySubmitDecision` (`main.ts:222`) = `rawTx || (overlayExact && allowHashOnlyMevShareSubmit) || allowApprox`; drop reason `hash_only_unmatchable` at `main.ts:1868`.
- The flag: `SEARCHER_SUBMIT_HASHONLY_MEVSHARE==="1"` → `allowHashOnlyMevShareSubmit` (`main.ts:435`). **UNSET on the node** (verified `/proc/177561/environ`: absent).
- The drain is BUILT: `submitMevShareBundle` imported + called (`bundle-router.ts:2,125`). Not an epic.
- Node env verified: `.deploy-live` present, `SEARCHER_DRY_RUN=0`, `EV_GATE=1`, `ENABLE_HASH_ONLY=1` (faucet ON), `BRIBE_ALL_ABOVE_GAS=1`, events `/var/log/mev/events/searcher-live.jsonl`.
- gasUsed=0 bug FIXED (`botvm-simulator.ts:48` real gas; `:67` 0n only on revert); `simSuccess` pre-EV-gate (`main.ts:1810` vs gate `:1963`) — both confirmed by A, B, and orchestrator.

## Dual-blind A vs B — converge
- **B (Codex, code-only, no chain):** primary = **measurement-gap** — "no live-path data after the gasUsed
  fix + MEV-Share flip; run a fresh measured window, not a new epic; existing mechanisms suffice."
  Correct given no chain access.
- **A (fable, chain+code):** got the fresh data (it existed all along — the offline rounds never read the
  live events) → localized to **flow-admission/submit-gate**; measurement-gap is "the cause of the
  misframe, not the obstacle."
- **Compare:** CONVERGE. Both reject Phase-2b scaffolding, the fixed gasUsed bug, and a new epic. B's
  "run a measured window" IS what A did; A's result is that measurement. A subsumes B → high confidence.

## Runner-up = economics / net-capture (downstream, strategic human gate)
`SEARCHER_BRIBE_ALL_ABOVE_GAS=1` → `computeBidEth = max(profit − gas, 0)` (`main.ts:216`) → net-to-us ≈ 0
even on the 6 we do submit; and those 6 mempool bundles don't land (one-shot, rule-6a expected).
**Separator:** if the wall were inclusion/economics we'd be SUBMITTING our biggest sims and losing the
auction — instead we NEVER submit the $50–$210 sims. Value is concentrated in the un-submitted flow →
submit-admission dominates. Bid posture (bribeAllAboveGas ⇒ 0 net) is a strategic call.

## Meta-finding (process): the relay was BLIND to the running live window
My regenerated handoff's premise — "no live window since 2026-07-03; R-2b was offline only" — was FALSE.
A bounded-live window has been running throughout, producing 3,889 +EV sims, while the R-2b relay did 5
rounds of OFFLINE Phase-2b scaffolding and never read `/var/log/mev/events/searcher-live.jsonl`. The
"measurement-gap" was self-inflicted. **Process fix: the relay/Hermes loop MUST read the live events each
round (the Step-1 precondition), not run offline slices blind to the live funnel.**

## Falsification (cheap, operator-gated — Safety Rule 1)
Set `SEARCHER_SUBMIT_HASHONLY_MEVSHARE=1` for ONE bounded-live window (envelope intact: wallet ≤0.2 ETH,
`EV_GATE=1`; `mev_sendBundle` is conditioned on the referenced hash landing ⇒ no phantom-loss path,
per [[project-mevshare-flow-discarded]]).
- Right ⇒ `bundle_submitted` jumps 6 → hundreds/thousands via `submitMevShareBundle` incl. the 0.06 ETH
  sims; Flashbots ACCEPTs → then `bundle-postmortem` measures real inclusion (the next real lever).
- Wrong ⇒ they still don't submit / relay rejects / real profit ≪ overlay sim (sim-fidelity).

## Decision (Findings Ledger)
- `localized_lever: FLOW-ADMISSION (submit gate)` · `decision: CONFIG-FLAG (not epic)` · the drain is built.
- **The flip is a broadcast-behavior change → HUMAN GATE (Safety Rule 1). RECOMMEND, do not auto-flip.**
  Escalated to the operator (chip). The bid-posture (bribeAllAboveGas ⇒ 0 net) is a second human call.
- Phase-2b scaffolding is NOT the production lever; it should pause pending the flag decision + a fresh
  measured window post-flip.
