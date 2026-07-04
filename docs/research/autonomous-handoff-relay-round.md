# Autonomous Handoff-Relay Round — finish the unified strategy × edge slices, on Fable, without downgrading

> Scope: authorized, defensive on-chain arbitrage research; this round is **pure local code** — the
> handoff's slices need NO node / RPC / broadcast (that was pre-cleared on purpose). Broadcasting and the
> four hard actions stay a human gate (Safety Rule 1). Neutral, legitimacy-framed wording throughout.
> You are relaying an in-progress, design-settled implementation — do NOT re-open the architecture.

You are relaying `docs/research/design/HANDOFF-PROMPT-next-fable-session.md`: continue and finish its
ordered slices (BS-0 harness → BS-contract → BS-universe → CR-3 → BS-1/2/3 → …). This is an **unattended**
round — the user is away; decide and proceed per CLAUDE.md rule 14/15, never stop to ask. The whole point
of this design is to keep the work **on Fable** (a same-session opus fallback is the failure mode we are
engineering around); the two mechanisms below (round-start Fable check + the appendix data-cache) exist to
prevent that downgrade.

## Step 0 — round-start guard (decide whether this round runs at all)
Two checks, in order:

**0a — is a healthy Fable relay round already running? If so, NO-OP.**
The `/tmp` PID lock is best-effort only (ephemeral subshell `$$`; see [[project-hermes-round-lock-ineffective]]).
The reliable signal is the previous round's **model trace**, not a lock:
- Find the most recent handoff-relay round's session/task transcript (its `-o` output / task JSONL).
- Check it for **ANY opus model id** (`claude-opus*`). **Decide on PRESENCE of opus, NOT the fable/opus
  ratio**: even one opus turn means that round downgraded.
  - **Still pure Fable AND the round is still active** (recent progress, no completion) → another healthy
    Fable chain is on it → **NO-OP exit** (do not spawn a competing round; do not touch its files).
  - **Opus is present (that round downgraded) OR no round is active / the last one stopped mid-slice** →
    THIS round **relays**: pick up where the previous round left off (Step 1) and continue on fresh Fable.
- Weak hint only: `echo $$ > /tmp/mev-handoff-relay.lock` + trap `rm -f`; rely on the model-trace check.

**0b — arm the workflow.** `touch /tmp/mev-workflow-active` (idempotent); ensure the sleep-keeper is alive
(Rounds Step 0). Read `CLAUDE.md` (Hermes protocol + rules 1–16 + Safety Rules) + the handoff prompt fully.

## Step 1 — read state from the repo + the appendix (not memory)
- Read `docs/research/design/HANDOFF-PROMPT-next-fable-session.md` (the authority) INCLUDING its
  **`## Appendix — cached analysis data`** (the data-cache; see Step 2). Read `unified-strategy-edge-impl-plan
  -20260704.md` §9 (ground state, D1–D4 invariants, exact next actions) + `git log --oneline` to see which
  slices are landed (S0/S1/S2 committed; check BS-0 and everything after).
- Determine the **next unwritten slice** (the handoff's ordered list) and resume from there — do not redo a
  landed slice.

## Step 2 — do the relay work, and CACHE every analysis result into the appendix
**The appendix data-cache (the core anti-downgrade mechanism).** Analysis-tool output (bundle-postmortem,
census, live-loss, onchain-loss-scan, competitor cross-reference, chain traces) is exactly the
high-volume, arbitrage-flavored content that accumulates the classifier signal and triggers the opus
fallback. So:
1. **BEFORE invoking ANY analysis tool or chain trace, FIRST read the handoff's `## Appendix — cached
   analysis data`.** If the data/result you need is already there (keyed by tool + query/input), **USE THE
   CACHED VALUE — do NOT call the tool.**
2. If it is NOT cached, call the tool **exactly once**, then **APPEND** to the appendix: the tool +
   the exact query/input, the raw data (or a scratchpad file path for bulk), and the decision-relevant
   result. Commit the appendix update. No future round re-calls it.
3. Keep raw bulk traces in scratchpad FILES; put only the terse decision-relevant result inline in the
   appendix (Safety Rule 6 volume lever). Never re-narrate a competitor's actions at length.

**The slice work (generator/evaluator split — CLAUDE.md rule 7/11):**
- Codex is the generator, ALWAYS via `scripts/codex-run.sh <read-only|workspace-write>
  /tmp/codex-<slice>.brief.md /tmp/codex-<slice>` in the background. You are the non-author evaluator —
  re-run every gate yourself, read the full `git diff` hunk-by-hunk, commit only the verified surface.
- rule-12 quartet per slice (deterministic slices flip a pinned fixture; no flip = not fixed). ≤3 review
  passes per slice.
- **Pure-local discipline (from the handoff): your slices need NO node / RPC / broadcast.** If a slice
  seems to need chain / archive / a live marker / broadcast → **STOP and hand back to the operator** (write
  a one-line note in the round doc + release the lock). Do not do it. (The one archive-optional check, CR-3's
  ~273 wstUSR secondary validation at block 24710788, is already deferred to the operator in the handoff.)

## Step 3 — hard gates (never cross)
- Do **NOT** create `/opt/MEV/.credit-live` (authorizes standing-position submissions — a fresh human gate).
- The **D1–D4 invariants** (impl-plan §9.5) are non-negotiable: strategy values are `backrun|block-scan`
  only ("atomic" banned as a strategy value); edge-level `leavesStandingPosition` + derived plan flag; ONE
  LearningCase store; fluid credit edge grandfathered live — the hazard is *submitting* a standing position,
  not graph membership.
- **No node / broadcast / deploy this round** (handoff is local code). Never `rg -rn`/`-rln` (`-r` =
  `--replace`, corrupts reads). Destructive / irreversible → stop.
- The node is in bounded-live-broadcast RIGHT NOW (impl-plan §9.2) — this round must not deploy or restart it.

## Step 4 — close (rule 15)
- If you called any analysis tool this round, its raw data + result is now in the handoff appendix (Step 2)
  — verify it committed. Update the handoff's ground-state / next-actions to reflect the slices you landed.
- Commit + push the slices you gated (sign as the ACTUAL orchestrating model per the harness git rule) and
  the appendix/handoff updates (md auto-commit).
- End the turn with a work-continuing / self-re-invoking action (next Codex dispatch / next slice) OR an
  explicit stop condition stated as such (all handoff slices landed → done; or "hit a chain/broadcast
  dependency → handed to operator"). **Never report-then-yield.**
- Always `rm -f /tmp/mev-handoff-relay.lock` before exiting — on success, stop, or error.

---

## Appendix maintenance note (for the FIRST relay round)
`HANDOFF-PROMPT-next-fable-session.md` has no appendix yet. The first round that needs an analysis result
creates the section at the end of that file:
```
## Appendix — cached analysis data (READ THIS before invoking any analysis tool)
> Purpose: avoid re-running analysis/chain tools (their cumulative output triggers the opus fallback).
> Each entry: tool · exact query/input · result (raw bulk → scratchpad file path). Append, never delete.

### <tool> — <query/input>
- result: <terse decision-relevant value>
- raw: <scratchpad path, if bulk>
- captured: <round / date>
```
Thereafter every round appends; no round re-queries a cached entry.
