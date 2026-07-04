# MEV-Share hash-only bounded-live window — analysis (run_id 1920ae1d)

> Scope: authorized, defensive on-chain arbitrage research. Node bounded-live inside the
> script-enforced envelope (Safety Rule 1): `.deploy-live` + signer ≤ 0.2 ETH + `SEARCHER_EV_GATE=1`.
> Broadcast outside the envelope stays a human gate. User-directed Phase 1 (MEV-Share flow), user present.

```yaml
window_id: mevshare-1920ae1d
date: 2026-07-04
orchestrator: Fable 5
type: flow-source enablement + measurement (first-ever measured MEV-Share hash-only window)
trigger: user-approved Phase 1 (MEV-Share). Discovered the pipeline was ~90% built but gated OFF
  (SEARCHER_ENABLE_HASH_ONLY=0) — 98.6% of flow (72x mempool) discarded before the funnel.
change: flipped SEARCHER_ENABLE_HASH_ONLY 0->1 in /opt/MEV/.env; broadcast posture untouched
  (DRY_RUN=0 / EV_GATE=1 / .deploy-live / wallet 0.0027 ETH < 0.2 cap — all asserted).
cu_spent: ~0 (local reth + node log over SSM)
```

## Safety valve
- Signer `0xb8578B6…DA3c` = **0.002704090055629396 ETH** = baseline, **unchanged** across the window
  (4 bundles submitted, none landed → no gas spend). ≥ 50% → no circuit-break. hashOnly=1 confirmed in
  `/proc/<pid>/environ`, bounded-live preserved.

## Window facts
- run_id `1920ae1d-33b3-4063-86d6-46503b0a4f0f`, PID 163752, blocks **25456413 → 25456598** (~185 blocks,
  ~38 min), `SEARCHER_ENABLE_HASH_ONLY=1`, mempool still merged (source tags separate them).

## Funnel — MEV-Share vs the R13-R21 public-mempool baseline
| stage | MEV-Share (this window) | R19 (public) | R15 (public) |
|---|---|---|---|
| opportunity_seen | **5,659** | 186 | 264 |
| simulation_result (ok) | **116** | 10 | 16 |
| bundle_submitted | 4 | 1 | 14 |
| bundle_not_included | 4 | — | 14 |

pipeline_dropped reasons: no_candidate_plans 1944 · no-profitable-quote 849 · candidate-cap 747 ·
**final_overlay_failed 167** · **hash_only_unverifiable 95** · expired-before-solver 41 · quote-timeout 23 ·
revm_prepare_failed 10 · below_ev_gate 4 · sim-revert 1.

**Headline: enabling the flow expanded the opportunity surface ~30x (opportunity_seen) and ~10x (ok sims).**
This directly follows from the 72x hint volume that was being discarded. The R13-R21 "coverage exhausted /
dust market ceiling" verdict was measured on 1.4% of flow — it does NOT hold for the 98.6% never evaluated.

## The three questions

**Q1 — latency: NOT the blocker (the old 21s overlay is gone).**
`found in Xms` (opportunity detection) p50=**10ms** / p95=**152ms** / max 2.7s — well inside the ~5s TTL.
`overlay=` appears only 6× (p50 41ms, one 11s outlier). `expired-before-solver` only 41. The stale
fixture's 21s overlay predates the warm-pool/local-quote work; current Path A latency is fine.

**Q2 — real landable +EV: the surface is bigger, but the pure-private flow is BLOCKED at submit on
sim-fidelity (a known, deliberate gate).**
- Profit distribution of the 116 sims: mostly dust ($0.1–5), but a tail of **2×0.052 ETH (~$90), 1×0.062
  ETH (~$108)** — 100-200x the public dust ceiling — AND two absurd **29.5 ETH / 33 ETH** sims that are
  clearly phantom/mispriced (the synthetic overlay overshooting).
- The 4 actual `bundle_submitted` were `mode:"eth_sendBundle"` — i.e. the **semi-public** MEV-Share subset
  where rawTx was fetchable (a v4 native-ETH arb, sim ~0.000302 ETH / ~$0.53, all 4 not included/waited 3).
- The **pure-private** hash-only opportunities (the real prize) hit the submit gate at `main.ts:1702`:
  `if (!rawTx && !allowHashOnlySubmit) skip` → 95 `hash_only_unverifiable` drops. The gate comment (added
  `e07c5a1`, **2026-06-29**, the "hash-only victims are ghosts / mempool is the real path" era): the
  SYNTHETIC overlay (impersonate a whale swapping `impact.amountIn`) diverges from the real victim for
  every adapter; measured hash-only landings had NEGATIVE real profit; 0/40 landed.

**Q3 — did anything land: no.** 4 semi-public submissions, 0 included (waited 3). No capital moved.

## Localized blocker (the decisive finding)
It is **NOT** latency, coverage, or the SSE/decode/`mev_sendBundle` plumbing (all built + working). It is
**hash-only sim fidelity**: we reconstruct the victim with a single-pool synthetic whale-swap overlay that
≠ the real victim's multi-pool state impact, so the private-flow sims are untrustworthy (the $50k+ phantom
tail proves it) and are correctly gated out of submission (`allowHashOnlySubmit` off).

Two coupled premises, one real + independent, one likely stale:
1. **Fidelity (REAL, independent of ghosts):** synthetic overlay ≠ real victim → backrun built on fake
   state → reverts on-chain (`canRevert:false` → excluded) or lands negative. THE engineering blocker.
2. **"0/40 don't land" (LIKELY STALE):** measured 2026-06-29 on public pending-hash **ghosts**, NOT on
   genuine MEV-Share **conditioned** bundles (`[{hash},{backrun}]`, included only if the referenced private
   tx lands). Per rule 3, do not inherit this premise for MEV-Share — but we can't test it until fidelity
   is trustworthy enough to submit.

## Decision — first fix target (rule-12 gated)
**Improve the hash-only overlay fidelity** so the private-flow sim is trustworthy, then flip
`allowHashOnlySubmit` on. Approach: when the MEV-Share hint carries logs (the ~20k pool-matching subset),
reconstruct the victim's true state from the actual Swap/Transfer log deltas across ALL touched pools,
instead of a single-pool synthetic whale swap. rule-12 gate: a recorded MEV-Share hint fixture where the
improved overlay's predicted post-state matches the on-chain post-state within tolerance (and the phantom
$50k tail disappears) — only that flip justifies enabling submission. This is the first Codex target
(generator/evaluator split); the fresh-analyst dual-blind decides the exact overlay reconstruction.

## Findings Ledger
| finding | owner | status |
|---|---|---|
| MEV-Share flow (72x mempool) was discarded via `enableHashOnly=0`; enabling it expanded surface ~30x/~10x | Phase-1 | **CLOSED (measured)** — [[project-mevshare-flow-discarded]]; R13-R21 ceiling qualified |
| Path A latency (old 21s overlay) | — | **closed** — not a blocker now (found-in p50 10ms) |
| **Hash-only sim fidelity** — synthetic overlay ≠ real victim → private-flow sims untrustworthy, gated at submit; phantom $50k tail | **fidelity fix (first Codex target)** | **open — the localized blocker; rule-12 gated overlay reconstruction from hint logs** |
| "0/40 hash-only don't land" premise | verify | open — likely public-ghost-era (2026-06-29), not MEV-Share conditioned bundles; re-test after fidelity |
| Window left running with hashOnly=1 (harmless; floods solver with unsubmittable sims) | Phase-1 | note — revert or keep for fixture capture |

## Verdict
First-ever measured MEV-Share window. Enabling the discarded flow expanded the opportunity surface ~30x and
surfaced $90-108 sims (vs the public $0.5 dust ceiling), decisively qualifying the R20 "coverage exhausted"
verdict. Latency is not the blocker. The precise blocker is **hash-only sim fidelity** (synthetic overlay ≠
real victim), which correctly gates the private flow out of submission today — that is the first Codex fix,
rule-12 gated by an overlay-reconstruction fixture. The "0/40 don't land" premise is likely stale
(public-ghost era) and must be re-tested on genuine MEV-Share conditioned bundles once fidelity is trustworthy.
