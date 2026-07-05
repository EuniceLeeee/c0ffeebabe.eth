# MEV Flash Arbitrage — Project Instructions

> Compatible with Claude Code (`CLAUDE.md`) and Codex (`AGENTS.md`).
>
> **Volume discipline (adopted from the distill kit).** This file is always-loaded doctrine — keep it
> imperative and lean. Dated decisions, closed findings, and dead-ends live in `docs/decision-log.md`,
> NOT inline here. When a rule accretes a "we observed X on 2026-0Y" story, the *doctrine* stays; the
> *story* moves to the decision-log. Rule **numbers** are load-bearing (hooks + autonomous rounds
> reference rules 11/12/13/14/15 by number) — never renumber; compress in place.

## Project Overview

### Mission / North Star — every session, every window, every operation stays anchored to this
1. **Ship to production.** The goal is a **profitable, live on-chain arbitrage searcher**. Everything is a step toward that first production go-live. (Broadcast stays a hard human gate — Safety Rule 1 — but the *direction* is always: get closer to a real, +EV live bundle.)
2. **Learn from other searchers to find OUR gaps.** Systematically study competitors' winning on-chain paths and classify what **we** are missing:
   - **pool gap** — a venue/pool we don't index (e.g. the Uni v4 singleton);
   - **path gap** — pools we have but can't route / close the loop through;
   - **unanticipated gap** — we saw the opportunity but lost it somewhere unexpected (e.g. latency, or a flow-admission drop before the funnel).
3. **Loop:** competitor cross-reference → classify our gap → close it → move closer to production. **No work item counts unless it moves a real gap toward closed, or moves us toward a live +EV bundle.** Do not drift.

Study is *in service of* the mission. Primary case study: **wstUSR depeg arbitrage** by `0xE08D97e151473A848C3d9CA3f323Cb720472D015`.
Reference tx: `0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970` (block 24710788).

### Arbitrage Flow

```
Morpho (flash loan 3,533.49 wstUSR)
  → Fluid Vault Position #1: deposit 1,766.74 wstUSR, borrow 1,839.93 USDC
  → Fluid Vault Position #2: deposit 1,766.74 wstUSR, borrow 1,839.93 USDC
  → Total: 3,679.86 USDC → Sky PSM: USDC → DAI
  → Uniswap/Curve: DAI → USDT → sUSDS → DOLA
  → DOLAwstUSR pool: DOLA → 3,806.51 wstUSR → Repay Morpho: 3,533.49 wstUSR
  → Profit: ~273.03 wstUSR + ~0.078 WETH (parallel arb leg)
```

### Key Addresses

| Contract | Address |
|---|---|
| MEV Bot (original) | `0xE08D97e151473A848C3d9CA3f323Cb720472D015` |
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| Fluid Vault (wstUSR/USDC), wstUSR | See `src/Constants.sol` |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| DAI | `0x6B175474E89094C44Da98b954EedeAC495271d0F` |
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |

---

## Coding Guidelines

**1. Think before coding.** State assumptions explicitly; if multiple interpretations exist, present them — don't pick silently. For a non-trivial task, list the 3 likeliest-wrong implicit assumptions before starting.

**2. Simplicity first.** No features beyond what was asked; no abstractions for single-use code. If 200 lines could be 50, rewrite.

**3. Surgical changes.** Don't "improve" adjacent code/comments/formatting. Match existing style. Every changed line traces to the request. Verify claims against CODE, not memory (verify-before-claim). **Never `rg -rn`/`-rln`** — `-r` is `--replace` and silently corrupts reads.

**4. Goal-driven execution.** Turn tasks into `[step] → verify: [check]` pairs.

**5. Agent autonomy.** Run the analysis/redaction/`tail`/`jq`/report commands yourself — don't ask the user to do mechanical local steps. Share **redacted** artifacts (redact first, then analyze the redacted output); preserve public on-chain evidence (tx hashes, pools, token addresses) unless stricter redaction is asked. Whenever a `*.md` is updated, commit + push it in the same turn (raw logs / JSONL / secrets / `.env` never committed).

**6. Live-run follow-up.** After a run, find the latest events JSONL + log, generate redacted artifacts, and analyze without waiting. Prefer structured JSONL over log greps; `pipeline_dropped` is the source of truth for loss attribution. First pass is zero-CU where possible (JSONL, redacted logs, planner code, graph/pool registries, fixtures before RPC/traces). If the dominant drop is `no_candidate_plans`, classify the blocker: flash borrowability / path template / token-graph coverage / unsupported shape (LP, borrow-lend, router-specific).

**6a. Competitor-loss analysis — the canonical flow (run the tools, don't guess).** Every "a competitor got value we didn't" event runs ONE fixed flow (see the `bundle-postmortem` skill for the decision tree; do NOT invent a parallel path):
1. **SCOPE both, same shape:** a bundle WE submitted that lost (`bundle_not_included` → `bundle-postmortem --tx <ours>`) AND an opportunity we MISSED (`not_seen` → census produces a postmortem-shaped report on the competitor's tx). Neither is skipped.
2. **FILTER non-comparable winners FIRST** (else it's noise). Only `atomic_loop` (a closed loop returning to a priced token in-tx) is comparable to our atomic sim. REJECT: `sandwich`, `one_leg_inventory` (one-way swap, profit realized off-chain / CEX-DEX — decisive check: the winner's Swap pushed the pool tick PAST the pre-triggering-swap `slot0` tick), plain transfers, JIT-LP → `route_gap_decisive=false` + `non_comparable_winner`; our sim was RIGHT and correctly lost. Codified in bundle-postmortem (`winner_style`).
3. **AUTO-IMPROVE from the tool's verdict** — classify + close (§6b).
4. **INCONCLUSIVE → MANUAL escalation → codify** (§6b meta-loop / rule 16).

```bash
cd analysis && npm run bundle-postmortem -- --events <events.jsonl> --tx <our tx, prefix ok> \
  --rpc http://127.0.0.1:8545 --out /tmp/pm.json
```
Events + local reth live on the NODE — run via SSM; the events path is the running process's `SEARCHER_EVENTS_PATH` (read `/proc/<pid>/environ`, e.g. `/var/log/mev/events/searcher-live.jsonl`). The postmortem answers a fixed tree: one-shot validity (a mempool-route bundle pins ONE target block; "not included after the swap landed" is EXPECTED) → builder reach (Flashbots relay auto-shares to BuilderNet, so `flashbots: ACCEPTED` ⇒ BuilderNet saw it) → auction outcome (`outbid` = winner payment > our bid; `route_gap_decisive` = winner payment > our FULL sim gross ⇒ coverage gap, no bid could have won) → gap class vs `runtime-graph-pools.json`.

**6b. Auto-improve loop (forcing function) — analyze → classify → CLOSE the gap.** Trigger: a same-block competition loss (6a `outbid`/`route_gap_decisive`) OR an opportunity-miss vs a watched competitor (`not_seen`). Then, without waiting: classify + close per class, validate with a rule-12 fixture flip.
- **pool gap** (winner used a venue/pool we don't index) → resolve poolKey + backfill + merge into the graph. **force-include is the band-aid, not the cure**: every auto-appended force-include is a signal the SCORER mis-ranked a pool. Same-class force-include ≥3 → escalate to fixing scoring (rule 13), stop pinning. The principled fix is **arb-relevance scoring** (does this pool close a loop?), an EPIC — see memory `project-pool-scoring-arb-relevance-epic`.
- **path gap** → add the route/template. **execution-adapter gap** → venue-adapter epic. **detection gap** → detection/admission fix. **pure outbid** (winner < our full gross but > our bid) → economics/bid-policy call, a bid-posture change is a human gate (Safety Rule 1).
- **UNCLASSIFIABLE loss (the tool's blind spot) → MANDATORY manual escalation.** Auto-close closes 0 yet we demonstrably LOST ⇒ the tool hit a class it can't name. "Auto-analysis empty" is itself a finding, never a shrug. Package {postmortem JSON + auto-close result + our sim/bid + winner touchedVenues/builderPayment} → a FRESH analyst (Fable PRIORITY, Opus 4.8 fallback) names the missed class → CODIFY it back into the tool (rule 16). A `pending-manual-analysis` package left unanalyzed BLOCKS cycle-close.

Executable improve-half (a `route_gap_decisive` loss):
```bash
cd listener && npm run auto-close-route-gap -- --report /tmp/pm.json --rpc http://127.0.0.1:8545  # backfill v4 poolId + append force-include-poolids.json (idempotent)
scripts/deploy-node.sh   # load the pool live; confirm banner forceIncludePoolIds merged>0 + poolId in the graph
```
**Automation state (honest):** the *judgment* is codified into two commands; the *orchestration* (a watcher firing 1→2→3 off `bundle_not_included`) is NOT yet auto-triggered — run on-demand / from the hourly cron. Do not claim "fully automatic". Governance: every triggered loss with a **closable** gap becomes a tracked item (`owner` + `carry_to_round`) and BLOCKS cycle-close until closed or human-killed. Auto-deploy IS sanctioned in this chain (user-approved — see `decision-log` D-002); it requires mode-preservation verify + debounce (≤1 deploy/window). Dated closed instances (e.g. the native-ETH v4 pool gap `0xa32b646c`) live in `docs/decision-log.md`.

**7. Generator / Evaluator split — DEFAULT for all code work.** Codex (gpt-5.5 xhigh) is the generator; Claude authors the brief and is the **non-author evaluator** of the diff (rule 11 protocol). Rounds depend on the orchestrating model:
- **Fable 5 (3 steps):** Claude plans → Codex writes → Claude reviews + gates + commits.
- **Opus 4.8 (5 steps):** Claude plans → Codex reviews the plan → Claude finalizes → Codex writes → Claude reviews + gates + commits (extra plan-review round vets the design before code).

Applies to normal single-turn requests too. Sign commits as the ACTUAL orchestrating model. **Exception (rule 11 fallback):** Claude may take over only **fully-specified mechanical edits** (brief pins exact file/anchor/code) or **evaluator gate-strengthening**, labelled as such — never net-new design/judgment code (judgment needs a non-author reviewer).

---

## Development Workflow

### Node Deploy — run BEFORE each dry-run (latest code on the node, safely)

The EC2 node picks up code only on **restart**, and `/opt/MEV` can drift behind `main`. Deploy latest with the one repeatable, broadcast-safe op:

```bash
aws ssm send-command --instance-ids i-0ff908dedeec9ebc6 --document-name AWS-RunShellScript \
  --parameters 'commands=["git -C /opt/MEV fetch origin -q && git -C /opt/MEV show origin/main:scripts/deploy-node.sh | sudo bash"]'
```

`scripts/deploy-node.sh` (self-bootstraps from git): recovers the full working env from the **running process** → forces `SEARCHER_DRY_RUN=1` (override via env/markers) → **ABORTS if DRY_RUN can't be ensured (broadcast guard)** → tar-backs-up dirty files → `git reset --hard origin/main` → build → restart → verifies the restarted env. Durable flags are marker-gated on the node (`.deploy-live`, `.bribe-all-above-gas`) so they survive the recover-from-process rebuild. Never restart by hand without this guard ([[project-node-env-dryrun-guard]]). Never spawn a 2nd searcher instance (corrupts the shared events JSONL + graph dump) — use the single service, mark a window boundary. Multiple concurrent sessions run on this repo — `git log` + check the node marker before any deploy, and never interrupt an active live measurement window.

### Historical Replay

Do NOT assume block `24710787` or the final state of `24710788`. First read `docs/historical-replay.md` (source of truth for the ordered tx list + DOLA/wstUSR pool impact). The accurate target is the **pre-state of tx index 8 in block 24710788**: 24710787 end state → apply tx index 0…7 → simulate our BotVM / FlashArb at tx index 8 pre-state.

### Fork Testing / Trace / Discovery

```bash
forge test --fork-url $MAINNET_RPC_URL --fork-block-number 24710787 -vvvv           # all fork tests
forge test --match-test testReplayArbitrage --fork-url $MAINNET_RPC_URL --fork-block-number 24710787 -vvvv
cast run <txhash> --rpc-url $MAINNET_RPC_URL                                          # trace a tx
cast 4byte-decode <calldata>                                                         # decode calldata
cast call <token> "balanceOf(address)(uint256)" <addr> --rpc-url $MAINNET_RPC_URL --block 24710787
cast receipt <txhash> --rpc-url $MAINNET_RPC_URL --json | jq '.logs'                 # logs / address discovery
```

For correctness / trace-diff / reproduction review, load the **`mev-review` skill** (staged trace→state→code methodology + the failure-mode checklist).

---

## Hermes — Live-Run Collaboration Protocol

Hermes is the fixed collaboration + decision record between **Claude** and **Codex** after each live run (a 作战记录 + 决策协议, not a product). One markdown file per run; GitHub is the shared state.

### Mechanics

- One file per run: `docs/research/reports/live-run-<run_id>-hermes.md`. Two templates:
  - **Implementation cycle** (known fix → code → gate → merge; most work): LEAN `docs/research/templates/hermes-impl-cycle.md`.
  - **Live-run analysis cycle** (run → drop attribution → competitor cross-ref → decide): full `hermes-live-run.md`.
  The governance hard-rules (11/12/13) apply to both; the lean template just drops the analysis-only sections.
- **Step 1 — competitor cross-reference (MANDATORY, before any conclusion).** Use the EXISTING scripts (iterate, don't reinvent), over the same block window, on the local reth node (zero Alchemy CU). Applies to EVERY measured window — including a pure metrics/deploy window (a metrics gate answers "did we regress"; Step-1 answers the north-star "what did competitors capture that we missed"). **Precondition: `SEARCHER_EVENTS_PATH` set before the window** (verify the events file is being written right after the banner) — a window without structured JSONL is not a valid Hermes window.
  - `analysis live-loss --watch <WATCHLIST> --events <jsonl> --rpc http://127.0.0.1:8545` → per-EOA `seenScope`/`primaryReason` (`not_seen`/`seen_but_lost`) + `poolInOurGraph`.
  - `analysis live-loss --competitor-scan --events <jsonl> --rpc <local-reth>` → per-drop victim-real-block competitor take. (`--coverage`/`analyzeBlock` still have the target-block-vs-real-block bug — [[project-competitor-scan-tool]].)
  - **WATCHLIST (seed):** `0xc0ffeebabe5d496b2dde509f9fa189c25cf29671` (coffeebabe), `0xae2Fc483527B8EF99EB5D9B44875F005ba1FaE13`.
  - **Both agents run this and cite it** — a conclusion not grounded in the cross-reference is invalid. Each works from PRIMARY sources independently (raw script JSON + own on-chain trace), **never the other's curated facts/conclusion** (a correlated hand-off isn't independence). Secondary-source-validate ≥1 key tx via Alchemy/Tenderly.
  - **MANUAL analysis, not script-only:** the script's label is a hypothesis. Each round both agents hand-trace the watchlist's key txs (coffeebabe first): what the arb did + did it backrun a source swap (find the swap + its origin: public-router / MEV-Share / private / none=atomic) or is it atomic. A root-cause is INVALID unless it names the specific source swap (or proves none exists) from a manual trace.
- **ENFORCEMENT — the hermes-gate (forcing function).** After EVERY dry-run, `cd analysis && npm run hermes-gate -- <hermes-md>` MUST exit 0 before `Final Approval` / cycle-close. It reads a fenced ```step1``` block + validates a structured on-disk artifact (prose can't satisfy it) and enforces all **five** mandatory analyses: (1) standard `run_analysis` (funnel + `dominant_drop` + `events_source`); (2) per-watchlist-EOA comparison (each `swept:true` with method + `txCount`); (3) coffeebabe `analysis_mode:"full"` — EVERY tx hand-analyzed (pools classified in/out of `runtime-graph-pools.json` + `gap_class`); (4) other bots `analysis_mode:"sample"`; (5) **intake audit — the funnel-EXTERNAL lens** (the R13–R21 blind spot: router-allowlist + MEV-Share intake gaps never ENTER the funnel, so `pipeline_dropped`/pool-coverage can't see them). Every competitor tx carries `class` (`atomic`|`backrun`); a `backrun` carries `source_flow`; a PUBLIC backrun carries `seen_in_our_feed` (a public swap we never saw = a **flow-admission gap**, not a lost auction). Per-window `intake_audit = {pending_received, pending_filtered, mevshare_enabled}`. Doctrine the gate encodes: a "private" victim is NOT a human gate until the MEV-Share feed is ruled in (a config flag we control, ~72× mempool volume); "coverage exhausted" is INVALID without the intake fraction; an `atomic` competitor is a scanner/strategy gap, NOT a market ceiling; "dust" ≡ per-tx NET USD < $0.1; `maxPriorityFeePerGas=0` ≠ private orderflow. Record `hermes_gate: PASS` in the close.

### Rounds — the canonical live-run loop

Each round DISCOVERS the next blocker from competitors, fixes it, gates it, carries what it can't.

```
0. SLEEP-KEEPER  First step of every round. Codex background runs FREEZE on Mac sleep/screen-lock
                 ([[reference-codex-background-suspend]]) — ensure ONE persistent keeper (idempotent, PID-guarded):
                   KEEP=/tmp/mev-sleep-keeper.pid
                   if [ -f "$KEEP" ] && kill -0 "$(cat "$KEEP" 2>/dev/null)" 2>/dev/null; then echo "alive"; \
                   else nohup caffeinate -i -d -s -t 10800 >/dev/null 2>&1 & echo $! >"$KEEP"; fi
1. LIVE RUN      ~30-min window on the node. Deploy latest FIRST; do not analyze stale code.
2. AUTO ANALYSIS Run Facts + structured pipeline_dropped + before/after vs the prior round.
   THE QUESTION  (dual frame, NOT "which opp did we lose this window"):
                 • PRIMARY (funnel-INTERNAL): the nearest blocker to a genuine +EV simSuccess. Walk
                   opportunity_seen → plans → solverEntered → simSuccess (the last gate before broadcast).
                   simSuccess must be +EV, not dust (gas_estimate=0/bribe≈100% can make a bare simSuccess −EV);
                   if dust is the ceiling, ECONOMICS is the blocker — do not celebrate dust.
                 • COMPLEMENTARY (funnel-EXTERNAL): what competitors capture that never enters our funnel
                   (the primary question is blind to pools we don't index — step 3 is the only lens).
3. COMPETITOR    MANDATORY (Mission #2 + reality check): coffeebabe — MANUAL, every live-window tx;
   CROSS-REF     0xae2Fc4… — SAMPLED, sample size OUTCOME-DRIVEN (extend a thin window to hours; never
                 conclude a "true negative" from a starved sample — the R3 trap). Classify what WE missed
                 (pool/path/unanticipated) + confirm the primary blocker is on a REAL captured opportunity.
4. BLOCKER       Two BLIND-INDEPENDENT analyses of the same raw material, then compare (NOT analyze-then-
   (dual-blind)  review — that's the rule-9 nodding risk): a FRESH fable-5 sub-agent (Agent tool, model:fable,
                 chain+code) → conclusion A (kept hidden from Codex); Codex, handed ONLY raw material as DATA
                 (never A or Claude's picked facts), → conclusion B blind to A. Claude compares: agree =
                 high-confidence; differ = the disagreement is the signal (dig). Only the Brief drives code.
5. IMPLEMENT     Codex writes → Claude review ↔ Codex fix (≤3 passes) → Final Approval or explicit stop.
6. GATE          deterministic (path/pool/decoder/planner/adapter/graph) → local FORK/REPLAY flip confirms
                 (rule 12; no flip = not fixed); non-deterministic (latency/inclusion/economics/bid/mempool)
                 → record with carry_to_round, next round's live metrics confirm/deny.
7. CARRY         Next round READS this round's conclusion + open findings FIRST; resolve any finding past
                 its carry_to_round before new analysis (rule 13).
```

### Governance (hard rules — numbers are load-bearing, never renumber)

1. **Only `Claude Final Decision` / `Implementation Brief` drives code.** Never from scattered chat or the other agent's draft section.
2. `Claude Final Decision` is authoritative for the md; code review is mutual; Claude holds final approval.
3. Every claim is verified against code/data, not memory.
4. md updates auto-commit/push; raw log / JSONL / secrets / `.env` never committed.
5. One agent owns each section; do not overwrite another's.
6. **The review phase is a fix loop, not a one-shot.** After a Claude review, Codex fixes all blocking + in-scope P1 issues and re-verifies before handoff, or marks `deferred` with owner + reason + next cycle.
7. **≤3 review passes per cycle.** A pass = one Claude review + the Codex fix/defer response. "I agree" alone is not a valid handoff.
8. After pass 3, Claude writes `Final Approval` OR stops with an explicit `not approved / deferred / blocked` + owner. No endless ping-pong.
9. **Evaluator = whoever did NOT author the artifact** (rotates: Codex writes code → Claude evaluates; Claude writes a plan → Codex evaluates). The evaluator defaults to doubt and must ACT: record `ran_gate:` (the build/test/replay/diff-check it executed) + `finding:`. An approval with no executed gate and no finding is invalid (the Nodding-loop red flag — two different models does NOT prevent it).
10. **Hard caps before each turn** (anti-blowout): per-run CU budget, daily CU budget, the 3-pass cap. Record `cu_spent` per turn.
11. **Codex CLI = xhigh long-running generator (calling protocol).** Default `gpt-5.5 xhigh`, orchestrated as a slow worker over the local proxy (`127.0.0.1:1082`); the long xhigh stream retries connection a few times — give it time.
    - **Invocation — ALWAYS via `scripts/codex-run.sh`, NEVER hand-write the codex line.** The wrapper bakes in `< /dev/null` (stdin-hang guard), `caffeinate -i`, `-o`+`--json` to files, and a 30s launch watchdog. Brief lives in a FILE; run in background: `scripts/codex-run.sh <read-only|workspace-write> /tmp/codex-<pass>.brief.md /tmp/codex-<pass>`. **ENFORCED:** a PreToolUse(Bash) hook (`scripts/hooks/guard-codex-stdin.py`) BLOCKS a raw `codex … exec` lacking the wrapper or `< /dev/null`. Do NOT edit global `~/.codex/config.toml`.
    - **Timeout:** soft 10–15 min, hard 25–30 min (never 90s/180s — kills xhigh mid-think). Background + judge on exit.
    - **Judge success by the OUTPUT FILE** (failed streams exit 0): `-o` file has content AND `git diff --stat` shows the expected surface.
    - **Stalled:** alive + under hard timeout = running (retrying). Hard timeout reached + empty `git diff` = one stalled attempt. 2 consecutive = Codex stalled. Never declare stalled before the hard timeout.
    - **One Codex task = one narrow patch** (≤1–3 files, 1–2 verify commands, allowed/forbidden files stated). No racing (while Codex runs, Claude only monitors — no same-file edits, no 2nd `codex exec`). Resume a fix pass with `codex exec resume <SESSION_ID>` (prefer the recorded id over `--last`).
    - **Fallback:** genuinely stalled → Claude takes over only fully-specified mechanical edits, labelled `authored_by: claude (codex stalled)`. NEVER judgment/design (the turn stops and waits). Record `codex: landed | stalled` every turn. *(Unattended rounds override the "stop and wait": fall back to an Opus 4.8 generator — Fable stays the non-author evaluator.)*
12. **Repair-replay double-gate (anti-instrument-drift).** Every turn claiming to improve extraction ships a pinned replay fixture that flips, run BEFORE the next dry-run:
    - correctness/coverage/path → deterministic replay asserts the behavior flip (`no_candidate → plans>0` / pool routes / `sim.success`). No flip = not fixed.
    - latency → replay the SAME fixture before/after, compare per-stage `seg` ms (relative only; valid only if the harness faithfully reproduces the latency source).
    **`fixed` vs `implemented` (hard):** for a deterministic change, `implemented` = code + build/tests pass; **`fixed` = the SAME failing sample, replayed, shows the expected bucket transition.** "Build passes" is NEVER enough. Final Approval records `failing_sample / baseline_failure / fix_commit / replay_command / replay_result / expected_transition / verdict (fixed | implemented_not_validated | deferred)`.
    **Exempt from replay (use before/after METRICS):** pure latency, builder inclusion, live mempool visibility, external-RPC instability, competitive bid — gate on `prep_ms p50/p95` / `solverEntered` / `pendingReceived` / `not_seen` rate.
    A turn with no flippable/speed-up fixture is `turn_class: observability-only` and does NOT count as improving extraction. **Use the EXISTING harnesses:** correctness → `npm run searcher:planner`; latency/pipeline → `npm run searcher:replay-live-fixtures`. Replay gates the FIX; live dry-run still gates competitiveness — never conflate ([[feedback-validate-live-not-backtest]]).
13. **Convert findings to fixes — forcing functions** (the "diagnosed but never fixed" fix). Rules 1–12 prevent bad changes; none forces impactful ones, so analysis commits masquerade as progress while extraction stays untouched. Counterweights, all hard:
    - **Anti-drift cap:** at most ONE consecutive `observability-only` turn. The next Brief MUST change searcher behavior (proven by a rule-12 flip); if it can't, STOP and escalate to the human — no third analysis turn.
    - **No orphan findings:** every finding → a tracked item with `owner` + `carry_to_round: N`. Deferred past `carry_to_round` blocks new work until done or human-killed.
    - **Brief gate:** every Brief carries `searcher_behavior_change: yes | no`. Two consecutive `no` escalate.
    - **Epic escalation:** a finding too big for one round → `decision: epic` in the Findings Ledger, run as ordered slices with their own gates (`analysis-decode → replay → adapter → dry-run`) — NOT ground down in analysis rounds. **Mechanical trigger:** the same `gap_class` in ≥3 samples within one window OR ≥2 consecutive rounds → a MANDATORY epic; once epic'd, per-pool pins for that class inside the loop are forbidden. A systemic single fix beats N per-pool pins.
    - **Architecture-review trigger (production-needle):** ≥2 consecutive rounds close with NO growth in a genuine +EV `simSuccess` → a MANDATORY architecture-level review in a fresh independent context (NOT another point-fix), run DUAL-BLIND like step 4 (fresh fable → A, Codex → B from the same DATA package, compare). **MANDATORY FRAME AUDIT first** (the R13–R21 failure was a shared WRONG frame that dual-blind can't catch — A and B both inherit the framed handoff and converge on the blind spot): (1) is "coverage exhausted" measured on COMPLETE intake or only the admitted fraction? — audit pre-funnel intake (`MEMPOOL_ROUTER_ADDRESSES` `main.ts`, MEV-Share) and quantify `pending_filtered` vs `pending_received`; (2) are we conflating "not-backrunnable-BY-US" (posture) with "no opportunity" (market)? Record the frame answers, THEN localize the lever (`funnel | coverage | flow-admission | scanner-strategy | no-replicable-atomic-EV`). Template `docs/research/templates/architecture-review.md` + a per-firing handoff regenerated FRESH from CURRENT run data — never hardcode past rounds/conclusions.
    - **Impact counterweight:** a round that shipped a clean analysis patch but changed nothing the searcher does is a **null round** — label it so. The loop's job is more MEV caught, not clean commits.
14. **Multi-round = user-away autonomy.** >1 round means the user is NOT at the keyboard. When an architecture/scope decision arises that would otherwise escalate (rule 11 "stop and wait", rule 13 "escalate/epic"), do NOT block with `AskUserQuestion` — pick the option best for the extraction goal and PROCEED, then record the decision (choice + rationale + not-doing) in the Hermes md / Findings Ledger / CLAUDE.md / memory. This does NOT relax the real stop conditions (go-live/broadcast, CU-cap, destructive/irreversible — those still wait for the human).
    - **ENFORCED:** at the start of an away workflow, `touch /tmp/mev-workflow-active` (remove when done). While it exists, `scripts/hooks/guard-workflow-noask.py` BLOCKS `AskUserQuestion` UNLESS the question names a real stop condition. This includes auto-firing the rule-13 architecture review — just run it and record the verdict.
15. **A status report is NOT a stop.** The rule-14 hook stops *asking*; the subtler failure is writing a checkpoint report and YIELDING the turn — neither asking nor proceeding (a silent stall: the loop only advances when a tool call re-invokes you). While `/tmp/mev-workflow-active` exists, every turn MUST end with either (a) a work-continuing / self-re-invoking tool call, or (b) an explicit real stop condition stated as such. Reporting rides ALONGSIDE the next action in the SAME turn. **ENFORCED:** a `Stop` hook (`scripts/hooks/guard-workflow-nostall.py`) blocks the first stop and forces a scheduled continuation.
16. **Fable manual analysis is also a TEST of our analysis tooling — codify its findings (hard).** The fresh fable analyst works from raw data with ad-hoc curl/jq, so it routinely finds where our permanent scripts are wrong (valuation artifacts) or missing a metric (builder-payment floor, sandwich detection, public-vs-private classification). When it exposes such a gap, the loop MUST fix/extend the script (Codex writes, Claude gates) — treat it like a rule-13 finding (`owner` + `carry_to_round`, BLOCKS cycle-close). Goal: every hand analysis becomes a one-command capability. *(Stated honestly, not faked: public-mempool membership for out-of-window txs and positive MEV-Share identification are NOT determinable from data we hold; `sender_flow` returns labeled-confidence proxies, never a fabricated proof.)*
17. **Tool-first, then codify-the-recurring-probe (orchestrator-side companion to 16).** BEFORE hand-writing a scratchpad analysis, CHECK the existing toolset (`analysis/src/cli/*`, the LearningCase `PrimaryGap` taxonomy + store `analysis/src/learning/learning-case.ts`, `redact-live-run` drill-downs, `analysis/src/pnl/*`). If the question maps to an existing tool/schema, RUN or EXTEND it — do NOT re-derive by hand. A scratchpad analysis run a SECOND time, or producing a finding that maps to an existing taxonomy, MUST be codified into the permanent tool before cycle-close (same teeth as 13/16). Hand-scripting the same class twice is a review miss.

### Boundary (CLI-orchestrated by Claude)

Claude orchestrates from the terminal (Bash), NOT via any in-app agent tool or `/codex`. Codex = generator (rule 11 protocol; judge by the `-o` file + `git diff --stat`, never scrolling stdout; the Hermes md is the formal ledger). Claude = orchestrator + evaluator (runs gates, reviews the diff, commits — the non-author skeptic). **No nested Claude via shell** (`claude -p` crashes the session — never shell it). **EXCEPTION — the fresh fable-5 blocker-finder** (Rounds step 4): each round spawns ONE fresh fable sub-agent via the **Agent tool with `model: "fable"`** (cold context, avoids long-session degradation) — the only sanctioned second-Claude spawn.

Discipline: **one turn on demand, not a self-spinning loop.** Run 2–3 turns before adding `ScheduleWakeup` pacing. Hard backstops apply (rate window + Alchemy CU cap); go-live/broadcast stays a human gate.

---

## Safety Rules

1. **Broadcasting transactions to mainnet (and signing with the private key) requires explicit user authorization.**
   The user authorized live bundle submission (2026-06-10) and, on 2026-07-03, authorized a **BOUNDED-LIVE test**: the searcher may broadcast autonomously ONLY inside a hard, script-enforced envelope, so worst-case loss is bounded to a tiny test wallet.
   - **The bounded-live envelope (all must hold, else stay dry-run):** live is gated by the node-side marker `/opt/MEV/.deploy-live`; `deploy-node.sh` REFUSES live unless the signing wallet balance `≤ MEV_LIVE_MAX_WALLET_ETH` (default 0.2 ETH) AND `SEARCHER_EV_GATE=1`. Flash-loan arbs are atomic (a bad arb reverts, principal never at risk) + the BotVM executor holds no standing funds → max loss is the test wallet's gas/bribe balance. Verified 2026-07-03: signer `0xb8578B6de173C8554FF0390dB5a7effA567DDA3c` = 0.0027 ETH, BotVM `0x4aF9495C…5BCe` = empty.
   - **Still hard (never autonomous — need a fresh explicit human OK):** funding the test wallet above the cap, raising `MEV_LIVE_MAX_WALLET_ETH`, swapping in the real-funds private key, any broadcast outside the bounded envelope. The autonomous cron must NEVER do these.
   - **Safety valve:** a bounded-live round reads the test-wallet balance at the start; if it dropped below 50% of its starting balance, STOP, `rm /opt/MEV/.deploy-live` (revert to dry-run), and report.
   - Even bounded, only broadcast a bundle that passed a **profitable on-fork/EV-gated simulation** (`sim.success` + net-EV + the assert-balance flash-repay guard). Never broadcast from an unverified or half-modified pipeline. **Default is still dry-run** (Rule 2); live is the marked exception.
2. Default to dry-run (`SEARCHER_DRY_RUN=1` → `DryRunBundleRouter`); flip to production only deliberately.
3. All correctness testing happens on local forks (`anvil` or `forge test --fork-url`).
4. Do not commit `.env` files containing real RPC URLs or private keys.
5. Scripts default to `--broadcast` disabled; require `--broadcast` explicitly.
6. **Neutral, legitimacy-framed wording — in artifacts AND in the live conversation** (avoid false safety-review triggers). This is authorized, defensive on-chain **arbitrage research** — mainnet fork + dry-run, reads public chain data, targets/harms no user, broadcast is a hard human gate. The safety flag is a real-time classifier on the live session + actions, so this applies to chat, briefs, and commit messages, not only committed files.
   - **Every Codex/agent brief opens with the one-line scope** (authorized arbitrage research; fork/dry-run; broadcast human-gated). Don't stack many sensitive terms in one message.
   - **Soften the prose (not code symbols):** bribe → priority-fee tip / builder payment; victim / victim swap → triggering swap / source swap; attack / exploit → arbitrage / strategy; extract / drain / steal → capture / realize / net; bare "go to production" → pair with "(dry-run today; broadcast is a human-gated step)". Code symbols (`victimApply`) and field terms ("backrun", "MEV") stay.
   - **Reduce generated VOLUME (the stronger lever)** — the classifier scores cumulative flagged content the session generates. Lead with structured data (tables, `tx→pools→profit`, `file:line`); cut narrative re-describing a competitor's actions; keep raw traces in scratchpad FILES, surface a terse conclusion; segment a long review into short scoped turns.
   - **Accept the fallback:** false positives aren't 100% avoidable; the auto-switch to a fallback model is the designed safety net — a sane split is judgment/orchestration on the fallback-capable model, code-gen on Codex.
   - **Accurate framing, NOT concealment:** never disguise, understate, or misrepresent what the code does.

---

## File Map

- `docs/decision-log.md` — dated decisions / verified facts / dead-ends (committed; the sink for the dated narratives this file used to inline). Read the ✅/❌ entries before re-opening a settled question.
- `.claude/skills/bundle-postmortem/` — the §6a/6b postmortem decision-tree tool.
- `.claude/skills/mev-review/` — reproduction / trace-diff review methodology (load for correctness-gate + replay work).
- `docs/distill/` — Fable/Opus dual-run distillation records + daily-compress + golden-set (do NOT auto-read; only when doing rule compression). `.claude/commands/{dualrun,compress}.md` drive it.
- `docs/research/` — Hermes round docs, handoff/relay routines, architecture reviews, templates.
- Source: `src/FlashArb.sol` (Morpho flash loan + Fluid + DEX routing), `src/Constants.sol` (all addresses), `src/interfaces/`, `test/WstUSRArb.t.sol` (fork replay), `script/Simulate.s.sol` (fork sim, no broadcast). The live searcher lives under `listener/src/searcher/`; analysis tooling under `analysis/src/`.
