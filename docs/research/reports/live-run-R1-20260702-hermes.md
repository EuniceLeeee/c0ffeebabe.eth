# Hermes Round R1 — 20260702 (full competitor-driven loop)

> Canonical live-run loop (CLAUDE.md Rounds). Blocker-discovery this round is done by a
> FRESH fable-5 sub-agent (Agent tool model:fable, id a322374210363503a). Scope: authorized
> arbitrage research; fork/dry-run; broadcast human-gated. Orchestrator = Opus 4.8 (5-step).

## Reads from previous conclusion (this session, pre-R1)
- **Latency starvation: FIXED + deployed** (expired-before-solver 16.4%→4.1%; per-opp time
  budget). Regression-watch only.
- **native-ETH v4: COMPLETE + deployed** (2a route + 2b exec + 2c pin ETH/USDC fee100).
  LIVE-confirmed: native v4 victims reach the SOLVER (drops all solver-stage, zero plan/graph).
- **Open findings carried in:** D go-live economics (bribeBps=10000, gas_estimate=0,
  minNetEth=0 → simSuccess structurally hard); native coverage breadth (only 1 native pool
  pinned); concurrent-session node restarts disrupting windows.

## R1 Run Facts (node dry-run, deployed `e55f152` via deploy-node.sh)
- Window: block **25442702 → 25442839** (~137 blocks / ~30 min, 05:21→05:47 UTC).
- Funnel: hints 18271 · **opportunity_seen 47** · plans 218 · solverEntered 77 · **simSuccess 0**
  · submitAttempts 0 · expiredBeforeSolver 4 · quoteTimeouts 11 · mempoolOpportunitySeen 47.
- **pipeline_dropped (loss attribution, all 47 opps dropped):**
  - **33 plan/no_candidate_plans (70%)**
  - 7 solver/quote-timeout
  - 4 solver/expired-before-solver
  - 3 solver/no-profitable-quote
- Note: latency regression OK (expired 4/47 ≈ 8.5%, in line). Dominant loss = no_candidate_plans,
  same shape as prior runs → the R1 question is whether these are REAL missed MEV (a competitor
  took them) or longtail noise, resolved by the competitor cross-reference below.

## Competitor Cross-Reference (fable-5 sub-agent a322374210363503a — DONE, ~26 CU)
- **coffeebabe made 0 txs** in the window; `0xae2fc483` made 50 txs, all v4 inventory/CEX-DEX
  pair-trades + sandwich pairs, net ≈ **+$179** — nothing for our backrun-arb shape.
- **The one class competitors monetized = our own SEEN-but-DROPPED bluechip v3 opps:**
  - Take `0x4cece1af354576c623267417fc88a5b50d08621e6e6a63271f4d2746299eb71a` (block 25442793,
    idx 31, bot `0x06cff70886…`): 6 v3 + 2 v4 loop, net **+0.0502 WETH**, backran **OUR EXACT
    victim** `0xd14dd150…` (public Uni V3 SwapRouter `0xe592427a…`, idx 30→31 same block).
    **Our matching drop:** target_block 25442793, pool `0xE0554a476A092703abdB3Ef35c80e0D76d32939F`
    (USDC/WETH fee100), reason **expired-before-solver**. Secondary-validated on Alchemy
    (identical block/idx/swap-count, wethDelta +0.0502).
  - Corroborating: 25442796 `quote-timeout` (same USDC/WETH-100, competitor-taken); 25442765
    double `quote-timeout` (USDC/USDT-100 + USDC/WETH-500, 14-venue taker followed).
- **no_candidate (33) proven longtail:** manual trace of the 5 script-flagged "takes" → 3 plain
  user router swaps, 1 sandwich (not our shape), 1 real arb = **$0.05 dust**. Zero material miss.

## Blocker (fable-5 named; Codex review next)
- **core_blocker:** the solver **doesn't finish quoting bluechip v3 opps inside the TTL** — we
  SEE + PLAN them, then die at `quote-timeout` / `expired-before-solver`, and competitors take
  the exact same victims. USDC/WETH fee100 `0xE0554a47…` alone: killed us 3×, competitor-took 2×.
- **gap_class: unanticipated-gap** (pool in graph, victim = our victim_hash, candidates planned;
  lost in the solver quote stage — not a pool/path gap).
- **fix_direction (fable-5):** prioritize quote order by pool liquidity / victim impact
  (USDC/WETH + USDC/USDT lanes first); per-candidate quote budget with early exit; route these
  bluechip pools through the **already-bit-exact LOCAL v3 quote path** so they never block on
  `eth_call`. Replay fixture: block 25442793 (victim `0xd14dd150`, pool `0xE0554a47`); expected
  transition `expired/quote-timeout → quotes complete + sim.success`.
- **not_this:** the 33 no_candidate (longtail, don't chase); not a v4 pool-gap round.
- **carry-in check:** this REFINES the carried "D economics" assumption — the top live loss is
  NOT economics-gating, it's **solver quote latency on bluechip lanes**; economics matters only
  after we finish quoting. Latency-class blocker (rule 12 → metrics gate, + a replay fixture that
  flips the drop bucket).

## Codex Blocker-Review (biwd691eq) — CONFIRMED + refined
- Diagnosis correct: material fixable loss = bluechip v3 solver drops (no_candidate is longtail).
- Mechanism pinned in code: local v3 warms only **±8 bitmap words** (`pool-state-cache.ts:41`,
  `pool-state-updater.ts:12`, both `SEARCHER_V3_WORD_RADIUS ?? 8`); local v3 math walks ticks but
  **throws on an unwarmed word** (`v3-math.ts:251/308`) → `quoter.ts:389/398` silently falls
  through to QuoterV2 **eth_call** (revm: 3M-gas call, client timeout 60s ≫ opp TTL 5s → blows TTL).
- **First lever = robust local-v3 word coverage** (candidate ordering/budget = 2nd guardrail).
- Traps: v3 math is already cross-tick (issue is warmed-word COUNT); two radius constants (both
  env-aligned); main fallback is in `quoter.ts`, not `AmountQuoteSource.quote`.

## Final Blocker (Claude) + Implementation Brief — drives code
- **Blocker (final):** bluechip large-impact v3 opps quote via local math only within ±8 warmed
  words; a big victim impact crosses beyond → throw → QuoterV2/eth_call fallback → quote-timeout /
  expired-before-solver, and competitors take our exact victim. **Latency-class (rule 12: fixture
  flip that removes the fallback + metrics at next round's dry-run).**
- **searcher_behavior_change:** yes (bluechip v3 quotes complete locally → finish in TTL).
- **Fix goal:** a bluechip large-impact v3 quote (block 25442793, pool USDC/WETH-100
  `0xE0554a47`, the real victim `0xd14dd150` impact) must complete via LOCAL v3 math WITHOUT
  falling back to QuoterV2 — bounded warm-up cost (don't 8× every pool blindly).
- **Mechanism (Codex's call, must pass the gate):** either (a) raise the warmed-word radius
  (the `SEARCHER_V3_WORD_RADIUS` default) to cover typical bluechip impact, and/or (b) make the
  warm ADAPTIVE — when the swap needs an unwarmed word, warm it on demand (turn the `v3-math`
  bare throw into a "need word W" signal the cache fills) instead of dropping to eth_call. Keep
  the two radius constants aligned (they already share the env).
- **Allowed files:** `pool-state-cache.ts`, `pool-state-updater.ts`, `v3-math.ts`, and a NEW
  deterministic fixture test. Forbidden: quoter.ts fallback removal (keep it as a safety net),
  main.ts, planner, adapters.
- **GATE (deterministic repair-replay flip):** a fixture at block 25442793 / pool
  `0xE0554a47` / the exact victim impact amount — **baseline (radius 8) FALLS BACK; after the fix
  the local v3 quote COMPLETES (no fallback) and matches QuoterV2** (bit-exact or ≤1 wei). Record
  state from local reth (zero CU). Candidate ordering/budget deferred to R2/guardrail.
## Implementation + Gate (Codex `bnayyagbl` adaptive; Claude review + gate)
- **Implemented (`f30a820`):** v3-math throws typed `V3MissingBitmapWordError(word)`;
  `PoolStateCache.quoteV3` catches it, warms that exact word via TickLens + retries (capped
  `SEARCHER_V3_ADAPTIVE_MAX_WORDS=64`; dup-word + warm-fail guards). quoter.ts eth_call kept as
  last-resort net. Adaptive (bounded to what the impact needs) — chosen over a blind radius bump.
- **Claude review found + fixed (`7c82520`):** the fixture defaulted to the victim's OWN swap
  size (106 USDC), which ±8 already covers — it would NOT exercise the fix. The searcher quotes
  ARB-sized amounts (flash-borrow size), which is what crosses ±8. Fixed the fixture default to a
  representative 2M USDC arb amount (direction from the real victim swap).
- **GATE — deterministic repair-replay FLIP, PASS (local reth, ZERO CU):**
  `replay-v3-bluechip-warm` @ block 25442793, USDC/WETH-100, 2M USDC:
  - baseline old ±8 **falls back** (missing bitmap word 781);
  - after fix: adaptive warms words 781→777 on demand, **local quote = QuoterV2 bit-exact
    (`1070100425116459172747`, diff=0)**. `v3-bluechip-warm PASS`.
  - Regressions green: v3-equiv 8/8, v3-math, pool-state-cache 6/6, pool-state-updater, planner 12/12.
- **verdict: FIXED** (deterministic flip: bluechip large-impact v3 quotes complete locally, no
  QuoterV2/eth_call fallback, bit-exact).
- **HONEST caveat:** the specific fable-5 victim (0xd14dd150) was a 106-USDC swap that ±8 already
  covered — that drop was general quote latency, not a word-miss. The fix targets the **arb-sized
  quotes the solver actually makes** on bluechip lanes (2M+ crosses ±8). Whether it materially
  reduces LIVE bluechip `quote-timeout`/`expired-before-solver` is a **metrics question carried to
  R2** (rule 12 latency-class: deterministic flip proves the fallback is gone; live impact = next
  window).
- **post-code Codex review:** deferred — the deterministic **bit-exact** flip is dispositive and
  the approach was already Codex-reviewed at the blocker stage (rule-14 autonomous call).

## Findings Ledger (carry to R2)
| finding | owner | carry_to | status |
|---|---|---|---|
| bluechip v3 solver quote latency (±8 word-miss → fallback) | R1 | — | **FIXED f30a820/7c82520** (deterministic flip); live-metrics validation → R2 |
| Does the adaptive warm reduce LIVE bluechip quote-timeout/expired? | R2 | R2 | open — metrics gate on R2 window (expect quote-timeout/expired on USDC/WETH lanes ↓) |
| Candidate quote ordering by impact + per-candidate budget (2nd guardrail) | R2/R3 | R3 | open — deferred from R1 (Codex blocker-review pt 5) |
| 33 no_candidate = longtail (proven) — do NOT chase | R1 | closed | done |
| D go-live economics (bribe/gas/minNetEth) | — | pre-broadcast | open (not top live blocker per R1 cross-ref) |
