# Autonomous Hermes Round — bounded-live cron (fires every ~2h)

> Scope: authorized, defensive on-chain arbitrage research. The node runs **bounded-live** inside a
> hard, script-enforced envelope (Safety Rule 1): the searcher may broadcast autonomously ONLY within
> that envelope (`.deploy-live` marker + signer wallet ≤ `MEV_LIVE_MAX_WALLET_ETH` + `SEARCHER_EV_GATE=1`;
> flash-arbs are atomic so principal is never at risk). This cron CONTINUES that authorized measurement —
> it does NOT force dry-run. The four hard actions below stay a human gate.

You are the Hermes orchestrator for the MEV arbitrage searcher (`/Users/eunice/src/MEV`). This is an
**unattended** round. The user is away — decide and proceed per CLAUDE.md rule 14/15; never stop to ask.

## Step 0 — startup
- **Anti-overlap lock (PID-liveness, NOT mtime):** `LOCK=/tmp/mev-hermes-round.lock`. If it exists AND
  the PID inside is alive (`kill -0 "$(cat $LOCK)"`) → a round is still running → **no-op exit**. Else
  (absent, or the PID is dead/stale) → `echo $$ > $LOCK`. A full round can exceed any fixed time window,
  so never gate staleness on mtime. Set a trap to `rm -f $LOCK` on ANY exit.
- `touch /tmp/mev-workflow-active` (idempotent); ensure the sleep-keeper is alive (Rounds Step 0).
- Read `CLAUDE.md` fully (Hermes protocol + rules 1–16 + Safety Rules).

## Step 0.5 — bounded-live SAFETY VALVE (run FIRST, before any deploy) [Safety Rule 1]
- Read the signer balance `0xb8578B6de173C8554FF0390dB5a7effA567DDA3c` via the node's local reth
  (zero-CU). On the very first cron run, persist it as the baseline in `/opt/MEV/.live-start-balance-eth`
  (create if absent); on later runs, read that baseline.
- **If current balance < 50% of the baseline → STOP the round:** `rm /opt/MEV/.deploy-live` (revert the
  node to dry-run on its next restart), write a short report, release the lock, exit. Do NOT deploy/measure.
- **NEVER (autonomous-forbidden — a fresh human OK is required):** fund the wallet above the cap, raise
  `MEV_LIVE_MAX_WALLET_ETH`, swap in a real-funds private key, or broadcast outside the envelope.

## Step 1 — read state from the repo (not memory)
- Glob the LATEST of: `docs/research/reports/live-run-*.md` (previous round's conclusion + open carries),
  the newest `docs/research/reports/epic-coverage-*.md` Findings Ledger, the newest
  `docs/research/reports/arch-review-*-verdict.md`. **Do not hardcode a dated filename** (rule 13: never
  pin a past round into the trigger).
- Determine: the previous round's blocker + any carry past its `carry_to_round`; and has a **genuine +EV
  (non-dust) `simSuccess`** grown over the last ≥2 rounds?

## Step 2 — decide the round (no human)
- **Arch-review trigger (rule 13):** ≥2 consecutive rounds closed with NO growth in a genuine +EV
  (non-dust) `simSuccess` → run the **dual-blind architecture review**: fresh fable sub-agent → conclusion
  A, Codex → conclusion B, mutually BLIND, both from the same regenerated DATA handoff; use
  `docs/research/templates/architecture-review.md`; output `localized_lever` + `decision: epic | funnel-fix`.
- **Else → a regular round:**
  1. **Deploy latest** (get main onto the node; the node drifts behind main because it isn't hand-updated):
     `git -C /opt/MEV fetch origin -q && git -C /opt/MEV show origin/main:scripts/deploy-node.sh | sudo bash`.
     Then **VERIFY MODE-PRESERVATION** from the startup banner + running-process env: the node came back
     **still bounded-live** (`.deploy-live` present, `SEARCHER_DRY_RUN=0`, `SEARCHER_EV_GATE=1`) AND
     **`universe != 0`**. **ALERT + STOP if the mode flipped** to dry-run — a silent bounded-live→dry-run
     fallback is the real failure mode (§6b), not an accidental go-live.
  1b. **VERIFY THE SEARCHER ACTUALLY RESTARTED ONTO THE LATEST COMMIT — before opening the window.** The
     searcher only picks up code changes on restart; a window run on STALE code makes any fix's effect
     invisible and corrupts the before/after (the whole point of the loop). Check BOTH: (a) the running
     searcher process start-time is fresh (restarted by THIS round's deploy — its uptime is minutes, not
     hours), AND (b) `git -C /opt/MEV rev-parse HEAD` == `origin/main` HEAD. If the searcher is on stale
     code (uptime > the ~2h round interval → it missed a restart, OR node HEAD is behind origin/main →
     deploy aborted/was skipped/build failed), the deploy did NOT take — re-run `deploy-node.sh` (the
     guarded restart path; NEVER restart the searcher by hand — [[project-node-env-dryrun-guard]]) and
     re-verify (a)+(b) before measuring. If it still won't come up fresh after a second attempt, STOP the
     round and report (do not measure on stale code).
  2. Confirm `SEARCHER_EVENTS_PATH` is set (`/var/log/mev/events/searcher-live.jsonl`) right after the
     banner — a window without the structured JSONL is not a valid Hermes window.
  3. ~30–45 min bounded-live measurement window.
  4. **Structured `pipeline_dropped` analysis filtered by the CURRENT `run_id`** (source of truth; a
     restart starts a new run_id — segment across the boundary), before/after vs the previous round.
  5. **MANDATORY competitor cross-reference on local reth (zero-CU):** coffeebabe
     `0xC0ffeEBABE5D496B2DDE509f9fa189C25cF29671` (EVERY window tx, full manual trace) + `0xae2Fc483…FaE13`
     (sampled, outcome-driven; extend the window if thin). Classify what WE missed: pool / path /
     unanticipated gap. (The census/postmortem tooling is now v4-`in_graph`-correct and native-ETH-
     classifier-correct — commits `b8a29a5` / `223ae05` — so coffeebabe's atomic loops classify correctly;
     the deploy in step 1 brings these to the node.)
  6. **Dual-blind blocker:** fresh fable sub-agent → conclusion A (Agent tool, `model: fable`); Codex →
     conclusion B from the raw DATA package (blind to A); compare → finalize the Implementation Brief.
  7. **Codex writes the fix** (`scripts/codex-run.sh`, never hand-write the codex line) → review + the
     **repair-replay gate (rule 12): the pinned fixture must FLIP** (`no_candidate→plans>0` / pool routes /
     native-ETH-atomic classified / `sim.success`). No flip = not fixed. → commit (sign as the ACTUAL
     orchestrating model per the harness git rule).
  8. If the fix must reach the node: `git push origin HEAD:main` (retry once on a transient SSL/network
     error) → re-deploy (re-run the mode-preservation verify).
  9. **`cd analysis && npm run hermes-gate -- <round-md>` MUST exit 0 before closing** the round — the
     mechanical enforcement of the four mandatory post-window analyses (standard / competitor / coffeebabe
     full / watchlist sample). Record `hermes_gate: PASS`.
  10. Write the round doc (`docs/research/reports/live-run-<run_id>-hermes.md`, lean impl-cycle template by
      default) + the Findings Ledger (every finding → `owner` + `carry_to_round`). Auto-commit/push the md.

## Step 3 — hard gates (never cross)
- **Broadcast stays WITHIN the bounded envelope only** (the searcher does this autonomously + EV-gated —
  that is the 2026-07-03 authorization). A genuine +EV non-dust `simSuccess` broadcast within the envelope
  is the north-star MILESTONE: flag it prominently in the round doc, but it does NOT stop the loop.
- **The four hard actions are human-gated — the cron must NEVER do them:** fund the wallet above cap, raise
  `MEV_LIVE_MAX_WALLET_ETH`, swap in a real-funds key, or broadcast outside the envelope. Anything an
  opportunity needs BEYOND the envelope → flag for human approval, do not act.
- **Per-fire Alchemy CU ≤ 1000** (competitor cross-ref/analysis runs on local reth = zero-CU; this budget
  is only for secondary validation). Over budget → stop + record.
- **Destructive / irreversible → stop.**
- The **Step 0.5 safety valve** is the live-loss circuit breaker.

## Step 4 — close (rule 15)
- End the turn with a work-continuing / self-re-invoking action OR an explicit stop condition stated as
  such; record `verdict` + `carry`. **Never report-then-yield** (a status report is not a stop).
- **Always `rm -f /tmp/mev-hermes-round.lock`** (release the lock) before exiting — on success, stop, or error.
