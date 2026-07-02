# Hermes — Cycle 20260702-latency: per-opportunity time budget (shared-TTL serial starvation)

> Implementation cycle, not a fresh live-run analysis. Root cause was located and
> competitor-cross-referenced in the prior run (R6 window, 6/71 blocks expired incl.
> our only live v4 opp — see `live-run-20260701-detgap-hermes.md`). This file is the
> decision + implementation ledger for the fix. Generator = Codex gpt-5.5 xhigh
> (user-directed 2026-07-02: "要写代码就调用 CLI 让 codex 5.5 xhigh 来写");
> Claude = orchestrator + non-author evaluator (rule 11 roles restored).

## Run Facts (auto, node `mev-searcher.service`, read 2026-07-02 via SSM, zero CU)

- Last 5000 events `pipeline_dropped`: **1050 `plan/no_candidate_plans`** (R2: ~80%
  longtail noise, not chased) / **277 `solver/expired-before-solver`** /
  96 `solver/no-profitable-quote` / 3 `solver/quote-timeout`.
- **TTL=8000 band-aid measured INEFFECTIVE:** 8000-era expiries exist (8068 / 8022 /
  8495 ms) whose own stages sum to ~130 ms (`plan=8ms prep≤202ms`) — the missing ~7.9 s
  is earlier opps of the same hint consuming the SHARED clock (`startedAt=tHint`,
  serial `for (const opp of opportunities)` at `main.ts:1112`). Not a slow plan on the
  expiring opp itself.
- Additional accounting bug found while reading the path: on hint-TTL exhaustion the
  candidate loop `return`s → **remaining opps of that hint die with NO
  `pipeline_dropped` event** (invisible loss).
- Dry-run sim results remain dust-level (best ~1e14 wei WETH), `gas_estimate:"0"`
  (EV gate falls back to `defaultGasUsed`) — economics blocker tracked for a later
  cycle, out of scope here.

## Claude Round 1 (core judgment)

- **core judgment:** the extraction-relevant latency loss is **starvation, not speed** —
  individual stages are fast; the shared per-hint TTL is a single serial budget that
  the first slow opp (plan blow-up: 2.8–4.8 s observed in R6) or a long solve exhausts
  for everyone behind it. Bumping TTL provably does not help (measured above).
- **next_action:** per-opportunity budget slicing + a hard planner deadline
  (Implementation Brief below).
- **not_doing:** opp ordering by size — `victimAmountIn` is raw token units,
  incomparable across decimals/tokens without pricing; slicing alone removes the
  starvation. Also not doing: concurrency inside a hint (larger blast radius,
  revisit only if slicing is insufficient).

## Claude Final Decision

1. Revert `SEARCHER_OPP_TTL_MS` to **5000** on the node at deploy time (band-aid
   measured ineffective; 8000 only serves staler state).
2. Ship the **per-opportunity time budget** patch (brief below), Codex-authored,
   Claude-gated.
3. Gate = **metrics** (rule 12 latency exemption): `expired-before-solver` count per
   opportunity_seen + solve p95, node dry-run window before/after, plus a
   deterministic planner-deadline regression test (cheap, non-flaky: deadline already
   expired → fast return + explicit classification).
4. `searcher_behavior_change: yes` — opps that previously starved before the solver
   now get solved (or are at least visibly accounted).

## Implementation Brief (drives code — rule 1)

**Task:** eliminate shared-TTL serial starvation with per-opportunity budget slices
and a planner deadline. One narrow patch.

**Allowed files (only these):**
- `listener/src/searcher/planner/planner.ts`
- `listener/src/searcher/planner/token-graph.ts`
- `listener/src/searcher/main.ts`
- `listener/src/searcher/test/planner.ts`

**Forbidden:** everything else (solver/*, detector/*, adapters, .env, package.json,
docs). No renames, no drive-by refactors, match existing style.

**Baseline already landed (`cfbf4c4`, adopted from concurrent session):** a
`SEARCHER_MAX_CANDIDATES_PER_OPP` candidate cap in the `main.ts` opp/candidate loop
(bail after N solves to free the shared TTL, default 0=off) + its config knob + log
line. **Keep it** — it is a complementary blunt cap. This cycle LAYERS the precise
time-budget on top. Follow the existing `maxCandidatesPerOpp` config-knob pattern for
the new knobs.

**Changes:**

1. `planner.ts` — `plan(opp, templates, opts?: { deadlineAtMs?: number })`
   (optional third param; existing callers unchanged).
   - Thread `deadlineAtMs` into `buildTokenPaths` opts.
   - Check `Date.now() >= deadlineAtMs` at the top of the template loop, the path
     loop, and the rotation loop; on exceed set an internal `timedOut` flag, stop
     exploring, **return the partial candidates found so far**.
   - If `timedOut && candidates.length === 0`, the no-candidate diagnostic
     (`lastNoCandidateDiagnostic`) must classify as **`plan_budget_exhausted`** —
     never mislabel a budget kill as structural `no_candidate`. Add
     `"plan_budget_exhausted"` to the `NoCandidateClassification` union
     (`planner.ts:35`); when `timedOut`, set the diagnostic's `classification` to it
     directly (bypass `classifyNoCandidate` for that case).
2. `token-graph.ts` — add `deadlineAtMs?: number` to `PathOpts`; in `walk()` check
   the clock every 64 node expansions (counter, not every call); on exceed stop
   expanding and return the paths found so far (partial OK, mirrors the `maxPaths`
   guard at line ~483).
3. `main.ts` — per-opp budget slice in the opp loop (`~1112`):
   - New config knobs (wire next to the existing env block ~324):
     `SEARCHER_PLAN_BUDGET_MS` (default **300**), `SEARCHER_OPP_MIN_SLICE_MS`
     (default **500**).
   - At the top of each opp iteration: `remainingTtl = oppTtlMs - (Date.now() -
     ctx.startedAt)`. If `remainingTtl <= 0`: emit `pipeline_dropped
     stage=solver reason=expired-before-solver` **for this and every remaining opp**
     (fixes the invisible-loss return), `recordFinalState`, return.
   - Slice: `sliceMs = max(minSliceMs, floor(remainingTtl / oppsLeft))`;
     `oppDeadlineAtMs = min(Date.now() + sliceMs, ctx.startedAt + oppTtlMs)`.
   - Plan call gets `deadlineAtMs = Date.now() + min(planBudgetMs, sliceMs / 2)`.
     If plans are 0 AND the planner reports budget-exhaustion, emit
     `pipeline_dropped stage=plan reason=plan_budget_exhausted` (distinct from
     `no_candidate_plans`).
   - Candidate loop: replace the shared-TTL `remainingMs` with
     `remainingMs = oppDeadlineAtMs - Date.now()`. On `<= 0`: if this opp entered
     the solver 0 times, emit `expired-before-solver` for it; either way **`continue`
     to the next opp** (do NOT return) unless the hint-level TTL is also exhausted
     (then the rule above applies). Per-solve deadline stays
     `min(solverDeadlineMs, remainingMs)`.
   - Keep the existing seg-timing (`segMark`) and log lines intact; extend the
     expiry log to say which budget expired (slice vs hint TTL).
4. `test/planner.ts` — add a deterministic case: any existing fixture with
   `deadlineAtMs: Date.now() - 1` → returns `[]` quickly and
   `lastNoCandidateDiagnostic().classification === "plan_budget_exhausted"`; all
   existing fixtures still pass unchanged (no deadline passed = no behavior change).

**Verify (run both, paste output):**
```
cd listener && npm run build
npm run searcher:planner
```

**Acceptance:**
- tsc clean; planner harness: all pre-existing fixtures pass + new deadline case.
- No behavior change when `deadlineAtMs` is not supplied.
- Diff stays inside the 4 allowed files.

## Codex Implementation Pass (orchestrator judged output file + diff)

- status: **landed** (`0c3d9ab`)
- authored_by: codex gpt-5.5 xhigh (torn down mid-cleanup — no `-o` file); **completed +
  non-author reviewed + one fix by Claude**. Codex's edits to the 4 target files were
  complete and green despite the teardown (its last message was a cosmetic-indent cleanup).
- changed_files: `planner/planner.ts` (+deadline param, `plan_budget_exhausted` class,
  timeout checks at template/path/rotation loops, diagnostic override) ·
  `planner/token-graph.ts` (`PathOpts.deadlineAtMs` + DFS clock check every 64 expansions) ·
  `main.ts` (per-opp slice, plan deadline, visible expired-before-solver for starved opps,
  slice-vs-hint distinction) · `test/planner.ts` (deadline case).
- verification: `npm run build` tsc clean; `npm run searcher:planner` → **11/11 + fixtures
  2/2**, incl. new `plan_budget_exhausted` case; pre-existing fixtures unchanged.
- diff_scope_check: strictly inside the 4 allowed files. (CLAUDE.md +27 in the tree was a
  concurrent session's edit — NOT this cycle; committed separately by that session, kept.)
- **Claude non-author finding (fixed in `0c3d9ab`):** candidate-cap branch double-emitted a
  `pipeline_dropped` (its own `candidate-cap` + the post-loop terminal drop) → would inflate
  the very loss-attribution metric this cycle gates on. Added `skipPostSolverDrop = true`
  before the cap `break`. Default-off (`maxCandidatesPerOpp=0`) so inert today, correct when
  enabled.

## Final Approval (rule 12 — latency fix, replay-EXEMPT → metrics gate at deploy)

- verdict: **implemented** (code + gates green). Not yet `fixed` in the extraction sense —
  a latency change is validated by before/after METRICS on a node dry-run window, not a
  replay flip. That is the deploy step below.
- searcher_behavior_change: **yes** — opps that previously starved before the solver now (a)
  get a fair time slice + a bounded planner, (b) yield to the next opp instead of killing the
  whole hint, (c) are visibly accounted when starved.
- **metrics gate (deploy step) — MEASURE `solverEntered`, NOT raw `expired-before-solver`.**
  Counting semantics changed: previously starved opps died invisibly (undercount); now every
  starved opp emits + increments the counter, so raw expired can *rise* while the pipeline
  improves. The honest before/after signals: **`solverEntered` up**, per-hint solver-reached
  ratio up, and no single opp consuming the whole hint TTL. Revert `SEARCHER_OPP_TTL_MS`
  8000→5000 at deploy (band-aid measured ineffective).

## Findings Ledger (carried)

| finding | owner | carry_to_round | status |
|---|---|---|---|
| shared-TTL serial starvation (this cycle) | Codex impl / Claude gate | this cycle | **FIXED `0c3d9ab`** — metrics gate PASS: expired-before-solver 16.4%→4.1% (~4×), slice-yield confirmed live |
| **native-ETH v4 execution — SCOPE CORRECTED 2026-07-02:** BotVM.sol already has opcode `0x01` CALL-with-value (since first commit `f964ae5`) + `0x04` WETH_UNWRAP + payable `receive()`; TS `encodeCallValue`/`weth-withdraw` exist. **NO contract change / redeploy.** Real gap is TS-only and starts upstream: detection excludes ZeroAddress (`pool-impact.ts:511`), graph drops it (`token-graph.ts:287`). Fix = 0x0↔WETH native-flag mapping + plan-builder unwrap/settle-value/wrap legs. | next cycle (cycle 2) | cycle 2 | open — de-escalated from "user-present contract change" to normal TS slice; broadcast still human-gated |
| TTL=8000 band-aid | Claude | this cycle (deploy step) | revert to 5000 — measured ineffective |
| go-live economics: bribeBps=10000 keeps nothing, `gas_estimate:"0"` in sims, `SEARCHER_MIN_NET_ETH=0` | — | pre-broadcast cycle | open (hard prerequisite before any production flip) |
| node `/var/log/mev-live.log` ~382MB no rotation | Claude | deploy step | open (add logrotate when touching the node) |
| `defaultTokenGraph()` hardcoded DAI/USDT v4 fallback (test-only) | — | backlog | open (minor, Codex caveat) |

## Deploy + Measurement (node `mev-searcher.service`, 2026-07-02 ~03:02 UTC)

- **Deployed** `main` `503c2a7` (incl. TTL fix `0c3d9ab`) to node. Node was 56 commits
  behind (`1be834c`, pre-v4-epic) with 39 dirty files = the v4-epic/tooling work
  hand-rsynced but never committed node-side; proven superseded by main
  (`pinned-warm-pools.json` local == origin/main, 0 diff). `git reset --hard origin/main`
  after a recoverable tarball backup (`/opt/MEV-deploy-backup-*.tar.gz` + `.env.bak-*`).
  `runtime-graph-pools.json` (untracked runtime snapshot) preserved.
- **Safety incident found + fixed:** `/opt/MEV/.env` had been truncated (02:22, by a
  concurrent session) to 5 lines, **losing `SEARCHER_DRY_RUN=1` and all `SEARCHER_LIVE_*`/
  mempool keys**. Since `dryRun = process.env.SEARCHER_DRY_RUN === "1"` (default false →
  `ProductionBundleRouter`), **any restart would have gone live-submit**. The running
  process still held the full env; `.env` reconstructed from `/proc/<pid>/environ`
  (node-side, secrets never printed), `SEARCHER_OPP_TTL_MS=5000`, `SEARCHER_DRY_RUN=1`.
- **Restart verified (startup banner):** `mode=dry-run` · `oppTtlMs=5000 planBudgetMs=300
  oppMinSliceMs=500 maxCandidatesPerOpp=unlimited` · backend=revm · mempool=auto · pool
  registry 2801. No crash loop.
- **Before/after boundary:** events file line **3303**; after = new-code window.
  **Old-code baseline (4000 events):** 1748 `opportunity_seen` · **286
  `expired-before-solver`** · 1134 `plan/no_candidate_plans` · 99 `no-profitable-quote` ·
  14 `simulation_result` · 14 `bundle_submitted`.
- **Gate (pending window accumulation ~20–30min):** compare NEW window — expect
  `expired-before-solver` *rate* per opp down and/or `simulation_result`/solverEntered up;
  a new `plan/plan_budget_exhausted` bucket may appear (honest reclassification, not a
  regression). Remember: raw expired count can rise (now counted honestly, was invisible).

## Measurement RESULT — metrics gate PASS (2026-07-02, ~44min clean-restart window, PID 57057)

- Process counters (cumulative since the clean restart on new code, `oppTtlMs=5000
  planBudgetMs=300 oppMinSliceMs=500`): **opportunities=73 · solverEntered=22 ·
  expired-before-solver=3 · plans=140 · simSuccess=0**.
- **expired-before-solver rate: 286/1748 = 16.4% (old) → 3/73 = 4.1% (new) — ~4× drop.**
  ~30% of opportunities now reach the solver (22/73). The slice-yield path is confirmed
  firing in the live log (`opportunity expired (slice) … moving to next opportunity
  (hintOpps=3 candidatesTried=4/20)`) — one opp yields after its slice instead of
  `return`-ing and killing the whole hint.
- **verdict: FIXED** (latency metrics gate, rule 12 exemption). Sample is smaller than the
  baseline window but the direction + the observed slice-yield behavior are unambiguous.
- **Caveat / not this cycle:** `simSuccess=0` — the fix moves more opps INTO the solver, but
  none produced a profitable bundle this window. That is the **coverage + economics** gap
  (native-ETH v4 = cycle 2; go-live economics = D), NOT latency. Latency starvation is closed.
- Note: the events-jsonl line-3303 boundary was invalidated when logrotate (installed this
  session) truncated the file; the process counters above are the clean before/after signal.
