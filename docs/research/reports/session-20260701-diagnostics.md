# Session 2026-07-01 — Hermes loop run (4 turns) + diagnostics

Redacted session record for external review. Raw logs, `.env`, RPC keys, and PII
(account id / email) are intentionally NOT committed (per CLAUDE.md). On-chain
evidence (tx hashes, pools, tokens) is preserved.

## What this session did

A CLI-orchestrated **Hermes** loop (Claude = orchestrator/evaluator, Codex =
generator) ran 4 turns against a self-hosted reth node (EC2 `mev-node`, local RPC,
zero Alchemy CU) over one live dry-run window: **blocks 25434876–25434966** (~90
blocks / ~18 min), 27 opportunities, 21 competitor MEV txs from a 2-bot watchlist.

Per-turn records (each is a standalone Hermes file):
- `docs/research/reports/live-run-20260701-032600-hermes.md` — turn 1: `analysis
  live-loss --competitor-scan` (victim real-block competitor cross-reference).
- `docs/research/reports/live-run-20260701-t2-hermes.md` — turn 2: authoritative
  `not_seen` split (searcher dumps its 2512-pool runtime graph; analysis classifies
  `graph_gap` vs `detection_gap`).
- `docs/research/reports/live-run-20260701-t3-hermes.md` — turn 3: verified the
  dominant `graph_gap` frontier is **Uniswap v4** (9/21 = 43% of watchlist MEV route
  the v4 singleton PoolManager `0x0000…08A90`; secondary-validated local reth ==
  Alchemy).
- `docs/research/reports/live-run-20260701-t4-hermes.md` — turn 4: prize-sizing
  attempt; balance-diff heuristic confounded (router intermediaries + v4 flash
  accounting) → clean v4 $ needs real v4 decode.

Governance + protocol: `CLAUDE.md` → "Hermes — Live-Run Collaboration Protocol"
(hard rules 1–12, incl. Step-1 competitor cross-reference watchlist, Codex fallback,
repair-replay double-gate). Template: `docs/research/templates/hermes-live-run.md`.

## Key verified findings

1. **Competitor cross-reference works and is now Step 1.** `analysis live-loss --watch
   <2 bots> --graph-pools <dump>` over the window: 21 competitor txs, `seenScope`
   15 not_seen / 3 block_only / 2 same_token / 1 same_pool. Secondary-validated vs
   Alchemy (distinct-pool counts matched 6/6, 3/3, 6/6).
2. **The bottleneck is coverage, not longtail.** Authoritative not_seen split (turn 2):
   **graph_gap = 13, detection_gap = 5** of 18. The impacted tokens are bluechip
   (WETH/USDT/USDC/DAI/wstETH/FRAX), not longtail.
3. **Uniswap v4 is the dominant coverage frontier** (43%), and our pair/factory graph
   model structurally can't see the v4 singleton. Scoped as a human-gated epic.
4. **Profit is unmeasured for v4** — the analyzer can't decode v4 flash-accounting;
   heuristics are confounded. One decodable arb was ~$310.

## Codex reliability — root cause (diagnosed this session)

The loop's generator (`codex exec`, gpt-5.5 xhigh) repeatedly **stalled**: exit 0,
zero file changes, no session rollout. Ruled out: config saver mode (none), desktop
app contention (closed — still stalled), stdin path (inline stalled too), prompt
complexity ("print HELLO" stalled), auth expiry (re-login — still stalled).

**Actual cause:** codex reaches OpenAI through the machine's local **GFW proxy
`127.0.0.1:1082`**. Basic connectivity is fine (bare GET to chatgpt.com = 403 in ~2s,
stable), but the **long streaming inference call (xhigh ≈ 17k tokens even for
"HELLO")** drops intermittently → codex silently exits 0 with no output, or hangs.
It is intermittent (within minutes: works / stalls / hangs). A working run printed
`HELLO` + used 17,512 tokens normally.

**Mitigation (landed in CLAUDE.md rule 11):** run codex at
`-c model_reasoning_effort=medium` (shorter stream — medium "HELLO" = 8,102 tokens,
landed reliably); judge success by a new rollout in `~/.codex/archived_sessions/`, not
exit code; retry (independent coin-flip); only a repeatedly-failing minimal probe
means a real outage. More robust long-term: run codex from the EC2 box (clean US
egress, no GFW proxy).

## Post-4-turn issues — solved / partial / open

Process:
- 🟡 Codex single-point-of-failure — rule 11 written + root-caused + mitigation
  (medium effort); default-medium not yet wired into the loop script.
- 🟡 Instrument-drift guard — rule 12 written (no flippable fixture ⇒
  `observability-only`); relies on the replay harness (which exists, below).
- 🟡 Diff-scope reconciliation — memory + practiced (caught 2 over-scopes), not yet a
  numbered governance rule.
- ✅/🟡 Signal-authority-before-concluding — general rule 3; the specific landmine
  `poolInOurGraph` fixed in turn 2 (`pool_in_seen_events` vs authoritative
  `pool_in_routing_graph`).
- ✅ Deterministic repair-replay gate — rule 12 + real fixtures wired into the existing
  `test/planner.ts` (`REPLAY_FIXTURES`, verified 2/2) and latency via
  `test/replay-live-fixtures.ts`.
- ❌ Sample-size discipline + `cu_spent` — not enforced (all 4 turns = one 90-block
  window).

Architecture:
- ❌ Uniswap v4 support — scoped epic only, not built.
- 🟡 Consolidate competitor path + kill block+1 bug — `--competitor-scan` (real-block)
  landed + verified; old `analyzeBlock`/`--coverage` still block+1-buggy (deferred).
- 🟡 Pinnable/versioned runtime graph — turn 2 dumps `runtime-graph-pools.json`
  (builtAt/count); still non-deterministically rebuilt each run (2422 vs 2512), no
  pin-for-replay.
- ❌ Realized-profit / settlement decoding — diagnosed as required (esp. v4), not built.
- 🟡 detection-set vs routing-graph made first-class — explicit in analysis (`gap_type`),
  still implicit in the searcher (`allPoolMap` vs routing graph).

## What actually landed as code this session (verified)

- `analysis live-loss --competitor-scan` (+ `--not-seen-scan`) — victim real-block
  competitor cross-reference (reproduced 3 on-chain competitor takes).
- Searcher startup dump of the runtime graph pool set (fail-open).
- `analysis` authoritative `pool_in_routing_graph` + `gap_type` classification.
- `test/planner.ts` `REPLAY_FIXTURES` — real-case regression guards (2/2 pass).
- `CLAUDE.md` governance rules 11 (Codex fallback) + 12 (repair-replay double-gate).

Deferred/known-buggy is tracked inline in each turn file and in the repo memory notes.
