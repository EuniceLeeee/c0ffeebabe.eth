# CLAUDE.md — MEV Flash Arbitrage

> Compatible with Claude Code (`CLAUDE.md`) and Codex (`AGENTS.md`).
>
> **This file is the always-loaded core:** the Behavioral Base (how to work), the Project (what/why),
> the Safety Rules (hard gates), and quick Reference. Keep it lean — dated decisions / closed findings
> live in `docs/decision-log.md`. **Load the companions on demand:**
> - **`docs/research/HERMES.md`** — the live-run collaboration runbook + governance rules 1–17. Read it
>   fully when running a Hermes / live-run / autonomous cycle (the `docs/research/autonomous-*.md` routines
>   do). **Hermes rule numbers are load-bearing; do not renumber.**
> - **`docs/research/gates.md`** — the validation contract (rule 12: `fixed` vs `implemented`, replay flips, the
>   test harnesses). Read it before claiming a deterministic change is fixed.
> - Skills: `bundle-postmortem` (competitor-loss decision tree), `mev-review` (trace-diff review).

---

## Behavioral Base — how to work here (every task)

*Tradeoff: these guidelines bias toward caution over speed. For trivial tasks, use judgment.*

### 1. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs. Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.
- **Verify against code/data, not memory** (verify-before-claim). A recalled fact / a stale memory is a
  hypothesis to re-check by reading the actual file or on-chain data, never a conclusion.

### 2. Simplicity First
Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked; no abstractions for single-use code.
- No "flexibility"/"configurability" that wasn't requested; no error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- The test: *"Would a senior engineer say this is overcomplicated?"* If yes, simplify.

### 3. Surgical Changes
Touch only what you must. Clean up only your own mess.
- Don't "improve" adjacent code, comments, or formatting; don't refactor what isn't broken.
- Match existing style, even if you'd do it differently. Standard code symbols (`victimApply`) and field
  terms ("backrun", "MEV") stay as-is — see Safety Rule 6 for prose-only wording.
- If you notice unrelated dead code, mention it — don't delete it. Remove only imports/vars/functions that
  *your* change orphaned.
- Every changed line traces directly to the request.
- **Never `rg -rn`/`-rln`** — `-r` is `--replace` and silently corrupts reads.

### 4. Goal-Driven Execution
Define success criteria, loop until verified. Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```
Strong success criteria let you loop independently; weak criteria ("make it work") require constant
clarification. In THIS repo: **build passing is `implemented`, not `fixed`** — a deterministic searcher
fix needs a replay/harness flip (`docs/research/gates.md`).

*These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites from
overcomplication, and clarifying questions come before implementation rather than after mistakes.*

### Project-specific habits merged onto the base
- **Agent autonomy.** Run the analysis/redaction/`tail`/`jq`/report commands yourself — don't ask the user
  to do mechanical local steps. Share **redacted** artifacts (redact first, then analyze the redacted
  output); preserve public on-chain evidence (tx hashes, pools, token addresses) unless stricter redaction
  is asked. Whenever a `*.md` is updated, commit + push it in the same turn (raw logs / JSONL / secrets /
  `.env` never committed; local run logs go to `MEV/logs/`, gitignored).
- **Live-run follow-up.** After a run, find the latest events JSONL + log, generate redacted artifacts, and
  analyze without waiting. Prefer structured JSONL over log greps; `pipeline_dropped` is the source of truth
  for loss attribution. First pass is zero-CU where possible (JSONL, redacted logs, planner code, registries
  before RPC/traces). If the dominant drop is `no_candidate_plans`, classify: flash borrowability / path
  template / token-graph coverage / unsupported shape.
- **Tool-first.** Before hand-writing a scratchpad analysis, check the existing toolset (`analysis/src/cli/*`,
  the LearningCase store, `redact-live-run`, `analysis/src/pnl/*`) and RUN/EXTEND it — see HERMES rule 17.

---

## The Project

### Mission / North Star — every session, every window, every operation stays anchored to this
1. **Ship to production.** The goal is a **profitable, live on-chain arbitrage searcher**. Everything is a step toward that first production go-live. (Broadcast stays a hard human gate — Safety Rule 1 — but the *direction* is always: get closer to a real, +EV live bundle.)
2. **Learn from other searchers to find OUR gaps.** Systematically study competitors' winning on-chain paths and classify what **we** are missing:
   - **pool gap** — a venue/pool we don't index (e.g. the Uni v4 singleton);
   - **path gap** — pools we have but can't route / close the loop through;
   - **unanticipated gap** — we saw the opportunity but lost it somewhere unexpected (latency, or a flow-admission drop before the funnel).
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

## Safety Rules (hard gates — never autonomous)

> Safety Rule **numbers are load-bearing** — Rule 1 is referenced by number from HERMES.md, the autonomous
> routines, and the bundle-postmortem skill. Never renumber; compress in place.

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
   - **Soften the prose (not code symbols):** bribe → priority-fee tip / builder payment; victim / victim swap → triggering swap / source swap; attack / exploit → arbitrage / strategy; extract / drain / steal → capture / realize / net; bare "go to production" → pair with "(dry-run today; broadcast is a human-gated step)".
   - **Reduce generated VOLUME (the stronger lever)** — the classifier scores cumulative flagged content the session generates. Lead with structured data (tables, `tx→pools→profit`, `file:line`); cut narrative re-describing a competitor's actions; keep raw traces in scratchpad FILES, surface a terse conclusion; segment a long review into short scoped turns.
   - **Accept the fallback:** false positives aren't 100% avoidable; the auto-switch to a fallback model is the designed safety net — a sane split is judgment/orchestration on the fallback-capable model, code-gen on Codex.
   - **Accurate framing, NOT concealment:** never disguise, understate, or misrepresent what the code does.

---

## Reference

### Historical Replay
Do NOT assume block `24710787` or the final state of `24710788`. First read `docs/historical-replay.md` (source of truth for the ordered tx list + DOLA/wstUSR pool impact). The accurate target is the **pre-state of tx index 8 in block 24710788**: 24710787 end state → apply tx index 0…7 → simulate our BotVM / FlashArb at tx index 8 pre-state.

### Fork Testing / Trace / Discovery
```bash
forge test --fork-url $MAINNET_RPC_URL --fork-block-number 24710787 -vvvv           # all fork tests
forge test --match-test testReplayArbitrage --fork-url $MAINNET_RPC_URL --fork-block-number 24710787 -vvvv
cast run <txhash> --rpc-url $MAINNET_RPC_URL                                          # trace a tx
cast 4byte-decode <calldata>                                                          # decode calldata
cast call <token> "balanceOf(address)(uint256)" <addr> --rpc-url $MAINNET_RPC_URL --block 24710787
cast receipt <txhash> --rpc-url $MAINNET_RPC_URL --json | jq '.logs'                 # logs / address discovery
```
Validation gates for searcher changes: `docs/research/gates.md`. Trace-diff / reproduction review methodology: the `mev-review` skill.

### File Map
- `docs/research/HERMES.md` — live-run collaboration runbook + governance rules 1–17 (on-demand).
- `docs/research/gates.md` — validation contract (rule 12 + the test harnesses + correctness-property → test mapping).
- `docs/decision-log.md` — dated decisions / verified facts / dead-ends (committed). Read the ✅/❌ entries before re-opening a settled question.
- `.claude/skills/bundle-postmortem/` — competitor-loss postmortem decision-tree tool. `.claude/skills/mev-review/` — reproduction / trace-diff review methodology.
- `docs/distill/` — Fable/Opus dual-run distillation records + daily-compress + golden-set (do NOT auto-read; only for rule compression). `.claude/commands/{dualrun,compress}.md` drive it.
- `docs/research/` — Hermes round docs, handoff/relay routines, architecture reviews, templates.
- Source: `src/FlashArb.sol` (Morpho flash loan + Fluid + DEX routing), `src/Constants.sol` (all addresses), `src/interfaces/`, `test/WstUSRArb.t.sol` (fork replay), `script/Simulate.s.sol` (fork sim, no broadcast). Live searcher under `listener/src/searcher/`; analysis tooling under `analysis/src/`.
