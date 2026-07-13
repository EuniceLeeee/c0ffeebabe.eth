# HERMES — Live-Run Collaboration Protocol (operating runbook)

> **Load this when you are running a live-run / Hermes / handoff round** (the autonomous routines in
> `docs/research/autonomous-*.md` read it). It is NOT always-on: a normal interactive task doesn't need
> it — that's why it lives here and not in `CLAUDE.md`. `CLAUDE.md` (behavioral base + Mission + Safety
> Rules) and `docs/research/gates.md` (the validation contract, rule 12) are the companions.
>
> Hermes is the fixed collaboration + decision record between **Claude** and **Codex** after each live
> run (a 作战记录 + 决策协议, not a product). One markdown file per run; GitHub is the shared state.
> Rule **numbers 1–17 are load-bearing** — hooks + routines reference rules 11/12/13/14/15 by number.
> Never renumber; compress in place. Safety Rules and their dated bounded-live authorizations live in
> `CLAUDE.md` / `docs/live-safety-envelope.md` and override everything here.

## Generator / Evaluator split — DEFAULT for all code work
Codex (gpt-5.5 xhigh) is the generator; Claude authors the brief and is the **non-author evaluator** of the diff (rule 11 protocol). Rounds depend on the orchestrating model:
- **Fable 5 (3 steps):** Claude plans → Codex writes → Claude reviews + gates + commits.
- **Opus 4.8 (5 steps):** Claude plans → Codex reviews the plan → Claude finalizes → Codex writes → Claude reviews + gates + commits.

Applies to normal single-turn requests too. Sign commits as the ACTUAL orchestrating model. **Fallback:** Claude may take over only **fully-specified mechanical edits** (brief pins exact file/anchor/code) or **evaluator gate-strengthening**, labelled as such — never net-new design/judgment code (judgment needs a non-author reviewer).

## Node Deploy — run BEFORE each dry-run (latest code on the node, safely)
The EC2 node picks up code only on **restart**, and `/opt/MEV` can drift behind `main`. Deploy latest with the one repeatable, broadcast-safe op:
```bash
aws ssm send-command --instance-ids i-0ff908dedeec9ebc6 --document-name AWS-RunShellScript \
  --parameters 'commands=["git -C /opt/MEV fetch origin -q && git -C /opt/MEV show origin/main:scripts/deploy-node.sh | sudo bash"]'
```
`scripts/deploy-node.sh` (self-bootstraps from git): recovers the full working env from the **running process** → forces `SEARCHER_DRY_RUN=1` (override via env/markers) → **ABORTS if DRY_RUN can't be ensured (broadcast guard)** → tar-backs-up dirty files → `git reset --hard origin/main` → build → pins the process to a content-addressed, read-only pool-universe snapshot → restart → verifies the restarted env. The 30-minute indexer may update canonical `active-pools.json`, but that update becomes input only at the NEXT guarded deploy and cannot invalidate an active A/B window. Durable flags are marker-gated on the node (`.deploy-live`, `.bribe-all-above-gas`) so they survive the recover-from-process rebuild. Never restart by hand without this guard ([[project-node-env-dryrun-guard]]). Never spawn a 2nd searcher instance **except the single §A/B challenger through `deploy-ab-challenger.sh`**. Multiple concurrent sessions run on this repo — `git log` + check the node marker before any deploy, and never interrupt an active live measurement window. Local run logs go to `MEV/logs/` (gitignored), not `$HOME`.

## Competitor-loss analysis — the canonical flow (run the tools, don't guess)
Every "a competitor got value we didn't" event runs ONE fixed flow (the `bundle-postmortem` skill holds the decision tree; do NOT invent a parallel path):
1. **SCOPE both, same shape:** a bundle WE submitted that lost (`bundle_not_included` → `bundle-postmortem --tx <ours>`) AND an opportunity we MISSED (`not_seen` → census produces a postmortem-shaped report). Neither is skipped.
2. **FILTER non-comparable winners FIRST** (else it's noise). Only `atomic_loop` (a closed loop returning to a priced token in-tx) is comparable to our atomic sim. REJECT: `sandwich`, `one_leg_inventory` (one-way swap, profit realized off-chain / CEX-DEX — decisive check: the winner's Swap pushed the pool tick PAST the pre-triggering-swap `slot0` tick), plain transfers, JIT-LP → `non_comparable_winner`; our sim was RIGHT and correctly lost. Codified in bundle-postmortem (`winner_style`).
3. **AUTO-IMPROVE from the tool's verdict** — classify + close per gap class (pool/path/execution-adapter/detection/pure-outbid), validate with a rule-12 fixture flip (`docs/research/gates.md`).
4. **INCONCLUSIVE → MANUAL escalation → codify:** auto-close closed 0 yet we demonstrably LOST ⇒ the tool hit a class it can't name ("auto-analysis empty" is itself a finding). Package {postmortem JSON + auto-close result + our sim/bid + winner touchedVenues/builderPayment} → a FRESH analyst (Fable PRIORITY, Opus 4.8 fallback) names the missed class → CODIFY it back into the tool (rule 16). A `pending-manual-analysis` package left unanalyzed BLOCKS cycle-close.

```bash
cd analysis && npm run bundle-postmortem -- --events <events.jsonl> --tx <our tx, prefix ok> \
  --rpc http://127.0.0.1:8545 --out /tmp/pm.json
cd listener && npm run auto-close-route-gap -- --report /tmp/pm.json --rpc http://127.0.0.1:8545  # backfill missing poolId + force-include (idempotent)
```
Events + local reth live on the NODE (run via SSM); the events path is the running process's `SEARCHER_EVENTS_PATH` (read `/proc/<pid>/environ`). Postmortem tree: one-shot validity (a mempool-route bundle pins ONE target block; "not included after the swap landed" is EXPECTED) → builder reach (Flashbots relay auto-shares to BuilderNet ⇒ `flashbots: ACCEPTED` ⇒ BuilderNet saw it) → auction outcome (`outbid` = winner payment > our bid; `route_gap_decisive` = winner payment > our FULL sim gross ⇒ coverage gap, no bid could have won) → gap class vs `runtime-graph-pools.json`. **force-include is the band-aid**; same-class force-include ≥3 → fix the SCORER (arb-relevance scoring epic, `project-pool-scoring-arb-relevance-epic`), stop pinning. Auto-deploy is sanctioned in this chain (decision-log D-002) with mode-preservation verify + debounce (≤1 deploy/window). Dated closed instances (e.g. the native-ETH v4 pool gap `0xa32b646c`) live in `docs/decision-log.md`.

## Mechanics
- One file per run: `docs/research/reports/live-run-<run_id>-hermes.md`. Two templates: **implementation cycle** (known fix → code → gate → merge) uses the lean `hermes-impl-cycle.md`; **live-run analysis cycle** uses the full `hermes-live-run.md`. Governance rules 11/12/13 apply to both.
- **Step 1 — competitor cross-reference (MANDATORY, before any conclusion).** Use the EXISTING scripts (iterate, don't reinvent), over the same block window, on the local reth node (zero Alchemy CU). Applies to EVERY measured window — including a pure metrics/deploy window (a metrics gate answers "did we regress"; Step-1 answers "what did competitors capture that we missed"). **Precondition: `SEARCHER_EVENTS_PATH` set before the window** (verify the events file writes right after the banner) — a window without structured JSONL is not a valid Hermes window.
  - `analysis live-loss --watch <WATCHLIST> --events <jsonl> --rpc http://127.0.0.1:8545` → per-EOA `seenScope`/`primaryReason` + `poolInOurGraph`. `--competitor-scan` → per-drop victim-real-block competitor take ([[project-competitor-scan-tool]]).
  - For an A/B block-scan window, run `/opt/MEV/scripts/census-gap.sh <from> <to> <WATCHLIST> <out-dir>
    --blockscan-log <log>` on the node. It is the canonical glue from `census-report`'s complete matched-take
    list to per-tx `bundle-postmortem` + source-block scanner evidence. Its verdicts remain hypotheses until
    the conserving `atomic_loop` filter and the calibration gate below pass.
  - **WATCHLIST (seed):** `0xc0ffeebabe5d496b2dde509f9fa189c25cf29671` (coffeebabe), `0xae2Fc483527B8EF99EB5D9B44875F005ba1FaE13`.
  - **Both agents run this and cite it.** Each works from PRIMARY sources independently (raw script JSON + own on-chain trace), **never the other's curated facts/conclusion**. Secondary-source-validate ≥1 key tx via Alchemy/Tenderly. **MANUAL analysis, not script-only:** the label is a hypothesis; hand-trace the watchlist's key txs — a root-cause is INVALID unless it names the specific source swap (or proves atomic) from a manual trace.
- **ENFORCEMENT — the hermes-gate (forcing function).** After EVERY dry-run, `cd analysis && npm run hermes-gate -- <hermes-md>` MUST exit 0 before `Final Approval`. It validates a structured on-disk artifact (prose can't satisfy it) and enforces five analyses: (1) standard `run_analysis` (funnel + `dominant_drop` + `events_source`); (2) per-watchlist-EOA comparison; (3) coffeebabe `analysis_mode:"full"` (EVERY tx hand-analyzed, pools in/out of `runtime-graph-pools.json` + `gap_class`); (4) other bots `analysis_mode:"sample"`; (5) **intake audit — the funnel-EXTERNAL lens** (router-allowlist + MEV-Share intake gaps never ENTER the funnel, so `pipeline_dropped` can't see them). Doctrine the gate encodes: a "private" victim is NOT a human gate until the MEV-Share feed is ruled in; "coverage exhausted" is INVALID without the intake fraction; an `atomic` competitor is a scanner/strategy gap, NOT a market ceiling; "dust" ≡ per-tx NET USD < $0.1; `maxPriorityFeePerGas=0` ≠ private orderflow. Record `hermes_gate: PASS`.

## Rounds — the canonical live-run loop
Each round DISCOVERS the next blocker from competitors, fixes it, gates it, carries what it can't.
```
0. SLEEP-KEEPER  First step. Codex bg runs freeze on Mac sleep/screen-lock ([[reference-codex-background-suspend]]);
                 ensure ONE persistent keeper (idempotent, PID-guarded):
                   KEEP=/tmp/mev-sleep-keeper.pid
                   if [ -f "$KEEP" ] && kill -0 "$(cat "$KEEP" 2>/dev/null)" 2>/dev/null; then echo alive; \
                   else nohup caffeinate -i -d -s -t 10800 >/dev/null 2>&1 & echo $! >"$KEEP"; fi
1. LIVE RUN      ~30-min window. Deploy latest FIRST; do not analyze stale code.
2. AUTO ANALYSIS Run Facts + structured pipeline_dropped + before/after vs the prior round. If the dominant
                 drop is `no_candidate_plans`, classify: flash borrowability / path template / token-graph
                 coverage / unsupported shape (drill-down is standard in the `redact-live-run` tool).
   THE QUESTION  (dual frame): • PRIMARY (funnel-INTERNAL) the nearest blocker to a genuine +EV simSuccess
                 (walk opportunity_seen → plans → solverEntered → simSuccess; simSuccess must be +EV not dust —
                 if dust is the ceiling, ECONOMICS is the blocker). • COMPLEMENTARY (funnel-EXTERNAL) what
                 competitors capture that never enters our funnel (step 3 is the only lens on pools we don't index).
3. COMPETITOR    MANDATORY: coffeebabe — MANUAL, every live-window tx; 0xae2Fc4… — SAMPLED, size OUTCOME-DRIVEN
   CROSS-REF     (extend a thin window to hours; never conclude a true-negative from a starved sample — the R3 trap).
                 Classify what WE missed (pool/path/unanticipated) + confirm the blocker is on a REAL captured opp.
4. BLOCKER       Two BLIND-INDEPENDENT analyses of the same raw material, then compare (NOT analyze-then-review —
   (dual-blind)  the rule-9 nodding risk): a FRESH fable-5 blocker-finder (Agent tool, model:fable, chain+code) → A
                 (kept from Codex); Codex, handed ONLY raw material as DATA → B blind to A. Agree = high-confidence;
                 differ = the disagreement is the signal. Only the Brief drives code.
5. IMPLEMENT     Codex writes → Claude review ↔ Codex fix (≤3 passes) → Final Approval or explicit stop.
6. GATE          deterministic → local FORK/REPLAY flip confirms (rule 12, docs/research/gates.md; no flip = not fixed);
                 non-deterministic (latency/inclusion/economics/bid/mempool) → record with carry_to_round, next
                 round's metrics decide.
7. CARRY         Next round READS this round's conclusion + open findings FIRST; resolve any finding past its
                 carry_to_round before new analysis (rule 13).
```

## A/B Canary — unattended champion/challenger research loop
This is the hourly path for one known blocker at a time. It is deliberately **not a TS research state
machine**: the agent chooses/implements/judges; a thin JSON journal plus small mechanical tools enforce
safety, fairness, evidence, recovery, and branch lifecycle. Metrics provide evidence but **never own the
merge decision** (a honeypot filter can correctly reduce `quotePositive` and look worse numerically).

- **A = champion:** deployed `/opt/MEV` (`mev-searcher`), bounded-live wallet/BotVM 1.
- **B = challenger:** literal `ab/*` branch in `/opt/MEV-ab/b` (`mev-ab-b`), bounded-live wallet/BotVM 2.
- Both are block-scan-only (mempool/backrun off), EV-gated, and may submit simultaneously. Their wallets,
  BotVMs, ports, events, logs, and CPU sets are separate. The dated authorization and circuit breakers are
  in `docs/live-safety-envelope.md`.
- Many analysis branches may exist, but there is exactly **one persistent B runtime lease** because every
  challenger shares wallet-2/BotVM-2/port 8567/unit `mev-ab-b`. The lease is resource coordination, not a
  global research lock; another hourly wake skips a busy B slot and does not disturb it.

### One unattended wake = one new problem
1. **RECOVER.** Run trusted `origin/main:scripts/deploy-ab-challenger.sh reap` first. An expired/crashed B is
   stopped, A gets all CPUs back, its branch is retained, and the report becomes `needs_escalation`. Read the
   newest A/B reports. Before picking new work, archive any retained branch whose gap has since been closed
   by a validated commit on `origin/main`: copy/update its report on main with the exact base, challenger,
   `resolved_by_commit`, and validation evidence; authorize `resolved_deleted`; delete only that literal
   `ab/*` branch/worktree. Skip every still-retained `problem_id`; never retry the same hard problem every
   hour. With no active B lease, sync champion A to `origin/main` through guarded
   `deploy-node.sh` if its deployed SHA differs; verify posture before taking the experiment base SHA.
2. **PICK A PRODUCTION SAMPLE, NOT A METRIC.** Select the highest-impact unclaimed blocker only after one
   real on-chain `+EV` sample in the current production scope proves where we stop. The sample MUST be a
   victim-independent `block-scan`, position-conserving `DEX↔DEX` or `DEX↔permissionless protocol` closed
   loop. `winner_style=atomic_loop` alone is insufficient: a prior/victim transaction makes it a backrun and
   excludes it while backrun/mempool are disabled. Keeper/reward, inventory, private-path, credit, sandwich,
   and JIT-LP samples are also excluded. If the queue is empty, run the normal Hermes manual+tool analysis to
   find one; do not invent a code change merely to keep the loop busy. One branch = one causal hypothesis.
   A latency/CPU/cache optimization becomes eligible only when the SAME +EV sample demonstrably misses a
   production stage because of that limit and the replay advances it; aggregate milliseconds alone are not
   a blocker.
   If manual analysis finds an analysis tool wrong or incomplete, invoke a fresh non-author reviewer. When
   both agree, fix the tool and its regression test immediately, rerun it in this same wake, and merge that
   auxiliary tooling commit before selecting/forking B. Tooling work does not consume the round's production
   objective and MUST NOT appear in the challenger diff.
3. **PREDECLARE.** Create `ab/<problem>` from the exact deployed A SHA, then before code create
   `docs/research/reports/ab-<experiment_id>-hermes.md` from the A/B template and fill its `ab_experiment`
   schema-v3 journal: exact problem/base SHA, change class, hypothesis, semantic success criterion,
   `production_evidence` (real tx/block/net +EV evidence, current-scope posture, baseline→challenger funnel
   stage, passing replay), deterministic gate,
   intended metric evidence, input mode, allowed config delta, and whether the change is expected to alter
   the runtime block-scan view/graph. `challenger_commit` is temporarily pending
   here because a commit cannot contain its own SHA. Commit/push the initial report on B.
4. **FIX + FREEZE.** Codex writes; the non-author agent
   reviews; the same production sample must advance at least one stage
   (`not_admitted→path_found→final_sim_success`) in a pinned replay
   from the sample's untouched parent-block state (rule 12). Predeploy runs the trusted unchanged
   `searcher:blockscan-hunt` from both A and B against the same universe and on-chain sample pool IDs; no
   victim/oracle transmit/same-actor prefix may be applied first. An exit-zero build/test or
   challenger-authored replay harness is not evidence. Push B. Two
   failed generator attempts or three review passes do not block the loop: retain branch + evidence as
   `needs_escalation`, then the next wake selects another problem. Freeze the exact tested code SHA while it
   is the remote branch tip and deploy that SHA. After deployment the branch may advance only through
   report/evidence commits; the final journal's `challenger_commit` is the frozen deployed code SHA, not the
   later report tip.
5. **DEPLOY B THROUGH THE SAFETY WRAPPER ONLY.** Execute the trusted `origin/main` copy of
   `scripts/deploy-ab-challenger.sh deploy <id> <branch> <base-sha> <challenger-sha>
   <candidate-report.md> <allow-view-delta>` over SSM, where the last argument is `1` only when
   `expected_runtime_view_delta=true` was predeclared
   (otherwise `0`). It validates
   the schema-v3 production candidate gate; recomputes the sample's receipt/block, PnL, winner style and
   victim independence from local reth; executes the trusted dual-worktree parent-state hunt; binds the
   report to the requested experiment/branch/base/input/config declarations; and requires a deployable
   listener runtime diff with no mixed analysis/governance/dependency-script edits. It then validates both
   wallet envelopes/ownership, exact commits, A's live posture, normalized A/B config, declared deltas,
   universe inputs, the pinned startup-discovery cutoff, exact runtime pool-view and TokenEdge graph hashes,
   and equal CPU partitions. A runtime-view delta is rejected unless it was explicitly predeclared for a
   correctness/capability experiment. It never restarts A. Direct `systemd-run`, hand-written B env,
   or deployment from the challenger branch is invalid. Block-scan-only A/B requires
   `SEARCHER_ENABLE_BACKRUN=0` **and** `SEARCHER_ENABLE_MEMPOOL=0` on both sides: the first disables
   MEV-Share plus every victim-driven hint path; the second alone disables only public mempool and is not a
   valid CPU-isolated canary posture.
6. **MEASURE PAIRED BLOCKS.** Exclude startup/full-warm, pass-budget, and catch-up blocks where either lane's
   incremental warm range spans more than one block; those lanes have different cache histories and are not
   a causal pair. Renew the lease if needed. A and B must see the same remaining block numbers. Record restart
   deltas and before/after input hashes. For shared-input tests all
   universe hashes and discovery cutoffs match. Unless the intervention explicitly targets graph admission,
   the full runtime pool-view and TokenEdge graph hashes must also match and remain stable. Budget-censored
   / full-warm / catch-up blocks are reported separately and do not count toward warmup or the paired
   sample. A fairness failure cannot yield a decisive verdict.
7. **PAUSE B BEFORE JUDGMENT.** Run `deploy-ab-challenger.sh pause <id>` to stop broadcasts and restore all
   CPUs to A. Preserve logs/events and copy only redacted evidence into the report bundle.
8. **EXTERNAL PRODUCTION CALIBRATION (MANDATORY).** Over the same block window, run the existing competitor
   cross-reference against coffeebabe `0xC0ffeEBABE5D496B2DDE509f9fa189C25cF29671` (plus the standing
   watchlist) through `scripts/census-gap.sh` and emit the normal Step-1 artifact. Compare B only with **replicable, conserving
   victim-independent `block-scan atomic_loop`** transactions: in-tx route closes to a priced token, has no
   standing position, and does not depend on a prior/victim transaction. Exclude
   `sandwich`, `one_leg_inventory`, keeper/liquidation, JIT-LP, standing-credit, and private-inventory
   rebalances before classifying any gap; they are different postures and cannot judge this block-scan lane.
   For each comparable take, classify B's remaining production gap (`not_seen | pool | path | adapter |
   quote/sim | execution | economics`). If the live window is thin, record zero same-window comparable
   samples honestly, then use a separate recent historical artifact to seed backlog rather than inserting
   out-of-window txs or relabeling non-comparable transactions. This axis answers
   “did the tested gap to a mature searcher shrink?” and seeds the next problem. It does not replace A/B.
   Before trusting those labels, run `cd analysis && npm run competitor-calibration`: it replays the nine
   pinned coffee source-shape fixtures plus conserving/inventory receipt controls. Record its JSON summary
   under `classifier_calibration`; `hermes-gate` independently reruns the same checks. A failure means the
   analysis tool is not authoritative: file/fix the tooling defect, retain this B as `needs_escalation`, and
   do not merge from an uncalibrated external comparison. Source-shape `atomic_state_arb` is never by itself
   proof of winner-style `atomic_loop`; the latter additionally requires in-tx position conservation.
9. **AGENT-MANUAL FIRST, SCRIPT SECOND.** The orchestrating agent independently inspects both axes: local
   A→B causal behavior and B→comparable-competitor production gap, then records
   `agent_manual_verdict: win|lose|inconclusive` + evidence. Only then run the canonical
   `ab-canary-compare` script over paired blocks and record its real exit code plus
   `script_assessment: supports|contradicts|inconclusive`. This follows `CLAUDE.md` reconcile-after and tests
   the script rather than anchoring the analyst to it. Infrastructure/identical-code shakedowns use
   `--expect-equal --require-output-match`; normal challenger experiments keep the default improvement goal.
10. **RECONCILE.** Agreement may decide performance/correctness. A capability `win` always requires a fresh
   non-author adversarial reviewer. Any manual/script conflict, either side inconclusive, suspected
   honeypot/phantom/inventory artifact, or semantic-vs-metric disagreement also requires one. The reviewer
   checks which causal interpretation is correct; it does not vote by threshold. If the fresh review still
   cannot decide, final verdict is `needs_escalation`.
11. **MECHANICAL VETO.** `npm run ab-canary-gate -- <report> --phase decision` verifies safety/fairness,
    exact evidence, script artifact, non-author review, replay requirements, and B stopped. It can reject a
    decision; it cannot create a win. `hermes-gate` also runs the A/B close validation when the journal exists.
12. **CLOSE EXACTLY ONE WAY.** First run `deploy-ab-challenger.sh close <id> <verdict>`.
    - `win`: only if `origin/main` is still the tested base; otherwise retain/retest. Merge the exact frozen
      `challenger_commit` with `--no-ff` (never the later report tip), then add the final redacted report as a
      separate main-side docs commit. Push, deploy champion via guarded `deploy-node.sh`, add `merge_commit`,
      authorize cleanup with the A/B gate (which verifies the no-ff merge's second parent is the tested SHA),
      delete local+remote `ab/*`, then close-gate.
    - `lose`: copy/commit the final redacted report (not challenger code) to `main`, authorize cleanup,
      archive evidence, delete local+remote `ab/*`, then close-gate against the preserved main report.
    - `needs_escalation` / unfinished / crash: branch action is `retained` while unresolved; do not merge or
      delete yet. Record the unresolved question so a stronger model can inspect it. The next hourly wake
      moves to a new problem.
    - later resolution: when a deterministic replay or subsequent A/B proves a fix already on `origin/main`,
      copy the original report/evidence to main, add `resolution.resolved_by_commit` + `resolution.evidence`,
      set `branch_action=resolved_deleted`, commit/push the report, then run close-phase cleanup authorization
      and delete the old local+remote `ab/*` branch/worktree. The report on main, not a permanent branch, is
      the archive. A recorded SHA alone is not durable for an unmerged Git object, so unresolved branches
      remain until this condition is met.

**No mid-loop questions.** This dual-live/merge/`ab/*` cleanup sequence is explicitly authorized inside the
dated bounded envelope. Only funding/cap/key changes, standing-credit enablement, or out-of-envelope
broadcast are real human stops. Transient mechanics get one retry; a second failure retains the branch and
advances rather than stalling ten future rounds.
The hourly opening `reap` also reconciles runtime liveness: `state=running` with an inactive B unit closes
immediately as `crashed_needs_escalation`, restores A's CPUs, preserves the branch/evidence, and advances to
the next problem. It never waits for the nominal lease to expire.
**Traps (codified 2026-07-08/12):** SSM runs `sh` not bash → `bash <(…)` fails, use `… | bash`. • Startup
full warm has its own one-time `SEARCHER_BLOCKSCAN_STARTUP_WARM_BUDGET_MS` (default 30000); regular passes
remain 11000. The B wrapper refuses readiness until one complete `scannedPairs=` pass, preventing the old
`lastWarmedBlock=null` / `warm=full` death spiral from masquerading as a healthy deploy. • stableswap-NG `stored_rate` refreshes OFF-event →
getLogs-changed incremental MISSES it → always re-warm `kind==="ng"`, only plain-curve is event-incremental.
• A fork-gate revert can be a FIXTURE artifact (take pinned to a realized amount on a post-tx fork →
CurrencyNotSettled), not a live bug (live re-quotes via `propagateAmountsWithRawOutputs`) — separate
fixture-pinning from real execution before calling a revert a live blocker. • `traceRevert` returns the
deepest failed call but the string is `.slice`-truncated. • `census-report` is loss-focused (only deep-
analyzes qualifying comparable losses) — it won't classify ALL competitor txs. • Don't call a pool-count or a
fork-gate revert a strategic blocker without the VALUE distribution + a CONSERVING atomic_loop exemplar
(hooked-v4: 9% of pools but the head is blue-chip, yet a fee hook thins the arb — [[project-v4-swaphook-admission-gap]]).
**Autonomous invocation:** use `docs/research/autonomous-ab-canary-round.md` as the complete fresh-context
prompt. One external hourly wake runs one problem; the durable node lease/reports provide recovery. No
in-session timer is required. All node ops use SSM to `i-0ff908dedeec9ebc6`; secrets stay in `/opt/MEV*/.env`.

## Governance (hard rules — numbers are load-bearing, never renumber)
1. **Only `Claude Final Decision` / `Implementation Brief` drives code.** Never from scattered chat or the other agent's draft.
2. `Claude Final Decision` is authoritative for the md; code review is mutual; Claude holds final approval.
3. Every claim is verified against code/data, not memory.
4. md updates auto-commit/push; raw log / JSONL / secrets / `.env` never committed (redacted review logs under `docs/research/reports/` ARE tracked on purpose).
5. One agent owns each section; do not overwrite another's.
6. **The review phase is a fix loop, not a one-shot.** After a Claude review, Codex fixes all blocking + in-scope P1 issues and re-verifies, or marks `deferred` with owner + reason + next cycle.
7. **≤3 review passes per cycle.** A pass = one Claude review + the Codex fix/defer response. "I agree" alone is not a valid handoff.
8. After pass 3, Claude writes `Final Approval` OR stops with an explicit `not approved / deferred / blocked` + owner. No endless ping-pong.
9. **Evaluator = whoever did NOT author the artifact** (rotates). The evaluator defaults to doubt and must ACT: record `ran_gate:` (the build/test/replay/diff-check it executed) + `finding:`. An approval with no executed gate and no finding is invalid (the Nodding-loop red flag — two different models does NOT prevent it).
10. **Hard caps before each turn** (anti-blowout): per-run CU budget, daily CU budget, the 3-pass cap. Record `cu_spent` per turn.
11. **Codex CLI = xhigh long-running generator (calling protocol).** Default `gpt-5.5 xhigh` over the local proxy (`127.0.0.1:1082`); the long stream retries connection — give it time.
    - **Invocation — ALWAYS via `scripts/codex-run.sh`, NEVER hand-write the codex line.** The wrapper bakes in `< /dev/null` (stdin-hang guard), `caffeinate -i`, `-o`+`--json` to files, and a 30s launch watchdog. Brief in a FILE; run in background: `scripts/codex-run.sh <read-only|workspace-write> /tmp/codex-<pass>.brief.md /tmp/codex-<pass>`. **ENFORCED:** a PreToolUse(Bash) hook (`scripts/hooks/guard-codex-stdin.py`) BLOCKS a raw `codex … exec` lacking the wrapper or `< /dev/null`. Do NOT edit global `~/.codex/config.toml`.
    - **Timeout:** soft 10–15 min, hard 25–30 min (never 90s/180s). Background + judge on exit.
    - **Judge success by the OUTPUT FILE** (failed streams exit 0): `-o` file has content AND `git diff --stat` shows the expected surface.
    - **Stalled:** alive + under hard timeout = running (retrying). Hard timeout + empty `git diff` = one stalled attempt. 2 consecutive = Codex stalled. Never declare stalled before the hard timeout.
    - **One Codex task = one narrow patch** (≤1–3 files, allowed/forbidden files stated). No racing. Resume a fix pass with `codex exec resume <SESSION_ID>` (prefer the recorded id over `--last`).
    - **Fallback:** genuinely stalled → Claude takes over only fully-specified mechanical edits, labelled `authored_by: claude (codex stalled)`; NEVER judgment/design (the turn stops and waits). *(Unattended rounds override the stop-and-wait: fall back to an Opus 4.8 generator — Fable stays the non-author evaluator.)*
12. **Repair-replay double-gate → see `docs/research/gates.md` (the validation contract).** A deterministic change is `fixed` only when the SAME failing sample, replayed, flips buckets; "build passes" is never enough. No flip = not fixed. `turn_class: observability-only` if there's nothing to replay.
13. **Convert findings to fixes — forcing functions.** Rules 1–12 prevent bad changes; none forces impactful ones, so analysis commits masquerade as progress. Counterweights:
    - **Anti-drift cap:** at most ONE consecutive `observability-only` turn; the next Brief MUST change searcher behavior (proven by a rule-12 flip) or STOP + escalate — no third analysis turn.
    - **No orphan findings:** every finding → `owner` + `carry_to_round: N`. Deferred past it blocks new work until done or human-killed.
    - **Brief gate:** every Brief carries `searcher_behavior_change: yes | no`. Two consecutive `no` escalate.
    - **Epic escalation:** a finding too big for one round → `decision: epic`, ordered slices with their own gates. **Mechanical trigger:** the same `gap_class` in ≥3 samples/window OR ≥2 consecutive rounds → a MANDATORY epic; per-pool pins for that class are then forbidden. A systemic single fix beats N per-pool pins.
    - **Architecture-review trigger:** ≥2 consecutive rounds with NO growth in a genuine +EV `simSuccess` → a MANDATORY arch-level review in a fresh context, DUAL-BLIND like step 4. **FRAME AUDIT first** (the R13–R21 failure was a shared WRONG frame dual-blind can't catch): (1) is "coverage exhausted" measured on COMPLETE intake or only the admitted fraction? (audit `MEMPOOL_ROUTER_ADDRESSES` + MEV-Share, quantify `pending_filtered` vs `pending_received`); (2) are we conflating "not-backrunnable-BY-US" (posture) with "no opportunity" (market)? Record the frame answers, THEN localize the lever (`funnel | coverage | flow-admission | scanner-strategy | no-replicable-atomic-EV`). Template `docs/research/templates/architecture-review.md` + a per-firing handoff regenerated FRESH — never hardcode past rounds; the arch-review handoff MUST include the Architecture Coverage Matrix (12 axes); missing/blank = invalid handoff (hermes-gate blocks).
    - **Impact counterweight:** a round that shipped a clean analysis patch but changed nothing the searcher does is a **null round** — label it so.
14. **Multi-round = user-away autonomy.** >1 round means the user is NOT at the keyboard: self-serve architecture/scope calls (pick the option best for the extraction goal + PROCEED + **record the decision: choice + rationale + explicit not-doing**), do NOT block with `AskUserQuestion`. This includes **auto-firing the rule-13 arch review when its trigger hits — just run it; do NOT ask "should I run the architecture review?"**. Real stop conditions still wait for the human (out-of-envelope broadcast/funding/cap/key/standing-credit, CU-cap). The dated dual-live A/B, merge-on-proven-win, and gate-authorized literal `ab/*` cleanup are already authorized and are not ask points. **ENFORCED** by `scripts/hooks/guard-workflow-noask.py` (`touch /tmp/mev-workflow-active` at start; the hook blocks AskUserQuestion unless it names a real stop condition — full rationale in the hook's docstring).
15. **A status report is NOT a stop.** While `/tmp/mev-workflow-active` exists, every turn ends with either a work-continuing / self-re-invoking tool call OR an explicit real stop condition — reporting rides ALONGSIDE the next action, never instead of it. **ENFORCED** by `scripts/hooks/guard-workflow-nostall.py` (full rationale in the hook's docstring).
16. **Fable manual analysis is also a TEST of our tooling — codify its findings (hard).** The fresh fable analyst works from raw data with ad-hoc curl/jq, routinely finding where our permanent scripts are wrong (valuation artifacts) or missing a metric. When manual and canonical results disagree about tool correctness, a fresh non-author reviewer MUST adjudicate before the tool is changed. If both analyses agree the tool is wrong/incomplete, the loop MUST create the exact `tooling_defect` LearningCase, fix/extend the script, add a regression test, and cite its `codify_commit` **in this same round** (Codex writes, non-author gates). An agreed tool defect cannot be deferred to a historical backlog or a later round. Only defects explicitly referenced by the current Method Trace block this cycle; unrelated historical cases remain evidence, not a global stop. *(Honest: public-mempool membership for out-of-window txs + positive MEV-Share identification are NOT determinable from data we hold; `sender_flow` returns labeled-confidence proxies, never a fabricated proof.)*
    - **Method Trace (MANDATORY — the auditable frame, not the hidden chain-of-thought).** Every handoff
      whose `step1` block declares `fable_manual: yes` MUST end with a `## Method Trace`.
      **Missing Method Trace = invalid handoff** (`hermes-gate` enforces its presence + fields). The
      declaration, not prose, is the gate trigger. It is not "how it thought" — it is *what tools it ran,
      in what order it verified, what frame it judged by, which tool-miss it caught, and which rule Opus
      should learn.* This is the reusable project-method asset that trains/constrains Opus (distilled into
      `docs/distill/`), and it feeds the tooling-defect close loop: **if `tool_gap` != `none`, a
      `tooling_defect` LearningCase MUST be created and closed (`codify_commit` or `human_killed`) before
      cycle-close** (see rule 17 / the `tooling_defect` gate in `hermes-gate`).
      **When `task_class: architecture_review`, the Method Trace MUST be accompanied by a `## Architecture Coverage Matrix` (the 12 axes: strategy source / edge model / universe·admission / planner / quote·pnl / state·freshness / sim·replay / execution / safety·position / learning·auto-close / observability·tooling / non-goals·isolation) with a filled decision per axis — hermes-gate enforces it. Not a second framework; the matrix is the arch-review variant of the one Method Trace.**
      ```
      ## Method Trace
      task_class:       competitor_path | bundle_postmortem | architecture_review | replay_fixture | protocol_leg | implementation
      tools_used:       - <tool / command / file>   (structured tool BEFORE ad-hoc curl/jq)
      evidence_order:   1. structured tool output  2. raw tx/receipt/trace  3. repo code path  4. compared to taxonomy
      analysis_frame:   - strategy_kind first, edge_kind second
                        - comparable vs non-comparable before gap classification
                        - protocol constraint vs market PnL
                        - source visibility before funnel attribution
                        - fixed vs implemented via replay flip
      sanity_checks:    - gross/net/block-netting  - same tx/block/source verified
                        - pool-in-graph vs venue-adapter separated  - landed/stale/phantom hint  - no positive-leg-only PnL
      tool_gap:         none | <tool missed: native-ETH delta / one-leg inventory / protocol mint / stale hint / …>
      codify_next:      no | <field/test/gate/tooling_defect to add — name the target file/tool>
      distill_for_opus: <one reusable rule Opus should learn from this round>
      ```
      The captured traces are harvested into `docs/distill/method-traces.md` (`npm run distill-harvest`) — the single asset Opus reads to learn the project's methods.
    - **Not round-only.** The Method Trace contract applies to ANY Fable manual analysis, not just a Hermes
      round. A daily one-off (postmortem / architecture note / replay debug / planning analysis) goes in
      `docs/analysis/` and is validated round-agnostically with `npm run method-trace-check -- <md>` (no
      step1 / 5-analysis scaffolding); harvest collects both `docs/analysis/` and the round reports. A
      Hermes round is the heavy special case of the same Method Trace.
17. **Manual-first, then canonical reconciliation (orchestrator-side companion to 16).** Follow
`CLAUDE.md` reconcile-after: make the independent manual/causal judgment first, then RUN the canonical
tool and compare. Do not anchor the analyst by showing it the script verdict first. A scratchpad probe run a
second time, or mapping to an existing taxonomy, MUST be codified before cycle-close (same teeth as 13/16).

## Boundary (CLI-orchestrated by Claude)
Claude orchestrates from the terminal (Bash), NOT via any in-app agent tool or `/codex`. Codex = generator (rule 11; judge by the `-o` file + `git diff --stat`, never scrolling stdout; the Hermes md is the formal ledger). Claude = orchestrator + evaluator (runs gates, reviews the diff, commits — the non-author skeptic). **No nested Claude via shell** (`claude -p` crashes the session). **EXCEPTIONS:** the fresh fable-5 blocker-finder (Rounds step 4) and the one-shot fresh non-author A/B adversarial reviewer required above. Discipline: one turn on demand, not a self-spinning loop; all broadcasts remain inside `CLAUDE.md` Safety Rule 1 and its dated envelope.
