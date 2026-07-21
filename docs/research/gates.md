# Validation Gates — the repo's test contract

> Scope: authorized defensive on-chain arbitrage research (fork/dry-run; broadcast is a human gate).
> This is where "how do we know a change is actually correct" lives — extracted from the Hermes
> protocol (was governance rule 12) so it reads as a **test contract**, not always-loaded prose.
> `docs/research/HERMES.md` rule 12 is a one-line pointer here. The endgame (distill-kit doctrine): correctness
> rules become **assertions in the harnesses below** and get DELETED from prose — see §Correctness
> properties.

## Rule 12 — repair-replay double-gate (anti-instrument-drift)

Every transaction-bound deterministic turn that claims to improve a specific route ships a pinned replay
fixture that flips, run BEFORE the next dry-run:
- **single-route correctness / coverage / path** → a deterministic replay asserts the behavior flip
  (`no_candidate → plans>0` / pool now routes / `sim.success`). No flip = not fixed, or the change was
  instrument-only.
- **latency** → replay the SAME fixture before/after, compare per-stage `seg` ms. Relative only
  (harness-bound), valid ONLY if the harness faithfully reproduces the latency source (cold state / real
  backend).

A systemic protocol scanner, graph/universe, distribution, or performance change is not proven by one
transaction. It predeclares a representative positive/negative cohort plus coverage/output equivalence,
same-block fairness, CPU/pass-latency, budget-censoring, candidate-composition, and final-sim false-positive
criteria as applicable. Its decisive check is that cohort contract plus Hermes A/B; the optional six-step
route diagnostic is not a deployment, decision, close, or merge switch.

### `fixed` vs `implemented` (the definition of "fixed")
For a transaction-bound deterministic searcher change (path / pool / decoder / template / planner / adapter / graph):
- `implemented` = code written + build/tests pass.
- **`fixed` = the SAME failing sample, replayed locally, shows the expected bucket transition.**
  **"Build passes" is NEVER enough.**

Final Approval MUST record, or the verdict is `implemented_not_validated` (not `fixed`):
```
failing_sample: / baseline_failure: / fix_commit: / replay_command: / replay_result: /
expected_transition: / verdict: fixed | implemented_not_validated | deferred
```
Systemic changes instead record the predeclared cohort identity, positive/negative controls, before/after
coverage/output/resource results, same-block fairness evidence, and reviewer verdict; they do not fabricate
the fields above for an unrelated transaction.
Example `expected_transition`s: graph_gap → `pool_in_routing_graph false→true`; no_candidate_plans →
`candidate_plans>0` (ideally `solverEntered>0`); v4 decode → poolId→token pair emitted; pricing → old
wrong number gone + auditable artifact.

### Backrun causal replay (thin three-state contract)

A backrun fixture is `fixed` only when the trusted harness freezes the same winner/trigger/config/graph and
records all three states:

- `boundary`: untouched parent-block state, with no same-block prefix;
- `trigger_only`: only the selected raw swap/oracle trigger, without nonce/balance rewriting, then the real
  detector → planner → solver → final-sim path; no pre-seeded impact or route;
- `full_prefix`: every real transaction before the winner, followed by the same declared route check.

The gate does not discover or bisect victims. It only requires the candidate stage to advance, the trusted
pipeline replay to pass, and `trigger_only`/`full_prefix` to match on route signature, final-sim result, and
EV-sign bucket. `diverge` or `unverified` means `implemented_not_validated` with
`manual_followup_required`; Hermes must select another trigger or record a multi-transaction dependency and
rerun. A positive `boundary` disqualifies the sample as a causal backrun and sends it to block-scan analysis.
If the change is before the detector (websocket/router/filter intake), `backrun-hunt` alone is insufficient;
a trusted intake-specific harness must also flip. A dust replay may validly end after final sim at
`below_ev_gate`; it need not submit.

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
| execution-family Adapter Replay (independent; never deploy-blocking) | `npm run searcher:adapter-family-replay -- --fixture <fixture>` | trace-bound route is emitted by one registered `ExecutionFamilyId`; production planner/solver/quote/encode/fork sim/repayment/conservation/EV all pass without fixture amounts or calldata. Emits `adapter_replay_pass`, not `adapter_fixed`. |
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
- the predeclared hypothesis-specific deterministic/cohort check passes before any correctness/capability
  win; only route-stage/equivalence claims require the pinned single-route replay;
- agent-manual evidence written independently; a distinct fresh reviewer for every capability win and
  every manual/script conflict or inconclusive result;
- branch lifecycle: decisive win/lose may clean only literal `ab/*`. A retained route-stage/equivalence
  report can later use a main-committed resolution claim, its unchanged report-owned replay, and
  `ab-resolution-sweep -- --apply`. A retained systemic report instead requires a fresh normal A/B retest of
  its original cohort contract; it cannot be deleted through a fabricated route replay.
- external comparator calibration: the pinned coffee corpus must still separate source shape from
  position-conserving winner style; `hermes-gate` reruns it and rejects an A/B close on classifier drift.

The agent's causal judgment owns `win|lose|needs_escalation`. A raw metric can contradict a valid semantic
fix (for example, filtering a high-scoring honeypot); in that case a fresh reviewer may confirm the win.
Hard safety/correctness/fairness failures can only veto or escalate. They cannot create a win.

### Optional production six-step acceptance (schema v3, independent of deployment)

`deploy-ab-challenger.sh deploy` does **not** invoke or wait for historical replay. It runs only the fast
`--phase binding` check (report/experiment/branch/base/challenger/input/config/lane identity) plus the hard
bounded-live safety/fairness preflight, then starts B. If the predeclared hypothesis is a route-stage or
equivalence claim, pause B after the paired live window and optionally run
`deploy-ab-challenger.sh acceptance <id>`. This invokes the legacy-named `ab-canary-gate --phase acceptance`
checker from trusted tooling against the frozen A/B commits and immutable universes. The status
`not_run|running|pass|fail|not_applicable` is diagnostic evidence for that claim only; it is never a deploy, decision, close, or
promotion switch. Scanner, universe, distribution, and performance changes use their own predeclared A/B
criteria.
The check may use the latest report/JSON-only descendant of the frozen B SHA and the then-current trusted
`origin/main` checker (which must descend from A and retain dependency compatibility). Therefore correcting
an acceptance report or external checker never requires a new B deployment or another warmup. A
runtime-coupled hunt-harness change still needs an explicitly compatible harness.

When invoked, the six-step check requires a fully populated `production_evidence` object proving:

- `analysis.tool_selection` records a successful generated catalog check, the capability query made only
  after independent manual analysis, successfully executed tool IDs, and a machine execution-manifest path
  + SHA-256. Every receipt binds the current descriptor fingerprint, redacted argv hash, output hashes/byte
  counts, timestamps, and real exit code; live-window tools must bind the exact measured range. Acceptance
  evidence must cover single-transaction causality/PnL plus competitor-window classification/block-scan.
  Decision/close independently require the common competitor-window/classification/block-scan and A/B
  comparison capabilities plus whatever the hypothesis predeclared; they do not inherit the optional
  acceptance check's single-transaction/causality/PnL requirements. The checker validates successful receipt capability
  union from the current generated inventory, never a fixed executable name, fixture-only substitute, or
  self-reported command;

- a real on-chain transaction whose successful receipt, block, positive net PnL and canonical
  `winner_style=atomic_loop` are recomputed from the champion's configured private archive endpoint during
  acceptance. This endpoint is evidence-only; both live A/B runtimes remain pinned to the same local reth.
  Block-scan requires
  `source_shape=atomic_state_arb`; dual backrun additionally verifies its declared earlier victim and exact
  pre/post counterfactual;
- a fresh non-author classification review confirming the sample is in scope;
- current strategy scope: position-conserving `dex-dex` or `dex-permissionless-protocol`, with either
  `block-scan`/`standing-state` or dual `backrun`/`victim-swap|oracle-update`;
- every new production Hermes candidate declares `lane_mode=dual`: A/B observe atomic block-scan and
  public-mempool backrun concurrently (MEV-Share off). The single B behavior change and replay sample may
  belong to either lane; the other lane is a no-regression/safety observation, not a second required win;
- no keeper/reward, inventory, private path, credit, sandwich, or JIT-LP posture; victim dependency is valid
  only for the declared, replay-proven dual backrun;
- `searcher_behavior_change=true`, `deterministic_gate.result=pass`, and the trusted, unchanged
  trusted hunt harness invoked directly by Node (not through challenger npm configuration). The wrapper runs
  `blockscan-hunt.ts` from the untouched sample parent block and `backrun-hunt.ts` across the exact
  boundary/trigger-only/full-prefix states,
  with the same frozen universe and the sample's on-chain DEX pool IDs. Harness/test/fixture changes in B
  are forbidden. The measured A/B hunt stages, not a challenger-authored success string, must show the same
  sample advances at least one
  mechanically observable production stage: `not_admitted → path_found → final_sim_success`. A backrun
  `final_sim_success` additionally requires trigger-only and full-prefix route/sim/EV buckets to match, the
  full-prefix route transaction to land at the winner index, and no historical sender balance/nonce rewrite;
  oracle victims require an
  independent trusted quote delta on the declared route edge. A later quote-only or submit-only stage
  requires its own trusted harness before it may satisfy acceptance.

For block-scan, acceptance records the six physical stages separately: (1) graph/admission, (2) route
enumeration, (3) exact quote/refine, (4) planner+solver, (5) resolved-plan fork re-sim with calldata/profit/gas,
and (6) production EV allow/reject. The final comparison binds those facts across baseline and challenger.
Backrun uses the same six-slot evidence shape as (1) raw trigger/state anchor, (2) route enumeration,
(3) pre/post counterfactual quote, (4) resolved-plan fork sim, (5) production EV, and (6) trigger-only versus
full-prefix replay equivalence.
For a stage-advance change the challenger must emit the ordered diagnostics through its declared stage and the baseline must fail at its
declared stage; for an equivalence refactor both sides must emit one ordered `pass` result for steps 1..6.
The canonical human evidence contract remains `.claude/commands/tx-gap.md`.

Inside the optional checker, `require_stage_advance` is a narrow, fail-closed switch for equivalence
refactors. It defaults to `true` when absent. An explicitly reviewed report may set it to `false`; this
disables only the `challenger_stage > baseline_stage` assertion in that check. It is read only when
`acceptance <id>` runs and cannot block deployment. Wallet, port, runtime, lane and posture protections are
independent hard boundaries.

Only this explicit `require_stage_advance=false` equivalence replay receives the closed-loop search budget:
the already-frozen A/B universe is reused, at most 20,000 pools are loaded, 512 coarse candidates may be
exact-refined, the final admitted set may extend through rank 300, and scan/pass budgets are 600/1,200 seconds.
The expected route is still matched by its complete ordered identity and appended to the eight-route solve
set, so this widens discovery without injecting a path or bypassing simulation/EV. Shared-input runs first
require byte-identical universe snapshots, and the report must declare the 3,600-second per-side timeout.
Standalone historical repair, ordinary stage-advance acceptance, and live searcher defaults keep their
production-shaped limits. These widened values are acceptance-only and never change live searcher defaults.

The trusted deploy wrapper's fast binding checks the report against the requested experiment, branch, tested base, frozen
challenger code SHA, input mode, runtime-view declaration, and cheap static bounded-live scope/posture fields.
It performs no archive lookup, tool discovery, historical classification or replay. Candidate config deltas are forbidden. The
branch tip may advance beyond the code SHA only through the named report; the wrapper deploys the code SHA,
not that report tip. It requires a deployable listener runtime diff (tests and
fixtures do not count and may not change) and rejects analysis, governance, dependency-script, or runner changes in the
challenger diff. Tool corrections are same-round auxiliary work: fix, review, merge to trusted main, and
rerun the optional acceptance when relevant; they may land after the B window without changing or redeploying B, and never
count as the B variable.
Historical schema-v1/v2 reports remain readable; only schema-v3 can pass new deployment binding or invoke
the optional six-step checker.

## Historical transaction repair gate

`docs/research/HISTORICAL-GAP.md` is the non-live entry to this same validation contract. Its mechanical
`historical-gap-gate` enforces three mutually exclusive tracks:

- analysis tools/classifiers/gates: build, regression tests and fresh review, then direct-to-main without B;
- deterministic single-route searcher behavior (adapter/identity/graph/detector/planner/quote/execution)
  uses the schema-v3 six-step check, unchanged trusted replay, and >=10 minute process-liveness smoke;
- systemic scanner/graph/universe work uses its predeclared cohort/coverage/equivalence contract and proceeds
  to the paired Hermes A/B window instead of the historical smoke/replay path;
- flow admission, latency and candidate ranking: historical evidence may classify the gap, but promotion is
  rejected and the branch routes to Hermes A/B.

The direct-main gate surface includes only `analysis/src` implementation files, same-named analysis tests,
script-only changes to `analysis/package.json`, archived report artifacts, and the exact trusted
`blockscan-hunt.ts` / `backrun-hunt.ts` replay harnesses. Fixtures, dependencies/lockfiles, lifecycle scripts,
governance documents, hooks, deploy/guard scripts and arbitrary listener tests remain ineligible.

The only accepted samples are position-conserving `DEX↔DEX` or `DEX↔permissionless protocol` closed loops,
from either scanner standing state or a real swap/oracle backrun trigger. Every sample binds one complete
ordered route (`adapterId`, `slotKind`, `target`, `tokenIn`, `tokenOut`, optional `poolId`) to canonical
on-chain swap order/direction, factory-backed V2/V3 venue identity, and one successful state-changing call
trace that matches every DEX and protocol adapter target/selector in the declared interleaved order. Protocol
token flow and the exact trusted replay route are checked separately. A protocol target equal to
the winner's private caller/executor is rejected; pool-set membership alone is insufficient. Build/test
without sample replay is
always `implemented_not_validated`. Before a new searcher branch is accepted, the gate binds an inventory of
main, all local heads/tags/stash/custom refs, all refs from every configured remote, worktrees, durable
reports/resolutions and local uncommitted evidence so a
prior unmerged fix is inspected rather than duplicated. Every entry requires an exact fingerprint and an
explicit resolved disposition; remote-only objects are fetched temporarily for same-gap inspection. A
reportless ref/worktree that overlaps a candidate runtime path cannot be dismissed as unrelated; it must be
reused, superseded or left blocking. A
challenger may contain only deploy-wrapper-approved `.ts` runtime files: no tests,
fixtures, dependency files, scripts, reports or validation runners. Adapter and shared runtime paths count as
production. Only explicitly enumerated deterministic runtime owners may promote historically. Mixed
orchestration owners are routed to Hermes regardless of identifier names; diff signals add a second veto for
intake, ranking, caps, thresholds, budgets, deadlines, concurrency and latency inside otherwise deterministic
files.
The non-author review separately attests that an allowlisted diff contains no cross-opportunity intake,
ordering, cardinality, timing or resource-budget change. The report binds that review to the exact base,
challenger and Git-patch SHA-256 and the gate requires the separate committed review artifact. Historical
replay also binds the exact production pool-universe snapshot/top-N to a provenance artifact and independently
attests the active champion's runtime commit, content-addressed path, hash and top-N through SSM before and
after replay/smoke. It also attests the active champion's local-reth chain ID, exact winner/trigger receipts
and parent block hashes. It rejects caller RPC/WS endpoints and creates SSM loopback tunnels to the exact
HTTP/WS ports read from that champion process. A tunnel is accepted only after the gate-owned Session Manager
child reports ownership of that exact local port and the port answers; identical facts are checked before and after the run.
Caller-provided paths, endpoints or top-N cannot establish production equivalence.
The short smoke uses
a disposable signer and never receives a production private key. It proves full-duration process liveness,
not lane activity from challenger-authored stdout; unchanged replay gates provide the lane capability proof.
A historical causal backrun fixture does not prove public/private network propagation. Any visibility or
source-intake claim is flow-admission work and routes to Hermes. Successful direct-main or deterministic
promotion emits an authenticated shared-Git-dir receipt only after trusted subprocesses finish. Authentication
is computed by node root through SSM from a root-only key. Candidate subprocesses run under a macOS sandbox
that permits outbound network only to loopback, permits writes only under a gate-owned temporary directory,
and permits file-content reads only from gate-created detached worktrees, content-hashed dependencies,
required system runtimes and the gate-owned universe copy. They receive no AWS credential environment or SSH agent. Receipt
close state is included in a newly issued node-root authentication tag. Hermes-routed
work emits none and closes through the A/B gate.
Historical close requires that receipt plus byte-identical candidate reports, tool manifests,
review and universe-provenance artifacts on main before branch/worktree deletion can pass. Close revalidates
track-specific replay, reth/universe and smoke evidence and rejects unsigned or edited receipts. An open receipt
blocks inventory for the next gap. A reusable prior ref must contribute a concrete
commit to challenger ancestry; prose-only reuse cannot promote.
Replay worktrees containing a root `.env` are rejected, close requires the merge tree to equal the frozen
challenger tree, and challenger-descendant worktrees outside `origin/main` must be removed before
the promotion receipt can close.
