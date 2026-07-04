# Credit-venue edge — landing plan (slice-by-slice)

> Scope: authorized, defensive on-chain arbitrage research. Implementation spec (the ADRs are
> `unified-strategy-edge-architecture-20260704.md` + `credit-venue-edge-20260704.md`). Synthesis of TWO
> independent fresh-fable landing plans (Plan A + Plan B, both majority-fable) that CONVERGED ~95% on the
> same 8-slice structure + v1 cut + safety wiring + repo anchors — a high-confidence signal. Each slice is
> a Codex-executable unit with its own rule-12 gate.

## Confidence: two independent plans converged
Plan A and Plan B (fresh, blind to each other) landed on the SAME 8 slices, the SAME v1 cut (1–3 +
optional 4), the SAME safety invariants, and the SAME file:line anchors. Divergence was cosmetic only
(edge type file location: `venues/edge.ts` vs `model/edge.ts` — pick `venues/edge.ts`, next to the
existing `capability.ts`). The convergence is the reason to trust this plan.

## The 5 cross-cutting safety invariants (every credit slice must honor)
1. **`leavesStandingPosition` lives on the EDGE** (`VenueEdge`), never on a strategy label — a credit edge
   cannot launder as principal-safe. Strategy axis renamed `strategy_kind: reactive | block-scan` (never
   overload "atomic", which means the execution/principal-safety invariant here).
2. **Credit is STRATEGY-AGNOSTIC** — a shared PATH capability both drivers route. `ENABLE_CREDIT_EDGES_FOR_
   {BACKRUN,ATOMIC,ANALYSIS}` are independent flags because the edge is shared, not owned. "analysis first"
   is a production-ENABLE ORDER, not a strategy binding.
3. **Bounded-live does NOT cover credit.** `assert-balance` (`plan-builder.ts:113`) bounds only the FLASH
   token, not the standing position → `deploy-node.sh` + submit must REJECT any plan with a
   `leavesStandingPosition:true` edge unless a SEPARATE credit-live marker (e.g. `/opt/MEV/.credit-live`,
   independent of `.deploy-live` + the wallet cap) is set. v1 keeps credit prod-OFF, so this is an
   installed guard + a rejected-path test, never exercised live.
4. **Credit quote is 2-D, not 1-D.** Fluid has no `quote(amountIn)` today (`quoter.ts:358` throws; a solver
   SEARCH over `fluidDebtBps`). Keep the borrow-size/LTV variable EXPLICIT; the typing layer must NOT
   flatten credit into the swap 1-D quote. Slice 5 replaces the SEARCH with a deterministic max-safe-borrow
   (linear under abandonment), not a swap quote.
5. **Per-adapter GAS TABLE is mandatory** — credit leg 250–400k vs ~100k swap; at `gas_estimate=0` credit
   over-ranks in the dust regime without it.

## Slices (converged)
| # | slice | class | prod flag | human gate | rule-12 gate |
|---|---|---|---|---|---|
| 1 | Unified TYPES (`VenueEdge`/`EdgeSequence`/`LearningCase`, `strategy_kind`, `leavesStandingPosition`) — widen `TokenEdge`, don't replace | pure | n/a | — | compile + `searcher:planner` unchanged; ships WITH slice 2 (not a bare observability turn) |
| 2 | Analysis `EdgeSequence`+`LearningCase` by EXTENDING `bundle-postmortem`/`live-loss`/`hermes-gate`/census (map `winner_style`→`primaryGap`, incl. `non_comparable_winner`) — one learning system, not parallel | pure/off-hot | n/a | — | replay on existing postmortem fixtures: `0xa32b…`→`venue_missing`, `0xee7b98ad…`→`non_comparable_winner` |
| 3 | CreditEdge recognized in ANALYSIS/replay: `0xf88b…`→`FluidCredit(wstUSR→USDC)`, prod flag OFF — the cheap decisive anchor | pure/off-hot | OFF | — | **planner `REPLAY_FIXTURES` flip: credit present ⇒ `candidate_plans 0→≥1`, absent ⇒ 0** (pure, no anvil, like the CFG fixture); optional AC-3 token-delta ≈ 273 wstUSR |
| 4 | `VenueEdge` typing/dispatch layer over current adapters (keeps every fast path; credit branch keeps the 2-D var) | refactor/latency | n/a | — | DOUBLE: `searcher:planner` plans unchanged + `searcher:replay-live-fixtures` p50/p95 not regressed. **OPTIONAL in v1** — if latency regresses, confine to analysis/AtomicView |
| 5 | Fluid credit adapter: resolver `quote()` (`VaultResolver.getVaultEntireData`, zero-CU) → deterministic max-borrow + haircut ε (DELETES `fluidDebtBps` search) + abandon-by-capability-absence (no close action) + isolated `nftId`/leg + **gas table** + **credit-live reject guard** | new runtime | OFF | credit-live marker | replay `0xf88b` `candidate_plans 0→1` + deterministic quote sim == ~273 wstUSR + guard rejects an abandonExit plan w/o marker |
| 6 | Backrun+credit routing: `views.ts` `projectView` materialized sets; `ENABLE_CREDIT_EDGES_FOR_BACKRUN=0` drops credit at VIEW-PROJECTION time (pinned edges won't self-prune, `token-graph.ts:474`); depeg-gated insertion | hot-path-adjacent | OFF | — | `searcher:planner` flip: flag=1 ⇒ backrun routes credit (proves strategy-agnostic); flag=0 ⇒ absent from projected view (proves projection-drop not scoring) |
| 7 | Atomic/block-scan lane + `AtomicView` + `SubmissionCoordinator` — isolation infra (separate fork/sim + separate EOA/nonce + separate process + RPC fairness) | new infra | OFF | **2nd funded EOA (Safety-1)** | deterministic: block-scan driver emits atomic+credit plan + coordinator backrun-first; latency: backrun `stageMs` flat under atomic load (metrics-gated) |
| 8 | Aave/Euler + e-mode behind the resolver-quote adapter; shared-target `marketId` discriminator (Aave = one Pool many reserves, like v4 singleton); e-mode account-global on Aave | new runtime | OFF | credit-live marker | per-protocol replay flip `candidate_plans 0→≥1` + shared-target dedup asserted |

**Dependency DAG:** `1 → {2, 3, 4-optional}`; `3 → 5 → 6 → 7`; `{5,6} → 8`.

## v1 cut (ship these; NOTHING new in production)
**Slices 1 + 2 + 3 (+ 4 optional, latency-gated).** = one unified model + one learning loop (analysis) +
`0xf88b` recognized as a FluidCredit edge in replay, production flags OFF. All off-hot-path or pure
refactor, all replay-gateable. Captures the operator goal (one model, one learning loop; kill the 3×
planner/analyzer drift) at ~1/3 the surface.

## Recommended FIRST Codex slice (orchestrator judgment)
**Slices 1+2 together = the operator's own "最稳的第一刀"**: unified types + the analysis-side
`EdgeSequence`/`LearningCase` extension, pure/off-hot-path, gated by the EXISTING postmortem fixtures
(`0xa32b…`, `0xee7b98ad…`, coffee, `0xf88b` all fall to one schema). It changes NO searcher behavior and
delivers the "one learning language" immediately. **Slice 3** (the `0xf88b` credit `candidate_plans 0→≥1`
planner flip) is the second PR — the decisive credit-correctness anchor for near-zero cost. Slices 5–8 each
carry their own replay gate and, where they touch live capital/posture, a distinct human authorization
(credit-live marker; second funded EOA) autonomous work may never self-grant.

## Repo anchors (both plans agree)
`token-graph.ts` (`TokenEdge` :15, `POOL_REGISTRY` fluid-vault :104-113, pinned score-exempt :474, top-N
:486, `sameDirectedEdge` :524), `planner/planner.ts` (edge-kind-agnostic DFS, `buildBorrowabilityRotations`),
`solver/solver.ts:396` (`fluidDebtBpsCandidates` = the 2-D search to delete), `solver/quoter.ts:358`
(`quoteFluidVault` throws today), `solver/amount-propagation.ts:123` (`quoteFluidDebtBySearchBps`),
`solver/plan-builder.ts:163-177` (`nftId:0` open, NO close) + `:113` (assert-balance = flash-only bound),
`main.ts` (single graph :603, wallet/nonce :347, fork/sim :379/:457, EV/submit ~:1780, config flags
:357-415), `venues/capability.ts` (typing-layer seed), `execution/bundle-router.ts` (`BundleSubmission`,
submit surface), `analysis/src/cli/bundle-postmortem.ts` (`winner_style`/`route_gap_decisive`/`in_graph`/
`non_comparable_winner` = LearningCase kernel), `hermes-gate.ts:133` (`intake_audit`),
`actions/canonicalize.ts` (`strategyType`/`revenueSource`), `scripts/deploy-node.sh:33-114` (bounded-live
guard to mirror), `src/FlashArb.sol:184` + `src/BotVM.sol` (execution; no Fluid contract change needed).
Rule-12 harnesses (reuse, don't build new): `test/planner.ts` (`REPLAY_FIXTURES`, `searcher:planner`),
`test/replay-live-fixtures.ts` (`searcher:replay-live-fixtures`), `test/ac3.ts` (`searcher:ac3`, wstUSR replay).
