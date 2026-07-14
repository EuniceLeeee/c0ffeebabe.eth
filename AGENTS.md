# Codex Instructions

The canonical project instructions live in `CLAUDE.md` (the always-loaded core:
behavioral base, mission, Safety Rules, reference). Companions load on demand:
- `docs/research/HERMES.md` — the live-run collaboration runbook + governance rules 1–17. Read it
  when running a Hermes / handoff / autonomous round.
- `docs/research/gates.md` — the validation contract (rule 12: `fixed` vs `implemented`,
  replay flips, the test harnesses). Read it before claiming a deterministic fix.
- `docs/research/HISTORICAL-GAP.md` — the pinned historical-transaction repair runbook. Read it when
  grouping scanner/backrun samples into gap branches without a full live research round.

When reading this file, immediately read `CLAUDE.md` and follow it as the source of
truth; read `docs/research/HERMES.md` / `docs/research/gates.md` when the work is a live-run round or a
searcher-correctness change, and `docs/research/HISTORICAL-GAP.md` for a pinned historical batch repair.

When changing project instructions, edit `CLAUDE.md` (or the load-on-demand runbook/gate docs
for protocol/gate content). Keep this file as a pointer unless asked otherwise.
