# docs/analysis/ — daily Fable analysis outputs (Method Trace, round-agnostic)

> The home for **any** Fable manual analysis that is NOT a full Hermes live-run round — a one-off
> bundle-postmortem, an architecture note, a replay debug, a protocol-leg study, a planning analysis.
> Same Method Trace contract as a Hermes round, without the round scaffolding (no step1 / 5 live analyses).

## The contract
Every analysis md dropped here MUST end with a `## Method Trace` (the auditable frame — see
`docs/research/HERMES.md` rule 16 for the field spec):
```
## Method Trace
task_class:       competitor_path | bundle_postmortem | architecture_review | replay_fixture | protocol_leg
tools_used:
evidence_order:
analysis_frame:
sanity_checks:
tool_gap:         none | <what the tool missed>
codify_next:      no | <field/test/gate/tooling_defect + target file>
distill_for_opus: <one reusable rule Opus should learn>
```
- If `task_class: architecture_review` → also include a `## Architecture Coverage Matrix` (12 axes, each
  with a filled decision).
- If `tool_gap != none` → a `tooling_defect` LearningCase MUST be filed (then codified or human_killed).

## Validate it (round-agnostic gate)
```
cd analysis && npm run method-trace-check -- ../docs/analysis/<your-analysis>.md
```
`PASS` = the Method Trace is complete + honest. `FAIL` lists what's missing.

## Feed it to Opus
```
cd analysis && npm run distill-harvest
```
Harvest scans this dir + `docs/research/reports/` and regenerates `docs/distill/method-traces.md` — the
single asset Opus reads, grouped by `task_class`. (Raw drafts: keep them out of git if they carry secrets;
the analysis md itself is a normal committed artifact.)
