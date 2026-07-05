# HERMES — Live-Run Collaboration Protocol (operating runbook)

> **Load this when you are running a live-run / Hermes / handoff round** (the autonomous routines in
> `docs/research/autonomous-*.md` read it). It is NOT always-on: a normal interactive task doesn't need
> it — that's why it lives here and not in `CLAUDE.md`. `CLAUDE.md` (behavioral base + Mission + Safety
> Rules) and `docs/research/gates.md` (the validation contract, rule 12) are the companions.
>
> Hermes is the fixed collaboration + decision record between **Claude** and **Codex** after each live
> run (a 作战记录 + 决策协议, not a product). One markdown file per run; GitHub is the shared state.
> Rule **numbers 1–17 are load-bearing** — hooks + routines reference rules 11/12/13/14/15 by number.
> Never renumber; compress in place. Safety Rules (broadcast = human gate) live in `CLAUDE.md` and
> override everything here.

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
`scripts/deploy-node.sh` (self-bootstraps from git): recovers the full working env from the **running process** → forces `SEARCHER_DRY_RUN=1` (override via env/markers) → **ABORTS if DRY_RUN can't be ensured (broadcast guard)** → tar-backs-up dirty files → `git reset --hard origin/main` → build → restart → verifies the restarted env. Durable flags are marker-gated on the node (`.deploy-live`, `.bribe-all-above-gas`) so they survive the recover-from-process rebuild. Never restart by hand without this guard ([[project-node-env-dryrun-guard]]). Never spawn a 2nd searcher instance. Multiple concurrent sessions run on this repo — `git log` + check the node marker before any deploy, and never interrupt an active live measurement window. Local run logs go to `MEV/logs/` (gitignored), not `$HOME`.

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
   (dual-blind)  the rule-9 nodding risk): a FRESH fable-5 sub-agent (Agent tool, model:fable, chain+code) → A
                 (kept from Codex); Codex, handed ONLY raw material as DATA → B blind to A. Agree = high-confidence;
                 differ = the disagreement is the signal. Only the Brief drives code.
5. IMPLEMENT     Codex writes → Claude review ↔ Codex fix (≤3 passes) → Final Approval or explicit stop.
6. GATE          deterministic → local FORK/REPLAY flip confirms (rule 12, docs/research/gates.md; no flip = not fixed);
                 non-deterministic (latency/inclusion/economics/bid/mempool) → record with carry_to_round, next
                 round's metrics decide.
7. CARRY         Next round READS this round's conclusion + open findings FIRST; resolve any finding past its
                 carry_to_round before new analysis (rule 13).
```

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
    - **Architecture-review trigger:** ≥2 consecutive rounds with NO growth in a genuine +EV `simSuccess` → a MANDATORY arch-level review in a fresh context, DUAL-BLIND like step 4. **FRAME AUDIT first** (the R13–R21 failure was a shared WRONG frame dual-blind can't catch): (1) is "coverage exhausted" measured on COMPLETE intake or only the admitted fraction? (audit `MEMPOOL_ROUTER_ADDRESSES` + MEV-Share, quantify `pending_filtered` vs `pending_received`); (2) are we conflating "not-backrunnable-BY-US" (posture) with "no opportunity" (market)? Record the frame answers, THEN localize the lever (`funnel | coverage | flow-admission | scanner-strategy | no-replicable-atomic-EV`). Template `docs/research/templates/architecture-review.md` + a per-firing handoff regenerated FRESH — never hardcode past rounds.
    - **Impact counterweight:** a round that shipped a clean analysis patch but changed nothing the searcher does is a **null round** — label it so.
14. **Multi-round = user-away autonomy.** >1 round means the user is NOT at the keyboard: self-serve architecture/scope calls (pick the option best for the extraction goal + PROCEED + **record the decision: choice + rationale + explicit not-doing**), do NOT block with `AskUserQuestion`. This includes **auto-firing the rule-13 arch review when its trigger hits — just run it; do NOT ask "should I run the architecture review?"**. Real stop conditions still wait for the human (go-live/broadcast, CU-cap, destructive). **ENFORCED** by `scripts/hooks/guard-workflow-noask.py` (`touch /tmp/mev-workflow-active` at start; the hook blocks AskUserQuestion unless it names a real stop condition — full rationale in the hook's docstring).
15. **A status report is NOT a stop.** While `/tmp/mev-workflow-active` exists, every turn ends with either a work-continuing / self-re-invoking tool call OR an explicit real stop condition — reporting rides ALONGSIDE the next action, never instead of it. **ENFORCED** by `scripts/hooks/guard-workflow-nostall.py` (full rationale in the hook's docstring).
16. **Fable manual analysis is also a TEST of our tooling — codify its findings (hard).** The fresh fable analyst works from raw data with ad-hoc curl/jq, routinely finding where our permanent scripts are wrong (valuation artifacts) or missing a metric. When it exposes a gap, the loop MUST fix/extend the script (Codex writes, Claude gates) — treat it like a rule-13 finding (`owner` + `carry_to_round`, BLOCKS cycle-close). *(Honest: public-mempool membership for out-of-window txs + positive MEV-Share identification are NOT determinable from data we hold; `sender_flow` returns labeled-confidence proxies, never a fabricated proof.)*
17. **Tool-first, then codify-the-recurring-probe (orchestrator-side companion to 16).** BEFORE hand-writing a scratchpad analysis, CHECK the toolset (`analysis/src/cli/*`, the LearningCase `PrimaryGap` store `analysis/src/learning/learning-case.ts`, `redact-live-run`, `analysis/src/pnl/*`) and RUN/EXTEND it. A scratchpad analysis run a SECOND time, or mapping to an existing taxonomy, MUST be codified before cycle-close (same teeth as 13/16).

## Boundary (CLI-orchestrated by Claude)
Claude orchestrates from the terminal (Bash), NOT via any in-app agent tool or `/codex`. Codex = generator (rule 11; judge by the `-o` file + `git diff --stat`, never scrolling stdout; the Hermes md is the formal ledger). Claude = orchestrator + evaluator (runs gates, reviews the diff, commits — the non-author skeptic). **No nested Claude via shell** (`claude -p` crashes the session). **EXCEPTION — the fresh fable-5 blocker-finder** (Rounds step 4): each round spawns ONE fresh fable sub-agent via the **Agent tool with `model: "fable"`** — the only sanctioned second-Claude spawn. Discipline: one turn on demand, not a self-spinning loop; go-live/broadcast stays a human gate (`CLAUDE.md` Safety Rule 1).
