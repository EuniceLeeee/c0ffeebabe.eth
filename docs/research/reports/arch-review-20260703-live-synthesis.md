# Architecture Review — 3-way synthesis (2026-07-03, bounded-live)

> Manual arch review (user-triggered): Claude viewpoint + Fable-A (independent, blind) + Codex
> re-review of Claude. Scope: authorized arbitrage research; node in bounded-live (test wallet ≤0.2 ETH).

## The three inputs
- **Claude:** flow-admission primary + no-replicable-atomic-EV ceiling.
- **Fable-A (independent, blind):** `no-replicable-atomic-EV` primary (EV-gate-on ~5.3h: 16 ok-sims, 1 +EV
  ≈ 1/5h; 2 chain traces: pinned `0x2e19d126` = single UniV3 swap / CEX-DEX non-replicable; coffeebabe
  `0x33e81fdb` = real 7-pool 4×v4 atomic loop but $0.15 dust). Runner-up flow-admission. **Real production
  gate = inclusion, live-only measurable.**
- **Codex re-review of Claude:** partly agree; corrects "flow-admission primary" → **longtail/high-spread
  pool admission** (R12's shipped lever) + bounded-live measurement. Flags residual economics suppressors
  (`valueInEth` zeros exotic tokens; live quote floor; wallet-headroom priority-fee cap).

## Synthesis (convergence)
1. economics / funnel / coverage-load = **done + working** (bribe=5000, EV gate on, gasUsed fixed). Residual:
   `valueInEth` exotic-token zeroing (latent, minor).
2. Replicable atomic +EV is **thin (~1/5h)** — but NOT a proven universal ceiling; Step-1 R9-R11 show 4-6
   **closable** out-of-graph competitor legs → R12's high-spread admission targets exactly these (live, unproven).
3. **Measurement gap (Codex, load-bearing): there is NO on-chain-inclusion event.** Production `accepted` = builder
   HTTP accepted only, NOT mined. So "did the bundle land + net positive" is currently UNMEASURABLE without
   pulling the tx_hash on-chain. All 42 historical bundles were dry-run (`accepted:false`).

## Unanimous next step (do NOT open another funnel point-fix)
Run **bounded-live as a measurement instrument, multi-hour → 1 day**, full-funnel instrumented INCLUDING
on-chain inclusion:
`opportunity_seen → simulation_result.ok → bundle_submitted → accepted → tx_hash on-chain receipt (mined? net?)`.
One experiment resolves all three: (a) does R12 high-spread admission yield recurring non-dust bundles;
(b) do our +EV bundles actually land + net positive (the inclusion gate); (c) pins the primary label
(no-replicable vs coverage vs inclusion) with data.

- **Decision gate (rule 14 self-served; broadcast/scope stays human):** ≥1 net-positive bundle lands over the
  window → architecture production-viable → reframe to inclusion-tuning (bribe-curve vs land-rate, the user's
  "capture moderate +EV" lever: bribe 5000→lower widens the +net band). Zero lands over a full day AND the
  victimless-spatial-arb falsifier is also dust → `no-replicable-atomic-EV` confirmed → strategy-class expansion
  (JIT-LP/CEX-DEX) breaks the atomic-flash safety posture → escalate to human.

## New finding (carry)
| finding | owner | status |
|---|---|---|
| No on-chain-inclusion event — `accepted` != mined; land-rate unmeasurable without tx_hash on-chain lookup | next | open — add inclusion instrumentation (or per-bundle on-chain check) before/as part of the multi-hour measurement |
| bribe-curve vs land-rate tuning (widen +net band, capture moderate +EV) | phase-2 | open — only after ≥1 bundle proven to land |
| `valueInEth` zeros exotic-token profit (latent economics suppressor) | later | open, minor |
