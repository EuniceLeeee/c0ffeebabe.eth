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
> **SUPERSEDED 2026-07-05 (operator approval) — see `## Phase 2b` below.** The pure-local phase is
> complete (2× verified); the operator approved the chain-enabled remainder. This section is kept
> for history only.
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

## Phase 2b — operator-approved chain-enabled slices (2026-07-05; this is the CURRENT work list)

The operator reviewed the operator-gated remainder on 2026-07-05 and approved **all of it** for the
autonomous relay, EXCEPT the credit-live human gate (still forbidden, see Authorization scope). This
supersedes the "No node / RPC" section above and impl-plan §9.3b's "stay pure-code / hand back" rule
for the slices listed here. Ordered list (resume at the first not-landed one; verify against git):

1. **BS-0-curve — ✅ LANDED `9135cbc` (R-2b-1, 2026-07-05).** Curve pool `0x6206ca31` state captured
   read-only from local reth (zero-CU; block still un-pruned); leg 3 upgraded receipt-anchored →
   node-state-verified (`curveNgGetDy` bit-exact both rates). `searcher:blockscan-a0` 23/23. Finding
   recorded: boundary loop is −EV (−389319); the oracle update is the trigger (see appendix A R-2b-1).
2. **Chip `task_45c7379e` — ✅ LANDED `a6b72cd` (R-2b-1).** `deriveEdgeKindsFromLogs` replaces the
   `["swap"]` hardcode in both LearningCase producers; `test:learning-case` 8/8.
3. **BS-3 full-pipeline — ⛔ HANDED BACK (R-2b-1): needs an execution-state fork + operator design
   call.** The `f2de7499` exemplar is boundary-−EV (appendix A R-2b-1), so a boundary-state fork sim
   cannot be profitable — BS-3 needs a new boundary-profitable exemplar OR a mid-block fork, and its
   gate needs the node's anvil-fork-of-local-reth. Resume here. Build a profitable block-scan fixture on a FORK (anvil against local reth
   or Alchemy) and gate the end-to-end scan→plan→sim→standalone-bundle path (dry-run router; no
   broadcast in the test). Gate: new suite flips no-bundle→bundle with expected profit.
4. **CR-5 credit adapter** + **CR-3 optional secondary** (same archive block, do together): fork
   replay of `0xf88b` at block 24710788 via `$MAINNET_RPC_URL` archive (past reth prune); assert the
   AC-3-style ~273 wstUSR delta for CR-3's secondary validation. Gate per impl-plan §CR-5.
5. **BS-lane.** Concurrent block-scan lane in the live process (code local; gate on
   `searcher:replay-live-fixtures` byte-identical backrun + new lane unit tests; no deploy needed yet).
6. **BS-4 live window.** Deploy via `scripts/deploy-node.sh` ONLY (its guard envelope decides
   live/dry from the node marker — do not touch the marker), mode-preservation verify + debounce
   (≤1 deploy per window/hour), run a measured window, then the full Hermes Step-1 competitor
   cross-ref + `hermes-gate` PASS. Bounded-live safety valve applies (wallet <50% of start →
   `rm /opt/MEV/.deploy-live`, stop, report).
7. **CS-min → CS-full → D → CR-8** per impl-plan order, each with its own rule-12 gate.

**Authorization scope (operator, 2026-07-05):**
- ALLOWED: read-only chain access (local reth via SSM preferred = zero-CU; Alchemy
  `$MAINNET_RPC_URL` only for archive blocks past prune, keep it to the named checks — rule-10 CU
  discipline applies); anvil forks; node deploys ONLY via `deploy-node.sh` for BS-4.
- STILL FORBIDDEN (fresh human gate each): creating `/opt/MEV/.credit-live` (standing-position
  submits), funding the wallet / raising `MEV_LIVE_MAX_WALLET_ETH`, swapping keys, any broadcast
  outside the bounded envelope, destructive/irreversible ops.
- Relay mechanics unchanged: Codex generator via `codex-run.sh` (Opus 4.8 Agent fallback if Codex
  stalls), Fable non-author evaluator, ≤3 passes, rule-12 quartet per slice, appendix A/B upkeep.

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

#### R-verify-2 · 2026-07-04
- blocker/gap: none new. Step-0b found the prior round (R-verify-1) had downgraded (42 opus turns in
  its transcript) and was inactive → this round ran as the fresh-Fable relay. Its "all done,
  done-confirm 0→1" was treated as a claim to CHECK (round-doc Step 1), not trusted.
- options + choice: only one path — independent verification (Step 4b). Confirmed no writable
  pure-local slice exists (same §9.1/§9.3b reading as R-verify-1: BS-3 full-pipeline needs a fork
  fixture; BS-lane/BS-4/CR-5/CS-*/D/CR-8 are operator-gated), verified all 17 slice commits in git,
  then re-ran the full gate suite MYSELF on this session (13 suites + learning-case + both tsc) —
  did NOT reuse R-verify-1's cached results, per the Section-B note. Entire round stayed pure Fable,
  zero analysis-tool calls, zero node/RPC.
- outcome: ALL GREEN, matching R-verify-1 independently → `consecutive_done_confirmations` 1→2 →
  `status: COMPLETE`. The relay loop is OFF (Step 0a NO-OPs every future round). Remainder is
  operator-gated; hand-back note stands.

#### R-2b-1 · 2026-07-05
- blocker/gap: Phase 2b opened (operator-approved chain-enabled slices). Two tractable slices were
  writable this round; the third (BS-3 full-pipeline) surfaced a premise-changing finding.
- options + choice: worked the Phase 2b list in order. (1) BS-0-curve (TIME-SENSITIVE, prune window):
  captured the stableswap-ng curve pool state read-only from local reth (zero-CU, block still
  un-pruned) and upgraded leg 3 from receipt-anchored to state-verified — `curveNgGetDy` is bit-exact
  at both boundary and execution rates. (2) edge-kinds chip: replaced the `["swap"]` hardcode in both
  LearningCase producers with topic0-derived edge kinds. Both gated + committed. (3) BS-3: STOPPED and
  handed back — see finding.
- **BS-3 finding (the reason for handback):** our ONLY block-scan exemplar (`f2de7499`) is **−EV at
  the block-25455296 boundary** (surplus −389,319 USDC units); its +$0.55 realized profit exists only
  AFTER an intra-block D166 rate-oracle update (+3.7bps) that lands before coffee's txIndex 37. So a
  "profitable block-scan fixture on a boundary-state fork" (BS-3 as written) cannot be built honestly
  from this exemplar. BS-3 needs EITHER a new genuinely-boundary-profitable block-scan exemplar (via
  the census) OR a mid-block / execution-state fork (fork at 25455297 after the oracle-update tx,
  before txIndex 37). Its end-to-end gate also needs the node's anvil-fork-of-local-reth environment
  (`replay-v4-native-arb.ts` pattern: `SEARCHER_LIVE_RPC_URL=local reth`). This is a design fork +
  node/fork-infra dependency → operator decision. The remainder (CR-5 archive replay, BS-lane, BS-4
  live window, CS-min/CS-full/D/CR-8) stays operator-gated behind it.
- outcome: 2 slices landed + gated (`9135cbc`, `a6b72cd`); BS-3 handed back with the boundary-−EV
  finding. Work remains → `consecutive_done_confirmations: 0`, `status: IN_PROGRESS`.

### B. Cached analysis data — avoid re-running tools (their volume triggers the opus fallback)
> One entry per tool call: tool · exact query/input · result (raw bulk → scratchpad file path).
> NOTE: the rule-12 *gate re-runs* below are deliberately NOT cached-to-skip — the 2-round
> done-bar (round doc Step 4b) requires each confirmation round to INDEPENDENTLY re-run them.
> This entry records the R-verify-1 outcome for audit only; the next round re-runs, it does not reuse.

#### node reth reads — curve pool 0x6206ca315c2fcdd2a857b47efb285aa12c529a7a @ blocks 25455295–25455298 (BS-0-curve)
- input: SSM read-only `eth_call`/`eth_getLogs` on the node's local reth (zero-CU), 2026-07-05; head
  was 25460848 (block still in prune window). Selectors: A/fee/offpeg_fee_multiplier/stored_rates/
  balances/coins/get_dy.
- result: pool is **stableswap-ng** 2-coin, coins=[USDC, D166]. `A=200`, `fee=1000000` (1e10 denom),
  `offpeg_fee_multiplier=100000000000`. Balances @25455296 boundary =
  `[385138018042, 1272541181204127929026946]`. `stored_rates` @25455296 =
  `[1e30, 893440000000000000]`; @25455297 (post-block) = `[1e30, 893771000000000000]` → **D166 has a
  live rate oracle that updated INSIDE block 25455297 before txIndex 37** (+3.7bps). Only pool event
  in 25455297 = the exemplar's own TokenExchange (txIndex 37). On-chain
  `get_dy(1,0,2040627466925953875895)` @25455295 AND @25455296 = `1807346489`.
- cross-check (local, bit-exact both ways): repo `curveNgGetDy` with boundary rates → 1807346489
  (== on-chain get_dy); with execution rates → 1808005999 (== realized). **Boundary-state loop
  surplus = −389319 (NOT +EV); +270191 exists only under the oracle-updated rate** — the exemplar's
  trigger is the D166 rate-oracle update, not a pure block-boundary standing dislocation.
- raw: scripts + outputs in session scratchpad (`curve-read.sh`, `curve-logs.sh`, `curve-rates2.sh`);
  decision-relevant values all inline above and persisted into the fixture.
- captured: R-2b-1 / 2026-07-05

#### node reth reads — block 25455297 tx anchors (BS-3 execution-state fork), 2026-07-05
- input: SSM read-only `eth_getBlockByNumber` 0x1846ac1 on local reth (zero-CU). Block has 160 txs.
- result: coffee's block-scan tx `0xf2de7499…` is at **txIndex 37**; the tx immediately before it is
  **txIndex 36 = `0x82c315049171b73a30587e23fdbe52a810dc56e431fb17aaf91ef657882275d3`**. Forking via
  `AnvilStateBackend.forkAfterTx("0x82c31504…")` (anvil `--fork-transaction-hash`) yields the
  EXECUTION state (all txs 0..36 applied, incl. the intra-block D166 oracle update) where the 4-leg
  loop is +EV — the correct fork anchor for BS-3 full-pipeline. (Boundary fork at 25455296 would be
  −EV, per R-2b-1.)
- design note (sharpened R-2b-2): f2de7499 is an **oracle-update backrun consumed same-block**, not a
  standing cross-block dislocation — a pure boundary scanner wouldn't see it. It is usable as the
  BS-3 fork exemplar ONLY via the execution-state anchor above; it is NOT evidence that standing
  boundary dislocations are +EV (they are dust — see [[project-atomic-backrun-market-ceiling]]).
- captured: R-2b-2 / 2026-07-05

#### rule-12 gate suite (local `npm run searcher:*` + `test:learning-case`) — R-verify-1
- result: ALL GREEN — blockscan-a0 19/19 · blockscan-scanner 10/10 · blockscan-solver-center 2/2 ·
  planner 15/15 + replay-fixtures 14/14 + high-spread universe · blockscan-contract 5/5 ·
  submission-coordinator 8/8 · bundle-router-safety 4/4 · cycle-fingerprint 7/7 · universe-split 6/6 ·
  standing-guard 4/4 · taxonomy 5/5 · replay-live-fixtures buckets unchanged (expired:1/no-profitable:1,
  byte-identical backrun) · learning-case 6/6 · tsc listener + analysis both CLEAN.
- raw: n/a (terse); no external analysis tool (bundle-postmortem/census/live-loss/chain trace) called
  this round — pure local gate re-runs, zero node/RPC.
- captured: R-verify-1 / 2026-07-04
