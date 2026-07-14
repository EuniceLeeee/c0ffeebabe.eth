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

## A/B canary gate — mechanical veto, never merge authority

`analysis/src/cli/ab-canary-compare.ts` pairs A/B by exact block and emits facts plus only
`supports | contradicts | inconclusive`. It never emits `win`. `ab-canary-gate` validates the report's
thin `ab_experiment` journal:
- exact tested commits; normalized config and universe fairness; same-block sample; no measured-window
  restarts; one pinned startup-discovery block; stable runtime pool-view and TokenEdge graph hashes
  (unless a graph delta was explicitly predeclared and replay-proven); B stopped; real script
  artifact/exit status;
- budget-censored, full-warm, and catch-up-range blocks are excluded before warmup/pairing because they do
  not share equivalent cache history; exact solved-ring identities remain part of semantic output matching;
- identical-code infrastructure shakedowns use the explicit equivalence goal; they never cherry-pick a
  noisy latency direction to manufacture a verdict;
- schema-v3 decision/close records bind a write-once standalone manual-verdict artifact by SHA-256 into the
  comparator output. The artifact seals the exact A/B log hashes and byte counts; the comparator must bind
  the same hashes plus seal nonce and start later than the artifact. Timestamps typed into prose or a seal for
  different log bytes cannot satisfy the gate;
- deterministic replay `pass` before any correctness/capability win;
- agent-manual evidence written independently; a distinct fresh reviewer for every capability win and
  every manual/script conflict or inconclusive result;
- branch lifecycle: decisive win/lose may clean only literal `ab/*`; unresolved/crashed work is retained only
  until a later validated `resolved_by_commit` is on `origin/main`. Resolved cleanup additionally requires
  a main-committed resolution claim that pins the old branch tip, an unchanged report-owned replay that fails
  on the old base and passes at the exact resolution SHA, and the final report on
  main with exact base/challenger/resolution SHAs before branch deletion. `ab-resolution-sweep -- --apply`
  is the mechanical claim→replay→archive→gate→delete connection.
- external comparator calibration: the pinned coffee corpus must still separate source shape from
  position-conserving winner style; `hermes-gate` reruns it and rejects an A/B close on classifier drift.

The agent's causal judgment owns `win|lose|needs_escalation`. A raw metric can contradict a valid semantic
fix (for example, filtering a high-scoring honeypot); in that case a fresh reviewer may confirm the win.
Hard safety/correctness/fairness failures can only veto or escalate. They cannot create a win.

### Production candidate gate (schema v3, pre-deploy)

Every new B deployment runs `ab-canary-gate --phase candidate` from the trusted champion checkout before
the second live searcher starts. It requires one `production_evidence` object proving:

- `analysis.tool_selection` records a successful generated catalog check, the capability query made only
  after independent manual analysis, successfully executed tool IDs, and a machine execution-manifest path
  + SHA-256. Every receipt binds the current descriptor fingerprint, redacted argv hash, output hashes/byte
  counts, timestamps, and real exit code; live-window tools must bind the exact measured range. Candidate
  evidence must cover single-transaction causality/PnL plus competitor-window classification/block-scan;
  decision evidence additionally covers A/B comparison. The gate validates successful receipt capability
  union from the current generated inventory, never a fixed executable name, fixture-only substitute, or
  self-reported command;

- a real on-chain transaction whose successful receipt, block, positive net PnL and canonical
  `winner_style=atomic_loop` are recomputed from the local archive node at deploy time. Block-scan requires
  `source_shape=atomic_state_arb`; dual backrun additionally verifies its declared earlier victim and exact
  pre/post counterfactual;
- a fresh non-author classification review confirming the sample is in scope;
- current strategy scope: position-conserving `dex-dex` or `dex-permissionless-protocol`, with either
  `block-scan`/`standing-state` or dual `backrun`/`victim-swap|oracle-update`;
- no keeper/reward, inventory, private path, credit, sandwich, or JIT-LP posture; victim dependency is valid
  only for the declared, replay-proven dual backrun;
- `searcher_behavior_change=true`, `deterministic_gate.result=pass`, and the trusted, unchanged
  trusted hunt harness invoked directly by Node (not through challenger npm configuration). The wrapper runs
  `blockscan-hunt.ts` from the untouched sample parent block and `backrun-hunt.ts` around the exact historical
  victim prefix,
  with the same frozen universe and the sample's on-chain DEX pool IDs. Harness/test/fixture changes in B
  are forbidden. The measured A/B hunt stages, not a challenger-authored success string, must show the same
  sample advances at least one
  mechanically observable production stage: `not_admitted → path_found → final_sim_success`. A backrun
  `final_sim_success` additionally requires the route transaction to land at the exact expected index in the
  historical victim block, without rewriting historical sender balances; oracle victims require an
  independent trusted quote delta on the declared route edge. A later
  quote-only or submit-only stage requires its own trusted harness to land on main before it may gate B.

The trusted deploy wrapper binds the report to the requested experiment, branch, tested base, frozen
challenger code SHA, input mode, and runtime-view declaration. Candidate config deltas are forbidden. The
branch tip may advance beyond the code SHA only through the named report; the wrapper deploys the code SHA,
not that report tip. It requires a deployable listener runtime diff (tests and
fixtures do not count and may not change) and rejects analysis, governance, dependency-script, or runner changes in the
challenger diff. Tool corrections are same-round auxiliary work: fix,
review, merge, and immediately rerun them before the B branch is cut. They never count as the B variable.
Historical schema-v1/v2 reports remain readable; only schema-v3 can pass the candidate phase.
