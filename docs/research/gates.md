# Validation Gates — the repo's test contract

> Scope: authorized defensive on-chain arbitrage research (fork/dry-run; broadcast is a human gate).
> This is where "how do we know a change is actually correct" lives — extracted from the Hermes
> protocol (was governance rule 12) so it reads as a **test contract**, not always-loaded prose.
> `docs/research/HERMES.md` rule 12 is a one-line pointer here. The endgame (distill-kit doctrine): correctness
> rules become **assertions in the harnesses below** and get DELETED from prose — see §Correctness
> properties.

## Rule 12 — repair-replay double-gate (anti-instrument-drift)

Every turn that claims to **improve extraction** ships a pinned replay fixture that flips, run BEFORE the
next dry-run:
- **correctness / coverage / path** → a deterministic replay asserts the behavior flip
  (`no_candidate → plans>0` / pool now routes / `sim.success`). No flip = not fixed, or the change was
  instrument-only.
- **latency** → replay the SAME fixture before/after, compare per-stage `seg` ms. Relative only
  (harness-bound), valid ONLY if the harness faithfully reproduces the latency source (cold state / real
  backend).

### `fixed` vs `implemented` (the definition of "fixed")
For a deterministic searcher change (path / pool / decoder / template / planner / adapter / graph):
- `implemented` = code written + build/tests pass.
- **`fixed` = the SAME failing sample, replayed locally, shows the expected bucket transition.**
  **"Build passes" is NEVER enough.**

Final Approval MUST record, or the verdict is `implemented_not_validated` (not `fixed`):
```
failing_sample: / baseline_failure: / fix_commit: / replay_command: / replay_result: /
expected_transition: / verdict: fixed | implemented_not_validated | deferred
```
Example `expected_transition`s: graph_gap → `pool_in_routing_graph false→true`; no_candidate_plans →
`candidate_plans>0` (ideally `solverEntered>0`); v4 decode → poolId→token pair emitted; pricing → old
wrong number gone + auditable artifact.

### Exempt from replay — gate on before/after METRICS instead
pure latency, builder inclusion, live mempool visibility, external-RPC/network instability, competitive
bid → gate on `prep_ms p50/p95` / `solverEntered` / `pendingReceived` / `cuProxyRpcCalls` / `not_seen`
rate before vs after. A turn with no flippable / speed-up fixture is `turn_class: observability-only`
and does NOT count as improving extraction. **Replay gates the FIX; live dry-run still gates
competitiveness** — never conflate ([[feedback-validate-live-not-backtest]]).

## The harnesses (use the EXISTING ones — don't build new)

| gate | command | what it asserts |
|---|---|---|
| correctness / coverage / path | `npm run searcher:planner` | plan count + `no_candidate` classification (pure, deterministic, no anvil). Pin real cases as named `REPLAY_FIXTURES`. |
| latency / full pipeline | `npm run searcher:replay-live-fixtures` | per-stage `stageMs` p50/p95 (incl. preSolver) + revm profit equivalence (1 wei). Record live first with `SEARCHER_RECORD_LIVE_FIXTURES=1`. |
| quote / math equivalence | `npm run searcher:finaloverlayequiv` / `:curvemath` / `:balanceslots` | local-quote vs on-chain quoter bit-exactness. |
| final verify / bundle safety | `npm run searcher:finalverifygate` / `:bundle-router-safety` | terminal balance-assert flash-repay guard; standing-position rejection. |
| reference arb (Foundry fork) | `forge test --match-test testReplayArbitrage --fork-url $MAINNET_RPC_URL --fork-block-number 24710787` | the wstUSR replay (see `test/WstUSRArb.t.sol`, `test/BotVM.t.sol`). |

## Correctness properties — MUST be test assertions, not prose (the #4 migration)

The reproduction-correctness checks (from the `mev-review` skill, 阶段3) are the properties that should
live as **assertions**, not as prompt rules. Their home is `test/WstUSRArb.t.sol` (+ a future
`test/replay/`) and the searcher harnesses above. Migration is phased (owner: correctness-test epic); a
property still marked *prose-only* is a tracked gap, not "done".

| correctness property | assertion home | status |
|---|---|---|
| trace diff = 0 (replay trace vs on-chain, per-call; every diff explained) | `test/WstUSRArb.t.sol` / `test/replay/` | ⏳ audit per-property; reference arb final-state covered, per-call trace-diff assertion is the gap |
| gas consistency (total + key sub-calls within tolerance) | `test/WstUSRArb.t.sol` | ⏳ prose-only until asserted |
| final-state consistency (touched accounts' balances/slots vs chain) | `test/WstUSRArb.t.sol` | ✅ reference arb asserts profit/final-state; extend to all touched slots |
| numeric precision (rounding direction matches contract logic) | `searcher:curvemath` / `:finaloverlayequiv` | ✅ local-quote bit-exact vs quoter (curve + v3); V4 pending |
| counterfactual (remove X → the diff disappears) | replay fixture per finding | ⏳ prose-only; encode as a paired before/after fixture |

**Rule:** when adding a new correctness/coverage rule, first ask *"can this be an assertion here?"* — if
yes, write the assertion and do NOT add the prose rule (distill-kit sunset doctrine). Only irreducibly
**judgment/process** doctrine (dual-blind, frame-audit, null-round, epic-escalation) stays as prose in
`docs/research/HERMES.md` — those have no single "correct" answer to assert.
