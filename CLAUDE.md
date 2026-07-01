# MEV Flash Arbitrage — Project Instructions

> Compatible with Claude Code (`CLAUDE.md`) and Codex (`AGENTS.md`).

## Project Overview

Replicate and study MEV arbitrage strategies on Ethereum mainnet forks.
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

---

## Development Workflow

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

- One file per run: `docs/research/reports/live-run-<run_id>-hermes.md`, copied from
  `docs/research/templates/hermes-live-run.md`.
- Auto-generated inputs (follow the Live-Run Follow-Up rules — redact first, keep
  public on-chain evidence): redacted log, redacted JSONL summary, key tx links, AND
  the **mandatory Step-1 competitor cross-reference** (below).
- **Step 1 — competitor cross-reference (mandatory, before any conclusion).** Use the
  EXISTING scripts, iterate them if they fall short — do NOT reinvent. Over the same
  block window, on the local reth node (zero Alchemy CU):
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
- Each agent writes **only its own sections**, never edits the other's. Each round =
  exactly **one core judgment + one next_action + one not_doing** (no walls of text).

### Rounds (per run)

```
auto:   Run Facts / Auto Analysis / Competitor Coverage / Path-Leg Findings
        Codex Round 1            Claude Round 1            (initial core view)
        Codex Review Of Claude   Claude Review Of Codex
        Codex Final View         Claude Final View
        Claude Final Decision + Implementation Brief + Acceptance   ← only this drives code
        Codex implements
        → review/fix loop: Claude review+fix request → Codex review+fix
                          → Claude review+fix request → Codex review+fix
                          → max 3 passes, then Claude final approval or stop
        → next 30-min live run
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
- **No nested Claude**: `claude -p` inside a Claude Code session is blocked (it
  crashes the session) — never shell it. Claude does not spawn a second Claude;
  it *is* the evaluator.

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
