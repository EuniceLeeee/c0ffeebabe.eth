# MEV Flash Arbitrage — Project Instructions

> Compatible with Claude Code (`CLAUDE.md`) and Codex (`AGENTS.md`).

## Project Overview

### Mission / North Star — every session, every window, every operation stays anchored to this
1. **Ship to production.** The goal is a **profitable, live on-chain arbitrage searcher**. Everything here is a step toward that first production go-live. (Broadcast stays a hard human gate — Safety Rule 1 — but the *direction* is always: get closer to a real, +EV live bundle.)
2. **Learn from other searchers to find OUR gaps.** The primary method is to systematically study competitors' winning on-chain paths and classify what **we** are missing:
   - **pool gap** — a venue/pool we don't index (e.g. the Uni v4 singleton);
   - **path gap** — pools we already have but can't route / close the loop through;
   - **unanticipated gap** — we saw the opportunity but lost it somewhere we didn't expect (e.g. latency killing a detected opp).
3. **Loop:** competitor cross-reference → classify our gap (pool / path / unanticipated) → close it → move closer to production. **No work item counts unless it moves a real gap toward closed, or moves us toward a live +EV bundle.** Do not drift from this.

Replicate and study on-chain arbitrage strategies on Ethereum mainnet forks (the study is *in service of* the mission above).
Primary case study: **wstUSR depegging arbitrage** executed by `0xE08D97e151473A848C3d9CA3f323Cb720472D015`.

Reference tx: `0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970` (block 24710788).

### Arbitrage Flow

```
Morpho (flash loan 3,533.49 wstUSR)
  → Fluid Vault Position #1: deposit 1,766.74 wstUSR, borrow 1,839.93 USDC
  → Fluid Vault Position #2: deposit 1,766.74 wstUSR, borrow 1,839.93 USDC
  → Total: 3,679.86 USDC
  → Sky PSM: USDC → DAI
  → Uniswap/Curve: DAI → USDT → sUSDS → DOLA
  → DOLAwstUSR pool: DOLA → 3,806.51 wstUSR
  → Repay Morpho: 3,533.49 wstUSR
  → Profit: ~273.03 wstUSR + ~0.078 WETH (from parallel arb leg)
```

### Key Addresses

| Contract | Address |
|---|---|
| MEV Bot (original) | `0xE08D97e151473A848C3d9CA3f323Cb720472D015` |
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| Fluid Vault (wstUSR/USDC) | See `src/Constants.sol` |
| wstUSR | See `src/Constants.sol` |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| DAI | `0x6B175474E89094C44Da98b954EedeAC495271d0F` |
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |

---

## Coding Guidelines

### 1. Think Before Coding

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If something is unclear, stop and ask.

### 2. Simplicity First

- No features beyond what was asked.
- No abstractions for single-use code.
- If you write 200 lines and it could be 50, rewrite it.

### 3. Surgical Changes

- Don't "improve" adjacent code, comments, or formatting.
- Match existing style.
- Every changed line should trace directly to the request.

### 4. Goal-Driven Execution

Transform tasks into verifiable goals:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

### 5. Agent Autonomy

- If logs, JSONL events, reports, or local scripts are available in this repo,
  the agent should run the needed analysis/redaction commands directly instead
  of asking the user to run them.
- When sharing live-run artifacts, generate redacted outputs first and analyze
  those outputs. Preserve public on-chain evidence such as tx hashes, pools,
  and token addresses unless the user explicitly asks for stricter redaction.
- Do not ask the user to do mechanical local steps like `tail`, `jq`, report
  generation, or redaction when the agent can do them safely in the workspace.
- Whenever a Markdown document (`*.md`) is updated by Codex or Claude, commit
  and push that Markdown change to GitHub in the same turn, while still keeping
  raw logs, raw JSONL events, secrets, and unrelated local files out of the
  commit.

### 6. Live-Run Follow-Up

- After a live or dry-run searcher run finishes, the agent should find the
  latest `/tmp/mev-live-*.log` and `analysis/events/searcher-*.jsonl`, generate
  redacted review artifacts, and analyze them without waiting for another user
  command.
- Prefer structured JSONL events over raw log substring counts. Use
  `pipeline_dropped` as the source of truth for loss attribution.
- If the dominant drop is `plan/no_candidate_plans`, dig until the blocker is
  classified into one of these buckets: flash borrowability, path template /
  closed-loop construction, token graph coverage, or unsupported strategy shape
  such as LP / borrow-lend / router-specific flow.
- This first pass should be zero-CU whenever possible: read JSONL, redacted
  logs, planner code, graph/pool registries, and local fixtures before using RPC
  or traces.
- Current known live-run bottleneck: filtered mempool + hybrid backend works and
  avoids the pending-hash `getTransaction` firehose; the active blocker is
  planner/path coverage, with repeated `plan/no_candidate_plans` on pool
  `0xEcABc504c30e1a081438B9F3b57Cc8F9dBDc1Ec6` and pair
  `0x39484A066aF5fEdFdef7ebf828E95CFB035fd1BC / WETH`.

### 7. Generator / Evaluator split — DEFAULT operating model (all code work, not just Hermes)

Codex (gpt-5.5 xhigh) is always the **generator/implementer**; Claude authors the brief
(scope, exact file/anchor list, allowed/forbidden files, verify commands) and is the
**non-author evaluator** of Codex's diff (rule 11 protocol: `codex exec -o <file>`, judge
by the output file + `git diff`, never stdout). **The number of rounds depends on which
Claude model is orchestrating** — check the session's own model id:

- **Fable 5 orchestrator (3 steps):**
  `Claude plans → Codex writes → Claude reviews + gates + commits.`
- **Opus 4.8 orchestrator (5 steps — add a plan-review round before code):**
  `Claude plans → Codex reviews the plan → Claude finalizes the plan → Codex writes →
  Claude reviews + gates + commits.` The extra `codex review`/`codex exec` plan-review
  round vets the design with the non-author BEFORE implementation (cheaper to catch a
  flawed plan than a flawed diff). Record the plan-review outcome in the brief/ledger.

- This applies to **normal single-turn requests too**, not only multi-round Hermes runs.
  Hermes just formalizes the same split into a ledger for live-run cycles.
- **Commit attribution:** sign as the ACTUAL orchestrating model (per the session's model
  id / the harness git rule), not whatever a handoff doc addressed — e.g. Opus 4.8 →
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Exception (rule 11 fallback):** Claude may take over only **fully-specified mechanical
  edits** (brief pins exact file/anchor/code) or **evaluator gate-strengthening** (e.g.
  adding a missing assertion to Codex's test), labelled as such. Claude does **not**
  author net-new design/judgment code without Codex unless the user explicitly says so —
  judgment needs a non-author reviewer.

---

## Development Workflow

### Node Deploy — run BEFORE each dry-run (get latest code on the node, safely)

The EC2 node's running searcher only picks up code changes on **restart**, and the node's
`/opt/MEV` can drift behind `main` (concurrent sessions). **Before starting/relying on a
dry-run for a measurement, deploy latest main** with the one repeatable, broadcast-safe op:

```bash
aws ssm send-command --instance-ids i-0ff908dedeec9ebc6 --document-name AWS-RunShellScript \
  --parameters 'commands=["git -C /opt/MEV fetch origin -q && git -C /opt/MEV show origin/main:scripts/deploy-node.sh | sudo bash"]'
```

`scripts/deploy-node.sh` (self-bootstraps from git) does: recover the full working env from
the **running process** → force `SEARCHER_DRY_RUN=1` (+ `SEARCHER_OPP_TTL_MS`, override via
env) → **ABORT if DRY_RUN can't be ensured (broadcast guard)** → tar-backup dirty files →
`git reset --hard origin/main` → build → restart → verify the restarted process env is
dry-run. Never restart the node searcher by hand without this guard ([[project-node-env-dryrun-guard]]).
Do NOT spawn a 2nd searcher instance for a dry-run — it corrupts the shared events jsonl +
graph dump; use the single service and mark a window boundary.

### Historical Replay

When replaying the reference arb tx, do not assume block `24710787` or the final
state of block `24710788` is enough. First read `docs/historical-replay.md`.
The accurate replay target is the pre-state of tx index 8 in block `24710788`:

```
24710787 end state
  → apply tx index 0
  → apply tx index 1
  → apply tx index 2
  → apply tx index 3
  → apply tx index 4
  → apply tx index 5
  → apply tx index 6
  → apply tx index 7
  → simulate our BotVM / FlashArb at tx index 8 pre-state
```

Use `docs/historical-replay.md` as the source of truth for the ordered tx list
and the DOLA/wstUSR pool impact.

### Fork Testing (primary workflow)

```bash
# Run all tests against mainnet fork
forge test --fork-url $MAINNET_RPC_URL --fork-block-number 24710787 -vvvv

# Run specific test
forge test --match-test testReplayArbitrage --fork-url $MAINNET_RPC_URL --fork-block-number 24710787 -vvvv
```

### Trace Analysis

```bash
# Trace the original tx
cast run 0xf88b498b835279ec9de597c7360ca21b7e8803053b442a04c5fc664e04e39970 --rpc-url $MAINNET_RPC_URL

# Decode calldata
cast 4byte-decode <calldata>

# Check token balances at block
cast call <token> "balanceOf(address)(uint256)" <address> --rpc-url $MAINNET_RPC_URL --block 24710787
```

### Address Discovery

```bash
# Get tx receipt and logs
cast receipt <txhash> --rpc-url $MAINNET_RPC_URL
cast receipt <txhash> --rpc-url $MAINNET_RPC_URL --json | jq '.logs'
```

---

## Hermes — Live-Run Collaboration Protocol

Hermes is the fixed collaboration + decision record between **Claude** and **Codex**
after each live run. It is a 作战记录 + 决策协议, not a product. One markdown file
per run holds the whole exchange; GitHub is the shared state both agents read/write.

### Mechanics

- One file per run: `docs/research/reports/live-run-<run_id>-hermes.md`. **Two templates
  by cycle type — pick the lean one by default:**
  - **Implementation cycle** (a known fix → code → gate → merge; most work): copy the LEAN
    `docs/research/templates/hermes-impl-cycle.md` (~5 sections: Brief · Plan-Review [Opus
    only] · Codex Pass · Repair-Replay Gate + Approval · Findings). This is what the
    2026-07-02 latency + v4 cycles actually used — do NOT fill live-run-analysis sections
    that don't apply.
  - **Live-run analysis cycle** (run searcher → drop attribution → competitor
    cross-reference → decide the fix): copy the full `hermes-live-run.md` (Run Facts /
    Auto Analysis / Competitor Coverage / Path-Leg Findings + the mandatory Step-1
    competitor cross-reference). Only these cycles need the heavy ceremony.
  The governance hard-rules (11 Codex protocol, 12 Repair-Replay, 13 forcing functions) apply
  to BOTH; the lean template just drops the analysis-only sections and the 6-way discussion rounds.
- Auto-generated inputs (follow the Live-Run Follow-Up rules — redact first, keep
  public on-chain evidence): redacted log, redacted JSONL summary, key tx links, AND
  the **mandatory Step-1 competitor cross-reference** (below).
- **Step 1 — competitor cross-reference (mandatory, before any conclusion).** Use the
  EXISTING scripts, iterate them if they fall short — do NOT reinvent. Over the same
  block window, on the local reth node (zero Alchemy CU):
  - **Applies to EVERY measured live/dry-run window — INCLUDING a pure latency/coverage
    "metrics-gate" or deploy window.** The rule-12 replay-vs-metrics exemption only chooses
    how the *fix* is validated; it does NOT exempt the window from Step-1. A metrics gate
    answers "did we regress"; Step-1 answers the north-star question "what did competitors
    capture in our blocks that we missed, and is it a pool/path/shape gap." Skipping Step-1
    because "it was only a metrics gate" is the exact miss that happened on cycle
    20260702-v3fork Slice 2 — do not repeat it. Minimum bar even when our events JSONL is
    absent: on the local node, get each WATCHLIST EOA's nonce delta over the window blocks,
    pull any tx it sent, and classify the pools touched as in/out of our runtime graph
    (`runtime-graph-pools.json`) — a per-tx manual trace, not just a counter.
  - **Precondition: `SEARCHER_EVENTS_PATH` MUST be set before a window is measured.** A
    window run without the structured JSONL is not a valid Hermes window for the
    `--watch`/`--competitor-scan` scripts (they key off our events) — you are forced onto
    log-counter scraping, which violates the "prefer structured JSONL" rule. Verify the
    events file is being written right after the startup banner.
  - **ENFORCEMENT (forcing function, not self-discipline): after EVERY dry-run, `cd analysis
    && npm run hermes-gate -- <hermes-md>` MUST exit 0 before you write `Final Approval` /
    close a cycle.** The gate reads a required fenced ```step1 block (`run_id`,
    `window_blocks`, `watchlist`, `artifact`, `method`) and validates a structured artifact
    on disk — prose in the md CANNOT satisfy it. It enforces all **four** mandatory
    post-dry-run analyses:
    1. **Standard analysis** — `run_analysis` with `funnel` (hints…solverEntered…),
       `dominant_drop`, and `events_source` (jsonl vs log-counter).
    2. **Competitor comparison** — per-watchlist-EOA `findings`, each `swept:true` with a real
       `method` (nonce delta / sweep) and `txCount`. No "not swept".
    3. **coffeebabe `0xc0ffee…29671` — EVERY tx hand-analyzed** (`analysis_mode:"full"`):
       `txs.length === txCount`, each tx = hashes in-window + pools classified in/out of
       `runtime-graph-pools.json` + `gap_class`.
    4. **`0xae2Fc483…FaE13` (+ other watchlist bots) — sampling analysis** (`analysis_mode:
       "sample"`): swept, `txCount` from the sweep, and if it traded ≥1 sampled tx analyzed to
       the same per-tx depth with a `sampleSize`.
    Accepts a `manual-onchain-trace` JSON manifest (events JSONL absent) or a directory of
    `live-loss --watch` `*.json` WatchReports. Record `hermes_gate: PASS` in the cycle close.
    This is the mechanical block for the 20260702-v3fork Slice-2 miss — a skipped/half-done
    analysis now fails a command, it is not left to memory.
  - `analysis live-loss --watch <WATCHLIST> --events <jsonl> --rpc http://127.0.0.1:8545`
    → what the watched MEV bots did in our window + `seenScope`/`primaryReason`
    (`not_seen` / `seen_but_lost`) + `poolInOurGraph`.
  - `analysis live-loss --competitor-scan --events <jsonl> --rpc <local-reth>` → per-drop
    victim-real-block competitor take (arb-signature). (`--coverage`/`analyzeBlock` still
    have the `target_block` vs real-block bug — see [[project-competitor-scan-tool]].)
  - **WATCHLIST (seed, extend as found):** `0xc0ffeebabe5d496b2dde509f9fa189c25cf29671`
    (coffeebabe), `0xae2Fc483527B8EF99EB5D9B44875F005ba1FaE13`.
  - **Both agents must run this and cite it.** A conclusion (Claude's or Codex's) that
    is not grounded in the competitor cross-reference is blind-guessing and is invalid.
  - **Secondary-source validation:** after the local-node analysis, re-sample ≥1 key tx
    via an independent source (Alchemy `$MAINNET_RPC_URL` / Tenderly) and confirm it
    agrees (e.g. distinct-pool count) before trusting the finding.
  - **Mandatory MANUAL competitor analysis (not script-only).** The script's `gap_type` /
    `seenScope` label is a **hypothesis, not a conclusion**. Each round, BOTH Claude and
    Codex must hand-analyze the watchlist competitor's key live-window txs (coffeebabe
    first) at the transaction level — full trace: what the arb actually did, and crucially
    **did it backrun a victim** (find the victim tx + its source: public-router / MEV-Share
    / private-orderflow / none=atomic), or is it a direct/atomic take. A root-cause
    (e.g. "needs atomic detection", "MEV-Share can't help") is INVALID unless it names the
    specific victim (or proves none exists) from a manual trace — not inferred from one
    pool/block probe. (2026-07-01: Claude wrongly concluded "atomic, MEV-Share can't save
    us" from a single-pool probe without tracing what the competitor backran.)
    - **Each agent works from PRIMARY sources, independently.** A read must come from
      (a) the analysis script's RAW output artifacts (the `watch-*.json` / `--competitor-scan`
      output itself, made available in-repo/scratchpad — NOT the prose summary) AND (b) its
      own manual on-chain trace. **Never from the other agent's curated facts or conclusion**
      — feeding Codex Claude's picked facts is a correlated hand-off, not independence
      (2026-07-01: Claude did exactly this). If Codex lacks chain access, it must still be
      handed raw DATA (block txs, indices, pools, script JSON) as data — never a conclusion —
      and reach its own verdict.
- Each agent writes **only its own sections**, never edits the other's. Each round =
  exactly **one core judgment + one next_action + one not_doing** (no walls of text).

### Rounds (per run) — the canonical live-run loop

Each round **DISCOVERS the next blocker from competitors, fixes it, gates it, and carries
what it can't**. This is the full loop (hermes-live-run.md). The lean impl-cycle template is
only a shortcut for when the blocker is ALREADY known (user-handed) and no competitor
discovery is needed.

```
1. LIVE RUN      ~30-min dry-run on the node. Deploy latest FIRST (scripts/deploy-node.sh);
                 do not analyze stale code.
2. AUTO ANALYSIS Run Facts + structured pipeline_dropped (source of truth) + before/after
                 vs the previous round's metrics.
3. COMPETITOR    MANDATORY — this is the blocker-DISCOVERY engine (Mission #2), not decoration:
   CROSS-REF       • coffeebabe 0xC0ffeEBABE5D496B2DDE509f9fa189C25cF29671 — MANUAL, EVERY
                     live-window tx (full trace: what the arb did + did it backrun a victim
                     + the victim's source, or prove atomic).
                   • 0xae2Fc483527B8EF99EB5D9B44875F005ba1FaE13 — SAMPLED.
                   • Each agent works from PRIMARY sources independently (raw script JSON +
                     own on-chain trace), never the other's curated facts.
                 → classify what WE missed: pool gap / path gap / unanticipated gap.
4. BLOCKER       A FRESH fable-5 sub-agent (Agent tool, model:fable — new context every round,
   (agree first)  avoids long-session degradation) does the competitor cross-ref + NAMES the core
                  blocker, returns it + evidence  →  Codex REVIEWS the blocker (agree on WHAT is
                  wrong before planning the fix)  →  Claude FINALIZES the blocker + writes the
                  Implementation Brief. Only the Brief / Final Decision drives code.
5. IMPLEMENT     Codex writes  →  Claude review ↔ Codex review/fix  (≤ 3 passes, then Claude
                 Final Approval or an explicit stop).
6. GATE          • deterministic blocker (path/pool/decoder/planner/adapter/graph) → a local
                   FORK/REPLAY flip CONFIRMS it's fixed (rule 12). No flip = not fixed.
                 • non-deterministic blocker (latency / inclusion / ECONOMICS / bid / mempool)
                   → NOT fork-provable. Record it in the round summary + Findings Ledger with
                   carry_to_round, and let the NEXT round's live metrics confirm or deny it.
7. CARRY         The next round's md READS this round's conclusion + open Findings FIRST, and
                 must resolve any finding past its carry_to_round before new analysis (rule 13).
```

### Governance (hard rules)

1. **Only `Claude Final Decision` / `Implementation Brief` drives code.** Never
   implement from scattered chat opinions or from the other agent's draft section.
2. `Claude Final Decision` is authoritative for the md; code review is mutual;
   Claude holds final approval.
3. Every claim is verified against code/data, not memory (verify-before-claim).
4. md updates auto-commit/push; raw log / raw JSONL / secrets / `.env` never committed.
5. One agent owns each section; do not overwrite another agent's section.
6. **The implementation review phase is a fix loop, not a one-shot review.**
   After any Claude review, Codex must fix all blocking issues and any P1
   explicitly scoped to the current cycle, then run verification before handoff.
   If Codex does not fix an issue, it must mark it as `deferred` with owner,
   reason, and the next cycle that will carry it.
7. The review/fix loop is capped at **three passes** per implementation cycle.
   A pass is one Claude review plus the corresponding Codex fix/defer response.
   "I agree" is not a valid handoff by itself; each pass must contain either
   code/docs fixes plus verification, or a documented defer.
8. After pass 3, Claude must either write `Final Approval` or stop the cycle with
   an explicit `not approved / deferred / blocked` decision and owner. Do not
   keep ping-ponging inside the same run file.
9. **Evaluator = whoever did NOT author the artifact under review** (the role
   rotates: Codex writes code → Claude evaluates; Claude writes a plan → Codex
   evaluates). The evaluator defaults to doubt and must **act, not just read**:
   its section must record `ran_gate:` (the build / test / replay / dry-run /
   diff-check it actually executed) and `finding:` (what it found, or
   "ran X, found nothing → pass"). An approval with **no executed gate and no
   finding is invalid** — that is the Nodding-loop red flag, and "two different
   models" does not prevent it (Claude + Codex nodded three rounds on `979d126`).
10. **Hard caps before each turn** (anti-blowout): per-run CU budget, daily CU
    budget (the Alchemy-side cap is the backstop), and the 3-pass review cap.
    Record `cu_spent` per turn so RPC/token blowout stays visible.
11. **Codex CLI = xhigh long-running generator (calling protocol).** Codex is the only
    generator, invoked over a local GFW proxy (`127.0.0.1:1082`); the **long `xhigh`
    inference stream** is the fragile part (codex retries/switches its connection method
    a few times before giving up — give it time). The earlier "stalls" were a bad
    calling posture (reading scrolling stdout, no output file, killed too early), NOT a
    reason to drop `xhigh`. **Default = `gpt-5.5 xhigh`, orchestrated as a slow worker:**
    - **Invocation (verified codex 0.142.4) — always output to files, never trust stdout:**
      ```
      codex -s workspace-write -a never exec -C /Users/eunice/src/MEV \
        --json -o /tmp/codex-<pass>.out "$BRIEF" > /tmp/codex-<pass>.events.jsonl 2>&1
      ```
      `-o` = final message (the result); `--json` events.jsonl = retry/connection evidence.
      Do NOT edit global `~/.codex/config.toml` (it also drives the desktop app).
    - **Timeout:** soft 10–15 min, hard 25–30 min. **Never 90s/180s** (kills xhigh
      mid-think → looks stalled). Run in background + judge on exit; do not poll-kill.
    - **Judge success by the OUTPUT FILE**, not stdout/exit-code (failed streams exit 0):
      success = `-o` file has content **and** `git diff --stat` shows the expected surface.
    - **Stalled definition (revised so xhigh isn't misjudged):** no last-message but
      process still alive AND under the hard timeout = **running** (it's retrying). Hard
      timeout reached **and** empty `git diff` = one **stalled attempt**. **2 consecutive
      stalled attempts = Codex stalled.** Never declare stalled before the hard timeout.
    - **One Codex task = one narrow patch:** ≤1–3 files, 1–2 verify commands; state
      allowed/forbidden files in the brief; no simultaneous analyze+design+code+long-md.
    - **No racing:** while Codex runs, Claude only monitors — must NOT edit the same
      files or start a second `codex exec` (prevents dueling patches when Codex is slow).
    - **resume within a cycle:** for a fix pass in the same Hermes cycle,
      `codex exec resume <SESSION_ID> ...` (prefer the recorded session id/thread over
      `--last`, which can attach to the wrong session).
    **Fallback:** if Codex is genuinely stalled, Claude MAY take over **only
    fully-specified mechanical edits** (Brief pins exact file/anchor/code — pure
    transcription), labelled `authored_by: claude (codex stalled)`. Claude must **NOT**
    take over **judgment/design** — no independent second party = blind-guessing; the turn
    **stops and waits**. Record `codex: landed | stalled` every turn. Rule: **judgment
    needs two actors; mechanical transcription may be one, but must be declared.**
12. **Repair-replay double-gate (also the anti-instrument-drift guard).** Every turn
    that claims to **improve extraction** must ship a pinned replay fixture that flips,
    run BEFORE the next dry-run:
    - correctness / coverage / path fix → **deterministic replay asserts the behavior
      flip** (`no_candidate → plans>0` / pool now routes / `sim.success`). No flip =
      not fixed, or the change was instrument-only.
    - latency fix → replay the **same** fixture before/after and compare `seg` per-stage
      ms. **Relative only** (harness-bound, not a live-absolute number), and valid ONLY
      if the harness faithfully reproduces the latency source (cold state / real
      backend) — otherwise the timing is misleading, do not trust it.
    **`fixed` vs `implemented` (hard — this is the definition of "fixed").** For a
    deterministic searcher change (path / pool / decoder / template / planner / adapter
    / graph): `implemented` = code written + build/tests pass; **`fixed` = the SAME
    failing sample, replayed locally, shows the expected bucket transition.** **"Build
    passes" is NEVER enough for these.** Final Approval MUST record, or the verdict is
    `implemented_not_validated` (not `fixed`):
    `failing_sample: / baseline_failure: / fix_commit: / replay_command: /
    replay_result: / expected_transition: / verdict: fixed | implemented_not_validated |
    deferred`. Examples of `expected_transition`: graph_gap → `pool_in_routing_graph
    false→true`; no_candidate_plans → `candidate_plans>0` (ideally `solverEntered>0`);
    v4 decode → poolId→token pair emitted; pricing → old wrong number gone + auditable
    artifact.
    **Exempt from replay (use before/after METRICS instead):** pure latency, builder
    inclusion, live mempool visibility, external-RPC/network instability, competitive
    bid — gate these on `prep_ms p50/p95` / `solverEntered` / `pendingReceived` /
    `cuProxyRpcCalls` / `not_seen` rate before vs after.
    A turn with **no flippable / speed-up fixture** is logged `turn_class:
    observability-only` and does **NOT** count as improving extraction (this is how the
    "polishing the microscope" drift gets caught — an instrument change has nothing in
    the searcher to replay). Correctness replay is cheap (planner-level, mostly no
    anvil); **replay gates the FIX, live dry-run still gates competitiveness** — never
    conflate the two ([[feedback-validate-live-not-backtest]]).
    **Use the EXISTING harnesses (don't build new):**
    - correctness / coverage / path → `listener/src/searcher/test/planner.ts`
      (`npm run searcher:planner`) — pure, deterministic, no anvil; asserts plan count +
      `no_candidate` classification. Pin real cases as named fixtures with on-chain
      provenance (see `REPLAY_FIXTURES` there).
    - latency / full-pipeline → `listener/src/searcher/test/replay-live-fixtures.ts`
      (`npm run searcher:replay-live-fixtures`) — record live with
      `SEARCHER_RECORD_LIVE_FIXTURES=1`, then replay for per-stage `stageMs` p50/p95
      (incl. preSolver) + revm profit equivalence (1 wei). This is the latency `seg`
      before/after gate — with the harness-fidelity caveat above.
13. **Convert findings to fixes — forcing functions (the "diagnosed but never fixed"
    fix).** The loop is strong at diagnosis and weak at shipping impact: every rule 1–12
    prevents *bad* changes, none forces *impactful* ones, so safe verifiable **analysis**
    commits masquerade as progress while the extraction goal (catch more MEV) stays
    untouched — the 2026-07-01 pattern (many analysis commits, searcher behavior
    unchanged). Counterweights, all hard:
    - **Anti-drift cap:** at most **one** consecutive `turn_class: observability-only`
      (analysis/tooling) turn. The **next Implementation Brief MUST change searcher
      behavior** (what it catches / builds / submits), proven by a Repair-Replay flip
      (rule 12). If it can't, the loop **stops and escalates to the human** — it does NOT
      run a third analysis turn.
    - **No orphan findings:** every finding in a Hermes md / review becomes a tracked
      item with `owner` + `carry_to_round: N`. A finding deferred past `carry_to_round`
      **blocks new analysis/tooling work** until done or explicitly killed by the human.
      "deferred" is not where findings go to die.
    - **Brief gate:** every Implementation Brief carries `searcher_behavior_change:
      yes | no`. Two consecutive `no` escalate to the human.
    - **Epic escalation (big architecture out of the 30-min loop):** a finding too big
      for one Hermes round (e.g. the v4 **searcher** adapter) must be escalated OUT of the
      loop into an `epic`, NOT ground down in more analysis rounds. Record
      `decision: epic` in the Findings Ledger and run the epic as ordered slices with
      their own gates: `analysis-decode → replay → adapter → dry-run`. Without this, the
      loop keeps polishing v4 sizing / poolId / profit-confidence and never ships the
      production adapter.
    - **Impact counterweight:** CLAUDE.md's culture is skeptic/verify/gate = good for
      correctness, biased against bold searcher changes. The loop's job is not clean
      commits; it is more MEV caught. A round that shipped a clean analysis patch but
      changed nothing the searcher does is a **null round**, and must be labelled so.
14. **Multi-round = user-away autonomy (architecture decisions self-served).** A
    workflow of **>1 round means the user is NOT at the keyboard.** When an
    architecture / scope decision arises that would otherwise escalate to the human
    (rule 11 "stops and waits", rule 13 "escalates to human" / "epic escalation"),
    do **NOT** block with `AskUserQuestion` — **pick the option you judge optimal for
    the extraction goal (catch more MEV) and PROCEED**, then **record the decision**
    (choice + rationale + explicit not-doing) where it belongs: Hermes md
    `Claude Final Decision` / Findings Ledger for run-scoped calls, **CLAUDE.md** for
    durable governance, memory for cross-session operating facts. The human reviews
    the whole run afterward. This does NOT relax the real stop conditions, which still
    wait for the human: **go-live / broadcast** (hard gate), spending beyond the
    per-run / daily **CU caps**, and any **destructive / irreversible** action.
    (Non-author evaluation still holds — Codex reviews Claude's code — but that is a
    gate, not a human-decision block.)

### Boundary (CLI-orchestrated by Claude)

Claude orchestrates the loop from the terminal (Bash) — NOT via any in-app agent
tool or `/codex` command:
- **Codex = generator / implementer**, invoked per the **rule 11 protocol** (xhigh
  long-runner): `codex -s workspace-write -a never exec -C <repo> --json -o
  /tmp/codex-<pass>.out "<brief>" > /tmp/codex-<pass>.events.jsonl 2>&1`. Judge by the
  `-o` output file + `git diff --stat`, never scrolling stdout. `codex review` for its
  code review. Two-layer output: raw `/tmp` files = evidence; the **Hermes md is the
  formal ledger** — the orchestrator writes the structured Codex Implementation Pass
  (status / authored_by / changed_files / verification / diff_scope_check) only after
  checking `git diff --stat` + build + replay. Codex saying "done" is not enough.
- **Claude (this session) = orchestrator + evaluator**: runs the gates
  (`npm run build`, tests, replay, reads node events over SSM), reviews Codex's
  diff, commits. Claude is the non-author skeptic of Codex's code, so the
  generator/evaluator split still holds (Codex writes, Claude judges).
- **No nested Claude via shell**: `claude -p` inside a Claude Code session is blocked
  (it crashes the session) — **never shell it.** The orchestrator does not shell a second
  Claude and is itself the evaluator of Codex's code.
- **EXCEPTION — fresh fable-5 blocker-finder per round (Rounds step 4):** each Hermes round
  spawns ONE fresh fable-5 sub-agent for the **blocker-discovery step** (competitor
  cross-reference → name the core blocker), via the **Agent tool with `model: "fable"`** (SDK
  sub-agent, cold/fresh context — NOT `claude -p`). Purpose: a fresh fable context each round
  avoids the long-session degradation, and the blocker judgment is made by fable regardless of
  which model orchestrates. The sub-agent returns its named blocker + evidence; the orchestrator
  then runs `Codex reviews the blocker → Claude finalizes → Codex writes → review → fork/replay
  gate`. This is the ONLY sanctioned second-Claude spawn; everything else stays single-orchestrator.

Discipline: **one turn on demand, not a self-spinning loop.** Run 2-3 turns this
way before adding `ScheduleWakeup` pacing. Hard backstops still apply (the
subscription rate window + the Alchemy CU cap), and **go-live / broadcast stays a
human gate** — the loop executes but cannot decide production.

---

## Safety Rules

1. **Broadcasting transactions to mainnet (and signing with the private key) requires explicit user authorization.**
   The user has authorized live bundle submission for this project (granted 2026-06-10).
   Even when authorized, only broadcast a bundle that passed a **profitable on-fork simulation**
   this run (`sim.success` + the assert-balance flash-repay guard). **Never broadcast from an
   unverified or half-modified pipeline** — confirm the dry-run produces a profitable bundle first.
2. Default to dry-run (`SEARCHER_DRY_RUN=1` → `DryRunBundleRouter`); flip to production only deliberately.
3. All correctness testing happens on local forks (`anvil` or `forge test --fork-url`).
4. Do not commit `.env` files containing real RPC URLs or private keys.
5. Scripts default to `--broadcast` disabled; require `--broadcast` flag explicitly.
6. **Neutral, legitimacy-framed wording — in artifacts AND in the live conversation (avoid false safety-review triggers).**
   This is authorized, defensive on-chain **arbitrage research** — mainnet fork + dry-run, reads
   public chain data, targets/harms no user, and broadcast is a hard human gate (rule 1). The
   safety flag is a **real-time classifier on the live session + actions**, not just on committed
   files — so this applies to **chat messages, Codex/agent briefs, and commit messages**, not only docs.
   - **Every Codex/agent brief opens with the one-line scope** (authorized arbitrage research; fork/dry-run; broadcast human-gated). Do NOT stack many sensitive terms in one message.
   - **Prefer these terms (soften the *prose*, not code symbols):**

     | avoid (prose) | use |
     |---|---|
     | bribe | priority-fee tip / builder payment / coinbase transfer |
     | victim / victim swap | triggering swap / source swap / the pending swap we follow |
     | attack / exploit / prey | arbitrage / strategy / opportunity |
     | extract / drain / steal | capture / realize / net |
     | "go to production" / "broadcast" (bare) | pair with context: "(dry-run today; broadcast is a human-gated step)" |

   - Standard **code symbols** (`victimApply`) and field terms ("backrun", "MEV") stay as-is — only soften prose; pair external-facing docs/briefs with the scope note.
   - **Accept the fallback:** false positives on this domain aren't 100% avoidable (the classifier itself says it flags safe conversations). The auto-switch to a fallback model is the designed safety net, not a failure — a sane split is **judgment/orchestration on the fallback-capable model, code-gen on Codex**, so a flag doesn't break the main line.
   - This is **accurate framing, NOT concealment**: never disguise, understate, or misrepresent what the code actually does.

## File Structure

```
src/
  FlashArb.sol       — Main arbitrage contract (Morpho flash loan + Fluid + DEX routing)
  Constants.sol      — All on-chain addresses in one place
  interfaces/        — Minimal interfaces for external protocols
    IMorpho.sol
    IFluidVault.sol
    IERC20.sol
test/
  WstUSRArb.t.sol    — Fork test replaying the arbitrage strategy
script/
  Simulate.s.sol     — Simulation script (fork only, no broadcast)
```
