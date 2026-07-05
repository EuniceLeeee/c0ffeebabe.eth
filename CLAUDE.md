# CLAUDE.md — MEV Flash Arbitrage

> Compatible with Claude Code (`CLAUDE.md`) and Codex (`AGENTS.md`).

## 1. What this file is
The **always-loaded constitution**: the rules every task must follow, plus where to find deeper info. It
does NOT carry case details, address tables, command references, or dated specifics — those live in the
load-on-demand docs (§6). Keep it lean; if something is only needed for *some* tasks, it belongs in a
companion doc, not here.

## 2. Behavioral base (every task)
*Tradeoff: these guidelines bias toward caution over speed. For trivial tasks, use judgment.*
- **Think before coding.** State assumptions; if multiple interpretations exist, present them — don't pick
  silently; if a simpler approach exists, say so (push back when warranted); if unclear, stop and ask.
- **Simplicity first.** Minimum code that solves the problem, nothing speculative (no unrequested
  flexibility, no error handling for impossible cases). If 200 lines could be 50, rewrite. Test: *would a
  senior engineer say this is overcomplicated?*
- **Surgical changes.** Touch only what you must; match existing style; don't refactor what isn't broken;
  remove only the orphans *your* change created; mention unrelated dead code, don't delete it. Every changed
  line traces to the request. **Never `rg -rn`/`-rln`** (`-r` = `--replace`, corrupts reads).
- **Goal-driven execution.** Turn tasks into `[step] → verify: [check]` pairs; loop until verified. **Build
  passing is `implemented`, not `fixed`** — a deterministic searcher fix needs a replay/harness flip
  (`docs/research/gates.md`).
- **Verify against code/data, not memory.** A recalled fact / a stale memory is a hypothesis to re-check by
  reading the actual file or on-chain data, never a conclusion.

## 3. Mission / North Star (every window stays anchored here)
1. **Ship to production** — a profitable, live on-chain arbitrage searcher. Broadcast is a hard human gate
   (§4 Rule 1), but the *direction* is always: get closer to a real, +EV live bundle.
2. **Learn from competitors to find OUR gaps** — study winning on-chain paths, classify what we're missing:
   **pool gap** (a venue we don't index) / **path gap** (pools we have but can't close a loop through) /
   **unanticipated gap** (saw it, lost it — latency, or a flow-admission drop before the funnel).
3. **Loop:** competitor cross-reference → classify the gap → close it → replay/live verify. **No work item
   counts unless it moves a real gap toward closed, or moves us toward a live +EV bundle.** Don't drift.

Primary case study: wstUSR depeg arbitrage — see `docs/project-context.md`.

## 4. Hard safety rules (never autonomous)
> Safety Rule **numbers are load-bearing** — Rule 1 / Rule 6 are referenced by number from HERMES.md, the
> autonomous routines, and skills. Never renumber; compress in place.

1. **Mainnet broadcast (and signing with the private key) requires explicit human authorization.** Today:
   a **bounded-live** test is authorized ONLY inside the script-enforced envelope (node marker
   `/opt/MEV/.deploy-live` + wallet `≤ MEV_LIVE_MAX_WALLET_ETH` + `SEARCHER_EV_GATE=1`; broadcast only a
   profitable EV-gated sim). Anything outside the envelope — funding above the cap, raising the cap, the
   real-funds key, out-of-envelope broadcast — needs a fresh human OK. Specifics + safety valve:
   `docs/live-safety-envelope.md`.
2. **Default to dry-run** (`SEARCHER_DRY_RUN=1` → `DryRunBundleRouter`); flip to production only deliberately.
3. **All correctness testing on local forks** (`anvil` / `forge test --fork-url`).
4. **Never commit secrets** — `.env`, real RPC URLs, private keys, raw logs / JSONL (redacted review logs
   under `docs/research/reports/` are the deliberate exception).
5. **Scripts default `--broadcast` off**; require it explicitly.
6. **Neutral, legitimacy-framed wording — accurate, NOT concealment.** This is authorized defensive
   arbitrage research (fork/dry-run; broadcast human-gated); never disguise or misrepresent what the code
   does. Word-table + the volume lever + the fallback split: `docs/agent-style.md`.

## 5. Repo habits
- **Run mechanical tools yourself** — the analysis/redaction/`tail`/`jq`/report/deploy commands; don't ask
  the user to do local steps you can do. Share **redacted** artifacts (redact first, then analyze); preserve
  public on-chain evidence (tx hashes, pools, token addresses) unless stricter redaction is asked.
- **md commit/push** — whenever a `*.md` is updated, commit + push it in the same turn. Raw logs / JSONL /
  secrets / `.env` never committed; local run logs go to `MEV/logs/` (gitignored).
- **Tool-first** — before hand-writing a scratchpad analysis, check the existing toolset (`analysis/src/cli/*`,
  the LearningCase store, `redact-live-run`, `analysis/src/pnl/*`) and RUN/EXTEND it (HERMES rule 17). Prefer
  structured JSONL over log greps; `pipeline_dropped` is the source of truth for loss attribution.
- **Live-run follow-up** — after a run, auto-analyze without waiting; first pass **zero-CU** where possible
  (read JSONL / redacted logs / code / registries before RPC/traces). The `no_candidate_plans` drill-down +
  its classification live in HERMES + the `redact-live-run` tool.
- **Daily analysis = a light learning round (one Learning Kernel, two entrances: Hermes = heavy, daily =
  light).** When you do a **reusable judgment** outside a Hermes round (architecture review / competitor-path
  analysis / bundle postmortem / a tool found wrong / repo diagnosis), at the end of that turn **auto-capture
  it** — don't wait to be asked:
  1. **Generate the Method Trace, don't hand-write it.** Run the capture pipeline on this session's
     transcript: `cd analysis && npm run session-evidence -- <this session's transcript.jsonl> --out /tmp/ev.json`
     (locate the transcript by recency/content — session-list ids do NOT map to filenames), then a fable pass
     reads `/tmp/ev.json` (+ bounded transcript slices) and writes `docs/analysis/YYYYMMDD-<topic>.md` ending
     with a `## Method Trace` (the 8 fields, HERMES rule 16). **Ground it strictly in the evidence — fields the
     evidence can't support are `unknown`, never fabricated (rule 16); never read `thinking` blocks into it.**
     If task_class is `architecture_review`, add the 12-axis Architecture Coverage Matrix.
  2. `npm run method-trace-check -- ../docs/analysis/<file>.md` (must PASS), then `npm run distill-harvest`.
     (The `guard-daily-methodtrace.py` Stop hook reminds you if a `docs/analysis/*.md` is unharvested/incomplete.)
  3. If `tool_gap != none`, **file a `tooling_defect` LearningCase** (not "fix later").
  4. State in your answer: **new Method Trace? harvested? tooling_defect? decision-log update?**
  Same Method Trace + same harvest as a Hermes round — Opus learns from `docs/distill/method-traces.md` either
  way. (Trivial turns — a typo, a one-command lookup, plain chat — are NOT reusable judgments; skip.)

## 6. Load-on-demand map (read the right one for the task)
- `docs/research/HERMES.md` — the live-run / Hermes / autonomous workflow runbook + governance rules 1–17.
  Read it **fully** when running such a cycle (the `docs/research/autonomous-*.md` routines do). Hermes rule
  numbers are load-bearing; do not renumber.
- `docs/research/gates.md` — the validation contract (`fixed` vs `implemented`, replay flips, test harnesses).
  Read before claiming a deterministic change is fixed.
- `docs/decision-log.md` — dated decisions / verified facts / dead-ends. Read the ✅/❌ entries **before
  re-opening a settled question**.
- `docs/live-safety-envelope.md` — the bounded-live authorization specifics (behind Rule 1).
- `docs/historical-replay.md` — the wstUSR replay procedure + ordered tx list. Read before any replay work.
- `docs/project-context.md` — case study, arb flow, address table, source layout.
- `docs/dev-commands.md` — fork test / trace / discovery command reference.
- `docs/agent-style.md` — neutral-wording detail (behind Rule 6).
- `docs/research/` — Hermes round docs, handoff/relay routines, architecture reviews, templates.
- `docs/distill/method-traces.md` — the harvested Fable/Opus project-method library (Method Traces grouped by task_class; regenerate with `npm run distill-harvest`). Opus reads this to learn this project's analysis methods.
- `docs/analysis/` — **daily** Fable analysis outputs (any manual analysis that isn't a full Hermes round). Each md ends with a `## Method Trace`; validate round-agnostically with `npm run method-trace-check -- <md>`; harvested into `method-traces.md`. See `docs/analysis/README.md`.
- Skills: `bundle-postmortem` (competitor-loss decision tree), `mev-review` (trace-diff review).
  `docs/distill/` + `.claude/commands/{dualrun,compress}.md` — the Fable/Opus distillation workflow (don't
  auto-read; only for rule compression).
