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

### 6a. Bundle Post-Mortem — submitted but never included (run the script, don't guess)

When a live bundle passes the EV gate and gets builder ACCEPTs but never lands, do NOT
guess (latency / builder list / bid). Run the codified post-mortem (validated against the
2026-07-03 manual analysis of bundle `0xa32b646c…8b2f68`, block 25449741):

```bash
cd analysis && npm run bundle-postmortem -- \
  --events <searcher events jsonl> --tx <our backrun tx hash, prefix ok> \
  --rpc http://127.0.0.1:8545
```

Events + local reth live on the NODE — run it there via SSM. The live events path is the
running process's `SEARCHER_EVENTS_PATH` (read `/proc/<pid>/environ`; e.g.
`/var/log/mev/events/searcher-live.jsonl`), NOT necessarily `analysis/events/`.

The script answers the fixed decision tree, in order:
1. **One-shot validity** — mempool-route bundles embed the pending swap's rawTx and pin ONE
   target block; once that swap lands, the bundle is permanently invalid (nonce consumed +
   dislocation re-equalized). "N blocks not included" afterwards is EXPECTED, not a failure.
2. **Builder reach** — who built the landing block (`extraData`/miner). Standing fact:
   Flashbots Bundle Relay orderflow is auto-shared with BuilderNet
   (buildernet.org/docs/send-orderflow), so `flashbots: ACCEPTED` ⇒ BuilderNet saw the
   bundle; `rpc.buildernet.org` exists as optional direct redundancy.
3. **Auction outcome** — competing txs directly behind the pending swap in the landing
   block: route venues, gross take, and builder payment (priority tip + coinbase transfer,
   the 9bb85fd metric). `outbid` = winner payment > our bid; `route_gap_decisive` = winner
   payment > our FULL simulated gross (i.e. no bid policy could have won — fix coverage,
   not bids).
4. **Gap classification** — winner's pools vs `runtime-graph-pools.json` → pool/path gap.

Manual follow-ups the script cannot do: WebSearch the orderflow-sharing relationships of a
new winning builder; secondary-source-verify one key number via Alchemy; write durable
findings to memory / the Findings Ledger.

### 6b. Auto-improve loop — same-block loss / opportunity-miss → analyze → CLOSE the gap (forcing function)

6a (post-mortem) + the competitor census ANALYZE why we lost; this rule adds the IMPROVE half so
diagnosis auto-converts to a closed gap (the mission's learn→close loop, made mandatory). Trigger,
either of:
- **Same-block competition loss** — our bundle passed the EV gate + got builder ACCEPTs but a
  competitor's tx behind the same pending swap landed instead (6a `outbid` / `route_gap_decisive`).
- **Opportunity-miss vs a comparison player** — a watched competitor captured a +EV backrun in one of
  our blocks that never became a profitable `simSuccess` for us (competitor census / `not_seen`).

Then, without waiting for a human, run: **analyze (6a / census) → classify the gap → CLOSE it →
validate with a rule-12 fixture.** Close per gap class:
- **pool gap** (winner used a venue/pool we don't index — e.g. a v4 poolId absent from
  `active-pools.json`/`runtime-graph-pools.json`) → resolve its poolKey + enqueue for backfill →
  merge into the graph so the planner can route it. This is the `route_gap_decisive` fix (winner's
  gross > our FULL simulated gross ⇒ NO bid policy could have won ⇒ fix COVERAGE, never bids).
- **path gap** (pools we have but can't close the loop) → add the route/template.
- **execution-adapter gap** (venue identifiable+graphable, no quote/build) → the venue-adapter epic.
- **detection gap** (fully covered, not detected/routed) → detection/admission fix.
- **pure outbid** (winner payment < our full gross but > our bid — bid policy, not coverage) → an
  economics/bid-policy call; a large bid-posture change stays a human gate (Safety Rule 1 territory).

Governance: every triggered loss/miss with a **closable** gap becomes a tracked item
(`owner` + `carry_to_round`) and BLOCKS closing the cycle until improved or explicitly killed by the
human (same teeth as rules 13/16). The gap MUST be closed, not just filed as "known".

**Reference instance (2026-07-03) — analysis-validated, close is an EPIC not an in-loop backfill:**
bundle `0xa32b646c…8b2f68` (block 25449741) lost `route_gap_decisive` — the winner `0x28390df4…`
backran the same triggering swap via a 2-hop route: WETH→CFG on v3 pool `0x08a10a8b…FCBF`, then
CFG→WETH on a **native-ETH v4 pool `0x267d01a3…9348cd9c`** (`Initialize` confirms currency0=`0x0`
native ETH / currency1=CFG; poolId absent from our runtime graph, `in_graph=false`). Our v3-only
3-hop detour (WETH→CFG→USDT→WETH) saw only ~43% of the value (sim gross 330217158618935 wei vs the
winner's ~774e12 wei = WETH out 0.16662725 − in 0.16585284), and the winner's builder payment
(750794055091649 wei, ~97% of its gross) alone exceeded our
FULL simulated gross — so NO bid policy could have won; the analysis named coverage, not bids.
**Gap class = execution-adapter, not pool.** The planner already routes native-ETH v4 (WETH-alias;
`planner.ts` native-ETH v4 fixtures pass), but **v4 is not in the ActionAdapter execution registry**
(only univ2/univ3/ln/curve/psm/fluid; the `ln` V4 call in `FlashArb.sol` is a bespoke wstUSR
hardcode, not a general v4 builder), so graphing the poolId lets us ROUTE but not BUILD/settle the
leg live. Per rule 13 native-ETH v4 execution is an **epic**, and per-pool pins on an epic'd class
are forbidden in-loop → the CLOSE routes to that epic. What the auto-loop CAN close here is the
COVERAGE half: a planner fixture asserting that, with the v4 CFG poolId graphed, our route emits the
2-hop v3↔v4 plan capturing the full gross (proves the routing lever); live capture stays
`implemented_not_validated` until the v4 native-ETH execution adapter lands. (Corrected 2026-07-03 by
the non-author evaluator after on-chain verification — the original draft mis-classified this as a
pure pool gap closable by backfill; that would have been a forbidden per-pool pin on the v4 epic.)

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
0. SLEEP-KEEPER  FIRST STEP of every round. Codex background runs FREEZE on Mac sleep/screen-lock
                 ([[reference-codex-background-suspend]]) — a multi-round workflow means the user is
                 away, so ensure ONE persistent keeper is alive before any background Codex/dry-run
                 (idempotent, PID-file guarded so rounds don't spawn duplicates):
                   KEEP=/tmp/mev-sleep-keeper.pid
                   if [ -f "$KEEP" ] && kill -0 "$(cat "$KEEP" 2>/dev/null)" 2>/dev/null; then
                     echo "sleep-keeper alive PID=$(cat "$KEEP")"
                   else nohup caffeinate -i -d -s -t 10800 >/dev/null 2>&1 & echo $! >"$KEEP"; fi
                 (AC power makes `-s` effective; lid-close on battery still sleeps → keep lid open +
                 the ScheduleWakeup fallback stays the backstop. Per-`codex exec` `caffeinate -i`
                 wrappers only cover that one command — the keeper covers the whole workflow.)
1. LIVE RUN      ~30-min dry-run on the node. Deploy latest FIRST (scripts/deploy-node.sh);
                 do not analyze stale code.
2. AUTO ANALYSIS Run Facts + structured pipeline_dropped (source of truth) + before/after
                 vs the previous round's metrics.
   THE QUESTION  Blocker-discovery answers TWO complementary questions — NOT "which opp did we
   (dual frame)  lose this window" (that surfaces the nearest POINT-failure, not the distance to
                 production; it produced ~20-line near-null rounds):
                   • PRIMARY (funnel-INTERNAL, toward production): **What is the nearest blocker
                     to a genuine +EV `simSuccess`?** Walk the funnel opportunity_seen → plans →
                     solverEntered → **simSuccess (a profitable simulated bundle = the last gate
                     before the human broadcast)** and find where REAL opportunities stall.
                     `simSuccess` must be **+EV, not dust** — today's sims run with gas_estimate=0
                     / bribe≈100%, so a bare `simSuccess>0` can be a −EV dust bundle; if that is
                     the ceiling, **economics IS the blocker**. Do not celebrate dust.
                   • COMPLEMENTARY (funnel-EXTERNAL, coverage): **What do competitors capture that
                     never enters our funnel?** The primary question is blind to pools we don't
                     index (those opps never register as "blocked"); the competitor cross-ref
                     (step 3) is the only lens on that.
3. COMPETITOR    MANDATORY — the funnel-EXTERNAL / coverage lens + reality check on the primary
   CROSS-REF     question (Mission #2), not decoration:
                   • coffeebabe 0xC0ffeEBABE5D496B2DDE509f9fa189C25cF29671 — MANUAL, EVERY
                     live-window tx (full trace: what the arb did + did it backrun a source swap
                     + that swap's origin, or prove atomic).
                   • 0xae2Fc483527B8EF99EB5D9B44875F005ba1FaE13 — SAMPLED, but sample size is
                     **OUTCOME-DRIVEN, not a fixed "a few"**: keep sampling (and if a small/thin
                     window yields nothing analyzable, **EXTEND the window to hours**) until you
                     have enough to counterfactual-walk **≥1 real blocker** — OR prove no analyzable
                     +EV opportunity exists. Never conclude a "true negative" from a STARVED sample
                     (the R3 trap: a 30-min window's thin flow was read as "nothing to fix" — the
                     right response to a thin window is EXTEND it, not conclude).
                   • Each agent works from PRIMARY sources independently (raw script JSON +
                     own on-chain trace), never the other's curated facts.
                 → classify what WE missed: pool gap / path gap / unanticipated gap; and confirm
                 the PRIMARY-question blocker is on a REAL opportunity a competitor captured (not
                 noise we optimized for nothing).
4. BLOCKER       **Two BLIND-INDEPENDENT analyses of the same raw material, then compare** — NOT
   (dual-blind)   "analyze then review the conclusion" (a correlated hand-off; the rule-9 nodding risk):
                  • A FRESH fable-5 sub-agent (Agent tool, model:fable — new context every round,
                    avoids long-session degradation; has BOTH chain + code access) does the FULL
                    independent analysis (competitor cross-ref + code root-cause) → **conclusion A**
                    (blocker + root cause + evidence). Claude KEEPS A hidden from Codex.
                  • Claude hands Codex ONLY the RAW MATERIAL as DATA — mechanical results (script
                    outputs/counts) + manual-analysis FACTS (competitor takes: victim/bot/block/pool)
                    + funnel numbers — **never fable-5's conclusion or Claude's picked facts**. Codex
                    (code access; chain facts as data) independently reaches **conclusion B**, BLIND to A.
                  • Claude COMPARES A vs B: agree → high-confidence blocker; differ → dig/reconcile
                    (the disagreement IS the signal). Then Claude FINALIZES the blocker + writes the
                    Implementation Brief. Only the Brief / Final Decision drives code.
                  Blind independence holds regardless of which model is stronger — two blind analyses
                  that agree beat one reviewing the other, and neither can rubber-stamp the other.
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
    - **Invocation — ALWAYS via the wrapper `scripts/codex-run.sh`, NEVER hand-write the codex line.**
      Hand-writing keeps dropping guards (2026-07-02: a plan-review sat stdin-hung 15 min because the
      hand-written line omitted `< /dev/null`). The wrapper bakes them in so they can't be forgotten:
      `< /dev/null` (stdin-hang guard), `caffeinate -i`, `-o`+`--json` to files, and a launch watchdog
      that KILLS a stdin-hang if no `thread.started` appears within 30s (a hang costs ~30s not 15 min).
      ```
      # brief lives in a FILE (avoids arg-escaping bugs); run via Bash tool run_in_background=true:
      scripts/codex-run.sh <read-only|workspace-write> /tmp/codex-<pass>.brief.md /tmp/codex-<pass>
      #   -> /tmp/codex-<pass>.out (final message) + /tmp/codex-<pass>.events.jsonl (events)
      ```
      The wrapper `wait`s on codex so the harness completion notification fires exactly when codex
      finishes. `-o` = final message; `--json` events = retry/connection + `thread.started` evidence.
      **ENFORCED, not just documented:** a PreToolUse(Bash) hook (`scripts/hooks/guard-codex-stdin.py`,
      wired in `.claude/settings.json`) BLOCKS the tool call if it's a raw `codex … exec` that lacks the
      wrapper or `< /dev/null` (quote-stripped, so it never false-blocks a commit message that mentions
      the invocation). This is the hard backstop for the doc rule that kept getting missed.
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
      - **Mechanical escalation trigger (not left to judgment):** the same `gap_class`
        recurring in **≥3 independent samples within one window**, OR in **≥2 consecutive
        rounds**, → a **mandatory** `decision: epic` in the Findings Ledger (owner + ordered
        slices). Once a class is epic'd, **per-pool pins for that class inside the 30-min loop
        are forbidden** — only epic slices (each with its own rule-12 gate) may touch it. And a
        **systemic single fix always beats N per-pool pins when one exists** (R2's v4 gate flip
        unlocked the whole v4 execution class in one change; do not whack-a-mole). The point of
        this trigger is the observed failure mode: coverage gaps get **parked as
        "longtail/separate" round after round and never escalated** — this converts that
        recurring signal into a forced epic instead of another parked finding.
    - **Architecture-review trigger (the production-needle forcing function — broader than the
      gap_class trigger above):** **≥2 consecutive rounds close with NO growth in a genuine +EV
      `simSuccess`** → the next step is a **mandatory architecture-level review in an INDEPENDENT
      fresh context** (NOT another point-fix round), **run DUAL-BLIND exactly like the per-round loop
      (Rounds step 4): a fresh fable context produces conclusion A + Codex independently produces
      conclusion B, BOTH from the same DATA package (the regenerated handoff — DATA + HYPOTHESES, never
      the other's conclusion), BLIND to each other, then the orchestrator compares A vs B** (converge =
      high-confidence lever; differ = the disagreement is the signal — dig). Codex has no chain access,
      so hand it the pinned competitor takes as DATA; its unique code-side job is re-deriving the
      economics / sim-fidelity numbers (EV gate, `defaultGasUsed`, profit floor, `valueInEth`) from
      `file:line`. This is NOT one reviewer rubber-stamping the other — same anti-nodding as step 4.
      Step back from the per-window loop and LOCALIZE
      the structural distance-to-production lever — `funnel | coverage | flow-admission |
      no-replicable-atomic-EV` — via a per-competitor-profitable-bundle counterfactual walk + a
      longer window. Output → Findings Ledger as `decision: epic` OR an explicit funnel-fix + its
      rule-12 gate; point-fixing on that theme PAUSES until it lands. Use the REUSABLE template
      `docs/research/templates/architecture-review.md` (invariant prompt + handoff-generation
      checklist + run-mode note) + a per-firing handoff regenerated FRESH from the CURRENT run data
      (`docs/research/reports/HANDOFF-architecture-review.md`). **Never hardcode a past run's rounds /
      conclusions / cases into the reusable template or the trigger** — those are variables that live
      in the regenerated handoff. (This catches the failure the gap_class trigger can't: several clean
      point-fixes that each moved nothing — the loop busy but the production needle unmoved.)
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
    - **ENFORCED, not just documented.** At the start of a multi-round / away workflow, `touch
      /tmp/mev-workflow-active` (remove it when the workflow ends or the user resumes driving
      interactively). While that marker exists, a PreToolUse hook
      (`scripts/hooks/guard-workflow-noask.py`, wired in `.claude/settings.json`) **BLOCKS
      `AskUserQuestion`** — UNLESS the question names a real stop condition (go-live/broadcast,
      CU-cap, destructive/irreversible, private-key), which it lets through. So a run-scoped /
      architecture / scope question can't be asked mid-workflow: decide it, PROCEED, record it.
      This includes **auto-firing the rule-13 architecture review** when its trigger hits — do not
      ask "should I run the architecture review?"; just run it and record the verdict. A single
      user prompt like "跑 N 轮 hermes" is the whole instruction; everything downstream (deploy,
      windows, blocker-discovery, arch-review firing, fixes, gates) is self-driven.
15. **A status report is NOT a stop — never end an autonomous-workflow turn on prose alone.** The
    rule-14 no-ask hook stops you from *asking*, but the real failure mode is subtler: after a big
    analysis you write a checkpoint report and simply YIELD the turn — neither asking nor proceeding.
    That is a **silent stall**: the loop only advances when a tool call re-invokes you (next Codex/agent
    dispatch, deploy, `ScheduleWakeup`, a background timer) or the user prompts; a pure text report
    schedules nothing, so the workflow dies until the human pokes it (observed 2026-07-02: R1 reported,
    R2 never auto-started until the user asked "are you running R2?"). **Rule: while `/tmp/mev-workflow-active`
    exists, every turn MUST end with either (a) a work-continuing / self-re-invoking tool call, or (b) an
    explicit real stop condition (go-live/broadcast, CU-cap, destructive) stated as such. Reporting is a
    side-channel to the away user, delivered ALONGSIDE the next action in the SAME turn — not a handoff.**
    - **ENFORCED, not just documented.** A `Stop` hook (`scripts/hooks/guard-workflow-nostall.py`, wired
      in `.claude/settings.json`) fires when the turn ends: while the marker exists, it BLOCKS the first
      stop and forces you to confirm a continuation is scheduled (background work running / wakeup set) or
      dispatch one — so "report then yield" cannot silently end the loop. If you are legitimately waiting
      on tracked background work, re-affirm and the stop proceeds (the hook self-clears via
      `stop_hook_active`).
16. **Fable manual analysis is also a TEST of our analysis tooling — its findings MUST be codified
    (forcing function, hard).** The fresh fable-5 competitor analyst (Rounds step 4) works from raw
    on-chain data with ad-hoc curl/jq, so it routinely discovers where our permanent analysis scripts
    are **wrong** (e.g. `realized_profit_usd` valuation artifact double-counting paired legs) or
    **missing a metric** (e.g. builder-payment as the robust profit floor; sandwich-bracket detection;
    public-vs-private distinct-sender classification). When fable's manual pass exposes such an
    error/omission, the loop MUST **fix or extend the analysis script** (Codex writes, Claude gates)
    so the next run is script-native — NOT re-derive it by hand every round. Treat a fable-found tooling
    gap exactly like a rule-13 finding: `owner` + `carry_to_round`, and it BLOCKS closing the cycle as
    "done" until the script is patched or the gap is explicitly killed by the human. The goal: every
    competitor analysis Fable can do by hand becomes a reproducible one-command capability
    (`live-loss --watch` / a `--competitor-census`), so "look at whether other MEV lands +EV backruns"
    stops depending on a hand analysis. (Codified so far: builder_payment metric. Pending: sandwich
    detection, public/private classification — carry until scripted.)

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
   The user authorized live bundle submission (2026-06-10) and, on 2026-07-03, authorized a
   **BOUNDED-LIVE test**: the searcher may broadcast autonomously ONLY inside a hard, script-enforced
   envelope, so worst-case loss is bounded to a tiny test wallet.
   - **The bounded-live envelope (all must hold, else stay dry-run):** live is gated by the node-side
     marker `/opt/MEV/.deploy-live`; `deploy-node.sh` REFUSES live unless the signing wallet balance
     `≤ MEV_LIVE_MAX_WALLET_ETH` (default 0.2 ETH) AND `SEARCHER_EV_GATE=1`. Flash-loan arbs are atomic
     (a bad arb reverts, principal never at risk) + the BotVM executor holds no standing funds → the
     max loss is the test wallet's gas/bribe balance. Verified 2026-07-03: signer
     `0xb8578B6de173C8554FF0390dB5a7effA567DDA3c` = 0.0027 ETH, BotVM `0x4aF9495C…5BCe` = empty.
   - **Still hard (never autonomous — these need a fresh explicit human OK):** funding the test wallet
     above the cap, raising `MEV_LIVE_MAX_WALLET_ETH`, swapping in the real-funds private key, or any
     broadcast outside the bounded envelope. The autonomous cron must NEVER do these.
   - **Safety valve:** a bounded-live round reads the test-wallet balance at the start; if it dropped
     below 50% of its starting balance, STOP, `rm /opt/MEV/.deploy-live` (revert to dry-run), and report.
   - Even bounded, only broadcast a bundle that passed a **profitable on-fork/EV-gated simulation**
     (`sim.success` + net-EV + the assert-balance flash-repay guard). Never broadcast from an
     unverified or half-modified pipeline. **Default is still dry-run** (Rule 2); live is the marked exception.
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
   - **Reduce generated VOLUME, not just word-choice (the stronger lever).** The classifier scores
     **cumulative** flagged content the session GENERATES, so a long narrated analysis trips it even with
     neutral words. Generate less flagged prose: **lead with structured data** (tables, `tx→pools→profit`,
     `file:line`) and let the numbers/addresses carry it (public on-chain data = low signal); cut narrative
     that re-describes what a competitor did; keep **raw traces in scratchpad FILES**, surface only a terse
     conclusion in chat; **segment a long review into scoped short turns** so no single context accumulates
     past the threshold.
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
