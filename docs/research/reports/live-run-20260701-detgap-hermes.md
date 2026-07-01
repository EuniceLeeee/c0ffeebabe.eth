# Hermes — detection_gap round `20260701-detgap`

> Fresh 30-min dry-run window (sample discipline). First round under governance 11–13
> (xhigh protocol, forcing functions, fixed-vs-implemented) + mandatory manual competitor analysis.

```yaml
run_id: 20260701-detgap
window: blocks 25436735–25436886 (~151 blocks / ~30 min)  # backup: searcher-live.20260701-171959.bak
config: SEARCHER_LIVE_BACKEND=revm / mempool=1 / local reth / cuProxyRpcCalls=0
codex: landed   # manual-analysis pass (reasoning), + v4-quote slice-1 (branch)
turn_class: extraction   # ships a searcher change (v4-quote slice-1)
searcher_behavior_change: yes   # v4 epic slice-1 (real V4Quoter)
```

## Run Facts  <!-- auto -->
```
funnel: opportunities 80 / plans 205 / solverEntered 121 / simSuccess 0
pipeline_dropped: 59 no_candidate_plans (80%) / 10 expired-before-solver / 5 no-profitable-quote
mempool: pendingReceived 31738 / cuProxyRpcCalls 0
```

## Competitor Coverage (step-1: --watch + --graph-pools + poolId→token)  <!-- auto, secondary-validated -->
```
watchlist 2 bots: 39 competitor txs
net_per_block total=$686  via_v4=$637 (93%)  ethUsd=1578
not_seen: graph_gap=15 / detection_gap=11
```
Note: 2 of the 11 detection_gap are v4-cross arbs (incl. a $635 one) → really v4 territory; the pure non-v4 detection_gap is small ($~6, break-even legs).

## Manual competitor analysis (governance — NOT script-only)

### Claude — manual trace of coffeebabe `0xd60d80df…` (block 25436883)
- **core judgment:** ATOMIC cross-venue arb (Uni v4 + Balancer Vault + v3 `0xe0554a47`), NOT a backrun. Evidence: coffeebabe is the **first toucher** of its main pools (`0xe0554a47` at idx 10, before idx 14/89; `0xa9c9a8fb` idx 10 alone); the preceding tx (idx 9) shares no pools. `to` = `0xe08d97…015` — the ORIGINAL wstUSR reference bot in CLAUDE.md → the bot we study IS coffeebabe's executor.
- **implication:** to catch THIS: needs (a) v4 support AND (b) atomic/state-triggered detection (no victim exists → mempool + MEV-Share both blind here). MEV-Share genuinely can't help this one (no user orderflow victim) — now PROVEN, not asserted.
- **self-correction:** my earlier "atomic / MEV-Share can't help" was directionally right but **under-evidenced** (inferred from one unrelated pool probe). The manual first-toucher trace is the real evidence.
- **not_doing / caveat:** n=1 — do NOT generalize "all detection_gap is atomic" from this. The idx-5 earlier v4 swap is unchecked (would need its poolId to rule out a v4 backrun).

### Codex — independent manual read (converged, independently)
- **core judgment:** atomic cross-venue arb, not a proven victim backrun — same first-toucher evidence (idx 10 first on `0xe0554a47` [10,14,89]; sole on `0xa9c9a8fb`; idx 9 shares no pools).
- **detector:** a victim-triggered detector (mempool / MEV-Share hints) has nothing to key off when there's no prior victim tx — "visible only from state and cross-venue pricing, not from someone just moving this pool."
- **required:** atomic/state-triggered detection + v4 support (route touches v4 PoolManager + Balancer + v3).
- **caveats (raised independently):** n=1 does not classify the whole detection_gap bucket; idx-5 v4 swap must have its poolId + state-delta checked before assuming coffeebabe backran it.

## Claude Final Decision  <!-- AUTHORITATIVE -->
- **user decision (2026-07-01): non-victim-backrun (atomic) — we do NOT do it.** So the manually-traced coffeebabe `0xd60d80df` (atomic cross-venue) is **out of scope**, and the atomic/state-triggered-detection epic is **KILLED** (not deferred). We stay victim-triggered (mempool + MEV-Share).
- **decision:** the round's `searcher_behavior_change` = **v4 epic slice-1 (real V4Quoter)** on branch `v4-epic-slice1` — for the **victim-backrun** opportunities that route through v4 (graph_gap, the executable share). Verdict `implemented_not_validated` until the full replay gate.
- **process correction:** this round's "Codex independent manual analysis" was flawed — Claude fed Codex its own curated facts instead of Codex working from the raw script artifacts + its own trace (a correlated hand-off, not independence). Rule strengthened (Step-1 mechanics: primary-source independence). Future rounds: each agent reads the raw `watch-*.json`/`--competitor-scan` output itself, never the other's conclusion.
- **rationale:** with atomic off the table, the money we can actually pursue is victim-backrun arbs that route through v4 (v4 execution/quote gap) — which is exactly slice-1. No new detection model.

## Repair Replay Gate (governance 12) — R1 CLOSED
- **searcher_behavior_change:** yes — v4 slice-1 (real V4Quoter) + USDC/USDT v4 pool pinned so the planner routes through `univ4-unlock`.
- **kind:** deterministic (quoter/graph) → REPLAY.
- **failing_sample:** USDC/USDT v4 pool `0x395f91b3…` (fee8/ts1/no-hooks); replay block 25278826.
- **baseline_failure:** `quoteUniV4` was a V3-proxy stub (2 hardcoded pairs → V3 proxy pool, threw for the rest); v4 pool absent from graph → replay produced **0/20 plans through univ4** (22 edges), quoteUniV4 never called.
- **fix_commit:** `ccae872` (slice-1) + `290bb15` (pin + validate) → merged to main `1fccf71`.
- **replay_command:** `npx tsx src/searcher/test/validate-v4-quote.ts` (quote correctness) + `npx tsx src/searcher/test/replay-v4-arb.ts` (threading).
- **replay_result:** (1) `validate-v4-quote`: encoding **bit-exact** vs independent V4Quoter call (encMatch=true ×3); reproduces the **real on-chain v4 swap** at block 25436883 (35045.87 USDT → 35012.02 quote vs 35013.32 actual) to **0 bps**. (2) `replay-v4-arb` with pin: **22→24 edges, 0→multiple plans route `univ4-unlock`**, quoteUniV4 dispatched clean ("quotes completed"); tsc clean; planner 10/10 + fixtures 2/2 (no regression).
- **expected_transition:** (a) quoteUniV4 old=wrong-pool/throw → new=correct on-chain quote (0 bps) ✓; (b) candidate_plans through univ4: 0 → multiple ✓.
- **verdict:** `fixed` — **scope**: v4 quote is correct + one high-value v4 pool (USDC/USDT) now routes end-to-end. Broad v4 coverage (auto-index the singleton) = slice-2; a *profitable* v4-arb replay fixture (fork block with an actual v4 dislocation) = a stronger future gate, not required for slice-1 scope.

## Findings Ledger (governance 13)
| finding | owner | carry_to_round | status |
|---|---|---|---|
| v4 epic slice-1 full replay gate (replay-v4-arb + 13-file review) | Claude/Codex | this round | **done** — `fixed`, merged `1fccf71` (quote bit-exact/0bps + univ4 routing flip) |
| arb-profit.ts double-counts WETH→ETH unwrap (~2× overcount; `0xd60d80df` $42→real ~$20) | Claude | R2 (analysis, only when sizing needed) | open — merge WETH+native ETH as one asset |
| v4 slice-2: auto-index the v4 singleton (pin-only today; USDC/USDT is the only pinned pool) | v4 epic | R2/R3 | open |
| ~~atomic / state-triggered detection~~ | — | — | **KILLED** (user 2026-07-01: non-victim-backrun not doing) |
| Codex manual analysis must use PRIMARY sources (not Claude's curated facts) | both agents | next round | open (rule strengthened) |
| v4 pools auto-index into graph (now pin-only) | v4 epic | slice-2 | open |
| local v4 quote math (latency; V4Quoter eth_call is correctness-first) | v4 epic | slice-3 | open |

## Next Run
- **next_state:** finish v4 slice-1 full replay gate → `fixed` → merge; then v4 slice-2 (auto-index).
- **live_allowed:** no (dry-run only; go-live human gate).
