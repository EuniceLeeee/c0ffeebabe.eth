# Handoff prompt — paste into the fresh Fable window

Scope: authorized, defensive on-chain arbitrage research; mainnet-fork / dry-run only; broadcasting
is a human-gated step (do not broadcast, do not create live markers). Neutral, legitimacy-framed
wording. You are continuing an in-progress, design-settled implementation — do NOT re-open the
architecture; execute the next slices.

## What you are building
The unified `strategy_kind × edge_kind` searcher plan. The authority doc is
`docs/research/design/unified-strategy-edge-impl-plan-20260704.md` (v2.3). Read its **§9 HANDOFF
first** (ground-truth of what is landed, the D1–D4 invariants, the tooling gotchas, the exact
ordered next actions). Slice-mechanics detail lives in
`docs/research/reports/coffee-20260704-atomic-epic-impl-plan.md`.

## Ground state (verify against git; do not trust prose)
- Landed + gated + committed: **S0** (`75210c5`, taxonomy + TokenEdge widening), **S1** (`6145931`,
  merged LearningCase + postmortem/census fold), **S2** (`a737576`, fail-closed standing-position
  guard — deployed to the node, verified 0 false-positives).
- **BS-0 node reads are ALL DONE for you** (the previous session front-loaded every chain read so
  you never touch the node): pre-tx pool states + both v4 PoolKeys + token symbols are persisted in
  `listener/src/searcher/test/fixtures/blockscan-coffee-803a3693.json`. Key finding recorded there:
  the "3 arb pools" are NOT one cycle — the closed loop is the 2-hop CFG spread (WETH/CFG v3 →
  native-ETH/CFG v4); the 3rd pool (ETH/BOLD) is a separate leg, out-of-cycle.
- Everything from BS-contract onward is UNWRITTEN (13 slices).

## No node / RPC / broadcast access is needed for your slices — this was deliberate
The previous session pre-cleared all chain dependencies so your slices stay purely on local code
(no node, RPC, or on-chain submission at all):
- **BS-0**: all node data captured → your job is pure local code (harness). No node.
- **BS-contract, BS-universe, BS-1/2/3**: gates are local — `npm run searcher:planner` +
  `npm run searcher:replay-live-fixtures` (persisted fixtures) + new unit tests. No node/archive.
- **CR-3**: the PRIMARY gate is a local planner `REPLAY_FIXTURES` flip (credit edge present ⇒
  `candidate_plans 0→≥1`). Its OPTIONAL secondary check (AC-3-style ~273 wstUSR token-delta) needs
  `MAINNET_RPC_URL` archive (block 24710788, beyond reth's prune window) — DEFER that half to the
  operator; do the primary local gate only, note the deferral. Do not hit archive yourself.
If any slice seems to need node/archive/broadcast: STOP and hand back to the operator — do not do it.

## Your first task: finish BS-0 (the only slice with node work, already de-risked)
1. Codex writes `listener/src/searcher/test/blockscan-a0-replay.ts` + npm `searcher:blockscan-a0`
   that reconstructs the **CFG 2-hop cycle** from the persisted fixture states using the existing
   local math (`solver/v3-math.ts` for the v3 leg + the v4 math the repo already has for
   native-ETH v4), and asserts a profitable closed loop `expectedGrossWei > 0` (record the number
   back into the fixture). Gate: cycle reconstructable from public state alone (no chain calls in
   the test). This substantiates "contestable with a scanner, no private info."
2. Then proceed in order (§2 of the doc): BS-contract (the big ~640-line `processOpportunities`
   factor-out — scope it MECHANICAL, gate on byte-identical backrun replay; relocate the S2 guard +
   add `BundleSubmission.safety` + `BundleRouter` second-reject) → BS-universe → CR-3 → BS-1/2/3 → …

## Process (hard rules)
- Codex is the generator, ALWAYS via `scripts/codex-run.sh <mode> /tmp/codex-<slice>.brief.md
  /tmp/codex-<slice>` in the background; you are the non-author evaluator — re-run every gate
  yourself, read the full `git diff` hunk-by-hunk, commit only the verified surface.
- Generator/evaluator split, ≤3 review passes per slice, rule-12 quartet recorded per slice.
- Do NOT create `/opt/MEV/.credit-live` (authorizes standing-position submits — a fresh human gate).
- Never `rg -rn`/`-rln` (`-r` = `--replace`, corrupts reads).
- The D1–D4 invariants (doc §9.5) are non-negotiable: strategy values are `backrun|block-scan` only
  ("atomic" banned as a strategy value); edge-level `leavesStandingPosition` + derived plan flag;
  ONE LearningCase; fluid credit edge grandfathered live, hazard is submitting not membership.

## Appendix (READ before invoking any analysis tool). Two sections, append-only, never delete.

### A. Reasoning chain — the relay's decision logic, one self-contained entry per round
> Judgment only, not data (data → B). Kept clean/general so it is followable + reusable across rounds.

#### R-verify-1 · 2026-07-04
- blocker/gap: no pure-local slice remains to write. Git shows the scanner is offline-complete
  (BS-1a `2498cf0` · BS-2 `c0e617b` · BS-3a `7f66cb7`) on top of Phase-1 (S0/S1/S2, BS-0, BS-contract
  A/B/B2/C1/C2, BS-universe P1/P2, CR-3a/b). The previous relay round downgraded to Opus (541 opus
  turns in its transcript) and ended on a bare "already-completed" claim — a claim to CHECK, not trust.
- options + choice: (a) write the next ordered slice, or (b) independently verify + advance the
  done-counter. Rejected (a): the next unwritten slice BS-3 (full-pipeline sim→standalone bundle) needs
  a profitable block-scan fixture on a FORK, and everything after (CR-5 archive replay, BS-lane, BS-4
  live window, CS-min live-admission, CS-full/D/CR-8) needs the live node or archive — all operator-gated
  per §9.1/§9.3b, off-limits to this pure-local round (Step 2 discipline). Chose (b): re-ran every landed
  slice's rule-12 gate myself (13 suites + both tsc), all green, byte-identical backrun preserved.
- outcome: all pure-local handoff slices confirmed landed + gated → `consecutive_done_confirmations`
  0→1, `status: IN_PROGRESS` (need a 2nd independent round for COMPLETE). No slice written (none was
  writable pure-local); remainder handed to the operator. Gate evidence → HANDOFF-RELAY-STATUS log.

### B. Cached analysis data — avoid re-running tools (their volume triggers the opus fallback)
> One entry per tool call: tool · exact query/input · result (raw bulk → scratchpad file path).
> NOTE: the rule-12 *gate re-runs* below are deliberately NOT cached-to-skip — the 2-round
> done-bar (round doc Step 4b) requires each confirmation round to INDEPENDENTLY re-run them.
> This entry records the R-verify-1 outcome for audit only; the next round re-runs, it does not reuse.

#### rule-12 gate suite (local `npm run searcher:*` + `test:learning-case`) — R-verify-1
- result: ALL GREEN — blockscan-a0 19/19 · blockscan-scanner 10/10 · blockscan-solver-center 2/2 ·
  planner 15/15 + replay-fixtures 14/14 + high-spread universe · blockscan-contract 5/5 ·
  submission-coordinator 8/8 · bundle-router-safety 4/4 · cycle-fingerprint 7/7 · universe-split 6/6 ·
  standing-guard 4/4 · taxonomy 5/5 · replay-live-fixtures buckets unchanged (expired:1/no-profitable:1,
  byte-identical backrun) · learning-case 6/6 · tsc listener + analysis both CLEAN.
- raw: n/a (terse); no external analysis tool (bundle-postmortem/census/live-loss/chain trace) called
  this round — pure local gate re-runs, zero node/RPC.
- captured: R-verify-1 / 2026-07-04
