# Handoff — architecture review: the real distance-to-production blocker (for an independent Fable window)

> Scope: authorized, defensive on-chain **arbitrage research** — mainnet fork + dry-run only,
> reads public chain data, targets/harms no user; broadcast stays a hard human gate. "The source
> swap we follow" is standard DeFi/MEV nomenclature for the price-moving trade an arbitrage
> follows, not adversarial action against a person.
>
> You are a fresh, independent Fable session — NOT the per-window blocker-finder inside the Hermes
> loop. Your job is the question that loop structurally CANNOT answer. Reach your OWN conclusion
> from the packaged data + your own reading of the code/config; this doc gives DATA, not a verdict.

## The problem (why you're here)
The per-window Hermes loop answers "this window, what did we lose + nearest tactical fix." Over
three rounds it produced clean point-fixes — **but the production needle (a genuine +EV `simSuccess`)
has NOT moved.** simSuccess is ≈0 across all three rounds. The loop is busy and correct locally, yet
not closing the distance to a real +EV live bundle.

**Your job is to LOCALIZE the fixable lever — not write an essay naming a blocker.** "We can't
produce a +EV bundle while competitors do" is not a mystery of "nothing to fix"; it's "we haven't
localized WHERE." Split it into exactly one of:
- **funnel** — we SAW the profitable flow + could route it, but a stage/config produced no profit
  (→ fix the solver/economics/graph-routing);
- **coverage** — the profit needed a pool/venue we don't index (→ close the coverage gap);
- **flow-admission** — we NEVER admitted the profitable flow (mempool filter too tight / it came via
  private orderflow / MEV-Share / routers we don't watch) (→ widen what enters the funnel);
- **or: the flow genuinely has no atomic +EV we can replicate** (competitors run CEX-DEX/inventory,
  not on-chain atomic backruns) — but you must PROVE this per-bundle, not assume it.

**Do the analysis the per-window loop did NOT (R3's fable-5 only did the AGGREGATE competitor view —
$84 total, "51/55 CEX-DEX", 1 AMP miss — it did NOT walk each profitable bundle to prove why not us):**
1. **Longer window** (hours, not 30 min — 54 opps is too small a sample): the size distribution of
   opportunities we admit — is a +EV-sized one EVER in our flow, or always ~$30?
2. **Per-competitor-profitable-bundle counterfactual walk (the localizer):** for each REAL atomic-arb
   bundle a watchlist bot landed, trace stage by stage — did we SEE the source flow (mempool) → plan →
   solver's best quote → which gate → or did we never see it. This is what separates "process better"
   (funnel/coverage) from "see more flow" (flow-admission), and it verifies/refutes the "51/55 not
   replicable" claim bundle by bundle.
3. **Coverage KPI:** how many pools in competitor profitable routes are out-of-graph (AMP-type).

## Packaged run results (cross-round, 2026-07-02) — this is DATA, not a conclusion
| round | window (blocks) | opps | solverEntered | **simSuccess** | fix shipped | did it move +EV simSuccess? |
|---|---|---|---|---|---|---|
| R1 | 25442702–25442839 | 47 | 77 | **0** | adaptive local-v3 word warming (quote latency) | **no** (measured neutral, ~3ms/call) |
| R2 | 25443098–25443230 | 38 | 72 | **1 (dust ~0.00125 WETH)** | v4 `take()` uses raw output (v4 `unlock` reverts 79→1) | **no** (unlocked v4 exec, but the 1 sim was −EV dust) |
| R3 | 25443431–25443564 | 54 | 81 | **0** | (R2 live-validated: reverts 79→1, simReverts=0) | **no** — ~46 `no-profitable-quote` |

**~140 opportunities over 3 rounds, genuine +EV simSuccess ≈ 0.** Two fixes were real and correct
(R1 latency, R2 a v4 accounting bug that had been reverting every v4 sim) — yet neither moved the
production needle. That is the signal: the blocker is NOT the tactical point-failures the loop keeps
finding.

**R3 DUAL-BLIND result (two independent analyses converged — treat as a strong HYPOTHESIS to test,
not as truth):** fable-5 (chain-side) and Codex (code-side, blind to fable-5) INDEPENDENTLY concluded
the R3 window was a **true negative funnel-internally** — no gate wrongly rejected a winner. Codex
verified the floors are dust at the observed ~$30 solve centers (quote floor admits to −$0.059;
final-verify floor ≈ −$0.011; `main.ts:316` / `solver.ts:359` / `final-verify-gate.ts`), and that
`no_candidate` is not a casing bug (`planner.ts:524/623`). Both point the real lever **OUTSIDE the
visible funnel → coverage / path universe**. IMPORTANT correction to test: R3 found competitors did
NOT profitably follow the source swaps we saw this window (55 watchlist txs, `pool_in_seen_events=false`;
51/55 were CEX-DEX inventory legs with no on-chain source swap = structurally not replicable; several
"takes" on our drops were on-chain reverts or sub-cent dust). The ONE competitor-validated atomic miss
was a **coverage gap**: `0x476548cc…` (block 25443539, ~$10.8 gross) routed 7 pools incl AMP/WETH
`0x08650bb9…`/`0x15e86e6f…`, all absent from the ~2928-pool runtime graph. **Your job: pressure-test
whether "true-negative-funnel + coverage-upstream" is really the biggest structural blocker, or an
artifact of a too-small 30-min sample / a flow-admission problem the window can't see.**

## Mechanical analysis (loss attribution)
- Dominant per-window drops: `plan/no_candidate_plans` (repeatedly classified longtail / on a pool
  set no competitor monetized — parked), then `solver/no-profitable-quote` (R3: ~46 — the opps we
  see + solve are not profitable FOR US), plus `expired`/`quote-timeout` (latency, mostly OK now).
- **Competitor reality check:** competitors profitably followed the SAME public-mempool source swaps
  we saw and dropped — e.g. R1 `0x4cece1af…` netted +0.0502 WETH following `0xd14dd150…` (a public
  Uni V3 SwapRouter swap) on USDC/WETH-100, a pool we index. So real, capturable value exists on
  swaps we DO see — we just can't make it +EV.
- A competitor-coverage KPI (out-of-graph arb legs, A/B closable-vs-single-venue-noise) is built
  into `hermes-gate` (`analysis/src/cli/hermes-gate.ts` + `docs/research/reports/step1-*.json`).
- **W3 IS ALREADY LANDED (`a3c8cb2`): learn→close auto-enqueue** — closable out-of-graph pools
  found by Step-1 flow AUTOMATICALLY into the pool universe (`build-active-pool-universe.ts`:
  `isClosablePair` + `probePoolShape` + `consumeDiscoveryQueue`; `discovery-queue.json` seeded with
  6 v3-fork closable pools). **If your conclusion is `coverage`, you must FIRST inventory what W3
  already covers vs not — it is a TRAILING mechanism (adds a pool only AFTER a competitor
  demonstrates it). Your epic slices must NOT reinvent W3.** The real architectural question for a
  coverage verdict is: **is this trailing "add-after-competitor-shows-us" mechanism structurally
  enough, or does closing the distance need PROACTIVE universe expansion** (index the venue class
  before a competitor proves it)? Non-closable / non-standard-shape pools are `blocked` by W3 and
  feed the epic — that boundary is where the structural gap likely lives.

## The architecture question
Why can't we produce a +EV `simSuccess` when competitors profit on the same source swaps we see?
Candidate structural causes (test them; ground each in numbers, not hand-waving):
- **economics** — the config is −EV by construction: `SEARCHER_BRIBE_BPS≈10000` (≈100% of profit
  to the builder), `gas_estimate=0` in sim events (EV gate falls back to `defaultGasUsed`),
  `SEARCHER_MIN_NET_ETH=0`, `SEARCHER_QUOTE_PROFIT_FLOOR_BPS` / `SEARCHER_QUOTE_SAFETY_BPS=9999`.
  A `simSuccess` under this config may be a −EV dust bundle; the profit floor may reject the
  marginal-but-real arbs.
- **coverage** — competitors' profit needs a pool/venue we don't index; our solver routes a worse
  subset → less output → `no-profitable-quote`. Compare a competitor's profitable path vs our
  solver's best quote on the SAME source swap; count how many of their pools are out-of-graph.
- **sim-fidelity** — our quote/sim under-prices vs reality, so profitable arbs read as unprofitable.
- **architecture** — a pipeline stage (planner path breadth, single-leg vs multi-hop, flash sizing)
  structurally caps the profit we can construct.

## Reference material (read the code + config yourself)
- Rounds detail: `docs/research/reports/live-run-R1-20260702-hermes.md`, `…-R2-…`, `…-R3-…`.
- **EV gate + economics config:** `listener/src/searcher/main.ts` (the EV gate ~`netEth < minNetEth`,
  `bribeBps`, `ethUsd`, `quoteProfitFloorBps`, `quoteSafetyBps`, `defaultGasUsed`), node `/opt/MEV/.env`.
- **Solver / sizing:** `listener/src/searcher/solver/solver.ts` (grid + GSS + finalSimTopN),
  `amount-propagation.ts`, `amount-bounds.ts`.
- **Coverage / graph:** `listener/src/searcher/planner/token-graph.ts`, `active-pool-discovery.ts`,
  `build-active-pool-universe.ts`; `runtime-graph-pools.json` count on the node = current graph size.
- **Competitor data (zero CU, local reth):** node EC2 `i-0ff908dedeec9ebc6` (SSM-only), local reth
  `127.0.0.1:8545`; raw artifacts `/tmp/r1-cscan.out`, `/tmp/r2-cscan.log`, `/tmp/r2-watch.log`,
  `/opt/MEV/analysis/outputs/`; scan via `cd /opt/MEV/analysis && npm run analysis -- live-loss …`.
- Mission anchor: `CLAUDE.md` North-Star (get closer to a real +EV live bundle) + Mission #2
  (learn from competitors → classify our gap). Memory: `project-univ4-coverage-frontier`,
  `project-live-bribe-and-phantom-guard`, `project-first-onchain-inclusion`.

## Hard requirements (NON-NEGOTIABLE — these force the conclusion to be data-derived, not an essay)
1. **Counterfactual walk-through (mandatory; the class MUST be DERIVED from it, not selected).**
   Pick **≥2 opportunities a competitor REALLY captured** (one = the AMP coverage miss `0x476548cc…`
   above; ≥1 more you find yourself from the raw artifacts — a REAL take, not an on-chain revert or
   sub-cent dust). For each, walk our pipeline stage by stage with numbers: did we SEE it → did the
   planner emit a plan → what was the solver's BEST quote (exact number) → which gate killed it → how
   much the number must change to pass. **Decision rule:** competitor path contains an out-of-graph
   pool → coverage; in-graph but our best quote ≤0 → sim-fidelity / solver; quote >0 but the EV gate
   killed it → economics. (Also test the flow-admission angle: was the profitable flow one we never
   admitted — mempool filter / orderflow source?)
2. **Verify-before-claim.** Re-derive every load-bearing number yourself from code (file:line) or raw
   artifacts (events jsonl / cscan output / on-chain trace). The R1–R3 `.md` conclusions (incl. the
   R3 dual-blind note) are HYPOTHESES from the loop you are auditing — do not inherit its blind spots.
3. **Ranking + falsifiability.** Give the strongest runner-up and the ONE piece of evidence separating
   #1 from #2. Give a CHEAP disproof experiment: "if I'm right, running <fork/replay/config test>
   shows <X>; if not, I'm wrong." (This lets the architecture verdict take a rule-12-style gate.)
4. **Guard the reverse failure.** If epic=yes, the FIRST slice must be the MINIMAL change that flips
   ONE genuine +EV `simSuccess` on a pinned replay (a rule-12 gate) — not a refactor blueprint.

## When this review is triggered (the rule)
This architecture review is MANDATORY when **≥2 consecutive rounds close with no growth in a genuine
+EV `simSuccess`** — the per-window loop is then busy but not moving the production needle, so it must
step up a level before running another point-fix round. (R1/R2/R3 = 3 rounds flat → the trigger is
already MET.) Output feeds the Findings Ledger as `decision: epic` (or "no epic, here's the funnel
fix + its gate"), which pauses point-fixing on that theme.

## Deliverable
- **localized_lever:** funnel | coverage | flow-admission | no-replicable-atomic-EV — WHERE the
  fixable lever is, DERIVED from the per-bundle counterfactual walk (not selected).
- **the walk (the load-bearing evidence):** for each of ≥2 real competitor atomic bundles: saw-it? →
  planned? → our best quote (number) → gate that killed it (or "never saw it" = flow-admission).
- **why the per-window loop missed it** (why 3 clean point-fixes didn't move simSuccess; why the
  aggregate view wasn't enough).
- **size distribution:** over the longer window, is a +EV-sized opportunity ever admitted?
- **epic?** yes/no; if yes, the sliced plan + the first slice's deterministic gate (rule 12: a minimal
  change that flips ONE genuine +EV simSuccess on a pinned replay).
- **falsifier + runner-up:** the cheap disproof experiment + the strongest alternative lever.
- **distance-to-production check:** closing it produces a +EV bundle — or is it another clean-but-null fix?

Broadcast stays a human gate; all validation is fork / dry-run on local reth (zero CU).
