# Codex Instructions

The canonical project instructions live in `CLAUDE.md` (the always-loaded core:
behavioral base, mission, Safety Rules, reference). Two companions load on demand:
- `docs/research/HERMES.md` — the live-run collaboration runbook + governance rules 1–17. Read it
  when running a Hermes / handoff / autonomous round.
- `docs/research/gates.md` — the validation contract (rule 12: `fixed` vs `implemented`,
  replay flips, the test harnesses). Read it before claiming a deterministic fix.

When reading this file, immediately read `CLAUDE.md` and follow it as the source of
truth; read `docs/research/HERMES.md` / `docs/research/gates.md` when the work is a live-run round or a
searcher-correctness change.

When changing project instructions, edit `CLAUDE.md` (or `docs/research/HERMES.md`/`docs/research/gates.md`
for protocol/gate content). Keep this file as a pointer unless asked otherwise.
