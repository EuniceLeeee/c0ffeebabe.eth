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
  silently; if a simpler approach exists, say so (push back when warranted); if unclear, stop and ask in an
  attended task. In an explicitly unattended HERMES round, make the safest in-envelope decision, record it,
  and continue; only a true out-of-envelope safety stop may wait for the user.
- **Simplicity first.** Minimum code that solves the problem, nothing speculative (no unrequested
  flexibility, no error handling for impossible cases). If 200 lines could be 50, rewrite. Test: *would a
  senior engineer say this is overcomplicated?*
- **Surgical changes.** Touch only what you must; match existing style; don't refactor what isn't broken;
  remove only the orphans *your* change created; mention unrelated dead code, don't delete it. Every changed
  line traces to the request. **Never `rg -rn`/`-rln`** (`-r` = `--replace`, corrupts reads).
- **Goal-driven execution.** Turn tasks into `[step] → verify: [check]` pairs; loop until verified. **Build
  passing is `implemented`, not `fixed`** — a change is accepted by ONE of the two declarative acceptance
  checklists: **四步验收** (deterministic local change) or **六步验收** (production-funnel capability/gap
  repair) — see `docs/research/HERMES.md` §验收标准. They are human-verified checklists, NOT hooks or
  gate scripts.
- **Verify against code/data, not memory.** A recalled fact / a stale memory is a hypothesis to re-check by
  reading the actual file or on-chain data, never a conclusion.
- **Derive identity on-chain; never gate admission on a hardcoded allowlist.** Venue / pool / factory /
  adapter admission must come from **reverse-verified on-chain identity** (`factory()` / `getPair` / Curve
  MetaRegistry / a registry call), with any hardcoded set demoted to **provenance / labeling only — never the
  admission gate**. A per-instance hardcoded allowlist "works" only for the samples you enumerated; the next
  fork / pool / metapool silently drops = a **coverage bug masquerading as a fix** (the seed-gated
  Curve-underlying that dropped Ubiquity is the type case). Mirror how V2/V3 already treat `factory()` =
  provenance, not a hard gate. Pinning an **infrastructure singleton** (a registry / vault / oracle address,
  token constants) is fine — that is the identity *source*, not an instance allowlist. The mandatory **final
  sim stays the fail-closed gate**, never the list. If you catch yourself adding an address to a table so one
  more sample passes, stop: derive it instead.

## 3. Mission / North Star (every window stays anchored here)
1. **Ship to production** — a profitable, live on-chain arbitrage searcher. Broadcast is a hard human gate
   (§4 Rule 1), but the *direction* is always: get closer to a real, +EV live bundle.
2. **Learn from competitors to find OUR gaps** — study winning on-chain paths, classify what we're missing:
   **pool gap** (a venue we don't index) / **path gap** (pools we have but can't close a loop through) /
   **unanticipated gap** (saw it, lost it — latency, or a flow-admission drop before the funnel).
3. **Loop:** competitor cross-reference → classify the gap → close it → replay/live verify. **No work item
   counts unless it moves a real gap toward closed, or moves us toward a live +EV bundle.** Don't drift.

**Current production phase:** B challengers target position-conserving `DEX↔DEX` or
`DEX↔permissionless protocol` closed loops. Production Hermes windows run both victim-independent
`block-scan` and public-mempool `backrun` (MEV-Share remains off); one challenger may target a proven blocker
in either lane while both funnels remain observed. A backrun must bind a real swap/oracle trigger and satisfy the 六步验收
(incl. causal trigger-replay evidence; `docs/research/HERMES.md` §验收标准). Keeper/reward flows,
inventory, private paths, credit, sandwich, and JIT-LP remain outside the target and cannot justify an
`ab/*` deployment.

Primary case study: wstUSR depeg arbitrage — see `docs/project-context.md`.

## 4. Hard safety rules (never autonomous)
> Safety Rule **numbers are load-bearing** — Rule 1 / Rule 6 are referenced by number from HERMES.md, the
> autonomous routines, and skills. Never renumber; compress in place.

1. **Mainnet broadcast (and signing with the private key) requires explicit human authorization.** Today:
   a **bounded-live** test is authorized ONLY inside the script-enforced envelope (node marker
   `/opt/MEV/.deploy-live` + wallet `≤ MEV_LIVE_MAX_WALLET_ETH` + `SEARCHER_EV_GATE=1`; broadcast only a
   profitable EV-gated sim). The dated envelope also defines the authorized dual-live A/B challenger.
   Anything outside the envelope — funding above the cap, raising the cap, the
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
- **Codex-first for fan-out** — multi-agent investigation OR code generation dispatches to **Codex**
  (`scripts/codex-run.sh <read-only|workspace-write> <brief-file> <out-prefix>`, parallel background runs
  fine), NOT a Claude-agent `Workflow`. Codex is the sanctioned generator/investigator (HERMES rule 11/12);
  Claude sub-agents burn tokens duplicating what Codex does in-sandbox. Reserve `Workflow`/Claude sub-agents
  for work Codex genuinely CANNOT do in its sandbox: spawning processes (anvil/forge), node/network queries
  the sandbox blocks, interactive-auth MCP, Claude-only tools (visualize/artifact/browser). **GATED** by
  `guard-workflow-codex-first.py` (PreToolUse Workflow) — BLOCKS a `Workflow` call unless you first
  `touch /tmp/mev-workflow-codex-exempt` (one-shot, hook-consumed) to declare the fan-out is sandbox-blocked.
- **Reconcile-after (NOT tool-first-pre-check)** — the ORDER is: hand-roll/analyze FIRST (it is allowed and
  valuable — rule 16: manual analysis is a TEST of the tooling and routinely finds where a script is stale/
  wrong), THEN query the generated current inventory with
  `cd analysis && npm run tool-index -- --select <capability[,capability]> --out <manifest.json>`, inspect its
  recommended coverage set plus related alternatives, then run the selected tools through
  `npm run tool-run -- --manifest <manifest.json> --tool <indexed-id> [--window <from>..<to>] -- <args>` and
  reconcile their results,
  and cross-check (HERMES rules 16+17). Never choose from a remembered/hardcoded tool list: the index is
  generated from the current analysis/listener package scripts plus repo scripts, and `--check` fails on an
  unindexed analysis CLI. Selection is validated by the **union** of capabilities across the recorded tools;
  no lifecycle rule hardcodes a diagnostic tool name. Trusted writers/runners/gates may be fixed because they
  create or validate evidence; they do not supply the diagnostic conclusion. Record the capability query, selected tool IDs,
  manifest path, and manifest SHA-256 in an A/B journal. `tool-run` records the current descriptor
  fingerprint, redacted argv hash, exit status, output hashes/byte counts, timestamps, and exact live window.
  A printed command, fixture-only run, failed/skipped shell branch, or remembered tool ID is not execution
  evidence. Do
  NOT invert to "check the tool, then hand-roll": pre-checking suppresses the very manual analysis that
  catches a stale tool. Prefer structured JSONL over log greps; `pipeline_dropped` is the source of truth
  for loss attribution.
  **GATED** by `guard-tool-reconcile.py` (PostToolUse Write|Edit|Bash) + `guard-reconcile-stop.py` (Stop) —
  a RECONCILE-after, not a pre-block (a pre-block suppresses the manual analysis that catches a STALE tool,
  rule 16). A throwaway `_*`/`/tmp`·scratchpad analysis (`.ts/.py/.sh/.mjs/.js` OR inline `python3 -c`/`node
  -e`) with a venue/pool/trace/PnL marker fires a reminder AND records a pending entry; the **Stop hook then
  refuses to end the turn** until it clears — that is the teeth. Clear it by RUNNING the indexed canonical
  tool set selected for the needed capabilities through `tool-run`. A tracked Write/Edit may record an honest
  `tool-reconciled: <exact-indexed-tool-id> agrees|diverged|n/a <reason>` when execution is genuinely
  inapplicable; printing that text from Bash does not clear the gate. One partial tool does not clear it: the
  successful execution/reconciliation capability union must cover the query. Divergence is the finding: fix
  the stale tool (rule 16) OR the wrong hand analysis
  (e.g. `in_graph` shows a "dead edge" is really an unindexed pool = pool gap). The hook is a gate on the
  canonical analysis pattern, while schema-v3 Hermes/A-B decisions additionally require the machine execution
  manifest and cannot be satisfied by prose.
- **Tool defects close in the same analysis round.** If manual analysis and a canonical tool disagree about
  the tool's correctness or coverage, call a fresh non-author adversarial reviewer. When both analyses agree
  the tool is wrong or incomplete, file the exact `tooling_defect` LearningCase, fix the tool, add its regression
  test, and cite the `codify_commit` before closing that same turn/Hermes round. Do not defer an agreed tool bug
  into a historical backlog. The acceptance checklist covers only defects explicitly referenced by the current Method
  Trace; unrelated old cases neither block the round nor excuse skipping this closure.
- **Live-run follow-up** — after a run, auto-analyze without waiting; first pass **zero-CU** where possible
  (read JSONL / redacted logs / code / registries before RPC/traces). The `no_candidate_plans` drill-down +
  its classification live in HERMES + the `redact-live-run` tool.
- **A/B branch lifecycle** — unattended cleanup is allowed only for literal `ab/*` branches after the A/B
  gate authorizes it. A decisive `win`/`lose` cleans immediately. `needs_escalation`, unresolved
  manual/script disagreement, incomplete fixes, and crashes retain the branch only while unresolved. Once a
  later validated fix is on `origin/main`, copy the report to main with exact base/challenger/resolution SHAs,
  add a main-committed `docs/research/resolutions/*.json` claim that pins the old branch tip, then run
  `npm run ab-resolution-sweep -- --apply`: it replays the report-owned old gate at `resolved_by_commit`,
  archives the report, invokes the cleanup gate, and exact-deletes only on success. Keep the report as the
  durable record. Never
  delete another branch class under this authority.
  Each new round starts from the current `origin/main` champion: `A_n → fresh B_n`. A proven win atomically
  promotes the exact frozen B SHA to `A_{n+1}` and deletes B; the next challenger is then cut fresh from
  `A_{n+1}`. Never stack the next experiment on an old B branch.
- **Daily analysis = a light learning round (one Learning Kernel, two entrances: Hermes = heavy, daily =
  light).** When you do a **reusable judgment** outside a Hermes round (architecture review / competitor-path
  analysis / bundle postmortem / a tool found wrong / repo diagnosis), capture it via steps 1–4 below.
  **[ACTIVE] Trigger = MANUAL only** (2026-07-07): run this capture ONLY when the user explicitly asks
  (e.g. `/compress`, or "capture this"). Do NOT auto-run it at end of turn.
  <!-- [DISABLED 2026-07-07] AUTO trigger — kept for easy revert. Reverted because the distill library's
       measured read-rate is 0 (docs/distill/method-traces.md never Read across 80 local sessions => auto-
       capture was write-only credit burn). To RE-ENABLE auto: swap the "[ACTIVE] Trigger = MANUAL only"
       sentence above back to the original line —
         "at the end of that turn **auto-capture it** — don't wait to be asked:"
       (and delete this comment). -->
  When triggered:
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
- `docs/research/HERMES.md` — the live-run / Hermes / autonomous workflow runbook + governance rules 1–17
  + the **§A/B Canary** champion/challenger loop (agent-manual causal analysis → canonical script
  reconciliation → fresh non-author review on conflict/capability wins; merge/delete only on a proven win,
  retain-and-advance on inconclusive; auto-runs bounded live).
  Read it **fully** when running such a cycle (the `docs/research/autonomous-*.md` routines do). Hermes rule
  numbers are load-bearing; do not renumber.
- `docs/research/HISTORICAL-GAP.md` — batch repair from pinned historical transactions without a full live
  research window. It accepts only scanner/backrun conserving DEX or DEX+permissionless-protocol loops and
  mechanically routes tooling work direct-to-main, deterministic fixes through replay+smoke, and
  admission/latency/ranking changes back to Hermes A/B.
- `docs/research/gates.md` — harness/replay command reference (and the record of the legacy gate scripts,
  now optional self-check aids). The acceptance standard itself is the 四步/六步验收 checklist in
  `docs/research/HERMES.md` §验收标准 — read THAT before claiming a change is fixed.
- `docs/research/tx-gap-analysis-format.md` — required user-facing format when one landed transaction is
  supplied for production-gap, tool, file, or function diagnosis. It separates the core conserving route
  from profit-disposal touches and requires current-main funnel/replay evidence before saying `fixed`.
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
