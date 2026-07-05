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

> **⏸ DEFERRED (operator priority reorder, 2026-07-05 evening — supersedes the R-2b-6/R-2b-7 pause):**
> The flag human-gate is RESOLVED: the operator flipped `SEARCHER_SUBMIT_HASHONLY_MEVSHARE` and the
> measured window ran (decision-log **D-001**, run `0bf0319a`) — mechanical success, **zero inclusion**;
> **F-006** diagnosed the 100% relay-reject ("backrun not found") as a STRUCTURAL POSTURE gate (19/20
> referenced victims never land; latency/targetBlock proven inert). The lever moved to protocol/credit
> coverage: the operator drove Track A/B attended (impl-plan §9.4 reorder; A0–A6 protocol edges LIVE,
> venue registry + 6 ERC4626 vaults deployed, `95ec2ff`). The remaining Phase-2b tail (BS-3 exemplar,
> CR-5b–e, BS-lane, BS-4, CS-*/D/CR-8) is **operator-DEFERRED behind Track A/B** — do not pick it up
> unattended. Fast-path for future rounds: read `git log` + impl-plan §9.4 status; if no new operator
> input re-opens the tail (or hands the relay a Track-B slice), verify HEAD builds + status intact and
> close as deferred. The ~2h autonomous-hermes-round cron owns the live-window comparison.

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
3. **BS-3 full-pipeline — ⛔ EPIC-ESCALATED (R-2b-2, rule 13): BLOCKED on a viable +EV exemplar.**
   BS-3-solve landed (`c63e075`, `searcher:blockscan-fork-solve` 9/9) and PROVED the planner→solver→
   fork wiring works — but also PROVED `f2de7499` is un-usable: its profit is a stableswap-ng
   swap-time `stored_rates` refresh (appendix A R-2b-2), −EV on every pre-coffee fork, invisible to
   view-quotes. **Next step is NOT more harness code — it is exemplar DISCOVERY**: census for a
   genuinely-standing (view-quotable, multi-block-persistent) +EV block-scan case, OR an operator
   decision that block-scan's testable +EV requires stored_rate-refresh/oracle-event modeling. Once a
   viable exemplar exists, BS-3-sim (BotVM execute → standalone +EV BundleSubmission) is the remaining
   sub-slice. Original spec kept below for reference. Build a profitable block-scan fixture on a FORK (anvil against local reth
   or Alchemy) and gate the end-to-end scan→plan→sim→standalone-bundle path (dry-run router; no
   broadcast in the test). Gate: new suite flips no-bundle→bundle with expected profit.
4. **CR-5 credit adapter — ⚙ EPIC, DECOMPOSED (R-2b-3). Resume at sub-slice a.** CR-5 is a large
   multi-part behavior slice (impl-plan §277/§306); do it as ordered sub-slices, each its own rule-12
   gate + commit. CR-5's max-borrow equivalence TARGET is on-chain-verified: **≈270.1 wstUSR** (exact
   `270096803239981276728` wei; appendix B R-2b-3) — NOT the impl-plan's loose "~273".
   - **CR-5a — CR-3 secondary — ✅ VALIDATED (R-2b-4), no new harness needed.** The existing
     `searcher:ac3` already fork-replays block 24710788 and PASSES 2/2 (our credit-edge path
     self-composes 870.99 wstUSR via the fluid-vault leg — appendix B R-2b-4); the reference bot's
     270.1 wstUSR is on-chain-verified directly (appendix B R-2b-3). CR-3's "AC-3-style ~273 wstUSR
     delta" secondary is satisfied by these two together — a separate harness would just duplicate
     AC-3. Nothing to build.
   - **CR-5b — resolver `quote()` + deterministic max-borrow — ⚠ DESIGN-BLOCKED / ESCALATED (R-2b-4).**
     `quoteFluidVault()` (`quoter.ts:358`) THROWS today — there is NO deterministic Fluid quote path;
     the `fluidDebtBps` grid (`solver.ts:396`) is the only sizing. CR-5b must build the resolver-quote
     max-borrow FROM SCRATCH: the Fluid resolver contract (address + ABI + LTV/oracle max-borrow math,
     needs external protocol research), a real `quoteFluidVault`, solver integration, and an
     equivalence proof (deterministic max-borrow ≥ the grid's best profit on AC-3). This is a
     design/research-heavy slice, NOT a clean unattended one-pass — it needs a dedicated round with
     research budget (WebSearch the Fluid resolver + archive-probe the vault) or operator input. Do
     NOT rush it. Until it lands, the `fluidDebtBps` grid stays (AC-3 proves it works).
   - **CR-5c — per-adapter gas table** (credit leg 250–400k vs swap ~100k): fixes the gas=0
     over-ranking → dust-regime under-ranking. Local gate: dust-regime ranking fixture.
   - **CR-5d — EV-gate market-priced profit token** (peg-valued fails, market-valued passes only when
     genuinely +EV) + **Fluid feasibility drops** (`credit_infeasible`/`emode_required` →
     `pipeline_dropped`). Local gate + the drops assertion.
   - **CR-5e — guard WIRING re-asserted end-to-end** (not unit-only): fork-replay the `0xf88b` plan
     reaches the pre-EV-gate check and is rejected WITHOUT the `.credit-live` marker (never create it).
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

#### R-2b-2 · 2026-07-05
- blocker/gap: R-2b-1 handed BS-3 to the operator; on review that was over-conservative — BS-3 (anvil
  fork, dry-run, no broadcast) is squarely inside the Phase 2b authorization, not one of the four hard
  human gates. So this round PROCEEDED on BS-3 (rule 14) instead of re-handing-back.
- options + choice: de-risked BS-3 fully (confirmed `forkAfterTx` execution-state fork infra; got the
  fork anchor = block 25455297 txIndex 36; fixture already bit-exact). Structured BS-3 as sub-slices
  (rule 13; it's a large fork-integration slice) and dispatched the first, BS-3-solve (fork-state
  planner→solver, +EV solved plan). Codex built the harness (no network in its sandbox); I gated it
  against Alchemy archive myself.
- **Definitive finding (verified by running the fork, `c63e075`):** f2de7499 is NOT a viable +EV
  block-scan fork exemplar. On any pre-coffee fork state the curve pool holds the STALE boundary D166
  rate → `get_dy 1807346489 < flash 1807735808` = −EV, so the solver correctly returns no profitable
  plan. The +3.7bps bump to the execution rate that made coffee +EV is applied by the stableswap-ng
  pool refreshing `stored_rates` at coffee's OWN swap (the only curve interaction in the block) —
  invisible to view-quotes and absent from any pre-coffee fork. So coffee's profit is a swap-time
  stored_rate refresh (an oracle-staleness capture), NOT a standing dislocation. This confirms the
  market-ceiling reality at the fixture level: standing view-quotable +EV block-scan dislocations are
  dust ([[project-atomic-backrun-market-ceiling]]).
- outcome: committed BS-3-solve as a documenting VIABILITY PROBE (9/9) — it proves the block-scan
  planner→solver→fork wiring works AND deterministically pins the non-viability (stops re-attempts;
  if stored_rate-refresh modeling ever lands, the same harness flips +EV → promote the exemplar).
  **BS-3 full-pipeline is now rule-13 EPIC-escalated: it is BLOCKED on a genuinely-viable +EV
  block-scan exemplar, which we do not have** — the next step is census discovery of a real standing
  (view-quotable, multi-block) +EV block-scan case, OR a decision that block-scan's testable +EV
  requires stored_rate-refresh / oracle-event modeling (a scanner-capability question). Handed to the
  operator/next round with all de-risk data. `consecutive_done_confirmations: 0`, IN_PROGRESS.

#### R-2b-3 · 2026-07-05
- blocker/gap: BS-3 is discovery-blocked (needs a viable exemplar, not code). Picked up the next
  UNBLOCKED Phase 2b slice — item 4, CR-5 credit adapter + CR-3 secondary (the `0xf88b` wstUSR archive
  replay). On inspection CR-5 is a LARGE multi-part behavior slice: resolver `quote()` + deterministic
  max-borrow + `fluidDebtBps`-search-delete equivalence + per-adapter gas table + EV-gate market-priced
  profit token + Fluid feasibility drops + guard-wiring fork re-assertion (impl-plan §277/§306).
- options + choice: (a) cram CR-5 onto this long single-session context, or (b) verify CR-5's key
  archive input now + decompose it as an epic for a fresh round. Chose (b): this session already landed
  3 slices (BS-0-curve, edge-kinds, BS-3-solve) and the relay design explicitly wants FRESH context for
  a new large slice (Rounds step 4 anti-degradation) — a rushed archive-gated adapter on a stale context
  is lower-integrity than a clean decomposition. Verified the one unambiguous, bounded datum the whole
  slice pivots on: the reference bot's realized on-chain wstUSR delta (CR-5's max-borrow equivalence
  target). CR-5 decomposed into ordered sub-slices below.
- outcome: no code slice this round (CR-5 is a fresh-context epic); verified ~270.1 wstUSR target
  cached (B) + CR-5 sub-slice decomposition written to the Phase 2b list. `consecutive_done_confirmations:
  0`, IN_PROGRESS. Next round executes CR-5 sub-slice 1.

#### R-2b-4 · 2026-07-05
- blocker/gap: picked up CR-5 (BS-3 still discovery-blocked). Goal: ship CR-5's first sub-slice.
- options + choice: (a) build CR-5a as a new ~270.1-wstUSR harness, or (b) check whether existing
  tooling already covers it. Chose (b) — ran `searcher:ac3` on archive: PASS 2/2, our credit path
  extracts 870.99 wstUSR on block 24710788 (> reference bot's on-chain-verified 270.1). So CR-3's
  secondary is ALREADY validated (AC-3 + the R-2b-3 on-chain read) — a CR-5a harness would just
  duplicate AC-3 (rule-17: don't re-derive what a tool already does). Then attempted CR-5b (the real
  behavior change): found `quoteFluidVault()` THROWS — no deterministic Fluid quote path exists; the
  `fluidDebtBps` grid is the only sizing. CR-5b must build the resolver-quote adapter from scratch +
  external protocol research → too large for a clean unattended one-pass.
- outcome: CR-5a validated (no build), CR-5b design-blocked/escalated (rule 13 — the behavior slice
  can't be cleanly shipped unattended without a research round). Next TRACTABLE behavior slice =
  CR-5c (per-adapter gas table, local, no resolver dependency) or BS-lane; routed the next round
  there. No hot-path code changed this round; the `fluidDebtBps` grid stays (AC-3 proves it works).
  `consecutive_done_confirmations: 0`, IN_PROGRESS.

#### R-2b-5 · 2026-07-05
- blocker/gap: rule-13 mandate to ship a behavior change (after R-2b-3/4 non-behavior). Investigated
  both available behavior slices; neither is a clean, genuinely-catches-more-MEV one-pass slice.
- options + choice: (a) CR-5c gas table — traced every insertion point: the EV gate ALREADY uses real
  `sim.gasUsed` (`main.ts:1919`, not gas=0 as an old memory claimed); within-plan solver top-N has
  CONSTANT gas across candidates (no ranking effect); cross-plan pre-solve ordering has no profit
  signal yet (gas-only ordering is a fuzzy heuristic). So there is no clean gas-table insertion that
  improves selection without a coordinated design pass — CR-5c is not the quick local slice the
  decomposition assumed. (b) BS-lane — self-contained but it's flag-gated construction that catches
  NOTHING new until BS-4 wires the trigger (rule-13 impact lens = a null round), and building lane
  infra for a strategy at the dust ceiling is a strategic call. Chose (c): ESCALATE. Neither slice is
  a genuine +EV behavior improvement; combined with BS-3 (discovery-blocked/dust) + CR-5b
  (design-blocked) + no +EV `simSuccess` growth across rounds, the rule-13 ARCHITECTURE-REVIEW trigger
  has fired.
- outcome: no code slice (correctly — shipping BS-lane null-infra or a half-CR-5c would be lower
  integrity than escalating). Spawned operator chip `task_3246ef5f` (strategic fork: block-scan-dust
  vs credit-resolver-research). Next round = the rule-13 architecture review in a fresh context
  (dual-blind, frame-audit first), NOT another point-fix. `consecutive_done_confirmations: 0`,
  IN_PROGRESS. This is the honest end of the cleanly-autonomous Phase 2b work — the remainder needs
  human/design input.

#### R-2b-6 · 2026-07-05 (arch review — logged here retroactively by R-2b-7 for chain continuity)
- blocker/gap: rule-13 architecture-review trigger (fired R-2b-5). Ran the mandated dual-blind review
  in fresh contexts instead of a point-fix.
- options + choice: frame-audit first (per the trigger's mandate) → discovered the frame itself was
  wrong: a bounded-live window WAS running all along, unread by the relay. A (fable, chain+code) and
  B (Codex, code-only) converged: the lever is FLOW-ADMISSION at our own submit gate — 95.3% of 3,889
  +EV sims self-dropped at `hash_only_unmatchable` because `SEARCHER_SUBMIT_HASHONLY_MEVSHARE` is
  unset while the `submitMevShareBundle` drain is already built. Rejected: new epics, Phase-2b
  scaffolding as the lever, bid-policy changes.
- outcome: verdict committed (`arch-review-20260705-verdict.md`, `abc0eca`); fix = one config flag =
  broadcast-behavior change = HUMAN GATE → escalated (chip `task_3deb3186`), did NOT auto-flip.
  Phase-2b scaffolding paused pending the decision. Process fix recorded: every round reads the live
  events first.

#### R-2b-7 · 2026-07-05
- blocker/gap: all remaining paths blocked on the R-2b-6 human gate. Round's job reduced to: has the
  operator acted? and is the live window healthy?
- options + choice: (a) pick up a Phase-2b slice anyway — rejected (verdict pauses scaffolding;
  BS-3 discovery-blocked, CR-5b design-blocked, CR-5c no clean insertion, BS-lane null infra);
  (b) re-run the arch review — rejected (nothing changed; re-deriving a cached verdict is waste);
  (c) verify the gate state read-only + safety-valve + funnel freshness, record, close as blocked.
  Chose (c). Node env (PID 177547, up 12h54m): flag still ABSENT → operator has not acted. Signer
  balance 0.002704 ETH ≈ start (0.0027) → no drain, valve fine. Funnel tail: 86 `hash_only_unmatchable`
  / 0 `bundle_submitted` — profile identical to the R-2b-6 measurement (no re-measurement needed).
- outcome: no code slice (correctly — blocked on Safety-Rule-1 human gate). Wrote the fast-path note
  (status file + Phase 2b header) so future rounds close cheaply until the operator acts. Counter
  stays 0, IN_PROGRESS. Post-flip playbook pre-recorded in the Phase 2b pause note.

#### R-2b-8 · 2026-07-05
- blocker/gap: the R-2b-7 fast-path condition ("flag unset, operator hasn't acted") was STALE — the
  operator acted attended: D-001 (flag flipped + measured window `0bf0319a`) and F-006 (100%
  relay-reject = structural posture gate, not timing/code) landed in the decision log, and the
  operator drove Track A/B to A6-live + venue-registry (impl-plan §9.4 reorder). The last attended
  session ended at an explicit clean terminus ("nothing more to push tonight; the ~2h hermes cron
  owns tomorrow's comparison") but left HEAD BROKEN: `venue-registry.ts` (committed `e0a223f`)
  imports `KNOWN_EXCLUDED_ADDRESSES` while the export edit sat uncommitted in the working tree.
- options + choice: (a) pick up the Phase-2b tail (CR-5d was never individually ruled out) —
  rejected: the operator's same-day reorder defers the whole CR-5 epic + BS tail behind Track A/B,
  and the operator explicitly closed the evening with "don't fabricate work"; barging into a
  deferred epic unattended would contradict fresh operator direction (R-2b-5 integrity principle).
  (b) re-run the arch review / re-measure the flag window — rejected: cached (D-001/F-006), nothing
  changed. Chose (c): fix the broken HEAD (rule-12 flip: analysis tsc TS2459 at HEAD → CLEAN with
  the one-line export; `test:venue-discovery` 2/2; commit `ce495f2`), refresh the stale Phase-2b
  pause header to the DEFERRED state with a new fast-path, close as deferred.
- outcome: HEAD un-broken (`ce495f2`); Phase-2b header + status-file fast-path updated (check
  git log/§9.4 for operator re-open; else verify HEAD builds + close as deferred). Counter stays 0,
  IN_PROGRESS — deferred tail still exists, so no done-confirmation is claimable.

#### R-2b-9 · 2026-07-05
- blocker/gap: none new — pure fast-path round. Zero commits after `8d02cc5` (R-2b-8's own), no
  operator input in git log or impl-plan §9.4 that re-opens the Phase-2b tail or hands the relay a
  Track-B slice; the tail (BS-3 exemplar, CR-5b–e, BS-lane, BS-4, CS-*/D/CR-8) stays
  operator-DEFERRED behind Track A/B per the §9.4 reorder.
- options + choice: (a) pick up a deferred-tail slice unattended — rejected, contradicts the
  operator's same-day defer (R-2b-8 reasoning holds unchanged). (b) run live-window analysis —
  rejected, the ~2h autonomous-hermes-round cron owns live comparisons (R-2b-8 terminus). Chose (c)
  the recorded fast-path verbatim: verify HEAD builds + close as deferred, no code.
- outcome: HEAD `8d02cc5` verified green — listener tsc CLEAN, analysis tsc CLEAN,
  `test:venue-discovery` 2/2 (last-touched surface). No slice landed (correctly — none available).
  Counter stays 0, IN_PROGRESS; fast-path remains valid for the next round.

#### R-2b-10 · 2026-07-05
- blocker/gap: none new — second consecutive pure fast-path round. Zero commits after `3bde999`
  (R-2b-9's own, 21:08; this round opened 22:05), no operator input in git log or impl-plan §9.4
  re-opening the Phase-2b tail or handing the relay a Track-B slice; tail stays operator-DEFERRED
  behind Track A/B.
- options + choice: R-2b-9's reasoning holds verbatim (no new facts to re-weigh): rejected picking
  up a deferred slice or live-window analysis; ran the recorded fast-path — verify HEAD builds,
  close as deferred, no code.
- outcome: HEAD `3bde999` verified green — listener tsc CLEAN, analysis tsc CLEAN,
  `test:venue-discovery` 2/2. No slice landed (none available). Counter stays 0, IN_PROGRESS.
  Note for future rounds: consecutive no-op fast-path rounds are expected while the tail is
  operator-deferred; the loop's real exit is either operator re-open (work resumes) or an operator
  decision that Phase 2b is done as-scoped (then the 2-confirmation done-bar applies).

#### R-2b-11 · 2026-07-05
- blocker/gap: none new — third consecutive pure fast-path round. Zero commits after `9a92fec`
  (R-2b-10's own, 22:07), no operator input in git log or impl-plan §9.4 re-opening the Phase-2b
  tail or handing the relay a Track-B slice; tail stays operator-DEFERRED behind Track A/B.
- options + choice: R-2b-8's fast-path remains operative; no new facts to re-weigh. Rejected
  picking up a deferred slice (operator-deferred) or live-window analysis (owned by the ~2h hermes
  cron); ran the fast-path — verify HEAD builds, close as deferred, no code.
- outcome: HEAD `9a92fec` verified green — listener tsc CLEAN, analysis tsc CLEAN,
  `test:venue-discovery` 2/2. No slice landed (none available). Counter stays 0, IN_PROGRESS.

#### R-2b-12 · 2026-07-06
- blocker/gap: none new — fourth consecutive pure fast-path round. Zero commits after `b0b957b`
  (R-2b-11's own, ~23:15; this round opened 00:05), working tree clean, no operator input in git
  log or impl-plan §9.4 re-opening the Phase-2b tail or handing the relay a Track-B slice; tail
  stays operator-DEFERRED behind Track A/B.
- options + choice: R-2b-8's fast-path remains operative; no new facts to re-weigh. Rejected
  picking up a deferred slice (operator-deferred) or live-window analysis (owned by the ~2h hermes
  cron); ran the fast-path — verify HEAD builds, close as deferred, no code.
- outcome: HEAD `b0b957b` verified green — listener tsc CLEAN, analysis tsc CLEAN,
  `test:venue-discovery` 2/2. No slice landed (none available). Counter stays 0, IN_PROGRESS.

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

#### searcher:ac3 — archive-fork replay of block 24710788 (CR-3 secondary validation), 2026-07-05
- input: `npm run searcher:ac3` against `$MAINNET_RPC_URL` archive (AnvilStateBackend fork; full
  HotPathSearcher detector→planner→solver→simulator→DryRun over VICTIM_FIXTURES).
- result: **PASS 2/2**. On the wstUSR victim `0xc52bc6f4` (block 24710788) our credit-edge path
  self-composes a profitable arb via the `fluid-vault` credit leg → psm → univ4 → curve×3, best
  netProfit = **870.985639595371182157 wstUSR** (> 543 threshold, > the reference bot's 270.1). The
  accepted plan used `fluidDebtBps=10400` (the grid's feasible optimum; 10800/11200 REVERTED =
  over-borrow infeasible). → CR-3 secondary is VALIDATED on-chain: the credit-edge economics on the
  real archive block are confirmed, and our extraction exceeds the reference realized amount.
- finding for CR-5b: `quoteFluidVault()` (`quoter.ts:358`) THROWS ("fluid-vault requires solver debt
  search") — there is NO deterministic Fluid quote path today; the `fluidDebtBps` grid
  (`[8500,9500,10000,10400,10800,11200]`, `solver.ts:396`) is the ONLY sizing. So CR-5b is a
  from-scratch resolver-quote adapter, not a quick sub-slice (see Phase 2b CR-5b note).
- captured: R-2b-4 / 2026-07-05

#### Alchemy archive — reference bot wstUSR realized delta on 0xf88b (CR-5 max-borrow target), 2026-07-05
- input: `cast call wstUSR balanceOf(0xE08D97e1…472D015)` at blocks 24710787 (pre) and 24710788 (post)
  via `$MAINNET_RPC_URL` archive (block past reth prune — archive required). wstUSR =
  `0x1202F5C7b4B9E47a1A484E8B270be34dbbC75055`.
- result: pre = **0**, post = **270096803239981276728** (270.096803… wstUSR). The reference bot netted
  **≈270.1 wstUSR** in-block (its arb is tx index 8). This is the on-chain-verified value behind the
  impl-plan's "~273 wstUSR" approximation → **CR-5's deterministic max-borrow equivalence gate target =
  ~270.1 wstUSR** (use the exact wei for a tolerance-band assert; the +WETH leg is separate). Bounded CU
  (2 archive eth_calls).
- captured: R-2b-3 / 2026-07-05

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
